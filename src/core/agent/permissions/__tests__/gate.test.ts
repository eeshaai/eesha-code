import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { answerText, PermissionLevel } from "../../../models/permissionCard";
import { createJail } from "../../providers/pathJail";
import { AnswerBook } from "../answers";
import { answerShown, createPermissionGate, fileMatches, GateCall, urlMatches } from "../gate";

/*
 * Our own permission check, one call at a time. The same decisions on every provider: the providers only turn
 * their own requests into a `GateCall`.
 */

function temporaryFolder(prefix: string): string {

    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function setUp(options: { provider?: string; acp?: boolean; level?: PermissionLevel; chatId?: string } = {}) {

    const repo = temporaryFolder("eesha-gate-repo-");
    const home = temporaryFolder("eesha-gate-home-");

    let level: PermissionLevel = options.level ?? "manual";

    const book = new AnswerBook(path.join(temporaryFolder("eesha-gate-book-"), "permissions.json"));
    const addFolder = vi.fn();

    const gate = createPermissionGate({
        provider: options.provider ?? "claude",
        acp: options.acp ?? false,
        chatId: options.chatId ?? "chat-1",
        workingFolder: repo,
        level: () => level,
        book,
        addFolder,
        home
    });

    const jail = createJail(repo);

    return { gate, jail, repo, home, book, addFolder, setLevel: (next: PermissionLevel) => { level = next; } };
}

const command = (text: string): GateCall => ({ tool: "Bash", what: "command", command: text });

describe("levels", () => {

    it("Auto never asks, and says so on the row", () => {

        const { gate, jail } = setUp({ level: "auto" });

        expect(gate.decide(command("rm -rf build"), jail)).toEqual({ verdict: "allow", note: "auto-allowed (Auto)" });
    });

    it("Semi Auto asks for commands only", () => {

        const { gate, jail, repo } = setUp({ level: "semi" });

        expect(gate.decide(command("npm test"), jail).verdict).toBe("ask");

        expect(gate.decide({ tool: "Edit", what: "edit", paths: [path.join(repo, "a.ts")] }, jail))
            .toEqual({ verdict: "allow", note: "auto-allowed (Semi Auto)" });
    });

    it("Manual asks for commands, edits, MCP, web and unknown tools, but not reads inside the folders", () => {

        const { gate, jail, repo } = setUp({ level: "manual" });

        for (const call of [
            command("ls"),
            { tool: "Edit", what: "edit", paths: [path.join(repo, "a.ts")] },
            { tool: "mcp__ado__get", what: "mcp", server: "ado", mcpTool: "get" },
            { tool: "WebFetch", what: "web", url: "https://example.test/a" },
            { tool: "Magic", what: "tool", name: "Magic" },
            { tool: "?", what: "unknown" }
        ] satisfies GateCall[])
            expect(gate.decide(call, jail).verdict).toBe("ask");

        expect(gate.decide({ tool: "Read", what: "read", paths: [path.join(repo, "a.ts")], writes: false }, jail))
            .toEqual({ verdict: "allow", note: "ran without asking: a read inside the chat's folders" });
    });

    it("housekeeping always runs silently, at every level", () => {

        const { gate, jail } = setUp({ level: "manual" });

        expect(gate.decide({ tool: "TodoWrite", what: "housekeeping" }, jail)).toEqual({ verdict: "allow" });
    });

    it("the level is read on every call, so a change in the picker holds at once", () => {

        const { gate, jail, setLevel } = setUp({ level: "manual" });

        expect(gate.decide(command("ls"), jail).verdict).toBe("ask");

        setLevel("auto");

        expect(gate.decide(command("ls"), jail).verdict).toBe("allow");
    });

    it("ACP Agent's Choice asks for every request; Semi Auto for execute, no kind or other", () => {

        const { gate, jail, setLevel } = setUp({ provider: "kiro", acp: true, level: "agent" });

        expect(gate.decide({ tool: "read", what: "read", acpKind: "read", paths: [] }, jail).verdict).toBe("ask");

        setLevel("semi");

        expect(gate.decide({ tool: "x", what: "command", acpKind: "execute", command: "ls" }, jail).verdict).toBe("ask");
        expect(gate.decide({ tool: "x", what: "unknown" }, jail).verdict).toBe("ask");
        expect(gate.decide({ tool: "x", what: "tool", acpKind: "other", name: "x" }, jail).verdict).toBe("ask");
        expect(gate.decide({ tool: "x", what: "edit", acpKind: "edit", paths: [] }, jail))
            .toEqual({ verdict: "allow", note: "auto-allowed (Semi Auto)" });
    });
});

describe("command cards", () => {

    it("shows the cleaned command, what was sent, where it runs, and wildcard choices", () => {

        const { gate, jail, repo } = setUp({ level: "semi" });

        const decision = gate.decide(command("& npm run build --prod"), jail);

        expect(decision.verdict).toBe("ask");

        if (decision.verdict !== "ask")
            return;

        expect(decision.card).toMatchObject({
            type: "command",
            title: "claude wants to run a command",
            level: "Semi Auto",
            shown: "npm run build --prod",
            sentAs: "& npm run build --prod",
            where: repo,
            pick: 1,
            scopes: ["session", "folder", "always"],
            kind: "command"
        });

        expect(decision.card.remember?.map(choice => choice.pattern)).toEqual(["npm run build --prod", "npm run build *", "npm run *", "npm *"]);
    });

    it("a chained command is asked whole, with only its exact text to save", () => {

        const { gate, jail } = setUp({ provider: "ghcp", level: "manual" });

        const decision = gate.decide(command("npm run lint && git push"), jail);

        expect(decision.verdict === "ask" && decision.card).toMatchObject({
            type: "chained",
            title: "copilot wants to run a command",
            shown: "npm run lint && git push",
            remember: [{ pattern: "npm run lint && git push" }],
            scopes: ["session", "folder", "always"]
        });
    });

    it("a command run as text can only be allowed once", () => {

        const { gate, jail } = setUp({ level: "semi" });

        const decision = gate.decide(command("iex $script"), jail);

        expect(decision.verdict === "ask" && decision.card).toMatchObject({ type: "once", scopes: [] });
    });

    it("Copilot running outside its sandbox can only be allowed once, even with a saved answer", () => {

        const { gate, jail, book } = setUp({ provider: "ghcp", level: "semi" });

        book.add({ kind: "command", pattern: "npm *", scope: "always", agent: "ghcp" });

        const decision = gate.decide({ ...command("npm install"), onceOnly: true }, jail);

        expect(decision.verdict === "ask" && decision.card.type).toBe("once");
    });
});

describe("answers", () => {

    it("Allow once saves nothing", () => {

        const { gate, jail, book } = setUp({ level: "semi" });

        const call = command("npm test");
        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(gate.answer(call, decision.card, answerText({ choice: "once" }))).toEqual({ allow: true, note: "allowed once by you" });
        expect(book.list()).toEqual([]);
    });

    it("This session saves the picked pattern for this chat, and the next match runs with a note", () => {

        const { gate, jail, book } = setUp({ level: "semi" });

        const call = command("npm run build --prod");
        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(gate.answer(call, decision.card, answerText({ choice: "session", pattern: "npm run build *" })))
            .toEqual({ allow: true, note: "allowed by your answer `npm run build *` (this session)" });

        expect(book.list()).toMatchObject([{ kind: "command", pattern: "npm run build *", scope: "session", chatId: "chat-1", agent: "claude" }]);

        expect(gate.decide(command("npm run build"), jail))
            .toEqual({ verdict: "allow", note: "allowed by your answer `npm run build *` (this session)" });
    });

    it("an answer saved by one provider holds for another in the same chat", () => {

        const first = setUp({ provider: "claude", level: "semi" });

        first.book.add({ kind: "command", pattern: "git status", scope: "session", chatId: "chat-1", agent: "claude" });

        const copilot = createPermissionGate({
            provider: "ghcp", acp: false, chatId: "chat-1", workingFolder: first.repo, level: () => "semi",
            book: first.book, addFolder: () => undefined, home: first.home
        });

        expect(copilot.decide(command("git status"), first.jail).verdict).toBe("allow");
    });

    it("This folder files the answer under the working folder", () => {

        const { gate, jail, book, repo } = setUp({ level: "semi" });

        const call = command("npm test");
        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        gate.answer(call, decision.card, answerText({ choice: "folder", pattern: "npm test *" }));

        expect(book.list()).toMatchObject([{ scope: "folder", folder: repo, pattern: "npm test *" }]);
    });

    it("a pattern the card did not offer is a yes once, and nothing is saved", () => {

        const { gate, jail, book } = setUp({ level: "semi" });

        const call = command("npm test");
        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(gate.answer(call, decision.card, "Always: *")).toEqual({ allow: true, note: "allowed once by you" });
        expect(gate.answer(call, decision.card, "Always: rm *")).toEqual({ allow: true, note: "allowed once by you" });
        expect(book.list()).toEqual([]);
    });

    it("Deny carries the reason to the agent and the row", () => {

        const { gate, jail } = setUp({ level: "semi" });

        const call = command("npm test");
        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(gate.answer(call, decision.card, answerText({ choice: "deny", reason: "use pnpm" })))
            .toEqual({ allow: false, note: "denied by you: \"use pnpm\"", reason: "use pnpm" });

        expect(gate.answer(call, decision.card, "Deny")).toEqual({ allow: false, note: "denied by you" });
    });

    it("words that are not an answer are a Deny with those words as the reason", () => {

        const { gate, jail } = setUp({ level: "semi" });

        const call = command("npm test");
        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(gate.answer(call, decision.card, "yes please")).toMatchObject({ allow: false, reason: "yes please" });
    });

    it("edits offer no Always, and save a folder pattern by default", () => {

        const { gate, jail, repo } = setUp({ level: "manual" });

        const file = path.join(repo, "src", "a.ts");

        const decision = gate.decide({ tool: "Edit", what: "edit", paths: [file] }, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(decision.card.scopes).toEqual(["session", "folder"]);
        expect(decision.card.remember?.[decision.card.pick ?? 0]).toMatchObject({ shown: "src/**", hint: "this folder and below" });
        expect(decision.card.shown).toBe("src/a.ts");
    });
});

describe("chained commands and saved answers", () => {

    it("runs a chain silently when every part is covered, a cd into the chat's folders included", () => {

        const { gate, jail, book, repo } = setUp({ level: "manual" });

        fs.mkdirSync(path.join(repo, "web"));

        book.add({ kind: "command", pattern: "npm run *", scope: "always", agent: "claude" });
        book.add({ kind: "command", pattern: "git status", scope: "always", agent: "claude" });

        expect(gate.decide(command("cd web; & npm run lint && git status"), jail)).toEqual({ verdict: "allow" });
    });

    it("asks the whole chain when one part is not covered", () => {

        const { gate, jail, book } = setUp({ level: "manual" });

        book.add({ kind: "command", pattern: "npm run *", scope: "always", agent: "claude" });

        expect(gate.decide(command("npm run lint && git push"), jail).verdict).toBe("ask");
    });

    it("a cd out of the chat's folders is not covered", () => {

        const { gate, jail, book } = setUp({ level: "manual" });

        book.add({ kind: "command", pattern: "npm run *", scope: "always", agent: "claude" });

        expect(gate.decide(command(`cd ${os.tmpdir()} && npm run lint`), jail).verdict).toBe("ask");
    });

    it("a chain saved whole is matched on its exact text", () => {

        const { gate, jail, book } = setUp({ level: "manual" });

        book.add({ kind: "command", pattern: "npm run lint && git push", scope: "session", chatId: "chat-1", agent: "claude" });

        expect(gate.decide(command("& npm run lint && git push"), jail))
            .toEqual({ verdict: "allow", note: "allowed by your answer `npm run lint && git push` (this session)" });
    });

    it("another chat's session answer does not hold", () => {

        const { gate, jail, book } = setUp({ level: "manual" });

        book.add({ kind: "command", pattern: "ls", scope: "session", chatId: "chat-2", agent: "claude" });

        expect(gate.decide(command("ls"), jail).verdict).toBe("ask");
    });
});

describe("outside the chat's folders", () => {

    it("asks at every level, Auto included, and offers folders to add", () => {

        const { gate, jail } = setUp({ level: "auto" });

        const other = temporaryFolder("eesha-gate-other-");

        fs.mkdirSync(path.join(other, ".git"));

        const decision = gate.decide({ tool: "Read", what: "read", paths: [path.join(other, "api.ts")], writes: false }, jail);

        expect(decision.verdict === "ask" && decision.card).toMatchObject({
            type: "outside",
            level: "asked in every mode",
            title: "claude wants to read a file outside this chat's folders",
            outside: { folders: [{ path: other, hint: "git root · suggested" }] }
        });
    });

    it("Add folder adds only an offered folder, and the rest of the turn uses it without asking", () => {

        const { gate, jail, addFolder } = setUp({ level: "auto" });

        const other = temporaryFolder("eesha-gate-other-");

        fs.mkdirSync(path.join(other, ".git"));

        const call: GateCall = { tool: "Read", what: "read", paths: [path.join(other, "api.ts")], writes: false };

        const decision = gate.decide(call, jail);

        if (decision.verdict !== "ask")
            throw new Error("expected a card");

        expect(gate.answer(call, decision.card, answerText({ choice: "addFolder", folder: os.tmpdir() })).allow).toBe(false);
        expect(addFolder).not.toHaveBeenCalled();

        expect(gate.answer(call, decision.card, answerText({ choice: "addFolder", folder: other })))
            .toEqual({ allow: true, note: `allowed by you, and ${other} was added to this chat` });

        expect(addFolder).toHaveBeenCalledWith(other);

        expect(gate.decide({ ...call, paths: [path.join(other, "b.ts")] }, jail).verdict).toBe("allow");
    });

    it("refuses a protected folder with no card, at every level", () => {

        const { gate, jail, home } = setUp({ level: "auto" });

        expect(gate.decide({ tool: "Read", what: "read", paths: [path.join(home, ".ssh", "id_rsa")], writes: false }, jail)).toMatchObject({
            verdict: "deny",
            note: "refused: ~/.ssh is never allowed, in any mode"
        });
    });
});

describe("other cards", () => {

    it("an MCP tool offers this tool or every tool of its server", () => {

        const { gate, jail } = setUp({ level: "manual" });

        const decision = gate.decide({ tool: "mcp__ado__wit_get", what: "mcp", server: "ado", mcpTool: "wit_get" }, jail);

        expect(decision.verdict === "ask" && decision.card.remember?.map(choice => choice.pattern)).toEqual(["ado/wit_get", "ado/*"]);
    });

    it("a fetch offers the address or its whole site, the site picked", () => {

        const { gate, jail } = setUp({ level: "manual" });

        const decision = gate.decide({ tool: "WebFetch", what: "web", url: "https://docs.example.test/a/b" }, jail);

        expect(decision.verdict === "ask" && decision.card).toMatchObject({
            remember: [{ pattern: "https://docs.example.test/a/b" }, { pattern: "https://docs.example.test/*" }],
            pick: 1
        });
    });

    it("an ACP card says no reason can be sent", () => {

        const { gate, jail } = setUp({ provider: "kiro", acp: true, level: "agent" });

        const decision = gate.decide(command("ls"), jail);

        expect(decision.verdict === "ask" && decision.card.noReason).toBe(true);
    });

    it("a request with nothing to tell it by can only be allowed once", () => {

        const { gate, jail } = setUp({ level: "manual" });

        const decision = gate.decide({ tool: "Run analysis", what: "unknown" }, jail);

        expect(decision.verdict === "ask" && decision.card).toMatchObject({ type: "once", scopes: [] });
    });
});

describe("matching helpers", () => {

    it("file patterns: a file, a folder and below, or every file", () => {

        const folder = path.resolve("/work/repo/src").replace(/\\/g, "/");

        expect(fileMatches(`${folder}/**`, path.resolve("/work/repo/src/a/b.ts"))).toBe(true);
        expect(fileMatches(`${folder}/**`, path.resolve("/work/repo/srcx/b.ts"))).toBe(false);
        expect(fileMatches("**", path.resolve("/anything"))).toBe(true);
    });

    it("web patterns: the address, or a site's /*", () => {

        expect(urlMatches("https://a.test/*", "https://a.test/x/y")).toBe(true);
        expect(urlMatches("https://a.test/*", "https://b.test/x")).toBe(false);
        expect(urlMatches("https://a.test/x", "https://a.test/x")).toBe(true);
    });

    it("the saved list shows files relative to the folder and MCP as server · tool", () => {

        const repo = path.resolve("/work/repo");
        const pattern = `${repo.replace(/\\/g, "/")}/src/**`;

        expect(answerShown({ kind: "edit", pattern }, repo)).toBe("src/**");
        expect(answerShown({ kind: "mcp", pattern: "ado/wit_get" }, repo)).toBe("ado · wit_get");
        expect(answerShown({ kind: "mcp", pattern: "ado/*" }, repo)).toBe("ado · every tool");
        expect(answerShown({ kind: "command", pattern: "npm *" }, repo)).toBe("npm *");
    });
});

describe("an unattended session - a variant of an evaluation", () => {

    function setUpUnattended() {

        const repo = temporaryFolder("eesha-gate-repo-");
        const home = temporaryFolder("eesha-gate-home-");
        const book = new AnswerBook(path.join(temporaryFolder("eesha-gate-book-"), "permissions.json"));
        const addFolder = vi.fn();

        const gate = createPermissionGate({
            provider: "claude", acp: false, chatId: "variant-1", workingFolder: repo,
            level: () => "auto", book, addFolder, home, unattended: true
        });

        return { gate, jail: createJail(repo), repo, home, addFolder };
    }

    it("runs every call inside its folder without a card", () => {

        const { gate, jail, repo } = setUpUnattended();

        expect(gate.decide(command("npm ci"), jail)).toEqual({ verdict: "allow", note: "auto-allowed (Auto)" });
        expect(gate.decide({ tool: "Edit", what: "edit", paths: [path.join(repo, "a.ts")] }, jail).verdict).toBe("allow");
    });

    it("refuses a call outside its folder, where an attended session would show a card", () => {

        const { gate, jail, addFolder } = setUpUnattended();
        const elsewhere = path.join(temporaryFolder("eesha-gate-other-"), "notes.md");

        const decision = gate.decide({ tool: "Read", what: "read", paths: [elsewhere], writes: false }, jail);

        expect(decision).toMatchObject({ verdict: "deny", note: "refused: outside this session's folders, and nobody is asked" });
        expect(decision.verdict === "deny" && decision.reason).toContain(elsewhere);
        expect(addFolder).not.toHaveBeenCalled();

        // The same call, attended: a card.
        const attended = setUp({ level: "auto" });

        expect(attended.gate.decide({ tool: "Read", what: "read", paths: [elsewhere], writes: false }, attended.jail).verdict).toBe("ask");
    });

    it("still gives a protected place its own reason", () => {

        const { gate, jail, home } = setUpUnattended();

        const decision = gate.decide({ tool: "Read", what: "read", paths: [path.join(home, ".ssh", "id_rsa")], writes: false }, jail);

        expect(decision.verdict === "deny" && decision.note).toContain("never allowed");
    });
});

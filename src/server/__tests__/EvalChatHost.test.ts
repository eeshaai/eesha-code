// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { AgentSessions } from "../../core/agent";
import { AnswerBook } from "../../core/agent/permissions";
import { createJail } from "../../core/agent/providers/pathJail";
import type { ChatController } from "../../chat/ChatController";
import { Connectors } from "../connectors/Connectors";
import { EvalChatHost } from "../EvalChatHost";
import { evalDir, evalScratchDir, type EvalVariant, readEval, writeEval } from "../evals";
import { FileStore } from "../fileStore";

import { Memory } from "../memory/Memory";
import { MemoryStore } from "../memory/memoryStore";
import { type MemoryChoices, type ToPage } from "../protocol";
import type { HostServer } from "../ServerChatHost";
import { readSession, sessionIds } from "../sessions";

/*
 * The host of one variant of an evaluation: what makes it differ from a
 * normal session's host. The server is a stand-in.
 */

function temporaryFolder(): string {

    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-evalhost-")));
}

const MEMORY_OFF: MemoryChoices = { access: "off", askOnSave: false, claudeMemoryOff: false };

function setUp(memoryChoices: MemoryChoices = MEMORY_OFF) {

    const sent: ToPage[] = [];
    const evalsChanged: string[] = [];
    const notified: unknown[] = [];

    const server: HostServer = {
        store: new FileStore(path.join(temporaryFolder(), "state.json")),
        sessions: new AgentSessions(),
        answers: new AnswerBook(path.join(temporaryFolder(), "permissions.json")),
        workerPath: "unused",
        logPlace: "the log",
        connectors: new Connectors({ folders: () => [], onSignIn: () => undefined, readConfig: () => ({}) }),
        memory: new Memory({ store: new MemoryStore(":memory:"), readChoices: () => memoryChoices }),
        cliPath: "unused",
        toPage: (_chat, message) => { sent.push(message); },
        ask: async () => { throw new Error("A variant never asks."); },
        toAll: message => { sent.push(message); },
        holder: () => undefined,
        chatChanged: () => undefined,
        renamed: () => undefined,
        chatDeleted: () => undefined,
        keepFolder: async () => undefined,
        notify: (_chat, notice) => { notified.push(notice); },
        phaseOwner: () => undefined,
        evalChanged: name => { evalsChanged.push(name); }
    };

    const source = temporaryFolder();
    const copy = temporaryFolder();

    const variant: EvalVariant = { name: "one-1", chatId: "variant-chat", provider: "claude", folder: copy, addedAt: 1 };
    const store = new FileStore(path.join(temporaryFolder(), "eval-state.json"));

    const host = new EvalChatHost(server, { name: "one", folder: source }, variant, store);
    const chat = { chatId: variant.chatId } as unknown as ChatController;

    host.bind(chat);

    return { host, chat, server, store, source, copy, evalsChanged, notified, sent };
}

describe("a variant's host", () => {

    it("works in the variant's copy only, with nobody to answer", () => {

        const { host, copy } = setUp();

        expect(host.unattended()).toBe(true);
        expect(host.workspace()).toBe(copy);
        expect(host.folders()).toEqual([copy]);
        expect(host.inScratch()).toBe(false);
    });

    it("keeps its chat file, its saved picks and its scratch folder with the evaluation, not with the sessions", () => {

        const { host, server, store } = setUp();

        expect(host.historyKey()).toBe(evalDir("one"));
        expect(host.scratchFolder()).toBe(evalScratchDir("one", "one-1"));
        expect(host.store).toBe(store);
        expect(host.store).not.toBe(server.store);
    });

    it("writes nothing into the sessions folder, when a turn ends or a folder changes", async () => {

        const { host, chat, evalsChanged } = setUp();
        const before = sessionIds();

        await host.changed(chat);
        host.setFolders([temporaryFolder()]);
        host.copied("variant-chat", "variant-chat-copy");

        expect(sessionIds()).toEqual(before);
        expect(readSession("variant-chat")).toBeUndefined();
        expect(readSession("variant-chat-copy")).toBeUndefined();

        // The Evaluator page hears that the turn ended.
        expect(evalsChanged).toEqual(["one"]);
    });

    it("tells the Evaluator page, not the notices, when a turn ends", () => {

        const { host, chat, evalsChanged, notified } = setUp();

        host.notify(chat, { kind: "ended", outcome: "done" });

        expect(notified).toEqual([]);
        expect(evalsChanged).toEqual(["one"]);
    });
});

describe("a variant's permission check", () => {

    /** The check as a provider gets it when a session starts in the copy. */
    function gateOf(host: EvalChatHost, copy: string) {

        const gate = (host as unknown as { gate(provider: string, folder: string): ReturnType<EvalChatHost["gate"]> }).gate("claude", copy);

        return { gate: gate!, jail: createJail(copy) };
    }

    it("is on Auto: a command and an edit inside the copy run with no card", () => {

        const { host, copy } = setUp();
        const { gate, jail } = gateOf(host, copy);

        expect(gate.level()).toBe("auto");
        expect(gate.decide({ tool: "Bash", what: "command", command: "npm ci" }, jail).verdict).toBe("allow");
        expect(gate.decide({ tool: "Edit", what: "edit", paths: [path.join(copy, "a.ts")] }, jail).verdict).toBe("allow");
    });

    it("refuses a read or a write outside the copy - the source folder too", () => {

        const { host, copy, source } = setUp();
        const { gate, jail } = gateOf(host, copy);

        expect(gate.decide({ tool: "Read", what: "read", paths: [path.join(source, "a.ts")], writes: false }, jail).verdict).toBe("deny");
        expect(gate.decide({ tool: "Edit", what: "edit", paths: [path.join(source, "a.ts")] }, jail).verdict).toBe("deny");
    });
});

describe("a variant and the memory", () => {

    const MEMORY_ON: MemoryChoices = { access: "write", askOnSave: false, claudeMemoryOff: true };

    it("reads what a session in the source folder reads, not what belongs to its copy", () => {

        const { host, source } = setUp(MEMORY_ON);

        expect(host.memoryPlace()).toEqual({ folders: [source] });
    });

    it("is told it can read the memory but not change it", () => {

        const { host } = setUp(MEMORY_ON);

        expect(host.systemInstructions("claude")).toContain("can be read but not changed");
    });

    it("says nothing of the memory while it is off", () => {

        const { host } = setUp();

        expect(host.systemInstructions("claude")).toBeUndefined();
    });

    it("runs a Claude variant on Claude's own memory, without ours, while Claude's is still on", async () => {

        const { host } = setUp({ access: "write", askOnSave: false, claudeMemoryOff: false });

        // Never held back, and never asked.
        expect(await host.beforeTurn("claude")).toBeUndefined();

        expect(host.ownMemory()).toBe(false);
        expect(host.systemInstructions("claude")).toBeUndefined();
    });

    it("gives a Claude variant ours once Claude's own memory is turned off in Settings", () => {

        const { host } = setUp(MEMORY_ON);

        expect(host.ownMemory()).toBe(true);
    });
});

describe("a variant's own text, typed at the foot of its column", () => {

    it("is saved, never sent, put back in the box, and locked once the variant got its message", async () => {

        const { host, chat, source, copy, evalsChanged, sent } = setUp();

        writeEval({ name: "one", folder: source, createdAt: 1, variants: [{ name: "one-1", chatId: "variant-chat", provider: "claude", folder: copy, addedAt: 1 }] });

        try {

            // Saved trimmed; the box gets it back, and the column is told.
            expect(await host.variantText("  Use a map.  ")).toBe("Use a map.");
            expect(readEval("one")!.variants[0]!.extra).toBe("Use a map.");
            expect(host.variantDraft()).toBe("Use a map.");
            expect(evalsChanged).toEqual(["one"]);
            expect(sent.at(-1)).toMatchObject({ type: "eesha.note", text: expect.stringContaining("Send to all") });

            // Empty clears it.
            expect(await host.variantText("   ")).toBe("");
            expect(readEval("one")!.variants[0]!.extra).toBeUndefined();

            // Once its message is on its way nothing changes, and the box keeps what was typed.
            (chat as unknown as { working: boolean }).working = true;

            expect(await host.variantText("Too late.")).toBe("Too late.");
            expect(readEval("one")!.variants[0]!.extra).toBeUndefined();
            expect(sent.at(-1)).toMatchObject({ type: "eesha.note", text: expect.stringContaining("one message") });

        } finally {

            fs.rmSync(evalDir("one"), { recursive: true, force: true });
        }
    });
});

describe("a variant's setup picked at the foot of its column", () => {

    it("is saved to the evaluation's own file, and the variant's memory follows its new runtime", async () => {

        const { host, source, copy, evalsChanged } = setUp({ access: "write", askOnSave: false, claudeMemoryOff: false });
        const variant: EvalVariant = { name: "one-1", chatId: "variant-chat", provider: "claude", model: "opus", effort: "high", extra: "Be short.", folder: copy, addedAt: 1 };

        writeEval({ name: "one", folder: source, createdAt: 1, variants: [variant, { ...variant, name: "one-2", chatId: "other-chat" }] });

        try {

            // On Claude with Claude's own memory on, it has none of ours.
            expect(host.ownMemory()).toBe(false);

            await host.picked({ provider: "kiro-cli-v3", mode: "spec" });

            const saved = readEval("one")!;

            // The model and effort belonged to the old runtime; the name, the copy and the extra text stay.
            expect(saved.variants[0]).toEqual({ name: "one-1", chatId: "variant-chat", provider: "kiro-cli-v3", mode: "spec", extra: "Be short.", folder: copy, addedAt: 1 });
            expect(saved.variants[1]).toMatchObject({ name: "one-2", provider: "claude", model: "opus" });

            expect(host.ownMemory()).toBe(true);
            expect(evalsChanged).toEqual(["one"]);

            // No pick: nothing changes.
            await host.picked(undefined);

            expect(readEval("one")!.variants[0]!.provider).toBe("kiro-cli-v3");

        } finally {

            fs.rmSync(evalDir("one"), { recursive: true, force: true });
        }
    });
});

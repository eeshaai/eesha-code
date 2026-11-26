// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentSessions } from "../../core/agent";
import { AnswerBook } from "../../core/agent/permissions";
import { readLevel } from "../../chat/permissionLevels";
import { phaseChatKey } from "../../sdd/phase/runPhase";
import { serverSddHost, planShell, type SddHostEvents, type SddHostServer, type SddPlace, stopPlanCommands } from "../ServerSddHost";
import type { Shell } from "../commands";
import type { Connectors } from "../connectors/Connectors";
import { Memory } from "../memory/Memory";
import { MemoryStore } from "../memory/memoryStore";
import { FileStore } from "../fileStore";
import type { PromptRequest } from "../protocol";

/*
 * Eesha Code's answers to what the SDD controller asks of its host
 * (src/sdd/panel/sddHost.ts) - the parts it answers differently from the
 * plain test host the controller's own tests use
 * (src/sdd/panel/__tests__/testPanel.ts): the question pop-up, a plan's
 * command run in a real shell, what Eesha Code cannot do here, files, and
 * the saved values. No AI runs here.
 */

const folders: string[] = [];

function temporaryFolder(): string {

    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-sddhost-"));

    folders.push(folder);

    return folder;
}

let notes: string[];
let asked: PromptRequest[];
let answer: (prompt: PromptRequest) => string | undefined;
let opened: string[];
let waiting: string[];
let place: SddPlace;
let server: SddHostServer;

function events(): SddHostEvents {

    return {
        note: text => { notes.push(text); },
        ask: async prompt => { asked.push(prompt); return answer(prompt); },
        openFile: file => { opened.push(file); },
        asked: where => { waiting.push(where); },
        released: () => undefined
    };
}

beforeEach(() => {

    notes = [];
    asked = [];
    answer = () => undefined;
    opened = [];
    waiting = [];

    const main = temporaryFolder();

    place = { key: main.toLowerCase(), mainFolder: main, folders: [main, temporaryFolder()] };

    server = {
        store: new FileStore(path.join(temporaryFolder(), "state.json")),
        sessions: new AgentSessions(),
        answers: new AnswerBook(path.join(temporaryFolder(), "permissions.json")),
        workerPath: "unused",
        resources: "unused",
        connectors: { connected: () => false } as unknown as Connectors,

        // Off: these tests are about other things.
        memory: new Memory({ store: new MemoryStore(":memory:"), readChoices: () => ({ access: "off", askOnSave: false, claudeMemoryOff: false }) }),
        cliPath: "unused",
        pluginNonce: "test-nonce",
        newPhaseChat: async () => "chat-1",
        phaseChat: () => undefined,
        resumeChanged: () => undefined,
        pluginDatabase: () => undefined
    };
});

afterEach(() => {

    for (const folder of folders.splice(0))
        fs.rmSync(folder, { recursive: true, force: true });
});

describe("the question with several answers", () => {

    const CHOICES = ["Open that chat", "Start another"];

    it("shows every choice, each its own button, and answers the one picked", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        answer = () => "Open that chat";

        expect(await host.choose("A chat was already started.", "Two agents, same work.", CHOICES)).toBe("Open that chat");
        expect(asked).toEqual([{ kind: "choose", text: "A chat was already started.", detail: "Two agents, same work.", choices: CHOICES }]);
    });

    it("answers nothing when the person backs out, or the answer is none of the choices", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        expect(await host.choose("Pick one.", "", CHOICES)).toBeUndefined();

        answer = () => "Delete everything";

        expect(await host.choose("Pick one.", "", CHOICES)).toBeUndefined();

        // No detail: none is sent.
        expect(asked[0]).toEqual({ kind: "choose", text: "Pick one.", choices: CHOICES });
    });

    it("asks nothing with no choices", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        expect(await host.choose("Pick one.", "", [])).toBeUndefined();
        expect(asked).toEqual([]);
    });
});

describe("a plan's command", () => {

    it("runs in a real shell and answers its exit code, late, when it ends", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        expect(await host.runInTerminal(place.mainFolder, `node -e "setTimeout(() => process.exit(0), 300)"`)).toBe(0);
        expect(await host.runInTerminal(place.mainFolder, `node -e "process.exit(3)"`)).toBe(3);

        expect(notes.some(note => note.startsWith(`Running in ${place.mainFolder} (`))).toBe(true);
        expect(notes.some(note => note.includes("ended with exit code 3"))).toBe(true);
    }, 30_000);

    it("hands over what it prints as it prints it", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());
        const printed: string[] = [];

        expect(await host.runInTerminal(place.mainFolder, `node -e "console.log('first line')"`, { output: text => printed.push(text) })).toBe(0);

        expect(printed.join("")).toContain("first line");
    }, 30_000);

    it("is ended by the stop it hands over: no exit code, so nothing is ticked", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());
        let stop: (() => void) | undefined;

        const ended = host.runInTerminal(place.mainFolder, `node -e "setTimeout(() => {}, 60000)"`, { onStop: kill => { stop = kill; } });

        expect(stop).toBeDefined();

        setTimeout(() => stop!(), 300);

        expect(await ended).toBeUndefined();
        expect(notes.some(note => note.startsWith("Stopped: "))).toBe(true);
    }, 30_000);

    it("is ended when the server closes", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        const ended = host.runInTerminal(place.mainFolder, `node -e "setTimeout(() => {}, 60000)"`);

        setTimeout(stopPlanCommands, 300);

        expect(await ended).toBeUndefined();
    }, 30_000);

    it("tells a row's command button when its command ended after Stop, so the button turns back to Run", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());
        let stop: (() => void) | undefined;

        const ended = new Promise<void>(resolve => host.sendToTerminal(place.mainFolder, `node -e "setTimeout(() => {}, 60000)"`, {
            onStop: kill => { stop = kill; },
            ended: resolve
        }));

        expect(stop).toBeDefined();

        setTimeout(() => stop!(), 300);

        await ended;

        expect(notes.some(note => note.startsWith("Stopped: "))).toBe(true);
    }, 30_000);
});

describe("the shell a plan's command runs in", () => {

    const shell = (id: string): Shell => ({ id, label: id, program: id, kind: id === "gitbash" ? "posix" : id === "cmd" ? "cmd" : "powershell" });

    it("is Git Bash first on Windows, then PowerShell 7, then cmd - never Windows PowerShell 5.1", () => {

        expect(planShell([shell("pwsh"), shell("powershell"), shell("cmd"), shell("gitbash")], true)?.id).toBe("gitbash");
        expect(planShell([shell("pwsh"), shell("powershell"), shell("cmd")], true)?.id).toBe("pwsh");
        expect(planShell([shell("powershell"), shell("cmd")], true)?.id).toBe("cmd");
        expect(planShell([shell("powershell")], true)).toBeUndefined();
    });

    it("is the first shell found elsewhere", () => {

        expect(planShell([shell("zsh"), shell("bash")], false)?.id).toBe("zsh");
    });
});

describe("what Eesha Code cannot do here", () => {

    it("says so, and answers as the controller expects: no workflow run, no chat opened, no other spec shown", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        expect(await host.runWorkflow("build.yml", "build", {})).toBeUndefined();
        await host.openSession("s-1");
        expect(await host.showSpec({ name: "other" } as never)).toBeUndefined();

        expect(notes).toHaveLength(2);
        expect(notes[0]).toContain("Starting the workflow 'build' is not available here");
        expect(notes[1]).toContain("has no session here to open");
    });
});

describe("notices and files", () => {

    it("tells errors and info as notices, and a waiting agent as asked", () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        host.showError("It broke.");
        host.showInfo("It worked.");
        host.announceAsk("Design", undefined, undefined, () => undefined);

        expect(notes).toEqual(["It broke.", "It worked."]);
        expect(waiting).toEqual(["Design"]);
    });

    it("opens a relative path from the main folder, and finds the workspace folder that holds a file", () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        host.openFile("notes.md");

        expect(opened).toEqual([path.resolve(place.mainFolder, "notes.md")]);
        expect(host.folderOf(path.join(place.folders[1], "src", "a.ts"))).toBe(place.folders[1]);
        expect(host.folderOf(path.join(os.tmpdir(), "elsewhere.md"))).toBeUndefined();
    });
});

describe("saved values", () => {

    it("are kept per workspace, and the profile's are shared by every workspace", async () => {

        const first = serverSddHost(server, place, "sdd-1-demo", events());
        const second = serverSddHost(server, { ...place, key: "other" }, "sdd-2-demo", events());

        await first.store.update("pick", "first");
        await first.profileStore.update("widths", [1, 2]);

        expect(second.store.get("pick")).toBeUndefined();
        expect(second.profileStore.get("widths")).toEqual([1, 2]);
    });
});

describe("plugin pages", () => {

    const resources = path.resolve(__dirname, "..", "..", "..", "resources");

    it("puts a plugin's page together with the page's nonce on every script", () => {

        const host = serverSddHost({ ...server, resources }, place, "sdd-1-demo", events());

        const { apps, sandboxed } = host.pluginApps(new Set(["ado-release@1"]));

        expect(sandboxed).toBe(true);
        expect(apps.map(app => app.ref)).toEqual(["ado-release@1"]);

        const scripts = apps[0].html.match(/<script\b[^>]*>/gi) ?? [];

        expect(scripts.length).toBeGreaterThan(0);
        expect(scripts.every(tag => tag.includes('nonce="test-nonce"'))).toBe(true);
    });

    it("shows no page for a plugin the spec does not use", () => {

        const host = serverSddHost({ ...server, resources }, place, "sdd-1-demo", events());

        expect(host.pluginApps(new Set(["ai@1"])).apps).toEqual([]);
    });

    it("answers a page's data request with the main folder's plugin data, or says there is none", async () => {

        const asked: string[] = [];

        const host = serverSddHost({ ...server, resources, pluginDatabase: folder => { asked.push(folder); return undefined; } }, place, "sdd-1-demo", events());

        const reply = await host.answerPluginRequest(
            { id: 1, ref: "ado-release@1", kind: "db", op: "all", sql: "select 1" },
            { cwd: place.mainFolder, root: place.mainFolder, run: async () => undefined });

        expect(asked).toEqual([place.mainFolder]);
        expect(reply).toMatchObject({ id: 1, ok: false });
    });
});

describe("the permission levels and saved answers", () => {

    it("keeps a level per runtime in the server's own store, the one the chats read", async () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        await host.permissions.setLevel("claude", "manual");

        expect(readLevel(server.store, "claude")).toBe("manual");
        expect(host.permissions.levels(["claude", "ghcp"])).toEqual({
            claude: { level: "manual", acp: false },
            ghcp: { level: "auto", acp: false }
        });
    });

    it("lists the answers that hold in any chat of the spec, and drops one chat's with its conversation", () => {

        const host = serverSddHost(server, place, "sdd-1-demo", events());

        const mine = server.answers.add({ kind: "command", pattern: "npm test *", scope: "session", chatId: phaseChatKey("a/spec", "design"), agent: "claude" })!;
        const other = server.answers.add({ kind: "command", pattern: "npm run lint *", scope: "session", chatId: phaseChatKey("b/spec", "design"), agent: "claude" })!;
        const always = server.answers.add({ kind: "command", pattern: "git status *", scope: "always", agent: "claude" })!;

        expect(host.permissions.saved("a/spec", place.mainFolder).map(one => one.id).sort()).toEqual([mine.id, always.id].sort());

        host.permissions.forget("a/spec", "design");

        expect(host.permissions.saved("a/spec", place.mainFolder).map(one => one.id)).toEqual([always.id]);
        expect(host.permissions.saved("b/spec", place.mainFolder).map(one => one.id).sort()).toEqual([other.id, always.id].sort());

        expect(host.permissions.remove(always.id)).toBe(true);
    });
});

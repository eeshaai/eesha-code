import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentSessions, type AgentSession } from "../../core/agent";
import { keepCommandList } from "../../core/agent/commandListFile";
import { chatEventsPath } from "../../core/events/eventFile";
import type { PluginHost } from "../../core/plugins/PluginHost";
import type { SavedAnswer } from "../../core/models/permissionCard";
import type { ToChatHost, ToChatView } from "../../shared/chatMessages";
import type { AiPick } from "../../sdd/config/sddConfig";
import type { ChatHost, ChatNotice, PhaseOwner } from "../chatHost";
import { APPLIED_PREFIX, ChatController, PICK_PREFIX } from "../ChatController";

/*
 * The chat's send path with a fake host: no server and no
 * agent. `runCall` is replaced, so a turn here is one the test
 * starts, talks through and ends by hand. What is under test is what
 * the chat sends to the runtime and when it carries a conversation on,
 * reopens it, or refuses.
 */

vi.mock("../../sdd/phase/runPhase", async () => {

    const actual = await vi.importActual<typeof import("../../sdd/phase/runPhase")>("../../sdd/phase/runPhase");

    return { ...actual, runCall: vi.fn() };
});

// The pickers' lists start runtime CLIs - never in a test.
vi.mock("../aiChoice", async () => {

    const actual = await vi.importActual<typeof import("../aiChoice")>("../aiChoice");

    return {
        ...actual,
        modelsOf: vi.fn(async () => undefined),
        refreshModels: vi.fn(async () => true),
        toolsOf: vi.fn(async () => []),
        providerIds: vi.fn(async () => ["ghcp", "claude"]),
        aiChoiceMessage: vi.fn(async () => ({ providers: ["ghcp", "claude"] }))
    };
});

// Claude's saved conversations are on this machine - never read here.
vi.mock("../../core/agent/providers/claudeRewind", async () => {

    const actual = await vi.importActual<typeof import("../../core/agent/providers/claudeRewind")>("../../core/agent/providers/claudeRewind");

    return { ...actual, claudeCutPoint: vi.fn(), forkClaudeConversation: vi.fn() };
});

// Kiro is never started here: whether a runtime is Kiro v3, and its cut, are stand-ins.
vi.mock("../../core/agent/providers/kiroSessions", async () => {

    const actual = await vi.importActual<typeof import("../../core/agent/providers/kiroSessions")>("../../core/agent/providers/kiroSessions");

    return { ...actual, isKiroV3: vi.fn(() => false), cutKiroConversation: vi.fn() };
});

import { runCall } from "../../sdd/phase/runPhase";
import { claudeCutPoint, forkClaudeConversation } from "../../core/agent/providers/claudeRewind";
import { cutKiroConversation, isKiroV3 } from "../../core/agent/providers/kiroSessions";
import { lastSession, parseEvents } from "../../core/events/runEvents";
import { listChats } from "../chatHistory";
import { CARRY_PREFIX, TITLES_KEY } from "../ChatController";

const runSessionMock = vi.mocked(runCall);
const cutPointMock = vi.mocked(claudeCutPoint);
const forkMock = vi.mocked(forkClaudeConversation);

type Call = Parameters<typeof runCall>[0];
type Hooks = Parameters<typeof runCall>[1];

let workspace: string;

beforeEach(() => {

    runSessionMock.mockReset();
    cutPointMock.mockReset();
    forkMock.mockReset();

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chat-controller-"));
});

afterEach(() => {

    // Retried: on Windows a git process can still hold a folder for a moment.
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A host with nothing behind it but memory. */
function fakeHost() {

    const values = new Map<string, unknown>();
    const notes: string[] = [];
    const sessions = new AgentSessions();

    const host: ChatHost = {
        store: {
            get: <T>(key: string) => values.get(key) as T | undefined,
            update: async (key: string, value: unknown) => {

                if (value === undefined)
                    values.delete(key);
                else
                    values.set(key, value);
            }
        },
        ai: { workspaceFolder: () => undefined, warn: () => undefined },
        logPlace: "The test log",
        workspace: () => workspace,
        folders: () => [workspace],

        // The working folder only, as it is when the test asks.
        changeFolders: () => {

            const folder = host.workspace();

            return folder ? [folder] : [];
        },
        historyKey: () => workspace,
        scratchFolder: folder => path.join(folder, ".scratch"),
        plugins: () => ({}) as PluginHost,
        sessions: () => sessions,
        searchFiles: async () => [],
        searchPaths: async () => [],
        pathReferences: async () => ({ lines: [] }),
        systemInstructions: () => undefined,
        note: text => { notes.push(text); },
        askText: async () => undefined,
        confirm: async () => true,
        openFile: () => undefined,
        showDiff: async () => undefined,
        showTurnDiff: async () => undefined,
        showReview: async () => undefined,
        trash: async () => undefined,
        announceAsk: () => undefined,
        holder: () => undefined,
        show: () => undefined,
        changed: async () => undefined,
        renamed: () => undefined,
        deleted: () => undefined,
        copied: () => undefined,
        notify: () => undefined,
        permissions: { saved: () => [], remove: () => false }
    };

    return { host, values, notes, sessions };
}

/** A chat drawn on a surface that keeps what it was sent. */
function chatOn(host: ChatHost, chatId = "chat-1") {

    const posted: ToChatView[] = [];

    const chat = new ChatController(host, chatId);

    chat.attach({ post: message => { posted.push(message); } });

    return {
        chat,
        posted,
        send: (text: string, extra: Partial<Extract<ToChatHost, { type: "send" }>> = {}) =>
            chat.receive({ type: "send", text, ...extra }),
        logs: () => posted.filter((one): one is Extract<ToChatView, { type: "log" }> => one.type === "log").map(one => one.text)
    };
}

/** A session the registry can hold, as a runtime's would be. */
function liveSession(id: string) {

    const sent: unknown[] = [];
    const answers: [string, string][] = [];
    let disposed = false;

    const session: AgentSession = {
        id,
        status: "working",
        send: async message => { sent.push(message); },
        sendAndWait: async () => undefined,
        abort: async () => undefined,
        dispose: async () => { disposed = true; },
        on: () => () => undefined,
        respond: async (askId: string, answer: string) => { answers.push([askId, answer]); }
    };

    return { session, sent, answers, disposed: () => disposed };
}

/**
 * The next turn: it stays open until the test ends it. Its session id is
 * reported at once, as a runtime reports it on start.
 */
function nextTurn(sessionId: string) {

    let finish: (success: boolean) => void = () => undefined;
    let call: Call | undefined;
    let hooks: Hooks | undefined;

    const killed = vi.fn();

    runSessionMock.mockImplementationOnce((given, host) => {

        call = given;
        hooks = host;

        host.registerKill?.(killed);
        host.onSession?.(sessionId);

        return new Promise(resolve => {

            finish = success => resolve({ success, sessionId });
        });
    });

    return {
        killed,
        call: () => call,
        hooks: () => hooks,
        finish: (success = true) => finish(success)
    };
}

/** Waits up to about 20 seconds; git calls can be slow when many test files run at once. */
async function until(check: () => boolean): Promise<void> {

    for (let tries = 0; tries < 2000 && !check(); tries++)
        await new Promise(resolve => setTimeout(resolve, 10));

    expect(check()).toBe(true);
}

/** Lets a handled message settle. */
const settle = () => new Promise(resolve => setTimeout(resolve, 30));

describe("the chat's send path", () => {

    it("starts a new conversation on the first message, in the working folder", async () => {

        const { host } = fakeHost();
        const { send, posted } = chatOn(host);

        const turn = nextTurn("s1");

        send("hello");

        await until(() => turn.call() !== undefined);

        expect(turn.call()!.prompt).toBe("hello");
        expect(turn.call()!.continueSession).toBeUndefined();
        expect(turn.call()!.verbatim).toBe(true);
        expect(turn.hooks()!.workspace).toBe(workspace);

        turn.finish();

        await until(() => posted.some(one => one.type === "busy" && !one.running));
    });

    it("carries the conversation on with the next message", async () => {

        const { host } = fakeHost();
        const { send, posted } = chatOn(host);

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);
        first.finish();
        await until(() => posted.filter(one => one.type === "busy" && !one.running).length === 1);

        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);

        expect(second.call()!.prompt).toBe("two");
        expect(second.call()!.continueSession).toBe("s1");

        second.finish();
    });

    it("reopens the conversation when the model changed since the last turn", async () => {

        const { host, values, sessions } = fakeHost();
        const { send, posted, logs } = chatOn(host);

        values.set(PICK_PREFIX + "chat-1", { provider: "ghcp", model: "model-a" });

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);

        const live = liveSession("s1");

        sessions.hold("chat", live.session);
        first.finish();
        await until(() => posted.filter(one => one.type === "busy" && !one.running).length === 1);

        values.set(PICK_PREFIX + "chat-1", { provider: "ghcp", model: "model-b" });

        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);

        expect(logs()).toContain("Model changed from model-a to model-b - reopening the conversation.\n");
        expect(live.disposed()).toBe(true);
        expect(second.call()!.ai.args.model).toBe("model-b");

        second.finish();
    });

    it("reopens the conversation when the tools pick changed since the last turn", async () => {

        const { host, values } = fakeHost();
        const { send, posted, logs } = chatOn(host);

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);
        first.finish();
        await until(() => posted.filter(one => one.type === "busy" && !one.running).length === 1);

        // What the first turn opened with, as the chat wrote it down.
        expect(values.get(APPLIED_PREFIX + "chat-1")).toBeDefined();

        values.set(APPLIED_PREFIX + "chat-1", "something else");

        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);

        expect(logs()).toContain("Tools or MCP servers changed - reopening the conversation with them.\n");

        second.finish();
    });

    it("keeps a started chat on the runtime it started on", async () => {

        const { host, values } = fakeHost();
        const { send, posted } = chatOn(host);

        values.set(PICK_PREFIX + "chat-1", { provider: "claude" });

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);

        expect(first.call()!.ai.args.provider).toBe("claude");

        first.finish();
        await until(() => posted.filter(one => one.type === "busy" && !one.running).length === 1);

        // The pick is cleared - the settings' default (Copilot) would win.
        values.delete(PICK_PREFIX + "chat-1");

        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);

        expect(second.call()!.ai.args.provider).toBe("claude");
        expect(values.get(PICK_PREFIX + "chat-1")).toMatchObject({ provider: "claude" });

        second.finish();
    });

    it("sends a message typed while the agent works into the running turn", async () => {

        const { host, sessions } = fakeHost();
        const { send, logs } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        const live = liveSession("s1");

        sessions.hold("chat", live.session);

        send("and also this");

        await until(() => live.sent.length === 1);

        expect(live.sent[0]).toEqual({ prompt: "and also this" });
        expect(logs()).toContain("and also this\n");
        expect(runSessionMock).toHaveBeenCalledTimes(1);

        turn.finish();
    });

    it("says so when a message comes before the first turn has its conversation", async () => {

        const { host, notes } = fakeHost();
        const { send } = chatOn(host);

        // A turn that has not reported its session yet.
        let finish: () => void = () => undefined;

        runSessionMock.mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve({ success: true }); }));

        send("one");
        await until(() => runSessionMock.mock.calls.length === 1);

        send("two");
        await until(() => notes.length === 1);

        expect(notes[0]).toBe("Still starting - send it again in a moment.");

        finish();
    });

    it("stops a running turn: the cancel flag first, then every registered stop", async () => {

        const { host } = fakeHost();
        const { chat, send } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        chat.receive({ type: "cancel" });
        await settle();

        expect(turn.hooks()!.isCancelled!()).toBe(true);
        expect(turn.killed).toHaveBeenCalledTimes(1);

        turn.finish(false);
    });

    it("hands an answer to the session that asked", async () => {

        const { host, sessions } = fakeHost();
        const { chat, send, posted, logs } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        const live = liveSession("s1");

        sessions.hold("chat", live.session);

        chat.receive({ type: "answer", askId: "q1", answer: "yes" });

        await until(() => live.answers.length === 1);

        expect(live.answers[0]).toEqual(["q1", "yes"]);
        expect(logs()).toContain("yes\n");

        turn.finish();
        await until(() => posted.some(one => one.type === "busy" && !one.running));
    });

    it("puts the log place in a failure the runtime gave no reason for", async () => {

        const { host } = fakeHost();
        const { send, logs } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        turn.finish(false);

        await until(() => logs().some(line => line.includes("The test log has the full log.")));
    });

    it("refuses to send with no working folder", async () => {

        const { host, notes } = fakeHost();

        host.workspace = () => undefined;

        const { send } = chatOn(host);

        send("one");
        await until(() => notes.length === 1);

        expect(notes[0]).toBe("Open a folder first - the session works in the workspace.");
        expect(runSessionMock).not.toHaveBeenCalled();
    });

    it("tells the view a message never went, so its Sending… line turns into Not sent", async () => {

        const { host, notes } = fakeHost();

        host.workspace = () => undefined;

        const { send, posted } = chatOn(host);

        send("one");
        await until(() => notes.length === 1);
        await settle();

        expect(posted.filter(one => one.type === "unsent")).toHaveLength(1);
    });

    it("tells the view nothing more when the turn logged the message's prompt line", async () => {

        const { host } = fakeHost();
        const { send, posted } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        // What the runtime logs once the message has gone.
        turn.hooks()!.onOutput!("one\n", "stdout", { kind: "prompt" });

        turn.finish();
        await until(() => posted.some(one => one.type === "busy" && !one.running));
        await settle();

        expect(posted.some(one => one.type === "unsent")).toBe(false);
    });

    it("tells the view nothing more for a message that went into the running turn", async () => {

        const { host, sessions } = fakeHost();
        const { send, posted } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);
        turn.hooks()!.onOutput!("one\n", "stdout", { kind: "prompt" });

        const live = liveSession("s1");

        sessions.hold("chat", live.session);

        send("and also this");
        await until(() => live.sent.length === 1);
        await settle();

        expect(posted.some(one => one.type === "unsent")).toBe(false);

        turn.finish();
    });

    it("saves uploads under the scratch folder", async () => {

        const { host } = fakeHost();
        const { send } = chatOn(host);

        const turn = nextTurn("s1");

        send("look", { files: [{ kind: "upload", name: "note.txt", contentBase64: Buffer.from("hi").toString("base64") }] });

        await until(() => turn.call() !== undefined);

        const sent = turn.call()!.sentFiles ?? [];

        expect(sent).toHaveLength(1);
        expect(sent[0].path.startsWith(path.join(workspace, ".scratch", "attachments"))).toBe(true);

        turn.finish();
    });

});

describe("a folder change", () => {

    it("lets the held session go and says the next message reopens the conversation", async () => {

        const { host, sessions } = fakeHost();
        const { chat, send, posted, logs } = chatOn(host);

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);

        const live = liveSession("s1");

        sessions.hold("chat", live.session);
        first.finish();
        await until(() => posted.filter(one => one.type === "busy" && !one.running).length === 1);

        expect(await chat.foldersChanged()).toBe(true);

        expect(live.disposed()).toBe(true);
        expect(logs()).toContain("Folders changed - the next message reopens the conversation with them.\n");

        // The next message carries the conversation on, reopened.
        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);

        expect(second.call()!.continueSession).toBe("s1");

        second.finish();
    });

    it("is refused while a turn runs", async () => {

        const { host, notes } = fakeHost();
        const { chat, send } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        expect(await chat.foldersChanged()).toBe(false);
        expect(notes).toContain("Still working - stop the agent first, then change the folders.");

        turn.finish();
    });
});

describe("a settings change", () => {

    // The settings page: the chat on screen shows a flag or a
    // runtime list change without being opened again.
    it("sends the flags and the runtime pickers again", async () => {

        const { host } = fakeHost();
        const { chat, posted } = chatOn(host);

        const before = posted.length;

        await chat.settingsChanged();

        const sent = posted.slice(before).map(one => one.type);

        expect(sent).toContain("features");
        expect(sent).toContain("aiChoice");
    });
});

describe("export", () => {

    it("is the Handover file's text once someone wrote in the chat, and nothing before", async () => {

        const { host } = fakeHost();
        const { chat, send } = chatOn(host);

        expect(chat.exportText()).toBeUndefined();

        const turn = nextTurn("s1");

        send("explain the parser");
        await until(() => turn.call() !== undefined);

        // What a real turn writes: the message, then the answer.
        turn.hooks()!.onOutput!("explain the parser\n", "stdout", { kind: "prompt" });
        turn.hooks()!.onOutput!("It splits on spaces.\n", "stdout", { kind: "message" });

        turn.finish();
        await settle();

        const exported = chat.exportText();

        expect(exported?.title).toBe("explain the parser");
        expect(exported?.text).toContain("# Handover: explain the parser");
        expect(exported?.text).toContain("### Person\nexplain the parser");
        expect(exported?.text).toContain("### Agent\nIt splits on spaces.");
    });
});

describe("the changed-files bar across several repositories", () => {

    /** A git repository with one committed file, in its own folder under the test's workspace. */
    function repoIn(name: string): string {

        const root = path.join(fs.realpathSync(workspace), name);

        fs.mkdirSync(root);

        const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

        run("init", "-q");
        run("config", "user.email", "test@example.com");
        run("config", "user.name", "Test");
        run("config", "core.autocrlf", "false");

        fs.writeFileSync(path.join(root, "kept.txt"), "kept\n");

        run("add", "-A");
        run("commit", "-q", "-m", "start");

        return root;
    }

    it("lists one turn's files from every watched repository on one line, and undoes in the one named", async () => {

        const api = repoIn("api");
        const web = repoIn("web");

        const { host } = fakeHost();

        host.workspace = () => api;
        host.changeFolders = () => [api, web];

        const trashed: string[] = [];

        host.trash = async file => { trashed.push(file); fs.rmSync(file); };

        const { chat, send, posted } = chatOn(host);

        const turn = nextTurn("s1");

        send("change both");
        await until(() => turn.call() !== undefined);

        // What the agent did in this turn.
        fs.writeFileSync(path.join(api, "a.ts"), "a\n");
        fs.writeFileSync(path.join(web, "w.ts"), "w\n");

        turn.finish();

        const changedLine = () => posted.find((one): one is Extract<ToChatView, { type: "log" }> =>
            one.type === "log" && one.meta?.kind === "files.changed");

        await until(() => changedLine() !== undefined);

        const line = changedLine()!;

        expect(line.text).toBe("Changed 2 files: api/a.ts, web/w.ts\n");
        expect(path.basename(line.meta!.changed!.root)).toBe("api");
        expect(line.meta!.changed!.files).toEqual([{ path: "a.ts", status: "added" }]);
        expect(line.meta!.changedMore).toHaveLength(1);
        expect(path.basename(line.meta!.changedMore![0].root)).toBe("web");

        await until(() => posted.some(one => one.type === "busy" && !one.running));

        chat.receive({ type: "undoFiles", changed: line.meta!.changedMore![0], paths: ["w.ts"] });

        await until(() => trashed.length === 1);

        expect(trashed[0]).toBe(path.join(web, "w.ts"));
        expect(fs.existsSync(path.join(api, "a.ts"))).toBe(true);
    });

    it("refuses an undo in a repository the chat does not watch", async () => {

        const api = repoIn("api");
        const other = repoIn("other");

        const { host } = fakeHost();

        host.workspace = () => api;
        host.changeFolders = () => [api];

        fs.writeFileSync(path.join(other, "x.ts"), "x\n");

        const trashed: string[] = [];

        host.trash = async file => { trashed.push(file); };

        const { chat } = chatOn(host);

        chat.receive({
            type: "undoFiles",
            changed: { root: other, before: "t0", after: "t1", files: [{ path: "x.ts", status: "added" }] },
            paths: ["x.ts"]
        });

        // Long enough for the git calls behind the check to finish.
        await new Promise(resolve => setTimeout(resolve, 1500));

        expect(trashed).toEqual([]);
        expect(fs.existsSync(path.join(other, "x.ts"))).toBe(true);
    });

    it("hands Review all every file inside a watched repository", async () => {

        const api = repoIn("api");
        const other = repoIn("other");

        const { host } = fakeHost();

        host.workspace = () => api;
        host.changeFolders = () => [api];

        const shown: { root: string; file: string; absolute: string }[][] = [];

        host.showReview = async files => { shown.push(files.map(one => ({ root: one.changed.root, file: one.file, absolute: one.absolute }))); };

        const { chat } = chatOn(host);

        chat.receive({
            type: "reviewFiles",
            changes: [
                { root: api, before: "t0", after: "t1", files: [{ path: "a.ts", status: "added" }, { path: "../escape.ts", status: "modified" }] },
                { root: other, before: "t0", after: "t1", files: [{ path: "x.ts", status: "added" }] }
            ]
        });

        await until(() => shown.length === 1);

        // The path out of the repository and the repository not watched are left out.
        expect(shown[0]).toEqual([{ root: api, file: "a.ts", absolute: path.join(api, "a.ts") }]);
    });

    it("hands one turn's diff only a file inside a watched repository", async () => {

        const api = repoIn("api");
        const other = repoIn("other");

        const { host } = fakeHost();

        host.workspace = () => api;
        host.changeFolders = () => [api];

        const shown: { root: string; before: string; after: string; file: string }[] = [];

        host.showTurnDiff = async (changed, file) => { shown.push({ root: changed.root, before: changed.before, after: changed.after, file }); };

        const { chat } = chatOn(host);

        chat.receive({ type: "diffTurn", changed: { root: other, before: "t0", after: "t1" }, path: "x.ts" });
        chat.receive({ type: "diffTurn", changed: { root: api, before: "t0", after: "t1" }, path: "../escape.ts" });
        chat.receive({ type: "diffTurn", changed: { root: api, before: "t0", after: "t1" }, path: "a.ts" });

        await until(() => shown.length === 1);

        // Long enough for the refused ones too, had they gone through.
        await new Promise(resolve => setTimeout(resolve, 300));

        expect(shown).toEqual([{ root: api, before: "t0", after: "t1", file: "a.ts" }]);
    });
});

describe("notices for the host", () => {

    function noticed() {

        const { host } = fakeHost();
        const notices: ChatNotice[] = [];

        host.notify = (_chat, notice) => { notices.push(notice); };

        return { host, notices };
    }

    it("tells the host when a turn ends, done or failed", async () => {

        const { host, notices } = noticed();
        const { send, posted } = chatOn(host);

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);

        first.finish();
        await until(() => notices.length === 1);

        expect(notices[0]).toEqual({ kind: "ended", outcome: "done" });

        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);

        second.finish(false);
        await until(() => notices.length === 2);

        expect(notices[1]).toEqual({ kind: "ended", outcome: "failed" });
        expect(posted.filter(one => one.type === "busy" && !one.running)).toHaveLength(2);
    });

    it("tells the host nothing for a turn the person stopped", async () => {

        const { host, notices } = noticed();
        const { chat, send, posted } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        chat.receive({ type: "cancel" });
        await settle();

        turn.finish(false);
        await until(() => posted.some(one => one.type === "busy" && !one.running));
        await settle();

        expect(notices).toEqual([]);
    });

    it("tells the host each question the agent asks, with its text", async () => {

        const { host, notices } = noticed();
        const { send } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        turn.hooks()!.onOutput!("Which store?\n", "stdout", { kind: "ask", askId: "q1", prompt: "Which store?" });

        expect(notices).toEqual([{ kind: "asked", text: "Which store?" }]);

        turn.finish();
        await until(() => notices.length === 2);
    });

    // The chat list marks a chat whose agent is stopped on a question.
    it("knows the questions still open until an answer line closes them, and none once the turn ends", async () => {

        const { host } = fakeHost();
        const { chat, send } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        expect(chat.waiting).toBeUndefined();

        // Two open at once: the newest is the one shown.
        turn.hooks()!.onOutput!("Which store?\n", "stdout", { kind: "ask", askId: "q1", prompt: "Which store?" });
        turn.hooks()!.onOutput!("Which file?\n", "stdout", { kind: "ask", askId: "q2", prompt: "Which file?" });

        expect(chat.waiting).toBe("Which file?");

        turn.hooks()!.onOutput!("b.ts\n", "stdout", { kind: "answer", askId: "q2" });

        expect(chat.waiting).toBe("Which store?");

        // q1 is never answered: the turn's end closes it.
        turn.finish();
        await until(() => !chat.working);

        expect(chat.waiting).toBeUndefined();

        // Drawn again from the file: its old question stays closed.
        chat.receive({ type: "ready" });
        await settle();

        expect(chat.waiting).toBeUndefined();
    });

    it("tells the host nothing for a chat drawn again from its file", async () => {

        const { host, notices } = noticed();
        const { chat, send } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        turn.hooks()!.onOutput!("Which store?\n", "stdout", { kind: "ask", askId: "q1", prompt: "Which store?" });
        turn.finish();
        await until(() => notices.length === 2);

        // A page reload: the thread is drawn again, the question with it.
        await chat.receive({ type: "ready" });

        expect(notices).toHaveLength(2);
    });
});

describe("the agent's plan", () => {

    it("is saved with the chat, so a reopened chat draws its last plan again", async () => {

        const { host } = fakeHost();
        const { chat, send, posted } = chatOn(host);

        const turn = nextTurn("s1");

        send("fix it");
        await until(() => turn.call() !== undefined);

        const plan = [{ text: "Read the code", status: "completed" as const }, { text: "Fix it", status: "in_progress" as const }];

        turn.hooks()!.onOutput!("Plan: 1 of 2 done.\n", "system", { kind: "notice", plan });
        turn.finish();
        await until(() => posted.some(one => one.type === "busy" && !one.running));

        const planned = () => posted.filter(one => one.type === "log" && one.meta?.plan);

        expect(planned()).toHaveLength(1);

        // A page reload: the thread is drawn again from the chat's file.
        await chat.receive({ type: "ready" });

        await until(() => planned().length === 2);

        expect((planned()[1] as Extract<ToChatView, { type: "log" }>).meta?.plan).toEqual(plan);
    });
});

describe("the compose box's slash commands", () => {

    it("sends the runtime's kept list when the chat opens, and again after each turn, read from its file", async () => {

        const { host } = fakeHost();
        const { chat, send, posted } = chatOn(host);

        const lists = () => posted.filter((one): one is Extract<ToChatView, { type: "commands" }> => one.type === "commands");

        await chat.receive({ type: "ready" });
        await until(() => lists().length === 1);

        // No session has sent a list yet: nothing to offer.
        expect(lists()[0].commands).toEqual([]);

        const choice = posted.find((one): one is Extract<ToChatView, { type: "aiChoice" }> => one.type === "aiChoice");

        // What a session start does - see commandListFile.ts. The test's
        // home is a throwaway folder.
        await keepCommandList(choice!.current.provider, [{ name: "compact", description: "Shrink the chat" }]);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        turn.finish();
        await until(() => lists().length === 2);

        expect(lists()[1].commands).toEqual([{ name: "compact", description: "Shrink the chat" }]);
    });
});

describe("deleting a chat", () => {

    it("deletes the chat's file, then tells the host, so the server drops what it kept for it", async () => {

        const { host } = fakeHost();
        const deleted: string[] = [];

        host.deleted = chatId => { deleted.push(chatId); };

        const file = chatEventsPath(workspace, "chat-old");

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "");

        const { chat } = chatOn(host);

        await chat.receive({ type: "deleteChat", chatId: "chat-old" });

        expect(fs.existsSync(file)).toBe(false);
        expect(deleted).toEqual(["chat-old"]);
    });

    it("tells the host nothing when the person backs out", async () => {

        const { host } = fakeHost();
        const deleted: string[] = [];

        host.confirm = async () => false;
        host.deleted = chatId => { deleted.push(chatId); };

        const { chat } = chatOn(host);

        await chat.receive({ type: "deleteChat", chatId: "chat-old" });

        expect(deleted).toEqual([]);
    });
});

describe("deleting several chats at once", () => {

    /** Chat files with one message each - the history list leaves out a chat with nothing said. */
    function chatFiles(...chatIds: string[]): string[] {

        return chatIds.map(chatId => {

            const file = chatEventsPath(workspace, chatId);

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, [
                { kind: "open", at: 1000, runId: `chat:${chatId}` },
                { kind: "prompt", at: 1000, ownerId: "chat", text: `hello from ${chatId}` }
            ].map(event => JSON.stringify(event)).join("\n") + "\n");

            return file;
        });
    }

    it("asks once with the host's question, then deletes them all and tells the host of each", async () => {

        const { host } = fakeHost();
        const deleted: string[] = [];
        const asked: string[] = [];

        host.confirm = async text => { asked.push(text); return true; };
        host.deleted = chatId => { deleted.push(chatId); };

        const files = chatFiles("chat-a", "chat-b");

        const { chat } = chatOn(host);

        // A chat that is gone already is left out.
        await chat.deleteChats(["chat-a", "chat-b", "chat-gone"], "Delete all 2 chats in 'api'?");

        expect(asked).toEqual(["Delete all 2 chats in 'api'?"]);
        expect(files.map(file => fs.existsSync(file))).toEqual([false, false]);
        expect(deleted).toEqual(["chat-a", "chat-b"]);
    });

    it("deletes nothing, and asks nothing, when one of them is open somewhere else", async () => {

        const { host, notes } = fakeHost();
        const deleted: string[] = [];
        let asked = false;

        host.confirm = async () => { asked = true; return true; };
        host.deleted = chatId => { deleted.push(chatId); };

        const files = chatFiles("chat-a", "chat-held");

        const { chat } = chatOn(host);

        host.holder = chatId => chatId === "chat-held" ? chat : undefined;

        await chat.deleteChats(["chat-a", "chat-held"], "Delete all 2 chats in 'api'?");

        expect(asked).toBe(false);
        expect(deleted).toEqual([]);
        expect(files.map(file => fs.existsSync(file))).toEqual([true, true]);
        expect(notes.at(-1)).toContain("Nothing was deleted");
    });

    it("deletes nothing when the person backs out", async () => {

        const { host } = fakeHost();
        const deleted: string[] = [];

        host.confirm = async () => false;
        host.deleted = chatId => { deleted.push(chatId); };

        const files = chatFiles("chat-a", "chat-b");

        const { chat } = chatOn(host);

        await chat.deleteChats(["chat-a", "chat-b"], "Delete all 2 chats in 'api'?");

        expect(deleted).toEqual([]);
        expect(files.map(file => fs.existsSync(file))).toEqual([true, true]);
    });
});

describe("going back to an earlier message", () => {

    /** A git repository with one committed file, as the working folder. */
    function repo(): string {

        const root = path.join(fs.realpathSync(workspace), "work");

        fs.mkdirSync(root);

        const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

        run("init", "-q");
        run("config", "user.email", "test@example.com");
        run("config", "user.name", "Test");
        run("config", "core.autocrlf", "false");

        fs.writeFileSync(path.join(root, "kept.txt"), "kept\n");

        run("add", "-A");
        run("commit", "-q", "-m", "start");

        return root;
    }

    /**
     * One whole turn: the message's line as `ai@1` writes it, an answer,
     * whatever `during` does to the files, then the end.
     */
    async function turn(
        on: ReturnType<typeof chatOn>,
        sessionId: string,
        text: string,
        options: { attachments?: { path: string; name?: string }[]; during?: () => void } = {}
    ) {

        const ended = () => on.posted.filter(one => one.type === "busy" && !one.running).length;
        const before = ended();

        const next = nextTurn(sessionId);

        on.send(text);
        await until(() => next.call() !== undefined);

        next.hooks()!.onOutput!(`${text}\n`, "stdout", { kind: "prompt", ...(options.attachments ? { attachments: options.attachments } : {}) });
        next.hooks()!.onOutput!(`About ${text}.\n`, "stdout", { kind: "message" });

        options.during?.();

        next.finish();

        await until(() => ended() === before + 1);

        return next;
    }

    const fileOf = (chatId: string) => parseEvents(fs.readFileSync(chatEventsPath(workspace, chatId), "utf8"));

    const promptsIn = (chatId: string) => fileOf(chatId).filter(event => event.kind === "prompt").map(event => event.text);

    it("on Claude: keeps a copy, cuts the thread and the conversation, puts the files back and refills the box", async () => {

        const root = repo();
        const { host, values } = fakeHost();

        host.workspace = () => root;

        const trashed: string[] = [];

        host.trash = async file => { trashed.push(file); fs.rmSync(file); };

        const copies: [string, string][] = [];

        host.copied = (from, to) => { copies.push([from, to]); };

        values.set(PICK_PREFIX + "chat-1", { provider: "claude" });

        const on = chatOn(host);
        const spec = path.join(root, "kept.txt");

        await turn(on, "s1", "first", { during: () => fs.writeFileSync(path.join(root, "a.txt"), "a\n") });

        await turn(on, "s1", "second", {
            attachments: [{ path: spec, name: "kept.txt" }],
            during: () => {

                fs.writeFileSync(path.join(root, "kept.txt"), "changed\n");
                fs.writeFileSync(path.join(root, "b.txt"), "b\n");
            }
        });

        await turn(on, "s1", "third");

        cutPointMock.mockResolvedValue({ kind: "at", upTo: "u-answer-1" });
        forkMock.mockResolvedValue({ sessionId: "s1-cut" });

        // What it would do, first.
        on.chat.receive({ type: "goBackCheck", prompt: { index: 1, text: "second" } });

        await until(() => on.posted.some(one => one.type === "goBackInfo"));

        const info = on.posted.find((one): one is Extract<ToChatView, { type: "goBackInfo" }> => one.type === "goBackInfo")!;

        expect(info.files).toEqual(["b.txt", "kept.txt"]);
        expect(info.about).toMatch(/^Claude's conversation is cut at the same point/);
        expect(cutPointMock).toHaveBeenCalledWith("s1", root, ["second\n", "third\n"]);

        // Nothing changed yet.
        expect(promptsIn("chat-1")).toEqual(["first\n", "second\n", "third\n"]);
        expect(forkMock).not.toHaveBeenCalled();

        on.chat.receive({ type: "goBack", prompt: { index: 1, text: "second" }, restoreFiles: true });

        await until(() => on.posted.some(one => one.type === "refill"));

        const refill = on.posted.find((one): one is Extract<ToChatView, { type: "refill" }> => one.type === "refill")!;

        expect(refill.text).toBe("second");
        expect(refill.files).toEqual([{ path: spec, name: "kept.txt" }]);

        // The conversation was cut where the thread was.
        expect(forkMock).toHaveBeenCalledWith("s1", root, "u-answer-1", "first");
        expect(promptsIn("chat-1")).toEqual(["first\n"]);
        // On the runtime and model the conversation was on.
        expect(lastSession(fileOf("chat-1"), "chat")).toEqual({
            sessionId: "s1-cut", provider: "claude", model: lastSession(fileOf(copies[0][1]), "chat")!.model
        });

        // The copy keeps everything, under its own name.
        expect(copies).toHaveLength(1);
        expect(copies[0][0]).toBe("chat-1");

        const copyId = copies[0][1];

        expect(promptsIn(copyId)).toEqual(["first\n", "second\n", "third\n"]);
        expect((values.get(TITLES_KEY) as Record<string, string>)[copyId]).toBe("first (before going back)");
        expect(values.get(PICK_PREFIX + copyId)).toEqual({ provider: "claude" });
        expect(listChats(workspace).map(chat => chat.id).sort()).toEqual(["chat-1", copyId].sort());

        // The files as they were when "second" was sent.
        expect(fs.readFileSync(path.join(root, "kept.txt"), "utf8")).toBe("kept\n");
        expect(trashed).toEqual([path.join(root, "b.txt")]);
        expect(fs.existsSync(path.join(root, "a.txt"))).toBe(true);

        expect(on.logs().some(text => text.startsWith("Went back to before your message.")
            && text.includes("Claude's conversation was cut at the same point.")
            && text.includes("Put back 2 files: b.txt, kept.txt."))).toBe(true);

        // The next message carries the cut conversation on.
        const next = nextTurn("s1-cut");

        on.send("second, again");
        await until(() => next.call() !== undefined);

        expect(next.call()!.continueSession).toBe("s1-cut");
        expect(next.call()!.prompt).toBe("second, again");

        const ended = on.posted.filter(one => one.type === "busy" && !one.running).length;

        next.finish();

        // Its git snapshot runs in the folder until then.
        await until(() => on.posted.filter(one => one.type === "busy" && !one.running).length === ended + 1);
    });

    it("anywhere else: starts the next message fresh, with what was said before as a file", async () => {

        const { host, values } = fakeHost();

        values.set(PICK_PREFIX + "chat-1", { provider: "ghcp" });

        const on = chatOn(host);

        await turn(on, "g1", "one");
        await turn(on, "g1", "two");

        on.chat.receive({ type: "goBack", prompt: { index: 1, text: "two" }, restoreFiles: false });

        await until(() => on.posted.some(one => one.type === "refill"));

        expect(cutPointMock).not.toHaveBeenCalled();
        expect(promptsIn("chat-1")).toEqual(["one\n"]);
        expect(lastSession(fileOf("chat-1"), "chat")).toBeUndefined();

        const carry = values.get(CARRY_PREFIX + "chat-1") as { path: string; lines: number };

        expect(carry.path).toBe(path.join(workspace, ".scratch", "handovers", path.basename(carry.path)));
        expect(fs.readFileSync(carry.path, "utf8")).toContain("one");

        expect(on.logs().some(text =>
            text.includes("The next message starts a new conversation, and what was said before goes with it as a file."))).toBe(true);

        const next = nextTurn("g2");

        on.send("two, better");
        await until(() => next.call() !== undefined);

        // Sent with the note in front; shown as typed.
        expect(next.call()!.continueSession).toBeUndefined();
        expect(next.call()!.prompt).toMatch(/^## Earlier in this chat\n/);
        expect(next.call()!.prompt).toContain(`\`.scratch/handovers/${path.basename(carry.path)}\``);
        expect(next.call()!.prompt.endsWith("## My message\n\ntwo, better")).toBe(true);
        expect(next.call()!.shown).toBe("two, better");

        next.finish();

        // The new conversation has it now.
        await until(() => values.get(CARRY_PREFIX + "chat-1") === undefined);
    });

    it("on Kiro v3: cuts Kiro's conversation and carries on from the copy", async () => {

        const { host, values } = fakeHost();

        values.set(PICK_PREFIX + "chat-1", { provider: "ghcp" });

        // This runtime stands in for a Kiro v3 one.
        vi.mocked(isKiroV3).mockImplementation((_settings, runtime) => runtime === "ghcp");
        vi.mocked(cutKiroConversation).mockResolvedValue({ kind: "forked", sessionId: "k1-cut" });

        try {

            const on = chatOn(host);

            await turn(on, "k1", "one");
            await turn(on, "k1", "two");

            on.chat.receive({ type: "goBack", prompt: { index: 1, text: "two" }, restoreFiles: false });

            await until(() => on.posted.some(one => one.type === "refill"));

            expect(cutPointMock).not.toHaveBeenCalled();
            expect(vi.mocked(cutKiroConversation)).toHaveBeenCalledWith("ghcp", "k1", workspace, ["two\n"], undefined);
            expect(promptsIn("chat-1")).toEqual(["one\n"]);
            expect(lastSession(fileOf("chat-1"), "chat")).toMatchObject({ sessionId: "k1-cut", provider: "ghcp" });
            expect(values.get(CARRY_PREFIX + "chat-1")).toBeUndefined();
            expect(on.logs().some(text => text.includes("Kiro's conversation was cut at the same point."))).toBe(true);

        } finally {

            vi.mocked(isKiroV3).mockImplementation(() => false);
        }
    });

    it("on Kiro v3, going back to the first message: starts fresh, with nothing to carry", async () => {

        const { host, values } = fakeHost();

        values.set(PICK_PREFIX + "chat-1", { provider: "ghcp" });

        vi.mocked(isKiroV3).mockImplementation((_settings, runtime) => runtime === "ghcp");
        vi.mocked(cutKiroConversation).mockResolvedValue({ kind: "empty" });

        try {

            const on = chatOn(host);

            await turn(on, "k1", "one");

            on.chat.receive({ type: "goBack", prompt: { index: 0, text: "one" }, restoreFiles: false });

            await until(() => on.posted.some(one => one.type === "refill"));

            expect(lastSession(fileOf("chat-1"), "chat")).toBeUndefined();
            expect(values.get(CARRY_PREFIX + "chat-1")).toBeUndefined();

        } finally {

            vi.mocked(isKiroV3).mockImplementation(() => false);
        }
    });

    it("on Claude, when the message is not found in its conversation: starts fresh and says why", async () => {

        const { host, values } = fakeHost();

        values.set(PICK_PREFIX + "chat-1", { provider: "claude" });

        const on = chatOn(host);

        await turn(on, "s1", "one");
        await turn(on, "s1", "two");

        cutPointMock.mockResolvedValue({ kind: "unmatched", reason: "It may have been compacted." });

        on.chat.receive({ type: "goBack", prompt: { index: 1, text: "two" }, restoreFiles: false });

        await until(() => on.posted.some(one => one.type === "refill"));

        expect(forkMock).not.toHaveBeenCalled();
        expect(lastSession(fileOf("chat-1"), "chat")).toBeUndefined();
        expect(values.get(CARRY_PREFIX + "chat-1")).toBeDefined();
        expect(on.logs().some(text => text.includes("It may have been compacted."))).toBe(true);
    });

    it("an edited message: goes back, then sends the new text with the message's files", async () => {

        const { host, values } = fakeHost();

        values.set(PICK_PREFIX + "chat-1", { provider: "claude" });

        const on = chatOn(host);
        const spec = path.join(workspace, "spec.md");

        fs.writeFileSync(spec, "# Spec\n");

        await turn(on, "s1", "first", { attachments: [{ path: spec, name: "spec.md" }] });

        // The first message: nothing before it to keep.
        cutPointMock.mockResolvedValue({ kind: "empty" });

        const next = nextTurn("s2");

        on.chat.receive({ type: "goBack", prompt: { index: 0, text: "first" }, restoreFiles: false, text: "first, edited" });

        await until(() => next.call() !== undefined);

        expect(next.call()!.prompt).toBe("first, edited");
        expect(next.call()!.continueSession).toBeUndefined();
        expect(next.call()!.sentFiles).toEqual([expect.objectContaining({ path: spec })]);
        expect(on.posted.some(one => one.type === "refill")).toBe(false);
        expect(values.get(CARRY_PREFIX + "chat-1")).toBeUndefined();

        next.finish();
    });

    it("does nothing when the view's message is not the file's", async () => {

        const { host, notes } = fakeHost();
        const copies: string[] = [];

        host.copied = (_from, to) => { copies.push(to); };

        const on = chatOn(host);

        await turn(on, "g1", "one");

        on.chat.receive({ type: "goBack", prompt: { index: 0, text: "something else" }, restoreFiles: true });
        on.chat.receive({ type: "goBack", prompt: { index: 3, text: "one" }, restoreFiles: true });

        await until(() => notes.length === 2);

        expect(notes[0]).toMatch(/^That message is not in this session any more/);
        expect(copies).toEqual([]);
        expect(promptsIn("chat-1")).toEqual(["one\n"]);
    });

    it("refuses while the agent is working", async () => {

        const { host, notes } = fakeHost();
        const on = chatOn(host);

        await turn(on, "g1", "one");

        const busy = nextTurn("g1");

        on.send("two");
        await until(() => busy.call() !== undefined);

        on.chat.receive({ type: "goBack", prompt: { index: 0, text: "one" }, restoreFiles: false });

        await until(() => notes.length === 1);

        expect(notes[0]).toBe("Still working - stop the agent first, then go back.");

        busy.finish();
    });
});

describe("the Permissions picker and saved answers", () => {

    /** A host with a permission check, holding two saved answers. */
    function withPermissions() {

        const base = fakeHost();

        const saved: SavedAnswer[] = [
            { id: "1", kind: "edit", pattern: `${workspace.replace(/\\/g, "/")}/src/**`, scope: "folder", folder: workspace, savedAt: 1, agent: "claude" },
            { id: "2", kind: "mcp", pattern: "ado/*", scope: "always", savedAt: 2, agent: "ghcp" }
        ];

        const removed: string[] = [];

        const host: ChatHost = {
            ...base.host,
            permissions: {
                saved: () => saved.filter(one => !removed.includes(one.id)),
                remove: id => { removed.push(id); return true; }
            }
        };

        return { ...base, host, removed, saved };
    }

    const choiceOf = (posted: ToChatView[]) =>
        posted.filter((one): one is Extract<ToChatView, { type: "aiChoice" }> => one.type === "aiChoice").at(-1)?.choice;

    const listsOf = (posted: ToChatView[]) =>
        posted.filter((one): one is Extract<ToChatView, { type: "savedAnswers" }> => one.type === "savedAnswers");

    it("sends a level per runtime and how many answers are saved", async () => {

        const { host } = withPermissions();
        const { chat, posted } = chatOn(host);

        chat.receive({ type: "ready" });

        await until(() => choiceOf(posted) !== undefined);

        expect(choiceOf(posted)!.levels).toEqual({ ghcp: { level: "auto", acp: false }, claude: { level: "auto", acp: false } });
        expect(choiceOf(posted)!.savedAnswers).toBe(2);
    });

    it("saves a level the runtime offers, and refuses one it does not", async () => {

        const { host, values } = withPermissions();
        const { chat } = chatOn(host);

        chat.receive({ type: "setPermissionLevel", provider: "claude", level: "manual" });

        await until(() => (values.get("eesha.permissionLevels") as Record<string, string> | undefined)?.claude === "manual");

        // Agent's Choice is an ACP agent's level, not Claude's.
        chat.receive({ type: "setPermissionLevel", provider: "claude", level: "agent" });
        await settle();

        expect(values.get("eesha.permissionLevels")).toEqual({ claude: "manual" });
    });

    it("lists the saved answers in a person's words, and removes one", async () => {

        const { host, removed } = withPermissions();
        const { chat, posted } = chatOn(host);

        chat.receive({ type: "listSavedAnswers" });

        await until(() => listsOf(posted).length === 1);

        expect(listsOf(posted)[0]).toMatchObject({ chat: "New session", folder: workspace });
        expect(listsOf(posted)[0].answers.map(one => one.shown)).toEqual(["src/**", "ado · every tool"]);

        chat.receive({ type: "removeSavedAnswer", id: "1" });

        await until(() => listsOf(posted).length === 2);

        expect(removed).toEqual(["1"]);
        expect(listsOf(posted)[1].answers.map(one => one.id)).toEqual(["2"]);
    });

    it("sends the count again when a saved answer is added elsewhere - a card in this chat or another", async () => {

        const { host, saved } = withPermissions();
        const { chat, posted } = chatOn(host);

        chat.receive({ type: "ready" });

        await until(() => choiceOf(posted)?.savedAnswers === 2);

        saved.push({ id: "3", kind: "command", pattern: "npm run build *", scope: "always", savedAt: 3, agent: "claude" });

        await chat.savedAnswersChanged();

        expect(choiceOf(posted)!.savedAnswers).toBe(3);
    });
});

describe("a phase chat - one SDD made for a phase of a spec", () => {

    /** SDD's side, writing down what the chat asked of it. */
    function phaseOwner(refusal?: string, resumable = false) {

        const asked: { pick?: AiPick }[] = [];
        const events: string[] = [];

        const owner: PhaseOwner = {
            plugins: () => ({}) as PluginHost,
            ai: async pick => {

                asked.push({ ...(pick ? { pick } : {}) });

                return { uses: "ai@1", args: { provider: "claude", model: "spec-model", agentMode: "spec" } };
            },
            extras: async () => ({ refuseWrites: [path.join(workspace, "design.md")] }),
            refuse: () => refusal,
            resumable: () => resumable,
            started: () => { events.push("started"); },
            ended: async success => { events.push(`ended ${success}`); }
        };

        return { owner, asked, events };
    }

    it("runs a turn SDD hands it with the phase's own call, and says a missing document in the thread", async () => {

        const { host } = fakeHost();
        const { chat, posted, logs } = chatOn(host);

        const turn = nextTurn("s1");

        const ran = chat.runOwned(
            {
                session: "requirements",
                prompt: "Write requirements.md",
                title: "requirements - demo",
                attachments: [{ name: "idea", path: "idea.md" }],
                target: "requirements.md",
                refuseWrites: [path.join(workspace, "design.md")],
                interactive: true,
                detach: true,
                ai: { uses: "ai@1", args: { provider: "claude" } }
            },
            () => "The requirements phase reported success without writing 'requirements.md'.");

        await until(() => turn.call() !== undefined);

        // The chat's own name for the conversation, held after the turn
        // and waited for - never detached.
        expect(turn.call()).toMatchObject({
            session: "chat",
            prompt: "Write requirements.md",
            title: "requirements - demo",
            target: "requirements.md",
            refuseWrites: [path.join(workspace, "design.md")],
            keep: true,
            interactive: true
        });
        expect(turn.call()!.detach).toBeUndefined();
        expect(chat.working).toBe(true);

        turn.finish(true);

        expect(await ran).toEqual({ success: true, sessionId: "s1" });
        expect(chat.working).toBe(false);
        expect(chat.held()).toMatchObject({ sessionId: "s1", provider: "claude" });
        expect(logs()).toContain("The requirements phase reported success without writing 'requirements.md'.\n");
        expect(posted.some(one => one.type === "busy" && one.running === false)).toBe(true);
    });

    it("refuses a turn SDD hands it while another turn runs, doing nothing", async () => {

        const { host } = fakeHost();
        const { chat, send } = chatOn(host);

        const turn = nextTurn("s1");

        send("one");
        await until(() => turn.call() !== undefined);

        expect(await chat.runOwned({ session: "x", prompt: "p", title: "t", attachments: [], ai: { uses: "ai@1", args: {} } }))
            .toEqual({ success: false });
        expect(runSessionMock).toHaveBeenCalledTimes(1);

        turn.finish();
    });

    it("runs a typed turn on the spec's AI with the phase's write block, and tells SDD when it starts and ends", async () => {

        const { host } = fakeHost();
        const { owner, asked, events } = phaseOwner();

        host.owner = () => owner;

        const { send } = chatOn(host);

        const turn = nextTurn("s1");

        send("tighten the third requirement");
        await until(() => turn.call() !== undefined);

        expect(asked).toEqual([{}]);
        expect(turn.call()).toMatchObject({
            prompt: "tighten the third requirement",
            verbatim: true,
            refuseWrites: [path.join(workspace, "design.md")],
            ai: { uses: "ai@1", args: { provider: "claude", model: "spec-model", agentMode: "spec" } }
        });

        // Neither the chat's tools pick nor its standing instructions.
        expect(turn.call()!.ai.args.systemInstructions).toBeUndefined();
        expect(events).toEqual(["started"]);

        turn.finish(true);

        await until(() => events.length === 2);

        expect(events).toEqual(["started", "ended true"]);
    });

    it("keeps a typed turn on the runtime the phase chat started on", async () => {

        const { host } = fakeHost();
        const { owner, asked } = phaseOwner();

        host.owner = () => owner;

        const { send } = chatOn(host);

        const first = nextTurn("s1");

        send("one");
        await until(() => first.call() !== undefined);
        first.finish();
        await settle();

        const second = nextTurn("s1");

        send("two");
        await until(() => second.call() !== undefined);
        second.finish();

        expect(asked[1]).toEqual({ pick: { provider: "claude" } });
        expect(second.call()!.continueSession).toBe("s1");
    });

    it("holds a typed turn back while another phase of the spec runs", async () => {

        const { host, notes } = fakeHost();
        const { owner, events } = phaseOwner("Still working on design of demo - wait for it, or stop it on the spec.");

        host.owner = () => owner;

        const { send } = chatOn(host);

        send("one");
        await until(() => notes.length === 1);

        expect(notes[0]).toBe("Still working on design of demo - wait for it, or stop it on the spec.");
        expect(runSessionMock).not.toHaveBeenCalled();
        expect(events).toEqual([]);
    });

    /* A wave chat a stopped plan waits on offers Resume - on opening, and whenever SDD says it changed. */
    it("says whether to offer Resume when its tab opens it, and again when asked", async () => {

        const { host } = fakeHost();
        let waits = true;
        const { owner } = phaseOwner();

        host.owner = () => ({ ...owner, resumable: () => waits });

        const { chat, posted } = chatOn(host);
        const resumes = () => posted.filter(one => one.type === "resumable").map(one => (one as { on: boolean }).on);

        chat.receive({ type: "ready" });

        await until(() => resumes().length === 1);

        expect(resumes()).toEqual([true]);

        waits = false;
        chat.postResume();

        expect(resumes()).toEqual([true, false]);
    });

    it("never offers Resume in a chat of your own", async () => {

        const { host } = fakeHost();
        const { chat, posted } = chatOn(host);

        chat.receive({ type: "ready" });

        await until(() => posted.some(one => one.type === "resumable"));

        expect(posted.find(one => one.type === "resumable")).toEqual({ type: "resumable", on: false });
    });
});

describe("a turn the host holds back", () => {

    it("does not start, and the thread says why", async () => {

        const { host } = fakeHost();
        const asked: string[] = [];

        host.beforeTurn = async provider => { asked.push(provider); return "Claude did not start: its own memory is still on."; };

        const { send, posted } = chatOn(host);

        await send("hello");

        await until(() => posted.some(one => one.type === "busy" && one.running === false));

        expect(runSessionMock).not.toHaveBeenCalled();
        expect(asked).toHaveLength(1);
        expect(JSON.stringify(posted)).toContain("Claude did not start: its own memory is still on.");
    });

    it("starts when the host has nothing to say", async () => {

        const { host } = fakeHost();

        host.beforeTurn = async () => undefined;

        const turn = nextTurn("s-held-1");
        const { send } = chatOn(host);

        await send("hello");

        await until(() => turn.call() !== undefined);

        turn.finish(true);
    });
});

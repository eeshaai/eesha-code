// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../chat/turnSnapshot", () => ({ contentAt: vi.fn() }));

import { AgentSessions } from "../../core/agent";
import { AnswerBook } from "../../core/agent/permissions";
import type { ChatController } from "../../chat/ChatController";
import { contentAt } from "../../chat/turnSnapshot";
import type { ConnectorsConfig } from "../connectors/config";
import { Connectors } from "../connectors/Connectors";
import { APP_INSTRUCTIONS, connectorsNote, KIRO_PLACE } from "../instructions";
import { Memory } from "../memory/Memory";
import { MemoryStore } from "../memory/memoryStore";
import { ServerChatHost, HostServer } from "../ServerChatHost";
import { FileStore } from "../fileStore";
import { eeshaPath } from "../paths";
import { folderKey, KEEP_FOLDER, type MemoryChoices, type PromptRequest, type ToPage } from "../protocol";
import { readSession, writeSession } from "../sessions";
import { saveWorkspace } from "../workspaces";

/*
 * One chat's host in Eesha Code: what the chat asks of the program around
 * it, answered with files and page messages. The server is a stand-in
 * that records what was sent to the page.
 */

const contentAtMock = vi.mocked(contentAt);

function temporaryFolder(): string {

    return fs.mkdtempSync(path.join(os.tmpdir(), "eesha-host-"));
}

/** Memory is off unless a test turns it on, so the tests of other things see none of it. */
const MEMORY_OFF: MemoryChoices = { access: "off", askOnSave: false, claudeMemoryOff: false };

function setUp(folders: string[], chatId = "chat-1", answer?: string, scratch = false, memoryChoices: MemoryChoices = MEMORY_OFF, workspace?: string) {

    const sent: ToPage[] = [];
    const asked: PromptRequest[] = [];
    const changed: string[] = [];
    const kept: string[] = [];

    /** The workspace pages a deleted chat's tab was sent to. */
    const leftFor: string[] = [];

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
        ask: async (_chat, prompt) => { asked.push(prompt); return answer; },
        toAll: message => { sent.push(message); },
        holder: () => undefined,
        chatChanged: chat => { changed.push(chat.chatId); },
        renamed: () => undefined,
        chatDeleted: () => undefined,
        toWorkspacePage: (_chat, workspace) => { leftFor.push(workspace); },
        keepFolder: async folder => { kept.push(folder); },
        notify: () => undefined,
        phaseOwner: () => undefined,
        evalChanged: () => undefined
    };

    const host = new ServerChatHost(server, { folders, scratch, ...(workspace ? { workspace } : {}) });
    const chat = { chatId, reveal: vi.fn() } as unknown as ChatController;

    host.bind(chat);

    return { host, chat, sent, asked, changed, kept, leftFor, server };
}

beforeEach(() => contentAtMock.mockReset());

describe("the chat on screen deleted", () => {

    it("sends its tab to the page of the workspace it is in", () => {

        const { host, leftFor } = setUp([temporaryFolder()], "chat-1", undefined, false, MEMORY_OFF, "ws-key");

        host.leaveDeleted();

        expect(leftFor).toEqual(["ws-key"]);
    });

    it("in no workspace, sends the tab nowhere - a new chat takes its place", () => {

        const { host, leftFor } = setUp([temporaryFolder()]);

        host.leaveDeleted();

        expect(leftFor).toEqual([]);
    });
});

describe("a copy made by going back", () => {

    it("gets the same folders, and works in the scratch folder of the chat it was copied from", async () => {

        const work = temporaryFolder();

        writeSession("chat-1", { folders: [work], scratch: true });

        const { host, chat } = setUp([work], "chat-1", undefined, true);

        host.copied("chat-1", "chat-copy");

        expect(readSession("chat-copy")).toEqual({ folders: [work], scratch: true, scratchOf: "chat-1" });

        // Opened later: its runtime conversation is under chat-1's scratch folder.
        (chat as { chatId: string }).chatId = "chat-copy";

        await host.changed(chat);

        expect(host.scratchFolder()).toBe(eeshaPath("scratch", "chat-1"));
        expect(host.workspace()).toBe(eeshaPath("scratch", "chat-1"));

        // A folder change keeps it there.
        host.setFolders([work]);

        expect(readSession("chat-copy")).toEqual({ folders: [work], scratch: true, scratchOf: "chat-1" });
    });

    it("of a copy, points at the first chat's scratch folder still", () => {

        writeSession("chat-copy", { folders: [], scratch: false, scratchOf: "chat-1" });

        const { host } = setUp([], "chat-copy");

        host.copied("chat-copy", "chat-copy-2");

        expect(readSession("chat-copy-2")).toEqual({ folders: [], scratch: false, scratchOf: "chat-1" });
    });
});

describe("folders", () => {

    it("works in the first folder and offers every folder to steering", () => {

        const [work, extra] = [temporaryFolder(), temporaryFolder()];

        const { host } = setUp([work, extra]);

        expect(host.workspace()).toBe(work);
        expect(host.folders()).toEqual([work, extra]);
        expect(host.historyKey()).toBeUndefined();
        expect(host.ai.workspaceFolder()).toBeUndefined();
        expect(host.scratchFolder()).toBe(eeshaPath("scratch", "chat-1"));
    });

    it("saves a folder change under the chat's id", () => {

        const [work, extra] = [temporaryFolder(), temporaryFolder()];

        const { host } = setUp([work]);

        host.setFolders([work, extra]);

        expect(host.folders()).toEqual([work, extra]);
        expect(readSession("chat-1")).toEqual({ folders: [work, extra], scratch: false });
    });

    it("gives a new chat no folder, and a chat opened again its own", async () => {

        const [work, old] = [temporaryFolder(), temporaryFolder()];

        const { host, chat, changed } = setUp([work], "chat-new");

        await host.changed(chat);

        expect(readSession("chat-new")).toEqual({ folders: [], scratch: false });
        expect(host.inScratch()).toBe(true);
        expect(changed).toEqual(["chat-new"]);

        writeSession("chat-old", { folders: [old], scratch: false });

        (chat as { chatId: string }).chatId = "chat-old";

        await host.changed(chat);

        expect(host.folders()).toEqual([old]);
        expect(host.inScratch()).toBe(false);
    });

    it("works in the scratch folder with no folder, made on the spot, and lists nothing from it", () => {

        const { host } = setUp([], "chat-bare");

        const scratch = eeshaPath("scratch", "chat-bare");

        expect(host.inScratch()).toBe(true);
        expect(host.workspace()).toBe(scratch);
        expect(fs.existsSync(scratch)).toBe(true);
        expect(host.folders()).toEqual([scratch]);
        expect(host.userFolders()).toEqual([]);
        expect(host.changeFolders()).toEqual([]);
    });

    it("stays in scratch once pinned there, with folders added later as extras whose changes are listed", () => {

        const extra = temporaryFolder();

        const { host } = setUp([], "chat-pinned");

        host.setFolders([extra], true);

        const scratch = eeshaPath("scratch", "chat-pinned");

        expect(host.workspace()).toBe(scratch);
        expect(host.folders()).toEqual([scratch, extra]);
        expect(host.userFolders()).toEqual([extra]);
        expect(host.changeFolders()).toEqual([extra]);
        expect(readSession("chat-pinned")).toEqual({ folders: [extra], scratch: true });
    });

    it("leaves scratch for the first folder picked while it is not pinned", () => {

        const work = temporaryFolder();

        const { host } = setUp([], "chat-free");

        host.setFolders([work]);

        expect(host.inScratch()).toBe(false);
        expect(host.workspace()).toBe(work);
        expect(host.changeFolders()).toEqual([work]);
    });
});

describe("files", () => {

    it("shows a file inside the chat's folders", () => {

        const work = temporaryFolder();

        fs.writeFileSync(path.join(work, "a.txt"), "hello");

        const { host, sent } = setUp([work]);

        host.openFile("a.txt");

        expect(sent).toEqual([{ type: "eesha.file", path: path.join(work, "a.txt"), text: "hello" }]);
    });

    it("refuses a file outside the chat's folders, and a file that is not text", () => {

        const [work, elsewhere] = [temporaryFolder(), temporaryFolder()];

        fs.writeFileSync(path.join(elsewhere, "secret.txt"), "no");
        fs.writeFileSync(path.join(work, "image.bin"), Buffer.from([1, 0, 2]));

        const { host, sent } = setUp([work]);

        host.openFile(path.join(elsewhere, "secret.txt"));
        host.openFile("image.bin");

        expect(sent[0]).toMatchObject({ type: "eesha.file", problem: "Only files inside this session's workspace open here." });
        expect(sent[1]).toMatchObject({ type: "eesha.file" });
        expect((sent[1] as { problem?: string }).problem).toContain("Not a text file");
    });

    it("shows a file outside the chat's folders when the context window lists it, and lets the page read only that one again", () => {

        const [work, elsewhere] = [temporaryFolder(), temporaryFolder()];

        const steering = path.join(elsewhere, "tech.md");

        fs.writeFileSync(steering, "use tabs");
        fs.writeFileSync(path.join(elsewhere, "secret.txt"), "no");

        const { host, sent } = setUp([work]);

        expect(host.mayShow(steering)).toBe(false);

        host.openFile(steering, true);

        expect(sent).toEqual([{ type: "eesha.file", path: steering, text: "use tabs" }]);
        expect(host.mayShow(steering)).toBe(true);
        expect(host.mayShow(path.join(elsewhere, "secret.txt"))).toBe(false);
    });

    it("diffs a changed file: before the turn against now", async () => {

        const work = temporaryFolder();

        fs.writeFileSync(path.join(work, "a.txt"), "new");

        contentAtMock.mockResolvedValue(Buffer.from("old"));

        const { host, sent } = setUp([work]);

        await host.showDiff({ root: work, before: "t1", after: "t2" }, "a.txt", path.join(work, "a.txt"));

        expect(contentAtMock).toHaveBeenCalledWith(work, "t1", "a.txt");
        expect(sent).toEqual([{ type: "eesha.diff", path: "a.txt", before: "old", after: "new", from: { root: work, before: "t1", after: "t2", file: "a.txt" } }]);
    });

    it("names the repository in the diff's title when the chat has several folders", async () => {

        const [api, web] = [temporaryFolder(), temporaryFolder()];

        fs.writeFileSync(path.join(web, "w.ts"), "new");

        contentAtMock.mockResolvedValue(Buffer.from("old"));

        const { host, sent } = setUp([api, web]);

        await host.showDiff({ root: web, before: "t1", after: "t2" }, "w.ts", path.join(web, "w.ts"));

        expect(sent).toEqual([{ type: "eesha.diff", path: `${path.basename(web)}/w.ts`, before: "old", after: "new", from: { root: web, before: "t1", after: "t2", file: "w.ts" } }]);
    });

    it("diffs an added file with no before, and a deleted one with an empty after", async () => {

        const work = temporaryFolder();

        fs.writeFileSync(path.join(work, "added.txt"), "all new");

        contentAtMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(Buffer.from("was here"));

        const { host, sent } = setUp([work]);

        await host.showDiff({ root: work, before: "t1", after: "t2" }, "added.txt", path.join(work, "added.txt"));
        await host.showDiff({ root: work, before: "t1", after: "t2" }, "gone.txt", path.join(work, "gone.txt"));

        expect(sent).toEqual([
            { type: "eesha.diff", path: "added.txt", after: "all new", from: { root: work, before: "t1", after: "t2", file: "added.txt" } },
            { type: "eesha.diff", path: "gone.txt", before: "was here", after: "", from: { root: work, before: "t1", after: "t2", file: "gone.txt" } }
        ]);
    });

    it("diffs what one turn did from its two snapshots, not from the file as it is now", async () => {

        const work = temporaryFolder();

        fs.writeFileSync(path.join(work, "a.txt"), "changed again later");

        contentAtMock.mockResolvedValueOnce(Buffer.from("old")).mockResolvedValueOnce(Buffer.from("new"));

        const { host, sent } = setUp([work]);

        await host.showTurnDiff({ root: work, before: "t1", after: "t2" }, "a.txt");

        expect(contentAtMock).toHaveBeenNthCalledWith(1, work, "t1", "a.txt");
        expect(contentAtMock).toHaveBeenNthCalledWith(2, work, "t2", "a.txt");
        expect(sent).toEqual([{ type: "eesha.diff", path: "a.txt", before: "old", after: "new", turn: true, from: { root: work, before: "t1", after: "t2", file: "a.txt" } }]);
    });

    it("sends every file for Review all in one message, each with what Undo needs", async () => {

        const work = temporaryFolder();

        fs.writeFileSync(path.join(work, "a.txt"), "new");
        fs.writeFileSync(path.join(work, "added.txt"), "all new");

        contentAtMock.mockResolvedValueOnce(Buffer.from("old")).mockResolvedValueOnce(undefined);

        const { host, sent } = setUp([work]);

        const changed = { root: work, before: "t1", after: "t2", files: [{ path: "a.txt", status: "modified" as const }, { path: "added.txt", status: "added" as const }] };

        await host.showReview([
            { changed, file: "a.txt", absolute: path.join(work, "a.txt") },
            { changed, file: "added.txt", absolute: path.join(work, "added.txt") }
        ]);

        expect(sent).toEqual([{
            type: "eesha.review",
            files: [
                { path: "a.txt", file: "a.txt", status: "modified", changed, before: "old", after: "new" },
                { path: "added.txt", file: "added.txt", status: "added", changed, after: "all new" }
            ]
        }]);
    });

    it("moves a file an undo removes into Eesha Code's trash, not out of existence", async () => {

        const work = temporaryFolder();
        const file = path.join(work, "added.txt");

        fs.writeFileSync(file, "keep me");

        const { host } = setUp([work]);

        await host.trash(file);

        expect(fs.existsSync(file)).toBe(false);

        const trashed = fs.readdirSync(eeshaPath("trash")).map(folder => path.join(eeshaPath("trash"), folder, "added.txt"));

        expect(trashed.some(one => fs.existsSync(one) && fs.readFileSync(one, "utf8") === "keep me")).toBe(true);
    });
});

describe("questions and notices", () => {

    it("confirms only when the page answers with the action", async () => {

        expect(await setUp([temporaryFolder()], "c", "Delete").host.confirm("Delete it?", "Delete")).toBe(true);
        expect(await setUp([temporaryFolder()], "c", undefined).host.confirm("Delete it?", "Delete")).toBe(false);
    });

    it("offers to keep a folder once, and keeps it when the box stays ticked", async () => {

        const { host, asked, kept } = setUp([temporaryFolder()], "c", `Delete${KEEP_FOLDER}`);

        host.keepOffer = { folder: "/work/api", label: "Keep 'api' in the list, with no sessions" };

        expect(await host.confirm("Delete it?", "Delete")).toBe(true);
        expect(asked[0]).toEqual({ kind: "confirm", text: "Delete it?", action: "Delete", keep: "Keep 'api' in the list, with no sessions" });
        expect(kept).toEqual(["/work/api"]);

        // Used up: the next question has no box.
        await host.confirm("Again?", "Delete");

        expect(asked[1]).toEqual({ kind: "confirm", text: "Again?", action: "Delete" });
    });

    it("keeps no folder when the box is unticked or the question is backed out of", async () => {

        for (const answer of ["Delete", undefined]) {

            const { host, kept } = setUp([temporaryFolder()], "c", answer);

            host.keepOffer = { folder: "/work/api", label: "Keep" };

            expect(await host.confirm("Delete it?", "Delete")).toBe(answer === "Delete");
            expect(kept).toEqual([]);
        }
    });

    it("asks for text as the page's question", async () => {

        const { host, asked } = setUp([temporaryFolder()], "c", "New name");

        expect(await host.askText({ title: "Rename chat", value: "Old", prompt: "Name?" })).toBe("New name");
        expect(asked).toEqual([{ kind: "text", title: "Rename chat", value: "Old", text: "Name?" }]);
    });

    it("tells every tab when a chat with no tab waits for an answer", () => {

        const { host, sent } = setUp([temporaryFolder()], "chat-9");

        host.announceAsk("chat 'Fix it'", "Allow?", undefined);

        expect(sent).toEqual([{ type: "eesha.attention", text: "The agent in chat 'Fix it' is waiting for an answer.", chatId: "chat-9" }]);
    });
});

describe("plugins", () => {

    it("builds the registry once per chat", () => {

        const { host } = setUp([temporaryFolder()]);

        expect(host.plugins()).toBe(host.plugins());
    });
});

describe("our own permission check", () => {

    it("hands the chat the server's saved answers, and removes one", () => {

        const work = temporaryFolder();

        const { host, server } = setUp([work]);

        const mine = server.answers.add({ kind: "command", pattern: "npm *", scope: "session", chatId: "chat-1", agent: "claude" })!;

        server.answers.add({ kind: "command", pattern: "ls", scope: "session", chatId: "chat-2", agent: "claude" });

        expect(host.permissions.saved("chat-1", work)).toEqual([mine]);
        expect(host.permissions.remove(mine.id)).toBe(true);
        expect(host.permissions.saved("chat-1", work)).toEqual([]);
    });

    it("a card's Add folder joins the chat's folder list, is saved, and the page is told - once", () => {

        const work = temporaryFolder();
        const other = temporaryFolder();

        const { host, changed } = setUp([work]);

        host.addFolderFromCard(other);
        host.addFolderFromCard(other);

        expect(host.userFolders()).toEqual([work, other]);
        expect(host.workspace()).toBe(work);
        expect(readSession("chat-1")).toEqual({ folders: [work, other], scratch: false });
        expect(changed).toEqual(["chat-1"]);
    });

    it("a chat working in its scratch folder stays there when a card adds a folder", () => {

        const other = temporaryFolder();

        const { host } = setUp([], "chat-s");

        host.addFolderFromCard(other);

        expect(host.workspace()).toBe(eeshaPath("scratch", "chat-s"));
        expect(readSession("chat-s")).toEqual({ folders: [other], scratch: true });
    });

    it("reopens the conversation when the turn ends, not before, and only once", async () => {

        const work = temporaryFolder();

        const { host, chat } = setUp([work]);

        const foldersChanged = vi.fn(async () => true);

        Object.assign(chat, { working: false, foldersChanged });

        host.addFolderFromCard(temporaryFolder());

        expect(foldersChanged).not.toHaveBeenCalled();

        await host.changed(chat);
        await host.changed(chat);

        expect(foldersChanged).toHaveBeenCalledTimes(1);
    });

    it("a copy made by going back keeps the chat's session answers", () => {

        const { host, server } = setUp([temporaryFolder()]);

        server.answers.add({ kind: "command", pattern: "git status", scope: "session", chatId: "chat-1", agent: "ghcp" });

        host.copied("chat-1", "chat-copy");

        expect(server.answers.applying("chat-copy", "").map(answer => answer.pattern)).toEqual(["git status"]);
    });
});

describe("what a new session is told", () => {

    const ADO_CONNECTED: ConnectorsConfig = {
        ado: {
            reach: [{ org: "contoso", project: "Web" }],
            sources: { workitems: "write", queries: "off", repos: "off", pulls: "off", builds: "off", releases: "off", wiki: "off", testplans: "off" }
        }
    };

    it("is Eesha Code's own text alone in a chat with no files, no connector and memory off", () => {

        expect(setUp([temporaryFolder()]).host.systemInstructions("claude")).toBe(APP_INSTRUCTIONS);
    });

    it("puts Eesha Code's own text and the connectors line in front of system.md", () => {

        const work = temporaryFolder();

        fs.mkdirSync(path.join(work, ".eesha"));
        fs.writeFileSync(path.join(work, ".eesha", "system.md"), "Be brief.");

        const { server } = setUp([work]);
        const connectors = new Connectors({ folders: () => [], onSignIn: () => undefined, readConfig: () => ADO_CONNECTED });
        const host = new ServerChatHost({ ...server, connectors }, { folders: [work], scratch: false });

        expect(host.systemInstructions("claude")).toBe(`${APP_INSTRUCTIONS}\n\n${connectorsNote(["ado"])}\n\nBe brief.`);
    });

    it("tells a Kiro runtime first that it runs in Eesha Code, and no other runtime", () => {

        const { host } = setUp([temporaryFolder()]);

        expect(host.systemInstructions("kiro-cli")).toBe(`${KIRO_PLACE}\n\n${APP_INSTRUCTIONS}`);
        expect(host.systemInstructions("Kiro-work")).toBe(`${KIRO_PLACE}\n\n${APP_INSTRUCTIONS}`);
        expect(host.systemInstructions("claude")).not.toContain(KIRO_PLACE);
        expect(host.systemInstructions("copilot")).not.toContain(KIRO_PLACE);
    });
});

describe("memory in a chat", () => {

    const ON: MemoryChoices = { access: "write", askOnSave: false, claudeMemoryOff: false };

    /** A chat in a workspace on `work`, with memory on. */
    async function inWorkspace(work: string, answer?: string, choices: MemoryChoices = ON) {

        const made = setUp([work], "chat-1", answer, false, choices, folderKey(work));

        await saveWorkspace(made.server.store, { name: "Login bug", folders: [work] });

        return made;
    }

    it("reaches global, its workspace and its folders - and only global from the scratch folder", async () => {

        const work = temporaryFolder();
        const { host, server } = await inWorkspace(work);

        expect(host.memoryPlace()).toEqual({ workspace: { key: folderKey(work), name: "Login bug" }, folders: [work] });

        // A session that recorded no workspace: the folder only - even
        // on that workspace's main folder.
        expect(new ServerChatHost(server, { folders: [work], scratch: false }).memoryPlace()).toEqual({ folders: [work] });
        expect(setUp([work]).host.memoryPlace()).toEqual({ folders: [work] });

        // In scratch: neither.
        expect(setUp([]).host.memoryPlace()).toEqual({ folders: [] });
        expect(setUp([work], "chat-1", undefined, true).host.memoryPlace()).toEqual({ folders: [] });
    });

    it("tells a new session about memory after its other instructions, and nothing when memory is off", async () => {

        const work = temporaryFolder();

        fs.mkdirSync(path.join(work, ".eesha"));
        fs.writeFileSync(path.join(work, ".eesha", "system.md"), "Be brief.");

        expect(setUp([work]).host.systemInstructions("kiro-cli")).toBe(`${KIRO_PLACE}\n\n${APP_INSTRUCTIONS}\n\nBe brief.`);

        const { host, server } = await inWorkspace(work);

        server.memory.store.add({ level: "workspace", owner: folderKey(work), place: "", title: "Cause", text: "The token expires.", author: "ai" });

        const told = host.systemInstructions("kiro-cli")!;

        expect(told.startsWith(`${KIRO_PLACE}\n\n${APP_INSTRUCTIONS}\n\nBe brief.\n\nEesha Code keeps a memory`)).toBe(true);
        expect(told).toContain("- 1 (workspace Login bug) Cause");
    });

    it("lists memory in the > list beside the connectors, and its rows below", async () => {

        const work = temporaryFolder();

        // Memory off: the connectors' own row, as before.
        expect(await setUp([work]).host.searchPaths([], "")).toEqual([expect.objectContaining({ name: "connect", disabled: true })]);

        const { host, server } = await inWorkspace(work);

        server.memory.store.add({ level: "global", owner: "", place: "", title: "Tabs", text: "Use tabs.", author: "person" });

        // No connector is connected: memory is the only row.
        expect(await host.searchPaths([], "")).toEqual([{ name: "memory", detail: "Saved memories" }]);
        expect(await host.searchPaths([], "ado")).toEqual([expect.objectContaining({ name: "connect", disabled: true })]);

        expect((await host.searchPaths(["memory"], "")).map(row => row.name)).toEqual(["global", "workspace", "folder"]);
        expect(await host.searchPaths(["Memory", "global"], "")).toEqual([{ name: "1", detail: "Tabs", leaf: true }]);
    });

    it("sends a picked memory with the message, and says so when a path points at none", async () => {

        const work = temporaryFolder();
        const { host, server } = await inWorkspace(work);

        server.memory.store.add({ level: "global", owner: "", place: "", title: "Tabs", text: "Use tabs.", author: "person" });

        expect(await host.pathReferences("format it like >memory>global>1 says")).toEqual({ lines: ["Memory 1 (global) - Tabs:\nUse tabs."] });

        expect(await host.pathReferences("see >memory>global>9")).toEqual({
            lines: [],
            note: "Sent as plain text - >memory>global>9: no global memory 9 for this session."
        });

        expect(await host.pathReferences("no path here")).toEqual({ lines: [] });
    });

    it("asks to turn Claude's own memory off before a Claude turn, and saves a yes", async () => {

        const settings = eeshaPath("settings.json");

        fs.rmSync(settings, { force: true });

        const work = temporaryFolder();
        const { host, asked } = await inWorkspace(work, "Turn off");

        // Another runtime: nothing is asked.
        expect(await host.beforeTurn("kiro-cli")).toBeUndefined();
        expect(asked).toEqual([]);

        expect(await host.beforeTurn("claude")).toBeUndefined();
        expect(asked).toEqual([{ kind: "confirm", text: expect.stringContaining("Turn Claude's own memory off"), action: "Turn off" }]);
        expect(JSON.parse(fs.readFileSync(settings, "utf8")).eesha.memory.claudeMemoryOff).toBe(true);

        fs.rmSync(settings, { force: true });
    });

    it("does not start the Claude turn on a no, and does not ask once it is off or memory is off", async () => {

        const settings = eeshaPath("settings.json");

        fs.rmSync(settings, { force: true });

        const work = temporaryFolder();
        const refused = await inWorkspace(work, undefined);

        expect(await refused.host.beforeTurn("claude")).toContain("Claude did not start");
        expect(fs.existsSync(settings)).toBe(false);

        const agreed = await inWorkspace(work, undefined, { ...ON, claudeMemoryOff: true });

        expect(await agreed.host.beforeTurn("claude")).toBeUndefined();
        expect(agreed.asked).toEqual([]);

        const off = setUp([work]);

        expect(await off.host.beforeTurn("claude")).toBeUndefined();
        expect(off.asked).toEqual([]);
    });
});

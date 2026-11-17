// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * The server over real HTTP on a free port, with the chat itself replaced
 * by a stand-in that records what reaches it - the chat's own behaviour
 * is tested in src/chat/__tests__/ChatController.test.ts.
 */

const { FakeChat, made } = vi.hoisted(() => {

    const made: InstanceType<typeof FakeChat>[] = [];

    class FakeChat {

        working = false;

        /** The open question - what the real chat's `waiting` answers. */
        waiting?: string;

        started = false;

        surface?: { post(message: unknown): void };

        received: unknown[] = [];

        closed = false;

        foldersChangedCalls = 0;

        constructor(public host: unknown, public chatId: string) {

            made.push(this);
        }

        attach(surface: { post(message: unknown): void }): void { this.surface = surface; }

        detach(surface?: unknown): void { if (!surface || surface === this.surface) this.surface = undefined; }

        receive(message: unknown): void { this.received.push(message); }

        /** What `title()` answers - a test sets it to play a runtime naming the chat. */
        named?: string;

        title(): string { return this.named ?? `Chat ${this.chatId}`; }

        async close(): Promise<void> { this.closed = true; }

        async foldersChanged(): Promise<boolean> { this.foldersChangedCalls++; return true; }

        savedAnswersChangedCalls = 0;

        async savedAnswersChanged(): Promise<void> { this.savedAnswersChangedCalls++; }

        settingsChangedCalls = 0;

        async settingsChanged(): Promise<void> { this.settingsChangedCalls++; }

        /** What `exportText()` answers - a test sets it. */
        exported?: { title: string; text: string };

        exportText(): { title: string; text: string } | undefined { return this.exported; }

        /** What `deleteChats` was asked: the chat ids and the question. */
        deleteCalls: { chatIds: readonly string[]; question: string }[] = [];

        async deleteChats(chatIds: readonly string[], question: string): Promise<void> { this.deleteCalls.push({ chatIds, question }); }
    }

    return { FakeChat, made };
});

vi.mock("../../chat/ChatController", () => ({ ChatController: FakeChat, TITLES_KEY: "chat.titles", PICK_PREFIX: "chat.pick:" }));

import { chatEventsPath } from "../../core/events/eventFile";
import { EeshaServer, deleteQuestion, emptiedFolder, PAGE_PATHS, rowDeleteQuestion } from "../EeshaServer";
import { FileStore } from "../fileStore";
import { eeshaPath } from "../paths";
import { type ChatRow, folderKey } from "../protocol";
import { saveWorkspace } from "../workspaces";
import { PAGE_PATHS as PAGE_ROUTES } from "../../web/pageRoute";
import { readSession, writeSession } from "../sessions";
import { KEY_HEADER } from "../security";

const KEY = "f".repeat(48);

let server: EeshaServer;
let port: number;
let onStop: ReturnType<typeof vi.fn<() => void>>;
let open: { close(): void }[] = [];

function temporaryFolder(): string {

    return fs.mkdtempSync(path.join(os.tmpdir(), "eesha-server-"));
}

/** Saves a chat's folders, as a new session does. */
function saveChat(chatId: string, folders: string[], scratch = false): void {

    writeSession(chatId, { folders, scratch });
}

/** A chat file with one message in it - what the chat list is read from. */
function writeChatFile(chatId: string, text: string, at: number): void {

    const file = chatEventsPath(undefined, chatId);

    fs.mkdirSync(path.dirname(file), { recursive: true });

    fs.writeFileSync(file, [
        { kind: "open", at, runId: `chat:${chatId}` },
        { kind: "prompt", at, ownerId: "chat", text }
    ].map(event => JSON.stringify(event)).join("\n") + "\n");
}

beforeEach(async () => {

    made.length = 0;

    const webRoot = temporaryFolder();

    fs.writeFileSync(path.join(webRoot, "index.html"), `<html data-theme="__THEME__"><body class="eesha-__THEME__"></body></html>`);
    fs.writeFileSync(path.join(webRoot, "page.js"), "console.log(1)");
    fs.writeFileSync(path.join(path.dirname(webRoot), "secret.txt"), "secret");

    onStop = vi.fn<() => void>();

    server = new EeshaServer({
        port: 0,
        theme: "dark",
        key: KEY,
        webRoot,
        workerPath: "unused",
        logPlace: "the log",
        store: new FileStore(path.join(temporaryFolder(), "state.json")),
        onStop,
        onRestart: vi.fn<() => void>(),
        idleMs: 50
    });

    await server.listen();

    port = server.port;
});

afterEach(async () => {

    for (const one of open)
        one.close();

    open = [];

    await server.close();
});

interface Answer {

    status: number;

    headers: http.IncomingHttpHeaders;

    text: string;
}

function call(method: string, route: string, headers: Record<string, string> = {}, body?: unknown): Promise<Answer> {

    return new Promise((resolve, reject) => {

        const request = http.request({ host: "127.0.0.1", port, method, path: route, headers: { host: `127.0.0.1:${port}`, ...headers } }, response => {

            const parts: Buffer[] = [];

            response.on("data", (part: Buffer) => parts.push(part));
            response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(parts).toString("utf8") }));
        });

        request.on("error", reject);

        if (body !== undefined)
            request.write(JSON.stringify(body));

        request.end();
    });
}

/** The headers the page's own requests carry. */
function page(): Record<string, string> {

    return { cookie: `eesha_key=${KEY}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" };
}

function post(route: string, body: unknown): Promise<Answer> {

    return call("POST", route, page(), body);
}

/** One tab's event stream: every message so far, and a wait for the next of a type. */
function events(view: string, chat?: string): Promise<{ messages: { type: string; [key: string]: unknown }[]; next(type: string): Promise<Record<string, unknown>>; close(): void }> {

    return new Promise((resolve, reject) => {

        const messages: { type: string }[] = [];
        const waiting: { type: string; resolve(message: unknown): void; from: number }[] = [];

        let buffered = "";

        const request = http.get({
            host: "127.0.0.1",
            port,
            path: `/events?view=${view}${chat ? `&chat=${chat}` : ""}`,
            headers: { host: `127.0.0.1:${port}`, cookie: `eesha_key=${KEY}` }
        }, response => {

            if (response.statusCode !== 200)
                return reject(new Error(`events answered ${response.statusCode}`));

            response.on("data", (part: Buffer) => {

                buffered += part.toString("utf8");

                let cut: number;

                while ((cut = buffered.indexOf("\n\n")) >= 0) {

                    const block = buffered.slice(0, cut);

                    buffered = buffered.slice(cut + 2);

                    if (!block.startsWith("data: "))
                        continue;

                    messages.push(JSON.parse(block.slice(6)));

                    for (const one of [...waiting]) {

                        const found = messages.slice(one.from).find(message => message.type === one.type);

                        if (found) {

                            waiting.splice(waiting.indexOf(one), 1);
                            one.resolve(found);
                        }
                    }
                }
            });

            const stream = {
                messages: messages as { type: string; [key: string]: unknown }[],
                next: (type: string) => new Promise<Record<string, unknown>>(done => {

                    const found = messages.find(message => message.type === type);

                    if (found)
                        return done(found as Record<string, unknown>);

                    waiting.push({ type, resolve: done as (message: unknown) => void, from: 0 });
                }),
                close: () => request.destroy()
            };

            open.push(stream);

            resolve(stream);
        });

        request.on("error", () => undefined);
    });
}

function wait(ms: number): Promise<void> {

    return new Promise(resolve => setTimeout(resolve, ms));
}

describe("who may talk to the server", () => {

    it("refuses a request addressed to another host name", async () => {

        expect((await call("GET", "/", { host: `evil.example:${port}`, cookie: `eesha_key=${KEY}` })).status).toBe(403);
    });

    it("refuses the page, the stream and requests without the key", async () => {

        expect((await call("GET", "/")).status).toBe(401);
        expect((await call("GET", "/events?view=abcdefgh")).status).toBe(401);
        expect((await call("POST", "/api/folders", { origin: `http://127.0.0.1:${port}`, "content-type": "application/json" }, {})).status).toBe(401);
    });

    it("swaps the printed link's key for a cookie and takes it out of the address", async () => {

        expect((await call("GET", "/?key=wrong")).status).toBe(403);

        const answer = await call("GET", `/?key=${KEY}&chat=abc`);

        expect(answer.status).toBe(302);
        expect(answer.headers.location).toBe("/?chat=abc");
        expect(String(answer.headers["set-cookie"])).toContain(`eesha_key=${KEY}`);
    });

    it("refuses a change that does not come from its own page", async () => {

        const { origin: _origin, ...noOrigin } = page();

        expect((await call("POST", "/api/folders", noOrigin, {})).status).toBe(403);
        expect((await call("POST", "/api/folders", { ...page(), origin: "https://evil.example" }, {})).status).toBe(403);
        expect((await call("POST", "/api/folders", { ...page(), "content-type": "text/plain" }, {})).status).toBe(415);
    });

    it("refuses a page load another site starts", async () => {

        expect((await call("GET", "/", { cookie: `eesha_key=${KEY}`, "sec-fetch-site": "cross-site" })).status).toBe(403);
    });

    it("answers the command only with the key in its header", async () => {

        expect((await call("GET", "/control/status")).status).toBe(401);

        const status = await call("GET", "/control/status", { "x-eesha-key": KEY });

        expect(status.status).toBe(200);
        expect(JSON.parse(status.text)).toMatchObject({ pid: process.pid, port, chats: 0 });

        expect((await call("POST", "/control/stop", { "x-eesha-key": KEY })).status).toBe(200);
        expect(onStop).toHaveBeenCalledTimes(1);
    });
});

describe("the page", () => {

    it("is served in the chosen theme, under a strict content policy", async () => {

        const answer = await call("GET", "/", { cookie: `eesha_key=${KEY}` });

        expect(answer.status).toBe(200);
        expect(answer.text).toBe(`<html data-theme="dark"><body class="eesha-dark"></body></html>`);
        expect(answer.headers["content-security-policy"]).toContain("script-src 'self'");
    });

    it("is served at the Settings addresses too, and nowhere else", async () => {

        for (const path of ["/settings", "/settings?chat=abc", "/settings/runtimes", "/settings/connectors", "/settings/storage?chat=abc"]) {

            const answer = await call("GET", path, { cookie: `eesha_key=${KEY}` });

            expect(answer.status).toBe(200);
            expect(answer.text).toBe(`<html data-theme="dark"><body class="eesha-dark"></body></html>`);
        }

        expect((await call("GET", "/settings")).status).toBe(401);
        expect((await call("GET", "/connectors/ado", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
        expect((await call("GET", "/other", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
        expect((await call("GET", "/settings/nope", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
    });

    it("sends the page for every address the page itself knows", () => {

        expect([...PAGE_PATHS].sort()).toEqual([...PAGE_ROUTES].sort());
    });

    it("serves its scripts, and nothing outside its own folder", async () => {

        const script = await call("GET", "/assets/page.js", { cookie: `eesha_key=${KEY}` });

        expect(script.status).toBe(200);
        expect(script.headers["content-type"]).toContain("text/javascript");

        expect((await call("GET", "/assets/..%5csecret.txt", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
        expect((await call("GET", "/assets/..%2fsecret.txt", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
    });
});

describe("sessions", () => {

    it("lists the top level with the folders used before", async () => {

        const answer = JSON.parse((await post("/api/folders", {})).text);

        expect(answer.path).toBe("");
        expect(Array.isArray(answer.recent)).toBe(true);
    });

    it("lists the working folders and their git repos at the top level, leaving out repos used before", async () => {

        const work = temporaryFolder();
        const [api, web] = ["api", "web"].map(name => path.join(work, name));

        for (const repo of [api, web])
            fs.mkdirSync(path.join(repo, ".git"), { recursive: true });

        const missing = path.join(work, "missing");

        fs.mkdirSync(eeshaPath(), { recursive: true });
        fs.writeFileSync(eeshaPath("settings.json"), JSON.stringify({ eesha: { workingFolders: [work, missing] } }));

        try {

            await post("/api/session", { folders: [web] });

            const top = JSON.parse((await post("/api/folders", {})).text);

            expect(top.working).toEqual([work]);
            expect(top.repos).toEqual([api]);
            expect(top.recent[0]).toBe(web);

            // A folder level below the top has none of these.
            const level = JSON.parse((await post("/api/folders", { path: work })).text);

            expect(level.working).toBeUndefined();
            expect(level.repos).toBeUndefined();

        } finally {

            fs.rmSync(eeshaPath("settings.json"), { force: true });
        }
    });

    it("starts a chat in the folders picked and saves them", async () => {

        const [one, two] = [temporaryFolder(), temporaryFolder()];

        const answer = await post("/api/session", { folders: [one, two] });

        const { chatId } = JSON.parse(answer.text);

        expect(answer.status).toBe(200);
        expect(readSession(chatId)).toEqual({ folders: [one, two], scratch: false });

        const top = JSON.parse((await post("/api/folders", {})).text);

        expect(top.recent.slice(0, 2)).toEqual([one, two]);
    });

    it("starts a chat with no folder - it works in its scratch folder", async () => {

        const answer = await post("/api/session", { folders: [] });

        const { chatId } = JSON.parse(answer.text);

        expect(answer.status).toBe(200);
        expect(readSession(chatId)).toEqual({ folders: [], scratch: false });
    });

    it("removes chats nobody wrote in and no tab shows when a new one is made", async () => {

        saveChat("empty-one", []);
        saveChat("written-in", []);
        saveChat("on-screen", []);

        writeChatFile("written-in", "hello", 1000);

        await (await events("view-0100", "on-screen")).next("eesha.hello");

        await post("/api/session", { folders: [] });

        expect(readSession("empty-one")).toBeUndefined();
        expect(readSession("written-in")).toBeDefined();
        expect(readSession("on-screen")).toBeDefined();
    });

    it("lists every chat with a message, newest first, with its folders and its name given by hand", async () => {

        const folder = temporaryFolder();

        saveChat("older", [folder]);
        saveChat("newer", []);
        saveChat("no-folders-file", []);

        writeChatFile("older", "first question", 1000);
        writeChatFile("newer", "second question", 2000);
        writeChatFile("never-saved", "no folder list", 3000);

        await server.store.update("chat.titles", { older: "Named by hand" });

        const listed = await post("/api/chats", {});

        expect(listed.status, listed.text).toBe(200);

        const { chats } = JSON.parse(listed.text);

        // Chats other tests in this file wrote are left out.
        expect(chats.filter((one: { chatId: string }) => ["newer", "older"].includes(one.chatId))).toEqual([
            { chatId: "newer", title: "second question", at: 2000, folders: [], working: false },
            { chatId: "older", title: "Named by hand", at: 1000, folders: [folder], working: false }
        ]);

        // A chat file with no saved folders cannot be opened here.
        expect(chats.some((one: { chatId: string }) => one.chatId === "never-saved")).toBe(false);
    });

    it("pins and archives a chat, keeps one mark per chat, and drops it with the chat", async () => {

        saveChat("marked", []);
        writeChatFile("marked", "a chat to mark", 4000);

        const one = await events("mark-view-1");

        const markOf = async () => {

            const { chats } = JSON.parse((await post("/api/chats", {})).text);

            return chats.find((chat: { chatId: string }) => chat.chatId === "marked")?.mark;
        };

        const changed = one.next("eesha.listChanged");

        expect((await post("/api/chats/mark", { chatId: "marked", mark: "pinned" })).status).toBe(200);
        await changed;
        expect(await markOf()).toBe("pinned");

        // Archiving a pinned chat unpins it.
        expect((await post("/api/chats/mark", { chatId: "marked", mark: "archived" })).status).toBe(200);
        expect(await markOf()).toBe("archived");
        expect(server.store.get("eesha.marks")).toEqual({ marked: "archived" });

        // Back among the other chats: nothing kept.
        expect((await post("/api/chats/mark", { chatId: "marked", mark: null })).status).toBe(200);
        expect(await markOf()).toBeUndefined();
        expect(server.store.get("eesha.marks")).toBeUndefined();

        // Refused: no such mark, a bad id, a chat that is not here.
        expect((await post("/api/chats/mark", { chatId: "marked", mark: "starred" })).status).toBe(400);
        expect((await post("/api/chats/mark", { chatId: "../x", mark: "pinned" })).status).toBe(400);
        expect((await post("/api/chats/mark", { chatId: "no-such-chat", mark: "pinned" })).status).toBe(404);

        // A deleted chat's mark goes with it.
        await post("/api/chats/mark", { chatId: "marked", mark: "pinned" });
        server.chatDeleted("marked");
        await wait(20);
        expect(server.store.get("eesha.marks")).toBeUndefined();

        one.close();
    });

    it("renames a workspace in the workspace itself, not as an alias", async () => {

        const folder = temporaryFolder();

        await saveWorkspace(server.store, { name: "old", folders: [folder] });

        expect((await post("/api/workspaces/name", { folder, name: "Billing" })).status).toBe(200);

        const listed = JSON.parse((await post("/api/chats", {})).text);

        expect(listed.workspaces).toEqual([{ name: "Billing", folders: [folder] }]);
        expect(listed.aliases).toEqual({});

        // Empty: the main folder's own name.
        expect((await post("/api/workspaces/name", { folder, name: "" })).status).toBe(200);
        expect(JSON.parse((await post("/api/chats", {})).text).workspaces).toEqual([{ name: path.basename(folder), folders: [folder] }]);
    });

    it("gives a folder an alias, sends it with the chat list, and takes it back when emptied", async () => {

        const folder = temporaryFolder();

        const one = await events("alias-view-1");

        const aliasesOf = async () => JSON.parse((await post("/api/chats", {})).text).aliases;

        const changed = one.next("eesha.listChanged");

        // Kept under the folder's key, without the spaces around it.
        expect((await post("/api/workspaces/name", { folder: folder + path.sep, name: "  Billing  " })).status).toBe(200);
        await changed;
        expect(await aliasesOf()).toEqual({ [folderKey(folder)]: "Billing" });

        // Refused: too long, two lines, not a full path, no alias at all.
        expect((await post("/api/workspaces/name", { folder, name: "x".repeat(61) })).status).toBe(400);
        expect((await post("/api/workspaces/name", { folder, name: "a\nb" })).status).toBe(400);
        expect((await post("/api/workspaces/name", { folder: "relative/api", name: "x" })).status).toBe(400);
        expect((await post("/api/workspaces/name", { folder })).status).toBe(400);
        expect(await aliasesOf()).toEqual({ [folderKey(folder)]: "Billing" });

        // Empty: the folder's own name again, and nothing kept.
        expect((await post("/api/workspaces/name", { folder, name: "" })).status).toBe(200);
        expect(await aliasesOf()).toEqual({});
        expect(server.store.get("eesha.aliases")).toBeUndefined();

        one.close();
    });

    it("hands a folder's chats to the tab's chat to delete, with a question that counts the pinned ones", async () => {

        for (const chatId of ["del-a", "del-b", "del-c"]) {

            saveChat(chatId, []);
            writeChatFile(chatId, "hello", 6000);
        }

        await post("/api/chats/mark", { chatId: "del-b", mark: "pinned" });
        await post("/api/chats/mark", { chatId: "del-c", mark: "archived" });

        saveChat("del-tab", []);
        await (await events("view-del-1", "del-tab")).next("eesha.hello");

        const chat = made.find(one => one.chatId === "del-tab")!;

        // A chat the list does not show is left out of the count.
        const answer = await post("/api/chats/delete", { view: "view-del-1", chatIds: ["del-a", "del-b", "del-c", "del-a", "no-such-chat"], where: "in 'api'" });

        expect(answer.status).toBe(200);
        expect(chat.deleteCalls).toEqual([{
            chatIds: ["del-a", "del-b", "del-c"],
            question: "Delete all 3 sessions in 'api'? Of these, 1 is pinned and 1 is archived. They cannot be brought back."
        }]);

        // Refused: no tab, no chats, a bad id, two lines of where, only chats not here.
        expect((await post("/api/chats/delete", { view: "no-such-view", chatIds: ["del-a"], where: "in 'api'" })).status).toBe(409);
        expect((await post("/api/chats/delete", { view: "view-del-1", chatIds: [], where: "in 'api'" })).status).toBe(400);
        expect((await post("/api/chats/delete", { view: "view-del-1", chatIds: ["../x"], where: "in 'api'" })).status).toBe(400);
        expect((await post("/api/chats/delete", { view: "view-del-1", chatIds: ["del-a"], where: "in\n'api'" })).status).toBe(400);
        expect((await post("/api/chats/delete", { view: "view-del-1", chatIds: ["no-such-chat"], where: "in 'api'" })).status).toBe(404);
        expect(chat.deleteCalls).toHaveLength(1);

        await post("/api/chats/mark", { chatId: "del-b", mark: null });
        await post("/api/chats/mark", { chatId: "del-c", mark: null });
    });

    it("words a row's own delete question by the session's name", () => {

        expect(rowDeleteQuestion({ title: "Fix the build" })).toBe("Delete 'Fix the build'? Its thread cannot be brought back.");
        expect(rowDeleteQuestion({ title: "Fix the build", mark: "pinned" })).toBe("Delete 'Fix the build'? It is pinned. Its thread cannot be brought back.");
    });

    it("finds the folder a delete leaves with no session in it", () => {

        const at = (chatId: string, folders: string[], mark?: ChatRow["mark"]): ChatRow =>
            ({ chatId, title: chatId, at: 1, folders, working: false, ...(mark ? { mark } : {}) });

        const api = path.join(os.tmpdir(), "api");
        const web = path.join(os.tmpdir(), "web");

        const all = [at("a1", [api]), at("a2", [api, web], "pinned"), at("w1", [web]), at("loose", [])];
        const notSaved = () => false;

        // Every session of 'api', pinned one too: 'api' is left empty.
        expect(emptiedFolder(all, [all[0]!, all[1]!], notSaved)).toBe(api);

        // One of two: another session still starts in 'api'.
        expect(emptiedFolder(all, [all[0]!], notSaved)).toBeUndefined();

        // 'web' as an extra folder does not count: only first folders do.
        expect(emptiedFolder(all, [all[2]!], notSaved)).toBe(web);

        // No folder, a folder added by hand, or two folders at once: nothing to offer.
        expect(emptiedFolder(all, [all[3]!], notSaved)).toBeUndefined();
        expect(emptiedFolder(all, [all[2]!], () => true)).toBeUndefined();
        expect(emptiedFolder(all, [all[0]!, all[1]!, all[2]!], notSaved)).toBeUndefined();
    });

    it("words the delete question for one chat and for many", () => {

        expect(deleteQuestion(1, 0, 0, "in 'api'")).toBe("Delete the one session in 'api'? It cannot be brought back.");
        expect(deleteQuestion(1, 1, 0, "in 'api'")).toBe("Delete the one session in 'api'? It is pinned. It cannot be brought back.");
        expect(deleteQuestion(4, 0, 0, "in 'web'")).toBe("Delete all 4 sessions in 'web'? They cannot be brought back.");
        expect(deleteQuestion(5, 2, 0, "in 'api'")).toBe("Delete all 5 sessions in 'api'? Of these, 2 are pinned. They cannot be brought back.");
    });

    it("searches what was said in the listed chats", async () => {

        saveChat("searched", []);
        writeChatFile("searched", "where is the zebra config", 5000);

        // A chat file with no saved folders is not listed, so not found.
        writeChatFile("unlisted", "zebra again", 5000);

        const answer = await post("/api/chats/search", { query: "ZEBRA" });

        expect(answer.status, answer.text).toBe(200);
        expect(JSON.parse(answer.text).hits).toEqual([{ chatId: "searched", line: "where is the zebra config" }]);

        expect((await post("/api/chats/search", { query: 7 })).status).toBe(400);
        expect((await post("/api/chats/search", { query: "x".repeat(201) })).status).toBe(400);
    });

    it("refuses a session with a folder that does not exist", async () => {

        const answer = await post("/api/session", { folders: [path.join(temporaryFolder(), "missing")] });

        expect(answer.status).toBe(400);
        expect(JSON.parse(answer.text).problem).toContain("No such folder");
    });
});

describe("tabs and chats", () => {

    it("draws a saved chat in the tab that names it and passes the page's messages to it", async () => {

        const folder = temporaryFolder();

        saveChat("chat-a", [folder]);

        const tab = await events("view-0001", "chat-a");

        const hello = await tab.next("eesha.hello");

        expect(hello.chat).toEqual({ chatId: "chat-a", folders: [folder], scratch: false, started: false, title: "Chat chat-a" });

        // The strip shows the version from the hello.
        expect(hello.version).toMatch(/^\d+\.\d+\.\d+/);

        const chat = made[0];

        expect(chat.chatId).toBe("chat-a");

        await post("/api/chat", { view: "view-0001", message: { type: "ready" } });

        expect(chat.received).toEqual([{ type: "ready" }]);

        // What the chat draws reaches the tab.
        chat.surface?.post({ type: "busy", running: true });

        expect(await tab.next("busy")).toEqual({ type: "busy", running: true });
    });

    it("exports this tab's chat as Markdown, and says so when nothing was said yet", async () => {

        saveChat("chat-export", []);

        await events("view-export1", "chat-export");

        const chat = made.find(one => one.chatId === "chat-export")!;

        const empty = await post("/api/chat/export", { view: "view-export1" });

        expect(empty.status).toBe(400);
        expect(JSON.parse(empty.text).problem).toContain("Nothing was said");

        chat.exported = { title: "Fix it", text: "# Handover: Fix it\n" };

        const answer = await post("/api/chat/export", { view: "view-export1" });

        expect(answer.status).toBe(200);
        expect(JSON.parse(answer.text)).toEqual({ title: "Fix it", text: "# Handover: Fix it\n" });

        expect((await post("/api/chat/export", { view: "no-such-view" })).status).toBe(409);
    });

    it("sends the chat's details again when a turn ends, so the header shows a name the runtime gave it", async () => {

        saveChat("chat-t", [temporaryFolder()]);

        const tab = await events("view-0014", "chat-t");

        await tab.next("eesha.hello");

        // The runtime named the chat during the turn.
        made[0].named = "What you are";
        made[0].started = true;

        made[0].surface?.post({ type: "busy", running: false });

        expect((await tab.next("eesha.chat")).chat).toMatchObject({ title: "What you are", started: true });
    });

    // The address of a deleted chat must say it is gone, not draw an empty
    // chat with its old folders.
    it("drops a deleted chat's folders and empty scratch folder, so its address says it is gone", async () => {

        const folder = temporaryFolder();

        saveChat("chat-on-screen", []);
        saveChat("chat-gone", [folder]);
        saveChat("chat-gone-2", []);
        writeChatFile("chat-gone", "hello", 1000);

        fs.mkdirSync(eeshaPath("scratch", "chat-gone"), { recursive: true });
        fs.mkdirSync(eeshaPath("scratch", "chat-gone-2"), { recursive: true });
        fs.writeFileSync(eeshaPath("scratch", "chat-gone-2", "notes.md"), "kept");

        await (await events("view-0030", "chat-on-screen")).next("eesha.hello");

        // The chat itself deletes the file, then tells its host.
        const host = made[0].host as { deleted(chatId: string): void };

        host.deleted("chat-gone");
        host.deleted("chat-gone-2");

        expect(readSession("chat-gone")).toBeUndefined();
        expect(fs.existsSync(eeshaPath("scratch", "chat-gone"))).toBe(false);

        // A scratch folder with something in it stays.
        expect(readSession("chat-gone-2")).toBeUndefined();
        expect(fs.existsSync(eeshaPath("scratch", "chat-gone-2", "notes.md"))).toBe(true);

        // The folder the chat worked in is never touched.
        expect(fs.existsSync(folder)).toBe(true);

        const back = await events("view-0031", "chat-gone");

        expect((await back.next("eesha.hello")).chat).toBeUndefined();
        expect(await back.next("eesha.unknownChat")).toEqual({ type: "eesha.unknownChat", chatId: "chat-gone" });
    });

    // The page shows a system notice for each.
    it("sends a turn's end or a question to the tab showing the chat, and to every tab when none does", async () => {

        // Each with a message, or opening one tab clears the others away.
        for (const chatId of ["chat-n1", "chat-n2", "chat-n3"]) {

            saveChat(chatId, []);
            writeChatFile(chatId, "hello", 1000);
        }

        const one = await events("view-0040", "chat-n1");
        const two = await events("view-0041", "chat-n2");
        const three = await events("view-0042", "chat-n3");

        await Promise.all([one.next("eesha.hello"), two.next("eesha.hello"), three.next("eesha.hello")]);

        type Notifying = { notify(chat: unknown, notice: unknown): void };

        const [first, second, third] = made;

        (first.host as Notifying).notify(first, { kind: "asked", text: "Which store?" });

        expect(await one.next("eesha.notify")).toEqual({
            type: "eesha.notify", chatId: "chat-n1", title: "Chat chat-n1", notice: { kind: "asked", text: "Which store?" }
        });

        // The other tab hears only about its own chat.
        (second.host as Notifying).notify(second, { kind: "ended", outcome: "done" });

        expect((await two.next("eesha.notify")).chatId).toBe("chat-n2");
        expect(two.messages.filter(message => message.type === "eesha.notify")).toHaveLength(1);

        // A chat whose tab closed: every tab hears.
        three.close();

        // The server lets go of the tab when its stream closes.
        await new Promise(resolve => setTimeout(resolve, 100));

        (third.host as Notifying).notify(third, { kind: "ended", outcome: "failed" });

        await vi.waitFor(() => {

            for (const tab of [one, two])
                expect(tab.messages.filter(message => message.type === "eesha.notify" && message.chatId === "chat-n3")).toEqual([
                    { type: "eesha.notify", chatId: "chat-n3", title: "Chat chat-n3", notice: { kind: "ended", outcome: "failed" } }
                ]);
        });
    });

    // A chat stopped on a question with no tab open has nobody to tell,
    // so its row must look different from a working one.
    it("marks a chat in the list while it waits for an answer, and one that ended with no tab until a tab opens it", async () => {

        for (const chatId of ["chat-w1", "chat-w2"]) {

            saveChat(chatId, []);
            writeChatFile(chatId, "hello", 1000);
        }

        const rows = async () => {

            const { chats } = JSON.parse((await post("/api/chats", {})).text) as { chats: { chatId: string }[] };

            return Object.fromEntries(chats.filter(one => one.chatId.startsWith("chat-w")).map(one => [one.chatId, one]));
        };

        const one = await events("view-0050", "chat-w1");
        const two = await events("view-0051", "chat-w2");

        await Promise.all([one.next("eesha.hello"), two.next("eesha.hello")]);

        type Notifying = { notify(chat: unknown, notice: unknown): void };

        const [first, second] = made;

        const changes = () => one.messages.filter(message => message.type === "eesha.listChanged").length;

        // The agent asks: every tab reads the list again, and the row says so.
        first.working = true;
        first.waiting = "Which store?";

        (first.host as Notifying).notify(first, { kind: "asked", text: "Which store?" });

        await vi.waitFor(() => expect(changes()).toBe(1));

        expect((await rows())["chat-w1"]).toMatchObject({ working: true, waiting: "Which store?" });

        // Answered: the mark goes.
        first.waiting = undefined;
        first.surface?.post({ type: "log", text: "the left one\n", stream: "stdout", meta: { kind: "answer", askId: "q1" } });

        await vi.waitFor(() => expect(changes()).toBe(2));

        expect((await rows())["chat-w1"]).toEqual(expect.not.objectContaining({ waiting: expect.anything() }));

        // An answer drawn again on a reload changes nothing: no list read.
        first.surface?.post({ type: "log", text: "the left one\n", stream: "stdout", meta: { kind: "answer", askId: "q1" } });

        await wait(50);

        expect(changes()).toBe(2);

        // A chat whose tab closed ends its turn: marked until a tab opens it.
        two.close();

        await wait(100);

        (second.host as Notifying).notify(second, { kind: "ended", outcome: "done" });

        await vi.waitFor(() => expect(changes()).toBe(3));

        expect((await rows())["chat-w2"]).toMatchObject({ working: false, unseen: "done" });

        await (await events("view-0052", "chat-w2")).next("eesha.hello");

        expect((await rows())["chat-w2"]).toEqual(expect.not.objectContaining({ unseen: expect.anything() }));
    });

    it("says so when the address names a chat with no folders saved", async () => {

        const tab = await events("view-0002", "nothing-here");

        expect((await tab.next("eesha.hello")).chat).toBeUndefined();
        expect(await tab.next("eesha.unknownChat")).toEqual({ type: "eesha.unknownChat", chatId: "nothing-here" });
        expect(made).toHaveLength(0);
    });

    it("refuses a chat message from a tab that shows no chat", async () => {

        await events("view-0003");

        expect((await post("/api/chat", { view: "view-0003", message: { type: "ready" } })).status).toBe(409);
    });

    it("moves a chat to the newest tab that opens it, and tells the old one", async () => {

        saveChat("chat-b", [temporaryFolder()]);

        const first = await events("view-0004", "chat-b");

        await first.next("eesha.hello");

        const second = await events("view-0005", "chat-b");

        await second.next("eesha.hello");

        expect(await first.next("eesha.moved")).toEqual({ type: "eesha.moved" });
        expect(made).toHaveLength(1);

        made[0].surface?.post({ type: "busy", running: false });

        await second.next("busy");

        expect(first.messages.some(message => message.type === "busy")).toBe(false);
    });

    it("keeps a chat whose tab closed for a while, then lets it go", async () => {

        saveChat("chat-c", [temporaryFolder()]);

        const tab = await events("view-0006", "chat-c");

        await tab.next("eesha.hello");

        tab.close();

        await wait(20);

        expect(made[0].closed).toBe(false);

        await wait(150);

        expect(made[0].closed).toBe(true);
    });

    it("asks the tab and hands back its answer", async () => {

        saveChat("chat-d", [temporaryFolder()]);

        const tab = await events("view-0007", "chat-d");

        await tab.next("eesha.hello");

        const asked = server.ask(made[0] as never, { kind: "confirm", text: "Delete it?", action: "Delete" });

        const prompt = await tab.next("eesha.prompt");

        expect(prompt.prompt).toEqual({ kind: "confirm", text: "Delete it?", action: "Delete" });

        await post("/api/reply", { view: "view-0007", id: prompt.id, value: "Delete" });

        expect(await asked).toBe("Delete");
    });

    it("backs out of a question when its tab closes", async () => {

        saveChat("chat-e", [temporaryFolder()]);

        const tab = await events("view-0008", "chat-e");

        await tab.next("eesha.hello");

        const asked = server.ask(made[0] as never, { kind: "text", title: "Rename", value: "", text: "Name?" });

        await tab.next("eesha.prompt");

        tab.close();

        expect(await asked).toBeUndefined();
    });
});

describe("changing a live chat's folders", () => {

    it("adds a folder, saves it and has the chat reopen its conversation", async () => {

        const [work, extra] = [temporaryFolder(), temporaryFolder()];

        saveChat("chat-f", [work]);

        const tab = await events("view-0009", "chat-f");

        await tab.next("eesha.hello");

        made[0].started = true;

        const answer = await post("/api/session/workspace", { view: "view-0009", folders: [work, extra] });

        expect(answer.status).toBe(200);
        expect(readSession("chat-f")).toEqual({ folders: [work, extra], scratch: false });
        expect(made[0].foldersChangedCalls).toBe(1);
        expect((await tab.next("eesha.chat")).chat).toMatchObject({ folders: [work, extra] });
    });

    it("keeps the first folder first once a runtime answered", async () => {

        const [work, other] = [temporaryFolder(), temporaryFolder()];

        saveChat("chat-g", [work]);

        await (await events("view-0010", "chat-g")).next("eesha.hello");

        made[0].started = true;

        const answer = await post("/api/session/workspace", { view: "view-0010", folders: [other, work] });

        expect(answer.status).toBe(400);
        expect(readSession("chat-g")).toEqual({ folders: [work], scratch: false });
        expect(made[0].foldersChangedCalls).toBe(0);
    });

    it("lets any folder be first, or none, before a runtime answered - with no conversation to reopen", async () => {

        const [work, other] = [temporaryFolder(), temporaryFolder()];

        saveChat("chat-g2", [work]);

        await (await events("view-0012", "chat-g2")).next("eesha.hello");

        expect((await post("/api/session/workspace", { view: "view-0012", folders: [other, work] })).status).toBe(200);
        expect(readSession("chat-g2")).toEqual({ folders: [other, work], scratch: false });

        expect((await post("/api/session/workspace", { view: "view-0012", folders: [] })).status).toBe(200);
        expect(readSession("chat-g2")).toEqual({ folders: [], scratch: false });

        expect(made[0].foldersChangedCalls).toBe(0);
    });

    it("keeps a chat that got its conversation with no folder in scratch, with added folders as extras", async () => {

        const work = temporaryFolder();

        saveChat("chat-s", []);

        const tab = await events("view-0013", "chat-s");

        expect((await tab.next("eesha.hello")).chat).toMatchObject({ folders: [], scratch: true });

        made[0].started = true;

        expect((await post("/api/session/workspace", { view: "view-0013", folders: [work] })).status).toBe(200);

        expect(readSession("chat-s")).toEqual({ folders: [work], scratch: true });
        expect(made[0].foldersChangedCalls).toBe(1);
        expect((await tab.next("eesha.chat")).chat).toMatchObject({ folders: [work], scratch: true, started: true });
    });

    it("refuses while a turn runs", async () => {

        const work = temporaryFolder();

        saveChat("chat-h", [work]);

        await (await events("view-0011", "chat-h")).next("eesha.hello");

        made[0].working = true;

        const answer = await post("/api/session/workspace", { view: "view-0011", folders: [work, temporaryFolder()] });

        expect(answer.status).toBe(409);
        expect(readSession("chat-h")).toEqual({ folders: [work], scratch: false });
    });
});

describe("the files pane", () => {

    /** A folder with a little of everything the pane meets. */
    function project(): string {

        const work = temporaryFolder();

        for (const folder of ["src", ".git", "node_modules"])
            fs.mkdirSync(path.join(work, folder));

        fs.writeFileSync(path.join(work, "b.txt"), "bee");
        fs.writeFileSync(path.join(work, "A.md"), "# A");
        fs.writeFileSync(path.join(work, "image.png"), Buffer.from([137, 80, 78, 71, 0, 1, 2]));
        fs.writeFileSync(path.join(work, "src", "x.ts"), "export {};");

        return work;
    }

    it("lists the chat's folders, then a folder's entries: folders first, A to Z, no .git or node_modules", async () => {

        const [work, extra] = [project(), temporaryFolder()];

        saveChat("chat-p", [work, extra]);

        await (await events("view-0020", "chat-p")).next("eesha.hello");

        const top = JSON.parse((await post("/api/files", { view: "view-0020" })).text);

        expect(top.entries).toEqual([
            { name: path.basename(work), path: work, folder: true },
            { name: path.basename(extra), path: extra, folder: true }
        ]);

        const inside = JSON.parse((await post("/api/files", { view: "view-0020", path: work })).text);

        expect(inside.entries).toEqual([
            { name: "src", path: path.join(work, "src"), folder: true },
            { name: "A.md", path: path.join(work, "A.md"), folder: false },
            { name: "b.txt", path: path.join(work, "b.txt"), folder: false },
            { name: "image.png", path: path.join(work, "image.png"), folder: false }
        ]);
    });

    it("shows the scratch folder for a chat that works there - empty before the agent made it", async () => {

        saveChat("chat-q", []);

        await (await events("view-0021", "chat-q")).next("eesha.hello");

        const top = JSON.parse((await post("/api/files", { view: "view-0021" })).text);

        expect(top.entries).toHaveLength(1);
        expect(top.entries[0]).toMatchObject({ name: "Scratch folder", folder: true });
        expect(fs.existsSync(top.entries[0].path)).toBe(false);

        const inside = await post("/api/files", { view: "view-0021", path: top.entries[0].path });

        expect(inside.status).toBe(200);
        expect(JSON.parse(inside.text)).toEqual({ entries: [] });
    });

    it("reads a file's text, and says why a folder or a binary file is not shown", async () => {

        const work = project();

        saveChat("chat-r", [work]);

        await (await events("view-0022", "chat-r")).next("eesha.hello");

        const read = async (file: string) => JSON.parse((await post("/api/file", { view: "view-0022", path: file })).text);

        expect(await read(path.join(work, "A.md"))).toEqual({ text: "# A" });
        expect((await read(path.join(work, "image.png"))).problem).toMatch(/^Not a text file\./);
        expect(await read(path.join(work, "src"))).toEqual({ problem: "Not a file." });
        expect((await read(path.join(work, "gone.txt"))).problem).toMatch(/ENOENT/);
    });

    it("refuses a path outside the chat's folders, a path that is not full, and a tab with no chat", async () => {

        const [work, outside] = [project(), project()];

        saveChat("chat-u", [work]);

        await (await events("view-0023", "chat-u")).next("eesha.hello");

        for (const route of ["/api/files", "/api/file"]) {

            for (const asked of [outside, path.join(outside, "A.md"), path.join(work, "..", path.basename(outside), "A.md")]) {

                const answer = await post(route, { view: "view-0023", path: asked });

                expect(answer.status).toBe(403);
                expect(JSON.parse(answer.text)).toEqual({ problem: "Only files inside this session's workspace are shown here." });
            }

            const relative = await post(route, { view: "view-0023", path: "A.md" });

            expect(relative.status).toBe(403);
            expect(JSON.parse(relative.text)).toEqual({ problem: "Not a full path." });

            expect((await post(route, { view: "view-0099", path: path.join(work, "A.md") })).status).toBe(409);
        }
    });
});

describe("the settings page", () => {

    it("writes a change, shows a new theme in every tab at once, and has every chat on screen read the settings again", async () => {

        fs.rmSync(eeshaPath("settings.json"), { force: true });

        for (const chatId of ["chat-s1", "chat-s2"]) {

            saveChat(chatId, []);
            writeChatFile(chatId, "hello", 1000);
        }

        const one = await events("view-0060", "chat-s1");
        const two = await events("view-0061", "chat-s2");

        await Promise.all([one.next("eesha.hello"), two.next("eesha.hello")]);

        const changed = await post("/api/settings/change", { theme: "light" });

        expect(changed.status, changed.text).toBe(200);
        expect(JSON.parse(changed.text)).toMatchObject({ theme: "light", runningPort: port });

        expect(await one.next("eesha.theme")).toEqual({ type: "eesha.theme", theme: "light" });
        expect(await two.next("eesha.theme")).toEqual({ type: "eesha.theme", theme: "light" });

        await vi.waitFor(() => expect(made.map(chat => chat.settingsChangedCalls)).toEqual([1, 1]));

        // A page loaded now is light from its first paint.
        expect((await call("GET", "/", { cookie: `eesha_key=${KEY}` })).text).toContain(`data-theme="light"`);

        // Refused: nothing written, nothing sent.
        const refused = await post("/api/settings/save", { text: "{ oops" });

        expect(refused.status).toBe(400);
        expect(JSON.parse(refused.text).problem).toContain("not valid JSON");

        fs.rmSync(eeshaPath("settings.json"), { force: true });
    });
});

describe("saved permission answers", () => {

    it("are kept in ~/.eesha/permissions.json, and a deleted chat's session answers go with it", () => {

        server.answers.add({ kind: "command", pattern: "npm *", scope: "session", chatId: "chat-gone", agent: "claude" });
        server.answers.add({ kind: "command", pattern: "git status", scope: "always", agent: "claude" });

        expect(fs.existsSync(eeshaPath("permissions.json"))).toBe(true);

        server.chatDeleted("chat-gone");

        expect(server.answers.list().map(answer => answer.pattern)).toEqual(["git status"]);
    });

    it("tell every chat on screen when one is saved or removed, so its count is sent again", async () => {

        saveChat("chat-count", [temporaryFolder()]);

        await (await events("view-0050", "chat-count")).next("eesha.hello");

        const chat = made.find(one => one.chatId === "chat-count")!;

        const saved = server.answers.add({ kind: "command", pattern: "npm run build *", scope: "always", agent: "claude" })!;

        expect(chat.savedAnswersChangedCalls).toBe(1);

        server.answers.remove(saved.id);

        expect(chat.savedAnswersChangedCalls).toBe(2);
    });
});

describe("the git panel", () => {

    /** A git repository with one commit, as a chat folder. */
    function repository(): string {

        const work = fs.realpathSync(temporaryFolder());
        const git = (...args: string[]) => execFileSync("git", args, { cwd: work, windowsHide: true });

        git("init", "-q", "-b", "main");
        git("config", "user.email", "test@example.com");
        git("config", "user.name", "Test");
        git("config", "core.autocrlf", "false");

        fs.writeFileSync(path.join(work, "a.txt"), "one\n");

        git("add", "-A");
        git("commit", "-q", "-m", "first");

        return work;
    }

    it("lists the repositories of the chat's folders, with their changes, and none for a folder outside git", async () => {

        const work = repository();
        const plain = temporaryFolder();

        fs.writeFileSync(path.join(work, "b.txt"), "new\n");

        saveChat("chat-g1", [work, plain]);

        await (await events("view-0030", "chat-g1")).next("eesha.hello");

        const answer = JSON.parse((await post("/api/git/status", { view: "view-0030" })).text);

        expect(answer.problems).toEqual([]);
        expect(answer.repos).toHaveLength(1);
        expect(answer.repos[0]).toMatchObject({ name: path.basename(work), branch: "main", head: "first", files: [{ path: "b.txt", index: "?", work: "?" }] });
    });

    it("runs an action in a repository of the chat, and refuses one outside its folders or while the agent works", async () => {

        const [work, other] = [repository(), repository()];

        fs.writeFileSync(path.join(work, "b.txt"), "new\n");

        saveChat("chat-g2", [work]);

        await (await events("view-0031", "chat-g2")).next("eesha.hello");

        const root = JSON.parse((await post("/api/git/status", { view: "view-0031" })).text).repos[0].root;

        const outside = await post("/api/git/action", { view: "view-0031", root: other, action: { kind: "stageAll" } });

        expect(outside.status).toBe(404);

        made[0].working = true;

        const busy = await post("/api/git/action", { view: "view-0031", root, action: { kind: "stageAll" } });

        expect(busy.status).toBe(409);
        expect(JSON.parse(busy.text).problem).toMatch(/agent is working/);

        made[0].working = false;

        expect(JSON.parse((await post("/api/git/action", { view: "view-0031", root, action: { kind: "stageAll" } })).text)).toEqual({ ok: true });
        expect(JSON.parse((await post("/api/git/status", { view: "view-0031" })).text).repos[0].files).toEqual([{ path: "b.txt", index: "A", work: "." }]);

        const refused = JSON.parse((await post("/api/git/action", { view: "view-0031", root, action: { kind: "switch", branch: "--orphan" } })).text);

        expect(refused.problem).toMatch(/not a branch name/);
        expect((await post("/api/git/action", { view: "view-0031", root, action: { kind: "push --force" } })).status).toBe(400);
    });

    it("tells the tab when a file in a watched repository changes, while the panel is open", async () => {

        const work = repository();

        saveChat("chat-g3", [work]);

        const stream = await events("view-0032", "chat-g3");

        await stream.next("eesha.hello");

        expect(JSON.parse((await post("/api/git/watch", { view: "view-0032", on: true })).text)).toEqual({ ok: true });

        fs.writeFileSync(path.join(work, "a.txt"), "two\n");

        const changed = await stream.next("eesha.gitChanged");

        expect(path.resolve(changed.root as string).toLowerCase()).toBe(path.resolve(work).toLowerCase());

        expect(JSON.parse((await post("/api/git/watch", { view: "view-0032", on: false })).text)).toEqual({ ok: true });
    });
});

describe("workspaces", () => {

    it("adds a workspace with its extra folders, lists it with no session in it, and takes it off again", async () => {

        const [folder, extra] = [temporaryFolder(), temporaryFolder()];

        const saved = await post("/api/workspaces/save", { name: "  Billing  ", folders: [folder, extra] });

        expect(saved.status, saved.text).toBe(200);

        const listed = JSON.parse((await post("/api/chats", {})).text);

        expect(listed.workspaces).toEqual([{ name: "Billing", folders: [folder, extra], created: expect.any(Number) }]);

        await post("/api/workspaces/remove", { key: folderKey(folder) });

        expect(JSON.parse((await post("/api/chats", {})).text).workspaces).toEqual([]);

        // The list stays, empty.
        expect(server.store.get("eesha.workspaces")).toEqual({});
    });

    it("names a workspace by its main folder when no name is given", async () => {

        const folder = temporaryFolder();

        expect((await post("/api/workspaces/save", { folders: [folder] })).status).toBe(200);
        expect(JSON.parse((await post("/api/chats", {})).text).workspaces).toEqual([{ name: path.basename(folder), folders: [folder], created: expect.any(Number) }]);
    });

    it("keeps the temp folder choice, and refuses an effort without a model and a work item no connector reaches", async () => {

        const folder = temporaryFolder();

        expect((await post("/api/workspaces/save", { folders: [folder], tempFolder: true })).status).toBe(200);
        expect(JSON.parse((await post("/api/chats", {})).text).workspaces[0].tempFolder).toBe(true);

        expect((await post("/api/workspaces/save", { folders: [folder], effort: "high" })).status).toBe(400);
        expect((await post("/api/workspaces/save", { folders: [folder], tempFolder: "yes" })).status).toBe(400);

        const unreached = await post("/api/workspaces/save", { folders: [folder], link: ["ado", "workitems", "12345"] });

        expect(unreached.status).toBe(400);
        expect(JSON.parse(unreached.text).problem).toContain("not connected");

        // A link that is not a > path.
        expect((await post("/api/workspaces/save", { folders: [folder], link: { connector: "ado", name: "org/project" } })).status).toBe(400);

        // The refused saves left the one before.
        expect(JSON.parse((await post("/api/chats", {})).text).workspaces[0]).toEqual({ name: path.basename(folder), folders: [folder], tempFolder: true, created: expect.any(Number) });
    });

    it("refuses a runtime that is not on offer, a model without a runtime, a folder that is not there, and no folder", async () => {

        const folder = temporaryFolder();

        expect((await post("/api/workspaces/save", { folders: [folder], runtime: "no-such-runtime" })).status).toBe(400);
        expect((await post("/api/workspaces/save", { folders: [folder], model: "opus" })).status).toBe(400);
        expect((await post("/api/workspaces/save", { folders: [path.join(folder, "missing")] })).status).toBe(400);
        expect((await post("/api/workspaces/save", { folders: [] })).status).toBe(400);
        expect((await post("/api/workspaces/save", { folders: [folder], name: "a\nb" })).status).toBe(400);
        expect(JSON.parse((await post("/api/chats", {})).text).workspaces).toEqual([]);
    });

    it("starts a session from a workspace's heading in its folders, on its runtime and model", async () => {

        const [folder, extra] = [temporaryFolder(), temporaryFolder()];

        await saveWorkspace(server.store, { name: "api", folders: [folder, extra], runtime: "claude", model: "opus" });

        const { chatId } = JSON.parse((await post("/api/session", { folder })).text);

        expect(readSession(chatId)).toEqual({ folders: [folder, extra], scratch: false, workspace: folderKey(folder) });
        expect(server.store.get(`chat.pick:${chatId}`)).toEqual({ provider: "claude", model: "opus" });
    });

    it("starts a session from a workspace on its effort, and lets it use the temp folder when the workspace does", async () => {

        const folder = temporaryFolder();

        await saveWorkspace(server.store, { name: "api", folders: [folder], runtime: "claude", model: "opus", effort: "high", tempFolder: true });

        const { chatId } = JSON.parse((await post("/api/session", { folder })).text);

        expect(readSession(chatId)).toEqual({ folders: [folder], scratch: false, tempFolder: true, workspace: folderKey(folder) });
        expect(server.store.get(`chat.pick:${chatId}`)).toEqual({ provider: "claude", model: "opus", effort: "high" });
    });

    it("starts a session in a folder with no defaults with no pick of its own", async () => {

        const folder = temporaryFolder();

        const { chatId } = JSON.parse((await post("/api/session", { folder })).text);

        expect(readSession(chatId)).toEqual({ folders: [folder], scratch: false });
        expect(server.store.get(`chat.pick:${chatId}`)).toBeUndefined();
    });

    it("says to fix the workspace when an extra folder is gone", async () => {

        const folder = temporaryFolder();
        const gone = path.join(temporaryFolder(), "gone");

        await saveWorkspace(server.store, { name: "api", folders: [folder, gone] });

        const answer = await post("/api/session", { folder });

        expect(answer.status).toBe(400);
        expect(JSON.parse(answer.text).problem).toContain("Edit workspace");
    });
});

describe("running a command block", () => {

    /** Every `eesha.run` the stream got for one run, once it ended. */
    async function finished(stream: { messages: { type: string; [key: string]: unknown }[] }, id: string): Promise<{ text: string; done: Record<string, unknown> }> {

        for (let tries = 0; tries < 300; tries++) {

            const parts = stream.messages.filter(message => message.type === "eesha.run" && message.id === id);
            const done = parts.find(part => part.done)?.done as Record<string, unknown> | undefined;

            if (done)
                return { text: parts.map(part => part.text ?? "").join(""), done };

            await wait(50);
        }

        throw new Error(`run ${id} did not end`);
    }

    it("lists the shells, the default first", async () => {

        const shells = JSON.parse((await post("/api/shells", {})).text).shells as { id: string; label: string; kind: string }[];

        expect(shells.length).toBeGreaterThan(0);
        expect(shells.every(shell => ["powershell", "cmd", "posix"].includes(shell.kind))).toBe(true);

        if (process.platform === "win32")
            expect(["pwsh", "powershell"]).toContain(shells[0]!.id);
    });

    it("runs a command in one of the session's folders and streams what it printed", async () => {

        const work = temporaryFolder();

        saveChat("chat-r1", [work]);

        const stream = await events("view-0040", "chat-r1");

        await stream.next("eesha.hello");

        const shell = process.platform === "win32" ? "cmd" : "sh";
        const code = process.platform === "win32" ? "echo one\r\ncd\r\nexit /b 3" : "echo one\npwd\nexit 3";

        const answer = JSON.parse((await post("/api/run", { view: "view-0040", code, shell, folder: work })).text);

        expect(answer.id).toMatch(/^run-/);

        const { text, done } = await finished(stream, answer.id);

        expect(text).toContain("one");
        expect(text.toLowerCase()).toContain(path.basename(work).toLowerCase());
        expect(done.code).toBe(3);
    });

    it("refuses a folder outside the session, a shell not on the machine, and an empty command", async () => {

        const [work, other] = [temporaryFolder(), temporaryFolder()];

        saveChat("chat-r2", [work]);

        await (await events("view-0041", "chat-r2")).next("eesha.hello");

        const shell = process.platform === "win32" ? "cmd" : "sh";

        const outside = await post("/api/run", { view: "view-0041", code: "echo hi", shell, folder: other });

        expect(outside.status).toBe(403);
        expect(JSON.parse(outside.text).problem).toMatch(/only in this session's workspace/);

        expect((await post("/api/run", { view: "view-0041", code: "echo hi", shell: "nope", folder: work })).status).toBe(400);
        expect((await post("/api/run", { view: "view-0041", code: "  ", shell, folder: work })).status).toBe(400);
        expect((await post("/api/run", { view: "view-nobody", code: "echo hi", shell, folder: work })).status).toBe(409);
    });

    it("stops a run on Stop, and only for the tab that started it", async () => {

        const work = temporaryFolder();

        saveChat("chat-r3", [work]);

        const stream = await events("view-0042", "chat-r3");

        await stream.next("eesha.hello");

        const shell = process.platform === "win32" ? "cmd" : "sh";
        const code = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30";

        const { id } = JSON.parse((await post("/api/run", { view: "view-0042", code, shell, folder: work })).text);

        // Another tab cannot stop it.
        await post("/api/run/stop", { view: "view-other", id });
        await wait(300);

        expect(stream.messages.some(message => message.type === "eesha.run" && message.id === id && message.done)).toBe(false);

        await post("/api/run/stop", { view: "view-0042", id });

        const { done } = await finished(stream, id);

        expect(done.stopped).toBe(true);
        expect(done.code).toBeNull();
    });
});

describe("the SDD module", () => {

    it("is served at its address, with a spec named in it", async () => {

        for (const route of ["/sdd", "/sdd?workspace=k", "/sdd?workspace=k&spec=s"])
            expect((await call("GET", route, { cookie: `eesha_key=${KEY}` })).status).toBe(200);
    });

    it("refuses every SDD request with no workspace saved", async () => {

        for (const route of ["/api/sdd/specs", "/api/sdd/offers", "/api/sdd/open", "/api/sdd/create"]) {

            const answer = await post(route, { workspace: "no-such-workspace", view: "v", spec: "s", name: "s" });

            expect(answer.status, route).not.toBe(200);
            expect(JSON.parse(answer.text).problem, route).toMatch(/workspace/i);
        }
    });

    it("makes a spec, opens it in a tab, passes the tab's messages to it, and never lists it as a chat", async () => {

        const folder = temporaryFolder();

        expect((await post("/api/workspaces/save", { folders: [folder] })).status).toBe(200);

        const workspace = JSON.parse((await post("/api/chats", {})).text).workspaces[0];
        const key = folderKey(workspace.folders[0]);

        expect(JSON.parse((await post("/api/sdd/specs", { workspace: key })).text)).toEqual({ specs: [], notes: [], sort: "alpha" });

        // Other tests in this file leave chats behind: what matters is that none is added.
        const chatsBefore = JSON.parse((await post("/api/chats", {})).text).chats;

        const offers = JSON.parse((await post("/api/sdd/offers", { workspace: key })).text);
        const type = offers.types[0];

        const created = await post("/api/sdd/create", { workspace: key, styleId: type.styleId, specTypeId: type.specTypeId, source: "manual", name: "first", text: "The ask." });

        expect(created.status, created.text).toBe(200);
        expect(JSON.parse(created.text)).toEqual({ name: "first" });

        const listed = JSON.parse((await post("/api/sdd/specs", { workspace: key })).text);

        expect(listed.specs.map((row: { name: string }) => row.name)).toEqual(["first"]);

        // A tab on the spec's address.
        const tab = await events("view-sdd1");

        await tab.next("eesha.hello");

        const opened = await post("/api/sdd/open", { view: "view-sdd1", workspace: key, spec: "first" });

        expect(opened.status, opened.text).toBe(200);
        expect(await tab.next("eesha.sdd")).toHaveProperty("message");

        expect((await post("/api/sdd", { view: "view-sdd1", message: { type: "ready" } })).status).toBe(200);

        // A tab that shows no spec reaches none.
        expect((await post("/api/sdd", { view: "view-other", message: { type: "ready" } })).status).toBe(409);

        // The spec is no chat: nothing in the chat list, and no chat made.
        expect(JSON.parse((await post("/api/chats", {})).text).chats).toEqual(chatsBefore);
        // No chat was made for it.
        expect(made).toEqual([]);
        expect(server.sdd.shownIn("view-sdd1")?.spec).toBe("first");
    });

    it("answers a failure with a server error, not success, and says what failed", async () => {

        const folder = temporaryFolder();

        await post("/api/workspaces/save", { folders: [folder] });

        vi.spyOn(server.sdd, "list").mockRejectedValueOnce(new Error("Could not read the specs folder."));

        const answer = await post("/api/sdd/specs", { workspace: folderKey(folder) });

        expect(answer.status).toBe(500);
        expect(JSON.parse(answer.text)).toEqual({ problem: "Could not read the specs folder." });
    });

    it("shows a file to the tab showing a spec only from inside its workspace", async () => {

        const [folder, outside] = [temporaryFolder(), temporaryFolder()];

        fs.writeFileSync(path.join(folder, "notes.md"), "inside", "utf8");
        fs.writeFileSync(path.join(outside, "secret.md"), "outside", "utf8");

        await post("/api/workspaces/save", { folders: [folder] });

        const key = folderKey(folder);
        const type = JSON.parse((await post("/api/sdd/offers", { workspace: key })).text).types[0];

        await post("/api/sdd/create", { workspace: key, styleId: type.styleId, specTypeId: type.specTypeId, source: "manual", name: "shown" });

        const tab = await events("view-sdd2");

        await tab.next("eesha.hello");
        await post("/api/sdd/open", { view: "view-sdd2", workspace: key, spec: "shown" });

        const inside = await post("/api/file", { view: "view-sdd2", path: path.join(folder, "notes.md") });

        expect(inside.status).toBe(200);
        expect(JSON.parse(inside.text)).toMatchObject({ text: "inside" });

        expect((await post("/api/file", { view: "view-sdd2", path: path.join(outside, "secret.md") })).status).toBe(403);
    });
});

describe("more than one workspace on a folder - one per work item", () => {

    const listed = async () => JSON.parse((await post("/api/chats", {})).text).workspaces as { id?: string; name: string; archived?: true }[];

    it("adds a second workspace on the same folder with a key of its own, and starts a session there or in the first one by key", async () => {

        const folder = temporaryFolder();

        expect((await post("/api/workspaces/save", { name: "12 Login", folders: [folder], runtime: "claude" })).status).toBe(200);
        expect((await post("/api/workspaces/save", { name: "13 Logout", folders: [folder] })).status).toBe(200);

        const both = await listed();
        const second = both.find(one => one.name === "13 Logout")!;

        expect(both.map(one => one.name).sort()).toEqual(["12 Login", "13 Logout"]);
        expect(second.id?.startsWith(`${folderKey(folder)}::`)).toBe(true);

        // From the folder: the newest workspace.
        const newest = JSON.parse((await post("/api/session", { folder })).text).chatId;

        expect(readSession(newest)?.workspace).toBe(second.id);

        // From the first one's heading: the first one, with its runtime.
        const older = JSON.parse((await post("/api/session", { folder, workspace: folderKey(folder) })).text).chatId;

        expect(readSession(older)?.workspace).toBe(folderKey(folder));
        expect(server.store.get(`chat.pick:${older}`)).toEqual({ provider: "claude" });

        // A key of a workspace on another folder is not used.
        const other = temporaryFolder();
        const wrong = JSON.parse((await post("/api/session", { folder: other, workspace: second.id })).text).chatId;

        expect(readSession(wrong)?.workspace).toBeUndefined();
    });

    it("changes a workspace by its key, keeps its main folder, and says when it is gone", async () => {

        const [folder, other] = [temporaryFolder(), temporaryFolder()];

        await post("/api/workspaces/save", { name: "12 Login", folders: [folder] });
        await post("/api/workspaces/save", { name: "13 Logout", folders: [folder] });

        const second = (await listed()).find(one => one.name === "13 Logout")!;

        expect((await post("/api/workspaces/save", { key: second.id, name: "13 Logout page", folders: [folder] })).status).toBe(200);
        expect((await listed()).map(one => one.name).sort()).toEqual(["12 Login", "13 Logout page"]);

        expect((await post("/api/workspaces/save", { key: second.id, folders: [other] })).status).toBe(400);
        expect((await post("/api/workspaces/save", { key: "c:\gone", folders: [folder] })).status).toBe(404);
    });

    it("archives a workspace, brings it back, and takes it off the list by its key", async () => {

        const folder = temporaryFolder();

        await post("/api/workspaces/save", { name: "12 Login", folders: [folder] });
        await post("/api/workspaces/save", { name: "13 Logout", folders: [folder] });

        const second = (await listed()).find(one => one.name === "13 Logout")!;

        expect((await post("/api/workspaces/archive", { key: second.id, archived: true })).status).toBe(200);
        expect((await listed()).find(one => one.id === second.id)?.archived).toBe(true);

        // A session started from the folder skips the archived one.
        const chatId = JSON.parse((await post("/api/session", { folder })).text).chatId;

        expect(readSession(chatId)?.workspace).toBe(folderKey(folder));

        expect((await post("/api/workspaces/archive", { key: second.id, archived: false })).status).toBe(200);
        expect((await listed()).find(one => one.id === second.id)?.archived).toBeUndefined();

        expect((await post("/api/workspaces/archive", { key: "c:\gone", archived: true })).status).toBe(404);
        expect((await post("/api/workspaces/archive", { key: second.id })).status).toBe(400);

        await post("/api/workspaces/remove", { key: second.id });

        expect((await listed()).map(one => one.name)).toEqual(["12 Login"]);
    });
});

describe("memory", () => {

    const settings = () => eeshaPath("settings.json");

    /** The header `eesha mcp` proves itself with. */
    const control = (route: string, body: unknown) => call("POST", route, { [KEY_HEADER]: KEY, "content-type": "application/json" }, body);

    beforeEach(() => {

        // Each test starts with no memory and the choices the file-less default gives.
        fs.rmSync(eeshaPath("memory.db"), { force: true });
        fs.rmSync(settings(), { force: true });
    });

    afterEach(() => fs.rmSync(settings(), { force: true }));

    it("has its own Settings address", async () => {

        expect((await call("GET", "/settings/memory", { cookie: `eesha_key=${KEY}` })).status).toBe(200);
        expect(PAGE_PATHS.has("/settings/memory")).toBe(true);
    });

    it("gives every session the memory tools with no connector connected, and none when memory is off", async () => {

        const listed = async () => (JSON.parse((await control("/control/connectors/tools", { chat: "any" })).text).tools as { name: string }[]).map(tool => tool.name);

        expect(await listed()).toEqual(["memory_list", "memory_search", "memory_read", "memory_save", "memory_delete"]);

        saveChat("mem-info", [temporaryFolder()]);

        const tab = await events("view-mem-info", "mem-info");

        open.push(tab);
        await tab.next("eesha.hello");

        expect(JSON.parse((await post("/api/session/info", { view: "view-mem-info" })).text).sentServers).toEqual(["eesha-connectors"]);

        expect((await post("/api/memory/choices", { choices: { access: "off" } })).status).toBe(200);

        expect(await listed()).toEqual([]);
        expect(JSON.parse((await post("/api/session/info", { view: "view-mem-info" })).text).sentServers).toEqual([]);
    });

    it("saves what a session's agent asks to save, tells its tab, and shows it on the Memory page", async () => {

        const folder = temporaryFolder();

        await saveWorkspace(server.store, { name: "Login bug", folders: [folder] });
        saveChat("mem-chat", [folder]);

        const tab = await events("view-mem-chat", "mem-chat");

        open.push(tab);
        await tab.next("eesha.hello");

        const saved = await control("/control/connectors/call", { chat: "mem-chat", name: "memory_save", arguments: { level: "workspace", title: "Cause", text: "The token expires." } });

        expect(saved.status).toBe(200);
        expect(JSON.parse(JSON.parse(saved.text).text)).toEqual({ saved: { id: 1, level: "workspace", where: "workspace Login bug", title: "Cause" } });

        expect(await tab.next("eesha.note")).toMatchObject({ text: "Memory saved (workspace Login bug): Cause" });

        const view = JSON.parse((await post("/api/memory", {})).text);

        expect(view.choices).toEqual({ access: "write", askOnSave: false, claudeMemoryOff: false });
        expect(view.groups.map((group: { level: string; label: string; memories: { title: string; author: string }[] }) => [group.level, group.label, group.memories.map(row => `${row.title} by ${row.author}`)])).toEqual([
            ["global", "Global", []],
            ["workspace", "Login bug", ["Cause by ai"]]
        ]);
        expect(view.workspaces).toEqual([{ key: folderKey(folder), name: "Login bug" }]);
        expect(view.folders).toContain(folder);
    });

    it("refuses a memory call from a session it does not hold", async () => {

        const answer = JSON.parse((await control("/control/connectors/call", { chat: "nobody", name: "memory_list", arguments: {} })).text);

        expect(answer.isError).toBe(true);
        expect(answer.text).toContain("not open in Eesha Code");

        // And without the key, nothing at all.
        expect((await call("POST", "/control/connectors/call", { "content-type": "application/json" }, { chat: "nobody", name: "memory_list" })).status).toBe(401);
    });

    it("adds, changes, moves and deletes memories from the Memory page", async () => {

        const before = path.join(temporaryFolder(), "old-name");
        const after = temporaryFolder();

        const groups = (answer: Answer) => (JSON.parse(answer.text).groups as { level: string; label: string; memories: { id: number; title: string; text: string }[] }[]);

        expect(groups(await post("/api/memory/save", { memory: { level: "global", title: "Tabs", text: "Use tabs." } }))[0]!.memories).toMatchObject([{ id: 1, title: "Tabs" }]);
        expect((await post("/api/memory/save", { memory: { level: "global", title: "", text: "x" } })).status).toBe(400);

        expect(groups(await post("/api/memory/save", { memory: { id: 1, level: "folder", owner: before, title: "Tabs", text: "Use spaces." } })).map(group => [group.level, group.label, group.memories.map(row => row.text)])).toEqual([
            ["global", "Global", []],
            ["folder", before, ["Use spaces."]]
        ]);

        // The folder was renamed: its memories follow it.
        expect((await post("/api/memory/repoint", { from: folderKey(before), to: path.join(after, "nope") })).status).toBe(400);
        expect(groups(await post("/api/memory/repoint", { from: folderKey(before), to: after }))[1]!.label).toBe(after);

        expect((await post("/api/memory/remove", { id: 9 })).status).toBe(400);
        expect(groups(await post("/api/memory/remove", { id: 1 }))).toEqual([{ level: "global", owner: "", label: "Global", memories: [] }]);
    });

    it("saves the memory choices, and refuses one of the wrong kind", async () => {

        const changed = JSON.parse((await post("/api/memory/choices", { choices: { access: "read", askOnSave: true, claudeMemoryOff: true } })).text);

        expect(changed.choices).toEqual({ access: "read", askOnSave: true, claudeMemoryOff: true });
        expect(JSON.parse(fs.readFileSync(settings(), "utf8")).eesha.memory).toEqual({ access: "read", askOnSave: true, claudeMemoryOff: true });

        expect((await post("/api/memory/choices", { choices: { access: "all" } })).status).toBe(400);
        expect((await post("/api/memory/choices", {})).status).toBe(400);

        // Read only now: the agent's save is refused even when it is called.
        const refused = JSON.parse((await control("/control/connectors/call", { chat: "any", name: "memory_save", arguments: { level: "global", title: "t", text: "x" } })).text);

        expect(refused.isError).toBe(true);
    });
});

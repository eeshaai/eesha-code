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

// A runtime's version is asked by starting its program: never in a test.
vi.mock("../runtimeVersion", () => ({ runtimeVersion: async (id: string) => `${id} 9.9.9` }));

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
function saveChat(chatId: string, folders: string[], scratch = false, workspace?: string): void {

    writeSession(chatId, { folders, scratch, ...(workspace ? { workspace } : {}) });
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
        // working and specsWorking: what `eesha restart` refuses on.
        expect(JSON.parse(status.text)).toMatchObject({ pid: process.pid, port, chats: 0, working: 0, specsWorking: 0 });

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

    it("is served at the Settings addresses too, and not at a file or a Settings section that is not one", async () => {

        for (const path of ["/settings", "/settings?chat=abc", "/settings/runtimes", "/settings/connectors", "/settings/storage?chat=abc"]) {

            const answer = await call("GET", path, { cookie: `eesha_key=${KEY}` });

            expect(answer.status).toBe(200);
            expect(answer.text).toBe(`<html data-theme="dark"><body class="eesha-dark"></body></html>`);
        }

        expect((await call("GET", "/settings")).status).toBe(401);
        expect((await call("GET", "/favicon.ico", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
        expect((await call("GET", "/settings/nope", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
        expect((await call("GET", "/eval/a/b", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
    });

    /*
     * The names of workspaces and sessions in the address
     * (shared/pageAddress.ts): the server finds what they show and tells
     * the page, and moves older and renamed addresses on.
     */
    describe("workspace and session addresses", () => {

        const signedIn = { cookie: `eesha_key=${KEY}` };
        const routeOf = (text: string) => {

            const found = /<meta name="eesha-route" content="([^"]*)">/.exec(text)?.[1];

            return found ? JSON.parse(found.replaceAll("&quot;", "\"").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")) : undefined;
        };

        async function made() {

            const folder = temporaryFolder();
            const key = folderKey(folder);

            await saveWorkspace(server.store, { name: "Login bug", folders: [folder] });

            saveChat("2026-11-26T10-00-00-k3x9q2", [folder], false, key);
            writeChatFile("2026-11-26T10-00-00-k3x9q2", "Fix the login", 1000);
            saveChat("2026-11-26T11-00-00-zz99yy", [folder]);
            writeChatFile("2026-11-26T11-00-00-zz99yy", "Loose one", 2000);

            return { key };
        }

        it("serves a workspace's page by its name, and tells the page which workspace it is", async () => {

            const { key } = await made();
            const answer = await call("GET", "/login-bug?spec=login", signedIn);

            expect(answer.status).toBe(200);
            expect(routeOf(answer.text)).toEqual({ workspace: key, spec: { spec: "login" } });
        });

        it("serves a session by its name, with a spec beside it, and one in no workspace", async () => {

            await made();

            const chat = await call("GET", "/login-bug/fix-the-login-k3x9q2", signedIn);

            expect(chat.status).toBe(200);
            expect(routeOf(chat.text)).toEqual({ chat: "2026-11-26T10-00-00-k3x9q2" });
            expect(routeOf((await call("GET", "/login-bug/login/fix-the-login-k3x9q2", signedIn)).text)).toEqual({ chat: "2026-11-26T10-00-00-k3x9q2", spec: { spec: "login" } });
            expect(routeOf((await call("GET", "/no-workspace/loose-one-zz99yy", signedIn)).text)).toEqual({ chat: "2026-11-26T11-00-00-zz99yy" });
        });

        it("moves an older address and a renamed one to the address it has now", async () => {

            const { key } = await made();

            const moved = async (address: string) => (await call("GET", address, signedIn)).headers.location;

            expect(await moved("/?chat=2026-11-26T10-00-00-k3x9q2")).toBe("/login-bug/fix-the-login-k3x9q2");
            expect(await moved("/?chat=2026-11-26T10-00-00-k3x9q2&spec=login")).toBe("/login-bug/login/fix-the-login-k3x9q2");
            expect(await moved(`/workspace?workspace=${encodeURIComponent(key)}&spec=login`)).toBe("/login-bug?spec=login");
            expect(await moved("/old-name/old-title-k3x9q2")).toBe("/login-bug/fix-the-login-k3x9q2");
            expect(await moved("/login-bug/loose-one-zz99yy")).toBe("/no-workspace/loose-one-zz99yy");
            expect(await moved("/no-workspace")).toBe("/");
        });

        it("keeps a column's frame and an address with nothing there, and tells the page nothing is there", async () => {

            await made();

            const column = await call("GET", "/?chat=2026-11-26T10-00-00-k3x9q2&column=1", signedIn);

            expect(column.status).toBe(200);
            expect(routeOf(column.text)).toBeUndefined();
            expect((await call("GET", "/?chat=not-here", signedIn)).status).toBe(200);
            expect(routeOf((await call("GET", "/nowhere", signedIn)).text)).toEqual({ workspace: "" });
            expect(routeOf((await call("GET", "/login-bug/gone-000000", signedIn)).text)).toEqual({ chat: "missing" });
        });
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
        saveChat("mem-chat", [folder], false, folderKey(folder));

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

describe("the Evaluator", () => {

    const settings = () => eeshaPath("settings.json");

    const json = (answer: Answer) => JSON.parse(answer.text);

    /**
     * Turns the `evals` flag on the way the settings page does, with one
     * runtime on offer whatever this machine has, and waits until the
     * server has read it.
     */
    async function turnOn(): Promise<void> {

        const changed = await post("/api/settings/change", { providers: ["claude"], defaultRuntime: "claude", flag: { name: "evals", on: true } });

        expect(changed.status, changed.text).toBe(200);

        await vi.waitFor(async () => expect((await post("/api/eval/list", {})).status).toBe(200));
    }

    /** A folder with one file. */
    function workFolder(): string {

        const folder = temporaryFolder();

        fs.writeFileSync(path.join(folder, "a.txt"), "text\n");

        return folder;
    }

    /** Makes an evaluation as the create page does: the common message is typed there, and sent at once. */
    const create = (body: Record<string, unknown>) => post("/api/eval/create", { text: "hello", ...body });

    /** All a variant's chats got: the one its message went to, and any opened for it later. */
    const sentTo = (chatId: string) => made.filter(chat => chat.chatId === chatId).flatMap(chat => chat.received);

    /** A variant's chat as it is now: the last one opened for it. */
    const live = (chatId: string) => made.filter(chat => chat.chatId === chatId).at(-1)!;

    afterEach(() => {

        fs.rmSync(settings(), { force: true });
        fs.rmSync(eeshaPath("evals"), { recursive: true, force: true, maxRetries: 3 });
    });

    it("refuses every request while its flag is off", async () => {

        for (const route of ["/api/eval/list", "/api/eval/get", "/api/eval/create", "/api/eval/send", "/api/eval/tasks", "/api/eval/variant/add", "/api/eval/stop", "/api/eval/report", "/api/eval/pick", "/api/eval/variant/retry", "/api/eval/delete"]) {

            const answer = await post(route, { name: "one" });

            expect(answer.status, route).toBe(403);
            expect(json(answer).problem).toContain("turned off");
        }
    });

    it("sends the page for the list and for one evaluation", async () => {

        expect((await call("GET", "/eval", { cookie: `eesha_key=${KEY}` })).status).toBe(200);
        expect((await call("GET", "/eval/login-refactor", { cookie: `eesha_key=${KEY}` })).status).toBe(200);
        expect((await call("GET", "/eval/a/b", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
        expect((await call("GET", "/eval/a.b", { cookie: `eesha_key=${KEY}` })).status).toBe(404);
    });

    it("lets the page show itself in a frame, and nobody else", async () => {

        const policy = String((await call("GET", "/", { cookie: `eesha_key=${KEY}` })).headers["content-security-policy"]);

        expect(policy).toContain("frame-src 'self'");
        expect(policy).toContain("frame-ancestors 'self'");
    });

    it("makes an evaluation: one copy and one session per variant, named after it when no name is given", async () => {

        await turnOn();

        const folder = workFolder();
        const answer = await create({ name: "one", folder, variants: [{ runtime: "claude" }, { name: "short-prompt", runtime: "claude", model: "opus" }] });

        expect(answer.status).toBe(200);
        expect(json(answer).sendProblem).toBeUndefined();

        const shown = json(answer).eval;

        expect(shown).toMatchObject({ name: "one", folder });
        expect(shown.variants.map((one: { name: string }) => one.name)).toEqual(["one-1", "short-prompt"]);
        expect(shown.variants[1]).toMatchObject({ runtime: "claude", model: "opus", working: false });

        for (const name of ["one-1", "short-prompt"])
            expect(fs.readFileSync(path.join(eeshaPath("evals", "one", "copies", name), "a.txt"), "utf8")).toBe("text\n");

        // Each variant's runtime and model, kept with the evaluation - not in the server's own saved values.
        const state = JSON.parse(fs.readFileSync(eeshaPath("evals", "one", "state.json"), "utf8"));

        expect(state[`chat.pick:${shown.variants[1].chatId}`]).toEqual({ provider: "claude", model: "opus" });

        // Every variant got the message at once, and the message is kept with the evaluation.
        expect(shown.variants.map((one: { chatId: string }) => sentTo(one.chatId))).toEqual([[{ type: "send", text: "hello" }], [{ type: "send", text: "hello" }]]);
        expect(shown.sent).toMatchObject({ text: "hello" });
        expect(shown.variants.map((one: { version?: string }) => one.version)).toEqual(["claude 9.9.9", "claude 9.9.9"]);

        expect(json(await post("/api/eval/get", { name: "one" })).eval.variants).toHaveLength(2);
        expect(json(await post("/api/eval/list", {})).evals).toEqual([{ name: "one", folder, createdAt: shown.createdAt, variants: 2 }]);
        expect(json(await post("/api/eval/get", { name: "other" }))).toEqual({});
    });

    it("starts every copy of a folder in git from the folder as it is, uncommitted changes too", async () => {

        await turnOn();

        const folder = temporaryFolder();
        const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });

        git("init", "--quiet");
        git("config", "core.autocrlf", "false");
        fs.writeFileSync(path.join(folder, "a.txt"), "committed\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "first");
        fs.writeFileSync(path.join(folder, "b.txt"), "committed later\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "second");
        fs.writeFileSync(path.join(folder, "a.txt"), "not committed\n");

        const shown = json(await create({ name: "ingit", folder, variants: [{ runtime: "claude" }, { runtime: "claude" }] })).eval;
        const copy = eeshaPath("evals", "ingit", "copies", "ingit-1");

        expect(shown.commit).toMatch(/^[0-9a-f]{7}$/);
        expect(fs.readFileSync(path.join(copy, "a.txt"), "utf8")).toBe("not committed\n");
        expect(fs.readFileSync(path.join(copy, "b.txt"), "utf8")).toBe("committed later\n");
        expect(fs.readFileSync(path.join(eeshaPath("evals", "ingit", "copies", "ingit-2"), "a.txt"), "utf8")).toBe("not committed\n");

        // The starting commit alone: the two older commits were not fetched.
        expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: copy, encoding: "utf8" }).trim()).toBe("1");
    });

    it("refuses an evaluation it cannot make, and says why", async () => {

        await turnOn();

        const folder = workFolder();
        const refused = async (body: Record<string, unknown>) => json(await create(body)).problem as string;

        expect(await refused({ name: "a b", folder, variants: [{ runtime: "claude" }] })).toContain("letters, digits");
        expect(await refused({ name: "one", variants: [{ runtime: "claude" }] })).toContain("Pick the folder");
        expect(await refused({ name: "one", folder: path.join(folder, "missing"), variants: [{ runtime: "claude" }] })).toContain("No such folder");
        expect(await refused({ name: "one", folder, variants: [] })).toContain("1 to 6 variants");
        expect(await refused({ name: "one", folder, variants: [{}, {}, {}, {}, {}, {}, {}] })).toContain("1 to 6 variants");
        expect(await refused({ name: "one", folder, variants: [{ runtime: "no-such-runtime" }] })).toContain("Variant 1");
        expect(await refused({ name: "one", folder, variants: [{}] })).toContain("pick a runtime");
        expect(await refused({ name: "one", folder, variants: [{ name: "x y", runtime: "claude" }] })).toContain("is not a name");
        expect(await refused({ name: "one", folder, variants: [{ name: "same", runtime: "claude" }, { name: "Same", runtime: "claude" }] })).toContain("Two variants");

        // Nothing to send: no common message, and no text of its own.
        expect(await refused({ name: "one", folder, text: "  ", variants: [{ runtime: "claude" }] })).toContain("Type a common message, or a text of its own for every variant");
        expect(await refused({ name: "one", folder, text: "", variants: [{ name: "a", runtime: "claude", extra: "Use a map." }, { name: "b", runtime: "claude" }] })).toContain("Nothing to send to b");
        expect(await refused({ name: "one", folder, text: 5, variants: [{ runtime: "claude" }] })).toContain("The common message is text");
        expect(await refused({ name: "one", folder, task: "no-such-task", variants: [{ runtime: "claude" }] })).toContain("no saved task named");

        // Nothing was left behind by the refusals.
        expect(fs.existsSync(eeshaPath("evals", "one"))).toBe(false);

        expect((await create({ name: "one", folder, variants: [{ runtime: "claude" }] })).status).toBe(200);
        expect(await refused({ name: "one", folder, variants: [{ runtime: "claude" }] })).toContain("already an evaluation");
    });

    it("sends every variant its message when the evaluation is made, and refuses Send to all while one works", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }, { runtime: "claude" }] })).eval;
        const ids = shown.variants.map((one: { chatId: string }) => one.chatId) as string[];

        expect(ids.map(sentTo)).toEqual([[{ type: "send", text: "hello" }], [{ type: "send", text: "hello" }]]);
        expect((await post("/api/eval/send", { name: "none" })).status).toBe(404);

        // Neither has a chat file yet nor works here, and each got its message all the same: its send was
        // written down before it went. A second press right after is refused.
        expect(shown.variants.map((one: { started: boolean }) => one.started)).toEqual([true, true]);
        expect((await post("/api/eval/send", { name: "one" })).status).toBe(409);
        expect(ids.map(id => sentTo(id).length)).toEqual([1, 1]);

        // The second one still works, its column open: nothing more goes to either.
        const tab = await events("view-eval-working", ids[1]);

        open.push(tab);
        await tab.next("eesha.hello");

        live(ids[1]!).working = true;

        const refused = await post("/api/eval/send", { name: "one" });

        expect(refused.status).toBe(409);
        expect(json(refused).problem).toContain("one message");
        expect(ids.map(id => sentTo(id).length)).toEqual([1, 1]);
        expect(json(await post("/api/eval/get", { name: "one" })).eval.variants.map((one: { working: boolean }) => one.working)).toEqual([false, true]);

        live(ids[1]!).working = false;
    });

    it("keeps a variant's session out of the session list and the sessions folder", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }] })).eval;
        const chatId = shown.variants[0].chatId as string;

        // Its chat in a column's frame: a tab of its own.
        const tab = await events("view-eval-column", chatId);

        open.push(tab);

        expect(((await tab.next("eesha.hello")).chat as { chatId: string }).chatId).toBe(chatId);

        expect(readSession(chatId)).toBeUndefined();
        expect((json(await post("/api/chats", {})).chats as ChatRow[]).map(row => row.chatId)).not.toContain(chatId);
    });

    it("carries a column's chat on its page's stream, so a page opens one connection however many columns it has", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }] })).eval;
        const chatId = shown.variants[0].chatId as string;

        const pageTab = await events("view-eval-page");

        open.push(pageTab);
        await pageTab.next("eesha.hello");

        // No such page, and a page's own id: refused.
        expect((await post("/api/join", { stream: "view-nobody-here", view: "view-eval-col1", chat: chatId })).status).toBe(409);
        expect((await post("/api/join", { stream: "view-eval-page", view: "view-eval-page", chat: chatId })).status).toBe(400);

        expect((await post("/api/join", { stream: "view-eval-page", view: "view-eval-col1", chat: chatId })).status).toBe(200);

        // The column's hello comes on the page's stream, marked with the column's id.
        expect(await pageTab.next("eesha.forView")).toMatchObject({ view: "view-eval-col1", message: { type: "eesha.hello", chat: { chatId } } });

        // The column sends as any tab does.
        expect((await post("/api/chat", { view: "view-eval-col1", message: { type: "ready" } })).status).toBe(200);

        // Its frame went: its tab ends, and the page's stream stays open - another column can join it.
        await post("/api/leave", { view: "view-eval-col1" });

        expect((await post("/api/chat", { view: "view-eval-col1", message: { type: "ready" } })).status).toBe(409);
        expect((await post("/api/join", { stream: "view-eval-page", view: "view-eval-col2", chat: chatId })).status).toBe(200);

        // The page's stream ends: its columns end with it.
        pageTab.close();
        await wait(100);

        expect((await post("/api/chat", { view: "view-eval-col2", message: { type: "ready" } })).status).toBe(409);
    });

    it("does not open a variant's session once the flag is off again", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }] })).eval;

        // The chat its message went to is let go once idle, with no column open.
        await vi.waitFor(() => expect(live(shown.variants[0].chatId).closed).toBe(true));

        expect((await post("/api/settings/change", { flag: { name: "evals", on: false } })).status).toBe(200);

        await vi.waitFor(async () => expect((await post("/api/eval/list", {})).status).toBe(403));

        const tab = await events("view-eval-off", shown.variants[0].chatId);

        open.push(tab);

        expect((await tab.next("eesha.unknownChat")).chatId).toBe(shown.variants[0].chatId);
    });

    it("lets a variant's agent read our memory and refuses every change - and gives a Claude variant none of ours while Claude's own is on", async () => {

        const control = (body: unknown) => call("POST", "/control/connectors/call", { [KEY_HEADER]: KEY, "content-type": "application/json" }, body);

        await turnOn();

        fs.rmSync(eeshaPath("memory.db"), { force: true });

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }] })).eval;
        const chatId = shown.variants[0].chatId as string;

        // Opened, as a column's frame opens it.
        const tab = await events("view-eval-memory", chatId);

        open.push(tab);
        await tab.next("eesha.hello");

        // Claude's own memory is still on: the variant runs on that one, and has none of ours.
        const off = json(await control({ chat: chatId, name: "memory_list", arguments: {} }));

        expect(off.isError).toBe(true);
        expect(off.text).toContain("memory is off for this variant");

        // Turned off in Settings: now the variant has ours, to read.
        expect((await post("/api/memory/choices", { choices: { claudeMemoryOff: true } })).status).toBe(200);

        const saved = json(await control({ chat: chatId, name: "memory_save", arguments: { level: "global", title: "t", text: "x" } }));

        expect(saved.isError).toBe(true);
        expect(saved.text).toContain("variant of an evaluation");

        expect(json(await control({ chat: chatId, name: "memory_list", arguments: {} })).isError).toBeUndefined();
    });

    /** Writes a variant's chat file with one message in it, as a sent message does. */
    function markStarted(name: string, chatId: string): void {

        const file = chatEventsPath(eeshaPath("evals", name), chatId);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, [
            { v: 1, kind: "open", runId: `chat:${chatId}`, at: 1000 },
            { kind: "prompt", at: 2000, ownerId: "chat", stream: "stdout", text: "hello" },
            { kind: "tool.start", at: 2100, ownerId: "chat", tool: "Reading a.txt", callId: "c1" },
            { kind: "tool.end", at: 2600, ownerId: "chat", tool: "Reading a.txt", callId: "c1", ok: true },
            { kind: "notice", at: 3000, ownerId: "chat", stream: "system", text: "Turn finished", cost: [{ amount: 0.5, unit: "USD" }], calls: 2 }
        ].map(line => JSON.stringify(line)).join("\n") + "\n");
    }

    it("keeps each variant's mode, effort and extra text, and sends the extra text under the message to all", async () => {

        await turnOn();

        const shown = json(await create({
            name: "one", folder: workFolder(),
            variants: [{ runtime: "claude" }, { name: "short", runtime: "claude", model: "opus", mode: "plan", effort: "high", extra: "  Change as few files as you can.  " }]
        })).eval;

        // Its message went when it was made.
        expect(shown.variants[0]).toMatchObject({ started: true, working: false });
        expect(shown.variants[0].extra).toBeUndefined();
        expect(shown.variants[1]).toMatchObject({ model: "opus", mode: "plan", effort: "high", extra: "Change as few files as you can." });

        const state = JSON.parse(fs.readFileSync(eeshaPath("evals", "one", "state.json"), "utf8"));

        expect(state[`chat.pick:${shown.variants[1].chatId}`]).toEqual({ provider: "claude", model: "opus", mode: "plan", effort: "high" });

        expect(sentTo(shown.variants[0].chatId)).toEqual([{ type: "send", text: "hello" }]);
        expect(sentTo(shown.variants[1].chatId)).toEqual([{ type: "send", text: "hello\n\nChange as few files as you can." }]);

        const refused = json(await create({ name: "two", folder: workFolder(), variants: [{ runtime: "claude", mode: "a\nb" }] })).problem;

        expect(refused).toContain("the mode is one line");
    });

    it("lists the saved tasks, and adds a find task's closing lines to what is sent", async () => {

        await turnOn();

        const listed = json(await post("/api/eval/tasks", {}));

        expect(listed.tasks.map((task: { name: string }) => task.name)).toEqual(expect.arrayContaining(["find-security", "fix-cache"]));
        expect(listed.folder).toBe(eeshaPath("eval-tasks"));
        expect(listed.problems).toEqual([]);

        // The common message as typed, then the variant's own text, then the task's closing lines last.
        const shown = json(await create({ name: "one", folder: workFolder(), text: "Look only in src.", task: "find-security", variants: [{ runtime: "claude", extra: "Be short." }] })).eval;

        const sent = (sentTo(shown.variants[0].chatId)[0] as { text: string }).text;

        expect(sent.startsWith("Look only in src.\n\nBe short.\n\nDo not change, create or delete any file")).toBe(true);
        expect(sent).toContain("```findings");
        expect(shown.sent).toMatchObject({ text: "Look only in src.", task: "find-security" });
    });

    it("joins the common message and each variant's own text, and names a variant left with nothing", async () => {

        await turnOn();

        // Nothing at the top and nothing of its own: the variant is named, and nothing is made.
        const variants = [{ name: "a", runtime: "claude", extra: "Use a map." }, { name: "b", runtime: "claude" }];

        expect(json(await create({ name: "one", folder: workFolder(), text: "  ", variants })).problem).toContain("Nothing to send to b");
        expect(fs.existsSync(eeshaPath("evals", "one"))).toBe(false);

        // A text of its own and nothing at the top: that text alone.
        const shown = json(await create({ name: "one", folder: workFolder(), text: "", variants: [variants[0], { ...variants[1], extra: "Use a list." }] })).eval;
        const [first, second] = shown.variants.map((one: { chatId: string }) => one.chatId) as string[];

        expect(sentTo(first!)).toEqual([{ type: "send", text: "Use a map." }]);
        expect(sentTo(second!)).toEqual([{ type: "send", text: "Use a list." }]);

        // The empty common message is kept: the top box shows it was empty.
        expect(json(await post("/api/eval/get", { name: "one" })).eval.sent).toMatchObject({ text: "" });
    });

    it("sends to the new variants only, closing lines included, and leaves the started ones alone", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), text: "Look only in src.", task: "find-security", variants: [{ runtime: "claude" }] })).eval;
        const old = shown.variants[0].chatId as string;

        // The first variant got its message when the evaluation was made.
        markStarted("one", old);

        // Every variant already got a message: nothing to send to.
        expect(json(await post("/api/eval/send", { name: "one", onlyNew: true })).problem).toContain("already got its message");

        const added = json(await post("/api/eval/variant/add", { name: "one", variant: { runtime: "claude", model: "new-model" } })).eval;
        const fresh = added.variants[1].chatId as string;

        // The kept message and its saved task: the new variant gets what the first one got, closing lines too. The first gets nothing more.
        expect((await post("/api/eval/send", { name: "one", onlyNew: true })).status).toBe(200);

        expect(sentTo(old)).toHaveLength(1);
        expect(sentTo(fresh)).toEqual(sentTo(old));
        expect((sentTo(fresh)[0] as { text: string }).text).toContain("```findings");

        // Kept: the message as typed and its task, and the runtime's version on each variant it went to.
        const after = json(await post("/api/eval/get", { name: "one" })).eval;

        expect(after.sent).toMatchObject({ text: "Look only in src.", task: "find-security" });
        expect(after.variants.map((one: { version?: string }) => one.version)).toEqual(["claude 9.9.9", "claude 9.9.9"]);
    });

    it("gives each variant one message: when it is made, then the kept message to new variants, never from a column", async () => {

        await turnOn();

        const shown = json(await create({
            name: "one", folder: workFolder(),
            variants: [{ runtime: "claude" }, { name: "own", runtime: "claude", extra: "Be short." }]
        })).eval;

        const [first, second] = shown.variants.map((one: { chatId: string }) => one.chatId) as string[];

        expect(shown.variants[1]).toMatchObject({ extra: "Be short." });

        // The message to all first; a variant's own text under it.
        expect(sentTo(first!)).toEqual([{ type: "send", text: "hello" }]);
        expect(sentTo(second!)).toEqual([{ type: "send", text: "hello\n\nBe short." }]);

        markStarted("one", first!);
        markStarted("one", second!);

        // Send to all again is refused: each variant got its message.
        const again = await post("/api/eval/send", { name: "one" });

        expect(again.status).toBe(409);
        expect(json(again).problem).toContain("one message");

        // A variant added later gets the kept message - a text sent with the ask is not read.
        const added = json(await post("/api/eval/variant/add", { name: "one", variant: { runtime: "claude" } })).eval;
        const third = added.variants[2].chatId as string;

        expect((await post("/api/eval/send", { name: "one", text: "something else", onlyNew: true })).status).toBe(200);
        expect(sentTo(third)).toEqual([{ type: "send", text: "hello" }]);

        // A column sends nothing and picks nothing: the page refuses it, and the column is told why.
        const tab = await events("view-eval-one-message", first!);

        open.push(tab);
        await tab.next("eesha.hello");

        for (const message of [{ type: "send", text: "second message" }, { type: "setAiChoice", pick: { provider: "claude", model: "opus" } }]) {

            const refused = await post("/api/chat", { view: "view-eval-one-message", message });

            expect(refused.status, message.type).toBe(409);
            expect((await tab.next("eesha.note")).text).toContain("one message");
        }

        expect(sentTo(first!)).toHaveLength(1);

        // Showing the column still goes through.
        expect((await post("/api/chat", { view: "view-eval-one-message", message: { type: "ready" } })).status).toBe(200);
    });

    it("removes one variant, its copy and its chat, and never the last one", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }, { name: "gone", runtime: "claude" }] })).eval;
        const chatId = shown.variants[1].chatId as string;

        markStarted("one", chatId);

        expect(fs.existsSync(eeshaPath("evals", "one", "copies", "gone"))).toBe(true);

        expect((await post("/api/eval/variant/remove", { name: "one", variant: "nobody" })).status).toBe(404);

        const removed = json(await post("/api/eval/variant/remove", { name: "one", variant: "gone" })).eval;

        expect(removed.variants.map((one: { name: string }) => one.name)).toEqual(["one-1"]);
        expect(fs.existsSync(eeshaPath("evals", "one", "copies", "gone"))).toBe(false);
        expect(fs.existsSync(chatEventsPath(eeshaPath("evals", "one"), chatId))).toBe(false);

        const state = JSON.parse(fs.readFileSync(eeshaPath("evals", "one", "state.json"), "utf8"));

        expect(state[`chat.pick:${chatId}`]).toBeUndefined();

        expect(json(await post("/api/eval/variant/remove", { name: "one", variant: "one-1" })).problem).toContain("only variant");
    });

    it("retries one variant from the start: a new copy and chat, the same setup and message, the old run gone", async () => {

        await turnOn();

        const folder = temporaryFolder();
        const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });

        git("init", "--quiet");
        git("config", "core.autocrlf", "false");
        fs.writeFileSync(path.join(folder, "a.txt"), "day one\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "first");

        const shown = json(await create({
            name: "again", folder, task: "find-security",
            variants: [{ runtime: "claude" }, { name: "own", runtime: "claude", model: "opus", extra: "Be short." }]
        })).eval;

        const [first, second] = shown.variants as { name: string; chatId: string }[];

        markStarted("again", second!.chatId);

        // What the old run left: a changed file in its copy, and a note in its scratch folder.
        const copy = eeshaPath("evals", "again", "copies", "own");
        const scratch = eeshaPath("evals", "again", "scratch", "own");

        fs.writeFileSync(path.join(copy, "a.txt"), "changed by the old run\n");
        fs.mkdirSync(scratch, { recursive: true });
        fs.writeFileSync(path.join(scratch, "note.md"), "old\n");

        // The folder moved on since: the new copy must not see it.
        fs.writeFileSync(path.join(folder, "a.txt"), "six months on\n");

        const answer = await post("/api/eval/variant/retry", { name: "again", variant: "own" });

        expect(answer.status, answer.text).toBe(200);
        expect(json(answer).sendProblem).toBeUndefined();

        const variants = json(answer).eval.variants as { name: string; chatId: string }[];
        const after = variants[1]!;

        // Same name, place and setup; a new chat, and its message sent.
        expect(variants.map(one => one.name)).toEqual(["again-1", "own"]);
        expect(after).toMatchObject({ runtime: "claude", model: "opus", extra: "Be short.", started: true, version: "claude 9.9.9" });
        expect(after.chatId).not.toBe(second!.chatId);

        // A new copy from where the evaluation started. The old run's copy, scratch folder and chat file are gone.
        expect(fs.readFileSync(path.join(copy, "a.txt"), "utf8")).toBe("day one\n");
        expect(fs.readdirSync(eeshaPath("evals", "again", "copies")).sort()).toEqual(["again-1", "own"]);
        expect(fs.existsSync(scratch)).toBe(false);
        expect(fs.existsSync(chatEventsPath(eeshaPath("evals", "again"), second!.chatId))).toBe(false);

        // Exactly the message it got the first time - common message, own text, closing lines. The other variant got nothing more.
        expect(sentTo(after.chatId)).toEqual(sentTo(second!.chatId));
        expect((sentTo(after.chatId)[0] as { text: string }).text).toContain("Be short.");
        expect((sentTo(after.chatId)[0] as { text: string }).text).toContain("```findings");
        expect(sentTo(first!.chatId)).toHaveLength(1);

        // Its setup is saved for the new chat, and the old chat's is gone.
        const state = JSON.parse(fs.readFileSync(eeshaPath("evals", "again", "state.json"), "utf8"));

        expect(state[`chat.pick:${second!.chatId}`]).toBeUndefined();
        expect(state[`chat.pick:${after.chatId}`]).toEqual({ provider: "claude", model: "opus" });
    });

    it("refuses a retry while the variant works and before it had its message, and sends a retry to that variant alone", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }] })).eval;
        const chatId = shown.variants[0].chatId as string;

        expect((await post("/api/eval/variant/retry", { name: "one", variant: "nobody" })).status).toBe(404);
        expect((await post("/api/eval/variant/retry", { name: "none", variant: "one-1" })).status).toBe(404);

        // Its column open, a turn running.
        const tab = await events("view-eval-retry", chatId);

        open.push(tab);
        await tab.next("eesha.hello");

        live(chatId).working = true;

        const busy = await post("/api/eval/variant/retry", { name: "one", variant: "one-1" });

        expect(busy.status).toBe(409);
        expect(json(busy).problem).toContain("still working");

        live(chatId).working = false;

        // A variant added later has had no message yet: Send to new variants sends it, not Retry.
        const later = json(await post("/api/eval/variant/add", { name: "one", variant: { name: "later", runtime: "claude" } })).eval.variants[1].chatId as string;

        expect(json(await post("/api/eval/variant/retry", { name: "one", variant: "later" })).problem).toContain("Send to new variants");
        expect(json(await post("/api/eval/get", { name: "one" })).eval.variants[0].chatId).toBe(chatId);

        // A retry sends only to the variant retried: the new one still waits for Send to new variants.
        expect((await post("/api/eval/variant/retry", { name: "one", variant: "one-1" })).status).toBe(200);
        expect(sentTo(later)).toEqual([]);
        expect(json(await post("/api/eval/get", { name: "one" })).eval.variants.map((one: { started: boolean }) => one.started)).toEqual([true, false]);
    });

    it("adds a variant later, with its own copy from where the evaluation started", async () => {

        await turnOn();

        const folder = temporaryFolder();
        const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });

        git("init", "--quiet");
        git("config", "core.autocrlf", "false");
        fs.writeFileSync(path.join(folder, "a.txt"), "day one\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "first");

        await create({ name: "later", folder, variants: [{ runtime: "claude" }] });

        // The folder moved on since: a variant added now must not see it.
        fs.writeFileSync(path.join(folder, "a.txt"), "six months on\n");

        const added = json(await post("/api/eval/variant/add", { name: "later", variant: { runtime: "claude", model: "new-model" } })).eval;

        expect(added.variants.map((one: { name: string }) => one.name)).toEqual(["later-1", "later-2"]);
        expect(added.variants[1]).toMatchObject({ model: "new-model", started: false });
        expect(fs.readFileSync(path.join(eeshaPath("evals", "later", "copies", "later-2"), "a.txt"), "utf8")).toBe("day one\n");

        const problem = async (variant: unknown) => json(await post("/api/eval/variant/add", { name: "later", variant })).problem as string;

        expect(await problem({ name: "Later-1", runtime: "claude" })).toContain("already a variant named");
        expect(await problem({ name: "x y", runtime: "claude" })).toContain("is not a name");
        expect(await problem({})).toContain("pick a runtime");
        expect((await post("/api/eval/variant/add", { name: "none", variant: { runtime: "claude" } })).status).toBe(404);

        for (let count = 3; count <= 6; count++)
            expect((await post("/api/eval/variant/add", { name: "later", variant: { runtime: "claude" } })).status).toBe(200);

        expect(await problem({ runtime: "claude" })).toContain("up to 6 variants");
    });

    it("stops one variant's turn, and says so when it is not working", async () => {

        await turnOn();

        const shown = json(await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }, { runtime: "claude" }] })).eval;
        const [first, second] = shown.variants as { name: string; chatId: string }[];

        // Its column is open while it works.
        const tab = await events("view-eval-stop", first!.chatId);

        open.push(tab);
        await tab.next("eesha.hello");

        const chat = live(first!.chatId);

        chat.working = true;

        expect((await post("/api/eval/stop", { name: "one", variant: first!.name })).status).toBe(200);
        expect(chat.received.at(-1)).toEqual({ type: "cancel" });

        chat.working = false;

        // Not working: nothing to stop. No such variant, or no such evaluation: not found.
        expect(json(await post("/api/eval/stop", { name: "one", variant: second!.name })).problem).toContain("is not working");
        expect((await post("/api/eval/stop", { name: "one", variant: "nobody" })).status).toBe(404);
        expect((await post("/api/eval/stop", { name: "none", variant: first!.name })).status).toBe(404);
    });

    it("reports each variant's numbers, the files its copy differs in, and the size on disk", async () => {

        await turnOn();

        const folder = temporaryFolder();
        const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });

        git("init", "--quiet");
        git("config", "core.autocrlf", "false");
        fs.writeFileSync(path.join(folder, "a.txt"), "text\n");
        fs.writeFileSync(path.join(folder, "b.txt"), "text\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "first");

        const shown = json(await create({ name: "rep", folder, variants: [{ runtime: "claude" }, { runtime: "claude" }] })).eval;
        const copy = eeshaPath("evals", "rep", "copies", "rep-1");

        // What an agent would have done in the first variant's copy.
        fs.writeFileSync(path.join(copy, "a.txt"), "changed\n");
        fs.writeFileSync(path.join(copy, "new.txt"), "new\n");
        fs.rmSync(path.join(copy, "b.txt"));

        markStarted("rep", shown.variants[0].chatId);

        const answer = await post("/api/eval/report", { name: "rep" });

        expect(answer.status).toBe(200);

        const report = json(answer).report;

        expect(report.variants.map((one: { name: string }) => one.name)).toEqual(["rep-1", "rep-2"]);
        expect(report.variants[0].turns).toHaveLength(1);
        expect(report.variants[0].turns[0]).toMatchObject({ ms: 1000, toolMs: 500, toolCalls: 1, modelCalls: 2, cost: [{ amount: 0.5, unit: "USD" }] });
        expect(report.variants[0].files).toEqual([
            { path: "a.txt", status: "modified" },
            { path: "b.txt", status: "deleted" },
            { path: "new.txt", status: "added" }
        ]);
        expect(report.variants[1]).toMatchObject({ turns: [], files: [] });
        expect(report.variants[0].bytes).toBeGreaterThan(0);
        expect(report.bytes).toBeGreaterThan(report.variants[0].bytes);
    });

    it("keeps a saved task's closing lines with the evaluation: a variant added later gets the same, task file or not", async () => {

        await turnOn();

        // One of the person's own tasks.
        const file = eeshaPath("eval-tasks", "mine.md");

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, "---\nkind: find\n---\nLook for slow loops.\n");

        try {

            const shown = json(await create({ name: "one", folder: workFolder(), text: "Look for slow loops.", task: "mine", variants: [{ runtime: "claude" }] })).eval;
            const first = (sentTo(shown.variants[0].chatId)[0] as { text: string }).text;

            expect(shown.sent.closing).toContain("```findings");
            expect(first.endsWith(shown.sent.closing)).toBe(true);

            // The task file is gone: a variant added later still gets the same message, closing lines included.
            fs.rmSync(file);

            const added = json(await post("/api/eval/variant/add", { name: "one", variant: { runtime: "claude" } })).eval;

            expect((await post("/api/eval/send", { name: "one", onlyNew: true })).status).toBe(200);
            expect(sentTo(added.variants[1].chatId)).toEqual([{ type: "send", text: first }]);

            // An evaluation from before the lines were kept reads them from its task - gone now, so it says so.
            const saved = JSON.parse(fs.readFileSync(eeshaPath("evals", "one", "eval.json"), "utf8"));

            delete saved.sent.closing;
            fs.writeFileSync(eeshaPath("evals", "one", "eval.json"), JSON.stringify(saved));

            expect((await post("/api/eval/variant/add", { name: "one", variant: { runtime: "claude" } })).status).toBe(200);
            expect(json(await post("/api/eval/send", { name: "one", onlyNew: true })).problem).toContain("is not there any more");

        } finally {

            fs.rmSync(eeshaPath("eval-tasks"), { recursive: true, force: true });
        }
    });

    it("counts the copies again only after a turn ran, not each time the report is read", async () => {

        await turnOn();

        const folder = temporaryFolder();
        const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });

        git("init", "--quiet");
        git("config", "core.autocrlf", "false");
        fs.writeFileSync(path.join(folder, "a.txt"), "text\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "first");

        const shown = json(await create({ name: "rep", folder, variants: [{ runtime: "claude" }] })).eval;
        const copy = eeshaPath("evals", "rep", "copies", "rep-1");
        const files = async () => json(await post("/api/eval/report", { name: "rep" })).report.variants[0].files;

        expect(await files()).toEqual([]);

        // Changed outside a turn: the last count still holds.
        fs.writeFileSync(path.join(copy, "a.txt"), "changed\n");

        expect(await files()).toEqual([]);

        // A turn ran - its chat file changed: counted again.
        markStarted("rep", shown.variants[0].chatId);

        expect(await files()).toEqual([{ path: "a.txt", status: "modified" }]);
    });

    it("saves the person's own pick and note, and takes it away again", async () => {

        await turnOn();

        await create({ name: "one", folder: workFolder(), variants: [{ runtime: "claude" }, { runtime: "claude" }] });

        const saved = json(await post("/api/eval/pick", { name: "one", variant: "one-2", note: "  It also fixed the tests.  " })).eval;

        expect(saved.pick).toMatchObject({ variant: "one-2", note: "It also fixed the tests." });
        expect(json(await post("/api/eval/get", { name: "one" })).eval.pick.variant).toBe("one-2");

        expect(json(await post("/api/eval/pick", { name: "one", variant: "nobody" })).problem).toContain("no variant named");

        // A note with no variant picked is kept; neither takes the pick away.
        expect(json(await post("/api/eval/pick", { name: "one", note: "Neither is good." })).eval.pick).toMatchObject({ note: "Neither is good." });
        expect(json(await post("/api/eval/pick", { name: "one", note: "" })).eval.pick).toBeUndefined();
    });

    it("deletes an evaluation with its copies, chats and starting commit - and not while a variant works", async () => {

        await turnOn();

        const folder = temporaryFolder();
        const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" } });

        git("init", "--quiet");
        fs.writeFileSync(path.join(folder, "a.txt"), "text\n");
        git("add", "-A");
        git("commit", "--quiet", "-m", "first");

        const shown = json(await create({ name: "gone", folder, variants: [{ runtime: "claude" }] })).eval;
        const chatId = shown.variants[0].chatId as string;

        expect(git("for-each-ref", "refs/eesha/evals")).toContain("refs/eesha/evals/gone");

        // Its chat is open in a column, and a message was sent.
        const tab = await events("view-eval-delete", chatId);

        open.push(tab);
        await tab.next("eesha.hello");

        markStarted("gone", chatId);

        const chat = live(chatId);

        chat.working = true;

        const refused = await post("/api/eval/delete", { name: "gone" });

        expect(refused.status).toBe(409);
        expect(fs.existsSync(eeshaPath("evals", "gone"))).toBe(true);

        chat.working = false;

        expect((await post("/api/eval/delete", { name: "gone" })).status).toBe(200);

        // The column is told its chat is gone, and the chat's session was ended.
        expect((await tab.next("eesha.unknownChat")).chatId).toBe(chatId);
        expect(chat.closed).toBe(true);

        expect(fs.existsSync(eeshaPath("evals", "gone"))).toBe(false);
        expect(fs.existsSync(chatEventsPath(eeshaPath("evals", "gone"), chatId))).toBe(false);
        expect(git("for-each-ref", "refs/eesha/evals")).toBe("");
        expect(fs.readFileSync(path.join(folder, "a.txt"), "utf8")).toBe("text\n");

        expect(json(await post("/api/eval/list", {})).evals).toEqual([]);
        expect((await post("/api/eval/delete", { name: "gone" })).status).toBe(404);
    });
});

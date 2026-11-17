// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import type { IncomingMessage } from "http";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { FileStore } from "../fileStore";
import { gitReposIn, isInside, listFolders, searchFolders, workingFoldersHere } from "../folders";
import { eeshaHome, eeshaPath } from "../paths";
import { cookieKey, ensureKey, hostAllowed, isKey, keyCookie, originAllowed, sameSite } from "../security";
import { checkFolders, isChatId, readSession, recentFolders, rememberFolders, removeSession, sessionIds, writeSession } from "../sessions";
import { DEFAULT_PORT, readServerSettings } from "../settings";
import { homeIsThrowaway } from "./homeGuard";

/*
 * The small parts of Eesha Code, each on its own. The home folder is a
 * temporary one for every test file (src/__tests__/setup.ts), so
 * ~/.eesha here is never the real one.
 */

function request(headers: Record<string, string>): IncomingMessage {

    return { headers } as unknown as IncomingMessage;
}

function temporaryFolder(): string {

    return fs.mkdtempSync(path.join(os.tmpdir(), "eesha-test-"));
}

describe("the profile folder", () => {

    it("is .eesha in the home folder", () => {

        expect(eeshaHome()).toBe(path.join(os.homedir(), ".eesha"));
        expect(eeshaPath("settings.json")).toBe(path.join(os.homedir(), ".eesha", "settings.json"));
    });

    it("is a throwaway folder in these tests - the guard takes only a folder inside the temp folder", () => {

        const temp = path.join("C:", "Users", "me", "AppData", "Local", "Temp");

        expect(homeIsThrowaway(path.join(temp, "eesha-home-abc"), temp)).toBe(true);
        expect(homeIsThrowaway(path.join("C:", "Users", "me"), temp)).toBe(false);
        expect(homeIsThrowaway(temp, temp)).toBe(false);
        expect(homeIsThrowaway(path.join(temp, "..", "Other"), temp)).toBe(false);

        // This run's own home passed the guard.
        expect(homeIsThrowaway(os.homedir(), os.tmpdir())).toBe(true);
    });

    it("is guarded in every Eesha Code test file, which loads the guard before anything else", () => {

        const files = fs.readdirSync(__dirname).filter(name => name.endsWith(".test.ts"));

        expect(files.length).toBeGreaterThan(3);

        for (const name of files) {

            const firstImport = fs.readFileSync(path.join(__dirname, name), "utf8").split(/\r?\n/).find(line => line.startsWith("import "));

            expect(firstImport, name).toBe('import "./homeGuard";');
        }
    });
});

describe("settings", () => {

    it("uses port 7420 and the dark theme when there is no file", () => {

        expect(readServerSettings(path.join(temporaryFolder(), "settings.json"))).toEqual({ port: DEFAULT_PORT, theme: "dark", fontSize: 16, workingFolders: [], runtimes: {}, problems: [] });
    });

    it("reads eesha.port and eesha.theme", () => {

        const file = path.join(temporaryFolder(), "settings.json");

        fs.writeFileSync(file, JSON.stringify({ ai: {}, eesha: { port: 8123, theme: "light" } }));

        expect(readServerSettings(file)).toEqual({ port: 8123, theme: "light", fontSize: 16, workingFolders: [], runtimes: {}, problems: [] });
    });

    it("says what is wrong and keeps the defaults for a bad port or theme", () => {

        const file = path.join(temporaryFolder(), "settings.json");

        fs.writeFileSync(file, JSON.stringify({ eesha: { port: 80, theme: "blue" } }));

        const read = readServerSettings(file);

        expect(read.port).toBe(DEFAULT_PORT);
        expect(read.theme).toBe("dark");
        expect(read.problems).toHaveLength(2);
    });

    it("reads eesha.fontSize, and keeps 16 for a size that is not a whole number from 11 to 24", () => {

        const file = path.join(temporaryFolder(), "settings.json");

        fs.writeFileSync(file, JSON.stringify({ eesha: { fontSize: 14 } }));

        expect(readServerSettings(file).fontSize).toBe(14);

        for (const bad of [10, 25, 15.5, "16"]) {

            fs.writeFileSync(file, JSON.stringify({ eesha: { fontSize: bad } }));

            const read = readServerSettings(file);

            expect(read.fontSize).toBe(16);
            expect(read.problems).toHaveLength(1);
        }
    });

    it("reads eesha.workingFolders as full paths, each once", () => {

        const file = path.join(temporaryFolder(), "settings.json");
        const work = temporaryFolder();
        const other = path.join(temporaryFolder(), "not-made-yet");

        fs.writeFileSync(file, JSON.stringify({ eesha: { workingFolders: [work, ` ${other} `, work + path.sep] } }));

        const read = readServerSettings(file);

        // A folder that does not exist now is kept: a drive may be unplugged.
        expect(read.workingFolders).toEqual([work, other]);
        expect(read.problems).toEqual([]);
    });

    it("uses no working folders and says why when the list is wrong", () => {

        const file = path.join(temporaryFolder(), "settings.json");

        for (const bad of ["C:\\work", [1], [""], ["relative/folder"]]) {

            fs.writeFileSync(file, JSON.stringify({ eesha: { workingFolders: bad } }));

            const read = readServerSettings(file);

            expect(read.workingFolders).toEqual([]);
            expect(read.problems).toHaveLength(1);
            expect(read.problems[0]).toContain("no working folders are used");
        }
    });
});

describe("the key", () => {

    it("is made once and kept across restarts", () => {

        const file = path.join(temporaryFolder(), "key");

        const first = ensureKey(file);

        expect(first).toMatch(/^[0-9a-f]{48}$/);
        expect(ensureKey(file)).toBe(first);
    });

    it("is compared whole", () => {

        const key = "a".repeat(48);

        expect(isKey(key, key)).toBe(true);
        expect(isKey("a".repeat(47), key)).toBe(false);
        expect(isKey("b".repeat(48), key)).toBe(false);
        expect(isKey(undefined, key)).toBe(false);
    });

    it("travels in a strict, script-proof cookie", () => {

        const cookie = keyCookie("k".repeat(48));

        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookieKey(request({ cookie: `other=1; eesha_key=${"k".repeat(48)}` }))).toBe("k".repeat(48));
        expect(cookieKey(request({}))).toBeUndefined();
    });
});

describe("request checks", () => {

    it("answers only to 127.0.0.1 and localhost on its own port", () => {

        expect(hostAllowed(request({ host: "127.0.0.1:7420" }), 7420)).toBe(true);
        expect(hostAllowed(request({ host: "localhost:7420" }), 7420)).toBe(true);
        expect(hostAllowed(request({ host: "evil.example:7420" }), 7420)).toBe(false);
        expect(hostAllowed(request({ host: "127.0.0.1:9999" }), 7420)).toBe(false);
        expect(hostAllowed(request({}), 7420)).toBe(false);
    });

    it("takes changes only from its own page", () => {

        expect(originAllowed(request({ origin: "http://127.0.0.1:7420" }), 7420)).toBe(true);
        expect(originAllowed(request({ origin: "http://localhost:7420" }), 7420)).toBe(true);
        expect(originAllowed(request({ origin: "https://evil.example" }), 7420)).toBe(false);
        expect(originAllowed(request({}), 7420)).toBe(false);
    });

    it("refuses page loads another site starts", () => {

        expect(sameSite(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
        expect(sameSite(request({ "sec-fetch-site": "none" }))).toBe(true);
        expect(sameSite(request({}))).toBe(true);
        expect(sameSite(request({ "sec-fetch-site": "cross-site" }))).toBe(false);
        expect(sameSite(request({ "sec-fetch-site": "same-site" }))).toBe(false);
    });
});

describe("sessions", () => {

    it("takes only chat ids that are safe as file names", () => {

        expect(isChatId("2026-11-05T01-02-03-abc123")).toBe(true);
        expect(isChatId("../settings")).toBe(false);
        expect(isChatId("a/b")).toBe(false);
        expect(isChatId("")).toBe(false);
        expect(isChatId(7)).toBe(false);
    });

    it("saves each chat's folders and reads them back", () => {

        const folders = [temporaryFolder(), temporaryFolder()];

        writeSession("chat-1", { folders, scratch: false });

        expect(readSession("chat-1")).toEqual({ folders, scratch: false });

        // No folder at all, and pinned to scratch.
        writeSession("chat-2", { folders: [], scratch: true });

        expect(readSession("chat-2")).toEqual({ folders: [], scratch: true });
        expect(sessionIds().sort()).toEqual(["chat-1", "chat-2"]);
        expect(fs.existsSync(eeshaPath("sessions", "chat-1.json"))).toBe(true);

        removeSession("chat-1");

        expect(readSession("chat-1")).toBeUndefined();
    });

    it("keeps whose scratch folder a copy uses, and drops one that is not a chat id", () => {

        writeSession("chat-copy", { folders: [], scratch: false, scratchOf: "chat-1" });

        expect(readSession("chat-copy")).toEqual({ folders: [], scratch: false, scratchOf: "chat-1" });

        fs.writeFileSync(eeshaPath("sessions", "chat-bad.json"), JSON.stringify({ folders: [], scratchOf: "../elsewhere" }));

        expect(readSession("chat-bad")).toEqual({ folders: [], scratch: false });
    });

    it("refuses folders that are missing, relative or not folders, and drops repeats", () => {

        const folder = temporaryFolder();
        const file = path.join(folder, "a.txt");

        fs.writeFileSync(file, "x");

        expect(checkFolders([])).toEqual({ folders: [] });
        expect(checkFolders(undefined)).toHaveProperty("problem");
        expect(checkFolders(["relative/path"])).toHaveProperty("problem");
        expect(checkFolders([path.join(folder, "missing")])).toHaveProperty("problem");
        expect(checkFolders([file])).toHaveProperty("problem");
        expect(checkFolders([folder, folder])).toEqual({ folders: [folder] });
    });

    it("keeps the folders used before, newest first, without repeats", async () => {

        const store = new FileStore(path.join(temporaryFolder(), "state.json"));
        const [one, two] = [temporaryFolder(), temporaryFolder()];

        await rememberFolders(store, [one]);
        await rememberFolders(store, [two, one]);

        expect(recentFolders(store)).toEqual([two, one]);

        fs.rmSync(two, { recursive: true });

        expect(recentFolders(store)).toEqual([one]);
    });
});

describe("the store", () => {

    it("keeps values across a restart and removes a key set to nothing", async () => {

        const file = path.join(temporaryFolder(), "state.json");

        const store = new FileStore(file);

        await store.update("chat.pick:a", { provider: "kiro" });
        await store.update("sdd.permissions", "manual");
        await store.update("sdd.permissions", undefined);

        const again = new FileStore(file);

        expect(again.get("chat.pick:a")).toEqual({ provider: "kiro" });
        expect(again.get("sdd.permissions")).toBeUndefined();
    });

    it("starts empty from a file that is not JSON", () => {

        const file = path.join(temporaryFolder(), "state.json");

        fs.writeFileSync(file, "{ not json");

        expect(new FileStore(file).get("anything")).toBeUndefined();
    });
});

describe("the folder browser", () => {

    it("lists the top level with no folder - the drives on Windows", async () => {

        const top = await listFolders(undefined);

        expect(top.path).toBe("");
        expect(top.parent).toBeUndefined();
        expect(top.entries.length).toBeGreaterThan(0);
    });

    it("lists only the folders inside a folder, by name, with the one above", async () => {

        const folder = temporaryFolder();

        fs.mkdirSync(path.join(folder, "beta"));
        fs.mkdirSync(path.join(folder, "Alpha"));
        fs.writeFileSync(path.join(folder, "file.txt"), "x");

        const listing = await listFolders(folder);

        expect(listing.entries.map(entry => entry.name)).toEqual(["Alpha", "beta"]);
        expect(listing.parent).toBe(path.dirname(folder));
    });

    it("says why a folder cannot be read", async () => {

        const listing = await listFolders(path.join(temporaryFolder(), "missing"));

        expect(listing.entries).toEqual([]);
        expect(listing.problem).toBeTruthy();
    });
});

describe("the git repos in the working folders", () => {

    /** Makes `folder` look like a git repo whose last git activity was `seconds` ago. */
    function repo(folder: string, seconds: number, asFile = false): string {

        fs.mkdirSync(folder, { recursive: true });

        const git = path.join(folder, ".git");

        if (asFile)
            fs.writeFileSync(git, "gitdir: elsewhere");
        else
            fs.mkdirSync(git);

        const when = new Date(Date.now() - seconds * 1000);

        fs.utimesSync(git, when, when);

        return folder;
    }

    it("lists the working folder when it is a repo and the repos right inside it, last git activity first", async () => {

        const work = temporaryFolder();

        const old = repo(path.join(work, "old"), 3000);
        const fresh = repo(path.join(work, "fresh"), 10);
        const worktree = repo(path.join(work, "worktree"), 500, true);

        repo(work, 1000);

        // Not repos: a plain folder, a file, and a repo two levels in.
        fs.mkdirSync(path.join(work, "plain"));
        fs.writeFileSync(path.join(work, "notes.txt"), "");
        repo(path.join(work, "plain", "deep"), 1);

        expect(await gitReposIn([work])).toEqual([fresh, worktree, work, old]);
    });

    it("lists a repo once when two working folders hold it, and skips a working folder that cannot be read", async () => {

        const work = temporaryFolder();
        const api = repo(path.join(work, "api"), 10);

        expect(await gitReposIn([work, api, path.join(work, "missing")])).toEqual([api]);
    });

    it("keeps only the working folders that are folders right now", () => {

        const work = temporaryFolder();
        const file = path.join(work, "file.txt");

        fs.writeFileSync(file, "");

        expect(workingFoldersHere([path.join(work, "missing"), file, work])).toEqual([work]);
    });
});

describe("the \"/\" file search", () => {

    it("gives the working folder's files relative to it, other folders' in full, and skips dependencies", async () => {

        const work = temporaryFolder();
        const other = temporaryFolder();

        fs.mkdirSync(path.join(work, "src"));
        fs.mkdirSync(path.join(work, "node_modules", "pkg"), { recursive: true });
        fs.writeFileSync(path.join(work, "src", "app.ts"), "");
        fs.writeFileSync(path.join(work, "node_modules", "pkg", "app.ts"), "");
        fs.writeFileSync(path.join(other, "app.md"), "");

        const found = await searchFolders([work, other], "app");

        expect(found).toContainEqual({ name: "app.ts", path: "src/app.ts" });
        expect(found).toContainEqual({ name: "app.md", path: path.join(other, "app.md").split(path.sep).join("/") });
        expect(found.some(match => match.path.includes("node_modules"))).toBe(false);
    });

    it("knows when a file is inside a folder", () => {

        const folder = temporaryFolder();

        expect(isInside(folder, path.join(folder, "a", "b.txt"))).toBe(true);
        expect(isInside(folder, folder)).toBe(true);
        expect(isInside(folder, path.join(folder, "..", "elsewhere.txt"))).toBe(false);
    });
});

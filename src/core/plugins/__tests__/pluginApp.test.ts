import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Plugin, PluginHandleContext } from "../Plugin";
import { PluginDatabase } from "../PluginDatabase";
import { PluginHost } from "../PluginHost";
import { PluginLoader } from "../PluginLoader";
import { PluginManifestError, pluginFromManifest } from "../PluginManifest";
import { PluginRegistry } from "../PluginRegistry";
import { PluginSandbox } from "../sandbox/PluginSandbox";
import { requireWorkerBundle, WORKER_PATH } from "./sandboxHarness";

/**
 * A plugin's own app: the manifest's `ui`, the `handle` export, and
 * `ctx.db` - through the sandbox and in-process.
 */

let dir: string;

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-plugin-app-"));
});

afterEach(() => {

    fs.rmSync(dir, { recursive: true, force: true });
});

const noop = async () => ({ success: true });

describe("a manifest's ui", () => {

    it("names the tab and defaults the page to ui/index.html", () => {

        const plugin = pluginFromManifest({
            id: "board", version: { major: 1, minor: 0, patch: 0 }, ui: { label: "Board" }
        }, noop);

        expect(plugin.ui).toEqual({ label: "Board", entry: "ui/index.html", surface: "both" });
    });

    it("keeps an entry the manifest names", () => {

        const plugin = pluginFromManifest({
            id: "board", version: { major: 1, minor: 0, patch: 0 }, ui: { label: "Board", entry: "app/page.html" }
        }, noop);

        expect(plugin.ui?.entry).toBe("app/page.html");
    });

    it("refuses a ui with no label", () => {

        expect(() => pluginFromManifest({
            id: "board", version: { major: 1, minor: 0, patch: 0 }, ui: {} as { label: string }
        }, noop)).toThrow(PluginManifestError);
    });

    it("refuses an entry that leaves the plugin's folder", () => {

        for (const entry of ["../secrets.html", "C:/x/page.html", "/etc/page.html"])
            expect(() => pluginFromManifest({
                id: "board", version: { major: 1, minor: 0, patch: 0 }, ui: { label: "Board", entry }
            }, noop), entry).toThrow(/leaves the plugin's folder/);
    });

    it("keeps a surface the manifest names, and refuses one it does not know", () => {

        const plugin = pluginFromManifest({
            id: "board", version: { major: 1, minor: 0, patch: 0 }, ui: { label: "Board", surface: "run" }
        }, noop);

        expect(plugin.ui?.surface).toBe("run");

        expect(() => pluginFromManifest({
            id: "board", version: { major: 1, minor: 0, patch: 0 }, ui: { label: "Board", surface: "panel" as never }
        }, noop)).toThrow(/'ui.surface: panel' - it is one of run, spec, both/);
    });

    it("carries handle through when the implementation has one", async () => {

        const plugin = pluginFromManifest(
            { id: "board", version: { major: 1, minor: 0, patch: 0 } },
            noop,
            undefined,
            async request => ({ echoed: request.name }));

        expect(await plugin.handle!({ name: "ping" }, {} as PluginHandleContext)).toEqual({ echoed: "ping" });
    });
});

describe("the registry's apps", () => {

    const withUi = (id: string): Plugin =>
        ({ id, version: "1", ui: { label: id, entry: "ui/index.html", surface: "both" }, execute: noop });

    it("lists only plugins that declare a ui and have a folder to read it from", () => {

        const registry = new PluginRegistry();

        registry.register(withUi("folderless"), "builtin");
        registry.register({ id: "plain", version: "1", execute: noop }, "profile", "p/plain/index.js", "p/plain");
        registry.register(withUi("board"), "profile", "p/boardV1/index.js", "p/boardV1");

        expect(registry.apps()).toEqual([
            { ref: "board@1", plugin: expect.objectContaining({ id: "board" }), folder: "p/boardV1" }
        ]);
    });

    it("becomes another registry in place, so every holder sees the reload", () => {

        const held = new PluginRegistry();

        held.register({ id: "old", version: "1", execute: noop }, "profile", "old.js");

        const fresh = new PluginRegistry();

        fresh.register({ id: "new", version: "1", execute: noop }, "profile", "new.js");

        held.replaceWith(fresh);

        expect(held.keys()).toEqual(["new@1"]);
    });
});

describe("PluginHost.handle", () => {

    function host(plugin: Plugin, database?: PluginDatabase) {

        const registry = new PluginRegistry();

        registry.register(plugin);

        return new PluginHost(registry, database);
    }

    it("runs the plugin's handle with a context that has the plugin's db", async () => {

        const database = new PluginDatabase(path.join(dir, "plugins"));

        try {

            const plugin: Plugin = {
                id: "board",
                version: "1",
                execute: noop,
                handle: async (request, ctx) => {

                    await ctx.db!.run("CREATE TABLE IF NOT EXISTS notes (text TEXT)");
                    await ctx.db!.run("INSERT INTO notes VALUES (?)", [request.payload]);

                    return ctx.db!.all("SELECT text FROM notes");
                }
            };

            const result = await host(plugin, database).handle("board@1", { name: "add", payload: "hi" }, { cwd: dir, root: dir });

            expect(result).toEqual([{ text: "hi" }]);

        } finally {

            database.close();
        }
    });

    it("says so when the plugin has no handle", async () => {

        await expect(host({ id: "board", version: "1", execute: noop }).handle("board@1", { name: "x" }, { cwd: dir, root: dir }))
            .rejects.toThrow(/has no 'handle/);
    });

    it("says so when the reference is unknown", async () => {

        await expect(host({ id: "board", version: "1", execute: noop }).handle("nope@1", { name: "x" }, { cwd: dir, root: dir }))
            .rejects.toThrow(/No plugin found/);
    });
});

/** A folder plugin with a manifest, a ui, a handle and a db-using execute. */
function writeBoardPlugin(): string {

    const folder = path.join(dir, "boardV1");

    fs.mkdirSync(path.join(folder, "ui"), { recursive: true });

    fs.writeFileSync(path.join(folder, "plugin.json"), JSON.stringify({
        id: "board",
        version: { major: 1, minor: 0, patch: 0 },
        ui: { label: "Board" }
    }));

    fs.writeFileSync(path.join(folder, "ui", "index.html"), "<html><body>board</body></html>");

    fs.writeFileSync(path.join(folder, "index.js"), `
        module.exports = {
            async execute(args, ctx) {
                await ctx.db.run("CREATE TABLE IF NOT EXISTS hits (n INTEGER)");
                await ctx.db.run("INSERT INTO hits VALUES (?)", [1]);
                return { success: true, artifacts: { hasDb: Boolean(ctx.db) } };
            },
            async handle(request, ctx) {
                if (request.name === "count") {
                    const row = await ctx.db.get("SELECT COUNT(*) AS n FROM hits");
                    return { count: row.n, payload: request.payload };
                }
                if (request.name === "nodb")
                    return { hasDb: ctx.db !== undefined };
                throw new Error("unknown: " + request.name);
            }
        };
    `);

    return folder;
}

const handleContext = (db?: PluginHandleContext["db"]): PluginHandleContext => ({
    cwd: dir,
    root: dir,
    env: {},
    secret: () => undefined,
    log: () => undefined,
    ...(db ? { db } : {})
});

describe("through the sandbox", () => {

    beforeEach(requireWorkerBundle);

    it("describes the ui and the handle, and answers a handle call with db access", async () => {

        writeBoardPlugin();

        const loader = new PluginLoader(new PluginSandbox(WORKER_PATH));

        const { loaded, failures } = loader.load(dir);

        expect(failures).toEqual([]);
        expect(loaded[0].folder).toBe(path.join(dir, "boardV1"));
        expect(loaded[0].plugin.ui).toEqual({ label: "Board", entry: "ui/index.html", surface: "both" });
        expect(typeof loaded[0].plugin.handle).toBe("function");

        const database = new PluginDatabase(path.join(dir, "plugins"));

        try {

            const db = database.for("board");

            const result = await loaded[0].plugin.execute({}, {
                runId: "r", taskId: "t", attempt: 1, cwd: dir, root: dir, env: {},
                secret: () => undefined, log: () => undefined, reportSession: () => undefined,
                cancelled: false, onCancel: () => undefined, db
            });

            expect(result.artifacts).toEqual({ hasDb: true });

            expect(await loaded[0].plugin.handle!({ name: "count", payload: { a: 1 } }, handleContext(db)))
                .toEqual({ count: 1, payload: { a: 1 } });

        } finally {

            database.close();
        }
    }, 30_000);

    it("leaves ctx.db absent when the host has no database", async () => {

        writeBoardPlugin();

        const { loaded } = new PluginLoader(new PluginSandbox(WORKER_PATH)).load(dir);

        expect(await loaded[0].plugin.handle!({ name: "nodb" }, handleContext())).toEqual({ hasDb: false });
    }, 30_000);

    it("rejects a handle call that throws, with the plugin's own message", async () => {

        writeBoardPlugin();

        const { loaded } = new PluginLoader(new PluginSandbox(WORKER_PATH)).load(dir);

        await expect(loaded[0].plugin.handle!({ name: "bogus" }, handleContext())).rejects.toThrow("unknown: bogus");
    }, 30_000);

    it("has no handle on a plugin whose module exports none", () => {

        fs.writeFileSync(path.join(dir, "plain.js"), `module.exports = { id: "plain", version: "1", async execute() { return { success: true }; } };`);

        const { loaded } = new PluginLoader(new PluginSandbox(WORKER_PATH)).load(dir);

        expect(loaded[0].plugin.handle).toBeUndefined();
        expect(loaded[0].plugin.ui).toBeUndefined();
    });
});

describe("in-process (debug: true)", () => {

    it("loads the module here, keeps the manifest's ui, and runs handle directly", async () => {

        writeBoardPlugin();

        const loader = new PluginLoader(new PluginSandbox(WORKER_PATH), { inProcess: true });

        const { loaded, failures } = loader.load(dir);

        expect(failures).toEqual([]);
        expect(loaded[0].plugin.ui).toEqual({ label: "Board", entry: "ui/index.html", surface: "both" });

        const database = new PluginDatabase(path.join(dir, "plugins"));

        try {

            const db = database.for("board");

            await db.run("CREATE TABLE hits (n INTEGER)");
            await db.run("INSERT INTO hits VALUES (1), (2)");

            expect(await loaded[0].plugin.handle!({ name: "count" }, handleContext(db))).toEqual({ count: 2, payload: undefined });

        } finally {

            database.close();
        }
    });

    it("picks up an edit on the next load - the require cache is not in the way", async () => {

        writeBoardPlugin();

        const loader = new PluginLoader(new PluginSandbox(WORKER_PATH), { inProcess: true });

        expect(await loader.load(dir).loaded[0].plugin.handle!({ name: "nodb" }, handleContext())).toEqual({ hasDb: false });

        fs.writeFileSync(path.join(dir, "boardV1", "index.js"), `
            module.exports = {
                async execute() { return { success: true }; },
                async handle() { return { edited: true }; }
            };
        `);

        expect(await loader.load(dir).loaded[0].plugin.handle!({ name: "nodb" }, handleContext())).toEqual({ edited: true });
    });
});

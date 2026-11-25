import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Plugin } from "../../../core/plugins/Plugin";
import { PluginDatabase } from "../../../core/plugins/PluginDatabase";
import { PluginHost } from "../../../core/plugins/PluginHost";
import { PluginRegistry } from "../../../core/plugins/PluginRegistry";
import { Workflow } from "../../../core/models/workflowTypes";
import { answerPluginRequest, pluginApps, pluginRefsOf } from "../PluginAppHost";

let dir: string;

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-app-host-"));
});

afterEach(() => {

    fs.rmSync(dir, { recursive: true, force: true });
});

const noop = async () => ({ success: true });

function hostWith(plugin: Plugin, folder?: string, database?: PluginDatabase) {

    const registry = new PluginRegistry();

    registry.register(plugin, "profile", folder && path.join(folder, "index.js"), folder);

    return new PluginHost(registry, database);
}

function writePage(files: Record<string, string>): string {

    const folder = path.join(dir, "boardV1");

    for (const [name, content] of Object.entries(files)) {

        fs.mkdirSync(path.dirname(path.join(folder, name)), { recursive: true });
        fs.writeFileSync(path.join(folder, name), content);
    }

    return folder;
}

const board: Plugin = { id: "board", version: "1", ui: { label: "Board", entry: "ui/index.html", surface: "both" }, execute: noop };

describe("pluginApps", () => {

    it("assembles the page: eesha client first, local scripts and styles inlined, every script nonced", () => {

        const folder = writePage({
            "ui/index.html": `<!doctype html><html><head><link rel="stylesheet" href="app.css"><title>B</title></head>`
                + `<body><script src="app.js"></script><script>inlineToo()</script></body></html>`,
            "ui/app.js": "console.log('app')",
            "ui/app.css": "body{color:red}"
        });

        const [app] = pluginApps(hostWith(board, folder), "N0NCE");

        expect(app).toMatchObject({ ref: "board@1", id: "board", label: "Board" });

        // The client comes before the plugin's own head content.
        expect(app.html.indexOf("window.eesha")).toBeLessThan(app.html.indexOf("<title>B</title>"));
        expect(app.html).toContain(`<script nonce="N0NCE">\nconsole.log('app')\n</script>`);
        expect(app.html).toContain("<style>\nbody{color:red}\n</style>");
        expect(app.html).toContain(`<script nonce="N0NCE">inlineToo()</script>`);
        expect(app.html).not.toMatch(/<script(?![^>]*nonce=)[^>]*>/);
    });

    it("leaves a note where a script or style pointed at the web or outside the folder", () => {

        const folder = writePage({
            "ui/index.html": `<script src="https://cdn.example.com/x.js"></script><script src="../../index.js"></script>`
        });

        const [app] = pluginApps(hostWith(board, folder), "N");

        expect(app.html).toContain("cannot load scripts by URL");
        expect(app.html).toContain("not found next to the page");
        expect(app.html).not.toContain("module.exports");
    });

    it("makes a page that says so when the entry is missing", () => {

        const folder = writePage({ "plugin.json": "{}" });

        const [app] = pluginApps(hostWith(board, folder), "N");

        expect(app.html).toContain("could not be read");
        expect(app.html).toContain("window.eesha");
    });

    it("lists nothing for a plugin without a ui", () => {

        expect(pluginApps(hostWith({ id: "plain", version: "1", execute: noop }, dir), "N")).toEqual([]);
    });

    it("given a set of refs, lists only the apps in it - and every app when given none", () => {

        const folder = writePage({ "ui/index.html": "<p>hi</p>" });

        const host = hostWith(board, folder);

        expect(pluginApps(host, "N", new Set(["board@1"])).map(app => app.ref)).toEqual(["board@1"]);
        expect(pluginApps(host, "N", new Set(["other@1"]))).toEqual([]);
        expect(pluginApps(host, "N", new Set())).toEqual([]);
        expect(pluginApps(host, "N", undefined).map(app => app.ref)).toEqual(["board@1"]);
    });

    it("assembles the shipped sample's page whole - its script and stylesheet are found by name", () => {

        const sample = path.join(__dirname, "fixtures", "greetV1");

        const greet: Plugin = { id: "greet", version: "1", ui: { label: "Greet app", entry: "ui/index.html", surface: "both" }, execute: noop };

        const [app] = pluginApps(hostWith(greet, sample), "N");

        // The script's own first line, inside a nonced tag - not a
        // `<script src=` left behind. (The sample's HTML comment also
        // spells `<script src="app.js">`, so that text is no signal.)
        expect(app.html).toMatch(/<script nonce="N">\s*\/\/ The page's own script/);
        expect(app.html).toContain("section { margin");
        expect(app.html).not.toContain("not found next to the page");
        expect(app.html).not.toMatch(/<script[^>]*\ssrc=["']app\.js["'][^>]*>\s*<\/script>/);
    });
});

describe("pluginRefsOf", () => {

    const task = (taskId: string, plugin?: string) => ({ taskId, name: taskId, needs: [], plugin, trigger: "auto" as const });

    it("collects the plugin of every task, across stages and the inline library, skipping pure composition tasks", () => {

        const workflow = {
            tasks: [task("a", "board@1"), task("b")],
            stages: [{ tasks: [task("c", "shell@1")] }, { tasks: [task("d", "board@1")] }]
        } as unknown as Workflow;

        expect([...pluginRefsOf(workflow)!].sort()).toEqual(["board@1", "shell@1"]);
    });

    it("is undefined without a definition, so the caller shows every app rather than none", () => {

        expect(pluginRefsOf(undefined)).toBeUndefined();
    });
});

describe("answerPluginRequest", () => {

    const deps = (run = async () => undefined) => ({ cwd: dir, root: dir, run });

    it("answers a call with what handle returned", async () => {

        const host = hostWith({ ...board, handle: async request => ({ got: request.payload }) }, dir);

        expect(await answerPluginRequest({ id: 7, ref: "board@1", kind: "call", name: "x", payload: [1] }, host, undefined, deps()))
            .toEqual({ id: 7, ok: true, value: { got: [1] } });
    });

    it("answers a db request against the plugin's own file, with rowids as plain numbers", async () => {

        const database = new PluginDatabase(path.join(dir, "plugins"));

        try {

            const host = hostWith(board, dir, database);

            await answerPluginRequest({ id: 1, ref: "board@1", kind: "db", op: "run", sql: "CREATE TABLE t (v TEXT)" }, host, database, deps());

            const inserted = await answerPluginRequest(
                { id: 2, ref: "board@1", kind: "db", op: "run", sql: "INSERT INTO t VALUES (?)", params: ["a"] }, host, database, deps());

            expect(inserted).toEqual({ id: 2, ok: true, value: { changes: 1, lastInsertRowid: 1 } });

            expect(await answerPluginRequest({ id: 3, ref: "board@1", kind: "db", op: "all", sql: "SELECT v FROM t" }, host, database, deps()))
                .toEqual({ id: 3, ok: true, value: [{ v: "a" }] });

        } finally {

            database.close();
        }
    });

    it("hands a run request to the panel, and reports its refusal", async () => {

        const host = hostWith(board, dir);

        const targets: (string | undefined)[] = [];

        expect(await answerPluginRequest({ id: 1, ref: "board@1", kind: "run", target: "greet" }, host, undefined,
            deps(async (target?: string) => { targets.push(target); })))
            .toEqual({ id: 1, ok: true, value: null });

        expect(targets).toEqual(["greet"]);

        expect(await answerPluginRequest({ id: 2, ref: "board@1", kind: "run" }, host, undefined,
            deps(async () => { throw new Error("not now"); })))
            .toEqual({ id: 2, ok: false, error: "not now" });
    });

    it("never throws - a failure is an answer the page can show", async () => {

        const host = hostWith(board, dir);

        expect(await answerPluginRequest({ id: 9, ref: "board@1", kind: "call", name: "x" }, host, undefined, deps()))
            .toEqual({ id: 9, ok: false, error: expect.stringContaining("has no 'handle") });

        expect(await answerPluginRequest({ id: 10, ref: "board@1", kind: "db", op: "all", sql: "SELECT 1" }, host, undefined, deps()))
            .toEqual({ id: 10, ok: false, error: expect.stringContaining("no plugin database") });
    });
});

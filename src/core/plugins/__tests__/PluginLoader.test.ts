import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PluginLoader, profilePluginsDirectory, workspacePluginsDirectory } from "../PluginLoader";
import { PluginRegistry } from "../PluginRegistry";
import { PluginSandbox } from "../sandbox/PluginSandbox";
import { WORKER_PATH } from "./sandboxHarness";

let dir: string;

const loader = new PluginLoader(new PluginSandbox(WORKER_PATH));

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-plugins-"));
});

afterEach(() => {

    fs.rmSync(dir, { recursive: true, force: true });
});

function writeTask(name: string, body: string): void {

    fs.writeFileSync(path.join(dir, name), body, "utf8");
}

const validTask = `
module.exports = {
    id: "greeter",
    version: "1",
    args: { name: { type: "string", required: true } },
    artifacts: ["greeting"],
    async execute(args, ctx) {
        ctx.log("hi " + args.name);
        return { success: true, artifacts: { greeting: "hi " + args.name } };
    }
};
`;

describe("plugins directories", () => {

    it("sits beside tasks.yml under the user's .eesha folder", () => {

        expect(profilePluginsDirectory()).toBe(path.join(os.homedir(), ".eesha", "plugins"));
    });

    it("has the same shape in a workspace, so a plugin can be committed beside the workflow using it", () => {

        expect(workspacePluginsDirectory(path.join("repo", "api")))
            .toBe(path.join("repo", "api", ".eesha", "plugins"));
    });
});

describe("PluginLoader", () => {

    it("resolves empty for a directory that does not exist - the normal case, not an error", () => {

        const result = loader.load(path.join(dir, "nope"));

        expect(result.loaded).toEqual([]);
        expect(result.failures).toEqual([]);
    });

    it("loads a single-file plugin", () => {

        writeTask("greeter.js", validTask);

        const result = loader.load(dir);

        expect(result.failures).toEqual([]);
        expect(result.loaded).toHaveLength(1);
        expect(result.loaded[0].plugin.id).toBe("greeter");
        expect(result.loaded[0].plugin.version).toBe("1");
    });

    it("loads a folder plugin via index.js", () => {

        fs.mkdirSync(path.join(dir, "greeter"));
        fs.writeFileSync(path.join(dir, "greeter", "index.js"), validTask, "utf8");

        const result = loader.load(dir);

        expect(result.loaded).toHaveLength(1);
        expect(result.loaded[0].plugin.id).toBe("greeter");
    });

    it("honours a folder plugin's package.json main", () => {

        fs.mkdirSync(path.join(dir, "greeter"));
        fs.writeFileSync(path.join(dir, "greeter", "package.json"), '{"main":"src/plugin.js"}', "utf8");
        fs.mkdirSync(path.join(dir, "greeter", "src"));
        fs.writeFileSync(path.join(dir, "greeter", "src", "plugin.js"), validTask, "utf8");

        expect(loader.load(dir).loaded).toHaveLength(1);
    });

    it("accepts an ES-module-style default export", () => {

        writeTask("greeter.js", `
            exports.default = {
                id: "greeter",
                version: "1",
                async execute() { return { success: true }; }
            };
        `);

        expect(loader.load(dir).loaded).toHaveLength(1);
    });

    it("actually runs the loaded plugin", async () => {

        writeTask("greeter.js", validTask);

        const { plugin } = loader.load(dir).loaded[0];

        const logged: string[] = [];

        // A real-shaped context: the plugin runs in another
        // process, and everything it can reach comes from here.
        const result = await plugin.execute(
            { name: "World" },
            {
                runId: "run-1",
                taskId: "plugin#0",
                attempt: 1,
                cwd: dir,
                root: dir,
                env: {},
                session: [],
                secret: () => undefined,
                log: (text: string) => logged.push(text),
                cancelled: false,
                onCancel: () => undefined
            } as never
        );

        expect(result.success).toBe(true);
        expect(result.artifacts).toEqual({ greeting: "hi World" });
        expect(logged).toEqual(["hi World"]);
    });

    describe("validation", () => {

        it("reports a plugin with no id", () => {

            writeTask("bad.js", 'module.exports = { version: "1", execute() {} };');

            const result = loader.load(dir);

            expect(result.loaded).toEqual([]);
            expect(result.failures[0].message).toContain("id");
        });

        it("reports an id that is not lowercase-kebab", () => {

            writeTask("bad.js", 'module.exports = { id: "My Plugin", version: "1", execute() {} };');

            expect(loader.load(dir).failures[0].message).toContain("id");
        });

        it("reports a non-numeric version", () => {

            writeTask("bad.js", 'module.exports = { id: "ok", version: "1.0", execute() {} };');

            expect(loader.load(dir).failures[0].message).toContain("version");
        });

        it("reports a missing execute function", () => {

            writeTask("bad.js", 'module.exports = { id: "ok", version: "1" };');

            expect(loader.load(dir).failures[0].message).toContain("execute");
        });

        it("reports a plugin that throws while being loaded, without losing the others", () => {

            writeTask("bad.js", 'throw new Error("kaboom");');
            writeTask("greeter.js", validTask);

            const result = loader.load(dir);

            expect(result.loaded).toHaveLength(1);
            expect(result.failures).toHaveLength(1);
            expect(result.failures[0].message).toContain("kaboom");
        });

        it("ignores non-JavaScript files", () => {

            writeTask("notes.txt", "not a plugin");
            writeTask("greeter.js", validTask);

            const result = loader.load(dir);

            expect(result.loaded).toHaveLength(1);
            expect(result.failures).toEqual([]);
        });
    });

    describe("loadInto", () => {

        it("records the scope it was loaded from, and where it came from", () => {

            writeTask("greeter.js", validTask);

            const registry = new PluginRegistry();

            expect(loader.loadInto(registry, dir, "workspace")).toEqual([]);

            const described = registry.describe({ id: "greeter", version: "1" });

            expect(described?.origin).toBe("workspace");
            expect(described?.sourcePath).toContain("greeter.js");
        });

        it("lets a workspace plugin shadow a profile one silently - that is the point of two scopes", () => {

            writeTask("greeter.js", validTask);

            const registry = new PluginRegistry();

            registry.register(
                { id: "greeter", version: "1", execute: async () => ({ success: true }) },
                "workspace"
            );

            expect(loader.loadInto(registry, dir, "profile")).toEqual([]);

            expect(registry.describe({ id: "greeter", version: "1" })?.origin).toBe("workspace");
        });

        it("still reports a profile plugin colliding with a bundled id - a builtin is never shadowed", () => {

            writeTask("greeter.js", validTask);

            const registry = new PluginRegistry();

            registry.register(
                { id: "greeter", version: "1", execute: async () => ({ success: true }) },
                "builtin"
            );

            expect(loader.loadInto(registry, dir, "profile")).toHaveLength(1);

            expect(registry.describe({ id: "greeter", version: "1" })?.origin).toBe("builtin");
        });

        it("reports a user plugin colliding with an already-registered id rather than replacing it", () => {

            writeTask("greeter.js", validTask);

            const registry = new PluginRegistry();

            registry.register(
                { id: "greeter", version: "1", execute: async () => ({ success: true }) },
                "builtin"
            );

            const failures = loader.loadInto(registry, dir);

            expect(failures).toHaveLength(1);
            expect(failures[0].message).toContain("greeter@1");
            expect(registry.describe({ id: "greeter", version: "1" })?.origin).toBe("builtin");
        });
    });
});

// A `plugin.json` declares what a plugin is and takes priority over
// any id/version the JavaScript itself exports.
describe("a folder plugin with a manifest", () => {

    /** A folder plugin: `plugin.json` beside an `index.js` that only implements. */
    function writeFolderTask(folder: string, manifest: unknown, implementation: string): void {

        const full = path.join(dir, folder);

        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, "plugin.json"), JSON.stringify(manifest), "utf8");
        fs.writeFileSync(path.join(full, "index.js"), implementation, "utf8");
    }

    const implementation = `
module.exports = {
    id: "ignored-by-the-manifest",
    version: "9",
    async execute(args, ctx) {
        return { success: true, artifacts: { greeting: "hi " + args.who } };
    }
};
`;

    const manifest = {
        id: "greeter",
        description: "From the manifest.",
        version: { major: 2, minor: 3, patch: 1 },
        args: [{ name: "who", type: "string", label: "Who", required: true }],
        artifacts: ["greeting"]
    };

    it("takes its id and version from plugin.json, not from the JavaScript", () => {

        writeFolderTask("greeterV2", manifest, implementation);

        const [loaded] = loader.load(dir).loaded;

        expect(loaded.plugin.id).toBe("greeter");
        expect(loaded.plugin.version).toBe("2");
    });

    it("resolves as id@major, so 2.3.1 is still 'uses: greeter@2'", () => {

        writeFolderTask("greeterV2", manifest, implementation);

        const registry = new PluginRegistry();

        loader.loadInto(registry, dir);

        expect(registry.has({ id: "greeter", version: "2" })).toBe(true);
        expect(registry.keys()).toEqual(["greeter@2"]);
    });

    it("takes its declared args from the manifest", () => {

        writeFolderTask("greeterV2", manifest, implementation);

        const [loaded] = loader.load(dir).loaded;

        expect(Object.keys(loaded.plugin.args!)).toEqual(["who"]);
        expect(loaded.plugin.args!.who.required).toBe(true);
        expect(loaded.plugin.description).toBe("From the manifest.");
    });

    it("still runs the JavaScript, which is the only thing the manifest cannot contain", async () => {

        writeFolderTask("greeterV2", manifest, implementation);

        const [loaded] = loader.load(dir).loaded;

        const result = await loaded.plugin.execute({ who: "World" }, context());

        expect(result.artifacts).toEqual({ greeting: "hi World" });
    });

    it("reports a folder whose name disagrees with the manifest's major", () => {

        writeFolderTask("greeterV1", manifest, implementation);

        const [failure] = loader.load(dir).failures;

        expect(failure.message).toContain("greeterV1");
        expect(failure.message).toContain("greeterV2");
    });

    it("reports a malformed plugin.json instead of falling back to the JavaScript", () => {

        const full = path.join(dir, "greeterV2");

        fs.mkdirSync(full, { recursive: true });
        fs.writeFileSync(path.join(full, "plugin.json"), "{ not json", "utf8");
        fs.writeFileSync(path.join(full, "index.js"), implementation, "utf8");

        const result = loader.load(dir);

        expect(result.loaded).toEqual([]);
        expect(result.failures[0].message).toContain("not valid JSON");
    });

    // A single file has no folder to hold a manifest, so it keeps
    // declaring itself in JavaScript. The right choice for something
    // self-contained.
    it("lets a loose .js plugin declare itself", () => {

        writeTask("greet.js", validTask);

        const [loaded] = loader.load(dir).loaded;

        expect(loaded.plugin.id).toBe("greeter");
        expect(loaded.plugin.version).toBe("1");
    });
});

function context() {

    return {
        runId: "r", taskId: "s", attempt: 1, cwd: dir, root: dir, env: {}, session: [],
        secret: () => undefined,
        log: () => undefined,
        reportSession: () => undefined,
        ask: async () => { throw new Error("not wired"); },
        cancelled: false,
        onCancel: () => undefined
    };
}

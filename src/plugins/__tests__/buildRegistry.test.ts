import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRegistry, PluginRoot } from "..";
import { WORKER_PATH } from "../../core/plugins/__tests__/sandboxHarness";

// Which folders user plugins are loaded from, given that a
// workspace can have more than one. This is about the folder
// set, not about what a plugin does once loaded - that is
// `PluginLoader`'s file.

let root: string;

const plugin = (id: string) => `
module.exports = {
    id: "${id}",
    version: "1",
    args: {},
    outputs: [],
    async execute() { return { success: true }; }
};
`;

/** Writes a plugin into `<folder>/.eesha/plugins`. */
function write(folder: string, id: string): void {

    const directory = path.join(folder, ".eesha", "plugins");

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${id}.js`), plugin(id), "utf8");
}

const build = (roots: PluginRoot[]) => buildRegistry(WORKER_PATH, roots);

const ids = (keys: string[]) =>
    keys.filter(key => !["ado-comment@1", "ado-release@1", "ai@1", "file@1", "http@1", "mcp@1", "pwsh@1", "shell@1"].includes(key));

beforeEach(() => {

    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-registry-")));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("buildRegistry across scopes", () => {

    it("loads plugins from every open folder, not just the first", () => {

        const api = path.join(root, "api");
        const web = path.join(root, "web");

        write(api, "api-deploy");
        write(web, "web-deploy");

        const { registry, failures } = build([
            { path: api, origin: "folder" },
            { path: web, origin: "folder" }
        ]);

        expect(failures).toEqual([]);
        expect(ids(registry.keys())).toEqual(["api-deploy@1", "web-deploy@1"]);
    });

    it("loads the workspace-level folder alongside them", () => {

        const api = path.join(root, "api");

        write(api, "api-deploy");
        write(root, "team-deploy");

        const { registry } = build([
            { path: api, origin: "folder" },
            { path: root, origin: "workspace" }
        ]);

        expect(ids(registry.keys())).toEqual(["api-deploy@1", "team-deploy@1"]);
        expect(registry.describe({ id: "team-deploy", version: "1" })?.origin).toBe("workspace");
    });

    it("lets a folder plugin shadow the workspace's copy of the same id, silently", () => {

        const api = path.join(root, "api");

        write(api, "deploy");
        write(root, "deploy");

        const { registry, failures } = build([
            { path: api, origin: "folder" },
            { path: root, origin: "workspace" }
        ]);

        expect(failures).toEqual([]);
        expect(registry.describe({ id: "deploy", version: "1" })?.origin).toBe("folder");
    });

    /**
     * The workspace root is often one of the open folders. Loading its
     * plugins folder twice would register every id against itself and
     * report a clash for each - a failure list about nothing.
     */
    it("reads a folder named as both a folder and the workspace root only once", () => {

        write(root, "deploy");

        const { registry, failures } = build([
            { path: root, origin: "folder" },
            { path: root, origin: "workspace" }
        ]);

        expect(failures).toEqual([]);
        expect(ids(registry.keys())).toEqual(["deploy@1"]);
        expect(registry.describe({ id: "deploy", version: "1" })?.origin).toBe("folder");
    });

    it("still reports two open folders declaring one id - neither is narrower", () => {

        const api = path.join(root, "api");
        const web = path.join(root, "web");

        write(api, "deploy");
        write(web, "deploy");

        expect(build([
            { path: api, origin: "folder" },
            { path: web, origin: "folder" }
        ]).failures).toHaveLength(1);
    });

    it("has only bundled plugins when nothing is open", () => {

        const { registry, failures } = build([]);

        expect(failures).toEqual([]);
        expect(ids(registry.keys())).toEqual([]);
    });

    // A bundled plugin's code is in the bundle, but its page is a file:
    // the registry needs the folder to show the tab at all.
    it("gives a bundled plugin that ships a tab its page folder under builtinAppsRoot", () => {

        const withRoot = buildRegistry(WORKER_PATH, [], undefined, undefined, { builtinAppsRoot: "C:/app/resources/plugins" });

        const app = withRoot.registry.apps().find(candidate => candidate.ref === "ado-release@1");

        expect(app?.folder).toBe(path.join("C:/app/resources/plugins", "ado-releaseV1"));
        expect(app?.plugin.ui?.entry).toBe("ui/index.html");

        // Without the root, as in a test, the bundled tab is not offered.
        expect(build([]).registry.apps().some(candidate => candidate.ref === "ado-release@1")).toBe(false);
    });
});

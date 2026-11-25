import * as fs from "fs";
import * as path from "path";
import { Plugin } from "./Plugin";
import { isPluginId } from "./PluginRef";
import { PluginManifest, PluginManifestError, pluginFromManifest } from "./PluginManifest";
import { PluginOrigin, PluginRegistry } from "./PluginRegistry";
import { PLUGINS_SUBDIR, WORKFLOWS_DIR } from "../loader/constants";
import { profilePath } from "../loader/profilePaths";
import { PluginRoot, PluginSandbox } from "./sandbox/PluginSandbox";
import { SandboxedPlugin } from "./sandbox/SandboxedPlugin";

/** Where the profile's plugins live: `~/.eesha/plugins`. */
export function profilePluginsDirectory(): string {

    return profilePath(PLUGINS_SUBDIR);
}

/**
 * Where a workspace's own plugins live:
 * `<workspace>/.eesha/plugins`. Committed to the repository,
 * so a plugin arrives on a teammate's machine with the workflow.
 */
export function workspacePluginsDirectory(workspacePath: string): string {

    return path.join(workspacePath, WORKFLOWS_DIR, PLUGINS_SUBDIR);
}

export interface LoadedPlugin {

    plugin: Plugin;

    sourcePath: string;

    /** The plugin's own folder - absent for a loose `.js` file. */
    folder?: string;
}

export interface PluginLoadFailure {

    sourcePath: string;

    message: string;
}

export interface PluginLoadResult {

    loaded: LoadedPlugin[];

    /** Reported rather than thrown - one broken plugin must not stop the others. */
    failures: PluginLoadFailure[];
}

export interface PluginLoaderOptions {

    /**
     * Load user plugins into this process, like a bundled one, with no
     * sandbox at all. For the profile's `debug: true` - the person is
     * writing the plugin and does not want the sandbox between them and
     * their own code. Off, every user plugin runs in a worker.
     */
    inProcess?: boolean;
}

/**
 * Loads plugins a user has written in plain JavaScript.
 *
 * Two layouts: a single `my-plugin.js`, or a `my-plugin/` folder with an
 * `index.js` (or whatever its `package.json` names as `main`).
 *
 * Nothing is downloaded or verified. A plugin here has the same trust
 * as a `run:` task in the user's own `tasks.yml`.
 */
export class PluginLoader {

    /**
     * @param sandbox Where user plugin code runs, unless
     * {@link PluginLoaderOptions.inProcess} says otherwise.
     */
    constructor(
        private readonly sandbox: PluginSandbox,
        private readonly options: PluginLoaderOptions = {}
    ) {}

    /** Loads every plugin in a directory. A missing directory is the normal case, not an error. */
    public load(directory: string): PluginLoadResult {

        const result: PluginLoadResult = { loaded: [], failures: [] };

        let entries: fs.Dirent[];

        try {

            entries = fs.readdirSync(directory, { withFileTypes: true });

        } catch {

            return result;
        }

        for (const entry of entries) {

            const entryPath = path.join(directory, entry.name);

            const modulePath = entry.isDirectory()
                ? this.entryPointOf(entryPath)
                : this.isJavaScript(entry.name) ? entryPath : undefined;

            if (!modulePath)
                continue;

            // The entry, not the entry point. A folder plugin owns its
            // whole folder even when `main` points inside it; a loose
            // file owns only itself, never the folder it shares.
            const root: PluginRoot = entry.isDirectory()
                ? { path: entryPath, kind: "directory" }
                : { path: entryPath, kind: "file" };

            try {

                result.loaded.push({
                    plugin: this.options.inProcess ? this.loadInProcess(modulePath, root) : this.loadOne(modulePath, root),
                    sourcePath: modulePath,
                    folder: root.kind === "directory" ? root.path : undefined
                });

            } catch (error) {

                result.failures.push({
                    sourcePath: modulePath,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return result;
    }

    /**
     * Loads a directory's plugins straight into a registry, returning
     * whatever failed so a caller can surface it.
     *
     * @param origin which scope this directory is. It decides how a
     * clash resolves: a profile plugin shadowed by a workspace one is
     * silently skipped, anything else is a reported failure - see
     * {@link PluginRegistry.register}.
     */
    public loadInto(
        registry: PluginRegistry,
        directory: string,
        origin: PluginOrigin = "profile"
    ): PluginLoadFailure[] {

        const result = this.load(directory);

        const failures = [...result.failures];

        for (const { plugin, sourcePath, folder } of result.loaded) {

            try {

                registry.register(plugin, origin, sourcePath, folder);

            } catch (error) {

                failures.push({
                    sourcePath,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }

        return failures;
    }

    /**
     * Reads a plugin's declaration. The module is evaluated to read its
     * exports, but inside the sandbox; what crosses back is plain JSON.
     * Each call is a fresh process, so there is no module cache to clear.
     */
    private loadOne(modulePath: string, root: PluginRoot): Plugin {

        const described = this.sandbox.describe(modulePath, root);

        const manifest = root.kind === "directory" ? this.manifestIn(root.path) : undefined;

        // The manifest wins where it speaks, because it is the file that
        // looks authoritative.
        if (manifest)
            return new SandboxedPlugin(
                { ...described, ...this.describedFrom(manifest, path.basename(root.path)) },
                modulePath,
                root,
                this.sandbox);

        this.validate(described, modulePath);

        return new SandboxedPlugin(described, modulePath, root, this.sandbox);
    }

    /**
     * The debug path: the module is required here, and runs here. The
     * require cache is cleared for everything under the plugin's root
     * first, so Reload Plugins picks up an edit rather than the copy
     * Node kept from last time.
     */
    private loadInProcess(modulePath: string, root: PluginRoot): Plugin {

        for (const cached of Object.keys(require.cache))
            if (inside(root, cached))
                delete require.cache[cached];

        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require(modulePath);

        const candidate = (loaded?.default ?? loaded) as Partial<Plugin>;

        if (!candidate || typeof candidate !== "object")
            throw new Error(`${path.basename(modulePath)} did not export a plugin object.`);

        if (typeof candidate.execute !== "function")
            throw new Error(`${path.basename(modulePath)} must export an 'execute(args, ctx)' function.`);

        const manifest = root.kind === "directory" ? this.manifestIn(root.path) : undefined;

        if (manifest)
            return pluginFromManifest(
                manifest,
                candidate.execute.bind(candidate),
                path.basename(root.path),
                typeof candidate.handle === "function" ? candidate.handle.bind(candidate) : undefined);

        this.validate(candidate, modulePath);

        return candidate as Plugin;
    }

    /** A folder plugin's `plugin.json`, when it has one. */
    private manifestIn(folder: string): PluginManifest | undefined {

        const file = path.join(folder, "plugin.json");

        if (!fs.existsSync(file))
            return undefined;

        try {

            return JSON.parse(fs.readFileSync(file, "utf8")) as PluginManifest;

        } catch (error) {

            throw new PluginManifestError(
                `plugin.json in '${path.basename(folder)}' is not valid JSON: ` +
                `${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * The manifest's declarations, in the shape a description carries.
     * Routed through {@link pluginFromManifest} so a user's manifest is
     * validated by the same rules as a bundled one, folder check included.
     */
    private describedFrom(manifest: PluginManifest, folder: string) {

        const declared = pluginFromManifest(manifest, noExecute, folder);

        return {
            id: declared.id,
            version: declared.version,
            description: declared.description,
            args: declared.args,
            artifacts: declared.artifacts,
            artifactsFrom: declared.artifactsFrom,
            secrets: declared.secrets,
            secretsFrom: declared.secretsFrom,
            // The manifest's when it has one, the module's otherwise.
            ...(declared.ui ? { ui: declared.ui } : {})
        };
    }

    /** Checks the shape a plugin must have before it is trusted to run. */
    private validate(candidate: Partial<Plugin>, modulePath: string): void {

        const where = path.basename(modulePath);

        if (!candidate || typeof candidate !== "object")
            throw new Error(`${where} did not export a plugin object.`);

        if (!isPluginId(candidate.id))
            throw new Error(`${where} must export an 'id' of lowercase letters, digits and hyphens.`);

        if (typeof candidate.version !== "string" || !/^[0-9]+$/.test(candidate.version))
            throw new Error(`${where} must export a 'version' that is a whole number, as a string (e.g. "1").`);

        // `execute` is not checked here: a function cannot cross the
        // process boundary. The worker refuses to describe a module that
        // has none.
    }

    private entryPointOf(directory: string): string | undefined {

        const manifest = path.join(directory, "package.json");

        if (fs.existsSync(manifest)) {

            try {

                const main = JSON.parse(fs.readFileSync(manifest, "utf8")).main;

                if (typeof main === "string") {

                    const resolved = path.join(directory, main);

                    if (fs.existsSync(resolved))
                        return resolved;
                }

            } catch {

                // A malformed package.json falls through to index.js.
            }
        }

        const index = path.join(directory, "index.js");

        return fs.existsSync(index) ? index : undefined;
    }

    private isJavaScript(name: string): boolean {

        return (name.endsWith(".js") || name.endsWith(".cjs")) && !name.startsWith(".");
    }

}

/** Whether a file is the plugin's own root, or under it. */
function inside(root: PluginRoot, file: string): boolean {

    if (root.kind === "file")
        return path.resolve(file) === path.resolve(root.path);

    const relative = path.relative(root.path, file);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Stands in for a plugin's `execute` while only its declarations are
 * read. If this is ever called, something has skipped the sandbox.
 */
const noExecute: Plugin["execute"] = async () => {

    throw new Error("A plugin's declarations were run as its implementation.");
};

import adoCommentManifest from "./ado-commentV1/plugin.json";
import adoReleaseManifest from "./ado-releaseV1/plugin.json";
import fileManifest from "./fileV1/plugin.json";
import httpManifest from "./httpV1/plugin.json";
import mcpManifest from "./mcpV1/plugin.json";
import pwshManifest from "./pwshV1/plugin.json";
import shellManifest from "./shellV1/plugin.json";
import { execute as adoCommentExecute } from "./ado-commentV1";
import { execute as adoReleaseExecute, handle as adoReleaseHandle } from "./ado-releaseV1";
import { execute as fileExecute } from "./fileV1";
import { execute as httpExecute } from "./httpV1";
import { McpPluginDeps, createExecute as mcpExecute } from "./mcpV1";
import { execute as pwshExecute } from "./pwshV1";
import { execute as shellExecute } from "./shellV1";

import { AgentPluginDeps, agentPlugin, agentRuntime } from "../core/agent";
import { Plugin } from "../core/plugins/Plugin";
import { PluginLoader, profilePluginsDirectory, workspacePluginsDirectory } from "../core/plugins/PluginLoader";
import { PluginLoadFailure } from "../core/plugins/PluginLoader";
import { PluginManifest, pluginFromManifest } from "../core/plugins/PluginManifest";
import { PluginOrigin, PluginRegistry } from "../core/plugins/PluginRegistry";
import { PluginSandbox } from "../core/plugins/sandbox/PluginSandbox";
import * as path from "path";

/**
 * Every plugin shipped with Eesha Code.
 *
 * Their manifests are the same `plugin.json` a user writes, read from
 * the same `<id>V<major>` folders. Only the delivery differs: these are
 * compiled into Eesha Code rather than loaded from disk.
 *
 * `http@1` and `mcp@1` reach any endpoint or MCP server through one
 * task, which keeps this list from growing a plugin per vendor.
 * `ado-comment@1` is the exception: a hand-written plugin still wins
 * when the failure has to name a variable.
 *
 * `ai@1` lives in `core/agent`, because a conversation people join is
 * owned by the engine, not a function call. It is registered whether or
 * not a provider is available, so a missing sign-in does not read as
 * "No plugin found for 'ai@1'".
 *
 * @param mcp where the workspace's `settings.json` lives. Defaulted to
 *            nothing, so a caller with no workspace still gets the
 *            plugin, which then fails saying no server is declared.
 */
export function builtinPlugins(
    agent: AgentPluginDeps = agentRuntime(),
    mcp: McpPluginDeps = {}
): Plugin[] {

    return [
        // What every `run:` task desugars to. The engine itself spawns nothing.
        pluginFromManifest(shellManifest as PluginManifest, shellExecute as Plugin["execute"], "shellV1"),
        pluginFromManifest(pwshManifest as PluginManifest, pwshExecute as Plugin["execute"], "pwshV1"),
        pluginFromManifest(fileManifest as PluginManifest, fileExecute as unknown as Plugin["execute"], "fileV1"),
        pluginFromManifest(adoCommentManifest as PluginManifest, adoCommentExecute as unknown as Plugin["execute"], "ado-commentV1"),
        // Classic releases live on vsrm.dev.azure.com, which the ADO MCP
        // server does not reach. Ships a tab: the picker for a release
        // workflow, started with its choices as params.
        pluginFromManifest(
            adoReleaseManifest as PluginManifest,
            adoReleaseExecute as unknown as Plugin["execute"],
            "ado-releaseV1",
            adoReleaseHandle as unknown as Plugin["handle"]),
        pluginFromManifest(httpManifest as PluginManifest, httpExecute as unknown as Plugin["execute"], "httpV1"),
        pluginFromManifest(mcpManifest as PluginManifest, mcpExecute(mcp) as unknown as Plugin["execute"], "mcpV1"),
        agentPlugin(agent)
    ];
}

export interface RegistryBuildResult {

    registry: PluginRegistry;

    /** User plugins that could not be loaded, so a client can surface them. */
    failures: PluginLoadFailure[];

    /** Whether user plugins run in the sandbox. False only under the profile's `debug: true`. */
    sandboxed: boolean;
}

export interface RegistryBuildOptions {

    /**
     * `false` loads user plugins in-process with no sandbox, and tells
     * the panels to show plugin apps unsandboxed too. For `debug: true`
     * in the profile's settings.json - the person writing a plugin
     * does not want the sandbox between them and their own code.
     * Defaults to true.
     */
    sandboxed?: boolean;

    /**
     * Where the bundled plugins' pages live on disk - Eesha Code's
     * `resources/plugins`. A bundled plugin's code is compiled into
     * Eesha Code, but its `ui/index.html` is read as a file, so the
     * registry has to be told the folder. Absent (as in a test), no
     * bundled plugin shows a tab.
     */
    builtinAppsRoot?: string;
}

/**
 * One folder to load user plugins from, and the scope it stands for.
 *
 * `path` is the folder itself (a repository, or one folder of a
 * workspace), not its `.eesha/plugins`, which the engine derives.
 */
export interface PluginRoot {

    path: string;

    origin: Extract<PluginOrigin, "folder" | "workspace">;
}

/**
 * Builds the registry a run uses: the bundled plugins, then the
 * workspace's own, then the profile's.
 *
 * That order is the precedence. Builtins register first so a user
 * plugin can never take over a bundled id; the duplicate is reported as
 * a failure. Narrower scopes come before wider ones so a repository's
 * `deploy@1` wins over the workspace's and the profile's copies, which
 * are skipped silently.
 *
 * @param roots every folder to load user plugins from, with its scope.
 * Empty when nothing is open. Deduped by resolved path, so a workspace
 * root that is also an open folder is read once rather than reported as
 * a clash with itself.
 *
 * @param mcp see {@link builtinPlugins}.
 */
export function buildRegistry(
    workerPath: string,
    roots: readonly PluginRoot[] = [],
    agent?: AgentPluginDeps,
    mcp?: McpPluginDeps,
    options: RegistryBuildOptions = {}
): RegistryBuildResult {

    const registry = new PluginRegistry();

    const sandboxed = options.sandboxed !== false;

    // Bundled plugins run in-process. They ship with the engine and are
    // trusted; user plugins are arbitrary JavaScript and are sandboxed
    // unless the profile says `debug: true`.
    for (const plugin of builtinPlugins(agent, mcp))
        registry.register(
            plugin,
            "builtin",
            undefined,
            // The page folder, `<root>/<id>V<major>`, for a bundled plugin
            // that ships a tab - see RegistryBuildOptions.builtinAppsRoot.
            plugin.ui && options.builtinAppsRoot
                ? path.join(options.builtinAppsRoot, `${plugin.id}V${plugin.version}`)
                : undefined);

    const loader = new PluginLoader(new PluginSandbox(workerPath), { inProcess: !sandboxed });

    const seen = new Set<string>();

    const failures = [
        ...ordered(roots).flatMap(root => {

            const directory = workspacePluginsDirectory(root.path);

            if (seen.has(path.resolve(directory)))
                return [];

            seen.add(path.resolve(directory));

            return loader.loadInto(registry, directory, root.origin);
        }),
        ...loader.loadInto(registry, profilePluginsDirectory(), "profile")
    ];

    return { registry, failures, sandboxed };
}

/**
 * Roots narrowest-scope first, so the dedup above keeps the narrower
 * claim on a folder named twice.
 *
 * A stable sort, so folders keep the order the workspace declared them
 * in and two failure lists compare predictably.
 */
function ordered(roots: readonly PluginRoot[]): PluginRoot[] {

    const rank = (root: PluginRoot) => root.origin === "folder" ? 0 : 1;

    return [...roots].sort((left, right) => rank(left) - rank(right));
}

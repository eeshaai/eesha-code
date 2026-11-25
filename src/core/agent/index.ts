import manifest from "./aiV1/plugin.json";
import { Plugin } from "../plugins/Plugin";
import { PluginManifest, pluginFromManifest } from "../plugins/PluginManifest";
import { AgentProviders, ProviderDeps } from "./AgentProvider";
import { AgentSessions } from "./AgentSessions";
import { AgentPluginDeps, createExecute } from "./aiV1";
import { FAKE_RUNTIME, FakeProvider } from "./providers/FakeProvider";
import { loadEngineSettings } from "../settings/engineSettings";

export { AgentProviders } from "./AgentProvider";
export type { AgentProvider, AgentProviderFactory, ProviderDeps } from "./AgentProvider";
export { AgentSessions } from "./AgentSessions";
export type { HoldPolicy, LiveSession } from "./AgentSessions";
export { AskDesk, askText, describeDuration, describeEvent, isMutatingTool } from "./AgentSession";
export type { AgentEventLine } from "./AgentSession";
export type {
    AgentAttachment,
    AgentEvent,
    AgentEventKind,
    AskHook,
    AskRequest,
    DeltaChannel,
    PendingAsk,
    AgentMessage,
    AgentSession,
    AgentSessionConfig,
    AgentSessionStatus
} from "./AgentSession";

/**
 * The agent half of the engine: sessions and providers, both of which
 * outlive a task. The task surface is `uses: ai@1`; which vendor runs
 * it is that task's `provider:` argument.
 */

/**
 * `ai@1`, ready to register.
 *
 * Register it even when no provider can be built. Otherwise a missing
 * sign-in reads as "No plugin found" - a typo in the workflow rather
 * than the real problem.
 */
export function agentPlugin(deps: AgentPluginDeps): Plugin {

    return pluginFromManifest(manifest as PluginManifest, createExecute(deps) as never, "aiV1");
}

/**
 * The providers the engine ships with. Each is a factory built on first
 * use, so a run that never touches an agent never loads an SDK.
 */
export function coreProviders(deps: ProviderDeps = {}): AgentProviders {

    const providers = new AgentProviders(deps);

    providers.register("ghcp", supplied => {

        // `require`, not `import()`: under this project's module
        // resolution `import()` demands a `.js` specifier no file on
        // disk has. Deferred so the SDK, `koffi` and the CLI are only
        // loaded when a task needs them.
        const { CopilotProvider } =
            require("./providers/CopilotProvider") as typeof import("./providers/CopilotProvider");

        return new CopilotProvider(supplied);
    });

    providers.register("claude", supplied => {

        // Same `require` for the same reason. The provider's own SDK
        // import is a dynamic `import()` inside `createSession` because
        // the package is ESM-only.
        const { ClaudeProvider } =
            require("./providers/ClaudeProvider") as typeof import("./providers/ClaudeProvider");

        return new ClaudeProvider(supplied);
    });

    // The fake runtime: no model, no cost, for tests and for trying a
    // flow by hand. Always buildable; offered in the pickers only when
    // the `fakeRuntime` flag is on (see `offeredRuntimes`). Imported at
    // the top, not required later: it loads no SDK.
    providers.register(FAKE_RUNTIME, supplied => new FakeProvider(undefined, supplied));

    /*
     * Every other id is a possible `ai.acpAgents.<id>` in settings.json.
     * `AgentProviders.get` tries a static factory first, so `ghcp` and
     * `claude` are never shadowed.
     *
     * Settings are read per call, not once at startup: the file can
     * change while the engine runs. A miss returns `undefined` so
     * `AgentProviders` can raise its own "not registered" error.
     */
    providers.registerFallback(async (id, supplied) => {

        const settings = await loadEngineSettings(supplied.workspaceFolder?.());

        if (!settings.ai.acpAgents[id])
            return undefined;

        const { AcpProvider } =
            require("./providers/AcpProvider") as typeof import("./providers/AcpProvider");

        return new AcpProvider(id, supplied);
    });

    return providers;
}

/**
 * Everything the agent plugin needs, with defaults.
 *
 * `provider` is the fallback for a direct caller that names none. The
 * manifest defaults it too, with the same id.
 */
export function agentRuntime(
    providers: AgentProviders = new AgentProviders(),
    sessions: AgentSessions = new AgentSessions()
): AgentPluginDeps {

    return { providers, sessions, provider: "ghcp" };
}

export type { AgentPluginDeps } from "./aiV1";

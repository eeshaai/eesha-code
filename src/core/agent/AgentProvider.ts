import { AgentEvent, AgentSession, AgentSessionConfig } from "./AgentSession";
import type { Spend } from "../models/run";
import type { PermissionGate } from "./permissions/gate";

/**
 * Who can start a session - a vendor's SDK, behind the engine's own
 * shape.
 *
 * Mainly a test seam: the engine's tests register a fake here and run
 * with no SDK, no CLI, no credentials and no network. Both real vendors
 * live in this package, so the interface can be the union of what they
 * do, and {@link AgentEvent}'s pass-through means it never has to be
 * widened for a new event.
 */
export interface AgentProvider {

    createSession(config: AgentSessionConfig): Promise<AgentSession>;

    /**
     * What this provider will accept as `model:`, for a surface that
     * offers a choice rather than a free-text box.
     *
     * Optional, and undefined is a real answer: a provider whose vendor
     * publishes no catalog says nothing, and `model:` stays free text
     * the engine passes through.
     *
     * Used for completion only, so it must be cheap and must fail
     * quietly - a catalogue that cannot be fetched is a missing
     * suggestion, never a broken page.
     */
    models?(): Promise<ModelChoice[] | undefined>;

    /**
     * The runtime's own built-in tools - the ones a tool picker can turn
     * off. MCP tools are not in it; those follow the MCP servers.
     *
     * Optional and cheap like {@link models}: a provider that cannot say
     * answers undefined, and a surface then offers no picker.
     */
    tools?(): Promise<ToolChoice[] | undefined>;

    /**
     * The agent's own modes (Kiro v3's Default, Spec, Plan and the rest),
     * and which one a new session starts in - for the compose box's mode
     * picker. Optional and cheap like {@link models}: undefined means the
     * agent has no modes, and no picker is shown.
     */
    modes?(): Promise<ModeList | undefined>;
}

/** What {@link AgentProvider.modes} answers. */
export interface ModeList {

    /** The mode a new session starts in, when the agent said. */
    current?: string;

    modes: ModeChoice[];
}

/** One mode an agent offers. */
export interface ModeChoice {

    /** What goes to the agent to switch to it. */
    id: string;

    name?: string;

    description?: string;
}

/** One built-in tool a provider can switch off. */
export interface ToolChoice {

    /** The runtime's own name for it - what an allow-list names. */
    id: string;

    description?: string;
}

/** One model a provider will accept, as much as the vendor says about it. */
export interface ModelChoice {

    /** What goes in `model:`. */
    id: string;

    /** The vendor's display name, when it has one. */
    name?: string;

    /**
     * The `reasoningEffort` values this model takes, when it takes any.
     *
     * Effort is only legal on a model whose capabilities report it, and
     * `auto` does not - so a surface can offer only real pairs instead
     * of letting the CLI reject one later.
     */
    reasoningEfforts?: string[];

    /**
     * What one request on this model costs, as a multiple of the base
     * rate - 0 is free. Copilot's premium request multiplier, or Kiro
     * v3's credit rate. Other runtimes have no such number.
     */
    multiplier?: number;

    /**
     * The account cannot run this model - Copilot's model policy says
     * `disabled` (an org turned it off). Still listed, so the picker can
     * show it greyed out rather than leave people wondering where it went.
     */
    disabled?: boolean;

    /**
     * The effort levels the compose box's Effort picker offers for this
     * model, lowest first. Only a provider that applies the pick fills it
     * (claude, claude-cli) - see `AgentSessionConfig.effort`. Absent, no
     * picker is shown.
     */
    efforts?: string[];

    /**
     * What the model costs, as the runtime's own short text (`$5/$25` per
     * million tokens in and out, from claude-agent-acp) - shown beside the
     * name where a runtime has no {@link multiplier}.
     */
    price?: string;

    /**
     * Other names the runtime has for this same model - Claude's `opus`
     * or `default` for `claude-opus-5-5`, as they stood when the list
     * was fetched. A pick saved under one of these names still shows on this
     * model's row.
     */
    aliases?: string[];
}

/**
 * What a provider needs from the server that runs it.
 *
 * A credential comes from an environment variable or a CLI's own
 * login. The engine cannot decide which, so the server supplies it.
 */
export interface ProviderDeps {

    /**
     * A credential for this provider, or nothing.
     *
     * Never fatal on its own: a provider with no token falls back to
     * whatever sign-in the vendor's own CLI holds.
     */
    token?(): Promise<string | undefined>;

    /**
     * Every folder the person can see, beyond the one a task runs in.
     *
     * A session can have several folders. The task's `cwd:` is one of
     * them, and an agent confined to it cannot read the sibling service
     * the change is about.
     *
     * A function rather than a list, because a provider is built once
     * and folders are added and removed while it lives.
     */
    directories?(): string[];

    /**
     * The `resources` directory.
     *
     * A session may read what is in it and may not write there - see
     * `createJail`. The SDD grammar and built-in style prompts ship
     * from here, and a phase attaches them by path, so the agent must
     * be allowed to open it.
     *
     * Optional: SDD passes it, because phases attach files
     * from it. A chat does not need it and passes nothing.
     */
    resources?(): string | undefined;

    /**
     * The workspace directory - where `workspaceConfig`
     * (`<workspaceFolder>/.eesha`) and so the team's
     * `settings.json` live.
     *
     * Only the server knows which folder is open. Core loads and merges
     * the settings; the server only says where.
     *
     * A function for the same reason as {@link directories}.
     */
    workspaceFolder?(): string | undefined;

    /**
     * The permission check for one session this provider starts.
     * Without one, every provider uses its own permission handling.
     *
     * With a check, the provider asks it about every call: it decides
     * what runs, what is refused, and what shows a card. The folder
     * boundary still holds, as the check's own first question.
     *
     * Called once per session, when it starts, with the provider's id, the
     * folder the session works in and the conversation it belongs to
     * (`AgentSessionConfig.chat`), when the caller names one.
     */
    permissions?(provider: string, workingDirectory: string, chat?: string): PermissionGate | undefined;

    /**
     * MCP servers added to every session, beside the ones
     * settings.json declares - the connector tools.
     * Read when a session starts. One with the same name as a declared
     * server replaces it.
     *
     * `provider` is the runtime the session starts on.
     */
    mcpServers?(provider: string): Record<string, unknown>;

    /**
     * Environment values the program itself adds to the runtime's own
     * process for a session, on top of what the settings grant. Read when
     * a session starts. May throw with the reason a session on this
     * runtime cannot start now - the person has a choice to make first.
     *
     * Claude reads it today, built in or run as an ACP agent: Eesha Code
     * turns Claude's own memory off this way while its own memory is on.
     */
    sessionEnv?(provider: string): Record<string, string>;

    /**
     * The runtime's own tools to take away from a session, by the
     * runtime's own names (Kiro's `str_replace`) - the settings'
     * `eesha.runtimes.<id>.toolsOff`. Read when a session starts. A
     * runtime that can take a tool away does (Claude's blocked list,
     * Copilot's excluded list, Kiro v3 cannot); on an ACP runtime a call
     * to one of them that still asks permission is refused as well.
     */
    toolsOff?(provider: string): readonly string[];
}

export type AgentProviderFactory = (deps: ProviderDeps) => AgentProvider | Promise<AgentProvider>;

/**
 * A second way to answer `get(id)`, tried only when no factory was
 * registered under that id.
 *
 * An ACP agent's id comes from `settings.json` (`ai.acpAgents`), not
 * from a fixed list, so it cannot be `register`ed the way `ghcp` and
 * `claude` are. Returning `undefined` means "not mine" - `get` then
 * raises the same "not registered" error a missing static factory
 * would.
 */
export type AgentProviderFallback =
    (id: string, deps: ProviderDeps) => Promise<AgentProvider | undefined>;

/**
 * The providers this engine can run a session on, by id.
 *
 * Registration rather than construction, so a test can register a fake
 * under `ghcp` and the real factory - and the SDK module behind it - is
 * never loaded. Factories are resolved on first use, so a run whose
 * tasks never touch an agent never pays for one.
 */
export class AgentProviders {

    private readonly factories = new Map<string, AgentProviderFactory>();

    private readonly resolved = new Map<string, Promise<AgentProvider>>();

    private fallback?: AgentProviderFallback;

    constructor(private readonly deps: ProviderDeps = {}) { }

    register(id: string, factory: AgentProviderFactory): void {

        this.factories.set(id, factory);
    }

    /**
     * Registers the one fallback consulted when `get` finds no factory
     * under an id - see {@link AgentProviderFallback}. A second call
     * replaces the first; this build only ever installs one.
     */
    registerFallback(fallback: AgentProviderFallback): void {

        this.fallback = fallback;
    }

    has(id: string): boolean {

        return this.factories.has(id);
    }

    /**
     * The extra root folders (see {@link ProviderDeps.directories}),
     * read fresh. Empty when none are given. `ai@1` looks for steering
     * files in these as well as the working folder.
     */
    directories(): string[] {

        return this.deps.directories?.() ?? [];
    }

    /**
     * The workspace folder (see {@link ProviderDeps.workspaceFolder}),
     * read fresh - where the team's `settings.json` lives. Undefined
     * when none is given.
     */
    workspaceFolder(): string | undefined {

        return this.deps.workspaceFolder?.();
    }

    /** Every registered id, for an error message that says what *is* available. */
    ids(): string[] {

        return [...this.factories.keys()].sort();
    }

    /**
     * The provider, built once and kept. A provider owns a connection;
     * building one per task would mean a CLI server per task.
     */
    async get(id: string): Promise<AgentProvider> {

        const existing = this.resolved.get(id);

        if (existing)
            return existing;

        const factory = this.factories.get(id);

        // Stored as the promise, not the result: two tasks starting at
        // once must share one provider, not race to build two.
        const building = (factory
            ? Promise.resolve(factory(this.deps))
            : this.buildFromFallback(id)).then(provider => stampingRuntime(id, provider));

        this.resolved.set(id, building);

        try {

            return await building;

        } catch (error) {

            // A failed build is not cached, so the next task can try
            // again - the usual cause is a credential not there yet.
            this.resolved.delete(id);

            throw error;
        }
    }

    private async buildFromFallback(id: string): Promise<AgentProvider> {

        const built = this.fallback ? await this.fallback(id, this.deps) : undefined;

        if (built)
            return built;

        throw new Error(
            `No agent provider '${id}' is registered.` +
            (this.ids().length ? ` Available: ${this.ids().join(", ")}.` : " None are registered."));
    }
}

/**
 * The provider, with every session it starts saying which runtime it
 * is: each charge, model split and account reading a session publishes
 * carries `runtime: id`.
 *
 * Done here, once, because this is where the id is known. A provider
 * does not know the name settings gave it - an ACP agent is whatever
 * its `ai.acpAgents` entry is called - and without the stamp, Copilot's
 * credits and Kiro's credits added up into one "credits" total.
 *
 * The provider itself is left untouched - the wrapper delegates to it -
 * and so is each session, but for its `on`, which stamps on the way
 * through. A figure that already names a runtime keeps it.
 */
export function stampingRuntime(id: string, provider: AgentProvider): AgentProvider {

    const wrapped: AgentProvider = Object.create(provider) as AgentProvider;

    wrapped.createSession = async config => {

        const session = await provider.createSession(config);

        const on = session.on.bind(session);

        session.on = handler => on(event => handler(stampEvent(id, event)));

        return session;
    };

    return wrapped;
}

/** One event with `runtime` on each of its figures - see {@link stampingRuntime}. Exported for tests. */
export function stampEvent(id: string, event: AgentEvent): AgentEvent {

    if (event.kind !== "notice" || (!event.cost && !event.models && !event.account))
        return event;

    const stamp = (spend: Spend): Spend => spend.runtime ? spend : { ...spend, runtime: id };

    return {
        ...event,
        ...(event.cost ? { cost: event.cost.map(stamp) } : {}),
        ...(event.models
            ? {
                models: event.models.map(model => ({
                    ...model,
                    runtime: model.runtime ?? id,
                    ...(model.cost ? { cost: model.cost.map(stamp) } : {})
                }))
            }
            : {}),
        ...(event.account ? { account: { ...event.account, runtime: event.account.runtime ?? id } } : {})
    };
}

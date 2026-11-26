import { AgentProvider, ModeList, ModelChoice, ProviderDeps, ToolChoice } from "../AgentProvider";
import { EnvService } from "../../env/envService";
import { cliBinary, requireCli } from "./claudeCli";
import { homeDirectory } from "../../runner/runContext";
import { loadEngineSettings } from "../../settings/engineSettings";
import { McpResolution, resolveMcpServers, withHostServers } from "./mcpConfig";
import { claudeWrites, createJail, engineDirectories, openJail } from "./pathJail";
import { projectMemory } from "./projectMemory";
import { normalizeMcpServers } from "./mcpServers";
import { ClaudeTotalsStore, fileTotalsStore } from "./claudeTotals";
import { CLAUDE_REFUSED_COMMANDS } from "./claudeCommands";
import { commandNameIn, commandsFrom, keepCommandList, offeredCommands, refusedCommandText } from "../commandListFile";
import { TaskBoard, isPlanTool, planFromTodos } from "../plan";
import { builtInTools, readClaudeTools, writeClaudeTools } from "./claudeTools";
import { redactSecret } from "./redactSecrets";
import { ClaudeAccountSource, claudeAccountNotice, readClaudeAccount } from "./claudeAccount";
import { lastAccount, rememberAccount } from "../accountCache";
import { targetSystemPrompt } from "./targetPrompt";
import type { AskPermission, ContextItem, ContextUsage, ModelSpend } from "../../models/run";
import { askCard, claudeCall, deniedText, gatePermission, UNANSWERED_NOTE, UNANSWERED_TEXT } from "../permissions";
import type { PermissionGate } from "../permissions";

/*
 * The SDK's types. The value import must stay dynamic (the package is
 * ESM-only and this file is bundled as CommonJS), but a type-only
 * import is erased before emit, so it can be static. Naming the real
 * module means a field the SDK renames is a build error here.
 */
import type {
    ModelInfo,
    Options,
    SDKMessage,
    SDKUserMessage,
    createSdkMcpServer,
    deleteSession,
    getSessionInfo,
    query,
    tool
} from "@anthropic-ai/claude-agent-sdk";
import {
    ASK_SERVER_NAME,
    ASK_SYSTEM_PROMPT,
    ASK_TOOL_DESCRIPTION,
    ASK_TOOL_FULL_NAME,
    ASK_TOOL_NAME,
    AskToolInput,
    askQuestions,
    askToolShape
} from "./askTool";
import {
    TIME_NOW_DESCRIPTION,
    TIME_NOW_TOOL_NAME,
    timeNow,
    timeToolShape,
    UTC_NOW_DESCRIPTION,
    UTC_NOW_TOOL_NAME,
    utcNow
} from "./timeTools";
import {
    CHECK_PLAN_DESCRIPTION,
    CHECK_PLAN_TOOL_NAME,
    checkPlan,
    checkPlanShape,
    markTaskDone,
    PlanToolInput,
    planToolShape,
    TASK_DONE_DESCRIPTION,
    TASK_DONE_TOOL_NAME
} from "./planTools";
import {
    answerSteering,
    STEERING_TOOL_NAME,
    steeringDescription,
    SteeringToolInput,
    steeringToolShape
} from "./steeringTool";
import {
    AgentEvent,
    AgentMessage,
    AgentSession,
    AgentSessionConfig,
    AgentSessionStatus,
    AskDesk,
    AskHook,
    allowedNotice,
    AskRequest,
    DELTA_INTERVAL_MS,
    DeltaChannel,
    PendingAsk,
    describeDuration,
    isAskTool
} from "../AgentSession";
import {
    LINE_LIMIT,
    VALUE_LIMIT,
    asText,
    clip,
    countOf,
    describeArguments,
    tokens,
    toolPath,
    toolTitle
} from "./describe";

/**
 * The picker's rows from the CLI's model list, each saved under the
 * exact model it runs (`claude-sonnet-5-5`), never under a short name.
 *
 * The CLI lists short names (`default`, `opus`, `sonnet`) beside exact
 * ids. A short name moves to a newer model when one comes out, and the
 * list is only fetched again on the refresh button - so a saved row
 * named "Sonnet 5" would go on running Sonnet 5.5. Each row carries the
 * exact id it stands for (`resolvedModel`), and that id is what is
 * kept: what the picker shows is then what runs.
 *
 * Rows that run the same model become one, where the first of them
 * stood, so `default` and `opus` are a single "Opus 5.5" row at the
 * top. Its name is the model's, not "Default (recommended)". The short
 * names go in `aliases`, so a pick or setting that names one still
 * finds its row. A CLI too old to send `resolvedModel` gives the short
 * names as they are.
 */
export function claudeModelChoices(rows: ModelInfo[]): ModelChoice[] {

    const choices: ModelChoice[] = [];

    // The `default` row, by the exact id it runs - its name says
    // "Default", not which model, so the model's own row names it.
    const unnamed = new Set<string>();

    for (const row of rows) {

        const id = row.resolvedModel?.trim() || row.value;
        const alias = row.value !== id ? row.value : undefined;
        const kept = choices.find(choice => choice.id === id);

        if (kept) {

            if (alias && !kept.aliases?.includes(alias))
                kept.aliases = [...kept.aliases ?? [], alias];

            if (unnamed.has(id) && row.value !== "default") {

                kept.name = row.displayName;
                unnamed.delete(id);
            }

            continue;
        }

        if (row.value === "default")
            unnamed.add(id);

        choices.push({
            id,
            name: row.displayName,

            // The Effort picker's levels - only where the model takes one.
            ...(row.supportsEffort && row.supportedEffortLevels?.length
                ? { efforts: [...row.supportedEffortLevels] }
                : {}),

            ...(alias ? { aliases: [alias] } : {})
        });
    }

    return choices;
}

/**
 * Anthropic's Claude, as an {@link AgentProvider}.
 * https://code.claude.com/docs/en/agent-sdk
 *
 * Two structural differences from {@link CopilotProvider}, both forced
 * by the SDK:
 *
 *   1. The SDK's value is imported dynamically, inside `createSession`.
 *      It ships ESM-only and this file is bundled as CommonJS, so a
 *      static import would be a build error. It also keeps the package
 *      out of agentless runs.
 *
 *   2. One `query()` per session, driven by a queue. The SDK has no
 *      session object: `query()` returns an async generator, and the
 *      conversation lives as long as the prompt iterable it was handed
 *      stays open. See {@link ClaudeAgentSession}. Streaming-input mode
 *      is required because `interrupt()` exists only there, and
 *      {@link AgentSession.abort} is in the contract.
 */
export class ClaudeProvider implements AgentProvider {

    constructor(private readonly deps: ProviderDeps = {}) { }

    /**
     * The modes the compose box offers - see {@link CLAUDE_MODES}. Fixed,
     * so nothing is started to ask.
     */
    public async modes(): Promise<ModeList | undefined> {

        return { current: "default", modes: CLAUDE_MODES.map(mode => ({ ...mode })) };
    }

    /**
     * The models this account can run, as the CLI reports them.
     *
     * The SDK answers `supportedModels()` off its start-up handshake,
     * which happens the moment `query()` is called - no prompt has to
     * be sent. So a query is opened with an input stream that yields
     * nothing until the list is in, then the process is aborted. One
     * CLI start per call, which is why this is only reached from a
     * surface offering a choice and cached there - never from a run.
     *
     * Fails quietly, like Copilot's: no CLI, not signed in, a changed
     * SDK - all mean "no list", and the picker then offers `auto`
     * alone rather than a broken panel.
     */
    public async models(): Promise<ModelChoice[] | undefined> {

        const settings = await loadEngineSettings(this.deps.workspaceFolder?.());

        // The same baseline the session child gets, so the CLI finds
        // its sign-in and PATH the same way. No task env here: nothing
        // is being run.
        const env = new EnvService({ allowed: settings.env.allowed, denied: settings.env.denied }).spawnEnvMasked();

        // Found the same way a session finds it. Left unset, the SDK
        // looks beside itself, where the package ships no CLI, and the
        // list would fail at once.
        const binary = cliBinary(env);

        if (!binary)
            return undefined;

        const { query } = await loadSdk();

        const abort = new AbortController();

        // Held open until the list is in. An input that ended at once
        // would end the CLI's input too, and it could exit before the
        // handshake finished.
        let release: () => void = () => { };
        const gate = new Promise<void>(resolve => { release = resolve; });

        async function* held(): AsyncGenerator<SDKUserMessage> {

            await gate;
        }

        const started = query({
            prompt: held(),
            options: {
                cwd: this.deps.workspaceFolder?.() ?? homeDirectory(),
                env,
                pathToClaudeCodeExecutable: binary,
                abortController: abort,

                // No settings files, as for a session: a repo's
                // `.claude/settings.json` could otherwise run its
                // start-up hooks just from opening the model picker.
                settingSources: []
            }
        });

        try {

            return claudeModelChoices(await started.supportedModels());

        } finally {

            release();
            abort.abort();
        }
    }

    /**
     * The built-in tools the last full-set session listed - see
     * `claudeTools.ts`. Nothing until one has run.
     */
    public async tools(): Promise<ToolChoice[] | undefined> {

        return readClaudeTools()?.map(id => ({ id }));
    }

    public async createSession(config: AgentSessionConfig): Promise<AgentSession> {

        /*
         * `deps.token()` is not used: it resolves a GitHub session, which
         * Claude cannot use. The vendor's own sign-in stands - whatever
         * `claude` is logged in as, or ANTHROPIC_API_KEY from the child's
         * environment. The SDK reports which on its `init` message as
         * `apiKeySource`, and that is logged.
         */

        // Read fresh per session, before anything is started: the file
        // can change while the provider lives, and a malformed one
        // should fail before any process is spawned.
        const settings = await loadEngineSettings(this.deps.workspaceFolder?.());

        // The only source of environment values here. It answers two
        // questions: what a `${{ env.NAME }}` may read (the gate), and
        // what the CLI child inherits (`spawnEnv`).
        const envs = new EnvService({
            allowed: settings.env.allowed,
            denied: settings.env.denied,
            taskEnv: config.env,
            allowedEnv: config.allowedEnv
        });

        /*
         * The child's whole environment: the spawn baseline plus granted
         * names, with task values on top (see `spawnEnv`).
         * ANTHROPIC_API_KEY only arrives if `env.allowed` grants it; the
         * CLI's own sign-in lives under the home directory, which the
         * baseline keeps.
         *
         * The SDK spawns a native binary. The binary itself
         * is found by {@link cliBinary} below and handed over as
         * `pathToClaudeCodeExecutable` - the SDK's own lookup only sees
         * the platform package beside itself, which the package does not
         * ship.
         *
         * Every granted value is registered with the masker before this
         * returns, so an echoed credential prints as `***` in the run
         * log. See `EnvService.spawnEnvMasked`.
         */
        const env = envs.spawnEnvMasked(config.registerSecret);

        // What the program adds itself - see `ProviderDeps.sessionEnv`.
        // Throws when a Claude session may not start yet.
        Object.assign(env as Record<string, string>, this.deps.sessionEnv?.("claude") ?? {});

        /*
         * `claudeAiConnectors`: the connectors of the claude.ai account
         * the CLI is signed in with (Gmail, Drive and the like). They are
         * not in settings.json, so no `mcp:` selection reaches them; the
         * CLI's own switch is this variable. Taken out of `extra` so it
         * never reaches the SDK as an unknown option. Absent, the CLI's
         * own default stands.
         */
        const extra = { ...(config.extra ?? {}) };

        if (typeof extra.claudeAiConnectors === "boolean")
            (env as Record<string, string>).ENABLE_CLAUDEAI_MCP_SERVERS = extra.claudeAiConnectors ? "true" : "false";

        delete extra.claudeAiConnectors;

        config = { ...config, extra };

        // Before the SDK is even loaded: its own failure for a missing
        // binary tells the user to reinstall a package they never
        // installed.
        const binary = cliBinary(env);

        requireCli(binary);

        const mcp = resolveMcpServers(withHostServers(settings.ai.mcpServers, this.deps.mcpServers?.("claude")), envs, config.mcp);

        const { query, deleteSession, createSdkMcpServer, tool, getSessionInfo } = await loadSdk();

        const abort = new AbortController();

        const queue = new MessageQueue();

        /*
         * Checked before anything starts, because the answer decides the
         * id below. Checked rather than attempted: `resume` naming a
         * missing transcript is reported by the SDK as a failed turn,
         * which would fail the phase. A miss starts a new conversation.
         */
        const resumeCheck: { resumed: boolean; reason?: string } = config.resume
            ? await resumable(getSessionInfo, config.resume, config.workingDirectory, log)
            : { resumed: false };

        const resumed = resumeCheck.resumed;

        // Our own id, unless a conversation is being resumed - then it
        // keeps the id it had (`forkSession` is off). Pinning it means
        // the id exists before the first message: `AgentSession.id` is
        // read immediately by ai@1's `reportSession`, and `delete()`
        // hands it to `deleteSession`.
        const id = resumed && config.resume ? config.resume : randomUuid();

        // The options need a way to ask the session, and the session
        // needs the options first, so the hook reaches the session
        // through a variable assigned below. Nothing calls it before the
        // first turn.
        let session: ClaudeAgentSession | undefined;

        const ask: AskHook = request => {

            if (!session)
                throw new Error("The Claude session asked a question before it was built.");

            return session.ask(request);
        };

        /*
         * Our own tools, served in-process: `createSdkMcpServer` runs
         * inside this process, so a handler is a closure over
         * the session. `alwaysLoad` keeps them out of tool search.
         *
         * The question tool's interactive gate is inside its handler,
         * not around the registration: an unattended run should hand
         * the agent a sentence it can act on, not a missing tool.
         *
         * The two clocks beside it save a shell start for the date -
         * see `timeTools`.
         */
        const askServer = createSdkMcpServer({
            name: ASK_SERVER_NAME,
            alwaysLoad: true,
            tools: [
                tool(
                    ASK_TOOL_NAME,
                    ASK_TOOL_DESCRIPTION,
                    askToolShape,
                    async (input, extra) => ({
                        content: [{
                            type: "text" as const,
                            text: await askQuestions(
                                input as AskToolInput,
                                config.interactive === true ? ask : undefined,
                                (extra as { signal?: AbortSignal } | undefined)?.signal)
                        }]
                    })),
                tool(
                    TIME_NOW_TOOL_NAME,
                    TIME_NOW_DESCRIPTION,
                    timeToolShape,
                    async () => ({ content: [{ type: "text" as const, text: timeNow() }] })),
                tool(
                    UTC_NOW_TOOL_NAME,
                    UTC_NOW_DESCRIPTION,
                    timeToolShape,
                    async () => ({ content: [{ type: "text" as const, text: utcNow() }] })),

                // Only for a session handed a plan - see `planTools`.
                ...(config.plan
                    ? [tool(
                        TASK_DONE_TOOL_NAME,
                        TASK_DONE_DESCRIPTION,
                        planToolShape,
                        async input => ({ content: [{ type: "text" as const, text: markTaskDone(config.plan!, input as PlanToolInput) }] }))]
                    : []),

                // And for the session writing one.
                ...(config.checkPlan
                    ? [tool(
                        CHECK_PLAN_TOOL_NAME,
                        CHECK_PLAN_DESCRIPTION,
                        checkPlanShape,
                        async () => ({ content: [{ type: "text" as const, text: checkPlan(config.checkPlan!) }] }))]
                    : []),

                // Only when the project has tagged steering files - see `steeringTool`.
                ...(config.steering?.length
                    ? [tool(
                        STEERING_TOOL_NAME,
                        steeringDescription(config.steering),
                        steeringToolShape,
                        async input => ({
                            content: [{
                                type: "text" as const,
                                text: answerSteering(config.steering!, input as SteeringToolInput, text => log(text))
                            }]
                        }))]
                    : [])
            ]
        });

        // `resume` is dropped when the check above said no, so the
        // options match what was decided.
        // Our own permission check, when the host hands one in.
        const gate = this.deps.permissions?.("claude", config.workingDirectory, config.chat);

        const options = sessionOptions(
            resumed ? config : { ...config, resume: undefined },
            id, env, abort, this.deps.directories?.(), mcp, log, askServer,
            settings.debug, this.deps.resources?.(), binary,
            (permission, raw, callId) => session?.allowedWithoutAsking(permission, raw, callId),
            gate ? { gate, ...(config.interactive === true ? { ask } : {}) } : undefined);

        // The tools the settings take away: added to the blocked list,
        // never replacing it.
        withToolsOff(options, this.deps.toolsOff?.("claude"));

        function log(text: string, stream?: "stdout" | "stderr" | "system"): void {

            config.log?.(text, stream ?? "system");
        }

        log(`Session options:\n${describeOptions(options)}`);

        // Only a session with every built-in tool lists them all; one
        // started with a picked `tools` list would shrink the picker.
        const fullSet = (options as { tools?: unknown }).tools === undefined;

        // Nothing has been spawned yet - `query` is lazy, and the first
        // message the queue yields is what starts the child process.
        const stream = query({ prompt: queue.stream(), options });

        session = new ClaudeAgentSession(
            id, stream, queue, abort, deleteSession, config.signal, log, resumed, resumeCheck.reason,
            fullSet ? tools => writeClaudeTools(builtInTools(tools)) : undefined,

            // Claude's own title for the conversation. The SDK's
            // `customTitle` is a /rename if there was one, else the
            // title Claude wrote itself; `summary` would fall back to
            // the first prompt, which the chat already shows.
            async () => (await getSessionInfo(id, { dir: config.workingDirectory }))?.customTitle,

            // The account kept from the last session, shown until a
            // fresh one is read - see `accountCache.ts`.
            { remember: rememberAccount, last: lastAccount });

        session.agentMode = claudeMode(config.agentMode, log);
        session.effort = claudeEffort(config.effort);

        return session;
    }
}

/*
 * The ask contract lives in `AgentSession`, shared by all providers.
 * Re-exported here for importers of this file.
 */
export type { AskHook, AskRequest, PendingAsk } from "../AgentSession";

export { NOT_INTERACTIVE } from "../AgentSession";

/**
 * One Claude conversation.
 *
 * Holds the three things that stand in for the session object the SDK
 * does not have: the queue feeding its prompt iterable, the generator
 * its output arrives on, and the controller that ends both.
 *
 * Exported for the tests. Constructing one starts no process; that
 * happens when the first message lands on the queue.
 */
export class ClaudeAgentSession implements AgentSession {

    private state: AgentSessionStatus = "idle";

    private readonly handlers = new Set<(event: AgentEvent) => void>();

    /**
     * Who is waiting for the current turn to end. A set rather than one
     * slot because `sendAndWait` may be called again before the first
     * has settled, and both callers are owed the same answer.
     */
    private readonly waiting = new Set<{ resolve(): void; reject(error: Error): void }>();

    /**
     * Per session, because everything it remembers belongs to one
     * conversation. Given the on-disk totals, so a reopened conversation
     * does not bill its earlier turns again - see `claudeTotals.ts`.
     */
    private readonly translator = new ClaudeEventTranslator(undefined, fileTotalsStore());

    /**
     * The background tasks the CLI says are live right now.
     *
     * Replaced wholesale on every `background_tasks_changed`, never
     * merged: the SDK publishes the full set so a missed message cannot
     * leave a stale entry.
     */
    private background = new Set<string>();

    /**
     * A turn whose `result` arrived while background work it started is
     * still running, and how many times the agent has been asked to
     * carry on. The SDK documents this gap: a backgrounded sub-agent
     * outlives the result. Settling then would record "waiting on their
     * results" as the answer, so nothing settles until the set is empty.
     */
    private parked?: { continuations: number };

    /** Questions waiting on a person, by id. See {@link AskDesk}. */
    private readonly asks = new AskDesk(event => this.emit(event));

    /**
     * Whether a context report has ever been published on this session.
     *
     * Only the first one is asked for early - see the `init` branch in
     * {@link publish}. After that every turn ends with one, and the
     * last one stays on screen while the next turn runs, so asking
     * again at the start of turn two would buy nothing.
     */
    private contextReported = false;

    /** The slash commands were kept once this session - see {@link reportCommands}. */
    private commandsReported = false;

    constructor(
        public readonly id: string,
        stream: AsyncIterable<SDKMessage>,
        private readonly queue: MessageQueue,
        private readonly abortController: AbortController,
        private readonly deleteSession: DeleteSession,
        signal: AbortSignal | undefined,
        private readonly log: (text: string, stream?: "stdout" | "stderr" | "system") => void,

        /** Whether this session is carrying on an earlier conversation - see {@link resumable}. */
        public readonly resumed = false,

        /** Why not, when it is not - see {@link AgentSession.resumeFailure}. */
        public readonly resumeFailure?: string,

        /** Told the runtime's tool list when the session is up - see `claudeTools.ts`. */
        private readonly onTools?: (tools: readonly unknown[]) => void,

        /** Reads the title Claude gave the conversation - see {@link reportTitle}. */
        private readonly readTitle?: () => Promise<string | undefined>,

        /**
         * Where the account is kept between sessions - see {@link reportAccount}.
         * Left out (the tests), nothing is kept or read back.
         */
        private readonly accounts?: { remember: typeof rememberAccount; last: typeof lastAccount }
    ) {

        this.pump(stream);

        // An already-aborted signal never fires its listener. That is a
        // Stop that landed while the session was being built, and it
        // must still win: dispose now, before the first prompt can start
        // the child process.
        if (signal?.aborted)
            void this.dispose();
        else
            signal?.addEventListener("abort", () => void this.abort("the run was stopped"));
    }

    public get status(): AgentSessionStatus {

        return this.state;
    }

    public async send(message: AgentMessage): Promise<void> {

        this.ensureUsable();

        const refused = this.refusedCommand(message) ?? this.refusedWhileCompacting();

        if (refused) {

            this.emit({ kind: "error", name: "claude.refused", message: refused.message, raw: refused });
            this.emit({ kind: "idle", name: "claude.refused", raw: refused });

            return;
        }

        this.state = "working";

        this.showKeptAccount();

        this.queue.push(sdkMessage(message, this.id));
    }

    /**
     * `send` returns as soon as the prompt is queued; this one waits for
     * the turn to end.
     *
     * The SDK emits exactly one `result` per turn, and foreground
     * sub-agents are inside it (the Task tool call does not return until
     * its sub-agent finishes). A backgrounded sub-agent can outlive the
     * result, so the wait is also gated on an empty task set from
     * `background_tasks_changed`. See `publish` and `resume`.
     *
     * The default timeout only stops an infinite wait on a session that
     * never reports; the task's own `timeout:` is the real limit.
     */
    public async sendAndWait(message: AgentMessage, timeoutMs: number | null = IDLE_TIMEOUT_MS): Promise<void> {

        this.ensureUsable();

        const refused = this.refusedCommand(message) ?? this.refusedWhileCompacting();

        if (refused) {

            this.emit({ kind: "error", name: "claude.refused", message: refused.message, raw: refused });

            throw refused;
        }

        // Registered before the message is queued, so a turn that
        // finishes quickly cannot land its result between the two.
        const settled = this.turn(timeoutMs);

        this.state = "working";

        this.showKeptAccount();

        this.queue.push(sdkMessage(message, this.id));

        await settled;
    }

    /**
     * Stops the turn in flight.
     *
     * `interrupt()` is the SDK's way to end a turn and keep the session
     * usable, so it goes first. It is a request to the child process,
     * not a guarantee, so the turn gets a short grace period and a
     * session that does not end in time is disposed. That kills the
     * child and settles every waiter now instead of at the backstop
     * timeout.
     *
     * A session with no turn running is left alone: a held, idle
     * conversation must survive the Stop of a run that no longer owns
     * it.
     *
     * @param graceMs How long the interrupt gets before dispose. A
     * parameter so tests do not wait out the real grace.
     */
    /** Stops the turn, and says so in the log with `reason` - see the ACP session's `abort`. */
    public async abort(reason: string = "Stop was pressed", graceMs = ABORT_GRACE_MS): Promise<void> {

        // A parked turn left here would ask the agent to carry on after
        // the person said to stop.
        this.parked = undefined;

        if (this.state !== "working")
            return;

        // An open question would hold the tool callback, and the turn,
        // past the Stop.
        this.asks.abandon("The turn was stopped before the question was answered.");

        this.emit({ name: "interrupt", raw: { reason }, kind: "notice", text: `Sent interrupt: ${reason}.` });

        // Registered before the interrupt, so a turn that ends promptly
        // cannot settle in the gap and leave this wait to time out.
        const settled = this.turn(graceMs);

        const stream = this.stream as { interrupt?(): Promise<unknown> } | undefined;

        stream?.interrupt?.().catch(() => undefined);

        try {

            await settled;

        } catch {

            // The grace ran out, or the turn failed. Dispose is
            // idempotent, so the already-failed case costs nothing.
            await this.dispose();
        }
    }

    public async dispose(): Promise<void> {

        if (this.state === "ended")
            return;

        this.state = "ended";
        this.handlers.clear();
        this.parked = undefined;

        this.asks.abandon("The session ended before the question was answered.");

        // Closing the queue ends the prompt iterable, which is how the
        // SDK is told the conversation is over; aborting then stops the
        // child process whether or not it noticed. The transcript on
        // disk survives both, so the session can be resumed later.
        this.queue.close();

        this.abortController.abort();

        this.settle(undefined);
    }

    public async delete(): Promise<void> {

        if (this.state === "ended")
            return;

        const id = this.id;

        try {

            // Before dispose, so this does not race the child process's
            // own shutdown writes.
            await this.deleteSession(id);

        } catch (error) {

            // Documented to throw when the session is not found, which
            // is normal for a session that never persisted anything.
            // Not a reason to leave a child process running.
            this.log(
                `Session transcript was not deleted: `
                + `${error instanceof Error ? error.message : String(error)}`,
                "stderr");

        } finally {

            await this.dispose();
        }
    }

    public on(handler: (event: AgentEvent) => void): () => void {

        this.handlers.add(handler);

        return () => this.handlers.delete(handler);
    }

    /**
     * Puts a question to whoever is watching, and waits.
     *
     * Raised as an `ask` event with a fresh id; the promise settles when
     * {@link respond} names that id. Called from the `ask_user` tool's
     * handler while the agent is blocked on the call, so a pending
     * question reads as `working`, not `idle`.
     */
    public ask(request: AskRequest): PendingAsk {

        this.ensureUsable();

        return this.asks.ask(request, ASK_TOOL_FULL_NAME);
    }

    /** A tool call allowed without asking a person - see `allowedNotice`. */
    public allowedWithoutAsking(permission: AskPermission, raw: unknown, callId?: string): void {

        this.emit(allowedNotice("canUseTool", raw, permission, callId));
    }

    public async respond(askId: string, answer: string): Promise<void> {

        this.asks.respond(askId, answer);
    }

    /** Kept so `abort` can reach `interrupt` and a mode change `setPermissionMode`; `pump` owns the iteration. */
    private stream?: AsyncIterable<SDKMessage>;

    /** The permission mode this session is in - see {@link CLAUDE_MODES}. */
    public agentMode?: string;

    /**
     * Puts the session in a mode from {@link CLAUDE_MODES}, between turns -
     * the compose box's pick. Anything else is refused and logged.
     */
    public async setAgentMode(mode: string | undefined): Promise<void> {

        const wanted = mode?.trim();

        if (!wanted || wanted === (this.agentMode ?? "default"))
            return;

        if (!CLAUDE_MODES.some(one => one.id === wanted)) {

            this.log(`Mode '${wanted}' is not offered - only ${CLAUDE_MODES.map(one => one.name).join(" and ")}.`, "system");

            return;
        }

        await this.setPermissionMode(wanted);

        this.log(`Mode: ${CLAUDE_MODES.find(one => one.id === wanted)!.name} (set on the session).`, "system");
    }

    /**
     * Changes how hard the model thinks for the rest of the session - the
     * compose box's Effort pick, between turns. Undefined goes back to the
     * model's own default. A level Claude does not know is refused and
     * logged.
     */
    public async setEffort(effort: string | undefined): Promise<void> {

        const wanted = effort?.trim() ? claudeEffort(effort, this.log) : undefined;

        if (effort?.trim() && !wanted)
            return;

        if ((wanted ?? "") === (this.effort ?? ""))
            return;

        const query = this.stream as { applyFlagSettings?(settings: { effortLevel?: string | null }): Promise<void> } | undefined;

        if (!query?.applyFlagSettings)
            throw new Error("The Claude session cannot change its effort yet - send a message first.");

        await query.applyFlagSettings({ effortLevel: wanted ?? null });

        this.effort = wanted;

        this.log(`Effort: ${wanted ?? "the model's default"} (set on the session).`, "system");
    }

    /** The effort level this session runs at, when one was picked - see {@link setEffort}. */
    public effort?: string;

    /** What the CLI has said so far about a Compact that is running - see {@link compact}. */
    private compaction?: { done: boolean; failed?: string; answer?: string };

    /**
     * The Compact button: Claude's own `/compact`, sent as a turn. Claude
     * writes a summary of the conversation and carries on from it, so it
     * costs a model call. Refused while a turn runs.
     *
     * Whether it worked is read from what the CLI says during that turn:
     * a `compact_boundary` means it did, a `status` with
     * `compact_result: "failed"` says why it did not. A message sent while
     * it runs is refused - see {@link refusedWhileCompacting}.
     */
    public async compact(): Promise<{ ok: boolean; reason?: string }> {

        if (this.state === "ended")
            return { ok: false, reason: "The session has ended." };

        if (this.state === "working")
            return { ok: false, reason: "A turn is still running. Compact once it has finished." };

        const compaction: { done: boolean; failed?: string; answer?: string } = { done: false };

        this.compaction = compaction;

        // Registered before the message is queued - see `sendAndWait`.
        const settled = this.turn(IDLE_TIMEOUT_MS);

        this.state = "working";

        this.queue.push(sdkMessage({ prompt: "/compact" }, this.id));

        try {

            await settled;

        } catch (error) {

            return { ok: false, reason: `Claude could not compact: ${error instanceof Error ? error.message : String(error)}` };

        } finally {

            this.compaction = undefined;
        }

        if (compaction.failed)
            return { ok: false, reason: `Claude did not compact: ${compaction.failed}` };

        if (!compaction.done)
            return {
                ok: false,
                reason: compaction.answer?.trim()
                    ? `Claude did not compact: ${clip(compaction.answer, VALUE_LIMIT)}`
                    : "Claude did not compact - there may be nothing to compact yet."
            };

        return { ok: true };
    }

    /** Notes what a running Compact needs to know - see {@link compact}. */
    private watchCompaction(message: SDKMessage): void {

        const compaction = this.compaction;

        if (!compaction)
            return;

        if (message.type === "system" && message.subtype === "compact_boundary")
            compaction.done = true;

        if (message.type === "system" && message.subtype === "status" && message.compact_result === "failed")
            compaction.failed = message.compact_error || "no reason given.";

        if (message.type === "result" && message.subtype === "success")
            compaction.answer = message.result;
    }

    /**
     * The error for a message sent while a Compact runs. Queued behind
     * `/compact`, it would run as a turn of its own after it, while the
     * Compact's end released its sender as if its own turn had ended.
     */
    private refusedWhileCompacting(): Error | undefined {

        return this.compaction
            ? new Error("Claude is compacting the conversation. Send your message once it has finished.")
            : undefined;
    }

    private async setPermissionMode(mode: string): Promise<void> {

        const query = this.stream as { setPermissionMode?(mode: string): Promise<void> } | undefined;

        if (!query?.setPermissionMode)
            throw new Error("The Claude session cannot change its mode yet - send a message first.");

        await query.setPermissionMode(mode);

        this.agentMode = mode;
    }

    /**
     * Keeps the session out of a permission mode that skips our checks
     * (accept edits, auto, bypass, don't ask), whatever put it there - the
     * CLI reports its mode on `init` and on each `status`. It is set back
     * to the default and said in the chat.
     */
    private guardMode(message: SDKMessage): void {

        if (message.type !== "system" || (message.subtype !== "init" && message.subtype !== "status"))
            return;

        const mode = (message as { permissionMode?: unknown }).permissionMode;

        if (typeof mode !== "string" || !mode)
            return;

        this.agentMode = mode;

        if (CLAUDE_MODES.some(one => one.id === mode))
            return;

        void this.setPermissionMode("default").then(
            () => this.emit({
                name: "setPermissionMode", raw: message, kind: "notice",
                text: `Claude switched itself to '${mode}', which skips asking - switched back to Agent.`
            }),
            error => this.emit({
                name: "setPermissionMode", raw: error, kind: "error",
                message: `Claude switched itself to '${mode}', and it could not be switched back: ${error instanceof Error ? error.message : String(error)}`
            }));
    }

    /**
     * Reads the whole conversation for the life of the session. Not
     * awaited: the generator stays open across turns, so awaiting it
     * would be awaiting the session's end.
     */
    private async pump(stream: AsyncIterable<SDKMessage>): Promise<void> {

        this.stream = stream;

        try {

            for await (const message of stream)
                await this.publish(message);

            // The generator ended without a result: fail the waiters
            // rather than leave them on the backstop timeout.
            this.settle(new Error("The Claude session ended before the turn completed."));

        } catch (error) {

            // The SDK documents throwing after yielding an error result,
            // so this is usually a second notice of a failure `publish`
            // already reported. Waiters settled by that result ignore
            // this one.
            const failure = error instanceof Error ? error : new Error(String(error));

            this.emit({ kind: "error", name: "sdk.error", message: failure.message, raw: error });

            this.settle(failure);
        }
    }

    /**
     * Keeps Claude's slash commands for the compose box - see
     * `commandListFile.ts`. From `supportedCommands()`, which has each
     * one's description; the bare names `init` carries when the CLI cannot
     * say. Not awaited, like the context report: nothing waits on it.
     *
     * Left out: the ones never sent (`claudeCommands.ts`), and the ones
     * only Claude Code's own terminal screen can run
     * (`terminal_slash_commands`).
     */
    private async reportCommands(init: Sdk<"system">): Promise<void> {

        this.commandsReported = true;

        const sent = init as { slash_commands?: unknown; terminal_slash_commands?: unknown };

        let commands = commandsFrom(sent.slash_commands);

        const stream = this.stream as { supportedCommands?(): Promise<unknown> } | undefined;

        try {

            if (stream?.supportedCommands) {

                const described = commandsFrom(await withTimeout(stream.supportedCommands(), CONTEXT_TIMEOUT_MS));

                if (described.length)
                    commands = described;
            }

        } catch {

            // The names `init` gave stand.
        }

        const terminal = Array.isArray(sent.terminal_slash_commands)
            ? sent.terminal_slash_commands.filter((name): name is string => typeof name === "string")
            : [];

        await keepCommandList(CLAUDE_RUNTIME, offeredCommands(commands, [...CLAUDE_REFUSED_COMMANDS, ...terminal]));
    }

    /** The error for a message that starts with a slash command Claude is never sent - see `claudeCommands.ts`. */
    private refusedCommand(message: AgentMessage): Error | undefined {

        const name = commandNameIn(message.prompt);

        return name && CLAUDE_REFUSED_COMMANDS.includes(name) ? new Error(refusedCommandText(name)) : undefined;
    }

    /**
     * The context window as the CLI counts it right now, as a `notice`
     * carrying {@link ContextUsage}.
     *
     * `getContextUsage` is a control request to the CLI, not a model
     * call, so it costs no tokens. An older CLI without it, or one that
     * has already exited, answers with a rejection - swallowed, because
     * a missing meter is not a failed turn.
     */
    private async reportContext(): Promise<void> {

        const stream = this.stream as { getContextUsage?(): Promise<ContextReport> } | undefined;

        if (!stream?.getContextUsage) {

            this.log("This CLI does not report context usage, so the session has no context meter.");

            return;
        }

        try {

            const report = await withTimeout(stream.getContextUsage(), CONTEXT_TIMEOUT_MS);

            const context = contextUsageOf(report);

            if (!context) {

                this.log("The CLI's context report named no window size, so there is no context meter.");

                return;
            }

            this.contextReported = true;

            this.emit({
                name: "context_usage",
                raw: report,
                kind: "notice",
                progress: true,
                text: `Context ${percent(context.used, context.size)}% of ${tokens(context.size)} tokens used`,
                // Says the Compact button can be offered - see {@link compact}.
                context: { ...context, compactable: true }
            });

        } catch (error) {

            // Never fatal: a missing meter is not a failed turn. Said
            // out loud rather than swallowed, because a meter that is
            // silently absent is a meter nobody can debug.
            this.log(`The context report could not be read, so there is no context meter. ${(error as Error).message}`);
        }
    }

    /** A fresh account went out this session - a kept copy landing later is older, and not shown. */
    private accountReported = false;

    /** The kept copy was asked for - once, on the first message. */
    private keptAccountAsked = false;

    /**
     * On the first message: the account kept from an earlier session, if
     * there is one, so the Account section is not empty while the CLI
     * starts. Dated, and replaced by the fresh one when it lands.
     */
    private showKeptAccount(): void {

        if (this.keptAccountAsked || !this.accounts)
            return;

        this.keptAccountAsked = true;

        void this.accounts.last(CLAUDE_RUNTIME).then(kept => {

            if (kept && !this.accountReported && this.state !== "ended")
                this.emit({
                    name: "account.kept",
                    raw: kept,
                    kind: "notice",
                    progress: true,
                    text: `Account usage as of ${new Date(kept.at).toISOString()} - fetching a fresh one`,
                    account: kept
                });
        }, () => undefined);
    }

    /**
     * The account and the plan limits - what `/status` and `/usage`
     * show - as a notice carrying {@link AccountUsage}. Control requests
     * to the CLI, not model calls: no tokens. Capped like the context
     * report, and quiet when the CLI cannot answer (an API key sign-in
     * has no plan limits, an older CLI has no such request): a missing
     * account is not a failed turn. See `claudeAccount.ts`.
     */
    private async reportAccount(): Promise<void> {

        if (!this.stream)
            return;

        const found = await readClaudeAccount(this.stream as ClaudeAccountSource, Date.now, CONTEXT_TIMEOUT_MS);

        if (!found || this.state === "ended")
            return;

        this.accountReported = true;

        this.emit(claudeAccountNotice(CLAUDE_RUNTIME, found));

        void this.accounts?.remember(CLAUDE_RUNTIME, found.account);
    }

    /** The last title {@link reportTitle} sent, so the same one is not sent after every turn. */
    private titleSent?: string;

    /**
     * The title Claude gave the conversation, as a `notice` carrying
     * `title` - the same line an ACP runtime's own title becomes, so
     * the chat list and the header show it.
     *
     * Claude writes it itself, in the session's file, once it has seen
     * enough of the conversation - often after the first or second
     * turn. Read after each turn; nothing is sent until there is one.
     * A failed read is said in the log and is never a failed turn.
     */
    private async reportTitle(): Promise<void> {

        if (!this.readTitle)
            return;

        try {

            const title = (await withTimeout(this.readTitle(), TITLE_TIMEOUT_MS))?.trim();

            if (!title || title === this.titleSent)
                return;

            this.titleSent = title;

            this.emit({ name: "session_title", raw: { title }, kind: "notice", progress: true, text: `Title: ${title}`, title });

        } catch (error) {

            this.log(`Claude's own title for this conversation could not be read. ${(error as Error).message}`);
        }
    }

    /**
     * One SDK message in the engine's terms, republished to subscribers.
     * Translation lives in {@link ClaudeEventTranslator}; what stays
     * here is the turn ending and everyone waiting on it.
     */
    private async publish(message: SDKMessage): Promise<void> {

        this.guardMode(message);

        this.watchCompaction(message);

        // The whole set, every time. See `background` above.
        if (message.type === "system" && message.subtype === "background_tasks_changed")
            this.background = new Set(
                (message.tasks ?? []).map(task => task.task_id).filter((id): id is string => !!id));

        /*
         * The window as it stands before the agent has done anything.
         *
         * `init` is the CLI announcing it is up, which is the earliest
         * moment it can answer. Without this the meter has no bar at
         * all until the first turn ends - and a first turn is the long
         * one, so that is exactly when somebody wants to know how much
         * room is left. What it reports is real work already: the
         * system prompt, the tool schemas and any memory files are in
         * the window before the first word is sent.
         *
         * Not awaited, unlike the one at the end of a turn: nothing is
         * waiting to be released here, the session stays alive for the
         * whole turn either way, and making the turn wait on it would
         * delay the agent starting.
         */
        if (message.type === "system" && message.subtype === "init" && !this.contextReported)
            void this.reportContext();

        if (message.type === "system" && message.subtype === "init" && !this.commandsReported)
            void this.reportCommands(message);

        // The account and plan limits as soon as the CLI can answer, and
        // again whenever it says the limit state changed.
        if ((message.type === "system" && message.subtype === "init" && !this.accountReported) || message.type === "rate_limit_event")
            void this.reportAccount();

        if (message.type === "system" && message.subtype === "init" && Array.isArray(message.tools))
            this.onTools?.(message.tools);

        // Before the events go out, so a handler reading `status` while
        // it handles the idle sees the state that idle announces. A
        // result with work still running is not idle.
        if (message.type === "result" && this.background.size === 0)
            this.state = "idle";

        for (const event of this.translator.translate(message))
            this.emit(event);

        if (message.type === "result") {

            const failure = resultFailure(message);

            // A failed turn ends now, whatever is still in the background.
            if (failure) {

                this.parked = undefined;

                // A question still open here is not a real one: the
                // model is blocked on its own tool call while one is,
                // and a turn cannot reach `result` mid-block. It is the
                // CLI having dropped that one call without telling this
                // session so - closed here rather than left to lock the
                // next turn's box forever over a question nobody is
                // still asking.
                this.asks.abandon("The turn ended without an answer.");

                this.settle(new Error(failure));

                return;
            }

            if (this.background.size === 0) {

                this.parked = undefined;

                this.asks.abandon("The turn ended without an answer.");

                /*
                 * How full the window is after this turn, before the
                 * turn is settled rather than after.
                 *
                 * Awaited on purpose. `settle` is what releases whoever
                 * ran the turn, and `ai@1` stops listening and disposes
                 * the session the moment it is released - so a report
                 * that arrived afterwards would be emitted to nobody, and
                 * the meter would have no bar to draw. It is one
                 * control round trip to a process that is sitting
                 * idle, and it is capped, so a CLI that never answers
                 * costs the turn {@link CONTEXT_TIMEOUT_MS} and no
                 * more.
                 */
                await this.reportContext();

                // Before the settle for the same reason: after it,
                // nobody is listening.
                await this.reportTitle();

                // What the turn left of the plan limits. Same reason.
                await this.reportAccount();

                this.settle(undefined);

                return;
            }

            // The agent ended its turn with jobs still out. The caller
            // waits, and `resume` picks it up when they land.
            this.parked ??= { continuations: 0 };

            return;
        }

        if (this.parked && this.background.size === 0)
            this.resume();
    }

    /**
     * The background work finished under a parked turn.
     *
     * The agent's last word was a holding line, and a sub-agent's own
     * prose is not the task's answer (see `collect` in `ai@1`), so the
     * agent gets one more turn to use the results. Capped, because a
     * turn that backgrounds work again on each continuation could go
     * round forever. At the cap the turn settles on what there is.
     */
    private resume(): void {

        const parked = this.parked;

        if (!parked)
            return;

        if (parked.continuations >= MAX_CONTINUATIONS) {

            this.parked = undefined;
            this.state = "idle";

            this.emit(backgroundNotice(
                `Background work finished, but the agent has already been asked to continue `
                + `${MAX_CONTINUATIONS} times - taking the turn as it stands.`));

            this.settle(undefined);

            return;
        }

        parked.continuations++;

        this.state = "working";

        // Announced, because the next turn is one nobody typed.
        this.emit(backgroundNotice("Background work finished - asking the agent to carry on."));

        this.queue.push(sdkMessage({ prompt: CONTINUE_PROMPT }, this.id));
    }

    private emit(event: AgentEvent): void {

        for (const handler of [...this.handlers])
            handler(event);
    }

    /** A promise for the end of the current turn, with a backstop. `timeoutMs` `null` is no backstop at all - see `AgentSession.sendAndWait`. */
    private turn(timeoutMs: number | null): Promise<void> {

        return new Promise<void>((resolve, reject) => {

            const waiter = {

                resolve: () => {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    this.waiting.delete(waiter);
                    resolve();
                },

                reject: (error: Error) => {
                    if (timer !== undefined)
                        clearTimeout(timer);
                    this.waiting.delete(waiter);
                    reject(error);
                }
            };

            const timer = timeoutMs === null
                ? undefined
                : setTimeout(
                    () => waiter.reject(new Error(`Timeout after ${timeoutMs}ms waiting for the turn to complete`)),
                    timeoutMs);

            this.waiting.add(waiter);
        });
    }

    /** Ends every wait on the current turn, successfully or not. */
    private settle(error?: Error): void {

        for (const waiter of [...this.waiting])
            error ? waiter.reject(error) : waiter.resolve();
    }

    /**
     * A message queued after `dispose` would go nowhere and its waiter
     * would sit on the backstop timeout for an hour. Throwing turns
     * that into an ordinary task failure the run can finish on.
     */
    private ensureUsable(): void {

        if (this.state === "ended")
            throw new Error("The Claude session has ended and cannot take another message.");
    }
}

/**
 * The prompt side of a session: messages in from `send`, out through an
 * async iterable the SDK owns.
 *
 * The iterable must not return between turns, because the conversation
 * lives exactly as long as it does. An empty queue waits; only `close`
 * ends it. Exported for the tests.
 */
export class MessageQueue {

    private readonly pending: SDKUserMessage[] = [];

    private wake?: () => void;

    private closed = false;

    public push(message: SDKUserMessage): void {

        this.pending.push(message);

        this.signal();
    }

    public close(): void {

        this.closed = true;

        this.signal();
    }

    public async *stream(): AsyncGenerator<SDKUserMessage> {

        for (; ;) {

            while (this.pending.length)
                yield this.pending.shift() as SDKUserMessage;

            if (this.closed)
                return;

            await new Promise<void>(resolve => { this.wake = resolve; });
        }
    }

    private signal(): void {

        const wake = this.wake;

        this.wake = undefined;

        wake?.();
    }
}

/**
 * Backstop against waiting forever on a turn that never reports. The
 * task's own `timeout:` is the real policy.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * How long an interrupted turn gets to end on its own before `abort`
 * escalates to `dispose`. Long enough for the CLI to wind down a tool
 * call, short enough that Stop still feels like stopping.
 */
const ABORT_GRACE_MS = 5000;

/**
 * How many times an agent may be asked to carry on after backgrounded
 * work lands. More than one because carrying on can start more work;
 * capped because it could go round forever.
 */
const MAX_CONTINUATIONS = 3;

/**
 * What the agent is told when its background work lands. Not new
 * instructions: the agent already has the task, and this only says the
 * results it was waiting for have arrived.
 */
const CONTINUE_PROMPT =
    "The work you started in the background has finished and its results are above. "
    + "Carry on and finish what you were asked to do.";

/** The engine's own line about a parked turn - see `resume`. */
function backgroundNotice(text: string): AgentEvent {

    return { kind: "notice", name: "background_tasks_changed", raw: undefined, text };
}

/**
 * Whether a conversation can be picked back up.
 *
 * The SDK keeps transcripts under `~/.claude/projects`, but an id can
 * outlive its transcript (cleared, folder moved, session deleted), and
 * `resume` pointed at nothing is a failed turn rather than a fresh
 * start. `getSessionInfo` reads the file and answers `undefined` when
 * there is nothing to read.
 *
 * It also answers `undefined` for a sidechain session and for one with
 * no summary yet. Both are treated as "no", which costs a cold start.
 * Wrong in the safe direction.
 *
 * A lookup that throws is a different fact from one that answers
 * "nothing here": the transcript may still exist, the check just did
 * not manage to say so. Retried a couple of times before giving up,
 * and the reason travels back either way - `ai@1` fails the run on a
 * missed resume rather than starting cold behind the person's back, and
 * "the transcript is gone" is not the same refusal as "the lookup kept
 * failing".
 */
export async function resumable(
    getSessionInfo: ClaudeSdk["getSessionInfo"],
    id: string,
    cwd: string,
    log: (text: string, stream?: "stdout" | "stderr" | "system") => void
): Promise<{ resumed: true } | { resumed: false; reason: string }> {

    for (let attempt = 0; attempt <= RESUMABLE_RETRIES; attempt++) {

        try {

            if (await getSessionInfo(id, { dir: cwd }))
                return { resumed: true };

            const reason = `no transcript for session ${id} under ${cwd}`;

            log(`${reason}, so this starts a new conversation rather than carrying that one on.`, "system");

            return { resumed: false, reason };

        } catch (error) {

            const detail = error instanceof Error ? error.message : String(error);

            if (attempt < RESUMABLE_RETRIES) {

                log(`Could not look up session ${id}: ${detail}. Trying again.`, "system");

                await new Promise(resolve => setTimeout(resolve, RESUMABLE_RETRY_DELAY_MS));

                continue;
            }

            const reason = `the lookup for session ${id} failed: ${detail}`;

            log(`${reason}. Starting a new conversation.`, "system");

            return { resumed: false, reason };
        }
    }

    // Unreachable - the loop always returns. TypeScript cannot see that
    // from a `for` bound by a runtime constant.
    return { resumed: false, reason: "the lookup did not complete" };
}

/** Extra attempts a lookup that threw gets before it is treated as "cannot tell". */
const RESUMABLE_RETRIES = 2;

/** The pause between those attempts - short, because this blocks starting the turn at all. */
const RESUMABLE_RETRY_DELAY_MS = 500;

/**
 * The SDK, loaded on first use. `import()` because the package is
 * ESM-only and this file is bundled as CommonJS. Cached so a second
 * session does not load the module twice.
 *
 * The cast is the one place the module's shape is asserted rather than
 * checked: `import()` of a package esbuild leaves external can only be
 * typed by hand. {@link ClaudeSdk} is built from the SDK's own exports,
 * so a rename on the vendor's side still fails the build.
 */
let sdk: Promise<ClaudeSdk> | undefined;

function loadSdk(): Promise<ClaudeSdk> {

    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return sdk ??= (import("@anthropic-ai/claude-agent-sdk") as unknown as Promise<ClaudeSdk>);
}

/**
 * The exports this file uses, as `typeof` the real functions so an
 * export the SDK renames or drops fails the `import type` above at
 * build time instead of as `undefined is not a function` at run time.
 */
interface ClaudeSdk {

    query: typeof query;

    deleteSession: typeof deleteSession;

    /** An MCP server that runs in this process. How `ask_user` reaches the model; see `askTool`. */
    createSdkMcpServer: typeof createSdkMcpServer;

    /** One tool of such a server. `inputSchema` is a zod raw shape; see `askToolShape`. */
    tool: typeof tool;

    /** One session's metadata off disk, or `undefined`. See {@link resumable}. */
    getSessionInfo: typeof getSessionInfo;
}

type DeleteSession = ClaudeSdk["deleteSession"];

/**
 * One content block of a user message, which is where `tool_result`
 * arrives. `content` is `string | block[]`, so the string case is
 * excluded here and guarded at the one place that iterates it.
 */
type SdkUserBlock = Exclude<Extract<SDKMessage, { type: "user" }>["message"]["content"], string>[number];

/** A tool's answer to a call, the only user block this file reads. */
type SdkToolResult = Extract<SdkUserBlock, { type: "tool_result" }>;

/**
 * One member of the SDK's message union, by its `type`. The handlers
 * take these rather than the whole union so `switch (message.subtype)`
 * can narrow; `subtype` is not a field every member carries.
 */
type Sdk<T extends SDKMessage["type"]> = Extract<SDKMessage, { type: T }>;

/**
 * The SDK's message stream in the engine's terms.
 *
 * A class because a `tool_result` block carries only the id of the call
 * it answers, so calls in flight are remembered here, as are sub-agent
 * labels, which are announced once on `task_started`.
 *
 * Anything unrecognised becomes `other` with `raw` intact.
 */
export class ClaudeEventTranslator {

    /**
     * `tool_use_id` to the call it started, so a `tool_result` can name
     * and time the call it answers. Entries go as they are matched; a
     * call whose result never arrives leaks a small string until the
     * session ends.
     *
     * `silent` is a call with no `tool.start`/`tool.end` pair: the agent
     * asking a person, which has the `ask` event instead. Still recorded
     * so its result can be recognised and dropped too.
     *
     * `plan` is a to-do tool call (see `plan.ts`): logged as two notices
     * instead of a tool call, and what it did goes into the plan.
     */
    private readonly calls = new Map<string, { tool: string; started: number; silent?: boolean; plan?: { input: unknown } }>();

    /** The tasks the `Task*` to-do tools built up this session - see `plan.ts`. */
    private readonly tasks = new TaskBoard();

    /** The MCP line last shown - see the `init` case of `system`. */
    private mcpShown?: string;

    /**
     * Sub-agent labels under both ids a later message might use: the
     * task's own id and the `tool_use_id` of the Task call that spawned
     * it, which a forwarded message carries as `parent_tool_use_id`.
     */
    private readonly agents = new Map<string, string>();

    /**
     * The running dollar total the last `result` carried.
     *
     * The SDK's `total_cost_usd` is cumulative over one `query()` call,
     * and one translator lives exactly that long - so the difference
     * from this is what the turn just finished cost, which is what the
     * notice carries. A total below the last one is the CLI having
     * reset its counter, and the whole of it is new.
     */
    private lastCostUsd = 0;

    /**
     * The same running totals, per model, from the result's
     * `modelUsage`. Cumulative for the same reason and over the same
     * life as {@link lastCostUsd}, so each turn reports the difference.
     */
    private readonly lastByModel = new Map<string, { cost: number; input: number; output: number; cached: number }>();

    /**
     * The current message's text so far, per speaker and channel; what
     * a `delta` event carries. Accumulated here because the SDK sends
     * only the piece that just arrived, and a consumer that missed one
     * delta would otherwise be permanently short a few words.
     *
     * Keyed by speaker as well as channel: with `forwardSubagentText`
     * on, a sub-agent's text streams while the main agent is still
     * writing, and one buffer per channel would splice the two together.
     * See {@link paintKey}.
     */
    private streamed = new Map<string, string>();

    /** When each channel last published a delta - see {@link DELTA_INTERVAL_MS}. */
    private readonly lastDelta = new Map<string, number>();

    /**
     * Whether {@link lastCostUsd} and {@link lastByModel} were started
     * from the conversation's stored totals yet - once, on the first
     * `result`, which is the first message that names the conversation.
     */
    private seeded = false;

    /**
     * @param now Injected so a test can pin the throttle.
     * @param totals Where each conversation's running totals are kept
     * between runtime processes - see `claudeTotals.ts`. Absent, a
     * reopened conversation counts from zero.
     */
    constructor(
        private readonly now: () => number = () => Date.now(),
        private readonly totals?: ClaudeTotalsStore
    ) { }

    public translate(message: SDKMessage): AgentEvent[] {

        switch (message.type) {

            /* The answer being typed. Ephemeral and throttled; see {@link partial}. */
            case "stream_event":

                return this.partial(message);

            case "assistant":

                return this.assistant(message);

            case "user":

                return this.user(message);

            case "result":

                return this.result(message);

            case "system":

                return this.system(message);

            /*
             * Heartbeats are dropped; a sub-agent being retried after an
             * API failure is reported nowhere else.
             */
            case "tool_progress": {

                const retry = message.subagent_retry;

                if (!retry)
                    return [this.other(message)];

                return [this.notice(message,
                    `Sub-agent retrying after ${retry.error_category ?? "an error"} `
                    + `(attempt ${retry.attempt ?? "?"} of ${retry.max_retries ?? "?"}).`)];
            }

            /* The CLI's own summary of a run of tool calls. */
            case "tool_use_summary":

                return asText(message.summary)
                    ? [this.notice(message, clip(asText(message.summary), LINE_LIMIT))]
                    : [this.other(message)];

            case "rate_limit_event":

                return [this.notice(message, "The account's rate limit state changed.")];

            case "conversation_reset":

                return [this.notice(message, "The conversation was reset.")];

            default:

                return [this.other(message)];
        }
    }

    /**
     * One streaming frame as a `delta`, or nothing.
     *
     * Only a `content_block_delta` carrying text or thinking says
     * anything new, and those are published at most every
     * {@link DELTA_INTERVAL_MS}. Dropping one costs nothing because each
     * carries the whole block so far.
     */
    private partial(message: Sdk<"stream_event">): AgentEvent[] {

        const event = message.event;

        // A fresh message: whatever was half-written belonged to the
        // last one. This speaker's buffers only, so a sub-agent starting
        // to write does not wipe the main agent's paragraph.
        if (event.type === "message_start") {

            for (const channel of ["message", "reasoning"] as const)
                this.streamed.delete(this.paintKey(message, channel));

            return [];
        }

        if (event.type !== "content_block_delta")
            return [];

        // The delta is a union: a `text_delta` has `text` and a
        // `thinking_delta` has `thinking`, so the channel and the field
        // are decided together.
        const delta = event.delta;

        const piece: { channel: DeltaChannel; text: string } | undefined =
            "text" in delta && typeof delta.text === "string"
                ? { channel: "message", text: delta.text }
                : "thinking" in delta && typeof delta.thinking === "string"
                    ? { channel: "reasoning", text: delta.thinking }
                    : undefined;

        if (!piece)
            return [];

        const key = this.paintKey(message, piece.channel);

        const text = (this.streamed.get(key) ?? "") + piece.text;

        this.streamed.set(key, text);

        const now = this.now();

        // Throttled per speaker, or two agents writing at once share one
        // budget and one starves the other.
        if (now - (this.lastDelta.get(key) ?? 0) < DELTA_INTERVAL_MS)
            return [];

        this.lastDelta.set(key, now);

        return [{
            ...this.common(message),
            kind: "delta",
            channel: piece.channel,
            text
        }];
    }

    /** What the agent said, thought, and decided to run. */
    private assistant(message: Sdk<"assistant">): AgentEvent[] {

        // The complete message is the record, so the live text for it
        // is done. Cleared before the events go out, so a surface
        // swapping the live text for the real thing cannot be handed a
        // stale delta after it. This speaker's buffers only, so a
        // sub-agent finishing does not wipe the main agent's paragraph.
        for (const channel of ["message", "reasoning"] as const)
            this.streamed.delete(this.paintKey(message, channel));

        const events: AgentEvent[] = [];

        for (const block of message.message.content) {

            if (block.type === "text" && block.text)
                events.push({ ...this.common(message), kind: "message", text: block.text });

            // Not folded into `message`: a phase records its closing
            // message as what it produced, and thinking is not that.
            if (block.type === "thinking" && block.thinking)
                events.push({ ...this.common(message), kind: "reasoning", text: block.thinking });

            // A to-do tool: the plan strip shows what it does, so it is not
            // drawn as a tool call. Still logged, as a notice. `TodoWrite`
            // carries the whole list; the `Task*` ones change the list
            // when their result comes back - see `user`.
            if (block.type === "tool_use" && isPlanTool(block.name ?? "")) {

                const name = block.name ?? "";

                if (block.id)
                    this.calls.set(block.id, { tool: name, started: Date.now(), silent: true, plan: { input: block.input } });

                const todos = name === "TodoWrite" ? planFromTodos(block.input) : undefined;

                events.push({
                    ...this.common(message),
                    kind: "notice",
                    text: `${name}: ${JSON.stringify(block.input ?? {})}`,
                    ...(todos ? { plan: todos } : {})
                });

                continue;
            }

            if (block.type === "tool_use") {

                const tool = toolTitle(block.name ?? "", block.input);

                // The agent asking is drawn as a question, not a tool
                // call (see `isAskTool`). Still recorded, so the result
                // that closes it is recognised and dropped too.
                const silent = isAskTool(block.name ?? "");

                if (block.id)
                    this.calls.set(block.id, { tool, started: Date.now(), silent });

                if (silent)
                    continue;

                const detail = describeArguments(block.input);
                const path = toolPath(block.input);

                events.push({
                    ...this.common(message),
                    kind: "tool.start",
                    tool,
                    ...(block.name ? { toolName: block.name } : {}),
                    ...(block.id ? { callId: block.id } : {}),
                    ...(detail ? { detail } : {}),
                    ...(path ? { path } : {}),
                    call: JSON.stringify(block)
                });
            }
        }

        // An assistant message can carry a turn-ending failure of its
        // own, separate from the one on the result.
        if (message.error)
            events.push({ ...this.common(message), kind: "error", message: message.error });

        return events;
    }

    /** Tool results, which arrive as user messages. */
    private user(message: Sdk<"user">): AgentEvent[] {

        const events: AgentEvent[] = [];

        // Content is a string or a list of blocks. The string form
        // carries no tool_result.
        const content = message.message.content;

        if (!Array.isArray(content))
            return [];

        for (const block of content) {

            if (block.type !== "tool_result")
                continue;

            const call = block.tool_use_id ? this.calls.get(block.tool_use_id) : undefined;

            if (block.tool_use_id)
                this.calls.delete(block.tool_use_id);

            // A to-do tool's result: a notice for the log, and the plan
            // when the call changed the task list. A failed call changes
            // nothing.
            if (call?.plan) {

                const ok = !block.is_error;
                const detail = describeToolResult(block);
                const changed = ok && this.tasks.apply(call.tool, call.plan.input, block.content);

                events.push({
                    ...this.common(message),
                    kind: "notice",
                    text: `${call.tool} ${ok ? "done" : "failed"}${detail ? ` - ${detail}` : ""}`,
                    ...(changed ? { plan: this.tasks.steps() } : {})
                });

                continue;
            }

            // The other half of a question's pair. A refusal is not
            // lost: `canUseTool` logs its own line.
            if (call?.silent)
                continue;

            const detail = describeToolResult(block);

            events.push({
                ...this.common(message),
                kind: "tool.end",
                ...(block.tool_use_id ? { callId: block.tool_use_id } : {}),
                tool: call?.tool ?? "",
                success: !block.is_error,
                ...(detail ? { detail } : {}),
                ...(call ? { ms: Date.now() - call.started } : {})
            });
        }

        return events;
    }

    /** The turn's end: what it cost, whether it failed, and that it is over. */
    private result(message: Sdk<"result">): AgentEvent[] {

        const events: AgentEvent[] = [];

        // The turn's bill, as an event so every surface watching the
        // conversation gets it - the sentence for a log, the dollar
        // difference beside it for a surface adding the session up.
        const bill = describeUsage(message);

        if (bill) {

            const sessionId = (message as { session_id?: unknown }).session_id;

            // A reopened conversation: the runtime restored its totals,
            // so the turn is measured from them, not from zero.
            if (!this.seeded && typeof sessionId === "string" && this.totals) {

                const prior = this.totals.read(sessionId);

                if (prior) {

                    this.lastCostUsd = prior.costUsd;

                    for (const [name, model] of Object.entries(prior.byModel))
                        this.lastByModel.set(name, model);
                }
            }

            this.seeded = true;

            const charged = this.charged(message);

            const models = this.chargedByModel(message);

            if (typeof sessionId === "string")
                this.totals?.write(sessionId, {
                    costUsd: this.lastCostUsd,
                    byModel: Object.fromEntries(this.lastByModel)
                });

            events.push({
                ...this.common(message),
                kind: "notice",
                text: `Turn finished - ${bill}`,
                ...(charged === undefined ? {} : { cost: [{ amount: charged, unit: "USD" }] }),
                ...(models.length ? { models } : {}),

                // The SDK's count of model round trips in this one turn -
                // a question asked through a tool and its answer stay in
                // the same turn but cost a call each.
                ...(typeof message.num_turns === "number" && message.num_turns > 0 ? { calls: message.num_turns } : {})
            });
        }

        const failure = resultFailure(message);

        if (failure)
            events.push({ ...this.common(message), kind: "error", message: failure });

        // Idle either way: AgentSessions' `untilIdle` policy waits on it.
        events.push({ ...this.common(message), kind: "idle" });

        return events;
    }

    /**
     * What this turn cost, from the running total the result carries -
     * see {@link lastCostUsd}. Undefined when the SDK sent no figure.
     */
    private charged(message: Sdk<"result">): number | undefined {

        if (typeof message.total_cost_usd !== "number")
            return undefined;

        const total = message.total_cost_usd;

        const charged = total >= this.lastCostUsd ? total - this.lastCostUsd : total;

        this.lastCostUsd = total;

        return charged;
    }

    /**
     * The same difference as {@link charged}, split by the model that
     * ran - see {@link lastByModel}. Empty when the SDK named no model,
     * and models whose totals did not move are left out, so a turn on
     * one model does not list every model the session has ever used.
     *
     * The SDK's own note says to prefer `modelUsage` over the top-level
     * `usage` for accounting: it covers sub-agents and the CLI's own
     * internal calls, which the top-level figure does not.
     */
    private chargedByModel(message: Sdk<"result">): ModelSpend[] {

        const usage = (message as { modelUsage?: Record<string, ClaudeModelUsage> }).modelUsage;

        if (!usage)
            return [];

        const charged: ModelSpend[] = [];

        for (const [name, model] of Object.entries(usage)) {

            const cost = model?.costUSD ?? 0;

            const input = (model?.inputTokens ?? 0)
                + (model?.cacheReadInputTokens ?? 0)
                + (model?.cacheCreationInputTokens ?? 0);

            const output = model?.outputTokens ?? 0;

            const cached = model?.cacheReadInputTokens ?? 0;

            const seen = this.lastByModel.get(name);
            const last = seen ?? { cost: 0, input: 0, output: 0, cached: 0 };

            // A total below the last one is a counter reset, the same
            // case {@link charged} handles - take the whole of it.
            const since = {
                cost: cost >= last.cost ? cost - last.cost : cost,
                input: input >= last.input ? input - last.input : input,
                output: output >= last.output ? output - last.output : output,
                cached: cached >= last.cached ? cached - last.cached : cached
            };

            this.lastByModel.set(name, { cost, input, output, cached });

            if (since.cost <= 0 && since.input <= 0 && since.output <= 0)
                continue;

            charged.push({
                model: model?.canonicalModel || name,
                ...(since.cost > 0 ? { cost: [{ amount: since.cost, unit: "USD" }] } : {}),
                inputTokens: since.input,
                outputTokens: since.output,
                ...(since.cached > 0 ? { cachedTokens: since.cached } : {})
            });
        }

        return charged;
    }

    /** The runtime's own notices. */
    private system(message: Sdk<"system">): AgentEvent[] {

        switch (message.subtype) {

            /*
             * Names the credential the session resolved, and any MCP
             * server that failed to connect. Neither is visible
             * anywhere else.
             */
            case "init": {

                const servers = (message.mcp_servers ?? [])
                    .filter(server => asText(server.status) && server.status !== "connected")
                    .map(server => `${asText(server.name) || "(unnamed)"} (${asText(server.status)})`);

                /*
                 * Whether the agent can ask a person anything. A missing
                 * `ask_user` is a wiring fault whose symptom (questions
                 * written as prose, then stopping) looks like a prompt
                 * problem. Named when present too, so "the tool was there
                 * and it still did not ask" is answerable from the log.
                 */
                const asking = (message.tools ?? []).find(name => isAskTool(asText(name)));

                // Every MCP server on one line, in the same form as the
                // Copilot and Kiro runtimes' - and only when it changed,
                // since `init` comes again on a resume.
                const mcp = claudeMcpText(message.mcp_servers);
                const mcpLine = mcp && mcp !== this.mcpShown ? [this.notice(message, mcp)] : [];

                if (mcp)
                    this.mcpShown = mcp;

                return [this.notice(message,
                    `Claude session ${asText(message.session_id)}: `
                    + `model=${asText(message.model) || "(default)"} `
                    + `apiKeySource=${asText(message.apiKeySource) || "(none)"} `
                    + (asking
                        ? `ask tool=${asking}`
                        : "ask tool=MISSING - this agent cannot put a question to anyone")
                    + (servers.length ? ` - MCP servers not connected: ${servers.join(", ")}` : "")), ...mcpLine];
            }

            /*
             * An agent that forgets what it was told forty turns ago was
             * compacted; without this line that looks like the model
             * failing.
             */
            case "compact_boundary": {

                const meta = message.compact_metadata ?? {};

                const sizes = [
                    typeof meta.pre_tokens === "number" ? `${tokens(meta.pre_tokens)} before` : "",
                    typeof meta.post_tokens === "number" ? `${tokens(meta.post_tokens)} after` : ""
                ].filter(Boolean);

                return [this.notice(message,
                    `Conversation compacted (${asText(meta.trigger) || "auto"})`
                    + (sizes.length ? ` - ${sizes.join(", ")}.` : "."))];
            }

            /*
             * A retry the SDK does by itself. Without this line a turn
             * that takes four minutes looks like a hang.
             */
            case "api_retry":

                return [this.notice(message,
                    `Retrying the API call (attempt ${message.attempt ?? "?"} of `
                    + `${message.max_retries ?? "?"})`
                    + (message.error_status ? `, status ${message.error_status}` : "")
                    + (asText(message.error) ? `: ${asText(message.error)}` : "")
                    + (typeof message.retry_delay_ms === "number"
                        ? ` - waiting ${describeDuration(message.retry_delay_ms)}.`
                        : "."))];

            /* The Task tool's sub-agents, which the SDK calls tasks. */
            case "task_started": {

                const label = asText(message.subagent_type)
                    || asText(message.task_type)
                    || "sub-agent";

                for (const key of [asText(message.task_id), asText(message.tool_use_id)])
                    if (key)
                        this.agents.set(key, label);

                const where = message.is_backgrounded ? " in the background" : "";

                const depth = typeof message.spawn_depth === "number" && message.spawn_depth > 1
                    ? ` at depth ${message.spawn_depth}`
                    : "";

                return [this.about(message,
                    `Sub-agent ${label} started${where}${depth}`
                    + (asText(message.description)
                        ? `: ${clip(asText(message.description), VALUE_LIMIT)}`
                        : ""))];
            }

            /*
             * The AI-written `summary` needs `agentProgressSummaries`,
             * which costs money and is off. The counters and the last
             * tool name arrive either way.
             */
            case "task_progress": {

                const label = this.agentLabel(message) ?? "sub-agent";

                const progress = [
                    countOf(message.usage?.tool_uses, "tool call"),
                    typeof message.usage?.total_tokens === "number"
                        ? `${tokens(message.usage.total_tokens)} tokens`
                        : "",
                    asText(message.last_tool_name) ? `last ${asText(message.last_tool_name)}` : ""
                ].filter(Boolean);

                // A heartbeat. The log takes every one; a surface
                // drawing a conversation replaces the last one.
                return [this.about(message,
                    `Sub-agent ${label}: `
                    + (asText(message.summary)
                        ? clip(asText(message.summary), VALUE_LIMIT)
                        : clip(asText(message.description), VALUE_LIMIT) || "working")
                    + (progress.length ? ` (${progress.join(", ")})` : ""),
                    true)];
            }

            case "task_notification": {

                const label = this.agentLabel(message) ?? "sub-agent";

                const stats = [
                    countOf(message.usage?.tool_uses, "tool call"),
                    typeof message.usage?.total_tokens === "number"
                        ? `${tokens(message.usage.total_tokens)} tokens`
                        : "",
                    typeof message.usage?.duration_ms === "number"
                        ? describeDuration(message.usage.duration_ms)
                        : ""
                ].filter(Boolean);

                this.forget(message);

                const line = `Sub-agent ${label} ${asText(message.status) || "finished"}`
                    + (stats.length ? ` - ${stats.join(", ")}` : "")
                    + (asText(message.summary) ? `: ${clip(asText(message.summary), VALUE_LIMIT)}` : "");

                // A failed sub-agent does not fail the task: the main
                // agent gets the failure back as a tool result and
                // decides what to do.
                return [message.status === "failed"
                    ? { name: name(message), raw: message, kind: "error", message: line }
                    : this.about(message, line)];
            }

            /* Only the transitions worth a line: a status change, or a failure. */
            case "task_updated": {

                const patch = message.patch ?? {};

                if (!patch.status && !patch.error)
                    return [this.other(message)];

                const label = this.agentLabel(message) ?? "sub-agent";

                return [this.about(message,
                    `Sub-agent ${label} is now ${patch.status ?? "in trouble"}`
                    + (patch.error ? `: ${clip(patch.error, VALUE_LIMIT)}` : "."))];
            }

            /*
             * A denial means something other than the jail refused: a
             * hook, a managed policy, a sandbox. Must not be silent.
             */
            case "permission_denied": {

                const denial = message as unknown as {
                    tool_name?: string;
                    message?: string;
                    decision_reason?: string;
                };

                return [this.notice(message,
                    `Permission denied for ${asText(denial.tool_name) || "a tool"}`
                    + (asText(denial.message) || asText(denial.decision_reason)
                        ? `: ${clip(asText(denial.message) || asText(denial.decision_reason), VALUE_LIMIT)}`
                        : "."))];
            }

            /* The CLI's own advice to whoever is watching. */
            case "informational":

                return asText(message.content)
                    ? [this.notice(message,
                        `${asText(message.level) || "info"}: `
                        + clip(asText(message.content), LINE_LIMIT))]
                    : [this.other(message)];

            case "notification":

                return asText(message.text)
                    ? [this.notice(message, clip(asText(message.text), LINE_LIMIT))]
                    : [this.other(message)];

            /* `requesting` fires on every API call and is dropped; compaction is kept. */
            case "status":

                if (message.status === "compacting")
                    return [this.notice(message, "Compacting the conversation...")];

                if (message.compact_result)
                    return [this.notice(message,
                        `Compaction ${message.compact_result}`
                        + (asText(message.compact_error)
                            ? `: ${clip(asText(message.compact_error), VALUE_LIMIT)}`
                            : "."))];

                return [this.other(message)];

            /* A refusal ends the turn, and nothing else says why. */
            case "model_refusal_fallback":

                return [this.notice(message,
                    `${asText(message.original_model) || "The model"} refused - falling back to `
                    + `${asText(message.fallback_model) || "another model"}`
                    + (asText(message.api_refusal_explanation)
                        ? `: ${clip(asText(message.api_refusal_explanation), VALUE_LIMIT)}`
                        : "."))];

            case "model_refusal_no_fallback":

                return [{
                    ...this.common(message),
                    kind: "error",
                    message: `${asText(message.original_model) || "The model"} refused and there is `
                        + "no fallback"
                        + (asText(message.api_refusal_explanation)
                            ? `: ${clip(asText(message.api_refusal_explanation), VALUE_LIMIT)}`
                            : ".")
                }];

            /*
             * Hooks are the user's own code inside the turn. Only
             * `hook_progress` arrives without `includeHookEvents`; the
             * other two are handled so a task can turn that option on
             * through `extra:`.
             */
            case "hook_started":

                return [this.notice(message,
                    `Hook ${asText(message.hook_name) || "(unnamed)"} started `
                    + `on ${asText(message.hook_event) || "an event"}.`)];

            case "hook_progress":

                return [this.notice(message,
                    `Hook ${asText(message.hook_name) || "(unnamed)"} is still running.`)];

            case "hook_response":

                return [this.notice(message,
                    `Hook ${asText(message.hook_name) || "(unnamed)"} `
                    + `${asText(message.outcome) || "finished"}`
                    + (typeof message.exit_code === "number" ? ` (exit ${message.exit_code})` : "")
                    + (asText(message.stderr) ? `: ${clip(asText(message.stderr), VALUE_LIMIT)}` : "."))];

            /* What the agent was reminded of before it started. */
            case "memory_recall": {

                const paths = (message.memories ?? []).map(memory => asText(memory.path)).filter(Boolean);

                return paths.length
                    ? [this.notice(message,
                        `Recalled ${paths.length} memory file(s): `
                        + clip(paths.join(", "), LINE_LIMIT))]
                    : [this.other(message)];
            }

            case "local_command_output":

                return asText(message.content)
                    ? [this.notice(message, clip(asText(message.content), LINE_LIMIT))]
                    : [this.other(message)];

            /* The SDK's own words: transcript data was dropped. */
            case "mirror_error":

                return [{
                    ...this.common(message),
                    kind: "error",
                    message: `The session transcript could not be written: `
                        + `${asText(message.error) || "no reason given."}`
                }];

            default:

                return [this.other(message)];
        }
    }

    /** One speaker's buffer for one channel. See {@link streamed}; same key as `CopilotProvider.bufferKey`. */
    private paintKey(message: SDKMessage, channel: DeltaChannel): string {

        return `${this.attribution(message) ?? ""}|${channel}`;
    }

    /** The fields every translated event carries, attribution included. */
    private common(message: SDKMessage): { name: string; raw: unknown; agent?: string } {

        const agent = this.attribution(message);

        return agent
            ? { name: name(message), raw: message, agent }
            : { name: name(message), raw: message };
    }

    private notice(message: SDKMessage, text: string): AgentEvent {

        return { ...this.common(message), kind: "notice", text };
    }

    /**
     * Lifecycle notices, which are about a sub-agent rather than from
     * one, so they carry no attribution. The `task_*` messages name
     * their agent in `subagent_type`, and through {@link common} that
     * came out as "[Explore] Sub-agent Explore started".
     */
    private about(message: SDKMessage, text: string, progress = false): AgentEvent {

        return {
            name: name(message),
            raw: message,
            kind: "notice",
            text,

            // A heartbeat replaces the last one; see the `notice` event.
            ...(progress ? { progress: true } : {})
        };
    }

    private other(message: SDKMessage): AgentEvent {

        return { ...this.common(message), kind: "other" };
    }

    /**
     * Whose message this is.
     *
     * `subagent_type` is the SDK's own answer; `parent_tool_use_id` is
     * the fallback, non-null exactly when a sub-agent produced the
     * message. An id with no registered label still gets one, because a
     * forwarded message whose `task_started` was missed is still not the
     * main agent talking.
     *
     * A sub-agent's text and thinking arrive only because
     * `sessionOptions` sets `forwardSubagentText`.
     */
    private attribution(message: SDKMessage): string | undefined {

        const declared = "subagent_type" in message ? asText(message.subagent_type) : "";

        if (declared)
            return declared;

        const parent = "parent_tool_use_id" in message ? asText(message.parent_tool_use_id) : "";

        if (!parent)
            return undefined;

        return this.agents.get(parent) ?? `sub-agent ${parent.slice(0, 8)}`;
    }

    /** A running sub-agent's label, by either id a message names it with. */
    private agentLabel(message: SDKMessage): string | undefined {

        const [task, call] = agentIds(message);

        return ("subagent_type" in message ? asText(message.subagent_type) : "")
            || this.agents.get(task)
            || this.agents.get(call);
    }

    /** A finished sub-agent is never referenced again; its labels go with it. */
    private forget(message: SDKMessage): void {

        for (const key of agentIds(message))
            if (key)
                this.agents.delete(key);
    }
}

/**
 * What a tool returned, short enough for a log line. Content is a
 * string for most tools and a list of blocks for the rest; only `text`
 * blocks contribute, since an image or document has no text to log.
 */
export function describeToolResult(block: SdkToolResult): string | undefined {

    const content = block.content;

    if (typeof content === "string")
        return clip(content, VALUE_LIMIT) || undefined;

    if (!Array.isArray(content))
        return undefined;

    const text = content
        .map(part => part.type === "text" ? part.text : "")
        .filter(Boolean)
        .join(" ");

    return clip(text, VALUE_LIMIT) || undefined;
}

/** `type`, or `type/subtype` where the SDK uses one. */
function name(message: SDKMessage): string {

    const subtype = "subtype" in message ? asText(message.subtype) : "";

    return subtype ? `${message.type}/${subtype}` : message.type;
}

/**
 * The two ids a message might name a sub-agent by: the task's own, and
 * the `tool_use_id` of the Task call that spawned it.
 */
function agentIds(message: SDKMessage): [task: string, call: string] {

    return [
        "task_id" in message ? asText(message.task_id) : "",
        "tool_use_id" in message ? asText(message.tool_use_id) : ""
    ];
}

/** One entry of the result's `modelUsage`, as much of it as the bill reads. */
interface ClaudeModelUsage {

    costUSD?: number;

    inputTokens?: number;

    outputTokens?: number;

    cacheReadInputTokens?: number;

    cacheCreationInputTokens?: number;

    /** The id used for the pricing lookup, which is the one worth showing. */
    canonicalModel?: string;
}

/**
 * The CLI's `/context` report, as `getContextUsage` returns it. Only the
 * fields the meter reads; the SDK's own type has many more.
 */
export interface ContextReport {

    totalTokens?: number;

    rawMaxTokens?: number;

    maxTokens?: number;

    /** `kind` came with newer CLIs; older ones only have the name and `isDeferred`. */
    categories?: { name?: string; tokens?: number; isDeferred?: boolean; kind?: string }[];

    /* The lists behind each category - what `/context all` prints below the grid. */

    systemPromptSections?: { name?: string; tokens?: number }[];

    systemTools?: { name?: string; tokens?: number }[];

    mcpTools?: { name?: string; serverName?: string; tokens?: number; isLoaded?: boolean }[];

    memoryFiles?: { path?: string; type?: string; tokens?: number }[];

    skills?: { skillFrontmatter?: { name?: string; source?: string; tokens?: number }[] };

    agents?: { agentType?: string; source?: string; tokens?: number }[];

    messageBreakdown?: {
        toolCallTokens?: number;
        toolResultTokens?: number;
        attachmentTokens?: number;
        assistantMessageTokens?: number;
        userMessageTokens?: number;
        redirectedContextTokens?: number;
        unattributedTokens?: number;
    };
}

/**
 * The report as a {@link ContextUsage}, or undefined when it has no
 * window size to measure against.
 *
 * Deferred tool schemas sit outside the window and are left out of the
 * parts; free space and the compaction buffer are too, because they
 * are what is *not* used and the surface draws that from `size`.
 * Each part gets the list the report keeps for it, so the meter can
 * open "Memory files" into the files, "MCP tools" into the tools, and
 * so on.
 */
export function contextUsageOf(report: ContextReport | undefined): ContextUsage | undefined {

    const size = report?.rawMaxTokens ?? report?.maxTokens;

    if (!report || typeof size !== "number" || size <= 0 || typeof report.totalTokens !== "number")
        return undefined;

    const parts = (report.categories ?? [])
        .filter(inWindow)
        .filter(category => typeof category.tokens === "number" && category.tokens > 0)
        .map(category => {

            const name = category.name ?? "Other";

            const items = itemsOf(report, name);

            return { name, tokens: category.tokens as number, ...(items.length ? { items } : {}) };
        });

    return { used: report.totalTokens, size, ...(parts.length ? { parts } : {}) };
}

/**
 * Whether a category fills the window. Uses the report's own `kind`
 * when it has one; an older CLI without it is judged by name.
 */
function inWindow(category: NonNullable<ContextReport["categories"]>[number]): boolean {

    if (category.kind)
        return category.kind === "used";

    return !category.isDeferred && !/^(free space|autocompact buffer|manual compact buffer)$/i.test(category.name ?? "");
}

/** The things inside one category, biggest first, with empty ones left out. */
function itemsOf(report: ContextReport, category: string): ContextItem[] {

    const rows = (list: { name?: string; tokens?: number; note?: string }[] | undefined): ContextItem[] =>
        (list ?? [])
            .filter(row => row.name && typeof row.tokens === "number" && row.tokens > 0)
            .map(row => ({ name: row.name as string, tokens: row.tokens as number, ...(row.note ? { note: row.note } : {}) }))
            .sort((left, right) => right.tokens - left.tokens);

    switch (category.toLowerCase()) {

        case "system prompt":
            return rows(report.systemPromptSections);

        case "system tools":
            return rows(report.systemTools);

        case "mcp tools":
            // Only tools in the window; the rest are counted under the deferred row.
            return rows(report.mcpTools?.filter(tool => tool.isLoaded !== false));

        case "memory files":
            return rows(report.memoryFiles?.map(file => ({ name: file.path, tokens: file.tokens, note: file.type })));

        case "skills":
            return rows(report.skills?.skillFrontmatter);

        case "custom agents":
            return rows(report.agents?.map(agent => ({ name: agent.agentType, tokens: agent.tokens })));

        case "messages": {

            const split = report.messageBreakdown;

            return rows(split && [
                { name: "Tool calls", tokens: split.toolCallTokens },
                { name: "Tool results", tokens: split.toolResultTokens },
                { name: "Attachments", tokens: split.attachmentTokens },
                { name: "Assistant messages", tokens: split.assistantMessageTokens },
                { name: "User messages", tokens: split.userMessageTokens },
                { name: "Redirected context", tokens: split.redirectedContextTokens },
                { name: "Other", tokens: split.unattributedTokens }
            ]);
        }

        default:
            return [];
    }
}

/**
 * How long a turn will wait for the CLI's context report before
 * finishing without one.
 *
 * The turn is over and the process is idle, so an answer takes
 * milliseconds. This is the ceiling for a CLI that never answers at
 * all - long enough not to lose a slow one, short enough that nobody
 * watching thinks the turn has hung.
 */
const CONTEXT_TIMEOUT_MS = 3000;

/** The id this runtime is registered under - what its slash commands are kept as. */
const CLAUDE_RUNTIME = "claude";

/**
 * How long to wait for Claude's own title for the chat - a read of the
 * session's file on this machine, so it normally takes a few
 * milliseconds. See {@link ClaudeAgentSession.reportTitle}.
 */
const TITLE_TIMEOUT_MS = 2000;

/** `work`, or a rejection once `ms` has passed - whichever lands first. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {

    return new Promise<T>((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(`No answer within ${ms}ms.`)), ms);

        work.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); });
    });
}

/** `used` as a whole-number share of `size`. */
function percent(used: number, size: number): number {

    return size > 0 ? Math.round((used / size) * 100) : 0;
}

/**
 * The result message's usage fields as one line, or undefined when the
 * SDK sent none. Cache reads are folded into "in"; the dollar figure
 * beside it is the SDK's own.
 */
function describeUsage(message: Sdk<"result">): string | undefined {

    const parts: string[] = [];

    if (message.usage) {

        const read = (message.usage.input_tokens ?? 0)
            + (message.usage.cache_read_input_tokens ?? 0)
            + (message.usage.cache_creation_input_tokens ?? 0);

        parts.push(`tokens in=${read} out=${message.usage.output_tokens ?? 0}`);
    }

    if (typeof message.total_cost_usd === "number")
        parts.push(`cost=$${message.total_cost_usd.toFixed(4)}`);

    if (typeof message.num_turns === "number")
        parts.push(`turns=${message.num_turns}`);

    if (typeof message.duration_ms === "number")
        parts.push(`took=${describeDuration(message.duration_ms)}`);

    return parts.length ? parts.join(" ") : undefined;
}

/**
 * Whether a result message says the turn failed, and what it said.
 *
 * Two ways it can: an error subtype, or `subtype: "success"` carrying
 * `is_error: true`, which is how a turn that ended on an API error
 * arrives.
 */
function resultFailure(message: Sdk<"result">): string | undefined {

    if (message.subtype && message.subtype !== "success")
        return message.errors?.join("; ") || `The session ended: ${message.subtype}`;

    if (message.is_error)
        return message.result || "The session reported an error.";

    return undefined;
}


/**
 * An engine message as the SDK's user message.
 *
 * Attachments become paths named in the prompt: this SDK has no
 * file-attachment field, and its agent reads files with the Read tool.
 */
function sdkMessage(message: AgentMessage, sessionId: string): SDKUserMessage {

    const attachments = message.attachments ?? [];

    const content = attachments.length
        ? `${message.prompt}\n\nAttached files (read these first):\n`
        + attachments.map(a => `- ${a.name ? `${a.name}: ` : ""}${a.path}`).join("\n")
        : message.prompt;

    return {
        type: "user",
        message: { role: "user", content },
        parent_tool_use_id: null,
        session_id: sessionId
    };
}

/**
 * The session options, with the task's own `extra` applied last:
 * {@link AgentSessionConfig.extra} promises that a key named there
 * overrides what the provider set. Exported for the tests; building the
 * object starts no process.
 */
/**
 * The model to name to the SDK, or nothing. Unset, blank and "auto" all
 * leave the choice to the CLI: "auto" is the picker's word for "no
 * choice", the same as the ACP runtimes read it, and sent as a name the
 * API refuses it as a model that does not exist (`model_not_found`).
 */
export function chosenModel(model: string | undefined): string | undefined {

    const name = model?.trim();

    return name && name !== "auto" ? name : undefined;
}

/**
 * Adds the host's tools to take away (see `ProviderDeps.toolsOff`) to
 * the options' blocked list, keeping what is already there.
 *
 * Exported for tests.
 */
export function withToolsOff(options: Record<string, unknown>, off: readonly string[] | undefined): void {

    if (!off?.length)
        return;

    const blocked = Array.isArray(options.disallowedTools) ? options.disallowedTools as string[] : [];

    options.disallowedTools = [...new Set([...blocked, ...off])];
}

export function sessionOptions(
    config: AgentSessionConfig,
    sessionId: string,
    env: Record<string, string>,
    abortController: AbortController,
    directories?: string[],
    mcp?: McpResolution,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void,
    askServer?: ReturnType<typeof createSdkMcpServer>,

    /** `debug` from the profile settings: the one thing that opens the jail. */
    debug = false,

    /** The app's `resources` directory, readable but not writable. See `createJail`. */
    resources?: string,

    /** The CLI executable, from {@link cliBinary}. Unset only in tests that never spawn. */
    binary?: string,

    /**
     * Told of each call `canUseTool` allows, with what it asked for, so
     * the chat thread can show calls that ran without a card. `callId`
     * is the SDK's `toolUseID`: the id the call's own row carries.
     */
    allowed?: (permission: AskPermission, raw: unknown, callId?: string) => void,

    /**
     * Our own permission check, and the way to put a card to
     * the person. With it, the `PreToolUse` hook decides every call and
     * `canUseTool` shows the card.
     */
    checked?: { gate: PermissionGate; ask?: AskHook }
): Record<string, unknown> {

    /*
     * Built from the same values the SDK is handed below, so the scope
     * the session is told about and the scope enforced cannot drift.
     *
     * `debug` opens it. It is profile-only (the loader rejects it in a
     * workspace file), so the switch cannot arrive with a repository.
     * The session logs which of the two it got.
     */
    const jail = debug
        ? openJail(config.workingDirectory, directories, engineDirectories(resources))
        : createJail(config.workingDirectory, directories, undefined, engineDirectories(resources));

    if (debug)
        log?.(
            "debug: true in your profile settings - this session may read and write anywhere,"
            + ` not only ${jail.roots.join(", ")}.`,
            "system");

    // The projects' own instructions first, so the task's situation
    // reads last and closest to the turn. `systemInstructions` last of
    // all: it is the caller's own words, the most specific thing here.
    const append = [
        projectMemory(jail.roots),
        config.interactive === true ? ASK_SYSTEM_PROMPT : undefined,
        config.target ? targetSystemPrompt(config.target, config.workingDirectory) : undefined,
        config.systemInstructions
    ].filter((one): one is string => typeof one === "string" && one.length > 0);

    /*
     * Typed as the SDK's own `Options`, the only thing that checks the
     * key names. The SDK silently ignores an option it does not
     * recognise.
     */
    const ours: Options = {

        cwd: config.workingDirectory,

        // The CLI this machine has - see `claudeCli`. Left unset, the
        // SDK looks beside itself, which only a source checkout can
        // satisfy.
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),

        // The SDK rejects the two together unless `forkSession` is set,
        // and forking mints a new id, which a caller resuming a
        // conversation does not want.
        ...(config.resume ? { resume: config.resume } : { sessionId }),

        /*
         * `CLAUDE_CODE_ENABLE_TODO_TOOLS` turns on Claude's to-do tools,
         * which the chat's plan strip is built from. From CLI v2.1.268
         * they are on by default only for Opus 4.7, Sonnet 4.6, Haiku
         * 4.5 and older models; every newer model gets none unless this
         * is set. A value already in the environment wins.
         */
        env: { CLAUDE_CODE_ENABLE_TODO_TOOLS: "1", ...env },

        abortController,

        /*
         * No settings file on disk gets a say in what this session may
         * reach. Left unset, the SDK loads `~/.claude/settings.json`,
         * `.claude/settings.json` and `.claude/settings.local.json`,
         * each of which can widen the scope (`additionalDirectories`),
         * allow a tool call outright (`permissions.allow`), or set
         * `bypassPermissions`. All of those resolve before `canUseTool`
         * is called, and a file in the repository being worked on
         * arrives with a clone. The engine's own `settings.json` is the
         * only source.
         *
         * The cost: `project` is also what loads `CLAUDE.md`, so it is
         * read by {@link projectMemory} instead. Managed settings are
         * still read from disk.
         */
        settingSources: [],

        // Plan, when picked in the compose box - see `CLAUDE_MODES`. Held
        // against `extra` with the other permission keys below.
        ...(claudeMode(config.agentMode) === "plan" ? { permissionMode: "plan" as const } : {}),

        // How hard the model thinks, when picked - see `claudeEffort`.
        ...(claudeEffort(config.effort, log) ? { effort: claudeEffort(config.effort) } : {}),

        /*
         * The shell, contained by the operating system. Everything else
         * here inspects a tool call's arguments, and a shell command has
         * none worth inspecting: `cd .. && cat secrets` names no path.
         *
         * `allowUnsandboxedCommands: false` because
         * `dangerouslyDisableSandbox` is a field on the Bash tool's own
         * input, so the model could opt itself out one call at a time.
         *
         * `failIfUnavailable: false` because the Windows sandbox can be
         * gated off, and the CLI answers a required but
         * unavailable sandbox by killing the session ("Sandbox required
         * but unavailable ... feature gate off"). So the sandbox is used
         * where available, and where not the shell runs uncontained.
         * `sandboxState` logs a line when that happens. The file tools
         * are held either way by the hook and the permission gate.
         */
        sandbox: {

            // Off under `debug`, with the rest of the boundary: a
            // sandbox still confining the shell while every path check
            // is open is a half-state.
            enabled: !debug,
            failIfUnavailable: false,
            allowUnsandboxedCommands: false
        },

        /*
         * The sandbox does not confine reads to the roots on its own.
         * Writes are an allowlist (`allowWrite` is additional paths),
         * but reads are a denylist, open unless `denyRead` says
         * otherwise. `allowManagedReadPathsOnly` flips reads to an
         * allowlist, and it is only honoured from the managed tier,
         * hence `managedSettings`, which the SDK documents for embedding
         * applications that need to enforce lockdown on the subprocess.
         */
        ...(debug
            ? {}
            : {
                managedSettings: {
                    sandbox: {
                        filesystem: {
                            allowRead: [...jail.roots],
                            allowWrite: [...jail.roots],
                            allowManagedReadPathsOnly: true
                        }
                    }
                }
            }),

        additionalDirectories: directories,

        /*
         * The answer as it is written, for the AI Session tab. Deltas
         * are ephemeral (see the `delta` event); the complete
         * `assistant` message is still what the run records.
         */
        includePartialMessages: true,

        /*
         * The jail, at the layer that holds. `canUseTool` below is only
         * consulted for calls that reach a permission prompt; an `allow`
         * rule, a path already in scope, or `bypassPermissions` resolve
         * before it. A `PreToolUse` hook runs before the tool executes
         * whatever decided it, so this gate cannot be routed around and
         * `canUseTool` is the second line. Both read the same jail and
         * cannot disagree.
         */
        hooks: {
            PreToolUse: [{
                hooks: [async input => {

                    const call = input as { tool_name?: string; tool_input?: unknown; tool_use_id?: string };

                    // Our own check decides every call. "Ask" goes on to
                    // `canUseTool`, which has no time limit for a person.
                    if (checked) {

                        const tool = call.tool_name ?? "tool";
                        const decision = checked.gate.decide(claudeCall(tool, call.tool_input), jail);

                        if (decision.verdict === "ask")
                            return {
                                continue: true,
                                hookSpecificOutput: {
                                    hookEventName: "PreToolUse" as const,
                                    permissionDecision: "ask" as const,
                                    permissionDecisionReason: decision.card.title
                                }
                            };

                        const shown = claudePermission(tool, call.tool_input);

                        if (decision.verdict === "deny") {

                            log?.(`Denied ${tool}: ${decision.note}`, "system");

                            allowed?.(gatePermission(tool, shown.input, { note: decision.note, refused: true }), call, call.tool_use_id);

                            return {
                                continue: true,
                                hookSpecificOutput: {
                                    hookEventName: "PreToolUse" as const,
                                    permissionDecision: "deny" as const,
                                    permissionDecisionReason: decision.reason
                                }
                            };
                        }

                        if (decision.note)
                            allowed?.(gatePermission(tool, shown.input, { note: decision.note }), call, call.tool_use_id);

                        // No decision, not "allow": the SDK's own rules
                        // still run (plan mode stays read-only), and a
                        // call it would prompt for reaches `canUseTool`,
                        // which decides the same way and lets it through.
                        return { continue: true };
                    }

                    const escape = jail.escape(call.tool_input, undefined, claudeWrites(call.tool_name));

                    if (!escape)
                        return { continue: true };

                    log?.(
                        `Denied ${call.tool_name ?? "a tool call"}: `
                        + `${escape.asked} is outside ${jail.roots.join(", ")}`,
                        "system");

                    return {
                        continue: true,
                        hookSpecificOutput: {
                            hookEventName: "PreToolUse" as const,
                            permissionDecision: "deny" as const,
                            permissionDecisionReason: jail.refusal(escape)
                        }
                    };
                }]
            }]
        },

        /*
         * Approved unattended, but only inside the jail's roots. The SDK
         * turns an out-of-scope path into a permission request rather
         * than a refusal, so an unconditional allow would approve every
         * escape. Not `permissionMode: "bypassPermissions"`: the SDK
         * documents fall-throughs bypass does not cover (MCP tools
         * flagged as needing a person) and says the callback is never
         * invoked under it, so such a call would hang until `timeout:`.
         */
        canUseTool: async (tool, input, options) => {

            // Our own check: the hook said "ask", so this is where the
            // card goes. Decided again here, the same way, so a call that
            // reaches this some other way is held to the same rules.
            if (checked) {

                const call = claudeCall(tool, input);
                const shown = claudePermission(tool, input);
                const decision = checked.gate.decide(
                    options?.blockedPath ? { ...call, paths: [...(call.paths ?? []), options.blockedPath] } : call,
                    jail);

                // The hook already put the note on the call's row.
                if (decision.verdict === "allow")
                    return { behavior: "allow" as const };

                if (decision.verdict === "deny") {

                    log?.(`Denied ${tool}: ${decision.note}`, "system");

                    allowed?.(gatePermission(tool, shown.input, { note: decision.note, refused: true }), { tool, input }, options?.toolUseID);

                    return { behavior: "deny" as const, message: decision.reason };
                }

                // Nobody watching: the same fallback as Copilot and ACP. A
                // path outside the folders stays refused; the rest is
                // allowed once, and the log says so.
                if (!checked.ask) {

                    if (decision.card.type === "outside") {

                        log?.(`Denied ${tool}: ${decision.card.shown} is outside the chat's folders, and nobody is watching to ask.`, "system");

                        return { behavior: "deny" as const, message: `Denied: ${decision.card.shown} is outside the directories this session may use.` };
                    }

                    log?.("A permission card is due, but nobody is watching this session, so the request was allowed once.", "system");

                    return { behavior: "allow" as const };
                }

                const answer = await askCard(checked.ask, checked.gate, call, decision.card, shown.input);

                if (!answer) {

                    log?.(`${tool}: ${UNANSWERED_TEXT}`, "system");

                    allowed?.(gatePermission(tool, shown.input, { note: UNANSWERED_NOTE, refused: true }), { tool, input }, options?.toolUseID);

                    return { behavior: "deny" as const, message: UNANSWERED_TEXT };
                }

                allowed?.(
                    gatePermission(tool, shown.input, { note: answer.note, ...(answer.allow ? {} : { refused: true }) }),
                    { tool, input }, options?.toolUseID);

                log?.(`Permission card (${tool}) answered: ${answer.note}`, "system");

                return answer.allow
                    ? { behavior: "allow" as const }
                    : { behavior: "deny" as const, message: deniedText(answer) };
            }

            const escape = jail.escape(input, options?.blockedPath, claudeWrites(tool));

            if (!escape) {

                allowed?.(claudePermission(tool, input), { tool, input }, options?.toolUseID);

                return { behavior: "allow" as const };
            }

            log?.(`Denied ${tool}: ${escape.asked} is outside ${jail.roots.join(", ")}`, "system");

            // `interrupt` is left off: a refusal the agent can read is
            // one it can work around; ending the turn would kill a task
            // over a single wrong path.
            return { behavior: "deny" as const, message: jail.refusal(escape) };
        },

        /*
         * The vendor's question tool cannot ask for free text (its
         * schema demands two to four options), so a model holding it
         * asks open questions in prose instead. Ours takes its place.
         */
        disallowedTools: ["AskUserQuestion"],

        /*
         * Appended to the CLI's own preset. Either part can be absent:
         * the projects' `CLAUDE.md` (see {@link projectMemory}), and
         * that somebody is there to answer, only when a person really
         * is watching.
         */
        ...(append.length
            ? {
                systemPrompt: {
                    type: "preset" as const,
                    preset: "claude_code" as const,
                    append: append.join("\n\n")
                }
            }
            : {}),

        /*
         * The child's diagnostics go to the run log. The CLI says on
         * stderr when it wanted a sandbox and could not have one; see
         * {@link sandboxState}.
         */
        stderr: (text: string) => {

            log?.(text.trimEnd(), "stderr");

            const state = sandboxState(text);

            if (state)
                log?.(state, "system");
        },

        /*
         * A sub-agent's text and thinking, not just its tool calls. The
         * SDK's default forwards only tool_use and tool_result blocks.
         * Forwarded messages carry `parent_tool_use_id`, which is what
         * `ClaudeEventTranslator` credits them by. Free, unlike
         * `agentProgressSummaries`, which forks each sub-agent every
         * thirty seconds and is left off; a task can set it via `extra:`.
         */
        forwardSubagentText: true,

        // `model` is a first-class field and never arrives through
        // `extra`. Omitted when unset, or "auto", so the CLI's own
        // configured model stands - see `chosenModel`.
        ...(chosenModel(config.model) ? { model: chosenModel(config.model) } : {})
    };

    /*
     * `extra` applied last so it overrides anything above. It is
     * arbitrary YAML and cannot be checked against `Options`, so the
     * merged object is a plain record.
     */
    const options: Record<string, unknown> = { ...ours, ...(config.extra ?? {}) };

    // MCP servers are machine setup, not workflow definition. The only
    // source is `settings.json`'s `ai.mcpServers`, added below.
    delete options.mcpServers;

    /*
     * The jail cannot be unlocked from the file it confines. Each of
     * these keys is a way out: `canUseTool` replaces the check,
     * `permissionMode: "bypassPermissions"` stops it being called, and
     * the rest widen or move the roots.
     *
     * The second group gets past it too: `allowDangerouslySkipPermissions`
     * and `allowedTools` approve calls before `canUseTool` sees them,
     * `permissionPromptToolName` hands the question to another tool,
     * `extraArgs` passes raw CLI flags (`--permission-mode`, `--settings`,
     * `--add-dir`), `env` replaces the masked environment, the executable
     * keys run another program in the CLI's place, `projectConfigRoot`
     * loads another checkout's settings and hooks, and `plugins` bring
     * hooks of their own.
     */
    const ourKeys = ours as Record<string, unknown>;

    for (const key of [
        "canUseTool",
        "permissionMode",
        "additionalDirectories",
        "cwd",
        "settings",
        "settingSources",
        "hooks",
        "sandbox",
        "managedSettings",
        "allowDangerouslySkipPermissions",
        "allowedTools",
        "permissionPromptToolName",
        "extraArgs",
        "env",
        "executable",
        "executableArgs",
        "pathToClaudeCodeExecutable",
        "spawnClaudeCodeProcess",
        "projectConfigRoot",
        "plugins"
    ]) {

        if (!(key in options) || options[key] === ourKeys[key])
            continue;

        log?.(`Ignored ${key} from extra: it could let the agent past the folders this session may use.`, "system");

        // Put ours back where there was one, and delete the key where
        // there was not: an explicit `undefined` and an absent key are
        // different to the SDK.
        if (key in ourKeys)
            options[key] = ourKeys[key];
        else
            delete options[key];
    }

    /*
     * `systemInstructions` is the one channel for standing instruction -
     * see `AgentSessionConfig.systemInstructions`. It always appends,
     * into `ours.systemPrompt` above, so a passthrough naming either
     * provider's own field directly is ignored rather than merged:
     * `systemPrompt` would replace this provider's own guardrail append
     * outright, and `systemMessage` (the other provider's name for the
     * same idea) would do nothing here but silently promise otherwise.
     */
    for (const key of ["systemPrompt", "systemMessage"]) {

        if (!(key in options) || options[key] === ourKeys[key])
            continue;

        log?.(
            `Ignored '${key}' from extra: standing instructions go through 'systemInstructions', which `
            + "always appends rather than replaces.", "system");

        if (key in ourKeys)
            options[key] = ourKeys[key];
        else
            delete options[key];
    }

    // Normalized so a portably-written `command: npx` starts on Windows.
    const servers: Record<string, unknown> = mcp && Object.keys(mcp.servers).length
        ? normalizeMcpServers(mcp.servers, { dialect: "claude" }) as Record<string, unknown>
        : {};

    // Ours goes on after the settings-declared ones so a settings file
    // cannot displace the agent's only way to ask a question.
    if (askServer)
        servers[ASK_SERVER_NAME] = askServer;

    // Only when there is something to add; an empty record means
    // something else to the SDK.
    if (Object.keys(servers).length)
        options.mcpServers = servers;

    return options;
}


/**
 * A sentence about the shell, from the CLI's own stderr, or `undefined`
 * when the line was about something else. Where the sandbox starts, a
 * shell command is confined to the session's directories; where it does
 * not, it can reach anywhere the user can, and only one stderr line
 * says which happened.
 *
 * Matched loosely: the wording is the vendor's and will change. A
 * missed line costs a log line, not a boundary.
 */
export function sandboxState(text: string): string | undefined {

    if (!/sandbox/i.test(text))
        return undefined;

    if (/unavailable|not active|could not|failed|disabled|unsupported/i.test(text))
        return "The OS sandbox did not start, so shell commands in this session are NOT confined to its"
            + " directories. File reads and writes still are. See pathJail.ts.";

    return undefined;
}

/**
 * What a `canUseTool` call asks to run: the tool, and its input as sent.
 * A shell command is shown as the command itself, since that is what a
 * person reads; anything else as its JSON.
 */
export function claudePermission(tool: string, input: unknown): AskPermission {

    const command = (input as { command?: unknown } | undefined)?.command;

    if (typeof command === "string")
        return { tool, input: command };

    let text: string | undefined;

    try {

        text = input === undefined ? undefined : JSON.stringify(input, null, 2);

    } catch {

        text = undefined;
    }

    return { tool, ...(text && text !== "{}" ? { input: text } : {}) };
}

/**
 * The session options as text, every key as sent. Handlers are named
 * rather than dropped, and an explicit `undefined` is shown as
 * `[unset]` because absent and undefined are different facts. Never
 * throws.
 *
 * A near-copy of CopilotProvider's, not imported from it: that module
 * loads the Copilot SDK at import time.
 */
export function describeOptions(options: unknown): string {

    try {

        return JSON.stringify(options, (key, value) => {

            /*
             * Private properties are skipped, and first, so a private
             * function is dropped rather than named. The in-process ask
             * server's `_registeredTools` hold zod schemas that point
             * back at themselves; `JSON.stringify` would throw on that
             * cycle and the whole log line would be lost.
             */
            if (key.startsWith("_"))
                return undefined;

            if (typeof value === "function")
                return "[handler]";

            if (value === undefined)
                return "[unset]";

            // AbortController would otherwise print as an empty object.
            if (value instanceof AbortController)
                return "[abort]";

            // Never print a secret - see `redactSecrets`.
            return redactSecret(key, value) ?? value;

        }, 2);

    } catch (error) {

        return `<could not be printed: ${error instanceof Error ? error.message : String(error)}>`;
    }
}

/** `crypto.randomUUID`, via the global Node provides. */
function randomUuid(): string {

    return globalThis.crypto.randomUUID();
}

/**
 * The `init` message's MCP servers as one line: `MCP: ado connected ·
 * github failed`. Undefined when there are none. The same form as the
 * Copilot and Kiro runtimes' line.
 *
 * Exported for tests.
 */
export function claudeMcpText(servers: unknown): string | undefined {

    const listed = Array.isArray(servers) ? servers as { name?: unknown; status?: unknown }[] : [];

    const parts = listed.flatMap(server => {

        const name = asText(server?.name);
        const status = asText(server?.status);

        if (!name || !status)
            return [];

        return [MCP_STATUS_WORDS[status] ? `${name} ${MCP_STATUS_WORDS[status]}` : `${name} ${status}`];
    });

    return parts.length ? `MCP: ${parts.join(" · ")}` : undefined;
}

const MCP_STATUS_WORDS: Record<string, string> = {
    connected: "connected",
    failed: "failed",
    "needs-auth": "needs sign-in",
    pending: "still connecting",
    disabled: "turned off"
};

/**
 * The modes the claude runtime offers: Claude Code's `default` and
 * `plan` permission modes. The others (accept edits, auto, bypass, don't
 * ask) approve calls before our check sees them, so they are never
 * offered - see `guardMode`.
 */
export const CLAUDE_MODES: readonly { id: string; name: string; description: string }[] = [
    { id: "default", name: "Agent", description: "Works on the task." },
    { id: "plan", name: "Plan", description: "Reads and plans only, and asks before it starts changing files." }
];

/**
 * The mode a picked value means: one of {@link CLAUDE_MODES}, or the
 * default for anything else - said in the log when `log` is given.
 *
 * Exported for tests.
 */
export function claudeMode(mode: string | undefined, log?: (text: string, stream?: "stdout" | "stderr" | "system") => void): string {

    const wanted = mode?.trim();

    if (!wanted)
        return "default";

    if (CLAUDE_MODES.some(one => one.id === wanted))
        return wanted;

    log?.(`Mode '${wanted}' is not offered - only ${CLAUDE_MODES.map(one => one.name).join(" and ")}. Using Agent.`, "system");

    return "default";
}

/** The effort levels Claude takes, lowest first. */
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/**
 * A picked effort as Claude's own level, or undefined for none - and for
 * a level Claude does not know, which is said in the log when `log` is
 * given. A model without the level runs at the nearest it has (the SDK's
 * own rule for `max`).
 *
 * Exported for tests.
 */
export function claudeEffort(
    effort: string | undefined,
    log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
): typeof CLAUDE_EFFORTS[number] | undefined {

    const wanted = effort?.trim();

    if (!wanted)
        return undefined;

    const level = CLAUDE_EFFORTS.find(one => one === wanted);

    if (!level)
        log?.(`Effort '${wanted}' is not one Claude takes (${CLAUDE_EFFORTS.join(", ")}) - the model's default is used.`, "system");

    return level;
}

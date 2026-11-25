import { CopilotClient, CopilotSession } from "@github/copilot-sdk";
import type {
    PermissionHandler,
    PermissionRequest,
    PermissionRequestResult,
    SessionConfig,
    SessionHooks
} from "@github/copilot-sdk";

import { AgentProvider, ModeList, ModelChoice, ProviderDeps, ToolChoice } from "../AgentProvider";
import { EnvService } from "../../env/envService";
import { loadEngineSettings } from "../../settings/engineSettings";
import { appName } from "../../loader/profilePaths";
import { cliBinary, requireCli } from "./copilotCli";
import { McpResolution, resolveMcpServers, withHostServers } from "./mcpConfig";
import { normalizeMcpServers } from "./mcpServers";
import {
    copilotRequestPaths, copilotRequestWrites, copilotWrites, createJail, engineDirectories, openJail
} from "./pathJail";
import type { PathJail } from "./pathJail";
import { askCard, copilotRequestCall, copilotToolCall, deniedText, gatePermission, UNANSWERED_NOTE, UNANSWERED_TEXT } from "../permissions";
import type { PermissionGate } from "../permissions";
import { approvalPermission } from "./copilotApproval";
import { redactSecret } from "./redactSecrets";
import { copilotCharge } from "./copilotCharge";
import { COPILOT_TODO_TOOL, planFromCopilotTodos, planFromTodoChecklist, planText } from "../plan";

export { copilotCharge };
import { targetSystemPrompt } from "./targetPrompt";
import { homeDirectory } from "../../runner/runContext";
import type { AccountRow, AccountUsage, AskPermission, ContextItem, ContextPart, ContextUsage, ModelSpend, Spend } from "../../models/run";
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
import {
    AcpElicitationRequest,
    AcpElicitationResponse,
    askElicitation
} from "./acpElicitation";
import {
    ASK_SYSTEM_PROMPT,
    ASK_TOOL_DESCRIPTION,
    ASK_TOOL_NAME,
    AskToolInput,
    askQuestions,
    askToolJsonSchema
} from "./askTool";
import {
    TIME_NOW_DESCRIPTION,
    TIME_NOW_TOOL_NAME,
    timeNow,
    timeToolJsonSchema,
    UTC_NOW_DESCRIPTION,
    UTC_NOW_TOOL_NAME,
    utcNow
} from "./timeTools";
import {
    CHECK_PLAN_DESCRIPTION,
    CHECK_PLAN_TOOL_NAME,
    checkPlan,
    checkPlanJsonSchema,
    markTaskDone,
    PlanToolInput,
    planToolJsonSchema,
    TASK_DONE_DESCRIPTION,
    TASK_DONE_TOOL_NAME
} from "./planTools";
import {
    answerSteering,
    STEERING_TOOL_NAME,
    steeringDescription,
    SteeringToolInput,
    steeringToolJsonSchema
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

/**
 * GitHub Copilot, as an {@link AgentProvider}.
 * https://github.com/github/copilot-sdk/tree/main/nodejs
 *
 * The only file in the engine that imports the SDK, which keeps the
 * rest testable without loading the CLI and its native modules.
 *
 * A client per session rather than one shared: a session carries the
 * working directory, and two tasks can be running in different ones at
 * the same time.
 */
export class CopilotProvider implements AgentProvider {

    constructor(private readonly deps: ProviderDeps = {}) { }

    public async createSession(config: AgentSessionConfig): Promise<AgentSession> {

        // The CLI keeps its own credential store - without a token here
        // it fails every turn even on a
        // machine visibly signed in to Copilot elsewhere. Never fatal: with no
        // token the CLI falls back to its own sign-in.
        let token: string | undefined;

        try {

            token = await this.deps.token?.();

        } catch {

            // The CLI's own sign-in is the remaining path.
        }

        // Before the client, so a malformed settings.json costs nothing
        // and no CLI child is started for it. Read fresh per session:
        // the file can change while the provider lives.
        const settings = await loadEngineSettings(this.deps.workspaceFolder?.());

        // The one authority on the environment - the machine's env is
        // never read directly here. It answers two questions below:
        // what a `${{ env.NAME }}` may read (the gate), and what the
        // CLI child inherits (`spawnEnv`).
        const envs = new EnvService({
            allowed: settings.env.allowed,
            denied: settings.env.denied,
            taskEnv: config.env,
            allowedEnv: config.allowedEnv
        });

        // The environment the CLI child process gets: the spawn
        // baseline plus granted names, task values layered on top - an
        // allowlist, see `spawnEnv`. The CLI's sign-in store lives
        // under the home directory, which the baseline keeps.
        //
        // Two additions of this provider's own:
        // 1. COPILOT_CLI_PATH must point at the platform package's
        //    native binary. The SDK otherwise resolves the CLI to
        //    `index.js` and spawns it with `process.execPath`, and the
        //    CLI's argument parser can misread argv when that is an
        //    Electron program, even with ELECTRON_RUN_AS_NODE set.
        // 2. ELECTRON_RUN_AS_NODE for the `index.js` fallback path -
        //    without it an Electron executable starts as a browser and
        //    exits 0 having run nothing. Harmless under plain Node.
        //
        // Every value the grant hands the child is in the masker before
        // this returns - one call, so a future provider cannot spawn
        // the env without also registering it.
        const env = envs.spawnEnvMasked(config.registerSecret);

        const binary = env.COPILOT_CLI_PATH ?? cliBinary(env);

        Object.assign(
            env,
            binary ? { COPILOT_CLI_PATH: binary } : {},
            { ELECTRON_RUN_AS_NODE: "1" });

        // Before the client, because the client's own failure for a
        // missing CLI is a spawn error naming nothing actionable.
        requireCli(env);

        const mcp = resolveMcpServers(withHostServers(settings.ai.mcpServers, this.deps.mcpServers?.("ghcp")), envs, config.mcp);

        const client = new CopilotClient({
            workingDirectory: config.workingDirectory,
            env,
            gitHubToken: token,
            useLoggedInUser: !token
        });

        await client.start();

        try {

            // The handlers need a session to raise a question on, and
            // the session does not exist until `createSession` returns -
            // so they reach it through a variable assigned below.
            // Nothing calls it before the first turn, and there is no
            // first turn before the session exists.
            let session: CopilotAgentSession | undefined;

            const ask: AskHook = request => {

                if (!session)
                    throw new Error("The Copilot session asked a question before it was built.");

                return session.ask(request);
            };

            const options = sessionConfig(
                config, this.deps.directories?.(), mcp, ask, settings.debug, this.deps.resources?.(),
                (permission, raw, callId) => session?.allowedWithoutAsking(permission, raw, callId),
                this.deps.permissions?.("ghcp", config.workingDirectory, config.chat));

            // The tools the settings take away: added to the excluded
            // list, never replacing it.
            const off = this.deps.toolsOff?.("ghcp") ?? [];

            // A tool set (not a list) from elsewhere is left as it is.
            if (off.length && (options.excludedTools === undefined || Array.isArray(options.excludedTools)))
                options.excludedTools = [...new Set([...options.excludedTools ?? [], ...off])];
            else if (off.length)
                config.log?.("The tools to turn off in the settings were not applied: this session's excluded tools are a tool set, not a list.", "system");

            config.log?.(`Session options:\n${describeOptions(options)}`, "system");

            // Carrying an earlier conversation on, when the caller named
            // one and the CLI still has it. Checked before it is
            // attempted: `resumeSession` on an id the store has
            // forgotten throws, and a phase that fails because a
            // conversation expired is far worse than one that starts
            // cold. `getSessionMetadata` answers `undefined` for an id
            // it does not know.
            //
            // The config is the same object a new session gets -
            // `ResumeSessionConfig` is `SessionConfigBase` plus three
            // resume-only flags. `suppressResumeEvent` is one of the
            // three: without it the CLI announces the resume as an
            // event, which would reach the panel as a line about
            // plumbing rather than about the work.
            const resumeCheck: { resumed: boolean; reason?: string } = config.resume
                ? await knows(client, config.resume, config.log)
                : { resumed: false };

            const resumed = resumeCheck.resumed;

            const created = resumed && config.resume
                ? await client.resumeSession(config.resume, { ...options, suppressResumeEvent: true })
                : await client.createSession(options);

            session = new CopilotAgentSession(
                client,
                created,
                config.signal,
                resumed,
                resumeCheck.reason,
                settings.features.liveToolOutput,
                settings.features.hideCopilotPremiumRequests);

            // The mode picked in the compose box - see `COPILOT_MODES`.
            await session.setAgentMode(config.agentMode, config.log);

            return session;

        } catch (error) {

            // A session that never came into being has nobody to stop
            // the client child process later.
            await client.stop?.().catch(() => []);

            throw error;
        }
    }

    /**
     * The modes the compose box offers - see {@link COPILOT_MODES}. Fixed:
     * they are the CLI's own, the same for every model, so nothing is
     * started to ask.
     */
    public async modes(): Promise<ModeList | undefined> {

        return { current: "interactive", modes: COPILOT_MODES.map(mode => ({ ...mode })) };
    }

    /**
     * The CLI's own model catalogue, as the signed-in account sees it.
     *
     * A client is started and stopped for the call, which is why this
     * is only ever reached from a surface offering a choice - never
     * from a run. Everything about it fails quietly: no token, no CLI,
     * no network, a vendor that changed the RPC - all mean "no
     * suggestions", and a missing suggestion is not worth a broken
     * completion list.
     *
     * Not cached here: what is on offer changes with the account's plan,
     * and this is called when somebody opens a completion list rather
     * than in a loop, so a stale answer would cost more than the call.
     */
    public async models(): Promise<ModelChoice[] | undefined> {

        let token: string | undefined;

        try {

            token = await this.deps.token?.();

        } catch {

            // The CLI's own sign-in is the remaining path, as in createSession.
        }

        const client = new CopilotClient({
            // The home directory when no working folder is set, not
            // `process.cwd()`: that can be the app's own install
            // directory, which is nobody's project. Listing models does
            // not read the tree either way - this only has to be a real
            // directory the CLI can start in.
            workingDirectory: this.deps.workspaceFolder?.() ?? homeDirectory(),
            gitHubToken: token,
            useLoggedInUser: !token
        });

        try {

            await client.start();

            return (await client.listModels()).map(model => ({
                id: model.id,
                name: model.name,

                // Present only when the model supports effort at all,
                // which is the distinction a surface needs - so it is
                // carried through as the vendor states it rather than
                // defaulted to the full list.
                reasoningEfforts: model.supportedReasoningEfforts,
                multiplier: model.billing?.multiplier,
                ...(model.policy?.state === "disabled" ? { disabled: true } : {})
            }));

        } catch {

            return undefined;

        } finally {

            await client.stop?.().catch(() => []);
        }
    }

    /**
     * The CLI's built-in tools, for a tool picker. Same shape and same
     * quiet failure as {@link models}: a client started and stopped for
     * the call, and no list when anything goes wrong. The RPC is marked
     * experimental by the vendor, which is one more reason to fail
     * quietly.
     */
    public async tools(): Promise<ToolChoice[] | undefined> {

        let token: string | undefined;

        try {

            token = await this.deps.token?.();

        } catch {

            // The CLI's own sign-in is the remaining path.
        }

        const client = new CopilotClient({
            workingDirectory: this.deps.workspaceFolder?.() ?? homeDirectory(),
            gitHubToken: token,
            useLoggedInUser: !token
        });

        try {

            await client.start();

            const listed = await client.rpc.tools.list({});

            return listed.tools
                .filter(tool => typeof tool.name === "string" && tool.name)
                .map(tool => ({ id: tool.name, ...(tool.description ? { description: tool.description } : {}) }));

        } catch {

            return undefined;

        } finally {

            await client.stop?.().catch(() => []);
        }
    }
}

/**
 * Whether the CLI still holds the conversation a caller named.
 *
 * Asked rather than assumed, because `resumeSession` throws on an
 * id it does not know and that would fail the phase behind it.
 *
 * A lookup that throws is not the same fact as one that answers "no
 * such conversation": the CLI may still have it, this call just
 * failed to say so. Retried a couple of times before giving up, and
 * the reason travels back either way, because `ai@1` fails the run
 * on a missed resume rather than starting cold - "gone" and "could
 * not check" are different refusals.
 */
export async function knows(
    client: CopilotClient,
    id: string,
    log: AgentSessionConfig["log"]
): Promise<{ resumed: true } | { resumed: false; reason: string }> {

    for (let attempt = 0; attempt <= KNOWS_RETRIES; attempt++) {

        try {

            if (await client.getSessionMetadata(id))
                return { resumed: true };

            const reason = `the CLI no longer has session ${id}`;

            log?.(`${reason}, so this starts a new conversation rather than carrying that one on.`, "system");

            return { resumed: false, reason };

        } catch (error) {

            const detail = error instanceof Error ? error.message : String(error);

            if (attempt < KNOWS_RETRIES) {

                log?.(`Could not look up session ${id}: ${detail}. Trying again.`, "system");

                await new Promise(resolve => setTimeout(resolve, KNOWS_RETRY_DELAY_MS));

                continue;
            }

            const reason = `the lookup for session ${id} failed: ${detail}`;

            log?.(`${reason}. Starting a new conversation.`, "system");

            return { resumed: false, reason };
        }
    }

    // Unreachable - the loop always returns.
    return { resumed: false, reason: "the lookup did not complete" };
}

/**
 * How much of a running tool's output is carried, in characters. The
 * tail, so what is on screen is what just happened.
 *
 * Big enough to hold a screenful of a build's output several times
 * over, small enough that republishing it ten times a second costs
 * nothing. The call's own result, which is what gets logged, is
 * unaffected by this.
 */
const OUTPUT_LIMIT = 8000;

/**
 * The throttle key for one call's output, kept in the same map the
 * message channels use. Prefixed so a call id can never collide with a
 * speaker's channel key - see `bufferKey`.
 */
function outputKey(callId: string): string {

    return `output|${callId}`;
}

/**
 * One Copilot conversation.
 *
 * Holds its own client: stopping a client ends the CLI server and every
 * session on it, so a shared client would make sessions impossible to
 * dispose independently.
 */
export class CopilotAgentSession implements AgentSession {

    public readonly id: string;

    private state: AgentSessionStatus = "idle";

    private readonly handlers = new Set<(event: AgentEvent) => void>();

    /**
     * Questions waiting on a person, by id - each holding the promise
     * one of this session's two ask handlers is blocked on. The same
     * bookkeeping every provider that can ask needs, which is why it is
     * shared: see {@link AskDesk}.
     */
    private readonly asks = new AskDesk(event => this.publishEvent(event));

    /** Per session, because everything it remembers belongs to one conversation. */
    private readonly translator: CopilotEventTranslator;

    constructor(
        private readonly client: CopilotClient,
        private readonly session: CopilotSession,
        signal?: AbortSignal,

        /** Whether this carried on an earlier conversation rather than starting one. */
        public readonly resumed = false,

        /** Why not, when it is not - see {@link AgentSession.resumeFailure}. */
        public readonly resumeFailure?: string,

        /**
         * Whether a running tool's output is published as it arrives -
         * the `liveToolOutput` feature flag, read from settings when
         * the session was created.
         */
        liveOutput = false,

        /** The `hideCopilotPremiumRequests` feature flag - see {@link copilotCharge}. */
        private readonly hidePremiumRequests = false
    ) {

        this.translator = new CopilotEventTranslator(() => Date.now(), liveOutput, hidePremiumRequests);

        this.id = session.sessionId;

        session.on(event => this.publish(event as SdkEvent));

        signal?.addEventListener("abort", () => void this.abort("the run was stopped"));
    }

    public get status(): AgentSessionStatus {

        return this.state;
    }

    public async send(message: AgentMessage): Promise<void> {

        this.state = "working";
        this.started();

        await this.session.send(sdkMessage(message));
    }

    /**
     * `send` resolves the moment the prompt is delivered, before the
     * agent has done anything - waiting for the turn needs this one.
     *
     * Not the SDK's own `sendAndWait`: that one returns on the first
     * `session.idle` event it sees, with no regard for whose idle it is
     * or for background agents still running - see {@link settleTurn}
     * for the wait used instead and why.
     *
     * The default timeout is far larger than the SDK's 60s: the task's
     * own `timeout:` is the real limit, this only stops an infinite wait
     * on a session that never settles.
     */
    public async sendAndWait(message: AgentMessage, timeoutMs: number | null = IDLE_TIMEOUT_MS): Promise<void> {

        this.state = "working";
        this.started();

        try {

            await settleTurn(
                this.session as unknown as SettleableSession,
                () => this.session.send(sdkMessage(message)),
                timeoutMs);

        } finally {

            this.state = "idle";

            // A question still open here is not a real one: the model
            // is blocked on its own tool call while one is, and a turn
            // cannot settle mid-block. It is the CLI having dropped that
            // one call without telling this session so, or the turn
            // hitting its own timeout with the call still open - closed
            // here rather than left to lock the next turn's box forever
            // over a question nobody is still asking.
            this.asks.abandon("The turn ended without an answer.");
        }
    }

    /** Stops the turn, and says so in the log with `reason` - see the ACP session's `abort`. */
    public async abort(reason: string = "Stop was pressed"): Promise<void> {

        // Before the abort reaches the CLI: a question still open is one
        // nothing will ever answer once the turn is being stopped.
        this.asks.abandon("The turn was stopped before the question was answered.");

        this.publishEvent({ name: "session.abort", raw: { reason }, kind: "notice", text: `Sent abort: ${reason}.` });

        await this.session.abort().catch(() => undefined);
    }

    /** A permission request answered "yes" by itself - see `allowedNotice`. */
    public allowedWithoutAsking(permission: AskPermission, raw: unknown, callId?: string): void {

        this.publishEvent(allowedNotice("permission.request", raw, permission, callId));
    }

    /**
     * Puts a question to whoever is watching, and waits.
     *
     * Called from our own `ask_user` tool's handler, or from
     * `onElicitationRequest`, while the agent is blocked on it - so the
     * wait here is the agent's wait, which is what makes a pending
     * question read as `working` rather than `idle`.
     */
    public ask(request: AskRequest): PendingAsk {

        if (this.state === "ended")
            throw new Error("The Copilot session has ended.");

        return this.asks.ask(request, ASK_TOOL_NAME);
    }

    public async respond(askId: string, answer: string): Promise<void> {

        this.asks.respond(askId, answer);
    }

    public async dispose(): Promise<void> {

        if (this.state === "ended")
            return;

        this.state = "ended";
        this.handlers.clear();

        this.asks.abandon("The session ended before the question was answered.");

        // Stops the CLI server. Session state on disk survives, so the
        // conversation can still be reopened later.
        await this.client.stop?.().catch(() => []);
    }

    public async delete(): Promise<void> {

        if (this.state === "ended")
            return;

        this.state = "ended";
        this.handlers.clear();

        this.asks.abandon("The session ended before the question was answered.");

        try {

            // Removes the conversation from the CLI's store - history,
            // planning state, artifacts. Before `stop`, because this is
            // an RPC and a stopped client has nobody to send it to.
            await this.client.deleteSession(this.id);

        } finally {

            // The CLI server ends either way; a failed delete must not
            // leave its child process running.
            await this.client.stop?.().catch(() => []);
        }
    }

    public on(handler: (event: AgentEvent) => void): () => void {

        this.handlers.add(handler);

        return () => this.handlers.delete(handler);
    }

    /**
     * One SDK event in the engine's terms, republished to subscribers.
     *
     * The translation itself lives in {@link CopilotEventTranslator} -
     * it has to remember things across events, and a session should not
     * also be a state machine for somebody else's event stream.
     */
    private publish(event: SdkEvent): void {

        let translated = this.translator.translate(event);

        // A context reading says the Compact button can be offered - see
        // {@link compact}.
        if (translated.kind === "notice" && translated.context)
            translated = { ...translated, context: { ...translated.context, compactable: true } };

        // Autopilot is never kept: it runs to the end without a person.
        // Plan mode's own exit is held off it (`exitPlanAction`); this is
        // for any other way in.
        if (event.type === "session.mode_changed") {

            const mode = asText((event.data as { newMode?: unknown } | undefined)?.newMode);

            if (mode)
                this.agentMode = mode;

            if (mode === "autopilot")
                void this.setAgentMode("interactive").then(() => this.publishEvent({
                    name: "session.mode_changed", raw: event, kind: "notice",
                    text: "Copilot switched itself to autopilot - switched back to Agent."
                }), () => undefined);
        }

        if (translated.kind === "idle") {

            this.state = "idle";

            // What the turn left of the account's allowance.
            void this.reportQuota();

            // What fills the window, item by item.
            void this.reportContext();
        }

        // The event carries nothing: the list is read from the session.
        if (event.type === "session.todos_changed")
            this.readTodos(translated);

        this.publishEvent(translated);
    }

    /** The to-do reads in the order the changes came, so an older list never lands after a newer one. */
    private todoReads: Promise<void> = Promise.resolve();

    /**
     * The agent's plan after its to-do table changed, published as a
     * notice that carries it. `changed` is that change's own translation,
     * so a sub-agent's change stays marked as the sub-agent's.
     */
    private readTodos(changed: AgentEvent): void {

        this.todoReads = this.todoReads.then(async () => {

            if (this.state === "ended")
                return;

            try {

                const { rows } = await this.session.rpc.plan.readSqlTodos();

                const plan = planFromCopilotTodos(rows);

                this.publishEvent({ ...changed, kind: "notice", text: planText(plan), plan });

            } catch (error) {

                this.publishEvent({
                    ...changed,
                    kind: "notice",
                    text: `Could not read Copilot's to-do list: ${error instanceof Error ? error.message : String(error)}`
                });
            }
        });
    }

    /** A message has gone out - the first point a caller is listening. */
    private sent = false;

    /** On the first message: the account's allowance, before the first turn ends. */
    private started(): void {

        if (this.sent)
            return;

        this.sent = true;

        void this.reportQuota();
    }

    /** The mode this session is in - see {@link COPILOT_MODES}. */
    public agentMode?: string;

    /**
     * Puts the session in a mode from {@link COPILOT_MODES} - the compose
     * box's pick, between turns. Nothing picked, or the mode it is already
     * in, sends nothing. Any other mode (autopilot) is refused and logged.
     */
    public async setAgentMode(
        mode: string | undefined,
        log?: (text: string, stream?: "stdout" | "stderr" | "system") => void
    ): Promise<void> {

        const wanted = mode?.trim();

        if (!wanted || wanted === (this.agentMode ?? "interactive"))
            return;

        if (!COPILOT_MODES.some(one => one.id === wanted)) {

            log?.(`Mode '${wanted}' is not offered - only ${COPILOT_MODES.map(one => one.name).join(" and ")}.`, "system");

            return;
        }

        await this.session.rpc.mode.set({ mode: wanted as "interactive" | "plan" });

        this.agentMode = wanted;

        log?.(`Mode: ${COPILOT_MODES.find(one => one.id === wanted)!.name} (set on the session).`, "system");
    }

    /**
     * Copilot's own compaction (`history.compact`): it writes a summary of
     * the conversation and carries on from it. Costs a model call.
     * Refused while a turn runs.
     */
    public async compact(): Promise<{ ok: boolean; reason?: string }> {

        if (this.state === "ended")
            return { ok: false, reason: "The session has ended." };

        if (this.state === "working")
            return { ok: false, reason: "A turn is still running. Compact once it has finished." };

        try {

            const result = await this.session.rpc.history.compact({ trigger: "manual" });

            return result?.success
                ? { ok: true }
                : { ok: false, reason: "Copilot did not compact - there may be nothing to compact yet." };

        } catch (error) {

            return { ok: false, reason: `Copilot could not compact: ${error instanceof Error ? error.message : String(error)}` };
        }
    }

    /** The CLI said it has no quota call - not asked again. */
    private noQuota = false;

    /**
     * The account's request allowance - `account.getQuota`, a call to
     * GitHub, not to a model - as account usage, the same card Kiro's
     * fills. Asked on the first message and after each turn. Quiet on
     * failure: a missing figure is not a failed turn.
     */
    private async reportQuota(): Promise<void> {

        if (this.noQuota || this.state === "ended")
            return;

        try {

            const result = await this.client.rpc.account.getQuota({});

            const found = copilotAccount(result, Date.now(), this.hidePremiumRequests);

            if (found)
                this.publishEvent({ name: "account.getQuota", raw: result, kind: "notice", progress: true, text: found.summary, account: { ...found.account, runtime: "ghcp" } });

        } catch {

            this.noQuota = true;
        }
    }

    /** The CLI has no context breakdown call - not asked again. */
    private noContext = false;

    /**
     * The context window item by item, after each turn - the same data
     * as the CLI's `/context`: every tool definition (built-in and MCP
     * apart) and the heaviest messages. Three calls to the CLI, none to
     * a model. Replaces the `session.usage_info` reading, which only has
     * three totals. Quiet on failure: a missing breakdown is not a
     * failed turn, and that reading is still there.
     */
    private async reportContext(): Promise<void> {

        if (this.noContext || this.state === "ended")
            return;

        const metadata = this.session.rpc.metadata as Partial<typeof this.session.rpc.metadata> | undefined;

        if (!metadata?.getContextAttribution) {

            this.noContext = true;

            return;
        }

        try {

            const [attribution, tools, heaviest] = await Promise.all([
                withTimeout(metadata.getContextAttribution(), CONTEXT_TIMEOUT_MS),
                withTimeout(this.session.rpc.tools.getCurrentMetadata(), CONTEXT_TIMEOUT_MS).catch(() => undefined),
                withTimeout(metadata.getContextHeaviestMessages?.({ limit: HEAVIEST_MESSAGES }) ?? Promise.resolve(undefined), CONTEXT_TIMEOUT_MS).catch(() => undefined)
            ]);

            const context = copilotAttributionContext(attribution.contextAttribution, tools?.tools, heaviest?.messages);

            if (!context)
                return;

            this.publishEvent({
                name: "metadata.getContextAttribution",
                raw: { attribution, tools, heaviest },
                kind: "notice",
                progress: true,
                text: `Context ${Math.round((context.used / context.size) * 100)}% of ${tokens(context.size)} tokens used`,
                context: { ...context, compactable: true }
            });

        } catch {

            this.noContext = true;
        }
    }

    /** An event this session raised itself - a question, rather than one the CLI sent. */
    private publishEvent(event: AgentEvent): void {

        for (const handler of [...this.handlers])
            handler(event);
    }
}

/**
 * The modes ghcp offers: the CLI's own `interactive` and `plan`. Its
 * third, `autopilot`, runs to the end without anyone and turns tool
 * approval off, so it is never offered.
 */
export const COPILOT_MODES: readonly { id: string; name: string; description: string }[] = [
    { id: "interactive", name: "Agent", description: "Works on the task, asking before each tool call as permissions say." },
    { id: "plan", name: "Plan", description: "Writes a plan first, and asks to leave plan mode before building." }
];

/**
 * What to answer when Copilot asks to leave plan mode. Its choices are
 * `autopilot`, `autopilot_fleet`, `interactive` ("build on default
 * permissions") and `exit_only` (read from CLI 1.0.85). The two autopilot
 * ones are never picked: the recommended one when it is not autopilot,
 * else `interactive`, else `exit_only`. Undefined when neither is on
 * offer, and the request is refused.
 *
 * Exported for tests.
 */
export function exitPlanAction(request: { actions?: string[]; recommendedAction?: string }): string | undefined {

    const actions = Array.isArray(request.actions) ? request.actions : [];
    const safe = (action: string | undefined) => !!action && actions.includes(action) && !action.startsWith("autopilot");

    if (safe(request.recommendedAction))
        return request.recommendedAction;

    return ["interactive", "exit_only"].find(safe);
}

/**
 * `account.getQuota` as account usage: one row per allowance the account
 * has (chat requests, code completions, premium requests), each as used
 * of allowed and what is left, and when they reset. An allowance the
 * account does not have (`hasQuota: false`) is left out. Past one, the
 * meter gets its warning mark.
 *
 * @param hidePremiumRequests the `hideCopilotPremiumRequests` flag -
 *        premium requests are left out here too.
 *
 * Exported for tests.
 */
export function copilotAccount(
    result: unknown,
    at: number,
    hidePremiumRequests = false
): { account: AccountUsage; summary: string } | undefined {

    const snapshots = (result as { quotaSnapshots?: unknown } | undefined)?.quotaSnapshots;

    if (!snapshots || typeof snapshots !== "object")
        return undefined;

    const rows: AccountRow[] = [];

    let overLimit = false;
    let resets: string | undefined;

    for (const [kind, raw] of Object.entries(snapshots as Record<string, unknown>)) {

        const quota = (raw ?? {}) as Record<string, unknown>;

        if (hidePremiumRequests && kind === "premium_interactions")
            continue;

        const name = QUOTA_NAMES[kind] ?? kind;

        if (quota.isUnlimitedEntitlement === true) {

            rows.push({ key: name, value: "Unlimited" });
            continue;
        }

        if (quota.hasQuota === false || typeof quota.entitlementRequests !== "number" || typeof quota.usedRequests !== "number")
            continue;

        const left = typeof quota.remainingPercentage === "number" ? `, ${Math.round(quota.remainingPercentage)}% left` : "";
        const over = typeof quota.overage === "number" && quota.overage > 0 ? `, ${quota.overage} over` : "";

        rows.push({ key: name, value: `${quota.usedRequests} of ${quota.entitlementRequests} used${left}${over}` });

        if (typeof quota.remainingPercentage === "number" && quota.remainingPercentage <= 0)
            overLimit = true;

        if (typeof quota.resetDate === "string" && quota.resetDate)
            resets ??= quota.resetDate.slice(0, 10);
    }

    if (!rows.length)
        return undefined;

    const summary = `Copilot account: ${rows.map(row => `${row.key.toLowerCase()} ${row.value}`).join("; ")}`;

    if (resets)
        rows.push({ key: "Resets", value: resets });

    return { account: { at, rows, ...(overLimit ? { overLimit } : {}) }, summary };
}

const QUOTA_NAMES: Record<string, string> = {
    chat: "Chat requests",
    completions: "Code completions",
    premium_interactions: "Premium requests"
};

/**
 * The context window from a `session.usage_info` event, or nothing
 * when the CLI gave no window size to measure against.
 */
export function copilotContext(data: Record<string, unknown>): ContextUsage | undefined {

    if (typeof data.currentTokens !== "number" || typeof data.tokenLimit !== "number" || data.tokenLimit <= 0)
        return undefined;

    const parts = [
        ["System prompt", data.systemTokens],
        ["Tool definitions", data.toolDefinitionsTokens],
        ["Conversation", data.conversationTokens]
    ]
        .filter((part): part is [string, number] => typeof part[1] === "number" && part[1] > 0)
        .map(([name, count]) => ({ name, tokens: count }));

    return { used: data.currentTokens, size: data.tokenLimit, ...(parts.length ? { parts } : {}) };
}

/** Only the fields {@link copilotAttributionContext} reads. The SDK's types have more. */
export interface CopilotAttribution {

    totalTokens?: number;

    promptTokenLimit?: number;

    categories?: Partial<Record<"systemPrompt" | "customInstructions" | "systemTools" | "mcpTools" | "messages", number>>;

    entries?: { kind?: string; label?: string; tokens?: number }[];
}

/**
 * The CLI's context breakdown as a {@link ContextUsage}, or nothing when
 * it has no window size.
 *
 * Parts are the CLI's own `/context` rows. Items, as SDK 1.0.14
 * reports them:
 *
 *   - Tools: every `toolDefinition` entry. The entry does not say which
 *     tools are MCP; the tool list does (`mcpServerName`), so it splits
 *     them into System tools and MCP tools.
 *   - Messages: the heaviest messages, with the CLI's short label
 *     (`skill: tmux`, `asst: -> view`).
 *
 * The other entry kinds the SDK names (`skill`, `subagent`,
 * `mcpServer`, `tool`, `plugin`) have not been seen in the CLI's
 * output, so they are not placed in any part - a guess could count the same tokens twice.
 */
export function copilotAttributionContext(
    attribution: CopilotAttribution | null | undefined,
    tools: { name?: string; mcpServerName?: string; mcpToolName?: string }[] | null | undefined,
    heaviest: { label?: string; tokens?: number }[] | null | undefined
): ContextUsage | undefined {

    const size = attribution?.promptTokenLimit;

    if (!attribution || typeof size !== "number" || size <= 0 || typeof attribution.totalTokens !== "number")
        return undefined;

    const servers = new Map((tools ?? []).filter(tool => tool.name && tool.mcpServerName).map(tool => [tool.name as string, tool]));

    const systemTools: ContextItem[] = [];
    const mcpTools: ContextItem[] = [];

    for (const entry of attribution.entries ?? []) {

        if (entry.kind !== "toolDefinition" || !entry.label || typeof entry.tokens !== "number" || entry.tokens <= 0)
            continue;

        const mcp = servers.get(entry.label);

        if (mcp)
            mcpTools.push({ name: mcp.mcpToolName ? `${mcp.mcpServerName}: ${mcp.mcpToolName}` : entry.label, tokens: entry.tokens });
        else
            systemTools.push({ name: entry.label, tokens: entry.tokens });
    }

    const messages = (heaviest ?? [])
        .filter(message => message.label && typeof message.tokens === "number" && message.tokens > 0)
        .map(message => ({ name: message.label as string, tokens: message.tokens as number }));

    const biggestFirst = (items: ContextItem[]) => items.sort((left, right) => right.tokens - left.tokens);

    const categories = attribution.categories ?? {};

    // When the tool list could not be read, nothing is known to be MCP,
    // so every tool would land under System tools - wrong. Then neither
    // tools part gets items.
    const split = tools !== undefined && tools !== null;

    const parts = ([
        ["System prompt", categories.systemPrompt, []],
        ["Custom instructions", categories.customInstructions, []],
        ["System tools", categories.systemTools, split ? systemTools : []],
        ["MCP tools", categories.mcpTools, split ? mcpTools : []],
        ["Messages", categories.messages, messages]
    ] as [string, number | undefined, ContextItem[]][])
        .filter(([, count]) => typeof count === "number" && count > 0)
        .map(([name, count, items]): ContextPart => ({ name, tokens: count as number, ...(items.length ? { items: biggestFirst(items) } : {}) }));

    return { used: attribution.totalTokens, size, ...(parts.length ? { parts } : {}) };
}

/** How many of the heaviest messages the Messages row lists. */
const HEAVIEST_MESSAGES = 20;

/** How long a finished turn waits for the CLI's context breakdown. A local call; this is only the ceiling for one that never answers. */
const CONTEXT_TIMEOUT_MS = 3000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {

    return new Promise<T>((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(`No answer in ${ms} ms.`)), ms);

        work.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); });
    });
}

/** `1.25 credits`, `3 premium requests` - a charge as a log would print it. */
function describeSpend(spend: Spend): string {

    const amount = Number.isInteger(spend.amount) ? String(spend.amount) : spend.amount.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");

    return `${amount} ${spend.unit}`;
}

interface SdkEvent {

    type: string;

    data?: Record<string, unknown>;

    /**
     * Which delegated agent an event was bridged up from. Absent on the
     * main agent's own events - the SDK documents exactly that - which
     * makes its absence the test for "this is the conversation itself
     * speaking".
     */
    agentId?: string;
}

/**
 * The CLI's event stream in the engine's terms.
 *
 * A class because two of the SDK's events cannot be read on their own.
 * A `tool.execution_complete` names no tool - only the call id that the
 * matching `tool.execution_start` carried - so a stateless translation
 * can report that *a* tool finished and never which one. And every
 * event bridged up from a sub-agent identifies it by an opaque instance
 * id, whose human name was announced once, in `subagent.started`. So
 * the calls in flight and the agents that are running are remembered
 * here.
 *
 * Everything unrecognised still becomes `other` with `raw` intact.
 */
export class CopilotEventTranslator {

    /**
     * Tool calls in flight, by the SDK's call id - the name the
     * completion event does not carry, and the clock it is measured
     * against. Entries go as the calls complete; one that never
     * completes (an aborted turn) leaks a small string, and the map
     * dies with the session.
     *
     * `silent` marks a call with no `tool.start`/`tool.end` pair at all
     * - the agent asking a person, which has the `ask` event and its
     * own card. Recorded even so, so the completion is recognised as
     * that question's and dropped too.
     *
     * `todos` is the input of an `update_todo` call, also silent: its
     * result becomes the plan, not a tool row.
     */
    private readonly calls = new Map<string, { tool: string; started: number; silent?: boolean; todos?: unknown }>();

    /**
     * Sub-agent display names, under every id an event might reference
     * them by.
     *
     * Two keys per agent because the SDK offers no single one
     * documented to be present on both ends: `subagent.started` may
     * carry the new agent's instance id at the event level, and it
     * always carries the `toolCallId` of the call that spawned it -
     * which is what a bridged event's `parentToolCallId` points back
     * to. Registering both means attribution works either way.
     */
    private readonly agents = new Map<string, string>();

    /**
     * The text each speaker has streamed so far this message, per
     * channel - what a `delta` event carries.
     *
     * Keyed by speaker as well as channel because a sub-agent streams
     * at the same time as the agent that hired it, and one shared
     * buffer would splice two people's sentences together.
     */
    private readonly streamed = new Map<string, string>();

    /** When each buffer last published - see {@link DELTA_INTERVAL_MS}. */
    private readonly lastDelta = new Map<string, number>();

    /**
     * A running call's output so far, by call id - only while
     * {@link liveOutput} is on. Dropped as the call completes.
     */
    private readonly output = new Map<string, string>();

    /**
     * @param now Injected so a test can pin the throttle rather than
     *            wait out real milliseconds.
     * @param liveOutput Whether a running tool's output is published as
     *            it arrives - the `liveToolOutput` feature flag. Off,
     *            the CLI's partial-result events are dropped.
     */
    constructor(
        private readonly now: () => number = () => Date.now(),
        private readonly liveOutput = false,

        /** Leave premium requests out of every charge - see {@link copilotCharge}. */
        private readonly hidePremiumRequests = false
    ) { }

    public translate(event: SdkEvent): AgentEvent {

        const data = event.data ?? {};

        switch (event.type) {

            /*
             * The answer being typed. Ephemeral, throttled, and never
             * the record - see {@link painting}.
             */
            case "assistant.message_delta":

                return this.painting(event, "message");

            case "assistant.reasoning_delta":

                return this.painting(event, "reasoning");

            case "assistant.message": {

                const text = asText(data.content);

                // The complete message is the record and it lands whole,
                // so whatever was being painted for this speaker is
                // finished with.
                this.streamed.delete(this.bufferKey(event, "message"));

                return text
                    ? { ...this.common(event), kind: "message", text }
                    : { ...this.common(event), kind: "other" };
            }

            /*
             * The model's thinking. Not folded into `message`: a phase
             * records its closing message as what it produced, and "let
             * me check whether the file exists" is not that. It is still
             * the most useful thing in a log when a run goes somewhere
             * unexpected.
             */
            case "assistant.reasoning": {

                const text = asText(data.content);

                this.streamed.delete(this.bufferKey(event, "reasoning"));

                return text
                    ? { ...this.common(event), kind: "reasoning", text }
                    : { ...this.common(event), kind: "other" };
            }

            case "tool.execution_start": {

                const named = asText(data.toolName);
                const callId = asText(data.toolCallId);
                const args = data.arguments;

                // The shell driver's own rendering of the command - the
                // text that actually runs, with a redundant leading `cd`
                // removed. Preferred over the raw arguments for exactly
                // that reason.
                const shell = data.shellToolInfo as { displayCommand?: string } | undefined;

                const described = shell?.displayCommand
                    ? clip(shell.displayCommand, VALUE_LIMIT)
                    : describeArguments(args);

                // Which MCP server a tool came from is invisible in its
                // name, and it is the first thing anyone asks when a
                // tool behaves unlike the built-in of the same name.
                const server = asText(data.mcpServerName);

                // A server tool that said why it was called is titled by
                // that reason instead of by its own name - see `toolTitle`.
                // A shell call is titled by the same cleaned-up command
                // the row's detail shows, not the raw argument.
                const titled = shell?.displayCommand && args && typeof args === "object"
                    ? { ...args as Record<string, unknown>, command: shell.displayCommand }
                    : args;

                const tool = toolTitle(named, titled, server);

                // The server tag is dropped when the title already opens
                // with it, which is every call `toolTitle` renamed.
                const detail = server && !tool.startsWith(`${server}/`)
                    ? described ? `[${server}] ${described}` : `[${server}]`
                    : described;

                // The agent asking is drawn as a question, not as a
                // tool call - see `isAskTool`. Our `ask_user` is a real
                // tool here, so its call does reach the event stream and
                // this is what keeps the same question from being drawn
                // twice: once as the card, once as a row.
                const silent = isAskTool(named);

                if (callId)
                    this.calls.set(callId, { tool, started: Date.now(), silent });

                if (silent)
                    return { ...this.common(event), kind: "other" };

                // The to-do tool: the plan strip shows what it does, so it
                // is not drawn as a tool call. Still logged, as a notice.
                // The plan itself goes out when the call succeeds.
                if (named === COPILOT_TODO_TOOL) {

                    if (callId)
                        this.calls.set(callId, { tool, started: Date.now(), silent: true, todos: args ?? {} });

                    return { ...this.common(event), kind: "notice", text: `${named}: ${JSON.stringify(args ?? {})}` };
                }

                const path = toolPath(args);

                return {
                    ...this.common(event),
                    kind: "tool.start",
                    tool,
                    ...(named ? { toolName: named } : {}),
                    ...(callId ? { callId } : {}),
                    ...(detail ? { detail } : {}),
                    ...(path ? { path } : {}),
                    call: JSON.stringify(data)
                };
            }

            /*
             * A running tool's output, a piece at a time - what a shell
             * command is printing while it still runs.
             */
            case "tool.execution_partial_result":

                return this.printing(event, data);

            /*
             * An MCP server saying how far along it is. Rare, and the
             * only sign of life during a tool call that takes minutes.
             */
            case "tool.execution_progress": {

                const progress = asText(data.progressMessage);

                if (!progress)
                    return { ...this.common(event), kind: "other" };

                const tool = this.calls.get(asText(data.toolCallId))?.tool;

                // A heartbeat, arriving as often as the server cares
                // to send one - one live line, not a queue of them.
                return {
                    ...this.common(event),
                    kind: "notice",
                    text: tool ? `${tool}: ${progress}` : progress,
                    progress: true
                };
            }

            case "tool.execution_complete": {

                const callId = asText(data.toolCallId);
                const call = callId ? this.calls.get(callId) : undefined;

                if (callId) {

                    this.calls.delete(callId);
                    this.output.delete(callId);
                    this.lastDelta.delete(outputKey(callId));
                }

                // The to-do tool's result: the checklist it was given, as
                // the plan, once the CLI took it.
                if (call?.todos !== undefined) {

                    const plan = data.success === false ? undefined : planFromTodoChecklist(call.todos);

                    if (plan)
                        return { ...this.common(event), kind: "notice", text: planText(plan), plan };

                    const detail = describeOutcome(data);

                    return {
                        ...this.common(event),
                        kind: "notice",
                        text: `${COPILOT_TODO_TOOL} failed${detail ? `: ${detail}` : "."}`
                    };
                }

                // The other half of the question's own pair.
                if (call?.silent)
                    return { ...this.common(event), kind: "other" };

                // The started event's name first. `toolDescription` is
                // only populated for MCP tools, and is the fallback for
                // a completion whose start was never seen - a session
                // resumed mid-call, say.
                const tool = call?.tool
                    || asText((data.toolDescription as { name?: string } | undefined)?.name);

                const detail = describeOutcome(data);

                return {
                    ...this.common(event),
                    kind: "tool.end",
                    ...(callId ? { callId } : {}),
                    tool,
                    ...(typeof data.success === "boolean" ? { success: data.success } : {}),
                    ...(detail ? { detail } : {}),
                    ...(call ? { ms: Date.now() - call.started } : {})
                };
            }

            case "subagent.started": {

                const name = agentName(data);

                // Registered here, because this is the only event that
                // ever states the name - every bridged event after it
                // carries the instance id and nothing else.
                for (const key of [event.agentId, asText(data.toolCallId)])
                    if (key)
                        this.agents.set(key, name);

                const description = asText(data.agentDescription);
                const model = asText(data.model);

                return this.about(event,
                    `Sub-agent ${name} started`
                        + (description ? `: ${clip(description, VALUE_LIMIT)}` : "")
                        + (model ? ` (model ${model})` : ""));
            }

            case "subagent.completed": {

                const name = agentName(data);

                const stats = [
                    countOf(data.totalToolCalls, "tool call"),
                    typeof data.totalTokens === "number" ? `${tokens(data.totalTokens)} tokens` : "",
                    typeof data.durationMs === "number" ? took(data.durationMs) : ""
                ].filter(Boolean);

                this.forget(event, data);

                return this.about(event,
                    `Sub-agent ${name} ${data.cancelled ? "was cancelled" : "finished"}`
                        + (stats.length ? ` - ${stats.join(", ")}` : ""));
            }

            /*
             * An error, not a notice: a delegated agent that failed did
             * not do the work the main agent believes it did. It does
             * not fail the task - the main agent gets the failure back
             * as a tool result and decides for itself what to do.
             */
            case "subagent.failed": {

                const name = agentName(data);

                this.forget(event, data);

                return {
                    name: event.type,
                    raw: event,
                    kind: "error",
                    message: `Sub-agent ${name} failed: `
                        + (asText(data.error) || "no reason given.")
                };
            }

            case "subagent.selected":

                return this.about(event,
                    `Custom agent ${agentName(data)} selected `
                        + `(${Array.isArray(data.tools) ? `${data.tools.length} tools` : "all tools"}).`);

            case "subagent.deselected":

                return this.about(event, "Custom agent deselected - back to the default agent.");

            /*
             * The runtime's own timeline messages. Both are written to
             * be read by a person and categorised by the CLI itself, so
             * they pass through with their category rather than being
             * re-worded here.
             */
            case "session.info":
            case "session.warning": {

                const message = asText(data.message);

                if (!message)
                    return { ...this.common(event), kind: "other" };

                const category = asText(data.infoType) || asText(data.warningType);
                const tip = asText(data.tip);

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: (category ? `${category}: ` : "") + message + (tip ? ` (${tip})` : "")
                };
            }

            /*
             * Compaction explains behaviour nothing else in the log can:
             * an agent that suddenly forgets what it was told forty
             * turns ago was compacted, and without this line that reads
             * as the model losing the plot.
             */
            case "session.compaction_start":

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: "Compacting the conversation"
                        + (typeof data.currentTokens === "number"
                            ? ` (${tokens(data.currentTokens)} tokens`
                                + (typeof data.tokenLimit === "number"
                                    ? ` of ${tokens(data.tokenLimit)}`
                                    : "")
                                + ")"
                            : "")
                        + "."
                };

            case "session.compaction_complete": {

                if (data.success === false)
                    return {
                        ...this.common(event),
                        kind: "error",
                        message: `Compaction failed: ${asText(data.error) || "no reason given."}`
                    };

                const removed = [
                    countOf(data.messagesRemoved, "message"),
                    typeof data.tokensRemoved === "number" && data.tokensRemoved > 0 ? `${tokens(data.tokensRemoved)} tokens` : ""
                ].filter(Boolean);

                // A short chat's summary can be longer than what it
                // replaced - the count removed is then negative.
                const grew = typeof data.tokensRemoved === "number" && data.tokensRemoved < 0
                    ? ` The summary is ${tokens(-data.tokensRemoved)} tokens longer than what it replaced.`
                    : "";

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: "Conversation compacted"
                        + (removed.length ? ` - ${removed.join(", ")} removed.` : ".")
                        + grew
                };
            }

            /*
             * Copilot's own short name for the conversation, made from
             * the first message. Carried as `title`, so the chat history
             * names the row with it instead of the prompt's first words.
             */
            case "session.title_changed": {

                const title = asText(data.title).trim();

                return title
                    ? { ...this.common(event), kind: "notice", progress: true, text: `Title: ${title}`, title }
                    : { ...this.common(event), kind: "other" };
            }

            /*
             * A server that drops out mid-run takes its tools with it,
             * and the only other symptom is an agent that stops being
             * able to do something it did a minute ago.
             */
            case "session.mcp_server_status_changed":

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: `MCP server ${asText(data.serverName) || "(unnamed)"}: `
                        + (asText(data.status) || "status changed")
                        + (asText(data.error) ? ` - ${clip(asText(data.error), VALUE_LIMIT)}` : "")
                };

            /*
             * A failed API call the CLI will usually retry by itself.
             * Worth a line because the retry is invisible otherwise - a
             * turn that takes four minutes with nothing in the log looks
             * like a hang.
             */
            case "model.call_failure": {

                const reason = asText(data.errorMessage)
                    || asText(data.errorCode)
                    || asText(data.failureKind);

                const model = asText(data.model);

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: `Model call failed${model ? ` (${model})` : ""}`
                        + (reason ? `: ${clip(reason, VALUE_LIMIT)}` : ".")
                };
            }

            /*
             * The turn's bill, one line per API call - and the only
             * place the model that actually ran is named when the
             * session was started on `auto`.
             */
            case "assistant.usage": {

                const bill = [
                    typeof data.inputTokens === "number" ? `${tokens(data.inputTokens)} in` : "",
                    typeof data.outputTokens === "number" ? `${tokens(data.outputTokens)} out` : "",
                    typeof data.reasoningTokens === "number" && data.reasoningTokens
                        ? `${tokens(data.reasoningTokens)} reasoning`
                        : "",
                    typeof data.duration === "number" ? took(data.duration) : ""
                ].filter(Boolean);

                const finish = asText(data.finishReason);

                // What the call charged, in whichever units the account
                // is billed in - see {@link copilotCharge}.
                const cost = copilotCharge(data, this.hidePremiumRequests);

                const model = asText(data.model);

                // One call is one model, so the split is the call
                // itself. With `model: auto` this event is the only
                // place the model that really ran is named.
                const models: ModelSpend[] = model
                    ? [{
                        model,
                        ...(cost.length ? { cost } : {}),

                        // Cache reads and writes are already inside
                        // `inputTokens` - a saved session's totals show
                        // 36,445 as 4 plain + 26,242 read + 10,199 written.
                        inputTokens: typeof data.inputTokens === "number" ? data.inputTokens : 0,
                        outputTokens: typeof data.outputTokens === "number" ? data.outputTokens : 0,
                        ...(typeof data.cacheReadTokens === "number" && data.cacheReadTokens > 0
                            ? { cachedTokens: data.cacheReadTokens }
                            : {})
                    }]
                    : [];

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: `Model call ${model || "(unnamed)"}`
                        + (bill.length ? ` - ${bill.join(", ")}` : "")
                        + (cost.length ? ` - ${cost.map(describeSpend).join(", ")}` : "")
                        + (finish && finish !== "stop" ? ` [${finish}]` : ""),
                    ...(cost.length ? { cost } : {}),
                    ...(models.length ? { models } : {}),

                    // One event is one model call.
                    calls: 1
                };
            }

            /*
             * How full the context window is. Sent by the CLI on its own
             * as the conversation grows, with three buckets - system
             * prompt, tool definitions, conversation - which is the
             * breakdown a meter's hover shows. A heartbeat, so it
             * replaces the last one rather than stacking up.
             */
            case "session.usage_info": {

                const context = copilotContext(data);

                if (!context)
                    return { ...this.common(event), kind: "other" };

                return {
                    ...this.common(event),
                    kind: "notice",
                    progress: true,
                    text: `Context ${Math.round((context.used / context.size) * 100)}% of ${tokens(context.size)} tokens used`,
                    context
                };
            }

            /*
             * Tool search is on for this provider, so the agent starts
             * with most tools deferred and activates them as it goes.
             * Which ones it reached for says what it thinks it is doing.
             */
            case "tool_search.activated": {

                const names = Array.isArray(data.toolNames) ? data.toolNames.map(asText) : [];

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: `Tool search (${asText(data.strategy) || "unknown"}) activated `
                        + `${names.length} tool(s)`
                        + (names.length ? `: ${clip(names.join(", "), LINE_LIMIT)}` : "")
                };
            }

            case "session.plan_changed":

                return {
                    ...this.common(event),
                    kind: "notice",
                    text: `Plan file ${asText(data.operation) || "changed"}.`
                };

            case "session.idle":

                // A sub-agent going quiet is not the conversation going
                // quiet: `agentId` marks events bridged up from a
                // delegated agent, and an "idle" from one of those would
                // flip this session's state - and AgentSessions'
                // `untilIdle` policy - while the main agent is still
                // mid-turn. Only the main agent's own idle counts.
                return event.agentId
                    ? { ...this.common(event), kind: "other" }
                    : { ...this.common(event), kind: "idle" };

            case "session.error":

                return {
                    ...this.common(event),
                    kind: "error",
                    message: asText(data.message) || "The session reported an error."
                };

            default:

                return { ...this.common(event), kind: "other" };
        }
    }

    /**
     * A lifecycle notice, which is *about* a sub-agent rather than
     * *from* one - so it carries no attribution.
     *
     * The `subagent.*` events are tagged with the instance id of the
     * agent they concern, which is the same field a bridged event uses
     * to say who is speaking. Through {@link common} they would come out
     * as "[Explore] Sub-agent Explore started", which reads as the agent
     * announcing its own start.
     */
    private about(event: SdkEvent, text: string): AgentEvent {

        return { name: event.type, raw: event, kind: "notice", text };
    }

    /**
     * One streaming chunk as a `delta` carrying everything this speaker
     * has said so far on this channel.
     *
     * The SDK sends the piece that just arrived (`deltaContent`) and a
     * painter wants the whole of it, so the accumulation lives here -
     * a consumer that missed one chunk would otherwise stay permanently
     * a few words short. Published at most every
     * {@link DELTA_INTERVAL_MS}; a throttled chunk is dropped rather
     * than queued, because the next delta carries it anyway.
     *
     * `other` is the "nothing to say" answer: every consumer already
     * drops it, which is what the SDK's own delta events become.
     */
    private painting(event: SdkEvent, channel: DeltaChannel): AgentEvent {

        const piece = asText(event.data?.deltaContent);

        if (!piece)
            return { ...this.common(event), kind: "other" };

        const key = this.bufferKey(event, channel);
        const text = (this.streamed.get(key) ?? "") + piece;

        this.streamed.set(key, text);

        const now = this.now();

        if (now - (this.lastDelta.get(key) ?? 0) < DELTA_INTERVAL_MS)
            return { ...this.common(event), kind: "other" };

        this.lastDelta.set(key, now);

        return { ...this.common(event), kind: "delta", channel, text };
    }

    /**
     * One chunk of a running tool's output as a `tool.output` event
     * carrying everything that call has printed so far.
     *
     * Accumulated here for the same reason a `delta` is: the CLI sends
     * the piece that just arrived, and a reader that missed one would
     * stay permanently a few lines short. Throttled the same way, and
     * trimmed to {@link OUTPUT_LIMIT} - a build that prints a thousand
     * lines is not worth carrying whole across a `postMessage` ten
     * times a second, and the tail is the part anyone is watching for.
     *
     * `other` is the "nothing to say" answer, which every consumer
     * already drops: the flag being off, a chunk that is empty, a call
     * with no id to attach it to, and a throttled chunk all take it.
     */
    private printing(event: SdkEvent, data: Record<string, unknown>): AgentEvent {

        const callId = asText(data.toolCallId);
        const piece = asText(data.partialOutput);

        if (!this.liveOutput || !piece || !callId)
            return { ...this.common(event), kind: "other" };

        // Not published: the question the agent asked is drawn as a
        // card, and its own tool call has no row for output to sit in.
        const call = this.calls.get(callId);

        if (call?.silent)
            return { ...this.common(event), kind: "other" };

        const grown = (this.output.get(callId) ?? "") + piece;

        const text = grown.length > OUTPUT_LIMIT ? grown.slice(-OUTPUT_LIMIT) : grown;

        this.output.set(callId, text);

        const key = outputKey(callId);
        const now = this.now();

        if (now - (this.lastDelta.get(key) ?? 0) < DELTA_INTERVAL_MS)
            return { ...this.common(event), kind: "other" };

        this.lastDelta.set(key, now);

        return {
            ...this.common(event),
            kind: "tool.output",
            callId,
            text,
            ...(call?.tool ? { tool: call.tool } : {})
        };
    }

    /** One speaker's buffer for one channel - see {@link streamed}. */
    private bufferKey(event: SdkEvent, channel: DeltaChannel): string {

        return `${event.agentId ?? ""}|${channel}`;
    }

    /** The fields every translated event carries, attribution included. */
    private common(event: SdkEvent): { name: string; raw: unknown; agent?: string } {

        const agent = this.attribution(event);

        return agent
            ? { name: event.type, raw: event, agent }
            : { name: event.type, raw: event };
    }

    /**
     * Whose event this is.
     *
     * An id with no registered name still produces one: a bridged event
     * from an agent whose `subagent.started` was missed is still not the
     * main agent talking, and saying so with a short id beats silently
     * crediting it to the conversation - which is the exact confusion
     * this field exists to end.
     */
    private attribution(event: SdkEvent): string | undefined {

        if (!event.agentId)
            return undefined;

        const parent = (event.data as { parentToolCallId?: string } | undefined)?.parentToolCallId;

        return this.agents.get(event.agentId)
            ?? (parent ? this.agents.get(parent) : undefined)
            ?? `sub-agent ${event.agentId.slice(0, 8)}`;
    }

    /** A finished sub-agent is never referenced again; its names go with it. */
    private forget(event: SdkEvent, data: Record<string, unknown>): void {

        for (const key of [event.agentId, asText(data.toolCallId)])
            if (key)
                this.agents.delete(key);
    }
}

/**
 * What a finished tool call has to say for itself: why it failed, or a
 * short account of what came back.
 *
 * A preview rather than the output - the full result is what the
 * *model* reads, and a log carrying it would be a transcript of the
 * repository. Exit codes and the tool's own telemetry come first,
 * since those are always worth the line.
 */
export function describeOutcome(data: Record<string, unknown>): string | undefined {

    const error = data.error as { code?: string; message?: string } | undefined;

    if (error?.message)
        return clip(`${error.code ? `${error.code}: ` : ""}${error.message}`, LINE_LIMIT);

    const result = data.result as {
        content?: string;
        contents?: { exitCode?: number }[];
    } | undefined;

    const parts: string[] = [];

    const exit = result?.contents?.find(block => typeof block?.exitCode === "number")?.exitCode;

    if (typeof exit === "number")
        parts.push(`exit ${exit}`);

    // Whatever the tool chose to count about itself - grep's match
    // count, a checker's finding count. The one summary the vendor
    // wrote on purpose.
    const telemetry = describeArguments(data.toolTelemetry);

    if (telemetry)
        parts.push(telemetry);

    const preview = result?.content ? clip(result.content, VALUE_LIMIT) : "";

    if (preview)
        parts.push(preview);

    return parts.length ? clip(parts.join(" - "), LINE_LIMIT) : undefined;
}

/** A sub-agent by the name a person would recognise. */
function agentName(data: Record<string, unknown>): string {

    return asText(data.agentDisplayName) || asText(data.agentName) || "(unnamed)";
}

/** A duration a person can read at a glance. See {@link describeDuration}. */
const took = describeDuration;

function sdkMessage(message: AgentMessage) {

    return {
        prompt: message.prompt,

        // `displayName` is what the agent sees an attachment called, so
        // a prompt can say "read `how`" and mean a specific file.
        ...(message.attachments?.length
            ? {
                attachments: message.attachments.map(attachment => ({
                    type: "file" as const,
                    path: attachment.path,
                    ...(attachment.name ? { displayName: attachment.name } : {})
                }))
            }
            : {})
    };
}

/**
 * Backstop against waiting forever on a session that never reports
 * idle. The task's own `timeout:` is the real policy.
 */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;

/** Extra attempts `knows` gets when its lookup throws, before giving up. */
const KNOWS_RETRIES = 2;

/** The pause between those attempts - short, because this blocks starting the turn at all. */
const KNOWS_RETRY_DELAY_MS = 500;

/**
 * The slice of the SDK session {@link settleTurn} reads. A structural
 * type rather than `CopilotSession` so the tests can hand in a plain
 * object without loading the CLI.
 */
export interface SettleableSession {

    on(handler: (event: SdkEvent) => void): () => void;

    rpc: {

        tasks: { waitForPending(): Promise<unknown> };

        metadata: { activity(): Promise<{ hasActiveWork: boolean }> };
    };
}

/**
 * Sends one message and resolves when the turn has *really* finished.
 *
 * The SDK's `sendAndWait` resolves on the first `session.idle` event,
 * unconditionally. Copilot delegates work to sub-agents on its own (the
 * CLI ships built-in `task`/`explore` agents), and those can outlive
 * the main agent's turn: a bridged sub-agent idle, or an idle emitted
 * while a background agent or shell is still running, would end that
 * wait with work still in flight - and the engine would mark the task
 * complete.
 *
 * So events are treated as hints and the runtime is asked for the
 * truth: after the main agent's own idle, `tasks.waitForPending()`
 * drains background agents, shells, and the follow-up turns their
 * completions schedule, and `metadata.activity()` then confirms nothing
 * is running. If something still is, the loop goes back to waiting -
 * every completion emits another idle or a `background_tasks_changed`,
 * so there is always a wake-up coming.
 *
 * Both RPCs are marked experimental in SDK 1.0.11. If a future SDK
 * moves them, the catch below degrades to trusting the idle event.
 *
 * Exported so the tests can reach it; nothing here touches the CLI.
 */
export async function settleTurn(
    session: SettleableSession,
    send: () => Promise<unknown>,
    timeoutMs: number | null
): Promise<void> {

    // `null` is no deadline at all - see `AgentSession.sendAndWait`.
    const deadline = timeoutMs === null ? undefined : Date.now() + timeoutMs;

    // The first idle must not be missable, so the subscription exists
    // before the prompt does. `idleSeen` never resets: after the first
    // idle the drain check owns the question "is work still running",
    // and events only decide *when* to ask it again.
    let idleSeen = false;

    // One pending wake-up, consumed by `nextSignal`. Distinct from
    // `idleSeen`, which is a level, not an edge: were the level the
    // signal, every iteration after the first idle would resolve
    // instantly and the loop would spin on the drain check.
    let signalled = false;

    let failure: Error | undefined;

    let wake: (() => void) | undefined;

    const unsubscribe = session.on(event => {

        switch (event.type) {

            case "session.idle":
            case "session.error":

                // A sub-agent's idle or error is the main agent's tool
                // call working itself out, not the turn ending - same
                // rule as `publish`.
                if (event.agentId)
                    return;

                if (event.type === "session.idle")
                    idleSeen = true;

                else {

                    failure = new Error(
                        typeof event.data?.message === "string"
                            ? event.data.message
                            : "The session reported an error.");

                    if (typeof event.data?.stack === "string")
                        failure.stack = event.data.stack;
                }

                break;

            // A background agent or shell finishing does not emit a new
            // idle when no follow-up turn runs - without this wake the
            // loop would sit out the whole backstop timeout on a
            // session that finished long ago.
            case "session.background_tasks_changed":

                break;

            default:

                return;
        }

        signalled = true;
        wake?.();
    });

    const nextSignal = (): Promise<void> => new Promise((resolve, reject) => {

        // An event that arrived while the drain check ran is not lost -
        // it was recorded, and is consumed here instead of waited for.
        if (signalled || failure) {

            signalled = false;
            resolve();
            return;
        }

        const remaining = deadline === undefined ? undefined : deadline - Date.now();

        if (remaining !== undefined && remaining <= 0) {

            reject(settleTimeout(timeoutMs!));
            return;
        }

        const timer = remaining === undefined
            ? undefined
            : setTimeout(() => {

                wake = undefined;
                reject(settleTimeout(timeoutMs!));

            }, remaining);

        wake = () => {

            if (timer !== undefined)
                clearTimeout(timer);
            wake = undefined;
            signalled = false;
            resolve();
        };
    });

    try {

        await send();

        for (; ;) {

            await nextSignal();

            if (failure)
                throw failure;

            // A background-task wake can land before the first idle;
            // the activity check would race the turn spinning up, so
            // nothing is asked until the main agent has yielded once.
            if (!idleSeen)
                continue;

            if (await drained(session))
                return;
        }

    } finally {

        unsubscribe();
    }
}

/** Whether the runtime is fully quiet - no turn, no background agents, no shells. */
async function drained(session: SettleableSession): Promise<boolean> {

    try {

        await session.rpc.tasks.waitForPending();

        return !(await session.rpc.metadata.activity()).hasActiveWork;

    } catch {

        // The experimental RPC surface is gone or broken; the idle
        // event that got us here is the best remaining signal.
        return true;
    }
}

function settleTimeout(timeoutMs: number): Error {

    return new Error(`Timeout after ${timeoutMs}ms waiting for the session to settle`);
}

/**
 * The session settings, with the task's own `extra` applied last - the
 * order is the contract: {@link AgentSessionConfig.extra} promises that
 * naming a key there overrides what the provider set itself.
 *
 * Exported so the tests can reach it. Building the object is pure - no
 * client is started.
 *
 * @param mcp The engine's own MCP configuration, resolved from the
 *            merged `settings.json` scopes by {@link resolveMcpServers} -
 *            the servers plus the session-level tool denials. The one
 *            sanctioned source - see the deletion below for why `extra`
 *            is not allowed to be another.
 */
export function sessionConfig(
    config: AgentSessionConfig,
    directories?: string[],
    mcp?: McpResolution,
    askHook?: AskHook,

    /**
     * `debug` from the profile settings - the person's own switch, and
     * the one thing that opens the jail. Nothing gives the closed one.
     */
    debug = false,

    /**
     * The app's `resources` directory, which the session may read
     * and may not write - see {@link createJail}. Absent when the caller gives none.
     */
    resources?: string,

    /**
     * Told of each request answered "yes" without a card, with what it
     * asked for, so the chat thread can show calls that ran unasked.
     * `callId` is the request's `toolCallId`, when it has one: the id
     * the call's own row carries.
     */
    allowed?: (permission: AskPermission, raw: unknown, callId?: string) => void,

    /**
     * Our own permission check. With it, the pre-tool hook
     * refuses what is never allowed and sends "ask" for what needs a card,
     * and the permission handler shows the card.
     */
    gate?: PermissionGate
): SessionConfig {

    // Only when a person is actually watching. Absent, both handlers
    // below refuse rather than wait - which is why this is one variable
    // read twice rather than two separate guards.
    const ask = config.interactive === true ? askHook : undefined;

    // Built from the same two things the SDK is handed below, so the
    // scope the session is *told* about and the scope actually
    // enforced can never drift apart. `debug` opens it - a
    // profile-only setting, which the loader makes an error in a
    // workspace file, so the switch cannot arrive with a repository.
    const engine = engineDirectories(resources);

    const jail = debug
        ? openJail(config.workingDirectory, directories, engine)
        : createJail(config.workingDirectory, directories, undefined, engine);

    if (debug)
        config.log?.(
            "debug: true in your profile settings - this session may read and write anywhere,"
            + ` not only ${jail.roots.join(", ")}.`,
            "system");

    // The two the passthrough may not replace, named up here so the
    // check below has the provider's own value to compare against.
    // `extra` is spread *inside* the object literal, so by the time it
    // has been applied there is nothing left to compare with.
    //
    // The jail one layer earlier than the permission handler - and
    // this is the layer that actually holds. `onPermissionRequest`
    // only fires for calls that raise a permission request, and this
    // runtime has several ways not to raise one: a tool approval
    // persisted for the location (kept in the location-permissions
    // config file, keyed by git root or working directory, from any
    // earlier session in the same repository), the system temp
    // directory which the path manager allows by default, and
    // allow-all mode. `onPreToolUse` is documented as "called before a
    // tool is executed", not before a prompt, so none of the above
    // routes around it. The permission handler stays as the second
    // line.
    const ourPreToolUse: NonNullable<SessionHooks["onPreToolUse"]> = input => {

        // Our own check. "Ask" makes the runtime raise its permission
        // request even when an approval it kept from an earlier session
        // would skip it; the handler below shows the card. A call allowed
        // here gets no decision: the runtime's own check still runs, and
        // a request it raises reaches the handler, which lets it through.
        if (gate) {

            const decision = gate.decide(copilotToolCall(input.toolName, input.toolArgs), jail);

            if (decision.verdict === "deny") {

                config.log?.(`Denied ${input.toolName}: ${decision.note}`, "system");

                return { permissionDecision: "deny" as const, permissionDecisionReason: decision.reason };
            }

            return decision.verdict === "ask" ? { permissionDecision: "ask" as const } : undefined;
        }

        // The tool's own name is all this hook gets, so the read/write
        // question is answered the same way it is for Claude: an
        // allowlist of the ones that cannot change a file, everything
        // else treated as a write.
        const escape = jail.escape(input.toolArgs, undefined, copilotWrites(input.toolName));

        if (!escape)
            return undefined;

        config.log?.(
            `Denied ${input.toolName}: ${escape.asked} is outside ${jail.roots.join(", ")}`,
            "system");

        return { permissionDecision: "deny" as const, permissionDecisionReason: jail.refusal(escape) };
    };

    // Never one of the autopilot builds - see `exitPlanAction`. Said in
    // the log, since the plan is accepted without a card.
    const ourExitPlanHandler = (request: { actions?: string[]; recommendedAction?: string }) => {

        const action = exitPlanAction(request);

        config.log?.(
            action
                ? `Copilot asked to leave plan mode - accepted, going on as '${action}' (autopilot is never picked).`
                : "Copilot asked to leave plan mode with no choice that keeps it asking - refused, it stays in plan mode.",
            "system");

        return action ? { approved: true, selectedAction: action } : { approved: false };
    };

    const ourPermissionHandler: PermissionHandler = request => {

        if (gate)
            return gatedApproval(request, gate, jail, ask, config, allowed);

        // Here the runtime says outright which it is: `kind` is one of
        // read/write/shell/mcp and the rest, so nothing has to be
        // guessed from a name.
        const escape = jail.escape(request, undefined, request.kind !== "read")
            ?? jail.escape({ paths: copilotRequestPaths(request) }, undefined, copilotRequestWrites(request));

        if (escape) {

            config.log?.(
                `Denied a permission request: ${escape.asked} is outside ${jail.roots.join(", ")}`,
                "system");

            return { kind: "reject" as const, feedback: jail.refusal(escape) };
        }

        // No check of our own: the request is allowed once.
        allowed?.(approvalPermission(request), request, request.toolCallId);

        return { kind: "approve-once" as const };
    };

    // Appended to the CLI's own preset - see `ASK_SYSTEM_PROMPT` and
    // `targetSystemPrompt`. Either part can be absent: the first only
    // when a person is watching, the second only when the task named a
    // target. `systemInstructions` last: it is the caller's own words,
    // the most specific thing here.
    const append = [
        config.interactive === true ? ASK_SYSTEM_PROMPT : undefined,
        config.target ? targetSystemPrompt(config.target, config.workingDirectory) : undefined,
        config.systemInstructions
    ].filter((one): one is string => typeof one === "string" && one.length > 0);

    const ourSystemMessage = append.length
        ? { mode: "append" as const, content: append.join("\n\n") }
        : undefined;

    const options: SessionConfig = {

        clientName: appName(),

        // `model` is a first-class field on AgentSessionConfig and never
        // arrives through `extra` - ai@1 strips it from the passthrough.
        model: config.model ?? "auto",

        // reasoningEffort is not supported when using the "auto" model.
        contextTier: "default",

        // The CLI's own discovery files (mcp-config.json under its
        // home, .mcp.json, .github/mcp.json) still apply - the engine's
        // mcp.json is a fourth source layered explicitly, not a
        // replacement for these three.
        enableConfigDiscovery: true,

        // `append` rather than `replace`: replace mode drops every SDK
        // guardrail including the security ones, and these are facts
        // about the session, not a system prompt of our own.
        ...(ourSystemMessage ? { systemMessage: ourSystemMessage } : {}),

        additionalDirectories: directories,

        toolSearch: {
            enabled: true,
            deferThreshold: 500
        },

        // `githubMcpToolConfig` is left unset on purpose, so the built-in
        // GitHub server gives only its default tool set: every tool's
        // definition costs context on every call, and most tasks never
        // touch GitHub. A stage or task that needs more sets it under
        // `providers.ghcp` in its args - `extra` is spread last, below.

        // On, and its sub-agent twin with it. Streaming buys
        // `assistant.message_delta` and `assistant.reasoning_delta`,
        // ephemeral chunks a client accumulates to paint text as it is
        // typed - the kind is `delta`, see
        // {@link CopilotEventTranslator.painting}. The complete
        // `assistant.message` and `assistant.reasoning` events arrive
        // either way and are what the log is written from, since a
        // delta is ephemeral and never reaches the store.
        //
        // Sub-agent deltas come too: a delegated agent working for two
        // minutes is exactly the silence this exists to fill, and the
        // translator attributes its text the same way it attributes
        // its tool calls.
        streaming: true,

        includeSubAgentStreamingEvents: true,

        enableSessionStore: false,
        
        enableHostGitOperations: true,

        // The SDK leaves an unhandled permission request pending, and
        // no consumer is wired to resolve one - a provider with no
        // handler is a task that hangs until its `timeout:` kills it.
        // So this answers every request: an ai@1 task has the agent's
        // full default toolset, unattended. With our own check
        // (see `gatedApproval`), the answer is the check's, or the
        // person's when it shows a card.
        //
        // Answering is not the same as agreeing. A request naming a
        // path outside the session's own directories is rejected; see
        // {@link createJail}.
        //
        // The whole request is scanned rather than one field per kind.
        // `read` carries `path`, `write` carries `fileName`, and an MCP
        // or custom tool carries whatever its own schema chose - a
        // per-kind table would be a list of the kinds that existed the
        // day it was written.
        hooks: { onPreToolUse: ourPreToolUse },

        onPermissionRequest: ourPermissionHandler,

        // And the handler cannot be switched off underneath us. The
        // runtime has an allow-all ("yolo") mode, reachable over its
        // own RPC, whose `on` state "swaps in unrestricted path and URL
        // managers" - permission requests stop being raised, so the
        // handler above stops being called and the jail with it. This
        // setting is documented as deny-wins: once disabled here it
        // "cannot be re-enabled by any other layer".
        //
        // Host-injected rather than self-fetched. An organisation's own
        // policy still composes on top - the runtime unions `deny`/`ask`
        // across every managed layer and intersects `allow` - so this
        // adds a restriction and takes none away.
        managedSettings: { permissions: { disableBypassPermissionsMode: "disable" as const } },

        onAutoModeSwitchRequest: () => "yes" as const,

        // Plan mode ends with the agent asking to leave it, offering
        // what to do next. Two of those build on autopilot - see
        // `exitPlanAction`. Without a handler the SDK says yes with no
        // pick, and the runtime then goes with its own recommendation.
        onExitPlanModeRequest: ourExitPlanHandler,

        // Our own question tool, in place of the built-in.
        // `overridesBuiltInTool` is the SDK's own word for this: without
        // it, a tool whose name clashes with a built-in is an error,
        // and with it the runtime takes ours instead. It has to be
        // ours, because the built-in `ask_user` is `{ question, choices
        // }` and has no multi-select in it at all - see `askTool`.
        //
        // `skipPermission` because a question is not an action to
        // approve, and `defer: "never"` so it is never hidden behind
        // tool search.
        //
        // With nobody watching, the handler answers in words the agent
        // can act on rather than throwing - a thrown handler ends the
        // turn, where a sentence lets the run finish on a stated
        // assumption.
        tools: [{
            name: ASK_TOOL_NAME,
            description: ASK_TOOL_DESCRIPTION,
            parameters: askToolJsonSchema,
            overridesBuiltInTool: true,
            skipPermission: true,
            defer: "never" as const,
            handler: async (args: unknown) => askQuestions(args as AskToolInput, ask)
        },

        // And two clocks, so the date never costs a shell start - see
        // `timeTools`. Same two flags, for the same reasons.
        {
            name: TIME_NOW_TOOL_NAME,
            description: TIME_NOW_DESCRIPTION,
            parameters: timeToolJsonSchema,
            skipPermission: true,
            defer: "never" as const,
            handler: async () => timeNow()
        }, {
            name: UTC_NOW_TOOL_NAME,
            description: UTC_NOW_DESCRIPTION,
            parameters: timeToolJsonSchema,
            skipPermission: true,
            defer: "never" as const,
            handler: async () => utcNow()
        },

        // Only for a session handed a plan - see `planTools`.
        ...(config.plan
            ? [{
                name: TASK_DONE_TOOL_NAME,
                description: TASK_DONE_DESCRIPTION,
                parameters: planToolJsonSchema,
                skipPermission: true,
                defer: "never" as const,
                handler: async (args: unknown) => markTaskDone(config.plan!, args as PlanToolInput)
            }]
            : []),

        // And for the session writing one.
        ...(config.checkPlan
            ? [{
                name: CHECK_PLAN_TOOL_NAME,
                description: CHECK_PLAN_DESCRIPTION,
                parameters: checkPlanJsonSchema,
                skipPermission: true,
                defer: "never" as const,
                handler: async () => checkPlan(config.checkPlan!)
            }]
            : []),

        // Only when the project has tagged steering files - see `steeringTool`.
        ...(config.steering?.length
            ? [{
                name: STEERING_TOOL_NAME,
                description: steeringDescription(config.steering),
                parameters: steeringToolJsonSchema,
                skipPermission: true,
                defer: "never" as const,
                handler: async (args: unknown) =>
                    answerSteering(config.steering!, args as SteeringToolInput, text => config.log?.(text, "system"))
            }]
            : [])],

        /*
         * An MCP server's own question, which is not the agent's and
         * cannot come through the tool above: the server is asking this
         * client, not the model. The same three shapes and the same
         * reader ACP uses - see `askElicitation`.
         */
        onElicitationRequest: async (context: AcpElicitationRequest) =>
            askElicitation({ mode: "form", ...context }, ask),

        // The engine reads the stream through `session.on` instead, in
        // CopilotAgentSession.
        onEvent: () => { /* no-op */ },

        // Last, so a task can override anything above it - the order
        // is the contract this file's doc comment states.
        ...(config.extra ?? {})
    };

    // The keys `extra` may not carry. Handled after the spread so they
    // are unreachable from every direction.
    //
    // MCP servers are machine setup, not workflow definition, so a
    // `mcpServers:` block a workflow smuggles in through the
    // passthrough is removed before the SDK sees it. The sanctioned
    // source is `settings.json`'s `ai.mcpServers`, which arrives
    // through the parameter below.
    delete (options as Record<string, unknown>).mcpServers;

    // And the jail cannot be unlocked from the file it confines.
    // `extra` is arbitrary YAML from a workflow. A workflow that can
    // hand back its own `onPermissionRequest`, or widen
    // `additionalDirectories`, can approve its own way out - and then
    // the check above is decoration. These two are the passthrough's
    // limit, in exchange for `extra` being able to set everything else.
    // This is a deliberate narrowing of the "extra overrides
    // everything" contract, and the only one besides `mcpServers`.
    if (options.onPermissionRequest !== ourPermissionHandler) {

        config.log?.("Ignored onPermissionRequest from extra: a workflow may not approve its own escapes.", "system");

        options.onPermissionRequest = ourPermissionHandler;
    }

    if (options.onExitPlanModeRequest !== ourExitPlanHandler) {

        config.log?.("Ignored onExitPlanModeRequest from extra: it could leave plan mode on autopilot.", "system");

        options.onExitPlanModeRequest = ourExitPlanHandler;
    }

    if (options.additionalDirectories !== directories) {

        config.log?.("Ignored additionalDirectories from extra: it would widen the directories this session may use.", "system");

        options.additionalDirectories = directories;
    }

    /*
     * `systemInstructions` is the one channel for standing instruction -
     * see `AgentSessionConfig.systemInstructions`. It always appends,
     * into `ourSystemMessage` above, so a passthrough naming this
     * runtime's own field directly is ignored rather than merged (it
     * would replace the append built above outright, guardrail text and
     * all), and the other provider's name for the same idea is ignored
     * too rather than silently doing nothing here.
     */
    for (const key of ["systemMessage", "systemPrompt"] as const) {

        const seen = (options as Record<string, unknown>)[key];

        if (seen === undefined || (key === "systemMessage" && seen === ourSystemMessage))
            continue;

        config.log?.(
            `Ignored '${key}' from extra: standing instructions go through 'systemInstructions', which `
            + "always appends rather than replaces.", "system");

        if (key === "systemMessage" && ourSystemMessage)
            options.systemMessage = ourSystemMessage;
        else
            delete (options as Record<string, unknown>)[key];
    }

    // The pre-tool hook is the gate that actually holds, so a workflow
    // replacing it replaces the boundary. Ours goes back in whole - a
    // merge would leave a task's own hook running beside it with no
    // stated precedence.
    if (options.hooks?.onPreToolUse !== ourPreToolUse) {

        config.log?.("Ignored hooks from extra: a workflow may not replace the check that keeps it in its directories.", "system");

        options.hooks = { onPreToolUse: ourPreToolUse };
    }

    // The lock on allow-all mode, for the same reason: a workflow that
    // can lift it can stop the handler above ever being called.
    if (options.managedSettings?.permissions?.disableBypassPermissionsMode !== "disable") {

        config.log?.("Ignored managedSettings from extra: a workflow may not re-enable bypass-permissions mode.", "system");

        options.managedSettings = { permissions: { disableBypassPermissionsMode: "disable" as const } };
    }

    // The engine's own servers, last of all - after the deletion, so
    // the order proves the file is the only way in. Normalized on the
    // way through: on Windows, nothing else in this build makes a
    // portably-written `command: npx` actually start - see
    // {@link normalizeMcpServers}. Assigned only when there are servers
    // to assert: handing the SDK `mcpServers: undefined` is a
    // statement, not the statement "the engine had none to add".
    if (mcp && Object.keys(mcp.servers).length)
        options.mcpServers =
            normalizeMcpServers(mcp.servers, { dialect: "copilot" }) as SessionConfig["mcpServers"];

    return options;
}

/**
 * One permission request under our own check: decided, and put to the
 * person as our card when it needs one. The runtime's own remember
 * answers (session, workspace, always) are never sent: what is saved is
 * ours.
 */
async function gatedApproval(
    request: PermissionRequest,
    gate: PermissionGate,
    jail: PathJail,
    ask: AskHook | undefined,
    config: AgentSessionConfig,
    allowed?: (permission: AskPermission, raw: unknown, callId?: string) => void
): Promise<PermissionRequestResult> {

    const call = copilotRequestCall(request);
    const shown = approvalPermission(request);
    const decision = gate.decide(call, jail);

    const mark = (note: string, refused = false): void =>
        allowed?.(gatePermission(shown.tool, shown.input, { note, ...(refused ? { refused: true } : {}) }), request, request.toolCallId);

    if (decision.verdict === "allow") {

        if (decision.note)
            mark(decision.note);

        return { kind: "approve-once" };
    }

    if (decision.verdict === "deny") {

        config.log?.(`Denied a permission request: ${decision.note}`, "system");

        mark(decision.note, true);

        return { kind: "reject", feedback: decision.reason };
    }

    if (!ask) {

        // Nobody watching. A path outside the folders stays refused; the
        // rest is allowed once.
        if (decision.card.type === "outside") {

            config.log?.(`Denied a permission request: ${decision.card.shown} is outside the chat's folders, and nobody is watching to ask.`, "system");

            return { kind: "reject", feedback: `Denied: ${decision.card.shown} is outside the directories this session may use.` };
        }

        config.log?.("A permission card is due, but nobody is watching this session, so the request was allowed once.", "system");

        return { kind: "approve-once" };
    }

    const answer = await askCard(ask, gate, call, decision.card, shown.input);

    if (!answer) {

        config.log?.(`Permission request (${request.kind}): ${UNANSWERED_TEXT}`, "system");

        mark(UNANSWERED_NOTE, true);

        return { kind: "user-not-available" };
    }

    config.log?.(`Permission request (${request.kind}) answered: ${answer.note}`, "system");

    mark(answer.note, !answer.allow);

    return answer.allow
        ? { kind: "approve-once", approvedInteractively: true }
        : { kind: "reject", feedback: deniedText(answer) };
}

/**
 * The session options as text - every key, exactly as sent. Handlers
 * are named rather than dropped (JSON.stringify drops functions), and
 * an explicit `undefined` is shown as `[unset]` because "absent" and
 * "sent as undefined" are different facts. Never throws: a log line is
 * not worth failing a session over.
 */
export function describeOptions(options: unknown): string {

    try {

        return JSON.stringify(options, (key, value) => {

            // Public properties only. A name starting with `_` belongs
            // to the object rather than to a reader, and printing one
            // is both noise and a hazard: a live object's private
            // fields are where a cycle lives, and a cycle throws,
            // turning the whole log line into one error string. First,
            // so a private function is dropped rather than named.
            if (key.startsWith("_"))
                return undefined;

            if (typeof value === "function")
                return "[handler]";

            if (value === undefined)
                return "[unset]";

            // Never print a secret: an MCP server's `env` and `headers`
            // arrive here with `${{ env.NAME }}` already expanded. See
            // `redactSecrets`.
            return redactSecret(key, value) ?? value;

        }, 2);

    } catch (error) {

        return `<could not be printed: ${error instanceof Error ? error.message : String(error)}>`;
    }
}

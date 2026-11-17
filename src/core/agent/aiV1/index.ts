import * as fs from "fs";
import * as path from "path";

import { hasContent } from "../../loader/hasContent";

import { PluginContext, PluginResult } from "../../plugins/Plugin";
import { AgentProviders } from "../AgentProvider";
import { AgentSessions } from "../AgentSessions";
import {
    AgentEvent,
    AgentMessage,
    AgentSession,
    describeEvent,
    isMutatingTool
} from "../AgentSession";
import { PROVIDERS_KEY } from "../providerBlocks";
import { McpSelection, parseMcpSelection } from "../providers/mcpConfig";
import { loadEngineSettings } from "../../settings/engineSettings";
import {
    alwaysAttachments,
    fileMatchAttachments,
    findSteering,
    mentionedSteering,
    taggedEntries,
    unknownMentions
} from "../steering/steering";

/**
 * `ai@1` - runs an agent session in the workspace, on whichever provider
 * the task names.
 *
 * Part of the engine, not the plugin library: every spec phase runs on
 * it, its conversations outlive the tasks that start them, and surfaces
 * react to its events.
 *
 * The vendor is an argument (`provider:`), not a separate task id, so
 * one manifest serves every vendor.
 *
 * It enforces no gate and has no read-only preset. To review output
 * before the next task runs, put `trigger: manual` on that task. A
 * session that must not touch the repository says so in `deny`.
 */
type AgentInputs = {

    prompt: string;

    /**
     * Which registered provider runs the session. The manifest defaults
     * it; `deps.provider` covers a caller that bypassed the host.
     */
    provider?: string;

    model?: string;

    /** Named documents laid into the session before the prompt - see the manifest. */
    context?: Record<string, unknown>;

    /**
     * Files the session may open, rather than content pasted into the
     * prompt. Absolute paths, not necessarily inside the working
     * directory - an instruction file shipped with Eesha Code is a
     * valid attachment.
     */
    attachments?: { path: string; name?: string }[];

    /**
     * Start the session and return its id without waiting for the turn.
     *
     * The agent still does the work. The session goes to the engine's
     * registry, which holds it until it goes idle, and a surface can
     * offer to open it. Nothing is verified afterwards, because nothing
     * has happened yet when this returns.
     */
    detach?: boolean;

    /**
     * Delete the provider's stored conversation once the task succeeds.
     *
     * Defaulted false by the manifest. Only a successful, waited session
     * is ever deleted: a failed one is the conversation most worth
     * reopening, and a detached one was started for a person to join.
     */
    cleanup?: boolean;

    /** The file the session must produce - told to the agent, verified on disk after. */
    target?: string;

    /**
     * Standing instruction for every turn, appended to the provider's own
     * guardrails rather than replacing them - see {@link
     * AgentSessionConfig.systemInstructions}.
     *
     * Either the text itself, or `file://` followed by a full path -
     * built from this build's own path variables (`${{ workspaceFolder
     * }}`, `${{ workspaceConfig }}`, `${{ home }}`, `${{ cwd }}`; see
     * `TemplateResolver`), already resolved by the time this plugin sees
     * it, since a workflow file and a style's `ai:` are both read through
     * the same templating - so this plugin only ever opens a path, never
     * writes one out itself. Read once, when the session starts.
     */
    systemInstructions?: string;

    /**
     * The plan whose checkboxes the session may tick with the
     * `task_done` tool - see `AgentSessionConfig.plan`. Relative to the
     * working directory unless absolute.
     */
    plan?: string;

    /**
     * The plan the session is writing, whose draft the `check_plan` tool
     * reads - see `AgentSessionConfig.checkPlan`. Relative to the
     * working directory unless absolute.
     */
    checkPlan?: string;

    /**
     * The files this session is known to work on, relative to the
     * working directory - an SDD implement wave's `Files:` lines. A
     * `fileMatch` steering file whose pattern matches one of them is
     * attached to the first message.
     */
    files?: string[];

    /**
     * Files this session may not write, relative to the working
     * directory unless absolute - see `AgentSessionConfig.refuseWrites`.
     */
    refuseWrites?: string[];

    /**
     * Hold the session after this turn instead of disposing it, so a
     * later call naming this run's session id as `continueSession` can
     * pick the same conversation back up. Off by default.
     */
    keep?: boolean;

    /**
     * An id from an earlier `keep: true` run.
     *
     * Looked up in the held-session registry before a new session is
     * built. Found: this turn runs on it, so the agent has its own memory
     * of the earlier conversation on top of what the prompt supplies.
     * Not found: a new session starts.
     */
    continueSession?: string;

    /** A short human title, sent as the prompt's first line - what a chat history names the session. */
    title?: string;

    /**
     * The prompt is already the whole message - send it exactly as given.
     *
     * Off, this plugin builds the message itself: title, `context`
     * documents, prompt, then the `target` instruction. That composed
     * text is what gets logged. A rerun handing back the edited log text
     * is handing back an already-composed message; composing it again
     * would repeat the title, documents and target instruction.
     *
     * `attachments` are unaffected: they are files, not prompt text.
     */
    verbatim?: boolean;

    /**
     * What the log shows as the message, when it is not what is sent - a
     * chat gone back to an earlier message puts a note in front of what
     * the person typed, and shows only what they typed. Read only with
     * `verbatim`. Not in the manifest: only the chat puts it here.
     */
    shown?: unknown;

    /**
     * A person is watching this session in a panel and can answer a
     * question the agent asks.
     *
     * Off by default: a question with nobody to answer it must not wait.
     * See `AgentSessionConfig.interactive` for what the provider does
     * with each setting. A workflow file that sets it owes the run a
     * person at the panel.
     */
    interactive?: boolean;

    /**
     * The agent's own mode (Kiro v3's `spec`, `plan`...), picked in the
     * compose box - see `AgentSessionConfig.agentMode`. Not in the
     * manifest: only the pick puts it here.
     */
    agentMode?: unknown;

    /**
     * How hard the model thinks, picked in the compose box - see
     * `AgentSessionConfig.effort`. Not in the manifest, like `agentMode`.
     */
    effort?: unknown;

    /**
     * Env var names `${{ env.NAME }}` in an MCP declaration may read. Names
     * only, never values - one grant among three (settings.json's
     * `env.allowed` and the workflow's own `env:` block are the others),
     * and `env.denied` vetoes them all. The gate stops a committed
     * settings file reading arbitrary secrets off the machine.
     */
    allowedEnv?: string[];

    /**
     * Which of settings.json's MCP servers, and which of their tools,
     * this session gets. Both allowlists, both optional, absence means
     * all. Shape-checked here; whether the names exist is checked where
     * the declarations are. See `McpSelection`.
     */
    mcp?: unknown;

    /**
     * Anything the manifest does not declare, handed to the provider as
     * written. The manifest is `passthrough: true`, so an undeclared arg
     * arrives here instead of failing the task.
     */
    [key: string]: unknown;
};

export interface AgentPluginDeps {

    providers: AgentProviders;

    /** Where a detached conversation goes when the task is done with it. */
    sessions: AgentSessions;

    /**
     * The provider a task that names none runs on. A fallback for direct
     * callers (a test, or SDD assembling a task by hand); the manifest
     * already defaults `provider:` for anything coming through the host.
     */
    provider: string;

    /**
     * How long a detached session is held if it never reports idle.
     * Injected so a test does not have to outlive it.
     */
    maxHoldMs?: number;

    /**
     * Whether the `steering` feature flag is on. Read from `settings.json`
     * when not given; injected so a test does not read this machine's
     * profile.
     */
    steeringOn?: () => Promise<boolean>;
}

/**
 * The `steering` flag from `settings.json`. Off when the settings cannot
 * be read: the provider reads the same file and says what is wrong with it.
 */
async function steeringFlag(deps: AgentPluginDeps): Promise<boolean> {

    if (deps.steeringOn)
        return deps.steeringOn();

    try {

        return (await loadEngineSettings(deps.providers.workspaceFolder())).features.steering;

    } catch {

        return false;
    }
}

/**
 * The args this plugin reads itself. Everything else is the provider's.
 *
 * A list rather than the manifest's own keys, so a documentation edit
 * to the manifest cannot change what runs.
 */
const OWN_ARGS = new Set([
    "prompt", "provider", "model",
    "context", "attachments", "detach", "cleanup", "target", "title",
    "allowedEnv", "mcp", "keep", "continueSession", "interactive", "verbatim", "shown",
    "systemInstructions", "plan", "checkPlan", "files", "refuseWrites", "agentMode", "effort"
]);

/** The value `systemInstructions` names a file rather than holding text itself. */
const FILE_PREFIX = "file://";

/**
 * `systemInstructions`, resolved to plain text - the file read now, once,
 * so `extraFrom` never sees it (it is an own arg, not passthrough) and
 * every provider downstream gets text rather than a path it would each
 * have to open itself.
 *
 * A relative path is read against `cwd`, the session's own working
 * directory - the same root `target` resolves against a few lines above
 * this function's callers. A style or workflow wanting a file elsewhere
 * writes a full path with this build's own path variables, already
 * resolved by the time this plugin sees the arg.
 */
function resolveSystemInstructions(value: unknown, cwd: string): string | undefined {

    if (value === undefined || value === null)
        return undefined;

    if (typeof value !== "string" || !value.trim())
        throw new Error("'systemInstructions' must be text, or 'file://' followed by a path.");

    if (!value.startsWith(FILE_PREFIX))
        return value;

    const named = value.slice(FILE_PREFIX.length).trim();

    if (!named)
        throw new Error("'systemInstructions: file://' names no path.");

    const resolved = path.isAbsolute(named) ? named : path.join(cwd, named);

    try {

        return fs.readFileSync(resolved, "utf8");

    } catch {

        throw new Error(`'systemInstructions: ${value}' names a file that could not be read: ${resolved}.`);
    }
}

/**
 * What this registry is holding instead, named. Nothing held means
 * something let the session go; something else held means the id moved.
 */
function held(sessions: AgentSessions): string {

    const ids = sessions.all().map(entry => entry.id);

    return ids.length
        ? `Held now: ${ids.slice(0, HELD_NAMED).join(", ")}${ids.length > HELD_NAMED ? " and others" : ""}.`
        : "Nothing is held now.";
}

/** How many held ids a diagnostic names before it stops listing. */
const HELD_NAMED = 5;

/**
 * What became of a session that could not be continued, as one clause.
 * A session this server ended and one it never held have different
 * causes and different fixes.
 */
function departure(sessions: AgentSessions, id: string): string {

    const gone = sessions.departureOf(id);

    if (!gone)
        return "this server has never held it, so it belongs to a server that has since stopped.";

    const what = gone.reason === "ended" ? "it was ended"
        : gone.reason === "forgotten" ? "it was deleted"
            : "it was replaced";

    return `${what} ${ago(gone.at)}.`;
}

/** How long ago something happened, in the coarsest unit that still says. */
function ago(at: number): string {

    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));

    return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/**
 * Args this plugin does not recognise, for the provider. Undefined when
 * there are none, so a provider can tell "nothing passed" from "an empty
 * map passed".
 */
function extraFrom(args: AgentInputs): Record<string, unknown> | undefined {

    const extra = Object.fromEntries(
        Object.entries(args).filter(([name]) => !OWN_ARGS.has(name)));

    return Object.keys(extra).length ? extra : undefined;
}

/**
 * The prompt the session actually receives: the context documents, each
 * under a named delimiter, then the instructions.
 *
 * Instructions go last: the nearest text is the one an agent weights
 * most. Documents that resolved empty (an `optional:` file that was not
 * there) are left out, because an empty section invites the agent to
 * remark on it.
 */
export function withContext(prompt: string, context: Record<string, unknown> | undefined): string {

    const documents = Object.entries(context ?? {})
        .map(([name, value]) => [name, typeof value === "string" ? value : JSON.stringify(value, null, 2)] as const)
        .filter(([, text]) => text.trim().length > 0);

    if (!documents.length)
        return prompt;

    const sections = documents.map(([name, text]) =>
        `=== DOCUMENT: ${name} ===\n\n${text.trim()}`);

    return `${sections.join("\n\n")}\n\n=== INSTRUCTIONS ===\n\n${prompt}`;
}

/**
 * Appends the target to the instructions, last, where a model weights
 * hardest.
 *
 * The path stays relative, but the working directory it is relative to
 * is named. A bare relative path can be resolved against the wrong
 * repository; an absolute one would put a machine's directory layout
 * into a chat transcript.
 *
 * `config.target` (see {@link AgentSessionConfig.target}) says the same
 * thing again on a provider's own system-prompt channel, where it
 * survives a session that goes on to read a great deal before writing
 * anything. This paragraph is what a provider with no such channel
 * still has - never removed on the strength of the other one existing.
 */
export function withTarget(prompt: string, target: string | undefined, cwd: string): string {

    if (!target)
        return prompt;

    return `${prompt}\n\n## Target\n\n` +
        `Write the finished document to \`${target}\`, relative to the working directory ` +
        `this session was started in (\`${cwd}\`) - not to wherever a shell happens to be. ` +
        `Create the file if it does not exist; overwrite it if it does.`;
}

/**
 * Built with its dependencies, so a test can drive the whole plugin
 * against a fake provider.
 */
export function createExecute(deps: AgentPluginDeps) {

    return async function execute(args: AgentInputs, ctx: PluginContext): Promise<PluginResult> {

        const aborter = new AbortController();

        ctx.onCancel(() => aborter.abort());

        if (ctx.cancelled)
            aborter.abort();

        // Blocks are resolved before a plugin runs - by the host for a
        // workflow step, by SDD for a phase. One arriving here means a
        // caller skipped that, and passing it on would hand every
        // runtime's options to this one.
        if (args[PROVIDERS_KEY] !== undefined)
            return {
                success: false,
                message: `'${PROVIDERS_KEY}' reached ai@1 unresolved. It is resolved before the plugin runs; `
                    + "a direct caller has to apply the running runtime's block itself."
            };

        const prepared = await prepare(deps, args);

        // Before the session starts, so a configuration error reads as
        // one.
        if ("message" in prepared)
            return { success: false, message: prepared.message };

        // `providerId` is not logged here: the host's `Args:` block
        // already prints `provider`.
        const { provider } = prepared;

        const absoluteTarget = args.target
            ? path.isAbsolute(args.target) ? args.target : path.join(ctx.cwd, args.target)
            : undefined;

        // A wrong shape is a workflow file mistake and must fail the
        // task. A security allowlist is never coerced: a string where a
        // list was meant must not quietly allow nothing, or something.
        if (args.allowedEnv !== undefined && (
            !Array.isArray(args.allowedEnv)
            || args.allowedEnv.some(name => typeof name !== "string")))
            return {
                success: false,
                message: "'allowedEnv' must be a list of environment variable names, "
                    + "e.g. allowedEnv: [ADO_PAT]."
            };

        if (args.files !== undefined && (
            !Array.isArray(args.files)
            || args.files.some(file => typeof file !== "string")))
            return {
                success: false,
                message: "'files' must be a list of paths relative to the working directory, e.g. files: [src/api/users.ts]."
            };

        if (args.refuseWrites !== undefined && (
            !Array.isArray(args.refuseWrites)
            || args.refuseWrites.some(file => typeof file !== "string")))
            return {
                success: false,
                message: "'refuseWrites' must be a list of paths relative to the working directory, e.g. refuseWrites: [specs/one/tasks.md]."
            };

        // Same for `mcp:`. Shape only; the names are checked when the
        // provider resolves the declarations.
        let mcp: McpSelection | undefined;

        try {

            mcp = parseMcpSelection(args.mcp);

        } catch (error) {

            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }

        const agentMode = typeof args.agentMode === "string" && args.agentMode.trim()
            ? args.agentMode.trim()
            : undefined;

        const effort = typeof args.effort === "string" && args.effort.trim()
            ? args.effort.trim()
            : undefined;

        // Read now, once, so a missing file fails the task here rather
        // than deep inside a provider that has no `ctx.log` of its own.
        let systemInstructions: string | undefined;

        try {

            systemInstructions = resolveSystemInstructions(args.systemInstructions, ctx.cwd);

        } catch (error) {

            return { success: false, message: error instanceof Error ? error.message : String(error) };
        }

        let session: AgentSession | undefined;

        // Set only where the success result is built, so every failure
        // path (throw, missing target, cancellation) leaves the session
        // behind to be read.
        let succeeded = false;

        // Set once a detached session is held by the registry, which
        // then owns its end - see `finally`.
        let handedToRegistry = false;

        // Hoisted so `finally` can stop this call's listener before the
        // session is held; otherwise a later turn on a kept session
        // would log through both listeners.
        let seen: ReturnType<typeof collect> | undefined;

        try {

            // A held session from an earlier `keep: true` run. Not found
            // is not an error - a new session starts below.
            const continuing = args.continueSession ? deps.sessions.get(args.continueSession) : undefined;

            // The `onCancel` registered above reaches this call's own
            // `aborter`, and a fresh session is wired to that signal at
            // creation, a few lines down. A continued session is not -
            // it was created on an earlier call, whose own `aborter`
            // cannot be reached again. Without this handler a Stop
            // pressed on this turn would do nothing. `abort()` is every
            // provider's own turn-stop, so a second handler reaches it
            // directly. This only fires from this call's own cancel
            // hook, which only fires from this call's own Stop - one
            // phase's Stop does not reach another phase's turn.
            if (continuing)
                ctx.onCancel(() => void continuing.abort());

            // The same for the agent's mode: switched in place, so a
            // mode picked mid-conversation holds from this turn on.
            await continuing?.setAgentMode?.(agentMode);
            await continuing?.setEffort?.(effort);

            // The project's steering files, found before a session is
            // built so its `steering` tool can list their tags. A held
            // session already has its tools. A resumed one is built
            // again, so it needs them too.
            // Nothing at all while the `steering` feature flag is off.
            const steeringOn = await steeringFlag(deps);

            const found = continuing || !steeringOn
                ? { files: [], skipped: [] }
                : await findSteering([ctx.cwd, ...deps.providers.directories()]);

            // What goes on a new chat's first message: every `always`
            // file, and every `fileMatch` file whose pattern matches one
            // of the files this chat is known to work on. None on a
            // continued chat, which already has them.
            const steering = args.continueSession
                ? []
                : [...alwaysAttachments(found.files), ...fileMatchAttachments(found.files, args.files ?? [])];

            // The tool does not offer a file the chat was already given.
            const tagged = taggedEntries(found.files)
                .filter(entry => !steering.some(one => one.path === entry.path));

            session = continuing ?? await provider.createSession({
                workingDirectory: ctx.cwd,
                env: ctx.env,
                model: args.model,
                allowedEnv: args.allowedEnv,
                mcp,
                extra: extraFrom(args),

                // Told as a standing instruction on the providers that
                // support one (see `AgentSessionConfig.target`), on top
                // of the `## Target` paragraph `withTarget` still puts in
                // the prompt below - a provider with no system-prompt
                // channel of its own still gets it that way.
                target: args.target,

                // Resolved above - text as written, or a `file://` path
                // already read. See `AgentSessionConfig.systemInstructions`.
                systemInstructions,

                // Absolute for the provider; the tool reads and writes it.
                ...(args.plan
                    ? { plan: path.isAbsolute(args.plan) ? args.plan : path.join(ctx.cwd, args.plan) }
                    : {}),
                ...(args.checkPlan
                    ? { checkPlan: path.isAbsolute(args.checkPlan) ? args.checkPlan : path.join(ctx.cwd, args.checkPlan) }
                    : {}),
                ...(args.refuseWrites?.length
                    ? { refuseWrites: args.refuseWrites.map(one => path.isAbsolute(one) ? one : path.join(ctx.cwd, one)) }
                    : {}),

                // Tagged steering files, for the `steering` tool.
                ...(tagged.length ? { steering: tagged } : {}),

                // The registry only holds what this process started, so
                // it is empty after a restart. The runtimes keep their
                // own transcripts on disk, so the id is still handed
                // over. A provider that cannot reopen it starts fresh
                // and says so.
                ...(args.continueSession ? { resume: args.continueSession } : {}),

                signal: aborter.signal,

                // `=== true` so only a deliberate setting turns it on: a
                // truthy string in a workflow file is not a person at a
                // panel.
                interactive: args.interactive === true,

                // Which conversation the session belongs to: the host's
                // permission check files its saved answers under it.
                chat: `${ctx.runId}/${ctx.taskId}`,

                ...(agentMode ? { agentMode } : {}),

                ...(effort ? { effort } : {}),

                // Wrapped, because `ctx.log` is a method on the host's
                // context and a detached reference would lose its task.
                log: (text, stream) => ctx.log(text, stream),

                // Every value the env gate resolves is registered, so a
                // granted credential an agent echoes comes back as `***`.
                registerSecret: value => ctx.registerSecret?.(value)
            });

            // Reported before the first turn, so a surface can offer to
            // open the conversation while the agent is still in it.
            // Held here or reopened by the provider reads the same.
            const carriedOn = continuing !== undefined || session.resumed === true;

            // A continue that cannot be honoured is a failed call, not a
            // fresh start. The person asked for that conversation; a new
            // one starting cold behind their back would re-read the
            // repository and answer with none of what was said. The
            // provider has already logged why it could not reopen the
            // transcript. The session it opened instead is let go here,
            // before it is reported or held, so nothing records its id.
            if (args.continueSession && !carriedOn) {

                const fresh = session;

                session = undefined;

                await fresh.dispose();

                // `resumeFailure` is the provider's own answer to "why
                // not", when it has one - "the transcript is gone" reads
                // very differently from "the lookup itself kept failing",
                // and a generic line covering both would flatten that
                // difference away. `departure` is a second, separate
                // fact - what this server's own registry saw happen to
                // the id - and worth keeping alongside rather than
                // instead of, since a provider with no reason to give
                // still leaves that question worth answering.
                throw new Error(
                    `Could not continue session ${args.continueSession}: `
                    + (fresh.resumeFailure ? `${fresh.resumeFailure}. ` : "the runtime could not reopen it. ")
                    + `This server - ${departure(deps.sessions, args.continueSession)} `
                    + `Nothing was sent. Start a new session to go on. ${held(deps.sessions)}`);
            }

            ctx.log(carriedOn ? `Continuing session: ${session.id}` : `Session: ${session.id}`, "system");

            ctx.reportSession(session.id);

            // Held with no policy (no `untilIdle`, no timer) so a panel
            // can find the session by id during the turn and answer a
            // question the agent asks. The `finally` below decides its
            // lifetime: `keep` and `detach` re-hold it with their own
            // policy, everything else ends it through the registry. A
            // continued session is already there.
            if (!continuing)
                deps.sessions.hold(ctx.runId, session, {});

            seen = collect(session, ctx);

            // Told relative, verified absolute (see `absoluteTarget`).
            const composed = withContext(
                withTarget(args.prompt, args.target, ctx.cwd), args.context);

            // The steering files worked out above go on even a `verbatim`
            // message, since they are files, not prompt text. A file the
            // caller already attached is not added twice.

            // Said once, on the chat that could have used the file.
            if (!args.continueSession)
                for (const one of found.skipped)
                    ctx.log(`Steering file ${one.relative} was skipped: ${one.problem}.`, "system");

            // A message a person typed (`verbatim`) can name a `manual`
            // steering file as `@name`, for this message only - on a new
            // chat or a continued one.
            const mentioned = args.verbatim && steeringOn
                ? await mentionedSteering(args.prompt, [ctx.cwd, ...deps.providers.directories()])
                : { attachments: [], unknown: [] };

            const notFound = unknownMentions(mentioned.unknown);

            if (notFound)
                ctx.log(notFound, "system");

            const attached = new Set<string>();

            const attachments = [...(args.attachments ?? []), ...steering, ...mentioned.attachments].filter(one => {

                const key = path.resolve(one.path).toLowerCase();

                return attached.has(key) ? false : (attached.add(key), true);
            });

            const message = {

                // The title leads: chat histories name a session by its
                // opening text. `verbatim` sends the prompt as given.
                // Attachments still go either way: they are files, not
                // prompt text.
                prompt: args.verbatim
                    ? args.prompt
                    : args.title ? `${args.title}\n\n${composed}` : composed,
                ...(attachments.length ? { attachments } : {})
            };

            // The composed prompt, so that context documents and the
            // target instruction show in the log.
            // `prompt` is not a provider event kind: this is the one
            // line in the conversation the engine wrote itself, and a
            // surface needs it to tell the question from the answer.
            // Attachments go on the line too, since they are not in the
            // text. `shown` replaces the text on a verbatim send - see
            // its doc.
            ctx.log(args.verbatim && typeof args.shown === "string" ? args.shown : message.prompt, "stdout", {
                kind: "prompt",
                ...(message.attachments?.length ? { attachments: message.attachments } : {})
            });

            // The session is handed to the registry, not to `finally`,
            // so it is not torn down before anyone can join it. Nothing
            // is listed or verified: "no files were changed" would be
            // misleading, and an unwritten target is not a failure yet.
            if (args.detach) {

                await session.send(message);

                // The task stops listening and the registry starts. A
                // subscription that outlived its task would log into a
                // context nobody is reading.
                seen.stop();

                // `detach`'s own policy is "hold until idle" - the right
                // default for a task nobody is going to talk to again.
                // `keep` means the opposite of that by definition ("hold
                // instead of disposing it"), so a caller naming both
                // gets `keep`'s policy: held with no backstop, the same
                // as a waited turn with `keep: true` and no `detach`.
                deps.sessions.hold(ctx.runId, session, args.keep
                    ? {}
                    : { untilIdle: true, maxHoldMs: deps.maxHoldMs });

                handedToRegistry = true;

                ctx.log(`Session ${session.id} started.`, "system");

                return { success: true, session: { id: session.id } };
            }

            // No backstop with a person at the panel: a turn waiting on
            // their answer would trip it, and Stop is their way out. The
            // hour stays for an unattended run, where nothing else ends
            // a session that never reports idle unless the task set its
            // own `timeout:`.
            await sendAndWaitWithRetries(session, message, ctx, args.interactive === true ? null : undefined);

            // "What changed" is what a person needs at the gate that
            // follows.
            if (seen.files.length)
                ctx.log(`Changed ${seen.files.length} file(s):\n  ${seen.files.join("\n  ")}`, "system");
            else
                ctx.log("No files were changed.", "system");

            // The task's contract is the file, not the agent's word. A
            // missing or empty target is a failed task; otherwise the
            // next phase starts from a document that is not there.
            if (absoluteTarget) {

                if (!fs.existsSync(absoluteTarget))
                    return {
                        success: false,
                        session: { id: session.id },
                        message: `The session ended without writing '${args.target}'.`
                    };

                if (!hasContent(absoluteTarget))
                    return {
                        success: false,
                        session: { id: session.id },
                        message: `The session wrote '${args.target}' but left it empty - an empty document does not satisfy the phase.`
                    };

                // A no-op revision leaves the target untouched, so an
                // untouched target is not a failure. But when the session
                // touched files and the target is not among them, say so.
                const touched = seen.files.map(file =>
                    path.normalize(path.isAbsolute(file) ? file : path.join(ctx.cwd, file)).toLowerCase());

                if (seen.files.length && !touched.includes(path.normalize(absoluteTarget).toLowerCase()))
                    ctx.log(
                        `Warning: the session reported writing ${seen.files.join(", ")} - not the target ` +
                        `'${args.target}'. The target exists, but this session may not be what wrote it.`,
                        "system");
            }

            succeeded = true;

            return {
                success: true,
                // Only the closing message. Earlier messages are already
                // in the task's log; repeating them would put the whole
                // conversation into a run variable and the store.
                artifacts: { summary: seen.messages[seen.messages.length - 1] ?? "", files: seen.files },
                // Recorded on the task's row, so a surface can offer to
                // reopen the conversation.
                session: { id: session.id }
            };

        } catch (error) {

            // The message is the headline; the log gets the properties
            // and `cause` chain a one-line message flattens away.
            if (!ctx.cancelled)
                ctx.log(errorDetail(error), "system");

            return {
                success: false,
                ...(session ? { session: { id: session.id } } : {}),
                message: ctx.cancelled
                    ? "Cancelled before the agent finished."
                    : `The agent could not finish: ${error instanceof Error ? error.message : String(error)}`
            };

        } finally {

            // Stopped before the session is held, deleted or disposed.
            // Already done for `detach`; harmless to repeat.
            seen?.stop();

            // A detached session is already the registry's; releasing
            // it here would tear it down before anyone joins. One whose
            // first send failed never got there - a quota error is the
            // usual case - and is kept or ended like a waited turn's, so
            // `keep` still leaves a chat a person can hand over to
            // another runtime and carry forward.
            if (session && !handedToRegistry) {

                if (args.keep && !(succeeded && args.cleanup === true)) {

                    // No `untilIdle` and no `maxHoldMs`: this session is
                    // meant to sit idle until the next revise, and
                    // either would end it.
                    deps.sessions.hold(ctx.runId, session, {});

                    ctx.log(
                        `Session ${session.id} kept open - a later call naming it as 'continueSession' `
                        + "will pick this conversation back up.",
                        "system");

                // `=== true` so a direct caller that named nothing keeps
                // the session, same as the manifest's default. A
                // provider with no `delete` falls back to dispose.
                } else if (succeeded && args.cleanup === true && session.delete) {

                    try {

                        await session.delete();

                        ctx.log(`Session ${session.id} deleted.`, "system");

                        // A delete already ends the session; the registry
                        // only has to stop naming it.
                        deps.sessions.forget(session.id);

                    } catch (error) {

                        // The work is on disk. A failed delete is a log
                        // line, never a failed task.
                        ctx.log(
                            `Could not delete session ${session.id}: `
                            + `${error instanceof Error ? error.message : String(error)}`,
                            "system");

                        await deps.sessions.end(session.id);
                    }

                } else
                    // Through the registry, not `session.dispose()`, so
                    // no dead entry is left for a panel to find.
                    await deps.sessions.end(session.id);
            }
        }
    };
}

/**
 * Failures worth one more try: the provider's service saying come back,
 * not the turn being wrong. Matched on the error's text because that is
 * the one shape both providers share. Everything else (auth, a session
 * that ended, the idle backstop, a model refusal) is fatal on the first
 * strike.
 */
const TRANSIENT_ERROR =
    /overloaded|rate.?limit|too many requests|service unavailable|internal server error|\b(?:429|502|503|529)\b/i;

/** Extra attempts a transient failure gets, and the pause before each. */
const TRANSIENT_RETRIES = 2;

const TRANSIENT_BACKOFF_MS = [5_000, 15_000];

/**
 * One turn, retried past transient provider failures.
 *
 * An error ends its turn cleanly and the session stays alive, so a
 * re-send is an ordinary next turn with the same message. Bounded,
 * backed off, and logged: a run record must show the retries, and
 * failing a late stage on a retryable blip would force the person back
 * through approvals they already gave.
 */
async function sendAndWaitWithRetries(
    session: AgentSession,
    message: AgentMessage,
    ctx: PluginContext,
    timeoutMs?: number | null
): Promise<void> {

    for (let attempt = 1; ; attempt++) {

        try {

            await session.sendAndWait(message, timeoutMs);

            return;

        } catch (error) {

            const text = error instanceof Error ? error.message : String(error);

            // A Stop is never retried; the error in hand is likely the
            // abort itself.
            if (!TRANSIENT_ERROR.test(text) || attempt > TRANSIENT_RETRIES || ctx.cancelled)
                throw error;

            const wait = TRANSIENT_BACKOFF_MS[attempt - 1] ?? TRANSIENT_BACKOFF_MS[TRANSIENT_BACKOFF_MS.length - 1];

            ctx.log(
                `The provider hit a transient error, retrying in ${Math.round(wait / 1000)}s `
                + `(retry ${attempt} of ${TRANSIENT_RETRIES}): ${text}`,
                "system");

            await new Promise(resolve => setTimeout(resolve, wait));

            if (ctx.cancelled)
                throw error;
        }
    }
}

/**
 * What the task learned by watching the session's events. Deciding what
 * an event means to a workflow task (which line is worth logging, which
 * tool call counts as a file changed) belongs here, not in the provider.
 */
function collect(
    session: AgentSession,
    ctx: PluginContext
): { readonly messages: string[]; readonly files: string[]; stop(): void } {

    const messages: string[] = [];
    const files = new Set<string>();

    const stop = session.on((event: AgentEvent) => {

        // Only the main agent's prose is the phase's answer. A
        // sub-agent's closing line must not become the task's summary.
        if (event.kind === "message" && !event.agent)
            messages.push(event.text);

        // Read-only tool calls (view, list, grep) carry a path too.
        if (event.kind === "tool.start" && event.path && isMutatingTool(event.tool))
            files.add(event.path);

        // `describeEvent` decides whether there is a line and what it
        // says, the same as every other surface.
        const line = describeEvent(event);

        if (line)
            // Passed as parts with a kind, so a surface can draw prose,
            // thinking and tool calls differently without parsing text.
            ctx.log(line.text, line.stream, {
                kind: line.kind,
                agent: line.agent,
                tool: line.tool,
                callId: line.callId,
                detail: line.detail,
                ok: line.ok,
                ms: line.ms,
                progress: line.progress,

                // What the turn charged and how full the window is.
                cost: line.cost,
                models: line.models,
                calls: line.calls,
                context: line.context,
                account: line.account,
                mcp: line.mcp,
                title: line.title,

                // The agent's plan, for the chat's plan strip.
                plan: line.plan,

                // A question's parts, so a surface can draw it and reply.
                askId: line.askId,
                prompt: line.prompt,
                options: line.options,
                multi: line.multi,
                permission: line.permission,

                // A streaming delta's parts.
                channel: line.channel,
                ephemeral: line.ephemeral
            });
    });

    return {
        get messages() { return messages; },
        get files() { return [...files]; },
        stop
    };
}

/**
 * Resolves the provider before a session starts. Returns the reason
 * instead of throwing, so a configuration error (unregistered provider,
 * or one that cannot be built) reads as one rather than as an agent that
 * could not finish.
 */
async function prepare(deps: AgentPluginDeps, args: AgentInputs): Promise<
    | { message: string }
    | { provider: Awaited<ReturnType<AgentProviders["get"]>> }> {

    // The task's own choice, then the host's default. An unknown name
    // fails with the list of registered ids.
    const providerId = args.provider ?? deps.provider;

    try {

        return { provider: await deps.providers.get(providerId) };

    } catch (error) {

        return { message: error instanceof Error ? error.message : String(error) };
    }
}

/**
 * Name, message, extra properties (status codes, response bodies), the
 * stack, and the same again for every link of the `cause` chain.
 */
export function errorDetail(error: unknown): string {

    const parts: string[] = [];

    let current: unknown = error;

    for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {

        if (depth > 0)
            parts.push("Caused by:");

        if (!(current instanceof Error)) {

            parts.push(asText(current));
            break;
        }

        parts.push(`${current.name}: ${current.message}`);

        const extras = Object.entries(current as unknown as Record<string, unknown>)
            .filter(([key]) => key !== "message" && key !== "stack" && key !== "cause");

        if (extras.length)
            parts.push(asText(Object.fromEntries(extras)));

        if (current.stack)
            parts.push(current.stack);

        current = (current as { cause?: unknown }).cause;
    }

    return parts.join("\n");
}

function asText(value: unknown): string {

    try {

        return typeof value === "string" ? value : JSON.stringify(value, null, 2);

    } catch {

        return String(value);
    }
}

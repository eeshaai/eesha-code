import * as path from "path";
import { PluginHost } from "../../core/plugins/PluginHost";
import { literal } from "../../core/plugins/literalArg";
import { EnvVars, Task } from "../../core/models/task";
import { LogMeta } from "../../core/models/run";
import { homeDirectory } from "../../core/runner/runContext";
import { PhaseRequest } from "./assemble";

/**
 * Running one phase, and the one call every session makes.
 *
 * `runPhase` turns a phase's request into a session call and hands it
 * to the phase's chat, which runs it as one of its turns. The chat
 * calls down into the engine through `runCall`, like every other chat
 * turn. SDD owns the model (what a phase is, what it is handed, when
 * it may run); the engine resolves the plugin, validates its args,
 * spawns it and masks what comes back. It does not go through the
 * walker, the TaskRunner or the workflow model: a turn is one plugin
 * call.
 *
 * The `Task` built here is a call shape, not a document anybody wrote.
 * `PluginHost.execute` takes one, so the plugin does not learn that SDD
 * exists and SDD does not reimplement input validation.
 */

export interface RunPhaseInput {

    request: PhaseRequest;

    /**
     * What to send, when it is not simply the request's prompt. The
     * compose box is the case: what the person typed, sent as typed.
     */
    prompt?: string;

    /** Hold the session after this turn instead of disposing it - see `SessionCall.keep`. */
    keep?: boolean;

    /** A session id from an earlier `keep: true` call - see `SessionCall.continueSession`. */
    continueSession?: string;

    /** A person is at the panel and can answer a question - see `SessionCall.interactive`. */
    interactive?: boolean;

    /** Send `prompt` exactly as given - see `SessionCall.verbatim`. */
    verbatim?: boolean;

    /**
     * Files a person attached to the message in the compose box. Sent
     * even on a `verbatim` send, which drops the phase's own attachments:
     * these are part of what was typed.
     */
    sentFiles?: { name?: string; path: string }[];

    /** The plan the session may tick with `task_done`, absolute - see `SessionCall.plan`. */
    plan?: string;

    /** The files the session is known to work on - see `SessionCall.files`. */
    files?: string[];

    /** The repository. Every path in the prompt, and in the request, is relative to it. */
    workspace: string;

    /**
     * Runs the call in the phase's chat, which writes the conversation
     * down, draws it and keeps its own stop and session id. `check` says
     * why the turn failed when the plugin said it went well but the phase
     * did not - a document it was asked for is missing - so the chat can
     * say it in its thread before the turn ends.
     */
    via(call: SessionCall, check: (result: CallResult) => string | undefined): Promise<CallResult>;
}

/** What one session call came back with. */
export interface CallResult {

    success: boolean;

    /** The conversation's id, when the plugin opened one. */
    sessionId?: string;

    /** The turn hit its time limit and was stopped. */
    timedOut?: boolean;
}

export interface PhaseOutcome {

    success: boolean;

    /** Documents the phase was asked for that are on disk afterwards. */
    written: string[];

    /** Documents it was asked for that are not. */
    missing: string[];

    /** Why it failed, when it did. */
    message?: string;

    /**
     * The provider's own id for the conversation this phase held.
     * Reported by the plugin as the session opens; reading it back from
     * the store later would race the write. It lets a user reopen the
     * chat that drafted a document.
     */
    sessionId?: string;
}

/**
 * What a phase's conversation is called to the host's permission check:
 * the run's id, then the task's id - the same two ids the session is
 * started under (`runId: sdd:<spec path>`, task `sdd:<stage id>`). Saved
 * "this session" answers are filed under it.
 */
export function phaseChatKey(specPath: string, stageId: string): string {

    return `${specChatPrefix(specPath)}sdd:${stageId}`;
}

/** The start of every {@link phaseChatKey} of one spec. */
export function specChatPrefix(specPath: string): string {

    return `sdd:${specPath}/`;
}

/**
 * Everything it takes to start one session, whoever is starting it.
 * Primitives rather than a {@link PhaseRequest}, so a caller with no
 * assembled request can still start one.
 */
export interface SessionCall {

    /** Names both the conversation and the task - a stage id. */
    session: string;

    prompt: string;

    system?: string;

    attachments: { name: string; path: string }[];

    /** Files a person attached in the compose box - see `RunPhaseInput.sentFiles`. */
    sentFiles?: { name?: string; path: string }[];

    /** A short human title, sent as the prompt's first line. */
    title: string;

    /** The document this session must write, when there is one to verify. */
    target?: string;

    /** The plugin to run and the settings it was configured with. */
    ai: { uses: string; args: Record<string, unknown> };

    /** Hold the session after this turn instead of disposing it. See `ai@1`'s `keep` arg. */
    keep?: boolean;

    /** A session id from an earlier `keep: true` call, to continue. See `ai@1`'s `continueSession`. */
    continueSession?: string;

    /**
     * A person is watching in a panel and can answer a question the
     * agent asks. Off, the agent is told nobody is there and to carry on
     * with an assumption. See `ai@1`'s `interactive` arg.
     */
    interactive?: boolean;

    /**
     * Send `prompt` exactly as typed: no title line, no attachments, no
     * target paragraph or target check. For a message a person typed
     * into a conversation already going - they said what they meant.
     * See `ai@1`'s `verbatim` arg.
     */
    verbatim?: boolean;

    /**
     * What the thread shows as the message, when it is not what is sent.
     * A chat gone back to an earlier message sends a note about the file
     * with the earlier messages in front of what the person typed; the
     * thread shows only what they typed. Verbatim sends only. See
     * `ai@1`'s `shown` arg.
     */
    shown?: string;

    /**
     * The plan whose boxes this session ticks through the `task_done`
     * tool, absolute. An implementation chat; a drafting phase sets
     * none. See `ai@1`'s `plan` arg.
     */
    plan?: string;

    /**
     * The plan this session writes and checks through `check_plan`,
     * absolute. The tasks phase; nothing else. See `ai@1`'s
     * `checkPlan` arg.
     */
    checkPlan?: string;

    /**
     * The files this session is known to work on, relative to the
     * repository: an implement wave's `Files:` lines. A `fileMatch`
     * steering file matching one is attached. See `ai@1`'s `files` arg.
     */
    files?: string[];

    /**
     * Files this session may not write, absolute - a native phase's
     * other documents. See `PhaseRequest.refuseWrites` and `ai@1`'s
     * `refuseWrites` arg.
     */
    refuseWrites?: string[];
}

/** Where a session runs, and who hears from it while it does. */
export interface SessionHost {

    /** Identifies the spec whose conversation this is - the spec folder path serves. */
    specId: string;

    /** Where the agent runs. The repository, since every path in the prompt is relative to it. */
    workspace: string;

    /** Correlates this session's output with the run it belongs to. */
    runId: string;

    /** The real environment, so `${{ env.NAME }}` in a plugin input resolves. */
    processEnv?: EnvVars;

    /** One line of this phase's output - see {@link RunPhaseInput.onOutput}. */
    onOutput?(text: string, stream: "stdout" | "stderr" | "system", meta?: LogMeta): void;

    onSession?(id: string): void;

    registerKill?(kill: () => void): void;

    isCancelled?(): boolean;
}

/**
 * The one place a session is started. Every call waits for its turn
 * to end.
 */
async function callPlugin(call: SessionCall, host: SessionHost, plugins: PluginHost) {

    const task: Task = {
        id: `sdd:${call.session}`,
        name: call.session,
        needs: [],
        plugin: call.ai.uses,

        // The human gate has already been passed by the time anything
        // calls this. The engine's own gate would hold a second time
        // for an approval nobody is coming to give.
        trigger: "auto",

        // A phase inherits no scope: there is no file above it.
        env: {},
        vars: {},
        dotenv: [],

        args: {
            ...call.ai.args,

            // Sent as the prompt's first line. A chat history names a
            // session by its opening text. Not on a verbatim send: the
            // conversation already has its name.
            ...(call.verbatim ? { verbatim: true } : { title: call.title }),

            // As it is, never template-resolved. The prompt is what the
            // person typed, a rendered frame, or a whole conversation
            // replayed for another runtime - text about workflows, so
            // `${{ params.repo }}` in it is words, not a lookup, and the
            // host resolving it would fail on a name no phase has.
            prompt: literal(call.prompt),

            ...(call.verbatim && call.shown !== undefined ? { shown: literal(call.shown) } : {}),

            // Standing instructions for every turn, under the provider's
            // own arg name; `ai@1` passes undeclared args straight on.
            // `append`, so the runtime's own guardrails survive.
            ...(call.system
                ? { systemMessage: { mode: "append", content: literal(call.system) } }
                : {}),

            // Files the session opens, not text pasted into the prompt.
            // The spec's own documents are named by path in the prompt
            // instead - see `assemble`. Not `context:`, which inlines and
            // would bury the ask in reference material.
            //
            // Files a person attached in the compose box go either way:
            // they are part of what was typed.
            ...((): { attachments?: { name?: string; path: string }[] } => {

                const all = [...(call.verbatim ? [] : call.attachments), ...(call.sentFiles ?? [])];

                return all.length ? { attachments: all } : {};
            })(),

            // The plugin fails the task when the session ends without
            // this file on disk. A stage producing several documents
            // names the first here; the check is a floor, not a list.
            // Not on a verbatim send: the text is the whole instruction.
            ...(call.target && !call.verbatim ? { target: call.target } : {}),

            ...(call.keep ? { keep: true } : {}),
            ...(call.continueSession ? { continueSession: call.continueSession } : {}),
            ...(call.interactive ? { interactive: true } : {}),
            ...(call.plan ? { plan: call.plan } : {}),
            ...(call.checkPlan ? { checkPlan: call.checkPlan } : {}),
            ...(call.files?.length ? { files: call.files } : {}),
            ...(call.refuseWrites?.length ? { refuseWrites: call.refuseWrites } : {})
        }
    };

    return plugins.execute(task, {
        runId: host.runId,
        taskId: `sdd:${call.session}`,
        attempt: 1,
        ownerId: host.specId,
        taskIndex: 0,

        // All three are the repository: every path in the prompt is
        // relative to it.
        cwd: host.workspace,
        root: host.workspace,
        workspace: host.workspace,

        home: homeDirectory(),

        env: {},
        processEnv: host.processEnv ?? {},
        onOutput: host.onOutput ?? (() => { }),
        onSession: host.onSession,
        registerKill: host.registerKill ?? (() => { }),

        // PluginHost hands the plugin's own cancel handler (ai@1's
        // AbortController) through registerCancel, never registerKill,
        // which is the sandbox's process-kill channel and stays empty
        // for an in-process ai task. Both mean "stop this phase" to the
        // caller, so they land in the same hook.
        registerCancel: host.registerKill,
        isCancelled: host.isCancelled
    });
}

/**
 * One waited turn from the primitives, for a caller with no chat - the
 * commit message. Held to nothing afterwards: there is no document it
 * was asked to write.
 */
export async function runSession(
    call: Omit<SessionCall, "target" | "plan" | "checkPlan">,
    host: SessionHost,
    plugins: PluginHost
): Promise<CallResult> {

    return runCall(call, host, plugins);
}

/**
 * One call with every field a phase may set. Every chat turn goes
 * through it - the ones a person types and the ones SDD hands a phase
 * chat (see `RunPhaseInput.via`).
 */
export async function runCall(call: SessionCall, host: SessionHost, plugins: PluginHost): Promise<CallResult> {

    const result = await callPlugin(call, host, plugins);

    return { success: result.success, sessionId: result.session?.id, timedOut: result.timedOut };
}

/**
 * Runs a phase in its chat and reports what it left behind. The phase
 * is held to the document it was asked for.
 *
 * @param exists Checked after the chat's turn ends, against repository-relative paths.
 */
export async function runPhase(
    input: RunPhaseInput,
    exists: (path: string) => boolean
): Promise<PhaseOutcome> {

    const { request } = input;
    const session = request.stage.id;

    const call: SessionCall = {
        session,
        prompt: input.prompt ?? request.prompt,
        attachments: request.attachments,

        // Phase first: a chat list truncates from the right, and the
        // spec name is shared by every session of that spec.
        title: `${request.stage.id} - ${label(request)}`,

        target: request.targets[0],

        ai: request.ai,
        keep: input.keep,
        continueSession: input.continueSession,
        interactive: input.interactive,

        // A native phase's message is the tool's own command - see
        // `PhaseRequest.verbatim`.
        verbatim: input.verbatim || request.verbatim,
        sentFiles: input.sentFiles,
        plan: input.plan,
        files: input.files,
        refuseWrites: request.refuseWrites?.map(file => path.resolve(input.workspace, file)),

        // The phase that writes the plan checks its own draft. Not
        // on a verbatim send - that text is the whole instruction.
        checkPlan: request.writesPlan && !input.verbatim && request.targets[0]
            ? path.resolve(input.workspace, request.targets[0])
            : undefined
    };

    // In the phase's chat: it checks the outcome before its turn ends,
    // so a missing document is said in its thread.
    const ran = await input.via(call, result => {

        const checked = outcome(request, result, exists, input.verbatim);

        return result.success && !checked.success ? checked.message : undefined;
    });

    return outcome(request, ran, exists, input.verbatim);
}

/** The spec's folder name - what a person calls this piece of work. */
function label(request: PhaseRequest): string {

    const target = request.targets[0] ?? request.context[0] ?? "";

    return target.split("/").slice(-2, -1)[0] ?? "spec";
}

/**
 * What the phase actually left, checked against the disk rather than
 * taken from the result. A plugin can report success having written
 * nothing; that is what a session that talked itself out of the work
 * looks like.
 *
 * A verbatim turn is held to nothing: the text is the whole instruction, so `callPlugin` does not send the
 * target and the agent is never told to write it. Checking for a file
 * nobody asked for turns "record the approval" - which correctly writes
 * nothing - into a failed phase. The document is still reported in
 * `written` and `missing`, so a caller that cares can look; nothing
 * fails over it.
 */
function outcome(
    request: PhaseRequest,
    result: CallResult,
    exists: (path: string) => boolean,
    verbatim?: boolean
): PhaseOutcome {

    const sessionId = result.sessionId;

    const written = request.targets.filter(exists);
    const missing = request.targets.filter(target => !exists(target));

    if (!result.success)
        return {
            success: false,
            written,
            missing,
            sessionId,
            message: result.timedOut
                ? `The ${request.stage.id} phase hit its time limit and was stopped.`
                : `The ${request.stage.id} phase did not complete.`
        };

    if (missing.length && !verbatim)
        return {
            success: false,
            written,
            missing,
            sessionId,
            message: `The ${request.stage.id} phase reported success without writing ${missing.map(one => `'${one}'`).join(", ")}.`
        };

    return { success: true, written, missing, sessionId };
}

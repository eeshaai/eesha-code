import type { AccountUsage, AskOption, AskPermission, ContextUsage, McpServerState, ModelSpend, PlanStep, Spend } from "../models/run";
import type { McpSelection } from "./providers/mcpConfig";
import { labelVerb } from "./providers/describe";

/**
 * A conversation with an agent, as the engine models it.
 *
 * A provider hands back an object with an id from the moment it exists,
 * a status, an event stream, and an explicit end. It outlives whatever
 * started it, because that is what these conversations do.
 */

/** What a session is doing right now. */
export type AgentSessionStatus = "working" | "idle" | "ended";

/**
 * What the engine understands an event to be.
 *
 * Deliberately short. It names the things the engine or a surface acts
 * on, and everything else arrives as `other` with its payload intact -
 * see {@link AgentEvent}.
 */
export type AgentEventKind =
    "message" | "reasoning" | "tool.start" | "tool.output" | "tool.end" | "notice" | "ask"
    | "answer" | "delta" | "idle" | "error" | "other";

/** Which half of what the model is producing a {@link AgentEvent} `delta` belongs to. */
export type DeltaChannel = "message" | "reasoning";

/**
 * How often one streaming channel may publish a delta, in milliseconds.
 *
 * Every delta is sent to the page. Ten a
 * second reads as live and is far fewer than one per token. Each delta
 * carries the whole block so far, so throttling loses nothing.
 *
 * Shared by every provider so streaming looks the same whichever
 * `provider:` runs.
 */
export const DELTA_INTERVAL_MS = 100;

interface AgentEventCommon {

    /**
     * The provider's own name for the event, verbatim -
     * `assistant.message`, `session.idle`, `session.title_changed`.
     *
     * Kept even when `kind` names it, so a surface can tell apart two
     * vendor events the engine maps to one kind, and a log line can
     * name the real event.
     */
    name: string;

    /**
     * The sub-agent this came from, by the display name its provider
     * announced - absent when the main agent itself is speaking.
     *
     * Copilot's CLI hands jobs to its own `task` and `explore` agents,
     * and their events come up this same stream. Without attribution a
     * log reads as one agent contradicting itself.
     */
    agent?: string;

    /**
     * The provider's payload, untouched.
     *
     * This is what makes the interface lossless: an event the engine
     * has never heard of still arrives with everything it came with,
     * and needs no interface change to be consumed.
     */
    raw: unknown;
}

export type AgentEvent =

    /** Prose the agent addressed to whoever asked. */
    | (AgentEventCommon & { kind: "message"; text: string })

    /**
     * The model's own thinking, separate from prose it chose to say, so
     * a consumer can show it, hide it, or keep it out of a task's
     * summary.
     */
    | (AgentEventCommon & { kind: "reasoning"; text: string })

    /**
     * A tool call, as it starts. `detail` is the call's arguments
     * rendered for a log line.
     */
    | (AgentEventCommon & {
        kind: "tool.start";
        tool: string;
        detail?: string;
        path?: string;

        /**
         * The runtime's own name for the tool (Claude's `Read`, Copilot's
         * `view`), when it differs from `tool` or `tool` is a plain-words
         * title. This is the name the "turn off" setting takes,
         * so the log line shows it to be copied. Left out when the
         * runtime does not say it (Copilot over ACP sends only a title).
         * Not `name`: that is the vendor's message type, on every event.
         */
        toolName?: string;

        /**
         * The vendor's own id for this call, so its end can find it.
         * Pairing by tool name fails when a model issues three `Read`s
         * in one message - durations and outcomes land on the wrong
         * rows.
         */
        callId?: string;

        /**
         * The call exactly as the agent sent it, as JSON. Written into
         * the log under the summary line, so what the agent really
         * asked for can be read whatever the summary made of it.
         */
        call?: string;
    })

    /**
     * What a running tool has printed so far - the live output of a
     * shell command, while it is still running.
     *
     * `text` is everything the call has produced up to now, not just
     * the newest piece, so a consumer replaces rather than appends and
     * a missed event costs nothing. Throttled like a `delta`, and
     * ephemeral for the same reason: the run's record of the call is
     * its `tool.end`, and keeping every step of a growing log would
     * store the same output over and over.
     *
     * Only sent by providers whose runtime streams tool output at all.
     * A consumer must work without it.
     */
    | (AgentEventCommon & {
        kind: "tool.output";
        text: string;

        /** The call this output belongs to - the same id its start carried. */
        callId?: string;

        /** The call's title, so a surface can label output whose start it never saw. */
        tool?: string;
    })

    /**
     * The same call, finished. `success` is the vendor's own verdict;
     * `detail` is why it failed or a short preview of what came back;
     * `ms` is how long it took.
     */
    | (AgentEventCommon & {
        kind: "tool.end";
        tool: string;
        success?: boolean;
        detail?: string;
        ms?: number;

        /** The call this finishes - see `tool.start`'s own note. */
        callId?: string;
    })

    /**
     * Something the runtime did that a person watching cannot infer: a
     * sub-agent starting, a context window compacted, an MCP server
     * changing state, what a turn cost. Already a finished sentence.
     */
    | (AgentEventCommon & {
        kind: "notice";
        text: string;

        /**
         * This notice replaces the last one like it rather than joining
         * the queue behind it - a heartbeat such as a running tool
         * count or "40% done". A log keeps them all; a surface drawing
         * a conversation shows one live line. Only the provider knows
         * which of its notices repeat, so it is set there.
         */
        progress?: boolean;

        /**
         * What this turn or model call charged, as a difference from
         * the last one - see `LogMeta.cost`. Only on a notice that
         * reports a bill.
         */
        cost?: Spend[];

        /** The same charge split by the model that ran - see `LogMeta.models`. */
        models?: ModelSpend[];

        /** How many model calls the charge covers, when the runtime says - see `LogMeta.calls`. */
        calls?: number;

        /**
         * How full the context window is, as the runtime last said -
         * see `LogMeta.context`. Only on a notice that reports it.
         */
        context?: ContextUsage;

        /** The account's usage this billing period - see `LogMeta.account`. Only on a notice that reports it. */
        account?: AccountUsage;

        /** The session's MCP servers and how each stands - see `LogMeta.mcp`. Only on a notice that reports it. */
        mcp?: McpServerState[];

        /** A short name the runtime gave the conversation - see `LogMeta.title`. */
        title?: string;

        /** The agent's whole plan as it stands now - see `LogMeta.plan`. */
        plan?: PlanStep[];

        /**
         * A permission request answered "yes" without asking a person -
         * a level that lets it through, or nobody watching. What it asked to
         * run, exactly as the runtime sent it, so a surface can show it.
         * See {@link allowedNotice}.
         */
        permission?: AskPermission;

        /**
         * On a `permission` notice: the vendor's id for the tool call it
         * allowed, when it gave one - the same id that call's
         * `tool.start` carries, so a surface can mark that row instead
         * of drawing a second one.
         */
        callId?: string;
    })

    /**
     * The agent is waiting on something only a person can answer.
     *
     * The provider is blocked on a promise until {@link
     * AgentSession.respond} is called with this `askId`. Answering
     * through `send` would start a new turn and leave the provider
     * blocked for good.
     *
     * `options` are carried as the vendor gave them, so a surface can
     * draw real choices.
     */
    | (AgentEventCommon & {
        kind: "ask";
        askId: string;
        prompt: string;
        options?: AskOption[];
        multi?: boolean;
        permission?: AskPermission;
    })

    /**
     * A question closed without a person answering it: the turn was
     * stopped, or the session ended. `text` says which.
     *
     * Raised so the log gets a closing line for the question. Without
     * one, a surface that draws an unanswered question as still waiting
     * waits forever, and keeps its compose box hidden behind it.
     */
    | (AgentEventCommon & { kind: "answer"; askId: string; text: string })

    /**
     * The answer so far, while it is still being written.
     *
     * `text` is the whole current block up to now, not the piece that
     * just arrived, so a dropped delta costs nothing. The completed
     * `message` or `reasoning` event still follows and is the one that
     * gets logged and stored - {@link describeEvent} marks this line
     * `ephemeral`.
     */
    | (AgentEventCommon & { kind: "delta"; channel: DeltaChannel; text: string })

    | (AgentEventCommon & { kind: "idle" })
    | (AgentEventCommon & { kind: "error"; message: string })
    | (AgentEventCommon & { kind: "other" });

/**
 * One question for a person, as a provider hands it to its own session.
 *
 * Shared by Claude's `AskUserQuestion` tool and an ACP agent's
 * `elicitation/create` request: different on the wire, the same to
 * whoever has to answer.
 */
export interface AskRequest {

    prompt: string;

    options?: AskOption[];

    multi?: boolean;

    /** Set when the question is a permission request - see {@link AskPermission}. */
    permission?: AskPermission;

    /** The vendor's own payload, for the event's `raw`. */
    raw: unknown;
}

/** A question in flight: its id, and the answer when it comes. */
export interface PendingAsk {

    askId: string;

    answer: Promise<string>;
}

/** How a provider puts a question to its session and gets back something to wait on. */
export type AskHook = (request: AskRequest) => PendingAsk;

/**
 * What an agent is told when it asks and nobody is watching.
 *
 * One sentence for every provider. It is advice the agent can act on
 * rather than an error: a thrown handler ends the turn, while this lets
 * the run finish on a stated assumption.
 */
export const NOT_INTERACTIVE =
    "No one is watching this session, so the question cannot be answered. Do not ask again. "
    + "Proceed on a reasonable assumption and record it in the document under Assumptions.";

/**
 * The questions one session has open, and the promises they are holding.
 *
 * Every provider that can ask needs this bookkeeping: mint an id, raise
 * the event, hold the promise, settle it by id, and fail the lot when
 * the turn or the session ends. Each session keeps only what differs:
 * whether it is still usable, and what its vendor calls the event.
 */
export class AskDesk {

    private readonly open = new Map<string, { resolve(answer: string): void; reject(error: Error): void }>();

    /**
     * @param emit  The session's own publish - one question is one event.
     * @param newId Injected so a test can pin the ids it asserts on.
     */
    constructor(
        private readonly emit: (event: AgentEvent) => void,
        private readonly newId: () => string = () => globalThis.crypto.randomUUID()
    ) { }

    /** How many questions are still waiting - what makes a session read as working. */
    public get pending(): number {

        return this.open.size;
    }

    /**
     * Raises one question and hands back the wait.
     *
     * `name` is what carried it - our own `ask_user` tool, or ACP's
     * `elicitation/create` - so a log line names the real thing.
     */
    public ask(request: AskRequest, name: string): PendingAsk {

        const askId = this.newId();

        const answer = new Promise<string>((resolve, reject) => {

            this.open.set(askId, { resolve, reject });
        });

        this.emit({
            kind: "ask",
            name,
            raw: request.raw,
            askId,
            prompt: request.prompt,
            ...(request.options?.length ? { options: request.options } : {}),
            ...(request.multi ? { multi: true } : {}),
            ...(request.permission ? { permission: request.permission } : {})
        });

        return { askId, answer };
    }

    /**
     * Settles one question by id.
     *
     * Throws when nothing is waiting on it. Silently dropping the answer
     * would leave a person believing they had replied.
     */
    public respond(askId: string, answer: string): void {

        const pending = this.open.get(askId);

        if (!pending)
            throw new Error(
                `Nothing is waiting on question ${askId} - it was already answered, or the session moved on.`);

        this.open.delete(askId);

        pending.resolve(answer);
    }

    /**
     * Fails every open question - the turn was stopped, or the session
     * ended. Each one also gets an `answer` event naming it, so the log
     * shows the question as closed rather than still waiting.
     */
    public abandon(reason: string): void {

        for (const [askId, pending] of [...this.open]) {

            this.open.delete(askId);

            pending.reject(new Error(reason));

            this.emit({ kind: "answer", name: "abandoned", raw: undefined, askId, text: reason });
        }
    }
}

/** A tagged steering file, as the `steering` tool offers it. */
export interface SteeringEntry {

    /** Absolute. Read when the agent asks for it, not before. */
    path: string;

    /** Relative to its root, with forward slashes - what the agent is shown. */
    relative: string;

    tags: readonly string[];
}

/** A file the session may open, and the name it is listed under. */
export interface AgentAttachment {

    /** Absolute. May sit outside the working directory. */
    path: string;

    /** What the session calls it - `how`, `requirements`. Defaults to the file name. */
    name?: string;
}

/** One thing said to a session. */
export interface AgentMessage {

    prompt: string;

    /**
     * Files handed over as attachments rather than pasted into the
     * prompt. Inlined, a page of instructions and three documents make a
     * prompt that is mostly reference material with the ask buried in
     * it. An attachment is a file the session opens when it needs it.
     */
    attachments?: readonly AgentAttachment[];
}

/** How a session is started. Everything here is fixed for its lifetime. */
export interface AgentSessionConfig {

    /** Where the agent works. The task's `cwd:`, resolved. */
    workingDirectory: string;

    /** Resolved non-secret env for this task. */
    env: Readonly<Record<string, string>>;

    /**
     * The model the session runs on. The one vendor setting the engine
     * names, because every caller has an opinion about it; everything
     * else is `extra`.
     */
    model?: string;

    /**
     * The env var names `${{ env.NAME }}` in an MCP declaration may read -
     * the `allowedEnv:` arg of `ai@1`, names only, never values.
     *
     * One grant among three: `env.allowed` in settings.json and the
     * task's own exported env (its keys arrive as {@link env}) also
     * grant names, and `env.denied` vetoes every grant. This one is
     * written by the workflow's author and seen by its reviewer.
     */
    allowedEnv?: readonly string[];

    /**
     * Which of settings.json's MCP servers, and which of their tools,
     * this session gets - the `mcp:` arg of `ai@1`, shape-checked.
     *
     * Undefined means every server, every tool. This can only narrow
     * what settings declare. See {@link McpSelection}.
     */
    mcp?: McpSelection;

    /**
     * Settings the engine does not model, for the provider to apply as
     * it sees fit - a vendor option a workflow author knows about and
     * this build does not.
     *
     * Applied over the fields the provider sets itself, so naming one
     * here is how a file overrides an engine default. That is on
     * purpose.
     */
    extra?: Readonly<Record<string, unknown>>;

    /**
     * A person is watching this session and can answer a question.
     *
     * Off by default: a question raised in an unattended run has nobody
     * to wait for, and a pending promise with no listener stalls the run
     * until `timeout:` kills it. With it off, a provider tells the agent
     * no one is there and to carry on with an assumption. With it on,
     * the provider raises an `ask` event and waits for `respond`.
     */
    interactive?: boolean;

    /**
     * The conversation this session belongs to, as the host's permission
     * check names it (see `ProviderDeps.permissions`): saved "this session"
     * answers are filed under it. Absent for a caller with no such check.
     */
    chat?: string;

    /**
     * The agent's own mode to run in - Kiro v3's `spec`, `plan` and the
     * rest, picked in the compose box. An id from the agent's own list
     * (see `AgentProvider.modes`). Absent leaves the agent on its default.
     *
     * Only an ACP agent that lists modes as a session config option reads
     * it. Every other provider ignores it.
     */
    agentMode?: string;

    /**
     * How hard the model thinks - `low` up to `max`, picked in the compose
     * box from the levels the model offers (`ModelChoice.efforts`). Absent
     * leaves the model's own default. Only a provider that lists levels
     * reads it (claude, claude-cli).
     */
    effort?: string;

    /**
     * The document this session must produce, repository-relative.
     *
     * Told to the provider as a standing instruction - appended to its
     * system prompt alongside {@link interactive}'s own note - rather
     * than left as a line inside the user's prompt. A session that goes
     * on to read a dozen repositories still carries this after every one
     * of those turns; a paragraph buried in the opening message does
     * not.
     */
    target?: string;

    /**
     * Standing instruction for every turn of this session, told to the
     * provider on the same channel as {@link target} and {@link
     * interactive}'s own note - appended to its system prompt, never
     * replacing it, so the vendor's own guardrails always survive
     * alongside it.
     *
     * Already resolved to plain text by the time a provider sees it: the
     * plugin layer reads a `file://` value from disk once, here, so
     * every provider gets text rather than a path it would each have to
     * open itself.
     */
    systemInstructions?: string;

    /**
     * The plan whose checkboxes this session may tick, as an absolute
     * path. Set, the provider registers the `task_done` tool over it -
     * the agent names a task and the engine flips its box, so the plan
     * never goes through the model to change one character. Unset for
     * a drafting phase, which has no boxes to tick. See `planTools`.
     */
    plan?: string;

    /**
     * The plan this session is *writing*, as an absolute path. Set, the
     * provider registers the `check_plan` tool over it - the agent runs
     * the implement phase's own parser over its draft and fixes what it
     * reports before stopping, instead of one revise pass later. See
     * `planTools`.
     */
    checkPlan?: string;

    /**
     * Files this session may not write, absolute. A permission request
     * for a write to one is answered no, with a line in the log saying
     * why - the agent is told and the turn goes on. Set by the spec
     * panel for a Kiro or Spec Kit phase: the documents of the spec's
     * other phases. Read by the ACP provider only - Kiro always runs on
     * one.
     */
    refuseWrites?: string[];

    /**
     * The tagged steering files this session may ask for. Set and not
     * empty, the provider registers the `steering` tool: its description
     * lists the tags, and the agent calls it with the tags that fit its
     * work to get those files' text. See `steeringTool`.
     */
    steering?: readonly SteeringEntry[];

    /**
     * A conversation this session should carry on rather than start.
     *
     * The provider's own id, from an earlier session it issued. Every
     * runtime keeps its transcript on disk after the process that made
     * it has gone, so the id is worth handing over even after a
     * restart.
     *
     * A provider that cannot reopen the id starts a fresh session
     * anyway and says so through {@link AgentSession.resumed} and
     * {@link AgentSession.resumeFailure} - the caller decides what that
     * means. `ai@1` refuses rather than hand over a cold start nobody
     * asked for; a direct caller with no such rule is free to use the
     * fresh session this still returns.
     */
    resume?: string;

    /** Aborted when the run is stopped. */
    signal?: AbortSignal;

    /**
     * Where a provider writes what it is about to do - the task's own
     * log. Optional because a direct caller assembling a config by hand
     * has no log to offer.
     */
    log?(text: string, stream?: "stdout" | "stderr" | "system"): void;

    /**
     * Hands a value to the run's masker, so an agent that echoes it -
     * a granted credential, say - is redacted in the log.
     *
     * A provider calls this with every value the env gate's grant lists
     * resolve (see `EnvService.grantValues`) before starting the child
     * that inherits them. Optional for the same reason `log` is.
     */
    registerSecret?(value: string): void;
}

export interface AgentSession {

    /**
     * The provider's own id, known before a single turn runs, so a
     * surface can offer to open the conversation while the agent is
     * still in it.
     */
    readonly id: string;

    readonly status: AgentSessionStatus;

    /**
     * Whether {@link AgentSessionConfig.resume} was honoured.
     *
     * A resume that quietly becomes a fresh session looks the same as
     * one that worked, except the agent re-reads every document. This
     * is how a caller tells them apart.
     *
     * `false` is a real answer: asked, and could not. `undefined` means
     * nothing was asked, or the provider does not say.
     */
    readonly resumed?: boolean;

    /**
     * Why {@link resumed} is `false`, in one sentence a person can read
     * in a refusal - "the transcript is gone" reads very differently
     * from "the lookup itself failed twice", and a caller that fails
     * the run over a missed resume (`ai@1` does) needs to say which one
     * happened rather than one generic line either way. Absent when
     * `resumed` is not `false`, or the provider does not say.
     */
    readonly resumeFailure?: string;

    /** Delivers a message and returns. Nothing waits on the turn. */
    send(message: AgentMessage): Promise<void>;

    /**
     * Delivers a message and waits for the session to go idle.
     *
     * `timeoutMs` is a backstop against a session that never reports
     * idle. Left out, the provider uses its own default. `null` means
     * wait with no limit: the right setting when a person is at the
     * panel, because a turn waiting on their answer looks exactly like
     * a hung session to a clock, and Stop is their way out.
     */
    sendAndWait(message: AgentMessage, timeoutMs?: number | null): Promise<void>;

    /** Stops the turn in flight. The session stays usable. */
    abort(): Promise<void>;

    /**
     * Answers a pending `ask` event, by id.
     *
     * Not `send`: the provider is blocked on a promise while it waits,
     * and a new message would start a turn on top of it. Rejects when
     * nothing with that id is waiting.
     *
     * Optional because only a provider that can raise a question has
     * anything to answer.
     */
    respond?(askId: string, answer: string): Promise<void>;

    /**
     * Changes {@link AgentSessionConfig.agentMode} for the rest of this
     * session. `ai@1` calls it when it carries on a held session, so a
     * mode picked in the compose box applies to the next turn without
     * reopening the conversation - the agent switches mode in place.
     *
     * Optional because only a provider whose agent has modes can switch.
     */
    setAgentMode?(mode: string | undefined): Promise<void>;

    /**
     * Changes {@link AgentSessionConfig.effort} for the rest of this
     * session, the same way {@link setAgentMode} does the mode. Undefined
     * goes back to the model's default.
     */
    setEffort?(effort: string | undefined): Promise<void>;

    /**
     * Shrinks the conversation's context - the runtime writes a summary of
     * it and carries on from that (Kiro v3's compact). Costs a model call.
     * Only between turns: a runtime refuses while one is running.
     *
     * Resolves with whether it worked and, when it did not, why - in
     * words for the person, never thrown. Optional because only some
     * runtimes can.
     */
    compact?(): Promise<{ ok: boolean; reason?: string }>;

    /**
     * Starts one MCP server's sign-in again (Kiro v3) - the Sign in
     * button on a server whose status says it needs one. The runtime
     * restarts the server and its sign-in page opens in the browser.
     *
     * Resolves with whether the page was opened and, when not, why - in
     * words for the person, never thrown. Optional because only some
     * runtimes can.
     */
    signInMcp?(server: string): Promise<{ ok: boolean; reason?: string }>;

    /**
     * Releases this session's process-side resources. Not a delete:
     * the provider keeps its state, so the conversation can be
     * reopened.
     */
    dispose(): Promise<void>;

    /**
     * Permanently removes the session and everything the provider
     * stored for it. The conversation cannot be reopened afterwards.
     *
     * Optional because not every provider has a store to delete from; a
     * caller falls back to `dispose` when this is absent.
     */
    delete?(): Promise<void>;

    /**
     * Every event, in order. Returns its own unsubscribe. Filtering
     * belongs to the consumer.
     */
    on(handler: (event: AgentEvent) => void): () => void;
}

/**
 * Whether a tool, by name, changes something - the filter for the "files
 * changed" list a person reviews at the gate that follows. Read tools
 * carry paths too, and counting them overstates what changed.
 *
 * Name-based because no provider publishes a read/write classification.
 * The bias is deliberate: a shell command that appends to a file goes
 * unlisted (the command is still in the log), while a listed file
 * really was written by a tool that says so.
 */
export function isMutatingTool(name: string): boolean {

    // `toolLabel` titles a built-in call in plain words: a verb, then a
    // file name or free text. The verb decides, and what follows it
    // does not - `Reading write_file.ts` read a file, and `Searching
    // 'createSession'` wrote nothing.
    const verb = labelVerb(name);

    if (verb)
        return verb === "Writing" || verb === "Editing";

    return /create|write|edit|replace|patch|delete|remove|move|rename|append|insert|mkdir/i.test(name);
}

/**
 * Whether a tool, by name, is the agent asking a person something
 * rather than work it did.
 *
 * A question is already drawn as the `ask` event's card. The vendor
 * also reports it as a tool call, so without this the same question
 * appears twice, and the tool row sits on "running" until the answer
 * arrives. So the tool.start/tool.end around the ask are dropped;
 * the question, the answer and a refusal keep their own lines.
 *
 * Matched against the vendor's raw name before any titling -
 * `toolTitle` renames calls, and a rename must not turn this off.
 *
 * ACP is absent on purpose: its `elicitation/create` is a protocol
 * request, not a tool call, so it never produced a row to suppress.
 */
export function isAskTool(name: string): boolean {

    // Our own tool, under both names it can arrive as: bare on Copilot,
    // and MCP-prefixed on Claude, where it is served from an in-process
    // server. Anchored, so a repository's own `ask_user_docs` is still
    // drawn as the tool call it is.
    return name === "ask_user" || /(^|__)ask_user$/.test(name);
}

/**
 * A duration a person can read at a glance. Shared so a provider and a
 * surface spell "1.2s" the same way.
 */
export function describeDuration(ms: number): string {

    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** One line of a session's log: what it says, and enough to render it. */
export interface AgentEventLine {

    /**
     * The line itself, with no attribution baked in - see {@link agent}.
     * {@link flatten} joins the two for a plain-text consumer.
     */
    text: string;

    stream: "stdout" | "stderr" | "system";

    /**
     * What produced the line, so a surface can tell prose from a tool
     * call from the model's thinking without parsing the text. The
     * stream cannot do this: most of what a session says is `system`.
     */
    kind: AgentEventKind;

    /** The sub-agent that produced it, if it was not the main agent. */
    agent?: string;

    /**
     * A tool call's own parts, on the two lines that are about one.
     * Carried beside `text` so a surface can draw a call as a call
     * without parsing "write_file done in 1.2s" back apart.
     */
    tool?: string;

    /** Which call the two lines are about - the vendor's own id. See the `tool.start` event. */
    callId?: string;

    /** What the call was given (`tool.start`), or why it failed and what came back (`tool.end`). */
    detail?: string;

    /** The vendor's verdict, on a finished call. */
    ok?: boolean;

    /** How long a finished call took, in milliseconds. */
    ms?: number;

    /** A notice that replaces the last one like it - see the `notice` event. */
    progress?: boolean;

    /** On a `notice` line: what it charged - see the `notice` event. */
    cost?: Spend[];

    /** On a `notice` line: the charge split by model - see the `notice` event. */
    models?: ModelSpend[];

    /** On a `notice` line: how many model calls the charge covers - see the `notice` event. */
    calls?: number;

    /** On a `notice` line: how full the context window is - see the `notice` event. */
    context?: ContextUsage;

    /** On a `notice` line: the account's usage - see the `notice` event. */
    account?: AccountUsage;

    /** On a `notice` line: the MCP servers - see the `notice` event. */
    mcp?: McpServerState[];

    /** On a `notice` line: the conversation's name - see the `notice` event. */
    title?: string;

    /** On a `notice` line: the agent's plan - see the `notice` event. */
    plan?: PlanStep[];

    /** On an `ask` line: the id a reply must name - see the `ask` event. */
    askId?: string;

    /**
     * On an `ask` line: the question by itself, without the choices.
     * `text` has the choices written in as a numbered list for a plain
     * log; a surface that draws them as buttons needs the question
     * alone.
     */
    prompt?: string;

    /** On an `ask` line: the choices offered, when there were any. */
    options?: AskOption[];

    /** On an `ask` line: whether more than one choice may be picked. */
    multi?: boolean;

    /** On an `ask` line that is a permission request: what it asks to run. */
    permission?: AskPermission;

    /** On a `delta` line: which half of the answer it is painting. */
    channel?: DeltaChannel;

    /**
     * This line is for painting only - never logged, never stored. A
     * streaming delta carries the answer so far, so keeping every one
     * would store the same paragraph many times over. The completed
     * event that follows is the record.
     */
    ephemeral?: boolean;
}

/**
 * One line as plain text, with everything a panel would draw instead
 * written into it.
 *
 * For consumers that have nowhere to put the parts. `PluginContext.log`
 * carries a `LogMeta` and `ai@1` sends the parts, so surfaces skip
 * this. The sandbox still needs it: its log message is text and a
 * stream (see `sandbox/protocol.ts`).
 *
 * Kept out of `describeEvent` because a marker baked into `text` would
 * have to be stripped back off, and a line that really began
 * "Thinking:" would then be mislabelled.
 */
export function flatten(line: AgentEventLine): string {

    const marked = line.kind === "reasoning" ? `Thinking: ${line.text}`
        : line.kind === "message" ? `[AGENT]: ${line.text}`
        : line.text;

    return line.agent ? `[${line.agent}] ${marked}` : marked;
}

/**
 * One event as a line of log, or nothing when it is not worth one.
 *
 * Shared by every surface that shows a conversation, so they all show
 * the same one. Which events are worth a line is one decision, made
 * here.
 *
 * `stdout` is what the agent produced, `system` is everything that
 * explains how it got there, `stderr` is what went wrong.
 */
export function describeEvent(event: AgentEvent): AgentEventLine | undefined {

    switch (event.kind) {

        case "message":

            return { ...whose(event), text: event.text, stream: "stdout" };

        // On the system stream, not stdout: thinking is not the answer.
        case "reasoning":

            return { ...whose(event), text: event.text, stream: "system" };

        case "tool.start":

            return {
                ...whose(event),
                text: toolLine(event)
                    + (event.call ? `\n${event.call}` : ""),
                stream: "system",

                // Never empty. `ClaudeProvider` builds this from
                // `block.name ?? ""`, and a surface keyed on the name
                // would drop a nameless call entirely.
                tool: event.tool || "tool",

                ...(event.callId ? { callId: event.callId } : {}),

                detail: event.detail
            };

        /*
         * Marked `ephemeral`, so it paints and is forgotten - the same
         * treatment a `delta` gets, and for the same reason: it carries
         * the whole output each time.
         */
        case "tool.output":

            return {
                ...whose(event),
                text: event.text,
                stream: "system",
                ...(event.tool ? { tool: event.tool } : {}),
                ...(event.callId ? { callId: event.callId } : {}),
                ephemeral: true
            };

        // Logged even for a plain success: duration and result are
        // what a start line cannot say, and a call with no second line
        // is one that never returned.
        case "tool.end":

            return {
                ...whose(event),
                text: `${event.tool || "tool"} `
                    + `${event.success === false ? "failed" : "done"}`
                    + `${event.ms === undefined ? "" : ` in ${describeDuration(event.ms)}`}`
                    + `${event.detail ? ` - ${event.detail}` : ""}`,
                stream: "system",
                tool: event.tool || "tool",
                ...(event.callId ? { callId: event.callId } : {}),
                detail: event.detail,

                // `undefined` is "it did not say", which is not the
                // same as success.
                ok: event.success,
                ms: event.ms
            };

        case "notice":

            return {
                ...whose(event),
                text: event.text,
                stream: "system",
                ...(event.progress ? { progress: true } : {}),
                ...(event.cost ? { cost: event.cost } : {}),
                ...(event.models ? { models: event.models } : {}),
                ...(event.calls ? { calls: event.calls } : {}),
                ...(event.context ? { context: event.context } : {}),
                ...(event.account ? { account: event.account } : {}),
                ...(event.mcp ? { mcp: event.mcp } : {}),
                ...(event.title ? { title: event.title } : {}),
                // Kept when empty: an empty plan says the agent dropped it.
                ...(event.plan ? { plan: event.plan } : {}),
                ...(event.permission ? { permission: event.permission } : {}),
                ...(event.callId ? { callId: event.callId } : {})
            };

        case "error":

            return { ...whose(event), text: event.message, stream: "stderr" };

        // On stdout, because it is the agent speaking to the person.
        // The choices go into the text as a numbered list for a plain
        // log, and beside it as parts for a surface that draws them.
        case "ask":

            return {
                ...whose(event),
                text: askText(event.prompt, event.options),
                stream: "stdout",
                askId: event.askId,
                prompt: event.prompt,
                ...(event.options?.length ? { options: event.options } : {}),
                ...(event.multi ? { multi: true } : {}),
                ...(event.permission ? { permission: event.permission } : {})
            };

        // The closing line for a question nobody answered. On stdout
        // with the ask's id - the same shape a person's answer has, so a
        // surface closes the question the same way.
        case "answer":

            return { ...whose(event), text: event.text, stream: "stdout", askId: event.askId };

        // Marked `ephemeral` to keep it out of the log and the store.
        // On the stream its channel would use, so thinking is painted
        // where thinking goes.
        case "delta":

            return {
                ...whose(event),
                text: event.text,
                stream: event.channel === "reasoning" ? "system" : "stdout",
                channel: event.channel,
                ephemeral: true
            };

        default:

            // `idle` and `other` say nothing a reader needs. They still
            // reach every subscriber.
            return undefined;
    }
}

/**
 * A tool call's summary line: its title, the runtime's own tool name in
 * brackets when it says something the title does not, then the
 * arguments - `Reading app.ts (Read): file_path=app.ts`. The name is
 * what the "turn off" setting takes, so it can be copied from
 * here.
 *
 * Exported for tests.
 */
export function toolLine(event: { tool: string; toolName?: string; detail?: string }): string {

    const name = event.toolName?.trim();
    const title = name && name.toLowerCase() !== event.tool.toLowerCase() ? `${event.tool} (${name})` : event.tool;

    return event.detail ? `${title}: ${event.detail}` : title;
}

/** The half of a line that says who produced it and what it is. */
function whose(event: AgentEvent): { kind: AgentEventKind; agent?: string } {

    return event.agent ? { kind: event.kind, agent: event.agent } : { kind: event.kind };
}

/**
 * The notice for a permission request the engine answered "yes" to by
 * itself. Every provider raises the same one, so the chat thread shows
 * each call that ran without a card, with what it asked for.
 *
 * @param name   The vendor's name for the request, for the log.
 * @param raw    The vendor's request, untouched.
 * @param callId The vendor's id for the tool call the request was for, when it gave one.
 */
export function allowedNotice(name: string, raw: unknown, permission: AskPermission, callId?: string): AgentEvent {

    // The permission check says how it was decided (see `permissions/gate.ts`);
    // without a note it only ever allowed without asking.
    const head = permission.note
        ? `${permission.refused ? "Refused" : "Allowed"} (${permission.note}): ${permission.tool}`
        : `Allowed without asking: ${permission.tool}`;

    return {
        kind: "notice",
        name,
        raw,
        text: `${head}${permission.input ? `
${permission.input}` : ""}`,
        permission,
        ...(callId ? { callId } : {})
    };
}

/**
 * A question with its choices as text, numbered from 1 so a person can
 * answer with the number. Shared so the Logs tab and the conversation
 * agree on what was asked.
 */
export function askText(prompt: string, options?: readonly AskOption[]): string {

    if (!options?.length)
        return prompt;

    const lines = options.map((option, index) =>
        `${index + 1}. ${option.label}${option.description ? ` - ${option.description}` : ""}`);

    return `${prompt}\n${lines.join("\n")}`;
}

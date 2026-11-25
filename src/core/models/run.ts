import type { PermissionCard } from "./permissionCard";
import type { Task } from "./task";

/**
 * What happens when a task actually runs: where it got to, and what it
 * printed.
 *
 * Separate from `task.ts` because a task is declared once and run many
 * times, and separate from `workspace.ts` because a run does not care
 * how its file was found.
 */

export enum RunStatus {

    Pending,

    Running,

    Success,

    Failed,

    Skipped,

    /** Stopped at a `trigger: manual` gate, waiting for a human. Nothing is executing. */
    Waiting,

    /** Stopped by the user before it could finish. */
    Cancelled
}

/**
 * Whether a run has stopped for good.
 *
 * `Waiting` is not finished: nothing is executing, but the run is
 * parked at a gate, halfway through. `Pending` has yet to begin.
 */
export function isFinished(status: RunStatus): boolean {

    return status === RunStatus.Success
        || status === RunStatus.Failed
        || status === RunStatus.Cancelled
        || status === RunStatus.Skipped;
}

/**
 * A file handed to an agent session as an attachment. Reported on the
 * `prompt` line so the page drawing the conversation can show what
 * went with the message.
 */
/**
 * A slash command a runtime offers - what the compose box lists when "/"
 * is the first thing typed. See `commandListFile.ts`.
 */
export interface RuntimeCommand {

    /** Without the "/": `compact`, `claude-md-management:revise-claude-md`. */
    name: string;

    description?: string;

    /** What to type after it, as the runtime words it: `<optional custom summarization instructions>`. */
    hint?: string;
}

/**
 * One step of the agent's plan - its to-do list for the work it is
 * doing. ACP runtimes send the whole plan as a `plan` update; the Claude
 * runtime's comes from its to-do tools. See `src/core/agent/plan.ts`.
 */
export interface PlanStep {

    /** What the step is, in the agent's words. */
    text: string;

    status: "pending" | "in_progress" | "completed";
}

export interface LogAttachment {

    /** Absolute, so a panel can open the file. */
    path: string;

    /** The label whatever attached it gave it, when it gave one. */
    name?: string;
}

/**
 * Money or credits an agent session charged, in whatever unit its
 * runtime bills in.
 *
 * `unit` is `USD` for Claude and for an ACP agent that prices in
 * dollars, `credits` and `premium requests` for Copilot, or another ISO
 * 4217 code from an ACP agent. Two amounts are only ever added when
 * their units match - see {@link addSpend}.
 */
export interface Spend {

    amount: number;

    unit: string;

    /**
     * The runtime that charged it - `ghcp`, `kiro-cli` - stamped where
     * the runtime is looked up (`stampingRuntime`). Two runtimes can
     * count in a unit of the same name - Copilot's credits and Kiro's are
     * both "credits" - and are different allowances, so a total keeps
     * them apart. Absent when the runtime was not recorded.
     */
    runtime?: string;
}

/**
 * The units that are an allowance rather than money.
 *
 * Copilot bills a seat against a quota: credits and premium requests
 * are how much of that allowance a call used, not a sum anybody is
 * charged. Everything else - `USD`, or another ISO 4217 code from an
 * ACP agent - is real money, which is the part the `sessionCost`
 * feature flag hides. A surface tells the two apart with this.
 */
export const QUOTA_UNITS: readonly string[] = ["credits", "premium requests"];

/** Whether this charge is an allowance rather than money. @see QUOTA_UNITS */
export function isQuota(spend: Spend): boolean {

    return QUOTA_UNITS.includes(spend.unit);
}

/**
 * What one model charged and how many tokens went through it.
 *
 * A session can switch models part way - a phase set to `auto`, a
 * sub-agent on a cheaper one - and "what did this cost" then has more
 * than one answer. `model` is the runtime's own name for it, verbatim.
 */
export interface ModelSpend {

    model: string;

    /** The runtime the model ran on - the same model can run on two. See {@link Spend.runtime}. */
    runtime?: string;

    cost?: Spend[];

    /** Everything the model read, cache included. */
    inputTokens?: number;

    /**
     * The part of `inputTokens` read from the prompt cache - a share of
     * it, never added on top. Only when the runtime says (Claude,
     * Copilot, an ACP agent that fills ACP's cached field); Kiro sends
     * no token counts at all.
     */
    cachedTokens?: number;

    outputTokens?: number;
}

/**
 * The per-model totals with one more turn's usage added, matched by
 * model name and runtime. Order is first-seen, the same as {@link addSpend}.
 */
export function addModelSpend(
    totals: readonly ModelSpend[],
    charges: readonly ModelSpend[]
): ModelSpend[] {

    const next = totals.map(total => ({ ...total, cost: total.cost ? [...total.cost] : undefined }));

    for (const charge of charges) {

        const total = next.find(candidate => candidate.model === charge.model && candidate.runtime === charge.runtime);

        if (!total) {

            next.push({ ...charge, cost: charge.cost ? [...charge.cost] : undefined });

            continue;
        }

        if (charge.cost?.length)
            total.cost = addSpend(total.cost ?? [], charge.cost);

        if (typeof charge.inputTokens === "number")
            total.inputTokens = (total.inputTokens ?? 0) + charge.inputTokens;

        if (typeof charge.cachedTokens === "number")
            total.cachedTokens = (total.cachedTokens ?? 0) + charge.cachedTokens;

        if (typeof charge.outputTokens === "number")
            total.outputTokens = (total.outputTokens ?? 0) + charge.outputTokens;
    }

    return next;
}

/**
 * How full the agent's context window is, as its runtime last reported.
 *
 * `used` and `size` are tokens. `parts` is the breakdown when the
 * runtime gives one - system prompt, tools, messages and so on - and
 * absent when it only counts the whole. A surface draws a percentage
 * from the first two and a hover from the third.
 *
 * `percentOnly` is for a runtime that reports only how full the window
 * is, never its size (Kiro): `used` is then the percentage and `size`
 * is 100, and the page must not print either as a token count.
 *
 * `sizeEstimated` says `size` was worked out rather than reported (Kiro
 * again: its token counts divided by its own percentage), so the page
 * prints it as approximate.
 */
export interface ContextUsage {

    used: number;

    size: number;

    parts?: ContextPart[];

    percentOnly?: boolean;

    sizeEstimated?: boolean;

    /**
     * The session this reading came from can shrink its context on
     * request (Kiro v3's compact) - what puts the Compact button in the
     * meter. Set by the session, which is the one that knows.
     */
    compactable?: boolean;
}

/**
 * What the person's account has used this billing period, as the
 * runtime last said - account-wide, not this session's. A state, not a
 * charge: the newest one wins and nothing is added up.
 *
 * Plain rows, in the order the runtime's own answer has them: the page
 * prints them as they come and knows nothing of any vendor's fields.
 * The vendor's extension (Kiro's, today) turns its answer into rows; a
 * second vendor sends its own rows and no page changes.
 */
export interface AccountUsage {

    /** The runtime that reported it - `kiro-cli`, say. */
    runtime?: string;

    /** When the runtime answered, in milliseconds since the epoch - so a kept copy can say how old it is. */
    at: number;

    rows: AccountRow[];

    /**
     * The runtime says the account is past an allowance - set by its
     * extension, which is the one that knows what its figures mean.
     * What puts the warning mark on the meter.
     */
    overLimit?: boolean;
}

export interface AccountRow {

    key: string;

    value: string;

    /** The value is real money: shown only where money is - the `sessionCost` feature flag. */
    money?: boolean;
}

/**
 * One MCP server of a session, as its runtime reported it. Only Kiro v3
 * sends this today (`_kiro/mcp/status`). `status` is the runtime's own
 * word: `connecting`, `connected`, `failed` or `disabled` from Kiro.
 */
export interface McpServerState {

    name: string;

    status: string;

    /** How many tools it gave, when connected and the runtime said. */
    tools?: number;

    /** Why it failed, when the runtime said. */
    reason?: string;

    /** It failed because it needs a sign-in. */
    needsSignIn?: boolean;
}

/**
 * One category of what fills the window. `items` is what is inside it,
 * when the runtime names them (Kiro does - each context file, each
 * tool); the page shows them when the category is opened.
 */
export interface ContextPart {

    name: string;

    tokens: number;

    items?: ContextItem[];
}

export interface ContextItem {

    name: string;

    tokens: number;

    /** A short word beside the name - `not loaded` for a context file the runtime found but did not use. */
    note?: string;
}

/**
 * The totals so far with one more charge added, matched by unit.
 *
 * A session on Copilot charges in credits and premium requests at the
 * same time, so a total is a list rather than one number. Order is
 * first-seen, so the line the page draws does not reorder as amounts
 * arrive.
 */
export function addSpend(totals: readonly Spend[], charges: readonly Spend[]): Spend[] {

    const next = totals.map(total => ({ ...total }));

    for (const charge of charges) {

        // By unit and runtime: Copilot's credits and Kiro's credits
        // are two allowances that happen to share a name.
        const total = next.find(candidate => candidate.unit === charge.unit && candidate.runtime === charge.runtime);

        if (total)
            total.amount += charge.amount;
        else
            next.push({ ...charge });
    }

    return next;
}

export interface LogMeta {

    /** An agent event's kind - `message`, `reasoning`, `tool.start`, `tool.end`, `notice`, `error` - or `prompt` for the turn that was sent. */
    kind?: string;

    /**
     * On a `notice` line: what this turn or model call charged, as a
     * difference - never a running total, so the page can add every
     * line up and a resumed session does not count twice.
     */
    cost?: Spend[];

    /**
     * On a `notice` line: the same charge split by the model that ran,
     * when the runtime says which - see {@link ModelSpend}. A
     * difference, like `cost`.
     */
    models?: ModelSpend[];

    /**
     * On a `notice` line: how many model calls this charge covers. Only
     * runtimes that say so set it - Claude's SDK (its count for the
     * turn) and Copilot (one per call). Kiro and plain ACP agents do
     * not, and nothing is guessed for them. A difference, like `cost`.
     */
    calls?: number;

    /**
     * On a `notice` line: how full the context window was when the
     * runtime last said. A state, not a charge: the latest line wins
     * and nothing is added up.
     */
    context?: ContextUsage;

    /** On a `notice` line: the account's usage this billing period - see {@link AccountUsage}. */
    account?: AccountUsage;

    /**
     * On a `notice` line: every MCP server the session has and how it
     * stands, as the runtime last said. A state, not a change: the
     * newest line wins - see {@link McpServerState}.
     */
    mcp?: McpServerState[];

    /**
     * On a `notice` line: a short name the runtime gave the conversation
     * (Kiro v3 writes one after the first message). The newest one names
     * the chat in the history, over the first thing the person asked.
     */
    title?: string;

    /**
     * On a `notice` line: the agent's whole plan as it stands now - see
     * {@link PlanStep}. A state, like `context`: the latest line wins.
     * An empty list means the agent dropped its plan.
     */
    plan?: PlanStep[];

    /** On a `prompt` line: the files sent with the message - see {@link LogAttachment}. */
    attachments?: LogAttachment[];

    /**
     * On a `prompt` line: lines sent to the agent under the message as
     * typed - what its ">" paths point at (Eesha Code's connectors). The
     * thread shows them under the message.
     */
    sentWith?: string[];

    /**
     * On a `prompt` line the view drew itself the moment Send was
     * pressed, before the host logged the real one: `sending` until the
     * real line replaces it, `failed` when the host said it never went.
     * Never written by the host and never stored.
     */
    pending?: "sending" | "failed";

    /** The sub-agent that produced it, when it was not the main one. */
    agent?: string;

    /**
     * The tool a `tool.start` or `tool.end` line is about. The name on
     * its own, so the page never has to parse it out of the text.
     */
    tool?: string;

    /**
     * Which call the two lines are about - the vendor's own id.
     *
     * The name cannot pair them: a model often issues three `Read`s in
     * one message, and pairing by name puts durations and outcomes on
     * the wrong rows. Absent when the provider or call carried no id; a
     * surface falls back to the name.
     */
    callId?: string;

    /** What the call was given (`tool.start`), or why it failed and what came back (`tool.end`). */
    detail?: string;

    /** The vendor's own verdict on a finished call. */
    ok?: boolean;

    /** How long a finished call took, in milliseconds. */
    ms?: number;

    /**
     * This line replaces the last one like it rather than joining the
     * queue behind it. The log keeps every one; the page drawing a
     * conversation shows one live line. See the `notice` event in
     * `AgentSession`.
     */
    progress?: boolean;

    /**
     * On an `ask` line: the id the answer must name. On an `answer`
     * line: the ask it answered. Two asks can be open at once, so "the
     * last one" is not enough.
     */
    askId?: string;

    /**
     * On an `ask` line: the question by itself, without the choices
     * written out after it. See `AgentEventLine.prompt` for why both.
     */
    prompt?: string;

    /** On an `ask` line: the choices the agent offered, when it offered any. */
    options?: AskOption[];

    /** On an `ask` line: whether more than one choice may be picked. */
    multi?: boolean;

    /**
     * On an `ask` line that is a permission request: what it asks to run.
     * On a `notice` line: a request that was allowed without asking a
     * person - see `allowedNotice` in `AgentSession`.
     */
    permission?: AskPermission;

    /** On a `delta` line: which half of the answer it paints - `message` or `reasoning`. */
    channel?: string;

    /**
     * This line is for painting only - never kept, never stored.
     *
     * A streaming delta carries the answer so far, so keeping every one
     * would store the same paragraph many times. `RunSession` drops
     * these before its replay buffer and the store.
     */
    ephemeral?: boolean;

    /**
     * On a `files.changed` line: what one turn of the chat did to
     * the files, and the two snapshots that tell before from after. On a
     * `files.undone` line: the files put back. See `turnSnapshot.ts`.
     */
    changed?: TurnChanges;

    /**
     * On a `files.changed` line, when the turn changed files in more than
     * one repository (an Eesha Code chat with several folders): the other
     * repositories, each with its own snapshots. `changed` holds the
     * first. Each is kept or undone on its own, by its own lines.
     */
    changedMore?: TurnChanges[];
}

/** One chat turn's file changes - see {@link LogMeta.changed}. */
export interface TurnChanges {

    /** The git repository's top folder - every `path` is relative to it. */
    root: string;

    /** Git tree ids of the whole working tree before and after the turn. */
    before: string;

    after: string;

    files: { path: string; status: "added" | "modified" | "deleted" }[];
}

/** One choice the agent offered with a question. */
export interface AskOption {

    label: string;

    description?: string;

    /** On a permission request's choice: picking it lets the call run. */
    allows?: boolean;
}

/**
 * On an `ask` line that is a permission request rather than a question:
 * the tool the agent wants to use, and what it would be given - so a
 * surface can draw the request as a request, not as a question.
 */
export interface AskPermission {

    tool: string;

    input?: string;

    /**
     * On an `ask` from our own permission check (Eesha Code): the card to
     * draw - see `permissionCard.ts`. Absent on the runtimes' own cards.
     */
    card?: PermissionCard;

    /**
     * On a notice from our own check: what the call's row says - "allowed
     * once by you", "refused: ~/.ssh is never allowed, in any mode".
     */
    note?: string;

    /** On such a notice: the call did not run. */
    refused?: boolean;
}

/** One line of a task's output. Extends {@link LogMeta}. */
export interface LogLine extends LogMeta {

    /** The runnable unit this line belongs to - a task's own id (inline) or a job id (default engine). */
    ownerId: string;

    taskIndex?: number;

    text: string;

    stream: "stdout" | "stderr" | "system";

    /** When this line was produced, in epoch milliseconds - the Logs tab's timestamp. */
    at: number;

}

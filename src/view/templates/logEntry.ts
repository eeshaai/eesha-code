import { AccountUsage, AskOption, AskPermission, ContextUsage, LogAttachment, LogLine, McpServerState, ModelSpend, PlanStep, Spend } from "../../core/models/run";

/**
 * The one log shape every log view in Eesha Code renders through -
 * the workflow Logs tab, the SDD log drawer, and anywhere else a list
 * of log lines shows up.
 *
 * One level (the four the core logger uses - see
 * `core/logging/logger.ts`), one category, one message, an optional
 * structured payload. Everything upstream produces `LogLine`s;
 * `entryFromLine` below is where a line becomes one of these.
 */

export type LogLevel = "info" | "warning" | "error" | "critical";

/** Lowest to highest - what a minimum-level filter compares against. */
export const LOG_LEVELS: readonly LogLevel[] = ["info", "warning", "error", "critical"];

export interface LogEntry {

    /** Stable across a render - the index a line arrived at, since nothing else about process output is unique. */
    id: string;

    /** Epoch milliseconds. */
    at: number;

    level: LogLevel;

    /**
     * What produced the line: a `kind` (message/reasoning/tool.start/...)
     * for an agent conversation, or the task/plugin name otherwise.
     * What a category or source filter groups by.
     */
    category: string;

    message: string;

    /** The sub-agent that spoke, when it was not the main one - shown as a chip, not folded into the category. */
    agent?: string;

    /**
     * A tool call's own parts, on the two entries that are about one -
     * its `tool.start` and its `tool.end`.
     *
     * The AI Session tab draws a call as a call: name, input, whether
     * it worked, how long it took. None of that can be read back out of
     * `message`, which is a sentence `describeEvent` wrote for a log.
     */
    tool?: string;

    /**
     * Which call the two entries are about - the vendor's own id.
     *
     * Pairs a start with its end. The name cannot: three `Read`s issued
     * together share one. Absent where the provider gave no id; the
     * name is the fallback there.
     */
    callId?: string;

    detail?: string;

    ok?: boolean;

    ms?: number;

    /** A notice that replaces the last one like it - see `LogMeta.progress`. */
    progress?: boolean;

    /** What a notice charged - see `LogMeta.cost`. */
    cost?: Spend[];

    /** The same charge split by model - see `LogMeta.models`. */
    models?: ModelSpend[];

    /** How many model calls a notice's charge covers - see `LogMeta.calls`. */
    calls?: number;

    /** How full the context window was at a notice - see `LogMeta.context`. */
    context?: ContextUsage;

    /** The account's usage at a notice - see `LogMeta.account`. */
    account?: AccountUsage;

    /** The MCP servers at a notice - see `LogMeta.mcp`. */
    mcp?: McpServerState[];

    /** The agent's plan at a notice - see `LogMeta.plan`. */
    plan?: PlanStep[];

    /** On an `ask` entry, the id an answer must name; on an `answer` entry, the ask it answered. */
    askId?: string;

    /**
     * On an `ask` entry: the question by itself.
     *
     * `message` has the choices written out after it as a numbered
     * list. A surface that draws them as buttons shows this instead, so
     * the list does not appear twice - see `AgentEventLine.prompt`.
     */
    prompt?: string;

    /** On an `ask` entry: the choices the agent offered. */
    options?: AskOption[];

    /** On a `prompt` entry: the files sent with the message - see {@link LogAttachment}. */
    attachments?: LogAttachment[];

    /** On a `prompt` entry: see `LogMeta.sentWith`. */
    sentWith?: string[];

    /** On a `prompt` entry the view drew before the host logged it - see `LogMeta.pending`. */
    pending?: "sending" | "failed";

    /** On an `ask` entry: whether more than one choice may be picked. */
    multi?: boolean;

    /** On an `ask` entry that is a permission request: what it asks to run. */
    permission?: AskPermission;

    /** On a `delta` entry: which half of the answer it paints. */
    channel?: string;

    /** Painted and forgotten - never logged, never stored. See `LogMeta.ephemeral`. */
    ephemeral?: boolean;

    /**
     * A value the reader can expand instead of reading as one escaped
     * line. Nothing upstream attaches this (a `LogLine` only carries
     * text); it is recovered when the text itself is JSON-shaped - see
     * `parseObjectish`.
     */
    data?: unknown;
}

/**
 * `line.stream` as a level: `stderr` is `error`, everything else is
 * `info`. A `LogLine` never carries `warning`/`critical`; those are
 * the core logger's own, for its own failures, not a task's.
 */
function levelOf(line: LogLine): LogLevel {

    return line.stream === "stderr" ? "error" : "info";
}

/** Leading/trailing whitespace that would stop `JSON.parse` seeing an otherwise-valid object or array. */
function looksObjectish(text: string): boolean {

    const trimmed = text.trim();

    return (trimmed.startsWith("{") && trimmed.endsWith("}"))
        || (trimmed.startsWith("[") && trimmed.endsWith("]"));
}

/**
 * Recovers a structured value from text that is actually JSON, so it
 * can be shown collapsed and expandable instead of as one long escaped
 * line. Anything that is not valid JSON, or parses to a bare string or
 * number, is left as plain text - there is nothing to expand into.
 */
function parseObjectish(text: string): unknown {

    if (!looksObjectish(text))
        return undefined;

    try {

        const parsed: unknown = JSON.parse(text);

        return parsed !== null && typeof parsed === "object" ? parsed : undefined;

    } catch {

        return undefined;
    }
}

/**
 * A `LogLine` as a `LogEntry`.
 *
 * `fallbackCategory` is what a plain process line (no `kind`) is filed
 * under - a task's name or a plugin id, since a `LogLine` itself
 * carries no such string.
 */
export function entryFromLine(line: LogLine, index: number, fallbackCategory: string): LogEntry {

    return {
        id: `${line.at}-${index}`,
        at: line.at,
        level: levelOf(line),
        category: line.kind ?? fallbackCategory,
        message: line.text,
        agent: line.agent,
        tool: line.tool,
        callId: line.callId,
        detail: line.detail,
        ok: line.ok,
        ms: line.ms,
        progress: line.progress,
        cost: line.cost,
        models: line.models,
        calls: line.calls,
        context: line.context,
        account: line.account,
        mcp: line.mcp,
        plan: line.plan,
        askId: line.askId,
        prompt: line.prompt,
        options: line.options,
        multi: line.multi,
        permission: line.permission,
        attachments: line.attachments,
        sentWith: line.sentWith,
        pending: line.pending,
        channel: line.channel,
        ephemeral: line.ephemeral,
        data: parseObjectish(line.text)
    };
}

/**
 * One more line, with a streaming delta replacing the last one like it
 * rather than joining the end.
 *
 * A delta carries the answer so far, so appending each one would stack
 * up copies of the same paragraph. Only the newest is kept, in the slot
 * the first one landed in - which is where the agent is writing.
 *
 * The completed line that follows clears the live one it finishes
 * (`message` clears the `message` delta, `reasoning` the `reasoning`
 * one), matched per speaker because a sub-agent writes at the same
 * time as the agent that started it.
 *
 * The completed line joins the end, not the live one's slot. Only
 * deltas are dropped before the store, so a real line placed anywhere
 * but the end would read in one order live and in another when the
 * panel is reopened. `AcpEventTranslator` buffers a turn's text and
 * flushes it after the tool calls it followed, so putting it in the
 * live line's slot would place it before them.
 *
 * Shared by every view that accumulates log lines.
 */
export function withLine<T extends LogLine>(lines: readonly T[], line: T): T[] {

    /*
     * A running tool's output, which is the same idea one call at a
     * time: each event carries everything that call has printed, so the
     * newest replaces the one before it, and the call's own end drops
     * it. Matched on the call id, since several tools run in a row and
     * each has its own row to sit under.
     */
    if (line.callId && (line.kind === "tool.output" || line.kind === "tool.end")) {

        const index = lines.findIndex(one =>
            one.ephemeral && one.kind === "tool.output" && one.callId === line.callId);

        if (index < 0)
            return [...lines, line];

        const next = [...lines];

        if (line.kind === "tool.output") {

            next[index] = line;

            return next;
        }

        // The end drops the live output and joins the end, the same way
        // a completed message drops the delta that was painting it.
        next.splice(index, 1);

        return [...next, line];
    }

    const channel = line.ephemeral ? line.channel : line.kind;

    // Not a streaming line and not the completion of one.
    if (channel !== "message" && channel !== "reasoning")
        return [...lines, line];

    const live = (one: T) =>
        one.ephemeral && one.channel === channel && one.agent === line.agent;

    const index = lines.findIndex(live);

    // Nothing live to replace. A first delta appends and marks the spot
    // every later one replaces.
    if (index < 0)
        return [...lines, line];

    const next = [...lines];

    // A later delta takes the live one's place, so the paragraph does
    // not move down the screen every time a tool call lands under it.
    if (line.ephemeral) {

        next[index] = line;

        return next;
    }

    // The completed line drops the live one and joins the end.
    next.splice(index, 1);

    return [...next, line];
}

/** ANSI escapes (colour, bold, cursor movement) stripped for display - built via charCode so no literal ESC lives in the source. */
const ESC = String.fromCharCode(27);

const ANSI_STYLES = new RegExp(ESC + "\\[[0-9;]*m", "g");

const ANSI_OTHER = new RegExp(ESC + "\\[[^m]*[A-Za-z]", "g");

/** A message ready to render: ANSI stripped, trailing newlines (the process's own line ending, not ours) dropped. */
export function cleanText(text: string): string {

    return text
        .replace(ANSI_STYLES, "")
        .replace(ANSI_OTHER, "")
        .replace(/\r/g, "")
        .replace(/\n+$/, "");
}

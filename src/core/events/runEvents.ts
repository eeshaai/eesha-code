import { LogLine, LogMeta, ModelSpend, Spend, addModelSpend, addSpend } from "../models/run";

/**
 * What a run's events file holds, and how to read one back.
 *
 * A file rather than a table because nothing queries it: it is appended
 * during a run and read whole afterwards. A person can delete one run's
 * history by hand, and one corrupt file loses one run, not a
 * workspace's worth.
 *
 * One JSON record per line, with `LogLine`'s own fields, so what the
 * panel drew live is what the file holds. A line with no `kind` is
 * plain process output.
 */

/** The record shape version. Only ever written on the `open` line. */
export const EVENTS_VERSION = 1;

/**
 * Lines the writer adds that no plugin produced: where the file starts,
 * where an owner begins and ends, which conversation to carry on, where
 * an owner started over, and where somebody cleared a conversation.
 *
 * `rewound` is a chat gone back to an earlier message with no
 * conversation to carry on from there: the lines before it stay on
 * screen, but the next message starts a new conversation. See
 * `ChatController.goBack`.
 */
export type ControlKind = "open" | "start" | "session" | "end" | "restart" | "cleared" | "rewound";

export interface RunEvent extends LogMeta {

    /** On the `open` line only - see {@link EVENTS_VERSION}. */
    v?: number;

    /** Epoch milliseconds. */
    at: number;

    /** Which phase or task this belongs to. Absent only on `open`. */
    ownerId?: string;

    stream?: LogLine["stream"];

    text?: string;

    /** `open` only - which run this file is about, for a reader holding the file alone. */
    runId?: string;

    /** `session` only - the provider's own conversation id, whose it is, and the model it was opened on. */
    sessionId?: string;

    provider?: string;

    /**
     * Absent when none was named; a reader treats that as "unknown",
     * never as a change.
     */
    model?: string;

    /** `end` only. */
    status?: string;

    /** `start` only, in a spec's file: the phase chat the run is in - see `ChatSpecLink`. */
    chatId?: string;
}

/**
 * One line of a file, parsed - or `undefined` for a line that is not a
 * record.
 *
 * A half-written last line means the process died mid-write. Skipping
 * it is the whole recovery: every line before it is complete.
 */
export function parseEvent(line: string): RunEvent | undefined {

    if (!line.trim())
        return undefined;

    try {

        const parsed: unknown = JSON.parse(line);

        return parsed !== null && typeof parsed === "object" && typeof (parsed as RunEvent).at === "number"
            ? parsed as RunEvent
            : undefined;

    } catch {

        return undefined;
    }
}

/** Every parseable record in a file's text, in the order it was written. */
export function parseEvents(text: string): RunEvent[] {

    const events: RunEvent[] = [];

    for (const line of text.split("\n")) {

        const event = parseEvent(line);

        if (event)
            events.push(event);
    }

    return events;
}

/**
 * The records that still count, with anything an owner superseded
 * dropped.
 *
 * The file is append-only: rewriting it to remove a section could lose
 * the rest. So running a phase again appends a `restart`, and this
 * drops that owner's earlier lines when reading. The earlier draft
 * stays on disk.
 */
export function currentEvents(events: readonly RunEvent[]): RunEvent[] {

    // The last restart or clear per owner, which is where that owner's
    // surviving lines begin. Owners with neither keep everything. A
    // `cleared` record cuts the same way a `restart` does: the file
    // keeps every line (see `sessionToContinue`), but a panel drawing
    // the conversation has already been told this owner starts fresh -
    // showing the old turns anyway would mix a new session's lines in
    // with a cleared one's, which reads as worse than not clearing at
    // all.
    const cut = new Map<string, number>();

    events.forEach((event, index) => {

        if ((event.kind === "restart" || event.kind === "cleared") && event.ownerId)
            cut.set(event.ownerId, index);
    });

    if (!cut.size)
        return [...events];

    return events.filter((event, index) => {

        if (event.kind === "restart" || event.kind === "cleared")
            return false;

        const from = event.ownerId === undefined ? undefined : cut.get(event.ownerId);

        return from === undefined || index > from;
    });
}

/**
 * A record as a `LogLine`, or `undefined` for a control line, which a
 * panel drawing a conversation has no use for.
 */
export function lineFrom(event: RunEvent, fallbackOwner = ""): LogLine | undefined {

    if (isControl(event))
        return undefined;

    const { v, runId, sessionId, provider, status, at, ownerId, stream, text, ...meta } = event;

    void v; void runId; void sessionId; void provider; void status;

    return {
        ownerId: ownerId ?? fallbackOwner,
        at,
        stream: stream ?? "stdout",
        text: text ?? "",
        ...meta
    };
}

/** What one owner's hidden lines charged - see {@link supersededSpend}. */
export interface SupersededSpend {

    spent: Spend[];

    models: ModelSpend[];
}

/**
 * What each owner's earlier, no-longer-shown conversations charged.
 *
 * `currentEvents` hides what a re-run or a clear superseded, but the
 * money was spent all the same, and "what has this phase cost so far"
 * means every draft, not the one on screen. This is the part the
 * hidden lines carry, per owner, for the page to add to the lines it
 * does show. Owners whose hidden lines charged nothing are left out.
 */
export function supersededSpend(events: readonly RunEvent[]): Map<string, SupersededSpend> {

    const shown = new Set(currentEvents(events));

    const spent = new Map<string, SupersededSpend>();

    for (const event of events) {

        if (shown.has(event) || event.ownerId === undefined)
            continue;

        if (!event.cost?.length && !event.models?.length)
            continue;

        const carried = spent.get(event.ownerId) ?? { spent: [], models: [] };

        spent.set(event.ownerId, {
            spent: event.cost?.length ? addSpend(carried.spent, event.cost) : carried.spent,
            models: event.models?.length ? addModelSpend(carried.models, event.models) : carried.models
        });
    }

    return spent;
}

/**
 * One run of one owner's conversation - what a phase or a chat said
 * between one fresh start and the next.
 *
 * A run ends where a `restart` or a `cleared` record cuts its owner,
 * the same cut {@link currentEvents} makes. A revise that carries the
 * conversation on writes no cut, so it stays in the same run.
 */
export interface SessionRun {

    ownerId: string;

    /** 1 for the owner's first run, counting only runs that are kept - see {@link sessionRuns}. */
    iteration: number;

    /** The run {@link currentEvents} still shows - the owner's last one, when nothing cut it. */
    current: boolean;

    /** When its first record was written. */
    at: number;

    /** The provider's conversation id - the last one recorded in the run. */
    sessionId?: string;

    provider?: string;

    model?: string;

    /** The instruction the person gave when starting it, if any - a revise note. */
    note?: string;

    /** How its last `end` record said it ended. Absent while it runs, or when it died. */
    status?: string;

    /** The phase chat the run is in. Absent for a run from before phase chats were sessions. */
    chatId?: string;

    /** Its lines, control records left out. */
    lines: RunEvent[];
}

/**
 * Every run of every owner in the file, in the order each started.
 *
 * Kept only when it has something to read: a conversation id, or a
 * line the plugin labelled. A run holding only the panel's own notes
 * ("Already working - design was not started.") is not a session.
 *
 * Numbered per owner after that filter, so the numbers never skip.
 */
export function sessionRuns(events: readonly RunEvent[]): SessionRun[] {

    const runs: SessionRun[] = [];

    /** The run each owner is writing into now. */
    const open = new Map<string, SessionRun>();

    const close = (ownerId: string) => {

        const run = open.get(ownerId);

        open.delete(ownerId);

        if (run && (run.sessionId || run.chatId || run.lines.some(line => line.kind)))
            runs.push(run);
    };

    for (const event of events) {

        const ownerId = event.ownerId;

        if (ownerId === undefined)
            continue;

        if (event.kind === "restart" || event.kind === "cleared") {

            close(ownerId);
            continue;
        }

        let run = open.get(ownerId);

        if (!run) {

            run = { ownerId, iteration: 0, current: false, at: event.at, lines: [] };
            open.set(ownerId, run);
        }

        if (event.kind === "session") {

            run.sessionId = event.sessionId;
            run.provider = event.provider;
            run.model = event.model;

        } else if (event.kind === "start") {

            if (run.note === undefined && event.text?.trim())
                run.note = event.text.trim();

            if (event.chatId)
                run.chatId = event.chatId;

        } else if (event.kind === "end")
            run.status = event.status;

        else if (!isControl(event))
            run.lines.push(event);
    }

    // What is still open was never cut: each owner's current run.
    const last = new Set<SessionRun>(open.values());

    for (const ownerId of [...open.keys()])
        close(ownerId);

    runs.sort((left, right) => left.at - right.at);

    const count = new Map<string, number>();

    for (const run of runs) {

        run.iteration = (count.get(run.ownerId) ?? 0) + 1;
        run.current = last.has(run);
        count.set(run.ownerId, run.iteration);
    }

    return runs;
}

/**
 * The phase chat of one owner's current run: the one its newest `start`
 * record names. Nothing when a `restart` or `cleared` came after it, or
 * when the run is from before phase chats were sessions.
 */
export function currentChat(events: readonly RunEvent[], ownerId: string): string | undefined {

    for (let index = events.length - 1; index >= 0; index--) {

        const event = events[index];

        if (event.ownerId !== ownerId)
            continue;

        if (event.kind === "restart" || event.kind === "cleared")
            return undefined;

        if (event.kind === "start")
            return event.chatId;
    }

    return undefined;
}

export function isControl(event: RunEvent): boolean {

    return event.kind === "open"
        || event.kind === "start"
        || event.kind === "session"
        || event.kind === "end"
        || event.kind === "restart"
        || event.kind === "cleared"
        || event.kind === "rewound";
}

/**
 * The conversation to carry on for one owner, when there is one.
 *
 * The last `session` record, because a phase run again gets a new
 * conversation. Only when the provider matches: a session id means
 * nothing to a provider that did not issue it, so a spec drafted on
 * Claude and revised with `provider: ghcp` must start fresh.
 *
 * A `cleared` record for that owner ends the search. It is a record
 * rather than a deletion because the file is append-only.
 */
export function sessionToContinue(
    events: readonly RunEvent[],
    ownerId: string,
    provider: string | undefined
): string | undefined {

    const last = lastSession(events, ownerId);

    if (!last)
        return undefined;

    return provider === undefined || last.provider === undefined || last.provider === provider
        ? last.sessionId
        : undefined;
}

/**
 * The last conversation one owner had, whoever issued it - the record
 * {@link sessionToContinue} judges, handed back whole so a caller can
 * see *why* it will not be continued (a different runtime) or on what
 * model it was opened. Stops at a `cleared` or `rewound` record the same
 * way.
 */
export function lastSession(
    events: readonly RunEvent[],
    ownerId: string
): { sessionId: string; provider?: string; model?: string } | undefined {

    for (let index = events.length - 1; index >= 0; index--) {

        const event = events[index];

        if ((event.kind === "cleared" || event.kind === "rewound") && event.ownerId === ownerId)
            return undefined;

        if (event.kind !== "session" || event.ownerId !== ownerId || !event.sessionId)
            continue;

        return { sessionId: event.sessionId, provider: event.provider, model: event.model };
    }

    return undefined;
}

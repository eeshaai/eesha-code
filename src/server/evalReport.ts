import * as fs from "fs";
import * as path from "path";

import { changedBetween, snapshot } from "../chat/turnSnapshot";
import { addSpend } from "../core/models/run";
import { parseEvents, type RunEvent } from "../core/events/runEvents";
import { parseFindings } from "./evalTasks";
import type { EvalFileChange, EvalToolReport, EvalTurnReport } from "./protocol";

/*
 * The numbers the Evaluator's report shows for one variant, read off the
 * variant's own chat file. Facts only: how long, how much, how many. It
 * never says whether the task was done, and never ranks.
 *
 * A turn is one message sent and everything the agent did until it
 * stopped. Every number is per turn, so the page can show the first
 * turn alone or all of them.
 */

/** The engine's own first line of a run - written a moment before the message's own line. */
const RUN_START = "Run ai@1";

/** The line a runtime's log gets for a refused call, where no notice carries it. */
const DENIED = /^Denied /;

/** The longest a tool's name is in the report. */
const TOOL_NAME_LIMIT = 48;

/** The most single calls kept for one turn. The sums count every call. */
const CALLS_KEPT = 500;

/** The longest a call's title is kept. */
const TITLE_LIMIT = 200;

/**
 * What a tool row is counted under. The runtimes write a row's title for
 * a person - "Executing 'npm test'", "Reading a.ts" - so the first word
 * is the kind of call, and the rest is what it was given. A title with
 * no such word ("Read File", "Sub-agent: x") is its own kind.
 */
export function toolKind(title: string): string {

    const text = title.replace(/\s+/g, " ").trim();
    const first = /^([A-Z][a-z]+ing)\b/.exec(text)?.[1];

    if (first)
        return first;

    // "Sub-agent: name" and the like: what is before the colon.
    const head = text.split(/[:'"`]/)[0]!.trim() || text;

    return head.length > TOOL_NAME_LIMIT ? `${head.slice(0, TOOL_NAME_LIMIT - 1)}…` : head;
}

/** One turn being added up. */
interface Turn {

    start: number;

    end: number;

    events: RunEvent[];
}

/**
 * Cuts a chat file into turns. A turn starts at the engine's "Run ai@1"
 * line before the message when there is one, else at the message.
 * Lines before the first message belong to no turn: a start that failed
 * sent nothing.
 */
function turnsOf(events: readonly RunEvent[]): Turn[] {

    const turns: Turn[] = [];

    // Lines since the last "Run ai@1": they belong to the turn the next message starts.
    let lead: RunEvent[] = [];

    let current: Turn | undefined;

    for (const event of events) {

        if (event.kind === "open" || event.kind === "restart" || event.kind === "cleared" || event.kind === "rewound")
            continue;

        if (event.kind === undefined && event.stream === "system" && event.text?.startsWith(RUN_START)) {

            lead = [event];

            continue;
        }

        if (event.kind === "prompt") {

            current = { start: lead[0]?.at ?? event.at, end: event.at, events: [...lead, event] };
            lead = [];
            turns.push(current);

            continue;
        }

        if (lead.length) {

            lead.push(event);

            continue;
        }

        if (!current)
            continue;

        current.events.push(event);

        // A progress line (the account's limits, the context's size) can arrive after the turn is over.
        if (!event.progress)
            current.end = Math.max(current.end, event.at);
    }

    return turns;
}

/**
 * One turn's numbers.
 *
 * @param running The turn has not ended: its time runs to `now`.
 */
function turnReport(turn: Turn, running: boolean, now: number): EvalTurnReport {

    const started = new Map<string, RunEvent>();
    const kinds = new Map<string, EvalToolReport>();
    const calls: EvalTurnReport["calls"] = [];

    // Everything the agent said in this turn, in order: its answer often arrives as several records.
    let said = "";

    let toolMs = 0;
    let toolCalls = 0;
    let failed = 0;
    let refusedNotices = 0;
    let deniedLines = 0;
    let modelCalls: number | undefined;
    let inputTokens: number | undefined;
    let cachedTokens: number | undefined;
    let outputTokens: number | undefined;
    const models = new Set<string>();
    let cost: EvalTurnReport["cost"] = [];
    let error = false;

    const add = (sum: number | undefined, value: number | undefined) => typeof value === "number" ? (sum ?? 0) + value : sum;

    for (const event of turn.events) {

        switch (event.kind) {

            case "tool.start":

                started.set(event.callId ?? event.tool ?? "", event);

                break;

            case "tool.end": {

                const key = event.callId ?? event.tool ?? "";
                const from = started.get(key);

                started.delete(key);

                const title = from?.tool ?? event.tool ?? "tool";
                const ms = Math.max(0, typeof event.ms === "number" ? event.ms : from ? event.at - from.at : 0);
                const kind = toolKind(title);
                const row = kinds.get(kind) ?? { tool: kind, calls: 0, ms: 0, failed: 0 };

                row.calls++;
                row.ms += ms;

                if (event.ok === false) {

                    row.failed++;
                    failed++;
                }

                kinds.set(kind, row);

                if (calls.length < CALLS_KEPT)
                    calls.push({ title: title.replace(/\s+/g, " ").trim().slice(0, TITLE_LIMIT), kind, ms, ...(event.ok === false ? { failed: true } : {}) });

                toolMs += ms;
                toolCalls++;

                break;
            }

            case "message":

                said += event.text ?? "";

                break;

            case "error":

                error = true;

                break;

            case "notice":

                if (event.permission?.refused)
                    refusedNotices++;

                if (event.cost?.length)
                    cost = addSpend(cost, event.cost).map(one => ({ amount: one.amount, unit: one.unit }));

                modelCalls = add(modelCalls, event.calls);

                for (const model of event.models ?? []) {

                    inputTokens = add(inputTokens, model.inputTokens);
                    cachedTokens = add(cachedTokens, model.cachedTokens);
                    outputTokens = add(outputTokens, model.outputTokens);

                    if (model.model)
                        models.add(model.model);
                }

                break;

            default:

                if (event.kind === undefined && event.stream === "system" && DENIED.test(event.text ?? ""))
                    deniedLines++;
        }
    }

    const end = running ? Math.max(now, turn.end) : turn.end;
    const ms = Math.max(0, end - turn.start);
    const findings = parseFindings(said);

    return {
        at: turn.start,
        ms,

        // Calls that ran at the same time can add up to more than the turn took.
        toolMs: Math.min(toolMs, ms),
        toolCalls,
        failed,

        // One refused call can be written as a notice, as a log line, or both.
        refused: Math.max(refusedNotices, deniedLines),
        ...(modelCalls !== undefined ? { modelCalls } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(cachedTokens !== undefined ? { cachedTokens } : {}),
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(models.size ? { models: [...models] } : {}),
        cost,
        tools: [...kinds.values()].sort((left, right) => right.ms - left.ms),
        calls,
        ...(findings ? { findings } : {}),
        ...(error ? { error: true } : {}),
        ...(running ? { running: true } : {})
    };
}

/**
 * Every turn's numbers of one chat file's records.
 *
 * @param working The variant runs a turn now: its last turn has no end yet.
 */
export function turnReports(events: readonly RunEvent[], working: boolean, now = Date.now()): EvalTurnReport[] {

    const turns = turnsOf(events);

    return turns.map((turn, index) => turnReport(turn, working && index === turns.length - 1, now));
}

/** A chat file's turns. No file yet: none. */
export function turnReportsOfFile(file: string, working: boolean, now = Date.now()): EvalTurnReport[] {

    let text: string;

    try {

        text = fs.readFileSync(file, "utf8");

    } catch {

        return [];
    }

    return turnReports(parseEvents(text), working, now);
}

/**
 * The files a variant's copy differs in from where it started: files as
 * they are on disk now, committed by the variant or not.
 *
 * @param root   The copy's repository.
 * @param commit The commit the copy started from.
 */
export async function copyChanges(root: string, commit: string): Promise<EvalFileChange[]> {

    const files = await changedBetween(root, commit, await snapshot(root));

    return files.map(file => ({ path: file.path, status: file.status }));
}

/**
 * The bytes under a folder. Links are counted as themselves, never
 * followed. A folder that is not there: 0. `except`: names of entries
 * right under `folder` that are left out - counted elsewhere.
 */
export async function folderBytes(folder: string, except: readonly string[] = []): Promise<number> {

    let entries: fs.Dirent[];

    try {

        entries = await fs.promises.readdir(folder, { withFileTypes: true });

    } catch {

        return 0;
    }

    let bytes = 0;

    for (const entry of entries) {

        if (except.includes(entry.name))
            continue;

        const full = path.join(folder, entry.name);

        if (entry.isDirectory()) {

            bytes += await folderBytes(full);

            continue;
        }

        try {

            bytes += (await fs.promises.lstat(full)).size;

        } catch {

            // Gone meanwhile.
        }
    }

    return bytes;
}

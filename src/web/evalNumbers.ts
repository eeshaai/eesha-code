import type { EvalFinding, EvalTurnReport, EvalVariantReport } from "../server/protocol";

/*
 * The Evaluator report's sums and how its numbers are written. No page
 * code in it, so a test can hold it.
 */

/** A variant's turns added up - all of them, or the first alone. */
export interface EvalTotals {

    turns: number;

    ms: number;

    toolMs: number;

    toolCalls: number;

    failed: number;

    refused: number;

    /** Absent: the runtime does not say. */
    modelCalls?: number;

    inputTokens?: number;

    cachedTokens?: number;

    outputTokens?: number;

    /** One row per unit. Empty: the runtime does not say. */
    cost: { amount: number; unit: string }[];

    /** By kind of call, the longest first. */
    tools: { tool: string; calls: number; ms: number; failed: number }[];

    /** Every single call, the longest first. */
    calls: EvalTurnReport["calls"];

    /** Absent: no counted turn's answer has a list of findings. */
    findings?: EvalFinding[];

    /** A turn is still running: the times are so far. */
    running: boolean;

    /** The runtime wrote an error in one of the turns. */
    error: boolean;

    /** The model ids the runtime said it used. Empty: it did not say. */
    models: string[];
}

/**
 * Adds a variant's turns up.
 *
 * @param firstOnly Only the first turn: the one message every variant got.
 */
export function totalsOf(variant: Pick<EvalVariantReport, "turns">, firstOnly: boolean): EvalTotals {

    const turns: EvalTurnReport[] = firstOnly ? variant.turns.slice(0, 1) : variant.turns;

    const totals: EvalTotals = { turns: turns.length, ms: 0, toolMs: 0, toolCalls: 0, failed: 0, refused: 0, cost: [], tools: [], calls: [], running: false, error: false, models: [] };

    const add = (sum: number | undefined, value: number | undefined) => typeof value === "number" ? (sum ?? 0) + value : sum;

    for (const turn of turns) {

        totals.ms += turn.ms;
        totals.toolMs += turn.toolMs;
        totals.toolCalls += turn.toolCalls;
        totals.failed += turn.failed;
        totals.refused += turn.refused;
        totals.modelCalls = add(totals.modelCalls, turn.modelCalls);
        totals.inputTokens = add(totals.inputTokens, turn.inputTokens);
        totals.cachedTokens = add(totals.cachedTokens, turn.cachedTokens);
        totals.outputTokens = add(totals.outputTokens, turn.outputTokens);
        totals.running ||= turn.running === true;
        totals.error ||= turn.error === true;

        for (const charge of turn.cost) {

            const row = totals.cost.find(one => one.unit === charge.unit);

            if (row)
                row.amount += charge.amount;
            else
                totals.cost.push({ ...charge });
        }

        for (const tool of turn.tools) {

            const row = totals.tools.find(one => one.tool === tool.tool);

            if (row) {

                row.calls += tool.calls;
                row.ms += tool.ms;
                row.failed += tool.failed;

            } else
                totals.tools.push({ ...tool });
        }

        totals.calls.push(...turn.calls);

        for (const model of turn.models ?? [])
            if (!totals.models.includes(model))
                totals.models.push(model);

        if (turn.findings)
            totals.findings = [...(totals.findings ?? []), ...turn.findings];
    }

    totals.tools.sort((left, right) => right.ms - left.ms);
    totals.calls.sort((left, right) => right.ms - left.ms);

    return totals;
}

/** One row of the findings table: one place in the code, and what each variant said about it. */
export interface FindingRow {

    file: string;

    /** 0: no single line. */
    line: number;

    /** One per variant, in the variants' order. Nothing: that variant did not list this place. */
    cells: (EvalFinding | undefined)[];

    /** How many variants listed this place. */
    found: number;
}

/**
 * Puts the variants' findings side by side. Two findings are the same
 * row when they name the same file and the same line - the wording of
 * the problem is each variant's own. Rows more variants listed come
 * first, then by file and line.
 *
 * @param all One list per variant, in the variants' order. Nothing: that variant has no list.
 */
export function findingRows(all: readonly (readonly EvalFinding[] | undefined)[]): FindingRow[] {

    const rows = new Map<string, FindingRow>();

    all.forEach((findings, index) => {

        for (const finding of findings ?? []) {

            const key = `${finding.file.toLowerCase()}:${finding.line}`;
            const row = rows.get(key) ?? { file: finding.file, line: finding.line, cells: all.map(() => undefined), found: 0 };

            // A variant that listed one place twice: the first is kept.
            if (!row.cells[index]) {

                row.cells[index] = finding;
                row.found++;
            }

            rows.set(key, row);
        }
    });

    return [...rows.values()].sort((left, right) =>
        right.found - left.found || left.file.localeCompare(right.file) || left.line - right.line);
}

/**
 * Which values of one row of the report are the lowest - the cells the
 * report shows in green. A variant with no value (nothing sent, still
 * running, or a number its runtime does not give) is left out. Nothing
 * is marked with fewer than two values, or when all of them are the
 * same: then there is nothing to tell apart.
 */
export function lowestOf(values: readonly (number | undefined)[]): boolean[] {

    const known = values.filter((value): value is number => value !== undefined);

    if (known.length < 2 || known.every(value => value === known[0]))
        return values.map(() => false);

    const lowest = Math.min(...known);

    return values.map(value => value === lowest);
}

/**
 * What a variant was charged as one number, to compare with the others.
 * Nothing when it was charged in more than one unit, or in another unit
 * than `unit`: dollars and credits cannot be compared.
 */
export function costIn(cost: readonly { amount: number; unit: string }[], unit: string | undefined): number | undefined {

    return unit !== undefined && cost.length === 1 && cost[0]!.unit === unit ? cost[0]!.amount : undefined;
}

/** A length of time: `0.4s`, `58s`, `6m 42s`, `1h 03m`. */
export function timeText(ms: number): string {

    if (ms < 10_000)
        return `${(ms / 1000).toFixed(1)}s`;

    const seconds = Math.round(ms / 1000);

    if (seconds < 60)
        return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60)
        return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;

    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A count with thousands apart: `55,751`. */
export function countText(value: number): string {

    return Math.round(value).toLocaleString("en-US");
}

/** What was charged: `$0.2445`, `3 credits`, or both. Nothing charged or not said: a dash. */
export function costText(cost: readonly { amount: number; unit: string }[]): string {

    if (!cost.length)
        return "-";

    return cost
        .map(one => one.unit === "USD" ? `$${one.amount.toFixed(one.amount < 1 ? 4 : 2)}` : `${Number(one.amount.toFixed(2))} ${one.unit}`)
        .join(" + ");
}

/** A size on disk: `812 KB`, `34.2 MB`, `1.3 GB`. */
export function sizeText(bytes: number): string {

    if (bytes < 1024 * 1024)
        return `${Math.max(bytes ? 1 : 0, Math.round(bytes / 1024))} KB`;

    if (bytes < 1024 * 1024 * 1024)
        return `${(bytes / 1024 / 1024).toFixed(1)} MB`;

    return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

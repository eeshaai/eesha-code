/**
 * What the Wave graph tab draws, worked out from the plan - kept apart
 * from the drawing so it can be tested without a browser.
 *
 * Waves are laid out top down in rows. A wave that waits for nothing
 * is a starting point and sits in the first row; any other wave sits
 * one row below the lowest wave it waits for. Waves in one row do not
 * wait for each other, so two people can work them at the same time.
 */

import { needsOf, waitsFor } from "../../shared/waveOrder";
import type { TaskWave } from "./taskList";

/** One wave as the graph shows it. */
export interface GraphWave {

    id: number;

    tasks: string[];

    /** The waves it waits for directly - one arrow each. Empty for a starting point. */
    needs: number[];

    /** Its row, 0 at the top. */
    row: number;
}

/** Two tasks on different branches that name the same file - a warning, never a stop. */
export interface Clash {

    tasks: [string, string];

    paths: string[];
}

/** A later task editing a file an earlier task it waits for edited - a card popup's "Builds on" and "Used by". */
export interface FileLink {

    from: string;

    to: string;

    paths: string[];
}

/**
 * The waves in rows, top down, each row in id order.
 *
 * Only smaller ids can be waited for, so walking the waves by id fills
 * in every wave a wave waits for before the wave itself.
 */
export function waveRows(waves: readonly TaskWave[]): GraphWave[][] {

    const direct = needsOf(waves);

    const rowOf = new Map<number, number>();

    const sorted = [...waves].sort((left, right) => left.id - right.id);

    for (const wave of sorted) {

        const needs = direct.get(wave.id) ?? [];

        rowOf.set(wave.id, needs.length ? 1 + Math.max(...needs.map(id => rowOf.get(id) ?? 0)) : 0);
    }

    const rows: GraphWave[][] = [];

    for (const wave of sorted) {

        const row = rowOf.get(wave.id)!;

        (rows[row] ??= []).push({ id: wave.id, tasks: wave.tasks, needs: direct.get(wave.id) ?? [], row });
    }

    // A row can only be empty if ids were skipped in a way that cannot
    // happen; filtered anyway, so the drawing never meets a hole.
    return rows.filter(Boolean);
}

/** The waves that wait for nothing - where people can start. */
export function startingPoints(waves: readonly TaskWave[]): number[] {

    return [...needsOf(waves).entries()]
        .filter(([, needs]) => !needs.length)
        .map(([id]) => id)
        .sort((left, right) => left - right);
}

/**
 * Tasks of two waves that can be worked at the same time - neither
 * waits for the other - and that name the same file on their `Files:`
 * lines. Two people on two laptops would both edit it, and git would
 * make them merge it. Tasks of one wave are not reported here: the
 * panel already refuses those before any chat opens.
 *
 * @param filesOf a task's `Files:` paths.
 */
export function branchClashes(waves: readonly TaskWave[], filesOf: (id: string) => readonly string[]): Clash[] {

    const all = waitsFor(waves);

    const sorted = [...waves].sort((left, right) => left.id - right.id);

    const clashes: Clash[] = [];

    for (const [index, left] of sorted.entries())
        for (const right of sorted.slice(index + 1)) {

            // One waits for the other: they are never worked at once.
            if (all.get(right.id)?.has(left.id) || all.get(left.id)?.has(right.id))
                continue;

            for (const one of left.tasks)
                for (const two of right.tasks) {

                    const theirs = new Set(filesOf(two));

                    const paths = [...new Set(filesOf(one))].filter(path => theirs.has(path));

                    if (paths.length)
                        clashes.push({ tasks: [one, two], paths });
                }
        }

    return clashes;
}

/**
 * For every task, the earlier task it builds on through a file: for
 * each path on its `Files:` line, the task with the same path in the
 * latest wave it waits for. Several paths between the same two tasks
 * make one link.
 */
export function fileLinks(waves: readonly TaskWave[], filesOf: (id: string) => readonly string[]): FileLink[] {

    const all = waitsFor(waves);

    const links = new Map<string, FileLink>();

    for (const wave of waves) {

        // Latest first, so the nearest earlier task wins.
        const earlier = waves
            .filter(other => all.get(wave.id)?.has(other.id))
            .sort((left, right) => right.id - left.id);

        for (const task of wave.tasks)
            for (const path of new Set(filesOf(task))) {

                const from = earlier
                    .flatMap(other => other.tasks)
                    .find(other => filesOf(other).includes(path));

                if (from === undefined)
                    continue;

                const key = `${from}>${task}`;

                const link = links.get(key) ?? { from, to: task, paths: [] };

                link.paths.push(path);
                links.set(key, link);
            }
    }

    return [...links.values()];
}

/** "after wave 0", "after waves 2 and 3", or "starting point". */
export function needsLabel(needs: readonly number[]): string {

    if (!needs.length)
        return "starting point";

    if (needs.length === 1)
        return `after wave ${needs[0]}`;

    return `after waves ${needs.slice(0, -1).join(", ")} and ${needs[needs.length - 1]}`;
}

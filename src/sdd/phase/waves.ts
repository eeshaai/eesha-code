/**
 * The order handed tasks are worked in: one wave at a time.
 *
 * The plan's dependency graph says which tasks may run at the same
 * time. Here that becomes the list of chats the panel starts, in order
 * - each wave is one chat, and the next chat starts only when every
 * task of the one before it is ticked.
 */

import type { OrderedTask } from "../../shared/waveOrder";
import type { Plan } from "../documents/parsePlan";

/**
 * Every unit of work in the plan - the tasks with none under them - in
 * the plan's order, with its wave and its box. What the start order is
 * checked against; see `openBefore`.
 */
export function planOrder(plan: Plan | undefined): OrderedTask[] {

    if (!plan)
        return [];

    return plan.tasks
        .filter(task => !task.group)
        .map(task => ({
            id: task.id,
            wave: plan.waves?.find(wave => wave.tasks.includes(task.id))?.id,
            done: task.done,
            optional: task.optional
        }));
}

/**
 * Groups tasks by the wave the plan put them in, waves in ascending
 * order.
 *
 * A plan with no graph at all is one wave, in the order handed: there
 * is nothing to say the tasks may not run one after another in a single
 * chat, and one chat per task would hand the agent one task at a
 * time. `splitWave` still cuts it at every `Run:` or by-hand task.
 *
 * A task a graph left out is a wave of its own, after the graphed ones,
 * in the order handed. Alone is the safe reading: the grammar says the
 * same when a plan cannot tell what a task touches.
 */
export function wavesOf<T extends { wave?: number }>(tasks: T[]): T[][] {

    if (tasks.length && tasks.every(task => task.wave === undefined))
        return [[...tasks]];

    const byWave = new Map<number, T[]>();
    const alone: T[][] = [];

    for (const task of tasks)
        if (task.wave === undefined)
            alone.push([task]);
        else
            byWave.set(task.wave, [...(byWave.get(task.wave) ?? []), task]);

    const waved = [...byWave.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, list]) => list);

    return [...waved, ...alone];
}

/**
 * The steps one wave is worked in, in the plan's order: each `Run:`
 * task alone, and the agent tasks between them together, for one chat.
 * The tasks of a wave run one after another, so the order they sit in
 * the plan is the order they run in.
 */
export function splitWave<T extends { run?: unknown }>(wave: T[]): T[][] {

    const steps: T[][] = [];

    let chat: T[] = [];

    for (const task of wave) {

        if (!task.run) {

            chat.push(task);
            continue;
        }

        if (chat.length)
            steps.push(chat);

        chat = [];
        steps.push([task]);
    }

    if (chat.length)
        steps.push(chat);

    return steps;
}

/** A path two or more tasks of one wave both name - work they would do on top of each other. */
export interface Conflict {

    path: string;

    /** The ids of the tasks naming it, in the order handed. */
    tasks: string[];
}

/**
 * The paths a wave's tasks share, from their `Files:` lines.
 *
 * Empty means the wave is safe to hand over as one chat. A task with no
 * `Files:` line conflicts with nothing here - the plan said nothing, so
 * there is nothing to check; the grammar asks the tasks phase to give
 * such a task a wave of its own.
 *
 * @param filesOf the plan's `Files:` line per task id, as parsed.
 */
export function conflicts(wave: { id: string }[], filesOf: (id: string) => string[]): Conflict[] {

    const byPath = new Map<string, string[]>();

    for (const task of wave)
        for (const file of new Set(filesOf(task.id)))
            byPath.set(file, [...(byPath.get(file) ?? []), task.id]);

    return [...byPath.entries()]
        .filter(([, tasks]) => tasks.length > 1)
        .map(([path, tasks]) => ({ path, tasks }));
}

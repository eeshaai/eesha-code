/**
 * The order a plan's tasks may start in - one rule, read the same way
 * by the engine (which refuses a start) and by the view (which greys
 * the ▶ out).
 *
 * The plan's waves are in order for a reason: a later wave builds on
 * the code the earlier ones wrote. So a task may start only when every
 * task in the waves its wave waits for is ticked - the wave's `after`
 * list, or every earlier wave when it has none. Waves that do not wait
 * for each other are branches, and two people can work them at once.
 * Tasks the graph gives no wave come after every waved one, one at a
 * time, in the order of the plan.
 */

/** A unit of work as far as order is concerned. */
export interface OrderedTask {

    id: string;

    /** The wave the plan's graph puts it in; undefined when the graph names it nowhere. */
    wave?: number;

    done: boolean;

    /** `- [ ]* 1.2` - skippable, so left unticked it holds nothing back. */
    optional?: boolean;
}

/**
 * Each task's place in the order, 0 first. Waves by ascending id, then
 * every unwaved task alone in the order given - the same order the
 * host's lanes run in.
 */
export function stepsOf(plan: readonly Pick<OrderedTask, "id" | "wave">[]): Map<string, number> {

    const waveIds = [...new Set(plan.flatMap(task => task.wave === undefined ? [] : [task.wave]))]
        .sort((left, right) => left - right);

    const steps = new Map<string, number>();

    let next = waveIds.length;

    for (const task of plan)
        steps.set(task.id, task.wave === undefined ? next++ : waveIds.indexOf(task.wave));

    return steps;
}

/** A wave as far as order is concerned: its id, and what it waits for. */
export interface WaveNeeds {

    id: number;

    /** The waves it waits for. Empty: none - a starting point. Absent: the wave before it. */
    after?: readonly number[];
}

/**
 * The waves each wave waits for directly - its `after`, with what the
 * graph does not have and what is not a smaller id dropped, or the wave
 * with the next smaller id when it has no `after`. What the wave graph
 * draws an arrow for.
 */
export function needsOf(graph: readonly WaveNeeds[]): Map<number, number[]> {

    const ids = [...new Set(graph.map(wave => wave.id))].sort((left, right) => left - right);

    const known = new Set(ids);

    const direct = new Map<number, number[]>();

    for (const wave of graph)
        direct.set(wave.id, wave.after === undefined
            ? ids.filter(id => id < wave.id).slice(-1)
            : [...new Set(wave.after)].filter(id => known.has(id) && id < wave.id).sort((left, right) => left - right));

    return direct;
}

/**
 * Every wave each wave waits for, directly or through another wave.
 *
 * A wave with no `after` waits for the wave with the next smaller id,
 * which is the whole order of a plan that never writes `after`. An
 * `after` naming a wave that is not there, or one with an id not smaller
 * than its own, is ignored; the plan's reader reports both. With only
 * smaller ids allowed there can be no loop.
 */
export function waitsFor(graph: readonly WaveNeeds[]): Map<number, Set<number>> {

    const ids = [...new Set(graph.map(wave => wave.id))].sort((left, right) => left - right);

    const direct = needsOf(graph);

    const all = new Map<number, Set<number>>();

    // Smallest first, so every wave a wave waits for is already filled in.
    for (const id of ids) {

        const set = new Set<number>();

        for (const needed of direct.get(id) ?? []) {

            set.add(needed);

            for (const further of all.get(needed) ?? [])
                set.add(further);
        }

        all.set(id, set);
    }

    return all;
}

/**
 * Whether `first` must be ticked before `then` may start.
 *
 * A task the graph puts in no wave comes after every waved task, and
 * after the unwaved tasks before it in the plan. A waved task waits for
 * the tasks of the waves it waits for - every earlier wave, when the
 * plan has no graph to say otherwise - and never for an unwaved one.
 * Tasks of one wave never wait for each other.
 *
 * @param index each task's place in the plan's order.
 */
function mustPrecede(
    first: OrderedTask,
    then: OrderedTask,
    index: ReadonlyMap<string, number>,
    waits: (wave: number) => ReadonlySet<number> | undefined): boolean {

    if (then.wave === undefined)
        return first.wave !== undefined || index.get(first.id)! < index.get(then.id)!;

    if (first.wave === undefined || first.wave === then.wave)
        return false;

    const set = waits(then.wave);

    // A wave the graph does not list: every earlier wave.
    return set ? set.has(first.wave) : first.wave < then.wave;
}

/**
 * The tasks that must be ticked before `ids` may start: unticked, not
 * optional, and in a wave one of them waits for. Empty means they may
 * start.
 *
 * A task that is itself one of `ids`, or in `ahead` (already in a chat
 * or queued before these), is not counted: it will be worked first
 * anyway. An id the plan does not know is not held back - there is
 * nothing to order it by.
 *
 * @param plan every unit of work, in the order of the plan.
 * @param graph the plan's waves with their `after`; without it, a wave waits for every wave before it.
 */
export function openBefore(
    plan: readonly OrderedTask[],
    ids: readonly string[],
    ahead: ReadonlySet<string> = new Set(),
    graph: readonly WaveNeeds[] = []): string[] {

    const index = new Map(plan.map((task, place) => [task.id, place]));

    const all = waitsFor(graph);

    const handed = new Set(ids);

    const targets = ids
        .map(id => plan.find(task => task.id === id))
        .filter((task): task is OrderedTask => task !== undefined);

    return plan
        .filter(task => !task.done && !task.optional && !handed.has(task.id) && !ahead.has(task.id))
        .filter(task => targets.some(target => mustPrecede(task, target, index, wave => all.get(wave))))
        .map(task => task.id);
}

/**
 * The waves that wait for `wave`, directly or through another wave -
 * what follows it down its branch. In id order.
 */
export function wavesAfter(graph: readonly WaveNeeds[], wave: number): number[] {

    const all = waitsFor(graph);

    return [...all.entries()]
        .filter(([, set]) => set.has(wave))
        .map(([id]) => id)
        .sort((left, right) => left - right);
}

/** What "Run till here" hands over - see `tillHere`. */
export interface Till {

    /** The tasks to run, in the plan's order. */
    tasks: string[];

    /** Optional tasks on the way: left out unless the person picks them. */
    optional: string[];
}

/**
 * What "Run till here" hands over: every unticked task of the waves
 * `wave` waits for, directly or through another wave, then the wave's
 * own unticked tasks - or only `only` of them, when one task was
 * pressed. Waves it does not wait for are left alone, and so is every
 * wave after it.
 *
 * A wave the graph does not list waits for every wave before it - the
 * same rule `mustPrecede` keeps. Optional tasks come back apart:
 * they hold nothing back, so the person is asked about them. The
 * pressed task itself is never one of those.
 *
 * @param plan every unit of work, in the order of the plan.
 */
export function tillHere(plan: readonly OrderedTask[], graph: readonly WaveNeeds[], wave: number, only?: string): Till {

    const before = waitsFor(graph).get(wave);

    const onPath = (task: OrderedTask) => task.wave !== undefined && (task.wave === wave
        ? only === undefined || task.id === only
        : before ? before.has(task.wave) : task.wave < wave);

    const open = plan.filter(task => !task.done && onPath(task));

    const extra = (task: OrderedTask) => task.optional === true && task.id !== only;

    return {
        tasks: open.filter(task => !extra(task)).map(task => task.id),
        optional: open.filter(extra).map(task => task.id)
    };
}

/** A list of task ids for a message: the first few, then how many more. */
export function namesOf(ids: readonly string[], shown = 8): string {

    return ids.length <= shown
        ? ids.join(", ")
        : `${ids.slice(0, shown).join(", ")} and ${ids.length - shown} more`;
}

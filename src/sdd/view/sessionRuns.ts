import { SpecStage } from "../../shared/runMessages";
import { SessionRunSummary } from "../../shared/sddMessages";

/**
 * What the sessions pane lists and how it names each row. Kept apart
 * from the view so the rules can be tested without drawing anything.
 */

/**
 * A run the pane can show: one the host reported, or the one it would
 * start next.
 *
 * `pending` is the second kind - a conversation nobody has said
 * anything in yet, invented by {@link withNextRun}. It is never
 * offered in the dropdown, because a session that does not exist is
 * not one you pick from a list of sessions; the dropdown simply reads
 * empty while it is on screen, and the `+` beside it is what puts you
 * there.
 */
export interface PaneRun extends SessionRunSummary {

    pending?: boolean;
}

/** A pick in the pane: one owner, and one run of it - or its newest, when `iteration` is absent. */
export interface RunPick {

    ownerId: string;

    iteration?: number;
}

/** The phase a run belongs to - the part of `implement@wave:2` before the `@`. */
export function stageOf(ownerId: string): string {

    const at = ownerId.indexOf("@");

    return at < 0 ? ownerId : ownerId.slice(0, at);
}

/**
 * The runs worth a row, in the order the pane lists them: by phase, in
 * pipeline order, and newest first inside a phase.
 *
 * Left out: the execution phase's own name. Its chats are filed under
 * `implement@...` and listed there; what stays under the plain name is
 * the panel's own notes, plus the chats' ids, which would make a row
 * for a conversation that has no lines of its own.
 *
 * A run whose phase is not in the style is kept, at the end,
 * under its id - a style edit must not hide a conversation that
 * happened.
 */
export function paneRuns(runs: readonly SessionRunSummary[], stages: readonly SpecStage[]): SessionRunSummary[] {

    const order = new Map(stages.map((stage, index) => [stage.name, index]));

    const byName = new Map(stages.map(stage => [stage.name, stage]));

    return runs
        .filter(run => {

            const stage = byName.get(run.ownerId);

            return !(stage && !stage.artifact && !stage.hidden);
        })
        .sort((left, right) => {

            const leftAt = order.get(stageOf(left.ownerId)) ?? stages.length;
            const rightAt = order.get(stageOf(right.ownerId)) ?? stages.length;

            return leftAt !== rightAt ? leftAt - rightAt : right.at - left.at;
        });
}

/**
 * The same list, plus a row for the conversation a phase would start
 * next - for any phase that has runs but none of them current.
 *
 * That happens after New Session, and while a re-run is starting: the
 * old conversation was cut and the new one has not said anything yet,
 * so it exists only as an empty compose box. It is marked `pending`:
 * the pane needs it to have something to show and something to type
 * into, but it is kept out of the dropdown, which lists the sessions
 * that happened.
 *
 * `firstLineAt` is when the owner's first line on screen arrived, or
 * undefined when it has none. It both dates the new row and, for an
 * implementation chat, is the only sign the chat is real: those are
 * filed under `implement@...` and have no stage of their own.
 */
export function withNextRun(
    listed: readonly SessionRunSummary[],
    stages: readonly SpecStage[],
    firstLineAt: (ownerId: string) => number | undefined
): PaneRun[] {

    const byName = new Map(stages.map(stage => [stage.name, stage]));

    const next: PaneRun[] = [];

    for (const ownerId of new Set(listed.map(run => run.ownerId))) {

        const own = listed.filter(run => run.ownerId === ownerId);

        if (own.some(run => run.current))
            continue;

        const stage = byName.get(ownerId);

        const thread = (stage?.artifact && !stage.hidden)
            || (ownerId.includes("@") && firstLineAt(ownerId) !== undefined);

        if (!thread)
            continue;

        // Newer than the run it follows, so it sorts to the top of its
        // own phase - but dated from that run rather than from now,
        // which would make a phase nobody has touched hold the newest
        // thing in the spec and pull the pane onto it.
        const after = own.reduce((latest, run) => Math.max(latest, run.at), 0) + 1;

        next.push({
            ownerId,
            iteration: own.length + 1,
            current: true,
            at: firstLineAt(ownerId) ?? after,
            note: "New session",
            pending: true
        });
    }

    return next.length ? paneRuns([...listed, ...next], stages) : [...listed];
}

/** `Sep 23 10:14`, in the reader's own time zone. */
export function shortTime(at: number): string {

    const date = new Date(at);

    const month = date.toLocaleString("en-US", { month: "short" });

    const pad = (value: number) => String(value).padStart(2, "0");

    return `${month} ${date.getDate()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** How long a note may run in a title before it is cut. */
const NOTE_LENGTH = 60;

/**
 * The third part of a row's title.
 *
 * An implementation chat is named by its work - `Wave 2 · 2.1, 2.2`,
 * `Tasks 1.1, 1.2`, `Task 1.4` - every task it was handed, when the
 * record says which.
 * A run started with a revise note is named by the note's first line.
 * Anything else by when it started.
 *
 * @param tasks The ids the chat was handed, from its record.
 */
export function runDetail(run: SessionRunSummary, tasks?: readonly string[]): string {

    const at = run.ownerId.indexOf("@");

    if (at >= 0) {

        const task = run.ownerId.slice(at + 1);

        const ids = tasks?.length ? ` · ${tasks.join(", ")}` : "";

        // `wave:2-2` is wave 2's second chat - a `Run:` task sat
        // between its agent tasks.
        if (task.startsWith("wave:")) {

            const [wave, part] = task.slice("wave:".length).split("-");

            return (part ? `Wave ${wave} (part ${part})` : `Wave ${wave}`) + ids;
        }

        // A chat of a plan with no graph is filed under its first task
        // but holds every task up to the first `Run:` one.
        return tasks && tasks.length > 1 ? `Tasks ${tasks.join(", ")}` : `Task ${task}`;
    }

    const note = run.note?.split(/\r?\n/).find(line => line.trim())?.trim();

    if (note)
        return note.length > NOTE_LENGTH ? `${note.slice(0, NOTE_LENGTH - 1).trimEnd()}…` : note;

    return shortTime(run.at);
}

/** `<phase label> : #<run> : <detail>` - what a row says. */
export function runTitle(run: SessionRunSummary, stages: readonly SpecStage[], tasks?: readonly string[]): string {

    const name = stageOf(run.ownerId);

    const stage = stages.find(one => one.name === name);

    return `${stage?.label ?? name} : #${run.iteration} : ${runDetail(run, tasks)}`;
}

/**
 * One run as an option under its phase's group.
 *
 * The phase name is the group's label, so it is left off here: it is
 * the same on every option under that group, and repeating it spends
 * the width the part that differs needs.
 *
 * `state` is what the dot said when there was a list - a native option
 * cannot hold a coloured mark, so it is said in words instead. An
 * earlier run says so here too: it is read only, and that is worth
 * knowing before you pick it rather than after.
 */
export function runOption(run: SessionRunSummary, state?: string, tasks?: readonly string[]): string {

    const mark = state === "waiting" ? " · waiting for you"
        : state === "running" ? " · working"
            : state === "failed" ? " · failed"
                : "";

    // On the option rather than beside the dropdown, where a chip would
    // only describe the one run on screen. Here it is on every run it is
    // true of, so you can see which sessions you can still talk to
    // before picking one.
    const shut = run.current ? "" : " (Read Only)";

    return `#${run.iteration} · ${runDetail(run, tasks)}${mark}${shut}`;
}

/**
 * The listed runs grouped by phase, in the order they were listed.
 *
 * `paneRuns` has already sorted them by phase and then newest-first, so
 * a phase's runs are next to each other and this only has to find where
 * one ends. The execution phase's chats - `implement@wave:2` and the
 * like - all name the same phase, so they group under it rather than
 * standing as one heading each.
 */
export function runGroups(
    listed: readonly SessionRunSummary[],
    stages: readonly SpecStage[]
): { label: string; runs: SessionRunSummary[] }[] {

    const groups: { label: string; runs: SessionRunSummary[] }[] = [];

    let last: string | undefined;

    for (const run of listed) {

        const name = stageOf(run.ownerId);

        if (name !== last) {

            groups.push({ label: stages.find(one => one.name === name)?.label ?? name, runs: [] });
            last = name;
        }

        groups[groups.length - 1].runs.push(run);
    }

    return groups;
}

/**
 * The run a pick points at.
 *
 * An exact run when the pick names one. Otherwise the owner's current
 * run, or its newest; and for an owner with no run of its own - the
 * execution phase - the newest chat filed under it.
 */
export function pickedRun(runs: readonly SessionRunSummary[], pick: RunPick | undefined): SessionRunSummary | undefined {

    if (!pick)
        return undefined;

    if (pick.iteration !== undefined)
        return runs.find(run => run.ownerId === pick.ownerId && run.iteration === pick.iteration);

    const own = runs.filter(run => run.ownerId === pick.ownerId);

    const pool = own.length ? own : runs.filter(run => run.ownerId.startsWith(`${pick.ownerId}@`));

    return pool.find(run => run.current && run.ownerId === pick.ownerId)
        ?? pool.reduce<SessionRunSummary | undefined>((newest, run) => !newest || run.at > newest.at ? run : newest, undefined);
}

/** A run's key in the pane's cache of earlier runs' lines. */
export function runKey(run: { ownerId: string; iteration: number }): string {

    return `${run.ownerId}#${run.iteration}`;
}

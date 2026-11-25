/**
 * Reading `tasks.md` - the one document the product parses rather than
 * merely shows.
 *
 * The implement lens renders a row per task, launches a chat per task,
 * and fans out a wave at a time; the ticked checkbox is the completion
 * signal every teammate reads progress from. So this file decides what
 * the panel can do with a plan.
 *
 * Tolerant, and never silent. A style may replace `tasks.md`, and an
 * agent may simply write something else. Neither is prevented -
 * stopping people doing what they like is not this product's job - but
 * a plan this cannot read must say so. An empty task list rendered
 * without comment reads as "no tasks", which sends someone debugging
 * the wrong thing entirely. Every result therefore carries
 * {@link Plan.problems}, and the panel is expected to show them.
 *
 * The grammar it reads is the shared `grammar.md` in the styles folder,
 * which every phase's prompt points at - the phase that writes the plan
 * and the agent that ticks its boxes both work from that one file.
 * `instructions/tasks.md` and
 * `instructions/tasks-implement.md` restate the checkbox rules for their own
 * phase; where the two differ on the shape of a line, the grammar wins,
 * and this parser follows the grammar.
 */

/**
 * How a plan numbers its work.
 *
 * Detected rather than declared. Two real styles number two ways -
 * kiro's `1.` groups with `1.1` beneath them, Spec Kit's flat `T001`
 * under `##` phase headings - and a style already declares its grammar
 * in prose for the phase that writes the file. Asking it to restate the
 * shape in YAML for the phase that reads it would write the same pipeline
 * twice.
 *
 * Detection is reported on {@link Plan.dialect} rather than assumed
 * silently, so a document read the wrong way is visible.
 */
export type Dialect =

    /** `- [ ] 1. Group` with `- [ ] 1.1 Task` beneath it. Concurrency comes from a JSON graph. */
    | "hierarchical"

    /** `- [ ] T001 [P] Task` under `##` phases. Concurrency comes from the `[P]` marker. */
    | "flat";

export interface Task {

    /** `1`, `1.2`, `1.2.3` - any depth; `T001` in a flat plan. */
    id: string;

    title: string;

    done: boolean;

    /** `- [ ]* 1.2 ...` - skippable for a faster first pass. Hierarchical plans only. */
    optional: boolean;

    /** `- [ ] T004 [P] ...` - may run beside the other marked tasks of its phase. Flat plans only. */
    parallel: boolean;

    /** The `##` heading this task sits under, in a flat plan. */
    phase?: string;

    /**
     * A container: a task with tasks beneath it (`1` above `1.1`, `1.2`
     * above `1.2.1`). Not a unit of work - the leaves under it are what
     * an agent is handed and what a wave names. Hierarchical plans only,
     * and decided by what is under a task, not by its depth.
     */
    group: boolean;

    /** Acceptance criteria this task implements, from `[Requirements : 1.2, 3.1](requirements.md)`. */
    requirements: string[];

    /**
     * The paths this task creates or edits, from its `- Files:` detail
     * line. Empty for a task with no such line, and for `Files: none`.
     * The implement lens reads it to refuse a wave whose tasks share a
     * path before any chat opens.
     */
    files: string[];

    /** 1-based, for opening the file at that line. */
    line: number;
}

export interface Wave {

    id: number;

    /** Sub-task ids that may run at the same time. */
    tasks: string[];

    /**
     * The waves this one waits for, by id - `"after": [0, 2]`. Empty
     * means it waits for nothing: a starting point, which can be worked
     * at the same time as another starting point. Absent means the wave
     * before it.
     */
    after?: number[];
}

export interface Problem {

    /** 1-based, or 0 for something wrong with the document as a whole. */
    line: number;

    message: string;
}

export interface Plan {

    /** Which grammar this document turned out to be written in. */
    dialect: Dialect;

    tasks: Task[];

    /**
     * The concurrency plan, or `undefined` when there is none - which
     * is not an error. A style with no parallel implementation writes
     * none, and the lens then runs tasks one at a time.
     *
     * Read from the JSON graph in a hierarchical plan; **derived from
     * the `[P]` markers** in a flat one, so the lens fans out the same
     * way whichever style wrote the file.
     */
    waves?: Wave[];

    /**
     * What could not be read, and what looks wrong.
     *
     * Not fatal, by design: a plan with one malformed row is still a
     * plan, and refusing the whole document over it would strand work
     * that is otherwise fine.
     */
    problems: Problem[];
}

/**
 * The states a checkbox may carry.
 *
 * Four, not two, and the extra pair is Kiro's: its own validator accepts
 * `[ ]`, `[x]`, `[~]` and `[-]`, so a plan it wrote can carry rows a
 * two-state parser has no reading for. A row it cannot read is a row the implement
 * lens does not show, which is the worst way to meet a document from
 * another tool - the work is simply absent rather than reported.
 *
 * Only `[x]` means done. `[~]` and `[-]` are somebody's in-flight or
 * abandoned marker, and both mean *not finished* here, which is the only
 * question this file asks of the box.
 */
const STATE = "[ xX~-]";

/** `- [ ] 1. Title` / `  - [x]* 1.2 Title` / `    - [ ] 1.2.3 Title` - the hierarchical grammar, any depth. */
const TASK = new RegExp(String.raw`^(\s*)-\s\[(${STATE})\]\\?(\*?)\s+(\d+(?:\.\d+)*)\.?\s+(.*)$`);

/** `- [ ] T001 Title` / `- [x] T004 [P] Title` - the flat grammar, exactly. */
const FLAT = new RegExp(String.raw`^(\s*)-\s\[(${STATE})\]\s+(T\d+)\.?\s*(\[P\])?\s+(.*)$`);

/** A checkbox line that is not a task: wrong id, wrong spacing, a detail that grew a box. */
const LOOSE = new RegExp(String.raw`^(\s*)-\s*\[(${STATE})\]`);

/**
 * `[Requirements : 1.2, 3.1](requirements.md)` - the citation on a
 * task's last detail line.
 *
 * The href is not read here. What a plan row needs to know is *which
 * criteria* this task answers for, and the ids say that; where they
 * live is the panel's question, asked while rendering a link a reader
 * can click.
 *
 * Any id, not only numeric ones. The panel's own control resolves a
 * citation against the target document's anchors, so it insists on
 * `N.M`; this only lists what a task says it answers for, and a style
 * that numbers its requirements `FR-1` is still saying it. Being
 * stricter here would drop that list for a whole dialect and gain
 * nothing.
 */
const REQUIREMENTS = /\[[^\]\n]*:\s*([^\]\n]+?)\s*\]\([^)\s]+\.md\)/i;

/**
 * `_Requirements: 1.2, 3.1_` - the same thing, in Kiro's spelling.
 *
 * Read but never written. Kiro writes this form, so plans Kiro drafted carry
 * it, and reading it keeps their requirements links working with no import
 * step.
 */
const REQUIREMENTS_ITALIC = /_Requirements:\s*([^_\n]+)_/i;

/**
 * `- Files: \`src/a.ts\`, \`src/b.ts\`` - the paths a task touches, on
 * a detail line. Read the same way a citation is: it belongs to the
 * task above it.
 */
const FILES = /^\s*-\s*Files:\s*(.*)$/i;

const HEADING = /^##\s+(.*\S)\s*$/;

export function parsePlan(text: string): Plan {

    const lines = outsideFences(text);
    const dialect: Dialect = lines.some(line => line !== undefined && FLAT.test(line)) ? "flat" : "hierarchical";

    const tasks: Task[] = [];
    const problems: Problem[] = [];

    let phase: string | undefined;

    lines.forEach((line, index) => {

        if (line === undefined)
            return;

        const heading = HEADING.exec(line);

        if (heading) {

            phase = heading[1];
            return;
        }

        const task = dialect === "flat"
            ? flatTask(line, index, phase)
            : hierarchicalTask(line, index, problems);

        if (task)
            tasks.push(task);
        else
            reportLooseCheckbox(line, index, dialect, problems);
    });

    attachRequirements(lines, tasks);
    attachFiles(lines, tasks);
    markGroups(tasks, dialect);
    checkIds(tasks, dialect, problems);

    // A flat plan carries its concurrency inline, so there is nothing
    // to cross-check: the markers cannot name a task that is not there.
    const waves = dialect === "flat" ? deriveWaves(tasks) : readWaves(text, problems);

    if (waves && dialect === "hierarchical")
        checkWaves(waves, tasks, problems);

    if (!tasks.length)
        problems.push({
            line: 0,
            message: "No tasks found. A plan's rows are '- [ ] 1. Title' with sub-tasks as '- [ ] 1.1 Title', "
                + "or a flat '- [ ] T001 Title'."
        });

    return { dialect, tasks, waves, problems };
}

/**
 * The document's lines, with fenced ones blanked out.
 *
 * A task example inside a fence is not a task. The tasks prompt is
 * full of such examples, and parsing them would produce rows nobody wrote.
 */
function outsideFences(text: string): (string | undefined)[] {

    let fenced = false;

    return text.split(/\r?\n/).map(line => {

        if (/^\s*```/.test(line)) {

            fenced = !fenced;
            return undefined;
        }

        return fenced ? undefined : line;
    });
}

function hierarchicalTask(line: string, index: number, problems: Problem[]): Task | undefined {

    const match = TASK.exec(line);

    if (!match)
        return undefined;

    const [, indent, box, optional, id, title] = match;

    if (indent.length && !id.includes("."))
        problems.push({
            line: index + 1,
            message: `Task '${id}' is indented but has no sub-number - a top-level task starts at column 1, a sub-task is '${id}.1'.`
        });

    return {
        id,
        title: title.trim(),
        done: box.toLowerCase() === "x",
        optional: optional === "*",
        parallel: false,

        // Decided once every row is read - see `markGroups`.
        group: false,
        requirements: [],
        files: [],
        line: index + 1
    };
}

function flatTask(line: string, index: number, phase: string | undefined): Task | undefined {

    const match = FLAT.exec(line);

    if (!match)
        return undefined;

    const [, , box, id, parallel, title] = match;

    return {
        id,
        title: title.trim(),
        done: box.toLowerCase() === "x",
        optional: false,
        parallel: Boolean(parallel),
        phase,
        group: false,
        requirements: [],
        files: [],
        line: index + 1
    };
}

/**
 * Waves from `[P]`, so a flat plan fans out like a hierarchical one.
 *
 * Marked tasks run together with the marked tasks beside them in the
 * same phase; anything unmarked is a wave of its own, in place. That is
 * the marker's meaning read literally - the list stays an order, and
 * `[P]` says where the order may relax.
 */
function deriveWaves(tasks: Task[]): Wave[] | undefined {

    if (!tasks.some(task => task.parallel))
        return undefined;

    const waves: Wave[] = [];
    let run: Task[] = [];

    const flush = () => {

        if (run.length)
            waves.push({ id: waves.length, tasks: run.map(task => task.id) });

        run = [];
    };

    for (const task of tasks) {

        if (!task.parallel) {

            flush();
            waves.push({ id: waves.length, tasks: [task.id] });
            continue;
        }

        if (run.length && run[0].phase !== task.phase)
            flush();

        run.push(task);
    }

    flush();

    return waves;
}

/**
 * A checkbox the grammar did not match.
 *
 * Worth a word rather than silence: the two ways to write a phantom
 * row - a detail line that grew a box, and a sub-task numbered `1.1.1` -
 * both vanish from the lens without one, and the author sees a plan
 * that is simply missing a task they wrote.
 */
function reportLooseCheckbox(line: string, index: number, dialect: Dialect, problems: Problem[]): void {

    if (!LOOSE.test(line))
        return;

    problems.push({
        line: index + 1,
        message: dialect === "flat"
            ? "This line has a checkbox but no 'T' id, so nothing can tick it. Details never carry a checkbox - use '- text'."
            : "This line has a checkbox but no task number, so nothing can tick it. Details never carry a checkbox - use '- text'."
    });
}

/**
 * Which tasks are containers: any task with a task under it, at any
 * depth. `1` above `1.1` is one, and so is `1.2` above `1.2.1` - a
 * group is a fact about what sits beneath a row, never about how deep
 * the row is. A flat plan has none; its phases are headings.
 */
function markGroups(tasks: Task[], dialect: Dialect): void {

    if (dialect === "flat")
        return;

    const ids = new Set(tasks.map(task => task.id));

    for (const task of tasks)
        task.group = [...ids].some(id => id.startsWith(`${task.id}.`));
}

/** A citation belongs to the task above it. */
function attachRequirements(lines: (string | undefined)[], tasks: Task[]): void {

    for (const [index, line] of lines.entries()) {

        // Either spelling. A plan can carry both at once - a
        // document revised by hand - and each line answers for itself.
        const match = line === undefined
            ? null
            : REQUIREMENTS.exec(line) ?? REQUIREMENTS_ITALIC.exec(line);

        if (!match)
            continue;

        const owner = [...tasks].reverse().find(task => task.line <= index + 1);

        if (owner)
            owner.requirements.push(...match[1].split(",").map(one => one.trim()).filter(Boolean));
    }
}

/**
 * The `Files:` line of each task, attached to the task above it.
 *
 * Paths are what sits in backticks; anything outside them is prose
 * ("none", "unsure - probably"). Normalised to forward slashes, so a
 * path written two ways in two tasks still counts as the same file.
 */
function attachFiles(lines: (string | undefined)[], tasks: Task[]): void {

    for (const [index, line] of lines.entries()) {

        const match = line === undefined ? null : FILES.exec(line);

        if (!match)
            continue;

        const owner = [...tasks].reverse().find(task => task.line <= index + 1);

        if (owner)
            owner.files.push(...[...match[1].matchAll(/`([^`]+)`/g)]
                .map(one => one[1].trim().replace(/\\/g, "/"))
                .filter(Boolean));
    }
}

/**
 * The last fenced `json` block, read as the dependency graph.
 *
 * Absent is fine and common. Present but unreadable is not: the lens
 * fans out sub-agents from this, so a graph nobody can parse must not
 * be quietly treated as no graph at all - that turns an intended
 * parallel run into a silent sequential one.
 */
function readWaves(text: string, problems: Problem[]): Wave[] | undefined {

    const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];

    if (!blocks.length)
        return undefined;

    const block = blocks[blocks.length - 1];
    const line = text.slice(0, block.index).split(/\r?\n/).length;

    let parsed: any;

    try {

        parsed = JSON.parse(block[1]);

    } catch (error) {

        problems.push({ line, message: `The dependency graph is not valid JSON: ${(error as Error).message}` });
        return undefined;
    }

    if (!parsed || !Array.isArray(parsed.waves)) {

        problems.push({ line, message: "The dependency graph has no 'waves' array, so no tasks can run in parallel." });
        return undefined;
    }

    return parsed.waves.map((wave: any, index: number) => {

        const id = typeof wave?.id === "number" ? wave.id : index;

        const read: Wave = {
            id,
            tasks: Array.isArray(wave?.tasks) ? wave.tasks.filter((one: unknown) => typeof one === "string") : []
        };

        if (wave?.after === undefined)
            return read;

        // Not a list of numbers: said, and read as no `after` at all -
        // the wave before it - which is the plain plan order, so
        // nothing starts earlier than that order allows.
        if (!Array.isArray(wave.after) || wave.after.some((one: unknown) => typeof one !== "number")) {

            problems.push({ line, message: `Wave ${id} has an 'after' that is not a list of wave numbers, so it waits for the wave before it.` });

            return read;
        }

        return { ...read, after: wave.after };
    });
}

function checkIds(tasks: Task[], dialect: Dialect, problems: Problem[]): void {

    const seen = new Map<string, number>();

    for (const task of tasks) {

        const first = seen.get(task.id);

        if (first !== undefined)
            problems.push({
                line: task.line,
                message: `Task '${task.id}' is numbered the same as the one on line ${first}. Ids are how a task is named, ticked, and put in a wave.`
            });

        seen.set(task.id, task.line);
    }

    // A flat plan has no groups to belong to - `##` phases do that job,
    // and a task under no heading is untidy rather than broken.
    if (dialect === "flat")
        return;

    // Every dotted id has a parent: `1.2.3` needs `1.2`, which needs `1`.
    // A missing one is a task nothing contains - the lens would show it
    // nowhere.
    for (const task of tasks) {

        if (!task.id.includes("."))
            continue;

        const parent = task.id.split(".").slice(0, -1).join(".");

        if (!tasks.some(candidate => candidate.id === parent))
            problems.push({
                line: task.line,
                message: `Task '${task.id}' has no task '${parent}' above it to belong to.`
            });
    }
}

/**
 * The graph against the list.
 *
 * A wave naming a task that does not exist is a task that never runs,
 * and a sub-task in no wave is one the lens will not reach - both
 * silent, both worth saying out loud.
 *
 * Whether two tasks in one wave truly touch disjoint files is not
 * checked here and cannot be: that is a claim about the code the tasks
 * will write. It belongs to the prompts, which have the task text.
 */
function checkWaves(waves: Wave[], tasks: Task[], problems: Problem[]): void {

    const real = new Set(tasks.filter(task => !task.group).map(task => task.id));
    const scheduled = new Set(waves.flatMap(wave => wave.tasks));

    for (const wave of waves)
        for (const id of wave.tasks) {

            if (real.has(id))
                continue;

            const group = tasks.find(task => task.id === id && task.group);

            problems.push({
                line: 0,
                message: group
                    ? `Wave ${wave.id} names '${id}', which is a group rather than a task. `
                    + "A group is not in any wave; the tasks under it are."
                    : `Wave ${wave.id} names '${id}', which is not a task in this plan - it would never run.`
            });
        }

    // `after` names waves by id. Only a smaller id is allowed: the waves
    // then always have an order to be worked in, and a loop - two waves
    // each waiting for the other, which would never start - cannot be
    // written at all.
    const ids = new Set(waves.map(wave => wave.id));

    for (const wave of waves)
        for (const needed of wave.after ?? []) {

            if (!ids.has(needed))
                problems.push({
                    line: 0,
                    message: `Wave ${wave.id} waits for wave ${needed}, which is not in the graph - that part of the wait is ignored.`
                });
            else if (needed >= wave.id)
                problems.push({
                    line: 0,
                    message: `Wave ${wave.id} waits for wave ${needed}. A wave can only wait for a wave with a smaller number - that part of the wait is ignored.`
                });
        }

    const missing = [...real].filter(id => !scheduled.has(id));

    if (missing.length)
        problems.push({
            line: 0,
            message: `${missing.length === 1 ? "Task" : "Tasks"} ${missing.map(id => `'${id}'`).join(", ")} `
                + `${missing.length === 1 ? "is" : "are"} in no wave, so the plan never reaches ${missing.length === 1 ? "it" : "them"}.`
        });
}


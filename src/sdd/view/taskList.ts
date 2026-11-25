/**
 * The implement lens's reading of `tasks.md` - checkbox lines as task
 * rows nested as deep as the plan nests them (`4`, `4.1`, `4.1.3`),
 * done-state from `[x]`, and the wave each task belongs to.
 *
 * One rule replaces "task and sub-task": a row with rows under it is a
 * group, a row with none is a unit of work. Depth is never the point.
 *
 * A reading, not a format: the file stays plain markdown, the
 * checkboxes stay the single source of completion truth, and
 * anything this parser does not recognise is not a task row - never an
 * error.
 */

import type { TaskRun } from "../../shared/taskRun";

export interface SpecTask {

    /** The task's own number as written - "3", "3.1", "3.1.2" - any depth. */
    id: string;

    text: string;

    done: boolean;

    /** Written `- [ ]* 3.1` - skippable for a faster first cut. */
    optional: boolean;

    /**
     * The line the row sits on, 1-based, in the text that was parsed -
     * what the rendered document's own controls key on.
     */
    line: number;

    /** The `## ` heading the row sits under, when there is one - a story, a phase. */
    group?: string;

    /** The paths the task touches, from its `- Files:` detail line. */
    files: string[];

    /**
     * How the task is done when not by an agent - its `- Run:` detail
     * line. Absent on an ordinary task, which is an agent's to do.
     */
    run?: TaskRun;

    /**
     * Everything written under the row that is not a task of its own -
     * the detail lines, as markdown, with the row's own indent taken
     * off so they render as the list they are. What the lens shows when
     * a row is opened; the row itself shows only the title.
     */
    details: string[];

    subtasks: SpecTask[];

    /** The row's own leading whitespace - what its detail lines are measured against. */
    indent: string;
}

export type { TaskRun };

/** One entry of the plan's `## Task Dependency Graph` - tasks that may run at the same time. */
export interface TaskWave {

    id: number;

    /** Task ids as written in the plan - "1.1", "3.2". */
    tasks: string[];

    /** The waves this one waits for; empty is a starting point, absent is the wave before it. See the engine's `Wave`. */
    after?: number[];
}

/**
 * `- [ ] 1. Title`, `  - [x] 1.1 Title`, `- [ ]* 5.5 Optional title`.
 *
 * The optional marker sits between the bracket and the space, so it is
 * matched here: demanding `\s+` straight after `]` would drop every
 * optional task's row.
 */
const CHECKBOX = /^(\s*)-\s+\[([ xX])\](\*?)\s+(.*\S)\s*$/;

/**
 * "1. Build the thing" / "2.1 Sub-thing" / "2.1.4 Deeper" - the leading
 * number, when there is one. Spec Kit's flat "T001 ..." ids count too,
 * the way the engine's `parsePlan` reads them.
 */
const NUMBERED = /^(\d+(?:\.\d+)*|T\d+)[.)]?\s+(.*)$/;

/** `- Files: `src/a.ts`, `src/b.ts`` - a detail line under a task, the same shape the engine's parser reads. */
const FILES = /^\s*-\s*Files:\s*(.*)$/i;

/** `- Run: ...` - a detail line under a task. */
const RUN = /^\s*-\s*Run:\s*(.*?)\s*$/i;

const HEADING = /^##\s+(.*\S)\s*$/;

export function parseTasks(content: string | undefined): SpecTask[] {

    if (!content)
        return [];

    const tasks: SpecTask[] = [];

    // The row a detail line belongs to: the last one read, at any depth.
    let current: SpecTask | undefined;

    // The open rows above the one being read, outermost first - where
    // a new row is filed. A numbered row's depth is its dots; an
    // unnumbered row's is how many open rows sit less indented than it.
    const open: { task: SpecTask; indent: number }[] = [];

    let group: string | undefined;

    content.split(/\r?\n/).forEach((line, index) => {

        const heading = HEADING.exec(line);

        if (heading) {

            group = heading[1];
            current = undefined;
            open.length = 0;

            return;
        }

        const checkbox = CHECKBOX.exec(line);

        if (!checkbox) {

            // A detail line is read only straight under a task row -
            // the same rule the engine's parser applies to `Files:`.
            if (!current)
                return;

            // Kept whole, minus the indent of the row's own text - its
            // indent plus the `- ` - so the details read as a list of
            // their own. A blank line is kept too, so a paragraph under
            // a task stays a paragraph.
            if (line.trim() || current.details.length) {

                const under = current.indent + "  ";

                current.details.push(line.startsWith(under)
                    ? line.slice(under.length)
                    : line.startsWith(current.indent) ? line.slice(current.indent.length) : line.trimStart());
            }

            const files = FILES.exec(line);

            if (files)
                current.files = parseFiles(files[1]);

            const run = RUN.exec(line);

            if (run)
                current.run = parseRun(run[1]);

            return;
        }

        const [, indent, mark, optional, rest] = checkbox;

        const numbered = NUMBERED.exec(rest);

        const id = numbered?.[1] ?? "";
        const text = numbered?.[2] ?? rest;
        const done = mark !== " ";

        const task: SpecTask = { id, text, done, optional: optional === "*", line: index + 1, group, files: [], details: [], subtasks: [], indent };

        // Where it goes: by its number when it has one ("3.1.2" is two
        // deep), else by indentation under the rows above it - both
        // spellings appear in real plans. Deeper than the rows open
        // allow is clamped to the deepest open row: an orphan is filed
        // under what is there rather than dropped.
        const depth = numbered
            ? Math.min(id.split(".").length - 1, open.length)
            : open.filter(one => one.indent < indent.length).length;

        open.length = depth;

        const parent = open[depth - 1]?.task;

        if (parent)
            parent.subtasks.push(task);
        else
            tasks.push(task);

        open.push({ task, indent: indent.length });

        current = task;
    });

    for (const one of allTasks(tasks))
        while (one.details.length && !one.details[one.details.length - 1].trim())
            one.details.pop();

    return tasks;
}

/**
 * The paths on a `Files:` line: only what sits in backticks, the same
 * rule the engine's parser applies, so `- Files: none` is no files and
 * a stray word is prose rather than a path. Backslashes read as
 * forward slashes.
 */
function parseFiles(value: string): string[] {

    return [...value.matchAll(/`([^`]+)`/g)]
        .map(one => one[1].trim().replace(/\\/g, "/"))
        .filter(Boolean);
}

/** A `Run:` line's value, by its shape - see {@link TaskRun}. Empty reads as by hand. */
export function parseRun(value: string): TaskRun {

    const text = value.trim();

    if (!text || /^by hand$/i.test(text))
        return { kind: "manual" };

    const command = /^`(.+)`$/.exec(text);

    if (command)
        return { kind: "command", command: command[1].trim() };

    const [name] = text.split(/\s+/, 1);

    const args: Record<string, string> = {};

    // `key=value` or `key="a value with spaces"`. A word with no `=` is
    // not an arg; it is left alone rather than guessed at, and the
    // workflow asks for what it still lacks.
    for (const [, key, quoted, bare] of text.slice(name.length).matchAll(/([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|(\S+))/g))
        args[key] = quoted ?? bare;

    return { kind: "workflow", name, args };
}

/** An agent's task: one with no `Run:` line. What Start and a ▶ chat hand over. */
export function isAgentTask(task: Pick<SpecTask, "run">): boolean {

    return task.run === undefined;
}

/** The repositories a task touches: the first segment of every `Files:` path, once each. */
export function reposOf(files: readonly string[]): string[] {

    return [...new Set(files.map(file => file.split("/")[0]).filter(Boolean))];
}

/**
 * The text with one checkbox flipped - `[ ]` to `[x]`, `[x]` or
 * `[X]` to `[ ]` - on the given 1-based line. The only thing this
 * product ever writes into a plan on its own: a person's click on a
 * box. Any other line, or a line that is not a checkbox row, comes back
 * unchanged.
 */
export function toggleCheckbox(content: string, line: number): string {

    const lines = content.split(/\r?\n/);

    const text = lines[line - 1];

    if (text === undefined || !CHECKBOX.test(text))
        return content;

    lines[line - 1] = text.replace(/\[([ xX])\]/, (_, mark) => mark === " " ? "[x]" : "[ ]");

    // Rejoined with the line ending the file used, so a CRLF plan does
    // not come back LF.
    return lines.join(content.includes("\r\n") ? "\r\n" : "\n");
}

/** The plan's `## Task Dependency Graph` heading and the json fence under it. */
const GRAPH = /^##\s+task dependency graph\s*$/i;

/**
 * The waves declared at the end of the plan - which tasks may be worked
 * at the same time.
 *
 * Forgiving on purpose: no graph, invalid JSON, or a shape that is not
 * `{ waves: [...] }` all return no waves, and the implement lens falls
 * back to document order. A malformed graph must never cost someone
 * their task rows.
 */
export function parseWaves(content: string | undefined): TaskWave[] {

    if (!content)
        return [];

    const lines = content.split(/\r?\n/);

    const heading = lines.findIndex(line => GRAPH.test(line.trim()));

    if (heading < 0)
        return [];

    const open = lines.findIndex((line, index) => index > heading && /^```/.test(line.trim()));

    if (open < 0)
        return [];

    const close = lines.findIndex((line, index) => index > open && /^```\s*$/.test(line.trim()));

    if (close < 0)
        return [];

    try {

        const parsed = JSON.parse(lines.slice(open + 1, close).join("\n")) as { waves?: unknown };

        if (!Array.isArray(parsed?.waves))
            return [];

        return parsed.waves
            .filter((wave): wave is TaskWave =>
                typeof (wave as TaskWave)?.id === "number" && Array.isArray((wave as TaskWave)?.tasks))
            .map(wave => {

                const after = (wave as { after?: unknown }).after;

                // Read only when it is a list of numbers, the same rule
                // the engine's parser applies - anything else is the
                // wave before it, and the engine reports it.
                return Array.isArray(after) && after.every(one => typeof one === "number")
                    ? { id: wave.id, tasks: wave.tasks.map(String), after: after as number[] }
                    : { id: wave.id, tasks: wave.tasks.map(String) };
            })
            .sort((left, right) => left.id - right.id);

    } catch {

        return [];
    }
}

/** The wave a task id belongs to, or undefined - a group header belongs to none. */
export function waveOf(id: string, waves: TaskWave[]): number | undefined {

    return waves.find(wave => wave.tasks.includes(id))?.id;
}

/** Every row, groups and units alike, in document order, any depth. */
export function allTasks(tasks: readonly SpecTask[]): SpecTask[] {

    return tasks.flatMap(task => [task, ...allTasks(task.subtasks)]);
}

/** Done means the box is ticked - and a group is done only when everything under it is, all the way down. */
export function isTaskDone(task: SpecTask): boolean {

    return task.done && task.subtasks.every(isTaskDone);
}

/** The next task the Start-all queue would launch - the first not-done top-level task. */
export function nextTask(tasks: SpecTask[]): SpecTask | undefined {

    return tasks.find(task => !isTaskDone(task));
}

/**
 * The units of work, done or not, in document order: the leaves.
 *
 * A row with rows under it is a group and contributes what is under
 * it, all the way down; a row with none is its own unit. The leaf is
 * what an agent is handed, what the dependency graph names, and what a
 * row's ▶ starts. A group is a container, never a unit - the tasks
 * phase says the same in its own words.
 */
export function workUnits(tasks: readonly SpecTask[]): SpecTask[] {

    return tasks.flatMap(task => task.subtasks.length ? workUnits(task.subtasks) : [task]);
}

/** The units still to do - what Start hands over and what the counts are about. */
export function pendingWork(tasks: SpecTask[]): SpecTask[] {

    return workUnits(tasks).filter(unit => !isTaskDone(unit));
}

/**
 * The work still to do under one group - what the group row's ▶ hands
 * over. Leaves at any depth, in document order, skipping the ticked
 * ones. `Run:` tasks included: the host runs them in their place in
 * the plan - the terminal, the workflow, or a wait for a person's tick.
 */
export function pendingUnder(group: SpecTask): SpecTask[] {

    return pendingWork(group.subtasks);
}

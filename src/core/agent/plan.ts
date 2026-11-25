import type { PlanStep } from "../models/run";

/*
 * The agent's plan - its to-do list for the work it is doing - from what
 * each runtime sends, as one shape: a list of steps, each pending, in
 * progress or done. The chat draws the newest plan in a strip above the
 * compose box.
 *
 * 1. ACP runtimes (claude-agent-acp, Copilot CLI) send the whole plan
 *    each time it changes, as a `plan` session update.
 * 2. The Claude runtime (SDK) sends no plan. Its to-do tools carry one:
 *    `TodoWrite` hands over the whole list each time; the newer
 *    `TaskCreate`, `TaskUpdate` and `TaskList` change one task at a time,
 *    so the list is kept here and built up from them - see
 *    {@link TaskBoard}.
 * 3. The Copilot runtime (SDK) sends no plan either. It keeps its to-do
 *    list in a `todos` table in its session database and says when the
 *    table changed (`session.todos_changed`), so the table is read then -
 *    see {@link planFromCopilotTodos}. Its `update_todo` tool carries a
 *    Markdown checklist instead - see {@link planFromTodoChecklist}.
 *
 * No file system here: the chat screen reads these too.
 */

const STATUSES = new Set<PlanStep["status"]>(["pending", "in_progress", "completed"]);

/** A status as sent, or pending for anything this does not know. */
function statusOf(value: unknown): PlanStep["status"] {

    return typeof value === "string" && STATUSES.has(value as PlanStep["status"]) ? value as PlanStep["status"] : "pending";
}

/** The text of a field, trimmed, or empty. */
function textOf(value: unknown): string {

    return typeof value === "string" ? value.trim() : "";
}

/** A step for the text, or nothing when there is no text. */
function step(text: string, status: unknown): PlanStep[] {

    return text ? [{ text, status: statusOf(status) }] : [];
}

/** ACP's `plan` update entries: `{ content, status, priority }`. */
export function planFromAcp(entries: unknown): PlanStep[] {

    if (!Array.isArray(entries))
        return [];

    return entries.flatMap(entry => {

        const one = entry as { content?: unknown; status?: unknown } | null;

        return step(textOf(one?.content), one?.status);
    });
}

/**
 * Claude's `TodoWrite` input: `{ todos: [{ content, status, activeForm }] }`.
 * A step in progress is worded the way the agent words it while doing it
 * ("Running the tests"), when it gave that.
 */
export function planFromTodos(input: unknown): PlanStep[] | undefined {

    const todos = (input as { todos?: unknown } | null)?.todos;

    if (!Array.isArray(todos))
        return undefined;

    return todos.flatMap(todo => {

        const one = todo as { content?: unknown; status?: unknown; activeForm?: unknown } | null;

        const doing = statusOf(one?.status) === "in_progress" ? textOf(one?.activeForm) : "";

        return step(doing || textOf(one?.content), one?.status);
    });
}

/**
 * Copilot's to-do rows, as `session.plan.readSqlTodos()` returns them:
 * `{ title, status }`, the status one of pending, in_progress, done and
 * blocked. `done` is completed. Blocked has no mark of its own here and
 * reads as pending - what Copilot CLI's own ACP plan does with it.
 */
export function planFromCopilotTodos(rows: unknown): PlanStep[] {

    if (!Array.isArray(rows))
        return [];

    return rows.flatMap(row => {

        const one = row as { title?: unknown; status?: unknown } | null;

        const status = one?.status === "done" ? "completed" : one?.status === "in_progress" ? "in_progress" : "pending";

        return step(textOf(one?.title), status);
    });
}

/**
 * One item of an `update_todo` checklist: a list marker, a box, the text.
 * The CLI's own pattern (Copilot 1.0.80).
 */
const CHECKLIST_ITEM = /^\s*(?:[-*+]|[0-9]+[.)])[ \t]*\[([ xX\-~/])\][ \t]*(.*)$/;

/**
 * Copilot's `update_todo` input: `{ todos }`, a Markdown checklist with
 * one item per line ("- [ ] Write the tests", "- [x] Read the code").
 * Lines that are not items are skipped. The tool tells the model only
 * about `[ ]` and `[x]`; the CLI also takes `[-]`, `[~]` and `[/]`, which
 * are read here as in progress.
 */
export function planFromTodoChecklist(input: unknown): PlanStep[] | undefined {

    const todos = (input as { todos?: unknown } | null)?.todos;

    if (typeof todos !== "string")
        return undefined;

    return todos.split(/\r?\n/).flatMap(line => {

        const item = CHECKLIST_ITEM.exec(line);

        if (!item)
            return [];

        const status = item[1] === " " ? "pending" : item[1].toLowerCase() === "x" ? "completed" : "in_progress";

        return step(textOf(item[2]), status);
    });
}

/** Copilot's checklist to-do tool - see {@link planFromTodoChecklist}. */
export const COPILOT_TODO_TOOL = "update_todo";

/** Claude's to-do tools. Their calls are not drawn as tool calls: the plan strip shows what they did. */
const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);

export function isPlanTool(name: string): boolean {

    return PLAN_TOOLS.has(name);
}

/** One line for the log: how far the plan is, then each step with its mark. */
export function planText(steps: readonly PlanStep[]): string {

    if (!steps.length)
        return "Plan cleared.";

    const done = steps.filter(one => one.status === "completed").length;

    const marks = { completed: "[x]", in_progress: "[>]", pending: "[ ]" } as const;

    return `Plan: ${done} of ${steps.length} done.\n` + steps.map(one => `${marks[one.status]} ${one.text}`).join("\n");
}

/** The text blocks of a tool result, which comes as a string or a list of blocks. */
function resultTexts(content: unknown): string[] {

    if (typeof content === "string")
        return [content];

    if (!Array.isArray(content))
        return [];

    return content.flatMap(block => {

        const one = block as { type?: unknown; text?: unknown } | null;

        return one?.type === "text" && typeof one.text === "string" ? [one.text] : [];
    });
}

/** The first text block that is JSON, read. */
function resultJson(content: unknown): unknown {

    if (content && typeof content === "object" && !Array.isArray(content))
        return content;

    for (const text of resultTexts(content)) {

        try {

            return JSON.parse(text);

        } catch {

            // Plain words - read by the caller's own pattern.
        }
    }

    return undefined;
}

interface Task {
    subject: string;
    status: PlanStep["status"];
    activeForm?: string;
}

/**
 * The tasks Claude's `TaskCreate`, `TaskUpdate` and `TaskList` tools
 * built up in one session, in the order they were made.
 *
 * Each `apply` takes a finished call - its input and what the tool gave
 * back - and says whether the list changed. A call that failed changes
 * nothing.
 */
export class TaskBoard {

    private readonly tasks = new Map<string, Task>();

    /** The plan as it stands. */
    public steps(): PlanStep[] {

        return [...this.tasks.values()].flatMap(task => {

            const doing = task.status === "in_progress" ? task.activeForm ?? "" : "";

            return step(doing || task.subject, task.status);
        });
    }

    /** One finished call. True when the list changed. */
    public apply(tool: string, input: unknown, result: unknown): boolean {

        const given = (input ?? {}) as Record<string, unknown>;

        if (tool === "TaskCreate")
            return this.created(given, result);

        if (tool === "TaskUpdate")
            return this.updated(given, result);

        if (tool === "TaskList")
            return this.listed(result);

        return false;
    }

    /** The new task's id is in the result: `{ task: { id } }`, or "Task #3 created successfully: ...". */
    private created(input: Record<string, unknown>, result: unknown): boolean {

        const parsed = resultJson(result) as { task?: { id?: unknown } } | undefined;

        let id = typeof parsed?.task?.id === "string" ? parsed.task.id : undefined;

        for (const text of id ? [] : resultTexts(result))
            id ??= /^Task #(\S+) created/.exec(text.trim())?.[1];

        const subject = textOf(input.subject);

        if (!id || !subject)
            return false;

        this.tasks.set(id, { subject, status: "pending", ...(textOf(input.activeForm) ? { activeForm: textOf(input.activeForm) } : {}) });

        return true;
    }

    private updated(input: Record<string, unknown>, result: unknown): boolean {

        const id = textOf(input.taskId);

        if (!id)
            return false;

        // The tool said no: `{ success: false }`, or "Task #3 not found".
        if ((resultJson(result) as { success?: unknown } | undefined)?.success === false
            || resultTexts(result).some(text => /^Task #\S+ not found$|^Failed to delete task$/.test(text.trim())))
            return false;

        if (input.status === "deleted")
            return this.tasks.delete(id);

        const kept = this.tasks.get(id);

        const subject = textOf(input.subject) || kept?.subject;

        // A task never seen, with no name given: nothing to show for it.
        if (!subject)
            return false;

        const activeForm = textOf(input.activeForm) || kept?.activeForm;

        this.tasks.set(id, {
            subject,
            status: input.status === undefined ? kept?.status ?? "pending" : statusOf(input.status),
            ...(activeForm ? { activeForm } : {})
        });

        return true;
    }

    /** The whole list, as the tool lists it: `{ tasks: [...] }`, or lines like "#1 [pending] Write the tests". */
    private listed(result: unknown): boolean {

        const parsed = resultJson(result) as { tasks?: unknown } | undefined;

        let listed: { id: string; subject: string; status: PlanStep["status"] }[] | undefined;

        if (Array.isArray(parsed?.tasks))
            listed = parsed.tasks.flatMap(task => {

                const one = task as { id?: unknown; subject?: unknown; status?: unknown } | null;

                return typeof one?.id === "string" && textOf(one.subject)
                    ? [{ id: one.id, subject: textOf(one.subject), status: statusOf(one.status) }]
                    : [];
            });

        else
            for (const text of resultTexts(result)) {

                if (text.trim() === "No tasks found") {

                    listed = [];

                    break;
                }

                const lines = text.trim().split("\n").map(line => /^#(\S+) \[(pending|in_progress|completed)\] (.+?)(?: \([^()]*\))?(?: \[blocked by [^\]]*\])?$/.exec(line.trim()));

                if (lines.length && lines.every(Boolean)) {

                    listed = lines.map(match => ({ id: match![1], subject: match![3], status: statusOf(match![2]) }));

                    break;
                }
            }

        if (!listed)
            return false;

        const before = new Map(this.tasks);

        this.tasks.clear();

        for (const task of listed) {

            const activeForm = before.get(task.id)?.activeForm;

            this.tasks.set(task.id, { subject: task.subject, status: task.status, ...(activeForm ? { activeForm } : {}) });
        }

        return true;
    }
}

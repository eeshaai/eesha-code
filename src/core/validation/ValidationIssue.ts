export interface ValidationIssue {

    /** The task (tasks.yml) or job (workflow file) this applies to, so it can be surfaced against that row's own log. */
    ownerId: string;

    message: string;

    severity: "warning" | "error";

    /**
     * The walker's id for the task this is about, when it is about one.
     * The same id the map draws from, so a problem can be shown on the
     * task itself.
     */
    taskId?: string;
}

/**
 * A problem the UI marks a task with.
 *
 * Validation is advisory. It does not stop a run or pre-empt a task: a
 * task whose plugin is missing already fails when it runs, and the
 * engine skips what depended on it. It only lets the problem be seen
 * before clicking Run.
 */
export interface TaskProblem {

    message: string;

    severity: "warning" | "error";
}

/** Every issue that names a task, keyed by that task's id. */
export function problemsByTask(issues: readonly ValidationIssue[]): Record<string, TaskProblem> {

    const problems: Record<string, TaskProblem> = {};

    for (const issue of issues)
        if (issue.taskId && !problems[issue.taskId])
            problems[issue.taskId] = { message: issue.message, severity: issue.severity };

    return problems;
}

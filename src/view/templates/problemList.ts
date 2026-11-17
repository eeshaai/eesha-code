import { ValidationIssue } from "../../core/validation/ValidationIssue";
import { RunGraph } from "../runGraph";

/**
 * Reading a list of validation issues for display.
 *
 * Pure and separate from the JSX so it can be tested - this layer has
 * no DOM test setup.
 */

/**
 * The worst severity present.
 *
 * The tab's count is coloured by this rather than by how many there
 * are: one error under nine warnings is still an error.
 */
export function worst(problems: readonly ValidationIssue[]): "error" | "warning" {

    return problems.some(problem => problem.severity === "error") ? "error" : "warning";
}

/** A task and the job holding it - both halves of what selecting a station takes. */
export interface Station {

    name: string;

    /** Logs are keyed by job with the task's index on each line, so the task id alone cannot open one. */
    jobId: string;
}

/**
 * Where a task id sits in the graph, if it sits anywhere.
 *
 * Undefined is a real answer: an issue can name a task id the current
 * graph has no station for (a definition edited since the run, or an
 * issue about the file itself). The row still shows; it just does not
 * link anywhere.
 */
export function stationOf(graph: RunGraph, taskId: string | undefined): Station | undefined {

    if (taskId === undefined)
        return undefined;

    for (const stage of graph.stages)
        for (const job of stage.jobs)
            for (const task of job.tasks)
                if (task.id === taskId)
                    return { name: task.name, jobId: job.id };

    return undefined;
}

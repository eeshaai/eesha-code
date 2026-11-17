import { RunSummary } from "../../shared/runMessages";

/**
 * How a recorded run reads in the runs landing. Kept apart from the
 * component, like `problemList.ts`, so the rules can be tested.
 */

/**
 * What to call a run in the list.
 *
 * Its resolved `label:` when the file declared one - `AB#48120`, not
 * "release pipeline" fifteen times over. Otherwise the workflow's name,
 * the same fallback the store's `titleOf` uses.
 */
export function runTitle(run: RunSummary, workflowName: string): string {

    return run.label?.trim() || workflowName;
}

/**
 * How long the run took.
 *
 * Undefined while it is still going, and for a run lost to a crash -
 * counting from its start to now would show a duration that grows
 * forever.
 */
export function runDuration(run: RunSummary): string | undefined {

    if (run.finishedAt === undefined)
        return undefined;

    return elapsedText(run.finishedAt - run.startedAt);
}

/**
 * A span of time as a person reads it: seconds under a minute, minutes
 * and seconds under an hour, hours and minutes past that. Negative
 * spans read as zero. Shared with the chat's status line, which counts
 * a turn up with the same words the run list uses to sum it.
 */
export function elapsedText(ms: number): string {

    const seconds = Math.max(0, Math.round(ms / 1000));

    if (seconds < 60)
        return `${seconds}s`;

    const minutes = Math.floor(seconds / 60);

    if (minutes < 60)
        return `${minutes}m ${seconds % 60}s`;

    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}



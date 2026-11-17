/**
 * How a run is written down in a list - the two pieces of text every
 * surface that shows one needs: what to call it, and how long ago it
 * started.
 */

/**
 * What to show a run as: its own `label:`, or the workflow's name from
 * the snapshot it froze at start.
 */
export function nameOfRun(run: { label?: string; workflowSnapshot: string; filePath: string }): string {

    if (run.label)
        return run.label;

    try {

        return (JSON.parse(run.workflowSnapshot) as { name?: string }).name || run.filePath;

    } catch {

        return run.filePath;
    }
}

/** How long ago, with minute detail - "5m ago", "3h ago", "2d ago" - for pick lists. */
export function runAgeAgo(startedAt: number): string {

    const minutes = Math.floor((Date.now() - startedAt) / 60_000);

    if (minutes < 1)
        return "just now";

    if (minutes < 60)
        return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);

    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

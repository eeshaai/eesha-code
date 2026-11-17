import { RunStatus } from "../../core/models/run";
import type { IconName } from "../ui";

/**
 * The one mapping from a status to its icon and CSS suffix, shared by
 * every surface that draws a status - see `StatusIcon` in ui.tsx.
 */

export function statusClass(status: RunStatus): string {

    switch (status) {

        case RunStatus.Running: return "running";
        case RunStatus.Success: return "success";
        case RunStatus.Failed: return "failed";
        case RunStatus.Skipped: return "skipped";
        case RunStatus.Waiting: return "waiting";
        case RunStatus.Cancelled: return "cancelled";
        default: return "pending";
    }
}

/** The icon for a status. */
export function statusIcon(status: RunStatus): IconName {

    switch (status) {

        case RunStatus.Running: return "running";
        case RunStatus.Success: return "passed";
        case RunStatus.Failed: return "failed";
        case RunStatus.Skipped: return "skipped";
        case RunStatus.Waiting: return "waiting";
        case RunStatus.Cancelled: return "cancelled";
        default: return "not-run";
    }
}

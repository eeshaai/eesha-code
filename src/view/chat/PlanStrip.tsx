import type { PlanStep } from "../../core/models/run";
import type { LogEntry } from "../templates/logEntry";

/*
 * The agent's plan is drawn by the library's PlanStrip. This file only
 * finds which plan to show. The newest plan the main agent sent is the
 * one shown; a reopened chat shows its last one.
 */

/** The newest plan in the lines, or nothing. A sub-agent's own list is not the chat's plan. */
export function latestPlan(entries: readonly LogEntry[]): PlanStep[] | undefined {

    for (let index = entries.length - 1; index >= 0; index--) {

        const entry = entries[index];

        if (entry.plan && !entry.agent)
            return entry.plan.length ? entry.plan : undefined;
    }

    return undefined;
}

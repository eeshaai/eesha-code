import * as path from "path";

import { EVENTS_SUBDIR } from "../loader/constants";
import { profileDirectory } from "../loader/profilePaths";
import { workspaceFolderName } from "../store/databaseLocation";

/**
 * Where a run's events file lives.
 *
 * The path is computed from the workspace and either the spec's folder
 * name or the run's id and start time. It is never stored, because a
 * stored copy would go stale on a rename - the same reason `runIdFor`
 * computes a spec's run id.
 *
 * A workflow or task run gets one file, named so the directory sorts
 * into time order. A spec gets one file for its whole life, which keeps
 * growing and is never pruned.
 */

/** `2026-09-05T20-14-03` - sortable, and legal as a filename on Windows, where `:` is not. */
export function stamp(at: number): string {

    const pad = (value: number) => String(value).padStart(2, "0");

    const when = new Date(at);

    return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
        + `T${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
}

/**
 * Anything that is not safe in a filename, folded to `-`.
 *
 * A spec's folder name is already legal on disk, but a name with a
 * separator in it would write outside the events folder.
 */
function safe(name: string): string {

    return name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") || "unnamed";
}

/** `~/.eesha/events/<workspace>` - everything below is under here. */
export function eventsRoot(workspacePath: string | undefined): string {

    return path.join(profileDirectory(), EVENTS_SUBDIR, workspaceFolderName(workspacePath));
}

/**
 * The file holding one spec's whole history - every phase, every
 * revise, from the first draft onwards.
 */
export function specEventsPath(workspacePath: string | undefined, specFolderName: string): string {

    return path.join(eventsRoot(workspacePath), "specs", `${safe(specFolderName)}.jsonl`);
}

/**
 * The file holding one chat - every turn of it, from the first
 * message on. New Session starts a new chat, so a new file.
 */
export function chatEventsPath(workspacePath: string | undefined, chatId: string): string {

    return path.join(eventsRoot(workspacePath), "chats", `${safe(chatId)}.jsonl`);
}

/**
 * The file holding one workflow or task run.
 *
 * The first eight characters of the run id tell apart two runs started
 * in the same second, and let a person match a file to a run list row.
 */
export function runEventsPath(
    workspacePath: string | undefined,
    runId: string,
    startedAt: number
): string {

    return path.join(eventsRoot(workspacePath), "runs", `${stamp(startedAt)}-${safe(runId).slice(0, 8)}.jsonl`);
}

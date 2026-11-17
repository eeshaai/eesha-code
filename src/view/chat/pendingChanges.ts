import type { LogLine, TurnChanges } from "../../core/models/run";

/** One repository's files in the changed-files bar, and which of them were undone since. */
export interface PendingRepo {

    changed: TurnChanges;

    undone: Set<string>;
}

/**
 * What the changed-files bar shows: the newest turn that changed files,
 * less what has been undone since - one entry per repository the turn
 * changed (one, except in a chat with several folders). A
 * repository drops out once its changes were kept, or every one of them
 * undone. Empty when nothing is left. A later turn that changed nothing
 * does not hide the bar; only Keep or Undo does.
 *
 * Read off the chat's own lines, so a reload shows the same bar.
 */
export function pendingChanges(lines: readonly LogLine[]): PendingRepo[] {

    let index = lines.length - 1;

    while (index >= 0 && lines[index].kind !== "files.changed")
        index--;

    const line = index >= 0 ? lines[index] : undefined;

    if (!line?.changed)
        return [];

    const later = lines.slice(index + 1);

    return [line.changed, ...(line.changedMore ?? [])].flatMap(changed => {

        const undone = new Set<string>();

        for (const one of later) {

            if (one.kind === "files.kept" && sameTurn(changed, one.changed))
                return [];

            if (one.kind === "files.undone" && sameTurn(changed, one.changed))
                for (const file of one.changed!.files)
                    undone.add(file.path);
        }

        return changed.files.every(file => undone.has(file.path)) ? [] : [{ changed, undone }];
    });
}

/** Whether a kept or undone line is about this turn in this repository. */
function sameTurn(changed: TurnChanges, other: TurnChanges | undefined): boolean {

    return other !== undefined && other.root === changed.root && other.before === changed.before && other.after === changed.after;
}

/** One turn that changed files, in the list of every turn - see `changedTurns`. */
export interface ChangedTurn {

    /** Where the turn's `files.changed` line is in the chat. The same turn keeps it. */
    key: number;

    /** The message that started the turn, as typed. Empty when none came before it. */
    message: string;

    /** One entry per repository the turn changed, each with the files undone since. */
    repos: PendingRepo[];
}

/**
 * Every turn of the chat that changed files, newest first: kept, undone
 * or still waiting. A file put back since says so in `undone`. Read off
 * the chat's own lines, like `pendingChanges`.
 */
export function changedTurns(lines: readonly LogLine[]): ChangedTurn[] {

    const turns: ChangedTurn[] = [];

    let message = "";

    lines.forEach((line, index) => {

        if (line.kind === "prompt" && line.pending === undefined)
            message = line.text.trim();

        else if (line.kind === "files.changed" && line.changed)
            turns.push({
                key: index,
                message,
                repos: [line.changed, ...(line.changedMore ?? [])].map(changed => ({ changed, undone: new Set<string>() }))
            });

        else if (line.kind === "files.undone" && line.changed)
            for (const turn of turns)
                for (const repo of turn.repos)
                    if (sameTurn(repo.changed, line.changed))
                        for (const file of line.changed.files)
                            repo.undone.add(file.path);
    });

    return turns.reverse();
}

/** A file the chat's turns changed - see `agentChangedFiles`. */
export interface AgentFile {

    /** The full path: the repository's folder, a slash, the file's path in it. */
    path: string;

    /** The repository's folder, as the turn wrote it. */
    root: string;

    /** The file's path in the repository. */
    file: string;

    /** The snapshots of the first turn that changed it - "before that turn and now" shows all the agent did to it. */
    before: string;

    after: string;
}

/**
 * What was asked for each turn that changed files: the message, by
 * `<root>|<after snapshot>` of each repository the turn changed. For the
 * "You asked" line over a turn's diff.
 */
export function turnMessages(lines: readonly LogLine[]): Record<string, string> {

    const messages: Record<string, string> = {};

    for (const turn of changedTurns(lines))
        for (const repo of turn.repos)
            messages[`${repo.changed.root}|${repo.changed.after}`] = turn.message;

    return messages;
}

/**
 * Every file a turn of the chat changed and that is still there, in path
 * order. The turns are read oldest first: a file a later turn deleted
 * drops out, and a turn's files undone since do not count. Kept files
 * stay in. The file tree and the Git panel mark these.
 */
export function agentChangedFiles(lines: readonly LogLine[]): AgentFile[] {

    const files = new Map<string, AgentFile>();

    for (const turn of changedTurns(lines).reverse())
        for (const repo of turn.repos)
            for (const file of repo.changed.files) {

                if (repo.undone.has(file.path))
                    continue;

                const { root, before, after } = repo.changed;
                const full = `${root.replace(/[\\/]+$/, "")}/${file.path}`;

                if (file.status === "deleted")
                    files.delete(full);
                else if (!files.has(full))
                    files.set(full, { path: full, root, file: file.path, before, after });
            }

    return [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

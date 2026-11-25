import type { ContextItem, ContextUsage } from "../core/models/run";

/*
 * Which rows of the context window are files on disk, and where each is.
 *
 * One rule, read by both sides: the page uses it to make a row a link,
 * and the server uses it to check that a file it is asked to show is one
 * the runtime itself listed.
 */

/** `/c%3A/work`, `/c:/work` and `c:\work` all as `c:/work`. */
export function plainPath(name: string): string {

    let path = name;

    try {
        path = decodeURIComponent(name);
    } catch {
        // Not encoded after all - a name with a lone % in it.
    }

    return path.replace(/\\/g, "/").replace(/^\/([a-zA-Z]:\/)/, "$1");
}

/** A path from the drive or the root down. Give it a name already through {@link plainPath}. */
export function isFullPath(name: string): boolean {

    return /^[a-zA-Z]:\//.test(name) || name.startsWith("/");
}

/**
 * The file a row stands for, or nothing when the row is not a file - a
 * tool, a skill, a part of the system prompt.
 *
 * A row is a file when its name is a full path (Kiro's context files,
 * Claude's memory files), or when the runtime marked it `not loaded`,
 * which it only says of a file. That second kind can be a path with no
 * drive in it, which is read from the session's working folder.
 */
export function contextFile(item: ContextItem): string | undefined {

    const plain = plainPath(item.name);

    return isFullPath(plain) || item.note === "not loaded" ? plain : undefined;
}

/** Every file the window lists, as {@link contextFile} gives them. */
export function contextFiles(context: ContextUsage): string[] {

    const files: string[] = [];

    for (const part of context.parts ?? [])
        for (const item of part.items ?? []) {

            const file = contextFile(item);

            if (file !== undefined)
                files.push(file);
        }

    return files;
}

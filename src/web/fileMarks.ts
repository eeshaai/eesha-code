import type { GitStatus } from "../server/protocol";

/**
 * A row of the tree - the same shape as the UI library's FileEntry. Kept
 * here so this file, and its test, do not pull in the library.
 */
export interface FileEntry {

    name: string;

    /** The full path. */
    relativePath: string;

    isDirectory: boolean;
}

/*
 * What the file tree marks on its rows - the git letter of a changed file, the dot on a folder
 * that holds changed files, and the tree of only the files the agent
 * changed. No React here, so it can be tested alone.
 */

/**
 * A full path in one form, to compare paths that came from different
 * places: forward slashes, no slash at the end, and on Windows (a path
 * that starts with a drive letter) lower case, as Windows paths ignore
 * case.
 */
export function pathKey(path: string): string {

    const forward = path.replace(/\\/g, "/").replace(/(.)\/+$/, "$1");

    return /^[a-zA-Z]:\//.test(forward) ? forward.toLowerCase() : forward;
}

/** A file's letter in the tree: what git says about it, in the Git panel's letters. */
export interface GitMark {

    /** M, A, R, C, T, U (a new file git does not track), D, or ! (a conflict). */
    letter: string;

    /** The repository it is in, and its path there - for "Show in Git". */
    root: string;

    path: string;

    /** Which diff "Show in Git" opens: the conflict, the change on disk, or (only staged) the staged one. */
    side: "conflict" | "changes" | "staged";
}

/**
 * Every changed file in these repositories, by `pathKey` of its full
 * path. A file changed both staged and on disk shows the change on disk.
 */
export function gitMarks(repos: readonly GitStatus[]): Map<string, GitMark> {

    const marks = new Map<string, GitMark>();

    for (const repo of repos)
        for (const file of repo.files) {

            const letter = file.conflict ? "!"
                : file.index === "?" ? "U"
                : file.work !== "." ? file.work
                : file.index;

            const side = file.conflict ? "conflict" : file.index === "?" || file.work !== "." ? "changes" : "staged";

            marks.set(pathKey(`${repo.root}/${file.path}`), { letter, root: repo.root, path: file.path, side });
        }

    return marks;
}

/** What git ignores in these repositories, by `pathKey` of the full path: files, and folders (everything under them). */
export interface IgnoredPaths {

    files: Set<string>;

    folders: Set<string>;
}

export function gitIgnored(repos: readonly GitStatus[]): IgnoredPaths {

    const ignored: IgnoredPaths = { files: new Set(), folders: new Set() };

    for (const repo of repos)
        for (const one of repo.ignored ?? []) {

            const key = pathKey(`${repo.root}/${one}`);

            (one.endsWith("/") ? ignored.folders : ignored.files).add(key);
        }

    return ignored;
}

/** Whether git ignores this path (a `pathKey`): named itself, or inside an ignored folder. */
export function isIgnored(key: string, ignored: IgnoredPaths): boolean {

    if (ignored.files.has(key) || ignored.folders.has(key))
        return true;

    if (!ignored.folders.size)
        return false;

    for (let at = key.lastIndexOf("/"); at > 0; at = key.lastIndexOf("/", at - 1))
        if (ignored.folders.has(key.slice(0, at)))
            return true;

    return false;
}

/** Every folder above these paths (all `pathKey`s), so a folder holding a changed file can be marked. */
export function foldersAbove(keys: Iterable<string>): Set<string> {

    const folders = new Set<string>();

    for (const key of keys)
        for (let at = key.lastIndexOf("/"); at > 0; at = key.lastIndexOf("/", at - 1)) {

            const folder = key.slice(0, at);

            if (folders.has(folder))
                break;

            folders.add(folder);
        }

    return folders;
}

/** The tree of only the agent's files: the top folders that hold any, and each folder's entries. */
export interface AgentTree {

    top: FileEntry[];

    children: Record<string, FileEntry[]>;
}

/** Folders first, then by name, as the tree lists them. */
function byKindThenName(a: FileEntry, b: FileEntry): number {

    if (a.isDirectory !== b.isDirectory)
        return a.isDirectory ? -1 : 1;

    return a.name.localeCompare(b.name);
}

/**
 * The tree the agent-only button shows, built from the files themselves
 * so no folder has to be opened first. `files` are full paths; `tops` are
 * the tree's top entries (the chat's folders). A file under none of them
 * is left out. Paths are written the way each top folder writes its own
 * path, so opening one goes to the same file the full tree opens.
 */
export function agentTree(files: readonly string[], tops: readonly FileEntry[]): AgentTree {

    const children: Record<string, FileEntry[]> = {};
    const seen = new Set<string>();
    const top: FileEntry[] = [];

    const add = (parent: string, entry: FileEntry) => {

        if (seen.has(entry.relativePath))
            return;

        seen.add(entry.relativePath);
        (children[parent] ??= []).push(entry);
    };

    for (const file of files) {

        const owner = tops.find(one => one.isDirectory && pathKey(file).startsWith(pathKey(one.relativePath) + "/"));

        if (!owner)
            continue;

        const separator = owner.relativePath.includes("\\") ? "\\" : "/";
        const base = owner.relativePath.replace(/[\\/]+$/, "");
        const parts = file.replace(/\\/g, "/").slice(base.length + 1).split("/").filter(Boolean);

        if (!top.includes(owner))
            top.push(owner);

        let parent = owner.relativePath;
        let path = base;

        parts.forEach((name, index) => {

            path = `${path}${separator}${name}`;

            const folder = index < parts.length - 1;

            add(parent, { name, relativePath: path, isDirectory: folder });

            parent = path;
        });
    }

    for (const list of Object.values(children))
        list.sort(byKindThenName);

    return { top: tops.filter(one => top.includes(one)), children };
}

/**
 * A file's path as the view's path line shows it: the session folder it
 * is in by name, then the folders down to the file. A file in none of
 * the folders: its whole path, cut at each slash.
 */
export function pathParts(file: string, folders: readonly string[]): string[] {

    const key = pathKey(file);

    // The deepest folder first, so a folder inside another one wins.
    for (const folder of [...folders].sort((a, b) => b.length - a.length)) {

        const top = pathKey(folder);

        if (key.startsWith(`${top}/`)) {

            const name = folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? folder;

            return [name, ...file.replace(/\\/g, "/").slice(top.length + 1).split("/")];
        }
    }

    return file.split(/[\\/]/).filter(Boolean);
}

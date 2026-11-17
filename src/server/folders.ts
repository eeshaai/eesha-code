import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import type { FileMatch } from "../shared/composeFiles";
import type { FileItem, FolderEntry, FolderListing } from "./protocol";
import { sameFolder } from "./settings";

/*
 * The folder browser and the "@" file search, done with Node.
 */

/** When a folder's `.git` last changed, in ms. Nothing: the folder is not a git repo. */
async function gitActivity(folder: string): Promise<number | undefined> {

    try {

        // A `.git` folder, or a `.git` file - a worktree's. Git writes and
        // renames files right inside the `.git` folder on a commit,
        // checkout, pull or stage, which changes the folder's time.
        return (await fsp.stat(path.join(folder, ".git"))).mtimeMs;

    } catch {

        return undefined;
    }
}

/**
 * The git repos in the working folders, for the folder browser's quick
 * pick: each working folder that is a repo, and each folder directly
 * inside one that is. Last git activity first; each once. A working
 * folder that cannot be read is skipped.
 */
export async function gitReposIn(workingFolders: readonly string[]): Promise<string[]> {

    const found: { folder: string; changed: number }[] = [];

    for (const working of workingFolders) {

        let entries: fs.Dirent[];

        try {

            entries = await fsp.readdir(working, { withFileTypes: true });

        } catch {

            continue;
        }

        // A link may point to a folder: its `.git` is looked for the same way.
        const inside = entries.filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(working, entry.name));

        const checked = await Promise.all([working, ...inside].map(async folder => ({ folder, changed: await gitActivity(folder) })));

        for (const { folder, changed } of checked)
            if (changed !== undefined && !found.some(one => sameFolder(one.folder, folder)))
                found.push({ folder, changed });
    }

    return found
        .sort((left, right) => right.changed - left.changed || left.folder.localeCompare(right.folder))
        .map(one => one.folder);
}

/** The working folders that are folders right now - a drive not plugged in is left out. */
export function workingFoldersHere(workingFolders: readonly string[]): string[] {

    return workingFolders.filter(folder => {

        try {

            return fs.statSync(folder).isDirectory();

        } catch {

            return false;
        }
    });
}

/** The drives that exist, `C:\` and so on. */
function drives(): FolderEntry[] {

    const found: FolderEntry[] = [];

    for (let code = 65; code <= 90; code++) {

        const drive = `${String.fromCharCode(code)}:\\`;

        if (fs.existsSync(drive))
            found.push({ name: drive, path: drive });
    }

    return found;
}

/**
 * The folders inside `folder`, by name. No folder lists the top level:
 * the drives on Windows, `/` elsewhere. With `withFiles`, its files too,
 * after the folders and marked `file` - for picking files (New spec's
 * files with the ask); otherwise only a folder can be picked.
 */
export async function listFolders(folder: string | undefined, withFiles = false): Promise<FolderListing> {

    if (!folder)
        return process.platform === "win32"
            ? { path: "", entries: drives() }
            : { path: "", entries: [{ name: "/", path: "/" }] };

    const resolved = path.resolve(folder);

    const up = path.dirname(resolved);

    // The parent of a drive or of `/` is the top level.
    const parent = up === resolved ? "" : up;

    let names: fs.Dirent[];

    try {

        names = await fsp.readdir(resolved, { withFileTypes: true });

    } catch (error) {

        return { path: resolved, parent, entries: [], problem: (error as Error).message };
    }

    const entries: FolderEntry[] = [];
    const files: FolderEntry[] = [];

    for (const entry of names) {

        const full = path.join(resolved, entry.name);

        let isFolder = entry.isDirectory();

        // A link to a folder counts as a folder.
        if (!isFolder && entry.isSymbolicLink())
            try {

                isFolder = (await fsp.stat(full)).isDirectory();

            } catch {

                // A broken link.
            }

        if (isFolder)
            entries.push({ name: entry.name, path: full });
        else if (withFiles && entry.isFile())
            files.push({ name: entry.name, path: full, file: true });
    }

    const byName = (left: FolderEntry, right: FolderEntry) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" });

    return { path: resolved, parent, entries: [...entries.sort(byName), ...files.sort(byName)] };
}

/** Folders the files pane never lists: not the chat's own work, and often huge. */
const PANE_HIDDEN = new Set([".git", "node_modules"]);

/**
 * One folder's files and folders, for the files pane: folders first, then
 * files, each A to Z. `.git` and `node_modules` are left out. Throws when
 * the folder cannot be read.
 */
export async function listFiles(folder: string): Promise<FileItem[]> {

    const names = await fsp.readdir(folder, { withFileTypes: true });

    const items: FileItem[] = [];

    for (const entry of names) {

        if (PANE_HIDDEN.has(entry.name))
            continue;

        const full = path.join(folder, entry.name);

        let isFolder = entry.isDirectory();
        let isFile = entry.isFile();

        // A link counts as what it points to.
        if (entry.isSymbolicLink())
            try {

                const stat = await fsp.stat(full);

                isFolder = stat.isDirectory();
                isFile = stat.isFile();

            } catch {

                // A broken link: listed as a file, which says why it does not open.
                isFile = true;
            }

        if (isFolder || isFile)
            items.push({ name: entry.name, path: full, folder: isFolder });
    }

    return items.sort((left, right) =>
        Number(right.folder) - Number(left.folder) || left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/** Folders the "@" search never looks in. */
const SKIPPED = new Set(["node_modules", ".git", "dist", "out", "bin", "obj", ".vs", ".next", "coverage"]);

/** How many matches the "@" search lists. */
const MATCH_LIMIT = 30;

/** How many files one search looks at before it stops, so a huge folder never hangs the page. */
const VISIT_LIMIT = 50_000;

/**
 * Files whose path holds `query`, for the compose box's "@" search, over
 * every folder of the chat. Name matches first, then the rest, each in
 * path order.
 *
 * A match in the working folder (the first) is given relative to it,
 * which is how the chat resolves a picked file. A match in another
 * folder is given as a full path, which resolves the same.
 */
export async function searchFolders(folders: readonly string[], query: string): Promise<FileMatch[]> {

    const needle = query.replace(/[^\w.\-/ ]/g, "").trim().toLowerCase().replace(/\\/g, "/");

    const root = folders[0];

    const found: FileMatch[] = [];

    let visited = 0;

    const walk = async (folder: string): Promise<void> => {

        if (visited >= VISIT_LIMIT || found.length >= MATCH_LIMIT * 4)
            return;

        let entries: fs.Dirent[];

        try {

            entries = await fsp.readdir(folder, { withFileTypes: true });

        } catch {

            return;
        }

        for (const entry of entries) {

            if (visited >= VISIT_LIMIT || found.length >= MATCH_LIMIT * 4)
                return;

            const full = path.join(folder, entry.name);

            if (entry.isDirectory()) {

                if (!SKIPPED.has(entry.name))
                    await walk(full);

                continue;
            }

            if (!entry.isFile())
                continue;

            visited++;

            const shown = root && isInside(root, full)
                ? path.relative(root, full).split(path.sep).join("/")
                : full.split(path.sep).join("/");

            if (!needle || shown.toLowerCase().includes(needle))
                found.push({ name: entry.name, path: shown });
        }
    };

    for (const folder of folders)
        await walk(folder);

    const byName = (one: FileMatch) => (needle && one.name.toLowerCase().includes(needle) ? 0 : 1);

    return found
        .sort((a, b) => byName(a) - byName(b) || a.path.localeCompare(b.path))
        .slice(0, MATCH_LIMIT);
}

/** Whether `file` is `folder` or inside it. */
export function isInside(folder: string, file: string): boolean {

    const relative = path.relative(path.resolve(folder), path.resolve(file));

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

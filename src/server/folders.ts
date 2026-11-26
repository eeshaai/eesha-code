import { type ChildProcess, spawn } from "child_process";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";

import { commandOnPath } from "../core/agent/providers/cliOnPath";
import { EnvService } from "../core/env/envService";
import type { FileMatch } from "../shared/composeFiles";
import type { FileItem, FolderEntry, FolderListing } from "./protocol";
import { sameFolder } from "./settings";

/*
 * The folder browser and the "@" file search, done with Node. The "@"
 * search asks rg for the file list instead when rg is on PATH.
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
const SKIPPED = new Set(["node_modules", ".git", "dist", "out", "bin", "obj", ".vs", ".next", "coverage", "target", ".venv", "__pycache__"]);

/** How many matches the "@" search lists. */
const MATCH_LIMIT = 30;

/** How many files one search looks at before it stops, so a huge folder never hangs the page. */
const VISIT_LIMIT = 50_000;

/**
 * What rg is asked for: every file, hidden ones too, in path order, with
 * `/` between folders, and none in the folders above. The person's own rg
 * config file is not read, so it cannot change the output.
 */
const RG_ARGS = [
    "--no-config", "--files", "--hidden", "--sort", "path", "--path-separator", "/",
    ...[...SKIPPED].flatMap(name => ["--glob", `!${name}`])
];

/** Where rg is on PATH, or nothing. */
export function findRipgrep(): string | undefined {

    return commandOnPath(EnvService.machine(), "rg");
}

/**
 * Files whose path holds `query`, for the compose box's "@" search, over
 * every folder of the chat. Name matches first, then the rest, each in
 * path order.
 *
 * A match in the working folder (the first) is given relative to it,
 * which is how the chat resolves a picked file. A match in another
 * folder is given as a full path, which resolves the same.
 *
 * With `rg` (found on PATH unless given; `null` for none), rg lists each
 * folder, so files a `.gitignore` leaves out are left out here too. A
 * folder rg cannot list is listed with Node.
 */
export async function searchFolders(folders: readonly string[], query: string, rg: string | null = findRipgrep() ?? null): Promise<FileMatch[]> {

    const needle = query.replace(/[^\w.\-/ ]/g, "").trim().toLowerCase().replace(/\\/g, "/");

    const root = folders[0];

    const found: FileMatch[] = [];

    let visited = 0;

    const enough = (): boolean => visited >= VISIT_LIMIT || found.length >= MATCH_LIMIT * 4;

    // One file seen. False once the search has seen enough.
    const take = (full: string): boolean => {

        visited++;

        const shown = root && isInside(root, full)
            ? path.relative(root, full).split(path.sep).join("/")
            : full.split(path.sep).join("/");

        if (!needle || shown.toLowerCase().includes(needle))
            found.push({ name: path.basename(full), path: shown });

        return !enough();
    };

    for (const folder of folders) {

        if (enough())
            break;

        if (!rg || !await listWithRg(rg, folder, take))
            await listWithNode(folder, take);
    }

    const byName = (one: FileMatch) => (needle && one.name.toLowerCase().includes(needle) ? 0 : 1);

    return found
        .sort((a, b) => byName(a) - byName(b) || a.path.localeCompare(b.path))
        .slice(0, MATCH_LIMIT);
}

/**
 * Gives each file in `folder` to `take`, with rg, until `take` says stop.
 * False when rg gave no file and could not start or ended with an error:
 * the caller then lists the folder with Node. rg ends with 1 when the
 * folder has no files - not an error.
 */
function listWithRg(rg: string, folder: string, take: (full: string) => boolean): Promise<boolean> {

    return new Promise(resolve => {

        let child: ChildProcess;

        try {

            child = spawn(rg, RG_ARGS, { cwd: folder, stdio: ["ignore", "pipe", "ignore"], windowsHide: true });

        } catch {

            // An rg.cmd or rg.bat, which Node does not start without a shell.
            resolve(false);

            return;
        }

        let gave = false;
        let done = false;
        let rest = "";

        const finish = (ok: boolean): void => {

            if (!done) {

                done = true;
                resolve(ok);
            }
        };

        const one = (line: string): void => {

            const file = line.replace(/\r$/, "");

            if (done || !file)
                return;

            gave = true;

            if (!take(path.join(folder, file))) {

                child.kill();
                finish(true);
            }
        };

        child.stdout!.setEncoding("utf8");

        child.stdout!.on("data", (chunk: string) => {

            const lines = (rest + chunk).split("\n");

            rest = lines.pop() ?? "";

            for (const line of lines)
                one(line);
        });

        // Not started (`error`) or ended (`close`): the first one settles it.
        child.on("error", () => finish(gave));

        child.on("close", code => {

            one(rest);
            finish(gave || code === 0 || code === 1);
        });
    });
}

/** Gives each file in `folder` to `take`, with Node, skipping the SKIPPED folders. False once `take` said stop. */
async function listWithNode(folder: string, take: (full: string) => boolean): Promise<boolean> {

    let entries: fs.Dirent[];

    try {

        entries = await fsp.readdir(folder, { withFileTypes: true });

    } catch {

        return true;
    }

    for (const entry of entries) {

        const full = path.join(folder, entry.name);

        if (entry.isDirectory()) {

            if (!SKIPPED.has(entry.name) && !await listWithNode(full, take))
                return false;

            continue;
        }

        if (entry.isFile() && !take(full))
            return false;
    }

    return true;
}

/** Whether `file` is `folder` or inside it. */
export function isInside(folder: string, file: string): boolean {

    const relative = path.relative(path.resolve(folder), path.resolve(file));

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

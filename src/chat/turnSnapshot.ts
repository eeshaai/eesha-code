import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { TurnChanges } from "../core/models/run";

/*
 * What one chat turn did to the files.
 *
 * Before the turn and after it, the whole working tree is written into
 * git's object store as a tree - through a temporary copy of the index,
 * so the real index, the branch and the working files are never
 * touched. Comparing the two trees lists the files the turn added,
 * changed or deleted, whoever did the writing (the agent's own tools, a
 * shell command it ran). The "before" tree is also what a diff shows on
 * the left and what Undo puts back.
 *
 * What it cannot see: files git ignores. And outside a git repository
 * there is nothing to write a tree into, so a turn there lists nothing.
 *
 * The only thing left behind is loose objects in `.git/objects` that no
 * branch points at; git's own garbage collection removes them.
 */

/** Big enough for any file a diff would show. */
const MAX_BUFFER = 256 * 1024 * 1024;

function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {

    return new Promise((resolve, reject) => {

        execFile("git", args, { cwd, env: env ?? process.env, windowsHide: true, maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {

            if (error)
                reject(new Error(`git ${args[0]} failed: ${String(stderr || error.message).trim()}`));
            else
                resolve(stdout);
        });
    });
}

/** The repository's top folder, or `undefined` when the workspace is not in one. */
export async function repoRoot(workspace: string): Promise<string | undefined> {

    try {

        return path.resolve((await git(workspace, ["rev-parse", "--show-toplevel"])).trim());

    } catch {

        return undefined;
    }
}

/**
 * The working tree as it is now, as a git tree id - tracked files as
 * they are on disk, and untracked ones git does not ignore.
 *
 * The real index is copied first so git can skip hashing every file it
 * already knows is unchanged; the copy is deleted afterwards.
 */
export async function snapshot(root: string): Promise<string> {

    const temp = path.join(os.tmpdir(), `eesha-chat-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try {

        const index = path.resolve(root, (await git(root, ["rev-parse", "--git-path", "index"])).trim());

        if (fs.existsSync(index))
            fs.copyFileSync(index, temp);

        const env = { ...process.env, GIT_INDEX_FILE: temp };

        await git(root, ["add", "-A", "--", "."], env);

        return (await git(root, ["write-tree"], env)).trim();

    } finally {

        fs.rmSync(temp, { force: true });
    }
}

/** Reads `git diff-tree --name-status` output. Renames are off, so every row is A, M or D. */
export function parseNameStatus(output: string): TurnChanges["files"] {

    const files: TurnChanges["files"] = [];

    // `-z`: fields end in NUL, so a path with a tab or a quote in it
    // comes through as written.
    const fields = output.split("\0");

    for (let index = 0; index + 1 < fields.length; index += 2) {

        const code = fields[index].trim();
        const file = fields[index + 1];

        if (!file)
            continue;

        const status = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";

        files.push({ path: file, status });
    }

    return files;
}

/** Every file that differs between two snapshots. */
export async function changedBetween(root: string, before: string, after: string): Promise<TurnChanges["files"]> {

    if (before === after)
        return [];

    return parseNameStatus(await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", before, after]));
}

/**
 * One file's bytes in a snapshot, as they would be checked out - line
 * endings and other filters applied, so putting it back gives the file
 * the person had. `undefined` when the file is not in that snapshot.
 */
export function contentAt(root: string, tree: string, file: string): Promise<Buffer | undefined> {

    return new Promise(resolve => {

        execFile(
            "git", ["cat-file", "--filters", `${tree}:${file}`],
            { cwd: root, windowsHide: true, maxBuffer: MAX_BUFFER, encoding: "buffer" },
            (error, stdout) => resolve(error ? undefined : stdout));
    });
}

import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";

import type {
    GitAction, GitBranch, GitCommit, GitCommitFile, GitDiff, GitDiffAsk, GitFile, GitLists, GitOperation, GitRepo, GitStatus
} from "./protocol";

/*
 * The git panel's side on the server: which repositories a chat's folders
 * give, what each one's state is, a file's two sides for a diff, and every
 * action the panel's buttons run.
 *
 * Every git call goes through `git()` here: no shell, the repository as
 * its working folder, never waiting for typed input. Every path the page
 * sends is checked to be inside the repository and goes after `--`; every
 * name is checked before it reaches git (see `checkName`).
 */

/** Large enough for a big status or log. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Reads and local writes. A network step (fetch, pull, push) gets `NETWORK_MS`. */
const LOCAL_MS = 2 * 60_000;

const NETWORK_MS = 10 * 60_000;

/** The largest file side the panel shows in a diff. */
const MAX_SIDE_BYTES = 2 * 1024 * 1024;

/** How many commits the Commits list shows. */
export const COMMIT_LIMIT = 50;

/** A failed git call: its own words, first. */
export class GitError extends Error { }

/**
 * Runs git in `cwd`. Git never waits for typed input: no password prompt
 * (`GIT_TERMINAL_PROMPT=0`) and a no-op editor for steps that would open
 * one. `GIT_OPTIONAL_LOCKS=0` keeps a status from taking the index lock
 * while the agent or the person runs git too.
 */
function git(cwd: string, args: string[], options: { timeout?: number; raw?: false }): Promise<string>;
function git(cwd: string, args: string[], options: { timeout?: number; raw: true }): Promise<Buffer>;
function git(cwd: string, args: string[], options: { timeout?: number; raw?: boolean } = {}): Promise<string | Buffer> {

    return new Promise((resolve, reject) => {

        execFile("git", args, {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
            windowsHide: true,
            maxBuffer: MAX_BUFFER,
            timeout: options.timeout ?? LOCAL_MS,
            encoding: options.raw ? "buffer" : "utf8"
        }, (error, stdout, stderr) => {

            if (error) {

                const said = String(stderr || stdout || "").trim();

                reject(new GitError(said || error.message));

                return;
            }

            resolve(stdout);
        });
    });
}

/** Git's own text, for the panel - a few lines at most. */
function shortText(text: string): string {

    const lines = text.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean);

    return lines.slice(0, 12).join("\n");
}

// -------------------------------------------------------------------
// Which repositories
// -------------------------------------------------------------------

/** The repository a folder is inside, or nothing. */
async function topOf(folder: string): Promise<string | undefined> {

    try {

        return path.resolve((await git(folder, ["rev-parse", "--show-toplevel"], {})).trim());

    } catch {

        return undefined;
    }
}

function sameKey(folder: string): string {

    const resolved = path.resolve(folder);

    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * The repositories a chat's folders give, in the folders' order: the one a
 * folder is inside, or - for a folder that is in none - the ones directly
 * inside it, A to Z. Each repository once.
 */
export async function findRepos(folders: readonly string[]): Promise<GitRepo[]> {

    const found: GitRepo[] = [];
    const seen = new Set<string>();

    const add = (root: string): void => {

        const key = sameKey(root);

        if (seen.has(key))
            return;

        seen.add(key);
        found.push({ root, name: path.basename(root) || root });
    };

    for (const folder of folders) {

        const top = await topOf(folder);

        if (top) {

            add(top);

            continue;
        }

        let entries: fs.Dirent[];

        try {

            entries = await fs.promises.readdir(folder, { withFileTypes: true });

        } catch {

            continue;
        }

        const inside = entries
            .filter(entry => entry.isDirectory() && fs.existsSync(path.join(folder, entry.name, ".git")))
            .map(entry => path.join(folder, entry.name))
            .sort((a, b) => a.localeCompare(b));

        for (const child of inside) {

            const childTop = await topOf(child);

            if (childTop)
                add(childTop);
        }
    }

    return found;
}

/** The URLs of a repository's remotes - for the connectors (connectors/remotes.ts). None when git cannot say. */
export async function repoRemoteUrls(repo: GitRepo): Promise<string[]> {

    try {

        const text = await git(repo.root, ["config", "--get-regexp", "^remote\\..*\\.url$"], {});

        return text.split(/\r?\n/).map(line => line.trim().split(/\s+/)[1]).filter((url): url is string => !!url);

    } catch {

        return [];
    }
}

/** The repository the page named, if the chat's folders give it. */
export function repoOf(repos: readonly GitRepo[], root: unknown): GitRepo | undefined {

    if (typeof root !== "string" || !path.isAbsolute(root))
        return undefined;

    const key = sameKey(root);

    return repos.find(repo => sameKey(repo.root) === key);
}

// -------------------------------------------------------------------
// Status
// -------------------------------------------------------------------

/** The first `count` space-separated fields of a line, and the rest - a path may hold spaces. */
function fields(line: string, count: number): { parts: string[]; rest: string } {

    const parts: string[] = [];

    let at = 0;

    for (let index = 0; index < count; index++) {

        const next = line.indexOf(" ", at);

        if (next < 0)
            return { parts, rest: "" };

        parts.push(line.slice(at, next));
        at = next + 1;
    }

    return { parts, rest: line.slice(at) };
}

/** `git status --porcelain=v2 --branch --show-stash -z` read into the panel's shape. Exported for the tests. */
export function parseStatus(text: string): Omit<GitStatus, "root" | "name" | "operation" | "head"> {

    const status: Omit<GitStatus, "root" | "name" | "operation" | "head"> = {
        branch: undefined,
        commit: undefined,
        ahead: 0,
        behind: 0,
        stashes: 0,
        files: []
    };

    const records = text.split("\0");

    for (let index = 0; index < records.length; index++) {

        const record = records[index];

        if (!record)
            continue;

        if (record.startsWith("# ")) {

            const [, key, ...value] = record.split(" ");
            const joined = value.join(" ");

            if (key === "branch.oid" && joined !== "(initial)")
                status.commit = joined;
            else if (key === "branch.head" && joined !== "(detached)")
                status.branch = joined;
            else if (key === "branch.upstream")
                status.upstream = joined;
            else if (key === "branch.ab") {

                const match = /^\+(\d+) -(\d+)$/.exec(joined);

                if (match) {

                    status.ahead = Number(match[1]);
                    status.behind = Number(match[2]);
                }

            } else if (key === "stash")
                status.stashes = Number(joined) || 0;

            continue;
        }

        const kind = record[0];

        if (kind === "1") {

            const { parts, rest } = fields(record, 8);

            status.files.push({ path: rest, index: parts[1][0], work: parts[1][1] });

        } else if (kind === "2") {

            const { parts, rest } = fields(record, 9);

            // The path it came from is the next record.
            const from = records[++index] ?? "";

            status.files.push({ path: rest, from, index: parts[1][0], work: parts[1][1] });

        } else if (kind === "u") {

            const { parts, rest } = fields(record, 10);

            status.files.push({ path: rest, index: parts[1][0], work: parts[1][1], conflict: true });

        } else if (kind === "?")
            status.files.push({ path: record.slice(2), index: "?", work: "?" });

        else if (kind === "!")
            (status.ignored ??= []).push(record.slice(2));
    }

    return status;
}

/** A merge, rebase, cherry-pick or revert that stopped and waits for Continue or Abort. */
async function operationOf(root: string): Promise<GitOperation | undefined> {

    const names = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"];

    let lines: string[];

    try {

        lines = (await git(root, ["rev-parse", ...names.flatMap(name => ["--git-path", name])], {})).split(/\r?\n/);

    } catch {

        return undefined;
    }

    const there = (index: number): boolean => Boolean(lines[index]) && fs.existsSync(path.resolve(root, lines[index].trim()));

    if (there(0) || there(1))
        return "rebase";

    if (there(2))
        return "merge";

    if (there(3))
        return "cherry-pick";

    if (there(4))
        return "revert";

    return undefined;
}

/** One repository's state, for the panel. */
export async function repoStatus(repo: GitRepo): Promise<GitStatus> {

    // "matching": an ignored folder is one line, not every file in it.
    const text = await git(repo.root, ["status", "--porcelain=v2", "--branch", "--show-stash", "--untracked-files=all", "--ignored=matching", "-z"], {});

    const parsed = parseStatus(text);

    let head: string | undefined;

    if (parsed.commit)
        try {

            head = (await git(repo.root, ["log", "-1", "--format=%s"], {})).trim();

        } catch {

            // No commit yet.
        }

    return { root: repo.root, name: repo.name, ...parsed, ...(head !== undefined ? { head } : {}), operation: await operationOf(repo.root) };
}

// -------------------------------------------------------------------
// Lists: branches, tags, stashes, remotes, commits
// -------------------------------------------------------------------

const UNIT = "\x1f";
const RECORD = "\x1e";

function records(text: string): string[][] {

    return text.split(RECORD).map(one => one.replace(/^\r?\n/, "")).filter(Boolean).map(one => one.split(UNIT));
}

/** Branches, tags, stashes and remotes - for the branch window and the panel's menus. */
export async function repoLists(repo: GitRepo): Promise<GitLists> {

    const refs = await git(repo.root, [
        "for-each-ref",
        `--format=%(refname)${UNIT}%(refname:short)${UNIT}%(objectname:short)${UNIT}%(upstream:short)${UNIT}%(HEAD)${UNIT}%(symref)${RECORD}`,
        "refs/heads", "refs/remotes", "refs/tags"
    ], {});

    const branches: GitBranch[] = [];
    const tags: string[] = [];

    for (const [full, short, commit, upstream, head, symref] of records(refs)) {

        if (full.startsWith("refs/tags/")) {

            tags.push(short);

            continue;
        }

        // origin/HEAD only points at another branch.
        if (symref)
            continue;

        branches.push({
            name: short,
            remote: full.startsWith("refs/remotes/"),
            commit,
            ...(upstream ? { upstream } : {}),
            ...(head === "*" ? { current: true } : {})
        });
    }

    let stashes: GitLists["stashes"] = [];

    try {

        stashes = records(await git(repo.root, ["stash", "list", `--format=%gd${UNIT}%s${UNIT}%ct${RECORD}`], {}))
            .map(([ref, text, at]) => ({ index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? -1), text, at: Number(at) * 1000 }))
            .filter(one => one.index >= 0);

    } catch {

        // No stash yet.
    }

    const remotes: GitLists["remotes"] = [];

    for (const line of (await git(repo.root, ["remote", "-v"], {})).split(/\r?\n/)) {

        const match = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim());

        if (match)
            remotes.push({ name: match[1], url: match[2] });
    }

    return { branches, tags, stashes, remotes };
}

/** The last commits on the current branch, newest first. Empty for a repository with no commit. */
export async function commitList(repo: GitRepo, limit = COMMIT_LIMIT): Promise<GitCommit[]> {

    let text: string;

    try {

        text = await git(repo.root, ["log", `-n${limit}`, `--format=%H${UNIT}%h${UNIT}%an${UNIT}%at${UNIT}%s${UNIT}%D${RECORD}`], {});

    } catch {

        return [];
    }

    return records(text).map(([hash, short, author, at, subject, refs]) => ({
        hash, short, author, at: Number(at) * 1000, subject, ...(refs ? { refs } : {})
    }));
}

/** A commit's first parent, or nothing for a root commit. */
async function parentOf(root: string, hash: string): Promise<string | undefined> {

    const line = (await git(root, ["rev-list", "--parents", "-n", "1", hash], {})).trim().split(/\s+/);

    return line[1];
}

/** What one commit changed, against its first parent. */
export async function commitFiles(repo: GitRepo, hash: string): Promise<GitCommitFile[]> {

    const parent = await parentOf(repo.root, hash);

    const text = await git(repo.root, parent
        ? ["diff-tree", "-r", "-z", "--name-status", "-M", parent, hash]
        : ["diff-tree", "-r", "-z", "--name-status", "--root", hash], {});

    const parts = text.split("\0");
    const files: GitCommitFile[] = [];

    // With --root the commit's own id comes first.
    let index = parts[0] && /^[0-9a-f]{7,64}$/.test(parts[0]) ? 1 : 0;

    while (index < parts.length) {

        const status = parts[index++];

        if (!status)
            continue;

        if (status.startsWith("R") || status.startsWith("C")) {

            const from = parts[index++];
            const to = parts[index++];

            files.push({ path: to, from, status: status[0] });

        } else
            files.push({ path: parts[index++], status: status[0] });
    }

    return files;
}

// -------------------------------------------------------------------
// Diffs
// -------------------------------------------------------------------

/** One side of a diff from git: `rev:path`, or `:path` for the staged copy. Nothing when it is not there. */
async function sideAt(root: string, spec: string): Promise<Buffer | undefined> {

    try {

        return await git(root, ["cat-file", "blob", spec], { raw: true });

    } catch {

        return undefined;
    }
}

function fileOnDisk(absolute: string): Buffer | undefined {

    try {

        return fs.statSync(absolute).isFile() ? fs.readFileSync(absolute) : undefined;

    } catch {

        return undefined;
    }
}

const isBinary = (bytes: Buffer | undefined): boolean => bytes !== undefined && bytes.subarray(0, 8192).includes(0);

/**
 * A file's two sides:
 * - `staged`: the last commit against the staged copy.
 * - `changes`: the staged copy against the file on disk (nothing on the left for a new file).
 * - `conflict`: the last commit against the file on disk, with its conflict marks.
 * - `commit`: the commit's first parent against the commit.
 */
export async function fileDiff(repo: GitRepo, ask: GitDiffAsk): Promise<GitDiff> {

    const file = checkPath(repo.root, ask.path);
    const from = ask.from ? checkPath(repo.root, ask.from) : file;

    let before: Buffer | undefined;
    let after: Buffer | undefined;

    if (ask.side === "staged") {

        before = await sideAt(repo.root, `HEAD:${from}`);
        after = await sideAt(repo.root, `:${file}`);

    } else if (ask.side === "changes") {

        before = await sideAt(repo.root, `:${file}`);
        after = fileOnDisk(path.join(repo.root, file));

    } else if (ask.side === "conflict") {

        before = await sideAt(repo.root, `HEAD:${file}`);
        after = fileOnDisk(path.join(repo.root, file));

    } else {

        const hash = checkHash(ask.commit);
        const parent = await parentOf(repo.root, hash);

        before = parent ? await sideAt(repo.root, `${parent}:${from}`) : undefined;
        after = await sideAt(repo.root, `${hash}:${file}`);
    }

    if (isBinary(before) || isBinary(after))
        return { binary: true, after: "" };

    if ((before?.length ?? 0) > MAX_SIDE_BYTES || (after?.length ?? 0) > MAX_SIDE_BYTES)
        return { tooLarge: true, after: "" };

    return {
        ...(before !== undefined ? { before: before.toString("utf8") } : {}),
        after: after?.toString("utf8") ?? ""
    };
}

// -------------------------------------------------------------------
// Checks on what the page sends
// -------------------------------------------------------------------

/** A path the page sent: relative to the repository, inside it, with forward slashes. Throws when it is not. */
export function checkPath(root: string, value: unknown): string {

    if (typeof value !== "string" || !value || /[\0\r\n]/.test(value))
        throw new GitError("Not a file path.");

    if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value))
        throw new GitError("A file path must be relative to its repository.");

    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);

    if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
        throw new GitError("Only files inside the repository.");

    return relative.split(path.sep).join("/");
}

function checkPaths(root: string, value: unknown): string[] {

    if (!Array.isArray(value) || !value.length || value.length > 5000)
        throw new GitError("Send the files to act on.");

    return value.map(one => checkPath(root, one));
}

/**
 * A branch, tag, remote or other ref name: never an option, no spaces, and
 * none of what git refuses in a ref (`..`, `~^:?*[\`, a trailing `.lock`).
 */
export function checkName(value: unknown, what = "name"): string {

    if (typeof value !== "string" || !value.trim())
        throw new GitError(`Type a ${what}.`);

    const name = value.trim();

    if (name.startsWith("-") || /[\s\0-\x1f\x7f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{")
        || name.endsWith(".lock") || name.endsWith("/") || name.endsWith(".") || name.startsWith("/") || name.includes("//"))
        throw new GitError(`'${name}' is not a ${what} git takes.`);

    return name;
}

function checkHash(value: unknown): string {

    if (typeof value !== "string" || !/^[0-9a-f]{4,64}$/i.test(value))
        throw new GitError("Not a commit id.");

    return value;
}

function checkIndex(value: unknown): string {

    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000)
        throw new GitError("Not a stash.");

    return `stash@{${value}}`;
}

function checkMessage(value: unknown, required: boolean): string {

    const text = typeof value === "string" ? value.trim() : "";

    if (required && !text)
        throw new GitError("Type a commit message first.");

    if (text.length > 100_000 || text.includes("\0"))
        throw new GitError("That message is too long.");

    return text;
}

/** A remote's address: one line, never an option. */
function checkUrl(value: unknown): string {

    if (typeof value !== "string" || !value.trim() || value.trim().startsWith("-") || /[\s\0]/.test(value.trim()))
        throw new GitError("Type the remote's address.");

    return value.trim();
}

// -------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------

/** What the server lends an action: where a discarded file goes instead of being deleted. */
export interface ActionDeps {

    trash(absolute: string): Promise<void>;
}

/** The repository has a commit yet. */
async function hasHead(root: string): Promise<boolean> {

    try {

        await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"], {});

        return true;

    } catch {

        return false;
    }
}

/** The remote a branch with no upstream is pushed to: origin, else the only one. */
async function pushRemote(root: string): Promise<string> {

    const names = (await git(root, ["remote"], {})).split(/\r?\n/).map(one => one.trim()).filter(Boolean);

    if (!names.length)
        throw new GitError("This repository has no remote to push to. Add one first (the panel's menu, Remotes).");

    return names.includes("origin") ? "origin" : names[0];
}

async function push(root: string): Promise<string> {

    const status = parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"], {}));

    if (!status.branch)
        throw new GitError("Not on a branch - switch to a branch to push.");

    if (status.upstream)
        return git(root, ["push"], { timeout: NETWORK_MS });

    return git(root, ["push", "--set-upstream", await pushRemote(root), status.branch], { timeout: NETWORK_MS });
}

/** Runs one of the panel's actions. Resolves with git's own words when it said something worth showing; throws a `GitError` when it failed. */
export async function runAction(repo: GitRepo, action: GitAction, deps: ActionDeps): Promise<string | undefined> {

    const root = repo.root;
    const run = (args: string[], timeout?: number) => git(root, args, { ...(timeout ? { timeout } : {}) });

    switch (action.kind) {

        case "stage":
            await run(["add", "-A", "--", ...checkPaths(root, action.paths)]);

            return undefined;

        case "stageAll":
            await run(["add", "-A"]);

            return undefined;

        case "unstage": {

            const paths = checkPaths(root, action.paths);

            await run(await hasHead(root) ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-r", "-q", "--", ...paths]);

            return undefined;
        }

        case "unstageAll":
            await run(await hasHead(root) ? ["reset", "-q"] : ["rm", "--cached", "-r", "-q", "--", "."]);

            return undefined;

        case "discard":
        case "discardAll": {

            const status = parseStatus(await run(["status", "--porcelain=v2", "-z", "--untracked-files=all"]));
            const asked = action.kind === "discard" ? new Set(checkPaths(root, action.paths)) : undefined;
            const picked = status.files.filter(file => !file.conflict && (!asked || asked.has(file.path)));

            const untracked = picked.filter(file => file.index === "?");

            // A staged new file has nothing to go back to on disk but the
            // staged copy - restoring the working copy from it.
            const tracked = picked.filter(file => file.index !== "?" && file.work !== ".");

            if (tracked.length)
                await run(["restore", "--worktree", "--", ...tracked.map(file => file.path)]);

            // Never deleted: moved to the trash, as Undo does.
            for (const file of untracked)
                await deps.trash(path.join(root, file.path));

            return undefined;
        }

        case "commit": {

            const message = checkMessage(action.message, !action.amend);

            if (action.all)
                await run(["add", "-A"]);

            const args = ["commit"];

            if (action.amend)
                args.push("--amend");

            if (message)
                args.push("-m", message);
            else
                args.push("--no-edit");

            return shortText(await run(args));
        }

        case "undoCommit": {

            if (!await hasHead(root))
                throw new GitError("There is no commit to undo.");

            let hasParent = true;

            try {

                await run(["rev-parse", "--verify", "--quiet", "HEAD~1"]);

            } catch {

                hasParent = false;
            }

            // The first commit has no parent to go back to: the branch is
            // emptied, and its files stay staged.
            await run(hasParent ? ["reset", "--soft", "HEAD~1"] : ["update-ref", "-d", "HEAD"]);

            return undefined;
        }

        case "fetch":
            return shortText(await run(["fetch", "--all", "--prune"], NETWORK_MS)) || undefined;

        case "pull":
            return shortText(await run(action.rebase ? ["pull", "--rebase"] : ["pull", "--no-edit"], NETWORK_MS));

        case "push":
            return shortText(await push(root)) || undefined;

        case "sync": {

            const pulled = await run(["pull", "--no-edit"], NETWORK_MS);
            const pushed = await push(root);

            return shortText(`${pulled}\n${pushed}`) || undefined;
        }

        case "pushTags":
            return shortText(await run(["push", "--tags"], NETWORK_MS)) || undefined;

        case "switch": {

            const name = checkName(action.branch, "branch name");

            if (!action.remote) {

                await run(["switch", name]);

                return undefined;
            }

            // A remote branch: its local branch when there is one, else a
            // new one that tracks it.
            const local = name.slice(name.indexOf("/") + 1);

            let exists = true;

            try {

                await run(["rev-parse", "--verify", "--quiet", `refs/heads/${local}`]);

            } catch {

                exists = false;
            }

            await run(exists ? ["switch", local] : ["switch", "--track", name]);

            return undefined;
        }

        case "createBranch": {

            const name = checkName(action.name, "branch name");

            await run(["check-ref-format", "--branch", name]);

            await run(action.from ? ["switch", "-c", name, checkName(action.from, "branch name")] : ["switch", "-c", name]);

            return undefined;
        }

        case "renameBranch": {

            const from = checkName(action.from, "branch name");
            const to = checkName(action.to, "branch name");

            await run(["check-ref-format", "--branch", to]);
            await run(["branch", "-m", from, to]);

            return undefined;
        }

        case "deleteBranch": {

            const name = checkName(action.name, "branch name");

            await run(["branch", action.force ? "-D" : "-d", name]);

            return undefined;
        }

        case "merge":
            return shortText(await run(["merge", "--no-edit", checkName(action.branch, "branch name")]));

        case "rebase":
            return shortText(await run(["rebase", checkName(action.branch, "branch name")]));

        case "continue":
        case "abort": {

            const operation = await operationOf(root);

            if (!operation)
                throw new GitError("Nothing to continue or abort - no merge, rebase, cherry-pick or revert is in progress.");

            const step = action.kind === "continue" ? "--continue" : "--abort";

            // A merge has no --continue before git 2.12; a commit with the
            // prepared message is the same.
            const args = operation === "merge" && action.kind === "continue"
                ? ["-c", "core.editor=true", "commit", "--no-edit"]
                : ["-c", "core.editor=true", operation, step];

            return shortText(await run(args)) || undefined;
        }

        case "stash": {

            const message = typeof action.message === "string" ? action.message.trim() : "";

            if (message.length > 1000 || /[\0\r\n]/.test(message))
                throw new GitError("A stash message is one line.");

            return shortText(await run(["stash", "push", "--include-untracked", ...(message ? ["-m", message] : [])]));
        }

        case "stashApply":
            return shortText(await run(["stash", "apply", checkIndex(action.index)]));

        case "stashPop":
            return shortText(await run(["stash", "pop", checkIndex(action.index)]));

        case "stashDrop":
            await run(["stash", "drop", checkIndex(action.index)]);

            return undefined;

        case "createTag": {

            const name = checkName(action.name, "tag name");

            await run(["check-ref-format", `refs/tags/${name}`]);

            const message = typeof action.message === "string" ? action.message.trim() : "";

            if (message.length > 100_000 || message.includes("\0"))
                throw new GitError("That message is too long.");

            await run(message ? ["tag", "-a", name, "-m", message] : ["tag", name]);

            return undefined;
        }

        case "deleteTag":
            await run(["tag", "-d", checkName(action.name, "tag name")]);

            return undefined;

        case "addRemote":
            await run(["remote", "add", checkName(action.name, "remote name"), checkUrl(action.url)]);

            return undefined;

        case "removeRemote":
            await run(["remote", "remove", checkName(action.name, "remote name")]);

            return undefined;

        case "revert":
            return shortText(await run(["revert", "--no-edit", checkHash(action.hash)]));

        case "cherryPick":
            return shortText(await run(["cherry-pick", checkHash(action.hash)]));

        case "checkoutCommit":
            await run(["switch", "--detach", checkHash(action.hash)]);

            return undefined;

        case "takeOurs":
        case "takeTheirs": {

            const paths = checkPaths(root, action.paths);

            await run(["checkout", action.kind === "takeOurs" ? "--ours" : "--theirs", "--", ...paths]);
            await run(["add", "--", ...paths]);

            return undefined;
        }

        case "resolve":
            await run(["add", "--", ...checkPaths(root, action.paths)]);

            return undefined;
    }
}

/** Whether a value the page sent is an action this file knows - its fields are checked as it runs. */
export function isGitAction(value: unknown): value is GitAction {

    const kinds: readonly GitAction["kind"][] = [
        "stage", "stageAll", "unstage", "unstageAll", "discard", "discardAll", "commit", "undoCommit",
        "fetch", "pull", "push", "sync", "pushTags", "switch", "createBranch", "renameBranch", "deleteBranch",
        "merge", "rebase", "continue", "abort", "stash", "stashApply", "stashPop", "stashDrop", "createTag",
        "deleteTag", "addRemote", "removeRemote", "revert", "cherryPick", "checkoutCommit", "takeOurs",
        "takeTheirs", "resolve"
    ];

    return typeof value === "object" && value !== null && (kinds as readonly unknown[]).includes((value as { kind?: unknown }).kind);
}

/** Changes under these parts of `.git` never change what the panel shows. */
const QUIET = /[\\/]\.git[\\/](objects|logs|lfs|hooks)([\\/]|$)|\.lock$/;

/**
 * Watches repositories while a tab's git panel is open: any change in one
 * calls `changed(root)` once things are quiet for a moment. Changes deep in
 * `.git` (objects, logs) and lock files are left out.
 */
export class RepoWatch {

    private readonly watchers = new Map<string, { watcher: fs.FSWatcher; timer?: ReturnType<typeof setTimeout> }>();

    constructor(private readonly changed: (root: string) => void, private readonly quietMs = 400) { }

    /** Watches exactly these repositories from now on. */
    set(roots: readonly string[]): void {

        const wanted = new Map(roots.map(root => [sameKey(root), root]));

        for (const [key, one] of [...this.watchers])
            if (!wanted.has(key)) {

                clearTimeout(one.timer);
                one.watcher.close();
                this.watchers.delete(key);
            }

        for (const [key, root] of wanted) {

            if (this.watchers.has(key))
                continue;

            let watcher: fs.FSWatcher;

            try {

                watcher = fs.watch(root, { recursive: true });

            } catch {

                // Not watchable here - the Refresh button still works.
                continue;
            }

            const entry: { watcher: fs.FSWatcher; timer?: ReturnType<typeof setTimeout> } = { watcher };

            watcher.on("change", (_event, file) => {

                if (typeof file === "string" && QUIET.test(path.join(root, file)))
                    return;

                clearTimeout(entry.timer);
                entry.timer = setTimeout(() => this.changed(root), this.quietMs);
            });

            // A folder removed under the watch: it stops quietly.
            watcher.on("error", () => undefined);

            this.watchers.set(key, entry);
        }
    }

    close(): void {

        this.set([]);
    }
}

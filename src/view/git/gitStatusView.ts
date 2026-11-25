import type { GitGroup, GitPanelCommit, GitPanelCommitFile, GitPanelRepo, GitPanelRow, PathTreeNode } from "../ui";

/*
 * What the Git panel shows for a repository, worked out from its status.
 * No React here, so it can be tested alone. The panel itself only draws
 * what this file hands it.
 */

/** A changed file, as `git status` gives it. */
export interface GitPanelFile {

    /** Relative to the repository, with forward slashes. */
    path: string;

    /** A renamed file's old path. */
    from?: string;

    /** The staged letter, "." for none, "?" for a file git does not track. */
    index: string;

    /** The letter on disk, "." for none. */
    work: string;

    /** Both sides changed it in a merge, rebase or cherry-pick. */
    conflict?: boolean;
}

/** A merge, rebase, cherry-pick or revert that stopped part way. */
export type GitPanelOperation = "merge" | "rebase" | "cherry-pick" | "revert";

/** One repository's state, as the server sends it. */
export interface GitRepoStatus {

    /** Its folder - also its key. */
    root: string;

    name: string;

    /** The branch checked out. None: a detached commit. */
    branch?: string;

    /** The commit checked out. None: no commit yet. */
    commit?: string;

    upstream?: string;

    ahead: number;

    behind: number;

    stashes: number;

    files: GitPanelFile[];

    operation?: GitPanelOperation;
}

/** A commit, as the server sends it. */
export interface GitCommitInfo {

    hash: string;

    short: string;

    author: string;

    /** In ms. */
    at: number;

    subject: string;

    /** The branches and tags pointing at it, as git writes them. */
    refs?: string;
}

/** A file of a commit, as the server sends it. */
export interface GitCommitFileInfo {

    path: string;

    from?: string;

    status: string;
}

/** The rows of each list, in path order. `isAgentFile` says which files the agent changed. */
export function groupsOf(files: readonly GitPanelFile[], isAgentFile: (path: string) => boolean = () => false): Record<GitGroup, GitPanelRow[]> {

    const groups: Record<GitGroup, GitPanelRow[]> = { conflicts: [], staged: [], changes: [] };

    const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

    const row = (file: GitPanelFile, group: GitGroup, letter: string): GitPanelRow => {

        const { name, folder } = splitPath(file.path);

        return { file, group, letter, letterTitle: letterText(letter), name, folder, byAgent: isAgentFile(file.path) };
    };

    for (const file of sorted) {

        if (file.conflict) {

            groups.conflicts.push(row(file, "conflicts", "!"));

            continue;
        }

        if (file.index === "?") {

            groups.changes.push(row(file, "changes", "U"));

            continue;
        }

        if (file.index !== ".")
            groups.staged.push(row(file, "staged", file.index));

        if (file.work !== ".")
            groups.changes.push(row(file, "changes", file.work));
    }

    return groups;
}

const LETTER_TEXT: Record<string, string> = {
    M: "Changed",
    A: "Added",
    D: "Deleted",
    R: "Renamed",
    C: "Copied",
    T: "Type changed",
    U: "New file, not tracked by git yet",
    "!": "Conflict - both sides changed it"
};

/** What a git letter means, in words. */
export function letterText(letter: string): string {

    return LETTER_TEXT[letter] ?? letter;
}

/** A path as a row shows it: the file's name, and the folder it is in. */
export function splitPath(file: string): { name: string; folder: string } {

    const at = file.lastIndexOf("/");

    return at < 0 ? { name: file, folder: "" } : { name: file.slice(at + 1), folder: file.slice(0, at) };
}

/**
 * Items with paths as a folder tree:
 * folders first, then files, each by name. A folder that holds only one
 * folder and nothing else is shown on the same row as it ("src/core").
 */
export function pathTree<T>(items: readonly T[], pathOf: (item: T) => string): PathTreeNode<T>[] {

    interface Draft {
        folders: Map<string, Draft>;
        files: { kind: "file"; path: string; name: string; item: T }[];
        items: T[];
    }

    const top: Draft = { folders: new Map(), files: [], items: [] };

    for (const item of items) {

        const parts = pathOf(item).split("/").filter(Boolean);
        const name = parts.pop() ?? "";
        let at = top;

        for (const part of parts) {

            let next = at.folders.get(part);

            if (!next) {

                next = { folders: new Map(), files: [], items: [] };
                at.folders.set(part, next);
            }

            next.items.push(item);
            at = next;
        }

        at.files.push({ kind: "file", path: pathOf(item), name, item });
    }

    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

    const nodes = (draft: Draft, prefix: string): PathTreeNode<T>[] => {

        const folders: PathTreeNode<T>[] = [];

        for (const [part, sub] of draft.folders) {

            let name = part;
            let path = prefix + part;
            let inner = sub;

            // Only one folder inside and no files: one row for both.
            while (inner.files.length === 0 && inner.folders.size === 1) {

                const [nextPart, next] = [...inner.folders][0];

                name += `/${nextPart}`;
                path += `/${nextPart}`;
                inner = next;
            }

            folders.push({ kind: "folder", path, name, children: nodes(inner, `${path}/`), items: sub.items });
        }

        return [...folders.sort(byName), ...[...draft.files].sort(byName)];
    };

    return nodes(top, "");
}

/** The branch's name, or the short commit when none is checked out. */
export function branchLabel(status: Pick<GitRepoStatus, "branch" | "commit">): string {

    if (status.branch)
        return status.branch;

    return status.commit ? `${status.commit.slice(0, 8)} (no branch)` : "No commit yet";
}

/** Commits to pull and to push - or Publish for a branch with no upstream. */
export function syncLabel(status: Pick<GitRepoStatus, "branch" | "upstream" | "ahead" | "behind">): string {

    if (!status.branch)
        return "";

    if (!status.upstream)
        return "Publish";

    if (!status.ahead && !status.behind)
        return "Sync";

    return [status.behind ? `↓${status.behind}` : "", status.ahead ? `↑${status.ahead}` : ""].filter(Boolean).join(" ");
}

/** The hover text that goes with `syncLabel`. */
export function syncTitle(status: Pick<GitRepoStatus, "branch" | "upstream" | "ahead" | "behind">): string {

    if (!status.upstream)
        return "Push this branch and set it to track the remote branch of the same name";

    const parts = [
        status.behind ? `${status.behind} commit${status.behind === 1 ? "" : "s"} to pull` : "",
        status.ahead ? `${status.ahead} commit${status.ahead === 1 ? "" : "s"} to push` : ""
    ].filter(Boolean);

    return `Pull, then push (${status.upstream})${parts.length ? ` - ${parts.join(", ")}` : " - up to date the last time it was fetched"}`;
}

const OPERATION_TEXT: Record<GitPanelOperation, string> = {
    merge: "A merge stopped part way",
    rebase: "A rebase stopped part way",
    "cherry-pick": "A cherry-pick stopped part way",
    revert: "A revert stopped part way"
};

/** What to say about a merge or rebase that stopped. */
export function operationText(operation: GitPanelOperation): string {

    return `${OPERATION_TEXT[operation]}. Fix the conflicts, then Continue - or Abort to go back to where it started.`;
}

/** "5 min ago", "yesterday", or a date - for the commit list. */
export function shortAgo(at: number, now: number): string {

    const minutes = Math.floor((now - at) / 60_000);

    if (minutes < 1)
        return "just now";

    if (minutes < 60)
        return `${minutes} min ago`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24)
        return `${hours} h ago`;

    const days = Math.floor(hours / 24);

    if (days === 1)
        return "yesterday";

    if (days < 30)
        return `${days} days ago`;

    return new Date(at).toLocaleDateString();
}

/**
 * The refs of a commit as the panel draws them: a name for each, and whether
 * it is a remote branch - it starts with the upstream's remote name, "origin/main".
 */
export function commitRefs(refs: string | undefined, upstream: string | undefined): { name: string; remote: boolean }[] {

    const remote = upstream?.split("/")[0];

    return (refs ?? "")
        .split(",")
        .map(ref => ref.trim())
        .filter(Boolean)
        .map(ref => ({ name: ref.replace(/^HEAD -> /, ""), remote: !!remote && ref.startsWith(`${remote}/`) }));
}

/** A commit as Graph draws it. */
export function panelCommit(commit: GitCommitInfo, upstream: string | undefined, now: number): GitPanelCommit {

    return {
        hash: commit.hash,
        short: commit.short,
        author: commit.author,
        at: commit.at,
        subject: commit.subject,
        refs: commitRefs(commit.refs, upstream),
        ago: shortAgo(commit.at, now)
    };
}

/** A file of a commit as the panel draws it. */
export function panelCommitFile(file: GitCommitFileInfo): GitPanelCommitFile {

    return { ...file, ...splitPath(file.path), statusTitle: letterText(file.status) };
}

/** A repository as the panel draws it: its lists, their trees, and every label. */
export function panelRepo(repo: GitRepoStatus, isAgentFile: (path: string) => boolean): GitPanelRepo {

    const groups = groupsOf(repo.files, isAgentFile);

    return {
        root: repo.root,
        name: repo.name,
        branch: repo.branch,
        commit: repo.commit,
        upstream: repo.upstream,
        ahead: repo.ahead,
        behind: repo.behind,
        fileCount: repo.files.length,
        groups,
        trees: {
            conflicts: pathTree(groups.conflicts, row => row.file.path),
            staged: pathTree(groups.staged, row => row.file.path),
            changes: pathTree(groups.changes, row => row.file.path)
        },
        branchLabel: branchLabel(repo),
        // The Repositories list says nothing for a branch that is up to date: only commits waiting, or Publish.
        syncLabel: repo.upstream && !repo.ahead && !repo.behind ? "" : syncLabel(repo),
        syncTitle: syncTitle(repo),
        operationText: repo.operation ? operationText(repo.operation) : undefined
    };
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentFile } from "../view/chat/pendingChanges";
import { createBranchName, filterBranches } from "../view/git/branchFilter";
import { branchLabel, groupsOf, panelCommit, panelCommitFile, panelRepo, pathTree, splitPath } from "../view/git/gitStatusView";
import {
    BranchDialog, type BranchPick, FormDialog, type GitFormField, GitPanel, type GitPanelMenuItem, type GitPanelNote, type GitPanelOpened, PickDialog,
    StashDialog
} from "../view/ui";
import {
    API, ChatInfo, GitAction, GitCommit, GitCommitFile, GitDiffAsk, GitLists, GitStatus, PromptRequest
} from "../server/protocol";
import { bridge } from "./bridge";
import "./gitPane.scss";
import { PromptDialog } from "./Dialogs";
import { pathKey } from "./fileMarks";
import { discardQuestion } from "./gitView";
import { loadGitTree, saveGitTree } from "./sideState";

/*
 * The Git view of the side panel. The panel itself is drawn by the UI
 * library's GitPanel, and its windows by the library's GitDialogs. This file reads the repositories
 * from the server, runs every action, asks before anything that cannot
 * be undone, and builds the "..." menus.
 *
 * Every button is the person's: the agent never uses this panel. While
 * the agent works, the buttons that change a repository are off; reading
 * still works.
 *
 * The server watches the repositories while the Git view or a git tab is
 * open (App.tsx turns the watch on) and says when one changed, so the
 * panel reads it again by itself.
 *
 * A click on a file opens its diff as a tab: one click in
 * the preview tab, a double-click keeps the tab.
 */

/** One commit's files, shown in place of the lists. */
interface Opened { root: string; commit: GitCommit; files?: GitCommitFile[]; problem?: string }

/** What a diff tab gets: its repository, its name, its hover text and what to read. */
export interface DiffOpen { root: string; title: string; tip: string; ask: GitDiffAsk }

type Dialog =
    | { kind: "prompt"; prompt: PromptRequest; run(value: string): void }
    | { kind: "form"; title: string; text?: string; fields: GitFormField[]; submit: string; run(values: Record<string, string>): void }
    | { kind: "branch"; title: string; root: string; remote: boolean; allowCreate?: boolean; run(pick: BranchPick): void }
    | { kind: "pick"; title: string; items: { key: string; label: string; note?: string }[]; empty: string; run(key: string): void }
    | { kind: "stashes"; root: string };

/** A menu item. `writes`: it changes the repository, so it is off while the agent works or an action runs. */
interface MenuItem extends Omit<GitPanelMenuItem, "disabled"> { writes?: boolean }

/** The folders' own names, for the empty state: "a", "a and b", "a, b and c". */
function folderNames(folders: readonly string[]): string {

    const names = folders.map(folder => folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder);

    return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] ?? "";
}

const request = <T,>(route: string, body: Record<string, unknown>) => bridge.request<T>(route, { view: bridge.view, ...body });

export default function GitPane({ chat, hidden, running, agentFiles, onRepos, onOpenDiff }: {
    chat: ChatInfo;

    /** Another view of the right panel is shown: this one stays on the page, hidden. */
    hidden?: boolean;

    /** The agent is working: nothing that changes a repository runs. */
    running: boolean;

    /** The files this chat's turns changed - their rows get the purple mark. */
    agentFiles: readonly AgentFile[];

    /** Told the repositories each time they are read - the file tabs use them. */
    onRepos?(repos: GitStatus[]): void;

    /** A click on a file (`keep` false) or a double-click (`keep` true): its diff as a tab. */
    onOpenDiff(diff: DiffOpen, keep: boolean): void;
}) {

    const [repos, setRepos] = useState<GitStatus[] | undefined>();
    const [problems, setProblems] = useState<{ root: string; problem: string }[]>([]);
    const [loadProblem, setLoadProblem] = useState<string | undefined>();

    /** The repository an action is running in. */
    const [busy, setBusy] = useState<string | undefined>();

    /** The repository whose AI button is writing a message. */
    const [writing, setWriting] = useState<string | undefined>();

    const [notes, setNotes] = useState<Record<string, GitPanelNote | undefined>>({});
    const [messages, setMessages] = useState<Record<string, string>>({});
    const [lists, setLists] = useState<Record<string, GitLists | undefined>>({});
    const [commits, setCommits] = useState<Record<string, GitCommit[] | undefined>>({});

    /** Parts closed or open: `<root>|graph`, `<root>|<list>`. */
    const [open, setOpen] = useState<Record<string, boolean>>({});

    /** With several repositories: the one picked in the Repositories list. Nothing: the first. */
    const [picked, setPicked] = useState<string | undefined>();

    const [opened, setOpened] = useState<Opened | undefined>();

    /** Files as a folder tree instead of a flat list. Kept in this browser across reloads. */
    const [tree, setTree] = useState(loadGitTree);

    const changeTree = (next: boolean): void => {

        setTree(next);
        saveGitTree(next);
    };
    const [dialog, setDialog] = useState<Dialog | undefined>();

    /** The text typed in the branch window's box. */
    const [branchText, setBranchText] = useState("");

    // ---------------------------------------------------------------
    // Reading
    // ---------------------------------------------------------------

    /** One read at a time; a change that comes in during one reads again after it. */
    const reading = useRef<{ now: boolean; again: boolean }>({ now: false, again: false });

    const openRef = useRef(open);
    openRef.current = open;

    const commitsRef = useRef(commits);
    commitsRef.current = commits;

    const loadCommits = useCallback(async (root: string) => {

        const answer = await request<{ commits?: GitCommit[] }>(API.gitCommits, { root });

        setCommits(current => ({ ...current, [root]: answer.commits ?? [] }));
    }, []);

    const loadLists = useCallback(async (root: string): Promise<GitLists | undefined> => {

        const answer = await request<Partial<GitLists>>(API.gitLists, { root });

        if (!answer.branches) {

            setNotes(current => ({ ...current, [root]: { text: answer.problem ?? "Could not read the branches.", error: true } }));

            return undefined;
        }

        const read = answer as GitLists;

        setLists(current => ({ ...current, [root]: read }));

        return read;
    }, []);

    const load = useCallback(async () => {

        if (reading.current.now) {

            reading.current.again = true;

            return;
        }

        reading.current.now = true;

        try {

            do {

                reading.current.again = false;

                const answer = await request<{ repos?: GitStatus[]; problems?: { root: string; problem: string }[] }>(API.gitStatus, {});

                if (!answer.repos) {

                    setLoadProblem(answer.problem ?? "Could not read the repositories.");

                    continue;
                }

                setLoadProblem(undefined);
                setRepos(answer.repos);
                setProblems(answer.problems ?? []);

                // The graphs already read are read again too.
                for (const repo of answer.repos)
                    if ((openRef.current[`${repo.root}|graph`] ?? false) && commitsRef.current[repo.root])
                        void loadCommits(repo.root);

            } while (reading.current.again);

        } catch {

            setLoadProblem("Could not reach the server.");

        } finally {

            reading.current.now = false;
        }
    }, [loadCommits]);

    // Other folders, another chat: read from the top.
    const folderKey = [chat.chatId, ...chat.folders].join("|");

    useEffect(() => {

        setRepos(undefined);
        setOpened(undefined);
        setLists({});
        setCommits({});
        setPicked(undefined);

        void load();

    }, [folderKey, load]);

    // A repository changed, or the stream came back (the server may have
    // restarted - the page turns its watch back on).
    useEffect(() => bridge.onPage(message => {

        if (message.type === "eesha.gitChanged" || message.type === "eesha.hello")
            void load();

    }), [load]);

    /** The repository on screen: the picked one, or the first. */
    const shown = repos?.find(repo => repo.root === picked) ?? repos?.[0];
    const shownRoot = shown?.root;

    // Its Graph is closed at first. Once opened, its commits are read once.
    useEffect(() => {

        if (shownRoot && (open[`${shownRoot}|graph`] ?? false) && !commits[shownRoot])
            void loadCommits(shownRoot);

    }, [shownRoot, open, commits, loadCommits]);

    const tellRepos = useRef(onRepos);
    tellRepos.current = onRepos;

    useEffect(() => { if (repos) tellRepos.current?.(repos); }, [repos]);

    /** The agent's files, by `pathKey` of their full path. */
    const agentKeys = useMemo(() => new Set(agentFiles.map(one => pathKey(one.path))), [agentFiles]);

    /** What the panel draws: each repository's lists, trees and labels, worked out here. */
    const panelRepos = useMemo(
        () => repos?.map(repo => panelRepo(repo, path => agentKeys.has(pathKey(`${repo.root}/${path}`)))),
        [repos, agentKeys]);

    /** Graph's commits with their refs and "ago" text. The text is worked out again each time the page draws. */
    const panelCommits = useMemo(() => {

        const now = Date.now();
        const result: Record<string, ReturnType<typeof panelCommit>[] | undefined> = {};

        for (const [root, list] of Object.entries(commits))
            result[root] = list?.map(item => panelCommit(item, repos?.find(one => one.root === root)?.upstream, now));

        return result;
    }, [commits, repos]);

    /** The commit shown in place of the lists, as the panel draws it. */
    const panelOpened = useMemo((): GitPanelOpened | undefined => {

        if (!opened)
            return undefined;

        const files = opened.files?.map(panelCommitFile);

        return {
            root: opened.root,
            commit: panelCommit(opened.commit, repos?.find(one => one.root === opened.root)?.upstream, Date.now()),
            ...(files ? { files, tree: pathTree(files, file => file.path) } : {}),
            ...(opened.problem ? { problem: opened.problem } : {})
        };
    }, [opened, repos]);

    // A turn ended: what the agent did is in the lists.
    const wasRunning = useRef(running);

    useEffect(() => {

        if (wasRunning.current && !running)
            void load();

        wasRunning.current = running;

    }, [running, load]);

    // ---------------------------------------------------------------
    // Acting
    // ---------------------------------------------------------------

    /** Buttons that change a repository are off while the agent works or any action runs. */
    const off = running || busy !== undefined;

    const note = (root: string, value: GitPanelNote | undefined): void => setNotes(current => ({ ...current, [root]: value }));

    /** Runs one action; git's words go under the repository's name. True when it worked. */
    const act = async (root: string, action: GitAction): Promise<boolean> => {

        setBusy(root);
        note(root, undefined);

        try {

            const answer = await request<{ ok?: boolean; text?: string }>(API.gitAction, { root, action });

            if (!answer.ok) {

                note(root, { text: answer.problem ?? "Git did not say what went wrong.", error: true });

                return false;
            }

            if (answer.text)
                note(root, { text: answer.text });

            return true;

        } catch {

            note(root, { text: "Could not reach the server.", error: true });

            return false;

        } finally {

            setBusy(undefined);

            await load();

            if (lists[root])
                void loadLists(root);
        }
    };

    const ask = (prompt: PromptRequest, run: (value: string) => void): void => setDialog({ kind: "prompt", prompt, run });

    const confirm = (text: string, action: string, run: () => void): void => ask({ kind: "confirm", text, action }, () => run());

    const pickBranch = async (root: string, title: string, remote: boolean, run: (pick: BranchPick) => void, allowCreate = false): Promise<void> => {

        if (!await loadLists(root))
            return;

        setBranchText("");
        setDialog({ kind: "branch", title, root, remote, allowCreate, run });
    };

    const commit = (repo: GitStatus, how: "commit" | "all" | "amend"): void => {

        const message = messages[repo.root] ?? "";
        const groups = groupsOf(repo.files);

        if (how !== "amend" && !message.trim())
            return note(repo.root, { text: "Type a commit message first - or use the AI button to write one.", error: true });

        if (how !== "amend" && !groups.staged.length && !groups.changes.length && !groups.conflicts.length)
            return note(repo.root, { text: "Nothing to commit - no file has changed.", error: true });

        const run = async (all: boolean): Promise<void> => {

            if (await act(repo.root, { kind: "commit", message, ...(all ? { all: true } : {}), ...(how === "amend" ? { amend: true } : {}) }))
                setMessages(current => ({ ...current, [repo.root]: "" }));
        };

        // Nothing staged: ask to stage everything.
        if (how === "commit" && !groups.staged.length)
            return confirm("There are no staged changes. Stage all the changes and commit them?", "Stage all and commit", () => void run(true));

        void run(how === "all");
    };

    /** The AI button: a message from a hidden session, or - while one runs - stop it. */
    const writeMessage = async (root: string): Promise<void> => {

        if (writing === root) {

            void request(API.gitMessage, { stop: true });

            return;
        }

        setWriting(root);
        note(root, undefined);

        try {

            const answer = await request<{ message?: string }>(API.gitMessage, { root });

            if (answer.message !== undefined)
                setMessages(current => ({ ...current, [root]: answer.message! }));
            else if (answer.problem !== "Stopped.")
                note(root, { text: answer.problem ?? "No message came back.", error: true });

        } catch {

            note(root, { text: "Could not reach the server.", error: true });

        } finally {

            setWriting(current => current === root ? undefined : current);
        }
    };

    /** A file's diff as a tab: its name, and a hover text with the repository when there are several. */
    const openDiff = (root: string, path: string, where: string, diffAsk: GitDiffAsk, keep: boolean) => {

        const several = (repos?.length ?? 0) > 1;
        const repoName = several ? repos?.find(one => one.root === root)?.name : undefined;

        onOpenDiff({ root, title: splitPath(path).name, tip: `${repoName ? `${repoName}: ` : ""}${path} - ${where}`, ask: diffAsk }, keep);
    };

    const showCommit = async (root: string, item: GitCommit): Promise<void> => {

        setOpened({ root, commit: item });

        const answer = await request<{ files?: GitCommitFile[] }>(API.gitCommitFiles, { root, hash: item.hash });

        setOpened(current => current?.commit.hash === item.hash
            ? { ...current, ...(answer.files ? { files: answer.files } : { problem: answer.problem ?? "Could not read the commit." }) }
            : current);
    };

    /** The library's menu items: the ones that change the repository are off while `off`. */
    const items = (list: MenuItem[]): GitPanelMenuItem[] =>
        list.map(({ writes, ...item }) => ({ ...item, ...(writes && off ? { disabled: true } : {}) }));

    /** The repository's "..." menu: remote steps, branches, stash, tags, remotes, commits. */
    const repoMenu = (repo: GitStatus): MenuItem[] => {

        const root = repo.root;
        const branch = repo.branch;
        const label = branchLabel(repo);

        return [
            { label: "Fetch", icon: "cloud-download", writes: true, onSelect: () => void act(root, { kind: "fetch" }) },
            { label: "Pull", icon: "arrow-down", writes: true, onSelect: () => void act(root, { kind: "pull" }) },
            { label: "Pull (rebase)", writes: true, onSelect: () => void act(root, { kind: "pull", rebase: true }) },
            { label: "Push", icon: "arrow-up", writes: true, onSelect: () => void act(root, { kind: "push" }) },
            { label: "Sync (pull, then push)", icon: "sync", writes: true, onSelect: () => void act(root, { kind: "sync" }) },

            {
                label: "Switch branch...", icon: "branch", writes: true, line: true,
                onSelect: () => void pickBranch(root, "Switch to a branch", true, pick => {
                    setDialog(undefined);
                    void act(root, "create" in pick ? { kind: "createBranch", name: pick.create } : { kind: "switch", branch: pick.branch.name, remote: pick.branch.remote });
                }, true)
            },
            {
                label: "Create branch...", icon: "add", writes: true,
                onSelect: () => setDialog({
                    kind: "form", title: "Create branch", text: "A new branch from the commit checked out now. The panel switches to it.",
                    fields: [{ key: "name", label: "Branch name", required: true }], submit: "Create",
                    run: values => { setDialog(undefined); void act(root, { kind: "createBranch", name: values.name.trim() }); }
                })
            },
            {
                label: "Create branch from...", writes: true,
                onSelect: () => void pickBranch(root, "Create a branch from", true, pick => {

                    if ("create" in pick)
                        return;

                    setDialog({
                        kind: "form", title: "Create branch", text: `A new branch from ${pick.branch.name}. The panel switches to it.`,
                        fields: [{ key: "name", label: "Branch name", required: true }], submit: "Create",
                        run: values => { setDialog(undefined); void act(root, { kind: "createBranch", name: values.name.trim(), from: pick.branch.name }); }
                    });
                })
            },
            ...(branch
                ? [{
                    label: "Rename branch...", writes: true,
                    onSelect: () => setDialog({
                        kind: "form", title: "Rename branch", fields: [{ key: "name", label: "New name", value: branch, required: true }], submit: "Rename",
                        run: values => { setDialog(undefined); void act(root, { kind: "renameBranch", from: branch, to: values.name.trim() }); }
                    })
                } as MenuItem]
                : []),
            {
                label: "Delete branch...", writes: true,
                onSelect: () => void pickBranch(root, "Delete a branch", false, pick => {

                    if ("create" in pick)
                        return;

                    setDialog(undefined);

                    void (async () => {

                        const name = pick.branch.name;

                        if (await act(root, { kind: "deleteBranch", name }))
                            return;

                        // Git refuses a branch that is not merged: one more question, then force.
                        confirm(`Git did not delete '${name}': its commits are not merged into another branch. Delete it anyway? Those commits are then only reachable by their ids.`,
                            "Delete anyway", () => void act(root, { kind: "deleteBranch", name, force: true }));
                    })();
                })
            },
            {
                label: "Merge branch into this one...", icon: "merge", writes: true,
                onSelect: () => void pickBranch(root, `Merge a branch into ${label}`, true, pick => {
                    setDialog(undefined);
                    if (!("create" in pick)) void act(root, { kind: "merge", branch: pick.branch.name });
                })
            },
            {
                label: "Rebase this branch onto...", writes: true,
                onSelect: () => void pickBranch(root, `Rebase ${label} onto`, true, pick => {
                    setDialog(undefined);
                    if (!("create" in pick)) void act(root, { kind: "rebase", branch: pick.branch.name });
                })
            },

            {
                label: "Stash all changes...", icon: "package", writes: true, line: true,
                onSelect: () => setDialog({
                    kind: "form", title: "Stash all changes", text: "Puts every change aside - new files too - and leaves the files as in the last commit.",
                    fields: [{ key: "message", label: "Message" }], submit: "Stash",
                    run: values => { setDialog(undefined); void act(root, { kind: "stash", message: values.message }); }
                })
            },
            ...(repo.stashes
                ? [{
                    label: `Stashes (${repo.stashes})...`, icon: "archive",
                    onSelect: () => { setDialog({ kind: "stashes", root }); void loadLists(root); }
                } as MenuItem]
                : []),

            {
                label: "Create tag...", icon: "tag", writes: true, line: true,
                onSelect: () => setDialog({
                    kind: "form", title: "Create tag", text: "A tag on the commit checked out now. With a message it is an annotated tag.",
                    fields: [{ key: "name", label: "Tag name", required: true }, { key: "message", label: "Message" }], submit: "Create",
                    run: values => { setDialog(undefined); void act(root, { kind: "createTag", name: values.name.trim(), message: values.message }); }
                })
            },
            {
                label: "Delete tag...", writes: true,
                onSelect: () => void (async () => {
                    const read = await loadLists(root);
                    if (read) setDialog({
                        kind: "pick", title: "Delete a tag", empty: "This repository has no tags.",
                        items: read.tags.map(tag => ({ key: tag, label: tag })),
                        run: tag => { setDialog(undefined); void act(root, { kind: "deleteTag", name: tag }); }
                    });
                })()
            },
            { label: "Push tags", writes: true, onSelect: () => void act(root, { kind: "pushTags" }) },

            {
                label: "Add remote...", writes: true, line: true,
                onSelect: () => setDialog({
                    kind: "form", title: "Add remote",
                    fields: [{ key: "name", label: "Name", value: "origin", required: true }, { key: "url", label: "Address", placeholder: "https://github.com/owner/repo.git", required: true }],
                    submit: "Add",
                    run: values => { setDialog(undefined); void act(root, { kind: "addRemote", name: values.name.trim(), url: values.url.trim() }); }
                })
            },
            {
                label: "Remove remote...", writes: true,
                onSelect: () => void (async () => {
                    const read = await loadLists(root);
                    if (read) setDialog({
                        kind: "pick", title: "Remove a remote", empty: "This repository has no remotes.",
                        items: read.remotes.map(one => ({ key: one.name, label: one.name, note: one.url })),
                        run: name => { setDialog(undefined); void act(root, { kind: "removeRemote", name }); }
                    });
                })()
            },

            ...(repo.commit
                ? [{
                    label: "Undo last commit", icon: "undo", writes: true, line: true,
                    onSelect: () => void act(root, { kind: "undoCommit" })
                } as MenuItem]
                : [])
        ];
    };

    /** The repository the library hands back, as the server sent it. */
    const status = (root: string): GitStatus | undefined => repos?.find(one => one.root === root);

    /** The empty state when there is no repository. The server cannot make one (it has no "git init"), so there is no button. */
    const noRepo = chat.folders.length
        ? {
            title: "Not a git repository",
            text: `${folderNames(chat.folders)} ${chat.folders.length === 1 ? "has" : "have"} no git repository, so there is nothing to commit and no history. AI changes needs git too, because it records each turn in git.`
        }
        : { title: "No workspace", text: "This session is not tied to a workspace, so there is no git repository to show. Git and AI changes need a workspace." };

    const branchDialog = dialog?.kind === "branch" ? dialog : undefined;

    /** The branches the window can list: the remote ones only when it was asked for them. */
    const branchChoices = branchDialog ? (lists[branchDialog.root]?.branches ?? []).filter(one => branchDialog.remote || !one.remote) : [];

    return (
        <>
            <GitPanel
                hidden={hidden}
                repos={panelRepos}
                loadProblem={loadProblem}
                problems={problems}
                noRepo={noRepo}
                running={running}
                busy={busy !== undefined}
                picked={picked}
                onPick={root => { setPicked(root); setOpened(undefined); }}
                opened={panelOpened}
                onBack={() => setOpened(undefined)}
                notes={notes}
                onHideNote={root => note(root, undefined)}
                messages={messages}
                onMessage={(root, text) => setMessages(current => ({ ...current, [root]: text }))}
                writing={writing}
                onWriteMessage={root => void writeMessage(root)}
                commits={panelCommits}
                open={open}
                onOpenChange={(key, isOpen) => setOpen(current => ({ ...current, [key]: isOpen }))}
                onRefresh={() => void load()}
                tree={tree}
                onTreeChange={changeTree}
                repoMenu={repo => items(repoMenu(status(repo.root)!))}
                commitMenu={repo => items([
                    { label: "Commit all (stage everything first)", icon: "check-all", writes: true, onSelect: () => commit(status(repo.root)!, "all") },
                    { label: "Amend last commit", writes: true, onSelect: () => commit(status(repo.root)!, "amend") },
                    ...(repo.commit ? [{ label: "Undo last commit", icon: "undo", writes: true, onSelect: () => void act(repo.root, { kind: "undoCommit" }) } as MenuItem] : [])
                ])}
                graphMenu={(repo, item) => items([
                    { label: "Copy commit id", icon: "copy", onSelect: () => void navigator.clipboard?.writeText(item.hash) },
                    { label: "Revert this commit", icon: "undo", writes: true, line: true, onSelect: () => void act(repo.root, { kind: "revert", hash: item.hash }) },
                    { label: "Cherry-pick onto this branch", writes: true, onSelect: () => void act(repo.root, { kind: "cherryPick", hash: item.hash }) },
                    {
                        label: "Check out (no branch)", writes: true,
                        onSelect: () => confirm(`Check out ${item.short} with no branch? Commits made then belong to no branch until you create one.`, "Check out", () => void act(repo.root, { kind: "checkoutCommit", hash: item.hash }))
                    }
                ])}
                onCommit={repo => commit(status(repo.root)!, "commit")}
                onFileAction={(repo, action, rows, all) => {

                    const root = repo.root;
                    const paths = rows.map(row => row.file.path);

                    switch (action) {
                        case "stage": return void act(root, all ? { kind: "stageAll" } : { kind: "stage", paths });
                        case "unstage": return void act(root, all ? { kind: "unstageAll" } : { kind: "unstage", paths });
                        case "discard": return confirm(discardQuestion(rows), all ? "Discard all" : "Discard", () => void act(root, all ? { kind: "discardAll" } : { kind: "discard", paths }));
                        case "takeOurs": return void act(root, { kind: "takeOurs", paths });
                        case "takeTheirs": return void act(root, { kind: "takeTheirs", paths });
                        case "resolve": return void act(root, { kind: "resolve", paths });
                    }
                }}
                onSync={(repo, kind) => void act(repo.root, { kind })}
                onOperation={(repo, kind) => void act(repo.root, { kind })}
                onOpenFile={(repo, row, keep) => {

                    const side: GitDiffAsk["side"] = row.group === "conflicts" ? "conflict" : row.group === "staged" ? "staged" : "changes";
                    const where = row.group === "staged" ? "last commit and staged" : row.group === "conflicts" ? "last commit and now, with the conflict marks" : row.letter === "U" ? "new file" : "staged and now";

                    openDiff(repo.root, row.file.path, where, { side, path: row.file.path, ...(row.file.from && row.group === "staged" ? { from: row.file.from } : {}) }, keep);
                }}
                onOpenCommitFile={(one, file, keep) => {

                    const item = one.commit;

                    openDiff(one.root, file.path, `in ${item.short} ${item.subject}`, { side: "commit", path: file.path, commit: item.hash, ...(file.from ? { from: file.from } : {}) }, keep);
                }}
                onShowCommit={(root, item) => {

                    const full = commits[root]?.find(one => one.hash === item.hash);

                    if (full)
                        void showCommit(root, full);
                }} />

            {dialog?.kind === "prompt"
                ? (
                    <PromptDialog
                        prompt={dialog.prompt}
                        onAnswer={value => { setDialog(undefined); if (value !== undefined) dialog.run(value); }} />
                )
                : null}

            {dialog?.kind === "form"
                ? <FormDialog title={dialog.title} text={dialog.text} fields={dialog.fields} submit={dialog.submit} onSubmit={dialog.run} onClose={() => setDialog(undefined)} />
                : null}

            {branchDialog
                ? (
                    <BranchDialog
                        title={branchDialog.title}
                        branches={filterBranches(branchChoices, branchText)}
                        filter={branchText}
                        onFilterChange={setBranchText}
                        allowCreate={branchDialog.allowCreate}
                        createName={createBranchName(branchChoices, branchText, branchDialog.allowCreate)}
                        onPick={branchDialog.run}
                        onClose={() => setDialog(undefined)} />
                )
                : null}

            {dialog?.kind === "pick"
                ? <PickDialog title={dialog.title} items={dialog.items} empty={dialog.empty} onPick={dialog.run} onClose={() => setDialog(undefined)} />
                : null}

            {dialog?.kind === "stashes"
                ? (
                    <StashDialog
                        stashes={lists[dialog.root]?.stashes}
                        off={off}
                        onApply={index => { setDialog(undefined); void act(dialog.root, { kind: "stashApply", index }); }}
                        onPop={index => { setDialog(undefined); void act(dialog.root, { kind: "stashPop", index }); }}
                        onDrop={(index, text) => {
                            const root = dialog.root;
                            confirm(`Drop the stash '${text}'? It cannot be brought back from here.`, "Drop", () => void act(root, { kind: "stashDrop", index }));
                        }}
                        onClose={() => setDialog(undefined)} />
                )
                : null}
        </>
    );
}

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AgentFile } from "../view/chat/pendingChanges";
import { letterText } from "../view/git/gitStatusView";
import { type ExplorerMenuItem, type ExplorerRow, FileExplorer, type FileEntry } from "../view/ui";
import { API, ChatInfo, FileItem, GitStatus } from "../server/protocol";
import { bridge } from "./bridge";
import type { TabsState } from "./editorTabs";
import { agentTree, foldersAbove, gitIgnored, type GitMark, gitMarks, isIgnored, pathKey } from "./fileMarks";

/*
 * The Files view: the chat's folders as a tree. The tree itself is drawn
 * by the UI library's FileExplorer. This file reads the folders and git from the server,
 * keeps which folders are open, works out each row's marks, and says
 * what each click does. It only reads - nothing is made, renamed or
 * deleted here.
 *
 * A file opens as a tab: one click in the preview tab, a double-click
 * keeps it. The row's + button, or dragging the file onto the compose
 * box, puts it in the message as a file chip.
 */

/** The path inside the top folder that holds it, written as the path writes it. Nothing when no top folder holds it. */
function relativeTo(path: string, tops: readonly FileEntry[]): string | undefined {

    const owner = tops.find(one => pathKey(path).startsWith(pathKey(one.relativePath) + "/"));

    return owner ? path.slice(owner.relativePath.replace(/[\\/]+$/, "").length + 1) : undefined;
}

/** One folder's entries - the chat's folders for the top. A `problem` answer is thrown. */
async function listFolder(folder?: string): Promise<FileEntry[]> {

    const answer = await bridge.request<{ entries?: FileItem[] }>(API.files, { view: bridge.view, ...(folder ? { path: folder } : {}) });

    if (!answer.entries)
        throw new Error(answer.problem ?? "Could not list the files.");

    return answer.entries.map(one => ({ name: one.name, relativePath: one.path, isDirectory: one.folder }));
}

export default function FilesPane({ chat, hidden, current, running, agentFiles, tabs, onOpen, onAttach, onShowTab, onKeepTab, onCloseTab, onShowInGit, onShowAgentChange, onRepos, onAddFolder, onFindFile }: {
    chat: ChatInfo;

    /** Another view of the right panel is shown: this one stays on the page, hidden. */
    hidden?: boolean;

    /** The file in the open tab - its row is marked. */
    current?: string;

    /** The agent is working: when it stops, the git colors are read again. */
    running: boolean;

    /** The files this chat's turns changed - marked, and all the agent-only button shows. */
    agentFiles: readonly AgentFile[];

    /** The open tabs, for the Open tabs list. */
    tabs: TabsState;

    /** A click on a file (`keep` false) or a double-click or Enter (`keep` true). */
    onOpen(entry: FileEntry, keep: boolean): void;

    /** The row's + button, or Add to context in its menu. A folder goes as its path. */
    onAttach(entry: FileEntry): void;

    /** Open tabs: a click shows the tab, a double-click keeps it, the x closes it. */
    onShowTab(id: string): void;

    onKeepTab(id: string): void;

    onCloseTab(id: string): void;

    /** "Show in Git": the file's git diff, in the Git view. */
    onShowInGit(mark: GitMark): void;

    /** "Show what the agent changed": the file before the agent's first turn on it, and now. */
    onShowAgentChange(file: AgentFile): void;

    /** Told the repositories each time they are read - the file tabs use them. */
    onRepos?(repos: GitStatus[]): void;

    /** The "Add a folder" button of the empty state, when the session has no folder. No button without it. */
    onAddFolder?(): void;

    /** The search button in the title row: the find-a-file window. No button without it. */
    onFindFile?(): void;
}) {

    const [top, setTop] = useState<FileEntry[] | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    /** Each folder's entries once read; a folder not in here is not read yet. */
    const [loaded, setLoaded] = useState<Record<string, FileEntry[]>>({});
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [reading, setReading] = useState<Record<string, boolean>>({});

    /** The chat's repositories as git sees them - the colors and letters. */
    const [repos, setRepos] = useState<GitStatus[]>([]);

    /** Only the agent's files are on screen. */
    const [agentOnly, setAgentOnly] = useState(false);

    /** Folders closed by hand in the agent-only tree; every other one there is open. */
    const [agentClosed, setAgentClosed] = useState<Record<string, boolean>>({});

    // Another chat, or other folders: the tree is read again from the top,
    // with every folder closed, and the first folder opened.
    const resetKey = [chat.chatId, chat.scratch, ...chat.folders].join("|");

    useEffect(() => {

        let gone = false;

        setTop(undefined);
        setProblem(undefined);
        setLoaded({});
        setExpanded({});
        setAgentClosed({});

        listFolder().then(
            entries => {

                if (gone)
                    return;

                setTop(entries);

                const first = entries.find(entry => entry.isDirectory);

                if (first)
                    void openFolder(first.relativePath, () => gone, true);
            },
            (error: Error) => { if (!gone) setProblem(error.message); });

        return () => { gone = true; };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [resetKey]);

    /** The agent-only tree, while that button is pressed. */
    const onlyAgent = useMemo(() => agentOnly ? agentTree(agentFiles.map(one => one.path), top ?? []) : undefined, [agentOnly, agentFiles, top]);

    // ---------------------------------------------------------------
    // Git colors and the agent's marks
    // ---------------------------------------------------------------

    /** One read at a time; a change that comes in during one reads again after it. */
    const gitReading = useRef<{ now: boolean; again: boolean }>({ now: false, again: false });

    const loadGit = useCallback(async () => {

        if (gitReading.current.now) {

            gitReading.current.again = true;

            return;
        }

        gitReading.current.now = true;

        try {

            do {

                gitReading.current.again = false;

                const answer = await bridge.request<{ repos?: GitStatus[] }>(API.gitStatus, { view: bridge.view });

                // No colors is better than old ones when git cannot be read.
                setRepos(answer.repos ?? []);

            } while (gitReading.current.again);

        } catch {

            setRepos([]);

        } finally {

            gitReading.current.now = false;
        }
    }, []);

    useEffect(() => {

        setRepos([]);
        void loadGit();

    }, [resetKey, loadGit]);

    // A repository changed, or the stream came back.
    useEffect(() => bridge.onPage(message => {

        if (message.type === "eesha.gitChanged" || message.type === "eesha.hello")
            void loadGit();

    }), [loadGit]);

    // A turn ended: what the agent did is on disk now.
    const wasRunning = useRef(running);

    useEffect(() => {

        if (wasRunning.current && !running)
            void loadGit();

        wasRunning.current = running;

    }, [running, loadGit]);

    const marks = useMemo(() => gitMarks(repos), [repos]);
    const changedFolders = useMemo(() => foldersAbove(marks.keys()), [marks]);

    /** What .gitignore leaves out - drawn dimmed. */
    const ignored = useMemo(() => gitIgnored(repos), [repos]);

    const tellRepos = useRef(onRepos);
    tellRepos.current = onRepos;

    useEffect(() => { tellRepos.current?.(repos); }, [repos]);
    const agentByKey = useMemo(() => new Map(agentFiles.map(one => [pathKey(one.path), one])), [agentFiles]);

    // ---------------------------------------------------------------
    // The rows
    // ---------------------------------------------------------------

    const rows = useMemo(() => {

        const list: ExplorerRow[] = [];

        const walk = (entries: FileEntry[], level: number, parent?: string) => entries.forEach((entry, index) => {

            const path = entry.relativePath;
            const key = pathKey(path);
            const children = onlyAgent ? onlyAgent.children[path] : loaded[path];
            const open = entry.isDirectory && (onlyAgent ? !agentClosed[path] : !!expanded[path]);

            list.push({
                entry,
                level,
                setSize: entries.length,
                posInSet: index + 1,
                ...(parent !== undefined ? { parent } : {}),
                ...(entry.isDirectory ? { open } : {}),
                ...(reading[path] ? { reading: true } : {}),
                ...(open && !onlyAgent && loaded[path]?.length === 0 ? { empty: true } : {}),
                ...(!entry.isDirectory && marks.get(key) ? { letter: marks.get(key)!.letter, letterTitle: letterText(marks.get(key)!.letter) } : {}),
                ...(entry.isDirectory && changedFolders.has(key) ? { changesInside: true } : {}),
                ...(isIgnored(key, ignored) ? { ignored: true } : {}),
                ...(!entry.isDirectory && agentByKey.has(key) ? { byAgent: true } : {})
            });

            if (open && children)
                walk(children, level + 1, path);
        });

        walk(onlyAgent ? onlyAgent.top : top ?? [], 1);

        return list;

    }, [top, loaded, expanded, onlyAgent, agentClosed, reading, marks, changedFolders, ignored, agentByKey]);

    // ---------------------------------------------------------------
    // Opening and closing folders
    // ---------------------------------------------------------------

    /**
     * Opens a folder, reading its entries the first time. A folder that
     * cannot be read stays closed. `fresh`: just after a reset, when this
     * draw's `loaded` still holds the folders read before it.
     */
    async function openFolder(folder: string, gone: () => boolean = () => false, fresh = false): Promise<void> {

        if (onlyAgent && !fresh) {

            setAgentClosed(current => ({ ...current, [folder]: false }));

            return;
        }

        if (fresh || !loaded[folder]) {

            setReading(current => ({ ...current, [folder]: true }));

            try {

                const entries = await listFolder(folder);

                if (gone())
                    return;

                setLoaded(current => ({ ...current, [folder]: entries }));

            } catch {

                return;

            } finally {

                setReading(current => ({ ...current, [folder]: false }));
            }
        }

        setExpanded(current => ({ ...current, [folder]: true }));
    }

    const closeFolder = (folder: string) => onlyAgent
        ? setAgentClosed(current => ({ ...current, [folder]: true }))
        : setExpanded(current => ({ ...current, [folder]: false }));

    /** The Refresh button: the top and every open folder read again, and git too. */
    const refresh = () => {

        void loadGit();

        listFolder().then(setTop, (error: Error) => setProblem(error.message));

        for (const [folder, open] of Object.entries(expanded))
            if (open)
                listFolder(folder).then(
                    entries => setLoaded(current => ({ ...current, [folder]: entries })),
                    () => undefined);
    };

    /** The Collapse button: every folder closed. */
    const collapseAll = () => {

        if (!onlyAgent)
            return setExpanded({});

        const closed: Record<string, boolean> = {};

        for (const row of rows)
            if (row.entry.isDirectory)
                closed[row.entry.relativePath] = true;

        setAgentClosed(closed);
    };

    // ---------------------------------------------------------------
    // A row's right-click menu
    // ---------------------------------------------------------------

    const copy = (text: string) => void navigator.clipboard?.writeText(text);

    const menuFor = (entry: FileEntry): ExplorerMenuItem[] => {

        const path = entry.relativePath;
        const relative = relativeTo(path, top ?? []);
        const copies: ExplorerMenuItem[] = [
            { label: "Copy Path", onSelect: () => copy(path), line: !entry.isDirectory },
            { label: "Copy Relative Path", ...(relative !== undefined ? { onSelect: () => copy(relative) } : { note: "Not inside the session's folders" }) }
        ];

        if (entry.isDirectory)
            return [{ label: "Add to context", note: "As a path", onSelect: () => onAttach(entry) }, ...copies.map((one, index) => index === 0 ? { ...one, line: true } : one)];

        const mark = marks.get(pathKey(path));
        const agent = agentByKey.get(pathKey(path));

        return [
            { label: "Open", note: "Click", onSelect: () => onOpen(entry, false) },
            { label: "Open and keep the tab", note: "Double-click", onSelect: () => onOpen(entry, true) },
            { label: "Add to context", onSelect: () => onAttach(entry) },
            ...copies,
            { label: "Show in Git", line: true, ...(mark ? { onSelect: () => onShowInGit(mark) } : { note: "No git changes" }) },
            { label: "Show what the agent changed", ...(agent ? { onSelect: () => onShowAgentChange(agent) } : { note: "Not changed by the agent" }) }
        ];
    };

    /** The grey line above the tree: a problem, still reading, or nothing to show. */
    const note = problem !== undefined ? problem
        : !top ? "Loading…"
        : onlyAgent && rows.length === 0 ? "The agent has not changed any files in this chat."
        : !onlyAgent && top.length === 0 ? "(empty)"
        : undefined;

    return (
        <FileExplorer
            hidden={hidden}
            rows={rows}
            current={current}
            note={note}
            noFolder={chat.folders.length === 0}
            onAddFolder={onAddFolder}
            agentOnly={agentOnly}
            onAgentOnly={setAgentOnly}
            onFindFile={onFindFile}
            onRefresh={refresh}
            onCollapseAll={collapseAll}
            editors={tabs.tabs.map(tab => ({ id: tab.id, title: tab.title, tip: tab.tip, kind: tab.what.kind === "file" ? "file" : "diff", preview: tab.preview }))}
            activeEditor={tabs.active}
            onShowEditor={onShowTab}
            onKeepEditor={onKeepTab}
            onCloseEditor={onCloseTab}
            onOpenFile={onOpen}
            onFolder={(path, open) => open ? void openFolder(path) : closeFolder(path)}
            onAttach={onAttach}
            menuFor={menuFor} />
    );
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ToChatView } from "../shared/chatMessages";
import ChatPane from "../view/chat/ChatPane";
import type { AgentFile } from "../view/chat/pendingChanges";
import type { SessionConnector, SessionExtras } from "../view/chat/SessionPanel";
import { CommandBlockContext } from "../view/commandBlock";
import { AppFooter, AppHeader, AppShell, Button, type FileEntry, type FileSelection, HeaderButton, languageOf, LibraryMenu, Modal, PanelButton, PanelView, PopoverDefaults, SidePanel, UiIcon } from "../view/ui";
import { API, type UpgradedView, ChatInfo, ChatMark, ChatRow, type ConnectorCard, folderKey, GitDiffAsk, GitStatus, KiroRow, PromptRequest, ReviewFile, SearchHit, type SessionInfo, type SettingsView, type SpecSessionView, type Workspace, workspaceKey } from "../server/protocol";
import { focusSdd } from "../sdd/view/host";
import { bridge } from "./bridge";
import ChatList from "./ChatList";
import { CommandBlock } from "./CommandBlock";
import { type Aliases, baseName, folderName, listOrder, namesOf, NO_ALIASES } from "./chatGroups";
import { PromptDialog, ReviewDialog, ShortcutsDialog, Toast, Toasts } from "./Dialogs";
import EditorArea, { type DiffLayout, type EditorHelp } from "./EditorArea";
import { closeTab, EditorTab, keepTab, NO_TABS, openTab, showTab, tabId, TabsState, TabWhat, type TurnDiff } from "./editorTabs";
import { gitMarks, pathKey, pathParts } from "./fileMarks";
import FilesPane from "./FilesPane";
import FindFileDialog from "./FindFileDialog";
import FolderPicker from "./FolderPicker";
import GitPane from "./GitPane";
import Fold from "./Fold";
import { chatAddress, evalAddress, goTo, pageInAddress, sddInAddress, setAddressBook, type SettingsSection, settingsAddress, specInAddress, type SpecInAddress, workspaceAddress, workspaceInAddress } from "./pageRoute";
import { CHAT_MAX, CHAT_MIN, editorFits, type Fold as FoldName, loadPanels, loadWidths, NAV_MAX, NAV_MIN, PAGE_MIN, PAGE_WIDTH, PANEL_ON_LOAD, pageWidth, type PanelState, savePanels, saveWidths, showFold, toggleFold, Widths } from "./sideState";
import { noticeText, pageTitle, showNotice } from "./notices";
import CopyStyleDialog from "./CopyStyleDialog";
import NewSpecDialog from "./NewSpecDialog";
import { readWatched, specOfFiles, type WatchedSpec, writeWatched } from "./widgets/watchedSpec";
import { lastSpecChat } from "./workspaceView";
import { type SpecAction, type SpecCommandAnswer, specCommand, specsNamed } from "../shared/specPaths";
import { specLine } from "./sddLine";
import SearchDialog from "./SearchDialog";
import SettingsPage from "./SettingsPage";
import StartPage, { type StartPickBody } from "./StartPage";
import WorkspacePage from "./WorkspacePage";
import WorkspacePicker from "./WorkspacePicker";
import { exportName } from "./exportName";
import { isMac, modName, shortcutList, shortcutOf, typesText } from "./shortcuts";
import { applyFontSize, applyTheme } from "./theme";
import UpdateDialog from "./UpdateDialog";
import WorkspaceDialog from "./WorkspaceDialog";
import { type SddPlace, sddPlace } from "./workspacePick";

/*
 * The Eesha Code page. Top to
 * bottom: a header (the name, Search, More, Settings), then the page,
 * then a footer line.
 *
 * With a session open, left to right: the workspace panel - its
 * sections Sessions, Files, AI changes, Git and This session, see
 * sideState.ts - then one header row over the chat. The AI button at the
 * left of the header shows or hides the workspace panel. When a file, a
 * diff, a spec or the logs open, the editor takes the middle and the chat
 * moves to the right at its own width.
 *
 * Nothing of this is kept across a reload: a reload shows the session's
 * chat full screen. Moving to another session, to the start page or to
 * Settings is a real page load.
 *
 * With no session in the address, the page is the start page.
 */

type Shown = { kind: "review"; files: ReviewFile[] };

/** Where a first message typed on the start page waits for its new session's page to load. */
const FIRST_TEXT_KEY = "eesha.firstText";

/** Eesha Code's repository on GitHub, opened by the GitHub mark in the footer. */
const REPO_URL = "https://github.com/eeshaai/eesha-code";

/** A git diff tab's hover text - what the two sides are, as the Git list says it. */
function gitWhere(ask: GitDiffAsk): string {

    switch (ask.side) {

        case "staged": return "last commit and staged";
        case "conflict": return "last commit and now, with the conflict marks";
        case "commit": return `in ${ask.commit?.slice(0, 7) ?? "a commit"}`;
        default: return "staged and now";
    }
}

/**
 * Lines picked in a file, for the message box: where they are, then the
 * lines in a code block. The fence is longer than any run of backticks in
 * the lines, so a Markdown file's own fences stay inside.
 */
function linesForMessage(where: string, picked: FileSelection): string {

    const longest = Math.max(2, ...(picked.text.match(/`+/g) ?? []).map(run => run.length));
    const fence = "`".repeat(longest + 1);
    const lines = picked.start === picked.end ? `line ${picked.start}` : `lines ${picked.start}-${picked.end}`;

    return `${where} ${lines}:\n${fence}${languageOf(where) ?? ""}\n${picked.text}\n${fence}`;
}

function fileName(file: string): string {

    return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

/**
 * The Settings section the address names. The short address `/settings`
 * is swapped in place for the section's own one, so the address always
 * shows which section is open.
 */
function readAddress(): SettingsSection | undefined {

    const section = pageInAddress();

    if (section !== undefined) {

        const address = settingsAddress(section);

        if (location.pathname !== address)
            history.replaceState(null, "", address);
    }

    return section;
}

/** Why the folder list is up, and what a change does. */
function folderIntro(chat: ChatInfo, running: boolean): string {

    if (running)
        return "The agent is working - stop it first, then change the folders.";

    if (!chat.started)
        return "Pick the folders this session works in. The first one is where the agent starts; it may use the others too. With none, it works in its own scratch folder.";

    if (chat.scratch)
        return "This session works in its own scratch folder - its conversation started there, so it stays there. Folders added here are extra places the agent may use. After a change, the next message reopens the conversation with them.";

    return "The agent may use every folder here. The first one stays first: the conversation started there. After a change, the next message reopens the conversation with the new folders.";
}

/**
 * After an upgrade from the footer's version, says how it went - once per
 * upgrade in this browser tab, though every hello for a few minutes carries it.
 */
function showUpgraded(upgraded: UpgradedView, addToast: (text: string) => void): void {

    const key = `eesha.upgraded.${upgraded.at}`;

    try {

        if (sessionStorage.getItem(key))
            return;

        sessionStorage.setItem(key, "1");

    } catch {

        // No storage here: said on every hello for a few minutes instead.
    }

    addToast(upgraded.problem
        ? `The upgrade failed: ${upgraded.problem}`
        : upgraded.kind === "source" ? "Built from source and started again." : `Upgraded from ${upgraded.from} to ${upgraded.to ?? "the newest version"}.`);
}

/**
 * The phase chat a spec opens on: the chat of `pick` - one session of a
 * phase, or the newest of a phase - else the spec's newest phase chat.
 * Nothing: it has none yet, or the server could not say.
 */
async function phaseChatOf(workspace: string, spec: SpecInAddress, pick: { phase?: string; session?: { ownerId: string; iteration?: number } } = {}): Promise<string | undefined> {

    let sessions: SpecSessionView[];

    try {

        sessions = (await bridge.request<{ sessions?: SpecSessionView[] }>(API.sddSessions, { workspace, spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) })).sessions ?? [];

    } catch {

        return undefined;
    }

    const chats = sessions.filter(one => one.chatId !== undefined);
    const newest = (list: SpecSessionView[]) => list.reduce<SpecSessionView | undefined>((best, one) => !best || one.at >= best.at ? one : best, undefined)?.chatId;
    const session = pick.session;

    if (session) {

        const run = chats.find(one => one.ownerId === session.ownerId && (session.iteration === undefined ? one.current : one.iteration === session.iteration));

        if (run)
            return run.chatId;
    }

    const phase = session?.ownerId ?? pick.phase;

    return (phase ? newest(chats.filter(one => one.ownerId === phase)) : undefined) ?? newest(chats);
}

/** A spec tab's part of an address. Nothing for any other tab. */
function specTabOf(what: TabWhat | undefined): SpecInAddress | undefined {

    return what?.kind === "spec" ? { spec: what.spec, ...(what.folder ? { folder: what.folder } : {}) } : undefined;
}

/** How a phase chat's line names its phase: `implement@wave:2` is "implement" - one chat holds every wave. */
function phaseName(phase: string): string {

    const at = phase.indexOf("@");

    return at < 0 ? phase : phase.slice(0, at);
}

/**
 * Whether this page load has told about the chats waiting for an answer
 * yet. Kept outside the page: a move with no page load draws the page
 * again, and must not tell again.
 */
let toldWaiting = false;

/**
 * The lists the page read last. After a move with no page load the new
 * page starts from them - the panel and the links are there at once -
 * and reads them again from the server as any page does.
 */
let lastLists: { chats: ChatRow[]; aliases: Aliases; workspaces: readonly Workspace[]; kiro: readonly KiroRow[] } | undefined;

export default function App() {

    /** The chat this page shows - the one the address names. None: the start page. */
    const [chatId, setChatId] = useState(bridge.chatId);

    const [chat, setChat] = useState<ChatInfo | undefined>();
    const [chats, setChats] = useState<ChatRow[]>(() => lastLists?.chats ?? []);

    /** The first chat list came from the server - on this page, or on the one before a move with no page load. */
    const [chatsLoaded, setChatsLoaded] = useState(lastLists !== undefined);

    /** The names given to folders that are no workspace - sent with the chat list. */
    const [folderAliases, setAliases] = useState<Aliases>(() => lastLists?.aliases ?? NO_ALIASES);

    /** The workspaces - sent with the chat list. */
    const [workspaces, setWorkspaces] = useState<readonly Workspace[]>(() => lastLists?.workspaces ?? []);

    /** The names every list shows: each workspace's own name, and the aliases of other folders. */
    const aliases = useMemo(() => namesOf(folderAliases, workspaces), [folderAliases, workspaces]);

    // Before anything draws from the lists: the links made from them
    // carry the workspaces' and sessions' names (pageRoute.ts).
    useMemo(() => setAddressBook(chats, workspaces), [chats, workspaces]);

    /** Kiro's own sessions in the list's folders - sent with the chat list. */
    const [kiroRows, setKiroRows] = useState<readonly KiroRow[]>(() => lastLists?.kiro ?? []);

    /**
     * The workspace window: `{}` adds a workspace, `{ editing }` changes
     * one, `{ next }` adds one like `next` for the next work item.
     */
    const [folderWindow, setFolderWindow] = useState<{ editing?: Workspace; next?: Workspace } | undefined>();

    /** The module panel's width. Not kept: every page load starts at the narrowest. */
    const [navWidth, setNavWidth] = useState(NAV_MIN);

    /** The folder whose name is being asked for - with its workspace's key when it is one. */
    const [aliasFor, setAliasFor] = useState<{ folder: string; key?: string } | undefined>();
    const [unknown, setUnknown] = useState(false);
    const [moved, setMoved] = useState(false);
    const [toasts, setToasts] = useState<Toast[]>([]);
    const [prompts, setPrompts] = useState<{ id: number; prompt: PromptRequest }[]>([]);
    const [shown, setShown] = useState<Shown | undefined>();
    const [editing, setEditing] = useState(false);
    const [running, setRunning] = useState(false);

    /** The Settings section on screen, from the address. Settings is its own page load. */
    const [page] = useState<SettingsSection | undefined>(readAddress);

    /** Settings is open. */
    const settings = page !== undefined;

    /**
     * An older spec link - `/sdd?workspace=...&spec=...`. There is no spec
     * page any more: the page goes on at once, to the spec's newest phase
     * chat with the spec as a tab, or to its workspace page.
     */
    const [oldSpecLink] = useState(sddInAddress);

    /**
     * A workspace page's address: the workspace's key (empty when the
     * address names none). Nothing: not a workspace page. Moving to a
     * session or a spec from it is a real page load.
     */
    const [workspaceAt] = useState(workspaceInAddress);

    /** A workspace page is open. */
    const workspacePage = workspaceAt !== undefined && !oldSpecLink;

    /** The spec tab the address named when the page loaded. Opened once its workspace is known. */
    const [specAt] = useState(specInAddress);

    /** The address's spec tab was opened, or dropped. From then on the address follows the spec tabs. */
    const [specRestored, setSpecRestored] = useState(specAt === undefined);

    /**
     * The New spec window is open - for a spec in `folder`, or in the main
     * folder when it has none. `place`: the workspace picked in the
     * Sessions section; without one, the page's own.
     */
    const [newSpecIn, setNewSpecIn] = useState<{ folder?: string; text?: string; place?: SddPlace } | undefined>();
    const [copyStyleOpen, setCopyStyleOpen] = useState(false);

    /**
     * The panels this session had open before a reload of this browser
     * tab. Not on a workspace page or Settings: those
     * decide their own panels.
     */
    const [keptPanels] = useState(() => oldSpecLink || workspacePage || settings ? undefined : loadPanels(bridge.chatId));

    /**
     * The workspace panel on the left: whether it shows, and which of its
     * sections are open. A session's reload uses what it kept; otherwise
     * PANEL_ON_LOAD.
     */
    const [panelState, setPanelState] = useState<PanelState>(() => keptPanels ?? PANEL_ON_LOAD);

    /** The Evaluator is on (the `evals` flag): the More menu links to it. */
    const [evalsOn, setEvalsOn] = useState(false);

    // An older spec link goes on to where the spec is now - see
    // `oldSpecLink`. With no workspace in it, to the start page.
    useEffect(() => {

        if (!oldSpecLink)
            return;

        const { workspace, spec, folder } = oldSpecLink;

        if (!workspace)
            return goTo(chatAddress(undefined), true);

        if (!spec)
            return goTo(workspaceAddress(workspace), true);

        const tab: SpecInAddress = { spec, ...(folder ? { folder } : {}) };

        void phaseChatOf(workspace, tab, oldSpecLink).then(id => goTo(id ? chatAddress(id, tab) : workspaceAddress(workspace, tab), true));

    }, [oldSpecLink]);

    /** The workspace panel shows. */
    const listOpen = panelState.open;

    /** Shows or hides the workspace panel. */
    const setListOpen = useCallback((open: boolean | ((now: boolean) => boolean)) =>
        setPanelState(now => ({ ...now, open: typeof open === "function" ? open(now.open) : open })), []);

    // Keeps the session's panel for a reload of this browser tab.
    useEffect(() => {

        if (!oldSpecLink && !workspacePage && !settings)
            savePanels(chatId, panelState);

    }, [chatId, panelState, oldSpecLink, workspacePage, settings]);

    /** The sections opened once: their panes stay drawn (hidden) while closed, so they keep their open folders. */
    const [visited, setVisited] = useState<ReadonlySet<FoldName>>(() => new Set(panelState.folds));

    useEffect(() => {

        const fresh = panelState.folds.filter(fold => !visited.has(fold));

        if (fresh.length)
            setVisited(current => new Set([...current, ...fresh]));

    }, [panelState.folds, visited]);

    /** The editor was hidden with Hide editor. Its tabs stay open. */
    const [editorHidden, setEditorHidden] = useState(false);

    /**
     * The editor is maximized: the chat (or the workspace page) and the
     * workspace panel are hidden, so the editor takes the row. Each panel keeps whether it was open, and
     * shows again as it was. Only while the editor shows; never kept for
     * a reload.
     */
    const [besideHidden, setBesideHidden] = useState(false);

    /** The width of the chat beside the editor - kept in this browser. */
    const [widths, setWidths] = useState<Widths>(loadWidths);

    useEffect(() => saveWidths(widths), [widths]);

    /** The menus: the session ⌄ menu in the header row, and More in the top header. */

    /** Eesha Code's version, shown in the footer. Sent with the server's hello. */
    const [version, setVersion] = useState("");

    /** The window the footer's version opens: check for a newer Eesha Code, and upgrade. */
    const [updateOpen, setUpdateOpen] = useState(false);

    /** An upgrade stopped the server: the next hello is the new server, and the page reloads to get its page code. */
    const reloadOnHello = useRef(false);

    /** How Eesha Code runs - from the hello. From source, a click on the version builds at once. */
    const [install, setInstall] = useState<"npm" | "source">("npm");

    /** `npm run build` runs, from a click on the version. */
    const [building, setBuilding] = useState(false);

    /** The word in front of the tab's title after a notice - "Done", "Question" - until the page is used again. */
    const [mark, setMark] = useState<string | undefined>();

    /** Where the chat view draws the AI changes list (its section on the left) and the log (Logs tab). */
    const [changesBody, setChangesBody] = useState<HTMLElement | null>(null);
    const [logsBody, setLogsBody] = useState<HTMLElement | null>(null);

    /** Where the chat view draws the This session section, on the left. */
    const [sessionBody, setSessionBody] = useState<HTMLElement | null>(null);

    /** What the Session panel shows that the chat view does not know - read while the panel is open. */
    const [sessionInfo, setSessionInfo] = useState<SessionInfo | undefined>();
    const [connectorCards, setConnectorCards] = useState<ConnectorCard[] | undefined>();
    const [toolsOff, setToolsOff] = useState<Record<string, string[]> | undefined>();

    /** The files this chat's turns changed, as full paths - the Files tree marks them. */
    const [agentFiles, setAgentFiles] = useState<AgentFile[]>([]);

    /** What was asked for each turn that changed files - over a turn's diff. */
    const [turnMessages, setTurnMessages] = useState<Record<string, string>>({});

    /** The repositories as the Files tree or the Git panel last read them - a file tab's git letter and changed lines. */
    const [repos, setRepos] = useState<GitStatus[]>([]);

    /** Diffs inline or side by side, for every diff tab. Not saved: a reload goes back to side by side. */
    const [diffLayout, setDiffLayout] = useState<DiffLayout>("split");

    /** "AI changes" in a file tab: the diff the chat sent, by `pathKey` of the file - and which files asked for one. */
    const [agentDiffs, setAgentDiffs] = useState<Record<string, TurnDiff>>({});
    const askedAgentDiffs = useRef(new Set<string>());

    /** A turn's diff switched to the other comparison: the tab the answer takes the place of. */
    const replaceTurnTab = useRef<string | undefined>(undefined);

    /** The editor's tabs. Kept only in the page's memory: a reload starts with none, but the spec tab the address names. */
    const [tabs, setTabs] = useState<TabsState>(NO_TABS);

    /**
     * The phase each spec tab shows first, by tab id: the one picked in
     * a link or a menu. Without one, the phase of the chat beside it. A
     * spec tab is drawn again each time it comes to the front.
     */
    const [specPicks, setSpecPicks] = useState<Record<string, string>>({});

    /** What `open` needs to know of the layout now, without being made again on each change. */
    const layout = useRef({ listOpen, navWidth, widths });

    layout.current = { listOpen, navWidth, widths };

    /**
     * Opens a file, a diff or the logs as a tab, and shows the editor. When
     * the editor would get less than its least room, the workspace panel
     * closes by itself.
     */
    const open = useCallback((what: TabWhat, title: string, tip: string, keep: boolean) => {

        setTabs(current => openTab(current, { title, tip, what }, keep));
        setEditorHidden(false);

        const now = layout.current;

        if (now.listOpen && !editorFits(pageWidth(window.innerWidth), now.navWidth, now.widths.chat))
            setListOpen(false);
    }, []);

    /** Opens a spec as a tab here, or shows it - at `phase` when one is given. */
    const openSpecTab = useCallback((workspace: string, spec: SpecInAddress, phase?: string) => {

        const what: TabWhat = { kind: "spec", workspace, spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) };

        if (phase) {

            setSpecPicks(current => ({ ...current, [tabId(what)]: phase }));

            // Drawn already: it moves now. Drawn later: it starts there.
            focusSdd(phase.includes("@") ? { ownerId: phase } : { phase });
        }

        open(what, spec.spec, `Spec ${spec.spec}${spec.folder ? ` in ${spec.folder}` : ""}`, true);

    }, [open]);

    /** The + on a file in the pane: the file goes in the compose box as a chip. */
    const attach = useCallback((entry: FileEntry) => {

        // A folder goes as its path - the name ends in "/" so its chip reads as a folder.
        const message: ToChatView = { type: "addFiles", files: [{ path: entry.relativePath, name: entry.isDirectory ? `${entry.name}/` : entry.name }] };

        bridge.toView(message);
    }, []);

    const addToast = useCallback((text: string, chatId?: string) => {

        setToasts(current => [...current.slice(-4), { id: Date.now() + Math.random(), text, ...(chatId ? { chatId } : {}) }]);
    }, []);

    const marks = useMemo(() => gitMarks(repos), [repos]);

    /** The chat's log as a tab. Open: it shows, or closes when it already shows. */
    const toggleLogs = useCallback(() => {

        const id = tabId({ kind: "logs" });

        if (tabs.active === id && !editorHidden)
            setTabs(current => closeTab(current, id));
        else
            open({ kind: "logs" }, "Logs", "This session's log lines", true);

    }, [tabs.active, editorHidden, open]);

    /**
     * The page's workspace, for SDD: a workspace page's own; on a
     * session, the workspace the session recorded. Nothing: a session in
     * no workspace - it has no specs, whatever its folders - or the start
     * page.
     */
    const sddWorkspace = workspacePage
        ? workspaces.find(one => workspaceKey(one) === workspaceAt)
        : chat?.workspace !== undefined
            ? workspaces.find(one => workspaceKey(one) === chat.workspace)
            : undefined;

    /** That workspace's key, name and main folder - for New spec and Copy a style. */
    const sddShown = sddWorkspace ? sddPlace(sddWorkspace) : undefined;

    /** What the tabs need from the page (EditorArea.tsx). */
    const editorHelp: EditorHelp = {
        folders: chat?.folders ?? sddWorkspace?.folders ?? [],
        marks,
        agentFiles,
        turnMessages,
        layout: diffLayout,
        onLayout: setDiffLayout,
        agentDiffs,
        askAgentDiff: file => {
            askedAgentDiffs.current.add(pathKey(file.path));
            bridge.toChat({ type: "diffFile", changed: { root: file.root, before: file.before, after: file.after }, path: file.file });
        },
        onAddFile: file => attach({ name: fileName(file), relativePath: file, isDirectory: false }),
        onAddLines: (file, picked) => {
            const text = linesForMessage(pathParts(file, chat?.folders ?? []).join("/"), picked);
            bridge.toView({ type: "addText", text });
            addToast(picked.start === picked.end ? `Line ${picked.start} is in the message box.` : `Lines ${picked.start}–${picked.end} are in the message box.`);
        },
        onCompare: (tab, diff) => {
            if (!diff.from)
                return;
            replaceTurnTab.current = tab.id;
            bridge.toChat({ type: diff.turn ? "diffFile" : "diffTurn", changed: { root: diff.from.root, before: diff.from.before, after: diff.from.after }, path: diff.from.file });
        },
        // The chat is always beside the editor: this puts the cursor in its
        // message box - or, while a question waits, on the question card,
        // which takes the message box's place.
        onGoToSession: () => {
            const ask = document.querySelector<HTMLElement>(".eesha-main .chat-view__ask");
            const target = ask?.querySelector<HTMLElement>("input, textarea, button") ?? document.querySelector<HTMLTextAreaElement>(".eesha-main .ee-prompt-input__textarea");
            ask?.scrollIntoView({ block: "nearest" });
            target?.focus();
        },
        setLogsBody,
        // A question waits in the chat beside the spec, and that chat is
        // the spec's: its phase chat, or a chat tied to it.
        chatWaits: what => {
            const mine = (one?: { spec: string; folder?: string }) => one !== undefined && one.spec === what.spec && (one.folder ?? "") === (what.folder ?? "");
            return chatOn && (prompts.length > 0 || chats.find(row => row.chatId === chatId)?.waiting !== undefined)
                && (mine(chat?.spec ? { spec: chat.spec.spec, folder: chat.spec.folder } : undefined) || (watched !== undefined && mine(watched)));
        },
        specPhase: what => specPicks[tabId(what)]
            ?? (chat?.spec && chat.spec.spec === what.spec && (chat.spec.folder ?? "") === (what.folder ?? "") ? chat.spec.phase : undefined)
    };

    const closeToast = useCallback((id: number) => setToasts(current => current.filter(toast => toast.id !== id)), []);

    /** Run from source: a click on the version runs npm run build, and the server restarts itself. The page reloads when it is back. */
    const buildAndRestart = useCallback(async () => {

        setBuilding(true);

        const answer = await bridge.request(API.updateStart, {}).catch((error: Error) => ({ problem: error.message }));

        if (answer.problem) {

            setBuilding(false);

            return addToast(answer.problem);
        }

        reloadOnHello.current = true;
    }, [addToast]);


    const loadChats = useCallback(async () => {

        try {

            const answer = await bridge.request<{ chats?: ChatRow[]; aliases?: Record<string, string>; workspaces?: Workspace[]; kiro?: KiroRow[] }>(API.chats, {});

            if (!answer.chats)
                return;

            lastLists = {
                chats: answer.chats,
                aliases: new Map(Object.entries(answer.aliases ?? {})),
                workspaces: answer.workspaces ?? [],
                kiro: answer.kiro ?? []
            };

            setChats(lastLists.chats);
            setAliases(lastLists.aliases);
            setWorkspaces(lastLists.workspaces);
            setKiroRows(lastLists.kiro);
            setChatsLoaded(true);

            // Once per page load: a chat stopped on a question while no
            // tab was open gets a notice with Open. Its question was told
            // to nobody, or to a tab that is gone. The start page lists
            // them itself.
            if (!toldWaiting) {

                toldWaiting = true;

                if (bridge.chatId)
                    for (const row of answer.chats)
                        if (row.waiting !== undefined && row.chatId !== bridge.chatId)
                            addToast(`The agent in session '${row.title}' is waiting for an answer.`, row.chatId);
            }

        } catch {

            // The stream says when the server is gone.
        }
    }, [addToast]);

    /**
     * Makes a session - with no folder, or in `folder` with its saved
     * defaults - and goes to it: a real page load. `text` waits for it in
     * this tab's storage, and lands in its message box. `pick`: the start
     * box's runtime, model and level, when changed there.
     */
    const newChat = useCallback(async (folder?: string, text = "", pick?: StartPickBody, workspace?: string) => {

        let answer: { chatId?: string; problem?: string };

        try {

            answer = await bridge.request<{ chatId?: string }>(API.newSession, { ...(folder ? { folder, ...(workspace ? { workspace } : {}) } : { folders: [] }), ...pick });

        } catch (error) {

            answer = { problem: `Could not reach the server: ${(error as Error).message}` };
        }

        if (!answer.chatId) {

            addToast(answer.problem ?? "The server did not make a new session.");

            return;
        }

        if (text.trim())
            try {

                sessionStorage.setItem(FIRST_TEXT_KEY, JSON.stringify({ chatId: answer.chatId, text }));

            } catch {

                // A browser that keeps nothing: the text is lost, the session still opens.
            }

        goTo(chatAddress(answer.chatId));

    }, [addToast]);

    /** The session's workspace, for the header row: its name, "No workspace", or its first folder and how many more. */
    const chatPlace = chat?.workspace;
    const folderLabel = chat
        ? chat.folders.length ? `${(chatPlace ? aliases.get(chatPlace) : undefined) ?? folderName(chat.folders[0], aliases)}${chat.folders.length > 1 ? ` +${chat.folders.length - 1}` : ""}` : "No workspace"
        : "";


    /**
     * The workspaces whose specs this tab shows: those of its spec tabs,
     * and the page's own while the Sessions section lists its specs. A spec's notice
     * (`eesha.sddNote`) is shown only here. Kept in a ref so the page's
     * message handler, set up once, reads the current one.
     */
    const sddShowing = useRef<(string | undefined)[]>([]);

    sddShowing.current = [listOpen && panelState.folds.includes("sessions") ? sddShown?.key : undefined, ...tabs.tabs.flatMap(tab => tab.what.kind === "spec" ? [tab.what.workspace] : [])];

    useEffect(() => {

        const offPage = bridge.onPage(message => {

            switch (message.type) {

                case "eesha.hello":

                    if (reloadOnHello.current)
                        return location.reload();

                    if (message.upgraded)
                        showUpgraded(message.upgraded, addToast);

                    applyTheme(message.theme);
                    applyFontSize(message.fontSize);
                    setEvalsOn(message.evals === true);
                    setVersion(message.version);
                    setInstall(message.install);

                    if (message.chat)
                        setChat(message.chat);

                    return;

                // Changed on the settings page, in this tab or another.
                case "eesha.theme":
                    return applyTheme(message.theme);

                case "eesha.fontSize":
                    return applyFontSize(message.fontSize);

                case "eesha.chat":
                    return setChat(message.chat);

                case "eesha.unknownChat":
                    return setUnknown(true);

                case "eesha.moved":
                    return setMoved(true);

                // The chat on screen was deleted: its workspace's page takes
                // its place - in the Back list too, so Back skips the gone chat.
                case "eesha.workspacePage":
                    return goTo(workspaceAddress(message.workspace), true);

                case "eesha.listChanged":
                    return void loadChats();

                case "eesha.note":
                    return addToast(message.text);

                // A spec's notice: only where its workspace's specs are shown.
                case "eesha.sddNote":
                    return void (sddShowing.current.includes(message.workspace) && addToast(message.text));

                case "eesha.attention":
                    return addToast(message.text, message.chatId);

                // A turn ended or the agent asked something - this tab's
                // chat, or one with no tab. A click on the notice goes to
                // that chat.
                case "eesha.notify":

                    showNotice(message, () => {

                        if (message.chatId !== bridge.chatId)
                            bridge.switchTo(message.chatId);
                    });

                    if (message.chatId === bridge.chatId)
                        setMark(noticeText(message).mark);

                    return;

                case "eesha.prompt":
                    return setPrompts(current => [...current, { id: message.id, prompt: message.prompt }]);

                // A changed file clicked in the thread or the AI changes
                // list: its diff as a tab.
                case "eesha.diff": {

                    const { type: _type, ...diff } = message;

                    // Asked by a file tab's "AI changes": shown in that tab, no tab of its own.
                    const asked = diff.from && !diff.turn ? pathKey(`${diff.from.root}/${diff.from.file}`) : undefined;

                    if (asked && askedAgentDiffs.current.delete(asked))
                        return setAgentDiffs(current => ({ ...current, [asked]: diff }));

                    open({ kind: "turn", diff }, fileName(diff.path), `${diff.path} - ${diff.turn ? "before and after the turn" : "before the turn and now"}`, false);

                    // The other comparison of a turn's diff takes the old tab's place.
                    const replaced = replaceTurnTab.current;
                    replaceTurnTab.current = undefined;

                    if (replaced && replaced !== tabId({ kind: "turn", diff }))
                        setTabs(current => closeTab(current, replaced));

                    return;
                }

                case "eesha.review":
                    return setShown({ kind: "review", files: message.files });

                // A file link in the thread: the file as a tab.
                case "eesha.file":

                    if (message.problem !== undefined || message.text === undefined)
                        return addToast(message.problem ?? `Could not read ${message.path}.`);

                    return open({ kind: "file", path: message.path }, fileName(message.path), message.path, false);
            }
        });

        // The chat on screen was deleted and another took its place: the
        // chat view has redrawn itself, and the list is read again.
        const offChat = bridge.onChat(next => {

            setChatId(next);
            void loadChats();
        });

        // "busy": a turn is running, so the folders cannot change until it
        // ends. "history": sent after a rename or a delete, so the list is
        // read again.
        const onView = (event: MessageEvent) => {

            const data = event.data as { type?: unknown; running?: unknown } | undefined;

            if (data?.type === "busy")
                setRunning(data.running === true);
            else if (data?.type === "history")
                void loadChats();
        };

        window.addEventListener("message", onView);

        void loadChats();

        // The start page and Settings have no chat, but the stream still
        // brings the theme, the text size and the notices.
        bridge.connect();

        return () => {

            offPage();
            offChat();
            window.removeEventListener("message", onView);
        };
    }, [addToast, loadChats, open]);

    // A phase of the spec in front started in a chat: the page goes to
    // that chat, with the spec as a tab beside it. Already there: it stays.
    // With text - the Doc tab's notes - the text goes in that chat's
    // message box: now when it is on screen, else once the page for it
    // has loaded (see the first-text effect below).
    useEffect(() => specLine.onPhaseChat((id, spec, text) => {

        if (id === chatId) {

            if (text)
                bridge.toView({ type: "addText", text });

            return;
        }

        if (text) {

            try {

                sessionStorage.setItem(FIRST_TEXT_KEY, JSON.stringify({ chatId: id, text }));

            } catch {

                // No storage: the page still goes to the chat.
            }
        }

        goTo(chatAddress(id, { spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) }));

    }), [chatId]);

    // A first message typed on the start page: into this session's message
    // box once the chat is drawn. Taken out of storage so a reload does not
    // put it there again.
    useEffect(() => {

        if (!chat || chat.chatId !== chatId)
            return;

        let first: { chatId?: unknown; text?: unknown } | undefined;

        try {

            first = JSON.parse(sessionStorage.getItem(FIRST_TEXT_KEY) ?? "null") ?? undefined;

            if (first?.chatId === chatId)
                sessionStorage.removeItem(FIRST_TEXT_KEY);

        } catch {

            return;
        }

        if (first?.chatId === chatId && typeof first.text === "string") {

            const text = first.text;

            setTimeout(() => bridge.toView({ type: "addText", text }), 0);
        }
    }, [chat, chatId]);

    useEffect(() => {

        document.title = pageTitle(chat?.title ?? (workspacePage ? sddWorkspace?.name ?? "Workspace" : undefined), mark);

    }, [chat, mark, workspacePage, sddWorkspace?.name]);

    // The title's mark goes once the person is at the page again: the
    // tab comes to the front, the window gets the focus, or they click
    // or type in it - the notice can come while they are looking.
    useEffect(() => {

        if (!mark)
            return;

        const seen = () => setMark(undefined);
        const shown = () => { if (document.visibilityState === "visible") seen(); };

        window.addEventListener("focus", seen);
        window.addEventListener("pointerdown", seen, true);
        window.addEventListener("keydown", seen, true);
        document.addEventListener("visibilitychange", shown);

        return () => {

            window.removeEventListener("focus", seen);
            window.removeEventListener("pointerdown", seen, true);
            window.removeEventListener("keydown", seen, true);
            document.removeEventListener("visibilitychange", shown);
        };
    }, [mark]);

    const answer = (id: number, value: string | undefined): void => {

        setPrompts(current => current.filter(one => one.id !== id));

        void bridge.request(API.reply, { view: bridge.view, id, ...(value !== undefined ? { value } : {}) });
    };

    const saveFolders = async (folders: string[]): Promise<string | undefined> => {

        const result = await bridge.request(API.setWorkspace, { view: bridge.view, folders });

        if (result.problem)
            return result.problem;

        setEditing(false);

        return undefined;
    };

    const [shortcuts, setShortcuts] = useState(false);

    /** The search window is open. */
    const [searching, setSearching] = useState(false);

    /** The find-a-file window is open. */
    const [findingFile, setFindingFile] = useState(false);

    /** Export: the browser saves this chat as `<chat name>.md`. */
    const exportChat = async (): Promise<void> => {

        const answer = await bridge.request<{ title?: string; text?: string }>(API.exportChat, { view: bridge.view });

        if (answer.problem || answer.text === undefined)
            return addToast(answer.problem ?? "The server did not send the session.");

        const url = URL.createObjectURL(new Blob([answer.text], { type: "text/markdown;charset=utf-8" }));
        const link = document.createElement("a");

        link.href = url;
        link.download = exportName(answer.title ?? "");

        document.body.appendChild(link);
        link.click();
        link.remove();

        // The download has its own copy by then.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
    };

    /** The chats whose messages hold this text. Nothing when the server cannot say. */
    const searchText = useCallback(async (query: string): Promise<readonly SearchHit[]> => {

        const answer = await bridge.request<{ hits?: SearchHit[] }>(API.searchChats, { query });

        return answer.hits ?? [];

    }, []);

    /** Pins or archives a chat. The list is read again when the server says it changed. */
    const markChat = async (id: string, mark: ChatMark | null): Promise<void> => {

        const result = await bridge.request(API.markChat, { chatId: id, mark });

        if (result.problem)
            addToast(result.problem);
    };

    /** The alias dialog's answer. `undefined`: backed out. Empty: the folder's own name again. */
    const saveAlias = async (folder: string, key: string | undefined, alias: string | undefined): Promise<void> => {

        setAliasFor(undefined);

        if (alias === undefined)
            return;

        const result = await bridge.request(API.workspaceName, { folder, ...(key ? { key } : {}), name: alias });

        if (result.problem)
            addToast(result.problem);
    };

    /** Takes a workspace off the list, by its key. Its sessions stay. */
    const removeFolder = async (key: string): Promise<void> => {

        const result = await bridge.request(API.removeWorkspace, { key });

        if (result.problem)
            addToast(result.problem);
    };

    /** Archives a workspace, or brings it back, by its key. */
    const archiveWorkspace = async (key: string, archived: boolean): Promise<void> => {

        const result = await bridge.request(API.archiveWorkspace, { key, archived });

        if (result.problem)
            addToast(result.problem);
    };

    /** A folder's Delete all sessions. The server asks first, in this tab. */
    const deleteMany = async (chatIds: string[], where: string): Promise<void> => {

        const result = await bridge.request(API.deleteChats, { view: bridge.view, chatIds, where });

        if (result.problem)
            addToast(result.problem);
    };

    /**
     * A row's own Delete. Through the server, not the chat, so the
     * question can offer to keep a folder the delete leaves empty.
     */
    const deleteRow = async (id: string): Promise<void> => {

        const result = await bridge.request(API.deleteChats, { view: bridge.view, chatIds: [id], row: true });

        if (result.problem)
            addToast(result.problem);
    };

    /** Makes a Kiro session from the list an Eesha Code one, and goes to it. */
    const openKiro = async (row: KiroRow): Promise<void> => {

        const result = await bridge.request<{ chatId?: string }>(API.openKiro, { sessionId: row.sessionId });

        if (result.problem || !result.chatId)
            return addToast(result.problem ?? "Could not open the Kiro session.");

        openChat(result.chatId);
    };

    /** Rename or Delete on a Kiro row's menu. The server asks in this tab, then changes it in Kiro; the session is not opened. */
    const changeKiro = async (route: string, row: KiroRow): Promise<void> => {

        const result = await bridge.request(route, { view: bridge.view, sessionId: row.sessionId });

        if (result.problem)
            addToast(result.problem);
    };

    /** Goes to a chat at its address - with no page load (pageRoute.ts `goTo`). */
    const openChat = (next: string): void => {

        if (next !== chatId || settings || unknown || moved)
            bridge.switchTo(next);
    };

    const listed = chat ? chats.some(row => row.chatId === chat.chatId) : true;

    /** There is a chat the panels and tabs can show things of. */
    const chatOn = chat !== undefined && !unknown && !moved && !settings;

    /** The session has a folder: Git and AI changes need one. */
    const hasFolder = (chat?.folders.length ?? 0) > 0;

    /** The editor shows: a tab is open and it was not hidden. */
    const editorShown = chatOn && tabs.tabs.length > 0 && !editorHidden;

    /** On a workspace page: a spec tab, or a file the spec opened, shows beside the page. */
    const workspaceEditorShown = workspacePage && tabs.tabs.length > 0 && !editorHidden;

    // The editor hidden or its last tab closed: a maximize is over, so the
    // chat (or the page) is back, and the next tab opens beside it.
    const editorBeside = editorShown || workspaceEditorShown;

    useEffect(() => {

        if (!editorBeside)
            setBesideHidden(false);

    }, [editorBeside]);

    /** The editor takes the whole row now. */
    const maximized = besideHidden && editorBeside;

    /** A section of the workspace panel is on screen: the panel shows, the section is open, and nothing is maximized. */
    const foldShown = (fold: FoldName): boolean => listOpen && !maximized && panelState.folds.includes(fold);

    /** A section only a session has - Files, AI changes, Git, This session - is on screen. */
    const chatFold = (fold: FoldName): boolean => chatOn && foldShown(fold);

    // The address's spec tab opens once the page knows its workspace - the
    // session's, or the workspace page's - at the phase of the chat beside
    // it. With no workspace to open it in, it is dropped.
    useEffect(() => {

        if (specRestored || !specAt)
            return;

        if (settings || unknown)
            return setSpecRestored(true);

        if (!chatsLoaded || (!workspacePage && !chat))
            return;

        if (sddShown)
            openSpecTab(sddShown.key, specAt);

        setSpecRestored(true);

    }, [specRestored, specAt, settings, unknown, chatsLoaded, workspacePage, chat, sddShown, openSpecTab]);

    /** The spec tab the address keeps, by tab id - see the effect below. */
    const addressSpec = useRef<string | undefined>(undefined);

    // The address keeps one spec tab, so it comes back after a reload: the
    // one in front, else the one it kept while that is still open, else
    // any open one. Nothing else of the tabs is kept. Not before the
    // lists came: the address is made from their names - and made again
    // when they change (a new session listed, a rename).
    useEffect(() => {

        // A session or workspace that is not there keeps the address it came on.
        if (!specRestored || !chatsLoaded || settings || oldSpecLink || unknown || (!chatId && !workspacePage) || (workspacePage && !sddWorkspace))
            return;

        const specTabs = tabs.tabs.filter(tab => tab.what.kind === "spec");
        const kept = specTabs.find(tab => tab.id === tabs.active) ?? specTabs.find(tab => tab.id === addressSpec.current) ?? specTabs[0];

        addressSpec.current = kept?.id;

        const spec = specTabOf(kept?.what);
        const address = workspacePage ? workspaceAddress(workspaceAt ?? "", spec) : chatAddress(chatId, spec);

        if (`${location.pathname}${location.search}` !== address)
            history.replaceState(history.state, "", address);

    }, [tabs, specRestored, chatsLoaded, chats, settings, oldSpecLink, unknown, chatId, workspacePage, workspaceAt, sddWorkspace]);

    // The server watches the chat's repositories while the Git section,
    // the Files section (its git colors) or a git tab is open, and says when
    // one changed. Turned on again when the stream comes back: the server
    // may have restarted.
    const watchGit = chatOn && (chatFold("git") || chatFold("files") || tabs.tabs.some(tab => tab.what.kind === "git"));
    const watchKey = chat ? [chat.chatId, ...chat.folders].join("|") : "";

    useEffect(() => {

        if (!watchGit)
            return;

        const on = () => void bridge.request(API.gitWatch, { view: bridge.view, on: true });

        on();

        const offPage = bridge.onPage(message => { if (message.type === "eesha.hello") on(); });

        return () => {

            offPage();
            void bridge.request(API.gitWatch, { view: bridge.view, on: false });
        };
    }, [watchGit, watchKey]);

    // The footer's branch: the page reads the repositories itself, so the
    // branch shows without the Git or Files section ever opened.
    // Read again when the session or its folders change, when a turn ends
    // (the agent may have switched branch) and when the stream comes back.
    // The panels' own reads update it too.
    const hasFolderNow = chatOn && hasFolder;

    useEffect(() => {

        setRepos([]);

        if (!hasFolderNow)
            return;

        let gone = false;

        const read = () => void bridge.request<{ repos?: GitStatus[] }>(API.gitStatus, { view: bridge.view })
            .then(answer => { if (!gone && answer.repos) setRepos(answer.repos); })
            .catch(() => undefined);

        read();

        const offPage = bridge.onPage(message => { if (message.type === "eesha.hello") read(); });

        return () => { gone = true; offPage(); };
    }, [hasFolderNow, watchKey]);

    const wasRunning = useRef(running);

    useEffect(() => {

        if (wasRunning.current && !running && hasFolderNow)
            void bridge.request<{ repos?: GitStatus[] }>(API.gitStatus, { view: bridge.view })
                .then(answer => { if (answer.repos) setRepos(answer.repos); })
                .catch(() => undefined);

        wasRunning.current = running;
    }, [running, hasFolderNow]);

    /** Another session waits for an answer, or works - the AI button's dot while the Sessions section is not on screen. Waiting wins. */
    const othersWaiting = chats.some(row => row.chatId !== chatId && row.waiting !== undefined);
    const othersWorking = chats.some(row => row.chatId !== chatId && row.working);

    /** The file the open tab shows - its row is marked in Files. */
    const activeTab: EditorTab | undefined = tabs.tabs.find(tab => tab.id === tabs.active);

    /** A spec tab in front on a workspace page: the page beside it is that spec's pane (WorkspacePage.tsx). */
    const specBesidePage = workspaceEditorShown ? specTabOf(activeTab?.what) : undefined;

    // A spec in front on a workspace page that a session has worked on:
    // the page goes to that session, with the spec beside it, so the
    // spec's chat goes on in the right-hand pane.
    const specPaneChat = workspacePage && workspaceAt && specBesidePage && chatsLoaded
        ? lastSpecChat(chats, workspaceAt, specBesidePage, id => readWatched(id))?.chatId
        : undefined;

    useEffect(() => {

        if (specPaneChat && specBesidePage)
            goTo(chatAddress(specPaneChat, specBesidePage), true);

    }, [specPaneChat, specBesidePage]);
    const currentFile = activeTab?.what.kind === "file" ? activeTab.what.path : undefined;

    /** The Logs tab shows. */
    const logsShown = editorShown && activeTab?.what.kind === "logs";

    // The This session section's own reads: the steering files and the MCP
    // servers Eesha Code sends, the connectors, and the tools the settings
    // turn off. Read when the section opens, when the session or its
    // folders change, and when a turn ends.
    const sessionOpen = chatFold("session");

    useEffect(() => {

        if (!sessionOpen)
            return;

        let gone = false;

        void bridge.request<SessionInfo & { problem?: string }>(API.sessionInfo, { view: bridge.view })
            .then(answer => { if (!gone && !answer.problem) setSessionInfo(answer); })
            .catch(() => undefined);

        void bridge.request<{ cards?: ConnectorCard[] }>(API.connectors, {})
            .then(answer => { if (!gone && answer.cards) setConnectorCards(answer.cards); })
            .catch(() => undefined);

        void bridge.request<Partial<SettingsView>>(API.settings, {})
            .then(answer => {
                if (!gone && answer.runtimeTools)
                    setToolsOff(Object.fromEntries(Object.entries(answer.runtimeTools).map(([id, tools]) => [id, tools.toolsOff])));
            })
            .catch(() => undefined);

        return () => { gone = true; };
    }, [sessionOpen, watchKey, running]);

    const sessionExtras = useMemo((): SessionExtras => ({
        folders: chat?.folders ?? [],
        ...(toolsOff ? { toolsOff } : {}),
        ...(sessionInfo ? { sentServers: sessionInfo.sentServers, instructionFiles: sessionInfo.instructionFiles } : {}),
        ...(connectorCards ? { connectors: connectorCards.map(sessionConnector) } : {}),
        onEditFolders: () => setEditing(true),
        connectorsHref: settingsAddress("connectors"),
        runtimesHref: settingsAddress("runtimes")
    }), [chat, toolsOff, sessionInfo, connectorCards]);

    /**
     * A key or a button that asks for a section of the workspace panel:
     * the panel shows with it open, or it closes when it is on screen.
     * Maximized, the panel is hidden: the maximize ends and the section
     * shows, rather than toggling one you cannot see.
     */
    const pickFold = useCallback((fold: FoldName) => {

        if (maximized) {

            setBesideHidden(false);
            setPanelState(now => ({ open: true, folds: now.folds.includes(fold) ? now.folds : showFold(now, fold).folds }));

            return;
        }

        setPanelState(now => showFold(now, fold));

    }, [maximized]);

    const mod = modName(isMac());

    /** A section's head clicked: it opens, or closes. */
    const toggle = (fold: FoldName): void => setPanelState(now => toggleFold(now, fold));

    // The keys, read in the capture phase so a control with the focus
    // cannot swallow them first. They act on what is on screen now - the
    // ref holds this draw's values for the one listener.
    const keys = useRef<(event: KeyboardEvent) => void>(() => undefined);

    keys.current = (event: KeyboardEvent): void => {

        const mac = isMac();
        const shortcut = shortcutOf(event, mac);

        // A window over the page - a question, a diff - keeps its keys.
        // Ctrl+/ still closes the shortcut list itself, and Ctrl+K the
        // search window.
        const covered = document.querySelector("[role=dialog]") !== null;

        if (covered && !(shortcut === "help" && shortcuts) && !(shortcut === "search" && searching))
            return;

        if (!shortcut) {

            // Typing with nothing in focus goes into the compose box: the
            // focus moves before the key lands, so the letter goes there.
            if (typesText(event) && chatOn && (document.activeElement === document.body || !document.activeElement))
                document.querySelector<HTMLTextAreaElement>(".eesha-main .ee-prompt-input__textarea")?.focus();

            return;
        }

        const target = event.target as HTMLElement | null;
        const typing = target?.closest("input, textarea, [contenteditable=true]") !== null && target !== null;

        // Option+arrows move the cursor by paragraph in a Mac text box.
        if (mac && typing && (shortcut === "previousChat" || shortcut === "nextChat"))
            return;

        // Esc stops the turn only from the chat's message box, with no
        // menu open - a menu, or the box's own list of files and
        // commands, takes Esc first.
        if (shortcut === "stop") {

            const inCompose = target?.closest(".eesha-main .ee-prompt-input") !== null && target !== null;
            const listOpen = document.querySelector(".eesha-main [role=listbox], [role=menu]") !== null;

            if (!inCompose || listOpen || !running || !chatOn)
                return;

            event.preventDefault();
            bridge.toChat({ type: "cancel" });

            return;
        }

        event.preventDefault();

        switch (shortcut) {

            case "newChat":
                return void newChat(chat?.folders[0]);

            case "previousChat":
            case "nextChat": {

                const order = listOrder(chats, workspaces);
                const at = order.findIndex(row => row.chatId === chatId);
                const next = at < 0 ? order[0] : order[at + (shortcut === "nextChat" ? 1 : -1)];

                if (next)
                    openChat(next.chatId);

                return;
            }

            case "search":
                return setSearching(current => !current);

            case "list":

                if (settings)
                    return;

                // Maximized: the layout comes back with the panel shown - see `pickFold`.
                if (maximized) {

                    setBesideHidden(false);
                    setListOpen(true);

                    return;
                }

                setListOpen(current => !current);

                return;

            case "files":

                if (chatOn)
                    pickFold("files");

                return;

            case "git":

                if (chatOn && hasFolder)
                    pickFold("git");

                return;

            case "logs":

                if (chatOn)
                    toggleLogs();

                return;

            case "findFile":

                if (chatOn && hasFolder)
                    setFindingFile(true);

                return;

            case "help":
                return setShortcuts(current => !current);
        }
    };

    useEffect(() => {

        const onKey = (event: KeyboardEvent) => keys.current(event);

        window.addEventListener("keydown", onKey, true);

        return () => window.removeEventListener("keydown", onKey, true);

    }, []);

    /** `>spec` works here: the session is in a workspace. Its key. */
    const specsAt = sddShown?.key;

    /** This chat is a phase chat: SDD made it for this spec and phase. */
    const phaseLink = chat?.spec;

    /**
     * The spec a normal chat is tied to, so its steps show over the
     * thread - see watchedSpec.ts. A phase chat is tied by SDD itself.
     */
    const [watched, setWatched] = useState<WatchedSpec | undefined>(() => readWatched(bridge.chatId));

    useEffect(() => setWatched(readWatched(chatId)), [chatId]);

    const watch = useCallback((next: WatchedSpec | undefined) => {

        setWatched(next);
        writeWatched(chatId, next);

    }, [chatId]);

    /**
     * One `>spec>NAME>action` (see shared/specPaths.ts): the server runs
     * it and says what the page does next. `quiet`: only tie the chat to
     * the spec - a problem is not said. `text`: for `next`, what the
     * spec's box beside it says - the phase's first pass gets it.
     */
    const specAction = useCallback(async (spec: string, action: SpecAction, quiet = false, text?: string): Promise<void> => {

        if (!specsAt)
            return;

        let answer: SpecCommandAnswer & { problem?: string };

        try {

            answer = await bridge.request<SpecCommandAnswer>(API.sddCommand, {
                workspace: specsAt, spec, action,
                ...(phaseLink ? { phase: phaseLink.phase } : {}),
                ...(text?.trim() ? { text } : {})
            });

        } catch (error) {

            return quiet ? undefined : addToast(`Could not reach the server: ${(error as Error).message}`);
        }

        if (answer.problem || typeof answer.spec !== "string")
            return quiet ? undefined : addToast(answer.problem ?? "That did not work.");

        const tab: SpecInAddress = { spec: answer.spec, ...(answer.folder ? { folder: answer.folder } : {}) };

        // A normal chat is tied to the spec it just worked with.
        if (!phaseLink)
            watch({ ...tab, by: "pick" });

        if (answer.note)
            addToast(answer.note);

        if (answer.text)
            bridge.toView({ type: "addText", text: answer.text });

        if (answer.chatId && answer.chatId !== chatId)
            return goTo(chatAddress(answer.chatId, tab));

        if (answer.chatId || answer.open)
            openSpecTab(specsAt, tab, answer.open?.phase);

    }, [specsAt, phaseLink, chatId, watch, addToast, openSpecTab]);

    /**
     * Asked with each message before it is sent. A message that is
     * nothing but a `>spec` command is run here, and the agent never
     * sees it: `>spec>new <text>` opens New spec with the text, and
     * `>spec>NAME>open` (resume, next, ...) is an action. Any other
     * message is sent as typed - and one that names a spec's document
     * ties this chat to that spec.
     */
    const takeSend = useCallback((text: string): boolean => {

        if (!specsAt)
            return false;

        const command = specCommand(text);

        if (!command) {

            const named = specsNamed(text);

            if (named.length && !phaseLink)
                void specAction(named[named.length - 1]!, "watch", true);

            return false;
        }

        if (command.kind === "action")
            void specAction(command.spec, command.action);

        else if (sddWorkspace?.archived)
            addToast("This workspace is archived - no new spec can be made in it.");

        else
            setNewSpecIn(command.text ? { text: command.text } : {});

        return true;

    }, [specsAt, phaseLink, specAction, sddWorkspace?.archived, addToast]);

    // By itself: a turn of a normal chat wrote a file inside a spec's
    // folder, so the chat is tied to that spec. Not over a pick. The
    // server says whether the folder is a spec.
    const wroteIn = specsAt && !phaseLink && watched?.by !== "pick"
        ? specOfFiles(agentFiles.map(file => file.path))
        : undefined;

    const watchedName = watched?.spec;

    useEffect(() => {

        if (wroteIn && wroteIn.toLowerCase() !== watchedName?.toLowerCase())
            void bridge.request<SpecCommandAnswer>(API.sddCommand, { workspace: specsAt!, spec: wroteIn, action: "watch" })
                .then(answer => {

                    if (!answer.problem && typeof answer.spec === "string")
                        watch({ spec: answer.spec, ...(answer.folder ? { folder: answer.folder } : {}), by: "auto" });
                })
                .catch(() => undefined);

    }, [wroteIn, watchedName, specsAt, watch]);

    const main = unknown
        ? (
            <div className="eesha-gone">
                <h2>That session is not here</h2>
                <p>It may have been deleted. Pick another session, or start a new one.</p>
                <Button variant="primary" onClick={() => void newChat()}>New session</Button>
            </div>
        )
        : moved
            ? (
                <div className="eesha-gone">
                    <h2>This session is open in another tab</h2>
                    <p>A session is shown in one browser tab at a time, and it was opened in another one.</p>
                    <Button variant="primary" onClick={() => location.reload()}>Show it here instead</Button>
                </div>
            )
            : (
                <PopoverDefaults compactBelow={false}>
                    {/* Shell commands in the thread get Run. */}
                    <CommandBlockContext.Provider value={CommandBlock}>
                        <ChatPane
                            emptyText="What should the agent work on?"
                            side={{
                                ...(chatFold("changes") && changesBody ? { changes: changesBody } : {}),
                                ...(logsShown && logsBody ? { logs: logsBody } : {}),
                                ...(sessionOpen && sessionBody ? { session: sessionBody } : {})
                            }}
                            sessionExtras={sessionExtras}
                            onAgentFiles={setAgentFiles}
                            onTurnMessages={setTurnMessages}
                            takeSend={takeSend} />
                    </CommandBlockContext.Provider>
                </PopoverDefaults>
            );

    /** The page's workspace, for the header and the Sessions section: the session's workspace, else "" for No workspace - whatever its folders - else a workspace page's. */
    const herePlace = chat ? chatPlace ?? "" : workspacePage ? workspaceAt : undefined;

    /**
     * The repository the footer names the branch of: the one the session's
     * first folder is in (the folder itself or a folder above it), else the
     * first one read. `repos` only ever holds this session's repositories.
     */
    const firstFolder = chat?.folders[0] ? pathKey(chat.folders[0]) : undefined;
    const branch = (firstFolder ? repos.find(repo => firstFolder === pathKey(repo.root) || firstFolder.startsWith(`${pathKey(repo.root)}/`)) : undefined)?.branch ?? repos[0]?.branch;

    /**
     * Over a session, only while something is hidden: the button that
     * brings it back. No title - the browser tab, the panel's row and the
     * message box already say the session's name and whether it works.
     */
    const crumb = chat && !settings && ((editorShown && besideHidden) || (editorHidden && tabs.tabs.length && chatOn))
        ? (
            <div className="eesha-restore-row">
                {editorShown && besideHidden
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" title="Show the chat and the workspace panel beside the editor again" onClick={() => setBesideHidden(false)}>
                            Show the chat
                        </Button>
                    )
                    : null}

                {editorHidden && tabs.tabs.length && chatOn
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" title="Show the editor again" onClick={() => setEditorHidden(false)}>
                            Editor · {tabs.tabs.length} {tabs.tabs.length === 1 ? "tab" : "tabs"}
                        </Button>
                    )
                    : null}
            </div>
        )
        : null;

    /**
     * The spec a chat belongs to: a phase chat's own, made by SDD; else
     * the spec a normal chat is tied to (watchedSpec.ts).
     */
    const link = chatOn ? chat?.spec : undefined;
    const tiedTo = chatOn && !link ? watched : undefined;
    const lineSpec = link ?? tiedTo;
    const lineTab: SpecInAddress | undefined = lineSpec ? { spec: lineSpec.spec, ...(lineSpec.folder ? { folder: lineSpec.folder } : {}) } : undefined;

    /** That spec shows now as the editor's tab beside the chat. */
    const lineSpecShown = lineTab !== undefined && editorShown && activeTab?.what.kind === "spec"
        && activeTab.what.spec === lineTab.spec && (activeTab.what.folder ?? "") === (lineTab.folder ?? "");

    /**
     * A phase chat opens beside its spec - the spec page: the document
     * big in the middle, this chat narrow on the right. Once per chat and
     * page load, so a spec tab closed by hand stays closed.
     */
    const openedSpecFor = useRef<string | undefined>(undefined);

    useEffect(() => {

        if (!specRestored || !link || !specsAt || !chat || openedSpecFor.current === chat.chatId)
            return;

        openedSpecFor.current = chat.chatId;

        const there = tabs.tabs.some(tab => tab.what.kind === "spec" && tab.what.spec === link.spec && (tab.what.folder ?? "") === (link.folder ?? ""));

        if (!there)
            openSpecTab(specsAt, { spec: link.spec, ...(link.folder ? { folder: link.folder } : {}) }, link.phase);

    }, [specRestored, link, specsAt, chat, tabs.tabs, openSpecTab]);

    /**
     * The line over the chat's thread while its spec is not beside it: a
     * phase chat says whose phase it is; a normal chat says which spec it
     * is tied to. Open spec brings the spec back. There is no untie.
     */
    const phaseLine = lineSpec && lineTab && !lineSpecShown
        ? (
            <div className="eesha-phase-line">
                <UiIcon name="checklist" size="sm" />
                {link
                    ? (
                        <span className="eesha-phase-line__text" title={`SDD made this session for the ${phaseName(link.phase)} phase of spec ${link.spec}`}>
                            Phase chat of spec <strong>{link.spec}</strong> · {phaseName(link.phase)}
                        </span>
                    )
                    : (
                        <span className="eesha-phase-line__text" title={`This chat worked with spec ${lineSpec.spec}. Its phases are on the spec's page.`}>
                            Tied to spec <strong>{lineSpec.spec}</strong>
                        </span>
                    )}
                {specsAt
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" onClick={() => openSpecTab(specsAt, lineTab, link?.phase)}>
                            Open spec
                        </Button>
                    )
                    : null}
            </div>
        )
        : null;

    /** Over a workspace page, only while the page is hidden behind the editor: the button that brings it back. No title - the header's workspace picker names it. */
    const workspaceCrumb = workspacePage && !settings && workspaceEditorShown && besideHidden
        ? (
            <div className="eesha-restore-row">
                <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    fill="outline"
                    title="Show the workspace page and the workspace panel beside the editor again"
                    onClick={() => setBesideHidden(false)}>
                    Show the page
                </Button>
            </div>
        )
        : null;

    /** The AI button's dot: another session waits or works, and the Sessions section is not on screen. */
    const aiDot = !foldShown("sessions") && (othersWaiting || othersWorking) ? (othersWaiting ? "waiting" : "working") : undefined;

    /** The editor's column, between the workspace panel and the chat (or the workspace page). */
    const editorColumn = (beside: string) => (
        <div className="eesha-editor-column">
            <EditorArea
                state={tabs}
                emptyText=""
                help={editorHelp}
                onShow={id => setTabs(current => showTab(current, id))}
                onClose={id => setTabs(current => closeTab(current, id))}
                onKeep={id => setTabs(current => keepTab(current, id))}
                onHide={() => setEditorHidden(true)}
                beside={beside}
                maximized={besideHidden}
                onMaximize={() => setBesideHidden(now => !now)} />
        </div>
    );

    /** Where New spec makes its spec: the workspace picked in the Sessions section, else the page's own. */
    const specPlace = newSpecIn?.place ?? sddShown;

    const header = (
        <AppHeader
            start={!settings
                ? (
                    <>
                    <HeaderButton
                        label="Workspace panel"
                        title={`${listOpen && !maximized ? "Hide" : "Show"} the workspace panel: sessions, specs, files, git (${mod}+B)`}
                        icon="chat"
                        pressed={listOpen && !maximized}
                        dot={aiDot}
                        dotLabel={aiDot === "waiting" ? "another session is waiting for you" : "another session is working"}
                        onClick={() => {
                            if (maximized) {
                                setBesideHidden(false);
                                setListOpen(true);
                            }
                            else
                                setListOpen(now => !now);
                        }} />
                    {/* After the name, by its style (frame.scss): the header's order is the panel button, the name, then the workspace. */}
                    <WorkspacePicker
                        chats={chats}
                        aliases={aliases}
                        workspaces={workspaces}
                        place={herePlace}
                        onAddFolder={() => setFolderWindow({})}
                        onEditFolder={folder => setFolderWindow({ editing: folder })}
                        onRemoveFolder={key => void removeFolder(key)}
                        onNextItem={workspace => setFolderWindow({ next: workspace })}
                        onArchiveWorkspace={(key, archived) => void archiveWorkspace(key, archived)}
                        onAlias={(folder, key) => setAliasFor({ folder, ...(key ? { key } : {}) })}
                        onDeleteMany={(ids, where) => void deleteMany(ids, where)} />
                    </>
                )
                : undefined}
            name="Eesha Code"
            href="/"
            hrefTitle="Open the start page"
            // The prompt sign (>_) on its own: the icon set's terminal icon has a box around it, too busy in a 20px square.
            logo={<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M7 8l4 4-4 4 M13 16h5" /></svg>}
            end={
                <>
                    <HeaderButton label="Search sessions" title={`Search sessions (${mod}+K)`} aria-haspopup="dialog" icon="search" onClick={() => setSearching(true)} />
                    <LibraryMenu
                        ariaLabel="More"
                        placement="bottom"
                        items={[
                            { label: "Keyboard shortcuts", icon: "keyboard", end: `${mod}+/`, onSelect: () => setShortcuts(true) },
                            ...(evalsOn ? [{ label: "Evaluator", icon: "diff" as const, href: evalAddress() }] : [])
                        ]}
                        trigger={<HeaderButton label="More" icon="more" />} />
                    <HeaderButton label="Settings" href={settingsAddress()} current={settings} icon="settings" />
                </>
            } />
    );

    const footer = (
        <AppFooter
            start={chat && !settings ? <span title={chat.folders.join("\n")}>{folderLabel}{branch ? ` · ${branch}` : ""}</span> : undefined}
            end={
                <>
                    {window.location.port ? <span title="The port this page is served on">port {window.location.port}</span> : null}
                    {version
                        ? (
                            <button
                                type="button"
                                className="eesha-footer-version"
                                disabled={building}
                                title={install === "source" ? `Eesha Code ${version}, run from source - build and restart` : `Eesha Code ${version} - check for updates`}
                                onClick={() => install === "source" ? void buildAndRestart() : setUpdateOpen(true)}>
                                {building ? "building…" : `v${version}`}
                            </button>
                        )
                        : null}
                    <a
                        className="eesha-footer-github"
                        href={REPO_URL}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Eesha Code on GitHub"
                        title="Eesha Code on GitHub">
                        <UiIcon name="github" size="custom" />
                    </a>
                </>
            } />
    );

    return (
        <>
        {/* Below 1024px a cover asks for a wider window; below 1280px the page stays 1280 wide and scrolls sideways. */}
        <AppShell header={header} footer={footer} minWidth={PAGE_MIN} scrollBelow={PAGE_WIDTH} narrowText={`Eesha Code needs a window at least ${PAGE_MIN} pixels wide. Make the window wider.`}>

                {/* The workspace panel: its sections, one under the other. On every page but Settings. */}
                {!settings
                    ? (
                        <SidePanel
                            width={navWidth}
                            min={NAV_MIN}
                            max={NAV_MAX}
                            edge="right"
                            label="Width of the workspace panel"
                            className="eesha-nav-panel"
                            hidden={!listOpen || maximized}
                            onWidth={setNavWidth}>
                            <div className="eesha-folds">
                                <ChatList
                                    chats={chats}
                                    loaded={chatsLoaded}
                                    current={chatId}
                                    place={herePlace}
                                    open={panelState.folds.includes("sessions")}
                                    onToggle={() => toggle("sessions")}
                                    kiro={kiroRows}
                                    onOpenKiro={row => void openKiro(row)}
                                    onRenameKiro={row => void changeKiro(API.renameKiro, row)}
                                    onDeleteKiro={row => void changeKiro(API.deleteKiro, row)}
                                    onNew={(folder, key) => void newChat(folder, "", undefined, key)}
                                    onNewSpec={workspace => setNewSpecIn({ place: sddPlace(workspace) })}
                                    workspaces={workspaces}
                                    onRename={id => bridge.toChat({ type: "renameChat", chatId: id })}
                                    onDelete={id => void deleteRow(id)}
                                    onMark={(id, mark) => void markChat(id, mark)}
                                    aliases={aliases}
                                    onNote={addToast} />

                                {chatOn
                                    ? (
                                        <>
                                            <Fold name="files" title="Files" open={panelState.folds.includes("files")} onToggle={() => toggle("files")}>
                                                {visited.has("files")
                                                    ? (
                                                        <FilesPane
                                                            chat={chat!}
                                                            hidden={!panelState.folds.includes("files")}
                                                            current={currentFile}
                                                            running={running}
                                                            agentFiles={agentFiles}
                                                            tabs={tabs}
                                                            onRepos={setRepos}
                                                            onAttach={attach}
                                                            onOpen={(entry, keep) => open({ kind: "file", path: entry.relativePath }, entry.name, entry.relativePath, keep)}
                                                            onShowTab={id => { setTabs(current => showTab(current, id)); setEditorHidden(false); }}
                                                            onKeepTab={id => setTabs(current => keepTab(current, id))}
                                                            onCloseTab={id => setTabs(current => closeTab(current, id))}
                                                            onShowInGit={mark => {
                                                                const ask: GitDiffAsk = { side: mark.side, path: mark.path };
                                                                open({ kind: "git", root: mark.root, ask }, fileName(mark.path), `${mark.path} - ${gitWhere(ask)}`, false);
                                                            }}
                                                            onShowAgentChange={file => bridge.toChat({ type: "diffFile", changed: { root: file.root, before: file.before, after: file.after }, path: file.file })}
                                                            onAddFolder={() => setEditing(true)}
                                                            onFindFile={() => setFindingFile(true)} />
                                                    )
                                                    : null}
                                            </Fold>

                                            {hasFolder
                                                ? (
                                                    <>
                                                        <Fold
                                                            name="changes"
                                                            title="AI changes"
                                                            fact={agentFiles.length ? `${agentFiles.length} file${agentFiles.length === 1 ? "" : "s"}` : undefined}
                                                            open={panelState.folds.includes("changes")}
                                                            onToggle={() => toggle("changes")}>
                                                            <PanelView title="AI changes" label="AI changes" hidden={!panelState.folds.includes("changes")} bodyRef={setChangesBody} />
                                                        </Fold>

                                                        <Fold name="git" title="Git" fact={branch} open={panelState.folds.includes("git")} onToggle={() => toggle("git")}>
                                                            {visited.has("git")
                                                                ? (
                                                                    <GitPane
                                                                        chat={chat!}
                                                                        hidden={!panelState.folds.includes("git")}
                                                                        running={running}
                                                                        agentFiles={agentFiles}
                                                                        onRepos={setRepos}
                                                                        onOpenDiff={(diff, keep) => open({ kind: "git", root: diff.root, ask: diff.ask }, diff.title, diff.tip, keep)} />
                                                                )
                                                                : null}
                                                        </Fold>
                                                    </>
                                                )
                                                : null}

                                            <Fold name="session" title="This session" open={panelState.folds.includes("session")} onToggle={() => toggle("session")}>
                                                <PanelView
                                                    title="This session"
                                                    label="This session"
                                                    hidden={!panelState.folds.includes("session")}
                                                    bodyRef={setSessionBody}
                                                    actions={
                                                        <>
                                                            <PanelButton icon="download" label="Export this session" title={listed ? "Export this session as a Markdown file" : "Export: nothing to export yet"} onClick={() => { if (listed) void exportChat(); }} />
                                                            <PanelButton icon="logs" label="Logs for this session" title={`Logs for this session (${mod}+Shift+U)`} pressed={logsShown} onClick={toggleLogs} />
                                                        </>
                                                    } />
                                            </Fold>
                                        </>
                                    )
                                    : null}
                            </div>
                        </SidePanel>
                    )
                    : null}

                <div className="eesha-work">

                    {settings
                        ? (
                            <div className="eesha-page eesha-page--settings">
                                <main className="eesha-main eesha-scroll">
                                    <SettingsPage section={page} />
                                </main>
                            </div>
                        )
                        : workspacePage
                            ? (
                                <>
                                    {workspaceCrumb}

                                    {/* The editor in the middle, the workspace page on the right at the chat's width. */}
                                    <div className="eesha-stage">

                                        {workspaceEditorShown ? editorColumn("workspace page") : null}

                                        {/* One element whether the editor shows or not, as for a session's chat. */}
                                        <SidePanel
                                            width={widths.chat}
                                            min={CHAT_MIN}
                                            max={CHAT_MAX}
                                            edge="left"
                                            label="Width of the workspace page"
                                            className={`eesha-chat${workspaceEditorShown ? "" : " eesha-chat--fill"}`}
                                            hidden={workspaceEditorShown && besideHidden}
                                            onWidth={chat => setWidths(current => ({ ...current, chat }))}>
                                            <main className="eesha-main eesha-main--start eesha-workspace-main eesha-scroll">
                                                <WorkspacePage
                                                    workspaceKey={workspaceAt ?? ""}
                                                    workspaces={workspaces}
                                                    chats={chats}
                                                    loaded={chatsLoaded}
                                                    besideSpec={specBesidePage}
                                                    onStart={(workspace, text, pick) => void newChat(workspace.folders[0], text, pick, workspaceKey(workspace))}
                                                    onSpecSend={(spec, text) => specAction(spec.spec, "next", false, text)}
                                                    onNextItem={workspace => setFolderWindow({ next: workspace })}
                                                    onNewSpec={() => setNewSpecIn({})} />
                                            </main>
                                        </SidePanel>
                                    </div>
                                </>
                            )
                        : !chatId
                            ? (
                                <main className="eesha-main eesha-main--start eesha-scroll">
                                    <StartPage
                                        chats={chats}
                                        loaded={chatsLoaded}
                                        aliases={aliases}
                                        workspaces={workspaces}
                                        onStart={(folder, text, pick) => void newChat(folder, text, pick)}
                                        onSearch={() => setSearching(true)}
                                        onAddFolder={() => setFolderWindow({})} />
                                </main>
                            )
                            : (
                                <>
                                    {crumb}

                                    {/* The editor in the middle, the chat on the right at its own width. */}
                                    <div className="eesha-stage">

                                        {editorShown ? editorColumn("chat") : null}

                                        {/* One element whether the editor shows or not, so the chat is never drawn anew. */}
                                        <SidePanel
                                            width={widths.chat}
                                            min={CHAT_MIN}
                                            max={CHAT_MAX}
                                            edge="left"
                                            label="Width of the chat"
                                            className={`eesha-chat${editorShown ? "" : " eesha-chat--fill"}`}
                                            hidden={editorShown && besideHidden}
                                            onWidth={chat => setWidths(current => ({ ...current, chat }))}>
                                            {phaseLine}
                                            <main className="eesha-main">{main}</main>
                                        </SidePanel>
                                    </div>
                                </>
                            )}
                </div>
        </AppShell>

            {/* The windows and toasts sit over the page, outside its frame. */}
            <SearchDialog
                show={searching}
                chats={chats}
                aliases={aliases}
                searchText={searchText}
                onOpen={openChat}
                onClose={() => setSearching(false)} />

            {chat
                ? (
                    <FindFileDialog
                        show={findingFile}
                        folders={chat.folders}
                        onOpen={path => { setFindingFile(false); open({ kind: "file", path }, fileName(path), path, false); }}
                        onClose={() => setFindingFile(false)} />
                )
                : null}

            {editing && chat
                ? (
                    <Modal show onHide={() => setEditing(false)} className="eesha-wide-modal">
                        <Modal.Header closeButton onClose={() => setEditing(false)}>
                            <Modal.Title>Workspace of this session</Modal.Title>
                        </Modal.Header>
                        <Modal.Body>
                            <FolderPicker
                                initial={chat.folders}
                                lockFirst={chat.started && !chat.scratch}
                                allExtras={chat.started && chat.scratch}
                                allowEmpty={!chat.started || chat.scratch}
                                submitLabel="Save"
                                disabled={running}
                                intro={folderIntro(chat, running)}
                                onCancel={() => setEditing(false)}
                                onSubmit={saveFolders} />
                        </Modal.Body>
                    </Modal>
                )
                : null}

            {/* Before the questions: Undo may ask first, over this window. */}
            {shown?.kind === "review"
                ? (
                    <ReviewDialog
                        files={shown.files}
                        onUndo={file => bridge.toChat({ type: "undoFiles", changed: file.changed, paths: [file.file] })}
                        onClose={() => setShown(undefined)} />
                )
                : null}

            {prompts[0] ? <PromptDialog key={prompts[0].id} prompt={prompts[0].prompt} onAnswer={value => answer(prompts[0].id, value)} /> : null}

            {aliasFor && !prompts[0]
                ? (
                    <PromptDialog
                        key={aliasFor.key ?? aliasFor.folder}
                        prompt={{
                            kind: "text",
                            title: "Workspace name",
                            value: aliases.get(aliasFor.key ?? folderKey(aliasFor.folder)) ?? "",
                            text: `The session list shows this name for ${aliasFor.folder}. Leave it empty to show '${baseName(aliasFor.folder)}' again.`
                        }}
                        onAnswer={value => void saveAlias(aliasFor.folder, aliasFor.key, value)} />
                )
                : null}

            {folderWindow
                ? (
                    <WorkspaceDialog
                        editing={folderWindow.editing}
                        editKey={folderWindow.editing && workspaces.some(one => workspaceKey(one) === workspaceKey(folderWindow.editing!)) ? workspaceKey(folderWindow.editing) : undefined}
                        next={folderWindow.next}
                        onClose={() => setFolderWindow(undefined)} />
                )
                : null}

            {newSpecIn && specPlace
                ? (
                    <NewSpecDialog
                        place={newSpecIn.folder ? { ...specPlace, folder: newSpecIn.folder } : specPlace}
                        text={newSpecIn.text}
                        onClose={() => setNewSpecIn(undefined)}
                        onMade={name => goTo(workspaceAddress(specPlace.key, { spec: name, ...(newSpecIn.folder ? { folder: newSpecIn.folder } : {}) }))}
                        onChat={(folder, text, workspace) => { setNewSpecIn(undefined); void newChat(folder, text, undefined, workspace); }}
                        onCopyStyle={() => { setNewSpecIn(undefined); setCopyStyleOpen(true); }} />
                )
                : null}

            {copyStyleOpen && sddShown
                ? <CopyStyleDialog place={sddShown} onClose={() => setCopyStyleOpen(false)} />
                : null}

            {shortcuts ? <ShortcutsDialog list={shortcutList(isMac())} onClose={() => setShortcuts(false)} /> : null}
            {updateOpen ? <UpdateDialog onClose={() => setUpdateOpen(false)} onStarted={() => { reloadOnHello.current = true; }} /> : null}

            <Toasts toasts={toasts} onClose={closeToast} onOpen={openChat} />
        </>
    );
}

/** A connector as the Session panel names it: connected or not, and the widest access any of its sources has. */
function sessionConnector(card: ConnectorCard): SessionConnector {

    const access = Object.values(card.config?.sources ?? {});

    return {
        title: card.title,
        connected: card.config !== undefined,
        ...(card.account ? { account: card.account } : {}),
        access: access.includes("write") ? "write" : access.includes("read") ? "read" : "off"
    };
}

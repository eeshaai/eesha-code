import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ToChatView } from "../shared/chatMessages";
import ChatPane from "../view/chat/ChatPane";
import type { AgentFile } from "../view/chat/pendingChanges";
import type { SessionConnector, SessionExtras } from "../view/chat/SessionPanel";
import { CommandBlockContext } from "../view/commandBlock";
import { AppFooter, AppHeader, AppShell, BarDivider, Button, type FileEntry, type FileSelection, HeaderButton, languageOf, LibraryMenu, type MenuEntry, Modal, PanelView, PopoverDefaults, SessionHeader, SidePanel, StatusDot, StatusPill, UiIcon } from "../view/ui";
import { API, type UpgradedView, ChatInfo, ChatMark, ChatRow, type ConnectorCard, folderKey, GitDiffAsk, GitStatus, KiroRow, newestAt, placeKey, PromptRequest, ReviewFile, SearchHit, type SessionInfo, type SettingsView, type SpecSessionView, type Workspace, workspaceKey } from "../server/protocol";
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
import ModuleStrip from "./ModuleStrip";
import { chatAddress, dropSpecsNote, pageInAddress, sddInAddress, type SettingsSection, settingsAddress, specInAddress, type SpecInAddress, specsAskedFor, workspaceAddress, workspaceInAddress } from "./pageRoute";
import { CHAT_MAX, CHAT_MIN, editorFits, loadPanels, loadWidths, NAV_MAX, NAV_MIN, PAGE_MIN, PAGE_WIDTH, pageWidth, PANEL_MAX, PANEL_MIN, pickModule, RightPanel, savePanels, saveWidths, STRIP_ON_LOAD, type StripState, togglePanel, Widths } from "./sideState";
import { noticeText, pageTitle, showNotice } from "./notices";
import CopyStyleDialog from "./CopyStyleDialog";
import NewSpecDialog from "./NewSpecDialog";
import { specLine } from "./sddLine";
import SpecExplorer, { type SpecTarget } from "./SpecExplorer";
import SearchDialog from "./SearchDialog";
import SettingsPage from "./SettingsPage";
import StartPage, { type StartPickBody } from "./StartPage";
import WorkspacePage from "./WorkspacePage";
import { exportName } from "./exportName";
import { isMac, modName, shortcutList, shortcutOf, typesText } from "./shortcuts";
import { applyFontSize, applyTheme } from "./theme";
import UpdateDialog from "./UpdateDialog";
import WorkspaceDialog from "./WorkspaceDialog";
import { pickerOrder, sddPlace } from "./workspacePick";

/*
 * The Eesha Code page. Top to
 * bottom: a header (the name, Search, More, Settings), then the page,
 * then a footer line.
 *
 * With a session open, left to right: the strip of module icons (AI and
 * SDD) and the picked module's
 * panel beside it - the session list or the specs - then one header row
 * over the chat, the editor and the right panel.
 * The editor opens between the chat and the right panel when a file, a
 * diff or the logs open; the chat then shrinks to its own width. The
 * right panel shows Git, AI changes or the File explorer, and does not
 * follow the editor's tabs.
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

/** How a phase chat's line names its phase: `implement@wave:2` is "implement, wave 2". */
function phaseName(phase: string): string {

    const wave = /^(.*)@wave:(\d+)$/.exec(phase);

    return wave ? `${wave[1]}, wave ${wave[2]}` : phase;
}

export default function App() {

    /** The chat this page shows - the one the address names. None: the start page. */
    const [chatId, setChatId] = useState(bridge.chatId);

    const [chat, setChat] = useState<ChatInfo | undefined>();
    const [chats, setChats] = useState<ChatRow[]>([]);

    /** The first chat list came from the server - the list on the left starts its folders closed then. */
    const [chatsLoaded, setChatsLoaded] = useState(false);

    /** The names given to folders that are no workspace - sent with the chat list. */
    const [folderAliases, setAliases] = useState<Aliases>(NO_ALIASES);

    /** The workspaces - sent with the chat list. */
    const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);

    /** The names every list shows: each workspace's own name, and the aliases of other folders. */
    const aliases = useMemo(() => namesOf(folderAliases, workspaces), [folderAliases, workspaces]);

    /** Kiro's own sessions in the list's folders - sent with the chat list. */
    const [kiroRows, setKiroRows] = useState<readonly KiroRow[]>([]);

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

    /** The New spec window is open - for a spec in `folder`, or in the main folder when it has none. */
    const [newSpecIn, setNewSpecIn] = useState<{ folder?: string } | undefined>();
    const [copyStyleOpen, setCopyStyleOpen] = useState(false);

    /**
     * The panels this session had open before a reload of this browser
     * tab. Not on a workspace page or Settings: those
     * decide their own panels.
     */
    const [keptPanels] = useState(() => oldSpecLink || workspacePage || settings ? undefined : loadPanels(bridge.chatId));

    /**
     * The strip at the far left: the module picked, and whether its panel
     * shows. A session's reload uses what it kept; otherwise STRIP_ON_LOAD.
     * Specs are not a module: they are in the Spec explorer, on the right.
     */
    const [strip, setStrip] = useState<StripState>(() => keptPanels?.strip ?? STRIP_ON_LOAD);

    /** The SDD module shows (the `Feature-SDD` flag). Not known until the server's hello. */
    const [sddModule, setSddModule] = useState<boolean | undefined>();

    // An older spec link goes on to where the spec is now - see
    // `oldSpecLink`. With the flag off, to the start page: SDD is only
    // hidden, the specs stay.
    useEffect(() => {

        if (!oldSpecLink || sddModule === undefined)
            return;

        const { workspace, spec, folder } = oldSpecLink;

        if (sddModule === false || !workspace)
            return location.replace(chatAddress(undefined));

        if (!spec)
            return location.replace(workspaceAddress(workspace));

        const tab: SpecInAddress = { spec, ...(folder ? { folder } : {}) };

        void phaseChatOf(workspace, tab, oldSpecLink).then(id => location.replace(id ? chatAddress(id, tab) : workspaceAddress(workspace, tab)));

    }, [sddModule, oldSpecLink]);

    /** A module panel shows beside the strip. */
    const listOpen = strip.open;

    /** Shows or hides the module panel. */
    const setListOpen = useCallback((open: boolean | ((now: boolean) => boolean)) =>
        setStrip(now => ({ ...now, open: typeof open === "function" ? open(now.open) : open })), []);

    /** Opens the AI panel: the session list. */
    const showSessions = useCallback(() => setStrip({ module: "ai", open: true }), []);

    /** The panel on the right of the chat. A session's reload opens the one it kept. */
    // A workspace page opened from the Specs item of its menu starts
    // with the Spec explorer shown.
    const [panel, setPanel] = useState<RightPanel | undefined>(() =>
        keptPanels?.panel ?? (workspacePage && specsAskedFor(workspaceAt) ? "specs" : undefined));

    // The Specs item's word is used once: a reload opens the page as usual.
    useEffect(() => dropSpecsNote(), []);

    // Keeps the session's open panels for a reload of this browser tab.
    useEffect(() => {

        if (!oldSpecLink && !workspacePage && !settings)
            savePanels(chatId, { strip, panel });

    }, [chatId, strip, panel, oldSpecLink, workspacePage, settings]);

    /** The panels opened once: they stay drawn (hidden) while closed, so they keep their open folders. */
    const [visited, setVisited] = useState<ReadonlySet<RightPanel>>(new Set());

    useEffect(() => {

        if (panel && !visited.has(panel))
            setVisited(current => new Set([...current, panel]));

    }, [panel, visited]);

    /** The editor was hidden with Hide editor. Its tabs stay open. */
    const [editorHidden, setEditorHidden] = useState(false);

    /**
     * The editor is maximized: the chat (or the workspace page), the
     * panel beside the strip and the right panel are hidden, so the
     * editor takes the row. Each panel keeps whether it was open, and
     * shows again as it was. Only while the editor shows; never kept for
     * a reload.
     */
    const [besideHidden, setBesideHidden] = useState(false);

    /** The widths of the chat (beside the editor) and of the right panel - kept in this browser. */
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

    /** Where the chat view draws the AI changes list (right panel) and the log (Logs tab). */
    const [changesBody, setChangesBody] = useState<HTMLElement | null>(null);
    const [logsBody, setLogsBody] = useState<HTMLElement | null>(null);

    /** Where the chat view draws the Session panel (right panel). */
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
     * the Spec explorer. Without one, the phase of the chat beside it. A
     * spec tab is drawn again each time it comes to the front.
     */
    const [specPicks, setSpecPicks] = useState<Record<string, string>>({});

    /** What `open` needs to know of the layout now, without being made again on each change. */
    const layout = useRef({ listOpen, navWidth, panel, widths });

    layout.current = { listOpen, navWidth, panel, widths };

    /**
     * Opens a file, a diff or the logs as a tab, and shows the editor. When
     * the editor would get less than its least room, the session list
     * closes by itself.
     */
    const open = useCallback((what: TabWhat, title: string, tip: string, keep: boolean) => {

        setTabs(current => openTab(current, { title, tip, what }, keep));
        setEditorHidden(false);

        const now = layout.current;

        if (now.listOpen && !editorFits(pageWidth(window.innerWidth), now.navWidth, now.widths.chat, now.panel ? now.widths.panel : undefined))
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
     * The workspace the Spec explorer lists: a workspace page's own; on a
     * session, the session's workspace, else the newest workspace on its
     * first folder. Nothing: a session with no workspace, or the start page.
     */
    const sddWorkspace = workspacePage
        ? workspaces.find(one => workspaceKey(one) === workspaceAt)
        : chat
            ? workspaces.find(one => chat.workspace !== undefined && workspaceKey(one) === chat.workspace)
                ?? (chat.folders[0] ? newestAt(pickerOrder(workspaces), chat.folders[0]) : undefined)
            : undefined;

    /** The explorer's place: its workspace's key, name and main folder - for New spec and Copy a style. */
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
        // The chat is always beside the editor: this puts the cursor in its message box.
        onGoToSession: () => document.querySelector<HTMLTextAreaElement>(".eesha-main .ee-prompt-input__textarea")?.focus(),
        setLogsBody,
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

    /** Whether this page load has told about the chats waiting for an answer yet. */
    const toldWaiting = useRef(false);

    const loadChats = useCallback(async () => {

        try {

            const answer = await bridge.request<{ chats?: ChatRow[]; aliases?: Record<string, string>; workspaces?: Workspace[]; kiro?: KiroRow[] }>(API.chats, {});

            if (!answer.chats)
                return;

            setChats(answer.chats);
            setAliases(new Map(Object.entries(answer.aliases ?? {})));
            setWorkspaces(answer.workspaces ?? []);
            setKiroRows(answer.kiro ?? []);
            setChatsLoaded(true);

            // Once per page load: a chat stopped on a question while no
            // tab was open gets a notice with Open. Its question was told
            // to nobody, or to a tab that is gone. The start page lists
            // them itself.
            if (!toldWaiting.current) {

                toldWaiting.current = true;

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

        location.assign(chatAddress(answer.chatId));

    }, [addToast]);

    /** The session's workspace, for the header row: its name, "No workspace", or its first folder and how many more. */
    const chatPlace = chat?.workspace;
    const folderLabel = chat
        ? chat.folders.length ? `${(chatPlace ? aliases.get(chatPlace) : undefined) ?? folderName(chat.folders[0], aliases)}${chat.folders.length > 1 ? ` +${chat.folders.length - 1}` : ""}` : "No workspace"
        : "";


    /**
     * The workspaces whose specs this tab shows: those of its spec tabs,
     * and the one in the Spec explorer while it is open. A spec's notice
     * (`eesha.sddNote`) is shown only here. Kept in a ref so the page's
     * message handler, set up once, reads the current one.
     */
    const sddShowing = useRef<(string | undefined)[]>([]);

    sddShowing.current = [panel === "specs" ? sddShown?.key : undefined, ...tabs.tabs.flatMap(tab => tab.what.kind === "spec" ? [tab.what.workspace] : [])];

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
                    setSddModule(message.sddModule);
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

                case "eesha.sddModule":
                    return setSddModule(message.on);

                case "eesha.chat":
                    return setChat(message.chat);

                case "eesha.unknownChat":
                    return setUnknown(true);

                case "eesha.moved":
                    return setMoved(true);

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

        location.assign(chatAddress(id, { spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) }));

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

    /** Goes to a chat: a real page load at its address. */
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

    /** The right panel on screen. A workspace page has only the Spec explorer. */
    const panelShown = chatOn ? panel : workspacePage && sddModule === true && sddWorkspace && panel === "specs" ? panel : undefined;

    /**
     * A click in the Spec explorer: the spec opens on its phase chat -
     * the picked session's, else the newest of the picked phase, else the
     * spec's newest - with the spec as a tab beside it. When that chat is
     * this one, the spec tab opens here. A spec with no phase chat yet
     * opens on its workspace page, where Start begins its first phase.
     */
    const openSpec = useCallback(async (target: SpecTarget) => {

        if (!sddShown)
            return;

        const tab: SpecInAddress = { spec: target.spec, ...(target.folder ? { folder: target.folder } : {}) };
        const id = await phaseChatOf(sddShown.key, tab, target);

        if (id && id !== chatId)
            return location.assign(chatAddress(id, tab));

        if (!id && !workspacePage)
            return location.assign(workspaceAddress(sddShown.key, tab));

        openSpecTab(sddShown.key, tab, target.session?.ownerId ?? target.phase);

    }, [sddShown, chatId, workspacePage, openSpecTab]);

    // The address's spec tab opens once the page knows its workspace - the
    // session's, or the workspace page's - at the phase of the chat beside
    // it. With SDD off, or no workspace to open it in, it is dropped.
    useEffect(() => {

        if (specRestored || !specAt || sddModule === undefined)
            return;

        if (sddModule === false || settings || unknown)
            return setSpecRestored(true);

        if (!chatsLoaded || (!workspacePage && !chat))
            return;

        if (sddShown)
            openSpecTab(sddShown.key, specAt);

        setSpecRestored(true);

    }, [specRestored, specAt, sddModule, settings, unknown, chatsLoaded, workspacePage, chat, sddShown, openSpecTab]);

    /** The spec tab the address keeps, by tab id - see the effect below. */
    const addressSpec = useRef<string | undefined>(undefined);

    // The address keeps one spec tab, so it comes back after a reload: the
    // one in front, else the one it kept while that is still open, else
    // any open one. Nothing else of the tabs is kept.
    useEffect(() => {

        if (!specRestored || settings || oldSpecLink || (!chatId && !workspacePage))
            return;

        const specTabs = tabs.tabs.filter(tab => tab.what.kind === "spec");
        const kept = specTabs.find(tab => tab.id === tabs.active) ?? specTabs.find(tab => tab.id === addressSpec.current) ?? specTabs[0];

        addressSpec.current = kept?.id;

        const spec = specTabOf(kept?.what);
        const address = workspacePage ? workspaceAddress(workspaceAt ?? "", spec) : chatAddress(chatId, spec);

        if (`${location.pathname}${location.search}` !== address)
            history.replaceState(history.state, "", address);

    }, [tabs, specRestored, settings, oldSpecLink, chatId, workspacePage, workspaceAt]);

    /** The Spec explorer - in the right panel of a session and of a workspace page. */
    const specExplorer = (hidden: boolean) => (
        <SpecExplorer
            workspace={sddWorkspace}
            current={specTabOf(tabs.tabs.find(tab => tab.id === tabs.active)?.what)}
            chats={chats}
            hidden={hidden}
            onNew={folder => setNewSpecIn(folder ? { folder } : {})}
            onCopyStyle={() => setCopyStyleOpen(true)}
            onOpen={openSpec}
            onNote={addToast} />
    );

    // The server watches the chat's repositories while the Git panel, the
    // File explorer (its git colors) or a git tab is open, and says when
    // one changed. Turned on again when the stream comes back: the server
    // may have restarted.
    const watchGit = chatOn && (panelShown === "git" || panelShown === "files" || tabs.tabs.some(tab => tab.what.kind === "git"));
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
    // branch shows without the Git panel or File explorer ever opened.
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

    /** The chat waits for an answer - a question here, or a card in the thread. */
    const waiting = prompts.length > 0 || chats.find(row => row.chatId === chatId)?.waiting !== undefined;

    /** Another session waits for an answer, or works - the AI icon's dot while its panel is hidden. Waiting wins. */
    const othersWaiting = chats.some(row => row.chatId !== chatId && row.waiting !== undefined);
    const othersWorking = chats.some(row => row.chatId !== chatId && row.working);

    /** The file the open tab shows - its row is marked in Files. */
    const activeTab: EditorTab | undefined = tabs.tabs.find(tab => tab.id === tabs.active);
    const currentFile = activeTab?.what.kind === "file" ? activeTab.what.path : undefined;

    /** The Logs tab shows. */
    const logsShown = editorShown && activeTab?.what.kind === "logs";

    // The Session panel's own reads: the steering files and the MCP
    // servers Eesha Code sends, the connectors, and the tools the settings
    // turn off. Read when the panel opens, when the session or its
    // folders change, and when a turn ends.
    const sessionOpen = panelShown === "session";

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

    /** A right panel icon: its panel opens, or closes when it is the one open. */
    const pickPanel = useCallback((picked: RightPanel) => {

        // Maximized, the panels are hidden: a panel's button ends the
        // maximize and shows that panel, rather than toggling one you
        // cannot see.
        if (maximized) {

            setBesideHidden(false);
            setPanel(picked);

            return;
        }

        setPanel(current => togglePanel(current, picked));

    }, [maximized]);

    const mod = modName(isMac());

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

                const order = listOrder(chats, aliases);
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

                // Maximized: the layout comes back with the list shown - see `pickPanel`.
                if (maximized) {

                    setBesideHidden(false);
                    setListOpen(true);

                    return;
                }

                setListOpen(current => !current);

                return;

            case "files":

                if (chatOn)
                    pickPanel("files");

                return;

            case "git":

                if (chatOn && hasFolder)
                    pickPanel("git");

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
                                ...(panelShown === "changes" && changesBody ? { changes: changesBody } : {}),
                                ...(logsShown && logsBody ? { logs: logsBody } : {}),
                                ...(panelShown === "session" && sessionBody ? { session: sessionBody } : {})
                            }}
                            sessionExtras={sessionExtras}
                            onAgentFiles={setAgentFiles}
                            onTurnMessages={setTurnMessages} />
                    </CommandBlockContext.Provider>
                </PopoverDefaults>
            );

    /** A header row icon for a right panel, the Logs tab, or Export. */
    const headIcon = (props: { label: string; keys?: string; icon: React.ComponentProps<typeof UiIcon>["name"]; pressed?: boolean; off?: string; onClick(): void }) => (
        <HeaderButton
            key={props.label}
            size="sm"
            label={props.label}
            icon={<UiIcon name={props.icon} size="md" />}
            pressed={props.pressed}
            title={props.off ? `${props.label}: ${props.off}` : `${props.label}${props.keys ? ` (${props.keys})` : ""}`}
            disabled={props.off !== undefined}
            onClick={props.onClick} />
    );

    /** The other sessions in this session's workspace (else folder) - the ⌄ menu lists the newest. */
    const herePlace = chat ? chatPlace ?? (chat.folders[0] ? folderKey(chat.folders[0]) : "") : "";
    const sameFolder = chat
        ? listOrder(chats, aliases).filter(row => placeKey(row) === herePlace).slice(0, 6)
        : [];

    /**
     * The repository the footer names the branch of: the one the session's
     * first folder is in (the folder itself or a folder above it), else the
     * first one read. `repos` only ever holds this session's repositories.
     */
    const firstFolder = chat?.folders[0] ? pathKey(chat.folders[0]) : undefined;
    const branch = (firstFolder ? repos.find(repo => firstFolder === pathKey(repo.root) || firstFolder.startsWith(`${pathKey(repo.root)}/`)) : undefined)?.branch ?? repos[0]?.branch;

    // The ⌄ menu after the title: New session, the newest sessions in this folder, All sessions.
    const sessionItems: MenuEntry[] = chat
        ? [
            { label: "New session", icon: "add", accent: true, onSelect: () => void newChat(chat.folders[0]) },
            "divider",
            ...(sameFolder.length
                ? [
                    { heading: `Recent in ${folderLabel}` },
                    ...sameFolder.map((row): MenuEntry => ({
                        label: row.title,
                        href: chatAddress(row.chatId),
                        end: row.chatId === chatId
                            ? "current"
                            : row.waiting !== undefined
                                ? <StatusDot tone="waiting" label="waiting for an answer" />
                                : row.working ? <StatusDot tone="working" label="working" /> : undefined
                    })),
                    "divider" as const
                ]
                : []),
            { label: "All sessions", icon: "history", onSelect: showSessions }
        ]
        : [];

    // The workspace name's menu: every other workspace - the workspaces, and
    // the folders sessions use that are no workspace - each with its 3
    // newest sessions, and a "+" on the heading for a workspace and for
    // "No workspace"; then Add a workspace and All
    // sessions. One click to another workspace's session.
    const folderItems: MenuEntry[] = (() => {

        if (!chat)
            return [];

        const here = chat.workspace ?? folderKey(chat.folders[0] ?? "");
        const archivedKeys = new Set(workspaces.filter(one => one.archived).map(workspaceKey));
        const groups = new Map<string, { folder: string; rows: ChatRow[] }>();

        for (const row of listOrder(chats, aliases)) {

            const folder = row.folders[0] ?? "";
            const key = placeKey(row);
            const group = groups.get(key) ?? { folder, rows: [] };

            group.rows.push(row);
            groups.set(key, group);
        }

        for (const one of workspaces)
            if (!groups.has(workspaceKey(one)))
                groups.set(workspaceKey(one), { folder: one.folders[0]!, rows: [] });

        // An archived workspace is not offered here.
        for (const key of archivedKeys)
            groups.delete(key);

        const entries: MenuEntry[] = [];

        for (const [key, group] of groups) {

            if (key === here)
                continue;

            const name = !group.folder ? "No workspace" : aliases.get(key) ?? folderName(group.folder, aliases);

            // A "+" on the heading makes a new session there - only for a
            // workspace and for "No workspace". A folder that is not a
            // workspace gets none: SDD does not work there.
            const isWorkspace = workspaces.some(one => workspaceKey(one) === key);
            const canAdd = !group.folder || isWorkspace;

            entries.push(
                canAdd
                    ? { heading: name, action: { label: group.folder ? `New session in ${name}` : "New session with no workspace", icon: "add", onSelect: () => void newChat(group.folder || undefined, "", undefined, isWorkspace ? key : undefined) } }
                    : { heading: name },
                ...group.rows.slice(0, 3).map((row): MenuEntry => ({
                    label: row.title,
                    href: chatAddress(row.chatId),
                    end: row.waiting !== undefined
                        ? <StatusDot tone="waiting" label="waiting for an answer" />
                        : row.working ? <StatusDot tone="working" label="working" /> : undefined
                })),
                "divider"
            );
        }

        return [
            ...entries,
            { label: "Add a workspace...", icon: "folder", onSelect: () => setFolderWindow({}) },
            { label: "All sessions", icon: "history", onSelect: showSessions }
        ];
    })();

    const crumb = chat && !settings
        ? (
            <SessionHeader
                folder={
                    <LibraryMenu
                        ariaLabel="Other workspaces"
                        placement="bottom"
                        items={folderItems}
                        trigger={
                            <button type="button" className="eesha-crumb-folder" title={`${chat.folders.join("\n") || "This session has no workspace"}\n\nClick to switch to another workspace or session`}>
                                {folderLabel}
                            </button>
                        } />
                }
                title={chat.title}
                after={
                    <>
                        {running && !waiting ? <StatusPill tone="working">Working</StatusPill> : null}
                        {waiting ? <StatusPill tone="waiting" title="The agent is waiting for your answer">Waiting for you</StatusPill> : null}
                        <LibraryMenu
                            ariaLabel="Sessions in this workspace"
                            placement="bottom"
                            items={sessionItems}
                            trigger={<HeaderButton size="sm" className="eesha-crumb-switch" label="Other sessions in this workspace" icon={<UiIcon name="expand" size="sm" />} />} />
                    </>
                }>

                {editorShown && besideHidden
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" className="eesha-crumb-editor" title="Show the chat and the panels beside the editor again" onClick={() => setBesideHidden(false)}>
                            Show the chat
                        </Button>
                    )
                    : null}

                {editorHidden && tabs.tabs.length && chatOn
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" className="eesha-crumb-editor" title="Show the editor again" onClick={() => setEditorHidden(false)}>
                            Editor · {tabs.tabs.length} {tabs.tabs.length === 1 ? "tab" : "tabs"}
                        </Button>
                    )
                    : null}

                {headIcon({ label: "Session", icon: "info", pressed: !maximized && panelShown === "session", off: chatOn ? undefined : "no session", onClick: () => pickPanel("session") })}
                {headIcon({ label: "Git", keys: `${mod}+Shift+G`, icon: "git", pressed: !maximized && panelShown === "git", off: !chatOn ? "no session" : hasFolder ? undefined : "needs a workspace", onClick: () => pickPanel("git") })}
                {headIcon({ label: "AI changes", icon: "diff", pressed: !maximized && panelShown === "changes", off: !chatOn ? "no session" : hasFolder ? undefined : "needs a workspace", onClick: () => pickPanel("changes") })}
                {headIcon({ label: "File explorer", keys: `${mod}+Shift+E`, icon: "folder", pressed: !maximized && panelShown === "files", off: chatOn ? undefined : "no session", onClick: () => pickPanel("files") })}
                {sddModule === true ? headIcon({ label: "Spec explorer", icon: "checklist", pressed: !maximized && panelShown === "specs", off: chatOn ? undefined : "no session", onClick: () => pickPanel("specs") }) : null}
                <BarDivider />
                {headIcon({ label: "Export this session", icon: "download", off: chatOn && listed ? undefined : "nothing to export yet", onClick: () => void exportChat() })}
                {headIcon({ label: "Logs for this session", keys: `${mod}+Shift+U`, icon: "logs", pressed: logsShown, off: chatOn ? undefined : "no session", onClick: toggleLogs })}
            </SessionHeader>
        )
        : null;

    /**
     * A phase chat's line over its thread: the spec and the phase SDD made
     * it for, and a button that opens the spec as a tab beside it. Always
     * shown on a phase chat.
     */
    const link = chatOn ? chat?.spec : undefined;
    const phaseLine = link
        ? (
            <div className="eesha-phase-line">
                <UiIcon name="checklist" size="sm" />
                <span className="eesha-phase-line__text" title={`SDD made this session for the ${phaseName(link.phase)} phase of spec ${link.spec}`}>
                    Phase chat of spec <strong>{link.spec}</strong> · {phaseName(link.phase)}
                </span>
                {sddModule === true && sddShown
                    ? (
                        <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            fill="outline"
                            onClick={() => openSpecTab(sddShown.key, { spec: link.spec, ...(link.folder ? { folder: link.folder } : {}) }, link.phase)}>
                            Open spec
                        </Button>
                    )
                    : null}
            </div>
        )
        : null;

    /** The row over a workspace page: the workspace, and the Spec explorer's icon with the SDD module on. */
    const workspaceCrumb = workspacePage && !settings
        ? (
            <SessionHeader
                folder={sddWorkspace?.name ?? "No workspace"}
                folderTitle={sddWorkspace?.folders.join("\n")}
                title="Workspace">
                {workspaceEditorShown && besideHidden
                    ? (
                        <Button type="button" size="sm" variant="secondary" fill="outline" className="eesha-crumb-editor" title="Show the workspace page and the panels beside the editor again" onClick={() => setBesideHidden(false)}>
                            Show the page
                        </Button>
                    )
                    : null}

                {sddModule === true && sddWorkspace && !sddWorkspace.archived
                    ? headIcon({ label: "Spec explorer", icon: "checklist", pressed: !maximized && panelShown === "specs", onClick: () => pickPanel("specs") })
                    : null}
            </SessionHeader>
        )
        : null;

    const header = (
        <AppHeader
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
                        items={[{ label: "Keyboard shortcuts", icon: "keyboard", end: `${mod}+/`, onSelect: () => setShortcuts(true) }]}
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
                </>
            } />
    );

    return (
        <>
        {/* Below 1024px a cover asks for a wider window; below 1280px the page stays 1280 wide and scrolls sideways. */}
        <AppShell header={header} footer={footer} minWidth={PAGE_MIN} scrollBelow={PAGE_WIDTH} narrowText={`Eesha Code needs a window at least ${PAGE_MIN} pixels wide. Make the window wider.`}>

                {/* The strip of module icons, then the picked module's panel. On every page but Settings - the start page too, so SDD can be reached from it. */}
                {!settings
                    ? (
                        <>
                            <ModuleStrip
                                state={maximized ? { ...strip, open: false } : strip}
                                toggleKeys={`${mod}+B`}
                                aiDot={othersWaiting || othersWorking
                                    ? { tone: othersWaiting ? "waiting" : "working", label: othersWaiting ? "another session is waiting for you" : "another session is working" }
                                    : undefined}
                                onPick={module => {

                                    // Maximized: the layout comes back with that module's panel shown - see `pickPanel`.
                                    if (maximized) {

                                        setBesideHidden(false);
                                        setStrip({ module, open: true });

                                        return;
                                    }

                                    setStrip(now => pickModule(now, module));
                                }} />
                            <SidePanel
                                width={navWidth}
                                min={NAV_MIN}
                                max={NAV_MAX}
                                edge="right"
                                label="Width of the panel"
                                className="eesha-nav-panel"
                                hidden={!listOpen || maximized}
                                onWidth={setNavWidth}>
                                {/* Both stay drawn, the hidden one kept, so the list keeps its open workspaces. */}
                                <div className="eesha-module" hidden={strip.module !== "ai"}>
                                    <ChatList
                                        chats={chats}
                                        loaded={chatsLoaded}
                                        current={chatId}
                                        onOpen={openChat}
                                        kiro={kiroRows}
                                        onOpenKiro={row => void openKiro(row)}
                                        onRenameKiro={row => void changeKiro(API.renameKiro, row)}
                                        onDeleteKiro={row => void changeKiro(API.deleteKiro, row)}
                                        onNew={(folder, key) => void newChat(folder, "", undefined, key)}
                                        workspaces={workspaces}
                                        onAddFolder={() => setFolderWindow({})}
                                        onEditFolder={folder => setFolderWindow({ editing: folder })}
                                        onRemoveFolder={key => void removeFolder(key)}
                                        onNextItem={workspace => setFolderWindow({ next: workspace })}
                                        onArchiveWorkspace={(key, archived) => void archiveWorkspace(key, archived)}
                                        onRename={id => bridge.toChat({ type: "renameChat", chatId: id })}
                                        onDelete={id => void deleteRow(id)}
                                        onMark={(id, mark) => void markChat(id, mark)}
                                        aliases={aliases}
                                        onAlias={(folder, key) => setAliasFor({ folder, ...(key ? { key } : {}) })}
                                        onDeleteMany={(ids, where) => void deleteMany(ids, where)} />
                                </div>
                            </SidePanel>
                        </>
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

                                    <div className="eesha-stage">

                                        {/* One element whether the editor shows or not, as for a session's chat. */}
                                        <SidePanel
                                            width={widths.chat}
                                            min={CHAT_MIN}
                                            max={CHAT_MAX}
                                            edge="right"
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
                                                    sdd={sddModule}
                                                    onStart={(workspace, text, pick) => void newChat(workspace.folders[0], text, pick, workspaceKey(workspace))}
                                                    onEdit={workspace => setFolderWindow({ editing: workspace })}
                                                    onArchive={(workspace, archived) => void archiveWorkspace(workspaceKey(workspace), archived)}
                                                    onNextItem={workspace => setFolderWindow({ next: workspace })}
                                                    onNewSpec={() => setNewSpecIn({})}
                                                    onSpecExplorer={() => setPanel("specs")} />
                                            </main>
                                        </SidePanel>

                                        {workspaceEditorShown
                                            ? (
                                                <div className="eesha-editor-column">
                                                    <EditorArea
                                                        state={tabs}
                                                        emptyText=""
                                                        help={editorHelp}
                                                        onShow={id => setTabs(current => showTab(current, id))}
                                                        onClose={id => setTabs(current => closeTab(current, id))}
                                                        onKeep={id => setTabs(current => keepTab(current, id))}
                                                        onHide={() => setEditorHidden(true)}
                                                        beside="workspace page"
                                                        maximized={besideHidden}
                                                        onMaximize={() => setBesideHidden(now => !now)} />
                                                </div>
                                            )
                                            : null}

                                        {sddModule === true && sddWorkspace
                                            ? (
                                                <SidePanel
                                                    width={widths.panel}
                                                    min={PANEL_MIN}
                                                    max={PANEL_MAX}
                                                    edge="left"
                                                    label="Width of the right panel"
                                                    className="eesha-right"
                                                    hidden={panelShown !== "specs" || maximized}
                                                    onWidth={width => setWidths(current => ({ ...current, panel: width }))}>
                                                    {specExplorer(panelShown !== "specs")}
                                                </SidePanel>
                                            )
                                            : null}
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
                                        sdd={sddModule}
                                        onStart={(folder, text, pick) => void newChat(folder, text, pick)}
                                        onSearch={() => setSearching(true)}
                                        onAddFolder={() => setFolderWindow({})} />
                                </main>
                            )
                            : (
                                <>
                                    {crumb}

                                    <div className="eesha-stage">

                                        {/* One element whether the editor shows or not, so the chat is never drawn anew. */}
                                        <SidePanel
                                            width={widths.chat}
                                            min={CHAT_MIN}
                                            max={CHAT_MAX}
                                            edge="right"
                                            label="Width of the chat"
                                            className={`eesha-chat${editorShown ? "" : " eesha-chat--fill"}`}
                                            hidden={editorShown && besideHidden}
                                            onWidth={chat => setWidths(current => ({ ...current, chat }))}>
                                            {phaseLine}
                                            <main className="eesha-main">{main}</main>
                                        </SidePanel>

                                        {editorShown
                                            ? (
                                                <div className="eesha-editor-column">
                                                    <EditorArea
                                                        state={tabs}
                                                        emptyText=""
                                                        help={editorHelp}
                                                        onShow={id => setTabs(current => showTab(current, id))}
                                                        onClose={id => setTabs(current => closeTab(current, id))}
                                                        onKeep={id => setTabs(current => keepTab(current, id))}
                                                        onHide={() => setEditorHidden(true)}
                                                        beside="chat"
                                                        maximized={besideHidden}
                                                        onMaximize={() => setBesideHidden(now => !now)} />
                                                </div>
                                            )
                                            : null}

                                        {chatOn && visited.size
                                            ? (
                                                <SidePanel
                                                    width={widths.panel}
                                                    min={PANEL_MIN}
                                                    max={PANEL_MAX}
                                                    edge="left"
                                                    label="Width of the right panel"
                                                    className="eesha-right"
                                                    hidden={!panelShown || maximized}
                                                    onWidth={width => setWidths(current => ({ ...current, panel: width }))}>
                                                    {visited.has("files")
                                                        ? (
                                                                <FilesPane
                                                                    chat={chat!}
                                                                    hidden={panelShown !== "files"}
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
                                                    {visited.has("git")
                                                        ? (
                                                                <GitPane
                                                                    chat={chat!}
                                                                    hidden={panelShown !== "git"}
                                                                    running={running}
                                                                    agentFiles={agentFiles}
                                                                    onRepos={setRepos}
                                                                    onOpenDiff={(diff, keep) => open({ kind: "git", root: diff.root, ask: diff.ask }, diff.title, diff.tip, keep)} />
                                                        )
                                                        : null}
                                                    {visited.has("specs") ? specExplorer(panelShown !== "specs") : null}
                                                    <PanelView title="AI changes" label="AI changes" hidden={panelShown !== "changes"} bodyRef={setChangesBody} />
                                                    <PanelView title="Session" label="Session" hidden={panelShown !== "session"} bodyRef={setSessionBody} />
                                                </SidePanel>
                                            )
                                            : null}
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

            {newSpecIn && sddShown
                ? (
                    <NewSpecDialog
                        place={newSpecIn.folder ? { ...sddShown, folder: newSpecIn.folder } : sddShown}
                        onClose={() => setNewSpecIn(undefined)}
                        onMade={name => location.assign(workspaceAddress(sddShown.key, { spec: name, ...(newSpecIn.folder ? { folder: newSpecIn.folder } : {}) }))}
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

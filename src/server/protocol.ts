/*
 * What the Eesha Code server and its page say to each other, on top of
 * the chat's own messages (src/shared/chatMessages.ts), which pass
 * through unchanged.
 *
 * Server to page: one stream of events per browser tab
 * (`GET /events`). Page to server: plain POSTs, answered with JSON.
 *
 * No Node imports here - the page is built from this file too.
 */

import type { ChatSpecLink } from "../shared/chatMessages";

/** Messages only the Eesha Code page knows. Every type starts with `eesha.`, so none clashes with a chat message. */
export type ToPage =

    /** The stream is open. Sent first, and again after every reconnect. `sddModule`: the `Feature-SDD` flag is on. */
    | { type: "eesha.hello"; view: string; theme: ThemeChoice; fontSize: number; sddModule: boolean; version: string; install: "npm" | "source"; chat?: ChatInfo; upgraded?: UpgradedView }

    /** The theme was changed on the settings page: every tab shows it at once. */
    | { type: "eesha.theme"; theme: ThemeChoice }

    /** The text size was changed on the settings page: every tab shows it at once. */
    | { type: "eesha.fontSize"; fontSize: number }

    /** The `Feature-SDD` flag was turned on or off on the settings page: every tab shows or hides the SDD module at once. */
    | { type: "eesha.sddModule"; on: boolean }

    /** A short notice - a toast. */
    | { type: "eesha.note"; text: string }

    /** A question the chat needs answered before it goes on: a line of text, or yes/no. */
    | { type: "eesha.prompt"; id: number; prompt: PromptRequest }

    /**
     * A connector sign-in printed a line, gave GitHub's one-time code,
     * or ended (`done`). Sent to every tab - the settings page shows it.
     */
    | { type: "eesha.connectorSignIn"; id: ConnectorId; line?: string; code?: string; url?: string; done?: { ok: true; account?: string } | { problem: string } }

    /**
     * One changed file: before the turn against now - or, with `turn`,
     * against right after the turn. `before` absent: the turn added it.
     */
    | { type: "eesha.diff"; path: string; before?: string; after: string; binary?: boolean; turn?: true; from?: DiffFrom }

    /** Every file the last turn changed, for Review all. */
    | { type: "eesha.review"; files: ReviewFile[] }

    /** A file's text, for a link in the thread. */
    | { type: "eesha.file"; path: string; text?: string; problem?: string }

    /** The chat on this tab is another one now, or its folders or name changed. */
    | { type: "eesha.chat"; chat: ChatInfo }

    /** The chat id in the address does not name a chat this server knows. */
    | { type: "eesha.unknownChat"; chatId: string }

    /** A chat was named, renamed, deleted, or started or stopped working: the chat list is read again. */
    | { type: "eesha.listChanged" }

    /** This chat was opened in another browser tab, which now shows it. */
    | { type: "eesha.moved" }

    /** This spec was opened in another browser tab, which now shows it. The chat here stays. */
    | { type: "eesha.specMoved"; workspace: string; spec: string; folder?: string }

    /** A chat with no tab open is waiting for an answer. */
    | { type: "eesha.attention"; text: string; chatId: string }

    /**
     * A turn ended by itself, or the agent asked something: the page
     * shows a Windows notice and marks its title. Sent as it happens,
     * never for a chat drawn again. To the tab showing the chat; to
     * every tab when no tab does.
     */
    | { type: "eesha.notify"; chatId: string; title: string; notice: Notice }

    /** A file changed in a repository the git panel shows: the panel reads it again. Only while the panel is open. */
    | { type: "eesha.gitChanged"; root: string }

    /**
     * A command started from a Run button printed `text`, or ended
     * (`done`). Only to the tab that started it.
     */
    | { type: "eesha.run"; id: string; text?: string; done?: RunDone }

    /**
     * One message from the spec this tab shows to its SDD editor - the
     * messages in src/shared/sddMessages.ts.
     * Only to the tab showing the spec.
     */
    | {
        type: "eesha.sdd";

        /** Which spec says it - the page drops what a spec it no longer shows said. `folder` only when not the main folder. */
        workspace: string;
        spec: string;
        folder?: string;
        message: unknown;
    }

    /** A spec was made, or one started or stopped working or waiting: the specs list is read again. */
    | { type: "eesha.specsChanged" }

    /**
     * A notice from a spec no tab shows - for example its agent waits for
     * an answer. Shown as a toast only on SDD pages of the workspace with
     * key `workspace`; chat pages and other workspaces ignore it.
     */
    | { type: "eesha.sddNote"; workspace: string; text: string };

/** How a command started from a Run button ended. `code` is null when it was stopped or could not start. */
export interface RunDone {

    code: number | null;

    ms: number;

    stopped?: true;

    problem?: string;
}

/** A shell the Run button can use. */
export interface ShellChoice {

    id: string;

    label: string;

    /** What language it speaks - a block's own language picks the shell by it. */
    kind: "powershell" | "cmd" | "posix";
}

// -------------------------------------------------------------------
// The git panel
// -------------------------------------------------------------------

/** A git repository a chat's folders give. */
export interface GitRepo {

    /** Its top folder, full path. */
    root: string;

    name: string;
}

/**
 * One changed file, as `git status` says it. `index` and `work` are git's
 * own letters for the staged copy and the copy on disk: `.` unchanged,
 * `M`, `A`, `D`, `R`, `C`, `T`; `?` for both on a file git does not track.
 */
export interface GitFile {

    /** Relative to the repository, with forward slashes. */
    path: string;

    /** A renamed file's old path. */
    from?: string;

    index: string;

    work: string;

    /** Both sides changed it in a merge, rebase or cherry-pick - it waits to be resolved. */
    conflict?: true;
}

/** A merge, rebase, cherry-pick or revert that stopped part way. */
export type GitOperation = "merge" | "rebase" | "cherry-pick" | "revert";

/** One repository's state. */
export interface GitStatus extends GitRepo {

    /** The branch checked out. Absent: a detached commit. */
    branch?: string;

    /** The commit checked out. Absent: no commit yet. */
    commit?: string;

    /** The last commit's first line. */
    head?: string;

    upstream?: string;

    ahead: number;

    behind: number;

    stashes: number;

    files: GitFile[];

    /**
     * What .gitignore leaves out, relative to the repository: a folder
     * ends in "/" and stands for everything under it. Only the paths a
     * rule names - nothing inside an ignored folder is listed.
     */
    ignored?: string[];

    operation?: GitOperation;
}

export interface GitBranch {

    /** As git shows it: `main`, `origin/main`. */
    name: string;

    remote: boolean;

    commit: string;

    upstream?: string;

    current?: true;
}

export interface GitLists {

    branches: GitBranch[];

    tags: string[];

    /** `index` is the N in `stash@{N}`. `at` in ms. */
    stashes: { index: number; text: string; at: number }[];

    remotes: { name: string; url: string }[];
}

export interface GitCommit {

    hash: string;

    short: string;

    author: string;

    /** In ms. */
    at: number;

    subject: string;

    /** The branches and tags pointing at it, as git writes them. */
    refs?: string;
}

/** One file a commit changed. `status`: A, M, D, R, C or T. */
export interface GitCommitFile {

    path: string;

    from?: string;

    status: string;
}

/** Which two sides of a file to show. See `fileDiff` in git.ts. */
/**
 * Where a turn's diff came from: the repository, the two snapshots, and the
 * file in it. The page puts it in the address, and after a reload asks the
 * chat for the same diff again.
 */
export interface DiffFrom {

    root: string;
    before: string;
    after: string;
    file: string;
}

export interface GitDiffAsk {

    side: "staged" | "changes" | "conflict" | "commit";

    path: string;

    from?: string;

    /** Only for `commit`. */
    commit?: string;
}

/** A file's two sides. `before` absent: the file is new. */
export interface GitDiff {

    before?: string;

    after: string;

    binary?: true;

    tooLarge?: true;
}

/** One button of the git panel. Every one changes the repository, so none runs while the agent works. */
export type GitAction =
    | { kind: "stage" | "unstage" | "discard" | "takeOurs" | "takeTheirs" | "resolve"; paths: string[] }
    | { kind: "stageAll" | "unstageAll" | "discardAll" | "undoCommit" | "fetch" | "push" | "sync" | "pushTags" | "continue" | "abort" }
    | { kind: "commit"; message: string; amend?: boolean; all?: boolean }
    | { kind: "pull"; rebase?: boolean }
    | { kind: "switch"; branch: string; remote?: boolean }
    | { kind: "createBranch"; name: string; from?: string }
    | { kind: "renameBranch"; from: string; to: string }
    | { kind: "deleteBranch"; name: string; force?: boolean }
    | { kind: "merge" | "rebase"; branch: string }
    | { kind: "stash"; message?: string }
    | { kind: "stashApply" | "stashPop" | "stashDrop"; index: number }
    | { kind: "createTag"; name: string; message?: string }
    | { kind: "deleteTag"; name: string }
    | { kind: "addRemote"; name: string; url: string }
    | { kind: "removeRemote"; name: string }
    | { kind: "revert" | "cherryPick" | "checkoutCommit"; hash: string };

/** One file in the Review all window. */
export interface ReviewFile {

    /** What the window calls it - with its folder's name first when the chat has several folders. */
    path: string;

    /** Its path in its repository, as the chat's Undo takes it. */
    file: string;

    status: "added" | "modified" | "deleted";

    /** The turn's changes in its repository - sent back with Undo. */
    changed: { root: string; before: string; after: string; files: { path: string; status: "added" | "modified" | "deleted" }[] };

    /** Before the turn. Absent: the turn added the file. */
    before?: string;

    /** Now. Empty when the file is gone. */
    after: string;

    /** Not a text file - no diff to show. */
    binary?: boolean;
}

/** The page's colours: dark, light, or the computer's own setting. */
export type ThemeChoice = "dark" | "light" | "system";

/** What the settings page shows - `POST /api/settings`. */
export interface SettingsView {

    /** ~/.eesha/settings.json. */
    file: string;

    /** The file's text. Empty when there is no file yet. */
    text: string;

    /** Why the file could not be read as settings. The simple controls are off until it is fixed in the text box. */
    problem?: string;

    theme: ThemeChoice;

    /** The page's text size in px. */
    fontSize: number;

    /** The port in the file - used from the next start. */
    port: number;

    /** The port this server listens on now. */
    runningPort: number;

    /** `eesha.workingFolders` - where the person keeps their code, in the file's order. */
    workingFolders: string[];

    /**
     * Every runtime Eesha Code knows, in the picker's order: whether its
     * program was found, whether the picker shows it, and whether the
     * person added it (`own`) - only those can be removed.
     */
    runtimes: { id: string; program: string; found?: string; install: string; shown: boolean; own: boolean }[];


    /** settings.json names the runtimes the picker shows (`ai.providers`). Without it, the picker shows the ones found on this machine. */
    providersListed: boolean;

    /**
     * The runtime a new chat starts on: `ai."ai@1".provider` when it is
     * shown, else the first runtime shown. Always one of the shown ones.
     */
    defaultRuntime?: string;

    /** The feature flags that change something in Eesha Code, on or off, with what each does. */
    flags: { name: string; text: string; on: boolean }[];

    /**
     * `eesha.runtimes` - per runtime id, its own tools turned off.
     * A runtime not here keeps all its tools.
     */
    runtimeTools: Record<string, RuntimeToolsView>;

    storage: {

        /** ~/.eesha/trash - files an Undo removed. */
        trash: { files: number; bytes: number };

        /** Scratch folders no chat uses any more - their chat was deleted. */
        scratch: { folders: number; bytes: number };
    };
}

/** One runtime's tool settings - see `SettingsView.runtimeTools`. */
export interface RuntimeToolsView {

    toolsOff: string[];
}

/** One change from the settings page's simple controls - `POST /api/settings/change`. */
export interface SettingsChange {

    theme?: ThemeChoice;

    /** The page's text size in px, 12 to 24. */
    fontSize?: number;

    port?: number;

    /** The working folders, replaced whole: full paths. An empty list removes `eesha.workingFolders`. */
    workingFolders?: string[];

    /** The runtimes the picker shows, in order. */
    providers?: string[];

    /** The runtime a new chat starts on - written as `ai."ai@1".provider`. One of the shown runtimes. */
    defaultRuntime?: string;

    /** One flag on or off. */
    flag?: { name: string; on: boolean };

    /** One runtime's tool settings, replaced whole. An empty list removes the runtime's entry. */
    runtimeTools?: { id: string } & RuntimeToolsView;
}

/** What a `eesha.notify` is about - the same shape as the chat's own `ChatNotice`. */
export type Notice =
    | { kind: "ended"; outcome: "done" | "failed" }
    | { kind: "asked"; text: string };

/** The chat a tab shows. */
export interface ChatInfo {

    chatId: string;

    /** The folders picked for the chat, in order - never the scratch folder. May be empty. */
    folders: string[];

    /** The agent works in the chat's scratch folder: it has no folder, or got its conversation with none. */
    scratch: boolean;

    /** A runtime has answered: where the agent works can no longer change. */
    started: boolean;

    title: string;

    /**
     * The key of the workspace it belongs to, while that workspace is
     * there. Sent here too because a session with no message yet is not
     * in the chat list.
     */
    workspace?: string;

    /**
     * A phase chat: the spec and phase SDD made it for. The page shows
     * the SDD line over it and opens the spec as a tab beside it.
     */
    spec?: ChatSpecLink;
}

/** One row of the chat list. */
export interface ChatRow {

    chatId: string;

    title: string;

    /** When it was last written to, in ms. */
    at: number;

    /** As in {@link ChatInfo}. */
    folders: string[];

    /** The key of the workspace it was started in, while that workspace is there - see `placeKey`. */
    workspace?: string;

    /** A turn is running in it now. */
    working: boolean;

    /** The agent asked this and is stopped until someone answers it. Only while a turn runs. */
    waiting?: string;

    /**
     * A turn ended while no tab showed the chat, and nobody opened it
     * since: how it ended. Kept by the running server only - gone after
     * a restart.
     */
    unseen?: "done" | "failed";

    /** Pinned: listed at the top. Archived: out of the list, under "Archived" at its foot. */
    mark?: ChatMark;

    /** A phase chat: the spec and phase SDD made it for. The list folds it under its spec. */
    spec?: ChatSpecLink;

    /** A phase chat somebody typed a message into. Only these show under Recent. */
    typed?: true;
}

/**
 * A session Kiro has that Eesha Code did not start - in the Kiro terminal
 * or another program - in a folder the list already shows. Opening it
 * makes it an Eesha Code session.
 */
export interface KiroRow {

    /** Kiro's own id. */
    sessionId: string;

    /** The runtime that reads it - a Kiro v3 one from settings.json. */
    runtime: string;

    /** The folder it ran in. */
    cwd: string;

    title: string;

    /** When it last changed, in ms. */
    at: number;

    /** Kiro says a turn is running in it now. */
    working: boolean;
}

/** A chat whose messages hold the text searched for, and one line around where. */
export interface SearchHit {

    chatId: string;

    line: string;
}

/** What the person set on a chat from its row's menu. */
export type ChatMark = "pinned" | "archived";

/**
 * One key for every spelling of the same folder: no separator at the
 * end, and a Windows path in one case with one kind of slash. The chat
 * list groups by it, and a folder's alias is kept under it.
 */
export function folderKey(folder: string): string {

    const trimmed = folder.replace(/[\\/]+$/, "");

    return /^([A-Za-z]:|\\\\)/.test(trimmed) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

/** The longest folder alias. */
export const ALIAS_LIMIT = 60;

/**
 * A workspace: a named list of folders, kept by Eesha Code in its own
 * store (~/.eesha/state.json), not a file on disk. It shows in the session list even with no session in
 * it. Its runtime and model only touch a session when the session is
 * made - a session already there keeps what it has.
 */
export interface Workspace {

    /**
     * Its own key, when it is not its main folder's - see `workspaceKey`.
     * Only a second workspace on the same main folder has one: the first
     * keeps its main folder's key, so nothing kept under it moves.
     */
    id?: string;

    /** When it was made, in ms. Absent: older than any that has it. */
    created?: number;

    /** Archived by hand: out of the session list and the pickers, with its sessions. Nothing is deleted. */
    archived?: true;

    /** The name the lists show. */
    name: string;

    /**
     * Its folders, never empty. The first is the main folder: where a new
     * session in it starts, and what core is given as its "workspace".
     * The others are extra folders every new session in it may also use.
     */
    folders: string[];

    /** The runtime a new session in it starts on. Absent: the server's default runtime. */
    runtime?: string;

    /** The model it starts on. Absent: the runtime's own default. Only set with `runtime`. */
    model?: string;

    /** The effort level it starts on - one the model lists. Absent: the model's own default. Only set with `model`. */
    effort?: string;

    /** A new session in it may also use the system temp folder. */
    tempFolder?: true;

    /**
     * The one ADO work item or GitHub issue this workspace is for. The
     * `>` list offers it first, and the AI is told it.
     */
    link?: WorkspaceLink;
}

/** A workspace's work item or issue - see `Workspace.link`. */
export interface WorkspaceLink {

    connector: ConnectorId;

    /** An ADO work item, or a GitHub issue. */
    kind: "workitem" | "issue";

    /** How it is named: the work item's number, or the issue as owner/repo#12. */
    id: string;

    /** Its title when it was picked. Not changed later. */
    title: string;

    /** Its `>` path, without the leading ">": ["ado", "workitems", "12345"]. */
    path: string[];

    /** Its page on the web. */
    url?: string;
}

/**
 * One key for a workspace: its `id` when it has one, else its main
 * folder's (see `folderKey`). Several workspaces can share a main folder
 * - one per work item - and only the first of them has the folder's key.
 */
export function workspaceKey(workspace: Pick<Workspace, "folders" | "id">): string {

    return workspace.id ?? folderKey(workspace.folders[0] ?? "");
}

/**
 * The workspace a new session started from this folder goes in: of the
 * workspaces not archived whose main folder this is, the newest.
 * Nothing when there is none.
 */
export function newestAt<T extends Pick<Workspace, "folders" | "id" | "created" | "archived">>(workspaces: readonly T[], folder: string): T | undefined {

    const key = folderKey(folder);

    return workspaces
        .filter(one => !one.archived && folderKey(one.folders[0] ?? "") === key)
        .sort((left, right) => (right.created ?? 0) - (left.created ?? 0))[0];
}

/**
 * The key of the group a session is listed in: the workspace it was
 * started in, while that workspace is there - else its first folder's
 * key, which is also the key of the first workspace on that folder.
 * Empty for a session with no folder.
 */
export function placeKey(chat: Pick<ChatRow, "folders" | "workspace">): string {

    return chat.workspace ?? (chat.folders[0] ? folderKey(chat.folders[0]) : "");
}

/** Where SDD keeps a workspace's specs: always its main folder. */
export function mainFolderOf(workspace: Pick<Workspace, "folders">): string {

    return workspace.folders[0] ?? "";
}

/** `POST /api/ai` - the runtimes on offer, and each one's models when its list is known. */
export interface AiOptions {

    runtimes: string[];

    /** The runtime a session with no pick of its own starts on. */
    defaultRuntime?: string;

    /** `efforts`: the effort levels the model takes, when it lists any. */
    models: Record<string, { id: string; name?: string; disabled?: boolean; efforts?: string[] }[]>;

    /** The connectors set up - where a workspace's work item or issue can be picked from. */
    connectors?: ConnectorId[];

    /**
     * Each runtime's Permissions level in force - "manual", "agent",
     * "semi" or "auto"; one per runtime, shared by every session - and
     * whether it is an ACP agent, which decides the levels it offers.
     */
    levels: Record<string, { level: string; acp: boolean }>;
}

/** Whether a value the page sent is a mark. */
export function isChatMark(value: unknown): value is ChatMark {

    return value === "pinned" || value === "archived";
}

export type PromptRequest =
    | { kind: "text"; title: string; value: string; text: string }
    /**
     * `keep`: the label of a tick box under the question, ticked to
     * start - "Keep 'api' in the list". Answered with `action` and
     * KEEP_FOLDER after it when it stays ticked.
     */
    | { kind: "confirm"; text: string; action: string; keep?: string }
    /** One of several answers, each its own button: answered with the choice clicked. */
    | { kind: "choose"; text: string; detail?: string; choices: string[] }
    /**
     * The AI asks to change something through a connector.
     * Answered "allow"; anything else, or no answer, is a no.
     */
    | { kind: "write"; connector: string; tool: string; text: string };

// -------------------------------------------------------------------
// SDD - the specs in a workspace's main folder
// -------------------------------------------------------------------

/** One row of the SDD panel's list: a spec in the workspace's main folder. */
export interface SpecRowView {

    /** Its folder name - what it is known by. */
    name: string;

    /** The style that placed it. Absent: no style could place it. */
    style?: string;

    /** The phase waiting - "design" - or "implementing", or "done". Absent with no style. */
    phase?: string;

    /** How many of its phases are done, of how many. */
    done?: number;
    total?: number;

    /** A phase, or a wave of it, runs now. */
    working: boolean;

    /** The agent asked something in it and waits for an answer. */
    waiting: boolean;

    /** When its folder last changed, in ms - what a workspace page's "Recent specs" goes by. */
    modified?: number;

    /**
     * Made in another workspace on the same main folder - one per work
     * item. The list shows it after this workspace's own specs.
     */
    elsewhere?: true;
}

/** `API.sddSpecs`'s answer. */
export interface SpecListView {

    specs: SpecRowView[];

    /** Lines that are not specs: a style that would not load, two spec folders with one name. */
    notes: string[];

    /** The order: A to Z, or most recently changed first. Kept per workspace - `API.sddSort`. */
    sort: SpecSort;
}

/** How the SDD panel orders a workspace's specs, in the Specs view. */
export type SpecSort = "alpha" | "recent";

/** One phase of a spec, in the Spec explorer. */
export interface SpecPhaseView {

    /** The stage id - what its sessions are filed under. */
    id: string;

    /** What it is called on screen. */
    label: string;

    /** Done, the one to run now, or later. */
    status: "done" | "next" | "upcoming";

    /** The Idea step: Eesha writes it from the New spec form, with no chat. */
    chatless?: true;
}

/** One spec in the Spec explorer: its list row, how it runs, and its phases. */
export interface SpecTreeRow extends SpecRowView {

    /** Kiro or Spec Kit. Absent: an Eesha style. */
    native?: "kiro" | "speckit";

    /** The folder its spec folders sit in, from the workspace folder - `.eesha/specs`, `.kiro/specs`, `specs`. */
    root: string;

    /** In the order they run. Empty when no style could place the spec. */
    phases: SpecPhaseView[];
}

/** One folder of a workspace in the Spec explorer. */
export interface SpecFolderView {

    folder: string;

    /** The workspace's main folder. */
    main: boolean;

    specs: SpecTreeRow[];

    /** Lines that are not specs - a style that would not load, two spec folders with one name. */
    notes: string[];

    /** Why the folder's specs could not be read. */
    problem?: string;
}

/** `API.sddExplorer`'s answer. */
export interface SpecExplorerView {

    folders: SpecFolderView[];

    sort: SpecSort;
}

/** One spec in the start page's "Recent specs": its list row and the workspace that made it. */
export interface RecentSpecView extends SpecRowView {

    /** The key of the workspace that made it. */
    workspace: string;

    /** The folder it is in, when that is not the workspace's main folder. */
    folder?: string;
}

/** `API.sddRecent`'s answer. */
export interface RecentSpecsView {

    /** Most recently changed first. */
    specs: RecentSpecView[];
}

/** One session of a spec's phase, in the Spec explorer - `API.sddSessions`. */
export interface SpecSessionView {

    /** The phase id, or an implementation chat - `implement@wave:2`. */
    ownerId: string;

    /** 1 for the owner's first session. */
    iteration: number;

    /** The session the spec's page still talks to. Earlier ones are read only. */
    current: boolean;

    at: number;

    model?: string;

    /** How it ended - `success` or `failed`. Absent while it runs. */
    status?: string;

    /** What the person typed when they started it - a revise note. */
    note?: string;

    /** The phase chat it ran in - a normal session. Absent for a run from before phase chats were sessions. */
    chatId?: string;
}

/** What the New spec window offers - `API.sddOffers`. */
export interface NewSpecOffers {

    /** The "[style] kind" rows. */
    types: { label: string; styleId: string; specTypeId: string }[];

    /** Styles in `sdd.styles` that could not be loaded, with why. */
    broken: { id: string; error: string }[];

    /** Where a spec can start from - "manual", "ado", "gh", "file" - with what the window calls each. */
    sources: { id: string; label: string }[];

    /** `sdd.source` settles it: the window does not ask. */
    source?: string;

    /** The folder each style's specs are made in, by style id. */
    roots: Record<string, string>;

    /** The spec folder names already taken. */
    taken: string[];

    /**
     * Kiro and Spec Kit - the "How it runs" choice beside the Eesha
     * styles above. Each one runs that tool's own spec process.
     */
    native: NativeOffer[];
}

/** One tool New spec can start a spec with - see {@link NewSpecOffers.native}. */
export interface NativeOffer {

    /** `kiro` or `speckit` - also its style's id. */
    id: string;

    label: string;

    /** What Create does with it, in one line. */
    detail: string;

    /** Where its specs go - the folder Create makes the spec in, or Spec Kit's own. */
    root: string;

    /** Why it cannot be picked in this workspace, when it cannot. */
    problem?: string;
}

/**
 * What Create answers: the spec's name, why not - or, for Spec Kit, a
 * chat to open with its first command in the box, since Spec Kit names
 * the spec folder and the branch itself.
 */
export type NewSpecAnswer =
    | { name: string }
    | { problem: string }
    | { chat: { folder: string; workspace: string; text: string } };

/** One New spec - `API.sddCreate`. */
export interface NewSpecAsk {

    /** The workspace, by its key - see `workspaceKey`. */
    workspace: string;

    styleId: string;

    specTypeId: string;

    source: string;

    /** The spec's folder name. */
    name: string;

    /**
     * `manual`: the one line saying what it is about. `ado` / `gh`: the
     * id or link. Kiro and Spec Kit: the description their first
     * command is sent with.
     */
    text?: string;

    /** `file`: full paths of the files with the ask, copied into the spec folder. */
    files?: string[];

    /** The workspace folder the spec goes in. Absent: the main folder. */
    folder?: string;
}

/** Where a copied style can go. The workspace is offered first. */
export type CopyStylePlace = "workspace" | "profile";

/** What the Copy a style window offers - `API.sddCopyOffers`. */
export interface CopyStyleOffers {

    /** The built-in styles, each with the files a copy takes and the name it would get. */
    styles: { id: string; files: string[]; suggested: string }[];

    /** The folders a copy can go to, the workspace first. */
    places: { id: CopyStylePlace; label: string; folder: string; detail: string }[];
}

/** One copy - `API.sddCopyStyle`. */
export interface CopyStyleAsk {

    /** The workspace, by its key - see `workspaceKey`. */
    workspace: string;

    /** The built-in style to copy. */
    styleId: string;

    place: CopyStylePlace;

    /** The new style's name: its folder and its `id:`. */
    name: string;
}

/** After a confirm's action: its Keep tick box was left ticked. */
export const KEEP_FOLDER = "\nkeep folder";

/** A folder the browser lists. */
export interface FolderEntry {

    name: string;

    path: string;

    /** A file, not a folder - listed only when files were asked for. */
    file?: true;
}

/** `POST /api/folders` - one folder's subfolders, or the top level. */
export interface FolderListing {

    /** The folder listed. Empty for the top level - the drives on Windows. */
    path: string;

    /** One level up. Absent at the top level; an empty string is the top level. */
    parent?: string;

    entries: FolderEntry[];

    /** Why the folder could not be read. */
    problem?: string;

    /** Only at the top level: folders used before, newest first. */
    recent?: string[];

    /**
     * Only at the top level: the git repos in the working folders - each
     * working folder that is one, and the folders directly inside it that
     * are - last git activity first. Ones in `recent` are left out.
     */
    repos?: string[];

    /** Only at the top level: the working folders that exist now, in the settings' order. */
    working?: string[];
}

/** One row of the files pane: a file or a folder. */
export interface FileItem {

    name: string;

    /** The full path - what the pane asks for next, and what goes in the compose box. */
    path: string;

    folder: boolean;
}

/** The request paths the page posts to. */
export const API = {

    /** `{ view, message }` - a chat message, passed to the chat as it is. */
    chat: "/api/chat",

    /** `{ path? }` → FolderListing. */
    folders: "/api/folders",

    /**
     * `{ folders }` → `{ chatId }` or `{ problem }`. A new session in these
     * folders - none: it works in its scratch folder. `{ folder }` instead:
     * a new session in that folder - in its workspace's folders, on its
     * runtime and model, when it is a workspace's main folder (see
     * Workspace). Optional, picked on the start page: `runtime` and
     * `model` beat the workspace's; `level` (`{ runtime, level }`) is
     * saved as that runtime's Permissions level.
     */
    newSession: "/api/session",

    /**
     * `{ view, folders }` → `{ ok: true }` or `{ problem }`. This tab's
     * session works in these folders from now on: its workspace's folders,
     * and any one-off extra folders of its own.
     */
    setWorkspace: "/api/session/workspace",

    /**
     * `{}` → `{ chats: ChatRow[], aliases, workspaces: Workspace[], kiro: KiroRow[] }`.
     * Every chat with a message, newest first. `aliases`: the names given
     * to folders that are no workspace's main folder, folder key (see
     * `folderKey`) to the name the list shows. `workspaces`: every
     * workspace, with its name and folders. `kiro`: Kiro's own
     * sessions in those folders - read in the background, so the first
     * list may have none, and `eesha.listChanged` follows when they come.
     */
    chats: "/api/chats",

    /**
     * `{ view }` → SessionInfo, or `{ problem }` when the tab shows no
     * session. What the Session panel shows that only the server knows.
     */
    sessionInfo: "/api/session/info",

    /** `{ sessionId }` → `{ chatId }` or `{ problem }`. Makes one of the `kiro` rows an Eesha Code session, its thread read back from Kiro. */
    openKiro: "/api/kiro/open",

    /**
     * `{ view, sessionId }` → `{ ok: true }` or `{ problem }`. Deletes one
     * of the `kiro` rows in Kiro, for good, after a question in this tab.
     * Refused while Kiro says it is working.
     */
    deleteKiro: "/api/kiro/delete",

    /** `{ view, sessionId }` → `{ ok: true }` or `{ problem }`. Asks for a new name in this tab, then renames one of the `kiro` rows in Kiro. */
    renameKiro: "/api/kiro/rename",

    /**
     * Workspace → `{ ok: true }` or `{ problem }`. With `key`: changes the
     * workspace with that key. Without: adds one - a second one on a main
     * folder that has a workspace already gets a key of its own. `name`
     * empty: the main folder's name. `link` is the work item's or issue's
     * `>` path, as a list of levels; absent: no link.
     */
    saveWorkspace: "/api/workspaces/save",

    /** `{ key, archived }` → `{ ok: true }` or `{ problem }`. Archives a workspace, or brings it back. */
    archiveWorkspace: "/api/workspaces/archive",

    /**
     * `{ path }` → `{ link: WorkspaceLink }` or `{ problem }`. What a
     * picked `>` path is as a workspace's link: only an ADO work item or
     * a GitHub issue is one.
     */
    workspaceItem: "/api/workspaces/item",

    /** `{ key }` → `{ ok: true }`. Takes the workspace with this key off the list. Its sessions stay. */
    removeWorkspace: "/api/workspaces/remove",

    /** `{}` → AiOptions. For the workspace window. */
    aiOptions: "/api/ai",

    /** `{ chatId, mark }` → `{ ok: true }` or `{ problem }`. Pins or archives a chat; `mark: null` puts it back in its folder. */
    markChat: "/api/chats/mark",

    /**
     * `{ view, chatIds, where }` → `{ ok: true }` or `{ problem }`. Deletes
     * these chats after one question in this tab - "Delete all 5 chats
     * <where>?", saying how many of them are pinned or archived. Nothing
     * is deleted when any of them is working or open in another tab.
     * `{ view, chatIds: [one], row: true }`: a row's own Delete - the
     * question names the session. When the delete leaves a folder with
     * no session, the question offers to keep it in the list.
     */
    deleteChats: "/api/chats/delete",

    /**
     * `{ folder, name }` → `{ ok: true }` or `{ problem }`. The name the
     * session list shows for the workspace whose main folder this is - or,
     * for a folder that is no workspace's, its alias. Empty: the folder's
     * own name again.
     */
    workspaceName: "/api/workspaces/name",

    /** `{ view }` → `{ title, text }` or `{ problem }`. This tab's chat as Markdown, for Export. */
    exportChat: "/api/chat/export",

    /** `{ query }` → `{ hits: SearchHit[] }`. The chats whose messages - the person's and the agent's answers - hold this text. */
    searchChats: "/api/chats/search",

    /** `{ view, id, value }` - the answer to a `eesha.prompt`. `value` absent: backed out. */
    reply: "/api/reply",
    /**
     * `{ view, path? }` → `{ entries: FileItem[] }` or `{ problem }`. For the
     * files pane. No path: the chat's folders - the scratch folder first
     * when the agent works there. A path: what is in that folder, folders
     * first; `.git` and `node_modules` are left out. Only inside the chat's folders.
     */
    files: "/api/files",
    /** `{ view, path }` → `{ text }` or `{ problem }`. One file's text for the files pane. Only inside the chat's folders. */
    file: "/api/file",

    /**
     * `{ view }` → `{ repos: GitStatus[], problems: { root, problem }[] }`.
     * Every repository the chat's folders give, with its state. One whose
     * state git could not read is in `problems` instead.
     */
    gitStatus: "/api/git/status",

    /** `{ view, root }` → GitLists or `{ problem }`. Branches, tags, stashes and remotes. */
    gitLists: "/api/git/lists",

    /** `{ view, root }` → `{ commits: GitCommit[] }` or `{ problem }`. The last 50 commits. */
    gitCommits: "/api/git/commits",

    /** `{ view, root, hash }` → `{ files: GitCommitFile[] }` or `{ problem }`. What one commit changed. */
    gitCommitFiles: "/api/git/commit-files",

    /** `{ view, root, ask: GitDiffAsk }` → GitDiff or `{ problem }`. */
    gitDiff: "/api/git/diff",

    /** `{ view, root, action: GitAction }` → `{ ok: true, text? }` or `{ problem }`. Refused while the agent works. */
    gitAction: "/api/git/action",

    /** `{ view, on }` → `{ ok: true }`. While on, the tab gets `eesha.gitChanged` when a file in one of the chat's repositories changes. */
    gitWatch: "/api/git/watch",

    /**
     * `{ view, root }` → `{ message }` or `{ problem }`. A commit message
     * from a hidden session on the chat's runtime and model, which looks
     * at the repository itself and is deleted after. `{ view, stop: true }`
     * stops the one running for this tab.
     */
    gitMessage: "/api/git/message",

    /** `{}` → `{ shells: ShellChoice[] }`. The shells on this machine, the default first. */
    shells: "/api/shells",

    /**
     * `{ view, code, shell, folder }` → `{ id }` or `{ problem }`. Runs a
     * command block once, in one of this tab's session folders. What it
     * prints comes as `eesha.run` events with that id.
     */
    run: "/api/run",

    /** `{ view, id }` → `{ ok: true }`. Stops a run this tab started. */
    runStop: "/api/run/stop",

    /** `{}` → SettingsView. */
    settings: "/api/settings",

    /** SettingsChange → SettingsView or `{ problem }`. Written into settings.json at once. */
    settingsChange: "/api/settings/change",

    /** `{ text }` → SettingsView or `{ problem }`. The whole settings.json, checked before it is written. */
    settingsSave: "/api/settings/save",

    /**
     * `{ id, command, args }` → SettingsView or `{ problem }`. Starts the
     * program once to check it speaks ACP, then adds it to
     * `ai.acpAgents`. Can take up to 20 seconds.
     */
    runtimeAdd: "/api/settings/runtime/add",

    /** `{ id }` → SettingsView or `{ problem }`. Removes a runtime the person added. */
    runtimeRemove: "/api/settings/runtime/remove",

    /** `{}` → `{ port }`: a port nothing listens on now, for the Port box. Nothing is written. */
    freePort: "/api/settings/free-port",

    /** `{}` → SettingsView. Empties ~/.eesha/trash. */
    emptyTrash: "/api/storage/trash",

    /** `{}` → SettingsView. Removes the scratch folders no chat uses. */
    removeScratch: "/api/storage/scratch",

    /** `{}` → UpdateCheckView. Asks npm for the newest Eesha Code - from the version in the footer. */
    updateCheck: "/api/update/check",

    /**
     * `{ version? }` → `{ ok: true }` or `{ problem }`. Installed from npm:
     * installs `version` and starts again. From source: `npm run build`,
     * then starts again. Refused while a session is working.
     */
    updateStart: "/api/update/start",

    /** `{}` → `{ cards: ConnectorCard[] }`. The Connectors section of the settings page. */
    connectors: "/api/connectors",

    /**
     * `{ id }` → `{ ok: true }` or `{ problem }`. Starts the CLI's sign-in;
     * what it prints comes as `eesha.connectorSignIn` events. `{ id, stop: true }` stops it.
     */
    connectorSignIn: "/api/connectors/sign-in",

    /** `{ id, config: ConnectorChoices }` → `{ cards }` or `{ problem }`. Saves what is in reach and each source's access. */
    connectorSave: "/api/connectors/save",

    /** `{ id }` → `{ cards }` or `{ problem }`. Disconnect: forgets the choices. The CLI stays signed in. */
    connectorRemove: "/api/connectors/remove",

    /** `{}` → MemoryView. Every memory, grouped, with the choices - the Memory section and the Connectors row. */
    memory: "/api/memory",

    /** `{ choices: Partial<MemoryChoices> }` → MemoryView or `{ problem }`. Written into settings.json. */
    memoryChoices: "/api/memory/choices",

    /** `{ memory: MemoryEdit }` → MemoryView or `{ problem }`. Adds a memory, or changes the one with that id. */
    memorySave: "/api/memory/save",

    /** `{ id }` → MemoryView or `{ problem }`. Deletes one memory. The page asks first. */
    memoryRemove: "/api/memory/remove",

    /** `{ from, to }` → MemoryView or `{ problem }`. Gives a folder's memories to another folder - it was moved or renamed. */
    memoryRepoint: "/api/memory/repoint",

    /**
     * `{ workspace }` → SpecListView or `{ problem }`. The specs in that
     * workspace's main folder.
     * `workspace` is the workspace's key - see `workspaceKey`.
     */
    sddSpecs: "/api/sdd/specs",

    // Every SDD route below also takes `folder`: a folder of the
    // workspace other than its main one, whose specs are meant.

    /**
     * `{ view, workspace, spec }` → `{ ok: true }` or `{ problem }`. This
     * tab shows that spec in its SDD editor from now on; the spec's
     * messages come as `eesha.sdd` events. A tab that showed it before is
     * told it moved.
     */
    sddOpen: "/api/sdd/open",

    /** `{ view, message }` - a message from the SDD editor, passed to the spec this tab shows. */
    sdd: "/api/sdd",

    /** `{ workspace }` → NewSpecOffers or `{ problem }`. */
    sddOffers: "/api/sdd/offers",

    /** NewSpecAsk → `{ name }` or `{ problem }`. Writes the spec's folder and idea.md. No AI runs. */
    sddCreate: "/api/sdd/create",

    /**
     * `{ path, query, refresh? }` → `{ rows: PathMatch[] }`. New spec's
     * connector picker: the rows one level below `path`,
     * the same rows the compose box's `>` list shows.
     */
    sddPick: "/api/sdd/pick",

    /**
     * `{ path }` → `{ line?, link?, problem? }`. What a picked item is -
     * the line the compose box would send - and its link, which New spec
     * records in idea.md.
     */
    sddPickLink: "/api/sdd/pick-link",

    /** `{ workspace }` → CopyStyleOffers or `{ problem }`. What the Copy a style window offers. */
    sddCopyOffers: "/api/sdd/copy-offers",

    /** CopyStyleAsk → `{ text }` or `{ problem }`. Copies a built-in style as a new style. */
    sddCopyStyle: "/api/sdd/copy-style",

    /** `{ workspace, sort }` → `{ ok }`. Keeps the workspace's spec order; every tab reads its list again. */
    sddSort: "/api/sdd/sort",

    /**
     * `{ workspace }` → `{ removed }`. Throws away the old copies of spec
     * documents that "What changed" compares against, for the workspace's
     * main folder. The page asks first.
     */
    sddClearHistory: "/api/sdd/clear-history",

    /**
     * `{ workspace }` → SpecExplorerView. Every folder of the workspace,
     * each with its specs and their phases - the Spec explorer.
     */
    sddExplorer: "/api/sdd/explorer",

    /**
     * `{ count }` → RecentSpecsView. The specs most recently changed, from
     * every workspace that is not archived - the start page's "Recent
     * specs". A folder that cannot be read is left out.
     */
    sddRecent: "/api/sdd/recent",

    /**
     * `{ workspace, folder?, spec }` → `{ sessions: SpecSessionView[] }`.
     * Every session the spec's phases have had, oldest first.
     */
    sddSessions: "/api/sdd/sessions"
} as const;

// -------------------------------------------------------------------
// Connectors - the shapes connectors/config.ts reads
// from settings.json, shared with the page.
// -------------------------------------------------------------------

export type ConnectorId = "ado" | "github";

/** Off, Read, or Read and write. */
export type ConnectorAccess = "off" | "read" | "write";

export interface AdoProject {

    org: string;

    project: string;
}

export interface AdoChoices {

    reach: AdoProject[];

    sources: Record<"workitems" | "queries" | "repos" | "pulls" | "builds" | "releases" | "wiki" | "testplans", ConnectorAccess>;
}

export interface GithubChoices {

    /** "owner" (every repo of that user or org) or "owner/repo". */
    reach: string[];

    sources: Record<"repos" | "files" | "pulls" | "issues" | "actions" | "releases" | "discussions" | "projects", ConnectorAccess>;
}

// -------------------------------------------------------------------
// Memory - short facts kept between sessions, in ~/.eesha/memory.db.
// See memory/Memory.ts.
// -------------------------------------------------------------------

/** Who gets a memory: every session, one workspace's sessions, or any session with one folder. */
export type MemoryLevel = "global" | "workspace" | "folder";

/** Who wrote a memory: an agent through the tools, or the person on the Memory page. */
export type MemoryAuthor = "ai" | "person";

export interface MemoryRow {

    id: number;

    level: MemoryLevel;

    /** Empty for global, the workspace's key, or the folder's key (see `folderKey`). */
    owner: string;

    /** A folder memory's folder as it was written, for showing. Empty otherwise. */
    place: string;

    title: string;

    text: string;

    author: MemoryAuthor;

    /** In ms. */
    created: number;

    updated: number;
}

/**
 * What the person chose for memory - `eesha.memory` in settings.json.
 * Machine wide, like every connector's choices.
 */
export interface MemoryChoices {

    /** Off: no session gets the memory. Read: sessions read it. Write: they also save, change and delete. */
    access: ConnectorAccess;

    /** The AI's save, change or delete asks the person first, every time. Off: it only shows a notice. */
    askOnSave: boolean;

    /**
     * Claude's own memory is turned off in Eesha Code's Claude sessions.
     * While memory is on, a Claude session starts only once this is true.
     */
    claudeMemoryOff: boolean;
}

/** One group on the Memory page: a level's memories under one owner. */
export interface MemoryGroup {

    level: MemoryLevel;

    owner: string;

    /** "Global", the workspace's name, or the folder's path. */
    label: string;

    /** A workspace that is archived or gone, or a folder that is not on disk now. */
    missing?: "archived" | "gone";

    memories: MemoryRow[];
}

/** The answer to every `API.memory*` route that changes or reads the page. */
export interface MemoryView {

    choices: MemoryChoices;

    groups: MemoryGroup[];

    /** Where a memory can be put: every workspace that is not archived, by key and name. */
    workspaces: { key: string; name: string }[];

    /** Every folder the workspaces and the recent list know, full paths. */
    folders: string[];
}

/** A memory as the Memory page sends it to be saved. `id`: change that one. */
export interface MemoryEdit {

    id?: number;

    level: MemoryLevel;

    /** The workspace's key, or the folder's full path. Not sent for global. */
    owner?: string;

    title: string;

    text: string;
}

/** The answer to `API.sessionInfo`. */
export interface SessionInfo {

    /**
     * The instruction files the session's folders have, full paths:
     * `.eesha/system.md` (every runtime) and `.eesha/kiro.md`
     * (`kiroOnly`: a Kiro runtime only) - see instructions.ts.
     */
    instructionFiles: { path: string; kiroOnly?: boolean }[];

    /** The MCP servers Eesha Code adds to the session itself: its connectors server while a connector is connected or memory is on. */
    sentServers: string[];
}

/** A GitHub owner or an ADO organization in the Connect window, with its repos or projects. */
export interface OfferedGroup {

    name: string;

    items: string[];
}

/** One card in the settings page's Connectors section. */
export interface ConnectorCard {

    id: ConnectorId;

    title: string;

    /** The CLI is on this machine. */
    cli: boolean;

    /** How to install the CLI, when it is not. */
    install?: string;

    /** Who the CLI is signed in as. */
    account?: string;

    /** The saved choices - absent when not connected. */
    config?: AdoChoices | GithubChoices;

    /** What the git remotes of the saved and recent folders point to: "org/project" or "owner/repo". */
    found: string[];

    /**
     * More offered in the Connect window under `found`, as groups with their
     * items. GitHub: the signed-in user and each of their organizations, with
     * its repos as "owner/repo" - the group itself is tickable, and an owner
     * covers all its repos. ADO: each organization the az sign-in belongs to,
     * with its projects as "org/project" - ticking the group ticks them all.
     */
    offered: OfferedGroup[];

    /** A sign-in is running now. */
    signingIn: boolean;
}

/** What the footer's version button shows: the version running, and the newest on npm. */
export interface UpdateCheckView {

    current: string;

    /** "npm": installed with npm install -g. "source": run from the repository. */
    kind: "npm" | "source";

    /** The newest on npm. Absent when npm could not be asked - see `problem`. */
    latest?: string;

    problem?: string;
}

/**
 * Sent with the hello for a few minutes after an upgrade started from the
 * page, so the page can say how it went. `at` tells one upgrade from the next.
 */
export interface UpgradedView {

    from: string;

    /** The version asked for; absent for a build from source. */
    to?: string;

    kind: "npm" | "source";

    problem?: string;

    at: number;
}

/**
 * Whether `latest` is newer than `current`: 1.2.3 against 1.2.4, the
 * three numbers first. A release is newer than its own pre-release
 * (1.2.3 beats 1.2.3-beta.1); two pre-releases of one version compare
 * as text.
 */
export function isNewerVersion(latest: string, current: string): boolean {

    const [mainA, preA] = latest.split("-", 2);
    const [mainB, preB] = current.split("-", 2);

    const a = mainA.split(".").map(Number);
    const b = mainB.split(".").map(Number);

    for (let at = 0; at < 3; at++)
        if ((a[at] ?? 0) !== (b[at] ?? 0))
            return (a[at] ?? 0) > (b[at] ?? 0);

    if (preA === preB)
        return false;

    if (!preA)
        return true;

    if (!preB)
        return false;

    return preA > preB;
}

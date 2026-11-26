import type { AgentSessions } from "../core/agent";
import type { SavedAnswer } from "../core/models/permissionCard";
import type { AskPermission, TurnChanges } from "../core/models/run";
import type { PluginHost } from "../core/plugins/PluginHost";
import type { AiPick } from "../sdd/config/sddConfig";
import type { ToChatView } from "../shared/chatMessages";
import type { FileMatch, PathMatch } from "../shared/composeFiles";
import type { AiChoiceEnv } from "./aiChoice";
import type { ChatController } from "./ChatController";
import type { ChatStore } from "./chatStore";

/*
 * What one chat needs from the server it runs in. The server supplies
 * it, so the chat itself - `ChatController` - has no server code in it.
 */

/** Where one chat is drawn: a browser page. */
export interface ChatSurface {

    /** One message to the page. Never throws for a page that has gone. */
    post(message: ToChatView): void;
}

/**
 * The line kinds an unattended chat writes when a turn did not end by
 * itself: the person pressed Stop, or the turn failed. The Evaluator's
 * report reads them. The thread does not draw them.
 */
export const TURN_STOPPED = "turn.stopped";
export const TURN_FAILED = "turn.failed";

/** What a chat tells its host about as it happens - see `ChatHost.notify`. */
export type ChatNotice =

    /** A turn ended by itself: the agent finished, or the turn failed. Not one the person stopped. */
    | { kind: "ended"; outcome: "done" | "failed" }

    /** The agent asked something and is stopped until it is answered. `text` is the question. */
    | { kind: "asked"; text: string };

/**
 * What a turn typed in a phase chat carries besides the message, as
 * SDD gives it - the same as `ai@1`'s args of the same names.
 */
export interface TurnExtras {

    /** Files the turn may not write, absolute: a native phase's other documents. */
    refuseWrites?: string[];

    /** The plan whose boxes the turn ticks, absolute: a wave of Implementation. */
    plan?: string;

    /** The files the turn is known to work on: a wave's `Files:` lines. */
    files?: string[];
}

/**
 * SDD's side of a phase chat - a chat it made for one phase of a spec
 * (see `ChatSpecLink`). The chat asks it on every turn the person
 * types there; a turn SDD itself hands the chat comes with all of this
 * already in it (see `ChatController.runOwned`).
 */
export interface PhaseOwner {

    /** The plugins every turn of the chat runs with: the spec's, which may name the repository's own. */
    plugins(): PluginHost;

    /**
     * The AI a typed turn runs on: the spec's. The pickers do not choose
     * it. `pick`: the runtime the chat is held to - the one it started on,
     * or the one a Handover moved it to - with its model when the person
     * picked one. Throws with why when there is none.
     */
    ai(pick?: AiPick): Promise<{ uses: string; args: Record<string, unknown> }>;

    /** What a typed turn carries besides the message. */
    extras(): Promise<TurnExtras>;

    /** Why a typed turn may not start now - another phase of the spec is running. Nothing when it may. */
    refuse(): string | undefined;

    /** The plan stopped at this chat: a message into it carries the plan on. The thread's Resume button. */
    resumable(): boolean;

    /** A typed turn starts: the spec is busy with this phase until `ended`. `stop` stops the turn. */
    started(stop: () => void): void;

    /**
     * Puts the phase's document aside before the typed turn runs, so the
     * Doc tab's "What changed" shows what this turn changed - the same
     * copy Start and Revise take. Waited for before the message is sent.
     */
    keepBaseline(): Promise<void>;

    /** The typed turn ended: the spec reads its document again. */
    ended(success: boolean): Promise<void>;
}

export interface ChatHost {

    /** Saved values: the chat's runtime and tools pick, names given by hand, the permission levels. */
    readonly store: ChatStore;

    /** What the runtime, model and permission pickers need. Its `workspaceFolder` is also where settings.json is read. */
    readonly ai: AiChoiceEnv;

    /** Where the full log is, for a turn that failed with no reason. */
    readonly logPlace: string;

    /** The folder the agent works in. Nothing when no folder is open. */
    workspace(): string | undefined;

    /** Every folder steering files are looked for in, the working folder first. */
    folders(): string[];

    /**
     * The folders whose git repositories are watched during a turn, so
     * the files it changed are listed after it. Every folder of the chat.
     */
    changeFolders(): string[];

    /** What the chat files are filed under - see `chatEventsPath`. Nothing files them under the profile's no-workspace folder. */
    historyKey(): string | undefined;

    /** Where uploaded files and handover notes are saved, inside the working folder so the agent may read them. */
    scratchFolder(workspace: string): string;

    /** The plugins a turn runs with - `ai@1` among them. */
    plugins(): PluginHost;

    /** SDD's side of the chat, when it is a phase chat. Nothing for any other chat. */
    owner?(): PhaseOwner | undefined;

    /**
     * Nobody answers this chat's agent - a variant of an evaluation. Its
     * turns run as unattended ones: the agent is told nobody is there and
     * gets no question tool. It has no Permissions picker, and its
     * runtime and model are never picked in it: they are set when the
     * variant is made.
     */
    unattended?(): boolean;

    /** A message typed in the compose box was sent - a phase chat is marked for the session list's Recent. */
    typedIn?(): void;

    /** The live agent conversations the server holds. */
    sessions(): AgentSessions;

    /** Files under `root` for the "@" search. */
    searchFiles(root: string, query: string): Promise<FileMatch[]>;

    /**
     * The ">" list in the compose box: the rows one level below `path`
     * that match `query`, from the connectors. `refresh`: ask the
     * service again, not a saved list - the person picked the refresh row.
     */
    searchPaths(path: readonly string[], query: string, refresh?: boolean): Promise<PathMatch[]>;

    /**
     * What the ">" paths in a message point at, as lines sent to the
     * agent with it - one per path. The thread shows the message as
     * typed. `note`: a path that could not be read, for the log.
     */
    pathReferences(text: string): Promise<{ lines: string[]; note?: string }>;

    /**
     * Standing instructions for a session about to start on `provider` -
     * sent as ai@1's `systemInstructions`, which each runtime takes as its
     * system prompt (or, over ACP with no other way, in front of the first
     * message). They come from `.eesha/system.md` in the chat's folders.
     */
    systemInstructions(provider: string): string | undefined;

    /**
     * Asked before a typed turn starts on `provider`, once the runtime is
     * known. The host may ask the person something first. A text back
     * stops the turn and is shown as why; nothing lets it run.
     */
    beforeTurn?(provider: string): Promise<string | undefined>;

    /** A short notice: nothing happened, and the thread is not the place for why. */
    note(text: string): void;

    /** Asks for a line of text. Nothing when the person backs out. */
    askText(request: { title: string; value: string; prompt: string }): Promise<string | undefined>;

    /** Asks before something that cannot be taken back. True only for `action`. */
    confirm(text: string, action: string): Promise<boolean>;

    /**
     * Opens a file for the person. `listed`: the runtime's context window
     * lists this file (a steering file, a CLAUDE.md), so it is shown even
     * when it is outside the chat's folders. The chat has checked that.
     */
    openFile(file: string, listed?: boolean): void;

    /** Shows one changed file: before the turn against now. `absolute` is checked to be inside the repository. */
    showDiff(changed: Omit<TurnChanges, "files">, file: string, absolute: string): Promise<void>;

    /**
     * Shows what one turn did to one file: before the turn against right
     * after it, both read from the turn's snapshots - later changes are
     * not in it. `file` is checked to be inside the repository.
     */
    showTurnDiff(changed: Omit<TurnChanges, "files">, file: string): Promise<void>;

    /**
     * Shows every file in `files` at once, each before the turn against
     * now, each with its own Undo. `absolute` is checked as for
     * `showDiff`.
     */
    showReview(files: { changed: TurnChanges; file: string; absolute: string }[]): Promise<void>;

    /** Moves a file to the trash - an undo of a file the turn added. */
    trash(absolute: string): Promise<void>;

    /** Tells the person an agent is blocked on a question while the chat is not on screen. `open` puts it back. */
    announceAsk(where: string, prompt: string | undefined, permission: AskPermission | undefined, open: () => unknown): void;

    /** The other chat on screen showing this chat id, when one does. */
    holder(chatId: string, asking: ChatController): ChatController | undefined;

    /** Puts that chat in front. */
    show(chat: ChatController): void;

    /** The chat on screen is another one now, or a turn just ended. */
    changed(chat: ChatController): Promise<void>;

    /** A chat was renamed - titles are read again. `chatId`: the person renamed this one by hand. */
    renamed(chatId?: string): void;

    /**
     * A chat's file was deleted. The server drops what it kept for the
     * chat - its folder list and an empty scratch folder - so the chat's
     * address says it is gone.
     */
    deleted(chatId: string): void;

    /**
     * The chat on screen was deleted. When it is in a workspace, its tab
     * goes to that workspace's page and stops showing this chat. No such
     * workspace, or no host that can: nothing happens, and a new chat
     * takes its place on screen.
     */
    leaveDeleted?(): void;

    /**
     * A chat's file was copied to a new chat - going back to an earlier
     * message keeps the chat as it was under `toId`. The server gives the
     * copy the same folders, and the same scratch folder: the runtime
     * keeps a conversation under the folder it ran in, so the copy must
     * run there too.
     */
    copied(fromId: string, toId: string): void;

    /**
     * A turn ended, or the agent asked something. The page shows a
     * notice wherever the person is looking. Every time, the chat on screen or not; never for a line drawn
     * again from the chat's file. `announceAsk` is the one for a question
     * while the chat is not on screen.
     */
    notify(chat: ChatController, notice: ChatNotice): void;

    /**
     * The permission check: the compose row shows the Permissions
     * picker (one level per provider) and the saved answers list.
     */
    readonly permissions: ChatPermissions;
}

/** The saved answers a host keeps for its permission check. */
export interface ChatPermissions {

    /** The answers that hold for this chat: its own session answers, its working folder's, and every Always one. */
    saved(chatId: string, folder: string): SavedAnswer[];

    /** Removes one answer. False when it was already gone. */
    remove(id: string): boolean;
}

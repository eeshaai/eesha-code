import type { SavedAnswer } from "../core/models/permissionCard";
import type { LogMeta, RuntimeCommand, TurnChanges } from "../core/models/run";
import type { FileMatch, PathMatch, SentFile } from "./composeFiles";
import type { AiChoiceMessage, StageAi } from "./runMessages";

/** One saved permission answer as the list shows it: `shown` is the pattern in a person's words. */
export interface SavedAnswerRow extends SavedAnswer {

    shown: string;
}

/*
 * What the chat and its host say to each other.
 *
 * Its own set rather than more cases on the spec panel's: the chat
 * has no spec, no phase and no stage id. Every line is the one
 * chat's.
 */

/**
 * A chat's own pick of MCP servers and built-in tools - the compose
 * box's Tools and MCP servers pickers. Kept per chat, like its runtime.
 */
export interface ChatToolset {

    /** The settings.json MCP servers it gets. Absent: every one declared. */
    mcpServers?: string[];

    /** Built-in tools picked by hand, by runtime - the names differ per runtime. A runtime not here gets all of its own. */
    tools?: Record<string, string[]>;

    /** The claude.ai account's own connectors (Gmail, Drive…), Claude only. Off unless turned on. */
    claudeAiConnectors?: boolean;
}

/** What the pickers offer, and what this chat has picked. */
export interface ToolsetChoice {

    /** The runtime's built-in tools. Empty: no Tools picker (the runtime cannot list them, or cannot switch them off). */
    tools: { id: string; description?: string }[];

    /** settings.json's MCP servers, plus the claude.ai connectors entry on Claude. */
    servers: { id: string; description?: string }[];

    autoTools: boolean;
    enabledTools: string[];
    autoServers: boolean;
    enabledServers: string[];
}

/** The MCP picker's entry for the claude.ai account's connectors - see {@link ChatToolset.claudeAiConnectors}. */
export const CLAUDE_AI_CONNECTORS = "claude.ai connectors";

/** What the compose box's pickers said on Send - the UI library's own shape. */
export interface SentToolSelection {
    autoTools: boolean;
    enabledToolIds: string[];
    autoMcpServers: boolean;
    enabledMcpServerIds: string[];
}

/**
 * The spec a phase chat belongs to. SDD made the chat for one phase of
 * the spec, or for one wave of its Implementation, and watches it: it
 * picks the AI of every turn and reads the phase's document when a turn
 * ends. The spec's workspace is the chat's own workspace.
 */
export interface ChatSpecLink {

    /** The spec's name - its folder's name. */
    spec: string;

    /** The workspace folder the spec is in, when it is not the workspace's main folder. */
    folder?: string;

    /** The phase's stage id, or `<stage id>@wave:<n>` for one wave of Implementation. */
    phase: string;
}

/** One chat in the history list. */
export interface ChatSummary {

    id: string;

    /** The name given it, else the first thing asked. */
    title: string;

    /** When anything last happened in it, epoch milliseconds. */
    at: number;

    /** The runtime it was last on. */
    provider?: string;

    /** The chat on screen now. */
    current?: boolean;
}

/**
 * One of the person's messages in the thread: the how-manyth it is,
 * counted from the top from 0, and its text, which the host checks
 * against its own file before doing anything.
 */
export interface PromptRef {

    index: number;

    text: string;
}

/** From the view to the host. */
export type ToChatHost =
    | { type: "ready" }

    /** A message from the compose box. */
    | { type: "send"; text: string; files?: SentFile[]; tools?: SentToolSelection }

    | { type: "answer"; askId: string; answer: string }
    | { type: "cancel" }
    | { type: "newChat" }

    /** The Compact button in the context meter - shrink this chat's context. */
    | { type: "compact" }

    /** Sign in on an MCP server's row in the Session panel - start that server's sign-in again. */
    | { type: "signInMcp"; server: string }

    /** This chat's runtime and model. Nothing clears it back to the settings' default. */
    | { type: "setAiChoice"; pick?: { provider: string; model?: string; mode?: string; effort?: string } }

    /** Eesha Code's Permissions picker: one runtime's level. */
    | { type: "setPermissionLevel"; provider: string; level: "manual" | "agent" | "semi" | "auto" }

    /** "Saved answers" at the foot of the Permissions picker: send the list. */
    | { type: "listSavedAnswers" }

    /** Remove one saved answer from the list. */
    | { type: "removeSavedAnswer"; id: string }

    /**
     * The Handover modal's Start (the `handover` flag): move this chat
     * to another runtime.
     */
    | { type: "handover"; provider: string; model?: string }

    /** The Handover modal picked a runtime whose model list may not be in yet - fetch it. */
    | { type: "listModels"; provider: string }

    /** The refresh button beside a model picker - fetch the runtime's list again and replace its file. */
    | { type: "refreshModels"; provider: string }

    | { type: "searchFiles"; requestId: number; query: string }

    /** The ">" list: the rows one level below `path` - see `ChatHost.searchPaths`. */
    | { type: "searchPaths"; requestId: number; path: string[]; query: string; refresh?: boolean }
    | { type: "open"; path: string }

    /**
     * A file row in the context window was clicked - a steering file, a
     * CLAUDE.md. `path` is as `contextFile` gave it. Shown only when the
     * runtime's newest context window lists it, wherever the file is.
     */
    | { type: "openContextFile"; path: string }

    /** The history list is being shown - send it. */
    | { type: "listHistory" }

    | { type: "openChat"; chatId: string }

    /** The host asks for the new name. */
    | { type: "renameChat"; chatId: string }

    /** The host asks to confirm first. */
    | { type: "deleteChat"; chatId: string }

    /** One file a turn changed: before the turn against now, in a diff tab. */
    | { type: "diffFile"; changed: Omit<TurnChanges, "files">; path: string }

    /** One file as one turn left it: before that turn against after it. */
    | { type: "diffTurn"; changed: Omit<TurnChanges, "files">; path: string }

    /** Put these files back as they were before the turn. */
    | { type: "undoFiles"; changed: TurnChanges; paths: string[] }

    /** Every file in these changes, before the turn against now, in one window. */
    | { type: "reviewFiles"; changes: TurnChanges[] }

    /** Keep what the turn did - the changed-files bar goes away. */
    | { type: "keepFiles"; changed: Omit<TurnChanges, "files"> }

    /**
     * "Go back to here", or Send on an edited message: what going back
     * to this message would do - the host answers with `goBackInfo`.
     * `text` is the edited message, for the dialog to say it is sent.
     */
    | { type: "goBackCheck"; prompt: PromptRef; text?: string }

    /**
     * Go back to just before this message: the later part leaves this
     * chat (a copy keeps it whole). `restoreFiles` puts the files back
     * as they were. `text`: an edited message, sent once back - absent,
     * the message goes back into the compose box instead.
     */
    | { type: "goBack"; prompt: PromptRef; restoreFiles: boolean; text?: string };

/** From the host to the view. */
export type ToChatView =
    | { type: "log"; text: string; stream?: "stdout" | "stderr" | "system"; meta?: LogMeta }

    /**
     * A message from the compose box never went: no prompt line was
     * posted for it. The view drew it as "Sending…" when it was sent;
     * this turns that line into "Not sent". `text` is the message as
     * typed, so the right line is marked when two were sent close
     * together. The host says why in its own notice or error line.
     */
    | { type: "unsent"; text: string }

    /** A new chat - the thread is emptied. */
    | { type: "clearLog" }

    /** The chat on screen - kept in the page's address, so a reload opens the same chat. */
    | { type: "chat"; chatId: string }

    | { type: "busy"; running: boolean }

    /** A stopped plan waits on this phase chat: the thread offers Resume, which sends "continue". */
    | { type: "resumable"; on: boolean }

    /**
     * The picker: what can be picked, and what this chat runs on now.
     * `locked`: a phase chat - style.yml and settings.json choose, not this one.
     */
    | { type: "aiChoice"; choice: AiChoiceMessage; current: StageAi; locked?: boolean }

    /**
     * Eesha Code: the saved answers that hold for this chat, for the list
     * opened from the Permissions picker. `chat` is the chat's name, and
     * `folder` its working folder - the "This folder" group's.
     */
    | { type: "savedAnswers"; answers: SavedAnswerRow[]; chat: string; folder: string }

    | { type: "fileMatches"; requestId: number; files: FileMatch[] }

    | { type: "pathMatches"; requestId: number; items: PathMatch[] }

    /**
     * The `sessionCost` feature flag.
     * `paths`: the server has a ">" list (the connectors).
     */
    | { type: "features"; sessionCost: boolean; paths?: boolean }

    | { type: "history"; chats: ChatSummary[] }

    /** The compose box's Tools and MCP servers pickers - see {@link ToolsetChoice}. */
    | { type: "toolset"; choice: ToolsetChoice }

    /**
     * The slash commands of the chat's runtime, listed when "/" is the
     * first thing typed - see `commandListFile.ts`. Empty: none.
     */
    | { type: "commands"; commands: RuntimeCommand[] }

    /**
     * Files to put in the compose box as file chips, sent with the next
     * message - the + button in Eesha Code's files pane. `path` is full, or
     * relative to the working folder. A file already in the box is not
     * added twice.
     */
    | { type: "addFiles"; files: { path: string; name?: string }[] }

    /**
     * Text to add at the end of the compose box - lines picked in
     * Eesha Code's file view, as a code block with the path above it.
     */
    | { type: "addText"; text: string }

    /**
     * What going back to a message would do, for the dialog: the files
     * that would be put back (relative to their repository, with its
     * folder name in front when there are several), and one sentence on
     * what happens to the runtime's conversation.
     */
    | { type: "goBackInfo"; prompt: PromptRef; text?: string; files: string[]; about: string }

    /** Puts a message back in the compose box: its text, and its files as chips. After going back. */
    | { type: "refill"; text: string; files: { path: string; name?: string }[] };

/*
 * Our own permission check's words, shared by the engine and the page: the
 * levels, the card the page draws, and the answer it sends back. No Node
 * imports - the chat view loads this file too.

 */

/**
 * How much a chat asks before the agent uses a tool. One per provider.
 *
 * - `manual` (SDK runtimes): asks for commands, edits, MCP tools, web and
 *   unknown tools.
 * - `agent` (ACP agents, "Agent's Choice"): every request the agent sends
 *   shows a card.
 * - `semi`: asks for commands only.
 * - `auto`: never asks.
 *
 * A path outside the chat's folders is asked at every level.
 */
export type PermissionLevel = "manual" | "agent" | "semi" | "auto";

/** The levels an SDK runtime (`claude`, `ghcp`) offers, in menu order. */
export const SDK_LEVELS: readonly PermissionLevel[] = ["manual", "semi", "auto"];

/** The levels an ACP agent offers, in menu order. */
export const ACP_LEVELS: readonly PermissionLevel[] = ["agent", "semi", "auto"];

/** A provider never set starts here. */
export const DEFAULT_LEVEL: PermissionLevel = "auto";

export const LEVEL_NAMES: Readonly<Record<PermissionLevel, string>> = {
    manual: "Manual",
    agent: "Agent's Choice",
    semi: "Semi Auto",
    auto: "Auto"
};

/** The line under a level in the menu - as drawn on the approved canvas. */
export function levelHint(level: PermissionLevel, acp: boolean): string {

    switch (level) {

        case "manual":
            return "Asks before shell commands, file edits, MCP tools, web and any tool it cannot name. Reads inside the chat's folders run without asking.";

        case "agent":
            return "Every request the agent sends asks you.";

        case "semi":
            return acp
                ? "Asks when the agent wants to run a shell command, or sends a request it does not name. Everything else it sends is allowed."
                : "Asks before shell commands only. Everything else runs.";

        default:
            return "Never asks. A path outside the chat's folders is still asked about.";
    }
}

/** Under Agent's Choice and Semi Auto on an ACP agent. */
export const ACP_LEVEL_NOTE =
    "The agent may still do some things without asking. That depends on its own settings on this machine.";

/** Whether a level is one this kind of runtime offers. */
export function levelFits(level: PermissionLevel, acp: boolean): boolean {

    return (acp ? ACP_LEVELS : SDK_LEVELS).includes(level);
}

/**
 * A level for this kind of runtime. A level saved for the other kind is
 * changed to its twin - Manual and Agent's Choice are the asking-most level
 * on each side - so nothing is lost when a provider id changes kind.
 */
export function levelFor(level: PermissionLevel | undefined, acp: boolean): PermissionLevel {

    if (!level)
        return DEFAULT_LEVEL;

    if (levelFits(level, acp))
        return level;

    return level === "manual" ? "agent" : level === "agent" ? "manual" : level;
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {

    return value === "manual" || value === "agent" || value === "semi" || value === "auto";
}

/** What a saved answer covers. */
export type AnswerKind = "command" | "edit" | "read" | "mcp" | "web" | "tool";

/** The chip on a saved answer's row. */
export const KIND_NAMES: Readonly<Record<AnswerKind, string>> = {
    command: "Command",
    edit: "Edits",
    read: "Reads",
    mcp: "MCP tool",
    web: "Web",
    tool: "Tool"
};

/** How long a saved answer holds. */
export type AnswerScope = "session" | "folder" | "always";

export const SCOPE_NAMES: Readonly<Record<AnswerScope, string>> = {
    session: "this session",
    folder: "this folder",
    always: "always"
};

/** One way the card offers to remember an answer. */
export interface RememberChoice {

    /** What is saved - matched against later calls. */
    pattern: string;

    /** What the card shows, when it differs from the pattern (a path shown relative to the folder). */
    shown?: string;

    /** A few words at the right: "only this exact command", "suggested". */
    hint?: string;
}

/** One folder the outside-folder card offers to add. */
export interface FolderChoice {

    path: string;

    hint: string;
}

/**
 * The card for one call our check asks about. Built by the engine, drawn
 * by the page; the page sends back {@link answerText}.
 */
export interface PermissionCard {

    /**
     * What is asked: decides the words and what is offered.
     * `chained` is a command of several parts, asked whole and exact.
     * `once` can only be allowed once or denied.
     * `outside` names a path outside the chat's folders.
     */
    type: "command" | "chained" | "edit" | "read" | "mcp" | "web" | "tool" | "once" | "outside";

    /** The heading: "copilot wants to run a command". */
    title: string;

    /** At the right of the heading: the level's name, or "asked in every mode". */
    level: string;

    /** The command, file, tool or address. */
    shown: string;

    /** The text exactly as the agent sent it, when cleaning changed it. */
    sentAs?: string;

    /** The folder the session works in, for a command - "in C:\work\repo". */
    where?: string;

    /** Short lines under it, in order. */
    lines?: string[];

    /** The ways to remember a yes. Empty or absent: only the exact text, or nothing. */
    remember?: RememberChoice[];

    /** Which of {@link remember} is picked to start with. */
    pick?: number;

    /** What a yes may be saved for, besides once. Empty: Allow once and Deny only. */
    scopes: AnswerScope[];

    /** The kind a saved answer gets. */
    kind?: AnswerKind;

    /** ACP: the agent cannot be told a reason. */
    noReason?: boolean;

    /** For `outside`: the path, the chat's folders now, and the folders it may add. */
    outside?: { path: string; chatFolders: string[]; folders: FolderChoice[] };
}

/** What the person picked on a card. */
export type CardAnswer =
    | { choice: "once" }
    | { choice: AnswerScope; pattern: string }
    | { choice: "deny"; reason?: string }
    | { choice: "addFolder"; folder: string };

/** The words each answer starts with, in the log and on the wire. */
export const ANSWER_WORDS = {
    once: "Allow once",
    session: "This session",
    folder: "This folder",
    always: "Always",
    deny: "Deny",
    addFolder: "Add folder"
} as const;

/**
 * An answer as one line: what the log shows and what the engine reads
 * back - "This session: npm run build *", "Deny: use the other file".
 */
export function answerText(answer: CardAnswer): string {

    switch (answer.choice) {

        case "once":
            return ANSWER_WORDS.once;

        case "deny":
            return answer.reason?.trim() ? `${ANSWER_WORDS.deny}: ${answer.reason.trim()}` : ANSWER_WORDS.deny;

        case "addFolder":
            return `${ANSWER_WORDS.addFolder}: ${answer.folder}`;

        default:
            return `${ANSWER_WORDS[answer.choice]}: ${answer.pattern}`;
    }
}

/**
 * The answer a line names. Anything that is not one of the answers is
 * read as Deny with the line as the reason: typed words never allow.
 * An empty line is a plain Deny.
 */
export function readAnswer(text: string): CardAnswer {

    const line = text.trim();

    if (line === ANSWER_WORDS.once)
        return { choice: "once" };

    if (line === ANSWER_WORDS.deny)
        return { choice: "deny" };

    const after = (word: string): string | undefined =>
        line.startsWith(`${word}: `) ? line.slice(word.length + 2).trim() : undefined;

    const reason = after(ANSWER_WORDS.deny);

    if (reason !== undefined)
        return reason ? { choice: "deny", reason } : { choice: "deny" };

    const folder = after(ANSWER_WORDS.addFolder);

    if (folder)
        return { choice: "addFolder", folder };

    for (const scope of ["session", "folder", "always"] as const) {

        const pattern = after(ANSWER_WORDS[scope]);

        if (pattern)
            return { choice: scope, pattern };
    }

    return line ? { choice: "deny", reason: line } : { choice: "deny" };
}

/** A saved answer, as the list shows it. */
export interface SavedAnswer {

    /** Unique within the file. */
    id: string;

    kind: AnswerKind;

    pattern: string;

    scope: AnswerScope;

    /** For `session`: the chat's id. */
    chatId?: string;

    /** For `folder`: the folder, absolute. */
    folder?: string;

    /** Epoch milliseconds. */
    savedAt: number;

    /** Which agent asked - a provider id. */
    agent: string;
}

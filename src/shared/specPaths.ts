/*
 * `>spec` in a session's message box: the specs of
 * the session's workspace, typed one level at a time like a connector's
 * path.
 *
 *   >spec>new <text>            New spec, with the text in its ask box
 *   >spec>NAME>design           that document goes to the agent with the message
 *   >spec>NAME>all              every written document of the spec does
 *   >spec>NAME>open             an action - see SPEC_ACTIONS
 *
 * A document path is sent with the message, like any other `>` path. An
 * action is never sent: it runs when it is the whole message and Enter
 * is pressed, and the agent hears nothing of it.
 *
 * Shared by the server, which lists the rows and runs the actions, and
 * the page, which tells an action from a message before it is sent.
 */

/** The first level, as typed. */
export const SPEC_PATH = "spec";

/** Under `>spec`: opens New spec. No spec can have this name's place - it is checked first. */
export const SPEC_NEW = "new";

/** Under a spec: every written document of it. */
export const SPEC_ALL = "all";

/** What each action does, by the word typed - the list's own text. */
export const SPEC_ACTIONS = {
    open: "Open the spec as a tab beside this chat",
    resume: "Go to the spec's newest phase chat, where the work stopped",
    next: "Start the next phase in a new chat",
    plan: "Open the plan, where the implementation starts wave by wave",
    notes: "Put the document's open review notes in the message box",
    changes: "Open the document the last turn changed",
    stop: "Stop the phase or wave that runs now",
    watch: "Tie this chat to the spec: a line over the chat links to it"
} as const;

export type SpecAction = keyof typeof SPEC_ACTIONS;

export function isSpecAction(word: string): word is SpecAction {

    return Object.prototype.hasOwnProperty.call(SPEC_ACTIONS, word);
}

/** A message that is nothing but a `>spec` command. */
export type SpecCommand =
    | { kind: "new"; text: string }
    | { kind: "action"; spec: string; action: SpecAction };

/**
 * The command a whole message is. Nothing: the message is not one, and
 * is sent as typed - a document path among them.
 */
export function specCommand(message: string): SpecCommand | undefined {

    const typed = message.trim();

    const made = /^>spec>new(?:\s+([\s\S]*))?$/i.exec(typed);

    if (made)
        return { kind: "new", text: (made[1] ?? "").trim() };

    const action = /^>spec>([^>\s]+)>([a-z]+)>?$/i.exec(typed);
    const word = action?.[2]!.toLowerCase();

    return action && word && isSpecAction(word) ? { kind: "action", spec: action[1]!, action: word } : undefined;
}

/**
 * The specs a message names with a `>spec>NAME>...` path, each once, in
 * the order written - the chat is tied to the last one, so its steps
 * show over the thread.
 */
export function specsNamed(message: string): string[] {

    const found: string[] = [];
    const token = /(?:^|\s)>spec>([^>\s]+)>[^>\s]/gi;

    let match: RegExpExecArray | null;

    while ((match = token.exec(message)))
        if (match[1]!.toLowerCase() !== SPEC_NEW && !found.includes(match[1]!))
            found.push(match[1]!);

    return found;
}

/**
 * `API.sddCommand`'s answer: what the page does after an action ran on
 * the server. Every answer names the spec and, when it is not in the
 * workspace's main folder, its folder - the page ties the chat to it.
 */
export interface SpecCommandAnswer {

    spec: string;

    folder?: string;

    /** Open the spec as a tab beside the chat - at `phase` when given. */
    open?: { phase?: string };

    /** Go to this chat, with the spec as a tab beside it. */
    chatId?: string;

    /** Put this in the message box. */
    text?: string;

    /** Say this to the person. */
    note?: string;
}

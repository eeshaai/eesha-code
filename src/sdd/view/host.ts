/*
 * The SDD view's line to the page that shows it.
 *
 * The view does not pick its own line. The page sets it once at start,
 * before the view is drawn: src/web/SddEditor.tsx passes its line to the
 * Eesha Code server (src/web/sddLine.ts).
 *
 * Using the view before a line is set is a mistake in the page's start
 * code, so it throws and says so.
 */

/** What the view needs from its page: send a message, and keep a little page state. */
export interface SddHost {

    postMessage(message: unknown): void;

    /** The page's own state, kept across a reload or a hide and rebuild. */
    getState(): unknown;

    setState(state: unknown): void;
}

let line: SddHost | undefined;

/** Sets the view's line. Called once by the page at start. */
export function setSddHost(next: SddHost): void {

    line = next;
}

function current(): SddHost {

    if (!line)
        throw new Error("The SDD view has no line to its page: call setSddHost before drawing it.");

    return line;
}

/** The view's line. Each call goes to the line set with setSddHost. */
export const host: SddHost = {
    postMessage: message => current().postMessage(message),
    getState: () => current().getState(),
    setState: state => current().setState(state)
};

/**
 * What the spec says to the view. Not the window's "message" events: the
 * spec is a tab beside a session, and the session's chat view listens
 * to those.
 */
const said = new EventTarget();

/** Hands the view one message from the spec. */
export function toSddView(message: unknown): void {

    said.dispatchEvent(new MessageEvent("message", { data: message }));
}

/** Listens to what the spec says. Returns the stop. */
export function onSddMessage(take: (event: MessageEvent) => void): () => void {

    const listener = (event: Event) => take(event as MessageEvent);

    said.addEventListener("message", listener);

    return () => said.removeEventListener("message", listener);
}

/** A phase, or one session of it, the page asks the view to show - from the Spec explorer. */
export interface SddFocus {

    phase?: string;

    /** A session's owner: a phase id, or an implementation chat - `implement@wave:2`. */
    ownerId?: string;

    /** Which of its sessions. Absent: the one still open. */
    iteration?: number;
}

let focusTo: ((focus: SddFocus) => void) | undefined;

/** Asked before the view was drawn - handed over when it is. */
let focusWaiting: SddFocus | undefined;

/** Shows a phase or a session in the view - now, or as soon as it is drawn. */
export function focusSdd(focus: SddFocus): void {

    if (focusTo)
        focusTo(focus);
    else
        focusWaiting = focus;
}

/** The view takes what `focusSdd` asks. Answers the way to stop. */
export function onSddFocus(take: (focus: SddFocus) => void): () => void {

    focusTo = take;

    if (focusWaiting) {

        const waiting = focusWaiting;

        focusWaiting = undefined;
        take(waiting);
    }

    return () => {

        if (focusTo === take)
            focusTo = undefined;
    };
}

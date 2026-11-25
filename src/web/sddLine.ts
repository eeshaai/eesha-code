import { API } from "../server/protocol";
import { toSddView } from "../sdd/view/host";
import { bridge } from "./bridge";

/*
 * The SDD editor's line to the server.
 *
 * The SDD editor is the spec tab (src/sdd/view/SddSpecView.tsx and
 * SddRunView.tsx); it talks to the server only through the line set
 * with setSddHost (src/sdd/view/host.ts); SddEditor.tsx sets this
 * file's `sddLine` as that line. What it posts goes to the spec this
 * tab shows; what the spec says comes on the page's event stream as
 * `eesha.sdd` and is handed to it with `toSddView`.
 *
 * Several spec tabs can be open, but only the one in front is drawn,
 * and only it is open on the server: `show` moves the line to it.
 */

/** A spec as a tab names it: the workspace's key, the spec, and its folder when that is not the main one. */
export interface SpecShown {
    workspace: string;
    spec: string;
    folder?: string;
}

/**
 * What the editor sent did not reach the spec. Said on the page, never
 * dropped. A typed message is also told `unsent`, as the server tells it
 * when the agent never got it, so its text goes back into the compose box.
 */
export function notSent(message: unknown, why: string): void {

    bridge.note(`Not sent - ${why}`);

    const sent = message as { type?: unknown; stageId?: unknown } | null;

    if (sent?.type === "sendMessage" && typeof sent.stageId === "string")
        toSddView({ type: "unsent", stageId: sent.stageId });
}

/**
 * Where a spec's page state is kept: by its workspace, name and folder,
 * not by an address's text. The folder only when it is not the main
 * one, so a main-folder spec keeps the key it always had.
 */
export function stateKey(spec: SpecShown): string {

    return `eesha.sdd.state:${JSON.stringify([spec.workspace, spec.spec, ...(spec.folder ? [spec.folder] : [])])}`;
}

/** What the spec tab in front is told by its line. */
export interface SpecTold {

    /** The spec could not be opened, and why. */
    problem(text: string): void;

    /** Another browser tab opened the spec: it shows there now, not here. */
    moved(): void;
}

function same(one: SpecShown | undefined, other: { workspace: string; spec: string; folder?: string }): boolean {

    return one !== undefined && one.workspace === other.workspace && one.spec === other.spec && (one.folder ?? "") === (other.folder ?? "");
}

class SpecLine {

    /** The spec the tab in front shows. Nothing: no spec tab in front. */
    private shown: SpecShown | undefined;

    /** What the spec tab in front is told: why its spec could not be opened, or that another browser tab took it. */
    private told: SpecTold = { problem: () => undefined, moved: () => undefined };

    /** The server shows this tab's spec - what the editor sends can go. */
    private open = false;

    /** What the editor sent before that. */
    private waiting: unknown[] = [];

    /** One at a time, so the spec reads them in the order sent. */
    private sending: Promise<unknown> = Promise.resolve();

    /** Each spec's page state, as read from storage or last set. */
    private states = new Map<string, unknown>();

    private hellos = 0;

    /** Counts the opens asked, so an answer to an older one is dropped. */
    private asked = 0;

    /**
     * A phase just started in a chat of the spec in front - the page goes
     * to it. With `text`: the Doc tab's notes, for that chat's message box.
     */
    private toPhaseChat: (chatId: string, spec: SpecShown, text?: string) => void = () => undefined;

    constructor() {

        bridge.onPage(message => {

            if (message.type === "eesha.specMoved") {

                if (same(this.shown, message)) {

                    this.open = false;
                    this.told.moved();
                }

                return;
            }

            if (message.type === "eesha.sdd") {

                // Said by a spec this tab showed before: dropped.
                if (!same(this.shown, message))
                    return;

                const said = message.message as { type?: unknown; chatId?: unknown; text?: unknown } | null;

                if (said?.type === "phaseChat" && typeof said.chatId === "string" && this.shown)
                    this.toPhaseChat(said.chatId, this.shown, typeof said.text === "string" ? said.text : undefined);

                return toSddView(message.message);
            }

            if (message.type !== "eesha.hello")
                return;

            // The stream came back - the server may have restarted. With a
            // spec shown, the page loads again: the address keeps the
            // spec tab, and the editor starts over from what the server has.
            if (this.hellos++ > 0 && this.shown)
                return location.reload();

            if (this.shown)
                this.request();
        });
    }

    /**
     * The spec tab in front shows `spec` from now on - opened on the
     * server once the event stream has said hello. Nothing: no spec tab
     * is in front, and what the last spec says is dropped.
     */
    show(spec: SpecShown | undefined, told?: SpecTold): void {

        this.shown = spec;
        this.told = told ?? { problem: () => undefined, moved: () => undefined };
        this.open = false;
        this.waiting = [];
        this.asked++;

        if (spec && this.hellos > 0)
            this.request();
    }

    /**
     * After a move with no page load: the page starts over on a new
     * stream, so its first hello is a first one again - not the stream
     * coming back - and no spec is shown until the new page shows one.
     */
    restart(): void {

        this.shown = undefined;
        this.told = { problem: () => undefined, moved: () => undefined };
        this.open = false;
        this.waiting = [];
        this.hellos = 0;
        this.asked++;
    }

    /** Where the page goes when a phase of the spec in front starts in a chat, or its notes go to one. */
    onPhaseChat(go: (chatId: string, spec: SpecShown, text?: string) => void): void {

        this.toPhaseChat = go;
    }

    private request(): void {

        const spec = this.shown;

        if (!spec)
            return;

        const asked = ++this.asked;

        void bridge.request(API.sddOpen, { view: bridge.view, workspace: spec.workspace, spec: spec.spec, ...(spec.folder ? { folder: spec.folder } : {}) })
            .then(answer => {

                if (asked !== this.asked)
                    return;

                if (answer.problem)
                    return this.told.problem(answer.problem);

                this.open = true;

                const waiting = this.waiting;

                this.waiting = [];

                for (const one of waiting)
                    this.post(one);
            })
            .catch((error: Error) => { if (asked === this.asked) this.told.problem(`Could not reach the server: ${error.message}`); });
    }

    post(message: unknown): void {

        if (!this.shown)
            return notSent(message, "No spec is open in this tab.");

        if (!this.open) {

            this.waiting.push(message);

            return;
        }

        this.sending = this.sending
            .then(() => bridge.request(API.sdd, { view: bridge.view, message }))
            .then(
                answer => { if (answer.problem) notSent(message, answer.problem); },
                (error: Error) => notSent(message, `Could not reach the server: ${error.message}`));
    }

    /**
     * The editor's page state for the spec in front. Kept in this browser
     * tab's session storage under the spec, so it lives through a reload -
     * the one a returning event stream makes too - and goes when the tab
     * closes. The editor keeps the compose boxes' unsent text in it.
     */
    getState(): unknown {

        if (!this.shown)
            return undefined;

        const key = stateKey(this.shown);

        if (this.states.has(key))
            return this.states.get(key);

        let state: unknown;

        try {

            const text = sessionStorage.getItem(key);

            state = text ? JSON.parse(text) : undefined;

        } catch {

            // No storage, or what it held is not JSON: start empty.
        }

        this.states.set(key, state);

        return state;
    }

    setState(state: unknown): void {

        if (!this.shown)
            return;

        const key = stateKey(this.shown);

        this.states.set(key, state);

        try {

            sessionStorage.setItem(key, JSON.stringify(state));

        } catch {

            // Storage full or blocked: kept for this page load only.
        }
    }
}

export const specLine = new SpecLine();

/** The SDD editor's line to this server. */
export const sddLine = {
    postMessage: (message: unknown) => specLine.post(message),
    getState: () => specLine.getState(),
    setState: (state: unknown) => specLine.setState(state)
};

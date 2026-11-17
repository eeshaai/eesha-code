import { API, ToPage } from "../server/protocol";
import { askNoticeLeave } from "./notices";
import { chatAddress, chatInAddress, pageInAddress } from "./pageRoute";

/*
 * The page's line to the server.
 *
 * The chat view sends to the server with `serverApi()` and listens to
 * window "message" events (src/view/hostApi.ts, ChatPane.tsx).
 * This file supplies both: `serverApi()` sends what the page posts to
 * the server, and the server's event stream is handed to the chat view
 * as window "message" events.
 *
 * Import this file first - before anything that imports the chat view.
 */

type PageListener = (message: ToPage) => void;

/**
 * The chat switched by itself - the chat on screen was deleted, and a new
 * one took its place. The chat view has already redrawn itself.
 */
type ChatListener = (chatId: string | undefined) => void;

/** The address is a Settings one: it names no chat, so the chat shown stays. */
function onSettings(): boolean {

    return pageInAddress() !== undefined;
}

/**
 * This page's own id - new on every load. Not kept in sessionStorage: a
 * duplicated tab copies that, and two pages with one id would keep
 * taking the chat from each other.
 */
function tabId(): string {

    return (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^A-Za-z0-9-]/g, "");
}

class Bridge {

    readonly view = tabId();

    /** The chat this tab shows - the one the address names. */
    private shown = chatInAddress();

    private source?: EventSource;

    /** The server said hello on the stream that is open now. */
    private open = false;

    private hellos = 0;

    /** What the chat view sent before the stream was open. */
    private waiting: unknown[] = [];

    /** Chat messages go one at a time, so the server reads them in the order they were sent. */
    private sending: Promise<unknown> = Promise.resolve();

    private readonly listeners = new Set<PageListener>();

    private readonly chatListeners = new Set<ChatListener>();

    private state: unknown;

    get chatId(): string | undefined {

        return this.shown;
    }

    /** Called when this tab shows another chat. */
    onChat(listener: ChatListener): () => void {

        this.chatListeners.add(listener);

        return () => this.chatListeners.delete(listener);
    }

    /**
     * Shows another chat: a real page load at its address. The chat left keeps running on the server - a turn in it
     * carries on.
     */
    switchTo(chatId: string | undefined): void {

        location.assign(chatAddress(chatId));
    }

    connect(): void {

        const query = new URLSearchParams({ view: this.view });

        if (this.shown)
            query.set("chat", this.shown);

        const source = new EventSource(`/events?${query}`);

        this.source = source;

        source.onmessage = event => {

            let message: { type?: unknown };

            try {

                message = JSON.parse(event.data);

            } catch {

                return;
            }

            this.receive(message);
        };

        // The browser reconnects by itself. Until it does, nothing is sent.
        // A refusal (not signed in) is not retried by the browser.
        source.onerror = () => {

            if (source.readyState === EventSource.CLOSED)
                this.emit({ type: "eesha.note", text: "The server refused this page. Open the link `eesha status` prints." });
            else if (this.open)
                this.emit({ type: "eesha.note", text: "Lost the server - trying again. Is it still running? (eesha status)" });

            this.open = false;
        };
    }

    /** A short notice on this page, as if the server had sent it. */
    note(text: string): void {

        this.emit({ type: "eesha.note", text });
    }

    /** For the page's own parts: notes, questions, the diff. */
    onPage(listener: PageListener): () => void {

        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    /** A message from the chat view, for the chat on the server. */
    toChat(message: unknown): void {

        if (!this.open) {

            this.waiting.push(message);

            return;
        }

        this.sending = this.sending
            .then(() => this.request(API.chat, { view: this.view, message }))
            .catch(() => undefined);
    }

    /** One request to the server. Its JSON answer; a `problem` answer is returned, not thrown. */
    async request<T = Record<string, unknown>>(route: string, body: Record<string, unknown>): Promise<T & { problem?: string }> {

        const response = await fetch(route, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            credentials: "same-origin"
        });

        const text = await response.text();

        try {

            return JSON.parse(text);

        } catch {

            return { problem: text.trim() || `The server answered ${response.status}.` } as T & { problem?: string };
        }
    }

    /** As the chat view's draw: a message from the server. */
    toView(message: unknown): void {

        window.dispatchEvent(new MessageEvent("message", { data: message }));
    }

    getState(): unknown {

        return this.state;
    }

    /**
     * The chat view saves the chat id it shows - kept in the address, so
     * a reload opens the same chat. It differs from the one shown when
     * the chat switched by itself (the chat on screen was deleted, and a
     * new one took its place).
     */
    setState(state: unknown): void {

        this.state = state;

        const chatId = (state as { chatId?: unknown } | undefined)?.chatId;

        if (typeof chatId !== "string" || chatId === this.shown)
            return;

        this.shown = chatId;

        // A Settings address stays as it is, with no chat in it.
        if (!onSettings())
            history.replaceState(null, "", chatAddress(chatId));

        for (const listener of this.chatListeners)
            listener(chatId);
    }

    private receive(message: { type?: unknown }): void {

        if (message.type === "eesha.hello") {

            const again = this.hellos++ > 0;

            this.open = true;

            // Back after the stream dropped: the server may have
            // restarted, so the thread is drawn again from the start.
            if (again && (message as { chat?: unknown }).chat) {

                this.toView({ type: "clearLog" });
                this.toChat({ type: "ready" });
            }

            const waiting = this.waiting;

            this.waiting = [];

            for (const one of waiting)
                this.toChat(one);
        }

        if (typeof message.type === "string" && message.type.startsWith("eesha."))
            return this.emit(message as ToPage);

        this.toView(message);
    }

    private emit(message: ToPage): void {

        for (const listener of this.listeners)
            listener(message);
    }
}

export const bridge = new Bridge();

declare global {
    interface Window {
        serverApi(): {
            postMessage(message: unknown): void;
            getState(): unknown;
            setState(state: unknown): void;
        };
    }
}

window.serverApi = () => ({
    postMessage: message => {

        // The first message sent is when the browser asks for leave to
        // show notices - see notices.ts.
        if ((message as { type?: unknown } | undefined)?.type === "send")
            askNoticeLeave();

        bridge.toChat(message);
    },
    getState: () => bridge.getState(),
    setState: state => bridge.setState(state)
});

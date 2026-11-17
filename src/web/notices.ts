import type { ToPage } from "../server/protocol";

/*
 * The notice when a turn ends or the agent asks something: every time, even while the chat is in front; a desktop
 * notification through the browser, plus a mark in the tab's title until the
 * page is used again.
 *
 * The browser asks for leave to show notices the first time a message is
 * sent - a moment the person is at the page, which some browsers insist
 * on. Refused, or not asked yet, only the title is marked.
 */

export type NotifyMessage = Extract<ToPage, { type: "eesha.notify" }>;

/** The longest question the notice shows; the rest is in the chat. */
const MAX_BODY = 180;

/** The notice's heading and text, and the word the tab's title gets. */
export function noticeText(message: NotifyMessage): { heading: string; body: string; mark: string } {

    const { notice, title } = message;

    if (notice.kind === "asked") {

        const text = notice.text.replace(/\s+/g, " ").trim();

        return {
            heading: `Question: ${title}`,
            body: !text
                ? "The agent is waiting for your answer."
                : text.length > MAX_BODY ? `${text.slice(0, MAX_BODY - 1)}…` : text,
            mark: "Question"
        };
    }

    return notice.outcome === "done"
        ? { heading: `Done: ${title}`, body: "The agent finished its turn.", mark: "Done" }
        : { heading: `Failed: ${title}`, body: "The turn did not finish. The session says why.", mark: "Failed" };
}

/** The tab's title: the session's name, with the mark in front while there is one. */
export function pageTitle(chatTitle: string | undefined, mark: string | undefined): string {

    const base = chatTitle ? `${chatTitle} - Eesha Code` : "Eesha Code";

    return mark ? `(${mark}) ${base}` : base;
}

/** Asks the browser for leave to show notices, once - when it has not been asked yet. */
export function askNoticeLeave(): void {

    try {

        if ("Notification" in window && Notification.permission === "default")
            void Notification.requestPermission().catch(() => undefined);

    } catch {

        // A browser without notices: the title mark is all there is.
    }
}

/**
 * Shows the desktop notification, when the browser was given leave. One tag per
 * session: a newer notice replaces the session's last one, and two tabs told of
 * one session show it once. A click brings this tab forward and runs `open`.
 */
export function showNotice(message: NotifyMessage, open: () => void): void {

    try {

        if (!("Notification" in window) || Notification.permission !== "granted")
            return;

        const { heading, body } = noticeText(message);

        const shown = new Notification(heading, { body, tag: `eesha-${message.chatId}` });

        shown.onclick = () => {

            window.focus();
            open();
            shown.close();
        };

    } catch {

        // Some browsers refuse `new Notification` in a page; the title mark stays.
    }
}

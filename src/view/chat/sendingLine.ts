import type { LogLine } from "../../core/models/run";
import { withLine } from "../templates/logEntry";

/*
 * The message drawn as "Sending…" the moment it is sent. The server logs
 * the real line only once the message has gone, which on a new turn is
 * after the session has started - seconds with nothing on screen
 * otherwise. The real line takes its place, or the server's `unsent`
 * message turns it into "Not sent".
 */

/** The line the view draws for a message it just sent. */
export function sendingLine(text: string): LogLine {

    return { ownerId: "chat", text: `${text}\n`, stream: "stdout", at: Date.now(), kind: "prompt", pending: "sending" };
}

/**
 * Which line still drawn as "Sending…" a message is: the oldest with
 * the same text, else the oldest of them.
 */
function sendingLineOf(lines: readonly LogLine[], text: string): number {

    const sent = text.trim();
    const matched = lines.findIndex(one => one.pending === "sending" && one.text.trim() === sent);

    return matched >= 0 ? matched : lines.findIndex(one => one.pending === "sending");
}

/**
 * One more line from the host. A real prompt line takes the place of its
 * "Sending…" line. It goes where the host put it, after anything logged
 * in between, so the thread matches the chat's saved file. `withLine`
 * for the rest: a streaming delta replaces the live line rather than
 * stacking copies.
 */
export function withHostLine(lines: readonly LogLine[], line: LogLine): LogLine[] {

    let next = [...lines];

    if (line.kind === "prompt" && !line.pending) {

        const index = sendingLineOf(next, line.text);

        if (index >= 0)
            next = [...next.slice(0, index), ...next.slice(index + 1)];
    }

    return withLine(next, line);
}

/** The "Sending…" line for `text`, now "Not sent" - the host's `unsent` message. */
export function markUnsent(lines: readonly LogLine[], text: string): LogLine[] {

    const index = sendingLineOf(lines, text);

    if (index < 0)
        return [...lines];

    const next = [...lines];

    next[index] = { ...next[index], pending: "failed" };

    return next;
}

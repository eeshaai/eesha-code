import { createHash } from "crypto";

/**
 * Which attachments a continued conversation still needs.
 *
 * A revise carries on the phase's conversation, and everything attached
 * on an earlier turn is already in its history. Sending the grammar, the
 * instructions and every earlier document again stacks another copy of each
 * into the context, and every later call pays for all of them. So a
 * file goes again only when its content changed since this conversation
 * last saw it - the document being revised (the agent wrote it, a person
 * may have edited it), or an earlier document that moved.
 *
 * Kept by session id, in memory only. After a restart nothing is known,
 * so everything is sent - the safe side.
 */

type Attachment = { name: string; path: string };

const seen = new Map<string, Map<string, string>>();

/** A file's content as a short fingerprint, or `undefined` when it cannot be read. */
export type Fingerprint = (path: string) => string | undefined;

export function sha1Of(read: (path: string) => Buffer): Fingerprint {

    return path => {

        try {

            return createHash("sha1").update(read(path)).digest("hex");

        } catch {

            return undefined;
        }
    };
}

/**
 * The attachments to send on a turn of `sessionId`. With no session,
 * or one this app has no record of, all of them.
 */
export function attachmentsToSend(
    sessionId: string | undefined,
    attachments: Attachment[],
    fingerprint: Fingerprint
): Attachment[] {

    const known = sessionId ? seen.get(sessionId) : undefined;

    if (!known)
        return attachments;

    return attachments.filter(one => {

        const now = fingerprint(one.path);

        // Unreadable now, or never sent: send it and let the agent say.
        return now === undefined || known.get(one.path) !== now;
    });
}

/** Records that `sessionId` now holds these files as they are on disk. */
export function recordSent(sessionId: string, attachments: Attachment[], fingerprint: Fingerprint): void {

    const known = seen.get(sessionId) ?? new Map<string, string>();

    for (const one of attachments) {

        const now = fingerprint(one.path);

        if (now !== undefined)
            known.set(one.path, now);
    }

    seen.set(sessionId, known);
}

/** For tests: forget every session. */
export function forgetAll(): void {

    seen.clear();
}

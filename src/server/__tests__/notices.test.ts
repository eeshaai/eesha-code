// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { noticeText, NotifyMessage, pageTitle } from "../../web/notices";

/*
 * What the system notice and the tab's title say when a turn ends or
 * the agent asks something. Showing the notice itself is the browser's
 * part, and is not tested here.
 */

function notify(notice: NotifyMessage["notice"]): NotifyMessage {

    return { type: "eesha.notify", chatId: "chat-1", title: "Fix the parser", notice };
}

describe("the notice's words", () => {

    it("says a turn is done, or failed, with the chat's name", () => {

        expect(noticeText(notify({ kind: "ended", outcome: "done" }))).toEqual({
            heading: "Done: Fix the parser", body: "The agent finished its turn.", mark: "Done"
        });

        expect(noticeText(notify({ kind: "ended", outcome: "failed" }))).toEqual({
            heading: "Failed: Fix the parser", body: "The turn did not finish. The session says why.", mark: "Failed"
        });
    });

    it("shows the question on one line, cut short when long", () => {

        expect(noticeText(notify({ kind: "asked", text: "Which store?\n\nSQLite or files?" }))).toEqual({
            heading: "Question: Fix the parser", body: "Which store? SQLite or files?", mark: "Question"
        });

        const long = noticeText(notify({ kind: "asked", text: "x".repeat(400) })).body;

        expect(long).toHaveLength(180);
        expect(long.endsWith("…")).toBe(true);
    });

    it("says the agent is waiting when the question has no text", () => {

        expect(noticeText(notify({ kind: "asked", text: "  " })).body).toBe("The agent is waiting for your answer.");
    });
});

describe("the tab's title", () => {

    it("puts the mark in front of the chat's name while there is one", () => {

        expect(pageTitle("Fix the parser", "Done")).toBe("(Done) Fix the parser - Eesha Code");
        expect(pageTitle("Fix the parser", undefined)).toBe("Fix the parser - Eesha Code");
        expect(pageTitle(undefined, undefined)).toBe("Eesha Code");
    });
});

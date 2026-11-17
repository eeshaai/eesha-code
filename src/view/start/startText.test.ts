import { describe, expect, it } from "vitest";

import { sessionsText, startAgo, startAgoText, waitingHeading } from "./startText";

describe("startText", () => {

    it("says how many sessions wait, with the right heading", () => {

        expect(waitingHeading(1)).toBe("1 SESSION IS WAITING FOR YOU");
        expect(waitingHeading(3)).toBe("3 SESSIONS ARE WAITING FOR YOU");
    });

    it("counts sessions in words", () => {

        expect(sessionsText(0)).toBe("no sessions yet");
        expect(sessionsText(1)).toBe("1 session");
        expect(sessionsText(4)).toBe("4 sessions");
    });

    it("says how long ago in short: now, 40m, 2h, 3d, then the date", () => {

        const now = Date.UTC(2026, 10, 13, 12, 0, 0);
        const minute = 60_000;

        expect(startAgo(now - 20_000, now)).toBe("now");
        expect(startAgo(now - 40 * minute, now)).toBe("40m");
        expect(startAgo(now - 125 * minute, now)).toBe("2h");
        expect(startAgo(now - 3 * 24 * 60 * minute, now)).toBe("3d");

        const old = now - 40 * 24 * 60 * minute;

        expect(startAgo(old, now)).toBe(new Date(old).toLocaleDateString(undefined, { day: "numeric", month: "short" }));

        expect(startAgoText(now - 20_000, now)).toBe("just now");
        expect(startAgoText(now - 2 * minute, now)).toBe("2m ago");
        expect(startAgoText(old, now)).toBe(startAgo(old, now));
    });
});

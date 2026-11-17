import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionConfig } from "../CopilotProvider";
import { TIME_NOW_TOOL_NAME, timeNow, UTC_NOW_TOOL_NAME, utcNow } from "../timeTools";

/**
 * Two clocks that answer from this process, so the agent never starts
 * a shell for the date. Both are checked against a fixed instant: the
 * UTC one is exact, the local one is read back through the same zone
 * the test runs in, whatever that is.
 */

const INSTANT = new Date("2026-09-11T14:32:05.000Z");

const clock = (): Date => INSTANT;

describe("utc_now", () => {

    it("is the instant in ISO 8601, ending in Z", () => {

        expect(utcNow(clock)).toBe("2026-09-11T14:32:05.000Z");
    });
});

describe("time_now", () => {

    /*
     * The local form depends on the machine's zone, so the assertion
     * reads the offset back rather than hard-coding one. The date and
     * time parts must agree with what `Date` itself reports locally.
     */
    it("is the same instant in local time, with the offset, zone and weekday", () => {

        const text = timeNow(clock);

        const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2}):(\d{2}) \((.+), (\w+)\)$/.exec(text);

        expect(match, text).not.toBeNull();

        const [, year, month, day, hour, minute, second, sign, offsetHours, offsetMinutes, zone, weekday] = match!;

        expect(Number(year)).toBe(INSTANT.getFullYear());
        expect(Number(month)).toBe(INSTANT.getMonth() + 1);
        expect(Number(day)).toBe(INSTANT.getDate());
        expect(Number(hour)).toBe(INSTANT.getHours());
        expect(Number(minute)).toBe(INSTANT.getMinutes());
        expect(Number(second)).toBe(INSTANT.getSeconds());

        // Minutes behind UTC, as `Date` reports it, against the printed offset.
        const printed = (sign === "-" ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes));

        expect(printed).toBe(-INSTANT.getTimezoneOffset());

        expect(zone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
        expect(weekday).toBe(INSTANT.toLocaleDateString("en-US", { weekday: "long" }));
    });

    it("pads every part, so a single-digit month or hour is two characters", () => {

        const early = (): Date => new Date(2026, 0, 5, 3, 4, 9);

        expect(timeNow(early)).toMatch(/^2026-01-05T03:04:09[+-]\d{2}:\d{2} \(/);
    });
});

interface CopilotTool {

    name: string;
    skipPermission?: boolean;
    defer?: string;
    parameters?: Record<string, unknown>;
    handler?: (args: unknown) => Promise<unknown>;
}

describe("the clock tools, as Copilot is given them", () => {

    beforeEach(() => {

        vi.useFakeTimers();
        vi.setSystemTime(INSTANT);
    });

    afterEach(() => {

        vi.useRealTimers();
    });

    function toolsOf(): CopilotTool[] {

        return (sessionConfig({ workingDirectory: "/work", env: {} }, undefined, undefined, undefined) as unknown as {
            tools: CopilotTool[];
        }).tools;
    }

    it("registers both, needing no approval and never deferred behind tool search", () => {

        for (const name of [TIME_NOW_TOOL_NAME, UTC_NOW_TOOL_NAME]) {

            const tool = toolsOf().find(one => one.name === name);

            expect(tool, name).toBeDefined();
            expect(tool!.skipPermission).toBe(true);
            expect(tool!.defer).toBe("never");
            expect(tool!.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
        }
    });

    it("answers from this process's clock", async () => {

        const tools = toolsOf();

        const utc = tools.find(one => one.name === UTC_NOW_TOOL_NAME)!;
        const local = tools.find(one => one.name === TIME_NOW_TOOL_NAME)!;

        expect(await utc.handler!({})).toBe("2026-09-11T14:32:05.000Z");
        expect(await local.handler!({})).toBe(timeNow(clock));
    });
});

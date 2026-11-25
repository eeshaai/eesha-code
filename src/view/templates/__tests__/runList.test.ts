import { describe, expect, it } from "vitest";

import { RunStatus } from "../../../core/models/run";
import { RunSummary } from "../../../shared/runMessages";
import { runDuration, runTitle } from "../runList";

/**
 * The runs landing's row rules.
 *
 * Timestamps are built from explicit local components rather than from
 * ISO strings, because every rule here compares *local* calendar days -
 * a UTC literal makes the same test pass in London and fail in Sydney.
 */

function at(year: number, month: number, day: number, hour: number, minute: number): number {

    return new Date(year, month - 1, day, hour, minute).getTime();
}

function run(over: Partial<RunSummary> = {}): RunSummary {

    return {
        id: "r1",
        status: RunStatus.Success,
        startedAt: at(2026, 8, 20, 14, 32),
        ...over
    };
}

describe("runTitle", () => {

    it("uses the run's own resolved label", () => {

        expect(runTitle(run({ label: "AB#48120" }), "release pipeline")).toBe("AB#48120");
    });

    it("falls back to the workflow's name when the file declared no label", () => {

        expect(runTitle(run(), "release pipeline")).toBe("release pipeline");
    });

    it("treats a blank label as none - a label that resolved to nothing names nothing", () => {

        expect(runTitle(run({ label: "   " }), "release pipeline")).toBe("release pipeline");
    });
});

describe("runDuration", () => {

    it("is nothing while the run is still going", () => {

        expect(runDuration(run({ finishedAt: undefined }))).toBeUndefined();
    });

    it("counts seconds under a minute", () => {

        const started = at(2026, 8, 20, 14, 32);

        expect(runDuration(run({ startedAt: started, finishedAt: started + 42_000 }))).toBe("42s");
    });

    it("counts minutes and seconds under an hour", () => {

        const started = at(2026, 8, 20, 14, 32);

        expect(runDuration(run({ startedAt: started, finishedAt: started + 72_000 }))).toBe("1m 12s");
    });

    it("counts hours and minutes beyond that", () => {

        const started = at(2026, 8, 20, 14, 32);

        expect(runDuration(run({ startedAt: started, finishedAt: started + 7_500_000 }))).toBe("2h 5m");
    });

    it("never goes negative - a clock that moved backwards is not a run that took minus time", () => {

        const started = at(2026, 8, 20, 14, 32);

        expect(runDuration(run({ startedAt: started, finishedAt: started - 5_000 }))).toBe("0s");
    });
});

import { describe, expect, it } from "vitest";

import { RunEvent, currentEvents, sessionRuns } from "../runEvents";

/**
 * The sessions pane's list: one entry per run of each phase or chat,
 * cut exactly where a re-run or New Session cuts the panel's own log.
 */

/** A line the plugin labelled - what makes a run worth listing. */
function said(ownerId: string, at: number, text = "hello"): RunEvent {

    return { ownerId, at, stream: "stdout", text, kind: "answer" };
}

describe("sessionRuns", () => {

    it("counts each fresh start of a phase as its own run, numbered from 1", () => {

        const runs = sessionRuns([
            { kind: "start", ownerId: "design", at: 1 },
            { kind: "session", ownerId: "design", at: 2, sessionId: "s1", provider: "claude" },
            said("design", 3),
            { kind: "end", ownerId: "design", at: 4, status: "success" },
            { kind: "restart", ownerId: "design", at: 5 },
            { kind: "start", ownerId: "design", at: 6, text: "  split story 2 into smaller ones  " },
            { kind: "session", ownerId: "design", at: 7, sessionId: "s2" },
            said("design", 8)
        ]);

        expect(runs.map(run => [run.iteration, run.sessionId, run.current])).toEqual([[1, "s1", false], [2, "s2", true]]);
        expect(runs[0]).toMatchObject({ at: 1, status: "success", provider: "claude" });
        expect(runs[1].note).toBe("split story 2 into smaller ones");
        expect(runs[1].lines.map(line => line.at)).toEqual([8]);
    });

    it("keeps a revise that carries the conversation on in the same run", () => {

        const runs = sessionRuns([
            { kind: "start", ownerId: "design", at: 1 },
            { kind: "session", ownerId: "design", at: 2, sessionId: "s1" },
            said("design", 3),
            { kind: "start", ownerId: "design", at: 4, text: "tighten it" },
            said("design", 5)
        ]);

        expect(runs).toHaveLength(1);
        expect(runs[0].lines).toHaveLength(2);
        expect(runs[0].note).toBe("tighten it");
    });

    it("leaves an owner with no current run once New Session cleared it", () => {

        const runs = sessionRuns([
            said("design", 1),
            { kind: "cleared", ownerId: "design", at: 2 }
        ]);

        expect(runs).toHaveLength(1);
        expect(runs[0].current).toBe(false);
    });

    it("skips a run holding only the panel's own notes", () => {

        const runs = sessionRuns([
            { ownerId: "design", at: 1, stream: "stdout", text: "Already working - design was not started.\n" },
            { kind: "restart", ownerId: "design", at: 2 },
            said("design", 3)
        ]);

        expect(runs.map(run => [run.iteration, run.at])).toEqual([[1, 3]]);
    });

    it("numbers owners apart and lists runs in the order they started", () => {

        const runs = sessionRuns([
            said("requirements", 1),
            said("implement@wave:1", 2),
            { kind: "restart", ownerId: "implement@wave:1", at: 3 },
            said("implement@wave:1", 4)
        ]);

        expect(runs.map(run => `${run.ownerId}#${run.iteration}`))
            .toEqual(["requirements#1", "implement@wave:1#1", "implement@wave:1#2"]);
    });

    it("holds the same lines as the panel's log for the current run", () => {

        const events: RunEvent[] = [
            said("design", 1, "old"),
            { kind: "restart", ownerId: "design", at: 2 },
            { kind: "start", ownerId: "design", at: 3 },
            said("design", 4, "new")
        ];

        const current = sessionRuns(events).find(run => run.current)!;

        expect(current.lines).toEqual(currentEvents(events).filter(event => event.kind === "answer"));
    });
});

import { describe, expect, it } from "vitest";

import { SpecStage } from "../../../shared/runMessages";
import { SessionRunSummary } from "../../../shared/sddMessages";
import { paneRuns, pickedRun, runDetail, runGroups, runOption, runTitle, shortTime, withNextRun } from "../sessionRuns";

/**
 * What the sessions pane lists, in what order, and what each row says.
 */

const stages: SpecStage[] = [
    { name: "requirements", label: "Requirements", artifact: "requirements.md" },
    { name: "stories", label: "User Stories", artifact: "stories.md" },
    { name: "implement", label: "Implement" }
];

function run(ownerId: string, iteration: number, at: number, extra: Partial<SessionRunSummary> = {}): SessionRunSummary {

    return { ownerId, iteration, at, current: false, ...extra };
}

describe("paneRuns", () => {

    it("lists by phase in pipeline order, newest first inside a phase", () => {

        const listed = paneRuns([
            run("stories", 1, 10),
            run("requirements", 1, 5),
            run("stories", 2, 20),
            run("implement@wave:1", 1, 30)
        ], stages);

        expect(listed.map(one => `${one.ownerId}#${one.iteration}`))
            .toEqual(["requirements#1", "stories#2", "stories#1", "implement@wave:1#1"]);
    });

    it("leaves out the execution phase's own name, whose chats are listed on their own", () => {

        expect(paneRuns([run("implement", 1, 1), run("implement@1.4", 1, 2)], stages).map(one => one.ownerId))
            .toEqual(["implement@1.4"]);
    });

    it("keeps a run whose phase the style does not have, at the end", () => {

        expect(paneRuns([run("extra-phase", 1, 1), run("requirements", 1, 2)], stages).map(one => one.ownerId))
            .toEqual(["requirements", "extra-phase"]);
    });
});

describe("runTitle", () => {

    it("reads '<phase> : #<run> : <details>'", () => {

        expect(runTitle(run("stories", 2, 0, { note: "split story 2\nmore text" }), stages))
            .toBe("User Stories : #2 : split story 2");
    });

    it("names a chat by its work", () => {

        expect(runTitle(run("implement@wave:2", 1, 0), stages)).toBe("Implement : #1 : Wave 2");
        expect(runTitle(run("implement@1.4", 3, 0), stages)).toBe("Implement : #3 : Task 1.4");
    });

    it("falls back to the phase id when the style gives no label", () => {

        expect(runTitle(run("design", 1, 0, { note: "x" }), stages)).toBe("design : #1 : x");
    });

    it("uses the start time when there is nothing else to say", () => {

        const at = new Date(2026, 8, 23, 9, 5).getTime();

        expect(runDetail(run("stories", 1, at))).toBe(shortTime(at));
        expect(shortTime(at)).toBe("Sep 23 09:05");
    });

    /* A chat is named by every task it was handed, when its record says which. */
    it("names every task an implementation chat was handed", () => {

        expect(runDetail(run("implement@wave:2", 1, 0), ["2.1", "2.2"])).toBe("Wave 2 · 2.1, 2.2");
        expect(runDetail(run("implement@1.1", 1, 0), ["1.1", "1.2", "2"])).toBe("Tasks 1.1, 1.2, 2");
        expect(runDetail(run("implement@1.4", 1, 0), ["1.4"])).toBe("Task 1.4");

        // No record: what the bucket says.
        expect(runDetail(run("implement@wave:2", 1, 0))).toBe("Wave 2");
    });

    it("cuts a long note", () => {

        const detail = runDetail(run("stories", 1, 0, { note: "a".repeat(100) }));

        expect(detail.length).toBe(60);
        expect(detail.endsWith("…")).toBe(true);
    });
});

describe("pickedRun", () => {

    const runs = [
        run("stories", 1, 10),
        run("stories", 2, 20, { current: true }),
        run("implement@wave:1", 1, 30),
        run("implement@wave:2", 1, 40, { current: true })
    ];

    it("finds the exact run a pick names", () => {

        expect(pickedRun(runs, { ownerId: "stories", iteration: 1 })?.at).toBe(10);
    });

    it("finds an owner's current run when the pick names only the owner", () => {

        expect(pickedRun(runs, { ownerId: "stories" })?.iteration).toBe(2);
    });

    it("finds the newest chat when the pick names the execution phase", () => {

        expect(pickedRun(runs, { ownerId: "implement" })?.ownerId).toBe("implement@wave:2");
    });

    it("finds nothing for nothing picked", () => {

        expect(pickedRun(runs, undefined)).toBeUndefined();
    });
});

/*
 * The row for the conversation that has not started yet.
 *
 * After New Session a phase has runs but none current, and its next
 * conversation is only an empty compose box. Without a row, opening an
 * earlier run would be a one-way trip - nothing to click back to.
 */
describe("withNextRun", () => {

    const none = () => undefined;

    it("adds a row for a phase whose runs were all cut, at the top of that phase", () => {

        const listed = paneRuns([run("requirements", 1, 1, { current: false })], stages);

        expect(withNextRun(listed, stages, none).map(one => [one.ownerId, one.iteration, one.current, one.note]))
            .toEqual([
                ["requirements", 2, true, "New session"],
                ["requirements", 1, false, undefined]
            ]);
    });

    /*
     * Marked, so the pane can keep it out of the dropdown: a session
     * nobody has said anything in yet is not one you pick from a list
     * of sessions. The dropdown reads empty while it is on screen.
     */
    it("marks the invented run pending, and leaves the real ones alone", () => {

        const listed = paneRuns([run("requirements", 1, 1, { current: false })], stages);

        expect(withNextRun(listed, stages, none).map(one => one.pending)).toEqual([true, undefined]);
    });

    it("adds nothing while a phase still has a current run", () => {

        const listed = paneRuns(
            [run("requirements", 1, 1), run("requirements", 2, 2, { current: true })], stages);

        expect(withNextRun(listed, stages, none)).toEqual(listed);
    });

    it("leaves other phases alone", () => {

        const listed = paneRuns(
            [run("requirements", 1, 1, { current: true }), run("stories", 1, 2)], stages);

        expect(withNextRun(listed, stages, none).map(one => `${one.ownerId}#${one.iteration}`))
            .toEqual(["requirements#1", "stories#2", "stories#1"]);
    });

    /* The execution phase's own name holds the panel's notes, not a thread. */
    it("adds nothing for a phase that has no conversation of its own", () => {

        const listed = [run("implement", 1, 1)];

        expect(withNextRun(listed, stages, none)).toEqual(listed);
    });

    /*
     * An implementation chat has no stage of its own, so the lines on
     * screen are the only sign it is real.
     */
    it("adds a row for an implementation chat only once it has lines", () => {

        const listed = [run("implement@1.1", 1, 5)];

        expect(withNextRun(listed, stages, none)).toEqual(listed);

        expect(withNextRun(listed, stages, owner => owner === "implement@1.1" ? 9 : undefined)
            .map(one => [one.ownerId, one.iteration, one.at]))
            .toEqual([["implement@1.1", 2, 9], ["implement@1.1", 1, 5]]);
    });

    /*
     * Dated from the run it follows, not from now: a phase nobody has
     * touched must not hold the newest thing in the spec and pull the
     * pane onto it.
     */
    it("dates the new row just after the run it follows when nothing has been said", () => {

        const listed = paneRuns([run("requirements", 1, 500)], stages);

        expect(withNextRun(listed, stages, none)[0].at).toBe(501);
    });
});

/*
 * The sessions dropdown.
 *
 * A spec runs to dozens of sessions, and a list of them would spend a
 * third of the pane to show six of twenty-two. The phase is the group's
 * label, so an option says only what differs.
 */
describe("the sessions dropdown", () => {

    it("groups consecutive runs by phase, in the order they were listed", () => {

        const listed = paneRuns([
            run("requirements", 1, 1),
            run("requirements", 2, 2),
            run("stories", 1, 3),
            run("implement@wave:0", 1, 4),
            run("implement@wave:1", 1, 5)
        ], stages);

        expect(runGroups(listed, stages).map(one => [one.label, one.runs.length]))
            .toEqual([["Requirements", 2], ["User Stories", 1], ["Implement", 2]]);
    });

    /* Every wave is its own owner but the same phase - one heading, not six. */
    it("puts every implementation chat under the one phase", () => {

        const listed = paneRuns(
            [run("implement@wave:0", 1, 1), run("implement@wave:1", 1, 2), run("implement@wave:2", 1, 3)], stages);

        expect(runGroups(listed, stages).map(one => one.label)).toEqual(["Implement"]);
    });

    it("falls back to the owner's own name for a phase the style does not have", () => {

        expect(runGroups([run("extra-phase", 1, 1)], stages).map(one => one.label)).toEqual(["extra-phase"]);
    });

    /* The phase is the group's; an option carries what differs. */
    it("leaves the phase out of an option", () => {

        expect(runOption(run("requirements", 2, 1, { note: "split story 2", current: true })))
            .toBe("#2 · split story 2");
    });

    /*
     * An earlier run says so on the option, not on a chip beside the
     * dropdown: a chip would only describe the run already on screen,
     * so you would learn a session was read only after picking it.
     */
    it("marks an earlier run read only, and a live one not at all", () => {

        expect(runOption(run("requirements", 1, 1, { note: "first try" })))
            .toBe("#1 · first try (Read Only)");

        expect(runOption(run("requirements", 2, 2, { note: "second", current: true })))
            .toBe("#2 · second");
    });

    it("says how a run ended as well as that it is read only", () => {

        expect(runOption(run("requirements", 1, 1, { note: "first try" }), "failed"))
            .toBe("#1 · first try · failed (Read Only)");
    });

    /* A native option cannot hold a coloured mark, so it says it. */
    it("says in words what the dot shows", () => {

        const one = run("requirements", 1, 1, { note: "first try", current: true });

        expect(runOption(one, "waiting")).toBe("#1 · first try · waiting for you");
        expect(runOption(one, "running")).toBe("#1 · first try · working");
        expect(runOption(one, "failed")).toBe("#1 · first try · failed");
        expect(runOption(one, undefined)).toBe("#1 · first try");
    });
});

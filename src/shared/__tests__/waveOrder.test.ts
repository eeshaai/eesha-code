import { describe, expect, it } from "vitest";
import { namesOf, needsOf, openBefore, stepsOf, tillHere, waitsFor, wavesAfter } from "../waveOrder";

const task = (id: string, wave?: number, done = false, optional = false) => ({ id, wave, done, optional });

describe("stepsOf", () => {

    it("orders waves by id, then every unwaved task alone in plan order", () => {

        const steps = stepsOf([task("9.9"), task("2.1", 5), task("1.1", 0), task("1.2", 0), task("9.8")]);

        expect(Object.fromEntries(steps)).toEqual({ "1.1": 0, "1.2": 0, "2.1": 1, "9.9": 2, "9.8": 3 });
    });
});

describe("openBefore", () => {

    const PLAN = [
        task("1.1", 0),
        task("1.2", 0),
        task("2.1", 1),
        task("3.1", 2),
        task("9.1")
    ];

    /* Item 10 must not start with nothing before it coded. */
    it("names every unticked task in an earlier wave", () => {

        expect(openBefore(PLAN, ["3.1"])).toEqual(["1.1", "1.2", "2.1"]);
    });

    it("lets the first wave start", () => {

        expect(openBefore(PLAN, ["1.2"])).toEqual([]);
    });

    it("does not hold a task back on another task of its own wave", () => {

        expect(openBefore([task("1.1", 0), task("1.2", 0)], ["1.2"])).toEqual([]);
    });

    it("lets a task start once everything before it is ticked", () => {

        const ticked = PLAN.map(one => ({ ...one, done: one.id !== "3.1" && one.id !== "9.1" }));

        expect(openBefore(ticked, ["3.1"])).toEqual([]);
    });

    it("does not count tasks handed over in the same press", () => {

        expect(openBefore(PLAN, ["1.1", "1.2", "2.1", "3.1"])).toEqual([]);
    });

    /* Handing wave 2 with part of wave 1 left out still leaves a gap. */
    it("names a task of an earlier wave left out of the press", () => {

        expect(openBefore(PLAN, ["1.1", "2.1"])).toEqual(["1.2"]);
    });

    it("does not count tasks already in a chat or queued ahead", () => {

        expect(openBefore(PLAN, ["2.1"], new Set(["1.1", "1.2"]))).toEqual([]);
    });

    it("puts an unwaved task after every waved one", () => {

        expect(openBefore(PLAN, ["9.1"])).toEqual(["1.1", "1.2", "2.1", "3.1"]);
    });

    it("orders unwaved tasks one at a time, in plan order", () => {

        expect(openBefore([task("1"), task("2"), task("3")], ["3"])).toEqual(["1", "2"]);
    });

    /* Optional means skippable - left unticked, it must not hold the plan forever. */
    it("does not hold anything back on an optional task", () => {

        expect(openBefore([task("1.1", 0, false, true), task("2.1", 1)], ["2.1"])).toEqual([]);
    });

    it("does not hold back a task the plan does not know", () => {

        expect(openBefore(PLAN, ["7.7"])).toEqual([]);
    });
});

describe("openBefore with branches", () => {

    // Wave 0 and wave 1 are two starting points; 2 follows 0, 3 follows
    // 1, and 4 joins them.
    const GRAPH = [
        { id: 0, after: [] },
        { id: 1, after: [] },
        { id: 2, after: [0] },
        { id: 3, after: [1] },
        { id: 4, after: [2, 3] }
    ];

    const PLAN = [
        task("1.1", 0),
        task("2.1", 1),
        task("3.1", 2),
        task("4.1", 3),
        task("5.1", 4),
        task("9.1")
    ];

    it("lets a second starting point start while the first is unticked", () => {

        expect(openBefore(PLAN, ["2.1"], new Set(), GRAPH)).toEqual([]);
    });

    it("holds a wave back only for its own branch", () => {

        expect(openBefore(PLAN, ["3.1"], new Set(), GRAPH)).toEqual(["1.1"]);
        expect(openBefore(PLAN, ["4.1"], new Set(), GRAPH)).toEqual(["2.1"]);
    });

    it("holds the wave that joins two branches back for both, all the way up", () => {

        expect(openBefore(PLAN, ["5.1"], new Set(), GRAPH)).toEqual(["1.1", "2.1", "3.1", "4.1"]);
    });

    it("still puts an unwaved task after every waved one", () => {

        expect(openBefore(PLAN, ["9.1"], new Set(), GRAPH)).toEqual(["1.1", "2.1", "3.1", "4.1", "5.1"]);
    });

    /* A plan with no `after` starts nothing earlier than the wave before allows. */
    it("reads a wave with no 'after' as waiting for the wave before it", () => {

        const graph = [{ id: 0 }, { id: 1 }, { id: 2 }];

        const plan = [task("1.1", 0), task("2.1", 1), task("3.1", 2)];

        expect(openBefore(plan, ["3.1"], new Set(), graph)).toEqual(["1.1", "2.1"]);
    });

    it("ignores an 'after' that names a later wave or one that is not there", () => {

        const graph = [{ id: 0, after: [] }, { id: 1, after: [5, 2] }, { id: 2, after: [] }];

        const plan = [task("1.1", 0), task("2.1", 1), task("3.1", 2)];

        expect(openBefore(plan, ["2.1"], new Set(), graph)).toEqual([]);
    });
});

describe("needsOf, waitsFor and wavesAfter", () => {

    const GRAPH = [{ id: 0, after: [] }, { id: 1, after: [] }, { id: 2, after: [0] }, { id: 3 }, { id: 4, after: [2, 3, 2] }];

    it("gives each wave what it waits for directly, the wave before it when it says nothing", () => {

        expect(Object.fromEntries(needsOf(GRAPH))).toEqual({ 0: [], 1: [], 2: [0], 3: [2], 4: [2, 3] });
    });

    it("follows the waits all the way up", () => {

        expect([...waitsFor(GRAPH).get(4)!].sort()).toEqual([0, 2, 3]);
        expect([...waitsFor(GRAPH).get(1)!]).toEqual([]);
    });

    it("lists the waves down a wave's branch", () => {

        expect(wavesAfter(GRAPH, 0)).toEqual([2, 3, 4]);
        expect(wavesAfter(GRAPH, 1)).toEqual([]);
    });
});

describe("tillHere", () => {

    // Two branches: 0 → 2 and 1 → 3, joined by 4.
    const GRAPH = [{ id: 0, after: [] }, { id: 1, after: [] }, { id: 2, after: [0] }, { id: 3, after: [1] }, { id: 4, after: [2, 3] }];

    const PLAN = [
        task("1.1", 0, true),
        task("1.2", 0),
        task("2.1", 1),
        task("3.1", 2),
        task("3.2", 2),
        task("3.3", 2, false, true),
        task("4.1", 3),
        task("5.1", 4),
        task("9.1")
    ];

    it("runs the open work of the waves a wave waits for, then the wave - and nothing on another branch or after it", () => {

        expect(tillHere(PLAN, GRAPH, 2)).toEqual({ tasks: ["1.2", "3.1", "3.2"], optional: ["3.3"] });
    });

    /* Code in one wave, the commit in the next beside tasks not wanted yet. */
    it("runs only the pressed task of its own wave", () => {

        expect(tillHere(PLAN, GRAPH, 2, "3.1")).toEqual({ tasks: ["1.2", "3.1"], optional: [] });
    });

    it("runs a pressed optional task, since it was asked for", () => {

        expect(tillHere(PLAN, GRAPH, 2, "3.3")).toEqual({ tasks: ["1.2", "3.3"], optional: [] });
    });

    it("follows the waits through every branch a joining wave needs", () => {

        expect(tillHere(PLAN, GRAPH, 4)).toEqual({ tasks: ["1.2", "2.1", "3.1", "3.2", "4.1", "5.1"], optional: ["3.3"] });
    });

    it("reads a plan with no 'after' as one wave after another", () => {

        const plan = [task("1.1", 0), task("2.1", 1), task("3.1", 2), task("3.2", 2)];

        expect(tillHere(plan, [{ id: 0 }, { id: 1 }, { id: 2 }], 1)).toEqual({ tasks: ["1.1", "2.1"], optional: [] });
    });

    it("reads a wave the graph does not list as waiting for every wave before it", () => {

        const plan = [task("1.1", 0), task("2.1", 1), task("3.1", 2)];

        expect(tillHere(plan, [], 2)).toEqual({ tasks: ["1.1", "2.1", "3.1"], optional: [] });
    });
});

describe("namesOf", () => {

    it("lists a few, and counts the rest", () => {

        expect(namesOf(["1", "2"])).toBe("1, 2");
        expect(namesOf(["1", "2", "3", "4"], 2)).toBe("1, 2 and 2 more");
    });
});

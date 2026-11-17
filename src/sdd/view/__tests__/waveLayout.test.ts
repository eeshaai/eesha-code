import { describe, expect, it } from "vitest";
import { branchClashes, fileLinks, needsLabel, startingPoints, waveRows } from "../waveLayout";

// Two starting points (0 and 1), a branch below each (2 and 3), and a
// wave joining them (4).
const WAVES = [
    { id: 0, tasks: ["1.1", "1.2"], after: [] },
    { id: 1, tasks: ["2.1", "2.2"], after: [] },
    { id: 2, tasks: ["3.1", "3.2"], after: [0] },
    { id: 3, tasks: ["4.1"], after: [1] },
    { id: 4, tasks: ["5.1"], after: [2, 3] }
];

const FILES: Record<string, string[]> = {
    "1.1": ["src/tags.ts"],
    "1.2": ["src/types.ts"],
    "2.1": ["src/chip.tsx"],
    "3.1": ["src/tags.ts", "src/loader.ts"],
    "3.2": ["src/cache.ts", "src/loader.ts"],
    "4.1": ["src/loader.ts", "src/chip.tsx"],
    "5.1": ["src/loader.ts"]
};

const filesOf = (id: string) => FILES[id] ?? [];

describe("waveRows", () => {

    it("puts starting points in the first row and each wave one row below what it waits for", () => {

        expect(waveRows(WAVES).map(row => row.map(wave => wave.id))).toEqual([[0, 1], [2, 3], [4]]);
    });

    it("lays a plan with no 'after' out as one wave per row", () => {

        const rows = waveRows([{ id: 0, tasks: ["1.1"] }, { id: 1, tasks: ["1.2"] }, { id: 2, tasks: ["1.3"] }]);

        expect(rows.map(row => row.map(wave => wave.id))).toEqual([[0], [1], [2]]);
        expect(rows[2][0].needs).toEqual([1]);
    });

    it("puts a join below the lower of the waves it waits for", () => {

        const rows = waveRows([{ id: 0, tasks: [], after: [] }, { id: 1, tasks: [], after: [0] }, { id: 2, tasks: [], after: [0, 1] }]);

        expect(rows.map(row => row.map(wave => wave.id))).toEqual([[0], [1], [2]]);
    });
});

describe("startingPoints", () => {

    it("lists the waves that wait for nothing", () => {

        expect(startingPoints(WAVES)).toEqual([0, 1]);
    });
});

describe("branchClashes", () => {

    it("names two tasks on branches that can be worked at once and edit the same file", () => {

        expect(branchClashes(WAVES, filesOf)).toEqual([
            { tasks: ["3.1", "4.1"], paths: ["src/loader.ts"] },
            { tasks: ["3.2", "4.1"], paths: ["src/loader.ts"] }
        ]);
    });

    /* One waits for the other, so they are never worked at the same time. */
    it("says nothing about a task and a later task down the same branch", () => {

        const clashes = branchClashes(WAVES, filesOf);

        expect(clashes.some(clash => clash.tasks.includes("5.1"))).toBe(false);
        expect(clashes.some(clash => clash.tasks.includes("1.1"))).toBe(false);
    });
});

describe("fileLinks", () => {

    it("links a task to the nearest earlier task it waits for that edits the same file", () => {

        const links = fileLinks(WAVES, filesOf);

        expect(links).toContainEqual({ from: "1.1", to: "3.1", paths: ["src/tags.ts"] });
        expect(links).toContainEqual({ from: "2.1", to: "4.1", paths: ["src/chip.tsx"] });

        // 5.1 waits for waves 0 to 3; wave 3 is the latest with loader.ts.
        expect(links).toContainEqual({ from: "4.1", to: "5.1", paths: ["src/loader.ts"] });
    });

    it("draws no link to a task on another branch", () => {

        expect(fileLinks(WAVES, filesOf).some(link => link.from === "3.1" && link.to === "4.1")).toBe(false);
    });
});

describe("needsLabel", () => {

    it("says what a wave waits for in words", () => {

        expect(needsLabel([])).toBe("starting point");
        expect(needsLabel([0])).toBe("after wave 0");
        expect(needsLabel([2, 3])).toBe("after waves 2 and 3");
        expect(needsLabel([1, 2, 3])).toBe("after waves 1, 2 and 3");
    });
});

import { describe, expect, it } from "vitest";

import { RowSort, sortRows } from "../rowSort";

/**
 * The order the Workflows and Specs sections read in.
 *
 * Without a sort, a list would follow whatever order the disk answers the
 * walk in, which changes between machines and between scans. So what is
 * asserted here is that both choices are total - every input has exactly
 * one output order - because "mostly sorted, ties left as they fell" is
 * not a stable list.
 */

interface Row { label: string; modified: number; }

function order(rows: Row[], sort: RowSort): string[] {

    return sortRows(rows, sort, row => row).map(row => row.label);
}

const rows: Row[] = [
    { label: "release", modified: 300 },
    { label: "Build", modified: 100 },
    { label: "audit", modified: 300 },
    { label: "check", modified: 900 }
];

describe("A-Z", () => {

    it("ignores case, so Build sits with build and not in its own alphabet", () => {

        expect(order(rows, "alpha")).toEqual(["audit", "Build", "check", "release"]);
    });

    it("leaves the input alone", () => {

        const input = [...rows];

        sortRows(input, "alpha", row => row);

        expect(input).toEqual(rows);
    });
});

describe("recently changed", () => {

    it("puts the newest first", () => {

        expect(order(rows, "recent")[0]).toBe("check");
    });

    /*
     * The case that matters most: a fresh clone writes every file at the
     * same moment. Without the fallback the whole list would keep the
     * random order this exists to remove.
     */
    it("falls back to A-Z when two rows changed at the same moment", () => {

        expect(order(rows, "recent")).toEqual(["check", "audit", "release", "Build"]);
    });

    it("puts a row whose time could not be read at the bottom, not out of the list", () => {

        const unreadable = [...rows, { label: "broken", modified: 0 }];

        expect(order(unreadable, "recent").at(-1)).toBe("broken");
    });
});

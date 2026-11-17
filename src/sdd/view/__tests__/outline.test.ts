import { describe, expect, it } from "vitest";

import { chainAt, hasChildren, outlineOf, sectionAt, visibleOf, withRows } from "../outline";

const BODY = [
    "# Requirements",            // 1
    "",
    "## Introduction",           // 3
    "",
    "Some prose with # a hash.", // 5
    "",
    "```bash",                   // 7
    "# not a heading",           // 8
    "```",
    "",
    "## Requirements",           // 11
    "",
    "### Requirement 1",         // 13
    "",
    "#### Criteria ####",        // 15
    "",
    "~~~",                       // 17
    "### also not a heading",
    "~~~",
    "",
    "## Glossary"                // 21
].join("\n");

describe("outlineOf", () => {

    it("reads every heading with its depth", () => {

        expect(outlineOf(BODY)).toEqual([
            { line: 1, depth: 1, text: "Requirements" },
            { line: 3, depth: 2, text: "Introduction" },
            { line: 11, depth: 2, text: "Requirements" },
            { line: 13, depth: 3, text: "Requirement 1" },
            { line: 15, depth: 4, text: "Criteria" },
            { line: 21, depth: 2, text: "Glossary" }
        ]);
    });

    it("shifts every line by the frontmatter that was split off", () => {

        expect(outlineOf(BODY, 6).map(item => item.line)).toEqual([7, 9, 17, 19, 21, 27]);
    });

    it("strips emphasis from the text", () => {

        expect(outlineOf("## The **loud** one")).toEqual([{ line: 1, depth: 2, text: "The loud one" }]);
    });

    it("finds nothing in a document with no headings", () => {

        expect(outlineOf("just prose\n\nand more")).toEqual([]);
    });
});

describe("sectionAt", () => {

    const items = outlineOf(BODY);

    it("names the heading the line sits under", () => {

        expect(sectionAt(items, 14)?.text).toBe("Requirement 1");
        expect(sectionAt(items, 11)?.text).toBe("Requirements");
        expect(sectionAt(items, 30)?.text).toBe("Glossary");
    });

    it("has nothing to name above the first heading", () => {

        expect(sectionAt(outlineOf("prose\n\n## Later"), 1)).toBeUndefined();
    });
});

describe("chainAt", () => {

    const items = outlineOf(BODY);

    it("lists every parent heading, outermost first", () => {

        expect(chainAt(items, 16).map(item => item.text)).toEqual(["Requirements", "Requirements", "Requirement 1", "Criteria"]);
    });

    it("drops a branch the line has left", () => {

        expect(chainAt(items, 22).map(item => item.text)).toEqual(["Requirements", "Glossary"]);
    });

    it("keeps a skipped level skipped", () => {

        expect(chainAt(outlineOf("# Top\n\n### Deep\n"), 3).map(item => item.text)).toEqual(["Top", "Deep"]);
    });

    it("has no chain above the first heading", () => {

        expect(chainAt(outlineOf("prose\n\n## Later"), 1)).toEqual([]);
    });

    it("carries a plan's rows under their heading", () => {

        const merged = withRows(outlineOf("## Tasks\n\n- [ ] 1. One\n  - [ ] 1.1 Sub\n"), [
            { line: 3, text: "1. One", level: 1 },
            { line: 4, text: "1.1. Sub", level: 2 }
        ]);

        expect(chainAt(merged, 4).map(item => item.text)).toEqual(["Tasks", "1. One", "1.1. Sub"]);
    });
});

describe("withRows", () => {

    it("folds rows in under the heading they sit beneath, one level deeper, in line order", () => {

        const items = outlineOf("# Plan\n\n## Tasks\n\n- [ ] 1. One\n- [ ] 2. Two\n\n## Notes\n");

        const merged = withRows(items, [{ line: 6, text: "2. Two" }, { line: 5, text: "1. One" }]);

        expect(merged.map(item => [item.line, item.depth, item.text, item.row ?? false])).toEqual([
            [1, 1, "Plan", false],
            [3, 2, "Tasks", false],
            [5, 3, "1. One", true],
            [6, 3, "2. Two", true],
            [8, 2, "Notes", false]
        ]);
    });

    it("nests a row one level deeper for each level it has", () => {

        const items = outlineOf("## Tasks\n\n- [ ] 1. One\n  - [ ] 1.1 Sub\n    - [ ] 1.1.1 Deeper\n");

        const merged = withRows(items, [
            { line: 3, text: "1. One", level: 1 },
            { line: 4, text: "1.1. Sub", level: 2 },
            { line: 5, text: "1.1.1. Deeper", level: 3 }
        ]);

        expect(merged.map(item => [item.depth, item.text])).toEqual([
            [2, "Tasks"],
            [3, "1. One"],
            [4, "1.1. Sub"],
            [5, "1.1.1. Deeper"]
        ]);
    });

    it("puts a row above any heading at depth two", () => {

        expect(withRows([], [{ line: 1, text: "1. Lone" }])).toEqual([{ line: 1, depth: 2, text: "1. Lone", row: true }]);
    });
});

describe("collapsing", () => {

    const items = outlineOf(BODY);

    it("knows which items have something under them", () => {

        expect(items.map((_, index) => hasChildren(items, index)))
            .toEqual([true, false, true, true, false, false]);
    });

    it("shows everything when nothing is collapsed", () => {

        expect(visibleOf(items, new Set())).toEqual(items);
    });

    it("hides every deeper item under a collapsed one, and keeps the collapsed one", () => {

        expect(visibleOf(items, new Set([11])).map(item => item.line)).toEqual([1, 3, 11, 21]);
    });

    it("hides everything under a collapsed top heading", () => {

        expect(visibleOf(items, new Set([1])).map(item => item.line)).toEqual([1]);
    });

    it("lights the collapsed item when the reader is inside it", () => {

        expect(sectionAt(visibleOf(items, new Set([11])), 15)?.line).toBe(11);
    });
});

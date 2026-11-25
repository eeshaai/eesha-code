import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { GRAMMAR_FILE, grammarSection } from "../grammar";

/**
 * The grammar is an ordinary style file, so there is almost no code
 * here to test - resolution is the registry's, and `assemble.test`
 * covers which scope wins.
 *
 * What is worth asserting is the shipped `custom` grammar itself. It is
 * the text every phase of the default style is handed, and it is the
 * copy an eject hands a person to edit. A rule dropped out of it would
 * still read like a grammar and would silently cost the panel feature it
 * exists to feed.
 */

const shipped = path.join("resources", "styles", GRAMMAR_FILE);

describe("the grammar Eesha Code ships", () => {

    it("is there, in the styles folder beside the style folders", () => {

        expect(fs.existsSync(shipped)).toBe(true);
    });

    it("states the shapes the panel reads", () => {

        const text = fs.readFileSync(shipped, "utf8");

        for (const rule of [
            "#### Acceptance Criteria",
            "[Requirements : 1.2, 3.1](requirements.md)",
            "## Task Dependency Graph",
            "- [ ] N. Title",
            "SHALL NOT",
            "## Open Questions",
            "## Answered Questions",
            "- **QN-1**",
            "**A:**"
        ])
            expect(text).toContain(rule);
    });
});

describe("naming it to an agent", () => {

    it("gives the path and when to open it", () => {

        const section = grammarSection("/styles/grammar.md");

        expect(section).toContain("## Grammar");
        expect(section).toContain("`/styles/grammar.md`");
        expect(section).toContain("Open it only when you write, edit or read a spec document.");
    });

    /* No scope has one. The phase runs without it rather than failing over it. */
    it("adds nothing when there is no grammar", () => {

        expect(grammarSection(undefined)).toBe("");
    });
});

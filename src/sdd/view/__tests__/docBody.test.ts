import { describe, expect, it } from "vitest";

import { splitFrontmatter } from "../docBody";

/**
 * The offset is the whole point of these tests.
 *
 * `meta` and `body` are visible on screen - a wrong split shows up the
 * first time anyone opens a document. A wrong offset shows up as a
 * line number that is quietly six out, which nobody notices until they
 * read it aloud in a review and somebody opens the file on a blank
 * line.
 */
describe("splitFrontmatter", () => {

    it("reports no offset for a document without frontmatter", () => {

        const { meta, body, offset } = splitFrontmatter("# Design\n\nSome prose.\n");

        expect(meta).toEqual([]);
        expect(body).toBe("# Design\n\nSome prose.\n");
        expect(offset).toBe(0);
    });

    /**
     * The shape `renderIdea` writes and the requirements prompt is
     * told to carry over, measured against the real file: with these
     * six lines of frontmatter, the body's line 4 is the file's line
     * 10.
     */
    it("counts the lines frontmatter occupied", () => {

        const content = [
            "---",
            "spec: 1",
            "type: feature",
            "source: file",
            "title: asasa",
            "---",
            "",
            "# asasa",
            "",
            "## Open Questions"
        ].join("\n");

        const { meta, body, offset } = splitFrontmatter(content);

        expect(meta).toEqual([
            ["spec", "1"],
            ["type", "feature"],
            ["source", "file"],
            ["title", "asasa"]
        ]);

        expect(offset).toBe(6);

        // The claim that matters, stated the way the gutter will use it.
        const bodyLine = body.split("\n").indexOf("## Open Questions") + 1;

        expect(bodyLine + offset).toBe(10);
    });

    it("counts CRLF frontmatter the same", () => {

        const content = "---\r\nspec: 1\r\ntype: bug\r\n---\r\n\r\n# Title\r\n";

        const { body, offset } = splitFrontmatter(content);

        expect(offset).toBe(4);
        expect(body.startsWith("\r\n# Title")).toBe(true);
    });

    /**
     * A key the parser skips still took up a line. Counting the matched
     * text rather than the keys is what keeps the offset about the file
     * instead of about what was understood.
     */
    it("counts lines it did not parse as keys", () => {

        const content = [
            "---",
            "spec: 1",
            "",
            "# a comment line the key parser ignores",
            "empty:",
            "title: thing",
            "---",
            "body"
        ].join("\n");

        const { meta, offset } = splitFrontmatter(content);

        expect(meta).toEqual([["spec", "1"], ["title", "thing"]]);
        expect(offset).toBe(7);
    });

    /**
     * A closing `---` with nothing after it. The trailing newline is
     * optional in the pattern, so the count has to come out one lower
     * rather than assuming a line that is not there.
     */
    it("handles frontmatter with no trailing newline", () => {

        const { body, offset } = splitFrontmatter("---\ntitle: x\n---");

        expect(body).toBe("");
        expect(offset).toBe(2);
    });

    /** A `---` that is not at the very top is a horizontal rule, not frontmatter. */
    it("leaves a mid-document rule alone", () => {

        const content = "# Title\n\n---\n\nAfter the rule.\n";

        const { meta, body, offset } = splitFrontmatter(content);

        expect(meta).toEqual([]);
        expect(body).toBe(content);
        expect(offset).toBe(0);
    });
});

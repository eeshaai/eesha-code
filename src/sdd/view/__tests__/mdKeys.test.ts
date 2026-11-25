import { describe, expect, it } from "vitest";

import { indent, link, wrap } from "../mdKeys";

/** A field written as one string, with `|` for the caret or `[...]` around the selection. */
function field(written: string) {

    if (written.includes("|"))
        return {
            text: written.replace("|", ""),
            start: written.indexOf("|"),
            end: written.indexOf("|")
        };

    const start = written.indexOf("[");
    const end = written.indexOf("]") - 1;

    return { text: written.replace("[", "").replace("]", ""), start, end };
}

/** The same notation back, so a failure reads as text rather than as three numbers. */
function shown(result: { text: string; start: number; end: number }) {

    if (result.start === result.end)
        return result.text.slice(0, result.start) + "|" + result.text.slice(result.start);

    return result.text.slice(0, result.start)
        + "[" + result.text.slice(result.start, result.end) + "]"
        + result.text.slice(result.end);
}

describe("wrap", () => {

    it("wraps the selection", () => {

        expect(shown(wrap(field("one [two] three"), "**"))).toBe("one **[two]** three");
    });

    it("grows to the word under the caret when nothing is selected", () => {

        expect(shown(wrap(field("one tw|o three"), "**"))).toBe("one **[two]** three");
    });

    it("unwraps marks that are already outside the selection", () => {

        expect(shown(wrap(field("one **[two]** three"), "**"))).toBe("one [two] three");
    });

    it("unwraps marks that are inside the selection", () => {

        expect(shown(wrap(field("one [**two**] three"), "**"))).toBe("one [two] three");
    });

    it("adds italic inside bold rather than unwrapping one star each side", () => {

        expect(shown(wrap(field("one **[two]** three"), "*"))).toBe("one ***[two]*** three");
    });

    it("wraps an empty caret and leaves it between the marks", () => {

        expect(shown(wrap(field("one |  two"), "`"))).toBe("one `|`  two");
    });
});

describe("link", () => {

    it("makes the selection the label and offers url", () => {

        expect(shown(link(field("see [the spec] first")))).toBe("see [the spec]([url]) first");
    });

    it("makes a url the target and leaves the caret in the label", () => {

        expect(shown(link(field("[https://example.com]")))).toBe("[|](https://example.com)");
    });

    it("treats a relative path as a target", () => {

        expect(shown(link(field("[./design.md]")))).toBe("[|](./design.md)");
    });
});

describe("indent", () => {

    it("indents where the caret stands when nothing is selected", () => {

        expect(shown(indent(field("- |one"), false))).toBe("-   |one");
    });

    it("indents every line the selection touches", () => {

        expect(shown(indent(field("- [one\n- two]\n- three"), false)))
            .toBe("  - [one\n  - two]\n- three");
    });

    it("outdents the line the caret is on", () => {

        expect(shown(indent(field("  - o|ne"), true))).toBe("- o|ne");
    });

    it("outdents one step at a time and stops at the margin", () => {

        expect(indent({ text: "- one", start: 5, end: 5 }, true).text).toBe("- one");
    });

    it("leaves the line below alone when the selection ends on a newline", () => {

        expect(indent({ text: "one\ntwo", start: 0, end: 4 }, false).text).toBe("  one\ntwo");
    });
});

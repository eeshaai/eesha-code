import { describe, expect, it } from "vitest";

import { ReviewNote, anchorFor, anchorNotes, normaliseAnchor, notesByLine, reviseInstruction } from "../reviewNotes";

const DOC = [
    "---",
    "spec: 1",
    "---",
    "",
    "# Title",
    "",
    "## Requirements",
    "",
    "1. WHEN a run starts THEN the system SHALL read .env.example",
    "2. WHEN a value is missing THEN the system SHALL fail loudly"
].join("\n");

function note(over: Partial<ReviewNote> = {}): ReviewNote {

    return {
        id: "n1",
        artifact: "requirements.md",
        line: 9,
        anchorText: anchorFor(DOC, 9),
        body: "Too vague - which values?",
        createdAt: "2026-09-02T00:00:00.000Z",
        ...over
    };
}

describe("normaliseAnchor", () => {

    it("strips the markup a reformat moves around", () => {

        expect(normaliseAnchor("  ### Requirement 1  ")).toBe("Requirement 1");
        expect(normaliseAnchor("- a bullet")).toBe("a bullet");
        expect(normaliseAnchor("12. a numbered item")).toBe("a numbered item");
        expect(normaliseAnchor("> quoted")).toBe("quoted");
    });

    /*
     * Why this guard exists. Every acceptance criterion and every user
     * story in a requirements document opens with bold, and eating its
     * first asterisk would anchor the note to text the document does not
     * contain - so it would arrive orphaned the moment it was written.
     */
    it("leaves bold at the start of a line alone", () => {

        expect(normaliseAnchor("**User Story:** As the person paying the bill"))
            .toBe("**User Story:** As the person paying the bill");

        expect(normaliseAnchor("*emphasis* opening a line")).toBe("*emphasis* opening a line");
    });

    it("strips a marker that is followed by space", () => {

        expect(normaliseAnchor("*  a starred bullet")).toBe("a starred bullet");
        expect(normaliseAnchor("#not-a-heading tag")).toBe("#not-a-heading tag");
    });

    it("collapses runs of whitespace", () => {

        expect(normaliseAnchor("one   two\tthree")).toBe("one two three");
    });
});

describe("anchorNotes", () => {

    it("keeps a note where it was written when the line has not moved", () => {

        const [anchored] = anchorNotes([note()], DOC);

        expect(anchored.at).toBe(9);
        expect(anchored.moved).toBe(false);
    });

    /**
     * The case the whole design exists for: a revise adds a paragraph
     * above, every line number below it shifts, and the note has to
     * follow its own text rather than stay on a number.
     */
    it("re-anchors a note whose text moved", () => {

        const revised = DOC.replace("## Requirements", "## Introduction\n\nA sentence.\n\n## Requirements");

        const [anchored] = anchorNotes([note()], revised);

        expect(anchored.at).toBe(13);
        expect(anchored.moved).toBe(true);
    });

    it("orphans a note whose text is gone rather than guessing", () => {

        const rewritten = DOC.replace("1. WHEN a run starts THEN the system SHALL read .env.example", "1. Something else entirely");

        const [anchored] = anchorNotes([note()], rewritten);

        expect(anchored.at).toBeUndefined();
        expect(anchored.moved).toBe(false);
    });

    it("picks the nearest match when the text appears more than once", () => {

        const repeated = [DOC, "", "1. WHEN a run starts THEN the system SHALL read .env.example"].join("\n");

        const [near] = anchorNotes([note({ line: 9 })], repeated);
        const [far] = anchorNotes([note({ line: 12, anchorText: anchorFor(DOC, 9) })], repeated);

        expect(near.at).toBe(9);
        expect(far.at).toBe(12);
    });

    /** A note against a blank line has nothing to find, and the first blank line is not an answer. */
    it("orphans a note with an empty anchor", () => {

        const [anchored] = anchorNotes([note({ anchorText: "" })], DOC);

        expect(anchored.at).toBeUndefined();
    });
});

describe("notesByLine", () => {

    it("groups by where each note landed and drops the orphans", () => {

        const anchored = anchorNotes(
            [
                note({ id: "a" }),
                note({ id: "b" }),
                note({ id: "c", line: 10, anchorText: anchorFor(DOC, 10) }),
                note({ id: "d", anchorText: "gone" })
            ],
            DOC);

        const byLine = notesByLine(anchored);

        expect(byLine.get(9)?.map(one => one.id)).toEqual(["a", "b"]);
        expect(byLine.get(10)?.map(one => one.id)).toEqual(["c"]);
        expect([...byLine.keys()]).toEqual([9, 10]);
    });
});

describe("reviseInstruction", () => {

    it("is empty when nothing is open", () => {

        expect(reviseInstruction(anchorNotes([note({ resolved: true })], DOC), DOC)).toBe("");
    });

    it("quotes each note against the line it is about, in document order", () => {

        const anchored = anchorNotes(
            [
                note({ id: "second", line: 10, anchorText: anchorFor(DOC, 10), body: "Say what loudly means." }),
                note({ id: "first" })
            ],
            DOC);

        const instruction = reviseInstruction(anchored, DOC);

        expect(instruction).toContain("2 review notes were left");
        expect(instruction.indexOf("Too vague")).toBeLessThan(instruction.indexOf("Say what loudly means"));
        expect(instruction).toContain("> 1. WHEN a run starts THEN the system SHALL read .env.example");
        expect(instruction).toContain("**line 9**");
    });

    it("says so rather than quoting nothing for an orphan", () => {

        const anchored = anchorNotes([note({ anchorText: "gone", body: "Check this." })], DOC);

        const instruction = reviseInstruction(anchored, DOC);

        expect(instruction).toContain("no longer in the document");
        expect(instruction).toContain("Check this.");
    });

    it("leaves resolved notes out of a mixed set", () => {

        const anchored = anchorNotes(
            [note({ id: "open" }), note({ id: "done", body: "Already handled.", resolved: true })],
            DOC);

        const instruction = reviseInstruction(anchored, DOC);

        expect(instruction).toContain("1 review note was");
        expect(instruction).not.toContain("Already handled.");
    });
});

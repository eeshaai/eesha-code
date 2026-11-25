import { describe, expect, it } from "vitest";

import { answerQuestion, openQuestions, unansweredQuestions } from "../openQuestions";

const document = (...body: string[]) => ["# Design Document", "", ...body].join("\n");

describe("openQuestions", () => {

    it("finds nothing in a document without the section", () => {

        expect(openQuestions(document("## Overview", "", "Some prose."))).toEqual([]);
    });

    it("reads the grammar's shape", () => {

        const questions = openQuestions(document(
            "## Open Questions",
            "",
            "- **QN-1** Do we keep the device-code flow?",
            "- **QN-2** Is the retry budget per request or per session?",
            "  **A:** Per session.",
            "",
            "## Overview"));

        expect(questions).toEqual([
            { id: "QN-1", text: "Do we keep the device-code flow?" },
            { id: "QN-2", text: "Is the retry budget per request or per session?", answer: "Per session." }
        ]);
    });

    it("blocks on the unanswered ones only", () => {

        const body = document(
            "## Open Questions",
            "",
            "- **QN-1** Answered one.",
            "  **A:** Yes.",
            "- **QN-2** Unanswered one.");

        expect(unansweredQuestions(body).map(question => question.id)).toEqual(["QN-2"]);
    });

    /*
     * A document by an agent that ignored the grammar. It still has
     * questions in it and they
     * still block - see the file comment.
     */
    it("counts an item with no id", () => {

        const questions = openQuestions(document(
            "## Open Questions",
            "",
            "1. Which auth flow?",
            "* Which storage?"));

        expect(questions).toEqual([
            { text: "Which auth flow?" },
            { text: "Which storage?" }
        ]);

        expect(unansweredQuestions(document("## Open Questions", "", "1. Which auth flow?"))).toHaveLength(1);
    });

    it("takes a bare A: as an answer", () => {

        const questions = openQuestions(document(
            "## Open Questions",
            "",
            "- **QN-1** Which auth flow?",
            "  A: Device code."));

        expect(questions[0].answer).toBe("Device code.");
    });

    it("stops at the next heading", () => {

        const questions = openQuestions(document(
            "## Open Questions",
            "",
            "- **QN-1** A real question.",
            "",
            "## Requirements",
            "",
            "- **QN-2** Not a question, a bullet that looks like one."));

        expect(questions).toHaveLength(1);
        expect(questions[0].id).toBe("QN-1");
    });

    it("does not read an answer line as a question", () => {

        expect(openQuestions(document(
            "## Open Questions",
            "",
            "- **QN-1** Which auth flow?",
            "  **A:** Device code."))).toHaveLength(1);
    });

    it("ignores an empty bullet", () => {

        expect(openQuestions(document("## Open Questions", "", "-", "- **QN-1** A real one."))).toEqual([
            { id: "QN-1", text: "A real one." }
        ]);
    });

    it("reads the heading whatever its case", () => {

        expect(openQuestions(document("## OPEN QUESTIONS", "", "- **QN-1** Still a question."))).toHaveLength(1);
    });

    it("reads a document with CRLF line endings", () => {

        const body = "# Design Document\r\n\r\n## Open Questions\r\n\r\n- **QN-1** Which flow?\r\n  **A:** Device code.\r\n";

        expect(openQuestions(body)).toEqual([{ id: "QN-1", text: "Which flow?", answer: "Device code." }]);
    });
});

describe("answerQuestion", () => {

    const doc = [
        "# Design",
        "",
        "## Open Questions",
        "",
        "- **QN-1** Which flow?",
        "  **A:** The short one.",
        "- **QN-2** Which store",
        "  should hold it?",
        "- **QN-3** Who signs off?",
        "",
        "## Next"
    ].join("\n");

    it("writes an A: line under the question, after its wrapped lines, and lifts the block", () => {

        const text = answerQuestion(doc, 1, "The file store.");

        expect(text.split("\n").slice(6, 10)).toEqual([
            "- **QN-2** Which store",
            "  should hold it?",
            "  **A:** The file store.",
            "- **QN-3** Who signs off?"
        ]);
        expect(unansweredQuestions(text).map(question => question.id)).toEqual(["QN-3"]);
    });

    it("answers the last question before a blank line", () => {

        expect(answerQuestion(doc, 2, "Maya")).toContain("- **QN-3** Who signs off?\n  **A:** Maya\n\n## Next");
    });

    it("keeps the answer on one line", () => {

        expect(answerQuestion(doc, 2, "one\ntwo")).toContain("  **A:** one two");
    });

    it("leaves the document alone for a blank answer, an answered question or no such question", () => {

        expect(answerQuestion(doc, 2, "  ")).toBe(doc);
        expect(answerQuestion(doc, 0, "Again")).toBe(doc);
        expect(answerQuestion(doc, 7, "Nobody")).toBe(doc);
    });

    it("keeps Windows line ends", () => {

        expect(answerQuestion(doc.replace(/\n/g, "\r\n"), 2, "Maya")).toContain("Who signs off?\r\n  **A:** Maya\r\n");
    });
});

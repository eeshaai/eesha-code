import { describe, expect, it } from "vitest";

import { SpecStage } from "../../../shared/runMessages";
import { blockedBy, questionsBefore } from "../openQuestionGate";

/** A requirements-design-tasks pipeline as the view receives it, with questions put where a test wants them. */
const pipeline = (questions: Record<string, SpecStage["openQuestions"]> = {}): SpecStage[] =>
    ["idea", "requirements", "design", "tasks", "implement"].map(name => ({
        name,
        ...(name === "implement" ? {} : { artifact: `/spec/${name}.md`, exists: true }),
        ...(questions[name] ? { openQuestions: questions[name] } : {})
    }));

const fileName = (path: string) => path.split("/").pop()!;

describe("questionsBefore", () => {

    it("finds nothing when no document has any", () => {

        expect(questionsBefore(pipeline(), "design")).toEqual([]);
    });

    it("does not block a phase on its own questions", () => {

        const stages = pipeline({ design: [{ id: "Q1", text: "Which store?" }] });

        expect(questionsBefore(stages, "design")).toEqual([]);
    });

    it("blocks every phase after the one that asked", () => {

        const stages = pipeline({ requirements: [{ id: "Q1", text: "Which flow?" }] });

        expect(questionsBefore(stages, "design").map(stage => stage.name)).toEqual(["requirements"]);
        expect(questionsBefore(stages, "tasks").map(stage => stage.name)).toEqual(["requirements"]);
        expect(questionsBefore(stages, "implement").map(stage => stage.name)).toEqual(["requirements"]);
    });

    /* The plan's controls start the execution phase, which is last - so every drafting document counts. */
    it("blocks the work on tasks.md as well", () => {

        const stages = pipeline({ tasks: [{ id: "Q4", text: "Ship behind a flag?" }] });

        expect(questionsBefore(stages, "implement").map(stage => stage.name)).toEqual(["tasks"]);
        expect(questionsBefore(stages, "tasks")).toEqual([]);
    });

    it("has nothing to say without a stage to start", () => {

        expect(questionsBefore(pipeline({ requirements: [{ text: "?" }] }), undefined)).toEqual([]);
    });
});

describe("blockedBy", () => {

    it("says nothing when nothing blocks", () => {

        expect(blockedBy(pipeline(), "design", fileName)).toBeUndefined();
    });

    it("names the document, the ids, and how to lift it", () => {

        const stages = pipeline({
            requirements: [{ id: "Q1", text: "Which flow?" }, { id: "Q3", text: "Which store?" }]
        });

        const message = blockedBy(stages, "design", fileName)!;

        expect(message).toContain("requirements.md (Q1, Q3)");
        expect(message).toContain("A: line");
    });

    it("names more than one document", () => {

        const stages = pipeline({
            requirements: [{ id: "Q1", text: "Which flow?" }],
            design: [{ id: "Q2", text: "Which store?" }]
        });

        expect(blockedBy(stages, "tasks", fileName)).toContain("requirements.md (Q1) and design.md (Q2)");
    });

    /* An item the document wrote without an id still blocks - it just has to be pointed at by position. */
    it("points at a question that carries no id", () => {

        const stages = pipeline({ requirements: [{ text: "Which flow?" }] });

        expect(blockedBy(stages, "design", fileName)).toContain("requirements.md (question 1)");
    });
});

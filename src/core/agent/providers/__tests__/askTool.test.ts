import { describe, expect, it } from "vitest";

import { AskHook, NOT_INTERACTIVE } from "../../AgentSession";
import { AskToolInput, askQuestions, askToolJsonSchema, askToolShape } from "../askTool";

/**
 * The shared question tool and its three shapes: pick one, pick
 * several, type an answer. It exists because no vendor tool covers all
 * three: Claude's cannot ask for free text, Copilot's has no
 * multi-select, and ACP has no agent question at all.
 */

/** A hook that records what it was asked and answers from a script, in order. */
function scripted(answers: string[]): {
    hook: AskHook;
    asked: { prompt: string; options?: unknown; multi?: boolean }[];
} {

    const asked: { prompt: string; options?: unknown; multi?: boolean }[] = [];

    const hook: AskHook = request => {

        asked.push({ prompt: request.prompt, options: request.options, multi: request.multi });

        return { askId: `ask-${asked.length}`, answer: Promise.resolve(answers[asked.length - 1]) };
    };

    return { hook, asked };
}

const pickOne: AskToolInput = {
    questions: [{
        question: "Which store?",
        options: [
            { label: "SQLite", description: "one file" },
            { label: "Postgres", description: "a server" }
        ]
    }]
};

describe("the three shapes", () => {

    it("pick one - options, and no multi flag", async () => {

        const { hook, asked } = scripted(["SQLite"]);

        const result = await askQuestions(pickOne, hook);

        expect(asked).toEqual([{
            prompt: "Which store?",
            options: [{ label: "SQLite", description: "one file" }, { label: "Postgres", description: "a server" }],
            multi: undefined
        }]);

        expect(result).toBe("Q: Which store?\nA: SQLite");
    });

    it("pick several - options, and the multi flag carried through", async () => {

        const { hook, asked } = scripted(["a, b"]);

        const result = await askQuestions({
            questions: [{ question: "Which?", options: [{ label: "a" }, { label: "b" }], multi: true }]
        }, hook);

        expect(asked[0].multi).toBe(true);
        expect(result).toBe("Q: Which?\nA: a, b");
    });

    it("free text - no options at all, and no invented ones", async () => {

        const { hook, asked } = scripted(["citation-check"]);

        const result = await askQuestions({
            questions: [{ question: "What should the next task be called?" }]
        }, hook);

        expect(asked).toEqual([{
            prompt: "What should the next task be called?",
            options: undefined,
            multi: undefined
        }]);

        expect(result).toBe("Q: What should the next task be called?\nA: citation-check");
    });

    it("one option is not a choice - it is asked as free text", async () => {

        const { hook, asked } = scripted(["something else"]);

        await askQuestions({
            questions: [{ question: "Which?", options: [{ label: "The only one" }] }]
        }, hook);

        expect(asked[0].options).toBeUndefined();
        expect(asked[0].multi).toBeUndefined();
    });

    it("multi with no options is not a multi-select", async () => {

        const { hook, asked } = scripted(["typed"]);

        await askQuestions({ questions: [{ question: "Which?", multi: true }] }, hook);

        expect(asked[0].multi).toBeUndefined();
    });
});

describe("askQuestions", () => {

    it("tells the agent nobody is watching, rather than waiting on no one", async () => {

        expect(await askQuestions(pickOne, undefined)).toBe(NOT_INTERACTIVE);
        expect(NOT_INTERACTIVE).toMatch(/assumption/i);
    });

    it("asks several questions one at a time, in order, and returns them all", async () => {

        const { hook, asked } = scripted(["SQLite", "citation-check"]);

        const result = await askQuestions({
            questions: [
                ...pickOne.questions!,
                { question: "What should the next task be called?" }
            ]
        }, hook);

        expect(asked.map(one => one.prompt))
            .toEqual(["Which store?", "What should the next task be called?"]);

        expect(result).toBe(
            "Q: Which store?\nA: SQLite\n\nQ: What should the next task be called?\nA: citation-check");
    });

    it("drops a question with nothing to answer, and an option with nothing written on it", async () => {

        const { hook, asked } = scripted(["SQLite"]);

        await askQuestions({
            questions: [
                { question: "   " },
                { question: "Which store?", options: [{ label: "SQLite" }, { label: "  " }, { label: "Postgres" }] }
            ]
        }, hook);

        expect(asked).toHaveLength(1);
        expect(asked[0].options).toEqual([{ label: "SQLite" }, { label: "Postgres" }]);
    });

    it("says so when the call carried no question at all", async () => {

        const { hook, asked } = scripted([]);

        expect(await askQuestions({ questions: [] }, hook)).toMatch(/no question/i);
        expect(await askQuestions({}, hook)).toMatch(/no question/i);
        expect(asked).toEqual([]);
    });

    it("keeps the answers already given when the rest is abandoned", async () => {

        let asked = 0;

        const hook: AskHook = () => {

            asked += 1;

            return asked === 1
                ? { askId: "ask-1", answer: Promise.resolve("SQLite") }
                : {
                    askId: "ask-2",
                    answer: Promise.reject(new Error("The session ended before the question was answered."))
                };
        };

        const result = await askQuestions({
            questions: [...pickOne.questions!, { question: "And then?" }]
        }, hook);

        expect(result).toContain("A: SQLite");
        expect(result).toContain("session ended");
        expect(result).toMatch(/assumption/i);
    });

    it("stops waiting the moment the provider's own signal fires", async () => {

        const controller = new AbortController();

        const hook: AskHook = () => ({ askId: "ask-1", answer: new Promise<string>(() => undefined) });

        const result = askQuestions(pickOne, hook, controller.signal);

        controller.abort();

        expect(await result).toMatch(/cancelled/i);
    });

    it("does not ask at all when the signal has already fired", async () => {

        const controller = new AbortController();

        controller.abort();

        const { hook } = scripted(["SQLite"]);

        expect(await askQuestions(pickOne, hook, controller.signal)).toMatch(/cancelled/i);
    });
});

/**
 * Claude takes a zod shape and Copilot takes raw JSON Schema, so the
 * same tool is declared twice. If they drift, one provider can ask a
 * question the other cannot.
 */
describe("the two spellings of one schema", () => {

    it("declare the same fields, with the same bounds", () => {

        const json = askToolJsonSchema.properties as Record<string, Record<string, unknown>>;

        expect(Object.keys(askToolShape)).toEqual(["questions"]);
        expect(Object.keys(json)).toEqual(["questions"]);

        expect(json.questions.minItems).toBe(1);
        expect(json.questions.maxItems).toBe(4);

        const item = json.questions.items as { properties: Record<string, unknown>; required: string[] };

        expect(Object.keys(item.properties)).toEqual(["question", "options", "multi"]);
        expect(item.required).toEqual(["question"]);
    });

    it("holds the question count the description promises", () => {

        const parsed = askToolShape.questions.safeParse(
            Array.from({ length: 5 }, () => ({ question: "Which?" })));

        expect(parsed.success).toBe(false);
    });
});

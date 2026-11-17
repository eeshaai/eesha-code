import { z } from "zod";

import { AskOption } from "../../models/run";
import { AskHook, NOT_INTERACTIVE } from "../AgentSession";

/**
 * The one question tool an agent can use to ask a person, and the one
 * place it is answered.
 *
 * The vendors' own tools do not cover what the panel draws: Claude's
 * `AskUserQuestion` requires two to four options, so it cannot ask for
 * free text; Copilot's `ask_user` has no multi-select; ACP has no agent
 * question at all. So each provider registers this tool instead:
 *
 *   - Claude: an in-process SDK MCP server, with `AskUserQuestion`
 *     disallowed so this is the only route.
 *   - Copilot: a session tool named `ask_user` with
 *     `overridesBuiltInTool`.
 *   - ACP: `elicitation/create`, the only door the protocol has. Not
 *     this tool, but the same three shapes; see `acpElicitation`.
 *
 * The three shapes, and how a call says which it wants:
 *
 *   - Pick one: two or more `options`.
 *   - Pick several: `options` and `multi: true`.
 *   - Free text: no `options`.
 *
 * A person can always type instead of picking, whatever the shape.
 */

/** What every provider calls it. Copilot's built-in has this name, and is overridden by it. */
export const ASK_TOOL_NAME = "ask_user";

/**
 * The MCP server this tool is served from on Claude, and therefore half
 * of the name the model sees: `mcp__eesha__ask_user`.
 *
 * Underscores, not hyphens: the SDK joins the name with `__`, and a
 * hyphen in the server name makes a tool the model cannot call.
 */
export const ASK_SERVER_NAME = "eesha";

/** The name the model sees for the Claude-side tool - what `isAskTool` matches. */
export const ASK_TOOL_FULL_NAME = `mcp__${ASK_SERVER_NAME}__${ASK_TOOL_NAME}`;

/**
 * What the model is told the tool is for. The three shapes are spelled
 * out here: a model that does not know it may omit `options` will
 * invent two filler ones instead of asking an open question.
 */
export const ASK_TOOL_DESCRIPTION =
    "Ask the person watching this session a question, and wait for their answer.\n\n"
    + "Use it when you need a decision only they can make. Do not use it to announce what you are "
    + "doing, or to ask something you can settle by reading the repository.\n\n"
    + "Each question is one of three kinds:\n"
    + "  - Pick one: give two or more options.\n"
    + "  - Pick several: give options and set multi to true.\n"
    + "  - Free text: give no options at all.\n\n"
    + "The person can always type their own answer instead of picking one, so options are a "
    + "suggestion rather than the whole list. Ask everything you need in one call - up to four "
    + "questions - rather than one call after another.";

/**
 * What an interactive session is told, on top of its own system prompt.
 *
 * The tool's description says what the tool is; this says someone is
 * there to answer. A headless agent assumes nobody is, so it writes its
 * questions out as prose and ends the turn, which no panel is
 * listening for.
 *
 * Applied by the provider whenever `interactive` is on, so no task has
 * to paste it into its own prompt. Appended to the vendor's own
 * preset, never replacing it.
 */
export const ASK_SYSTEM_PROMPT =
    "A person is watching this session right now and can answer questions.\n\n"
    + `When a decision is genuinely theirs to make, call the \`${ASK_TOOL_NAME}\` tool and wait for `
    + "the answer. Do not write a question out as prose and stop: there is no box on screen for a "
    + "question asked that way, so the turn ends with it unanswered and the work not done.\n\n"
    + "This holds for every question, not only the first. If an answer is unclear, contradicts "
    + `itself, or is not one of the choices you offered, ask again through \`${ASK_TOOL_NAME}\`. `
    + "A follow-up written as prose is as unreachable as a first question written that way.\n\n"
    + "This does not mean asking about everything. Anything you can settle by reading the "
    + "repository, you settle yourself.";

/** One question, read loosely: a malformed call is a question with missing parts, not a crash. */
export interface AskToolQuestion {

    question?: string;

    options?: { label?: string; description?: string }[];

    multi?: boolean;
}

export interface AskToolInput {

    questions?: AskToolQuestion[];
}

/** How many questions one call may carry - the model is told, and the schema holds it. */
export const MAX_QUESTIONS = 4;

/** The tool's input as a zod shape, for Claude's `tool()`. `zod` is a peer dependency of the Claude SDK. */
export const askToolShape = {

    questions: z.array(z.object({

        question: z.string()
            .describe("The question, written as a full sentence a person can answer."),

        options: z.array(z.object({

            label: z.string()
                .describe("The choice as the person sees it - a few words."),

            description: z.string().optional()
                .describe("What picking this one means. Optional.")
        }))
            .optional()
            .describe(
                "The choices to offer. Omit entirely when the answer is free text - do not invent "
                + "filler options for an open question."),

        multi: z.boolean().optional()
            .describe("True when more than one option may be picked. Ignored when there are no options.")
    }))
        .min(1)
        .max(MAX_QUESTIONS)
        .describe("The questions to ask, in the order they should be put.")
};

/**
 * The same input as plain JSON Schema, for Copilot. It is given the raw
 * schema so the two SDKs never have to agree on a zod version. Keep it
 * in step with the zod shape above.
 */
export const askToolJsonSchema: Record<string, unknown> = {
    type: "object",
    properties: {
        questions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_QUESTIONS,
            description: "The questions to ask, in the order they should be put.",
            items: {
                type: "object",
                properties: {
                    question: {
                        type: "string",
                        description: "The question, written as a full sentence a person can answer."
                    },
                    options: {
                        type: "array",
                        description:
                            "The choices to offer. Omit entirely when the answer is free text - do not "
                            + "invent filler options for an open question.",
                        items: {
                            type: "object",
                            properties: {
                                label: {
                                    type: "string",
                                    description: "The choice as the person sees it - a few words."
                                },
                                description: {
                                    type: "string",
                                    description: "What picking this one means. Optional."
                                }
                            },
                            required: ["label"]
                        }
                    },
                    multi: {
                        type: "boolean",
                        description:
                            "True when more than one option may be picked. Ignored when there are no options."
                    }
                },
                required: ["question"]
            }
        }
    },
    required: ["questions"]
};

/**
 * The questions, asked and answered.
 *
 * Never throws. Every failure comes back as text the agent can read and
 * act on; a thrown handler would end the turn.
 *
 * One question at a time, in declared order. The whole call's answers
 * come back together as the tool's result.
 *
 * @param ask    How to put one question to the session and wait. Absent
 *               means nobody is watching - see `config.interactive`.
 * @param signal The provider's own signal for this call. It fires when
 *               the agent gives up, so the open box is closed.
 */
export async function askQuestions(
    input: AskToolInput,
    ask?: AskHook,
    signal?: AbortSignal
): Promise<string> {

    if (!ask)
        return NOT_INTERACTIVE;

    const questions = readQuestions(input);

    if (!questions.length)
        return "That call carried no question, so nobody was asked. Ask again with at least one question.";

    const answered: string[] = [];

    for (const question of questions) {

        let answer: string;

        try {

            // eslint-disable-next-line no-await-in-loop
            answer = await withSignal(ask({
                prompt: question.prompt,
                ...(question.options.length ? { options: question.options } : {}),
                ...(question.multi ? { multi: true } : {}),
                raw: input
            }).answer, signal);

        } catch (error) {

            // The session ended, the turn was stopped, or the agent gave
            // up while the box was open. Earlier answers are still sent.
            return [
                ...answered,
                `The remaining questions were not answered: ${messageOf(error)}`,
                "Proceed on a reasonable assumption and say which one you made."
            ].join("\n\n");
        }

        answered.push(`Q: ${question.prompt}\nA: ${answer.trim()}`);
    }

    return answered.join("\n\n");
}

/** One question, ready to put. */
interface Question {

    prompt: string;

    /** Empty for a free-text question. */
    options: AskOption[];

    multi: boolean;
}

/**
 * The call as a list of questions, with anything unusable dropped
 * rather than refused: a question with no text, an option with no
 * label. A question left with fewer than two options is free text.
 */
function readQuestions(input: AskToolInput): Question[] {

    const declared = Array.isArray(input?.questions) ? input.questions : [];

    const questions: Question[] = [];

    for (const one of declared.slice(0, MAX_QUESTIONS)) {

        const prompt = typeof one?.question === "string" ? one.question.trim() : "";

        if (!prompt)
            continue;

        const options: AskOption[] = (Array.isArray(one.options) ? one.options : [])
            .filter(option => typeof option?.label === "string" && option.label.trim())
            .map(option => ({
                label: option.label!.trim(),
                ...(typeof option.description === "string" && option.description.trim()
                    ? { description: option.description.trim() }
                    : {})
            }));

        // One option is not a choice, so the free-text box is offered.
        questions.push({
            prompt,
            options: options.length > 1 ? options : [],
            multi: one.multi === true && options.length > 1
        });
    }

    return questions;
}

/** The answer, or a rejection the moment the provider's own signal fires. */
function withSignal(answer: Promise<string>, signal?: AbortSignal): Promise<string> {

    if (!signal)
        return answer;

    if (signal.aborted)
        return Promise.reject(new Error("The question was cancelled."));

    return new Promise<string>((resolve, reject) => {

        const onAbort = () => reject(new Error("The question was cancelled."));

        signal.addEventListener("abort", onAbort, { once: true });

        answer.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
}

function messageOf(error: unknown): string {

    return error instanceof Error ? error.message : String(error);
}

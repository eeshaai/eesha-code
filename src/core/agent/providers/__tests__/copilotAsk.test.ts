import { describe, expect, it } from "vitest";

import { AskHook, NOT_INTERACTIVE } from "../../AgentSession";
import { ASK_TOOL_NAME } from "../askTool";
import { sessionConfig } from "../CopilotProvider";
import { askElicitation } from "../acpElicitation";

/**
 * Two ways in. The agent's own questions come through our `ask_user`
 * tool, which overrides the built-in of the same name (theirs has no
 * multi-select). An MCP server's question arrives as an elicitation,
 * the same form ACP sends, read by the same file.
 */

/** A hook that records what it was asked and answers from a script, in order. */
function scripted(answers: string[]): { hook: AskHook; asked: { prompt: string; options?: unknown }[] } {

    const asked: { prompt: string; options?: unknown }[] = [];

    const hook: AskHook = request => {

        asked.push({ prompt: request.prompt, options: request.options });

        return { askId: `ask-${asked.length}`, answer: Promise.resolve(answers[asked.length - 1]) };
    };

    return { hook, asked };
}

interface CopilotTool {

    name: string;
    overridesBuiltInTool?: boolean;
    skipPermission?: boolean;
    defer?: string;
    parameters?: Record<string, unknown>;
    handler?: (args: unknown) => Promise<unknown>;
}

function askToolOf(interactive: boolean | undefined, hook?: AskHook): CopilotTool {

    const config = sessionConfig(
        { workingDirectory: "/work", env: {}, interactive },
        undefined,
        undefined,
        hook) as unknown as { tools: CopilotTool[] };

    return config.tools.find(one => one.name === ASK_TOOL_NAME)!;
}

describe("the ask tool, as Copilot is given it", () => {

    it("replaces the built-in of the same name, and is never deferred", () => {

        const tool = askToolOf(true, scripted([]).hook);

        expect(tool.name).toBe("ask_user");
        expect(tool.overridesBuiltInTool).toBe(true);

        // A question needs no approval, and a tool hidden behind tool
        // search would never be used to ask one.
        expect(tool.skipPermission).toBe(true);
        expect(tool.defer).toBe("never");
    });

    it("routes a question through the hook when a person is watching", async () => {

        const { hook, asked } = scripted(["SQLite"]);

        const answered = await askToolOf(true, hook).handler!({
            questions: [{ question: "Which store?", options: [{ label: "SQLite" }, { label: "Postgres" }] }]
        });

        expect(asked).toHaveLength(1);
        expect(answered).toBe("Q: Which store?\nA: SQLite");
    });

    it("tells the agent to carry on when the session is not interactive, even with a hook wired", async () => {

        const { hook, asked } = scripted(["SQLite"]);

        const answered = await askToolOf(false, hook).handler!({
            questions: [{ question: "Which store?" }]
        });

        expect(asked).toEqual([]);
        expect(answered).toBe(NOT_INTERACTIVE);
    });

    it("treats a session that said nothing about a watcher as unattended - the default", async () => {

        const { hook } = scripted(["SQLite"]);

        expect(await askToolOf(undefined, hook).handler!({ questions: [{ question: "Which?" }] }))
            .toBe(NOT_INTERACTIVE);
    });
});

/**
 * Copilot's elicitation is ACP's form under another name, so the same
 * reader takes it. `enumNames` is Copilot's own spelling of a label,
 * which ACP does not have.
 */
describe("a Copilot elicitation, read by the ACP form reader", () => {

    it("reads a plain string field", async () => {

        const { hook, asked } = scripted(["payments"]);

        const answered = await askElicitation({
            mode: "form",
            message: "Which service?",
            requestedSchema: {
                properties: { service: { type: "string", title: "Service" } }
            }
        }, hook);

        expect(asked[0].prompt).toBe("Which service?\nService");
        expect(answered).toEqual({ action: "accept", content: { service: "payments" } });
    });

    it("shows enumNames as the labels, and sends the value behind them", async () => {

        const { hook, asked } = scripted(["Postgres"]);

        const answered = await askElicitation({
            mode: "form",
            message: "Pick one.",
            requestedSchema: {
                properties: {
                    store: {
                        type: "string",
                        title: "Store",
                        enum: ["sqlite", "pg"],
                        enumNames: ["SQLite", "Postgres"]
                    }
                }
            }
        }, hook);

        expect(asked[0].options).toEqual([{ label: "SQLite" }, { label: "Postgres" }]);

        // The label is what a person picked; the wire gets the value.
        expect(answered).toEqual({ action: "accept", content: { store: "pg" } });
    });

    it("falls back to the value itself when a name is missing", async () => {

        const { hook, asked } = scripted(["pg"]);

        await askElicitation({
            mode: "form",
            message: "Pick one.",
            requestedSchema: {
                properties: { store: { type: "string", enum: ["sqlite", "pg"], enumNames: ["SQLite"] } }
            }
        }, hook);

        expect(asked[0].options).toEqual([{ label: "SQLite" }, { label: "pg" }]);
    });

    it("declines when nobody is watching, rather than waiting", async () => {

        const answered = await askElicitation({
            mode: "form",
            message: "Which service?",
            requestedSchema: { properties: { service: { type: "string" } } }
        }, undefined);

        expect(answered).toEqual({ action: "decline" });
    });
});

/** The same line on the other SDK. See `claudeAsk.test.ts` for why. */
describe("the interactive system message", () => {

    function messageOf(interactive: boolean | undefined): { mode?: string; content?: string } | undefined {

        return (sessionConfig(
            { workingDirectory: "/work", env: {}, interactive },
            undefined,
            undefined,
            undefined) as unknown as { systemMessage?: { mode?: string; content?: string } }).systemMessage;
    }

    it("appends, never replaces - replace mode drops the SDK's own guardrails", () => {

        const message = messageOf(true);

        expect(message?.mode).toBe("append");
        expect(message?.content).toContain("ask_user");
    });

    it("says nothing at all when nobody is watching", () => {

        expect(messageOf(false)).toBeUndefined();
        expect(messageOf(undefined)).toBeUndefined();
    });
});

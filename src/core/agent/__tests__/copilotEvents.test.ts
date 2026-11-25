import { describe, expect, it } from "vitest";

import { AgentEvent, describeEvent, flatten } from "../AgentSession";
import { CopilotEventTranslator, copilotAttributionContext, copilotCharge } from "../providers/CopilotProvider";

/**
 * What a Copilot session says, and what a log makes of it: tool
 * completions, tool arguments, sub-agents, reasoning. Nothing here
 * touches the CLI: the translator takes plain objects.
 */

/** The SDK's event shape, as much of it as a case needs. */
function event(type: string, data: Record<string, unknown> = {}, agentId?: string) {

    return agentId ? { type, data, agentId } : { type, data };
}

/** The log line an event produces, asserting there is one at all. */
function lineOf(event: AgentEvent): string {

    const line = describeEvent(event);

    expect(line).toBeDefined();

    return flatten(line!);
}

describe("a tool call, start to finish", () => {

    /* `tool.execution_complete` is the SDK's name, not `tool.execution_end`. */
    it("translates the completion event the SDK actually sends", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", {
            toolName: "grep",
            toolCallId: "call-1",
            arguments: { pattern: "export function", path: "src" }
        }));

        const end = translator.translate(event("tool.execution_complete", {
            toolCallId: "call-1",
            success: true,
            result: { content: "12 matches" }
        }));

        expect(end.kind).toBe("tool.end");
    });

    /* The completion event carries a call id and no tool name. */
    it("names the tool the completion event does not carry", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", {
            toolName: "bash",
            toolCallId: "call-2"
        }));

        const end = translator.translate(event("tool.execution_complete", {
            toolCallId: "call-2",
            success: true
        }));

        expect(end).toMatchObject({ kind: "tool.end", tool: "bash", success: true });
        expect(end.kind === "tool.end" && end.ms).toBeGreaterThanOrEqual(0);
    });

    /*
     * This SDK asks through `onUserInputRequest`, not the event stream.
     * If a build ever puts `ask_user` on the stream, the question must
     * not be drawn twice. Same rule as Claude's.
     */
    it("draws no tool call for the agent asking a person", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("tool.execution_start", {
            toolName: "ask_user",
            toolCallId: "call-ask",
            arguments: { question: "Which colour do you prefer?" }
        }));

        expect(start.kind).toBe("other");

        const end = translator.translate(event("tool.execution_complete", {
            toolCallId: "call-ask",
            success: true
        }));

        expect(end.kind).toBe("other");
    });

    it("renders a search by its pattern, not just its directory", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("tool.execution_start", {
            toolName: "grep",
            toolCallId: "call-3",
            arguments: { pattern: "export function", path: "src", caseSensitive: false }
        }));

        expect(start.kind).toBe("tool.start");

        const detail = start.kind === "tool.start" ? start.detail ?? "" : "";

        expect(detail).toContain("pattern=export function");
        expect(detail).toContain("path=src");
        expect(detail).toContain("caseSensitive=false");
    });

    /* The "files changed" list depends on the path. */
    it("finds the file a mutating call is about", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("tool.execution_start", {
            toolName: "str_replace",
            toolCallId: "call-4",
            arguments: { path: "src/app.ts", oldString: "a", newString: "b" }
        }));

        expect(start).toMatchObject({ kind: "tool.start", path: "src/app.ts" });
    });

    /* The call as sent goes under the summary line in the log. */
    it("logs the call as the SDK sent it under the summary", () => {

        const data = { toolName: "str_replace", toolCallId: "call-r", arguments: { path: "src/app.ts", oldString: "a", newString: "b" } };

        const lines = lineOf(new CopilotEventTranslator().translate(event("tool.execution_start", data))).split("\n");

        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe(JSON.stringify(data));
    });

    /* The name the "turn off" setting takes, to be copied from the log. */
    it("puts Copilot's own tool name on the summary line", () => {

        const start = new CopilotEventTranslator().translate(event("tool.execution_start", {
            toolName: "view", toolCallId: "call-n", arguments: { path: "src/app.ts" }
        }));

        expect(start).toMatchObject({ kind: "tool.start", toolName: "view" });
        expect(lineOf(start).split("\n")[0]).toMatch(/^.+ \(view\): /);
    });

    it("prefers the command the shell will really run", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("tool.execution_start", {
            toolName: "bash",
            toolCallId: "call-5",
            arguments: { command: "cd /repo && npm run build" },
            shellToolInfo: { displayCommand: "npm run build", possiblePaths: [] }
        }));

        expect(start.kind === "tool.start" && start.detail).toBe("npm run build");
    });

    it("carries the reason a tool call failed", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", { toolName: "view", toolCallId: "call-6" }));

        const end = translator.translate(event("tool.execution_complete", {
            toolCallId: "call-6",
            success: false,
            error: { code: "ENOENT", message: "no such file: nope.ts" }
        }));

        expect(lineOf(end)).toContain("view failed");
        expect(lineOf(end)).toContain("ENOENT: no such file: nope.ts");
    });

    it("flattens and caps an argument that runs to pages", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("tool.execution_start", {
            toolName: "create",
            toolCallId: "call-7",
            arguments: { path: "big.txt", content: "x\n".repeat(5000) }
        }));

        const detail = start.kind === "tool.start" ? start.detail ?? "" : "";

        expect(detail).not.toContain("\n");
        expect(detail.length).toBeLessThan(1000);
        expect(detail).toContain("path=big.txt");
    });
});

describe("sub-agents", () => {

    /* The CLI spawns `task` and `explore` agents on its own. */
    it("announces a sub-agent and credits its work to it", () => {

        const translator = new CopilotEventTranslator();

        const started = translator.translate(event("subagent.started", {
            agentDisplayName: "Explore",
            agentName: "explore",
            agentDescription: "Search the codebase",
            toolCallId: "spawn-1",
            model: "claude-sonnet-4.5"
        }, "agent-a"));

        expect(started.kind).toBe("notice");
        expect(lineOf(started))
            .toBe("Sub-agent Explore started: Search the codebase (model claude-sonnet-4.5)");

        // Unattributed on purpose: the event is tagged with the id of
        // the agent it announces, which would give
        // "[Explore] Sub-agent Explore started".
        expect(started.agent).toBeUndefined();

        const bridged = translator.translate(event("tool.execution_start", {
            toolName: "grep",
            toolCallId: "call-8",
            arguments: { pattern: "settleTurn" }
        }, "agent-a"));

        expect(bridged.agent).toBe("Explore");
        expect(lineOf(bridged).split("\n")[0]).toBe("[Explore] Searching 'settleTurn' (grep): pattern=settleTurn");
    });

    /** The spawning call's id is the fallback key when the instance id is not the one used. */
    it("credits work that only points back at the spawning call", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("subagent.started", {
            agentDisplayName: "Task",
            toolCallId: "spawn-2"
        }));

        const bridged = translator.translate(event("assistant.message", {
            content: "Found it.",
            parentToolCallId: "spawn-2"
        }, "agent-b"));

        expect(bridged.agent).toBe("Task");
    });

    /* An unknown id is still not the main agent. */
    it("marks a bridged event even when it never saw the sub-agent start", () => {

        const translator = new CopilotEventTranslator();

        const bridged = translator.translate(
            event("assistant.message", { content: "Done." }, "abcdef1234567890"));

        expect(bridged.agent).toBe("sub-agent abcdef12");
    });

    it("reports what a sub-agent cost when it finishes", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("subagent.started",
            { agentDisplayName: "Explore", toolCallId: "spawn-3" }, "agent-c"));

        const done = translator.translate(event("subagent.completed", {
            agentDisplayName: "Explore",
            toolCallId: "spawn-3",
            totalToolCalls: 8,
            totalTokens: 12300,
            durationMs: 41000
        }, "agent-c"));

        expect(lineOf(done))
            .toContain("Sub-agent Explore finished - 8 tool calls, 12.3k tokens, 41.0s");
    });

    it("puts a failed sub-agent on the error stream", () => {

        const translator = new CopilotEventTranslator();

        const failed = translator.translate(event("subagent.failed", {
            agentDisplayName: "Task",
            error: "the model refused"
        }));

        expect(failed.kind).toBe("error");
        expect(describeEvent(failed)?.stream).toBe("stderr");
        expect(lineOf(failed)).toBe("Sub-agent Task failed: the model refused");
    });

    /* A sub-agent going quiet is not the turn ending. `untilIdle` waits on this. */
    it("does not let a sub-agent's idle end the conversation", () => {

        const translator = new CopilotEventTranslator();

        expect(translator.translate(event("session.idle", {}, "agent-d")).kind).toBe("other");
        expect(translator.translate(event("session.idle")).kind).toBe("idle");
    });
});

describe("everything else the runtime does", () => {

    it("shows the model's thinking as its own kind", () => {

        const translator = new CopilotEventTranslator();

        const thought = translator.translate(
            event("assistant.reasoning", { content: "The target file may not exist yet." }));

        expect(thought).toMatchObject({ kind: "reasoning" });
        expect(lineOf(thought)).toBe("Thinking: The target file may not exist yet.");
        expect(describeEvent(thought)?.stream).toBe("system");
    });

    /* Without this, a compacted agent looks like one that forgot. */
    it("says when the conversation was compacted", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("session.compaction_start",
            { currentTokens: 180000, tokenLimit: 200000 }));

        expect(lineOf(start)).toBe("Compacting the conversation (180.0k tokens of 200.0k).");
    });

    it("says when an MCP server changes state", () => {

        const translator = new CopilotEventTranslator();

        const changed = translator.translate(event("session.mcp_server_status_changed",
            { serverName: "ado", status: "failed", error: "connection refused" }));

        expect(lineOf(changed)).toBe("MCP server ado: failed - connection refused");
    });

    /** With `model: auto`, this is the only place the real model is named. */
    it("reports what a model call cost", () => {

        const translator = new CopilotEventTranslator();

        const usage = translator.translate(event("assistant.usage",
            { model: "gpt-5", inputTokens: 24100, outputTokens: 812, duration: 1900 }));

        expect(lineOf(usage)).toBe("Model call gpt-5 - 24.1k in, 812 out, 1.9s");
        expect(usage).not.toHaveProperty("cost");
    });

    /**
     * Copilot bills two ways and sends both: the premium-request
     * multiplier and the AI-credit charge in nano-units. Both go on the
     * line and beside it as figures, so whichever plan the account is
     * on, the number that matters is there.
     */
    it("carries what a model call charged, in credits and premium requests", () => {

        const translator = new CopilotEventTranslator();

        const usage = translator.translate(event("assistant.usage",
            { model: "claude-opus-4", inputTokens: 100, outputTokens: 10, cost: 3, copilotUsage: { totalNanoAiu: 1250000000 } }));

        expect(lineOf(usage)).toBe("Model call claude-opus-4 - 100 in, 10 out - 1.25 credits, 3 premium requests");
        expect(usage).toMatchObject({ cost: [{ amount: 1.25, unit: "credits" }, { amount: 3, unit: "premium requests" }] });

        // One call is one model, so the call itself is the split.
        expect(usage).toMatchObject({
            models: [{
                model: "claude-opus-4",
                cost: [{ amount: 1.25, unit: "credits" }, { amount: 3, unit: "premium requests" }],
                inputTokens: 100,
                outputTokens: 10
            }]
        });
    });

    /* The `hideCopilotPremiumRequests` feature flag: credits only. */
    it("leaves premium requests out when told to, and keeps the credits", () => {

        const usage = new CopilotEventTranslator(() => 0, true).translate(event("assistant.usage",
            { model: "claude-opus-4", inputTokens: 100, outputTokens: 10, cost: 3, copilotUsage: { totalNanoAiu: 1250000000 } }));

        expect(lineOf(usage)).toBe("Model call claude-opus-4 - 100 in, 10 out - 1.25 credits");
        expect(usage).toMatchObject({ cost: [{ amount: 1.25, unit: "credits" }] });
        expect(copilotCharge({ cost: 3, copilotUsage: { totalNanoAiu: 1250000000 } }, true))
            .toEqual([{ amount: 1.25, unit: "credits" }]);
    });

    it("counts what the model read once - cache reads and writes are already inside Copilot's input", () => {

        const usage = new CopilotEventTranslator().translate(event("assistant.usage",
            { model: "gpt-5", inputTokens: 36445, cacheReadTokens: 26242, cacheWriteTokens: 10199, outputTokens: 10 }));

        expect(usage).toMatchObject({ models: [{ model: "gpt-5", inputTokens: 36445, outputTokens: 10, cachedTokens: 26242 }] });
    });

    it("counts each usage event as one model call", () => {

        const usage = new CopilotEventTranslator().translate(event("assistant.usage", { inputTokens: 100, outputTokens: 10 }));

        expect(usage).toMatchObject({ calls: 1 });
    });

    it("carries no split when the call named no model", () => {

        const usage = new CopilotEventTranslator().translate(event("assistant.usage", { inputTokens: 100, outputTokens: 10 }));

        expect(usage).not.toHaveProperty("models");
    });

    it("reports how full the context window is, with the CLI's three buckets", () => {

        const translator = new CopilotEventTranslator();

        const info = translator.translate(event("session.usage_info", {
            currentTokens: 42000, tokenLimit: 128000, systemTokens: 3000, toolDefinitionsTokens: 9000, conversationTokens: 30000
        }));

        expect(lineOf(info)).toBe("Context 33% of 128.0k tokens used");
        expect(info).toMatchObject({
            kind: "notice",
            progress: true,
            context: {
                used: 42000,
                size: 128000,
                parts: [
                    { name: "System prompt", tokens: 3000 },
                    { name: "Tool definitions", tokens: 9000 },
                    { name: "Conversation", tokens: 30000 }
                ]
            }
        });
    });

    it("passes a usage_info without a window size through as other", () => {

        const translator = new CopilotEventTranslator();

        expect(translator.translate(event("session.usage_info", { messagesLength: 4 })).kind).toBe("other");
    });

    it("passes an unknown event through with its payload", () => {

        const raw = event("session.something_new", { whatever: 1 });

        const passed = new CopilotEventTranslator().translate(raw);

        expect(passed).toMatchObject({ kind: "other", name: "session.something_new", raw });
        expect(describeEvent(passed)).toBeUndefined();
    });
});

/*
 * A server tool's name says where the call went, not what the agent
 * wanted. Copilot's MCP client sends that as `__tool_use_purpose`.
 */
describe("an MCP call that said why it was made", () => {

    it("titles the row with the purpose instead of the tool name", () => {

        const start = new CopilotEventTranslator().translate(event("tool.execution_start", {
            toolName: "search_issues",
            toolCallId: "call-p1",
            mcpServerName: "github",
            arguments: { __tool_use_purpose: "Find the issue about the failing build", query: "build" }
        }));

        expect(start).toMatchObject({ kind: "tool.start", tool: "github/Find the issue about the failing build" });
    });

    it("drops the purpose from the arguments", () => {

        const start = new CopilotEventTranslator().translate(event("tool.execution_start", {
            toolName: "search_issues",
            toolCallId: "call-p2",
            mcpServerName: "github",
            arguments: { __tool_use_purpose: "Find the issue", query: "build" }
        }));

        expect(start.kind === "tool.start" && start.detail).toBe("query=build");
    });

    it("drops the server tag once the title carries the server", () => {

        const start = new CopilotEventTranslator().translate(event("tool.execution_start", {
            toolName: "search_issues",
            toolCallId: "call-p3",
            mcpServerName: "github",
            arguments: { __tool_use_purpose: "Find the issue", query: "build" }
        }));

        expect(start.kind === "tool.start" && start.detail).not.toContain("[github]");
    });

    it("leaves a call that carried no purpose alone", () => {

        const start = new CopilotEventTranslator().translate(event("tool.execution_start", {
            toolName: "search_issues",
            toolCallId: "call-p4",
            mcpServerName: "github",
            arguments: { query: "build" }
        }));

        expect(start).toMatchObject({ kind: "tool.start", tool: "search_issues" });
        expect(start.kind === "tool.start" && start.detail).toBe("[github] query=build");
    });

    /* Both halves of the call are one row. */
    it("titles the completion the same as the start", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", {
            toolName: "search_issues",
            toolCallId: "call-p5",
            mcpServerName: "github",
            arguments: { __tool_use_purpose: "Find the issue" }
        }));

        const end = translator.translate(event("tool.execution_complete", {
            toolCallId: "call-p5",
            success: true
        }));

        expect(end).toMatchObject({ kind: "tool.end", tool: "github/Find the issue" });
    });
});

/**
 * A running command's output. The translator is the whole of the
 * feature on the engine side: it turns the CLI's partial-result events
 * into `tool.output` events.
 */
describe("a running tool's output", () => {

    /** A translator with a clock a test can move. */
    function live(clock: { at: number }) {

        return new CopilotEventTranslator(() => clock.at);
    }

    it("carries everything the call has printed, not just the newest piece", () => {

        const clock = { at: 1000 };
        const translator = live(clock);

        translator.translate(event("tool.execution_start", {
            toolName: "bash",
            toolCallId: "call-1"
        }));

        const first = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "Building...\n"
        }));

        // Past the throttle, so the second piece publishes too.
        clock.at += 1000;

        const second = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "Done.\n"
        }));

        expect(first).toMatchObject({
            kind: "tool.output",
            callId: "call-1",
            tool: "bash",
            text: "Building...\n"
        });

        expect(second).toMatchObject({ kind: "tool.output", text: "Building...\nDone.\n" });
    });

    /* Ten a second at most, the same as a message delta. */
    it("drops a chunk that arrives inside the throttle, keeping its text", () => {

        const clock = { at: 1000 };
        const translator = live(clock);

        translator.translate(event("tool.execution_start", { toolName: "bash", toolCallId: "call-1" }));

        translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "one\n"
        }));

        const dropped = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "two\n"
        }));

        clock.at += 1000;

        const published = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "three\n"
        }));

        expect(dropped.kind).toBe("other");

        // Nothing was lost by the drop: the next event carries it.
        expect(published).toMatchObject({ kind: "tool.output", text: "one\ntwo\nthree\n" });
    });

    it("keeps the tail of an output too big to carry whole", () => {

        const clock = { at: 1000 };
        const translator = live(clock);

        translator.translate(event("tool.execution_start", { toolName: "bash", toolCallId: "call-1" }));

        translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "x".repeat(9000)
        }));

        clock.at += 1000;

        const printed = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "the end"
        }));

        expect(printed.kind === "tool.output" && printed.text.length).toBe(8000);
        expect(printed.kind === "tool.output" && printed.text.endsWith("the end")).toBe(true);
    });

    /* A second call reusing the id must not inherit the first's output. */
    it("forgets a call's output once the call has finished", () => {

        const clock = { at: 1000 };
        const translator = live(clock);

        translator.translate(event("tool.execution_start", { toolName: "bash", toolCallId: "call-1" }));

        translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "first run\n"
        }));

        translator.translate(event("tool.execution_complete", { toolCallId: "call-1", success: true }));

        clock.at += 1000;

        translator.translate(event("tool.execution_start", { toolName: "bash", toolCallId: "call-1" }));

        clock.at += 1000;

        const printed = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "second run\n"
        }));

        expect(printed).toMatchObject({ kind: "tool.output", text: "second run\n" });
    });

    it("keeps output out of the question the agent asked", () => {

        const clock = { at: 1000 };
        const translator = live(clock);

        translator.translate(event("tool.execution_start", { toolName: "ask_user", toolCallId: "call-1" }));

        const printed = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "anything"
        }));

        expect(printed.kind).toBe("other");
    });

    /* Painted, never stored - the same rule a message delta follows. */
    it("makes a line that never reaches the log", () => {

        const clock = { at: 1000 };
        const translator = live(clock);

        translator.translate(event("tool.execution_start", { toolName: "bash", toolCallId: "call-1" }));

        const printed = translator.translate(event("tool.execution_partial_result", {
            toolCallId: "call-1",
            partialOutput: "Building...\n"
        }));

        expect(describeEvent(printed)).toMatchObject({
            kind: "tool.output",
            callId: "call-1",
            tool: "bash",
            ephemeral: true,
            stream: "system"
        });
    });
});

/*
 * The CLI's `/context` breakdown, read after a turn: rows from its own
 * categories, tools split into built-in and MCP by the tool list, and
 * the heaviest messages under Messages. Shapes as observed on SDK 1.0.14.
 */
describe("copilotAttributionContext", () => {

    const attribution = {
        totalTokens: 11338,
        promptTokenLimit: 128000,
        categories: { systemPrompt: 5627, customInstructions: 0, systemTools: 4313, mcpTools: 1126, messages: 272 },
        entries: [
            { kind: "system", label: "System prompt", tokens: 5627 },
            { kind: "system", label: "Tool definitions", tokens: 5439 },
            { kind: "toolDefinition", label: "view", tokens: 198 },
            { kind: "toolDefinition", label: "powershell", tokens: 627 },
            { kind: "toolDefinition", label: "github-mcp-server-search_code", tokens: 390 },
            { kind: "toolDefinition", label: "empty", tokens: 0 }
        ]
    };

    const tools = [
        { name: "view" },
        { name: "powershell" },
        { name: "github-mcp-server-search_code", mcpServerName: "github-mcp-server", mcpToolName: "search_code" }
    ];

    it("splits tools into built-in and MCP and lists the heaviest messages, biggest first", () => {

        const context = copilotAttributionContext(attribution, tools, [
            { label: "asst: -> view", tokens: 51 },
            { label: "skill: customize-cloud-agent", tokens: 3886 }
        ]);

        expect(context).toEqual({
            used: 11338,
            size: 128000,
            parts: [
                { name: "System prompt", tokens: 5627 },
                { name: "System tools", tokens: 4313, items: [{ name: "powershell", tokens: 627 }, { name: "view", tokens: 198 }] },
                { name: "MCP tools", tokens: 1126, items: [{ name: "github-mcp-server: search_code", tokens: 390 }] },
                { name: "Messages", tokens: 272, items: [{ name: "skill: customize-cloud-agent", tokens: 3886 }, { name: "asst: -> view", tokens: 51 }] }
            ]
        });
    });

    it("lists no tools when the tool list could not be read, so no MCP tool is shown as built-in", () => {

        const parts = copilotAttributionContext(attribution, undefined, undefined)?.parts;

        expect(parts?.find(part => part.name === "System tools")?.items).toBeUndefined();
        expect(parts?.find(part => part.name === "MCP tools")?.items).toBeUndefined();
    });

    it("is nothing before the session has started", () => {

        expect(copilotAttributionContext(null, tools, [])).toBeUndefined();
        expect(copilotAttributionContext({ totalTokens: 5 }, tools, [])).toBeUndefined();
    });
});

import { describe, expect, it } from "vitest";

import { AgentEvent, describeEvent, flatten } from "../AgentSession";
import { ClaudeEventTranslator, contextUsageOf } from "../providers/ClaudeProvider";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * What a Claude session says, and what a log makes of it: thinking,
 * sub-agents, tool arguments and results, retries, compaction,
 * refusals, denied permissions. Nothing here touches the CLI: the
 * translator takes plain objects.
 */

/** One log line, asserting there is one at all. */
function lineOf(event: AgentEvent | undefined): string {

    expect(event).toBeDefined();

    const line = describeEvent(event!);

    expect(line).toBeDefined();

    return flatten(line!);
}

/** The first event of a kind, which is what each case here is about. */
function firstOf(events: AgentEvent[], kind: string): AgentEvent | undefined {

    return events.find(event => event.kind === kind);
}

/**
 * The Claude translator, with fixtures naming only the fields the case
 * is about. `SDKMessage` members carry many required fields (`uuid`,
 * `session_id`, the whole `BetaMessage`), so the cast lives here once.
 */
function claude(now?: () => number): { translate(fixture: unknown): AgentEvent[] } {

    const translator = new ClaudeEventTranslator(now);

    return { translate: fixture => translator.translate(fixture as SDKMessage) };
}

describe("what the agent said and did", () => {

    it("shows the model's thinking as its own kind", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
                content: [
                    { type: "thinking", thinking: "The target file may not exist yet." },
                    { type: "text", text: "I will create it." }
                ]
            }
        });

        expect(events.map(event => event.kind)).toEqual(["reasoning", "message"]);
        expect(lineOf(events[0])).toBe("Thinking: The target file may not exist yet.");
        expect(describeEvent(events[0])?.stream).toBe("system");
        expect(describeEvent(events[1])?.stream).toBe("stdout");
    });

    it("renders a search by its pattern, not just its directory", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
                content: [{
                    type: "tool_use",
                    id: "toolu_1",
                    name: "Grep",
                    input: { pattern: "export function", path: "src", output_mode: "content" }
                }]
            }
        });

        const detail = events[0].kind === "tool.start" ? events[0].detail ?? "" : "";

        expect(detail).toContain("pattern=export function");
        expect(detail).toContain("path=src");
        expect(detail).toContain("output_mode=content");
    });

    /* The "files changed" list depends on the path. */
    it("finds the file a mutating call is about", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
                content: [{
                    type: "tool_use",
                    id: "toolu_2",
                    name: "Edit",
                    input: { file_path: "src/app.ts", old_string: "a", new_string: "b" }
                }]
            }
        });

        expect(events[0]).toMatchObject({ kind: "tool.start", path: "src/app.ts" });
    });

    /* The call as sent goes under the summary line in the log. */
    it("logs the call as the SDK sent it under the summary", () => {

        const block = { type: "tool_use", id: "toolu_r", name: "Edit", input: { file_path: "src/app.ts", old_string: "a", new_string: "b" } };

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [block] }
        } as unknown as SDKMessage);

        const lines = lineOf(firstOf(events, "tool.start")).split("\n");

        expect(lines).toHaveLength(2);
        expect(lines[1]).toBe(JSON.stringify(block));
    });

    /* The name the "turn off" setting takes, to be copied from the log. */
    it("puts Claude's own tool name on the summary line", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "toolu_n", name: "Read", input: { file_path: "src/app.ts" } }] }
        } as unknown as SDKMessage);

        const start = firstOf(events, "tool.start");

        expect(start).toMatchObject({ kind: "tool.start", toolName: "Read" });
        expect(lineOf(start).split("\n")[0]).toMatch(/^.+ \(Read\): /);
    });

    it("says how a tool call turned out", () => {

        const translator = claude();

        translator.translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: {} }] }
        });

        const events = translator.translate({
            type: "user",
            parent_tool_use_id: null,
            message: {
                content: [{
                    type: "tool_result",
                    tool_use_id: "toolu_3",
                    content: "12 files changed"
                }]
            }
        });

        expect(events[0]).toMatchObject({ kind: "tool.end", tool: "Bash", success: true });
        expect(lineOf(events[0])).toContain("Bash done in");
        expect(lineOf(events[0])).toContain("12 files changed");
    });

    it("marks a failed tool call as failed, with what it said", () => {

        const translator = claude();

        translator.translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "toolu_4", name: "Read", input: {} }] }
        });

        const events = translator.translate({
            type: "user",
            parent_tool_use_id: null,
            message: {
                content: [{
                    type: "tool_result",
                    tool_use_id: "toolu_4",
                    is_error: true,
                    content: [{ type: "text", text: "File does not exist: nope.ts" }]
                }]
            }
        });

        expect(events[0]).toMatchObject({ kind: "tool.end", tool: "Read", success: false });
        expect(lineOf(events[0])).toContain("Read failed");
        expect(lineOf(events[0])).toContain("File does not exist: nope.ts");
    });

    /*
     * The question is drawn as a card. It is also a tool call on the
     * wire; drawing both would put the same question on screen twice.
     */
    it("draws no tool call for the agent asking a person", () => {

        const translator = claude();

        const started = translator.translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: {
                content: [{
                    type: "tool_use",
                    id: "toolu_ask",
                    name: "mcp__eesha__ask_user",
                    input: { questions: [{ question: "Which colour do you prefer?" }] }
                }]
            }
        });

        expect(started).toEqual([]);

        const ended = translator.translate({
            type: "user",
            parent_tool_use_id: null,
            message: {
                content: [{ type: "tool_result", tool_use_id: "toolu_ask", content: "Green" }]
            }
        });

        expect(ended).toEqual([]);
    });

    it("draws a tool whose name only resembles the asking one", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "tool_use", id: "toolu_5", name: "ask_user_docs", input: {} }] }
        });

        expect(events[0]).toMatchObject({ kind: "tool.start", tool: "ask_user_docs" });
    });
});

describe("sub-agents", () => {

    it("announces a sub-agent starting and finishing", () => {

        const translator = claude();

        const started = translator.translate({
            type: "system",
            subtype: "task_started",
            task_id: "task-1",
            tool_use_id: "toolu_9",
            subagent_type: "Explore",
            description: "Search the codebase"
        });

        expect(lineOf(started[0])).toBe("Sub-agent Explore started: Search the codebase");

        const done = translator.translate({
            type: "system",
            subtype: "task_notification",
            task_id: "task-1",
            tool_use_id: "toolu_9",
            status: "completed",
            summary: "Found four call sites.",
            usage: { total_tokens: 12300, tool_uses: 8, duration_ms: 41000 }
        });

        expect(lineOf(done[0]))
            .toBe("Sub-agent Explore completed - 8 tool calls, 12.3k tokens, 41.0s: "
                + "Found four call sites.");
    });

    /* The SDK stamps a sub-agent's own messages with `subagent_type`. */
    it("credits a sub-agent's own work to it", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: "toolu_9",
            subagent_type: "Explore",
            message: {
                content: [{ type: "tool_use", id: "toolu_10", name: "Grep", input: { pattern: "x" } }]
            }
        });

        expect(events[0].agent).toBe("Explore");
        expect(lineOf(events[0]).split("\n")[0]).toBe("[Explore] Searching 'x' (Grep): pattern=x");
    });

    /** When only the parent call id is stamped, the task's own start supplies the label. */
    it("credits a forwarded message that names only the call that spawned it", () => {

        const translator = claude();

        translator.translate({
            type: "system",
            subtype: "task_started",
            task_id: "task-2",
            tool_use_id: "toolu_11",
            subagent_type: "general-purpose",
            description: "Refactor"
        });

        const events = translator.translate({
            type: "assistant",
            parent_tool_use_id: "toolu_11",
            message: { content: [{ type: "text", text: "Done." }] }
        });

        expect(events[0].agent).toBe("general-purpose");
    });

    /* An unknown parent is still not the main agent. */
    it("marks a forwarded message even when it never saw the task start", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: "toolu_abcdef123456",
            message: { content: [{ type: "text", text: "Done." }] }
        });

        expect(events[0].agent).toBe("sub-agent toolu_ab");
    });

    it("leaves the main agent's own work uncredited", () => {

        const events = claude().translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "Done." }] }
        });

        expect(events[0].agent).toBeUndefined();
        expect(lineOf(events[0])).toBe("[AGENT]: Done.");
    });

    it("puts a failed sub-agent on the error stream", () => {

        const events = claude().translate({
            type: "system",
            subtype: "task_notification",
            task_id: "task-3",
            subagent_type: "Explore",
            status: "failed",
            summary: "ran out of context"
        });

        expect(events[0].kind).toBe("error");
        expect(describeEvent(events[0])?.stream).toBe("stderr");
    });
});

describe("everything else the runtime does", () => {

    /* Without this, a turn that takes four minutes looks like a hang. */
    it("says when an API call is being retried", () => {

        const events = claude().translate({
            type: "system",
            subtype: "api_retry",
            attempt: 2,
            max_retries: 5,
            retry_delay_ms: 8000,
            error_status: 529,
            error: "overloaded"
        });

        expect(lineOf(events[0]))
            .toBe("Retrying the API call (attempt 2 of 5), status 529: overloaded "
                + "- waiting 8.0s.");
    });

    /* Without this, a compacted agent looks like one that forgot. */
    it("says when the conversation was compacted", () => {

        const events = claude().translate({
            type: "system",
            subtype: "compact_boundary",
            compact_metadata: { trigger: "auto", pre_tokens: 180000, post_tokens: 42000 }
        });

        expect(lineOf(events[0]))
            .toBe("Conversation compacted (auto) - 180.0k before, 42.0k after.");
    });

    /* After a refusal the turn ends and nothing else says why. */
    it("puts a refusal with no fallback on the error stream", () => {

        const events = claude().translate({
            type: "system",
            subtype: "model_refusal_no_fallback",
            original_model: "claude-opus-4",
            api_refusal_explanation: "the request was declined"
        });

        expect(events[0].kind).toBe("error");
        expect(lineOf(events[0]))
            .toBe("claude-opus-4 refused and there is no fallback: the request was declined");
    });

    /* This provider approves every tool call, so a denial came from a hook or policy. */
    it("says when a tool was refused by something other than us", () => {

        const events = claude().translate({
            type: "system",
            subtype: "permission_denied",
            tool_name: "Bash",
            message: "blocked by a PreToolUse hook"
        } as never);

        expect(lineOf(events[0])).toBe("Permission denied for Bash: blocked by a PreToolUse hook");
    });

    it("names the credential and any MCP server that did not come up", () => {

        const events = claude().translate({
            type: "system",
            subtype: "init",
            session_id: "abc",
            model: "claude-opus-4",
            apiKeySource: "ANTHROPIC_API_KEY",
            tools: ["Read", "mcp__eesha__ask_user"],
            mcp_servers: [
                { name: "ado", status: "failed" },
                { name: "github", status: "connected" }
            ]
        });

        expect(lineOf(events[0]))
            .toBe("Claude session abc: model=claude-opus-4 apiKeySource=ANTHROPIC_API_KEY "
                + "ask tool=mcp__eesha__ask_user "
                + "- MCP servers not connected: ado (failed)");
    });

    /*
     * Without the ask tool, a turn writes its questions as prose and
     * stops, which looks like the model ignoring an instruction.
     */
    it("says so when the agent was never given the ask tool", () => {

        const events = claude().translate({
            type: "system",
            subtype: "init",
            session_id: "abc",
            model: "claude-opus-4",
            apiKeySource: "none",
            tools: ["Read", "Write"]
        });

        expect(lineOf(events[0])).toContain("ask tool=MISSING");
    });

    /* An event, not a log call, so every surface watching the conversation gets it. */
    it("reports what the turn cost, then goes idle", () => {

        const events = claude().translate({
            type: "result",
            subtype: "success",
            usage: { input_tokens: 1000, cache_read_input_tokens: 23100, output_tokens: 812 },
            total_cost_usd: 0.1234,
            num_turns: 3,
            duration_ms: 41000
        });

        expect(events.map(event => event.kind)).toEqual(["notice", "idle"]);
        expect(lineOf(events[0]))
            .toBe("Turn finished - tokens in=24100 out=812 cost=$0.1234 turns=3 took=41.0s");

        // The SDK's round trips in the turn, for the Usage panel.
        expect(events[0]).toMatchObject({ calls: 3 });
    });

    /**
     * The SDK's dollar figure is a running total for the process, so
     * the bill carries only what the turn added - a surface adding
     * bills up then never counts a dollar twice.
     */
    it("charges each turn the difference from the running total", () => {

        const translator = claude();

        const result = (total: number) => translator.translate({
            type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: total
        })[0];

        expect(result(0.1825)).toMatchObject({ cost: [{ amount: 0.1825, unit: "USD" }] });
        expect(result(0.6958)).toMatchObject({ cost: [{ amount: expect.closeTo(0.5133, 6), unit: "USD" }] });

        // A smaller total is the CLI having reset its counter.
        expect(result(0.02)).toMatchObject({ cost: [{ amount: 0.02, unit: "USD" }] });
    });

    /**
     * `modelUsage` is cumulative like the total beside it, so a second
     * turn on the same model reports only what that turn added - and a
     * model that did not run in this turn is left out entirely.
     */
    it("splits each turn's charge by the model that ran, as a difference", () => {

        const translator = claude();

        const result = (modelUsage: unknown) => translator.translate({
            type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 1, modelUsage
        })[0];

        const first = result({
            "claude-opus-5": { costUSD: 0.17, inputTokens: 80000, cacheReadInputTokens: 4000, outputTokens: 243 },
            "claude-haiku-4-5": { costUSD: 0.01, inputTokens: 9000, outputTokens: 120 }
        });

        expect(first).toMatchObject({
            models: [
                { model: "claude-opus-5", cost: [{ amount: expect.closeTo(0.17, 6) }], inputTokens: 84000, cachedTokens: 4000, outputTokens: 243 },
                { model: "claude-haiku-4-5", cost: [{ amount: expect.closeTo(0.01, 6) }], inputTokens: 9000, outputTokens: 120 }
            ]
        });

        // Haiku read nothing from the cache, so it has no cached figure.
        expect((first as { models: object[] }).models[1]).not.toHaveProperty("cachedTokens");

        // Opus ran again; Haiku's totals did not move, so it is not listed.
        const second = result({
            "claude-opus-5": { costUSD: 0.68, inputTokens: 80000, cacheReadInputTokens: 864000, outputTokens: 17019 },
            "claude-haiku-4-5": { costUSD: 0.01, inputTokens: 9000, outputTokens: 120 }
        });

        expect(second).toMatchObject({
            models: [
                { model: "claude-opus-5", cost: [{ amount: expect.closeTo(0.51, 6) }], inputTokens: 860000, cachedTokens: 860000, outputTokens: 16776 }
            ]
        });
    });

    /** The id the pricing was looked up under is the one worth showing. */
    it("names a model by its canonical id when the SDK gives one", () => {

        const [notice] = claude().translate({
            type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 1,
            modelUsage: { "us.anthropic.claude-opus-5-v1:0": { costUSD: 0.5, canonicalModel: "claude-opus-5" } }
        });

        expect(notice).toMatchObject({ models: [{ model: "claude-opus-5" }] });
    });

    it("carries no split when the SDK named no model", () => {

        const [notice] = claude().translate({
            type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 1
        });

        expect(notice).not.toHaveProperty("models");
    });

    it("carries no charge when the SDK sent no dollar figure", () => {

        const [notice] = claude().translate({
            type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, num_turns: 1
        });

        expect(notice).not.toHaveProperty("cost");
    });

    it("reports a failed turn as an error, and still goes idle", () => {

        const events = claude().translate({
            type: "result",
            subtype: "success",
            is_error: true,
            result: "the API returned 500"
        });

        expect(events.map(event => event.kind)).toEqual(["error", "idle"]);
        expect(lineOf(events[0])).toBe("the API returned 500");
    });

    it("passes an unknown message through with its payload", () => {

        const raw = { type: "system", subtype: "something_new" };

        const events = claude().translate(raw);

        expect(events[0]).toMatchObject({ kind: "other", name: "system/something_new", raw });
        expect(describeEvent(events[0])).toBeUndefined();
    });
});

/* The purpose argument, with this SDK's MCP tool name spelling: `mcp__server__tool`. */
describe("an MCP call that said why it was made", () => {

    it("titles the row with the purpose, keeping the server", () => {

        const events = claude().translate({
            type: "assistant",
            message: {
                content: [{
                    type: "tool_use",
                    id: "call-p1",
                    name: "mcp__github__search_issues",
                    input: { __tool_use_purpose: "Find the failing build", query: "build" }
                }]
            }
        });

        expect(firstOf(events, "tool.start")).toMatchObject({
            tool: "github/Find the failing build",
            detail: "query=build"
        });
    });

    /* No purpose, so no `server/` prefix: the built-in gets its plain-words label and nothing more. */
    it("leaves a built-in tool alone", () => {

        const events = claude().translate({
            type: "assistant",
            message: {
                content: [{ type: "tool_use", id: "call-p2", name: "Bash", input: { command: "ls" } }]
            }
        });

        expect(firstOf(events, "tool.start")).toMatchObject({ tool: "Executing 'ls'", detail: "command=ls" });
    });
});

describe("contextUsageOf", () => {

    it("keeps what is in the window and drops free space, buffers and deferred tools", () => {

        expect(contextUsageOf({
            totalTokens: 84000,
            rawMaxTokens: 200000,
            categories: [
                { name: "System prompt", tokens: 3000 },
                { name: "System tools", tokens: 12000 },
                { name: "MCP tools (deferred)", tokens: 9000, isDeferred: true },
                { name: "Memory files", tokens: 0 },
                { name: "Messages", tokens: 69000 },
                { name: "Free space", tokens: 116000 },
                { name: "Autocompact buffer", tokens: 33000 }
            ]
        })).toEqual({
            used: 84000,
            size: 200000,
            parts: [
                { name: "System prompt", tokens: 3000 },
                { name: "System tools", tokens: 12000 },
                { name: "Messages", tokens: 69000 }
            ]
        });
    });

    it("opens each part into what is inside it, biggest first", () => {

        const context = contextUsageOf({
            totalTokens: 49000,
            rawMaxTokens: 400000,
            categories: [
                { name: "System prompt", tokens: 3000, kind: "used" },
                { name: "System tools", tokens: 21500, kind: "used" },
                { name: "MCP tools", tokens: 900, kind: "used" },
                { name: "MCP tools (deferred)", tokens: 9000, kind: "deferred" },
                { name: "Memory files", tokens: 11500, kind: "used" },
                { name: "Skills", tokens: 9800, kind: "used" },
                { name: "Custom agents", tokens: 300, kind: "used" },
                { name: "Messages", tokens: 2500, kind: "used" },
                { name: "Free space", tokens: 318000, kind: "free" },
                { name: "Autocompact buffer", tokens: 33000, kind: "buffer" }
            ],
            systemPromptSections: [{ name: "Core", tokens: 1000 }, { name: "Environment", tokens: 2000 }],
            systemTools: [{ name: "Read", tokens: 500 }, { name: "Bash", tokens: 4000 }, { name: "Empty", tokens: 0 }],
            mcpTools: [
                { name: "mcp__docs__read", serverName: "docs", tokens: 900, isLoaded: true },
                { name: "mcp__docs__create", serverName: "docs", tokens: 700, isLoaded: false }
            ],
            memoryFiles: [{ path: "C:/code/repo/CLAUDE.md", type: "Project", tokens: 1900 }],
            skills: { skillFrontmatter: [{ name: "pdf", source: "plugin", tokens: 120 }] },
            agents: [{ agentType: "reviewer", source: "projectSettings", tokens: 300 }],
            messageBreakdown: { toolCallTokens: 400, toolResultTokens: 1500, userMessageTokens: 600, assistantMessageTokens: 0 }
        });

        expect(context?.parts?.map(part => [part.name, part.items])).toEqual([
            ["System prompt", [{ name: "Environment", tokens: 2000 }, { name: "Core", tokens: 1000 }]],
            ["System tools", [{ name: "Bash", tokens: 4000 }, { name: "Read", tokens: 500 }]],
            ["MCP tools", [{ name: "mcp__docs__read", tokens: 900 }]],
            ["Memory files", [{ name: "C:/code/repo/CLAUDE.md", tokens: 1900, note: "Project" }]],
            ["Skills", [{ name: "pdf", tokens: 120 }]],
            ["Custom agents", [{ name: "reviewer", tokens: 300 }]],
            ["Messages", [{ name: "Tool results", tokens: 1500 }, { name: "User messages", tokens: 600 }, { name: "Tool calls", tokens: 400 }]]
        ]);
    });

    it("trusts the report's own kind over the row's name", () => {

        expect(contextUsageOf({
            totalTokens: 10,
            rawMaxTokens: 100,
            categories: [{ name: "Free space", tokens: 10, kind: "used" }, { name: "Messages", tokens: 5, kind: "buffer" }]
        })?.parts).toEqual([{ name: "Free space", tokens: 10 }]);
    });

    it("is nothing without a window size to measure against", () => {

        expect(contextUsageOf({ totalTokens: 10 })).toBeUndefined();
        expect(contextUsageOf(undefined)).toBeUndefined();
    });
});

/*
 * Claude's to-do tools are the plan, not tool calls: the chat's plan
 * strip shows what they did. Each call is still logged, as two notices.
 */
describe("Claude's to-do tools", () => {

    const call = (id: string, name: string, input: unknown) => ({
        type: "assistant",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_use", id, name, input }] }
    });

    const result = (id: string, content: unknown, isError = false) => ({
        type: "user",
        parent_tool_use_id: null,
        message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] }
    });

    it("hands TodoWrite's whole list on as the plan, with no tool call drawn", () => {

        const translator = claude();

        const started = translator.translate(call("t1", "TodoWrite", {
            todos: [
                { content: "Read the code", status: "completed", activeForm: "Reading the code" },
                { content: "Fix the bug", status: "in_progress", activeForm: "Fixing the bug" },
                { content: "Run the tests", status: "pending", activeForm: "Running the tests" }
            ]
        }));

        expect(started.map(event => event.kind)).toEqual(["notice"]);
        expect(started[0]).toMatchObject({
            plan: [
                { text: "Read the code", status: "completed" },
                { text: "Fixing the bug", status: "in_progress" },
                { text: "Run the tests", status: "pending" }
            ]
        });
        expect(lineOf(started[0])).toContain("TodoWrite: ");

        const ended = translator.translate(result("t1", "Todos have been modified successfully"));

        expect(ended.map(event => event.kind)).toEqual(["notice"]);
        expect(lineOf(ended[0])).toContain("TodoWrite done");
        expect((ended[0] as { plan?: unknown }).plan).toBeUndefined();
    });

    it("builds the plan from TaskCreate and TaskUpdate as their results come back", () => {

        const translator = claude();

        expect(translator.translate(call("c1", "TaskCreate", { subject: "Write the tests", activeForm: "Writing the tests" })))
            .toMatchObject([{ kind: "notice" }]);

        const created = translator.translate(result("c1", "Task #1 created successfully: Write the tests"));

        expect(created[0]).toMatchObject({ kind: "notice", plan: [{ text: "Write the tests", status: "pending" }] });

        translator.translate(call("c2", "TaskCreate", { subject: "Ship it" }));
        translator.translate(result("c2", JSON.stringify({ task: { id: "2", subject: "Ship it" } })));

        translator.translate(call("u1", "TaskUpdate", { taskId: "1", status: "in_progress" }));

        const updated = translator.translate(result("u1", "Updated task #1 status"));

        expect(updated[0]).toMatchObject({
            plan: [{ text: "Writing the tests", status: "in_progress" }, { text: "Ship it", status: "pending" }]
        });
    });

    it("leaves the plan as it was for a call that failed or found no task", () => {

        const translator = claude();

        translator.translate(call("c1", "TaskCreate", { subject: "Write the tests" }));
        translator.translate(result("c1", "Task #1 created successfully: Write the tests"));

        translator.translate(call("u1", "TaskUpdate", { taskId: "9", status: "completed" }));
        expect((translator.translate(result("u1", "Task #9 not found"))[0] as { plan?: unknown }).plan).toBeUndefined();

        translator.translate(call("u2", "TaskUpdate", { taskId: "1", status: "completed" }));

        const failed = translator.translate(result("u2", "boom", true));

        expect(lineOf(failed[0])).toContain("TaskUpdate failed");
        expect((failed[0] as { plan?: unknown }).plan).toBeUndefined();
    });

    it("draws every other tool as a plain tool start", () => {

        expect(claude().translate(call("b1", "Bash", { command: "ls" }))[0].kind).toBe("tool.start");
    });
});

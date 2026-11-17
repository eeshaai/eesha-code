import * as path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it, vi } from "vitest";

import {
    AcpActiveSession, AcpAgentContext, AcpAgentSession, AcpConnection, AcpPromptResponse, AcpSessionMessage,
    acpStderrStream, acpTokens, describeAcpCost, describeAcpSession, describeAcpUsage, describeCharge, describeStopReason, forwardableMcpServers,
    isKnownAcpNoise, loadSession, offersLoad, awaitConfigOptions, sdkMessage, takesImages
} from "../AcpProvider";
import { ACP_EXTENSIONS, AcpExtension, extensionsFor } from "../acpExtensions";
import { readKiroMetadata } from "../kiroV2AcpExtension";
import { readCopilotEvent } from "../copilotCliAcpExtension";
import { McpResolution } from "../mcpConfig";
import { AgentEvent, describeEvent } from "../../AgentSession";
import type { AccountUsage } from "../../../models/run";
import { UNANSWERED_NOTE } from "../../permissions";

function resolution(servers: McpResolution["servers"]): McpResolution {

    return { servers };
}

/**
 * A fake `ActiveSession`. A test controls which `session/update`
 * notifications arrive and when `session/prompt` resolves.
 */
function fakeActiveSession(sessionId = "test-session"): {
    session: AcpActiveSession;
    push(update: AcpSessionMessage): void;
    promptCalls: unknown[];
    resolvePrompt(response: AcpPromptResponse): void;
    rejectPrompt(error: Error): void;

    /** One turn failing, as the SDK reports it: the waiting read throws once, the session lives on. */
    failTurn(error: Error): void;
    disposed: boolean;
} {

    const queue: AcpSessionMessage[] = [];

    let waiter: { resolve(v: AcpSessionMessage): void; reject(e: Error): void } | undefined;

    let closed = false;

    const promptCalls: unknown[] = [];

    let pending: { resolve(v: AcpPromptResponse): void; reject(e: Error): void } | undefined;

    return {

        promptCalls,

        get disposed() { return closed; },

        push(update) {

            queue.push(update);

            if (waiter) {

                const w = waiter;
                waiter = undefined;
                w.resolve(queue.shift()!);
            }
        },

        // Queues the `stop` too, as the SDK's `ActiveSession.prompt`
        // does with the same response - behind whatever is queued.
        resolvePrompt(response) {

            if (!pending)
                return;

            pending.resolve(response);
            pending = undefined;

            this.push({ kind: "stop", response });
        },

        rejectPrompt(error) {

            pending?.reject(error);
            pending = undefined;
        },

        failTurn(error) {

            const w = waiter;
            waiter = undefined;
            w?.reject(error);
        },

        session: {

            sessionId,

            newSessionResponse: {},

            prompt(prompt) {

                promptCalls.push(prompt);

                return new Promise((resolve, reject) => { pending = { resolve, reject }; });
            },

            nextUpdate() {

                if (closed)
                    return Promise.reject(new Error("closed"));

                if (queue.length)
                    return Promise.resolve(queue.shift()!);

                return new Promise((resolve, reject) => { waiter = { resolve, reject }; });
            },

            dispose() {

                closed = true;

                if (waiter) {

                    const w = waiter;
                    waiter = undefined;
                    w.reject(new Error("closed"));
                }
            }
        }
    };
}

function fakeConnection(): { connection: AcpConnection; closed: boolean; notified: unknown[] } {

    const state = { closed: false, notified: [] as unknown[] };

    const ctx: AcpAgentContext = {

        request: (() => Promise.reject(new Error("not needed here"))) as AcpAgentContext["request"],

        async notify(method, params) {

            state.notified.push({ method, params });
        },

        buildSession: () => { throw new Error("not needed here"); }
    };

    return {
        closed: state.closed,
        notified: state.notified,
        connection: {
            agent: ctx,
            close() { state.closed = true; }
        }
    };
}

function fakeChild(): { kill(): void } {

    return { kill() { /* no-op */ } };
}

function session(active: AcpActiveSession, connection: AcpConnection): AcpAgentSession {

    return new AcpAgentSession(
        fakeChild() as never,
        connection,
        connection.agent,
        active,
        undefined);
}

describe("AcpAgentSession", () => {

    it("takes its id from session/new, before any turn runs", () => {

        const { session: active } = fakeActiveSession("abc-123");
        const { connection } = fakeConnection();

        expect(session(active, connection).id).toBe("abc-123");
    });

    /*
     * sendAndWait must not resolve until prompt() resolves, no matter
     * how many intermediate updates arrive first.
     */
    it("sendAndWait resolves only when the turn's own response resolves, not on an intermediate update", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        let resolved = false;

        const waiting = s.sendAndWait({ prompt: "do the thing" }).then(() => { resolved = true; });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Shell", status: "pending" }
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(resolved).toBe(false);
        expect(s.status).toBe("working");

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(resolved).toBe(false);

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        expect(resolved).toBe(true);
        expect(s.status).toBe("idle");
    });

    it("stays usable across multiple turns on the same session", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const turn1 = s.sendAndWait({ prompt: "first" });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await turn1;

        const turn2 = s.sendAndWait({ prompt: "second" });

        expect(fake.promptCalls).toEqual(["first", "second"]);

        fake.resolvePrompt({ stopReason: "end_turn" });

        await turn2;

        expect(s.status).toBe("idle");
    });

    /*
     * A network drop fails one turn. The next message - "resume" - must
     * still have its replies and its end of turn read, or the chat shows
     * nothing and stays "running" for good.
     */
    it("keeps reading after one turn fails, so the next turn's replies and end still arrive", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        await s.send({ prompt: "first" });

        const drop = new Error("network dropped");
        fake.failTurn(drop);
        fake.rejectPrompt(drop);

        await new Promise(resolve => setTimeout(resolve, 0));

        // The failed turn is over: said as an error, then as idle, so
        // nothing shows it as still working.
        expect(events.map(e => e.kind)).toEqual(["error", "idle"]);
        expect(s.status).toBe("idle");

        events.length = 0;

        await s.send({ prompt: "resume" });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "carrying on" } }
        });
        fake.resolvePrompt({ stopReason: "end_turn" });

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(events.some(e => e.kind === "message" && e.text === "carrying on")).toBe(true);
        expect(events[events.length - 1].kind).toBe("idle");
        expect(s.status).toBe("idle");
    });

    it("stops reading once the connection is closed, rather than spinning on it", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const closed = new Error("connection closed");
        const reads = vi.spyOn(fake.session, "nextUpdate").mockImplementation(() => Promise.reject(closed));

        // The read already waiting is the real one; fail it to reach the mock.
        fake.failTurn(closed);

        await new Promise(resolve => setTimeout(resolve, 0));

        // The first throw is taken as a failed turn, the repeat as the end.
        expect(reads.mock.calls.length).toBe(1);
    });

    it("buffers message chunks per turn and flushes one message event on stop", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "hi" });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "P" } }
        });
        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ONG" } }
        });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        const messages = events.filter(e => e.kind === "message");

        expect(messages).toHaveLength(1);
        expect((messages[0] as { text: string }).text).toBe("PONG");
    });

    it("does not release sendAndWait until the turn's answer and idle are published", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "hi" });

        // The last chunks and the reply land together, as one read off
        // the agent's stdout often brings them: all queued ahead of the
        // `stop` at the moment the prompt resolves.
        for (const text of ["a", "b", "c", "d", "e", "f"])
            fake.push({
                kind: "session_update",
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } }
            });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        // Read at once - no tick for the pump to catch up.
        expect(events.filter(e => e.kind === "message").map(e => (e as { text: string }).text)).toEqual(["abcdef"]);
        expect(events.some(e => e.kind === "idle")).toBe(true);
    });

    it("finishes the text written before a tool call, so the text after it starts below the call", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "hi" });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "checking" } }
        });
        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Before." } }
        });
        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "PowerShell", status: "pending" }
        });
        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "After." } }
        });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        const order = events
            .filter(e => e.kind === "reasoning" || e.kind === "message" || e.kind === "tool.start")
            .map(e => e.kind === "tool.start" ? "tool" : `${e.kind}:${(e as { text: string }).text}`);

        expect(order).toEqual(["reasoning:checking", "message:Before.", "tool", "message:After."]);
    });

    it("translates a completed tool call into tool.start then tool.end, with timing", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "run it" });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "PowerShell", status: "pending" }
        });

        // A non-terminal update carries no line of its own.
        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: undefined }
        });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" }
        });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        const toolEvents = events.filter(e => e.kind === "tool.start" || e.kind === "tool.end");

        expect(toolEvents).toHaveLength(2);
        expect(toolEvents[0]).toMatchObject({ kind: "tool.start", tool: "PowerShell" });
        expect(toolEvents[1]).toMatchObject({ kind: "tool.end", tool: "PowerShell", success: true });
        expect((toolEvents[1] as { ms?: number }).ms).toBeGreaterThanOrEqual(0);

        // The call as sent goes under the summary line in the log.
        const line = describeEvent(toolEvents[0])!;

        expect(line.text.split("\n")).toEqual([
            "PowerShell: PowerShell",
            JSON.stringify({ sessionUpdate: "tool_call", toolCallId: "t1", title: "PowerShell", status: "pending" })
        ]);
    });

    it("abort() cancels the session over the protocol rather than tearing it down", async () => {

        const fake = fakeActiveSession();
        const { connection, notified } = fakeConnection();
        const s = session(fake.session, connection);

        await s.abort();

        expect(notified).toEqual([{ method: "session/cancel", params: { sessionId: fake.session.sessionId } }]);
    });

    /* The agent says "cancelled by the user" for its own aborts too - this line is how the log tells them apart. */
    it("says in the log that it sent a cancel, and why", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        await s.abort();
        await s.abort("the run was stopped");

        expect(events.filter(e => e.kind === "notice").map(e => describeEvent(e)?.text)).toEqual([
            "Sent session/cancel: Stop was pressed.",
            "Sent session/cancel: the run was stopped."
        ]);
    });

    it("dispose() ends the SDK session, closes the connection, and stops the pump", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        await s.dispose();

        expect(fake.disposed).toBe(true);
        expect(s.status).toBe("ended");

        // A second dispose is a no-op, not a re-close.
        await expect(s.dispose()).resolves.toBeUndefined();
    });
});

/**
 * Which of `ai.mcpServers` reaches `session/new`: stdio always (ACP's
 * capability flags never name it), `http`/`sse` only when the agent's
 * `initialize` response said so.
 */
describe("forwardableMcpServers", () => {

    // Empty pathEnv throughout so nothing depends on this machine's PATH.
    it("forwards a stdio server regardless of what the agent advertised", () => {

        const servers = forwardableMcpServers(resolution({ ado: { command: "npx" } }), {}, undefined, "", false);

        expect(servers).toEqual([{ type: "stdio", name: "ado", command: "npx", args: [], env: [] }]);
    });

    it("forwards http only when the agent advertised mcpCapabilities.http", () => {

        const mcp = resolution({ remote: { type: "http", url: "https://example.com" } });

        expect(forwardableMcpServers(mcp, { mcpCapabilities: { http: true } }, undefined, "", false)).toHaveLength(1);
        expect(forwardableMcpServers(mcp, { mcpCapabilities: { http: false } }, undefined, "", false)).toEqual([]);
        expect(forwardableMcpServers(mcp, {}, undefined, "", false)).toEqual([]);
        expect(forwardableMcpServers(mcp, undefined, undefined, "", false)).toEqual([]);
    });

    it("forwards sse only when the agent advertised mcpCapabilities.sse", () => {

        const mcp = resolution({ remote: { type: "sse", url: "https://example.com" } });

        expect(forwardableMcpServers(mcp, { mcpCapabilities: { sse: true } }, undefined, "", false)).toHaveLength(1);
        expect(forwardableMcpServers(mcp, { mcpCapabilities: { http: true } }, undefined, "", false)).toEqual([]);
    });

    it("logs why an unsupported server was left out, naming it", () => {

        const logs: string[] = [];
        const mcp = resolution({ remote: { type: "sse", url: "https://example.com" } });

        forwardableMcpServers(mcp, {}, text => logs.push(text), "", false);

        expect(logs.join("\n")).toContain("remote");
        expect(logs.join("\n")).toContain("did not advertise support");
    });

    it("forwards a server regardless of its tools allowlist - no ACP equivalent to apply, and no log either", () => {

        const logs: string[] = [];

        const servers = forwardableMcpServers(
            resolution({ ado: { command: "npx", tools: ["wit_get_work_item"] } }),
            {},
            text => logs.push(text),
            "",
            false);

        expect(servers).toHaveLength(1);
        expect(logs).toEqual([]);
    });

    it("forwards nothing for an empty server map", () => {

        expect(forwardableMcpServers(
            resolution({}), { mcpCapabilities: { http: true, sse: true } }, undefined, "", false))
            .toEqual([]);
    });
});

/**
 * Which ACP agent stderr lines never reach the task log: only observed,
 * known-benign chatter, never a real error that shares a word with one.
 */
describe("isKnownAcpNoise", () => {

    it("matches Kiro's own observed elicitation-capability line", () => {

        expect(isKnownAcpNoise("client doesn't support form elicitation")).toBe(true);
    });

    it("matches Kiro's own observed dynamic client registration failure", () => {

        expect(isKnownAcpNoise("registration failed: dynamic client registration not supported")).toBe(true);
    });

    it("matches Node's SQLite warning that Kiro's v3 engine prints on every start, and its hint line", () => {

        expect(isKnownAcpNoise(
            "[ERROR] (node:96088) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r"))
            .toBe(true);
        expect(isKnownAcpNoise("(Use `node --trace-warnings ...` to show where the warning was created)\r")).toBe(true);

        // Another Node warning is still shown.
        expect(isKnownAcpNoise("[ERROR] (node:1) ExperimentalWarning: VM Modules is an experimental feature")).toBe(false);
    });

    it("leaves an unrelated line alone, even one mentioning registration", () => {

        expect(isKnownAcpNoise("MCP server 'ado' registration succeeded")).toBe(false);
        expect(isKnownAcpNoise("fatal: could not start agent")).toBe(false);
    });
});

/** Kiro's v3 engine logs every level to stderr; only real problems show as errors. */
describe("acpStderrStream", () => {

    it("shows Kiro's info, debug and trace lines as normal lines", () => {

        expect(acpStderrStream("[INFO] session loaded\r")).toBe("system");
        expect(acpStderrStream("[debug] reading config")).toBe("system");
        expect(acpStderrStream("  [TRACE] tick")).toBe("system");
    });

    it("keeps warnings, errors and untagged lines as errors", () => {

        expect(acpStderrStream("[WARN] retrying request")).toBe("stderr");
        expect(acpStderrStream("[ERROR] could not reach the server")).toBe("stderr");
        expect(acpStderrStream("fatal: could not start agent")).toBe("stderr");
    });

    it("looks at the tag at the start only, not one later in the line", () => {

        expect(acpStderrStream("request failed after [INFO] was printed")).toBe("stderr");
    });
});

/**
 * What the end of a turn says: the bill as a notice, a failure as an
 * error. Same as `ClaudeProvider` does off the SDK's `result` message.
 */
describe("the end of an ACP turn", () => {

    function endOfTurn(response: AcpPromptResponse): Promise<AgentEvent[]> {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "go" });

        fake.resolvePrompt(response);

        return waiting.then(() => events);
    }

    it("says nothing beyond idle for a clean finish the agent did not bill for", async () => {

        expect(await endOfTurn({ stopReason: "end_turn" })).toEqual([
            { name: "session/prompt", raw: { stopReason: "end_turn" }, kind: "idle" }
        ]);
    });

    it("reports the turn's bill, cache tokens folded into 'in' the way ClaudeProvider folds them", async () => {

        const events = await endOfTurn({
            stopReason: "end_turn",
            usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 900, cachedWriteTokens: 0 }
        });

        expect(events.filter(e => e.kind === "notice"))
            .toEqual([expect.objectContaining({ text: "Turn finished - tokens in=1000 out=20" })]);
    });

    it("reports a refusal as an error, not as a finished turn", async () => {

        const events = await endOfTurn({ stopReason: "refusal" });

        expect(events.filter(e => e.kind === "error"))
            .toEqual([expect.objectContaining({ message: expect.stringContaining("refused") })]);

        // Still idle afterwards: the turn is over either way, and
        // AgentSessions' `untilIdle` policy is waiting on it.
        expect(events.at(-1)).toMatchObject({ kind: "idle" });
    });

    it("reports a token ceiling as an error", async () => {

        expect((await endOfTurn({ stopReason: "max_tokens" })).filter(e => e.kind === "error"))
            .toEqual([expect.objectContaining({ message: expect.stringContaining("maximum number of tokens") })]);
    });

    it("reports our own cancellation as a notice rather than a failure", async () => {

        const events = await endOfTurn({ stopReason: "cancelled" });

        expect(events.filter(e => e.kind === "error")).toEqual([]);
        expect(events.filter(e => e.kind === "notice"))
            .toEqual([expect.objectContaining({ text: "The turn was cancelled." })]);
    });

    it("spends the cost a usage_update reported on the turn's own bill", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "go" });

        // No line of its own - it repeats as the context window fills.
        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "usage_update", cost: { amount: 0.1234, currency: "USD" } }
        });

        const response = { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };

        fake.resolvePrompt(response);

        await waiting;

        expect(events.filter(e => e.kind === "notice"))
            .toEqual([expect.objectContaining({
                text: "Turn finished - tokens in=10 out=5 cost=$0.1234",
                cost: [{ amount: 0.1234, unit: "USD" }]
            })]);
    });

    /**
     * ACP's cost is cumulative for the session, so the second bill
     * carries only what the second turn added. The window fill goes
     * out as its own heartbeat notice, since it is a state and not a
     * charge.
     */
    it("charges each turn the difference, and reports the window as it fills", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const turn = async (amount: number, used: number) => {

            const waiting = s.sendAndWait({ prompt: "go" });

            fake.push({
                kind: "session_update",
                update: { sessionUpdate: "usage_update", used, size: 200000, cost: { amount, currency: "USD" } }
            });

            const response = { stopReason: "end_turn", usage: { inputTokens: 10, outputTokens: 5 } };

            fake.resolvePrompt(response);

            await waiting;
        };

        await turn(0.10, 50000);
        await turn(0.35, 90000);
        await turn(0.35, 90000);

        expect(events.filter(e => e.kind === "notice")).toEqual([
            expect.objectContaining({ progress: true, text: "Context 25% of 200000 tokens used", context: { used: 50000, size: 200000 } }),
            expect.objectContaining({ cost: [{ amount: expect.closeTo(0.10, 6), unit: "USD" }] }),
            expect.objectContaining({ progress: true, text: "Context 45% of 200000 tokens used", context: { used: 90000, size: 200000 } }),
            expect.objectContaining({ cost: [{ amount: expect.closeTo(0.25, 6), unit: "USD" }], text: "Turn finished - tokens in=10 out=5 cost=$0.2500" }),
            expect.objectContaining({ progress: true, text: "Context 45% of 200000 tokens used" }),

            // A turn that added nothing says so, not the session's total.
            expect.objectContaining({ text: "Turn finished - tokens in=10 out=5 cost=$0.0000" })
        ]);
    });

    it("publishes a failed sendAndWait as an error event as well as throwing it", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "go" });

        fake.rejectPrompt(new Error("the agent went away"));

        await expect(waiting).rejects.toThrow("the agent went away");

        expect(events).toEqual([
            expect.objectContaining({ kind: "error", message: "the agent went away" })
        ]);
    });
});

describe("describeAcpUsage", () => {

    it("says nothing when the agent counted nothing", () => {

        expect(describeAcpUsage(undefined)).toBeUndefined();
        expect(describeAcpUsage(undefined, "")).toBeUndefined();
    });

    it("reads a partly-filled usage without inventing zeros it was not given", () => {

        expect(describeAcpUsage({ outputTokens: 7 })).toBe("tokens in=0 out=7");
    });

    it("carries the cost through even when there are no token counts", () => {

        expect(describeAcpUsage(undefined, "cost=$1.0000")).toBe("cost=$1.0000");
    });
});

describe("describeAcpCost", () => {

    it("uses a dollar sign only for USD", () => {

        expect(describeAcpCost({ amount: 2, currency: "USD" })).toBe("cost=$2.0000");
        expect(describeAcpCost({ amount: 2 })).toBe("cost=$2.0000");
        expect(describeAcpCost({ amount: 2, currency: "EUR" })).toBe("cost=2.0000 EUR");
    });

    it("says nothing without an amount", () => {

        expect(describeAcpCost(undefined)).toBeUndefined();
        expect(describeAcpCost({ currency: "USD" })).toBeUndefined();
    });
});

/*
 * The `session/new` log line. ACP's `env` and `headers` are
 * `[{ name, value }]` lists, with `${{ env.NAME }}` already expanded.
 */
describe("describeAcpSession", () => {

    it("never prints an MCP server's env or header values, but keeps the names", () => {

        const secret = "abc123secret";

        const printed = describeAcpSession({ protocolVersion: 1 }, "/work", [
            { type: "stdio", name: "ado", command: "npx", args: [], env: [{ name: "ADO_MCP_AUTH_TOKEN", value: secret }] },
            { type: "http", name: "api", url: "https://x", headers: [{ name: "Authorization", value: `Bearer ${secret}` }] }
        ]);

        expect(printed).not.toContain(secret);

        const [ado, api] = JSON.parse(printed).mcpServers;

        expect(ado.env).toEqual([{ name: "ADO_MCP_AUTH_TOKEN", value: `[redacted, ${secret.length} chars]` }]);
        expect(api.headers).toEqual([{ name: "Authorization", value: `[redacted, ${`Bearer ${secret}`.length} chars]` }]);
        expect(ado.command).toBe("npx");
    });
});

describe("describeStopReason", () => {

    it("says nothing for a clean finish, or for an agent that sent no reason at all", () => {

        expect(describeStopReason("end_turn")).toBeUndefined();
        expect(describeStopReason(undefined)).toBeUndefined();
        expect(describeStopReason("")).toBeUndefined();
    });

    it("names a reason this build has not seen rather than swallowing it", () => {

        expect(describeStopReason("something_new"))
            .toMatchObject({ kind: "error", message: "The turn ended: something_new" });
    });
});

/**
 * The session's half of the elicitation path: raise an `ask` event with
 * a fresh id, hold the promise, and settle it when `respond` names that
 * id. Same contract `ClaudeAgentSession` keeps, so one page can
 * answer either provider.
 */
describe("an ACP session's questions", () => {

    it("raises an ask event carrying the choices, and settles on respond", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const pending = s.ask({
            prompt: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }],
            raw: { mode: "form" }
        });

        expect(events).toEqual([expect.objectContaining({
            kind: "ask",
            name: "elicitation/create",
            askId: pending.askId,
            prompt: "Which database?",
            options: [{ label: "Postgres" }, { label: "SQLite" }]
        })]);

        await s.respond(pending.askId, "SQLite");

        await expect(pending.answer).resolves.toBe("SQLite");
    });

    it("refuses an answer to a question nobody is waiting on", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        await expect(s.respond("not-a-question", "yes")).rejects.toThrow(/Nothing is waiting/);
    });

    it("refuses a second answer to the same question", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const pending = s.ask({ prompt: "Again?", raw: undefined });

        await s.respond(pending.askId, "yes");

        await expect(s.respond(pending.askId, "no")).rejects.toThrow(/Nothing is waiting/);
    });

    it("fails an open question when the turn is stopped, so the agent is not left waiting", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const pending = s.ask({ prompt: "Which one?", raw: undefined });

        await s.abort();

        await expect(pending.answer).rejects.toThrow(/stopped before the question was answered/);
    });

    it("fails an open question when the session ends", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const pending = s.ask({ prompt: "Which one?", raw: undefined });

        await s.dispose();

        await expect(pending.answer).rejects.toThrow(/session ended before the question was answered/);

        // And nothing new may be asked on a session that is over.
        expect(() => s.ask({ prompt: "One more?", raw: undefined })).toThrow(/has ended/);
    });

    /*
     * `session/prompt` cannot resolve while a tool call it spawned is
     * still running - an elicitation is exactly that - so a question
     * still open the moment the turn settles is not a real one. It is
     * the agent having dropped it without telling this session so.
     * Left alone it would lock the next turn's compose box forever.
     */
    it("closes a question still open when the turn settles anyway", async () => {

        const fake = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const pending = s.ask({ prompt: "Which one?", raw: undefined });

        // Attached before the turn settles: `abandon` rejects this as
        // part of the same settle below.
        const rejected = expect(pending.answer).rejects.toThrow(/turn ended without an answer/);

        const waiting = s.sendAndWait({ prompt: "go" });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;
        await rejected;

        // Closed, not merely rejected: a late respond finds nothing.
        await expect(s.respond(pending.askId, "too late")).rejects.toThrow(/Nothing is waiting/);
    });
});

describe("a vendor's own ACP messages", () => {

    /*
     * `receive` is what every `_vendor/...` notification reaches, via
     * the extension that reads it. Driven here with Kiro's reader, since
     * it is the one that charges a turn.
     */
    it("puts a Kiro metering charge on the turn's bill, with its duration", async () => {

        const fake = fakeActiveSession("kiro-1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const waiting = s.sendAndWait({ prompt: "go" });

        s.receive(readKiroMetadata, { sessionId: "kiro-1", contextUsagePercentage: 12.4 });
        s.receive(readKiroMetadata, {
            sessionId: "kiro-1",
            contextUsagePercentage: 13,
            meteringUsage: [
                { value: 0.195, unit: "credit", unitPlural: "credits" },
                { value: 0.59, unit: "credit", unitPlural: "credits" }
            ],
            turnDurationMs: 30010
        });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        expect(events.filter(e => e.kind === "notice").map(e => (e as { text: string }).text)).toEqual([
            "Context 12% used",
            "Context 13% used",
            "Turn finished - 0.785 credits in 30.0s"
        ]);

        const bill = events.find(e => e.kind === "notice" && e.text.startsWith("Turn finished"));

        expect(bill).toMatchObject({ cost: [{ amount: expect.closeTo(0.785, 9), unit: "credits" }] });

        // Kiro does not say how many model calls the turn made.
        expect(bill).not.toHaveProperty("calls");
    });

    it("puts the model calls Copilot's feed counted on the turn's bill, then starts again at zero", async () => {

        const fake = fakeActiveSession("copilot-1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const bills = () => events.filter(e => e.kind === "notice" && e.text.startsWith("Turn finished"));

        const first = s.sendAndWait({ prompt: "go" });

        s.receive(readCopilotEvent, { type: "assistant.usage", data: { copilotUsage: { totalNanoAiu: 250_000_000 } } });
        s.receive(readCopilotEvent, { type: "assistant.usage", data: { copilotUsage: { totalNanoAiu: 250_000_000 } } });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await first;

        expect(bills()).toEqual([expect.objectContaining({ text: "Turn finished - 0.5 credits (2 model calls)", calls: 2 })]);

        const second = s.sendAndWait({ prompt: "again" });

        s.receive(readCopilotEvent, { type: "assistant.usage", data: {} });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await second;

        expect(bills()[1]).toMatchObject({ text: "Turn finished - (1 model call)", calls: 1 });
    });

    it("counts ACP's cache reads into In once, and an extension's already-inside reads not again", () => {

        expect(acpTokens({ inputTokens: 100, outputTokens: 20, cachedReadTokens: 900, cachedWriteTokens: 50 }))
            .toEqual({ inputTokens: 1050, outputTokens: 20, cachedTokens: 900 });

        expect(acpTokens({ inputTokens: 1000, outputTokens: 50, cachedInsideTokens: 800 }))
            .toEqual({ inputTokens: 1000, outputTokens: 50, cachedTokens: 800 });

        expect(acpTokens({ inputTokens: 10, outputTokens: 5 })).toEqual({ inputTokens: 10, outputTokens: 5 });
        expect(acpTokens(undefined)).toBeUndefined();
    });

    /*
     * Kiro never says which model a charge was for, so the bill is filed
     * under the model the session runs on - the one picked for it, then
     * whatever the agent says it switched to.
     */
    it("files each turn's bill under the session's model", async () => {

        const fake = fakeActiveSession("kiro-1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        s.runsOn("claude-sonnet-4.5");

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const first = s.sendAndWait({ prompt: "one" });

        s.receive(readKiroMetadata, { meteringUsage: [{ value: 0.5, unitPlural: "credits" }] });
        fake.resolvePrompt({ stopReason: "end_turn" });

        await first;

        fake.push({
            kind: "session_update",
            update: {
                sessionUpdate: "config_option_update",
                configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "claude-opus-4.5", options: [] }]
            }
        });

        const second = s.sendAndWait({ prompt: "two" });

        s.receive(readKiroMetadata, { meteringUsage: [{ value: 1.5, unitPlural: "credits" }] });
        fake.resolvePrompt({ stopReason: "end_turn" });

        await second;

        const bills = events.filter(e => e.kind === "notice" && e.text.startsWith("Turn finished"));

        expect(bills.map(bill => (bill as { models?: unknown }).models)).toEqual([
            [{ model: "claude-sonnet-4.5", cost: [{ amount: 0.5, unit: "credits" }] }],
            [{ model: "claude-opus-4.5", cost: [{ amount: 1.5, unit: "credits" }] }]
        ]);
    });

    it("names no model on the bill when the agent lists none", async () => {

        const fake = fakeActiveSession("kiro-1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        s.runsOn(undefined);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const turn = s.sendAndWait({ prompt: "go" });

        s.receive(readKiroMetadata, { meteringUsage: [{ value: 0.5, unitPlural: "credits" }] });
        fake.resolvePrompt({ stopReason: "end_turn" });

        await turn;

        const bill = events.find(e => e.kind === "notice" && e.text.startsWith("Turn finished"));

        expect(bill).not.toHaveProperty("models");
    });

    it("bills a charge once - the next turn starts with nothing on it", async () => {

        const fake = fakeActiveSession("kiro-1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        const first = s.sendAndWait({ prompt: "one" });

        s.receive(readKiroMetadata, { meteringUsage: [{ value: 0.5, unitPlural: "credits" }] });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await first;

        const second = s.sendAndWait({ prompt: "two" });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await second;

        expect(events.filter(e => e.kind === "notice").map(e => (e as { text: string }).text))
            .toEqual(["Turn finished - 0.5 credits"]);
    });

    it("ignores a message naming another session", () => {

        const { session: active } = fakeActiveSession("mine");
        const { connection } = fakeConnection();
        const s = session(active, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        s.receive(readKiroMetadata, { sessionId: "theirs", contextUsagePercentage: 50 });

        expect(events).toEqual([]);
    });

    it("drops a message whose reader throws, and keeps the session", () => {

        const { session: active } = fakeActiveSession();
        const { connection } = fakeConnection();
        const s = session(active, connection);

        expect(() => s.receive(() => { throw new Error("new shape"); }, {})).not.toThrow();
        expect(s.status).toBe("idle");
    });
});

describe("an extension's after-turn step", () => {

    function withExtension(afterTurn: AcpExtension["afterTurn"]) {

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();
        const extension: AcpExtension = { vendor: "Test", notifications: {}, afterTurn };

        const s = new AcpAgentSession(
            fakeChild() as never, connection, connection.agent, fake.session, undefined, undefined, undefined, [extension]);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        return { fake, s, events };
    }

    it("publishes its event before sendAndWait releases the caller", async () => {

        const { fake, s, events } = withExtension(async session => [{
            name: "test", raw: undefined, kind: "notice", text: `after ${session.sessionId}`
        }]);

        const waiting = s.sendAndWait({ prompt: "go" });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await waiting;

        expect(events.some(e => e.kind === "notice" && e.text === "after S1")).toBe(true);
    });

    it("runs after the turn's answer, not before it, on a plain send", async () => {

        const { fake, s, events } = withExtension(async () => [{
            name: "test", raw: undefined, kind: "notice", text: "after send"
        }]);

        await s.send({ prompt: "go" });

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done." } }
        });
        fake.resolvePrompt({ stopReason: "end_turn" });

        await vi.waitFor(() => expect(events.some(e => e.kind === "notice" && e.text === "after send")).toBe(true));

        const message = events.findIndex(e => e.kind === "message");
        const after = events.findIndex(e => e.kind === "notice" && e.text === "after send");

        expect(message).toBeGreaterThanOrEqual(0);
        expect(message).toBeLessThan(after);
    });

    it("runs after a plain send too", async () => {

        const { fake, s, events } = withExtension(async () => [{
            name: "test", raw: undefined, kind: "notice", text: "after send"
        }]);

        await s.send({ prompt: "go" });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await vi.waitFor(() => expect(events.some(e => e.kind === "notice" && e.text === "after send")).toBe(true));
    });

    it("costs the turn nothing when it throws", async () => {

        const { fake, s, events } = withExtension(async () => { throw new Error("gone"); });

        const waiting = s.sendAndWait({ prompt: "go" });

        fake.resolvePrompt({ stopReason: "end_turn" });

        await expect(waiting).resolves.toBeUndefined();
        expect(events.filter(e => e.kind === "error")).toEqual([]);
    });

    it("holds the turn no longer than its cap when the agent never answers", async () => {

        vi.useFakeTimers();

        try {

            const { fake, s } = withExtension(() => new Promise(() => undefined));

            let released = false;

            const waiting = s.sendAndWait({ prompt: "go" }).then(() => { released = true; });

            fake.resolvePrompt({ stopReason: "end_turn" });

            await vi.advanceTimersByTimeAsync(2999);
            expect(released).toBe(false);

            await vi.advanceTimersByTimeAsync(1);
            await waiting;

            expect(released).toBe(true);

        } finally {

            vi.useRealTimers();
        }
    });
});

describe("an extension reading standard updates", () => {

    it("gets the updates of the kinds it names, and the engine still handles them too", async () => {

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();

        const seen: unknown[] = [];

        const extension: AcpExtension = {
            vendor: "Test",
            updates: {
                session_info_update: update => {
                    seen.push(update);
                    return { name: "test", raw: update, kind: "notice", text: "read it" };
                }
            }
        };

        const s = new AcpAgentSession(
            fakeChild() as never, connection, connection.agent, fake.session, undefined, undefined, undefined, [extension]);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        fake.push({ kind: "session_update", update: { sessionUpdate: "session_info_update" } });
        fake.push({ kind: "session_update", update: { sessionUpdate: "plan", entries: [] } });

        await vi.waitFor(() => expect(events.some(e => e.kind === "notice" && e.text.startsWith("Plan cleared"))).toBe(true));

        expect(seen).toEqual([{ sessionUpdate: "session_info_update" }]);
        expect(events.filter(e => e.kind === "notice").map(e => (e as { text: string }).text))
            .toEqual(["read it", "Plan cleared."]);
    });

    it("hands on the agent's plan as steps, with how far it is for the log", async () => {

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        fake.push({
            kind: "session_update",
            update: {
                sessionUpdate: "plan",
                entries: [
                    { content: "Read the code", priority: "high", status: "completed" },
                    { content: "Fix the bug", priority: "medium", status: "in_progress" },
                    { content: "  ", priority: "low", status: "pending" },
                    { content: "Run the tests", priority: "low", status: "something new" }
                ]
            }
        });

        await vi.waitFor(() => expect(events).toHaveLength(1));

        expect(events[0]).toMatchObject({
            kind: "notice",
            text: "Plan: 1 of 3 done.\n[x] Read the code\n[>] Fix the bug\n[ ] Run the tests",
            plan: [
                { text: "Read the code", status: "completed" },
                { text: "Fix the bug", status: "in_progress" },
                { text: "Run the tests", status: "pending" }
            ]
        });
    });

    it("runs a session with no extensions on the protocol alone", async () => {

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();
        const s = session(fake.session, connection);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        fake.push({ kind: "session_update", update: { sessionUpdate: "session_info_update" } });
        fake.push({ kind: "session_update", update: { sessionUpdate: "plan", entries: [] } });

        await vi.waitFor(() => expect(events).toHaveLength(1));
    });
});

describe("account usage on a session", () => {

    const kept: AccountUsage = { at: 5, runtime: "kiro-cli-v3", rows: [{ key: "Credits used", value: "1,000" }] };

    function withAccounts(options: { kept?: AccountUsage; atStart?: AcpExtension["atStart"] } = {}) {

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();
        const remembered: { runtime: string; account: AccountUsage }[] = [];

        const extension: AcpExtension = { vendor: "Test", ...(options.atStart ? { atStart: options.atStart } : {}) };

        const s = new AcpAgentSession(
            fakeChild() as never, connection, connection.agent, fake.session, undefined, undefined, undefined,
            [extension], "kiro-cli-v3",
            {
                remember: async (runtime, account) => { remembered.push({ runtime, account }); },
                last: async () => options.kept
            });

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        return { fake, s, events, remembered };
    }

    const accounts = (events: AgentEvent[]) => events
        .filter(e => e.kind === "notice" && e.account)
        .map(e => (e as { account: AccountUsage }).account);

    it("shows the kept copy on the first message, before anything is fetched", async () => {

        const { s, events } = withAccounts({ kept });

        await s.send({ prompt: "go" });

        await vi.waitFor(() => expect(accounts(events)).toEqual([kept]));
    });

    it("fetches a fresh one at the start, keeps it under the runtime, and shows it", async () => {

        const fresh: AccountUsage = { at: 9, rows: [{ key: "Credits used", value: "1,100" }] };

        const { s, events, remembered } = withAccounts({
            atStart: async () => [{ name: "test", raw: undefined, kind: "notice", text: "Account", account: fresh }]
        });

        await s.send({ prompt: "go" });

        await vi.waitFor(() => expect(accounts(events)).toEqual([{ ...fresh, runtime: "kiro-cli-v3" }]));
        expect(remembered).toEqual([{ runtime: "kiro-cli-v3", account: { ...fresh, runtime: "kiro-cli-v3" } }]);
    });

    it("does not show the kept copy once a fresh one has gone out", async () => {

        const fresh: AccountUsage = { at: 9, rows: [] };

        const slow = new Promise<AccountUsage | undefined>(resolve => setTimeout(() => resolve(kept), 20));

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();

        const s = new AcpAgentSession(
            fakeChild() as never, connection, connection.agent, fake.session, undefined, undefined, undefined,
            [{ vendor: "Test", atStart: async () => [{ name: "t", raw: undefined, kind: "notice", text: "A", account: fresh }] }],
            "kiro-cli-v3",
            { remember: async () => undefined, last: () => slow });

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        await s.send({ prompt: "go" });
        await slow;
        await new Promise(resolve => setTimeout(resolve, 0));

        expect(accounts(events).map(one => one.at)).toEqual([9]);
    });

    it("runs the start step once, however many messages follow", async () => {

        let starts = 0;

        const { fake, s } = withAccounts({ atStart: async () => { starts++; return []; } });

        await s.send({ prompt: "one" });
        fake.resolvePrompt({ stopReason: "end_turn" });
        await s.send({ prompt: "two" });

        expect(starts).toBe(1);
    });
});

describe("extensionsFor", () => {

    it("returns the named extensions in order, and logs and skips a name this build lacks", () => {

        const lines: string[] = [];

        const found = extensionsFor(["kiro-v3", "nope", "kiro-v2"], text => { lines.push(text); });

        expect(found).toEqual([ACP_EXTENSIONS["kiro-v3"], ACP_EXTENSIONS["kiro-v2"]]);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/'nope' is not one this build has \(it has: kiro-v2, kiro-v3, copilot-cli, claude-cli\)/);
    });
});

describe("describeCharge", () => {

    it("keeps up to three decimals and drops trailing zeros", () => {

        expect(describeCharge({ amount: 0.785, unit: "credits" })).toBe("0.785 credits");
        expect(describeCharge({ amount: 0.12345, unit: "credits" })).toBe("0.123 credits");
        expect(describeCharge({ amount: 2, unit: "credits" })).toBe("2 credits");
    });
});

describe("attachments in a prompt", () => {

    /** A file reader that never touches the disk: `files` by path, anything else not found. */
    function reader(files: Record<string, Buffer>): (file: string) => Promise<Buffer> {

        return async file => {

            if (!(file in files))
                throw new Error(`ENOENT: ${file}`);

            return files[file];
        };
    }

    it("goes by the agent's own promptCapabilities.image flag", () => {

        expect(takesImages({ promptCapabilities: { image: true } })).toBe(true);
        expect(takesImages({ promptCapabilities: { image: false } })).toBe(false);
        expect(takesImages({})).toBe(false);
        expect(takesImages(undefined)).toBe(false);
    });

    it("sends the prompt alone when nothing is attached", async () => {

        expect(await sdkMessage({ prompt: "hi" }, true)).toBe("hi");
    });

    it("sends an image's bytes when the agent takes images", async () => {

        const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
        const file = path.resolve("attach", "shot.PNG");

        expect(await sdkMessage({ prompt: "look", attachments: [{ path: file, name: "shot.PNG" }] }, true, reader({ [file]: bytes }))).toEqual([
            { type: "text", text: "look" },
            { type: "image", mimeType: "image/png", data: bytes.toString("base64") }
        ]);
    });

    it("sends a link for an image when the agent does not take images", async () => {

        const file = path.resolve("attach", "shot.png");

        expect(await sdkMessage({ prompt: "look", attachments: [{ path: file, name: "shot.png" }] }, false, reader({ [file]: Buffer.from([1]) }))).toEqual([
            { type: "text", text: "look" },
            { type: "resource_link", uri: pathToFileURL(file).href, name: "shot.png" }
        ]);
    });

    it("sends a link for an image that cannot be read", async () => {

        const missing = path.resolve("attach", "gone.png");

        expect(await sdkMessage({ prompt: "look", attachments: [{ path: missing }] }, true, reader({}))).toEqual([
            { type: "text", text: "look" },
            { type: "resource_link", uri: pathToFileURL(missing).href, name: missing }
        ]);
    });

    it("sends a link for any other file, as a well-formed file URL", async () => {

        const file = path.resolve("attach", "notes.md");
        const blocks = await sdkMessage({ prompt: "read", attachments: [{ path: file }] }, true, reader({})) as { uri?: string }[];

        expect(blocks[1]).toEqual({ type: "resource_link", uri: pathToFileURL(file).href, name: file });
        expect(blocks[1].uri).toMatch(/^file:\/\/\//);
        expect(blocks[1].uri).not.toContain("\\");
    });
});

describe("resuming with session/load", () => {

    it("goes by the agent's own loadSession flag", () => {

        expect(offersLoad({ loadSession: true })).toBe(true);
        expect(offersLoad({ loadSession: false })).toBe(false);
        expect(offersLoad({})).toBe(false);
        expect(offersLoad(undefined)).toBe(false);
    });

    it("loads the conversation and follows it under the same id", async () => {

        const calls: unknown[] = [];
        const { session: attached } = fakeActiveSession("old-1");
        let attachedWith: unknown;

        const ctx = {
            request: async (method: string, params: unknown) => {
                calls.push({ method, params });
                return { models: { currentModelId: "auto", availableModels: [{ modelId: "auto" }] } };
            },
            attachSession(response: unknown) {
                attachedWith = response;
                return attached;
            }
        } as unknown as AcpAgentContext;

        const active = await loadSession(ctx, "old-1", "D:/repo", []);

        expect(active.sessionId).toBe("old-1");
        expect(calls).toEqual([{ method: "session/load", params: { sessionId: "old-1", cwd: "D:/repo", mcpServers: [] } }]);

        // The id goes back on, since the load's answer does not carry it,
        // and the model list comes with it for `applyModel` to read.
        expect(attachedWith).toEqual({
            sessionId: "old-1",
            models: { currentModelId: "auto", availableModels: [{ modelId: "auto" }] }
        });
    });

    it("sends nothing when the SDK cannot follow a loaded session", async () => {

        const calls: unknown[] = [];

        const ctx = {
            request: async (method: string) => { calls.push(method); return {}; }
        } as unknown as AcpAgentContext;

        await expect(loadSession(ctx, "old-1", "D:/repo", [])).rejects.toThrow(/cannot follow a loaded session/);
        expect(calls).toEqual([]);
    });

    it("reports resumed: true when the load worked", () => {

        const { session: active } = fakeActiveSession("old-1");
        const { connection } = fakeConnection();

        const s = new AcpAgentSession(fakeChild() as never, connection, connection.agent, active, undefined, undefined, true);

        expect(s.resumed).toBe(true);
        expect(s.resumeFailure).toBeUndefined();
    });

    it("reports nothing about resuming when nothing was asked", () => {

        const { session: active } = fakeActiveSession();
        const { connection } = fakeConnection();

        expect(session(active, connection).resumed).toBeUndefined();
    });
});

describe("an ACP session that cannot resume", () => {

    /*
     * No SDK this build talks to has `session/load` - `ctx.buildSession`
     * always starts fresh. `ai@1` fails a `continueSession` call over
     * this, so the session says why in its own words rather than leave
     * a generic line to blame "the runtime" for it.
     */
    it("reports resumed: false with its own reason, never silently", () => {

        const { session: active } = fakeActiveSession();
        const { connection } = fakeConnection();

        const s = new AcpAgentSession(
            fakeChild() as never, connection, connection.agent, active, undefined,
            "this ACP agent cannot resume a conversation - it has no session/load");

        expect(s.resumed).toBe(false);
        expect(s.resumeFailure).toContain("cannot resume");
    });

    it("carries no reason when nothing was asked to resume", () => {

        const { session: active } = fakeActiveSession();
        const { connection } = fakeConnection();

        expect(session(active, connection).resumeFailure).toBeUndefined();
    });
});

/*
 * A permission request that names only its title - Kiro v3's "Write
 * File", observed - filled in with what its own tool call said, so the
 * card names the file and the folder boundary has a path to check.
 */
describe("withCallInput", () => {

    const WRITE = {
        sessionUpdate: "tool_call", toolCallId: "tooluse_1", title: "Write File", kind: "edit", status: "in_progress",
        rawInput: { path: "C:\\repo\\probe.txt", text: "hi" },
        locations: [{ path: "C:\\repo\\probe.txt" }]
    };

    it("adds the path and input the call's own tool_call carried", async () => {

        const fake = fakeActiveSession();
        const s = session(fake.session, fakeConnection().connection);

        fake.push({ kind: "session_update", update: WRITE });

        const filled = await s.withCallInput({ toolCallId: "tooluse_1", title: "Write File" });

        expect(filled).toMatchObject({
            toolCallId: "tooluse_1", title: "Write File", kind: "edit",
            locations: [{ path: "C:\\repo\\probe.txt" }], rawInput: { path: "C:\\repo\\probe.txt", text: "hi" }
        });
    });

    it("waits for a tool_call that has not been read yet", async () => {

        const fake = fakeActiveSession();
        const s = session(fake.session, fakeConnection().connection);

        const filled = s.withCallInput({ toolCallId: "tooluse_1", title: "Write File" }, 5000);

        fake.push({ kind: "session_update", update: WRITE });

        expect((await filled)?.locations).toEqual([{ path: "C:\\repo\\probe.txt" }]);
    });

    it("gives the request as it came when no tool_call ever described it", async () => {

        const s = session(fakeActiveSession().session, fakeConnection().connection);

        expect(await s.withCallInput({ toolCallId: "never", title: "Review changes" }, 10))
            .toEqual({ toolCallId: "never", title: "Review changes" });
        expect(await s.withCallInput(undefined, 10)).toBeUndefined();
    });

    it("keeps the request's own paths over the tool call's", async () => {

        const fake = fakeActiveSession();
        const s = session(fake.session, fakeConnection().connection);

        fake.push({ kind: "session_update", update: WRITE });

        const filled = await s.withCallInput({ toolCallId: "tooluse_1", locations: [{ path: "C:\\other.txt" }] });

        expect(filled?.locations).toEqual([{ path: "C:\\other.txt" }]);
    });
});

/* Kiro v3 names the conversation itself - `title` on `session_info_update`. */
describe("a title from the agent", () => {

    it("becomes one live notice carrying the title", async () => {

        const fake = fakeActiveSession();
        const s = session(fake.session, fakeConnection().connection);
        const events: AgentEvent[] = [];

        s.on(event => events.push(event));

        fake.push({
            kind: "session_update",
            update: { sessionUpdate: "session_info_update", title: "Create Probe.txt With Single Word" } as never
        });

        await new Promise(resolve => setTimeout(resolve, 0));

        expect(events.find(event => event.kind === "notice")).toMatchObject({
            kind: "notice", progress: true, title: "Create Probe.txt With Single Word", text: "Title: Create Probe.txt With Single Word"
        });
    });
});

/*
 * Kiro v3 on a cold start answers `session/new` before its model list is
 * in, and sends it a moment later as a `config_option_update`. The model asked
 * for must still be applied, not dropped so that the turn runs on Auto.
 */
describe("awaitConfigOptions", () => {

    const MODEL = { id: "model", name: "Model", category: "model", type: "select" as const, currentValue: "auto", options: [{ value: "auto", name: "Auto" }] };
    const hasModel = (response: { configOptions?: { category?: string | null }[] | null }) =>
        (response.configOptions ?? []).some(option => option.category === "model");

    it("gives the session back as it was when nothing is missing", async () => {

        const fake = fakeActiveSession();

        (fake.session as { newSessionResponse: unknown }).newSessionResponse = { configOptions: [MODEL] };

        expect(await awaitConfigOptions(fake.session, hasModel, 1000)).toBe(fake.session);
    });

    it("waits for the options to arrive, and replays every update it read", async () => {

        const fake = fakeActiveSession();

        const waiting = awaitConfigOptions(fake.session, hasModel, 5000);

        fake.push({ kind: "session_update", update: { sessionUpdate: "available_commands_update" } });
        fake.push({ kind: "session_update", update: { sessionUpdate: "config_option_update", configOptions: [MODEL] } });

        const ready = await waiting;

        expect(ready.newSessionResponse.configOptions?.map(option => option.id)).toEqual(["model"]);
        expect((await ready.nextUpdate()).kind === "session_update").toBe(true);
        expect(((await ready.nextUpdate()) as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe("config_option_update");
    });

    it("gives up after the wait, and still hands on the read it left waiting", async () => {

        const fake = fakeActiveSession();

        const ready = await awaitConfigOptions(fake.session, hasModel, 20);

        expect(ready.newSessionResponse.configOptions).toBeUndefined();

        const next = ready.nextUpdate();

        fake.push({ kind: "session_update", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } });

        expect(((await next) as { update: { sessionUpdate: string } }).update.sessionUpdate).toBe("agent_message_chunk");
    });
});

/*
 * A message sent while a turn runs, on a runtime whose extension can hand
 * it to that turn (Kiro v3's `_session/steer`).
 */
describe("AcpAgentSession - a message sent while a turn runs", () => {

    function steering(steer: NonNullable<AcpExtension["steer"]>) {

        const fake = fakeActiveSession("S1");
        const { connection } = fakeConnection();
        const extension: AcpExtension = { vendor: "Test", steer };

        const s = new AcpAgentSession(
            fakeChild() as never, connection, connection.agent, fake.session, undefined, undefined, undefined, [extension]);

        const events: AgentEvent[] = [];
        s.on(e => events.push(e));

        return { fake, s, events };
    }

    it("goes to the running turn, not as a second prompt", async () => {

        const steered: string[] = [];
        const { fake, s } = steering(async (session, text) => { steered.push(`${session.sessionId}: ${text}`); return { ok: true }; });

        await s.send({ prompt: "first" });
        await s.send({ prompt: "also this" });

        expect(fake.promptCalls).toHaveLength(1);
        expect(steered).toEqual(["S1: also this"]);
        expect(s.status).toBe("working");
    });

    it("is a prompt of its own once the turn has ended", async () => {

        const steered: string[] = [];
        const { fake, s } = steering(async (_session, text) => { steered.push(text); return { ok: true }; });

        await s.send({ prompt: "first" });
        fake.resolvePrompt({ stopReason: "end_turn" });

        await vi.waitFor(() => expect(s.status).toBe("idle"));

        await s.send({ prompt: "second" });

        expect(fake.promptCalls).toHaveLength(2);
        expect(steered).toEqual([]);
    });

    it("goes as a prompt when it carries files - the steer takes text only", async () => {

        const steered: string[] = [];
        const { fake, s } = steering(async (_session, text) => { steered.push(text); return { ok: true }; });

        await s.send({ prompt: "first" });
        await s.send({ prompt: "with a file", attachments: [{ path: path.resolve("notes.md") }] });

        expect(steered).toEqual([]);
        await vi.waitFor(() => expect(fake.promptCalls).toHaveLength(2));
    });

    it("says so when the agent did not take it, and sends no prompt instead", async () => {

        const { fake, s, events } = steering(async () => ({ ok: false, reason: "Kiro did not take your message. Send it again." }));

        await s.send({ prompt: "first" });
        await s.send({ prompt: "late" });

        expect(fake.promptCalls).toHaveLength(1);
        expect(events.some(e => e.kind === "notice" && e.text === "Kiro did not take your message. Send it again.")).toBe(true);
    });
});

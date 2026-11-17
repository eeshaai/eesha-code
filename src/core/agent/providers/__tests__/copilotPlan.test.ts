import { describe, expect, it } from "vitest";

import { AgentEvent } from "../../AgentSession";
import { CopilotAgentSession, CopilotEventTranslator } from "../CopilotProvider";

/*
 * The Copilot runtime's plan for the chat's plan strip, from its two
 * to-do sources: the `todos` table in its session database (read when
 * `session.todos_changed` says it changed) and its `update_todo` tool.
 * See plan.ts.
 */

/** The SDK's event shape, as much of it as a case needs. */
function event(type: string, data: Record<string, unknown> = {}, agentId?: string) {

    return agentId ? { type, data, agentId } : { type, data };
}

describe("the update_todo tool", () => {

    it("is logged as a notice, not drawn as a tool call", () => {

        const translator = new CopilotEventTranslator();

        const start = translator.translate(event("tool.execution_start", {
            toolName: "update_todo",
            toolCallId: "t1",
            arguments: { todos: "- [ ] One" }
        }));

        expect(start.kind).toBe("notice");
        expect(start.kind === "notice" && start.text).toBe('update_todo: {"todos":"- [ ] One"}');
        expect(start.kind === "notice" && start.plan).toBeUndefined();
    });

    it("hands its checklist on as the plan once the call succeeds", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", {
            toolName: "update_todo",
            toolCallId: "t1",
            arguments: { todos: "- [x] Read the code\n- [ ] Write the tests" }
        }));

        const end = translator.translate(event("tool.execution_complete", { toolCallId: "t1", success: true }));

        expect(end.kind).toBe("notice");
        expect(end.kind === "notice" && end.plan).toEqual([
            { text: "Read the code", status: "completed" },
            { text: "Write the tests", status: "pending" }
        ]);
        expect(end.kind === "notice" && end.text).toBe("Plan: 1 of 2 done.\n[x] Read the code\n[ ] Write the tests");
    });

    it("sends no plan when the call failed", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", {
            toolName: "update_todo",
            toolCallId: "t1",
            arguments: { todos: "- [ ] One" }
        }));

        const end = translator.translate(event("tool.execution_complete", { toolCallId: "t1", success: false }));

        expect(end.kind).toBe("notice");
        expect(end.kind === "notice" && end.plan).toBeUndefined();
        expect(end.kind === "notice" && end.text.startsWith("update_todo failed")).toBe(true);
    });

    it("keeps a sub-agent's list marked as the sub-agent's", () => {

        const translator = new CopilotEventTranslator();

        translator.translate(event("tool.execution_start", {
            toolName: "update_todo",
            toolCallId: "t1",
            arguments: { todos: "- [ ] One" }
        }, "agent-1"));

        const end = translator.translate(event("tool.execution_complete", { toolCallId: "t1", success: true }, "agent-1"));

        expect(end.agent).toBeDefined();
    });
});

/** A session over a fake SDK session whose to-do table reads as `read` says. */
function sessionWith(read: () => Promise<{ rows: unknown[] }>) {

    let emit: (event: unknown) => void = () => undefined;

    const sdk = {
        sessionId: "copilot-1",
        on: (handler: (event: unknown) => void) => {

            emit = handler;

            return () => undefined;
        },
        rpc: { plan: { readSqlTodos: read } }
    };

    const session = new CopilotAgentSession({} as never, sdk as never);

    const events: AgentEvent[] = [];

    session.on(one => events.push(one));

    return { emit: (one: unknown) => emit(one), events };
}

/** Lets the queued to-do reads finish. */
async function settled(): Promise<void> {

    for (let i = 0; i < 10; i++)
        await Promise.resolve();
}

describe("the to-do table", () => {

    it("is read when it changes, and sent as the plan", async () => {

        const { emit, events } = sessionWith(async () => ({
            rows: [
                { id: "a", title: "Read the code", status: "done" },
                { id: "b", title: "Write the tests", status: "in_progress" },
                { id: "c", title: "Ship it", status: "blocked" }
            ]
        }));

        emit(event("session.todos_changed"));

        await settled();

        const plans = events.filter(one => one.kind === "notice" && one.plan);

        expect(plans).toHaveLength(1);
        expect(plans[0].kind === "notice" && plans[0].plan).toEqual([
            { text: "Read the code", status: "completed" },
            { text: "Write the tests", status: "in_progress" },
            { text: "Ship it", status: "pending" }
        ]);
        expect(plans[0].agent).toBeUndefined();
    });

    it("sends the lists in the order the changes came, even when a read is slow", async () => {

        const reads = [
            { delay: 20, rows: [{ title: "Old", status: "pending" }] },
            { delay: 0, rows: [{ title: "New", status: "pending" }] }
        ];

        const { emit, events } = sessionWith(() => {

            const next = reads.shift()!;

            return new Promise(resolve => setTimeout(() => resolve({ rows: next.rows }), next.delay));
        });

        emit(event("session.todos_changed"));
        emit(event("session.todos_changed"));

        await new Promise(resolve => setTimeout(resolve, 50));

        const texts = events.flatMap(one => one.kind === "notice" && one.plan ? [one.plan[0].text] : []);

        expect(texts).toEqual(["Old", "New"]);
    });

    it("marks a sub-agent's change as the sub-agent's", async () => {

        const { emit, events } = sessionWith(async () => ({ rows: [{ title: "One", status: "pending" }] }));

        emit(event("session.todos_changed", {}, "agent-1"));

        await settled();

        const plan = events.find(one => one.kind === "notice" && one.plan);

        expect(plan?.agent).toBeDefined();
    });

    it("says so in the log when the table cannot be read", async () => {

        const { emit, events } = sessionWith(async () => { throw new Error("no database"); });

        emit(event("session.todos_changed"));

        await settled();

        const notice = events.find(one => one.kind === "notice" && one.text.startsWith("Could not read"));

        expect(notice?.kind === "notice" && notice.text).toBe("Could not read Copilot's to-do list: no database");
        expect(events.some(one => one.kind === "notice" && one.plan)).toBe(false);
    });
});

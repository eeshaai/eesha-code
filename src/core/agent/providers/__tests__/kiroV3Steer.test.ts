import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../AgentSession";
import { KIRO_V3_AGENT_FILE_ERROR, KIRO_V3_STEER, kiroV3AgentFileErrorText, kiroV3Extension, readKiroV3Info, steerKiroV3 } from "../kiroV3AcpExtension";
import { kiroSessionsFrom, messagesFrom } from "../kiroSessions";

/*
 * Kiro CLI 3.2.1, in the shapes it sends:
 * `_session/steer`, the steering updates, the agent file error, and what
 * `session/list` and a `session/load` replay give back.
 */

function turn(answer?: (method: string, params: unknown) => Promise<unknown>) {

    const notes = new Map<string, unknown>();
    const requests: { method: string; params: unknown }[] = [];

    return {
        requests,
        sessionId: "sess_1",
        charge: () => undefined,
        note: (key: string, value: unknown) => { notes.set(key, value); },
        noted: (key: string) => notes.get(key),
        request: async (method: string, params: unknown) => {
            requests.push({ method, params });
            return answer ? answer(method, params) : undefined;
        }
    };
}

function info(kiro: Record<string, unknown>) {

    return { sessionUpdate: "session_info_update", _meta: { kiro } };
}

const textOf = (event: AgentEvent | undefined) => (event as { text?: string } | undefined)?.text;

describe("steerKiroV3", () => {

    it("sends the message as plain text, as Kiro takes it", async () => {

        const session = turn(async () => ({ queued: true, messageId: "steer-1" }));

        expect(await steerKiroV3(session, "After the numbers, write STEERED.")).toEqual({ ok: true });
        expect(session.requests).toEqual([{ method: KIRO_V3_STEER, params: { sessionId: "sess_1", message: "After the numbers, write STEERED." } }]);
    });

    it("says why when Kiro drops it", async () => {

        const session = turn(async () => ({ queued: false, messageId: "steer-1", dropped: "epoch_changed" }));

        const result = await steerKiroV3(session, "hi");

        expect(result.ok).toBe(false);
        expect(result.reason).toContain("epoch_changed");
        expect(result.reason).toContain("Send it again");
    });

    it("says why when Kiro refuses the request", async () => {

        const session = turn(async () => { throw new Error("_session/steer: missing or empty message"); });

        const result = await steerKiroV3(session, "hi");

        expect(result.ok).toBe(false);
        expect(result.reason).toContain("missing or empty message");
    });

    it("sends nothing for an empty message", async () => {

        const session = turn();

        expect((await steerKiroV3(session, "  ")).ok).toBe(false);
        expect(session.requests).toEqual([]);
    });

    it("is what the kiro-v3 extension steers with", () => {

        expect(kiroV3Extension.steer).toBeDefined();
    });
});

describe("Kiro's steering updates", () => {

    it("says the message is waiting, then that the agent has it, and nothing on the clear", () => {

        const session = turn();

        expect(textOf(readKiroV3Info(info({ kind: "steering_queued", messageId: "steer-1", content: "x" }), session))).toContain("waiting");
        expect(textOf(readKiroV3Info(info({ kind: "steering_injected", messageId: "steer-1", content: "x" }), session))).toBe("Kiro added your message to the running turn.");
        expect(readKiroV3Info(info({ kind: "steering_cleared", messageIds: ["steer-1"] }), session)).toBeUndefined();
    });

    it("says a message cleared before the agent read it was dropped", () => {

        const session = turn();

        readKiroV3Info(info({ kind: "steering_queued", messageId: "steer-2" }), session);

        expect(textOf(readKiroV3Info(info({ kind: "steering_cleared", messageIds: ["steer-2"] }), session))).toContain("dropped your message");
    });

    it("leaves a replayed update alone", () => {

        expect(readKiroV3Info(info({ kind: "steering_queued", messageId: "steer-3", replay: true }), turn())).toBeUndefined();
    });
});

describe("kiroV3AgentFileErrorText", () => {

    it("names the file and why", () => {

        expect(kiroV3AgentFileErrorText({ sessionId: "s", path: "C:\\x\\.kiro\\agents\\a.json", reasonCode: "invalid_json", error: "Unexpected token" }))
            .toBe("Kiro could not load an agent file (C:\\x\\.kiro\\agents\\a.json): Unexpected token.");
    });

    it("says nothing when Kiro sent neither", () => {

        expect(kiroV3AgentFileErrorText({ sessionId: "s" })).toBeUndefined();
    });

    it("is read by the kiro-v3 extension", () => {

        expect(kiroV3Extension.notifications?.[KIRO_V3_AGENT_FILE_ERROR]).toBeDefined();
    });
});

describe("messagesFrom", () => {

    it("joins a message's chunks, keeps Kiro's ids, and leaves out its empty markers", () => {

        const user = (text: string, messageId: string) => ({ sessionUpdate: "user_message_chunk", content: { type: "text", text }, _meta: { kiro: { messageId } } });
        const agent = (text: string, messageId: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, _meta: { kiro: { messageId } } });

        expect(messagesFrom([
            user("Write 1 to 3", "u1"),
            agent("1\n2", "a1-say"),
            agent("\n3", "a1-say"),
            { sessionUpdate: "tool_call", toolCallId: "t" },
            user("Then STEERED", "steer-1"),
            agent("STEERED", "a2-say"),
            user("", "steering_boundary_1"),
            user("Next", "u2")
        ])).toEqual([
            { role: "user", text: "Write 1 to 3", messageId: "u1" },
            { role: "agent", text: "1\n2\n3", messageId: "a1-say" },
            { role: "user", text: "Then STEERED", messageId: "steer-1" },
            { role: "agent", text: "STEERED", messageId: "a2-say" },
            { role: "user", text: "Next", messageId: "u2" }
        ]);
    });
});

describe("kiroSessionsFrom", () => {

    it("reads session/list's rows, and skips one with no folder", () => {

        expect(kiroSessionsFrom([
            { sessionId: "sess_a", cwd: "C:\\work\\api", title: "Fix the build", updatedAt: "2026-11-12T16:52:41.932Z", _meta: { kiro: { status: "idle" } } },
            { sessionId: "sess_b", cwd: "C:\\work\\api", title: " ", updatedAt: "bad", _meta: { kiro: { status: "in_progress" } } },
            { sessionId: "sess_c" }
        ])).toEqual([
            { sessionId: "sess_a", cwd: "C:\\work\\api", title: "Fix the build", at: Date.parse("2026-11-12T16:52:41.932Z"), working: false },
            { sessionId: "sess_b", cwd: "C:\\work\\api", title: "Kiro session", at: 0, working: true }
        ]);
    });
});

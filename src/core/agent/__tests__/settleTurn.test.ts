import { describe, expect, it, vi } from "vitest";

import { SettleableSession, settleTurn } from "../providers/CopilotProvider";

/**
 * When a Copilot turn is over. The SDK's `sendAndWait` returns on the
 * first `session.idle`, which can be a sub-agent's or arrive while a
 * background agent still runs. `settleTurn` treats events as wake-ups
 * and asks the runtime: main-agent idle first, then
 * `tasks.waitForPending()` plus `metadata.activity()`. The session
 * here is a plain object: no CLI, no SDK client.
 */

type Emitted = { type: string; data?: Record<string, unknown>; agentId?: string };

function fakeSession(overrides?: {
    waitForPending?: () => Promise<unknown>;
    activity?: () => Promise<{ hasActiveWork: boolean }>;
}) {

    const handlers = new Set<(event: Emitted) => void>();

    const waitForPending = vi.fn(overrides?.waitForPending ?? (async () => ({})));
    const activity = vi.fn(overrides?.activity ?? (async () => ({ hasActiveWork: false })));

    const session: SettleableSession = {

        on(handler) {

            handlers.add(handler);

            return () => handlers.delete(handler);
        },

        rpc: {
            tasks: { waitForPending },
            metadata: { activity }
        }
    };

    return {
        session,
        waitForPending,
        activity,
        emit: (event: Emitted) => [...handlers].forEach(handler => handler(event))
    };
}

/** Lets queued microtasks and the fake session's async RPCs run out. */
const drainMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

describe("settleTurn", () => {

    it("resolves on the main agent's idle once the runtime is drained", async () => {

        const s = fakeSession();

        const turn = settleTurn(s.session, async () => { }, 1000);

        s.emit({ type: "session.idle" });

        await expect(turn).resolves.toBeUndefined();

        expect(s.waitForPending).toHaveBeenCalledTimes(1);
        expect(s.activity).toHaveBeenCalledTimes(1);
    });

    /* A sub-agent going quiet is not the turn ending. */
    it("ignores a sub-agent's idle", async () => {

        const s = fakeSession();

        let settled = false;

        const turn = settleTurn(s.session, async () => { }, 1000)
            .then(() => { settled = true; });

        s.emit({ type: "session.idle", agentId: "agent-1" });

        await drainMicrotasks();

        expect(settled).toBe(false);
        expect(s.activity).not.toHaveBeenCalled();

        s.emit({ type: "session.idle" });

        await turn;
    });

    /* The drain check is the authority, not the event. */
    it("keeps waiting while the runtime reports active work", async () => {

        const s = fakeSession();

        s.activity
            .mockResolvedValueOnce({ hasActiveWork: true })
            .mockResolvedValue({ hasActiveWork: false });

        let settled = false;

        const turn = settleTurn(s.session, async () => { }, 1000)
            .then(() => { settled = true; });

        s.emit({ type: "session.idle" });

        await drainMicrotasks();

        expect(settled).toBe(false);

        // A background task finishing does not always run another turn,
        // so no second idle may come. This event is the wake-up.
        s.emit({ type: "session.background_tasks_changed" });

        await turn;

        expect(s.activity).toHaveBeenCalledTimes(2);
    });

    /* Before the first idle the turn is still starting, and asking the
     * runtime about active work would race it. */
    it("does not consult the runtime before the main agent has yielded once", async () => {

        const s = fakeSession();

        let settled = false;

        const turn = settleTurn(s.session, async () => { }, 1000)
            .then(() => { settled = true; });

        s.emit({ type: "session.background_tasks_changed" });

        await drainMicrotasks();

        expect(settled).toBe(false);
        expect(s.waitForPending).not.toHaveBeenCalled();

        s.emit({ type: "session.idle" });

        await turn;
    });

    it("rejects on the main agent's error, with its message", async () => {

        const s = fakeSession();

        const turn = settleTurn(s.session, async () => { }, 1000);

        s.emit({ type: "session.error", data: { message: "model exploded" } });

        await expect(turn).rejects.toThrow("model exploded");
    });

    it("does not fail the turn for a sub-agent's error", async () => {

        const s = fakeSession();

        const turn = settleTurn(s.session, async () => { }, 1000);

        // The main agent sees this as a failed tool call and carries on.
        s.emit({ type: "session.error", agentId: "agent-1", data: { message: "sub-agent died" } });
        s.emit({ type: "session.idle" });

        await expect(turn).resolves.toBeUndefined();
    });

    it("times out when the session never settles", async () => {

        const s = fakeSession();

        await expect(settleTurn(s.session, async () => { }, 10))
            .rejects.toThrow("waiting for the session to settle");
    });

    it("waits with no limit when told null, and still settles on idle", async () => {

        const s = fakeSession();

        let done = false;

        const turn = settleTurn(s.session, async () => { }, null).then(() => { done = true; });

        // Longer than any timeout the other tests use; nothing fires.
        await new Promise(resolve => setTimeout(resolve, 30));

        expect(done).toBe(false);

        s.emit({ type: "session.idle" });

        await expect(turn).resolves.toBeUndefined();
    });

    /* The drain RPCs are experimental in SDK 1.0.11. If a future SDK
     * moves them, completion must fall back to the idle event, not hang. */
    it("falls back to the idle event when the drain RPCs are unavailable", async () => {

        const s = fakeSession({
            waitForPending: async () => { throw new Error("no such method"); }
        });

        const turn = settleTurn(s.session, async () => { }, 1000);

        s.emit({ type: "session.idle" });

        await expect(turn).resolves.toBeUndefined();
    });

    /* Lost-wakeup race: the second idle lands while the first drain
     * check is still in flight. It must be consumed, not waited for. */
    it("does not miss an idle that arrives during the drain check", async () => {

        const s = fakeSession();

        let releaseFirstDrain: (() => void) | undefined;

        s.waitForPending
            .mockImplementationOnce(() => new Promise<unknown>(resolve => {
                releaseFirstDrain = () => resolve({});
            }))
            .mockResolvedValue({});

        s.activity
            .mockResolvedValueOnce({ hasActiveWork: true })
            .mockResolvedValue({ hasActiveWork: false });

        const turn = settleTurn(s.session, async () => { }, 1000);

        s.emit({ type: "session.idle" });

        await drainMicrotasks();

        // The drain is mid-flight; the follow-up turn ends now.
        s.emit({ type: "session.idle" });

        releaseFirstDrain?.();

        await expect(turn).resolves.toBeUndefined();
    });
});

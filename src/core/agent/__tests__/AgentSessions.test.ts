import { describe, expect, it } from "vitest";
import { AgentEvent, AgentSession } from "../AgentSession";
import { AgentSessions } from "../AgentSessions";

/**
 * The registry that keeps a conversation alive past the call that
 * started it, republishes its events, and answers whether something is
 * already working on a piece of work.
 */

/** A session that reports what was done to it and can be made to emit. */
function session(id = "chat-1") {

    const handlers = new Set<(event: AgentEvent) => void>();

    const calls: string[] = [];

    const fake: AgentSession = {
        id,
        status: "working",
        send: async () => void calls.push("send"),
        sendAndWait: async () => void calls.push("sendAndWait"),
        abort: async () => void calls.push("abort"),
        dispose: async () => void calls.push("dispose"),
        on: handler => {

            handlers.add(handler);

            return () => handlers.delete(handler);
        }
    };

    const emit = (event: AgentEvent) => {

        for (const handler of [...handlers])
            handler(event);
    };

    return { fake, calls, emit, subscribers: () => handlers.size };
}

const idle = (): AgentEvent => ({ kind: "idle", name: "session.idle", raw: {} });

const message = (text: string): AgentEvent => ({ kind: "message", name: "assistant.message", text, raw: {} });

describe("holding a conversation past the task that started it", () => {

    it("keeps it, and can hand it back by id", () => {

        const sessions = new AgentSessions();
        const held = session();

        sessions.hold("sdd:specs/one", held.fake);

        expect(sessions.get("chat-1")).toBe(held.fake);
        expect(held.calls).toEqual([]);
    });

    it("groups by owner, newest first", () => {

        let clock = 0;
        const sessions = new AgentSessions(() => ++clock);

        sessions.hold("spec-a", session("first").fake);
        sessions.hold("spec-b", session("other").fake);
        sessions.hold("spec-a", session("second").fake);

        expect(sessions.forOwner("spec-a").map(entry => entry.id)).toEqual(["second", "first"]);
    });

    /*
     * A task's callbacks die with the task; a surface subscribes here
     * instead and keeps listening after the task returned.
     */
    it("republishes everything the session says, to whoever is listening", () => {

        const sessions = new AgentSessions();
        const held = session();

        const heard: [string, string][] = [];

        sessions.on((id, event) => heard.push([id, event.kind]));
        sessions.hold("owner", held.fake);

        held.emit(message("still working"));

        expect(heard).toEqual([["chat-1", "message"]]);
    });

    it("stops telling a listener that unsubscribed", () => {

        const sessions = new AgentSessions();
        const held = session();

        const heard: string[] = [];

        const stop = sessions.on((_id, event) => heard.push(event.kind));

        sessions.hold("owner", held.fake);

        held.emit(message("one"));
        stop();
        held.emit(message("two"));

        expect(heard).toEqual(["message"]);
    });
});

describe("letting it go", () => {

    it("ends a session held until idle, when it goes idle", async () => {

        const sessions = new AgentSessions();
        const held = session();

        sessions.hold("owner", held.fake, { untilIdle: true });

        held.emit(idle());

        // The end is async; the decision to end is not.
        await Promise.resolve();

        expect(held.calls).toEqual(["dispose"]);
        expect(sessions.get("chat-1")).toBeUndefined();
    });

    it("keeps holding one that was not asked to end at idle", async () => {

        const sessions = new AgentSessions();
        const held = session();

        sessions.hold("owner", held.fake);

        held.emit(idle());
        await Promise.resolve();

        expect(held.calls).toEqual([]);
        expect(sessions.get("chat-1")).toBe(held.fake);
    });

    it("unsubscribes when it lets go, so a dead session cannot still be heard", async () => {

        const sessions = new AgentSessions();
        const held = session();

        sessions.hold("owner", held.fake);

        expect(held.subscribers()).toBe(1);

        await sessions.end("chat-1");

        expect(held.subscribers()).toBe(0);
    });

    it("survives a session that throws on the way out", async () => {

        const sessions = new AgentSessions();

        const stubborn: AgentSession = {
            ...session().fake,
            dispose: async () => { throw new Error("no"); }
        };

        await expect(sessions.end(stubborn.id)).resolves.toBeUndefined();

        sessions.hold("owner", stubborn);

        await expect(sessions.end(stubborn.id)).resolves.toBeUndefined();
        expect(sessions.get(stubborn.id)).toBeUndefined();
    });

    it("ends everything, for a server shutting down", async () => {

        const sessions = new AgentSessions();
        const one = session("one");
        const two = session("two");

        sessions.hold("owner", one.fake);
        sessions.hold("owner", two.fake);

        await sessions.endAll();

        expect(one.calls).toEqual(["dispose"]);
        expect(two.calls).toEqual(["dispose"]);
        expect(sessions.all()).toEqual([]);
    });

    /*
     * The same id twice is the same conversation. Two subscriptions to
     * it would report everything twice.
     */
    it("replaces a session held under an id it already has", () => {

        const sessions = new AgentSessions();
        const held = session();

        const heard: string[] = [];

        sessions.on((_id, event) => heard.push(event.kind));

        sessions.hold("owner", held.fake);
        sessions.hold("owner", held.fake);

        held.emit(message("once"));

        expect(heard).toEqual(["message"]);
        expect(sessions.all()).toHaveLength(1);
    });

    /*
     * Why a session is not here any more. "It ended" and "it was never
     * here" have different causes, and a caller told only `undefined`
     * cannot tell them apart. `ai@1` says which when it cannot honour a
     * `continueSession`.
     */
    describe("departureOf", () => {

        it("says nothing about an id this registry has never held", () => {

            expect(new AgentSessions().departureOf("never-here")).toBeUndefined();
        });

        it("does not count a first hold as a departure", () => {

            const sessions = new AgentSessions();

            sessions.hold("owner", session().fake);

            expect(sessions.departureOf("chat-1")).toBeUndefined();
        });

        it("records a session that was ended", async () => {

            const sessions = new AgentSessions();

            sessions.hold("owner", session().fake);

            await sessions.end("chat-1");

            expect(sessions.departureOf("chat-1")?.reason).toBe("ended");
        });

        it("records a session that was forgotten", () => {

            const sessions = new AgentSessions();

            sessions.hold("owner", session().fake);
            sessions.forget("chat-1");

            expect(sessions.departureOf("chat-1")?.reason).toBe("forgotten");
        });

        // Named separately from the endings: a task holding the same
        // session twice has not ended anything.
        it("records a session that was replaced by a second hold", () => {

            const sessions = new AgentSessions();
            const held = session();

            sessions.hold("owner", held.fake);
            sessions.hold("owner", held.fake);

            expect(sessions.departureOf("chat-1")?.reason).toBe("replaced");
            expect(sessions.get("chat-1")).toBeDefined();
        });
    });
});

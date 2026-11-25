import { describe, expect, it } from "vitest";

import { AgentEvent, DELTA_INTERVAL_MS, describeEvent } from "../AgentSession";
import { ClaudeEventTranslator } from "../providers/ClaudeProvider";

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CopilotEventTranslator } from "../providers/CopilotProvider";
import { AcpEventTranslator } from "../providers/AcpProvider";

/**
 * The answer as it is being written. Three rules, the same for all
 * three providers:
 *
 *   1. a delta carries the whole block so far, not the piece that just
 *      arrived, so a consumer that missed one is not left short;
 *   2. deltas are throttled, because every one is sent to the page;
 *   3. a delta is never logged or stored; the completed event behind
 *      it is the record.
 */

/** A clock a test moves by hand, so the throttle is pinned rather than waited out. */
function clock(): { now: () => number; pass(ms: number): void } {

    let at = 1_000;

    return { now: () => at, pass: ms => { at += ms; } };
}

const past = DELTA_INTERVAL_MS + 1;

/** The text of every delta a run of events produced, in order. */
function painted(events: readonly AgentEvent[]): string[] {

    return events.filter(event => event.kind === "delta").map(event => (event as { text: string }).text);
}

/**
 * The Claude translator, with fixtures naming only the fields the case
 * is about. `SDKMessage` members carry many required fields, so the
 * cast lives here once.
 */
function claude(now?: () => number): { translate(fixture: unknown): AgentEvent[] } {

    const translator = new ClaudeEventTranslator(now);

    return { translate: fixture => translator.translate(fixture as SDKMessage) };
}

describe("what a delta is", () => {

    it("is never logged and never stored", () => {

        const line = describeEvent({
            kind: "delta", channel: "message", text: "half a sen", name: "stream_event", raw: {}
        });

        expect(line?.ephemeral).toBe(true);
        expect(line?.channel).toBe("message");
        expect(line?.text).toBe("half a sen");
    });

    it("puts thinking on the system stream, the same as a finished thought", () => {

        const thinking = describeEvent({
            kind: "delta", channel: "reasoning", text: "let me check", name: "stream_event", raw: {}
        });

        expect(thinking?.stream).toBe("system");

        expect(describeEvent({
            kind: "delta", channel: "message", text: "hello", name: "stream_event", raw: {}
        })?.stream).toBe("stdout");
    });
});

describe("Claude streaming", () => {

    /** One `stream_event` frame carrying a piece of text. */
    const chunk = (text: string) => ({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "text_delta", text } }
    });

    const thinking = (text: string) => ({
        type: "stream_event",
        parent_tool_use_id: null,
        event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: text } }
    });

    it("accumulates, so each delta is the whole block so far", () => {

        const time = clock();
        const translator = claude(time.now);

        const first = translator.translate(chunk("Hello"));

        time.pass(past);

        const second = translator.translate(chunk(" there"));

        expect(painted(first)).toEqual(["Hello"]);
        expect(painted(second)).toEqual(["Hello there"]);
    });

    it("throttles - a chunk inside the interval is folded into the next one", () => {

        const time = clock();
        const translator = claude(time.now);

        translator.translate(chunk("a"));

        // Same instant: nothing published, but the text is not lost.
        expect(painted(translator.translate(chunk("b")))).toEqual([]);

        time.pass(past);

        expect(painted(translator.translate(chunk("c")))).toEqual(["abc"]);
    });

    it("keeps thinking and prose in separate buffers", () => {

        const time = clock();
        const translator = claude(time.now);

        translator.translate(thinking("checking"));

        time.pass(past);

        const events = translator.translate(chunk("Done."));

        expect(events[0].kind).toBe("delta");
        expect((events[0] as { channel: string }).channel).toBe("message");
        expect((events[0] as { text: string }).text).toBe("Done.");
    });

    it("starts a new block on message_start, so one message never bleeds into the next", () => {

        const time = clock();
        const translator = claude(time.now);

        translator.translate(chunk("first"));

        translator.translate({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start" } });

        time.pass(past);

        expect(painted(translator.translate(chunk("second")))).toEqual(["second"]);
    });

    it("clears the buffer when the completed message lands - that one is the record", () => {

        const time = clock();
        const translator = claude(time.now);

        translator.translate(chunk("Hello"));

        const complete = translator.translate({
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: [{ type: "text", text: "Hello there" }] }
        });

        expect(complete.map(event => event.kind)).toEqual(["message"]);

        time.pass(past);

        // The next message starts from nothing, not from "Hello".
        expect(painted(translator.translate(chunk("Next")))).toEqual(["Next"]);
    });

    it("says nothing about a frame that carries no text", () => {

        const translator = claude(clock().now);

        expect(translator.translate({
            type: "stream_event",
            parent_tool_use_id: null,
            event: { type: "content_block_stop" }
        })).toEqual([]);
    });

    /*
     * `forwardSubagentText` is on, so a delegated agent's text streams
     * up the same stream while the main agent is still writing. One
     * buffer per channel would splice the two together.
     */
    describe("with a sub-agent writing at the same time", () => {

        /** A frame from a delegated agent, which the translator attributes by `subagent_type`. */
        const sub = (text: string) => ({
            type: "stream_event",
            parent_tool_use_id: null,
            subagent_type: "Explore",
            event: { type: "content_block_delta", delta: { type: "text_delta", text } }
        });

        it("keeps each speaker's text to itself", () => {

            const time = clock();
            const translator = claude(time.now);

            translator.translate(chunk("The main agent "));

            time.pass(past);

            expect(painted(translator.translate(sub("A sub-agent ")))).toEqual(["A sub-agent "]);

            time.pass(past);

            // Not "The main agent A sub-agent says…".
            expect(painted(translator.translate(chunk("says this."))))
                .toEqual(["The main agent says this."]);
        });

        it("does not let one speaker's message_start clear the other's buffer", () => {

            const time = clock();
            const translator = claude(time.now);

            translator.translate(chunk("Half a "));

            translator.translate({
                type: "stream_event",
                parent_tool_use_id: null,
                subagent_type: "Explore",
                event: { type: "message_start" }
            });

            time.pass(past);

            expect(painted(translator.translate(chunk("sentence.")))).toEqual(["Half a sentence."]);
        });

        it("does not let one speaker's completed message clear the other's buffer", () => {

            const time = clock();
            const translator = claude(time.now);

            translator.translate(chunk("Half a "));

            translator.translate({
                type: "assistant",
                parent_tool_use_id: null,
                subagent_type: "Explore",
                message: { content: [{ type: "text", text: "The sub-agent finished." }] }
            });

            time.pass(past);

            expect(painted(translator.translate(chunk("sentence.")))).toEqual(["Half a sentence."]);
        });

        it("gives each speaker its own throttle budget", () => {

            const time = clock();
            const translator = claude(time.now);

            translator.translate(chunk("main"));

            // Same instant. The main agent's frame used the slot; the
            // sub-agent's is a different speaker and must still paint.
            expect(painted(translator.translate(sub("sub")))).toEqual(["sub"]);
        });
    });
});

describe("Copilot streaming", () => {

    const chunk = (deltaContent: string, agentId?: string) => agentId
        ? { type: "assistant.message_delta", data: { deltaContent }, agentId }
        : { type: "assistant.message_delta", data: { deltaContent } };

    it("accumulates, so each delta is the whole block so far", () => {

        const time = clock();
        const translator = new CopilotEventTranslator(time.now);

        expect(painted([translator.translate(chunk("Hello"))])).toEqual(["Hello"]);

        time.pass(past);

        expect(painted([translator.translate(chunk(" there"))])).toEqual(["Hello there"]);
    });

    it("throttles, and a throttled chunk becomes nothing a consumer acts on", () => {

        const time = clock();
        const translator = new CopilotEventTranslator(time.now);

        translator.translate(chunk("a"));

        expect(translator.translate(chunk("b")).kind).toBe("other");

        time.pass(past);

        expect(painted([translator.translate(chunk("c"))])).toEqual(["abc"]);
    });

    /* One shared buffer would splice two speakers' sentences together. */
    it("keeps each speaker's text apart", () => {

        const time = clock();
        const translator = new CopilotEventTranslator(time.now);

        translator.translate(chunk("main says"));
        translator.translate(chunk("helper says", "agent-2"));

        time.pass(past);

        const helper = translator.translate(chunk(" more", "agent-2"));

        expect(painted([helper])).toEqual(["helper says more"]);
        expect((helper as { agent?: string }).agent).toBeDefined();
    });

    it("clears the buffer when the completed message lands", () => {

        const time = clock();
        const translator = new CopilotEventTranslator(time.now);

        translator.translate(chunk("Hello"));
        translator.translate({ type: "assistant.message", data: { content: "Hello there" } });

        time.pass(past);

        expect(painted([translator.translate(chunk("Next"))])).toEqual(["Next"]);
    });
});

describe("ACP streaming", () => {

    const chunk = (text: string) => ({
        sessionUpdate: "agent_message_chunk" as const,
        content: { type: "text" as const, text }
    });

    it("paints the buffer as it fills, and still flushes the whole thing at the end", () => {

        const time = clock();
        const translator = new AcpEventTranslator(time.now);

        const first = translator.translate(chunk("Hello"));

        time.pass(past);

        const second = translator.translate(chunk(" there"));

        expect(first?.kind).toBe("delta");
        expect((second as { text: string }).text).toBe("Hello there");

        // The flush is the record. The deltas took nothing away from it.
        const flushed = translator.flush();

        expect(flushed.map(event => event.kind)).toEqual(["message"]);
        expect((flushed[0] as { text: string }).text).toBe("Hello there");
    });

    it("throttles, and loses nothing by it", () => {

        const time = clock();
        const translator = new AcpEventTranslator(time.now);

        translator.translate(chunk("a"));

        expect(translator.translate(chunk("b"))).toBeUndefined();

        time.pass(past);

        expect((translator.translate(chunk("c")) as { text: string }).text).toBe("abc");
    });
});

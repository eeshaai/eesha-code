import { describe, expect, it } from "vitest";

import { AgentEvent } from "../../AgentSession";
import { ASK_SERVER_NAME, ASK_TOOL_FULL_NAME } from "../askTool";
import { ClaudeAgentSession, MessageQueue, sessionOptions } from "../ClaudeProvider";

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";

/**
 * Two rules:
 *
 *   1. a question is an `ask` event with an id, and `respond` with that
 *      id settles the wait - not `send`;
 *   2. a question left open when the session ends fails the wait, so
 *      nothing is held past a Stop.
 *
 * The asking itself is `askTool`'s and is tested there; it is the same
 * handler on all three providers.
 */

/** A stream that never yields - these tests never need a message from the SDK. */
function silentStream(): AsyncIterable<unknown> {

    return {
        [Symbol.asyncIterator]: () => ({
            next: () => new Promise<IteratorResult<unknown>>(() => undefined)
        })
    };
}

function session(): ClaudeAgentSession {

    return new ClaudeAgentSession(
        "test-session",
        silentStream() as never,
        new MessageQueue(),
        new AbortController(),
        async () => undefined,
        undefined,
        () => undefined
    );
}

describe("ClaudeAgentSession ask and respond", () => {

    it("raises an ask event with an id, and settles when that id is answered", async () => {

        const claude = session();
        const events: AgentEvent[] = [];

        claude.on(event => events.push(event));

        const pending = claude.ask({
            prompt: "Which store?",
            options: [{ label: "SQLite", description: "one file" }, { label: "Postgres" }],
            multi: false,
            raw: { questions: [] }
        });

        expect(events).toHaveLength(1);

        const ask = events[0];

        expect(ask.kind).toBe("ask");

        if (ask.kind !== "ask")
            return;

        expect(ask.askId).toBe(pending.askId);
        expect(ask.prompt).toBe("Which store?");
        expect(ask.options).toEqual([{ label: "SQLite", description: "one file" }, { label: "Postgres" }]);
        expect(ask.multi).toBeUndefined();

        // The event names our own tool, not the vendor's `AskUserQuestion`,
        // which this session does not have.
        expect(ask.name).toBe("mcp__eesha__ask_user");

        await claude.respond(pending.askId, "SQLite");

        expect(await pending.answer).toBe("SQLite");
    });

    it("rejects an answer to a question nobody is waiting on", async () => {

        const claude = session();

        await expect(claude.respond("not-a-question", "yes")).rejects.toThrow(/Nothing is waiting/);
    });

    it("takes one answer per question - a second answer to the same id is refused", async () => {

        const claude = session();
        const pending = claude.ask({ prompt: "Go?", raw: {} });

        await claude.respond(pending.askId, "yes");

        await expect(claude.respond(pending.askId, "no")).rejects.toThrow(/Nothing is waiting/);
        expect(await pending.answer).toBe("yes");
    });

    it("fails an open question when the session is disposed", async () => {

        const claude = session();
        const pending = claude.ask({ prompt: "Go?", raw: {} });

        await claude.dispose();

        await expect(pending.answer).rejects.toThrow(/session ended/);
    });

    it("refuses to ask on a session that has ended", async () => {

        const claude = session();

        await claude.dispose();

        expect(() => claude.ask({ prompt: "Go?", raw: {} })).toThrow(/has ended/);
    });
});

/**
 * How the tool reaches the model. `AskUserQuestion` cannot ask for free
 * text (its schema demands two to four options), so only ours is
 * offered.
 */
describe("sessionOptions and the ask tool", () => {

    /**
     * `sessionOptions` with an ask server. The real parameter carries a
     * live in-process server; a plain marker object stands in, since
     * these cases only check where the value lands.
     */
    function optionsWith(askServer?: unknown): Record<string, unknown> {

        return sessionOptions(
            { workingDirectory: "/work", env: {}, interactive: true },
            "sid",
            {},
            new AbortController(),
            undefined,
            undefined,
            undefined,
            askServer as McpSdkServerConfigWithInstance);
    }

    it("serves the ask tool from our own in-process server", () => {

        const server = { type: "sdk", name: ASK_SERVER_NAME };

        const servers = optionsWith(server).mcpServers as Record<string, unknown>;

        expect(servers[ASK_SERVER_NAME]).toBe(server);
    });

    it("turns the vendor's own question tool off", () => {

        expect(optionsWith({}).disallowedTools).toEqual(["AskUserQuestion"]);
    });

    it("says nothing about servers when there is no ask server and no settings ones", () => {

        expect(optionsWith(undefined).mcpServers).toBeUndefined();
    });

    /*
     * The ask tool's call carries no path, so it is approved like any
     * other call inside the session's directories. See
     * `claudeJail.test.ts` for calls that are not.
     */
    it("approves a tool call that names no path, with nothing special-cased", async () => {

        const canUseTool = optionsWith({}).canUseTool as
            (tool: string, input: unknown, options: unknown) => Promise<{ behavior: string }>;

        expect(await canUseTool(ASK_TOOL_FULL_NAME, { questions: [] }, {}))
            .toEqual({ behavior: "allow" });
    });
});

/**
 * The tool being present is not enough. A headless agent assumes nobody
 * is watching and ends the turn with a list of open decisions. The
 * system prompt line says otherwise, set once here rather than in every
 * prompt.
 */
describe("the interactive system prompt", () => {

    function promptOf(interactive: boolean | undefined): unknown {

        return sessionOptions(
            { workingDirectory: "/work", env: {}, interactive },
            "sid",
            {},
            new AbortController()).systemPrompt;
    }

    it("appends to the vendor's own preset rather than replacing it", () => {

        const prompt = promptOf(true) as { type: string; preset: string; append: string };

        expect(prompt.type).toBe("preset");
        expect(prompt.preset).toBe("claude_code");
        expect(prompt.append).toContain("ask_user");
        expect(prompt.append).toMatch(/watching/i);
    });

    it("says nothing at all when nobody is watching", () => {

        expect(promptOf(false)).toBeUndefined();
        expect(promptOf(undefined)).toBeUndefined();
    });
});

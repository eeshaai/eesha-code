import { describe, expect, it, vi } from "vitest";

import {
    claudeCutPoint, ClaudeHistorySdk, cutPoint, cutsClaude, forkClaudeConversation, TranscriptMessage, typedText
} from "../providers/claudeRewind";

/*
 * Cutting a saved Claude conversation just before a message the person
 * sent. The SDK is a stand-in: nothing here reads ~/.claude.
 */

let count = 0;

function user(content: unknown, extra: Partial<TranscriptMessage> = {}): TranscriptMessage {

    return { type: "user", uuid: `u${++count}`, parent_tool_use_id: null, message: { role: "user", content }, ...extra };
}

function answer(text: string): TranscriptMessage {

    return { type: "assistant", uuid: `a${++count}`, parent_tool_use_id: null, message: { role: "assistant", content: [{ type: "text", text }] } };
}

function toolResult(): TranscriptMessage {

    return user([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
}

describe("typedText", () => {

    it("reads a typed message, as a string or as text blocks", () => {

        expect(typedText(user("hello"))).toBe("hello");
        expect(typedText(user([{ type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }]))).toBe("one\ntwo");
    });

    it("is nothing for answers, tool results and sub-agents' messages", () => {

        expect(typedText(answer("hi"))).toBeUndefined();
        expect(typedText(toolResult())).toBeUndefined();
        expect(typedText(user("from a sub-agent", { parent_tool_use_id: "t9" }))).toBeUndefined();
    });
});

describe("cutPoint", () => {

    const first = user("Fix the login page");
    const firstAnswer = answer("Done.");
    const second = user("Now add a test\n\nAttached files (read these first):\n- spec.md: C:\\work\\spec.md");
    const call = answer("Reading.");
    const result = toolResult();
    const secondAnswer = answer("Added.");
    const caveat = user("<local-command-caveat>Caveat: ignore</local-command-caveat>");
    const third = user("Ship   it");
    const thirdAnswer = answer("Shipped.");

    const messages = [first, firstAnswer, second, call, result, secondAnswer, caveat, third, thirdAnswer];

    it("keeps everything up to the message before the one gone back to", () => {

        expect(cutPoint(messages, ["Now add a test\n", "Ship it\n"])).toEqual({ upTo: firstAnswer.uuid });
        expect(cutPoint(messages, ["Ship it"])).toEqual({ upTo: caveat.uuid });
    });

    it("keeps nothing for the conversation's first message", () => {

        expect(cutPoint(messages, ["Fix the login page", "Now add a test", "Ship it"])).toEqual({});
    });

    it("finds nothing when a message is missing - after a compact, say", () => {

        expect(cutPoint(messages, ["Something never sent", "Ship it"])).toBeUndefined();
        expect(cutPoint(messages, [])).toBeUndefined();
    });

    it("matches each message before the next one, not anywhere", () => {

        const again = user("Ship it");

        // "Ship it" sent twice: going back to the first of the two.
        expect(cutPoint([...messages, answer("Again?"), again, answer("Shipped again.")], ["Ship it", "Ship it"]))
            .toEqual({ upTo: caveat.uuid });
    });
});

describe("the SDK calls", () => {

    function sdk(messages: TranscriptMessage[]) {

        const fork = vi.fn(async () => ({ sessionId: "forked" }));
        const read = vi.fn(async () => messages);

        return {
            fork,
            read,
            sdk: Promise.resolve({ getSessionMessages: read, forkSession: fork } as unknown as ClaudeHistorySdk)
        };
    }

    it("reads the conversation in its folder and says where to cut, without forking", async () => {

        const one = user("one");
        const oneAnswer = answer("1");
        const two = user("two");

        const fake = sdk([one, oneAnswer, two, answer("2")]);

        await expect(claudeCutPoint("s1", "C:\\work", ["two"], fake.sdk)).resolves.toEqual({ kind: "at", upTo: oneAnswer.uuid });
        await expect(claudeCutPoint("s1", "C:\\work", ["one", "two"], fake.sdk)).resolves.toEqual({ kind: "empty" });

        expect(fake.read).toHaveBeenCalledWith("s1", { dir: "C:\\work" });
        expect(fake.fork).not.toHaveBeenCalled();
    });

    it("says why when it cannot cut", async () => {

        expect(await claudeCutPoint("s1", "C:\\work", ["two"], sdk([]).sdk))
            .toEqual({ kind: "unmatched", reason: "Claude has no saved conversation s1 under C:\\work." });

        expect(await claudeCutPoint("s1", "C:\\work", ["two"], sdk([user("one")]).sdk))
            .toMatchObject({ kind: "unmatched", reason: expect.stringContaining("not found") });

        const broken = Promise.resolve({ getSessionMessages: async () => { throw new Error("disk gone"); } } as unknown as ClaudeHistorySdk);

        expect(await claudeCutPoint("s1", "C:\\work", ["two"], broken))
            .toEqual({ kind: "unmatched", reason: "Claude's saved conversation could not be read: disk gone" });
    });

    it("forks up to the message, named", async () => {

        const fake = sdk([]);

        await expect(forkClaudeConversation("s1", "C:\\work", "a7", "Login fix", fake.sdk)).resolves.toEqual({ sessionId: "forked" });

        expect(fake.fork).toHaveBeenCalledWith("s1", { dir: "C:\\work", upToMessageId: "a7", title: "Login fix" });

        const broken = Promise.resolve({ forkSession: async () => { throw new Error("no such message"); } } as unknown as ClaudeHistorySdk);

        await expect(forkClaudeConversation("s1", "C:\\work", "a7", "Login fix", broken))
            .resolves.toEqual({ reason: "Claude's conversation could not be cut: no such message" });
    });
});

describe("cutsClaude", () => {

    it("is the two Claude runtimes only", () => {

        expect(cutsClaude("claude")).toBe(true);
        expect(cutsClaude("claude-cli")).toBe(true);
        expect(cutsClaude("ghcp")).toBe(false);
        expect(cutsClaude("kiro")).toBe(false);
        expect(cutsClaude(undefined)).toBe(false);
    });
});

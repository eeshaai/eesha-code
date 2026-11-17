import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { AgentEvent } from "../../AgentSession";
import { ClaudeTotals, ClaudeTotalsStore, fileTotalsStore } from "../claudeTotals";
import { ClaudeEventTranslator } from "../ClaudeProvider";

function memoryStore(): ClaudeTotalsStore {

    const kept = new Map<string, ClaudeTotals>();

    return { read: id => kept.get(id), write: (id, totals) => void kept.set(id, totals) };
}

/** One `result`, as the runtime sends it - running totals for the whole conversation. */
function result(translator: ClaudeEventTranslator, total: number, modelUsage: Record<string, unknown>): AgentEvent {

    return translator.translate({
        type: "result", subtype: "success", session_id: "s1",
        usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: total, modelUsage
    } as never)[0];
}

const SONNET = { costUSD: 0.1573, inputTokens: 39298, outputTokens: 13 };

describe("a reopened Claude conversation", () => {

    /*
     * "hi" on Sonnet, then the model changes to Opus, which reopens
     * the conversation in a new process. That process must not restore
     * the Sonnet totals, or the Opus turn would be billed both.
     */
    it("bills only the new turn, not the turns before the reopen", () => {

        const store = memoryStore();

        result(new ClaudeEventTranslator(undefined, store), 0.1573, { "claude-sonnet-5": SONNET });

        const reopened = result(new ClaudeEventTranslator(undefined, store), 0.4841, {
            "claude-sonnet-5": SONNET,
            "claude-opus-5-5": { costUSD: 0.3268, inputTokens: 40292, outputTokens: 222 }
        });

        expect(reopened).toMatchObject({
            cost: [{ amount: expect.closeTo(0.3268, 6), unit: "USD" }],
            models: [{ model: "claude-opus-5-5", inputTokens: 40292, outputTokens: 222 }]
        });

        expect((reopened as { models: unknown[] }).models).toHaveLength(1);
    });

    it("bills a reopen on the same model only for what it added", () => {

        const store = memoryStore();

        result(new ClaudeEventTranslator(undefined, store), 0.1573, { "claude-sonnet-5": SONNET });

        const reopened = result(new ClaudeEventTranslator(undefined, store), 0.2, {
            "claude-sonnet-5": { costUSD: 0.2, inputTokens: 79000, outputTokens: 50 }
        });

        expect(reopened).toMatchObject({
            cost: [{ amount: expect.closeTo(0.0427, 6) }],
            models: [{ model: "claude-sonnet-5", inputTokens: 39702, outputTokens: 37 }]
        });
    });

    it("counts from zero with nothing stored", () => {

        const first = result(new ClaudeEventTranslator(undefined, memoryStore()), 0.1573, { "claude-sonnet-5": SONNET });

        expect(first).toMatchObject({ cost: [{ amount: expect.closeTo(0.1573, 6) }] });
    });
});

describe("fileTotalsStore", () => {

    it("keeps totals by conversation across stores, and reads a missing file as empty", () => {

        const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-totals-")), "state", "claude-usage.json");

        expect(fileTotalsStore(file).read("s1")).toBeUndefined();

        fileTotalsStore(file).write("s1", { costUsd: 1.5, byModel: { m: { cost: 1.5, input: 10, output: 2, cached: 0 } } });

        expect(fileTotalsStore(file).read("s1")).toEqual({ costUsd: 1.5, byModel: { m: { cost: 1.5, input: 10, output: 2, cached: 0 } } });
    });
});

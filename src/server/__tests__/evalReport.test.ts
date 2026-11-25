// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import type { RunEvent } from "../../core/events/runEvents";
import { folderBytes, toolKind, turnReports } from "../evalReport";
import { costIn, costText, lowestOf, sizeText, timeText, totalsOf } from "../../web/evalNumbers";

/** A chat file's records for two turns: the first with two tool calls and a refused one, the second with none. */
function twoTurns(): RunEvent[] {

    const system = (at: number, text: string): RunEvent => ({ at, ownerId: "chat", stream: "system", text });

    return [
        { v: 1, kind: "open", runId: "chat:one", at: 900 },

        // A start that failed: no message was sent, so it is no turn.
        { kind: "error", at: 950, ownerId: "chat", stream: "stderr", text: "did not start" },

        system(1000, "Run ai@1"),
        system(1001, "Args: ..."),
        { kind: "session", at: 1200, ownerId: "chat", sessionId: "s1", provider: "claude", model: "opus" },
        { kind: "prompt", at: 1300, ownerId: "chat", stream: "stdout", text: "do it" },
        { kind: "tool.start", at: 2000, ownerId: "chat", tool: "Reading a.ts", callId: "c1" },
        { kind: "tool.end", at: 2500, ownerId: "chat", tool: "Reading a.ts", callId: "c1", ok: true },
        { kind: "tool.start", at: 3000, ownerId: "chat", tool: "Executing 'npm test'", callId: "c2" },
        { kind: "tool.end", at: 9000, ownerId: "chat", tool: "Executing 'npm test'", callId: "c2", ok: false, ms: 5800 },
        { kind: "notice", at: 9100, ownerId: "chat", stream: "system", text: "Refused", permission: { tool: "Read", input: "C:\\x", note: "refused: outside", refused: true } },
        system(9101, "Denied Read: refused: outside"),
        { kind: "message", at: 9500, ownerId: "chat", stream: "stdout", text: "done" },
        {
            kind: "notice", at: 10_000, ownerId: "chat", stream: "system", text: "Turn finished",
            cost: [{ amount: 0.25, unit: "USD", runtime: "claude" }],
            models: [{ model: "opus", runtime: "claude", inputTokens: 1000, cachedTokens: 400, outputTokens: 50 }],
            calls: 3
        },

        // Arrives after the turn is over: the account's limits.
        { kind: "notice", progress: true, at: 60_000, ownerId: "chat", stream: "system", text: "limits" },

        system(100_000, "Run ai@1"),
        { kind: "prompt", at: 100_200, ownerId: "chat", stream: "stdout", text: "and now this" },
        { kind: "message", at: 104_000, ownerId: "chat", stream: "stdout", text: "ok" },
        { kind: "notice", at: 104_500, ownerId: "chat", stream: "system", text: "Turn finished", cost: [{ amount: 0.05, unit: "USD", runtime: "claude" }], calls: 1 }
    ];
}

describe("toolKind", () => {

    it("counts a row under the first word of its title, or under the whole title when it names no action", () => {

        expect(toolKind("Executing 'npm test'")).toBe("Executing");
        expect(toolKind("Reading package.json")).toBe("Reading");
        expect(toolKind("Searching 'TODO'")).toBe("Searching");
        expect(toolKind("Read File")).toBe("Read File");
        expect(toolKind("Sub-agent: requirement-detailer")).toBe("Sub-agent");
        expect(toolKind("ToolSearch")).toBe("ToolSearch");
    });
});

describe("turnReports", () => {

    it("cuts a chat file into turns and adds each one up", () => {

        const [first, second, ...rest] = turnReports(twoTurns(), false);

        expect(rest).toEqual([]);

        // From the engine's own first line to the last line that is not a late progress line.
        expect(first).toMatchObject({ at: 1000, ms: 9000, toolMs: 6300, toolCalls: 2, failed: 1, refused: 1, modelCalls: 3, inputTokens: 1000, cachedTokens: 400, outputTokens: 50 });
        expect(first!.cost).toEqual([{ amount: 0.25, unit: "USD" }]);
        expect(first!.tools).toEqual([
            { tool: "Executing", calls: 1, ms: 5800, failed: 1 },
            { tool: "Reading", calls: 1, ms: 500, failed: 0 }
        ]);
        expect(first!.calls).toEqual([
            { title: "Reading a.ts", kind: "Reading", ms: 500 },
            { title: "Executing 'npm test'", kind: "Executing", ms: 5800, failed: true }
        ]);
        expect(first!.findings).toBeUndefined();
        expect(first!.running).toBeUndefined();

        expect(second).toMatchObject({ at: 100_000, ms: 4500, toolMs: 0, toolCalls: 0, refused: 0, modelCalls: 1 });
        expect(second!.inputTokens).toBeUndefined();
    });

    it("keeps the model ids the runtime said it used, and nothing when it said none", () => {

        const [first, second] = turnReports(twoTurns(), false);

        expect(first!.models).toEqual(["opus"]);
        expect(second!.models).toBeUndefined();
        expect(totalsOf({ turns: [first!, second!] }, false).models).toEqual(["opus"]);
    });

    it("leaves out the folders it is told to when counting a folder's size", async () => {

        const root = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-bytes-"));

        try {

            fs.mkdirSync(path.join(root, "copies"));
            fs.writeFileSync(path.join(root, "copies", "big.txt"), "x".repeat(100));
            fs.writeFileSync(path.join(root, "eval.json"), "12345");

            expect(await folderBytes(root)).toBe(105);
            expect(await folderBytes(root, ["copies"])).toBe(5);

        } finally {

            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("counts a turn still running up to now, and only the last one", () => {

        const [first, second] = turnReports(twoTurns(), true, 130_000);

        expect(first!.running).toBeUndefined();
        expect(second).toMatchObject({ running: true, ms: 30_000 });
    });

    it("reads the findings the agent listed, from an answer that came in pieces", () => {

        const [turn] = turnReports([
            { kind: "prompt", at: 1000, ownerId: "chat", text: "find problems" },
            { kind: "message", at: 2000, ownerId: "chat", text: "Two problems.\n\n```findings\nsrc/a.ts | 4 | high | First.\n" },
            { kind: "message", at: 2100, ownerId: "chat", text: "src/b.ts | 0 | low | Second.\n```" }
        ], false);

        expect(turn!.findings).toEqual([
            { file: "src/a.ts", line: 4, severity: "high", problem: "First." },
            { file: "src/b.ts", line: 0, severity: "low", problem: "Second." }
        ]);
    });

    it("has no turn for a chat nothing was sent to", () => {

        expect(turnReports([{ v: 1, kind: "open", at: 1 }, { kind: "error", at: 2, ownerId: "chat", text: "did not start" }], false)).toEqual([]);
    });
});

describe("the report's sums", () => {

    it("adds every turn, or takes the first alone", () => {

        const turns = turnReports(twoTurns(), false);

        // Every call, the longest first.
        expect(totalsOf({ turns }, false).calls.map(call => call.ms)).toEqual([5800, 500]);
        expect(totalsOf({ turns }, false).findings).toBeUndefined();

        expect(totalsOf({ turns }, false)).toMatchObject({ turns: 2, ms: 13_500, toolMs: 6300, toolCalls: 2, failed: 1, refused: 1, modelCalls: 4, inputTokens: 1000, running: false });
        expect(totalsOf({ turns }, false).cost).toEqual([{ amount: 0.3, unit: "USD" }]);

        expect(totalsOf({ turns }, true)).toMatchObject({ turns: 1, ms: 9000, modelCalls: 3 });
        expect(totalsOf({ turns: [] }, false)).toMatchObject({ turns: 0, ms: 0, cost: [] });
        expect(totalsOf({ turns: [] }, false).modelCalls).toBeUndefined();
    });

    it("marks the lowest value of a row, and nothing when there is nothing to tell apart", () => {

        expect(lowestOf([15, 11, 20])).toEqual([false, true, false]);

        // Two share the lowest: both are marked.
        expect(lowestOf([3, 3, 5])).toEqual([true, true, false]);

        // A variant with no value is left out, not counted as zero.
        expect(lowestOf([undefined, 8, 4])).toEqual([false, false, true]);

        // All the same, or only one value: no mark.
        expect(lowestOf([0, 0])).toEqual([false, false]);
        expect(lowestOf([7, undefined])).toEqual([false, false]);
        expect(lowestOf([])).toEqual([]);
    });

    it("compares costs only in one unit", () => {

        expect(costIn([{ amount: 0.25, unit: "USD" }], "USD")).toBe(0.25);
        expect(costIn([{ amount: 3, unit: "credits" }], "USD")).toBeUndefined();
        expect(costIn([{ amount: 1, unit: "USD" }, { amount: 3, unit: "credits" }], "USD")).toBeUndefined();
        expect(costIn([], "USD")).toBeUndefined();
    });

    it("writes times, costs and sizes for a person", () => {

        expect(timeText(400)).toBe("0.4s");
        expect(timeText(58_000)).toBe("58s");
        expect(timeText(402_000)).toBe("6m 42s");
        expect(timeText(3_780_000)).toBe("1h 03m");

        expect(costText([])).toBe("-");
        expect(costText([{ amount: 0.244529, unit: "USD" }])).toBe("$0.2445");
        expect(costText([{ amount: 12.5, unit: "USD" }, { amount: 3, unit: "credits" }])).toBe("$12.50 + 3 credits");

        expect(sizeText(0)).toBe("0 KB");
        expect(sizeText(500)).toBe("1 KB");
        expect(sizeText(34.2 * 1024 * 1024)).toBe("34.2 MB");
    });
});

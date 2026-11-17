import { describe, expect, it } from "vitest";

import type { LogEntry } from "../../templates/logEntry";
import { callsText, latestMcp, toolCounts, turnSpends, usageTable } from "../SessionPanel";

/* The Session panel's own reading of a chat's log lines. */

let next = 0;

function entry(category: string, extra: Partial<LogEntry> = {}): LogEntry {

    next++;

    return { id: String(next), at: next, level: "info", category, message: "", ...extra };
}

const credits = (amount: number) => [{ amount, unit: "credits", runtime: "kiro-cli-v3" }];

describe("turnSpends", () => {

    it("adds every charge after a message to that message's turn", () => {

        const turns = turnSpends([
            entry("prompt", { message: "Read the layout files\nand more" }),
            entry("notice", { cost: credits(0.1) }),
            entry("notice", { cost: credits(0.08) }),
            entry("prompt", { message: "Add a tab" }),
            entry("notice", { cost: credits(0.61) })
        ]);

        expect(turns.map(turn => [turn.number, turn.asked, turn.cost[0]?.amount])).toEqual([
            [1, "Read the layout files", 0.18],
            [2, "Add a tab", 0.61]
        ]);
    });

    it("keeps a turn that charged nothing, and skips a message still being sent", () => {

        const turns = turnSpends([
            entry("prompt", { message: "One" }),
            entry("prompt", { message: "Sending", pending: "sending" } as Partial<LogEntry>)
        ]);

        expect(turns).toEqual([{ number: 1, asked: "One", cost: [], models: [] }]);
    });

    it("puts charges seen before any message in a turn of their own with no label", () => {

        const turns = turnSpends([
            entry("notice", { cost: credits(1) }),
            entry("prompt", { message: "Next" })
        ]);

        expect(turns.map(turn => [turn.number, turn.asked])).toEqual([[1, ""], [2, "Next"]]);
    });

    it("adds up the model calls a turn's lines report, and has no count when none did", () => {

        const turns = turnSpends([
            entry("prompt", { message: "Claude" }),
            entry("notice", { cost: [{ amount: 0.31, unit: "USD" }], calls: 3 }),
            entry("prompt", { message: "Copilot" }),
            entry("notice", { cost: credits(0.1), calls: 1 }),
            entry("notice", { calls: 1 }),
            entry("prompt", { message: "Kiro" }),
            entry("notice", { cost: credits(0.5) })
        ]);

        expect(turns.map(turn => turn.calls)).toEqual([3, 2, undefined]);
        expect(callsText(3)).toBe("3 model calls");
        expect(callsText(1)).toBe("1 model call");
        expect(callsText(undefined)).toBeUndefined();
    });

    it("cuts a long first line", () => {

        const [turn] = turnSpends([entry("prompt", { message: "x".repeat(80) })]);

        expect(turn.asked).toHaveLength(60);
        expect(turn.asked.endsWith("…")).toBe(true);
    });
});

describe("usageTable", () => {

    const usd = (amount: number) => [{ amount, unit: "USD", runtime: "claude" }];
    const opus = (input: number, cached: number, output: number) =>
        [{ model: "claude-opus-5-5", runtime: "claude", inputTokens: input, cachedTokens: cached, outputTokens: output }];

    const claudeTurns = () => turnSpends([
        entry("prompt", { message: "king" }),
        entry("notice", { cost: usd(0.31), models: opus(106332, 98000, 579), calls: 3 })
    ]);

    it("keeps the tokens when money is shown - the flag only adds the Cost column", () => {

        const table = usageTable(claudeTurns(), usd(0.31), opus(106332, 98000, 579), true);

        expect(table.head.map(cell => cell.text)).toEqual(["", "Calls", "In", "Cached", "Out", "Cost"]);
        expect(table.rows.map(row => [row.label, ...row.cells.map(cell => cell.text)])).toEqual([
            ["Turn 1 · king", "3", "106k", "98k", "579", "$0.31"],
            ["Total", "3", "106k", "98k", "579", "$0.31"]
        ]);
        expect(table.rows[1].kind).toBe("total");
    });

    it("leaves money out, and the column with it, when the flag is off", () => {

        const table = usageTable(claudeTurns(), usd(0.31), opus(106332, 98000, 579), false);

        expect(table.head.map(cell => cell.text)).toEqual(["", "Calls", "In", "Cached", "Out"]);
    });

    it("leaves out the columns Kiro has no figures for, and keeps its credits", () => {

        const turns = turnSpends([
            entry("prompt", { message: "Kiro" }),
            entry("notice", { cost: credits(0.5) })
        ]);

        const table = usageTable(turns, credits(0.5), [], false);

        expect(table.head.map(cell => cell.text)).toEqual(["", "In", "Out", "Usage"]);
        expect(table.rows[0].cells.map(cell => cell.text)).toEqual(["—", "—", "0.50 credits"]);
    });

    it("gives the total no call count when a turn did not report one", () => {

        const turns = turnSpends([
            entry("prompt", { message: "Claude" }),
            entry("notice", { cost: usd(0.1), calls: 2 }),
            entry("prompt", { message: "Kiro" }),
            entry("notice", { cost: credits(0.5) })
        ]);

        const table = usageTable(turns, [...usd(0.1), ...credits(0.5)], [], true);

        const calls = table.head.findIndex(cell => cell.text === "Calls") - 1;

        expect(table.rows.map(row => row.cells[calls].text)).toEqual(["2", "—", "—"]);
    });
});

describe("toolCounts", () => {

    it("counts the calls of each tool, most used first", () => {

        expect(toolCounts([
            entry("tool.start", { tool: "fs_read" }),
            entry("tool.end", { tool: "fs_read" }),
            entry("tool.start", { tool: "grep" }),
            entry("tool.start", { tool: "fs_read" })
        ])).toEqual([{ name: "fs_read", calls: 2 }, { name: "grep", calls: 1 }]);
    });
});

describe("latestMcp", () => {

    it("takes the newest list, and nothing when no runtime sent one", () => {

        expect(latestMcp([entry("notice")])).toBeUndefined();

        expect(latestMcp([
            entry("notice", { mcp: [{ name: "a", status: "connecting" }] }),
            entry("notice", { mcp: [{ name: "a", status: "connected" }] }),
            entry("notice")
        ])).toEqual([{ name: "a", status: "connected" }]);
    });
});

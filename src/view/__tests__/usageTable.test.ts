import { describe, expect, it } from "vitest";

import { phaseLines, sumCells, totalCells, usageCell, usageCells, usageColumns } from "../usageTable";

const ghcp = (amount: number) => ({ amount, unit: "credits", runtime: "ghcp" });
const kiro = (amount: number) => ({ amount, unit: "credits", runtime: "kiro-cli-v3" });

describe("usageCells", () => {

    it("keeps Copilot's models and leaves out its turn charges, which are the same money", () => {

        const cells = usageCells(
            [ghcp(1)],
            [{ model: "gpt-5", runtime: "ghcp", inputTokens: 100, cost: [ghcp(1)] }]);

        expect(cells).toEqual([{ model: "gpt-5", runtime: "ghcp", inputTokens: 100, cost: [ghcp(1)] }]);
    });

    it("puts Kiro's charges, which name no model, in a cell with no model name", () => {

        const cells = usageCells(
            [ghcp(1), kiro(2.5)],
            [{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(1)] }]);

        expect(cells).toEqual([
            { model: "gpt-5", runtime: "ghcp", cost: [ghcp(1)] },
            { model: "", runtime: "kiro-cli-v3", cost: [kiro(2.5)] }
        ]);
    });
});

describe("usageColumns", () => {

    it("groups models under their runtime, in first-seen order, the unnamed column last", () => {

        const columns = usageColumns([
            [{ model: "gpt-5", runtime: "ghcp" }, { model: "", runtime: "kiro-cli-v3" }],
            [{ model: "claude-haiku-4.5", runtime: "ghcp" }, { model: "gpt-5", runtime: "ghcp" }]
        ]);

        expect(columns).toEqual([
            { runtime: "ghcp", model: "gpt-5" },
            { runtime: "ghcp", model: "claude-haiku-4.5" },
            { runtime: "kiro-cli-v3", model: "" }
        ]);
    });
});

describe("totals", () => {

    it("adds a runtime's models into one cell, and every row into the Spec row", () => {

        const one = [{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(3)] }, { model: "claude-haiku-4.5", runtime: "ghcp", cost: [ghcp(0.25)] }];
        const two = [{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(0.5)] }, { model: "", runtime: "kiro-cli-v3", cost: [kiro(1.84)] }];

        expect(sumCells(one, "", "ghcp").cost).toEqual([ghcp(3.25)]);

        const spec = totalCells([one, two]);

        expect(usageCell(spec, { runtime: "ghcp", model: "gpt-5" })?.cost).toEqual([ghcp(3.5)]);
        expect(usageCell(spec, { runtime: "kiro-cli-v3", model: "" })?.cost).toEqual([kiro(1.84)]);
    });
});

describe("phaseLines", () => {

    const stages = [{ name: "requirements", label: "Requirements" }, { name: "design" }, { name: "tasks" }, { name: "implement" }];

    it("gives every phase a row in pipeline order, run or not, with its chats under it", () => {

        const lines = phaseLines(stages, {
            "implement@wave:2": { lines: [{ cost: [kiro(1.5)] }] },
            requirements: { lines: [{ cost: [ghcp(1)], models: [{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(1)] }] }] },
            "implement@wave:1": { lines: [{ cost: [kiro(2.6)] }] }
        }, owner => owner.replace("implement@wave:", "Wave "));

        expect(lines.map(line => [line.label, line.lane === true])).toEqual([
            ["Requirements", false],
            ["design", false],
            ["tasks", false],
            ["implement", false],
            ["Wave 2", true],
            ["Wave 1", true]
        ]);

        expect(lines[3].cost).toEqual([kiro(4.1)]);
        expect(lines[1]).toEqual({ label: "design", cost: [], models: [] });
    });

    it("counts the drafts a re-run took off the screen", () => {

        const [requirements] = phaseLines(stages, {
            requirements: {
                spent: [ghcp(2)],
                spentModels: [{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(2)] }],
                lines: [{ cost: [ghcp(1)], models: [{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(1)] }] }]
            }
        }, owner => owner);

        expect(requirements.cost).toEqual([ghcp(3)]);
        expect(requirements.models).toEqual([{ model: "gpt-5", runtime: "ghcp", cost: [ghcp(3)] }]);
    });

    it("keeps a row, at the end, for a phase the style does not have", () => {

        const lines = phaseLines(stages, { old: { lines: [{ cost: [ghcp(1)] }] } }, owner => owner);

        expect(lines.at(-1)).toEqual({ label: "old", cost: [ghcp(1)], models: [] });
    });
});

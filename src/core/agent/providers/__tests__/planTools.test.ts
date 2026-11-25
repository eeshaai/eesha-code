import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CHECK_PLAN_TOOL_NAME, checkPlan, markTaskDone, PlanChecker, planToolJsonSchema, TASK_DONE_TOOL_NAME, usePlanChecker } from "../planTools";

/**
 * A stand-in reader: the engine cannot import SDD's parser, and neither
 * can a test under src/core. The real one is tested beside the parser
 * (src/sdd/documents/__tests__/planCheck.test.ts); this one flags any
 * unnumbered checkbox row.
 */
const fakeChecker: PlanChecker = {
    problems: text => text.split("\n").flatMap((line, index) =>
        /^\s*-\s\[[ x]\]\s+\D/.test(line) ? [`line ${index + 1}: no task number`] : []),
    summary: text => `${text.split("\n").filter(line => /^\s*-\s\[/.test(line)).length} rows.`
};
import { sessionConfig } from "../CopilotProvider";

/**
 * `task_done`: the agent names a task, the engine flips its box and
 * nothing else in the plan.
 */

let dir: string;
let plan: string;

const PLAN = [
    "# Plan",
    "",
    "- [ ] 1. Group",
    "  - [x] 1.1 Done already",
    "  - [ ]* 1.2 Optional",
    "    - [ ] 1.2.1 Deep",
    "- [~] 2 Kiro-style in progress",
    "- [ ] Unnumbered row",
    ""
].join("\n");

beforeEach(() => {

    dir = fs.mkdtempSync(path.join(os.tmpdir(), "plan-tools-"));
    plan = path.join(dir, "tasks.md");
    fs.writeFileSync(plan, PLAN, "utf8");
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe(TASK_DONE_TOOL_NAME, () => {

    it("ticks exactly that task's box and touches nothing else", () => {

        expect(markTaskDone(plan, { task: "1.2" })).toBe("Ticked task 1.2.");

        expect(fs.readFileSync(plan, "utf8")).toBe(PLAN.replace("- [ ]* 1.2 Optional", "- [x]* 1.2 Optional"));
    });

    it("reads the id with or without the trailing dot a top-level number carries", () => {

        expect(markTaskDone(plan, { task: "1." })).toBe("Ticked task 1.");
        expect(fs.readFileSync(plan, "utf8")).toContain("- [x] 1. Group");
    });

    it("reaches any depth, and Kiro's in-progress mark", () => {

        expect(markTaskDone(plan, { task: "1.2.1" })).toBe("Ticked task 1.2.1.");
        expect(markTaskDone(plan, { task: "2" })).toBe("Ticked task 2.");

        const text = fs.readFileSync(plan, "utf8");

        expect(text).toContain("    - [x] 1.2.1 Deep");
        expect(text).toContain("- [x] 2 Kiro-style");
    });

    it("says so for a box already ticked, and for an id that is not there - never throws", () => {

        expect(markTaskDone(plan, { task: "1.1" })).toBe("Task 1.1 was already ticked.");
        expect(markTaskDone(plan, { task: "9.9" })).toMatch(/No task '9.9' in the plan/);
        expect(markTaskDone(plan, { task: "" })).toMatch(/No task id given/);
        expect(markTaskDone(path.join(dir, "missing.md"), { task: "1" })).toMatch(/could not be read/);

        expect(fs.readFileSync(plan, "utf8")).toBe(PLAN);
    });

    it("keeps CRLF line endings", () => {

        fs.writeFileSync(plan, PLAN.replace(/\n/g, "\r\n"), "utf8");

        markTaskDone(plan, { task: "1.2" });

        expect(fs.readFileSync(plan, "utf8")).toBe(PLAN.replace("- [ ]* 1.2 Optional", "- [x]* 1.2 Optional").replace(/\n/g, "\r\n"));
    });

    it("declares one required input, the task id", () => {

        expect(planToolJsonSchema.required).toEqual(["task"]);
    });
});

/* The tool reaches Copilot only when the session was handed a plan. */
describe("as Copilot is given it", () => {

    interface CopilotTool { name: string; skipPermission?: boolean; defer?: string; handler?: (args: unknown) => Promise<unknown> }

    const toolsOf = (planPath: string | undefined) =>
        (sessionConfig({ workingDirectory: "/work", env: {}, plan: planPath }, undefined, undefined, undefined) as unknown as { tools: CopilotTool[] }).tools;

    it("is registered over the plan, never deferred and with nothing to approve", async () => {

        const tool = toolsOf(plan).find(one => one.name === TASK_DONE_TOOL_NAME)!;

        expect(tool).toBeDefined();
        expect(tool.skipPermission).toBe(true);
        expect(tool.defer).toBe("never");

        expect(await tool.handler!({ task: "1.2" })).toBe("Ticked task 1.2.");
        expect(fs.readFileSync(plan, "utf8")).toContain("- [x]* 1.2 Optional");
    });

    it("is absent from a session with no plan", () => {

        expect(toolsOf(undefined).some(one => one.name === TASK_DONE_TOOL_NAME)).toBe(false);
    });
});

/* `check_plan`: the parser's own verdict on the draft, as text for the model. */
describe(CHECK_PLAN_TOOL_NAME, () => {

    beforeEach(() => usePlanChecker(fakeChecker));

    afterEach(() => usePlanChecker(undefined));

    it("says so when no reader is registered", () => {

        usePlanChecker(undefined);

        expect(checkPlan(plan)).toMatch(/No plan checker is registered/);
    });

    it("reports no problems, with the reader's summary, on a clean plan", () => {

        fs.writeFileSync(plan, "- [ ] 1. One\n  - [ ] 1.1 Two\n", "utf8");

        expect(checkPlan(plan)).toBe("No problems. 2 rows.");
    });

    it("lists the reader's problems, counted, one per line", () => {

        fs.writeFileSync(plan, "- [ ] 1. One\n  - [ ] Unnumbered\n- [ ] Also unnumbered\n", "utf8");

        expect(checkPlan(plan)).toBe("2 problems:\n- line 2: no task number\n- line 3: no task number");
    });

    it("says so when the plan is not written yet", () => {

        expect(checkPlan(path.join(dir, "not-yet.md"))).toMatch(/not on disk yet/);
    });

    it("reaches Copilot only for a session writing a plan", () => {

        const tools = (sessionConfig({ workingDirectory: "/work", env: {}, checkPlan: plan }, undefined, undefined, undefined) as unknown as { tools: { name: string }[] }).tools;

        expect(tools.some(one => one.name === CHECK_PLAN_TOOL_NAME)).toBe(true);
        expect(tools.some(one => one.name === TASK_DONE_TOOL_NAME)).toBe(false);
    });
});

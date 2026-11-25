import { describe, expect, it } from "vitest";

import { describeEvent } from "../AgentSession";
import { TaskBoard, isPlanTool, planFromAcp, planFromCopilotTodos, planFromTodoChecklist, planFromTodos, planText } from "../plan";

/*
 * The agent's plan from what each runtime sends, as one list of steps -
 * see plan.ts. The chat draws the newest one above the compose box.
 */

describe("planFromAcp", () => {

    it("reads ACP's entries, skipping empty ones, with an unknown status as not started", () => {

        expect(planFromAcp([
            { content: " Read ", status: "completed", priority: "high" },
            { content: "", status: "pending" },
            { content: "Ship", status: "blocked" }
        ])).toEqual([{ text: "Read", status: "completed" }, { text: "Ship", status: "pending" }]);
    });

    it("gives an empty plan for anything that is not a list", () => {

        expect(planFromAcp(undefined)).toEqual([]);
    });
});

describe("planFromTodos", () => {

    it("words the step in progress the way the agent does while doing it", () => {

        expect(planFromTodos({
            todos: [
                { content: "Fix it", status: "in_progress", activeForm: "Fixing it" },
                { content: "Test it", status: "pending", activeForm: "Testing it" },
                { content: "Plan it", status: "in_progress" }
            ]
        })).toEqual([
            { text: "Fixing it", status: "in_progress" },
            { text: "Test it", status: "pending" },
            { text: "Plan it", status: "in_progress" }
        ]);
    });

    it("gives nothing for an input with no list", () => {

        expect(planFromTodos({})).toBeUndefined();
        expect(planFromTodos({ todos: [] })).toEqual([]);
    });
});

describe("planFromCopilotTodos", () => {

    it("reads done as completed, and blocked as pending", () => {

        expect(planFromCopilotTodos([
            { id: "a", title: "Read the code", status: "done" },
            { id: "b", title: " Write the tests ", status: "in_progress" },
            { id: "c", title: "Ship it", status: "pending" },
            { id: "d", title: "Wait for review", status: "blocked" }
        ])).toEqual([
            { text: "Read the code", status: "completed" },
            { text: "Write the tests", status: "in_progress" },
            { text: "Ship it", status: "pending" },
            { text: "Wait for review", status: "pending" }
        ]);
    });

    it("skips rows with no title, and reads anything but a list as no plan", () => {

        expect(planFromCopilotTodos([{ status: "done" }, null, { title: "One" }])).toEqual([{ text: "One", status: "pending" }]);
        expect(planFromCopilotTodos(undefined)).toEqual([]);
    });
});

describe("planFromTodoChecklist", () => {

    it("reads each checklist item with its box", () => {

        expect(planFromTodoChecklist({ todos: "- [x] Read the code\r\n- [ ] Write the tests\n* [X] Plan" })).toEqual([
            { text: "Read the code", status: "completed" },
            { text: "Write the tests", status: "pending" },
            { text: "Plan", status: "completed" }
        ]);
    });

    it("reads numbered items, and the other boxes the CLI takes as in progress", () => {

        expect(planFromTodoChecklist({ todos: "1. [-] One\n2) [~] Two\n  + [/] Three" })).toEqual([
            { text: "One", status: "in_progress" },
            { text: "Two", status: "in_progress" },
            { text: "Three", status: "in_progress" }
        ]);
    });

    it("skips lines that are not items", () => {

        expect(planFromTodoChecklist({ todos: "## TODO\nSome words\n- no box\n- [ ] Real one\n- [?] Odd box" }))
            .toEqual([{ text: "Real one", status: "pending" }]);
    });

    it("gives no plan when there is no checklist text", () => {

        expect(planFromTodoChecklist({})).toBeUndefined();
        expect(planFromTodoChecklist({ todos: ["- [ ] One"] })).toBeUndefined();
        expect(planFromTodoChecklist(null)).toBeUndefined();
    });
});

describe("planText", () => {

    it("says how far the plan is, then each step with its mark", () => {

        expect(planText([{ text: "a", status: "completed" }, { text: "b", status: "in_progress" }, { text: "c", status: "pending" }]))
            .toBe("Plan: 1 of 3 done.\n[x] a\n[>] b\n[ ] c");
        expect(planText([])).toBe("Plan cleared.");
    });
});

describe("TaskBoard", () => {

    it("keeps tasks in the order they were made, and takes a deleted task out", () => {

        const board = new TaskBoard();

        expect(board.apply("TaskCreate", { subject: "One" }, [{ type: "text", text: "Task #1 created successfully: One" }])).toBe(true);
        expect(board.apply("TaskCreate", { subject: "Two" }, "Task #2 created successfully: Two")).toBe(true);
        expect(board.apply("TaskUpdate", { taskId: "2", status: "completed" }, "Updated task #2 status")).toBe(true);

        expect(board.steps()).toEqual([{ text: "One", status: "pending" }, { text: "Two", status: "completed" }]);

        expect(board.apply("TaskUpdate", { taskId: "1", status: "deleted" }, "Updated task #1 deleted")).toBe(true);
        expect(board.steps()).toEqual([{ text: "Two", status: "completed" }]);
    });

    it("takes a whole list from TaskList, as JSON or as its lines", () => {

        const board = new TaskBoard();

        board.apply("TaskCreate", { subject: "One", activeForm: "Doing one" }, "Task #1 created successfully: One");

        expect(board.apply("TaskList", {}, "#1 [in_progress] One (main)\n#2 [pending] Two [blocked by #1]")).toBe(true);
        expect(board.steps()).toEqual([{ text: "Doing one", status: "in_progress" }, { text: "Two", status: "pending" }]);

        expect(board.apply("TaskList", {}, JSON.stringify({ tasks: [{ id: "2", subject: "Two", status: "completed" }] }))).toBe(true);
        expect(board.steps()).toEqual([{ text: "Two", status: "completed" }]);

        expect(board.apply("TaskList", {}, "No tasks found")).toBe(true);
        expect(board.steps()).toEqual([]);
    });

    it("changes nothing for a result it cannot read, a task it never saw, or a refusal", () => {

        const board = new TaskBoard();

        expect(board.apply("TaskCreate", { subject: "One" }, "something else")).toBe(false);
        expect(board.apply("TaskUpdate", { taskId: "7", status: "completed" }, "ok")).toBe(false);
        expect(board.apply("TaskList", {}, "a line that is not a task")).toBe(false);
        expect(board.apply("TaskGet", { taskId: "1" }, "{}")).toBe(false);

        board.apply("TaskCreate", { subject: "One" }, "Task #1 created successfully: One");

        expect(board.apply("TaskUpdate", { taskId: "1", status: "completed" }, JSON.stringify({ success: false, taskId: "1", updatedFields: [] }))).toBe(false);
        expect(board.steps()).toEqual([{ text: "One", status: "pending" }]);
    });
});

describe("the plan on a log line", () => {

    it("names Claude's to-do tools", () => {

        expect(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].every(isPlanTool)).toBe(true);
        expect(isPlanTool("Task")).toBe(false);
    });

    it("goes on the line, an empty plan too", () => {

        expect(describeEvent({ name: "plan", raw: {}, kind: "notice", text: "Plan cleared.", plan: [] })?.plan).toEqual([]);
        expect(describeEvent({ name: "x", raw: {}, kind: "notice", text: "hi" })?.plan).toBeUndefined();
    });
});

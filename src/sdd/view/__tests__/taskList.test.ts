import { describe, expect, it } from "vitest";
import { allTasks, isAgentTask, isTaskDone, nextTask, parseRun, parseTasks, parseWaves, pendingUnder, pendingWork, reposOf, toggleCheckbox, waveOf, workUnits } from "../taskList";

const PLAN = `# Implementation Plan

- [x] 1. Create the script skeleton
  - [x] 1.1 Add param block
  - [x] 1.2 Add validation
- [ ] 2. Implement greeting output
- [ ] 3. Append to the log file
  - [x] 3.1 Create dist folder on demand
  - [ ] 3.2 Timestamped line format
`;

describe("parseTasks", () => {

    it("reads top-level tasks with their numbers and done state", () => {

        const tasks = parseTasks(PLAN);

        expect(tasks.map(task => task.id)).toEqual(["1", "2", "3"]);
        expect(tasks[0].done).toBe(true);
        expect(tasks[1].done).toBe(false);
        expect(tasks[1].text).toBe("Implement greeting output");
    });

    it("nests exactly one level of sub-tasks under their parent", () => {

        const tasks = parseTasks(PLAN);

        expect(tasks[0].subtasks.map(subtask => subtask.id)).toEqual(["1.1", "1.2"]);
        expect(tasks[2].subtasks.map(subtask => subtask.done)).toEqual([true, false]);
        expect(tasks[1].subtasks).toEqual([]);
    });

    it("treats non-checkbox lines as prose, never as an error", () => {

        expect(parseTasks("# Title\n\nJust some text.\n- a plain bullet\n")).toEqual([]);
        expect(parseTasks(undefined)).toEqual([]);
    });

    it("accepts unnumbered checkboxes and capital X", () => {

        const tasks = parseTasks("- [X] Ship it\n");

        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe("");
        expect(tasks[0].text).toBe("Ship it");
        expect(tasks[0].done).toBe(true);
    });

    it("handles CRLF files", () => {

        expect(parseTasks("- [ ] 1. One\r\n- [x] 2. Two\r\n")).toHaveLength(2);
    });
});

describe("done and queue order", () => {

    it("a parent with an unticked sub-task is not done, whatever its own box says", () => {

        const tasks = parseTasks(PLAN);

        expect(isTaskDone(tasks[0])).toBe(true);
        expect(isTaskDone(tasks[2])).toBe(false);
    });

    it("the queue's next task is the first not-done top-level task", () => {

        expect(nextTask(parseTasks(PLAN))?.id).toBe("2");

        const allDone = parseTasks("- [x] 1. One\n- [x] 2. Two\n");

        expect(nextTask(allDone)).toBeUndefined();
    });
});

describe("optional tasks", () => {

    it("reads the asterisk marker without losing the row", () => {

        const tasks = parseTasks("- [ ]* 1. Nice to have\n");

        expect(tasks).toHaveLength(1);
        expect(tasks[0].id).toBe("1");
        expect(tasks[0].text).toBe("Nice to have");
        expect(tasks[0].optional).toBe(true);
    });

    it("marks ordinary tasks not optional", () => {

        expect(parseTasks("- [ ] 1. Required\n")[0].optional).toBe(false);
    });

    it("reads an optional sub-task under its parent", () => {

        const tasks = parseTasks("- [ ] 5. Group\n  - [ ]* 5.5 Skippable\n");

        expect(tasks[0].subtasks[0].optional).toBe(true);
        expect(tasks[0].subtasks[0].text).toBe("Skippable");
    });
});

describe("workUnits", () => {

    /* A group is a container: its sub-tasks are the units, it is not one. */
    it("is every sub-task, and every task without any, done or not", () => {

        expect(workUnits(parseTasks(PLAN)).map(task => task.id)).toEqual(["1.1", "1.2", "2", "3.1", "3.2"]);
    });
});

describe("pendingWork", () => {

    it("hands over sub-tasks where a group has them, the task itself where it does not", () => {

        expect(pendingWork(parseTasks(PLAN)).map(task => task.id)).toEqual(["2", "3.2"]);
    });

    it("is empty when everything is ticked", () => {

        expect(pendingWork(parseTasks("- [x] 1. One\n  - [x] 1.1 Part\n"))).toEqual([]);
    });
});

const GRAPHED = `## Tasks

- [ ] 1. Group
  - [ ] 1.1 First
  - [ ] 1.2 Second

## Task Dependency Graph

\`\`\`json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2"] }
  ]
}
\`\`\`
`;

describe("parseWaves", () => {

    it("reads the waves declared under the dependency graph heading", () => {

        const waves = parseWaves(GRAPHED);

        expect(waves).toEqual([
            { id: 0, tasks: ["1.1", "1.3"] },
            { id: 1, tasks: ["1.2"] }
        ]);
    });

    it("reads a wave's 'after', and leaves one that is not a list of numbers off", () => {

        const graph = "## Task Dependency Graph\n\n```json\n" +
            "{\"waves\": [{\"id\": 0, \"tasks\": [\"1.1\"], \"after\": []}, {\"id\": 1, \"tasks\": [\"2.1\"], \"after\": \"0\"}, {\"id\": 2, \"tasks\": [\"3.1\"], \"after\": [0]}]}\n```\n";

        expect(parseWaves(graph)).toEqual([
            { id: 0, tasks: ["1.1"], after: [] },
            { id: 1, tasks: ["2.1"] },
            { id: 2, tasks: ["3.1"], after: [0] }
        ]);
    });

    it("orders waves by id however they were written", () => {

        const graph = "## Task Dependency Graph\n\n```json\n" +
            "{\"waves\": [{\"id\": 2, \"tasks\": [\"3.1\"]}, {\"id\": 0, \"tasks\": [\"1.1\"]}]}\n```\n";

        expect(parseWaves(graph).map(wave => wave.id)).toEqual([0, 2]);
    });

    it("finds the wave a task belongs to, and none for a task in no wave", () => {

        const waves = parseWaves(GRAPHED);

        expect(waveOf("1.2", waves)).toBe(1);
        expect(waveOf("1.1", waves)).toBe(0);
        expect(waveOf("2", waves)).toBeUndefined();
    });

    // A graph is advisory. Every malformed shape degrades to "no waves"
    // and the lens falls back to document order - a bad graph must never
    // cost someone their task rows.
    it("returns nothing rather than throwing on a plan it cannot read", () => {

        expect(parseWaves(undefined)).toEqual([]);
        expect(parseWaves("- [ ] 1. No graph at all\n")).toEqual([]);
        expect(parseWaves("## Task Dependency Graph\n\n```json\n{ not json\n```\n")).toEqual([]);
        expect(parseWaves("## Task Dependency Graph\n\n```json\n{\"waves\": \"nope\"}\n```\n")).toEqual([]);
        expect(parseWaves("## Task Dependency Graph\n\nNo fence here.\n")).toEqual([]);
    });

    it("skips wave entries that are not shaped like waves", () => {

        const graph = "## Task Dependency Graph\n\n```json\n" +
            "{\"waves\": [{\"id\": 0, \"tasks\": [\"1.1\"]}, {\"nope\": true}]}\n```\n";

        expect(parseWaves(graph)).toEqual([{ id: 0, tasks: ["1.1"] }]);
    });
});

describe("row lines", () => {

    it("records the 1-based line each row sits on, frontmatter and prose included", () => {

        const [group] = parseTasks("---\ntitle: x\n---\n\n# Plan\n\n- [ ] 1. Group\n  - [x] 1.1 Done\n  - [ ] 1.2 Todo\n");

        expect(group.line).toBe(7);
        expect(group.subtasks.map(task => task.line)).toEqual([8, 9]);
    });
});

describe("toggleCheckbox", () => {

    const plan = "# Plan\n\n- [ ] 1. Group\n  - [x] 1.1 Done\n  - [ ]* 1.2 Optional\n";

    it("ticks an empty box and unticks a ticked one, touching nothing else", () => {

        expect(toggleCheckbox(plan, 3)).toBe("# Plan\n\n- [x] 1. Group\n  - [x] 1.1 Done\n  - [ ]* 1.2 Optional\n");
        expect(toggleCheckbox(plan, 4)).toBe("# Plan\n\n- [ ] 1. Group\n  - [ ] 1.1 Done\n  - [ ]* 1.2 Optional\n");
        expect(toggleCheckbox(plan, 5)).toBe("# Plan\n\n- [ ] 1. Group\n  - [x] 1.1 Done\n  - [x]* 1.2 Optional\n");
    });

    it("unticks an upper-case X too", () => {

        expect(toggleCheckbox("- [X] 1. Done\n", 1)).toBe("- [ ] 1. Done\n");
    });

    it("leaves a line that is not a checkbox row, or does not exist, alone", () => {

        expect(toggleCheckbox(plan, 1)).toBe(plan);
        expect(toggleCheckbox(plan, 99)).toBe(plan);
    });

    it("keeps CRLF line endings", () => {

        expect(toggleCheckbox("- [ ] 1. A\r\n- [ ] 2. B\r\n", 2)).toBe("- [ ] 1. A\r\n- [x] 2. B\r\n");
    });
});

describe("detail lines", () => {

    const plan = [
        "# Plan",
        "",
        "## US-3 Retry on timeout",
        "",
        "- [ ] 1. Retry",
        "  - [ ] 1.1 Add the header",
        "    - Files: `orders-api/src/http/client.ts`, `orders-api\\src\\http\\retry.ts`, `billing/src/a.ts`, none",
        "  - [ ] 1.2 Update the database schema",
        "    - Run: db-migrate",
        "  - [ ] 1.3 Create the branch",
        "    - Run: `git switch -c feature/4711`",
        "  - [ ] 1.4 Get it reviewed",
        "    - Run: by hand",
        "",
        "## Notes",
        "",
        "- Files: not/under/a/task.ts",
        "- [ ] 2. Loose task"
    ].join("\n");

    const [retry, loose] = parseTasks(plan);

    it("reads Files: under the row it follows - backticked paths only, backslashes forward", () => {

        expect(retry.subtasks[0].files).toEqual(["orders-api/src/http/client.ts", "orders-api/src/http/retry.ts", "billing/src/a.ts"]);
        expect(reposOf(retry.subtasks[0].files)).toEqual(["orders-api", "billing"]);
        expect(retry.subtasks[1].files).toEqual([]);
    });

    it("reads the heading a row sits under as its group", () => {

        expect(retry.group).toBe("US-3 Retry on timeout");
        expect(retry.subtasks[0].group).toBe("US-3 Retry on timeout");
        expect(loose.group).toBe("Notes");
    });

    it("reads Run: in its three shapes, and a task without one is an agent's", () => {

        expect(retry.subtasks[0].run).toBeUndefined();
        expect(isAgentTask(retry.subtasks[0])).toBe(true);

        expect(retry.subtasks[1].run).toEqual({ kind: "workflow", name: "db-migrate", args: {} });
        expect(retry.subtasks[2].run).toEqual({ kind: "command", command: "git switch -c feature/4711" });
        expect(retry.subtasks[3].run).toEqual({ kind: "manual" });
        expect(isAgentTask(retry.subtasks[3])).toBe(false);
    });

    it("ignores a detail line that follows a heading rather than a task", () => {

        expect(loose.files).toEqual([]);
    });
});

describe("parseRun", () => {

    it("takes key=value pairs after a workflow name, quotes stripped", () => {

        expect(parseRun("story-start story=4711 branch=\"feature/4711 retries\"")).toEqual({
            kind: "workflow", name: "story-start", args: { story: "4711", branch: "feature/4711 retries" }
        });
    });

    it("skips a word after the name that is not key=value", () => {

        expect(parseRun("story-start now story=1")).toEqual({ kind: "workflow", name: "story-start", args: { story: "1" } });
    });

    it("reads an empty value and 'By Hand' as by hand", () => {

        expect(parseRun("")).toEqual({ kind: "manual" });
        expect(parseRun("By Hand")).toEqual({ kind: "manual" });
    });
});

describe("a row's details", () => {

    const plan = [
        "- [ ] 1. Group",
        "  - [ ] 1.1 Sub",
        "    - Files: `src/a.ts`",
        "    - _Requirements: 1.2_",
        "",
        "    A paragraph about it.",
        "",
        "  - [ ] 1.2 Bare",
        "- [ ] 2. Lone",
        "  Some prose under it.",
        ""
    ].join("\n");

    const [group, lone] = parseTasks(plan);

    it("keeps every line under the row, minus the indent of the row's text, without trailing blanks", () => {

        expect(group.subtasks[0].details).toEqual([
            "- Files: `src/a.ts`",
            "- _Requirements: 1.2_",
            "",
            "A paragraph about it."
        ]);
        expect(group.subtasks[1].details).toEqual([]);
        expect(lone.details).toEqual(["Some prose under it."]);
    });

    it("gives a group its own details, not its sub-tasks'", () => {

        expect(group.details).toEqual([]);
    });
});

describe("any depth", () => {

    const plan = [
        "- [ ] 1. Group",
        "  - [ ] 1.1 Middle",
        "    - [x] 1.1.1 Leaf one",
        "    - [ ] 1.1.2 Leaf two",
        "      - [ ] 1.1.2.1 Deepest",
        "  - [x] 1.2 Leaf three",
        "- [ ] 2. Lone",
        "- [ ] Unnumbered top",
        "  - [ ] Unnumbered under it",
        "    - [ ] And deeper",
        ""
    ].join("\n");

    const tasks = parseTasks(plan);

    it("nests by the number's dots, a group at every level that has rows under it", () => {

        expect(tasks.map(task => task.id)).toEqual(["1", "2", ""]);
        expect(tasks[0].subtasks.map(task => task.id)).toEqual(["1.1", "1.2"]);
        expect(tasks[0].subtasks[0].subtasks.map(task => task.id)).toEqual(["1.1.1", "1.1.2"]);
        expect(tasks[0].subtasks[0].subtasks[1].subtasks.map(task => task.id)).toEqual(["1.1.2.1"]);
    });

    it("nests an unnumbered row by its indent", () => {

        const top = tasks[2];

        expect(top.text).toBe("Unnumbered top");
        expect(top.subtasks[0].text).toBe("Unnumbered under it");
        expect(top.subtasks[0].subtasks[0].text).toBe("And deeper");
    });

    it("hands over the leaves only, all the way down", () => {

        expect(workUnits(tasks).map(task => task.id || task.text))
            .toEqual(["1.1.1", "1.1.2.1", "1.2", "2", "And deeper"]);
        expect(pendingWork(tasks).map(task => task.id || task.text)).toEqual(["1.1.2.1", "2", "And deeper"]);
    });

    it("is done only when everything under it is, however deep", () => {

        expect(isTaskDone(tasks[0].subtasks[0])).toBe(false);
        expect(isTaskDone(tasks[0].subtasks[1])).toBe(true);

        const done = parseTasks("- [x] 1. G\n  - [x] 1.1 M\n    - [x] 1.1.1 L\n");

        expect(isTaskDone(done[0])).toBe(true);
    });

    it("lists every row at any depth", () => {

        expect(allTasks(tasks).length).toBe(10);
    });

    it("files an orphan under the deepest row that is open rather than dropping it", () => {

        const [group] = parseTasks("- [ ] 1. Group\n    - [ ] 1.2.1 Orphan\n");

        expect(group.subtasks.map(task => task.id)).toEqual(["1.2.1"]);
    });
});

describe("pendingUnder", () => {

    it("is the open leaves under a group, any depth, in document order", () => {

        const tasks = parseTasks(
            "- [ ] 4. Group\n"
            + "  - [ ] 4.1 Inner group\n"
            + "    - [x] 4.1.1 Done already\n"
            + "    - [ ] 4.1.2 Still open\n"
            + "  - [ ] 4.2 Flat one\n");

        expect(pendingUnder(tasks[0]).map(task => task.id)).toEqual(["4.1.2", "4.2"]);
        expect(pendingUnder(tasks[0].subtasks[0]).map(task => task.id)).toEqual(["4.1.2"]);
    });

    it("keeps tasks with a Run: line, carrying the line - the host runs them in their place", () => {

        const tasks = parseTasks(
            "- [ ] 5. Group\n"
            + "  - [ ] 5.1 Agent work\n"
            + "  - [ ] 5.2 Build it\n"
            + "    - Run: `npm run build`\n");

        const under = pendingUnder(tasks[0]);

        expect(under.map(task => task.id)).toEqual(["5.1", "5.2"]);
        expect(under[1].run).toEqual({ kind: "command", command: "npm run build" });
    });

    it("is empty for a unit and for a fully ticked group", () => {

        const tasks = parseTasks(PLAN);

        expect(pendingUnder(tasks[1])).toEqual([]);
        expect(pendingUnder(tasks[0])).toEqual([]);
    });
});

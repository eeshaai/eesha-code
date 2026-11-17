import { describe, expect, it } from "vitest";
import { parsePlan } from "../parsePlan";

const PLAN = `# Implementation Plan: Greeting

## Overview

Ship it.

## Tasks

- [x] 1. Greeting script
  - [x] 1.1 Implement scripts/greet.ps1
    - Write the parameter block
    - Files: \`scripts/greet.ps1\`, \`scripts\\tests\\greet.Tests.ps1\`
    - [Requirements : 1.2, 3.1](requirements.md)
  - [ ] 1.2 Verify behaviour
    - Files: none
    - [Requirements : 2.1](requirements.md)
  - [ ]* 1.3 Add a nicety

- [ ] 2. Ship the greeting
  - Tag the release.

## Task Dependency Graph

\`\`\`json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.3"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["2"] }
  ]
}
\`\`\`
`;

describe("reading a plan", () => {

    const plan = parsePlan(PLAN);

    it("reads it without complaint", () => {

        expect(plan.problems).toEqual([]);
    });

    it("separates groups from the tasks under them - a group is what has tasks beneath it", () => {

        // `2` has nothing under it, so it is a unit of work, not a group.
        expect(plan.tasks.filter(task => task.group).map(task => task.id)).toEqual(["1"]);
        expect(plan.tasks.filter(task => !task.group).map(task => task.id)).toEqual(["1.1", "1.2", "1.3", "2"]);
    });

    it("reads the tick as the completion signal it is", () => {

        expect(plan.tasks.filter(task => task.done).map(task => task.id)).toEqual(["1", "1.1"]);
    });

    it("reads the optional marker, which sits against the bracket", () => {

        expect(plan.tasks.find(task => task.id === "1.3")?.optional).toBe(true);
        expect(plan.tasks.find(task => task.id === "1.2")?.optional).toBe(false);
    });

    it("attaches requirements to the task above them", () => {

        expect(plan.tasks.find(task => task.id === "1.1")?.requirements).toEqual(["1.2", "3.1"]);
        expect(plan.tasks.find(task => task.id === "1.2")?.requirements).toEqual(["2.1"]);
        expect(plan.tasks.find(task => task.id === "1.3")?.requirements).toEqual([]);
    });

    /* Paths in backticks, slashes made forward; prose outside the backticks is not a path. */
    it("attaches the files a task touches, from its Files line", () => {

        expect(plan.tasks.find(task => task.id === "1.1")?.files).toEqual(["scripts/greet.ps1", "scripts/tests/greet.Tests.ps1"]);
        expect(plan.tasks.find(task => task.id === "1.2")?.files).toEqual([]);
        expect(plan.tasks.find(task => task.id === "1.3")?.files).toEqual([]);
    });

    it("reads the waves the lens fans out from", () => {

        expect(plan.waves).toEqual([
            { id: 0, tasks: ["1.1", "1.3"] },
            { id: 1, tasks: ["1.2"] },
            { id: 2, tasks: ["2"] }
        ]);
    });

    it("points at real lines, so a problem can open the file at that line", () => {

        expect(PLAN.split("\n")[plan.tasks[0].line - 1]).toContain("1. Greeting script");
    });
});

/*
 * The whole point of this module. A style may replace the tasks prompt
 * and an agent may write something else; neither is prevented. But a
 * plan that cannot be read has to say so, because an empty task list
 * rendered without comment reads as "no tasks".
 */
describe("saying what it cannot read", () => {

    it("says so when there are no tasks at all, rather than returning an empty plan", () => {

        const plan = parsePlan("# Plan\n\nWe will do the thing, carefully.\n");

        expect(plan.tasks).toEqual([]);
        expect(plan.problems[0].message).toMatch(/No tasks found/);
    });

    it("names a detail line that grew a checkbox", () => {

        const plan = parsePlan("- [ ] 1. Group\n  - [ ] 1.1 Task\n    - [ ] write the thing\n");

        expect(plan.tasks.map(task => task.id)).toEqual(["1", "1.1"]);
        expect(plan.problems.some(problem => /checkbox but no task number/.test(problem.message))).toBe(true);
    });

    it("reads any depth: a task with tasks under it is a group, whatever its level", () => {

        const plan = parsePlan("- [ ] 1. Group\n  - [ ] 1.1 Task\n    - [ ] 1.1.1 Deeper\n      - [ ]* 1.1.1.1 Deepest\n  - [ ] 1.2 Leaf\n");

        expect(plan.tasks.map(task => task.id)).toEqual(["1", "1.1", "1.1.1", "1.1.1.1", "1.2"]);
        expect(plan.tasks.filter(task => task.group).map(task => task.id)).toEqual(["1", "1.1", "1.1.1"]);
        expect(plan.tasks.find(task => task.id === "1.1.1.1")?.optional).toBe(true);
        expect(plan.problems.filter(problem => problem.line > 0)).toEqual([]);
    });

    it("reports a duplicated id, naming the line it collides with", () => {

        const plan = parsePlan("- [ ] 1. Group\n  - [ ] 1.1 One\n  - [ ] 1.1 Two\n");

        expect(plan.problems.some(problem => /'1.1' is numbered the same as the one on line 2/.test(problem.message))).toBe(true);
    });

    it("reports a sub-task with no group above it", () => {

        expect(parsePlan("- [ ] 2.1 Orphan\n").problems.some(problem => /no task '2' above it/.test(problem.message)))
            .toBe(true);
        expect(parsePlan("- [ ] 1. Group\n    - [ ] 1.2.1 Orphan\n").problems.some(problem => /no task '1.2' above it/.test(problem.message)))
            .toBe(true);
    });

    /*
     * The failure this exists for: an unreadable graph treated as no
     * graph turns an intended parallel run into a silent sequential
     * one, and nobody finds out.
     */
    it("refuses to read a broken graph as no graph", () => {

        const plan = parsePlan(`${PLAN.replace('"waves"', '"waves",')}`);

        expect(plan.waves).toBeUndefined();
        expect(plan.problems.some(problem => /not valid JSON/.test(problem.message))).toBe(true);
    });

    it("says when a graph has no waves array", () => {

        const plan = parsePlan("- [ ] 1. G\n  - [ ] 1.1 T\n\n```json\n{ \"order\": [] }\n```\n");

        expect(plan.problems.some(problem => /no 'waves' array/.test(problem.message))).toBe(true);
    });

    it("takes an absent graph as absent, which is not a problem", () => {

        const plan = parsePlan("- [ ] 1. G\n  - [ ] 1.1 T\n");

        expect(plan.waves).toBeUndefined();
        expect(plan.problems).toEqual([]);
    });
});

describe("the graph against the list", () => {

    it("names a wave entry that is not a task, since it would never run", () => {

        const plan = parsePlan("- [ ] 1. G\n  - [ ] 1.1 T\n\n```json\n{\"waves\":[{\"id\":0,\"tasks\":[\"1.1\",\"9.9\"]}]}\n```\n");

        expect(plan.problems.some(problem => /'9.9', which is not a task/.test(problem.message))).toBe(true);
    });

    it("names a group put in a wave", () => {

        const plan = parsePlan("- [ ] 1. G\n  - [ ] 1.1 T\n\n```json\n{\"waves\":[{\"id\":0,\"tasks\":[\"1\",\"1.1\"]}]}\n```\n");

        expect(plan.problems.some(problem => /'1', which is a group/.test(problem.message))).toBe(true);
    });

    it("names a task the graph forgot, which the lens would never reach", () => {

        const plan = parsePlan("- [ ] 1. G\n  - [ ] 1.1 T\n  - [ ] 1.2 U\n\n```json\n{\"waves\":[{\"id\":0,\"tasks\":[\"1.1\"]}]}\n```\n");

        expect(plan.problems.some(problem => /'1.2' is in no wave/.test(problem.message))).toBe(true);
    });

    /*
     * Disjoint files is the rule that makes parallel implementation
     * safe, and it is a claim about code that does not exist yet. It
     * belongs to the prompts, which can read the task text.
     */
    it("does not pretend to check that a wave's tasks touch disjoint files", () => {

        const plan = parsePlan(PLAN);

        expect(plan.problems).toEqual([]);
    });
});

describe("what a wave waits for", () => {

    const graph = (waves: string) =>
        parsePlan(`- [ ] 1. G\n  - [ ] 1.1 T\n  - [ ] 1.2 U\n  - [ ] 1.3 V\n\n\`\`\`json\n{"waves":${waves}}\n\`\`\`\n`);

    it("reads 'after', an empty one included, and leaves it off a wave that has none", () => {

        const plan = graph('[{"id":0,"tasks":["1.1"],"after":[]},{"id":1,"tasks":["1.2"],"after":[]},{"id":2,"tasks":["1.3"]}]');

        expect(plan.waves).toEqual([
            { id: 0, tasks: ["1.1"], after: [] },
            { id: 1, tasks: ["1.2"], after: [] },
            { id: 2, tasks: ["1.3"] }
        ]);
        expect(plan.problems).toEqual([]);
    });

    it("says when 'after' is not a list of numbers, and reads the wave as waiting for the one before", () => {

        const plan = graph('[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["1.2","1.3"],"after":"0"}]');

        expect(plan.waves?.[1]).toEqual({ id: 1, tasks: ["1.2", "1.3"] });
        expect(plan.problems.some(problem => /Wave 1 has an 'after' that is not a list/.test(problem.message))).toBe(true);
    });

    it("names an 'after' that points at a wave the graph does not have", () => {

        const plan = graph('[{"id":0,"tasks":["1.1"]},{"id":1,"tasks":["1.2","1.3"],"after":[7]}]');

        expect(plan.problems.some(problem => /Wave 1 waits for wave 7, which is not in the graph/.test(problem.message))).toBe(true);
    });

    /* Only smaller ids, so two waves can never wait for each other and never start. */
    it("names an 'after' that points at the same or a later wave", () => {

        const plan = graph('[{"id":0,"tasks":["1.1"],"after":[1]},{"id":1,"tasks":["1.2","1.3"],"after":[1]}]');

        expect(plan.problems.filter(problem => /can only wait for a wave with a smaller number/.test(problem.message))).toHaveLength(2);
    });
});

describe("fenced examples", () => {

    it("does not read a plan's own example of a task as a task", () => {

        const plan = parsePlan("# Plan\n\n```markdown\n- [ ] 1. Example\n```\n\n- [ ] 1. Real\n  - [ ] 1.1 Work\n");

        expect(plan.tasks.map(task => task.title)).toEqual(["Real", "Work"]);
    });
});

const FLAT = `# Tasks: Greeting

## Phase 1: Setup

- [x] T001 Add the module skeleton in \`src/thing/index.ts\`
- [ ] T002 [P] Add the config type in \`src/thing/config.ts\`
- [ ] T003 [P] Add fixtures in \`test/fixtures.ts\`

## Phase 2: Implementation

- [ ] T004 Implement parsing in \`src/thing/parse.ts\`
  - reads the config type from T002
  - [spec : FR-1, FR-2](spec.md)
- [ ] T005 [P] Wire the CLI in \`src/cli.ts\`

## Phase 3: Verification

- [ ] T010 Run the full suite and report
`;

/*
 * The second dialect, and why it is detected rather than declared: a
 * style states its grammar in prose for the phase that writes the file,
 * so asking it to restate the shape in YAML for the phase that reads it
 * would be the same pipeline written twice.
 */
describe("a flat plan", () => {

    const plan = parsePlan(FLAT);

    it("is recognised, rather than read as a document with no tasks", () => {

        expect(plan.dialect).toBe("flat");
        expect(plan.problems).toEqual([]);
    });

    it("has tasks and no groups - headings do the grouping", () => {

        expect(plan.tasks.map(task => task.id)).toEqual(["T001", "T002", "T003", "T004", "T005", "T010"]);
        expect(plan.tasks.every(task => !task.group)).toBe(true);
        expect(plan.tasks.find(task => task.id === "T010")?.phase).toBe("Phase 3: Verification");
    });

    it("reads the tick and the parallel marker", () => {

        expect(plan.tasks.filter(task => task.done).map(task => task.id)).toEqual(["T001"]);
        expect(plan.tasks.filter(task => task.parallel).map(task => task.id)).toEqual(["T002", "T003", "T005"]);
    });

    /*
     * The citation is one shape in both dialects, but the ids inside it
     * belong to whichever document owns them - and Spec Kit's are
     * `FR-1`. A plan row lists what its task answers for; deciding
     * whether an id resolves is the panel's job, not this one's.
     */
    it("attaches requirements whatever they are numbered", () => {

        expect(plan.tasks.find(task => task.id === "T004")?.requirements).toEqual(["FR-1", "FR-2"]);
    });

    /*
     * So the implement lens fans out identically whichever dialect
     * wrote the file: `[P]` is read as the concurrency statement a JSON
     * graph makes explicitly elsewhere. The list stays an order; the
     * marker says where the order may relax.
     */
    it("derives waves from the markers, keeping the list's order", () => {

        expect(plan.waves).toEqual([
            { id: 0, tasks: ["T001"] },
            { id: 1, tasks: ["T002", "T003"] },
            { id: 2, tasks: ["T004"] },
            { id: 3, tasks: ["T005"] },
            { id: 4, tasks: ["T010"] }
        ]);
    });

    it("does not run marked tasks from two phases together", () => {

        expect(parsePlan("## A\n\n- [ ] T001 [P] One\n\n## B\n\n- [ ] T002 [P] Two\n").waves)
            .toEqual([{ id: 0, tasks: ["T001"] }, { id: 1, tasks: ["T002"] }]);
    });

    it("has no waves when nothing is marked, which is not a problem", () => {

        const sequential = parsePlan("## A\n\n- [ ] T001 One\n- [ ] T002 Two\n");

        expect(sequential.waves).toBeUndefined();
        expect(sequential.problems).toEqual([]);
    });

    it("still names a detail line that grew a checkbox", () => {

        expect(parsePlan("- [ ] T001 Real\n  - [ ] not a task\n").problems
            .some(problem => /checkbox but no 'T' id/.test(problem.message))).toBe(true);
    });

    it("still reports a duplicated id", () => {

        expect(parsePlan("- [ ] T001 One\n- [ ] T001 Two\n").problems
            .some(problem => /'T001' is numbered the same/.test(problem.message))).toBe(true);
    });

    it("does not demand a group, the way a hierarchical plan would", () => {

        expect(parsePlan("- [ ] T001 One\n").problems).toEqual([]);
    });
});

describe("the two dialects do not collide", () => {

    it("still reads a numbered plan as hierarchical", () => {

        const plan = parsePlan(PLAN);

        expect(plan.dialect).toBe("hierarchical");
        // `2` has nothing under it, so it is a unit of work, not a group.
        expect(plan.tasks.filter(task => task.group).map(task => task.id)).toEqual(["1"]);
    });

    it("reads a flat plan even where a heading looks like a number", () => {

        expect(parsePlan("## 1. Setup\n\n- [ ] T001 One\n").dialect).toBe("flat");
    });
});


/**
 * A plan Kiro wrote.
 *
 * Its validator accepts four checkbox states and an escaped optional
 * marker. A parser reading two states and a bare asterisk would drop
 * those rows from the implement lens rather than report them - the one
 * failure mode this module exists to prevent, met on the documents it is
 * most likely to be handed.
 */
describe("a plan from Kiro", () => {

    const plan = parsePlan([
        "# Implementation Plan: Greeting",
        "",
        "## Tasks",
        "",
        "- [x] 1. Done group",
        "  - [x] 1.1 Finished",
        "  - [~] 1.2 In flight",
        "  - [-] 1.3 Abandoned",
        "  - [ ]\* 1.4 Optional, escaped marker",
        "    - _Requirements: 1.1, 2.3_",
        ""
    ].join("\n"));

    it("reads every row, whatever state its box carries", () => {

        expect(plan.tasks.map(task => task.id)).toEqual(["1", "1.1", "1.2", "1.3", "1.4"]);
    });

    /* Only a tick is done. In flight and abandoned are both unfinished. */
    it("counts only a tick as done", () => {

        expect(plan.tasks.filter(task => task.done).map(task => task.id)).toEqual(["1", "1.1"]);
    });

    it("reads the escaped optional marker Kiro allows", () => {

        expect(plan.tasks.find(task => task.id === "1.4")?.optional).toBe(true);
    });

    it("still reads Kiro's own citation spelling", () => {

        expect(plan.tasks.find(task => task.id === "1.4")?.requirements).toEqual(["1.1", "2.3"]);
    });

    it("reports none of it as malformed", () => {

        expect(plan.problems.filter(one => /checkbox/.test(one.message))).toEqual([]);
    });
});

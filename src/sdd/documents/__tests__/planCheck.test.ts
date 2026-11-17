import { describe, expect, it } from "vitest";

import { planChecker } from "../planCheck";

/** The reader behind `check_plan`: the parser's own problems, plus the shared-file clash the panel refuses. */
describe("planChecker", () => {

    it("finds nothing wrong with a plan the implement phase will read whole, and says what it read", () => {

        const plan = [
            "# Plan",
            "",
            "- [ ] 1. Group",
            "  - [ ] 1.1 One",
            "    - Files: `src/a.ts`",
            "  - [ ] 1.2 Two",
            "    - Files: `src/b.ts`",
            "",
            "## Task Dependency Graph",
            "",
            "```json",
            '{ "waves": [ { "id": 0, "tasks": ["1.1", "1.2"] } ] }',
            "```",
            ""
        ].join("\n");

        expect(planChecker.problems(plan)).toEqual([]);
        expect(planChecker.summary(plan)).toBe("3 task rows, 1 wave, read as the hierarchical shape.");
    });

    it("names the parser's problems by line, and a wave whose tasks share a file", () => {

        const plan = [
            "# Plan",
            "",
            "- [ ] 1. Group",
            "  - [ ] 1.1 One",
            "    - Files: `src/shared.ts`",
            "  - [ ] 1.2 Two",
            "    - Files: `src/shared.ts`",
            "  - [ ] Three, unnumbered",
            "- [ ] 2.1 Orphan",
            "",
            "## Task Dependency Graph",
            "",
            "```json",
            '{ "waves": [ { "id": 0, "tasks": ["1.1", "1.2"] } ] }',
            "```",
            ""
        ].join("\n");

        const problems = planChecker.problems(plan);

        expect(problems).toHaveLength(4);
        expect(problems[0]).toMatch(/^line 8: This line has a checkbox but no task number/);
        expect(problems[1]).toMatch(/^line 9: Task '2.1' has no task '2' above it/);
        expect(problems[2]).toContain("Task '2.1' is in no wave");
        expect(problems[3]).toBe("wave 0: 1.1 and 1.2 both name 'src/shared.ts' - two tasks in one wave must not touch the same file; move one to a later wave.");
    });
});

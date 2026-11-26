import { describe, expect, it } from "vitest";
import { matchesTarget } from "../specRefs";
import { CitationTarget, taskMarks } from "../taskMarks";

/** The requirements document is `requirements.md`, next to the plan - the way the panel resolves it, cut down. */
const pointsHere = (target: CitationTarget) => "href" in target
    ? target.href === "requirements.md"
    : matchesTarget("requirements", target.noun);

/** The 1-based line a fragment sits on. */
function lineOf(text: string, fragment: string): number {

    const index = text.split("\n").findIndex(line => line.includes(fragment));

    if (index < 0)
        throw new Error(`'${fragment}' is not in the text`);

    return index + 1;
}

const REQUIREMENTS = `# Requirements Document

## Introduction

Retry and timeouts.

## Requirements

### Requirement 1: Retry on timeout

**User Story:** As a user, I want retries, so that a slow call does not fail.

#### Acceptance Criteria

1. WHEN a call times out THEN the client SHALL retry once
2. WHEN the retry fails THEN the client SHALL report the error
3. IF the user cancels THEN the client SHALL stop retrying

### Requirement 2: Settings

**User Story:** As an admin, I want a setting.

#### Acceptance Criteria

1. WHEN the setting is off THEN the client SHALL NOT retry

### Requirement 3: Logging

Every retry is logged.
`;

const PLAN = `# Implementation Plan

- [ ] 1. Retry
  - [ ] 1.1 Add the retry
    - Files: \`src/retry.ts\`
    - _Requirements: 1.1, 2.1_
  - [ ] 1.2 Report the error
    - Files: \`src/retry.ts\`
    - [Requirements : 1.2](requirements.md)
    - [Design : Dec-1](design.md)
- [ ] 2. Tests
  - [ ]* 2.1 Property test for the retry
    - **Property 1: Retry once**
    - **Validates: Requirements 1.1**

## Task Dependency Graph

\`\`\`json
{ "waves": [ { "id": 0, "tasks": ["1.1", "1.2", "2.1"] } ] }
\`\`\`
`;

describe("taskMarks", () => {

    const marks = taskMarks(REQUIREMENTS, undefined, PLAN, pointsHere);

    const at = (fragment: string) => marks.get(lineOf(REQUIREMENTS, fragment));

    it("names the tasks that cite each criterion, in plan order", () => {

        expect(at("SHALL retry once")).toEqual(["1.1", "2.1"]);
        expect(at("SHALL report the error")).toEqual(["1.2"]);
        expect(at("SHALL NOT retry")).toEqual(["1.1"]);
    });

    it("reads every spelling the plan page reads: the italic line, the link, and Validates", () => {

        // 1.1 is cited twice - by `_Requirements:_` under 1.1 and by
        // `**Validates:**` under 2.1 - and 1.2 by the link.
        expect(at("SHALL retry once")).toEqual(["1.1", "2.1"]);
        expect(at("SHALL report the error")).toEqual(["1.2"]);
    });

    it("gives a criterion no task cites an empty list - the 'No task' mark", () => {

        expect(at("SHALL stop retrying")).toEqual([]);
    });

    it("leaves a requirement with criteria unmarked unless a task cites it whole", () => {

        expect(at("### Requirement 1")).toBeUndefined();
        expect(at("### Requirement 2")).toBeUndefined();
    });

    it("marks a requirement with no criteria either way, since it can only be cited whole", () => {

        expect(at("### Requirement 3")).toEqual([]);
    });

    it("marks nothing else - not the introduction, not the user stories", () => {

        expect([...marks.keys()].sort((one, other) => one - other)).toEqual([
            lineOf(REQUIREMENTS, "SHALL retry once"),
            lineOf(REQUIREMENTS, "SHALL report the error"),
            lineOf(REQUIREMENTS, "SHALL stop retrying"),
            lineOf(REQUIREMENTS, "SHALL NOT retry"),
            lineOf(REQUIREMENTS, "### Requirement 3")
        ].sort((one, other) => one - other));
    });

    it("counts a task that cites a whole requirement for each of its criteria", () => {

        const plan = "- [ ] 4. Everything about retries\n  - _Requirements: 1, 3_\n";

        const whole = taskMarks(REQUIREMENTS, undefined, plan, pointsHere);

        expect(whole.get(lineOf(REQUIREMENTS, "### Requirement 1"))).toEqual(["4"]);
        expect(whole.get(lineOf(REQUIREMENTS, "SHALL retry once"))).toEqual(["4"]);
        expect(whole.get(lineOf(REQUIREMENTS, "SHALL stop retrying"))).toEqual(["4"]);
        expect(whole.get(lineOf(REQUIREMENTS, "### Requirement 3"))).toEqual(["4"]);

        // Requirement 2 is not cited at all.
        expect(whole.get(lineOf(REQUIREMENTS, "### Requirement 2"))).toBeUndefined();
        expect(whole.get(lineOf(REQUIREMENTS, "SHALL NOT retry"))).toEqual([]);
    });

    it("marks nothing when the plan cites only other documents, or there is no plan", () => {

        const designOnly = "- [ ] 1. Build it\n  - [Design : Dec-1](design.md)\n";

        expect(taskMarks(REQUIREMENTS, undefined, designOnly, pointsHere).size).toBe(0);
        expect(taskMarks(REQUIREMENTS, undefined, "", pointsHere).size).toBe(0);
        expect(taskMarks(REQUIREMENTS, undefined, undefined, pointsHere).size).toBe(0);
        expect(taskMarks(undefined, undefined, PLAN, pointsHere).size).toBe(0);
    });

    it("ignores a fenced example, and a citation under a heading belongs to no task", () => {

        const plan = [
            "# Plan",
            "",
            "```markdown",
            "- [ ] 9.9 An example row, not a task",
            "  - _Requirements: 1.3_",
            "```",
            "",
            "- [ ] 1. First",
            "  - _Requirements: 1.1_",
            "",
            "## Notes",
            "",
            "- _Requirements: 1.2_"
        ].join("\n");

        const read = taskMarks(REQUIREMENTS, undefined, plan, pointsHere);

        expect(read.get(lineOf(REQUIREMENTS, "SHALL retry once"))).toEqual(["1"]);
        expect(read.get(lineOf(REQUIREMENTS, "SHALL report the error"))).toEqual([]);
        expect(read.get(lineOf(REQUIREMENTS, "SHALL stop retrying"))).toEqual([]);
    });

    it("gives each row its own citations whatever its box says, Kiro's [~] and [-] included", () => {

        const plan = [
            "- [x] 1. Done",
            "  - _Requirements: 1.1_",
            "- [-] 2. Dropped",
            "  - _Requirements: 1.2_",
            "- [~] 3. In progress",
            "  - _Requirements: 1.3_"
        ].join("\n");

        const read = taskMarks(REQUIREMENTS, undefined, plan, pointsHere);

        expect(read.get(lineOf(REQUIREMENTS, "SHALL retry once"))).toEqual(["1"]);
        expect(read.get(lineOf(REQUIREMENTS, "SHALL report the error"))).toEqual(["2"]);
        expect(read.get(lineOf(REQUIREMENTS, "SHALL stop retrying"))).toEqual(["3"]);
    });

    it("lists a task once, and in the order the plan has its rows", () => {

        const plan = [
            "- [ ] 3. Written first",
            "  - _Requirements: 1.1_",
            "- [ ] 1. Written second",
            "  - _Requirements: 1.1_",
            "  - [Requirements : 1.1](requirements.md)"
        ].join("\n");

        const read = taskMarks(REQUIREMENTS, undefined, plan, pointsHere);

        expect(read.get(lineOf(REQUIREMENTS, "SHALL retry once"))).toEqual(["3", "1"]);
    });

    it("finds the citation past an underscore inside a word or in code on the same line", () => {

        const plan = [
            "- [ ] 1. Edit `my_file_name.ts` and snake_case_name _Requirements: 1.1_",
            "  - Touch retry_count first, then _Requirements: 1.2_"
        ].join("\n");

        const read = taskMarks(REQUIREMENTS, undefined, plan, pointsHere);

        expect(read.get(lineOf(REQUIREMENTS, "SHALL retry once"))).toEqual(["1"]);
        expect(read.get(lineOf(REQUIREMENTS, "SHALL report the error"))).toEqual(["1"]);
    });

    it("reads a stage's own prefix - Req-1.2", () => {

        const requirements = [
            "### Req-1: Retry",
            "",
            "#### Acceptance Criteria",
            "",
            "1. WHEN a call times out THEN the client SHALL retry once",
            "2. WHEN the retry fails THEN the client SHALL report the error"
        ].join("\n");

        const plan = "- [ ] 1. Retry\n  - _Requirements: Req-1.1_\n";

        const read = taskMarks(requirements, "Req", plan, pointsHere);

        expect(read.get(lineOf(requirements, "SHALL retry once"))).toEqual(["1"]);
        expect(read.get(lineOf(requirements, "SHALL report the error"))).toEqual([]);
    });

    it("leaves ids the document declares some other way unmarked", () => {

        const requirements = [
            "## Non-functional",
            "",
            "- **NFR-1**: The client SHALL log every retry"
        ].join("\n");

        const plan = "- [ ] 1. Logging\n  - _Requirements: NFR-1_\n";

        expect(taskMarks(requirements, undefined, plan, pointsHere).size).toBe(0);
    });
});

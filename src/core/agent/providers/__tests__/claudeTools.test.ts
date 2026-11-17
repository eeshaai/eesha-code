import { describe, expect, it } from "vitest";

import { builtInTools, readClaudeTools, writeClaudeTools } from "../claudeTools";

describe("Claude's built-in tool list", () => {

    it("keeps the runtime's own tools, sorted, and drops MCP ones", () => {

        expect(builtInTools(["Read", "mcp__ado__wit_get", "Bash", "", 7])).toEqual(["Bash", "Read"]);
    });

    it("reads back what a full session wrote - the suite's home is a temp folder", () => {

        writeClaudeTools(["Read", "Edit"]);

        expect(readClaudeTools()).toEqual(["Edit", "Read"]);
    });
});

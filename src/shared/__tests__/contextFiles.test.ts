import { describe, expect, it } from "vitest";
import { contextFile, contextFiles } from "../contextFiles";

describe("contextFile", () => {

    it("reads every spelling of a full path as the same file", () => {

        expect(contextFile({ name: "/c%3A/work/repo/.kiro/steering/tech.md", tokens: 1 })).toBe("c:/work/repo/.kiro/steering/tech.md");
        expect(contextFile({ name: "/c:/work/repo/.kiro/steering/tech.md", tokens: 1 })).toBe("c:/work/repo/.kiro/steering/tech.md");
        expect(contextFile({ name: "C:\\Users\\me\\.claude\\CLAUDE.md", tokens: 1, note: "User" })).toBe("C:/Users/me/.claude/CLAUDE.md");
        expect(contextFile({ name: "/home/me/.claude/CLAUDE.md", tokens: 1 })).toBe("/home/me/.claude/CLAUDE.md");
    });

    it("takes a row marked not loaded for a file, and any other name with no full path for not a file", () => {

        expect(contextFile({ name: "AGENTS.md", tokens: 0, note: "not loaded" })).toBe("AGENTS.md");
        expect(contextFile({ name: "read_file", tokens: 700 })).toBeUndefined();
        expect(contextFile({ name: "github: list_issues", tokens: 40 })).toBeUndefined();
        expect(contextFile({ name: "50% rule", tokens: 1 })).toBeUndefined();
    });
});

describe("contextFiles", () => {

    it("lists the files of every part, and nothing for a window with no parts", () => {

        expect(contextFiles({
            used: 1, size: 100,
            parts: [
                { name: "Memory files", tokens: 10, items: [{ name: "D:\\repo\\CLAUDE.md", tokens: 10, note: "Project" }] },
                { name: "System tools", tokens: 5, items: [{ name: "Bash", tokens: 5 }] },
                { name: "Messages", tokens: 3 }
            ]
        })).toEqual(["D:/repo/CLAUDE.md"]);

        expect(contextFiles({ used: 1, size: 100 })).toEqual([]);
    });
});

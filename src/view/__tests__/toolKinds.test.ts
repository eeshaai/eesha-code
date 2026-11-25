import { describe, expect, it } from "vitest";

import { argPairs, readFile, readRange, toolHeading, toolIcon, toolSummary } from "../chat/toolKinds";

/**
 * A tool call drawn by its kind. The kind is the verb at the start of
 * the call's title, as the engine writes it ("Reading app.js").
 */
describe("tool kinds", () => {

    it("picks the icon from the title's verb, and the wrench for anything else", () => {

        expect(toolIcon("Reading app.js")).toBe("file");
        expect(toolIcon("Editing app.js")).toBe("edit");
        expect(toolIcon("Executing 'npm test'")).toBe("terminal");
        expect(toolIcon("Searching 'TODO'")).toBe("search");
        expect(toolIcon("Searching web 'vitest'")).toBe("globe");
        expect(toolIcon("mcp__github__search_issues")).toBe("wrench");
        expect(toolIcon("Allowed without asking: shell")).toBe("wrench");
    });

    it("says what a run of calls did, each kind once, in the order it came", () => {

        expect(toolSummary([
            "Reading a.ts",
            "Executing 'npm test'",
            "Reading b.ts",
            "mcp__github__search_issues",
            "Searching 'x'"
        ])).toBe("read 2 files, ran 1 command, 1 other call, 1 search");

        expect(toolSummary(["Editing a.ts"])).toBe("edited 1 file");
    });

    it("says nothing when every call is of no known kind - the group's title already has the count", () => {

        expect(toolSummary(["mcp__github__search_issues", "mcp__ado__get_item"])).toBe("");
    });

    it("reads the engine's argument line as name and value pairs", () => {

        expect(argPairs("file_path=src/a.ts, offset=1, limit=200")).toEqual([
            ["file_path", "src/a.ts"],
            ["offset", "1"],
            ["limit", "200"]
        ]);
    });

    it("keeps a comma inside a value when no name follows it", () => {

        expect(argPairs("old_string=f(a, b), new_string=f(a, b, c)")).toEqual([
            ["old_string", "f(a, b)"],
            ["new_string", "f(a, b, c)"]
        ]);
    });

    it("gives nothing for a line that is not name and value pairs", () => {

        expect(argPairs("npm test")).toBeUndefined();
        expect(argPairs("")).toBeUndefined();
        expect(argPairs(undefined)).toBeUndefined();
    });

    it("splits a title into the verb and what it acted on, quotes taken off", () => {

        expect(toolHeading("Reading app.js")).toEqual({ verb: "Read", target: "app.js" });
        expect(toolHeading("Executing 'npm test'")).toEqual({ verb: "Run", target: "npm test" });
        expect(toolHeading("Searching web 'vitest docs'")).toEqual({ verb: "Search web", target: "vitest docs" });
        expect(toolHeading("Searching 'TODO'")).toEqual({ verb: "Search", target: "TODO" });
        expect(toolHeading("Running task 'find the bug'")).toEqual({ verb: "Task", target: "find the bug" });
        expect(toolHeading("Fetching https://example.com")).toEqual({ verb: "Fetch", target: "https://example.com" });
    });

    it("gives no heading for a bare tool name", () => {

        expect(toolHeading("mcp__github__search_issues")).toBeUndefined();
        expect(toolHeading("Allowed without asking: shell")).toBeUndefined();
        expect(toolHeading("ToolSearch")).toBeUndefined();
    });

    it("finds the file a read opened, only when it is a full path not cut short", () => {

        expect(readFile("Reading a.ts", "file_path=D:/repo/a.ts, limit=20")).toBe("D:/repo/a.ts");
        expect(readFile("Reading a.ts", "file_path=C:\\repo\\a.ts")).toBe("C:\\repo\\a.ts");
        expect(readFile("Reading a.ts", "path=/home/me/a.ts")).toBe("/home/me/a.ts");
        expect(readFile("Reading a.ts", "file_path=src/a.ts")).toBeUndefined();
        expect(readFile("Reading a.ts", "file_path=D:/repo/very/long...")).toBeUndefined();
        expect(readFile("Editing a.ts", "file_path=D:/repo/a.ts")).toBeUndefined();
    });

    it("says which lines a read asked for", () => {

        // Claude: offset is the first line, limit how many.
        expect(readRange("Reading a.ts", "file_path=a.ts, offset=40, limit=20")).toBe("lines 40-59");
        expect(readRange("Reading a.ts", "file_path=a.ts, limit=200")).toBe("lines 1-200");
        expect(readRange("Reading a.ts", "file_path=a.ts, offset=40")).toBe("from line 40");

        // Copilot: view_range is [first, last]; -1 is the end of the file.
        expect(readRange("Reading a.ts", "path=a.ts, view_range=[1,50]")).toBe("lines 1-50");
        expect(readRange("Reading a.ts", "path=a.ts, view_range=[30,-1]")).toBe("from line 30");

        expect(readRange("Reading a.ts", "file_path=a.ts")).toBeUndefined();
        expect(readRange("Editing a.ts", "file_path=a.ts, offset=1, limit=2")).toBeUndefined();
    });
});

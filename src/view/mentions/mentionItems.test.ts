import { describe, expect, it } from "vitest";
import { commandItems, fileItems, pathItems, toolItems } from "./mentionItems";

describe("commandItems", () => {

    const commands = [
        { name: "compact", description: "Shrink the chat" },
        { name: "recompile" },
        { name: "clear" },
        { name: "compare", hint: "<a> <b>" }
    ];

    it("lists names that start with the text first, then names that contain it", () => {

        expect(commandItems(commands, "comp").map(one => one.key)).toEqual(["compact", "compare", "recompile"]);
    });

    it("lists every command when nothing is typed", () => {

        expect(commandItems(commands, "")).toHaveLength(4);
    });

    it("matches without regard to case and keeps the description and hint", () => {

        expect(commandItems(commands, "COMPA")).toEqual([
            { kind: "command", key: "compact", label: "compact", description: "Shrink the chat", hint: undefined },
            { kind: "command", key: "compare", label: "compare", description: undefined, hint: "<a> <b>" }
        ]);
    });

    it("shows at most 20 rows", () => {

        const many = Array.from({ length: 30 }, (_, index) => ({ name: `c${index}` }));

        expect(commandItems(many, "c")).toHaveLength(20);
    });
});

describe("toolItems", () => {

    const mcpServers = [{ id: "fs", name: "filesystem", status: "online" as const }];
    const tools = [{ id: "search", name: "web_search" }, { id: "files", name: "file_reader" }];

    it("puts MCP servers before tools and keeps the names that contain the text", () => {

        expect(toolItems(tools, mcpServers, "file").map(one => one.key)).toEqual(["fs", "files"]);
    });

    it("gives the kind of each row", () => {

        expect(toolItems(tools, mcpServers, "").map(one => one.kind)).toEqual(["mcp", "tool", "tool"]);
    });

    it("shows at most 20 rows", () => {

        const many = Array.from({ length: 30 }, (_, index) => ({ id: `t${index}`, name: `t${index}` }));

        expect(toolItems(many, [], "t")).toHaveLength(20);
    });
});

describe("fileItems", () => {

    it("keeps the first 20", () => {

        const many = Array.from({ length: 25 }, (_, index) => ({ name: `f${index}`, path: `src/f${index}` }));

        expect(fileItems(many).map(one => one.name)).toEqual(many.slice(0, 20).map(one => one.name));
    });
});

describe("pathItems", () => {

    it("puts the refresh row last", () => {

        const found = [{ name: "a" }, { name: "Refresh", refresh: true }, { name: "b" }];

        expect(pathItems(found).map(one => one.name)).toEqual(["a", "b", "Refresh"]);
    });

    it("keeps 50 real rows and still adds the refresh row", () => {

        const many = Array.from({ length: 60 }, (_, index) => ({ name: `p${index}` }));
        const shown = pathItems([...many, { name: "Refresh", refresh: true }]);

        expect(shown).toHaveLength(51);
        expect(shown[50].refresh).toBe(true);
    });

    it("has no refresh row when none is given", () => {

        expect(pathItems([{ name: "a" }])).toEqual([{ name: "a" }]);
    });
});

import { describe, expect, it } from "vitest";

import { mcpServerConfig } from "./mcpServerConfig";

describe("mcpServerConfig", () => {

    const typed = { name: " filesystem ", type: "stdio" as const, command: " npx ", argsText: "-y\n server-filesystem \n\nC:/data", url: "", envRows: [{ key: " NODE_ENV ", value: "production" }, { key: "", value: "x" }] };

    it("trims a stdio server, splits its arguments one per line and collects the env rows with a name", () => {

        expect(mcpServerConfig(typed)).toEqual({
            name: "filesystem",
            type: "stdio",
            command: "npx",
            args: ["-y", "server-filesystem", "C:/data"],
            env: { NODE_ENV: "production" }
        });
    });

    it("gives an http server its url and no command or arguments", () => {

        expect(mcpServerConfig({ ...typed, type: "http", url: " https://mcp.example.com ", envRows: [{ key: "", value: "" }] })).toEqual({
            name: "filesystem",
            type: "http",
            url: "https://mcp.example.com",
            env: undefined
        });
    });
});

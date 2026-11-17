import { describe, expect, it } from "vitest";

import { acpCall, claudeCall, copilotRequestCall, copilotToolCall } from "../calls";

/*
 * Each provider's own request, put into the one shape the check reads.
 * What matters is `what` and the thing matched on - the command, the file,
 * the server and tool - never the runtime's own tool name.
 */

describe("claudeCall", () => {

    it("reads commands, edits, reads, web and MCP", () => {

        expect(claudeCall("Bash", { command: "npm test" })).toMatchObject({ what: "command", command: "npm test" });
        expect(claudeCall("PowerShell", { command: "Get-ChildItem" })).toMatchObject({ what: "command", command: "Get-ChildItem" });
        expect(claudeCall("Edit", { file_path: "src/a.ts" })).toMatchObject({ what: "edit", paths: ["src/a.ts"], writes: true });
        expect(claudeCall("Read", { file_path: "src/a.ts" })).toMatchObject({ what: "read", paths: ["src/a.ts"], writes: false });
        expect(claudeCall("WebFetch", { url: "https://a.test" })).toMatchObject({ what: "web", url: "https://a.test" });
        expect(claudeCall("WebSearch", { query: "acp spec" })).toMatchObject({ what: "web", search: "acp spec" });
        expect(claudeCall("mcp__ado__wit_get", {})).toMatchObject({ what: "mcp", server: "ado", mcpTool: "wit_get" });
    });

    it("its own housekeeping and our own tools always run", () => {

        expect(claudeCall("TodoWrite", {}).what).toBe("housekeeping");
        expect(claudeCall("Task", { prompt: "x" }).what).toBe("housekeeping");
        expect(claudeCall("mcp__eesha__ask_user", {}).what).toBe("housekeeping");
    });

    it("any other tool is remembered by its name", () => {

        expect(claudeCall("SomethingNew", {})).toMatchObject({ what: "tool", name: "SomethingNew" });
    });
});

describe("copilotToolCall", () => {

    it("reads shells, typing into a shell, edits and web", () => {

        expect(copilotToolCall("powershell", { command: "npm test" })).toMatchObject({ what: "command", command: "npm test" });
        expect(copilotToolCall("write_powershell", { input: "y" })).toMatchObject({ what: "command", command: "y" });
        expect(copilotToolCall("edit", { path: "a.ts" })).toMatchObject({ what: "edit", writes: true });
        expect(copilotToolCall("web_fetch", { url: "https://a.test" })).toMatchObject({ what: "web", url: "https://a.test" });
    });

    it("its own housekeeping always runs", () => {

        expect(copilotToolCall("update_todo", {}).what).toBe("housekeeping");
        expect(copilotToolCall("read_powershell", {}).what).toBe("housekeeping");
    });
});

describe("copilotRequestCall", () => {

    it("a shell request carries its full command, and a sandbox bypass is once only", () => {

        expect(copilotRequestCall({ kind: "shell", fullCommandText: "npm i" })).toMatchObject({ what: "command", command: "npm i" });
        expect(copilotRequestCall({ kind: "shell", fullCommandText: "npm i", requestSandboxBypass: true })).toMatchObject({ onceOnly: true });
    });

    it("reads write, read, mcp, url and custom-tool requests", () => {

        expect(copilotRequestCall({ kind: "write", fileName: "a.ts" })).toMatchObject({ what: "edit", paths: ["a.ts"] });
        expect(copilotRequestCall({ kind: "read", path: "a.ts" })).toMatchObject({ what: "read", paths: ["a.ts"], writes: false });
        expect(copilotRequestCall({ kind: "mcp", serverName: "ado", toolName: "get" })).toMatchObject({ what: "mcp", server: "ado", mcpTool: "get" });
        expect(copilotRequestCall({ kind: "url", url: "https://a.test" })).toMatchObject({ what: "web", url: "https://a.test" });
        expect(copilotRequestCall({ kind: "custom-tool", toolName: "lint" })).toMatchObject({ what: "tool", name: "lint" });
        expect(copilotRequestCall({ kind: "custom-tool" }).what).toBe("unknown");
    });

    it("a kind it does not know has nothing to tell it by", () => {

        expect(copilotRequestCall({ kind: "teleport" }).what).toBe("unknown");
    });
});

describe("acpCall", () => {

    it("keeps the agent's own kind, which Semi Auto asks by", () => {

        expect(acpCall({ kind: "execute", title: "npm test", rawInput: { command: "npm test" } }))
            .toMatchObject({ what: "command", command: "npm test", acpKind: "execute" });
    });

    it("finds a command in an array, a string, or the title", () => {

        expect(acpCall({ kind: "execute", rawInput: { command: ["git", "status"] } }).command).toBe("git status");
        expect(acpCall({ kind: "execute", rawInput: "ls -la" }).command).toBe("ls -la");
        expect(acpCall({ kind: "execute", title: "`pwd`" }).command).toBe("pwd");
    });

    it("reads edits and reads from their locations", () => {

        expect(acpCall({ kind: "edit", title: "Edit a.ts", locations: [{ path: "/r/a.ts" }] })).toMatchObject({ what: "edit", paths: ["/r/a.ts"] });
        expect(acpCall({ kind: "read", locations: [{ path: "/r/a.ts" }] })).toMatchObject({ what: "read", writes: false });
    });

    it("an MCP title is an MCP tool", () => {

        expect(acpCall({ kind: "other", title: "mcp__ado__get" })).toMatchObject({ what: "mcp", server: "ado", mcpTool: "get" });
    });

    it("no kind, no title and no input has nothing to tell it by", () => {

        expect(acpCall({}).what).toBe("unknown");
        expect(acpCall(undefined).what).toBe("unknown");
    });
});

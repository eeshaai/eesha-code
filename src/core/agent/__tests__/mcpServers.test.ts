import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
    normalizeMcpServers, resolveExecutable, resolveMcpServerCommand, runnableCommand, toAcpMcpServers
} from "../providers/mcpServers";

/**
 * On Windows a bare `npx` is a name only a shell can resolve, so a
 * server declared that way starts nowhere and the session runs without
 * it. `isWindows` is injected so both platforms are tested from either.
 */
describe("normalizeMcpServers", () => {

    it("wraps a bare command in cmd /c on Windows", () => {

        const servers = normalizeMcpServers(
            { ado: { command: "npx", args: ["-y", "@azure-devops/mcp", "contoso"] } },
            { isWindows: true });

        expect(servers?.ado).toMatchObject({
            command: "cmd",
            args: ["/c", "npx", "-y", "@azure-devops/mcp", "contoso"]
        });
    });

    it("wraps a bare command with no args at all", () => {

        expect(normalizeMcpServers({ s: { command: "npx" } }, { isWindows: true })?.s)
            .toMatchObject({ command: "cmd", args: ["/c", "npx"] });
    });

    it("leaves the command alone off Windows", () => {

        expect(normalizeMcpServers({ s: { command: "npx", args: ["-y"] } }, { isWindows: false })?.s)
            .toMatchObject({ command: "npx", args: ["-y"] });
    });

    /* CreateProcess can start these directly. */
    it("leaves a command with an extension alone", () => {

        expect(normalizeMcpServers({ s: { command: "node.exe" } }, { isWindows: true })?.s)
            .toMatchObject({ command: "node.exe" });

        expect(normalizeMcpServers({ s: { command: "C:/tools/server.cmd" } }, { isWindows: true })?.s)
            .toMatchObject({ command: "C:/tools/server.cmd" });
    });

    /* `cmd /c cmd /c ...` would run, so nothing would flag it. */
    it("does not wrap a command that already is a shell", () => {

        expect(normalizeMcpServers({ s: { command: "cmd", args: ["/c", "npx"] } }, { isWindows: true })?.s)
            .toMatchObject({ command: "cmd", args: ["/c", "npx"] });

        expect(normalizeMcpServers({ s: { command: "powershell" } }, { isWindows: true })?.s)
            .toMatchObject({ command: "powershell" });
    });

    /* `stdio` and `http` are shared by both SDKs. `local` is Copilot's only. */
    it("stamps stdio on a command server and http on a url server", () => {

        expect(normalizeMcpServers({ s: { command: "npx" } }, { isWindows: false })?.s)
            .toMatchObject({ type: "stdio" });

        expect(normalizeMcpServers({ s: { url: "https://example.com/mcp" } }, { isWindows: false })?.s)
            .toMatchObject({ type: "http" });
    });

    /* Copilot's word for "all". Claude's `tools` is a policy list, not names. */
    it("fills tools only on the copilot dialect", () => {

        expect(normalizeMcpServers(
            { s: { command: "npx" } }, { dialect: "copilot", isWindows: false })?.s)
            .toMatchObject({ tools: ["*"] });

        const claude = normalizeMcpServers(
            { s: { command: "npx" } }, { dialect: "claude", isWindows: false })
            ?.s as Record<string, unknown>;

        expect(claude.tools).toBeUndefined();

        const probe = normalizeMcpServers({ s: { command: "npx" } }, { isWindows: false })
            ?.s as Record<string, unknown>;

        expect(probe.tools).toBeUndefined();
    });

    /* An author's `local` still means stdio to the SDK that has no `local`. */
    it("translates an author-written local to stdio on the claude dialect only", () => {

        expect(normalizeMcpServers(
            { s: { command: "npx", type: "local" } }, { dialect: "claude", isWindows: false })?.s)
            .toMatchObject({ type: "stdio" });

        expect(normalizeMcpServers(
            { s: { command: "npx", type: "local" } }, { dialect: "copilot", isWindows: false })?.s)
            .toMatchObject({ type: "local" });
    });

    it("keeps the type and tools an author stated", () => {

        expect(normalizeMcpServers(
            { s: { command: "npx", type: "stdio", tools: ["one", "two"] } },
            { dialect: "copilot", isWindows: false })?.s)
            .toMatchObject({ type: "stdio", tools: ["one", "two"] });

        expect(normalizeMcpServers(
            { s: { url: "https://example.com/mcp", type: "sse" } },
            { dialect: "claude", isWindows: false })?.s)
            .toMatchObject({ type: "sse" });
    });

    /* Guessing would hide that the entry is malformed. */
    it("stamps no type on a server with neither command nor url", () => {

        const server = normalizeMcpServers({ s: { note: "malformed" } }, { isWindows: false })
            ?.s as Record<string, unknown>;

        expect(server.type).toBeUndefined();
    });

    /* A malformed entry is the CLI's to complain about. */
    it("passes a non-object entry through untouched", () => {

        expect(normalizeMcpServers({ s: "not a server" }, { isWindows: true })?.s).toBe("not a server");
        expect(normalizeMcpServers({ s: null }, { isWindows: true })?.s).toBeNull();
    });

    it("returns undefined for undefined", () => {

        expect(normalizeMcpServers(undefined, { isWindows: true })).toBeUndefined();
    });
});

/**
 * The single-command form `AcpProvider` spawns an `ai.acpAgents.<id>`
 * entry through. Same fix as `normalizeServer`. A bare npm-shimmed
 * command (`claude-agent-acp`) fails with `ENOENT` without it.
 */
describe("runnableCommand", () => {

    it("wraps a bare command in cmd /c on Windows", () => {

        expect(runnableCommand("claude-agent-acp", ["--foo"], true))
            .toEqual({ command: "cmd", args: ["/c", "claude-agent-acp", "--foo"] });
    });

    it("wraps a bare command with no args at all", () => {

        expect(runnableCommand("kiro-cli", [], true))
            .toEqual({ command: "cmd", args: ["/c", "kiro-cli"] });
    });

    it("returns undefined off Windows - nothing to wrap", () => {

        expect(runnableCommand("claude-agent-acp", ["--foo"], false)).toBeUndefined();
    });

    it("returns undefined for a command that already carries an extension", () => {

        expect(runnableCommand("node.exe", ["dist/index.js"], true)).toBeUndefined();
        expect(runnableCommand("C:/tools/kiro-cli.cmd", ["acp"], true)).toBeUndefined();
    });

    it("returns undefined for a command that already is a shell", () => {

        expect(runnableCommand("cmd", ["/c", "kiro-cli", "acp"], true)).toBeUndefined();
        expect(runnableCommand("powershell", [], true)).toBeUndefined();
    });

    it("defaults isWindows from the real platform when not given", () => {

        expect(runnableCommand("claude-agent-acp", []))
            .toEqual(process.platform === "win32" ? { command: "cmd", args: ["/c", "claude-agent-acp"] } : undefined);
    });
});

/**
 * ACP's own `mcpServers` shape: an array of self-naming objects, with
 * `env`/`headers` as `{ name, value }` pairs. See
 * `NewSessionRequest.mcpServers: McpServer[]` in the SDK's schema.
 */
describe("toAcpMcpServers", () => {

    // Empty pathEnv throughout, so every command resolves to itself.
    // Resolution has its own describe block below.
    it("converts a stdio server, env included, in the array shape", () => {

        expect(toAcpMcpServers(
            { ado: { command: "npx", args: ["-y", "@azure-devops/mcp"], env: { ADO_PAT: "secret" } } },
            false, ""))
            .toEqual([{
                type: "stdio", name: "ado", command: "npx", args: ["-y", "@azure-devops/mcp"],
                env: [{ name: "ADO_PAT", value: "secret" }]
            }]);
    });

    it("defaults args and env to empty when the declaration says nothing", () => {

        expect(toAcpMcpServers({ ado: { command: "npx" } }, false, ""))
            .toEqual([{ type: "stdio", name: "ado", command: "npx", args: [], env: [] }]);
    });

    it("applies the Windows cmd-shim fix once a command resolves to a .cmd/.bat file", () => {

        // Unresolved ("npx" stays "npx", no extension) the wrap does not
        // apply, unlike `runnableCommand`. See `resolveMcpServerCommand`
        // for why the two differ.
        expect(toAcpMcpServers({ ado: { command: "npx", args: ["-y"] } }, true, ""))
            .toEqual([{ type: "stdio", name: "ado", command: "npx", args: ["-y"], env: [] }]);
    });

    it("converts an http server, headers included", () => {

        expect(toAcpMcpServers(
            { remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } } },
            false, ""))
            .toEqual([{
                type: "http", name: "remote", url: "https://example.com/mcp",
                headers: [{ name: "Authorization", value: "Bearer x" }]
            }]);
    });

    it("converts an sse server the same way as http", () => {

        expect(toAcpMcpServers({ remote: { type: "sse", url: "https://example.com/mcp" } }, false, ""))
            .toEqual([{ type: "sse", name: "remote", url: "https://example.com/mcp", headers: [] }]);
    });

    it("infers stdio from command and http from url, same as every other dialect", () => {

        expect(toAcpMcpServers({ a: { command: "npx" }, b: { url: "https://example.com" } }, false, ""))
            .toEqual([
                { type: "stdio", name: "a", command: "npx", args: [], env: [] },
                { type: "http", name: "b", url: "https://example.com", headers: [] }
            ]);
    });

    it("drops a malformed entry rather than failing every other server", () => {

        expect(toAcpMcpServers({ bad: { note: "no command or url" }, good: { command: "npx" } }, false, ""))
            .toEqual([{ type: "stdio", name: "good", command: "npx", args: [], env: [] }]);

        expect(toAcpMcpServers({ bad: "not a server" }, false, "")).toEqual([]);
    });

    it("returns an empty array for an empty map", () => {

        expect(toAcpMcpServers({}, false, "")).toEqual([]);
    });
});

/**
 * ACP's schema documents a stdio server's `command` as an absolute
 * path. An agent that enforces that silently never connects to a server
 * declared with a bare `npx`. Fixture-based, not this machine's PATH,
 * so the test is the same everywhere.
 */
describe("resolveExecutable / resolveMcpServerCommand", () => {

    // Spelled the way the filesystem spells it, not the way the temp
    // path happened to arrive. A GitHub Windows runner's TEMP is the
    // 8.3 short form (`C:\Users\RUNNER~1\...`), and `resolveExecutable`
    // normalises what it finds through `realpathSync.native` - so an
    // expectation built from the raw `mkdtempSync` string compares
    // `RUNNER~1` against `runneradmin` and fails on the spelling alone.
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "acp-resolve-")));

    beforeAll(() => {

        fs.writeFileSync(path.join(dir, "real-tool.exe"), "");
        fs.writeFileSync(path.join(dir, "npx.cmd"), "");
        fs.writeFileSync(path.join(dir, "myscript.sh"), "");
    });

    afterAll(() => {

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // A controlled, lowercase PATHEXT, not this machine's real one.
    const pathExt = ".exe;.cmd";

    it("resolves a bare command to its absolute path on Windows, trying PATHEXT", () => {

        expect(resolveExecutable("npx", dir, true, pathExt)).toBe(path.join(dir, "npx.cmd"));
    });

    it("resolves a bare command with its own extension already stated", () => {

        expect(resolveExecutable("real-tool.exe", dir, true, pathExt)).toBe(path.join(dir, "real-tool.exe"));
    });

    it("resolves a bare command with no extension needed off Windows", () => {

        expect(resolveExecutable("myscript.sh", dir, false)).toBe(path.join(dir, "myscript.sh"));
    });

    it("leaves a command that already looks like a path untouched", () => {

        expect(resolveExecutable("C:/tools/npx", dir, true, pathExt)).toBe("C:/tools/npx");
        expect(resolveExecutable("./relative/npx", dir, true, pathExt)).toBe("./relative/npx");
    });

    it("leaves a command unresolved when nothing on the path matches", () => {

        expect(resolveExecutable("does-not-exist", dir, true, pathExt)).toBe("does-not-exist");
    });

    it("wraps a resolved .cmd in cmd /c, absolute path and all", () => {

        expect(resolveMcpServerCommand("npx", ["-y", "@azure-devops/mcp"], dir, true, pathExt))
            .toEqual({ command: "cmd", args: ["/c", path.join(dir, "npx.cmd"), "-y", "@azure-devops/mcp"] });
    });

    it("does not wrap a resolved real executable", () => {

        expect(resolveMcpServerCommand("real-tool", ["--flag"], dir, true, pathExt))
            .toEqual({ command: path.join(dir, "real-tool.exe"), args: ["--flag"] });
    });

    it("does nothing off Windows beyond resolving the path", () => {

        expect(resolveMcpServerCommand("myscript.sh", [], dir, false))
            .toEqual({ command: path.join(dir, "myscript.sh"), args: [] });
    });

    it("leaves an unresolvable command as the bare name it already was", () => {

        expect(resolveMcpServerCommand("does-not-exist", ["-x"], dir, true))
            .toEqual({ command: "does-not-exist", args: ["-x"] });
    });
});

import { describe, expect, it, vi } from "vitest";
import { EngineSettings } from "../../../core/settings/engineSettings";
import { mcpConverse } from "../../../core/agent/mcpClient";
import { McpPluginDeps, createExecute } from "../index";
import { PluginContext } from "../../../core/plugins/Plugin";
import { PluginManifest, pluginFromManifest } from "../../../core/plugins/PluginManifest";
import manifest from "../plugin.json";

/**
 * `mcp@1` against a stubbed conversation - what reaches the wire is the
 * contract here: which declaration, which tool, which arguments, and
 * what the server's answer becomes as artifacts. The transport itself
 * is `mcpClient`'s, tested against real spawned servers over there.
 */

function context(overrides: Partial<PluginContext> = {}) {

    const logged: string[] = [];

    const ctx: PluginContext = {
        runId: "run-1",
        taskId: "s#0",
        attempt: 1,
        cwd: "C:/work",
        root: "C:/work",
        env: {},
        secret: () => undefined,
        log: text => logged.push(text),
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined,
        ...overrides
    };

    return { ctx, text: () => logged.join("\n") };
}

/** Settings carrying exactly the servers a test cares about. */
function settings(servers: Record<string, unknown>, env: { allowed?: string[]; denied?: string[] } = {}) {

    return async () => ({
        sdd: {},
        ai: {
            mcpServers: Object.fromEntries(
                Object.entries(servers).map(([name, server]) => [name, { server, source: "settings.json" }])),
            acpAgents: {}
        },
        env: { allowed: env.allowed ?? [], denied: env.denied ?? [] },
        ignore: [],
        debug: false
    }) as unknown as EngineSettings;
}

/**
 * `node.exe`, not `node`, so these assertions hold on either platform:
 * a command carrying an extension is already runnable and
 * `normalizeMcpServers` leaves it alone. That normalization is real and
 * load-bearing - it has its own test below.
 */
const ado = { command: "node.exe", args: ["server.js"] };

/**
 * A `tools/call` answer, in the shape the protocol actually returns one.
 *
 * Typed as the real `mcpConverse` so the recorded calls keep their
 * argument types - an untyped `vi.fn` records them as an empty tuple,
 * and every assertion about what reached the wire stops being checked.
 */
function answered(result: Record<string, unknown>) {

    return vi.fn<typeof mcpConverse>(async () => ({ serverName: "ado", version: "1.0", result }));
}

function plugin(deps: Partial<McpPluginDeps>) {

    return createExecute({ workspaceFolder: () => "C:/work", ...deps } as McpPluginDeps);
}

describe("mcp@1", () => {

    it("is a valid manifest", () => {

        expect(() => pluginFromManifest(manifest as PluginManifest, (async () => ({ success: true })), "mcpV1"))
            .not.toThrow();
    });

    it("calls the named tool on the named server, with the arguments as written", async () => {

        const converse = answered({ content: [{ type: "text", text: "AB#4821 updated" }] });

        const execute = plugin({ settings: settings({ ado }), converse });

        const result = await execute(
            { server: "ado", tool: "wit_update_work_item", arguments: { id: 4821, state: "Active" } },
            context().ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts).toEqual({ text: "AB#4821 updated", structured: null, isError: false });

        const [declaration, request] = converse.mock.calls[0];

        expect(declaration).toMatchObject({ command: "node.exe", args: ["server.js"] });
        expect(request).toEqual({
            method: "tools/call",
            params: { name: "wit_update_work_item", arguments: { id: 4821, state: "Active" } }
        });
    });

    it("joins every text block, and keeps a structured answer as it came", async () => {

        const converse = answered({
            content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }],
            structuredContent: { id: 4821, state: "Active" }
        });

        const execute = plugin({ settings: settings({ ado }), converse });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, context().ctx);

        expect(result.artifacts).toEqual({
            text: "line one\nline two",
            structured: { id: 4821, state: "Active" },
            isError: false
        });
    });

    it("drops non-text blocks and says so, rather than pretending the answer was whole", async () => {

        const converse = answered({
            content: [{ type: "text", text: "here it is" }, { type: "image", data: "AAAA" }]
        });

        const execute = plugin({ settings: settings({ ado }), converse });

        const { ctx, text } = context();

        const result = await execute({ server: "ado", tool: "screenshot" }, ctx);

        expect((result.artifacts as { text: string }).text).toBe("here it is");
        expect(text()).toContain("1 non-text content block(s) were not stored");
    });

    it("fails on a tool error, and still stores what came back", async () => {

        const converse = answered({
            content: [{ type: "text", text: "TF401232: work item 4821 does not exist" }],
            isError: true
        });

        const execute = plugin({ settings: settings({ ado }), converse });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("TF401232");
        expect(result.artifacts).toMatchObject({ isError: true });
    });

    it("carries on when the caller says a tool error is data", async () => {

        const converse = answered({ content: [{ type: "text", text: "not found" }], isError: true });

        const execute = plugin({ settings: settings({ ado }), converse });

        const result = await execute(
            { server: "ado", tool: "wit_get_work_item", failOnToolError: false },
            context().ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts).toMatchObject({ isError: true, text: "not found" });
    });

    it("names what settings.json does declare when the server is not one of them", async () => {

        const converse = answered({ content: [] });

        const execute = plugin({ settings: settings({ ado }), converse });

        const result = await execute({ server: "jira", tool: "search" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("declares no MCP server by that name");
        expect(result.message).toContain("ado");
        expect(converse).not.toHaveBeenCalled();
    });

    it("refuses a disabled server as a decision, not a missing one", async () => {

        const converse = answered({ content: [] });

        const execute = plugin({ settings: settings({ ado: { ...ado, disabled: true } }), converse });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("disabled in settings.json");
        expect(converse).not.toHaveBeenCalled();
    });

    it("expands an env reference in the declaration from the task's own env", async () => {

        const converse = answered({ content: [{ type: "text", text: "ok" }] });

        const execute = plugin({
            settings: settings({ ado: { ...ado, env: { TOKEN: "${{ env.ADO_PAT }}" } } }),
            converse
        });

        const { ctx } = context({ env: { ADO_PAT: "secret-value" } });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, ctx);

        expect(result.success).toBe(true);
        expect(converse.mock.calls[0][0]).toMatchObject({ env: { TOKEN: "secret-value" } });
    });

    it("refuses an env reference the gate does not grant", async () => {

        const converse = answered({ content: [] });

        const execute = plugin({
            settings: settings(
                { ado: { ...ado, env: { TOKEN: "${{ env.ADO_PAT }}" } } },
                { denied: ["ADO_PAT"] }),
            converse
        });

        const { ctx } = context({ env: { ADO_PAT: "secret-value" } });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, ctx);

        expect(result.success).toBe(false);
        expect(converse).not.toHaveBeenCalled();
    });

    it("reports a server that could not be reached, naming the tool and the server", async () => {

        const converse = vi.fn<typeof mcpConverse>(
            async () => { throw new Error("Could not start 'node': ENOENT"); });

        const execute = plugin({ settings: settings({ ado }), converse });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("'wit_get_work_item' on 'ado'");
        expect(result.message).toContain("ENOENT");
    });

    /**
     * A bare `npx` is not a program `CreateProcess` can find, so without
     * normalization the server never starts and the task blames the tool.
     */
    it("makes a bare command runnable on this machine", async () => {

        const converse = answered({ content: [{ type: "text", text: "ok" }] });

        const execute = plugin({
            settings: settings({ ado: { command: "npx", args: ["-y", "@azure-devops/mcp", "contoso"] } }),
            converse
        });

        const result = await execute({ server: "ado", tool: "wit_get_work_item" }, context().ctx);

        expect(result.success).toBe(true);

        const declaration = converse.mock.calls[0][0] as { command: string; args: string[] };

        if (process.platform === "win32")
            expect([declaration.command, ...declaration.args]).toEqual(
                ["cmd", "/c", "npx", "-y", "@azure-devops/mcp", "contoso"]);
        else
            expect([declaration.command, ...declaration.args]).toEqual(
                ["npx", "-y", "@azure-devops/mcp", "contoso"]);
    });

    it("rejects args that cannot work before it starts anything", async () => {

        const converse = answered({ content: [] });

        const execute = plugin({ settings: settings({ ado }), converse });

        const bad = await execute(
            { server: "ado", tool: "x", arguments: ["not", "a", "map"] as never },
            context().ctx);

        expect(bad.success).toBe(false);
        expect(bad.message).toContain("'arguments' must be a map");
        expect(converse).not.toHaveBeenCalled();
    });
});

import { describe, expect, it } from "vitest";

import { CLAUDE_AI_CONNECTORS } from "../../shared/chatMessages";
import { toolsetChoice, toolsetFrom, toolsetKey, withToolset } from "../chatToolset";

const AUTO = { autoTools: true, enabledToolIds: [], autoMcpServers: true, enabledMcpServerIds: [] };

describe("toolsetFrom", () => {

    it("keeps nothing picked on Auto, and the claude.ai connectors off", () => {

        expect(toolsetFrom({}, "claude", AUTO)).toEqual({ claudeAiConnectors: false });
    });

    it("keeps servers and tools picked by hand, the connectors apart from the servers", () => {

        const next = toolsetFrom({}, "claude", {
            autoTools: false, enabledToolIds: ["Read", "Edit"],
            autoMcpServers: false, enabledMcpServerIds: ["ado", CLAUDE_AI_CONNECTORS]
        });

        expect(next).toEqual({ mcpServers: ["ado"], claudeAiConnectors: true, tools: { claude: ["Read", "Edit"] } });
    });

    it("keeps each runtime's tools apart, and ignores tools for a runtime that takes none", () => {

        const claude = toolsetFrom({}, "claude", { ...AUTO, autoTools: false, enabledToolIds: ["Read"] });
        const both = toolsetFrom(claude, "ghcp", { ...AUTO, autoTools: false, enabledToolIds: ["view"] });

        expect(both.tools).toEqual({ claude: ["Read"], ghcp: ["view"] });
        expect(toolsetFrom(both, "kiro-cli", { ...AUTO, autoTools: false, enabledToolIds: ["x"] }).tools)
            .toEqual({ claude: ["Read"], ghcp: ["view"] });
    });
});

describe("withToolset", () => {

    it("narrows the MCP servers and keeps the settings' per-server tool list", () => {

        expect(withToolset({ mcp: { tools: { ado: ["wit_get"] } } }, "kiro-cli", { mcpServers: ["ado"] }))
            .toEqual({ mcp: { tools: { ado: ["wit_get"] }, servers: ["ado"] } });
    });

    it("gives Claude its tool list and the connectors switch, off unless turned on", () => {

        expect(withToolset({ model: "opus" }, "claude", { tools: { claude: ["Read"] } }))
            .toEqual({ model: "opus", claudeAiConnectors: false, tools: ["Read"] });
    });

    it("gives Copilot an allow-list that keeps its own and the MCP tools", () => {

        expect(withToolset({}, "ghcp", { tools: { ghcp: ["view", "bash"] } }))
            .toEqual({ availableTools: ["builtin:view", "builtin:bash", "custom:*", "mcp:*"] });
    });

    it("changes nothing for Auto on a runtime with no switches", () => {

        expect(withToolset({ model: "x" }, "kiro-cli", {})).toEqual({ model: "x" });
    });
});

describe("toolsetChoice", () => {

    it("offers the connectors entry on Claude only, and shows a pick still on offer", () => {

        const choice = toolsetChoice(
            { mcpServers: ["ado", "gone"], claudeAiConnectors: true, tools: { claude: ["Read", "Gone"] } },
            "claude", [{ id: "Read" }, { id: "Edit" }], [{ id: "ado" }]);

        expect(choice.servers.map(one => one.id)).toEqual(["ado", CLAUDE_AI_CONNECTORS]);
        expect(choice.enabledServers).toEqual(["ado", CLAUDE_AI_CONNECTORS]);
        expect(choice.autoTools).toBe(false);
        expect(choice.enabledTools).toEqual(["Read"]);

        expect(toolsetChoice({}, "kiro-cli", [{ id: "Read" }], [{ id: "ado" }]))
            .toMatchObject({ tools: [], servers: [{ id: "ado" }], autoTools: true, autoServers: true });
    });
});

describe("toolsetKey", () => {

    it("changes with what the runtime is started with, and only that", () => {

        const base = toolsetKey("ghcp", { tools: { claude: ["Read"] } });

        expect(toolsetKey("ghcp", { tools: { claude: ["Edit"] } })).toBe(base);
        expect(toolsetKey("ghcp", { tools: { ghcp: ["view"] } })).not.toBe(base);
        expect(toolsetKey("ghcp", { mcpServers: [] })).not.toBe(base);
    });
});

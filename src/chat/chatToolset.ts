import { CLAUDE_AI_CONNECTORS } from "../shared/chatMessages";
import type { ChatToolset, SentToolSelection, ToolsetChoice } from "../shared/chatMessages";

/*
 * The chat's Tools and MCP servers pickers, as rules with no
 * page code in them.
 *
 * What a runtime can be told, and how:
 *
 * - settings.json's MCP servers: ai@1's own `mcp: { servers }`, on every
 *   runtime.
 * - Built-in tools: Claude's `tools` (the whole built-in set, named) and
 *   Copilot's `availableTools` (an allow-list across sources). An ACP
 *   agent such as Kiro has no such switch, so it gets no Tools picker.
 * - The claude.ai account's connectors: Claude only, one switch for all.
 *
 * All of these are fixed when a session starts, so a change reopens the
 * conversation on the next message - see {@link toolsetKey}.
 */

/** The runtimes whose built-in tools can be switched off. */
const TOOL_RUNTIMES = new Set(["claude", "ghcp"]);

/** Whether a runtime takes a built-in tool list at all. */
export function takesTools(runtime: string): boolean {

    return TOOL_RUNTIMES.has(runtime);
}

/**
 * The chat's pick after a Send, from what the pickers said.
 *
 * Auto on the MCP picker is every settings.json server and no claude.ai
 * connectors: those are only on when ticked by hand. Tools are kept per
 * runtime, since Claude's and Copilot's tools have different names.
 */
export function toolsetFrom(prior: ChatToolset, runtime: string, sent: SentToolSelection): ChatToolset {

    const next: ChatToolset = { ...prior, tools: { ...prior.tools } };

    if (sent.autoMcpServers) {

        delete next.mcpServers;
        next.claudeAiConnectors = false;

    } else {

        next.mcpServers = sent.enabledMcpServerIds.filter(id => id !== CLAUDE_AI_CONNECTORS);
        next.claudeAiConnectors = sent.enabledMcpServerIds.includes(CLAUDE_AI_CONNECTORS);
    }

    if (takesTools(runtime)) {

        if (sent.autoTools)
            delete next.tools![runtime];
        else
            next.tools![runtime] = [...sent.enabledToolIds];
    }

    if (!Object.keys(next.tools!).length)
        delete next.tools;

    return next;
}

/**
 * What the pickers show: the lists on offer, and this chat's pick in the
 * library's terms. A picked name no longer on offer is dropped from the
 * shown pick - a server taken out of settings.json, say.
 */
export function toolsetChoice(
    toolset: ChatToolset,
    runtime: string,
    tools: readonly { id: string; description?: string }[],
    servers: readonly { id: string; description?: string }[]
): ToolsetChoice {

    const offered = takesTools(runtime) ? [...tools] : [];

    const allServers = runtime === "claude"
        ? [...servers, {
            id: CLAUDE_AI_CONNECTORS,
            description: "Gmail, Drive and the other connectors of the claude.ai account Claude is signed in with. Off unless ticked here - Auto leaves them off."
        }]
        : [...servers];

    const picked = toolset.tools?.[runtime];

    return {
        tools: offered,
        servers: allServers,
        autoTools: picked === undefined || !offered.length,
        enabledTools: (picked ?? []).filter(id => offered.some(tool => tool.id === id)),
        autoServers: toolset.mcpServers === undefined,
        enabledServers: [
            ...(toolset.mcpServers ?? []).filter(id => servers.some(server => server.id === id)),
            ...(runtime === "claude" && toolset.claudeAiConnectors ? [CLAUDE_AI_CONNECTORS] : [])
        ]
    };
}

/**
 * The runtime's args with the chat's pick applied - the settings the
 * pick changes, and nothing else.
 */
export function withToolset(args: Record<string, unknown>, runtime: string, toolset: ChatToolset): Record<string, unknown> {

    const next: Record<string, unknown> = { ...args };

    if (toolset.mcpServers !== undefined) {

        // A tools allow-list the settings already give per server stays.
        const current = args.mcp && typeof args.mcp === "object" ? args.mcp as Record<string, unknown> : {};

        next.mcp = { ...current, servers: [...toolset.mcpServers] };
    }

    const picked = toolset.tools?.[runtime];

    if (runtime === "claude") {

        next.claudeAiConnectors = toolset.claudeAiConnectors === true;

        if (picked)
            next.tools = [...picked];
    }

    // Copilot's allow-list covers every source, so this chat's own tools
    // (asking a question, the time) and the MCP servers picked above stay
    // on; only the built-ins are narrowed.
    if (runtime === "ghcp" && picked)
        next.availableTools = [...picked.map(name => `builtin:${name}`), "custom:*", "mcp:*"];

    return next;
}

/**
 * The part of the pick a runtime is started with, as one string. A
 * different key from the one the conversation was opened with means the
 * next message reopens it, the same as a model change does.
 */
export function toolsetKey(runtime: string, toolset: ChatToolset): string {

    return JSON.stringify({
        mcp: toolset.mcpServers ?? null,
        tools: toolset.tools?.[runtime] ?? null,
        connectors: runtime === "claude" ? toolset.claudeAiConnectors === true : null
    });
}

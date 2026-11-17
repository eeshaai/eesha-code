import type { GateCall } from "./gate";
import { ASK_SERVER_NAME, ASK_TOOL_NAME } from "../providers/askTool";
import { claudeWrites, copilotRequestPaths, copilotRequestWrites, copilotWrites, pathsIn } from "../providers/pathJail";
import { CHECK_PLAN_TOOL_NAME, TASK_DONE_TOOL_NAME } from "../providers/planTools";
import { STEERING_TOOL_NAME } from "../providers/steeringTool";
import { TIME_NOW_TOOL_NAME, UTC_NOW_TOOL_NAME } from "../providers/timeTools";

/*
 * Each provider's own tool call or permission request, as the one shape
 * our permission check reads - see `gate.ts`. Matching is then on the
 * command, the file or the tool, never on the runtime's tool name: an
 * answer Claude got holds when Copilot asks the same thing.
 */

/**
 * Eesha Code's connector tools.
 * They make their own checks: a tool the person did not allow is never
 * listed and is refused, and every write asks the person first, at every
 * level. So the permission check lets them run, like our own tools.
 */
export const CONNECTORS_SERVER = "eesha-connectors";

/** Our own tools, on every runtime: always run. */
const OWN_TOOLS = new Set([
    ASK_TOOL_NAME, TASK_DONE_TOOL_NAME, CHECK_PLAN_TOOL_NAME, STEERING_TOOL_NAME, TIME_NOW_TOOL_NAME, UTC_NOW_TOOL_NAME
]);

/**
 * Claude's own housekeeping: its to-do list and tasks, helper agents,
 * plan mode, tool search, skills, and reading or stopping a shell it
 * already started. The helper agent's own calls still come through the
 * check one by one.
 */
const CLAUDE_HOUSEKEEPING = new Set([
    "TodoWrite", "Task", "Agent", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskOutput", "TaskStop",
    "ExitPlanMode", "EnterPlanMode", "ToolSearch", "Skill", "BashOutput", "KillShell", "KillBash",
    "ListMcpResourcesTool", "ReadMcpResourceTool", "AskUserQuestion"
]);

const CLAUDE_COMMANDS = new Set(["Bash", "PowerShell"]);

const CLAUDE_READS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

const CLAUDE_EDITS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

/** One Claude SDK tool call. */
export function claudeCall(tool: string, input: unknown): GateCall {

    const args = (input ?? {}) as Record<string, unknown>;

    const paths = pathsIn(input);

    if (tool.startsWith(`mcp__${ASK_SERVER_NAME}__`) || tool.startsWith(`mcp__${CONNECTORS_SERVER}__`))
        return { tool, what: "housekeeping" };

    if (tool.startsWith("mcp__")) {

        const rest = tool.slice("mcp__".length);
        const split = rest.indexOf("__");

        return split > 0
            ? { tool, what: "mcp", server: rest.slice(0, split), mcpTool: rest.slice(split + 2), name: tool, paths, writes: true }
            : { tool, what: "tool", name: tool, paths, writes: true };
    }

    if (CLAUDE_HOUSEKEEPING.has(tool))
        return { tool, what: "housekeeping" };

    if (CLAUDE_COMMANDS.has(tool))
        return { tool, what: "command", command: text(args.command) ?? "", paths, writes: true };

    if (CLAUDE_READS.has(tool))
        return { tool, what: "read", paths, writes: false };

    if (CLAUDE_EDITS.has(tool))
        return { tool, what: "edit", paths, writes: true };

    if (tool === "WebFetch")
        return { tool, what: "web", url: text(args.url) ?? "", writes: false };

    if (tool === "WebSearch")
        return { tool, what: "web", search: text(args.query) ?? "", writes: false };

    return { tool, what: "tool", name: tool, paths, writes: claudeWrites(tool) };
}

/** Copilot's shells - the tool that runs a command. */
const COPILOT_SHELLS = new Set(["powershell", "bash", "shell"]);

/** Copilot tools that type into, read or stop a shell it already started. Typing in runs a command. */
const COPILOT_SHELL_INPUT = new Set(["write_bash", "write_powershell"]);

const COPILOT_SHELL_HOUSEKEEPING = new Set([
    "read_bash", "stop_bash", "list_bash", "read_powershell", "stop_powershell", "list_powershell"
]);

const COPILOT_EDITS = new Set(["create", "edit", "str_replace", "str_replace_editor", "apply_patch", "write"]);

const COPILOT_HOUSEKEEPING = new Set([
    "update_todo", "report_intent", "task", "read_agent", "list_agents", "fetch_copilot_cli_documentation", "skill"
]);

/**
 * One Copilot tool call, as its pre-tool hook is handed it: a name and
 * the tool's own arguments. The hook only uses this to refuse what is
 * never allowed and to force a permission request where a card is due;
 * the request itself ({@link copilotRequestCall}) is what is asked.
 */
export function copilotToolCall(tool: string, toolArgs: unknown): GateCall {

    const args = (toolArgs ?? {}) as Record<string, unknown>;

    const paths = pathsIn(toolArgs);

    const name = tool.toLowerCase();

    if (OWN_TOOLS.has(name) || COPILOT_HOUSEKEEPING.has(name) || COPILOT_SHELL_HOUSEKEEPING.has(name))
        return { tool, what: "housekeeping" };

    if (COPILOT_SHELLS.has(name))
        return { tool, what: "command", command: text(args.command) ?? "", paths, writes: true };

    if (COPILOT_SHELL_INPUT.has(name))
        return { tool, what: "command", command: text(args.input) ?? text(args.command) ?? "", paths, writes: true };

    if (COPILOT_EDITS.has(name))
        return { tool, what: "edit", paths, writes: true };

    if (name === "web_fetch" || name === "fetch")
        return { tool, what: "web", url: text(args.url) ?? "", writes: false };

    if (name === "web_search")
        return { tool, what: "web", search: text(args.query) ?? "", writes: false };

    if (!copilotWrites(name))
        return { tool, what: "read", paths, writes: false };

    return { tool, what: "tool", name: tool, paths, writes: true };
}

/** One Copilot permission request - `kind` says outright what it is. */
export function copilotRequestCall(request: unknown): GateCall {

    const asked = (request ?? {}) as Record<string, unknown>;

    const kind = typeof asked.kind === "string" ? asked.kind : "";

    const extra = copilotRequestPaths(request);

    switch (kind) {

        case "shell":
            return {
                tool: "shell",
                what: "command",
                command: text(asked.fullCommandText) ?? "",
                paths: [...pathsIn(request), ...extra],
                writes: copilotRequestWrites(request),
                ...(asked.requestSandboxBypass === true ? { onceOnly: true } : {})
            };

        case "write":
            return { tool: "write", what: "edit", paths: [text(asked.fileName) ?? "", ...extra].filter(Boolean), writes: true };

        case "read": {

            const one = text(asked.path);

            return { tool: "read", what: "read", paths: extra.length ? extra : one ? [one] : [], writes: false };
        }

        case "mcp": {

            const server = text(asked.serverName);
            const tool = text(asked.toolName);

            if (server === CONNECTORS_SERVER)
                return { tool: tool ?? "mcp", what: "housekeeping" };

            return {
                tool: "mcp",
                what: "mcp",
                ...(server ? { server } : {}),
                ...(tool ? { mcpTool: tool } : {}),
                paths: pathsIn(asked.args),
                writes: true
            };
        }

        case "url":
            return { tool: "url", what: "web", url: text(asked.url) ?? "", writes: false };

        case "memory":
            return { tool: "memory", what: "tool", name: "memory", writes: true };

        case "custom-tool": {

            const tool = text(asked.toolName) ?? "";

            return OWN_TOOLS.has(tool)
                ? { tool, what: "housekeeping" }
                : { tool: tool || "custom-tool", what: tool ? "tool" : "unknown", ...(tool ? { name: tool } : {}), paths: pathsIn(asked.args), writes: true };
        }

        case "hook": {

            const tool = text(asked.toolName) ?? "";

            return tool
                ? copilotToolCall(tool, asked.toolArgs)
                : { tool: "hook", what: "unknown" };
        }

        default:
            return { tool: kind || "request", what: "unknown" };
    }
}

/** An ACP request's tool call - see `acpApproval.ts`. */
interface AcpToolCallShape {

    title?: string;

    kind?: string | null;

    locations?: { path: string }[] | null;

    rawInput?: unknown;
}

/**
 * One ACP `session/request_permission`. The agent's own `kind` is kept:
 * Semi Auto asks by it.
 */
export function acpCall(toolCall: AcpToolCallShape | undefined): GateCall {

    const kind = toolCall?.kind ?? "";
    const title = toolCall?.title?.trim() ?? "";
    const input = toolCall?.rawInput;
    const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;

    const located = (toolCall?.locations ?? [])
        .map(location => location?.path)
        .filter((one): one is string => typeof one === "string" && one.length > 0);

    const paths = [...new Set([...located, ...pathsIn(input)])];

    const base = { tool: title || kind || "tool", acpKind: kind };

    switch (kind) {

        case "execute": {

            const command = text(args.command)
                ?? (Array.isArray(args.command) ? args.command.filter(one => typeof one === "string").join(" ") : undefined)
                ?? (typeof input === "string" ? input : undefined)
                ?? title.replace(/^`+|`+$/g, "");

            return { ...base, what: "command", command, paths, writes: true };
        }

        case "edit":
        case "delete":
        case "move":
            return { ...base, what: "edit", paths, writes: true, ...(title ? { name: title } : {}) };

        case "read":
        case "search":
            return paths.length
                ? { ...base, what: "read", paths, writes: false }
                : { ...base, what: title ? "tool" : "unknown", ...(title ? { name: title } : {}), writes: false };

        case "fetch": {

            const url = text(args.url);

            return url
                ? { ...base, what: "web", url, writes: false }
                : { ...base, what: "web", search: text(args.query) ?? title, writes: false };
        }

        default: {

            const mcp = /^mcp__(.+?)__(.+)$/.exec(title);

            if (mcp?.[1] === CONNECTORS_SERVER)
                return { ...base, what: "housekeeping" };

            if (mcp)
                return { ...base, what: "mcp", server: mcp[1], mcpTool: mcp[2], name: title, paths, writes: true };

            // No kind and nothing to go on: can only be allowed once.
            if (!kind && !title && input === undefined && !paths.length)
                return { ...base, what: "unknown" };

            return title
                ? { ...base, what: "tool", name: title, paths, writes: true }
                : { ...base, what: "unknown", paths, writes: true };
        }
    }
}

function text(value: unknown): string | undefined {

    return typeof value === "string" && value.trim() ? value : undefined;
}

import type { AskPermission } from "../../models/run";

/*
 * What an ACP `session/request_permission` carries - the agent's options
 * and the tool call it asks about - and how the call reads to a person.
 */

/** One option the agent offered, as ACP sends it. */
export interface AcpPermissionOption {

    optionId: string;

    kind: string;

    name?: string;
}

/** The part of the request the card describes - ACP's `ToolCallUpdate`. */
export interface AcpPermissionToolCall {

    /** The call this asks about - the same id its `tool_call` update carried. */
    toolCallId?: string;

    title?: string;

    kind?: string | null;

    locations?: { path: string }[] | null;

    rawInput?: unknown;

    /** The vendor's own data - Claude over ACP puts the tool's name in `claudeCode.toolName`. */
    _meta?: unknown;
}

/** What goes back on the request: one of the agent's options, or nothing picked. */
export type AcpApprovalOutcome =
    | { outcome: { outcome: "selected"; optionId: string } }
    | { outcome: { outcome: "cancelled" } };

/**
 * What the request asks to run, for the page that draws it as a request:
 * the tool by its title (or its kind), and what it would be given - its
 * raw input, or the paths it names.
 */
export function acpPermission(toolCall: AcpPermissionToolCall | undefined): AskPermission {

    const tool = toolCall?.title?.trim() || toolCall?.kind || "a tool";

    let input: string | undefined;

    if (toolCall?.rawInput !== undefined && toolCall.rawInput !== null) {

        try {

            input = typeof toolCall.rawInput === "string" ? toolCall.rawInput : JSON.stringify(toolCall.rawInput, null, 2);

        } catch {

            input = undefined;
        }
    }

    if (input === undefined) {

        const paths = (toolCall?.locations ?? []).map(location => location.path).filter(Boolean);

        if (paths.length)
            input = paths.join("\n");
    }

    return { tool, ...(input !== undefined ? { input } : {}) };
}

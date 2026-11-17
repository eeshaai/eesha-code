import type { PermissionRequest } from "@github/copilot-sdk";
import type { AskPermission } from "../../models/run";

/**
 * What the request asks to run, for the page that draws it as a request:
 * the tool, and what it would be given - the command, the file, the
 * address, or an MCP tool's arguments.
 */
export function approvalPermission(request: PermissionRequest): AskPermission {

    const fields = request as unknown as Record<string, unknown>;

    const input = fields.fullCommandText ?? fields.fileName ?? fields.path ?? fields.url
        ?? (fields.args !== undefined ? JSON.stringify(fields.args, null, 2) : undefined);

    const tool = request.kind === "mcp" ? String(fields.toolTitle || fields.toolName || "mcp") : request.kind;

    return { tool, ...(typeof input === "string" ? { input } : {}) };
}

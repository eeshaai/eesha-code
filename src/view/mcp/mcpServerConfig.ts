import type { McpServerFormValues } from "../ui";

/*
 * The mcp.json entry for what the Add MCP server window holds. The window
 * hands over the values as typed; this trims them, splits the arguments
 * and leaves out empty environment rows.
 */

/** The shape of one server entry in an mcp.json file. */
export interface McpServerConfig {

    name: string;

    type: "stdio" | "http";

    command?: string;

    args?: string[];

    env?: Record<string, string>;

    url?: string;
}

/** The server entry for the typed values. A stdio server has a command and arguments, an http server a url. `env` is left out when no variable has a name. */
export function mcpServerConfig(values: McpServerFormValues): McpServerConfig {

    const env: Record<string, string> = {};

    for (const row of values.envRows)
        if (row.key.trim().length > 0)
            env[row.key.trim()] = row.value;

    const common = { name: values.name.trim(), type: values.type, env: Object.keys(env).length ? env : undefined };

    return values.type === "stdio"
        ? { ...common, command: values.command.trim(), args: values.argsText.split("\n").map(arg => arg.trim()).filter(Boolean) }
        : { ...common, url: values.url.trim() };
}

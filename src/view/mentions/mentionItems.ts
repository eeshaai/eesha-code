import type { FileMentionOption, McpServerOption, MentionMenuItem, PathMentionOption, PromptCommandOption, ToolOption } from "../ui";

/** Most rows the "/" command list and the "#" list show. */
const MOST_ROWS = 20;

/** Most rows one ">" path level shows (the refresh row is extra). */
const MOST_PATH_ROWS = 50;

/**
 * The rows of the "/" menu for the commands: names that start with the
 * text typed come first, then the names that only contain it, each in the
 * order given.
 */
export function commandItems(commands: readonly PromptCommandOption[], query: string): MentionMenuItem[] {

    const typed = query.toLowerCase();

    return commands
        .filter(one => one.name.toLowerCase().includes(typed))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(typed)) - Number(!b.name.toLowerCase().startsWith(typed)))
        .slice(0, MOST_ROWS)
        .map(one => ({ kind: "command" as const, key: one.name, label: one.name, description: one.description, hint: one.hint }));
}

/** The rows of the "#" menu: MCP servers first, then tools, those whose name contains the text typed. */
export function toolItems(tools: readonly ToolOption[], mcpServers: readonly McpServerOption[], query: string): MentionMenuItem[] {

    const typed = query.toLowerCase();

    const rows: MentionMenuItem[] = [
        ...mcpServers.map(one => ({ kind: "mcp" as const, key: one.id, label: one.name, status: one.status })),
        ...tools.map(one => ({ kind: "tool" as const, key: one.id, label: one.name, icon: one.icon }))
    ];

    return rows
        .filter(one => one.label.toLowerCase().includes(typed))
        .slice(0, MOST_ROWS);
}

/** The file rows found for a search: the first few, as the box shows them. */
export function fileItems(found: readonly FileMentionOption[]): FileMentionOption[] {

    return found.slice(0, MOST_ROWS);
}

/**
 * The rows of one ">" path level: the first few real rows, then the
 * refresh row last, so the best match stays first.
 */
export function pathItems(found: readonly PathMentionOption[]): PathMentionOption[] {

    const rows = found.filter(one => !one.refresh).slice(0, MOST_PATH_ROWS);
    const refresh = found.find(one => one.refresh);

    return refresh ? [...rows, refresh] : rows;
}

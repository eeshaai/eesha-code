import * as fs from "fs";
import * as path from "path";

import { profileDirectory } from "../../loader/profilePaths";

/*
 * Claude's built-in tool names, as the runtime last listed them.
 *
 * The Claude runtime names its tools only on the `init` message of a
 * running session - there is no call that lists them without starting
 * one. So every session started with the full set writes the list here,
 * and the page offering a tool picker reads it. Before the first such
 * session there is no list, and the picker offers none.
 */

/** MCP tools come and go with the servers; only the runtime's own are kept. */
export function builtInTools(tools: readonly unknown[]): string[] {

    return tools
        .filter((name): name is string => typeof name === "string" && name.length > 0 && !name.startsWith("mcp__"))
        .sort((left, right) => left.localeCompare(right));
}

function file(): string {

    return path.join(profileDirectory(), "state", "claude-tools.json");
}

/** Never throws: a list that cannot be written is only a picker that stays empty. */
export function writeClaudeTools(tools: readonly string[]): void {

    try {

        fs.mkdirSync(path.dirname(file()), { recursive: true });
        fs.writeFileSync(file(), JSON.stringify({ tools, at: Date.now() }), "utf8");

    } catch {

        // See above.
    }
}

/** The last list written, or nothing before the first full session. */
export function readClaudeTools(): string[] | undefined {

    try {

        const parsed = JSON.parse(fs.readFileSync(file(), "utf8")) as { tools?: unknown };

        return Array.isArray(parsed.tools) ? builtInTools(parsed.tools) : undefined;

    } catch {

        return undefined;
    }
}

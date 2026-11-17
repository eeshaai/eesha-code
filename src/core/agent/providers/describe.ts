/**
 * Turning a vendor's free-form payloads into something a log line can
 * carry. Shared by both providers so the same tool call logs the same
 * way whichever one ran it.
 *
 * Nothing here imports a vendor SDK: `ClaudeProvider` cannot reach into
 * `CopilotProvider` for helpers without pulling the Copilot CLI and its
 * native addon into every Claude session.
 */

/** How much of one value, and of one whole line, a log will take. */
export const VALUE_LIMIT = 200;

export const LINE_LIMIT = 800;

/** A vendor field that should be a string, as one. Never `undefined`. */
export function asText(value: unknown): string {

    return typeof value === "string" ? value : "";
}

/**
 * One value, fit for a log line: whitespace collapsed, length capped.
 * A tool argument can be an entire heredoc; the original is in the
 * event's `raw`.
 */
export function clip(value: string, limit: number): string {

    const flat = value.replace(/\s+/g, " ").trim();

    return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

/**
 * The argument an MCP server adds to say *why* a call is being made,
 * rather than what it is being given.
 *
 * GitHub Copilot's MCP client sends this on every call it makes to a
 * server; other clients may not. It is a sentence written for a reader,
 * so a collapsed tool row shows it as the title and drops it from the
 * argument list, where it would read as a declared parameter.
 */
export const PURPOSE_KEY = "__tool_use_purpose";

/** The purpose a call carried, if it carried one. */
export function toolPurpose(args: unknown): string | undefined {

    if (!args || typeof args !== "object" || Array.isArray(args))
        return undefined;

    const value = (args as Record<string, unknown>)[PURPOSE_KEY];

    return typeof value === "string" && value.trim() ? clip(value, VALUE_LIMIT) : undefined;
}

/**
 * What a tool row is titled: the call's purpose in place of the tool's
 * own name, kept under the same namespace the name had.
 *
 * `github/issue_search` says which entry point was called; `github/Find
 * the issue about the failing build` says what the agent wanted.
 *
 * The namespace is the caller's `server` when the vendor names one
 * separately, otherwise the one the tool name carries (`server/tool` or
 * `mcp__server__tool`). A name with no namespace keeps its own place,
 * so a built-in tool that carries a purpose still reads as itself.
 */
export function toolTitle(tool: string, args: unknown, server?: string): string {

    const purpose = toolPurpose(args);

    if (!purpose)
        return toolLabel(tool, args) ?? tool;

    return `${server || namespaceOf(tool) || tool}/${purpose}`;
}

/**
 * A plain-words title for the built-in tools of both vendors, built
 * from the one argument that says what the call is about. Copilot's
 * names are lower case, Claude's are capitalised; the match ignores
 * case so one table covers both.
 *
 * | Title                    | Copilot                | Claude                        |
 * |--------------------------|------------------------|-------------------------------|
 * | `Reading app.js`         | view, read             | Read, NotebookRead            |
 * | `Writing app.js`         | create, write          | Write                         |
 * | `Editing app.js`         | edit, str_replace      | Edit, MultiEdit, NotebookEdit |
 * | `Listing src`            | ls                     | LS                            |
 * | `Searching 'pattern'`    | grep, glob, search     | Grep, Glob                    |
 * | `Executing 'command'`    | powershell, bash, shell| PowerShell, Bash              |
 * | `Fetching url`           | fetch, web_fetch       | WebFetch                      |
 * | `Searching web 'query'`  | web_search             | WebSearch                     |
 * | `Running task 'what'`    | task                   | Task                          |
 *
 * A file is shown by its name, not its path - the path is in the
 * arguments beside it. Every other tool keeps its own name, and so
 * does one of these whose argument is missing: undefined here means
 * the caller falls back to the name.
 *
 * `isMutatingTool` reads these titles back by their first word, so a
 * new verb here needs a place there.
 */
export function toolLabel(tool: string, args: unknown): string | undefined {

    const named = args && typeof args === "object" && !Array.isArray(args)
        ? args as Record<string, unknown>
        : undefined;

    // The first of the given keys that holds text. The two vendors
    // agree on most keys, and a tool that has none of them keeps its
    // name rather than getting a label with nothing after the verb.
    const text = (...keys: string[]): string => {

        for (const key of keys) {

            const value = named ? clip(asText(named[key]), VALUE_LIMIT) : "";

            if (value)
                return value;
        }

        return "";
    };

    const file = (verb: string): string | undefined => {

        const path = toolPath(args);

        return path ? `${verb} ${basenameOf(path)}` : undefined;
    };

    const quoted = (verb: string, ...keys: string[]): string | undefined => {

        const value = text(...keys);

        return value ? `${verb} '${value}'` : undefined;
    };

    switch (tool.toLowerCase()) {

        case "view":
        case "read":
        case "notebookread":
            return file("Reading");

        case "create":
        case "write":
            return file("Writing");

        case "edit":
        case "str_replace":
        case "multiedit":
        case "notebookedit":
            return file("Editing");

        case "ls":
            return file("Listing");

        case "grep":
        case "glob":
        case "search":
            return quoted("Searching", "pattern", "query");

        case "powershell":
        case "bash":
        case "shell":
            return quoted("Executing", "command");

        case "fetch":
        case "web_fetch":
        case "webfetch": {

            const url = text("url");

            return url ? `Fetching ${url}` : undefined;
        }

        case "web_search":
        case "websearch":
            return quoted("Searching web", "query");

        case "task":
            return quoted("Running task", "description", "prompt");

        default:
            return undefined;
    }
}

/**
 * The verb a `toolLabel` title opens with, or undefined when the
 * title is a tool's own name (or a purpose sentence).
 *
 * Two readers key on this: the "files changed" list, which judges a
 * titled call by its verb, and the AI Session row, which drops the
 * closed line's argument text when the title already says what the
 * call was given. A new verb in `toolLabel` goes here too.
 */
export function labelVerb(title: string): string | undefined {

    const verb = /^(\w+) /.exec(title)?.[1];

    return verb && LABEL_VERBS.has(verb) ? verb : undefined;
}

const LABEL_VERBS = new Set(["Reading", "Writing", "Editing", "Listing", "Searching", "Executing", "Fetching", "Running"]);

/** The last segment of a path, in either separator. */
function basenameOf(path: string): string {

    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** The server part of a namespaced tool name, in either spelling. Empty when there is none. */
function namespaceOf(tool: string): string {

    if (tool.startsWith("mcp__")) {

        // `mcp__github__search_issues`: prefix, server, tool. Fewer
        // than three parts is not namespaced. Only the server part is
        // wanted, so the row says `github/...` like every other client.
        const parts = tool.split("__");

        return parts.length > 2 ? parts.slice(1, -1).join("__") : "";
    }

    return tool.includes("/") ? tool.slice(0, tool.lastIndexOf("/")) : "";
}

/**
 * A tool call's arguments, as one line. Every argument, in declared
 * order: which argument matters is the tool's business, and whoever
 * reads the log afterwards cannot go back and ask.
 */
export function describeArguments(value: unknown): string | undefined {

    if (typeof value === "string")
        return clip(value, VALUE_LIMIT) || undefined;

    if (!value || typeof value !== "object")
        return undefined;

    if (Array.isArray(value))
        return clip(value.map(item => scalar(item)).join(", "), LINE_LIMIT) || undefined;

    const parts: string[] = [];

    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {

        if (item === undefined || item === null)
            continue;

        // Already in the row title, via `toolTitle`.
        if (key === PURPOSE_KEY)
            continue;

        const text = scalar(item);

        if (text)
            parts.push(`${key}=${text}`);
    }

    return parts.length ? clip(parts.join(", "), LINE_LIMIT) : undefined;
}

/** One argument value. Objects and arrays go in as JSON, capped like everything else. */
export function scalar(value: unknown): string {

    if (typeof value === "string")
        return clip(value, VALUE_LIMIT);

    if (typeof value === "number" || typeof value === "boolean")
        return String(value);

    try {

        return clip(JSON.stringify(value) ?? "", VALUE_LIMIT);

    } catch {

        // Circular, or something that throws in a getter. A log line is
        // not worth failing a translation over.
        return "";
    }
}

/**
 * The file a tool call is about, from its own free-form arguments.
 *
 * Best-effort: neither SDK has a dedicated field, and a missed path
 * only shortens the "files changed" list. The keys are the union of
 * both vendors' spellings.
 */
export function toolPath(args: unknown): string | undefined {

    if (!args || typeof args !== "object")
        return undefined;

    const named = args as Record<string, unknown>;

    for (const key of ["file_path", "path", "filePath", "file", "target", "notebook_path"]) {

        const value = named[key];

        if (typeof value === "string" && value.length)
            return value;
    }

    return undefined;
}

/** Tokens, roughly - a log line wants the magnitude, not the audit. */
export function tokens(value: number): string {

    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

/** `3 tool calls`, or nothing at all when the vendor did not count. */
export function countOf(value: unknown, noun: string): string {

    return typeof value === "number" ? `${value} ${noun}${value === 1 ? "" : "s"}` : "";
}

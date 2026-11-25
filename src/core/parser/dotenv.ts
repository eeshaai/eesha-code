import { EnvVars } from "../models/task";

/**
 * Parses the `dotenv:` key - one path, or a list of them. A bare string
 * is accepted because `dotenv: .env` is the common case.
 *
 * This reads the declaration only; {@link parseDotEnv} reads the file.
 */
export function parseDotenvKey(source: any): string[] {

    if (source === undefined || source === null)
        return [];

    if (typeof source === "string")
        return [source];

    if (Array.isArray(source) && source.every(entry => typeof entry === "string"))
        return [...source];

    throw new Error("'dotenv:' must be a file path or a list of file paths.");
}

export interface DotEnvResult {

    values: EnvVars;

    /** Lines that could not be read, ready to log. Never thrown - one bad line must not lose the other forty. */
    problems: string[];
}

/**
 * Parses a `.env` file's content.
 *
 * Values are taken literally: no `${{ }}` resolution. A `.env` holds
 * secrets, and a `$` or `{{` inside one is a character, not a template.
 *
 * Supported:
 *
 *     # a comment
 *     export KEY=value        # the `export` prefix common in shell-sourced files
 *     QUOTED="a b c"          # escapes honoured inside double quotes
 *     LITERAL='a b c'         # nothing honoured inside single quotes
 *
 * Trailing `#` comments are not stripped from an unquoted value:
 * `URL=https://example.com/#anchor` and passwords with a hash are more
 * common than end-of-line comments. Use quotes for the other behaviour.
 */
export function parseDotEnv(text: string): DotEnvResult {

    const values: EnvVars = {};
    const problems: string[] = [];

    text.split(/\r?\n/).forEach((raw, index) => {

        const line = raw.trim();

        if (line.length === 0 || line.startsWith("#"))
            return;

        const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line;

        const separator = withoutExport.indexOf("=");

        if (separator < 1) {

            problems.push(`line ${index + 1}: expected NAME=value, got '${line}'`);

            return;
        }

        const name = withoutExport.slice(0, separator).trim();

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || RESERVED.has(name)) {

            problems.push(`line ${index + 1}: '${name}' is not a usable variable name`);

            return;
        }

        values[name] = unquote(withoutExport.slice(separator + 1).trim());
    });

    return { values, problems };
}

/**
 * Names that pass the name pattern but would not store a value:
 * assigning `__proto__` on a plain object is silently swallowed.
 * Rejected with a message instead.
 */
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

function unquote(value: string): string {

    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
        return value
            .slice(1, -1)
            .replace(/\\([nrt"\\])/g, (_match, escaped) =>
                escaped === "n" ? "\n"
                    : escaped === "r" ? "\r"
                        : escaped === "t" ? "\t"
                            : escaped);

    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
        return value.slice(1, -1);

    return value;
}

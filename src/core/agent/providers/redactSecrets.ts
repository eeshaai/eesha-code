/**
 * Secret hiding for the "Session options" log line, shared by every
 * provider that prints its options before starting a session - and
 * sign-in links kept out of the raw ACP log (see {@link hideSignInLinks}).
 *
 * `env` is a child process's environment, and an MCP server's `env` and
 * `headers` arrive with `${{ env.NAME }}` already expanded - a PAT in
 * plain text. Names are kept and values are not, matched by key name so
 * it holds at any depth.
 *
 * Its own file, not inside either provider: each provider module loads
 * its SDK at import time, so neither can import the other's copy.
 */

/**
 * The printable form of `value` when `key` holds secrets, or undefined
 * when it does not and the value should print as it is. Meant to be
 * called from a `JSON.stringify` replacer.
 */
export function redactSecret(key: string, value: unknown): unknown {

    if (!SECRET_KEYS.has(key) || !value || typeof value !== "object")
        return undefined;

    // ACP's shape: `[{ name, value }]` rather than `{ name: value }`.
    if (Array.isArray(value))
        return value.map(pair => pair && typeof pair === "object" && "value" in pair
            ? { ...pair, value: redacted(pair.value) }
            : redacted(pair));

    return redactValues(value as Record<string, unknown>);
}

/** Keys whose values are never printed. */
const SECRET_KEYS = new Set(["env", "headers"]);

/**
 * An object with its names kept and its values replaced. The length is
 * kept because "set but empty" and "not set" are different facts.
 */
function redactValues(value: Record<string, unknown>): Record<string, string> | string {

    const names = Object.keys(value);

    // A whole environment is two hundred names nobody reads; a count
    // says enough. An MCP server's handful of variables keeps its
    // names, because "did this server get its token" is the question.
    if (names.length > NAMEABLE_ENV)
        return `[${names.length} variables; names and values not logged]`;

    const hidden: Record<string, string> = {};

    for (const [name, item] of Object.entries(value))
        hidden[name] = redacted(item);

    return hidden;
}

/** One value, replaced. The length is kept - see {@link redactValues}. */
function redacted(item: unknown): string {

    return typeof item === "string" ? `[redacted, ${item.length} chars]` : "[redacted]";
}

/** Above this many entries an env block is summarized rather than listed. */
const NAMEABLE_ENV = 20;

/**
 * The line with every sign-in link in it replaced - for the raw ACP log.
 *
 * A sign-in link (OAuth) is a one-time key to an account's sign-in, and
 * Kiro's guide for ACP clients says never to log one. It is matched by
 * its shape, not by vendor, so any runtime's is caught: OAuth asks for
 * `client_id` and `response_type` in the link's query. Written plain,
 * or inside a JSON string with `/` and `&` escaped (`\/`, `&`).
 */
export function hideSignInLinks(line: string): string {

    return line.replace(SIGN_IN_LINK, SIGN_IN_LINK_HIDDEN);
}

const SIGN_IN_LINK = /https?:(?:\\?\/){2}[^\s"'<>]*?(?:[?&]|\\u0026)(?:client_id|response_type)=[^\s"'<>]*/gi;

const SIGN_IN_LINK_HIDDEN = "[sign-in link not logged]";

import { PluginContext, PluginResult } from "../../core/plugins/Plugin";

/**
 * `http@1` - one HTTP(S) call, in-process. The route to a webhook or a
 * JSON endpoint instead of `run: curl` with the token on the command
 * line.
 *
 * Auth never rides in `headers:`. `authEnv` names the env var holding
 * the ready Authorization value, read through `ctx.secret`, which
 * registers it with the masker so a response that echoes it back still
 * logs as `***`.
 */
interface HttpArgs {

    url: string;

    method?: string;

    headers?: Record<string, unknown>;

    body?: string;

    authEnv?: string;

    timeoutMs?: number;

    failOnHttpError?: boolean;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Ceiling on the body stored as an artifact. A response is workflow
 * data, not a download; a longer body is truncated and the log says so.
 */
const MAX_STORED_BODY = 1_000_000;

/**
 * Response headers that carry credentials, never stored. Node's fetch,
 * unlike a browser's, returns `Set-Cookie` through `headers.entries()`,
 * so a session token would otherwise land in the run record, where
 * artifacts must be secret-free (see PluginResult.artifacts).
 */
const SENSITIVE_HEADERS = new Set(["set-cookie", "www-authenticate", "proxy-authenticate", "authorization"]);

export async function execute(args: HttpArgs, ctx: PluginContext): Promise<PluginResult> {

    const invalid = validate(args);

    if (invalid)
        return { success: false, message: invalid };

    const method = (args.method ?? "GET").toUpperCase();

    const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let headers: Record<string, string>;

    try {

        headers = requestHeaders(args, ctx);

    } catch (error) {

        return { success: false, message: error instanceof Error ? error.message : String(error) };
    }

    const controller = new AbortController();

    const timer = setTimeout(() => controller.abort(), timeoutMs);

    ctx.onCancel(() => controller.abort());

    const started = Date.now();

    try {

        const response = await fetch(args.url, {
            method,
            headers,
            body: args.body === undefined || method === "GET" || method === "HEAD"
                ? undefined
                : args.body,
            signal: controller.signal
        });

        const text = method === "HEAD" ? "" : await response.text();

        ctx.log(
            `HTTP ${method} ${args.url} -> ${response.status} `
            + `(${text.length} chars, ${Date.now() - started}ms)`,
            "system");

        if (text.length > MAX_STORED_BODY)
            ctx.log(
                `The response body is ${text.length} chars - storing the first ${MAX_STORED_BODY}.`,
                "system");

        const stored = text.slice(0, MAX_STORED_BODY);

        // The body parsed, when it is JSON, so a later task reads
        // `${{ run.context.NAME.json.id }}` instead of running a script
        // to parse it. Absent when the body is not JSON - reading it
        // then fails the reader, naming the missing key.
        const json = parseJson(stored);

        const artifacts = {
            status: response.status,
            body: stored,
            headers: Object.fromEntries(
                [...response.headers.entries()]
                    .filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase()))),
            ...(json === undefined ? {} : { json: json.value })
        };

        // Stored on failure too, so a task with `continueOnError:` lets a
        // later `if:` read `run.context.NAME.status`.
        if (!response.ok && args.failOnHttpError !== false)
            return {
                success: false,
                artifacts,
                message: `${method} ${args.url} answered HTTP ${response.status}. `
                    + "Set failOnHttpError: false if a non-2xx answer is data rather than a failure."
            };

        return { success: true, artifacts };

    } catch (error) {

        if (controller.signal.aborted)
            return {
                success: false,
                message: ctx.cancelled
                    ? `Stopped while calling ${args.url}.`
                    : `${method} ${args.url} timed out after ${timeoutMs / 1000}s.`
            };

        // fetch buries the useful part (ECONNREFUSED, DNS) in `cause`.
        const cause = (error as { cause?: { message?: string } }).cause?.message;

        return {
            success: false,
            message: `Could not reach ${args.url}: `
                + `${error instanceof Error ? error.message : String(error)}${cause ? ` (${cause})` : ""}`
        };

    } finally {

        clearTimeout(timer);
    }
}

/**
 * The body as JSON, boxed so a body that is the JSON `null` still
 * counts as parsed. Undefined when it is not JSON. A truncated body
 * (see MAX_STORED_BODY) is not valid JSON, and is left as text.
 */
function parseJson(text: string): { value: unknown } | undefined {

    const trimmed = text.trim();

    if (!trimmed || !"{[\"-0123456789tfn".includes(trimmed[0]))
        return undefined;

    try {

        return { value: JSON.parse(trimmed) };

    } catch {

        return undefined;
    }
}

/** The args a run cannot proceed without, each failure naming its field. */
function validate(args: HttpArgs): string | undefined {

    if (typeof args.url !== "string" || !/^https?:\/\//.test(args.url.trim()))
        return "'url' must be an http:// or https:// URL.";

    if (args.method !== undefined && !METHODS.includes(String(args.method).toUpperCase()))
        return `'method' must be one of ${METHODS.join(", ")} - got '${String(args.method)}'.`;

    if (args.headers !== undefined
        && (typeof args.headers !== "object" || args.headers === null || Array.isArray(args.headers)))
        return "'headers' must be a map of header names to values.";

    if (args.body !== undefined && typeof args.body !== "string")
        return "'body' must be text - serialize JSON before handing it over.";

    if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== "number" || args.timeoutMs <= 0))
        return `'timeoutMs' must be a positive number of milliseconds - got '${String(args.timeoutMs)}'.`;

    return undefined;
}

/**
 * The headers sent: the declared map, the auth env var's value as
 * `Authorization`, and a JSON `Content-Type` when a body is going out
 * and none was named.
 */
function requestHeaders(args: HttpArgs, ctx: PluginContext): Record<string, string> {

    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(args.headers ?? {}))
        headers[name] = String(value);

    if (args.authEnv?.trim()) {

        const value = ctx.secret(args.authEnv.trim());

        if (!value)
            throw new Error(
                `No value found for 'authEnv' - set the '${args.authEnv.trim()}' environment variable, `
                + "or point 'authEnv' at the one holding the Authorization value.");

        headers["Authorization"] = value;
    }

    const hasContentType = Object.keys(headers).some(name => name.toLowerCase() === "content-type");

    if (args.body !== undefined && !hasContentType)
        headers["Content-Type"] = "application/json";

    return headers;
}

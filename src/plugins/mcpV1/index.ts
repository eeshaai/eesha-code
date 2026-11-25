import { EnvService } from "../../core/env/envService";
import { mcpConverse } from "../../core/agent/mcpClient";
import { normalizeMcpServers } from "../../core/agent/providers/mcpServers";
import { PluginContext, PluginResult } from "../../core/plugins/Plugin";
import { loadEngineSettings } from "../../core/settings/engineSettings";
import { resolveMcpServers } from "../../core/agent/providers/mcpConfig";

/**
 * `mcp@1` - one tool call on one MCP server, with no model involved.
 *
 * It reads the servers `settings.json` declares, applies the same env
 * gate as an `ai@1` session, and calls one named tool once. Unlike a
 * model deciding to call the tool, this is deterministic and
 * reproducible.
 *
 * The trade: nothing here can check `arguments` before the run, because
 * the shape belongs to the server. A hand-written plugin can, and is
 * still the right answer when the failure needs to name a variable.
 */
export interface McpArgs {

    server: string;

    tool: string;

    arguments?: Record<string, unknown>;

    allowedEnv?: string[];

    timeoutMs?: number;

    failOnToolError?: boolean;
}

/**
 * What this plugin cannot get from a task. Same shape as `ai@1`'s
 * `AgentPluginDeps`: the host knows where `settings.json` lives, and a
 * test needs to answer without a machine.
 */
export interface McpPluginDeps {

    /**
     * Where the workspace-level `.eesha` lives. Read fresh per
     * call, because the file can change while the engine runs.
     */
    workspaceFolder?(): string | undefined;

    /** Injected by tests. Defaults to the real loader. */
    settings?: typeof loadEngineSettings;

    /** Injected by tests. Defaults to the real client. */
    converse?: typeof mcpConverse;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** Ceiling on the text stored as an artifact, the same as `http@1`'s. */
const MAX_STORED_TEXT = 1_000_000;

export function createExecute(deps: McpPluginDeps = {}) {

    const loadSettings = deps.settings ?? loadEngineSettings;

    const converse = deps.converse ?? mcpConverse;

    return async function execute(args: McpArgs, ctx: PluginContext): Promise<PluginResult> {

        const invalid = validate(args);

        if (invalid)
            return { success: false, message: invalid };

        const timeoutMs = args.timeoutMs ?? DEFAULT_TIMEOUT_MS;

        let declaration: Record<string, unknown>;
        let baseEnv: Record<string, string>;

        try {

            const settings = await loadSettings(deps.workspaceFolder?.());

            // Built exactly as a provider builds it, so a server
            // declaration reads the same names here as in a session.
            const envs = new EnvService({
                allowed: settings.env.allowed,
                denied: settings.env.denied,
                taskEnv: ctx.env,
                allowedEnv: args.allowedEnv
            });

            // Selecting by name reuses the session path's own error for
            // an undeclared name, which lists what is declared.
            const resolved = resolveMcpServers(
                settings.ai.mcpServers,
                envs,
                { servers: [args.server] });

            const selected = resolved?.servers?.[args.server];

            // Declared but nothing came back: settings.json says
            // `disabled`. Say so, rather than a missing-server error.
            if (!selected)
                return {
                    success: false,
                    message: `The MCP server '${args.server}' is disabled in settings.json, `
                        + "so this task cannot call it. Remove 'disabled' there to allow it."
                };

            // Windows resolves a bare `npx` through a shell or not at
            // all. Same normalization a session's copy goes through.
            declaration = normalizeMcpServers({ [args.server]: selected })?.[args.server] as Record<string, unknown>;

            baseEnv = envs.spawnEnv();

        } catch (error) {

            return { success: false, message: messageOf(error) };
        }

        const controller = new AbortController();

        ctx.onCancel(() => controller.abort());

        const started = Date.now();

        try {

            const answer = await converse(
                declaration,
                { method: "tools/call", params: { name: args.tool, arguments: args.arguments ?? {} } },
                { timeoutMs, baseEnv, signal: controller.signal });

            return reported(args, answer.result, ctx, started);

        } catch (error) {

            return {
                success: false,
                message: ctx.cancelled
                    ? `Stopped while calling '${args.tool}' on '${args.server}'.`
                    : `Calling '${args.tool}' on '${args.server}' failed: ${messageOf(error)}`
            };
        }
    };
}

/** The args a run cannot proceed without, each failure naming its field. */
function validate(args: McpArgs): string | undefined {

    if (typeof args.server !== "string" || !args.server.trim())
        return "'server' must name a server declared under ai.mcpServers in settings.json.";

    if (typeof args.tool !== "string" || !args.tool.trim())
        return "'tool' must be the bare name of a tool the server offers.";

    if (args.arguments !== undefined
        && (typeof args.arguments !== "object" || args.arguments === null || Array.isArray(args.arguments)))
        return "'arguments' must be a map of the tool's argument names to values.";

    if (args.timeoutMs !== undefined && (typeof args.timeoutMs !== "number" || args.timeoutMs <= 0))
        return `'timeoutMs' must be a positive number of milliseconds - got '${String(args.timeoutMs)}'.`;

    return undefined;
}

/**
 * What the server answered, as artifacts.
 *
 * An MCP result is a list of content blocks: text, images, embedded
 * resources. Only text is stored; the log says how many blocks were
 * dropped. `structuredContent` is stored as it comes when a server
 * sends one.
 */
function reported(
    args: McpArgs,
    result: Record<string, unknown> | undefined,
    ctx: PluginContext,
    started: number
): PluginResult {

    const blocks = Array.isArray(result?.content) ? result.content as Record<string, unknown>[] : [];

    const spoken = blocks.filter(block => block?.type === "text" && typeof block.text === "string");

    const text = spoken.map(block => String(block.text)).join("\n");

    const isError = result?.isError === true;

    ctx.log(
        `MCP ${args.server}/${args.tool} -> ${isError ? "error" : "ok"} `
        + `(${text.length} chars, ${Date.now() - started}ms)`,
        isError ? "stderr" : "system");

    const dropped = blocks.length - spoken.length;

    if (dropped > 0)
        ctx.log(
            `${dropped} non-text content block(s) were not stored - an artifact is workflow data, not a download.`,
            "system");

    if (text.length > MAX_STORED_TEXT)
        ctx.log(`The answer is ${text.length} chars - storing the first ${MAX_STORED_TEXT}.`, "system");

    const artifacts = {
        text: text.slice(0, MAX_STORED_TEXT),
        structured: result?.structuredContent ?? null,
        isError
    };

    // Stored on failure too, so a task with `continueOnError:` lets a
    // later `if:` read `run.context.NAME.isError`.
    if (isError && args.failOnToolError !== false)
        return {
            success: false,
            artifacts,
            message: `'${args.tool}' on '${args.server}' answered with an error`
                + `${text ? `: ${firstLine(text)}` : "."} `
                + "Set failOnToolError: false if that is data rather than a failure."
        };

    return { success: true, artifacts };
}

/** Enough of the server's error to act on, without pasting a page into the run panel. */
function firstLine(text: string): string {

    const line = text.split("\n").find(part => part.trim()) ?? "";

    return line.length > 300 ? `${line.slice(0, 300)}...` : line;
}

function messageOf(error: unknown): string {

    return error instanceof Error ? error.message : String(error);
}

import { NodeProcessSpawner } from "../process/NodeProcessSpawner";
import { ProcessSpawner } from "../process/processSpawner";
import { appName } from "../loader/profilePaths";

/**
 * One JSON-RPC conversation with an MCP server: connect, handshake, ask
 * one thing, disconnect.
 *
 * Shared by the MCP panel's discovery (`tools/list`) and `mcp@1`
 * (`tools/call`); the request is the parameter.
 *
 * One request per connection, not a client you hold. A task is a
 * function call, and a pooled connection would outlive it and belong to
 * nobody.
 *
 * Speaks both transports the settings schema allows:
 *
 *   - `stdio` (a `command`): spawn, newline-delimited JSON-RPC,
 *     `initialize` / `initialized` / the request, kill.
 *   - `http` / `sse` (a `url`): POST the same JSON-RPC, reading either
 *     a JSON body or an SSE stream, whichever the server answers with.
 *
 * Expects a declaration that is already runnable: engine keys stripped,
 * env expanded, Windows-normalized - the same shape a session gets.
 */

/** The one thing this conversation is for, after the handshake. */
export interface McpRequest {

    method: string;

    params?: Record<string, unknown>;
}

export interface McpAnswer {

    /** What the server called itself in the handshake. */
    serverName?: string;

    version?: string;

    /** The request's own result, untouched. Its shape is the method's business. */
    result?: Record<string, unknown>;
}

export interface McpCallOptions {

    timeoutMs?: number;

    /**
     * What a stdio server's child inherits - callers hand in
     * `EnvService.spawnEnv()`; this module never reads `process.env`.
     * The default is empty on purpose: a call that inherits nothing
     * fails loudly at spawn, where one that inherited everything would
     * leak.
     */
    baseEnv?: Record<string, string>;

    /** Aborts the conversation - a cancelled run, as opposed to a timeout. */
    signal?: AbortSignal;

    /** Who actually starts a stdio server's process. Defaults to Node's own. */
    spawner?: ProcessSpawner;
}

const DEFAULT_SPAWNER = new NodeProcessSpawner();

const DEFAULT_TIMEOUT_MS = 30_000;

const PROTOCOL_VERSION = "2025-06-18";


/**
 * Holds one conversation and returns its answer.
 *
 * Rejects with a readable message on anything - a command that will not
 * start, a URL that will not answer, a handshake that stalls past
 * `timeoutMs`, a server that answers with a JSON-RPC error.
 */
export async function mcpConverse(
    server: Record<string, unknown>,
    request: McpRequest,
    options: McpCallOptions = {}
): Promise<McpAnswer> {

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (typeof server.url === "string" && server.url.length)
        return overHttp(
            server as { url: string; headers?: Record<string, string> },
            request,
            timeoutMs,
            options.signal);

    if (typeof server.command === "string" && server.command.length)
        return overStdio(
            server, request, timeoutMs, options.baseEnv ?? {}, options.signal, options.spawner ?? DEFAULT_SPAWNER);

    throw new Error("The declaration has neither a 'command' nor a 'url' - nothing to start.");
}

const INITIALIZE_ID = 1;

/** The handshake. Built when sent, so it carries the app's own name - see appName. */
function initialize() {

    return {
        jsonrpc: "2.0" as const,
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: appName(), version: "1.0.0" }
        }
    };
}

const INITIALIZED = { jsonrpc: "2.0" as const, method: "notifications/initialized" };

/** The caller's request, as the second and last message of the conversation. */
function asked(request: McpRequest) {

    return {
        jsonrpc: "2.0" as const,
        id: 2,
        method: request.method,
        ...(request.params ? { params: request.params } : {})
    };
}

interface RpcMessage {

    id?: number;

    result?: Record<string, unknown> & { serverInfo?: { name?: string; version?: string } };

    error?: { message?: string; code?: number };
}

function overStdio(
    server: Record<string, unknown>,
    request: McpRequest,
    timeoutMs: number,
    baseEnv: Record<string, string>,
    signal: AbortSignal | undefined,
    spawner: ProcessSpawner
): Promise<McpAnswer> {

    const ask = asked(request);

    return new Promise<McpAnswer>((resolve, reject) => {

        const args = Array.isArray(server.args) ? server.args.map(String) : [];

        const child = spawner.spawn(String(server.command), args, {

            // The caller's base env, with the server's own declared
            // values on top. Never `process.env` directly - EnvService
            // is the one place that reads it.
            env: {
                ...baseEnv,
                ...(server.env && typeof server.env === "object" ? server.env as Record<string, string> : {})
            },

            ...(typeof server.workingDirectory === "string" && server.workingDirectory
                ? { cwd: server.workingDirectory }
                : {})
        });

        let settled = false;
        let stdout = "";
        let stderr = "";
        let info: { name?: string; version?: string } | undefined;

        const finish = (outcome: { result?: McpAnswer; error?: Error }) => {

            if (settled)
                return;

            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            child.kill();

            if (outcome.result)
                resolve(outcome.result);
            else
                reject(outcome.error);
        };

        // One timeout, two failures worth telling apart: a server that
        // never spoke is broken or still installing; one that shook
        // hands and then went quiet is the tool call hanging.
        const timer = setTimeout(() => finish({
            error: new Error(
                (info
                    ? `The server did not answer '${request.method}' within ${Math.round(timeoutMs / 1000)}s.`
                    : `The server did not finish the handshake within ${Math.round(timeoutMs / 1000)}s.`)
                + trailer(stderr))
        }), timeoutMs);

        const onAbort = () => finish({ error: new Error(`Stopped while calling '${request.method}'.`) });

        if (signal?.aborted) {

            onAbort();
            return;
        }

        signal?.addEventListener("abort", onAbort);

        child.onError(error => finish({
            error: new Error(`Could not start '${String(server.command)}': ${error.message}`)
        }));

        child.onExit(code => finish({
            error: new Error(`The server exited (code ${code}) before answering.` + trailer(stderr))
        }));

        child.onStderr(chunk => { stderr += chunk; });

        child.onStdout(chunk => {

            stdout += chunk;

            let at: number;

            while ((at = stdout.indexOf("\n")) >= 0) {

                const line = stdout.slice(0, at).trim();

                stdout = stdout.slice(at + 1);

                if (!line)
                    continue;

                let message: RpcMessage;

                try {

                    message = JSON.parse(line) as RpcMessage;

                } catch {

                    // Servers log on stdout before speaking JSON-RPC -
                    // the ADO server prints a whole banner. Skip it.
                    continue;
                }

                if (message.error)
                    return finish({
                        error: new Error(`The server answered with an error: ${message.error.message}`)
                    });

                if (message.id === INITIALIZE_ID) {

                    info = message.result?.serverInfo;

                    child.writeStdin(JSON.stringify(INITIALIZED) + "\n");
                    child.writeStdin(JSON.stringify(ask) + "\n");
                }

                if (message.id === ask.id)
                    return finish({
                        result: {
                            serverName: info?.name,
                            version: info?.version,
                            result: message.result
                        }
                    });
            }
        });

        child.writeStdin(JSON.stringify(initialize()) + "\n");
    });
}

/** The last of what a dead or stalled server said - where the reason usually is. */
function trailer(stderr: string): string {

    const said = stderr.trim();

    if (!said)
        return "";

    return `\n\nThe server's stderr:\n${said.length > 2000 ? said.slice(-2000) : said}`;
}

/**
 * The same conversation over streamable HTTP. Each request is one POST;
 * the answer arrives as plain JSON or as an SSE stream depending on the
 * server, and both are read.
 */
async function overHttp(
    server: { url: string; headers?: Record<string, string> },
    request: McpRequest,
    timeoutMs: number,
    signal?: AbortSignal
): Promise<McpAnswer> {

    // The caller's cancellation and our own ceiling are one signal, so a
    // stopped run does not sit out the rest of the timeout.
    const deadline = AbortSignal.timeout(timeoutMs);

    const combined = signal ? anyOf([deadline, signal]) : deadline;

    const post = async (body: unknown, session?: string): Promise<{ message: RpcMessage; session?: string }> => {

        const response = await fetch(server.url, {
            method: "POST",
            signal: combined,
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream",
                ...(session ? { "Mcp-Session-Id": session } : {}),
                ...(server.headers ?? {})
            },
            body: JSON.stringify(body)
        });

        if (!response.ok)
            throw new Error(`'${server.url}' answered ${response.status} ${response.statusText}.`);

        const nextSession = response.headers.get("mcp-session-id") ?? session;

        // A notification is answered with 202 and no body.
        if (response.status === 202)
            return { message: {}, session: nextSession };

        const text = await response.text();

        return { message: parseRpcResponse(text), session: nextSession };
    };

    const initialized = await post(initialize());

    if (initialized.message.error)
        throw new Error(`The server answered with an error: ${initialized.message.error.message}`);

    await post(INITIALIZED, initialized.session);

    const answered = await post(asked(request), initialized.session);

    if (answered.message.error)
        throw new Error(`The server answered with an error: ${answered.message.error.message}`);

    return {
        serverName: initialized.message.result?.serverInfo?.name,
        version: initialized.message.result?.serverInfo?.version,
        result: answered.message.result
    };
}

/**
 * One signal that fires when either does.
 *
 * `AbortSignal.any` is missing on older Node versions, so
 * fall back rather than throw.
 */
function anyOf(signals: AbortSignal[]): AbortSignal {

    const any = (AbortSignal as unknown as { any?: (list: AbortSignal[]) => AbortSignal }).any;

    if (any)
        return any(signals);

    const controller = new AbortController();

    for (const signal of signals)
        if (signal.aborted)
            controller.abort();
        else
            signal.addEventListener("abort", () => controller.abort(), { once: true });

    return controller.signal;
}

/** A body that is either JSON outright or an SSE stream whose `data:` lines carry it. */
function parseRpcResponse(text: string): RpcMessage {

    try {

        return JSON.parse(text) as RpcMessage;

    } catch {

        // SSE: the last data: line with a JSON-RPC response wins.
        for (const line of text.split("\n").reverse()) {

            const trimmed = line.trim();

            if (!trimmed.startsWith("data:"))
                continue;

            try {

                return JSON.parse(trimmed.slice(5).trim()) as RpcMessage;

            } catch {

                continue;
            }
        }

        throw new Error("The server's answer was neither JSON nor an SSE stream carrying it.");
    }
}

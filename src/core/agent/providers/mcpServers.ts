import * as fs from "fs";
import * as path from "path";

/**
 * MCP server declarations, made runnable on the machine they land on.
 *
 * The problem here is Windows-only and silent. A config declares
 * `"command": "npx"` the way every MCP README does. On Windows there is
 * only `npx.cmd`, and `CreateProcess` does not consult `PATHEXT`, so a
 * bare `npx` resolves to nothing. The task does not fail: the session
 * starts with a server that never connected, and the agent reports it
 * cannot find the tool. So a command with no file extension is run
 * through `cmd /c` on Windows. A command that already carries one is
 * left as written.
 *
 * `type` is stated rather than left to the SDK default, because the
 * thing that starts a server is the CLI binary behind the SDK, whose
 * default is not documented. The word is `stdio`, never `local`:
 * `local` is Copilot's private alias, absent from the Claude SDK's
 * union, so it is translated on the Claude dialect and kept elsewhere.
 *
 * `tools: ["*"]` is Copilot vocabulary only. Claude's per-server
 * `tools` is a list of policy objects, not names, so the default is
 * scoped to the `copilot` dialect.
 *
 * All of this fills blanks only. A declaration that names its own
 * `type` or `tools` is left as it is.
 */

/**
 * Which SDK the normalized servers are for. Absent means neither - the
 * MCP panel's probe, which reads `command`/`url` itself and ignores
 * `type` and `tools` entirely.
 */
export type McpDialect = "copilot" | "claude";

/**
 * The same map, with every server's command runnable here.
 *
 * @param options.dialect   The SDK vocabulary to normalize into - see
 *                          {@link McpDialect}.
 * @param options.isWindows Injected so the Windows behaviour is testable
 *                          from any machine.
 */
export function normalizeMcpServers(
    servers: Record<string, unknown> | undefined,
    options: { dialect?: McpDialect; isWindows?: boolean } = {}
): Record<string, unknown> | undefined {

    if (!servers)
        return servers;

    const isWindows = options.isWindows ?? process.platform === "win32";

    return Object.fromEntries(Object.entries(servers)
        .map(([name, server]) => [name, normalizeServer(server, options.dialect, isWindows)]));
}

/**
 * One server: the two blanks filled, then the command made runnable.
 * Anything that is not a server object is returned untouched, for the
 * CLI to complain about.
 */
function normalizeServer(server: unknown, dialect: McpDialect | undefined, isWindows: boolean): unknown {

    if (!server || typeof server !== "object" || Array.isArray(server))
        return server;

    const declared = server as Record<string, unknown>;

    const config = { ...declared, ...defaults(declared, dialect) };

    // Copilot's private alias, translated for the SDK whose union does
    // not contain it.
    if (dialect === "claude" && config.type === "local")
        config.type = "stdio";

    const command = config.command;

    if (typeof command !== "string" || !command.length)
        return config;

    const args = Array.isArray(config.args) ? config.args : [];

    const runnable = runnableCommand(command, args, isWindows);

    // Unchanged when the problem does not exist here, so a server with
    // no `args` is not rewritten to carry an empty list.
    return runnable ? { ...config, ...runnable } : config;
}

/**
 * One command and its args, made runnable on Windows. Exported so
 * `AcpProvider`, spawning one `ai.acpAgents.<id>` entry, uses the same
 * fix.
 *
 * Undefined wherever the problem does not exist: off Windows, for a
 * command that already carries an extension (`CreateProcess` can start
 * these directly), and for a command that already is a shell.
 */
export function runnableCommand(
    command: string,
    args: readonly string[],
    isWindows: boolean = process.platform === "win32"
): { command: string; args: string[] } | undefined {

    if (!isWindows || path.extname(command) || SHELLS.has(path.basename(command).toLowerCase()))
        return undefined;

    return { command: "cmd", args: ["/c", command, ...args] };
}

/**
 * The defaults the declaration did not state.
 *
 * A `command` is a `stdio` server and a `url` is an `http` one; an
 * author who means `sse` says so. A declaration with neither gets no
 * `type`, so the malformed-server error stays clear.
 *
 * Empty when the author already said both.
 */
function defaults(config: Record<string, unknown>, dialect: McpDialect | undefined): Record<string, unknown> {

    const filled: Record<string, unknown> = {};

    if (config.type === undefined) {

        if (typeof config.command === "string" && config.command.length)
            filled.type = "stdio";
        else if (typeof config.url === "string" && config.url.length)
            filled.type = "http";
    }

    // Every tool the server offers; a task narrows that per session.
    // Copilot only: `["*"]` is the wrong shape for Claude's per-server
    // policy list.
    if (dialect === "copilot" && config.tools === undefined)
        filled.tools = ["*"];

    return filled;
}

/** Commands that are already a shell, so they are not wrapped in one. */
const SHELLS = new Set(["cmd", "powershell", "pwsh"]);

/** Windows' own default, for a machine whose `PATHEXT` is somehow unset. */
const DEFAULT_PATHEXT = ".com;.exe;.bat;.cmd";

/**
 * One server, in the shape `session/new` takes. ACP takes an array,
 * each entry naming itself, and `env`/`headers` are arrays of
 * `{ name, value }` pairs - the wire shape
 * `NewSessionRequest.mcpServers: McpServer[]` declares.
 */
export type AcpMcpServer =
    | { type: "stdio"; name: string; command: string; args: string[]; env: { name: string; value: string }[] }
    | { type: "http"; name: string; url: string; headers: { name: string; value: string }[] }
    | { type: "sse"; name: string; url: string; headers: { name: string; value: string }[] };

/**
 * The resolved `ai.mcpServers` map, as the array `session/new` wants.
 *
 * A malformed or unrecognized entry (no `command` and no `url`, or a
 * `type` this shape has no case for) is dropped rather than thrown
 * over, so one bad declaration does not fail every other server.
 */
export function toAcpMcpServers(
    servers: Record<string, unknown>,
    isWindows: boolean = process.platform === "win32",
    pathEnv: string = process.env.PATH ?? ""
): AcpMcpServer[] {

    return Object.entries(servers)
        .map(([name, server]) => acpServer(name, server, isWindows, pathEnv))
        .filter((server): server is AcpMcpServer => server !== undefined);
}

function acpServer(name: string, server: unknown, isWindows: boolean, pathEnv: string): AcpMcpServer | undefined {

    if (!server || typeof server !== "object" || Array.isArray(server))
        return undefined;

    const declared = server as Record<string, unknown>;

    const type = typeof declared.type === "string"
        ? declared.type
        : typeof declared.command === "string" ? "stdio" : typeof declared.url === "string" ? "http" : undefined;

    if ((type === "stdio" || type === "local") && typeof declared.command === "string" && declared.command.length) {

        const declaredArgs = stringArray(declared.args);

        // ACP's schema documents `command` as an absolute path. The
        // agent on the other end launches this, not this engine, so a
        // bare `npx` that works for `ghcp`/`claude` may silently fail
        // to connect there.
        const { command, args } = resolveMcpServerCommand(declared.command, declaredArgs, pathEnv, isWindows);

        return { type: "stdio", name, command, args, env: pairs(declared.env) };
    }

    if ((type === "http" || type === "sse") && typeof declared.url === "string" && declared.url.length)
        return { type, name, url: declared.url, headers: pairs(declared.headers) };

    return undefined;
}

/**
 * A stdio MCP server's command, resolved to an absolute path and
 * wrapped for `cmd.exe` if it is (or resolves to) a `.cmd`/`.bat`
 * script.
 *
 * Not {@link runnableCommand}: that one skips wrapping any command that
 * carries an extension, which is right for this engine's own spawn. But
 * a `.cmd`/`.bat` is not a real executable; `CreateProcess` cannot run
 * it without `cmd.exe`, and what spawns this command is the agent on
 * the other end of the ACP connection, which may not handle that. So a
 * resolved `.cmd`/`.bat` is wrapped even with an absolute path.
 */
export function resolveMcpServerCommand(
    command: string,
    args: readonly string[],
    pathEnv: string = process.env.PATH ?? "",
    isWindows: boolean = process.platform === "win32",
    pathExt: string = process.env.PATHEXT ?? DEFAULT_PATHEXT
): { command: string; args: string[] } {

    const resolved = resolveExecutable(command, pathEnv, isWindows, pathExt);

    if (!isWindows)
        return { command: resolved, args: [...args] };

    const ext = path.extname(resolved).toLowerCase();

    if ((ext === ".cmd" || ext === ".bat") && !SHELLS.has(path.basename(resolved, ext).toLowerCase()))
        return { command: "cmd", args: ["/c", resolved, ...args] };

    return { command: resolved, args: [...args] };
}

/**
 * The absolute path to `command` if found on `pathEnv`, or `command`
 * unchanged when it already contains a separator or nothing on PATH
 * matched.
 *
 * `PATHEXT` is consulted on Windows the way a shell would, because
 * `CreateProcess` does not.
 */
export function resolveExecutable(
    command: string,
    pathEnv: string = process.env.PATH ?? "",
    isWindows: boolean = process.platform === "win32",
    pathExt: string = process.env.PATHEXT ?? DEFAULT_PATHEXT
): string {

    if (command.includes("/") || command.includes("\\"))
        return command;

    const dirs = pathEnv.split(path.delimiter).filter(Boolean);

    // A command that already has an extension (`npx.cmd`) is searched
    // for by exactly that name.
    const extensions = isWindows && !path.extname(command)
        ? pathExt.split(";").filter(Boolean)
        : [""];

    for (const dir of dirs)
        for (const extension of extensions) {

            const candidate = path.join(dir, `${command}${extension}`);

            if (isFile(candidate))
                return realCasing(candidate);
        }

    return command;
}

/**
 * A path that exists, spelled the way it is on disk.
 *
 * The candidate was built with `PATHEXT`'s casing (usually `.CMD`),
 * and the case-insensitive filesystem found `npx.cmd` under it. The
 * string still reads `npx.CMD`, which a byte-for-byte comparison or a
 * case-sensitive process elsewhere would not match.
 * `realpathSync.native` asks Windows for the real spelling.
 *
 * Falls back to the candidate on any error.
 */
function realCasing(candidate: string): string {

    try {

        return fs.realpathSync.native(candidate);

    } catch {

        return candidate;
    }
}

function isFile(candidate: string): boolean {

    try {

        return fs.statSync(candidate).isFile();

    } catch {

        return false;
    }
}

function stringArray(value: unknown): string[] {

    return Array.isArray(value) ? value.filter((one): one is string => typeof one === "string") : [];
}

/** A plain `{ KEY: "value" }` map as ACP's `{ name, value }[]` pairs - `env` and `headers` share this shape. */
function pairs(value: unknown): { name: string; value: string }[] {

    if (!value || typeof value !== "object" || Array.isArray(value))
        return [];

    return Object.entries(value as Record<string, unknown>)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([entryName, entryValue]) => ({ name: entryName, value: entryValue }));
}

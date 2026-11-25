import * as path from "path";
import { Plugin, PluginContext, PluginDb, PluginHandleContext } from "../Plugin";
import { flushLogs, getLogger, messageOf } from "../../logging/logger";
import {
    FromWorker, PluginDescription, SandboxedContextData, SandboxedHandleContextData, ToWorker
} from "./protocol";

/**
 * This process's own diagnostics, never a plugin's. `setLogSinks` is
 * never called here on purpose: a file or network sink inside this
 * process would write before the parent masks secrets out of the
 * captured stdout/stderr (see `hooks.onLog` in PluginSandbox). Every
 * line stays on the console pipeline and is masked downstream.
 */
const logger = getLogger("PluginWorker");

/**
 * The process a user plugin runs in. Three layers:
 *
 *   1. A separate process. A plugin cannot see the engine's memory or the
 *      run store. An escape inside this process gains only
 *      this process.
 *
 *   2. Node's permission model (`--permission --allow-fs-read=...`, set
 *      by PluginSandbox when it forks us). Reads outside the plugin's
 *      directory, spawning, and native addons fail with
 *      ERR_ACCESS_DENIED. Node enforces this below JavaScript, so this
 *      is the layer that holds.
 *
 *   3. The module allowlist below. `require("fs")` fails with a message
 *      the author can act on instead of an ERR_ACCESS_DENIED from deep
 *      inside a library. It also denies `net`/`http`/`dns`, which the
 *      permission model does not cover.
 */

/**
 * Modules a plugin may require. All pure computation: none opens a
 * file, a socket, or a process. Anything absent is denied, so a module
 * added to Node later is denied by default.
 */
const ALLOWED_MODULES = new Set([
    "assert",
    "buffer",
    "crypto",
    "events",
    "path",
    "punycode",
    "querystring",
    "string_decoder",
    "url",
    "util",
    "zlib"
]);

/** The modules people most often reach for, with a reason in the denial. */
const EXPLAINED = new Map([
    ["fs", "read and write files"],
    ["fs/promises", "read and write files"],
    ["child_process", "run other programs"],
    ["net", "open network connections"],
    ["http", "open network connections"],
    ["https", "open network connections"],
    ["dgram", "open network connections"],
    ["dns", "resolve host names"],
    ["worker_threads", "start threads"],
    ["vm", "compile code"],
    ["module", "reach around the loader"],
    ["inspector", "attach a debugger"]
]);

function denialFor(request: string): string {

    const capability = EXPLAINED.get(bare(request));

    return capability
        ? `A plugin cannot require '${request}' - it would let the plugin ${capability}, ` +
        `which the sandbox exists to prevent. Ask the engine for what you need through the plugin context instead.`
        : `A plugin cannot require '${request}'. Allowed modules: ${[...ALLOWED_MODULES].sort().join(", ")}.`;
}

const bare = (request: string) => request.replace(/^node:/, "");

/**
 * Whether a request names a Node builtin. Asked of Node, not a list we
 * maintain, so a builtin added later is denied rather than mistaken for
 * a dependency.
 */
function isBuiltin(request: string): boolean {

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return request.startsWith("node:") || require("module").builtinModules.includes(bare(request));
}

/**
 * Where a bare specifier resolves from the file asking for it.
 *
 * Node walks node_modules upward, so this can land outside the plugin;
 * the caller rejects that. The permission model may refuse the walk
 * partway, which arrives as a throw and means the same thing.
 */
function resolveDependency(request: string, from: string): string | undefined {

    try {

        return require.resolve(request, { paths: [path.dirname(from)] });

    } catch {

        return undefined;
    }
}

/** Whether a resolved path sits inside the plugin's own directory. */
function inside(root: string, candidate: string): boolean {

    const relative = path.relative(root, candidate);

    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Constrains what the plugin's own files may require.
 *
 * Scoped by the requesting file, so the worker's own code and Node's
 * internals keep working. Only modules loaded from inside the plugin's
 * directory are held to the allowlist. That includes the plugin's own
 * `node_modules`, so a dependency cannot reach `fs` on its behalf.
 */
function lockLoader(pluginRoot: string): void {

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require("module");

    const load = Module._load;

    Module._load = function (request: string, parent: { filename?: string } | undefined, isMain: boolean) {

        const from = parent?.filename;

        if (!from || !inside(pluginRoot, from))
            return load.call(this, request, parent, isMain);

        const relative = request.startsWith(".") || path.isAbsolute(request);

        if (!relative) {

            if (ALLOWED_MODULES.has(bare(request)))
                return load.call(this, request, parent, isMain);

            // A denied builtin is never put to resolution. Node resolves
            // builtins ahead of node_modules, so a `node_modules/fs`
            // could not shadow the real one; resolution would only
            // report "not found" for something that is reachable.
            if (isBuiltin(request))
                throw new Error(denialFor(request));

            // Otherwise it is a dependency, allowed only if it resolves
            // inside the plugin's own root. The permission model usually
            // refuses the upward walk first, so the containment check
            // rarely fires; it is kept as the layer that would still be
            // right if resolution succeeded.
            const dependency = resolveDependency(request, from);

            if (!dependency || !inside(pluginRoot, dependency))
                throw new Error(
                    `A plugin cannot require '${request}' - it is not a permitted builtin, and it was not ` +
                    `found in the plugin's own node_modules. Install it beside the plugin and ship it with it.`);

            return load.call(this, request, parent, isMain);
        }

        // The permission model would refuse the read anyway; this says
        // why.
        const resolved = path.resolve(path.dirname(from), request);

        if (!inside(pluginRoot, resolved))
            throw new Error(
                `A plugin cannot require '${request}' - it resolves outside the plugin's own directory.`);

        return load.call(this, request, parent, isMain);
    };
}

/**
 * What a plugin is confined to: its folder, or the single file itself.
 *
 * Told to us by the host, not derived from the entry point:
 * `path.dirname` of a loose `greet.js` is the shared plugins folder.
 * This must match the permission flags (see PluginRoot).
 */
export function confinementRootOf(argv: readonly string[], modulePath: string): string {

    const flag = argv.indexOf("--root");

    return flag >= 0 && argv[flag + 1] ? argv[flag + 1] : path.dirname(modulePath);
}

function loadPlugin(modulePath: string): Plugin {

    lockLoader(confinementRootOf(process.argv, modulePath));

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loaded = require(modulePath);

    const candidate = (loaded?.default ?? loaded) as Plugin;

    if (!candidate || typeof candidate !== "object")
        throw new Error(`${path.basename(modulePath)} did not export a plugin object.`);

    // Checked here rather than on the host, because a function does not
    // survive the message boundary.
    if (typeof candidate.execute !== "function")
        throw new Error(`${path.basename(modulePath)} must export an 'execute(args, ctx)' function.`);

    return candidate;
}

/**
 * Whether this process really is running under the permission model.
 *
 * `process.permission` exists only when `--permission` was accepted.
 * Its absence means the flags did not take.
 */
function permissionModelActive(): boolean {

    const permission = (process as NodeJS.Process & {
        permission?: { has(scope: string, reference?: string): boolean };
    }).permission;

    if (!permission || typeof permission.has !== "function")
        return false;

    // Present but granting everything would be no boundary either.
    return !permission.has("fs.write") && !permission.has("child") && !permission.has("fs.read", "/");
}

function describe(modulePath: string): PluginDescription {

    const plugin = loadPlugin(modulePath);

    return {
        enforced: permissionModelActive(),
        id: plugin.id,
        version: plugin.version,
        description: plugin.description,
        args: plugin.args,
        artifacts: plugin.artifacts,
        artifactsFrom: plugin.artifactsFrom,
        secrets: plugin.secrets,
        secretsFrom: plugin.secretsFrom,
        ui: plugin.ui,
        hasHandle: typeof plugin.handle === "function"
    };
}

function send(message: FromWorker): void {

    process.send?.(message);
}

/**
 * `ctx.db` calls in flight, by id. The host answers each with a
 * `dbResult`; the promise here is what the plugin awaited.
 */
const pendingDb = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

let nextDbId = 0;

/** The plugin's database, as three calls that each cross to the host and back. */
function dbProxy(): PluginDb {

    const ask = (op: "run" | "get" | "all", sql: string, params?: unknown[] | Record<string, unknown>) =>
        new Promise<never>((resolve, reject) => {

            const id = ++nextDbId;

            pendingDb.set(id, { resolve: resolve as (value: unknown) => void, reject });

            send({ type: "db", id, op, sql: String(sql), params });
        });

    return {
        run: (sql, params) => ask("run", sql, params),
        get: (sql, params) => ask("get", sql, params),
        all: (sql, params) => ask("all", sql, params)
    };
}

function settleDb(message: Extract<ToWorker, { type: "dbResult" }>): void {

    const waiting = pendingDb.get(message.id);

    if (!waiting)
        return;

    pendingDb.delete(message.id);

    if (message.ok)
        waiting.resolve(message.value);
    else
        waiting.reject(new Error(message.error ?? "The database call failed."));
}

/** The part of the context a task and a handle share. */
function buildHandleContext(data: SandboxedHandleContextData): PluginHandleContext {

    return {
        cwd: data.cwd,
        root: data.root,
        env: Object.freeze({ ...data.env }),

        secret: name => {

            // An undeclared name is not an error, just absent, the same
            // as an unset one.
            const value = data.secrets[name];

            if (value === undefined)
                send({
                    type: "log",
                    text: `Plugin asked for the secret '${name}', which it does not declare. ` +
                        `Add it to the plugin's 'secrets' list to receive it.\n`,
                    stream: "system"
                });

            return value;
        },

        log: (text, stream = "stdout") => send({ type: "log", text: String(text), stream }),

        ...(data.hasDb ? { db: dbProxy() } : {})
    };
}

/**
 * Builds the context a plugin sees. Everything on it is created here
 * from plain data; no host object is handed over (see protocol.ts).
 */
function buildContext(data: SandboxedContextData, cancel: { cancelled: boolean; handlers: (() => void)[] }): PluginContext {

    return {
        ...buildHandleContext(data),
        runId: data.runId,
        taskId: data.taskId,
        attempt: data.attempt,

        // Sent as a message; a callback could not survive the fork.
        reportSession: id => send({ type: "session", id: String(id) }),

        get cancelled() {
            return cancel.cancelled;
        },

        onCancel: handler => cancel.handlers.push(handler)
    };
}

/**
 * Whatever `run()` did not catch: a crash outside the execute call, a
 * rejected promise nobody awaited.
 *
 * Without this the process dies and `PluginSandbox` sees only a bare
 * exit code. `flushLogs()` first: the console sink's dispatch is async
 * and there is nothing after this to retry from.
 */
async function reportCrash(kind: string, error: unknown): Promise<void> {

    logger.critical(`${kind}: ${messageOf(error)}`);

    await flushLogs();

    send({ type: "failed", message: messageOf(error) });

    // Not `process.exit()`, which would cut off the send above if it is
    // still in flight.
    process.exitCode = 1;
}

function main(): void {

    process.on("uncaughtException", error => void reportCrash("Uncaught exception", error));
    process.on("unhandledRejection", reason => void reportCrash("Unhandled rejection", reason));

    const describeIndex = process.argv.indexOf("--describe");

    if (describeIndex >= 0) {

        // Metadata only: the module is evaluated, nothing is called.
        process.stdout.write(JSON.stringify(describe(process.argv[describeIndex + 1])));

        return;
    }

    const modulePath = process.argv[2];

    const cancel = { cancelled: false, handlers: [] as (() => void)[] };

    process.on("message", (message: ToWorker) => {

        if (message.type === "cancel") {

            cancel.cancelled = true;

            for (const handler of cancel.handlers)
                try {
                    handler();
                } catch {
                    // A plugin's own cancel handler must not stop the rest.
                }

            return;
        }

        if (message.type === "dbResult")
            return settleDb(message);

        if (message.type === "handle")
            return void handle(modulePath, message);

        void run(modulePath, message, cancel);
    });

    send({ type: "ready" });
}

async function run(
    modulePath: string,
    message: Extract<ToWorker, { type: "execute" }>,
    cancel: { cancelled: boolean; handlers: (() => void)[] }
): Promise<void> {

    try {

        const plugin = loadPlugin(modulePath);

        const result = await plugin.execute(message.args, buildContext(message.context, cancel));

        send({ type: "result", result });

    } catch (error) {

        send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    }
}

/** One request from the plugin's own tab, answered by its `handle`. */
async function handle(modulePath: string, message: Extract<ToWorker, { type: "handle" }>): Promise<void> {

    try {

        const plugin = loadPlugin(modulePath);

        if (typeof plugin.handle !== "function")
            throw new Error(`${path.basename(modulePath)} does not export a 'handle(request, ctx)' function, so its tab has nothing to call.`);

        const value = await plugin.handle(message.request, buildHandleContext(message.context));

        // `undefined` does not survive JSON; the page gets null instead.
        send({ type: "handled", value: value === undefined ? null : value });

    } catch (error) {

        send({ type: "failed", message: error instanceof Error ? error.message : String(error) });
    }
}

main();

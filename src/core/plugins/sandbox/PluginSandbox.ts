import { ChildProcess, execFileSync, fork } from "child_process";
import * as path from "path";
import { EnvService } from "../../env/envService";
import { getLogger, messageOf } from "../../logging/logger";
import { PluginRequest, PluginResult } from "../Plugin";
import {
    FromWorker, PluginDescription, SandboxedContextData, SandboxedHandleContextData, ToWorker
} from "./protocol";

const logger = getLogger("PluginSandbox");

/**
 * Runs user plugins in their own process, forked with Node's permission
 * model restricted to the plugin's own directory.
 *
 * The permission flags are the layer that holds: Node enforces them
 * below JavaScript. The module allowlist inside the worker fails early
 * with a readable message, and covers network access, which the
 * permission model does not know about.
 *
 * Bundled plugins do not go through here. They ship with the engine and
 * are trusted; user plugins are arbitrary JavaScript.
 */
/**
 * What one plugin is allowed to read. Passed in rather than derived
 * from the module path, because `path.dirname(entryPoint)` is wrong in
 * both directions:
 *
 * - a single `greet.js` in the plugins folder would be granted the whole
 *   plugins folder, so it could read every neighbour's source and
 *   config with a plain `require("./other-plugin/creds.json")`;
 * - a folder plugin whose `package.json` points `main` at `lib/index.js`
 *   would be granted only `lib/`, not its own data files one level up.
 *
 * Only the loader knows which layout it found, so it says so.
 */
export interface PluginRoot {

    /** The folder, for a folder plugin. The file itself, for a single-file one. */
    path: string;

    kind: "directory" | "file";
}

export class PluginSandbox {

    /**
     * @param workerPath The bundled worker script.
     * @param runtime Executable used to run it. Defaults to the
     * current Node binary. If that binary is an Electron program,
     * `ELECTRON_RUN_AS_NODE` makes it behave as Node.
     */
    constructor(
        private readonly workerPath: string,
        private readonly runtime: string = process.execPath
    ) {}

    /**
     * Reads a plugin's metadata without running any of it.
     *
     * Synchronous because the registry is built synchronously, once per
     * plugin at startup. The module is evaluated to read its exports,
     * but inside the same sandbox.
     */
    public describe(modulePath: string, root: PluginRoot): PluginDescription {

        const output = execFileSync(
            this.runtime,
            [
                ...this.permissionFlags(root),
                this.workerPath,
                "--describe", modulePath,
                // The worker's require guard must use the same boundary
                // as the permission flags, so it is passed, not re-derived.
                "--root", root.path
            ],
            {
                env: this.environment(),
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                timeout: DESCRIBE_TIMEOUT_MS
            });

        const described = JSON.parse(output) as PluginDescription;

        // Fail closed. Without the permission flags only the module
        // allowlist is left, and sandboxEscape.test.ts shows three ways
        // around it.
        if (!described.enforced)
            throw new Error(
                "Refusing to load: this runtime did not accept Node's permission model, " +
                "so the plugin could not be confined to its own directory. " +
                "User plugins need Node 20+.");

        return described;
    }

    /**
     * Runs one plugin call in a process of its own, then disposes of it.
     *
     * A process per call rather than a pool, so nothing a plugin leaves
     * behind (a timer, a global, a buffer) can reach the next task.
     */
    public execute(
        modulePath: string,
        root: PluginRoot,
        args: Record<string, unknown>,
        context: SandboxedContextData,
        hooks: SandboxHooks
    ): Promise<PluginResult> {

        return this.invoke<PluginResult>(
            modulePath,
            root,
            { type: "execute", args, context },
            hooks,
            message => message.type === "result" ? { value: message.result } : undefined,
            message => ({ success: false, message }));
    }

    /**
     * Answers one request from the plugin's own tab, in a process of its
     * own - the same rule as {@link execute}. Rejects when the plugin
     * throws or exports no `handle`.
     */
    public handle(
        modulePath: string,
        root: PluginRoot,
        request: PluginRequest,
        context: SandboxedHandleContextData,
        hooks: SandboxHooks
    ): Promise<unknown> {

        return this.invoke<unknown>(
            modulePath,
            root,
            { type: "handle", request, context },
            hooks,
            message => message.type === "handled" ? { value: message.value } : undefined,
            message => { throw new Error(message); });
    }

    /**
     * One worker, one message in, one answer out.
     *
     * @param answer  Picks the reply out of the worker's stream, or
     *                nothing for a message that is not the reply.
     * @param failure Turns a failure line into the call's result - a
     *                failed `PluginResult` for a task, a throw for a
     *                handle.
     */
    private invoke<T>(
        modulePath: string,
        root: PluginRoot,
        first: Extract<ToWorker, { type: "execute" | "handle" }>,
        hooks: SandboxHooks,
        answer: (message: FromWorker) => { value: T } | undefined,
        failure: (message: string) => T
    ): Promise<T> {

        return new Promise<T>((resolve, reject) => {

            let worker: ChildProcess;

            const fail = (message: string) => {

                try {

                    resolve(failure(message));

                } catch (error) {

                    reject(error);
                }
            };

            try {

                worker = fork(this.workerPath, [modulePath, "--root", root.path], {
                    env: this.environment(),
                    execArgv: this.permissionFlags(root),
                    stdio: ["ignore", "pipe", "pipe", "ipc"]
                });

            } catch (error) {

                logger.error(`Could not start the plugin sandbox for '${modulePath}': ${messageOf(error)}`);

                fail(`Could not start the plugin sandbox: ${messageOf(error)}`);

                return;
            }

            let settled = false;

            const finish = (outcome: () => void) => {

                if (settled)
                    return;

                settled = true;

                worker.removeAllListeners();
                worker.kill();

                outcome();
            };

            hooks.onCancel?.(() => {

                send(worker, { type: "cancel" });

                // A plugin that ignores cancellation is still stopped.
                setTimeout(() => finish(() => fail("Plugin cancelled.")), CANCEL_GRACE_MS);
            });

            // Anything written straight to a pipe (a stray console.log, a
            // crash) is still output and still gets masked.
            worker.stdout?.on("data", chunk => hooks.onLog(String(chunk), "stdout"));
            worker.stderr?.on("data", chunk => hooks.onLog(String(chunk), "stderr"));

            worker.on("message", (message: FromWorker) => {

                if (message.type === "log")
                    return hooks.onLog(message.text, message.stream);

                if (message.type === "session")
                    return hooks.onSession?.(message.id);

                if (message.type === "db")
                    return void this.answerDb(worker, message, hooks);

                if (message.type === "failed")
                    return finish(() => fail(message.message));

                if (message.type === "ready")
                    return send(worker, first);

                const reply = answer(message);

                if (reply)
                    finish(() => resolve(reply.value));
            });

            worker.on("error", error => {

                logger.error(`Plugin sandbox for '${modulePath}' failed: ${messageOf(error)}`);

                finish(() => fail(`Plugin sandbox failed: ${messageOf(error)}`));
            });

            worker.on("exit", code => {

                logger.error(
                    `Plugin sandbox for '${modulePath}' exited before returning a result (code ${code}).`);

                finish(() => fail(`The plugin's sandbox exited before returning a result (code ${code}).`));
            });
        });
    }

    /**
     * One `ctx.db` call from the worker, run by the host and answered by
     * id. The plugin never holds the connection; it holds a promise.
     */
    private async answerDb(
        worker: ChildProcess,
        message: Extract<FromWorker, { type: "db" }>,
        hooks: SandboxHooks
    ): Promise<void> {

        try {

            if (!hooks.onDb)
                throw new Error("This plugin has no database here.");

            const value = await hooks.onDb(message.op, message.sql, message.params);

            send(worker, { type: "dbResult", id: message.id, ok: true, value });

        } catch (error) {

            send(worker, { type: "dbResult", id: message.id, ok: false, error: messageOf(error) });
        }
    }

    /**
     * Reads are allowed for the worker script and the plugin's own root.
     * Everything else, including another plugin's folder, is denied by
     * Node. Nothing is granted for writing, spawning, or native addons.
     *
     * A single-file plugin is granted that one file and no directory: a
     * folder grant would hand it every neighbour.
     */
    protected permissionFlags(root: PluginRoot): string[] {

        return [
            "--permission",
            `--allow-fs-read=${this.workerPath}`,
            `--allow-fs-read=${root.kind === "directory" ? `${root.path}${path.sep}*` : root.path}`
        ];
    }

    /**
     * The environment the plugin's process gets, which is almost none.
     *
     * Node's permission model has no concept of environment variables.
     * Passing `process.env` through would let an undeclared plugin read
     * `process.env.SOME_TOKEN` directly and bypass `ctx.secret()`.
     *
     * The task's env and the declared secrets cross as data on the IPC
     * channel (see {@link SandboxedContextData}), filtered per plugin.
     * Only the variables Node itself needs are inherited, by name.
     */
    private environment(): NodeJS.ProcessEnv {

        // Only the named-and-set variables survive.
        const inherited = new EnvService({ allowed: RUNTIME_ENV, denied: [] }).allowedValues();

        // If the runtime is an Electron program, without this it opens a
        // window instead of behaving as Node.
        return { ...inherited, ELECTRON_RUN_AS_NODE: "1" };
    }
}

/**
 * The only host variables a sandboxed plugin's process inherits.
 *
 * `SystemRoot`/`windir`/`COMSPEC` are the ones Windows builds of Node
 * misbehave without; the temp and locale entries keep `os.tmpdir()` and
 * string formatting working on both platforms.
 *
 * `PATH` is left out. On Windows libuv still injects a fixed set into
 * every child whatever `env` says (`PATH`, `HOMEDRIVE`, `HOMEPATH`,
 * `LOGONSERVER`, `SYSTEMDRIVE`, `SYSTEMROOT`, `TEMP`, `USERDOMAIN`,
 * `USERNAME`, `USERPROFILE`, `WINDIR`). None of those is a credential.
 *
 * Adding a name here widens what every user plugin can read.
 */
const RUNTIME_ENV = [
    "SystemRoot",
    "windir",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL"
] as const;

export interface SandboxHooks {

    onLog(text: string, stream: "stdout" | "stderr" | "system"): void;

    /** An external, provider-owned conversation the sandboxed plugin opened. */
    onSession?(id: string): void;

    /** Registers a callback the sandbox invokes to stop the plugin. Absent for a handle, which nothing cancels. */
    onCancel?(stop: () => void): void;

    /** Runs one `ctx.db` call on the host. Absent means the plugin has no database. */
    onDb?(op: "run" | "get" | "all", sql: string, params?: unknown[] | Record<string, unknown>): Promise<unknown>;
}

const DESCRIBE_TIMEOUT_MS = 10_000;

const CANCEL_GRACE_MS = 2_000;

function send(worker: ChildProcess, message: ToWorker): void {

    if (worker.connected)
        worker.send(message);
}

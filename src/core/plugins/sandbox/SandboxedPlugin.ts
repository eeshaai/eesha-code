import { Plugin, PluginApp, PluginContext, PluginDb, PluginHandleContext, PluginRequest, PluginResult } from "../Plugin";
import { secretNamesOf } from "../secretNames";
import { PluginRoot, PluginSandbox } from "./PluginSandbox";
import { PluginDescription, SandboxedHandleContextData } from "./protocol";

/**
 * A user plugin, as the engine sees it.
 *
 * Satisfies `Plugin`, so the registry, the host, and input validation
 * are unchanged. `execute` never runs the author's code here: it hands
 * the args to a sandboxed process and waits for plain JSON back.
 *
 * The metadata is a snapshot taken at load time. The engine needs
 * `args`/`artifacts` to validate a task before running it, and reading
 * them live would mean running the plugin.
 */
export class SandboxedPlugin implements Plugin {

    public readonly id: string;

    public readonly version: string;

    public readonly description?: string;

    public readonly args?: Plugin["args"];

    public readonly artifacts?: readonly string[];

    public readonly artifactsFrom?: string;

    /** Env var names this plugin declared. Only these are handed over - see {@link secretsFor}. */
    public readonly secrets: readonly string[];

    /** An input naming one more, chosen by the workflow rather than the plugin. */
    public readonly secretsFrom?: string;

    public readonly ui?: PluginApp;

    /**
     * Present only when the module exports `handle`, so a caller can
     * tell "this plugin has no app back end" from "the call failed"
     * without starting a process to find out.
     */
    public readonly handle?: (request: PluginRequest, ctx: PluginHandleContext) => Promise<unknown>;

    constructor(
        described: PluginDescription,
        private readonly modulePath: string,
        /** Everything this plugin may read. Carried per plugin, never re-derived. */
        private readonly pluginRoot: PluginRoot,
        private readonly sandbox: PluginSandbox
    ) {

        this.id = described.id;
        this.version = described.version;
        this.description = described.description;
        this.args = described.args;
        this.artifacts = described.artifacts;
        this.artifactsFrom = described.artifactsFrom;
        this.secrets = described.secrets ?? [];
        this.secretsFrom = described.secretsFrom;
        this.ui = described.ui;

        if (described.hasHandle)
            this.handle = (request, ctx) => this.sandbox.handle(
                this.modulePath,
                this.pluginRoot,
                request,
                this.handleData(ctx, this.secretsFor(ctx, {})),
                {
                    onLog: (text, stream) => ctx.log(text, stream),
                    onDb: dbHook(ctx.db)
                });
    }

    public execute(args: Record<string, unknown>, ctx: PluginContext): Promise<PluginResult> {

        return this.sandbox.execute(
            this.modulePath,
            this.pluginRoot,
            args,
            {
                ...this.handleData(ctx, this.secretsFor(ctx, args)),
                runId: ctx.runId,
                taskId: ctx.taskId,
                attempt: ctx.attempt
            },
            {
                onLog: (text, stream) => ctx.log(text, stream),
                onSession: id => ctx.reportSession(id),
                onCancel: stop => ctx.onCancel(stop),
                onDb: dbHook(ctx.db)
            });
    }

    /** The data half of a context, as it crosses to the worker. */
    private handleData(ctx: PluginHandleContext, secrets: Record<string, string>): SandboxedHandleContextData {

        return {
            cwd: ctx.cwd,
            root: ctx.root,
            env: { ...ctx.env },
            secrets,
            hasDb: ctx.db !== undefined
        };
    }

    /**
     * Resolves exactly the secrets this plugin declared, and no others.
     *
     * Read through `ctx.secret` rather than the environment directly, so
     * each one is registered with the run's masker. A sandboxed plugin
     * that echoes a token still gets it redacted.
     *
     * `secretsFrom` adds one name taken from an input. The args are
     * already resolved here, so the name is a value, not an expression.
     */
    private secretsFor(ctx: PluginHandleContext, args: Record<string, unknown>): Record<string, string> {

        const resolved: Record<string, string> = {};

        for (const name of secretNamesOf(this, args)) {

            const value = ctx.secret(name);

            if (value !== undefined)
                resolved[name] = value;
        }

        return resolved;
    }
}

/** The worker's `ctx.db` calls, run against the host's database for this plugin. */
function dbHook(db: PluginDb | undefined) {

    if (!db)
        return undefined;

    return (op: "run" | "get" | "all", sql: string, params?: unknown[] | Record<string, unknown>): Promise<unknown> =>
        db[op](sql, params);
}

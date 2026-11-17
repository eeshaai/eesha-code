import { PluginApp, PluginArgSchema, PluginRequest, PluginResult } from "../Plugin";

/**
 * Everything that crosses the sandbox boundary.
 *
 * Plain JSON only. No object reference may cross: a plugin holding one
 * of our objects can reach `constructor.constructor` and from there the
 * host's `process`.
 */

/** What a worker reports about a plugin without running it. */
export interface PluginDescription {

    /**
     * Whether Node's permission model was active in the worker that
     * produced this.
     *
     * Reported rather than assumed: the module allowlist alone can be
     * bypassed (sandboxEscape.test.ts shows three ways with permissions
     * off). False means refuse to load.
     */
    enforced: boolean;

    id: string;

    version: string;

    description?: string;

    args?: PluginArgSchema;

    artifacts?: readonly string[];

    /**
     * A name, not a callback, so it survives the trip and a sandboxed
     * plugin stays validatable.
     */
    artifactsFrom?: string;

    /**
     * Env var names this plugin may read through `ctx.secret()`. The
     * sandbox hands over a fixed map, not `process.env`, so the list
     * must be declared.
     */
    secrets?: readonly string[];

    /**
     * The input naming one further variable, chosen by the workflow. The
     * host resolves it before building the map, so the worker still
     * receives a fixed set.
     */
    secretsFrom?: string;

    /** The plugin's own app, when its module declares one. The manifest wins when both do. */
    ui?: PluginApp;

    /** Whether the module exports `handle` - a function cannot cross, so the fact is sent instead. */
    hasHandle: boolean;
}

/** Host -> worker. */
export type ToWorker =
    | {
        type: "execute";
        args: Record<string, unknown>;
        context: SandboxedContextData;
    }
    | {
        type: "handle";
        request: PluginRequest;
        context: SandboxedHandleContextData;
    }

    /** The host's answer to a `db` message, by id. */
    | { type: "dbResult"; id: number; ok: boolean; value?: unknown; error?: string }
    | { type: "cancel" };

/** The part of a handle's context that is data rather than behaviour. */
export interface SandboxedHandleContextData {

    cwd: string;

    root: string;

    env: Record<string, string>;

    /** Only the names the plugin declared, resolved and already registered with the run's masker. */
    secrets: Record<string, string>;

    /** Whether the host has a database for this plugin. False leaves `ctx.db` absent. */
    hasDb: boolean;
}

/** The part of `PluginContext` that is data rather than behaviour. */
export interface SandboxedContextData extends SandboxedHandleContextData {

    runId: string;

    taskId: string;

    attempt: number;
}

/** Worker -> host. */
export type FromWorker =
    | { type: "ready" }
    | { type: "log"; text: string; stream: "stdout" | "stderr" | "system" }
    | { type: "session"; id: string }
    | { type: "result"; result: PluginResult }

    /** `handle`'s answer. */
    | { type: "handled"; value: unknown }

    /** One `ctx.db` call, answered by a `dbResult` with the same id. */
    | { type: "db"; id: number; op: "run" | "get" | "all"; sql: string; params?: unknown[] | Record<string, unknown> }
    | { type: "failed"; message: string };

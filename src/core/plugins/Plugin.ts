import { LogMeta } from "../models/run";

/**
 * Declared shape of a plugin's `args:`.
 *
 * Used to validate a task before it runs and to render a form when a
 * human reviews or supplies those args - which is why `description`
 * matters even though nothing enforces it.
 */
export interface PluginArgSchema {

    [name: string]: {

        /**
         * `object` is a map the plugin interprets itself. The engine only
         * checks that it is a map; the plugin validates what is inside.
         */
        type: "string" | "number" | "boolean" | "string[]" | "object" | "array";

        required?: boolean;

        /** Shown in the UI when this input is collected from or reviewed by a human. */
        description?: string;

        /** Applied when the task omits this input. */
        default?: unknown;

        /**
         * The only values this input accepts. A constraint on a `string`,
         * not a type of its own. Checked when the file is read and again
         * when the value arrives, because a `${{ }}` expression is only
         * known at the second one.
         */
        options?: readonly string[];

        /**
         * A hint that this input holds many lines, so a form gives it a
         * multi-line box rather than a single-line box. Rendering only - it says
         * nothing about what values are legal.
         */
        multiline?: boolean;

        /**
         * `false` keeps this input's value out of the run log's `Args:`
         * block. On by default. For a value the plugin itself writes to
         * the log in a better form, like `ai@1` logging the full prompt
         * it sent.
         */
        logged?: boolean;
    };
}

/**
 * A tab a plugin asks the run panel to show for its step. Content only,
 * never code: the plugin picks one of these shapes and the panel draws
 * it with its own components. A plugin running in the sandbox cannot be
 * handed the page, and a plugin handing back HTML or a script would
 * run with the panel's own access, which undoes the sandbox.
 */
export type PluginUi =
    | { type: "markdown"; label: string; content: string }
    | { type: "table"; label: string; columns: string[]; rows: unknown[][] }
    | { type: "json"; label: string; content: unknown };

export const PLUGIN_UI_TYPES: readonly PluginUi["type"][] = ["markdown", "table", "json"];

/**
 * A plugin's own app: an HTML page it ships in its folder, shown in a
 * tab of the run panel and the spec panel whether or not the plugin is
 * running. Declared in `plugin.json` as `ui`. The page talks to the
 * engine through `window.eesha` - see `eeshaClient.ts`.
 */
export interface PluginApp {

    /** The tab's name. */
    label: string;

    /** The page, relative to the plugin's folder. Defaults to `ui/index.html`. */
    entry: string;

    /**
     * Which panel the tab belongs in. `both` by default. A page about
     * runs (a release picker) says `run`; one about specs says `spec`.
     */
    surface: PluginAppSurface;
}

export type PluginAppSurface = "run" | "spec" | "both";

export const PLUGIN_APP_SURFACES: readonly PluginAppSurface[] = ["run", "spec", "both"];

/**
 * The plugin's own storage: one SQLite file per plugin id, opened by the
 * host and handed over as these three calls. A plugin never sees the
 * file or the connection, so one plugin cannot reach another's tables
 * and a typo in one cannot touch the run history.
 *
 * `params` is positional (`?`) as an array, or named (`$name`, `:name`)
 * as an object.
 */
export interface PluginDb {

    /** A statement that changes rows - `CREATE`, `INSERT`, `UPDATE`, `DELETE`. */
    run(sql: string, params?: unknown[] | Record<string, unknown>): Promise<{ changes: number; lastInsertRowid: number | bigint }>;

    /** The first row, or undefined. */
    get(sql: string, params?: unknown[] | Record<string, unknown>): Promise<Record<string, unknown> | undefined>;

    /** Every row. */
    all(sql: string, params?: unknown[] | Record<string, unknown>): Promise<Record<string, unknown>[]>;
}

/** What a plugin's app sends to its own `handle` - a name and whatever the app chose to attach. */
export interface PluginRequest {

    name: string;

    payload?: unknown;
}

/**
 * What `handle` gets: the part of {@link PluginContext} that exists
 * without a task. No run id, no task id, no attempt - nothing is
 * running; a person clicked something in the plugin's tab.
 */
export type PluginHandleContext = Pick<PluginContext, "cwd" | "root" | "env" | "secret" | "log" | "db">;

export interface PluginResult {

    success: boolean;

    /** Stored under the task's `artifact:`. Must not contain secrets. */
    artifacts?: Record<string, unknown>;

    /** Short human-readable reason, surfaced in the run panel on failure. */
    message?: string;


    /**
     * An external conversation this task held, owned by the provider
     * (a Copilot CLI session, a vendor's agent thread). Not part of
     * `artifacts:` because nothing downstream templates against it. The
     * engine records it on the task's row so the page can offer to
     * reopen it, and ignores it otherwise.
     */
    session?: { id: string };

    /**
     * A tab for this step in the run panel - see {@link PluginUi}. Not
     * an artifact: nothing downstream reads it, a person does. Held for
     * the session only, not written to the run store. NO SECRETS.
     */
    ui?: PluginUi;
}

/**
 * Everything a plugin may touch.
 *
 * Kept narrow on purpose. Passing capabilities in means this surface
 * can be tightened later without breaking existing plugins.
 */
export interface PluginContext {

    readonly runId: string;

    readonly taskId: string;

    /** 1 on first execution, higher when a failed task is retried. */
    readonly attempt: number;

    readonly cwd: string;

    /** The workflow file's own directory - the run's starting cwd. */
    readonly root: string;

    /** Resolved non-secret env for this task. */
    readonly env: Readonly<Record<string, string>>;


    /**
     * Reads a secret by env var name at call time. Never cached, never
     * logged - and registered with the run's masker on the way out, so
     * it is redacted if it ever reaches the log.
     */
    secret(name: string): string | undefined;

    /**
     * Hands a value the plugin already holds to the run's masker, for
     * values that arrive by some route other than {@link secret}.
     * Optional: the sandbox does not carry it, so a plugin must work
     * without it. It protects the log; the work must not depend on it.
     */
    registerSecret?(value: string): void;

    /**
     * One line of the task's log. `meta` says what the line is when the
     * plugin knows (an agent event's kind, the sub-agent that spoke).
     */
    log(text: string, stream?: "stdout" | "stderr" | "system", meta?: LogMeta): void;

    /**
     * Reports an external, provider-owned conversation the moment it
     * opens - see {@link PluginResult.session}. A call rather than only
     * a return value so the page can offer to open the session while
     * the agent is still working.
     */
    reportSession(id: string): void;

    // There is no `ask()` for a mid-run question to a human. Approval is
    // `trigger: manual`, which blocks between tasks, so it holds nothing
    // in memory, needs no timeout, and survives closing the app.

    /**
     * This plugin's own SQLite tables - see {@link PluginDb}. Absent
     * when the engine has no database directory (a test, a CLI run with
     * nowhere to write).
     */
    readonly db?: PluginDb;

    readonly cancelled: boolean;

    onCancel(handler: () => void): void;
}

/**
 * A workflow task implementation, resolved from a `uses: <id>@<version>`
 * reference.
 *
 * A plugin *is* a task, in the same sense as an Azure DevOps task or a
 * GitHub Action - not a library a task calls.
 */
export interface Plugin<TInputs = Record<string, unknown>> {

    readonly id: string;

    readonly version: string;

    /** Shown in error messages and any future plugin listing. */
    readonly description?: string;

    /** Declared args, used to validate `args:` and to render a form in the UI. */
    readonly args?: PluginArgSchema;

    /**
     * Env var names this plugin may read through {@link PluginContext.secret}.
     * A sandboxed plugin gets exactly these and nothing else; it cannot
     * reach `process.env`.
     */
    readonly secrets?: readonly string[];

    /**
     * The name of an input whose string value is a further env var name
     * this plugin may read - for a credential whose name the workflow
     * chooses (`ADO_PAT` on one machine, `TEAM_ADO_PAT` on another).
     *
     * Data, like {@link artifactsFrom}, so it crosses the sandbox
     * boundary and only declared names are ever handed over. The input's
     * `default` applies when a workflow says nothing.
     *
     * Read through `secretNamesOf`, never directly.
     */
    readonly secretsFrom?: string;

    /**
     * Artifact keys this plugin can produce. Declared so `artifact:` and
     * every `${{ run.context.X.key }}` reference can be validated when the
     * file is read.
     */
    readonly artifacts?: readonly string[];

    /**
     * The name of an input whose `string[]` value is this plugin's output
     * keys, for a plugin whose caller chooses them.
     *
     * Data rather than a callback because a function cannot cross the
     * sandbox boundary.
     *
     * Read through {@link outputKeysOf}, never directly - the input may
     * be omitted (the schema's `default` decides) or be a `${{ }}`
     * expression (nothing can be decided).
     */
    readonly artifactsFrom?: string;

    /**
     * Whether an arg this plugin does not declare is handed over rather
     * than rejected.
     *
     * Off for a plugin that owns its whole surface, where an undeclared
     * arg is a typo. On for a plugin that fronts a vendor SDK with many
     * fast-changing options (`ai@1`), where restating them here would
     * mean a build per new switch. The cost: a misspelled arg reaches the
     * vendor instead of being caught here. So it is opt-in per plugin.
     */
    readonly passthrough?: boolean;

    /** The plugin's own app, when it ships one - see {@link PluginApp}. */
    readonly ui?: PluginApp;

    execute(args: TInputs, ctx: PluginContext): Promise<PluginResult>;

    /**
     * The app's back end. The plugin's tab calls `eesha.call(name, payload)`
     * and this answers it: request in, value out, and for a sandboxed
     * plugin a fresh process each time - the same rule as `execute`.
     * Whatever it returns is handed back to the page as JSON.
     */
    handle?(request: PluginRequest, ctx: PluginHandleContext): Promise<unknown>;
}

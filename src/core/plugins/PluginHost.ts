import * as path from "path";

import { Providers } from "../agent/providerArgs";
import { applyProviderBlock, PROVIDERS_KEY, refuseUnknownProviders } from "../agent/providerBlocks";
import { CALLER_ORIGIN } from "../execution/callbacks";
import { EnvService } from "../env/envService";
import { WORKFLOWS_DIR } from "../loader/constants";
import { EnvVars, Task, Vars } from "../models/task";
import { LogMeta } from "../models/run";
import { ParamValue } from "../models/workflowTypes";
import { readableEnv, RunStamps, TemplateResolver, TemplateScope } from "../templating/TemplateResolver";
import { isFileArg, parseFileArg, readFileArg } from "./fileArg";
import { isLiteralArg } from "./literalArg";
import { getLogger } from "../logging/logger";
import {
    Plugin, PluginContext, PluginArgSchema, PluginHandleContext, PluginRequest, PluginUi, PLUGIN_UI_TYPES
} from "./Plugin";
import { PluginDatabase } from "./PluginDatabase";
import { parsePluginRef } from "./PluginRef";
import { PluginRegistry } from "./PluginRegistry";

const logger = getLogger("PluginHost");

/** How one attempt ended - what the retry loop decides from. */
export interface TaskResult {

    success: boolean;

    /** Set by a `uses:` task, to be stored under the task's `artifact:`. */
    artifacts?: Record<string, unknown>;


    /** An external, provider-owned conversation the plugin held - see `PluginResult.session`. */
    session?: { id: string };

    /** A tab for this step in the run panel - see `PluginResult.ui`. Already checked for shape. */
    ui?: PluginUi;

    /** The task hit its `timeout:` and was killed. Distinct from failing on its own terms. */
    timedOut?: boolean;
}

/**
 * What one attempt runs against - built by TaskRunner, consumed here.
 * Defined here so `plugins/` never has to import `runner/`.
 */
export interface TaskExecutionContext {

    runId: string;

    /** Opaque, produced by the walker. Stable for this task within this run. */
    taskId: string;

    /** 1 on first execution; higher when a failed task is retried. */
    attempt: number;

    ownerId: string;

    taskIndex: number;

    /** Working directory to run in when the task doesn't override it - what `${{ cwd }}` means before this task's own `cwd:`. */
    cwd: string;

    /** The directory of the file being run - what seeds `${{ cwd }}` at the top level. */
    root: string;

    /** Where the app was started, or where a CLI was invoked - available as `${{ workspaceFolder }}`. */
    workspace: string;

    /** The person's home directory - available as `${{ home }}`. Injected so a test can pin it. */
    home: string;

    /** Env vars inherited from the level above, before this task's own `env:` is merged in. */
    env: EnvVars;

    /** Vars inherited from the level above, before this task's own `vars:` is merged in. */
    vars?: Vars;

    /** The real environment, so `${{ env.PATH }}` resolves. Injected rather than read here, so a test can pin it. */
    processEnv: EnvVars;


    /**
     * What the run was asked for at start, readable as `${{ params.NAME }}`.
     * Absent for the inline engine, which declares no `params:`, so an
     * expression there fails with "params are not available here".
     */
    params?: Record<string, ParamValue>;

    /** Run variables set by earlier tasks, readable as `${{ run.context.NAME }}`. */
    runVariables?: Record<string, unknown>;

    /** A `foreach:` task's loop variables - `${{ item }}` and its index. See TemplateScope.items. */
    items?: Record<string, unknown>;

    /** The run's stamps, minted once at run start - readable bare, like the anchors. */
    stamps?: RunStamps;

    /** The settled `variables` section of settings.json - readable bare, by top-level name. See TemplateScope.variables. */
    variables?: Record<string, unknown>;

    /**
     * Where a dotenv problem goes. Defaults to a plain `onOutput` line
     * when absent; supplied by a caller that wants one missing file
     * reported once per run, not once per task.
     */
    onProblem?(message: string): void;

    onOutput(text: string, stream: "stdout" | "stderr" | "system", meta?: LogMeta): void;

    /** Where a plugin's `reportSession` lands - see `PluginContext.reportSession`. */
    onSession?(id: string): void;

    /**
     * The task's `args:` as the plugin is about to receive them: the same
     * object handed to `plugin.execute`, after templating, file-arg
     * reading and schema defaults. NO SECRETS - the caller supplying this
     * masks it like log output.
     *
     * Never called for a task whose args fail to resolve, or one that
     * never runs.
     *
     * `origins` names where each value came from, keyed by arg name - the
     * same map the provenance log line prints.
     */
    onArgs?(args: Record<string, unknown>, origins?: Record<string, string>): void;

    /**
     * This task's own resolved level - see `TaskContext`. Reported by the
     * executor once it has merged the task's `vars:`, `env:` and `cwd:`
     * over its job's and the file's.
     */
    onContext?(cwd: string, vars: Vars, env: EnvVars): void;

    /** Returns the currently running process handle so it can be killed on stop. */
    registerKill(kill: () => void): void;

    /**
     * Hands a secret value to the run's masker, so it is redacted if it
     * ever reaches a log line. Called by `ctx.secret()`, never by a task.
     */
    registerSecret?(value: string | undefined): void;

    /** Lets a plugin be told to wind down when the run is stopped. */
    registerCancel?(onCancel: () => void): void;

    isCancelled?(): boolean;
}

export interface ResolvedInputs {

    success: boolean;

    args?: Record<string, unknown>;

    /**
     * Where each arg's value came from, keyed by arg name: the caller's
     * own `args:`, a settings.json default (named by file), or the
     * plugin manifest's default. Ready to log.
     */
    origins?: Record<string, string>;

    /** Which scope declared a settings.json default, keyed by arg name - for a compact log tag. Absent for a task-arg or manifest-default origin. */
    scopes?: Record<string, "workspace" | "profile">;

    /** Why resolution failed, ready to log. */
    message?: string;
}

/**
 * The `ai:` section's per-plugin defaults, as {@link PluginHost} needs
 * them: the values, and per key the settings file that declared it.
 *
 * Same shape as the engine settings' `AiSettings`, declared here rather
 * than imported so the host does not depend on the settings module.
 */
export interface SettingsPluginDefaults {

    /** Default args keyed by plugin reference (`"ai@1"`), then by arg name. */
    defaults: Record<string, Record<string, unknown>>;

    /** The declaring settings file, mirroring `defaults` key for key. */
    defaultSources: Record<string, Record<string, string>>;

    /** Which of the two scopes declared it, mirroring `defaults` key for key. */
    defaultScopes?: Record<string, Record<string, "workspace" | "profile">>;

    /**
     * `ai.acpAgents`, merged. Only the ids are read: with the built-in
     * runtimes they are what a `providers:` block may be keyed by.
     * Absent, block ids are not checked.
     */
    acpAgents?: Record<string, unknown>;

    /**
     * `ai.providers` - the runtimes the org uses. When set, it is what a
     * block may be keyed by and what a step may run on, in place of
     * every known runtime.
     */
    providers?: string[];
}

/**
 * Turns a `uses:` task into a plugin call: resolves the reference,
 * templates and validates its `args:`, builds the narrow
 * {@link PluginContext}, and runs it.
 */
export class PluginHost {

    private readonly templateResolver = new TemplateResolver();

    /** The settings.json defaults a run starts under - see {@link refreshPluginDefaults}. */
    private pluginDefaults?: SettingsPluginDefaults;

    /**
     * @param database Plugin storage, when the engine has somewhere to
     * keep it. Absent leaves `ctx.db` off every context.
     */
    constructor(
        private readonly registry: PluginRegistry,
        private readonly database?: PluginDatabase
    ) {}

    /** Every plugin that ships an app - for the panels that show them. */
    public get plugins(): PluginRegistry {

        return this.registry;
    }

    /**
     * Answers one request from a plugin's own tab - see `Plugin.handle`.
     * Throws when the reference is unknown or the plugin has no `handle`,
     * and whatever the plugin itself throws.
     *
     * The context is the workspace's, not a task's: nothing is running.
     * Secrets resolve the same way as for a task; the log goes to the
     * engine's own channel, since there is no task log to put it in.
     */
    public async handle(ref: string, request: PluginRequest, where: { cwd: string; root: string }): Promise<unknown> {

        const parsed = parsePluginRef(ref);

        const plugin = parsed ? this.registry.resolve(parsed) : undefined;

        if (!plugin)
            throw new Error(`No plugin found for '${ref}'.`);

        if (!plugin.handle)
            throw new Error(`Plugin '${ref}' has no 'handle(request, ctx)', so its tab has nothing to call.`);

        const ctx: PluginHandleContext = {
            cwd: where.cwd,
            root: where.root,
            env: {},
            secret: name => new EnvService({ allowed: [name], denied: [] }).allowedValues()[name],
            log: (text, stream = "stdout") => {

                const line = `[${ref}] ${text.trimEnd()}`;

                if (stream === "stderr")
                    logger.warning(line);
                else
                    logger.info(line);
            },
            ...(this.database ? { db: this.database.for(plugin.id) } : {})
        };

        return plugin.handle(request, ctx);
    }

    /**
     * Hands the host settings.json's per-plugin defaults, read fresh by
     * whoever starts a run.
     *
     * Pushed in rather than loaded here: the host resolves args
     * synchronously, and one read per run means the gate preview and the
     * run itself see the same values.
     */
    public refreshPluginDefaults(defaults: SettingsPluginDefaults | undefined): void {

        this.pluginDefaults = defaults;
    }

    public async execute(task: Task, context: TaskExecutionContext): Promise<TaskResult> {

        const ref = parsePluginRef(task.plugin);

        if (!ref) {

            context.onOutput(
                `Invalid plugin reference '${task.plugin}' - expected the form 'id@version'.`,
                "system"
            );

            return { success: false };
        }

        const plugin = this.registry.resolve(ref);

        if (!plugin) {

            const known = this.knownRefs();

            context.onOutput(
                `No plugin found for '${task.plugin}'.` +
                (known.length ? ` Available: ${known.join(", ")}.` : " No plugins are registered."),
                "system"
            );

            return { success: false };
        }

        const resolved = this.resolveInputs(task, context, plugin);

        if (!resolved.success) {

            context.onOutput(resolved.message!, "system");

            return { success: false };
        }

        context.onOutput(`Run ${task.plugin}`, "system");

        // Where it runs, and the constants it can read. Logged here
        // rather than in the runner so an SDD phase, which calls this
        // same host, gets it too. Env is not logged; the Env tab holds it.
        context.onOutput(describeAnchors(context), "system");

        const constants = describeValues("Vars", context.vars ?? {});

        if (constants)
            context.onOutput(constants, "system");

        // Every arg the plugin is about to receive, each naming its source.
        const provenance = describeArgSources(
            resolved.args!, resolved.origins, resolved.scopes, plugin.args);

        if (provenance)
            context.onOutput(provenance, "system");

        // After resolution and before execution, so these are exactly the
        // values the plugin is handed.
        context.onArgs?.(resolved.args!, resolved.origins);

        try {

            const result = await plugin.execute(resolved.args!, this.buildContext(context, plugin));

            // Newline-terminated because this is a whole message, not a
            // stream chunk: without it the line buffer holds it back
            // waiting for a terminator that never comes.
            if (result.message)
                context.onOutput(`${result.message}\n`, result.success ? "system" : "stderr");

            // A malformed `ui` is dropped and said so, not thrown: the
            // work is done and the tab is a courtesy on top of it.
            const uiProblem = result.ui === undefined ? undefined : uiProblemOf(result.ui);

            if (uiProblem)
                context.onOutput(`Plugin '${task.plugin}' returned a 'ui' the panel cannot draw - ${uiProblem}\n`, "stderr");

            return {
                success: result.success,
                artifacts: result.artifacts,
                session: result.session,
                ui: uiProblem ? undefined : result.ui
            };

        } catch (error) {

            // Masked on the way out - a plugin that interpolated a secret
            // into its own error message must not leak it here.
            context.onOutput(
                `Plugin '${task.plugin}' threw: ${error instanceof Error ? error.message : String(error)}`,
                "system"
            );

            return { success: false };
        }
    }

    /**
     * Resolves a task's `args:` without executing it. Public so a manual
     * gate can show the human the exact values the plugin will receive.
     */
    public resolveInputs(
        task: Task,
        context: TaskExecutionContext,
        plugin?: Plugin
    ): ResolvedInputs {

        const target = plugin ?? this.pluginFor(task);

        const scope: TemplateScope = {
            workspaceFolder: context.workspace,
            workspaceConfig: path.join(context.workspace, WORKFLOWS_DIR),
            home: context.home,
            cwd: context.cwd,
            params: context.params,
            vars: context.vars ?? {},
            // Same view a `run:` cmd gets - a template reading
            // `${{ env.PATH }}` must not have to redeclare it just
            // because it sits in an arg.
            env: readableEnv(context.processEnv, context.env),
            run: context.runVariables ?? {},
            stamps: context.stamps,
            items: context.items,
            variables: context.variables
        };

        const resolved: Record<string, unknown> = {};

        const origins: Record<string, string> = {};

        const scopes: Record<string, "workspace" | "profile"> = {};

        for (const [name, value] of Object.entries(task.args ?? {})) {

            try {

                resolved[name] = this.resolveInputValue(value, scope, context);

                origins[name] = CALLER_ORIGIN;

            } catch (error) {

                return {
                    success: false,
                    message: `Failed to resolve arg '${name}': ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }

        // settings.json defaults fill what the caller left unset. They
        // rank above the manifest's own defaults and never override a
        // task arg.
        if (task.plugin) {

            let declared = this.pluginDefaults?.defaults[task.plugin] ?? {};

            // `providers:` blocks, on a plugin that runs on a runtime:
            // the caller's own block goes over the caller's flat keys,
            // settings.json's over settings.json's, and only then do the
            // defaults fill what is still unset - so a step's own flat
            // `model` still beats a settings.json block. Every other
            // runtime's block is dropped, and the plugin never sees
            // `providers` itself.
            const runtimeArg = target?.args?.provider;

            // What a block may be keyed by and a step may run on: the
            // org's own list, else every runtime this build knows.
            const acp = this.pluginDefaults?.acpAgents;

            const allowed = this.pluginDefaults?.providers
                ?? (acp ? [...new Set([...Providers, ...Object.keys(acp)])] : undefined);

            const runtime = runtimeArg
                ? [resolved.provider, declared.provider, runtimeArg.default]
                    .find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim()
                : undefined;

            // A step naming a runtime the org does not use. Only against
            // the org's own list: without one, an unknown runtime is the
            // plugin's to refuse, naming the ones it has.
            if (runtime && this.pluginDefaults?.providers && !this.pluginDefaults.providers.includes(runtime))
                return {
                    success: false,
                    message: `This step runs on '${runtime}', which is not in ai.providers. `
                        + `Use one of: ${this.pluginDefaults.providers.join(", ")}.`
                };

            if (runtimeArg && (PROVIDERS_KEY in resolved || PROVIDERS_KEY in declared)) {

                try {

                    if (allowed) {

                        refuseUnknownProviders(resolved, allowed, "This step's args");
                        refuseUnknownProviders(declared, allowed, `settings.json's ai."${task.plugin}"`);
                    }

                } catch (error) {

                    return { success: false, message: error instanceof Error ? error.message : String(error) };
                }

                if (runtime) {

                    const own = applyProviderBlock(resolved, runtime);

                    delete resolved[PROVIDERS_KEY];

                    for (const [name, value] of Object.entries(own)) {

                        origins[name] ??= CALLER_ORIGIN;
                        resolved[name] = value;
                    }

                    declared = applyProviderBlock(declared, runtime);
                }
            }

            const sources = this.pluginDefaults?.defaultSources[task.plugin];
            const declaredScopes = this.pluginDefaults?.defaultScopes?.[task.plugin];

            for (const [name, value] of Object.entries(declared)) {

                if (resolved[name] !== undefined)
                    continue;

                resolved[name] = value;

                // A key that came out of a `providers:` block is sourced
                // to the file that declared the block.
                origins[name] = `settings.json default `
                    + `(${sources?.[name] ?? sources?.[PROVIDERS_KEY] ?? "settings.json"})`;

                scopes[name] = declaredScopes?.[name] ?? declaredScopes?.[PROVIDERS_KEY] ?? "workspace";
            }
        }

        if (!target)
            return { success: true, args: resolved, origins, scopes };

        return this.applySchema(
            resolved, origins, scopes, target.args, task.plugin!, target.passthrough === true);
    }

    /**
     * One arg value, at any depth.
     *
     * A file-shaped value becomes the file's content before the plugin
     * runs; a required file that is missing fails here with the path
     * named. Walked recursively so a file can sit inside a map arg. File
     * content is never re-resolved, so `${{ }}` text inside a document
     * stays exactly what was on disk. A literal-shaped value is the
     * same rule for text a caller built in code - see literalArg.ts.
     */
    private resolveInputValue(
        value: unknown,
        scope: TemplateScope,
        context: TaskExecutionContext
    ): unknown {

        if (isLiteralArg(value))
            return value.literal;

        if (isFileArg(value)) {

            const input = parseFileArg(value);

            const resolvedPath = String(this.templateResolver.resolveValue(input.file, scope));

            const anchored = path.isAbsolute(resolvedPath)
                ? resolvedPath
                : path.join(context.workspace, resolvedPath);

            return readFileArg(input, anchored);
        }

        if (Array.isArray(value))
            return value.map(item => this.resolveInputValue(item, scope, context));

        if (value && typeof value === "object") {

            const walked: Record<string, unknown> = {};

            for (const [key, item] of Object.entries(value))
                walked[key] = this.resolveInputValue(item, scope, context);

            return walked;
        }

        // Typed: `retries: ${{ vars.retries }}` hands over the number 3,
        // not the string "3", so an arg schema can check it as one.
        return this.templateResolver.resolveValue(value, scope);
    }

    /** The plugin a task refers to, if the reference is valid and registered. */
    public pluginFor(task: Task): Plugin | undefined {

        const ref = parsePluginRef(task.plugin);

        return ref ? this.registry.resolve(ref) : undefined;
    }

    /** Every registered `id@version`, so a validator can list what is available. */
    public knownRefs(): string[] {

        return this.registry.keys();
    }

    private applySchema(
        resolved: Record<string, unknown>,
        origins: Record<string, string>,
        scopes: Record<string, "workspace" | "profile">,
        schema: PluginArgSchema | undefined,
        plugin: string,
        passthrough = false
    ): ResolvedInputs {

        if (!schema)
            return { success: true, args: resolved, origins, scopes };

        const withDefaults = { ...resolved };

        for (const [name, declared] of Object.entries(schema)) {

            if (withDefaults[name] === undefined && declared.default !== undefined) {

                withDefaults[name] = declared.default;
                origins[name] = "plugin manifest default";
            }

            const value = withDefaults[name];

            if (value === undefined) {

                if (declared.required)
                    return { success: false, message: `Plugin '${plugin}' requires the arg '${name}'.` };

                continue;
            }

            if (!this.matchesType(value, declared.type))
                return {
                    success: false,
                    message: `Arg '${name}' of '${plugin}' must be a ${declared.type}, but got ${typeof value}.`
                };

            // Checked here as well as in the validator because this is
            // where a `${{ }}` expression has become a value.
            if (declared.options && !declared.options.includes(value as string))
                return {
                    success: false,
                    message: `Arg '${name}' of '${plugin}' is '${String(value)}', which is not one of: ` +
                        `${declared.options.join(", ")}.`
                };
        }

        const unknown = Object.keys(withDefaults).filter(name => !(name in schema));

        // A passthrough plugin hands on what it does not recognise - see
        // `Plugin.passthrough`. Declared args are still checked above.
        if (unknown.length && !passthrough)
            return {
                success: false,
                message: `Plugin '${plugin}' has no input named '${unknown[0]}'. ` +
                    `It accepts: ${Object.keys(schema).join(", ") || "(none)"}.`
            };

        return { success: true, args: withDefaults, origins, scopes };
    }

    private matchesType(value: unknown, type: PluginArgSchema[string]["type"]): boolean {

        switch (type) {

            case "string": return typeof value === "string";
            case "number": return typeof value === "number" && !Number.isNaN(value);
            case "boolean": return typeof value === "boolean";
            case "string[]": return Array.isArray(value) && value.every(item => typeof item === "string");
            // A map, not an array or null - both are `typeof "object"`.
            case "object": return typeof value === "object" && value !== null && !Array.isArray(value);

            // A list of anything. The plugin validates the elements.
            case "array": return Array.isArray(value);
        }
    }

    private buildContext(context: TaskExecutionContext, plugin: Plugin): PluginContext {

        const cancelHandlers: (() => void)[] = [];

        context.registerCancel?.(() => {

            for (const handler of cancelHandlers)
                try {

                    handler();

                } catch {

                    // One handler failing must not stop the others.
                }
        });

        return {

            runId: context.runId,
            taskId: context.taskId,
            attempt: context.attempt,
            cwd: context.cwd,
            root: context.root,
            env: context.env,

            secret: name => {

                // Reads the one name asked for, through the EnvService
                // rather than `process.env`. The policy that only
                // declared names are asked for is the caller's
                // (`secretNamesOf` for a sandboxed plugin).
                const value = new EnvService({ allowed: [name], denied: [] })
                    .allowedValues()[name];

                // Registered before it is handed over, so it is already
                // redacted if the plugin echoes it into the log.
                context.registerSecret?.(value);

                return value;
            },

            registerSecret: value => context.registerSecret?.(value),

            log: (text, stream = "stdout", meta) => {

                // Plugin output is whole messages, not stream chunks, so
                // terminate the line or the line buffer holds it back.
                context.onOutput(text.endsWith("\n") ? text : `${text}\n`, stream, meta);
            },

            reportSession: id => context.onSession?.(id),

            // Only when there is one: a key holding undefined would still
            // widen the surface a plugin can see.
            ...(this.database ? { db: this.database.for(plugin.id) } : {}),

            get cancelled() {

                return context.isCancelled?.() ?? false;
            },

            onCancel: handler => cancelHandlers.push(handler)
        };
    }

}

/**
 * Why a returned `ui` cannot be drawn, or nothing when it can. Checked
 * here because the value crosses the sandbox as plain data and the
 * page must never be the first thing to find out it is wrong.
 */
export function uiProblemOf(ui: unknown): string | undefined {

    if (!ui || typeof ui !== "object" || Array.isArray(ui))
        return "it is not an object.";

    const { type, label } = ui as Partial<PluginUi>;

    if (!PLUGIN_UI_TYPES.includes(type as PluginUi["type"]))
        return `'type' must be one of ${PLUGIN_UI_TYPES.join(", ")}.`;

    if (typeof label !== "string" || !label.trim())
        return "'label' must be a non-empty string - it is the tab's name.";

    if (type === "markdown" && typeof (ui as { content?: unknown }).content !== "string")
        return "a 'markdown' ui needs a string 'content'.";

    if (type === "table") {

        const { columns, rows } = ui as { columns?: unknown; rows?: unknown };

        if (!Array.isArray(columns) || !columns.length || columns.some(column => typeof column !== "string"))
            return "a 'table' ui needs 'columns', a non-empty array of strings.";

        if (!Array.isArray(rows) || rows.some(row => !Array.isArray(row)))
            return "a 'table' ui needs 'rows', an array of arrays.";
    }

    if (type === "json" && (ui as { content?: unknown }).content === undefined)
        return "a 'json' ui needs 'content'.";

    return undefined;
}

/**
 * The args block: one line per arg the plugin will receive, led by a tag
 * naming its source - `task` (the caller's own `args:`; SDD merges
 * settings into the args it passes, so those arrive as the caller's),
 * `settings(ws)` / `settings(up)` (a settings.json default, workspace or
 * user profile), or `manifest` (the plugin's own default). Columns are
 * padded to line up.
 *
 * Long values are cut in the column so they do not bury the next arg.
 * What was cut is written out in full underneath, one block per clipped
 * arg.
 */
function describeArgSources(
    args: Record<string, unknown>,
    origins: Record<string, string> | undefined,
    scopes: Record<string, "workspace" | "profile"> | undefined,
    schema: PluginArgSchema | undefined
): string | undefined {

    // An arg declared `logged: false` is left out. An arg the schema says
    // nothing about (a `passthrough:` plugin's extras) is logged.
    const names = Object.keys(args).filter(name => schema?.[name]?.logged !== false);

    if (!names.length)
        return undefined;

    const tagFor = (name: string): string => {

        const origin = origins?.[name];

        if (origin === "plugin manifest default")
            return "manifest";

        if (origin?.startsWith("settings.json default"))
            return `settings(${scopes?.[name] === "profile" ? "up" : "ws"})`;

        return "task";
    };

    const tags = names.map(tagFor);
    const tagWidth = Math.max(...tags.map(tag => tag.length));
    const nameWidth = Math.max(...names.map(name => name.length));

    const lines = names.map((name, index) =>
        `  [${tags[index].padEnd(tagWidth)}] ${name.padEnd(nameWidth)} = ${briefValue(args[name])}`);

    // Only the args the column could not hold. Asked through `clipped`
    // rather than measured here: whitespace is collapsed before the
    // clip, so the value's own length is not what decides.
    const full = names
        .filter(name => clipped(args[name]))
        .map(name => `  ${name}:\n${indent(fullValue(args[name]))}`);

    return `Args:\n${lines.join("\n")}`
        + (full.length ? `\n\n${full.join("\n\n")}` : "");
}

/** Every line of a value pushed in, so a long one reads as one block rather than as loose output. */
function indent(value: string): string {

    return value.split("\n").map(line => `    ${line}`).join("\n");
}

/** A value as text, whole - a string as itself, anything else as JSON. */
function fullValue(value: unknown): string {

    if (typeof value === "string")
        return value;

    try {

        return JSON.stringify(value, undefined, 2) ?? String(value);

    } catch {

        return String(value);
    }
}

/** The four anchors, as one block. `workspaceConfig` is derived: it is always the workspace's `.eesha`. */
function describeAnchors(context: TaskExecutionContext): string {

    return describeValues("Anchors", {
        workspaceFolder: context.workspace,
        workspaceConfig: path.join(context.workspace, WORKFLOWS_DIR),
        cwd: context.cwd,
        home: context.home
    }) ?? "Anchors: none";
}

/**
 * A named block of values, one per line, names padded so the column
 * lines up. Returns nothing for an empty map, so no heading over no rows.
 */
function describeValues(title: string, values: Record<string, unknown>): string | undefined {

    const names = Object.keys(values);

    if (!names.length)
        return undefined;

    const width = Math.max(...names.map(name => name.length));

    const lines = names.map(name => `  ${name.padEnd(width)} = ${briefValue(values[name])}`);

    return `${title}:\n${lines.join("\n")}`;
}

/** How much of a value the provenance column holds before the rest goes underneath. */
const VALUE_LINE = 120;

/** Whether the column had to cut this value. */
function clipped(value: unknown): boolean {

    return oneLine(value).length > VALUE_LINE;
}

/** A value as one log-safe line, however long that is. */
function oneLine(value: unknown): string {

    let text: string;

    try {

        text = JSON.stringify(value) ?? String(value);

    } catch {

        text = String(value);
    }

    return text.replace(/\s+/g, " ");
}

/** A value as one short log-safe line - never the whole document. */
function briefValue(value: unknown): string {

    const line = oneLine(value);

    return clipped(value) ? `${line.slice(0, VALUE_LINE)}...` : line;
}

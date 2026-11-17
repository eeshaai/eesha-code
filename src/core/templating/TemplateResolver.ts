import { EnvVars, Vars } from "../models/task";
import { ParamValue } from "../models/workflowTypes";

/**
 * What `${{ env.NAME }}` can see: the declared env over the real one.
 *
 * Only for reading. What gets exported stays declared-only, because
 * the process runner already layers that onto the real environment.
 */
export function readableEnv(processEnv: EnvVars, declared: EnvVars): EnvVars {

    return { ...processEnv, ...declared };
}

/**
 * What one expression may look like: dotted names, `[0]` for a position
 * in a list, `["odd.key"]` for a key that holds a dot. So `a.b[0].c`
 * and `a["x.y"].z`. Nothing else - no operators, no calls, no
 * wildcards. A path reads a value; it never computes one.
 */
const EXPRESSION = String.raw`[\w.]+(?:\[(?:\d+|"[^"]*")\](?:\.\w+)*)*`;

/**
 * One `${{ … }}` anywhere in a string.
 *
 * Exported for `src/sdd/phase/specVars`, which substitutes
 * `${{ spec.… }}` once a spec exists. `g`-flagged, so a caller that
 * iterates it rather than handing it to `replace` must mind `lastIndex`.
 */
export const TEMPLATE_PATTERN = new RegExp(String.raw`\$\{\{\s*(${EXPRESSION})\s*\}\}`, "g");

/** A value that is nothing but one expression - the case that keeps its type. */
const WHOLE_VALUE_PATTERN = new RegExp(String.raw`^\$\{\{\s*(${EXPRESSION})\s*\}\}$`);

/**
 * An expression as its segments: `a.b[0].c` is `["a", "b", "0", "c"]`
 * and `a["x.y"]` is `["a", "x.y"]`. A list position arrives as digits;
 * the walker decides whether the value there is a list.
 *
 * Shared with the validator, so what it checks is what resolves.
 */
export function pathOf(expression: string): string[] {

    return [...expression.matchAll(/\[(\d+|"[^"]*")\]|[^.[\]]+/g)]
        .map(match => match[1] === undefined
            ? match[0]
            : match[1].startsWith("\"") ? match[1].slice(1, -1) : match[1]);
}

const MAX_RESOLUTION_PASSES = 5;

/** The first segment of the run-output namespace. */
const RUN_NAMESPACE = "run";

/** Its second segment. Two words, one namespace - see {@link RUN_SOURCE}. */
const RUN_CONTEXT = "context";

/**
 * How a task's `artifact:` is addressed: `${{ run.context.NOTES.summary }}`.
 *
 * Two segments so `run` stays a namespace: a flat `run.NOTES` would
 * collide with things like `run.id` a run could offer later.
 *
 * Exported so the validator names the same expressions identically.
 */
export const RUN_SOURCE = `${RUN_NAMESPACE}.${RUN_CONTEXT}`;

/**
 * The values stamped onto a run the moment it starts.
 *
 * Minted once per run, never recomputed per level: every task must read
 * the same `${{ dateNow }}`, or a run's own artifacts disagree about
 * when it happened. A parked run resumed tomorrow keeps the day it
 * started.
 */
export interface RunStamps {

    /** The local date - `2026-09-05`. */
    dateToday: string;

    /** Local date and time, ISO - `2026-09-05T15:42:10`. Carries colons, so not for file names. */
    dateNow: string;

    /** UTC date and time, ISO - `2026-09-05T10:12:10Z`. Carries colons, so not for file names. */
    dateUtcNow: string;

    /** Local date and time, compact and file-name-safe - `20260905-154210`. */
    timestamp: string;

    /** The run's own id - the same one the run history lists. */
    runId: string;

    /** `windows`, `macos` or `linux`. */
    platform: string;
}

/** The stamp names, as bare `${{ }}` expressions - one list, shared by lookup, errors and completion. */
export const STAMP_NAMES = ["dateToday", "dateNow", "dateUtcNow", "timestamp", "runId", "platform"] as const;

function isStampName(name: string): name is keyof RunStamps {

    return (STAMP_NAMES as readonly string[]).includes(name);
}

/**
 * Every bare name an expression already resolves, so nothing else may
 * take one: a `foreachAs:` (see `TaskParser`) or a settings variable
 * (see `engineSettings`). One list, so the two refusals agree.
 */
export const RESERVED_NAMES: readonly string[] = [
    "workspaceFolder", "workspaceConfig", "cwd", "home", "params", "vars", "env", "run", "spec", ...STAMP_NAMES
];

/**
 * Everything a `${{ }}` expression can see.
 *
 * The directory anchors are separate on purpose. They coincide for one
 * repo with `tasks.yml` at its root, but a file in `packages/api/`
 * would then point every path at the wrong place. A nested file's own
 * folder arrives as its starting `cwd`, captured when the file is
 * discovered (see `runRootOf`).
 *
 * A namespace left `undefined` is not empty, it is not yet available,
 * and asking for it produces an error that says why.
 */
export interface TemplateScope {

    /** The folder the app was started in. Stable for a whole run. */
    workspaceFolder: string;

    /** `<workspaceFolder>/.eesha` - where the workspace's settings, specs and plugins live. */
    workspaceConfig: string;

    /** The working directory whatever is being resolved will actually run in. */
    cwd: string;

    /**
     * The person's home directory - `os.homedir()`. Constant for the
     * whole process, unlike `cwd`.
     */
    home: string;

    /**
     * Readable as `${{ params.NAME }}` - what the run was asked for
     * before it started. Known before `vars` and `env`, so a `vars:`
     * value can be built out of one.
     */
    params?: Record<string, ParamValue>;

    /**
     * Readable as `${{ env.NAME }}` - the file's declared env merged over
     * the real process environment. A typo is in neither map, so it
     * still throws.
     */
    env?: EnvVars;

    /** Readable as `${{ vars.NAME }}`, or any path into it - `${{ vars.NAME.key }}`, `${{ vars.NAME.list[0] }}`. */
    vars?: Vars;

    /**
     * Readable as `${{ run.context.NAME }}`, or any path into it -
     * `${{ run.context.NAME.key }}`, `${{ run.context.NAME.json.items[0].id }}`.
     * Flat and run-scoped, so they cross job and stage boundaries.
     */
    run?: Record<string, unknown>;

    /**
     * Readable bare, like the anchors - `${{ dateToday }}`,
     * `${{ runId }}`. Absent where no run exists to have stamped them.
     */
    stamps?: RunStamps;

    /**
     * A `foreach:` task's loop variables, readable bare and by path:
     * `${{ item }}`, `${{ item.id }}`, `${{ itemIndex }}`. Named by the
     * task's `foreachAs:`. Present only inside such a task's turn.
     */
    items?: Record<string, unknown>;

    /**
     * The `variables` section of `settings.json`, both scopes merged.
     * Each top-level key is readable bare, and a path reads into it:
     * `${{ Team }}`, `${{ Team.Name }}`. Known before anything runs,
     * like the anchors, and constant for the whole run.
     */
    variables?: Record<string, unknown>;
}

/** Thrown when a `${{ }}` expression can't be resolved. */
export class TemplateResolutionError extends Error {}

/**
 * Every `${{ }}` expression inside a value, without resolving any of it.
 * Lets a validator read what a file asks for before a run exists.
 * Recurses the same way `resolveValue` does.
 */
export function expressionsIn(value: unknown): string[] {

    if (typeof value === "string")
        return [...value.matchAll(TEMPLATE_PATTERN)].map(match => match[1]);

    if (Array.isArray(value))
        return value.flatMap(expressionsIn);

    if (value !== null && typeof value === "object")
        return Object.values(value as Record<string, unknown>).flatMap(expressionsIn);

    return [];
}

/** Whether a value is nothing but one expression - the case whose type is unknown until it resolves. */
export function isWholeExpression(value: unknown): boolean {

    return typeof value === "string" && WHOLE_VALUE_PATTERN.test(value.trim());
}

/**
 * Whether a map declares a name itself.
 *
 * Not `name in source` or `source[name] !== undefined`: both walk the
 * prototype chain, so `${{ vars.toString }}` would resolve to the
 * function's source text and go straight into a command line.
 */
function owns(source: Record<string, unknown> | undefined, name: string): boolean {

    return source !== undefined && Object.prototype.hasOwnProperty.call(source, name);
}

/**
 * Resolves `${{ }}` expressions in `vars:`, `env:`, `cwd:`, `run:` and a
 * task's `args:`. Resolved ahead of time, so the same expression works
 * in fields no shell ever sees, like `cwd:`.
 *
 * Resolution order, one direction only, so no namespace can depend on
 * itself:
 *
 *   1. `workspaceFolder`, `workspaceConfig`, `home`, `cwd`,
 *      `params`                    - known before anything runs
 *   2. `vars`                      - may read the anchors and each other
 *   3. `env`                       - may read the anchors, `vars` and `run.context.*`
 *   4. `cwd:` / `run:` / `args:` - may read everything
 *
 * `vars` cannot read `env` on purpose: vars are the file's constants,
 * env is machine-dependent, and letting vars read env is the only way
 * to make a cycle between the two blocks.
 *
 * An unresolvable expression throws {@link TemplateResolutionError}
 * rather than being left as literal text that becomes part of a real
 * path. Callers should catch it and report a clean failure.
 */
export class TemplateResolver {

    /** Strict: every expression must resolve, and the answer is always a string. */
    public resolve(text: string, scope: TemplateScope): string {

        return text.replace(TEMPLATE_PATTERN, (_match, expression) =>
            this.stringify(this.demand(expression, scope, text)));
    }

    /**
     * Typed: a value that is nothing but one expression keeps that
     * value's type; an expression inside a larger string is stringified.
     *
     *     retries: ${{ vars.retries }}     -> the number 3
     *     tag: v${{ vars.version }}        -> the string "v1.4.0"
     *
     * Recurses into arrays and maps.
     */
    public resolveValue(value: unknown, scope: TemplateScope): unknown {

        if (typeof value === "string") {

            const whole = WHOLE_VALUE_PATTERN.exec(value.trim());

            return whole
                ? this.demand(whole[1], scope, value)
                : this.resolve(value, scope);
        }

        if (Array.isArray(value))
            return value.map(item => this.resolveValue(item, scope));

        if (value !== null && typeof value === "object")
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .map(([key, item]) => [key, this.resolveValue(item, scope)]));

        return value;
    }

    /**
     * Resolves what this scope can answer and leaves the rest exactly
     * as written, for a value that is resolved in more than one pass.
     *
     * Used for an MCP server declaration: its anchors are known when
     * `settings.json` is read, but `${{ env.NAME }}` there goes through
     * the env gate and cannot be answered until a task supplies its
     * grants. What survives must be demanded by a later pass - the
     * caller owns that.
     */
    public resolveKnown(value: unknown, scope: TemplateScope): unknown {

        return this.tryResolveValue(value, scope);
    }

    /**
     * Resolves a `vars:` block against itself, so a var can reference a
     * sibling regardless of declaration order.
     *
     * `env` and `run` are stripped from the scope: vars are resolved
     * before either exists, and reaching for them here gets the error
     * that explains the order rather than a bare "unknown variable".
     */
    public resolveVars(vars: Vars, scope: TemplateScope): Vars {

        const anchors = {
            workspaceFolder: scope.workspaceFolder,
            workspaceConfig: scope.workspaceConfig,
            home: scope.home,
            cwd: scope.cwd,
            params: scope.params,
            stamps: scope.stamps,
            variables: scope.variables
        };

        return this.settle(vars, current => ({ ...anchors, vars: current })) as Vars;
    }

    /**
     * Resolves an `env:` block against itself and the already-resolved
     * `vars`, so a value can reference a sibling key regardless of
     * declaration order.
     *
     * Run variables are readable too: a level's `env:` is resolved when
     * the level is entered, after earlier tasks produced their
     * `artifact:`. This matters because the environment needs no
     * quoting, while the same model output pasted into a `script:`
     * can break the shell.
     */
    public resolveEnv(env: EnvVars, scope: TemplateScope): EnvVars {

        const base = {
            workspaceFolder: scope.workspaceFolder,
            workspaceConfig: scope.workspaceConfig,
            home: scope.home,
            cwd: scope.cwd,
            params: scope.params,
            stamps: scope.stamps,
            variables: scope.variables,
            vars: scope.vars,
            run: scope.run
        };

        const settled = this.settle(env, current => ({
            ...base,
            // Declared values win over the process environment, but the
            // process environment is visible - see TemplateScope.env.
            env: { ...scope.env, ...(current as EnvVars) }
        }));

        // Env is what a process is spawned with, so every value has to be
        // a string no matter what the template produced.
        return Object.fromEntries(
            Object.entries(settled).map(([key, value]) => [key, this.stringify(value)]));
    }

    /**
     * Resolves the `variables` section of `settings.json` against
     * itself, so a variable can read a sibling regardless of which file
     * or line declared it.
     *
     * Reads the anchors, `env` and the other variables. Not `params`,
     * `vars` or `run`: settings are read before any run exists.
     */
    public resolveVariables(variables: Record<string, unknown>, scope: TemplateScope): Record<string, unknown> {

        const base = {
            workspaceFolder: scope.workspaceFolder,
            workspaceConfig: scope.workspaceConfig,
            home: scope.home,
            cwd: scope.cwd,
            env: scope.env
        };

        const settled = this.settle(variables, current => ({ ...base, variables: current }));

        // Two variables reading each other never change across the
        // lenient passes, and the strict pass finds each by name and
        // hands back its own text - so the cycle has to be caught here,
        // as an expression that outlived settling.
        for (const [name, value] of Object.entries(settled)) {

            if (!expressionsIn(value).length)
                continue;

            // Named from the block as written: after the passes the
            // value has turned into its own name, which explains nothing.
            const [reads] = expressionsIn(variables[name]);

            throw new TemplateResolutionError(
                `Cannot resolve '\${{ ${reads} }}' in '${name}' - '${name}' still has no value after `
                + "every pass, so it reads a variable that reads it back.");
        }

        return settled;
    }

    /**
     * Iterates a block until it stops changing, then makes one strict
     * pass so anything unresolvable reports itself. The lenient passes
     * leave an unresolved expression as its own text, so a key gets
     * another go once its dependency has resolved.
     */
    private settle(
        block: Record<string, unknown>,
        scopeOf: (current: Record<string, unknown>) => TemplateScope
    ): Record<string, unknown> {

        let current: Record<string, unknown> = { ...block };

        for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass++) {

            const next: Record<string, unknown> = {};
            let changed = false;

            const scope = scopeOf(current);

            for (const key of Object.keys(current)) {

                next[key] = this.tryResolveValue(current[key], scope);

                if (next[key] !== current[key])
                    changed = true;
            }

            current = next;

            if (!changed)
                break;
        }

        const strict = scopeOf(current);

        for (const key of Object.keys(current))
            this.resolveValue(current[key], strict);

        return current;
    }

    /** Lenient: an expression that cannot be resolved yet is left as its own text. */
    private tryResolveValue(value: unknown, scope: TemplateScope): unknown {

        if (typeof value === "string") {

            const whole = WHOLE_VALUE_PATTERN.exec(value.trim());

            if (whole) {

                const found = this.lookup(whole[1], scope);

                return found ? found.value : value;
            }

            return value.replace(TEMPLATE_PATTERN, (match, expression) => {

                const found = this.lookup(expression, scope);

                return found ? this.stringify(found.value) : match;
            });
        }

        if (Array.isArray(value))
            return value.map(item => this.tryResolveValue(item, scope));

        if (value !== null && typeof value === "object")
            return Object.fromEntries(
                Object.entries(value as Record<string, unknown>)
                    .map(([key, item]) => [key, this.tryResolveValue(item, scope)]));

        return value;
    }

    /** Resolves one expression or throws, with a message that says what went wrong. */
    private demand(expression: string, scope: TemplateScope, within: string): unknown {

        const found = this.lookup(expression, scope);

        if (found)
            return found.value;

        throw new TemplateResolutionError(
            `Cannot resolve '\${{ ${expression} }}' in '${within}' - ${this.explain(expression, scope)}`);
    }

    /**
     * Why an expression did not resolve. "unknown variable" for a name
     * declared three lines above reads as a bug; "vars are resolved
     * before env" is the actual answer.
     */
    private explain(expression: string, scope: TemplateScope): string {

        const { namespace, name, path } = this.split(expression);

        const rest = name ?? "";

        if (namespace === "vars" && scope.vars === undefined)
            return "vars are not available here. They are resolved first, so nothing they read can be a var.";

        if (namespace === "env" && scope.env === undefined)
            return "env is not available here. Env is resolved after vars, so a 'vars:' value cannot read it.";

        if (namespace === RUN_SOURCE && scope.run === undefined)
            return "run variables are produced by tasks as they finish, so they cannot be read from 'vars:'.";

        if (namespace === "params" && scope.params === undefined)
            return "params are not available here.";

        // A loop variable whose path missed.
        if (owns(scope.items, namespace))
            return this.explainPath(namespace, scope.items![namespace], pathOf(expression).slice(1));

        // A settings variable whose path missed.
        if (owns(scope.variables, namespace))
            return this.explainPath(namespace, scope.variables![namespace], pathOf(expression).slice(1));

        // The name is there; the path under it is what missed. Say how
        // far it got, so the fix is one look at the value.
        const source = namespace === "params" ? scope.params
            : namespace === "vars" ? scope.vars
            : namespace === RUN_SOURCE ? scope.run
            : undefined;

        if (name && path.length && owns(source, name))
            return this.explainPath(`${namespace}.${name}`, source![name], path);

        if (namespace === "params")
            return `the file declares no param named '${rest}'. ` +
                "A param has to be declared in 'params:' before a run can be asked for it.";

        if (isStampName(namespace) && scope.stamps === undefined)
            return `'${namespace}' is stamped when a run starts, and this value is read before any run exists.`;

        if (namespace === "env" && path.length)
            return `env vars are flat text - there is no '${namespace}.${rest}.${path[0]}'.`;

        if (namespace === "vars" || namespace === "env" || namespace === RUN_SOURCE)
            return `no ${namespace === RUN_SOURCE ? "run variable" : namespace === "env" ? "env var" : "var"} named '${rest}' is in scope.`;

        return `'${namespace}' is not a thing. Available: ${this.available(scope).join(", ")}.`;
    }

    /** Where a path stopped resolving, named from the deepest node that did. */
    private explainPath(reached: string, value: unknown, path: string[]): string {

        for (const segment of path) {

            if (Array.isArray(value)) {

                if (!/^\d+$/.test(segment))
                    return `'${reached}' is a list of ${value.length}, so it is read by position - '[0]', not '.${segment}'.`;

                if (Number(segment) >= value.length)
                    return `'${reached}' is a list of ${value.length}, so [${segment}] is out of range.`;

                value = value[Number(segment)];
                reached = `${reached}[${segment}]`;

                continue;
            }

            if (value === null || typeof value !== "object")
                return `'${reached}' is ${value === null ? "null" : typeof value === "string" ? "text" : `a ${typeof value}`}, so there is no '${segment}' under it.`;

            if (!owns(value as Record<string, unknown>, segment))
                return `'${reached}' has no '${segment}'. It has: ${Object.keys(value as object).join(", ") || "nothing"}.`;

            value = (value as Record<string, unknown>)[segment];
            reached = `${reached}.${segment}`;
        }

        return `'${reached}' did not resolve.`;
    }

    private available(scope: TemplateScope): string[] {

        return [
            "workspaceFolder",
            "workspaceConfig",
            "cwd",
            "home",
            ...(scope.stamps ? [...STAMP_NAMES] : []),
            ...(scope.params ? ["params.NAME"] : []),
            ...(scope.vars ? ["vars.NAME"] : []),
            ...(scope.env ? ["env.NAME"] : []),
            ...(scope.run ? [`${RUN_SOURCE}.NAME`] : []),
            ...Object.keys(scope.items ?? {}),
            ...Object.keys(scope.variables ?? {})
        ];
    }

    /**
     * Looks one expression up. Returns a box rather than the value so
     * a stored `undefined`/`null` is still "found".
     */
    private lookup(expression: string, scope: TemplateScope): { value: unknown } | undefined {

        if (expression === "workspaceFolder") return { value: scope.workspaceFolder };
        if (expression === "workspaceConfig") return { value: scope.workspaceConfig };
        if (expression === "home") return { value: scope.home };
        if (expression === "cwd") return { value: scope.cwd };

        // Absent before a run stamps them; the name then falls through
        // to `explain`.
        if (isStampName(expression))
            return scope.stamps ? { value: scope.stamps[expression] } : undefined;

        // A loop variable: `${{ item }}` is the element itself, and a
        // path reads into it. Checked before the namespaces so a task's
        // `foreachAs: params` cannot shadow one - the parser refuses
        // that name anyway.
        const [head] = pathOf(expression);

        if (owns(scope.items, head))
            return this.walk(scope.items, head, pathOf(expression).slice(1));

        // A settings variable, read bare like a loop variable. After
        // the anchors and stamps, which `engineSettings` refuses as
        // variable names, so nothing here can shadow them.
        if (owns(scope.variables, head))
            return this.walk(scope.variables, head, pathOf(expression).slice(1));

        const { namespace, name, path } = this.split(expression);

        if (name === undefined)
            return undefined;

        // Env is flat text, so nothing sits under a name.
        if (namespace === "env")
            return path.length === 0 && owns(scope.env, name)
                ? { value: scope.env![name] }
                : undefined;

        if (namespace === "params")
            return this.walk(scope.params, name, path);

        if (namespace === "vars")
            return this.walk(scope.vars, name, path);

        if (namespace === RUN_SOURCE)
            return this.walk(scope.run, name, path);

        return undefined;
    }

    /**
     * An expression in its three parts: the namespace, the declared
     * name under it, and the path into that name's value.
     *
     * `run.context` is one namespace in two segments, so its name and
     * path sit one place further right. A bare `run.NOTES` is not
     * special-cased: `run` lands in `explain` as "not a thing", which
     * lists `run.context.NAME` as available.
     */
    private split(expression: string): { namespace: string; name: string | undefined; path: string[] } {

        const parts = pathOf(expression);

        const compound = parts[0] === RUN_NAMESPACE && parts[1] === RUN_CONTEXT;

        const at = compound ? 2 : 1;

        return {
            namespace: compound ? RUN_SOURCE : parts[0],
            name: parts[at],
            path: parts.slice(at + 1)
        };
    }

    /**
     * `NAME`, then each path segment into it: a key of a map, or a
     * position in a list. A segment that is not there is a miss, and
     * so is a segment under a value that is neither - text has nothing
     * under it. A `null` reached at the end is a value, and stringifies
     * to nothing.
     */
    private walk(
        source: Record<string, unknown> | undefined,
        name: string,
        path: string[]
    ): { value: unknown } | undefined {

        if (!owns(source, name))
            return undefined;

        let value = source![name];

        for (const segment of path) {

            if (Array.isArray(value)) {

                if (!/^\d+$/.test(segment) || Number(segment) >= value.length)
                    return undefined;

                value = value[Number(segment)];

                continue;
            }

            if (value === null || typeof value !== "object" || !owns(value as Record<string, unknown>, segment))
                return undefined;

            value = (value as Record<string, unknown>)[segment];
        }

        return { value };
    }

    private stringify(value: unknown): string {

        if (value === undefined || value === null)
            return "";

        return typeof value === "object" ? JSON.stringify(value) : String(value);
    }
}

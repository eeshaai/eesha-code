import * as os from "os";
import * as path from "path";

import { EnvService } from "../env/envService";
import { WORKFLOWS_DIR } from "../loader/constants";
import {
    expressionsIn, TemplateResolutionError, TemplateResolver, TemplateScope
} from "./TemplateResolver";

/**
 * `${{ }}` in the engine's configuration files - `settings.json` and a
 * style's `style.yml`.
 *
 * Readable here: the four anchors, `env`, and the settings variables
 * (`settings.json`'s `variables` section, once settled - see
 * {@link resolveVariables}). Not `vars`, `params` or `run.context` -
 * those belong to a run, and a configuration file is read before any
 * run exists. `cwd` equals `workspaceFolder`, since nothing is running
 * yet.
 *
 * Which env rule applies depends on where the value goes:
 *
 *   - Inside `ai.mcpServers`: the full gate. `env.allowed`, the
 *     workflow's `env:` block or a task's `allowedEnv:` must grant the
 *     name, because the value goes to a third-party server process.
 *     A task's grants do not exist when a settings file is read, so
 *     this module leaves that subtree to `resolveAnchorsOnly` and
 *     `mcpConfig.expandEnv` finishes it.
 *   - Everywhere else here, and in `tasks.yml`: no grant needed. The
 *     engine consumes the value in process.
 *
 * `env.denied` vetoes in both cases, and this module enforces its
 * half: `settings.json` is where the deny list is declared, so a read
 * answered freely here would bypass the gate the same file states. A
 * denied name fails naming the setting rather than resolving to
 * nothing, so the veto can be debugged.
 */
export interface ConfigTemplating {

    /**
     * The workspace root, when there is one. A run with no workspace
     * open still reads the profile's `settings.json`.
     *
     * {@link resolveConfigValue} refuses when this is undefined rather
     * than substituting `""`, which would produce a path rooted at the
     * filesystem's top.
     */
    workspaceFolder?: string;

    /** The person's home directory. Defaults to the real one. */
    home?: string;

    /** `env.denied`, from every settings scope. See the class note. */
    denied?: readonly string[];

    /** The machine environment. Injected only by tests; otherwise {@link EnvService.machine}. */
    processEnv?: Record<string, string | undefined>;

    /**
     * The settled `variables` section, both scopes merged - what
     * `${{ Team.Name }}` reads. Absent while that section itself is
     * being settled, and for a caller that has no settings at all.
     */
    variables?: Record<string, unknown>;
}

/**
 * The scope a configuration file's expressions resolve against, or
 * undefined when there is no workspace to anchor them to.
 */
export function configScope(templating: ConfigTemplating): TemplateScope | undefined {

    const workspaceFolder = templating.workspaceFolder;

    if (!workspaceFolder)
        return undefined;

    return {
        workspaceFolder,
        workspaceConfig: path.join(workspaceFolder, WORKFLOWS_DIR),
        cwd: workspaceFolder,
        home: templating.home ?? os.homedir(),
        env: readableEnv(templating.denied ?? [], templating.processEnv),
        variables: templating.variables
    };
}

/**
 * The `variables` section of `settings.json`, settled: every
 * `${{ }}` in it answered from the anchors, `env` and the section
 * itself, in any order of declaration. What comes back is what every
 * other file reads as `${{ NAME }}`.
 *
 * A section with no expressions is returned untouched, so a profile
 * with plain values works with no folder open. One with expressions
 * needs a workspace, like any other configuration value.
 *
 * @param source What to call the section in an error - it spans two
 * files, so the caller names both.
 */
export function resolveVariables(
    variables: Record<string, unknown>,
    source: string,
    templating: ConfigTemplating
): Record<string, unknown> {

    const expressions = expressionsIn(variables);

    if (!expressions.length)
        return variables;

    refuseDenied(expressions, source, templating.denied ?? []);

    const scope = configScope({ ...templating, variables: undefined });

    if (!scope)
        throw new Error(
            `${source} uses \${{ }} but no workspace is open, so there is nothing for `
            + "'workspaceFolder' to mean. Open the folder this file belongs to, or write the "
            + "value without an expression.");

    try {

        return new TemplateResolver().resolveVariables(variables, scope);

    } catch (error) {

        if (error instanceof TemplateResolutionError)
            throw new Error(`${source}: ${error.message}`);

        throw error;
    }
}

/**
 * A parsed configuration file with every `${{ }}` in it resolved.
 *
 * Recurses the whole structure. A value that is nothing but an
 * expression keeps the resolved type, so a templated number stays a
 * number.
 *
 * A file with no expressions is returned untouched, before anything
 * needs a workspace or an environment. Most files are like that.
 *
 * @param source The file's path, for a message that names it.
 *
 * @param defer Namespaces this pass leaves exactly as written for a
 * later caller. `style.yml` defers `spec`, which has no values until a
 * spec exists - `src/sdd/phase/specVars` finishes them. Everything
 * not deferred is still strict.
 */
export function resolveConfigValue<T>(
    value: T,
    source: string,
    templating: ConfigTemplating,
    defer: readonly string[] = []
): T {

    const expressions = expressionsIn(value);

    if (!expressions.length)
        return value;

    const late = (expression: string) => defer.includes(namespaceOf(expression));

    const now = expressions.filter(one => !late(one));

    // Only what this pass answers. A file whose expressions are all
    // deferred must not need a workspace.
    refuseDenied(now, source, templating.denied ?? []);

    const scope = configScope(templating);

    if (!scope) {

        if (!now.length)
            return value;

        throw new Error(
            `'${source}' uses \${{ }} but no workspace is open, so there is nothing for `
            + "'workspaceFolder' to mean. Open the folder this file belongs to, or write the "
            + "value without an expression.");
    }

    try {

        if (now.length === expressions.length)
            return new TemplateResolver().resolveValue(value, scope) as T;

        const resolved = new TemplateResolver().resolveKnown(value, scope) as T;

        // Lenient resolution leaves everything it could not answer as
        // its own text. Anything that survives and was not deferred is
        // demanded here, purely for the error it raises.
        for (const expression of expressionsIn(resolved))
            if (!late(expression))
                new TemplateResolver().resolve(`\${{ ${expression} }}`, scope);

        return resolved;

    } catch (error) {

        if (error instanceof TemplateResolutionError)
            throw new Error(`'${source}': ${error.message}`);

        throw error;
    }
}

/**
 * The namespace an expression reads from - its first segment.
 * `run.context` is not special-cased: nothing defers it.
 */
function namespaceOf(expression: string): string {

    return expression.split(".")[0];
}

/**
 * The anchors of a value whose `${{ env.NAME }}` reads are answered
 * later, by something else.
 *
 * Used for the MCP declarations in `settings.json`: an anchor there is
 * known when the file is read, but an env read goes through the env
 * gate and cannot be answered until a task supplies its own grants
 * (`resolveMcpServers`). Whatever survives here is demanded by that
 * later pass - see `mcpConfig.expandEnv`.
 */
export function resolveAnchorsOnly<T>(
    value: T,
    source: string,
    templating: ConfigTemplating
): T {

    const expressions = expressionsIn(value);

    if (!expressions.length)
        return value;

    refuseDenied(expressions, source, templating.denied ?? []);

    const scope = configScope(templating);

    if (!scope)
        return value;

    // Without `env`, so `resolveKnown` leaves every env read untouched.
    return new TemplateResolver().resolveKnown(value, { ...scope, env: undefined }) as T;
}

/**
 * One `${{ env.NAME }}`. Shared by `mcpConfig` and the connections list so both
 * agree on what an env read looks like. `g`-flagged, so a caller that
 * iterates it must reset `lastIndex` - or use `envNamesIn` below.
 */
export const ENV_EXPRESSION = /\$\{\{\s*env\.(\w+)\s*\}\}/g;

/**
 * The bare `${VAR}` every other MCP tool uses, and therefore the most
 * likely thing to type here. It reads nothing: it is literal text handed
 * to a server process, which then fails at the handshake instead of at
 * the line that wrote it.
 *
 * Matching it is not enough to refuse it - `${workspaceFolder}` is
 * another tool's dialect and has to pass through untouched. The caller
 * refuses only a name the env gate grants, which is the one case where
 * the person plainly meant an env read; see `mcpConfig`'s `refuseBare`.
 *
 * `${{ env.VAR }}` and `${env:VAR}` do not match: the first has `{`
 * where a name must start, the second has `:` where the closing brace
 * must be.
 */
export const BARE_ENV_EXPRESSION = /\$\{([A-Za-z_]\w*)\}/g;

/** Every env name a value reads, at any depth. */
export function envNamesIn(value: unknown, names: Set<string> = new Set()): Set<string> {

    if (typeof value === "string") {

        for (const match of value.matchAll(ENV_EXPRESSION))
            names.add(match[1]);

        return names;
    }

    if (Array.isArray(value)) {

        for (const entry of value)
            envNamesIn(entry, names);

        return names;
    }

    if (value && typeof value === "object")
        for (const entry of Object.values(value as Record<string, unknown>))
            envNamesIn(entry, names);

    return names;
}

/**
 * Refuses a denied env name, by name.
 *
 * Runs before resolution: a denied name is absent from the scope, so
 * the resolver would only say "no env var named X is in scope", which
 * hides that the deny list is the reason.
 */
function refuseDenied(expressions: string[], source: string, denied: readonly string[]): void {

    if (!denied.length)
        return;

    const vetoed = new Set(denied.map(name => name.toUpperCase()));

    for (const expression of expressions) {

        const parts = expression.split(".");

        if (parts.length !== 2 || parts[0] !== "env" || !vetoed.has(parts[1].toUpperCase()))
            continue;

        throw new Error(
            `'${source}' reads \${{ env.${parts[1]} }}, which 'env.denied' vetoes. `
            + "Remove the name from env.denied, or the expression from this file.");
    }
}

/** The machine environment, minus what `env.denied` vetoes. */
function readableEnv(
    denied: readonly string[],
    processEnv: Record<string, string | undefined> | undefined
): Record<string, string> {

    const source = processEnv ?? EnvService.machine();

    const vetoed = new Set(denied.map(name => name.toUpperCase()));

    const env: Record<string, string> = {};

    for (const [name, value] of Object.entries(source))
        if (value !== undefined && !vetoed.has(name.toUpperCase()))
            env[name] = value;

    return env;
}

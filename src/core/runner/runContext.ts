import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { EnvService } from "../env/envService";
import { WORKFLOWS_DIR } from "../loader/constants";
import { cwdToResolve } from "../models/cwd";
import { EnvVars, Vars } from "../models/task";
import { Param, ParamValue } from "../models/workflowTypes";
import { readableEnv, RunStamps, TemplateResolver, TemplateScope } from "../templating/TemplateResolver";
import { parseDotEnv } from "../parser/dotenv";

/*
 * The run's context: the one place every source a `${{ ... }}` can read
 * is gathered and layered.
 *
 *   processEnv  ->  .env files  ->  env:   (later wins; only env: and
 *   (machine)       (dotenv:)      (declared)   .env are exported)
 *   vars:    declared per level, engine-only, keeps its YAML types
 *   params:  answered at run start, frozen into the snapshot
 *   run.context.X:   produced by earlier tasks (see storedOutput)
 *
 * The namespaces stay separate so a reader can tell where a value came
 * from and whether it reaches spawned processes.
 */

/**
 * The two directories a run is handed, and never discovers itself.
 *
 * `workspace` is the folder the app was started in -
 * `${{ workspaceFolder }}` to a file (and `${{ workspaceConfig }}` is its
 * `.eesha`). `root` is the directory of the file being run.
 * It is not a template anchor; it seeds the file's starting `cwd` and
 * anchors its `dotenv:` paths, so a nested
 * `packages/api/.eesha/tasks.yml` runs beside the code it
 * builds.
 */
export interface RunDirectories {

    workspace: string;

    root: string;
}

export interface ContextRequest extends RunDirectories {

    /** The working directory this level inherits - `root` at the top. */
    inheritedCwd: string;

    /**
     * This level's own `cwd:`, before templating. Relative paths
     * resolve against `inheritedCwd`; `none` names no folder at all and
     * leaves the level running where it already was.
     */
    declaredCwd?: string;

    /** Declared vars for this level, already merged over the levels above. */
    vars: Vars;

    /** Declared env for this level, already merged over the levels above. */
    env: EnvVars;

    /** This level's own `dotenv:` paths. Not accumulated - each level's values are already in `env` by the time the next one runs. */
    dotenv?: string[];

    /** The real environment, so `${{ env.PATH }}` resolves. Never merged into what is exported. */
    processEnv: EnvVars;

    /**
     * The person's home directory. Injected like `processEnv`, so a test
     * never depends on whose machine it runs on. Defaults to
     * {@link homeDirectory}. Not part of {@link RunDirectories}: those
     * are handed to a run, this one is discovered.
     */
    home?: string;

    /**
     * Param values answered at run start. Undefined for `tasks.yml`,
     * which has no `params:` block, so `${{ params.X }}` there gets the
     * "params are not available" error rather than one blaming the name.
     */
    params?: Record<string, ParamValue>;

    run?: Record<string, unknown>;

    /**
     * The run's stamps - see {@link runStamps}. Passed down rather than
     * minted here: this function runs once per level, and every level
     * must read the same instant.
     */
    stamps?: RunStamps;

    /** A `foreach:` task's loop variables - see TemplateScope.items. */
    items?: Record<string, unknown>;

    /** The settled `variables` section of settings.json - see TemplateScope.variables. Passed down like the stamps. */
    variables?: Record<string, unknown>;

    /** Reads a `.env`, or returns undefined when there is no such file. Injected so a test never touches a disk. */
    readEnvFile?: (path: string) => string | undefined;

    /** Somewhere to report a missing or malformed `.env` - see {@link loadDotEnv}. */
    onProblem?: (message: string) => void;
}

export interface ResolvedContext {

    vars: Vars;

    /** Resolved *declared* env only - what gets layered onto a spawned process. */
    env: EnvVars;

    cwd: string;

    /** What `cwd:`, `run:` and a task's `args:` are resolved against. */
    scope: TemplateScope;
}

/**
 * Builds one level of scope: vars, then env, then cwd, then everything
 * else. Shared by both executors so the order cannot drift. See
 * {@link TemplateResolver} for why the order is what it is.
 */
export function resolveContext(resolver: TemplateResolver, request: ContextRequest): ResolvedContext {

    const anchors = {
        workspaceFolder: request.workspace,
        workspaceConfig: path.join(request.workspace, WORKFLOWS_DIR),
        home: request.home ?? homeDirectory(),
        cwd: request.inheritedCwd,
        params: request.params,
        stamps: request.stamps,
        items: request.items,
        variables: request.variables
    };

    const vars = resolver.resolveVars(request.vars, anchors);

    // The machine's environment with this level's `.env` files loaded
    // over it - a `.env` overrides any machine variable, and this
    // level's own `env:` (below) overrides both.
    const loaded = loadEnvVariables(resolver, { ...anchors, vars }, {
        root: request.root,
        dotenv: request.dotenv,
        processEnv: request.processEnv,
        readEnvFile: request.readEnvFile,
        onProblem: request.onProblem
    });

    // Run variables are in scope from here on. `env:` is resolved when
    // the level is entered, after earlier tasks have produced theirs.
    // Only `vars:` is resolved too early to see them.
    const declared = resolver.resolveEnv(request.env, {
        ...anchors,
        vars,
        env: loaded.environment,
        run: request.run
    });

    // Exported = declared + `.env` values only. The machine's own
    // environment is NOT in here: the process runner already layers
    // onto the real environment, and a sandboxed plugin receives exactly
    // this map, so it must not carry the whole machine environment.
    const env = { ...loaded.fromFiles, ...declared };

    const readable = readableEnv(request.processEnv, env);

    // A relative `cwd:` is relative to what this level inherited, and
    // `${{ cwd }}` inside a `cwd:` means the parent's - so
    // `cwd: ${{ cwd }}/dist` means what it looks like.
    //
    // `cwd: none` resolves to nothing here: the level inherits, which
    // is what "none" means. Its effect is upstream, where saying it
    // silences the "run in which folder?" pick.
    const declaredCwd = cwdToResolve(request.declaredCwd);

    const cwd = declaredCwd
        ? path.resolve(
            request.inheritedCwd,
            resolver.resolve(declaredCwd, {
                ...anchors,
                vars,
                env: readable,
                run: request.run ?? {}
            }))
        : request.inheritedCwd;

    return {
        vars,
        env,
        cwd,
        scope: {
            workspaceFolder: anchors.workspaceFolder,
            workspaceConfig: anchors.workspaceConfig,
            home: anchors.home,
            cwd,
            params: request.params,
            stamps: request.stamps,
            items: request.items,
            variables: request.variables,
            vars,
            env: readable,
            run: request.run ?? {}
        }
    };
}

/** What {@link loadEnvVariables} produced, in its two roles. */
export interface LoadedEnvVariables {

    /** The environment as this level sees it: the machine's, with the `.env` values loaded over it. */
    environment: EnvVars;

    /**
     * Just the `.env` values - the half that is exported (alongside
     * declared `env:`). Kept separate because a sandboxed plugin
     * receives the exported map, and it must never carry the whole
     * machine environment.
     */
    fromFiles: EnvVars;
}

/**
 * Loads the environment a level starts from: the machine's variables,
 * overridden by this level's `dotenv:` files (later paths win).
 *
 * Callable with no arguments for a bare machine snapshot.
 *
 * A missing `.env` is not an error: it is the one file not committed,
 * so `dotenv: .env` in a shared file would otherwise fail for everyone
 * who has not made one yet. It is reported instead, so a typo'd path
 * stays visible in the log.
 *
 * Relative paths resolve against `root`, the file's own directory, not
 * against `cwd:`. `cwd:` has not been computed yet at this point, and
 * "the .env next to the file that names it" is what a reader expects.
 */
export function loadEnvVariables(
    resolver?: TemplateResolver,
    scope?: TemplateScope,
    request?: {
        root: string;
        dotenv?: string[];
        processEnv?: EnvVars;
        readEnvFile?: (path: string) => string | undefined;
        onProblem?: (message: string) => void;
    }
): LoadedEnvVariables {

    const machine = request?.processEnv ?? machineEnvironment();

    const paths = request?.dotenv ?? [];

    if (paths.length === 0 || !resolver || !scope || !request)
        return { environment: machine, fromFiles: {} };

    const read = request.readEnvFile ?? readEnvFileFromDisk;
    const report = request.onProblem ?? (() => undefined);

    const fromFiles: EnvVars = {};

    for (const declared of paths) {

        const resolved = path.resolve(request.root, resolver.resolve(declared, scope));

        const text = read(resolved);

        if (text === undefined) {

            report(`No dotenv file at '${resolved}' - skipping it.`);

            continue;
        }

        const parsed = parseDotEnv(text);

        for (const problem of parsed.problems)
            report(`${resolved}: ${problem}`);

        Object.assign(fromFiles, parsed.values);
    }

    return { environment: { ...machine, ...fromFiles }, fromFiles };
}

/**
 * The person's home directory. A function rather than a constant so a
 * test can point `os.homedir` at a temporary directory.
 */
export function homeDirectory(): string {

    return os.homedir();
}

function machineEnvironment(): EnvVars {

    return EnvService.machine();
}

function readEnvFileFromDisk(file: string): string | undefined {

    try {

        return fs.readFileSync(file, "utf8");

    } catch {

        return undefined;
    }
}

/**
 * Mints a run's stamps - once, at run start. See {@link RunStamps} for
 * why once matters.
 *
 * Local time for everything but `dateUtcNow`, because a person reading
 * `report-20260905-154210.md` expects their own clock. Formats are
 * built by hand rather than through `toISOString` (UTC-only) or locale
 * APIs (machine-dependent), so every machine produces the same name.
 */
export function runStamps(runId: string, at: Date = new Date()): RunStamps {

    const pad = (value: number) => String(value).padStart(2, "0");

    const date = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

    const time = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;

    return {
        dateToday: date,
        dateNow: `${date}T${time}`,
        dateUtcNow: at.toISOString().replace(/\.\d{3}Z$/, "Z"),
        timestamp: `${date.replace(/-/g, "")}-${time.replace(/:/g, "")}`,
        runId,
        platform: platformName()
    };
}

/** `windows`, `macos` or `linux` - the words a person writes in an `if:`. */
function platformName(): string {

    return process.platform === "win32" ? "windows"
        : process.platform === "darwin" ? "macos"
        : "linux";
}

/**
 * The values a run resolves its `${{ params.NAME }}` against.
 *
 * Supplied values win over defaults; a param with neither resolves to
 * undefined and is reported by `missingParams` (see `parseParams.ts`)
 * rather than silently becoming an empty string.
 */
export function loadParamValues(params: readonly Param[]): Record<string, ParamValue> {

    const values: Record<string, ParamValue> = {};

    for (const param of params) {

        const value = param.value ?? param.default;

        if (value !== undefined)
            values[param.name] = value;
    }

    return values;
}

/**
 * What a task's `artifact:` stores into `run.context.X`.
 *
 * A plugin declaring exactly one artifact makes `${{ run.context.PR }}`
 * that single value; anything else stores the whole map, addressed as
 * `${{ run.context.PR.title }}`. Decided once, at write time, so
 * `TemplateResolver` never needs to know how many outputs a plugin
 * declared.
 */
export function storedOutput(
    outputs: Record<string, unknown> | undefined,
    declaredKeys: readonly string[] | undefined
): unknown {

    if (!outputs)
        return undefined;

    if (declaredKeys?.length === 1)
        return outputs[declaredKeys[0]];

    return outputs;
}

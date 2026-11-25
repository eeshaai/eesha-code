import { EnvVars, Task, Vars } from "./task";

/**
 * One workflow. Every YAML file the product reads parses into this
 * shape; the engine decides how it is validated, executed and drawn.
 *
 * Two templates:
 *
 *   - `"inline"` - `tasks.yml`. A flat library of independently
 *     runnable tasks ordered only by `needs:`. Nothing runs unless a
 *     person runs it. `stages`/`params` are empty.
 *   - `"default"` (or any declared `engine:`) - `.eesha/*.yml`.
 *     Stages in order, tasks in list order inside them, all sequential. `tasks` at this
 *     level is empty - they live in stages.
 */
export interface Workflow {

    /**
     * Which engine runs this workflow. `"inline"` is stamped by
     * `WorkflowParser` for `tasks.yml`; a workflow file may declare
     * `engine:` and gets `"default"` when it does not.
     */
    engine: string;

    /** Mandatory in engine files - an unknown value is a hard parse failure. Inline workflows carry none. */
    version?: number;

    name: string;

    desc?: string;

    /** Identity. Two files sharing a `name:` is legal and harmless. */
    filePath: string;

    /**
     * sha256 of the source text, stamped by `WorkflowParser`. A run
     * records it at start; a parked run whose hash no longer matches the
     * file is outdated, and a client can shelve it. Absent on synthetic
     * workflows.
     */
    sourceHash?: string;

    /**
     * Each step's own YAML as written, keyed by the rail's step id -
     * see `stepSources`. Stamped by `WorkflowParser`; absent on
     * synthetic workflows.
     */
    stepSources?: Record<string, StepSource>;

    /**
     * What to call this run, as opposed to the workflow - templated, and
     * resolved once at run start. `label: "AB#${{ params.work_item }}"`
     * makes the run list a list of the things being worked on. Status is
     * reported separately and never part of the label.
     */
    label?: string;

    /**
     * Where this file's tasks start, before any task's own `cwd:`.
     * Relative to the directory the run starts in, and templated, so
     * `${{ home }}/scratch` works. `cwd: none` means no folder at all -
     * see `cwd.ts`.
     */
    cwd?: string;

    env: EnvVars;

    /** File-level values, overridable per job and per task. */
    vars: Vars;

    /**
     * What the run asks for before it starts, in the order they are
     * prompted for. Readable everywhere an engine is, `vars:` and
     * `env:` included. Always empty for the inline engine.
     */
    params: Param[];

    /** `.env` files layered under this file's own `env:`. */
    dotenv: string[];

    /** Ordered. Each stage is a barrier: nothing in stage N+1 starts until stage N is fully done. Empty for the inline engine. */
    stages: Stage[];

    /**
     * The inline engine's flat task library. Each task is
     * independently runnable; `needs:` only says what must already have
     * run. Empty for staged templates.
     */
    tasks: Task[];
}

/**
 * One value the run is asked for before it starts.
 *
 * Distinct from `vars:`: a var is a value the file states; a param is a
 * declaration that the file cannot state one, with a description to
 * prompt with and a rule about whether it may be left out. The separate
 * `${{ params.NAME }}` namespace says where the value came from.
 */
export interface Param {

    /** Referenced as `${{ params.NAME }}`, so it must be a bare identifier. */
    name: string;

    /** Shown when the run asks for it. The only thing a caller has to go on. */
    desc?: string;

    /**
     * The shape of the answer. `string` is text - what a prompt's box
     * gives. `file` and `folder` are a path, picked in the open dialog
     * and held as text. `list` is what a `foreach:` runs over, and what
     * a plugin's own page supplies through `eesha.run`. `map` is a keyed
     * value read by path: `${{ params.NAME.key }}`.
     *
     * Absent: read as `string`.
     */
    type?: ParamType;

    /** Whether the run cannot start without it. Never true when a `default:` exists. */
    required: boolean;

    /** Of the param's `type`. */
    default?: ParamValue;

    /**
     * The only values this param accepts, when the file closes the set.
     * A prompt renders these as a pick list instead of a text box; for a
     * `list` param, a pick-many list. Never on a `map`, never beside
     * `items`.
     */
    options?: string[];

    /**
     * What a `list` holds when each item is picked in the open dialog:
     * a multi-select of files or of folders. Never beside `options`.
     */
    items?: PathParamType;

    /**
     * Where the open dialog starts, for a `file`, a `folder` or a list
     * of them. Relative to the workflow's workspace folder. Without it
     * the dialog opens where it was last, else at the workspace folder.
     */
    root?: string;

    /**
     * Which files the open dialog offers, as glob patterns: `*.md`.
     * Only for a `file` or a list of files.
     */
    filters?: string[];

    /**
     * What this run was given. Written onto the declaration at run start
     * and frozen into `workflow_snapshot`, so a resumed run does not ask
     * again.
     */
    value?: ParamValue;
}

/** A path picked in the open dialog - one file or one folder. */
export type PathParamType = "file" | "folder";

export type ParamType = "string" | PathParamType | "list" | "map";

/** An answer: text, a list, or a map - see {@link Param.type}. */
export type ParamValue = string | unknown[] | Record<string, unknown>;

/** What the open dialog picked for one param - a path, or a list's paths. */
export interface BrowsedParam {

    name: string;

    value: ParamValue;

    /** Climbs per pick, so the same pick twice is still two events. */
    seq: number;
}

/** A param's type: `string` when none is given. */
export function paramTypeOf(param: Pick<Param, "type">): ParamType {

    return param.type ?? "string";
}

/**
 * Whether a param's answer is one piece of text - typed, or a path
 * picked in a dialog. What a text box edits and `${{ params.X }}`
 * hands over whole.
 */
export function isTextParam(param: Pick<Param, "type">): boolean {

    const type = paramTypeOf(param);

    return type === "string" || type === "file" || type === "folder";
}

/**
 * A value coerced to a param's type, or the reason it cannot be.
 *
 * Text and the scalars a page might send (a number, a boolean) become
 * a string param's text. A list needs a list and a map a plain map -
 * nothing is guessed from a string that looks like JSON, because a
 * value that was meant as text must stay text.
 */
export function coerceParamValue(param: Pick<Param, "name" | "type">, value: unknown): { value: ParamValue } | { error: string } {

    const type = paramTypeOf(param);

    if (isTextParam(param))
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
            ? { value: String(value) }
            : { error: `Param '${param.name}' is ${type === "string" ? "text" : `a ${type} path`}, but was given ${describe(value)}.` };

    if (type === "list")
        return Array.isArray(value)
            ? { value }
            : { error: `Param '${param.name}' is a list, but was given ${describe(value)}.` };

    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? { value: value as Record<string, unknown> }
        : { error: `Param '${param.name}' is a map, but was given ${describe(value)}.` };
}

/**
 * A list or map param typed into a text box: JSON, then coerced. Empty
 * text is "no answer", the same as an empty string param. Never for a
 * string param - its text is its value, JSON-looking or not.
 */
export function parseJsonParam(param: Pick<Param, "name" | "type">, text: string): { value: ParamValue | "" } | { error: string } {

    if (!text.trim())
        return { value: "" };

    let parsed: unknown;

    try {

        parsed = JSON.parse(text);

    } catch (error) {

        return { error: `Param '${param.name}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
    }

    return coerceParamValue(param, parsed);
}

function describe(value: unknown): string {

    if (value === null) return "null";
    if (Array.isArray(value)) return "a list";
    if (typeof value === "object") return "a map";
    if (typeof value === "string") return `text ('${value.length > 40 ? `${value.slice(0, 40)}…` : value}')`;

    return `a ${typeof value}`;
}

export interface Stage {

    name: string;

    /** Optional prose shown under the stage heading, when the author supplies it. */
    desc?: string;

    /**
     * Whether this stage runs at all, answered when the walk reaches it,
     * never at run start - earlier stages' outputs do not exist yet.
     * False skips the stage without failing the run. A stage that must
     * not run without an input should declare the input and fail, not
     * condition on it.
     */
    if?: string;

    /**
     * The document this stage produces, when it is a document phase -
     * `${{ vars.SPEC }}/requirements.md`. A surface reads the phase-to-
     * file map from here: present means a document phase whose file
     * presence is its state; absent means an execution stage. Declares
     * what the stage yields, not what any task may write.
     */
    artifact?: string;

    /**
     * Ordered - the list order is the execution order, so the file reads
     * top-to-bottom as it runs. No task-level `needs:` here and no job
     * level; a task's own `env:`/`vars:` merge directly over the file's.
     */
    tasks: Task[];
}

/** One step's own YAML, as written in its file - see `stepSources`. */
export interface StepSource {

    /** The step's lines, with the file's indent taken off. */
    text: string;

    /** The file line the step starts on, counted from 1. */
    line: number;
}

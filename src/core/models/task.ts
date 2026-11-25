/**
 * What one unit of work is, and the values it carries.
 *
 * A task is the smallest thing this engine runs: one plugin, with its
 * args, in one directory, under one set of values. Everything about a
 * *run* of one is in `run.ts`; everything about the file a task was
 * declared in is in `workflowTypes.ts`.
 */

/**
 * Everyone is assumed to run the same OS, so there is no per-task
 * runner selection. The only per-command variation is which shell a
 * script needs.
 *
 * `pwsh` must be named explicitly. A task with no `shell:` runs through
 * what the OS provides (`cmd` on Windows, `bash` elsewhere), not a shell
 * someone may not have installed. See `ProcessRunner`.
 */
export type Shell = "pwsh" | "cmd" | "bash";

/** Environment variable map, e.g. `{ NODE_ENV: "production" }`. */
export type EnvVars = Record<string, string>;

/**
 * Values for templating the file itself, readable as `${{ vars.NAME }}`.
 *
 * Not the same thing as {@link EnvVars}:
 *
 *   - `env:` is the environment a process is spawned with. Strings
 *     only, readable by anything you run.
 *   - `vars:` never leave the engine. They are substituted into the
 *     file's own fields and keep their YAML type, so a plugin's input
 *     schema can check a number as a number.
 *
 * Merging the two would put every templated value into the environment
 * of every process the run spawns.
 */
export type Vars = Record<string, unknown>;

/**
 * What a task's `run:` desugars to at parse time - the shell plugin.
 *
 * After parsing, every runnable task names a plugin; a `run:` task
 * names this one, with the command as `args.script` and any `shell:`
 * as `args.shell`. The engine never spawns anything itself.
 */
export const SHELL_PLUGIN = "shell@1";

/**
 * The plugin that holds a conversation with an agent. Named here so a
 * surface checking for it does not match a string it typed itself.
 */
export const AI_PLUGIN = "ai@1";

/**
 * One runnable unit - the same task everywhere a task can appear.
 *
 * A task is written with one syntax whether it sits in a `tasks.yml`
 * `tasks:` map or in a stage's `tasks:` list: a bare string (shorthand
 * for `run:`), or a block with `run:` / `uses:` / `args:` and the keys
 * below. `TaskParser` produces it for both, and after parsing every
 * runnable task is a plugin: `run:` and `shell:` desugar to
 * {@link SHELL_PLUGIN}.
 *
 * What differs between the two homes:
 *
 *   - `id`: the `tasks:` map key in `tasks.yml`. A stage's list entries
 *     have none; their run-time id comes from `DefaultWalker`.
 *   - `needs`: meaningful between `tasks.yml` tasks. Inside a stage the
 *     list order sequences the tasks, so a task-level `needs:` there is
 *     rejected at parse time rather than silently ignored.
 */
export interface Task {

    /**
     * The `tasks:` map key in `tasks.yml`, referenced by another task's
     * `needs:`. Absent for a workflow task, whose id `DefaultWalker`
     * assigns.
     */
    id?: string;

    name: string;

    /** Optional human-readable description, shown as the tree row's tooltip when present. */
    desc?: string;

    /**
     * Tasks that must already have run before this one starts.
     *
     * Not a schedule: nothing in a `tasks.yml` runs on its own. Running
     * this task pulls in its `needs:` chain first. Two tasks with no
     * `needs:` between them never run together.
     *
     * Always `[]` for a workflow task - a stage's tasks run in list order.
     */
    needs: string[];

    /**
     * A plugin reference, `id@version`.
     *
     * The YAML key is `uses:`; `TaskParser` translates it into this
     * field (a `run:` task gets {@link SHELL_PLUGIN}). Absent only for a
     * pure composition task - `needs:` and nothing of its own.
     */
    plugin?: string;

    /** Raw `args:` block, before templating. For a desugared `run:` task: `{ script, shell? }`. */
    args?: Record<string, unknown>;


    /**
     * Who starts this task. `manual` stops the run until a human clicks
     * Run.
     *
     * Required on the model even though the YAML key is optional: the
     * parser defaults it, so no consumer can treat `undefined` as auto.
     */
    trigger: "auto" | "manual";

    /**
     * Name of the run variable this task's artifact - what its plugin
     * produced - is stored under. The YAML key is `artifact:`.
     */
    artifact?: string;

    /**
     * Whether this task runs at all, as a condition resolved like any
     * other field and then evaluated - see `condition.ts` for the grammar.
     *
     * A false condition is a skip, not a failure: the tasks after it
     * still run.
     */
    if?: string;

    /**
     * Lets a task that `needs:` this one carry on when this task fails.
     *
     * Only for the task's own failure - a non-zero exit, a plugin
     * returning `{ success: false }`. A rejected gate and a stopped run
     * are never swallowed by it.
     */
    continueOnError?: boolean;

    /**
     * How long this task gets, in milliseconds, before it is killed.
     *
     * Stored resolved rather than as the author's `30s`, so nothing
     * downstream parses a duration a second time. Absent means no limit,
     * which is right for a task like `dotnet watch`.
     */
    timeout?: number;

    /**
     * How many extra attempts a failed task gets. `retries: 2` means up
     * to three runs in total. Extra rather than total, so `retries: 0`
     * and "no retries" mean the same thing.
     */
    retries?: number;

    /**
     * Run once per item of a list, one after another. An expression
     * that resolves to a list - `${{ params.releases }}`,
     * `${{ run.context.CREATED.items }}` - or a literal list.
     *
     * Each item gets its own attempt, its own `retries:`, its own gate
     * when `trigger: manual`, and its own lines in the log. Not
     * parallelism: items share one working tree, so they take turns.
     */
    foreach?: string | unknown[];

    /**
     * The name the item is read by - `${{ item }}`, `${{ item.id }}` -
     * and, with `Index` appended, its position: `${{ itemIndex }}`.
     * Defaults to `item`.
     */
    foreachAs?: string;

    /**
     * Whether the first failing item stops the loop. Default true. Off,
     * every item is attempted and the task fails if any did.
     */
    failFast?: boolean;

    /** Merged with (and overriding) the workflow-level env for this task. */
    env: EnvVars;

    /** Merged with (and overriding) the workflow-level vars for this task. */
    vars: Vars;

    /** `.env` files layered under this task's own `env:`. */
    dotenv: string[];

    /**
     * Directory this task runs in, relative to the workflow file's
     * project directory. Defaults to that directory when omitted.
     */
    cwd?: string;
}

import { SHELL_PLUGIN, Task } from "../core/models/task";
import { RunStatus } from "../core/models/run";
import { Workflow } from "../core/models/workflowTypes";

/**
 * What the run map draws, independent of which file format produced it.
 * Each format projects onto this. The status keys are resolved here: a
 * task id is whatever the walker reports under (the task's own `id` for
 * `tasks.yml`, `<stage>/<n>` for a workflow file), so the layout never
 * sees either id shape.
 */
export interface RunGraph {

    name: string;

    /** Whether to draw stage bands. False for `tasks.yml`, whose jobs sit in one synthetic stage. */
    showStages: boolean;

    stages: GraphStage[];
}

export interface GraphStage {

    name: string;

    desc?: string;

    jobs: GraphJob[];
}

export interface GraphJob {

    /** The key its status arrives under, via `onOwnerStatus`. */
    id: string;

    name: string;

    desc?: string;

    /** Ids of the jobs that must finish first. Drawn as incoming edges. */
    needs: string[];

    tasks: GraphTask[];
}

export interface GraphTask {

    /** The key its status arrives under, via `onTaskStatus` - the walker's task id. */
    id: string;

    name: string;

    /** Secondary line: the task, or the command, when the name does not already say it. */
    detail?: string;

    /** The `id@version` it runs, for a `uses:` task - lets a row offer plugin-specific actions. */
    plugin?: string;

    manual: boolean;
}

/** The status a set of things has as a group - the worst of them. */
export function rollUp(statuses: (RunStatus | undefined)[]): RunStatus | undefined {

    if (statuses.some(s => s === RunStatus.Failed)) return RunStatus.Failed;
    if (statuses.some(s => s === RunStatus.Running)) return RunStatus.Running;
    if (statuses.some(s => s === RunStatus.Waiting)) return RunStatus.Waiting;
    if (statuses.length > 0 && statuses.every(s => s === RunStatus.Success)) return RunStatus.Success;
    if (statuses.some(s => s === RunStatus.Skipped)) return RunStatus.Skipped;

    return undefined;
}

/** The graph a workflow draws as, chosen by the workflow's `engine`. */
export function graphOf(workflow: Workflow): RunGraph {

    return workflow.engine === "inline"
        ? graphOfInline(workflow)
        : graphOfDefault(workflow);
}

/**
 * A stage projects as one box holding its tasks in order. Its id is the
 * stage name, which is what `onOwnerStatus` reports. `GraphJob` here
 * only means "a box with task rows".
 */
export function graphOfDefault(file: Workflow): RunGraph {

    return {

        name: file.name,

        showStages: true,

        stages: file.stages.map(stage => ({

            name: stage.name,
            desc: stage.desc,

            jobs: [{

                id: stage.name,
                name: stage.name,
                desc: stage.desc,
                needs: [],

                tasks: stage.tasks.map((task, index) => ({
                    id: `${stage.name}/${index}`,
                    name: task.name,
                    detail: task.plugin,
                    plugin: task.plugin,
                    manual: task.trigger === "manual"
                }))
            }]
        }))
    };
}

/**
 * Projects a `tasks.yml` workflow onto the same graph. A task becomes a
 * job (it has `needs:` and a status) holding one row, itself, so this
 * view draws every kind of workflow the same way.
 */
export function graphOfInline(workflow: Workflow): RunGraph {

    const known = new Set(workflow.tasks.map(task => task.id));

    return {

        name: workflow.name,

        showStages: false,

        stages: [{

            name: "",

            // `id!`: a `tasks.yml` task always carries its map key as
            // `id`.
            jobs: workflow.tasks.map(task => ({

                id: task.id!,
                name: task.name || task.id!,
                desc: task.desc,

                // A `needs:` naming a task not in this run is dropped
                // rather than drawn as an edge to nowhere; the executor
                // already warns about it.
                needs: task.needs.filter(dependency => known.has(dependency)),

                tasks: [{
                    id: task.id!,
                    name: taskName(task),
                    detail: taskDetail(task),
                    plugin: task.plugin,
                    manual: task.trigger === "manual"
                }]
            }))
        }]
    };
}

/** Whether the task has a name the author wrote. The parser defaults `name` to the map key. */
function named(task: Task): boolean {

    return Boolean(task.name) && task.name !== task.id;
}

/** What to call a `tasks.yml` task: its `name:` when it has one, else whatever it does. */
function taskName(task: Task): string {

    if (named(task))
        return task.name;

    const script = scriptOf(task);

    if (script)
        return firstLine(script);

    return task.plugin ?? task.name ?? "Task";
}

/** The second line - skipped when the name is already the command, so it is not printed twice. */
function taskDetail(task: Task): string | undefined {

    const script = scriptOf(task);

    if (script)
        return named(task) ? firstLine(script) : undefined;

    return task.plugin;
}

/** The command line of a desugared run: task, or undefined for a real plugin task. */
function scriptOf(task: Task): string | undefined {

    return task.plugin === SHELL_PLUGIN && typeof task.args?.script === "string"
        ? task.args.script
        : undefined;
}

function firstLine(text: string): string {

    const line = text.split("\n").find(candidate => candidate.trim().length > 0) ?? text;

    return line.trim();
}

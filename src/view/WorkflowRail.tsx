import React from "react";

import { RunStatus } from "../core/models/run";
import { TaskProblem } from "../core/validation/ValidationIssue";
import { RunGraph } from "./runGraph";
import { Button, Chip, StatusIcon, StepTree, UiIcon } from "./ui";
import type { StepTreeItem } from "./ui";

/**
 * The pipeline as a tree - the UI library's StepTree: stage rows that
 * fold, step rows in execution order under them, top to bottom as the
 * file reads.
 *
 * Fold behaviour: every stage starts open. A click on a stage holds it
 * however the person put it, for as long as the view lives.
 *
 * The inline template (tasks.yml) has no stage names (`showStages`
 * false), so it draws as a flat list of step rows.
 */
interface WorkflowRailProps {

    graph: RunGraph;

    taskStatuses: Record<string, RunStatus>;

    ownerStatuses: Record<string, RunStatus>;

    selectedTaskId?: string;

    taskProblems: Record<string, TaskProblem>;

    onSelectTask(taskId: string, boxId: string): void;

    /** Absent while the run is going - nothing may be rerun under a walk in flight. */
    onRerunTask?(taskId: string, name: string, plugin?: string): void;
}

/**
 * A step's status as an icon, coloured by state - see
 * `StatusIcon`. A step not reached yet that is a gate shows the gate's
 * ring up front, so it is known before Run is pressed.
 */
export function RailIcon({ status, gate }: { status: RunStatus; gate: boolean }) {

    return <StatusIcon status={status} gate={gate} size="base" />;
}

/** A stage's id in the tree, kept apart from step ids. */
const stageKey = (name: string) => `stage:${name}`;

export default function WorkflowRail({
    graph, taskStatuses, ownerStatuses, selectedTaskId, taskProblems, onSelectTask, onRerunTask
}: WorkflowRailProps) {

    /** The stages folded or opened by hand. Every other stage is open. */
    const [chosen, setChosen] = React.useState<Record<string, boolean>>({});

    /** Which box each step runs in - what a selection reports back. */
    const boxOf = new Map<string, string>();

    const expanded: Record<string, boolean> = {};

    const step = (task: RunGraph["stages"][number]["jobs"][number]["tasks"][number], boxId: string, headed: boolean): StepTreeItem => {

        boxOf.set(task.id, boxId);

        // A step the walker never reached has no status of its own: use
        // the box's for a flat (inline) row, pending for a staged one.
        const status = taskStatuses[task.id]
            ?? (headed ? RunStatus.Pending : ownerStatuses[boxId] ?? RunStatus.Pending);

        const problem = taskProblems[task.id];

        const ai = task.plugin?.startsWith("ai@") === true;

        return {
            id: task.id,
            label: task.name,
            // The full name, for when the rail cuts it short.
            title: problem ? `${task.name}
${problem.message}` : task.name,
            icon: <RailIcon status={status} gate={task.manual} />,

            // Shown before Run is pressed: a problem found in the file,
            // and whether the step stops for a person.
            badge: problem || task.manual
                ? (
                    <>
                        {problem && (
                            <span
                                className={problem.severity === "error" ? "text-error" : "text-warning"}
                                role="img"
                                aria-label={`${problem.severity}: ${problem.message}`}>
                                <UiIcon name={problem.severity === "error" ? "error" : "warning"} size="sm" />
                            </span>
                        )}

                        {task.manual && (
                            <Chip variant="warning" title="Stops here for a person (trigger: manual)">gate</Chip>
                        )}
                    </>
                )
                : undefined,

            meta: task.plugin,

            // Rerun one task of a finished run. An ai step gets an
            // edited prompt; an ordinary step gets the button once it
            // has failed, and the host confirms instead of prompting.
            actions: onRerunTask && (ai || status === RunStatus.Failed)
                ? (
                    <Button
                        fill="ghost"
                        size="icon"
                        title={ai
                            ? `Run '${task.name}' again with a revised prompt`
                            : `Run '${task.name}' again - every other step keeps its result`}
                        aria-label={`Run '${task.name}' again`}
                        onClick={() => onRerunTask(task.id, task.name, task.plugin)}>
                        <UiIcon name="replay" size="sm" />
                    </Button>
                )
                : undefined
        };
    };

    const items: StepTreeItem[] = graph.stages.flatMap(stage => {

        const headed = graph.showStages && stage.name !== "";

        const rows = stage.jobs.flatMap(job => job.tasks.map(task => step(task, job.id, headed)));

        if (!headed)
            return rows;

        const key = stageKey(stage.name);

        // Open unless this stage was folded by hand.
        const open = chosen[key] ?? true;

        expanded[key] = open;

        // One box per stage, so its id is the stage name, which is what
        // the runner reports.
        const stageStatus = ownerStatuses[stage.jobs[0]?.id] ?? RunStatus.Pending;

        return [{
            id: key,
            label: stage.name,
            title: stage.name,
            icon: <RailIcon status={stageStatus} gate={false} />,
            meta: open ? undefined : `${rows.length} ${rows.length === 1 ? "step" : "steps"}`,
            children: rows
        }];
    });

    return (
        <StepTree
            className="rail"
            ariaLabel="Pipeline"
            items={items}
            selectedId={selectedTaskId}
            expanded={expanded}
            onToggle={(id, open) => setChosen(previous => ({ ...previous, [id]: open }))}
            onSelect={id => onSelectTask(id, boxOf.get(id) ?? id)} />
    );
}

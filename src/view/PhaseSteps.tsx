import React from "react";
import { RunStatus } from "../core/models/run";
import { StatusIndicator } from "./ui";
import { RailIcon } from "./WorkflowRail";

/**
 * The spec panel's phases, as one row of steps in the header.
 *
 * It is a row, not a column down the left: a spec has five or so phases, so most of a column would be empty. A row in the header costs
 * no width at all. On a narrow panel the steps wrap onto a second line
 * rather than hiding any names.
 *
 * Kept apart from `WorkflowRail`: a spec's phases are a short flat
 * list, always all shown; a workflow's steps are a folding tree with
 * gate chips, problem marks and a rerun button per row. The two share
 * the status discs, so they look the same.
 */

/** The four things a phase can be, drawn as the run panel draws them. */
export type PhaseState = "done" | "active" | "running" | "pending";

export interface PhaseItem {

    id: string;

    label: string;

    state: PhaseState;

    /**
     * A question or permission request in this phase, or in a chat on
     * its page, is waiting for an answer. Drawn as the same pulsing
     * yellow dot the sessions pane uses for it.
     */
    waiting?: boolean;

    /** The tooltip on the step. */
    title?: string;
}

export interface PhaseStepsProps {

    items: PhaseItem[];

    /** The step whose tabs are shown below. */
    selectedId?: string;

    onSelect(id: string): void;
}

const STATUS: Record<PhaseState, RunStatus | undefined> = {
    done: RunStatus.Success,
    running: RunStatus.Running,
    active: RunStatus.Waiting,
    pending: undefined
};

const SPOKEN: Record<PhaseState, string> = {
    done: "done",
    running: "drafting",
    active: "current",
    pending: "not started"
};

export default function PhaseSteps({ items, selectedId, onSelect }: PhaseStepsProps) {

    return (
        /*
            A group of buttons, not a tablist: phases run in order and
            each has its own documents, so they are not alternative
            views of one thing. Every step is always pickable, because
            opening a phase is reading it, not running it.
        */
        <nav className="phase-steps" aria-label="Phases">

            {items.map((item, index) => {

                const selected = item.id === selectedId;

                return (
                    <React.Fragment key={item.id}>

                        {index > 0 && <span className="phase-steps__sep" aria-hidden="true">›</span>}

                        <button
                            className={"phase-steps__pick" + (selected ? " phase-steps__pick--on" : "")}
                            aria-current={selected ? true : undefined}
                            title={item.title}
                            onClick={() => onSelect(item.id)}>

                            <RailIcon status={STATUS[item.state] ?? RunStatus.Pending} gate={false} />

                            <span>{item.label}</span>

                            <span className="sr-only"> - {SPOKEN[item.state]}</span>

                            {item.waiting && (
                                <StatusIndicator
                                    className="phase-steps__waiting"
                                    status="connecting"
                                    srLabel="Waiting for you" />
                            )}
                        </button>
                    </React.Fragment>
                );
            })}
        </nav>
    );
}

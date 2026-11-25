import React from "react";
import { ValidationIssue } from "../../core/validation/ValidationIssue";
import { PhaseTab } from "../PhasePanel";
import { worst } from "./problemList";
import { EmptyNote } from "../ui";

/**
 * The Problems tab, for any panel that has problems to show.
 *
 * Where an issue points is a question the caller answers - see
 * {@link ProblemsTabProps.locate} - so the spec panel, which has no
 * execution graph, can use it too.
 *
 * The whole tab is shared, not just the list: the id, the label, the
 * count on the tab strip and its colour would drift if each panel
 * wrote its own.
 */

/** A place a problem points at, and what opening it does. */
export interface ProblemTarget {

    /** Shown on the row as where the problem is - a step name, a document name. */
    name: string;

    /** What clicking the row does. */
    open(): void;
}

export interface ProblemsTabProps {

    problems: readonly ValidationIssue[];

    /**
     * Where an issue points, if anywhere.
     *
     * Undefined is a real answer: an issue can be about the file as a
     * whole, or name something the panel no longer has. The row still
     * shows; it just does not link anywhere.
     */
    locate?(issue: ValidationIssue): ProblemTarget | undefined;

    /**
     * What to say when there are none. The caller's, because "valid"
     * has to name the thing that is valid - a workflow or a spec.
     */
    emptyText: string;
}

/**
 * Everything the validator found, whether or not it points anywhere.
 *
 * Listed in the order the validator produced them, not by severity:
 * that order follows the file and matches the log lines.
 */
export function ProblemsList({ problems, locate, emptyText }: ProblemsTabProps) {

    if (!problems.length)
        return <EmptyNote icon="passed" text={emptyText} />;

    return (
        <div className="problems">

            {problems.map((problem, index) => {

                const target = locate?.(problem);

                return (
                    <div
                        key={index}
                        className={`problem problem--${problem.severity}${target ? " problem--linked" : ""}`}
                        role={target ? "button" : undefined}
                        tabIndex={target ? 0 : undefined}
                        title={target ? `Show ${target.name}` : undefined}
                        onClick={target ? () => target.open() : undefined}>

                        <span className="problem__severity" aria-hidden="true">
                            {problem.severity === "error" ? "✕" : "!"}
                        </span>

                        <div className="problem__what">

                            <span className="problem__message">{problem.message}</span>

                            {/* Absent for an issue about the whole
                                definition rather than one part of it. */}
                            {target && <span className="problem__where">{target.name}</span>}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

/** The tab itself, ready to drop into either panel's tab list. */
export function problemsTab(props: ProblemsTabProps): PhaseTab {

    return {
        id: "problems",
        label: "Problems",

        // On the tab itself, so a problem is visible without opening
        // the tab that holds it.
        count: props.problems.length,
        countClass: `side-tab__count--${worst(props.problems)}`,
        title: "What the validator says about this definition",
        render: () => <ProblemsList {...props} />
    };
}

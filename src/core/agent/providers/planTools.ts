import * as fs from "fs";
import { z } from "zod";


/**
 * One tool, so an agent ticks a task without rewriting the plan.
 *
 * The plan's checkbox is the definition of done. Without this tool the
 * agent would have to read `tasks.md`, edit one
 * character and write the file back - a full document through the model
 * twice, for one `[x]`, on every task. This tool does the same one-character
 * change in-process: the agent names the task, the engine flips its
 * box and nothing else in the file.
 *
 * Registered only on a session that was handed a plan (see
 * `AgentSessionConfig.plan`) - a drafting phase has no boxes to tick.
 * Same route as the clocks: in-process, never deferred, nothing to
 * approve. The judgement is still the agent's; the engine writes only
 * what it was told, on the line it was told.
 */

export const TASK_DONE_TOOL_NAME = "task_done";

export const TASK_DONE_DESCRIPTION =
    "Ticks one task's checkbox in the plan - marks it done. Call it with the task's id exactly as "
    + "written in the plan (\"1.2\", \"3\", \"2.1.4\") the moment that task is finished and verified. "
    + "Do not edit the plan file to tick a box; this does it, and changes nothing else. "
    + "A task you could not finish is left alone - say what blocked you instead.";

/** The tool's input as a zod shape, for Claude's `tool()`. */
export const planToolShape = {

    task: z.string().describe("The task's id, exactly as the plan writes it - \"1.2\", \"3\".")
};

/** The same input as JSON Schema, for the runtimes that take one. */
export const planToolJsonSchema: Record<string, unknown> = {
    type: "object",
    properties: {
        task: { type: "string", description: "The task's id, exactly as the plan writes it - \"1.2\", \"3\"." }
    },
    required: ["task"],
    additionalProperties: false
};

export interface PlanToolInput {

    task: string;
}

/**
 * A checkbox row and its id: `- [ ] 1.2 Title`, `  - [x]* 3 Title`,
 * with the trailing dot a top-level number may carry. Any depth of
 * indent; the id is whatever sits after the box.
 */
const ROW = /^(\s*-\s+\[)([ xX~-])(\]\*?\s+)(\S+?)\.?(\s.*)?$/;

/**
 * Ticks the box of the task with this id, in this file, and says what
 * happened - a sentence for the model, never a throw: a wrong id is
 * something the agent should read and act on, not a crash in its tool.
 *
 * Idempotent: a box already ticked is reported, not toggled.
 */
export function markTaskDone(planPath: string, input: PlanToolInput): string {

    const wanted = String(input?.task ?? "").trim().replace(/\.$/, "");

    if (!wanted)
        return "No task id given. Call task_done with the id exactly as the plan writes it, such as \"1.2\".";

    let text: string;

    try {

        text = fs.readFileSync(planPath, "utf8");

    } catch (error) {

        return `The plan could not be read: ${(error as Error).message}`;
    }

    const newline = text.includes("\r\n") ? "\r\n" : "\n";

    const lines = text.split(/\r?\n/);

    const at = lines.findIndex(line => {

        const match = ROW.exec(line);

        return match !== null && match[4] === wanted;
    });

    if (at < 0)
        return `No task '${wanted}' in the plan. The id is what sits after the checkbox on the task's own line - check it and call again.`;

    const match = ROW.exec(lines[at])!;

    if (match[2].toLowerCase() === "x")
        return `Task ${wanted} was already ticked.`;

    // The first bracket pair on the line is the box - the row matched
    // from its start - so only that character changes.
    lines[at] = lines[at].replace(/\[[ xX~-]\]/, "[x]");

    try {

        fs.writeFileSync(planPath, lines.join(newline), "utf8");

    } catch (error) {

        return `The plan could not be written: ${(error as Error).message}`;
    }

    return `Ticked task ${wanted}.`;
}

/**
 * The other plan tool: the phase that *writes* the plan checks it the
 * way the panel will read it, before it stops. Without it the agent
 * would find out one revise pass later, when the panel listed the problems
 * over the document it had already finished.
 *
 * Registered on a session whose target is a plan (see
 * `AgentSessionConfig.checkPlan`). Reads the file, runs the same parser
 * the implement phase runs, and says what it would refuse - line by
 * line - plus the one check the parser leaves to the panel: two tasks
 * of one wave naming the same file.
 */

export const CHECK_PLAN_TOOL_NAME = "check_plan";

export const CHECK_PLAN_DESCRIPTION =
    "Checks the plan file you are writing the way the implement phase will read it: every checkbox "
    + "row, every id, the Files: lines and the Task Dependency Graph. Returns the problems by line, or "
    + "\"No problems.\" Call it after writing the file and again after every fix, until it reports none - "
    + "a problem it lists is a task the implement phase will not run.";

/** No input: the file is the session's own target. */
export const checkPlanShape = {};

export const checkPlanJsonSchema: Record<string, unknown> = {
    type: "object",
    properties: {},
    additionalProperties: false
};

/**
 * What reads a plan: the problems in it, as sentences for the model,
 * and one line on what it read when there are none. The engine does
 * not know a plan's shape - that is SDD's parser - so the reader is
 * handed in at start (see `usePlanChecker`), and the engine's
 * boundary stays where it is: nothing under `src/core` imports SDD.
 */
export interface PlanChecker {

    /** The problems, each a sentence naming its line where it has one. Empty is a clean plan. */
    problems(text: string): string[];

    /** One line on a clean plan - how many rows, how many waves - so the agent knows what was read. */
    summary(text: string): string;
}

let planChecker: PlanChecker | undefined;

/** Hands the engine the plan reader. Called once at start by the layer that owns the parser. */
export function usePlanChecker(checker: PlanChecker | undefined): void {

    planChecker = checker;
}

/**
 * The report, as text for the model. A missing file is a report too -
 * the phase has not written it yet, which is the first thing to fix.
 */
export function checkPlan(planPath: string): string {

    if (!planChecker)
        return "No plan checker is registered in this build, so the plan cannot be checked here. Follow the grammar exactly.";

    let text: string;

    try {

        text = fs.readFileSync(planPath, "utf8");

    } catch {

        return `The plan is not on disk yet at ${planPath}. Write it, then call check_plan again.`;
    }

    const problems = planChecker.problems(text);

    if (!problems.length)
        return `No problems. ${planChecker.summary(text)}`;

    return `${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map(one => `- ${one}`).join("\n")}`;
}

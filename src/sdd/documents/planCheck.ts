import { parsePlan } from "./parsePlan";
import { conflicts } from "../phase/waves";
import type { PlanChecker } from "../../core/agent/providers/planTools";

/**
 * The plan read the way the panel reads it, for the `check_plan` tool:
 * the parser's own problems, plus the one check the parser leaves to
 * the panel - two tasks of one wave naming the same file, which the
 * panel refuses before a chat opens. Reported here so the plan is
 * fixed before anyone presses ▶.
 *
 * Registered into the engine at start-up - see `usePlanChecker` -
 * because the engine cannot import this layer.
 */
export const planChecker: PlanChecker = {

    problems(text) {

        const plan = parsePlan(text);

        const problems = plan.problems.map(problem =>
            problem.line > 0 ? `line ${problem.line}: ${problem.message}` : problem.message);

        for (const wave of plan.waves ?? [])
            for (const clash of conflicts(wave.tasks.map(id => ({ id })), id => plan.tasks.find(task => task.id === id)?.files ?? []))
                problems.push(
                    `wave ${wave.id}: ${clash.tasks.join(" and ")} both name '${clash.path}' - two tasks in one wave `
                    + "must not touch the same file; move one to a later wave.");

        return problems;
    },

    summary(text) {

        const plan = parsePlan(text);

        const waves = plan.waves?.length ?? 0;

        return `${plan.tasks.length} task row${plan.tasks.length === 1 ? "" : "s"}, ${waves} wave${waves === 1 ? "" : "s"}, read as the ${plan.dialect} shape.`;
    }
};

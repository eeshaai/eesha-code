import { describe, expect, it } from "vitest";
import { ValidationIssue } from "../../../core/validation/ValidationIssue";
import { problemsTab } from "../ProblemsTab";

/**
 * The tab both panels get from one place.
 *
 * What is defended is the part that would drift if each panel wrote its
 * own: the id the panel switches on, and the count on the tab strip
 * with the colour that count carries. The rows themselves are JSX and
 * this layer has no DOM test setup - `e2e/runPanel.spec.ts` is what
 * reads them.
 */

const issue = (severity: "error" | "warning"): ValidationIssue =>
    ({ ownerId: "o", message: "m", severity });

describe("the shared Problems tab", () => {

    it("is the id and label both panels switch on", () => {

        const tab = problemsTab({ problems: [], emptyText: "" });

        expect(tab.id).toBe("problems");
        expect(tab.label).toBe("Problems");
    });

    /**
     * Zero has to be zero rather than absent-looking: `PhasePanel` draws
     * no badge for a falsy count, which is what an empty list should
     * get.
     */
    it("counts nothing when there is nothing", () => {

        expect(problemsTab({ problems: [], emptyText: "" }).count).toBe(0);
    });

    it("counts every issue, whether or not it names a task", () => {

        expect(problemsTab({
            problems: [issue("warning"), issue("error")],
            emptyText: ""
        }).count).toBe(2);
    });

    /** One error under warnings is still an error - see `worst`. */
    it("colours the count by the worst severity, not by the majority", () => {

        expect(problemsTab({
            problems: [issue("warning"), issue("warning"), issue("error")],
            emptyText: ""
        }).countClass).toBe("side-tab__count--error");

        expect(problemsTab({
            problems: [issue("warning")],
            emptyText: ""
        }).countClass).toBe("side-tab__count--warning");
    });
});

import { describe, expect, it } from "vitest";
import { ValidationIssue } from "../../../core/validation/ValidationIssue";
import { RunGraph } from "../../runGraph";
import { stationOf, worst } from "../problemList";

const issue = (severity: "error" | "warning"): ValidationIssue =>
    ({ ownerId: "o", message: "m", severity });

const graph: RunGraph = {
    name: "W",
    stages: [{
        name: "only",
        jobs: [{
            id: "work",
            name: "work",
            tasks: [
                { id: "only/work/0", name: "Sign A" },
                { id: "only/work/1", name: "Sign B" }
            ]
        }]
    }]
} as unknown as RunGraph;

describe("reading a problem list", () => {

    describe("worst", () => {

        /**
         * One error under nine warnings is still an error. A badge that
         * went yellow because errors were outnumbered would tell the
         * reader the opposite of the truth.
         */
        it("is error when a single error hides among warnings", () => {

            expect(worst([issue("warning"), issue("warning"), issue("error")])).toBe("error");
        });

        it("is warning when there are only warnings", () => {

            expect(worst([issue("warning"), issue("warning")])).toBe("warning");
        });
    });

    describe("stationOf", () => {

        it("finds the task and the job holding it, which selecting needs both of", () => {

            expect(stationOf(graph, "only/work/1")).toEqual({ name: "Sign B", jobId: "work" });
        });

        /** An issue about the file rather than about a task - the kind the map could never show. */
        it("is undefined for an issue that names no task", () => {

            expect(stationOf(graph, undefined)).toBeUndefined();
        });

        /**
         * A real answer, not a failure: a definition edited since the run
         * can leave an id the current graph has no station for. The row
         * still shows, it just does not offer to go anywhere.
         */
        it("is undefined for a task id the graph does not have", () => {

            expect(stationOf(graph, "only/work/9")).toBeUndefined();
        });
    });
});

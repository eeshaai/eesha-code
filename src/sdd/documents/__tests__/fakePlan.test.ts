import { describe, expect, it } from "vitest";

import { fakePlan } from "../../../core/agent/providers/FakeProvider";
import { planChecker } from "../planCheck";

/*
 * The fake runtime's plan must be one the implement phase can run, read
 * by the real plan parser - a test under src/core cannot import it.
 */
describe("the fake runtime's plan", () => {

    it("has no problems for the real plan checker", () => {

        expect(planChecker.problems(fakePlan(1))).toEqual([]);
    });

    it("still has none after a revise", () => {

        expect(planChecker.problems(fakePlan(3))).toEqual([]);
    });
});

import { describe, expect, it } from "vitest";

import { sourceLabel, specNameProblem } from "../newSpec";

/**
 * The spec's name becomes a folder, so the rules are checked while the
 * person types. One copy of the rules, here.
 */
describe("a new spec's name", () => {

    const taken = new Set(["mask-secrets"]);

    it("takes a plain folder name", () => {

        expect(specNameProblem("retry-on-timeout", taken)).toBeUndefined();
    });

    it("refuses an empty name", () => {

        expect(specNameProblem("   ", taken)).toBe("A spec needs a name.");
    });

    it("refuses characters a folder name should not have", () => {

        expect(specNameProblem("retry on timeout", taken)).toContain("Letters, digits");
    });

    it("refuses a name another spec folder already has", () => {

        expect(specNameProblem(" mask-secrets ", taken)).toBe("A spec folder named 'mask-secrets' already exists.");
    });
});

describe("where a spec's work item comes from", () => {

    it("names each source the way the pick shows it", () => {

        expect(["ado", "gh", "file", "manual"].map(sourceLabel)).toEqual([
            "Azure DevOps work item", "GitHub issue", "A file with the ask", "Describe it myself"
        ]);
    });
});

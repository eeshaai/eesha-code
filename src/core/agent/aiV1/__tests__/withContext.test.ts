import { describe, expect, it } from "vitest";
import { withContext } from "../index";

describe("withContext", () => {

    it("returns the prompt untouched when there is no context", () => {

        expect(withContext("do the thing", undefined)).toBe("do the thing");
        expect(withContext("do the thing", {})).toBe("do the thing");
    });

    it("lays documents before the prompt, instructions last", () => {

        const composed = withContext("write requirements", {
            brief: "# The brief\ncontent"
        });

        expect(composed).toBe(
            "=== DOCUMENT: brief ===\n\n# The brief\ncontent\n\n=== INSTRUCTIONS ===\n\nwrite requirements");
    });

    it("leaves out documents that resolved empty", () => {

        // An `optional:` file that wasn't there arrives as "" - presenting
        // an empty section invites the agent to remark on it.
        const composed = withContext("write requirements", {
            brief: "the brief",
            principles: ""
        });

        expect(composed).not.toContain("principles");
        expect(composed).toContain("DOCUMENT: brief");
    });

    it("keeps document order", () => {

        const composed = withContext("p", { first: "1", second: "2" });

        expect(composed.indexOf("DOCUMENT: first")).toBeLessThan(composed.indexOf("DOCUMENT: second"));
    });
});

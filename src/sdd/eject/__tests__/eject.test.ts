import * as path from "path";
import { describe, expect, it } from "vitest";
import { freeStyleId, planEject, withStyleId } from "../eject";

const SOURCE = path.join("app", "resources", "styles", "kiro");
const TARGET = path.join("home", ".eesha", "styles", "kiro");

describe("planning an eject", () => {

    it("plans one copy per file, source and target joined per platform", () => {

        const plan = planEject({
            files: ["style.yml", "instructions/design.md"],
            sourceRoot: SOURCE,
            targetRoot: TARGET,
            exists: () => false
        });

        expect(plan.copies).toEqual([
            {
                relative: "instructions/design.md",
                from: path.join(SOURCE, "instructions", "design.md"),
                to: path.join(TARGET, "instructions", "design.md")
            },
            {
                relative: "style.yml",
                from: path.join(SOURCE, "style.yml"),
                to: path.join(TARGET, "style.yml")
            }
        ]);
    });

    it("reports the files already present at the target, and still plans them", () => {

        const plan = planEject({
            files: ["style.yml", "instructions/design.md", "instructions/tasks.md"],
            sourceRoot: SOURCE,
            targetRoot: TARGET,
            exists: relative => relative === "instructions/design.md"
        });

        expect(plan.collisions).toEqual(["instructions/design.md"]);

        // Present in the plan too: after an explicit yes the copy list
        // is the whole eject, not the eject minus what was asked about.
        expect(plan.copies.map(copy => copy.relative)).toContain("instructions/design.md");
    });

    it("orders copies by path, whatever order the walk found them in", () => {

        const plan = planEject({
            files: ["instructions/tasks.md", "style.yml", "instructions/design.md"],
            sourceRoot: SOURCE,
            targetRoot: TARGET,
            exists: () => false
        });

        expect(plan.copies.map(copy => copy.relative))
            .toEqual(["instructions/design.md", "instructions/tasks.md", "style.yml"]);
    });

    it("plans nothing for an empty style folder", () => {

        const plan = planEject({ files: [], sourceRoot: SOURCE, targetRoot: TARGET, exists: () => true });

        expect(plan.copies).toEqual([]);
        expect(plan.collisions).toEqual([]);
    });
});

/* A style lives in one place, so a copy gets an id of its own. */
describe("naming the copy", () => {

    it("takes the first free number after the built-in's id", () => {

        expect(freeStyleId("custom", new Set(["custom"]))).toBe("custom-1");
        expect(freeStyleId("custom", new Set(["custom", "custom-1", "custom-2"]))).toBe("custom-3");
    });

    it("fills a gap rather than counting past it", () => {

        expect(freeStyleId("custom", new Set(["custom", "custom-2"]))).toBe("custom-1");
    });

    it("rewrites the top-level id and leaves a stage's own id alone", () => {

        const text = "schema: 1\nid: custom\nname: Custom\nstages:\n  - id: design\n";

        expect(withStyleId(text, "custom-1")).toBe("schema: 1\nid: custom-1\nname: Custom\nstages:\n  - id: design\n");
    });

    it("refuses a style.yml with no top-level id to rename", () => {

        expect(() => withStyleId("schema: 1\nname: X\n", "x-1")).toThrow(/no top-level 'id:'/);
    });
});

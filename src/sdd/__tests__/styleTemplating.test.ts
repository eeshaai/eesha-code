import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SddCore } from "../SddCore";

/**
 * A `style.yml` read the way the program actually reads one.
 *
 * A registry must be built with a {@link ConfigTemplating}. Without one,
 * every anchor a style writes fails with "no workspace is open", and an
 * absolute `template:` inside the repository is refused instead of being
 * folded to a relative path. The parser's unit tests pass one in by hand,
 * and nothing else under `src/sdd` composes the real thing, so this test
 * does.
 */

let home: string;

let workspace: string;

const resources = path.resolve(__dirname, "..", "..", "..", "resources");

const core = () => SddCore.create({ workspace, resources, home });

/** A workspace style - what ejecting writes - with one stage edited. */
function ejectHouse(design: string): void {

    const folder = path.join(workspace, ".eesha", "styles", "house");

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "style.yml"), `
schema: 1
id: house
name: House
desc: Requirements, design, tasks, implement.

specTypes:
  - id: feature
    label: Feature
    stages: [requirements, design, tasks]

stages:
  - id: design
    instructions: ${design}
`, "utf8");
}

/** One spec folder, so discovery has something to place - opening document and all, since that is what makes it a spec. */
function spec(style?: string): void {

    const folder = path.join(workspace, ".eesha", "specs", "one");

    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(
        path.join(folder, "idea.md"),
        style ? `---\nstyle: ${style}\n---\n\n# The ask` : "# The ask",
        "utf8");
}

beforeEach(() => {

    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-styletmpl-")));
    workspace = path.join(home, "repo");

    fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("expressions in a style", () => {

    it("resolves ${{ workspaceFolder }} in a stage template", async () => {

        ejectHouse("${{ workspaceFolder }}/docs/shape.md");

        const style = await (await core()).registry.load("house");

        expect(style.stages.find(stage => stage.id === "design")?.instructions)
            .toEqual({ root: "repo", path: "docs/shape.md" });
    });

    /* The same path a person types after copying it out of the explorer. */
    it("folds an absolute template inside the repository back to a relative one", async () => {

        ejectHouse(path.join(workspace, "docs", "shape.md"));

        const style = await (await core()).registry.load("house");

        expect(style.stages.find(stage => stage.id === "design")?.instructions)
            .toEqual({ root: "repo", path: "docs/shape.md" });
    });

    it("still refuses a template that resolves outside the repository", async () => {

        ejectHouse("${{ workspaceFolder }}/../../.kiro/specs/_templates/requirements.md");

        await expect((await core()).registry.load("house"))
            .rejects.toThrow(/climbs out of the repository/);
    });
});

describe("a spec whose style will not load", () => {

    it("is reported with the parser's own words, not as a style nobody has", async () => {

        spec("house");
        ejectHouse("${{ workspaceFolder }}/../../.kiro/specs/_templates/requirements.md");

        const [found] = await (await core()).specs();

        expect(found.detection.style).toBeUndefined();
        expect(found.detection.reason).toContain("was found but could not be read");
        expect(found.detection.reason).toContain("climbs out of the repository");
        expect(found.detection.reason).not.toContain("no scope holds");
    });

    /* The built-in still reads, so the specs still place. */
    it("places normally when nothing is ejected", async () => {

        spec();

        const [found] = await (await core()).specs();

        expect(found.detection.style).toBe("custom");
    });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SddCore } from "../SddCore";

/**
 * The input gate, which runs no model.
 *
 * `idea.md` is written from what ＋ New Spec collected - the type, the
 * source, the pointer to a work item or the files copied into the
 * folder. Every one of those is something the person picked, so the
 * document is formatting rather than reasoning.
 *
 * What these pin is the part the next phase depends on: the frontmatter
 * that decides the pipeline, and a body that *points at* the source
 * material rather than summarising it. A summary here would be a lossy
 * copy sitting between the ask and every phase downstream.
 */

let home: string;

let workspace: string;

/** The shipped styles live under the repository's own `resources/`. */
const resources = path.resolve(__dirname, "..", "..", "..", "resources");

const core = () => SddCore.create({ workspace, resources, home });

beforeEach(() => {

    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-idea-")));
    workspace = path.join(home, "repo");

    fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("the idea document", () => {

    it("goes to the artifact the style declares", async () => {

        const written = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "manual", description: "Mask secrets in logs."
        });

        expect(written.artifact).toBe("idea.md");
    });

    /**
     * `type:` decides which pipeline the spec runs and is recorded
     * nowhere else, so it is the one field that cannot be wrong.
     */
    it("records the type and source as frontmatter the next phase reads", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "bug", source: "manual", description: "Logs leak tokens."
        });

        expect(text).toContain("spec: 1");
        expect(text).toContain("style: custom");
        expect(text).toContain("type: bug");
        expect(text).toContain("source: manual");
        expect(text).toContain("title: mask-secrets");
    });

    it("carries the description as the ask, for a spec described by hand", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "manual",
            description: "Secrets appear in run logs and must be masked."
        });

        expect(text).toContain("## What is being asked");
        expect(text).toContain("Secrets appear in run logs and must be masked.");
    });

    /**
     * Pointed at, never summarised. The requirements phase opens the
     * real file; a paraphrase here would compete with it and lose.
     */
    it("points at the copied files rather than restating them", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "file",
            files: ["brief.md", "thread.md"]
        });

        expect(text).toContain("- `brief.md`");
        expect(text).toContain("- `thread.md`");
        expect(text).toContain("Read them all in full");
        expect(text).toContain("source material, not a summary");
    });

    it("says 'it' for one file, because one file is not a set", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "file", files: ["the-ask.md"]
        });

        expect(text).toContain("The ask is in the file copied into this spec folder");
        expect(text).toContain("Read it in full");
    });

    it("records a work item id and tells the next phase to fetch it", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "ado", workItem: "48213"
        });

        expect(text).toContain("id: 48213");
        expect(text).toContain("work item 48213");
        expect(text).toContain("Azure DevOps MCP server");
    });

    it("records a url when one was pasted instead of an id", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "gh",
            workItem: "412", url: "https://github.com/o/r/issues/412"
        });

        expect(text).toContain("url: https://github.com/o/r/issues/412");
        expect(text).toContain("GitHub MCP server");
    });

    /** No empty keys. A blank `id:` is a field a later reader has to interpret. */
    it("leaves out the provenance keys a source does not have", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "manual", description: "A thing."
        });

        expect(text).not.toContain("id:");
        expect(text).not.toContain("url:");
    });

    it("says so plainly when nothing about the ask was recorded", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "manual"
        });

        expect(text).toContain("Nothing was recorded when this spec was created");
    });

    it("tells the reader the file is theirs to edit", async () => {

        const { text } = await (await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "feature", source: "manual", description: "A thing."
        });

        expect(text).toContain("Edit it freely");
    });

    it("refuses a spec type the style does not offer, naming the ones it has", async () => {

        await expect((await core()).idea({
            specName: "mask-secrets", style: "custom", specType: "epic", source: "manual"
        })).rejects.toThrow(/no spec type 'epic'.*'feature' and 'bug'/s);
    });

    /**
     * The document has to survive the round trip that matters: written
     * here, read back by discovery, and believed.
     */
    it("is read back by discovery as the spec type it declares", async () => {

        const built = await core();

        const { artifact, text } = await built.idea({
            specName: "mask-secrets", style: "custom", specType: "bug", source: "manual", description: "Logs leak tokens."
        });

        fs.mkdirSync(built.specPathOf("mask-secrets"), { recursive: true });
        fs.writeFileSync(path.join(built.specPathOf("mask-secrets"), artifact), text, "utf8");

        const [spec] = await built.specs();

        expect(spec.detection.style).toBe("custom");
        expect(spec.specType).toBe("bug");

        // Idea is satisfied the moment its document exists, so the
        // spec opens on the first phase that actually runs something.
        expect(spec.state?.next?.id).toBe("requirements");
    });
});

/**
 * A folder under the spec root with no opening document in it - the
 * copied ask and nothing else.
 *
 * It is not a spec and is not listed. ＋ New Spec writes `idea.md`
 * in the same call that creates the folder, so the only way to have one
 * of these is by hand, and drawing a pipeline for it put a whole
 * process in front of a folder nobody had started.
 */
describe("a folder holding only the copied ask", () => {

    function newSpecFolder(name: string, ask: Record<string, string>): void {

        const folder = path.join(workspace, ".eesha", "specs", name);

        fs.mkdirSync(folder, { recursive: true });

        for (const [file, text] of Object.entries(ask))
            fs.writeFileSync(path.join(folder, file), text, "utf8");
    }

    it("is not listed as a spec", async () => {

        newSpecFolder("generate-a-greeting-script", { "brief.md": "# The ask" });

        expect(await (await core()).specs()).toEqual([]);
    });

    /* Writing the opening document is what adopts the folder. */
    it("becomes one the moment its opening document is written", async () => {

        newSpecFolder("generate-a-greeting-script", {
            "brief.md": "# The ask",
            "idea.md": "# Generate a greeting script"
        });

        const [spec] = await (await core()).specs();

        expect(spec.detection.style).toBe("custom");
        expect(spec.specType).toBe("feature");
        expect(spec.detection.reason).toContain("the configured style");
        expect(spec.state?.next?.id).toBe("requirements");
    });
});

import { describe, expect, it } from "vitest";
import { IdeaInput, renderIdea } from "../ideaDocument";

/**
 * `idea.md` is the one document in the pipeline produced by code
 * rather than by a model, and the module says why: a shape produced by
 * code can be relied on. That is only true while something checks it.
 */
function idea(over: Partial<IdeaInput> = {}): string {

    return renderIdea({ specName: "greeting", style: "kiro", specType: "feature", source: "manual", ...over });
}

describe("what the next phase reads", () => {

    /*
     * Frontmatter is the whole reason this file is not a prompt's job:
     * discovery reads `type:` out of it to decide which pipeline the
     * spec runs.
     */
    it("opens with frontmatter carrying the type", () => {

        expect(idea({ specType: "bug" }).startsWith("---\nspec: 1\nstyle: kiro\ntype: bug\nsource: manual\n")).toBe(true);
    });

    /*
     * An empty `id:` is a key a later reader has to decide how to treat,
     * so provenance keys appear only where they mean something.
     */
    it("writes provenance keys only when there is provenance", () => {

        expect(idea()).not.toContain("id:");
        expect(idea()).not.toContain("url:");

        expect(idea({ source: "ado", workItem: "4471" })).toContain("id: 4471");
        expect(idea({ source: "gh", url: "https://github.com/x/y/issues/3" }))
            .toContain("url: https://github.com/x/y/issues/3");
    });

    it("titles the document with the spec's own name", () => {

        expect(idea()).toContain("# greeting");
    });
});

describe("the ask", () => {

    it("is the sentence a person typed, where they typed one", () => {

        expect(idea({ description: "Greet a named person." })).toContain("Greet a named person.");
    });

    /*
     * Pointed at rather than summarised. The requirements phase opens
     * the original, and a sentence here pretending to be the ask would
     * compete with it.
     */
    it("points at the files rather than describing them", () => {

        const text = idea({ source: "file", files: ["prd.md", "notes.md"] });

        expect(text).toContain("- `prd.md`");
        expect(text).toContain("- `notes.md`");
        expect(text).toContain("**Read them all in full.**");
        expect(text).toContain("They are this spec's source material");
    });

    /* One file is not "them all", and one file is not "they are". */
    it("agrees with itself when there is only one file", () => {

        const text = idea({ source: "file", files: ["prd.md"] });

        expect(text).toContain("The ask is in the file copied into this spec folder:");
        expect(text).toContain("**Read it in full.** It is this spec's source material");

        expect(text).not.toContain("them all");
        expect(text).not.toContain("They are");
    });

    it("names a work item and says to read its thread", () => {

        const text = idea({ source: "ado", workItem: "4471" });

        expect(text).toContain("work item 4471");
        expect(text).toContain("Azure DevOps MCP server");
    });

    it("calls a GitHub item an issue, not a work item", () => {

        expect(idea({ source: "gh", workItem: "12" })).toContain("issue 12");
    });

    /*
     * Said plainly rather than left blank: a phase reading this needs to
     * know the ask is thin, not guess that the section failed to render.
     */
    it("says so when nothing was recorded, rather than leaving a gap", () => {

        expect(idea()).toContain("Nothing was recorded when this spec was created.");
    });
});

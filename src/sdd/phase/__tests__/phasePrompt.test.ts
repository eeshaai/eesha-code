import { describe, expect, it } from "vitest";

import { configFromSettings } from "../../config/sddConfig";
import { parseStyle } from "../../parser/parseStyle";
import { StyleRegistry } from "../../registry/StyleRegistry";
import { Scope, StyleFiles } from "../../registry/styleFiles";
import { assemble, PhaseInput } from "../assemble";
import { BUILT_IN, PromptMode, promptFile, MODES, modeFor } from "../phasePrompt";

/*
 * A phase's prompt is a file in the style folder. Which of the four
 * runs is the engine's call; every word in the one that runs belongs to
 * whoever owns the file, and a scope that writes its own gets it
 * verbatim.
 */

const BASE = `
schema: 1
id: t
name: T
desc: A style written to exercise the frame.
specTypes:
  - id: full
    label: Full
    stages: [first, middle]
stages:
  - id: first
    produces: [one.md]
  - id: middle
    produces: [two.md]
`;

/** A style with the named stage citing its own items. */
function citing(stage: string, prefix: string): string {

    return BASE.replace(`  - id: ${stage}`, `  - id: ${stage}\n    prefix: ${prefix}`);
}

/**
 * The style `t`, in one scope only - a style lives in one place.
 *
 * @param own the style's own files beyond `style.yml` and its
 * instructions - a frame it wrote, keyed the way the registry asks for it.
 */
function registry(own: Record<string, string> = {}, scope: Scope = "workspace"): StyleRegistry {

    const all: Record<string, string> = {
        "style.yml": BASE,
        "instructions/first.md": "WRITE THE FIRST",
        "instructions/middle.md": "WRITE THE MIDDLE",
        "instructions/middle-implement.md": "HAND OFF",
        ...own
    };

    const files: StyleFiles = {
        styles: async (one: Scope) => one === scope ? ["t"] : [],
        read: async (one, styleId, relative) => styleId === "t" && one === scope ? all[relative] : undefined,
        pathOf: (one, styleId, relative) => `/styles/${one}/${styleId}/${relative}`,
        readWorkspace: async () => undefined,
        pathOfWorkspace: () => undefined
    };

    return new StyleRegistry(files, {});
}

async function prompt(over: Partial<PhaseInput> = {}, reg = registry()): Promise<string> {

    const input: PhaseInput = {
        style: parseStyle(BASE, "t"),
        config: configFromSettings(undefined),
        specDir: "specs/greeting",
        specType: "full",
        stageId: "middle",
        contents: ["one.md"],
        ...over
    };

    return (await assemble(input, reg)).prompt;
}

/** A style that wrote one of its own prompts. */
function owning(mode: PromptMode, text: string, scope: Scope = "workspace"): StyleRegistry {

    return registry({ [promptFile(mode)]: text }, scope);
}

/** A pass over a document this phase has already written. */
const written = { contents: ["one.md", "two.md"] };

describe("which frame a pass runs", () => {

    it("is the first one until the document exists", () => {

        expect(modeFor(false)).toBe("first");
        expect(modeFor(false, "")).toBe("first");
    });

    it("is the first one with the note when the spec's box had text", () => {

        expect(modeFor(false, "mobile only")).toBe("first-note");
        expect(promptFile("first-note")).toBe("prompts/first-note.md");
    });

    it("is the rewrite once it does", () => {

        expect(modeFor(true)).toBe("rewrite");
        expect(modeFor(true, "   ")).toBe("rewrite");
    });

    it("is the one with the note when somebody typed one", () => {

        expect(modeFor(true, "shorter")).toBe("rewrite-note");
    });

    /* The output gate rewrites nothing and takes no note: one file, whatever the folder holds. */
    it("is the implement one for the output gate, whatever else is true", () => {

        expect(modeFor(false, undefined, true)).toBe("implement");
        expect(modeFor(true, "shorter", true)).toBe("implement");
    });

    it("reads it from the style folder", () => {

        expect(promptFile("rewrite-note")).toBe("prompts/rewrite-note.md");
    });
});

describe("a style with no frame of its own", () => {

    it("gets the words this repository ships", async () => {

        const text = await prompt();

        expect(text).toContain("Chat is not the deliverable");
        expect(text).toContain("Read repository code only when **how** calls for it");
    });

    it("has every placeholder answered", async () => {

        const text = await prompt();

        expect(text.startsWith("# middle for 'greeting'")).toBe(true);
        expect(text).toContain("the spec folder: `specs/greeting`");
        expect(text).toContain("Your job: **write the file `two.md`**");
        expect(text).not.toContain("${{");
    });

    it("asks for a rewrite once the document is on disk", async () => {

        const text = await prompt(written);

        expect(text).toContain("Your job: **rewrite the file `two.md`**");
        expect(text).toContain("reply with one sentence: what you changed");
        expect(text).not.toContain("Your job: **write the file `two.md`**");
    });

    /* Quoted on the way in, so a heading somebody typed stays the note's. */
    it("quotes the person's words into the pass that has them", async () => {

        const text = await prompt({ ...written, revise: true, note: "## Shorten\nDrop the retry section." });

        expect(text).toContain("This pass has one instruction");
        expect(text).toContain("> ## Shorten");
        expect(text).toContain("> Drop the retry section.");
    });

    it("says nothing about an instruction on a pass without one", async () => {

        expect(await prompt(written)).not.toContain("This pass has one instruction");
    });
});

describe("a style that writes its own frame", () => {

    it("runs it word for word", async () => {

        expect(await prompt({}, owning("first", "NUR DAS.\n"))).toBe("NUR DAS.\n");
    });

    /* Per file: the mode it did not write still comes from the built-in. */
    it("leaves the modes it did not write alone", async () => {

        const text = await prompt(written, owning("first", "NUR DAS.\n"));

        expect(text).toContain("Your job: **rewrite the file `two.md`**");
        expect(text).not.toContain("NUR DAS.");
    });

    /* A style kept in the profile runs its own frame the same way a workspace one does. */
    it("is read from whichever scope holds the style", async () => {

        expect(await prompt({}, owning("first", "AUS DEM PROFIL.\n", "profile"))).toBe("AUS DEM PROFIL.\n");
    });

    it("answers the spec variables inside it", async () => {

        const frame = "Ordner: ${{ spec.dir }} (${{ spec.stage }})\n";

        expect(await prompt({}, owning("first", frame))).toBe("Ordner: specs/greeting (middle)\n");
    });

    it("answers the phase variables inside it", async () => {

        const frame = "Schreibe ${{ phase.target }} neu.\n";

        expect(await prompt(written, owning("rewrite", frame))).toBe("Schreibe `two.md` neu.\n");
    });
});

describe("the rows a frame is handed", () => {

    it("names the spec's documents", async () => {

        expect(await prompt({}, owning("first", "${{ phase.documents }}\n")))
            .toBe("- **one** - the spec's one.\n");
    });

    /* `current` has a line of its own in the file, so it is not a row. */
    it("leaves the document being rewritten out of them", async () => {

        expect(await prompt(written, owning("rewrite", "${{ phase.documents }}\n")))
            .toBe("- **one** - the spec's one.\n");
    });

    /*
     * Never a blank. A list that stops where a group was expected reads
     * as a prompt that failed to render, and the model cannot tell that
     * from a spec that genuinely has no references.
     */
    it("says None when there are none, rather than nothing", async () => {

        const frame = "- **how**\n${{ phase.references }}\n- **last**\n";

        expect(await prompt({}, owning("first", frame)))
            .toBe("- **how**\n- **None** - no reference files for this phase.\n- **last**\n");
    });

    /* The clause differs by group, so a flat list still says which is empty. */
    it("says which group is empty", async () => {

        const frame = "${{ phase.documents }}\n${{ phase.references }}\n";

        expect(await prompt({ stageId: "first", contents: [] }, owning("first", frame)))
            .toBe("- **None** - no documents from an earlier phase.\n"
                + "- **None** - no reference files for this phase.\n");
    });

    /* Every line the author wrote is a line in the prompt. */
    it("leaves the author's own words where they put them", async () => {

        expect(await prompt({}, owning("first", "Reference:\n${{ phase.references }}\n")))
            .toBe("Reference:\n- **None** - no reference files for this phase.\n");
    });
});

describe("a stage that cites its own items", () => {

    it("hands the prefix to a frame that asks for it", async () => {

        const frame = "Cite them `${{ phase.prefix }}-<n>`.\n";

        expect(await prompt({ style: parseStyle(citing("middle", "Two"), "t") }, owning("first", frame)))
            .toBe("Cite them `Two-<n>`.\n");
    });

    /*
     * The trap this closes: the panel parses a document's citations by
     * the prefix, so a prompt that never mentions one leaves the model
     * writing plain headings and the panel finding nothing.
     */
    it("refuses to run a frame that never says so", async () => {

        await expect(prompt({ style: parseStyle(citing("middle", "Two"), "t") }))
            .rejects.toThrow(/declares 'prefix: Two'.*prompts\/first\.md.*never writes/s);
    });

    it("says nothing about a prefix the style never declared", async () => {

        expect(await prompt()).not.toContain("-<n>");
    });
});

describe("what a frame is refused", () => {

    it("names the variables when given one that is not", async () => {

        await expect(prompt({}, owning("first", "${{ preamble }}")))
            .rejects.toThrow(/writes '\$\{\{ preamble \}\}'.*spec\.dir.*phase\.target/s);
    });

    /*
     * A first pass has no note, so a frame asking for one is asking for a
     * fact this run does not have. Said rather than rendered blank - the
     * paragraph around it would claim an instruction nobody gave.
     */
    it("refuses a fact this run does not have", async () => {

        await expect(prompt({}, owning("first", "${{ phase.note }}")))
            .rejects.toThrow(/writes '\$\{\{ phase\.note \}\}', but this run has no phase\.note to give/);
    });

    it("names the style's own file when that is the one to fix", async () => {

        await expect(prompt({}, owning("first", "${{ preamble }}")))
            .rejects.toThrow(/t's own prompts\/first\.md/);
    });
});

/*
 * A value that differs per person - the team a branch is cut under -
 * belongs in that person's settings.json, not in the style. The prompt
 * reads it the way tasks.yml does, bare by its top-level name.
 */
describe("settings variables in a frame", () => {

    const withTeam = configFromSettings({ variables: { Profile: { CurrentTeam: "platform", Tags: ["a"] } } });

    it("reads a settings variable by its dotted path", async () => {

        expect(await prompt({ config: withTeam }, owning("first", "team: ${{ Profile.CurrentTeam }}")))
            .toContain("team: platform");
    });

    it("names the missing leaf when the variable has nothing under that name", async () => {

        await expect(prompt({ config: withTeam }, owning("first", "${{ Profile.Team }}")))
            .rejects.toThrow(/settings variable 'Profile' has no 'Team' under it/);
    });

    it("refuses a variable that is not text, a number or true/false", async () => {

        await expect(prompt({ config: withTeam }, owning("first", "${{ Profile }}")))
            .rejects.toThrow(/is not text, a number or true\/false/);
    });

    it("says where variables are declared when there are none", async () => {

        await expect(prompt({}, owning("first", "${{ Profile.CurrentTeam }}")))
            .rejects.toThrow(/declared under 'variables' in settings\.json/);
    });
});

describe("the shipped prompts", () => {

    it("are all four, and all of them say something", () => {

        for (const mode of MODES)
            expect(BUILT_IN[mode].length).toBeGreaterThan(200);
    });

    /*
     * The list a frame prints and the files the engine sends are two
     * separate things, and the built-in ones have to agree.
     */
    it("name the attachments the engine actually sends", () => {

        for (const mode of MODES) {

            // Not attached - the engine names it under the prompt.
            expect(BUILT_IN[mode]).not.toContain("- **grammar**");
            expect(BUILT_IN[mode]).toContain("- **how**");
            expect(BUILT_IN[mode]).toContain("${{ phase.documents }}");
            expect(BUILT_IN[mode]).toContain("${{ phase.references }}");
        }

        expect(BUILT_IN.rewrite).toContain("- **current**");
        expect(BUILT_IN["rewrite-note"]).toContain("${{ phase.note }}");
        expect(BUILT_IN.first).not.toContain("- **current**");
        expect(BUILT_IN.first).not.toContain("${{ phase.note }}");
        expect(BUILT_IN["first-note"]).toContain("${{ phase.note }}");
        expect(BUILT_IN["first-note"]).not.toContain("- **current**");

        // The output gate's own: the tasks, and no document to write.
        expect(BUILT_IN.implement).toContain("${{ phase.tasks }}");
        expect(BUILT_IN.implement).not.toContain("${{ phase.target }}");
        expect(BUILT_IN.implement).not.toContain("- **current**");

        for (const mode of ["first", "first-note", "rewrite", "rewrite-note"] as const)
            expect(BUILT_IN[mode]).not.toContain("${{ phase.tasks }}");
    });
});

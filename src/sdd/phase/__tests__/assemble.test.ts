import * as path from "path";

import { describe, expect, it } from "vitest";
import { configFromSettings } from "../../config/sddConfig";
import { parseStyle } from "../../parser/parseStyle";
import { StyleRegistry } from "../../registry/StyleRegistry";
import { Scope, StyleFiles } from "../../registry/styleFiles";
import { assemble, PhaseInput } from "../assemble";

const STYLE = `
schema: 1
id: t
name: T
desc: A style written to exercise assembly.
specTypes:
  - id: full
    label: Full
    stages: [first, middle, implement]
  - id: short
    label: Short
    stages: [first, implement]
stages:
  - id: first
    produces: [one.md]
  - id: middle
    produces: [two.md]
`;

const style = parseStyle(STYLE, "t");

const BUILTIN: Record<string, string> = {
    "style.yml": STYLE,

    // The shared grammar - in the styles folder, beside the style
    // folders, not inside one. Keyed apart so `read` never serves it as
    // a file of style `t`.
    "@shared/grammar.md": "THE SHAPES",

    "instructions/first.md": "WRITE THE FIRST",
    "instructions/middle.md": "WRITE THE MIDDLE",

    // Two output-gate prompts for two spec types, named for the stage
    // each one's pipeline ends on - `full` ends at `middle`, `short` at
    // `first`. One `implement.md` could not serve both.
    "instructions/middle-implement.md": "HAND OFF",
    "instructions/first-implement.md": "HAND OFF"
};

function registry(
    overrides: Partial<Record<Scope, Record<string, string>>> = {},
    templating?: { workspaceFolder?: string }
): StyleRegistry {

    const tree: Partial<Record<Scope, Record<string, string>>> = { builtin: BUILTIN, ...overrides };

    // A style lives in one scope. The highest scope writing a file of
    // its own (a `@shared/` file belongs to no style) holds `t`, with
    // the base files beside its own - a copy made from the sample.
    const own = (scope: Scope) => Object.keys(tree[scope] ?? {}).some(key => !key.startsWith("@shared/"));

    const home: Scope = own("workspace") ? "workspace" : own("profile") ? "profile" : "builtin";

    const styleFiles: Record<string, string> = { ...tree.builtin, ...(home === "builtin" ? {} : tree[home]) };

    const files: StyleFiles = {
        styles: async scope => (scope === home ? ["t"] : []),
        read: async (scope, styleId, relative) => styleId === "t" && scope === home ? styleFiles[relative] : undefined,

        // Style files are attached, not pasted in, so the registry has
        // to give paths as well as text - from the scope the style is in.
        pathOf: (scope, styleId, relative) => `/styles/${scope}/${styleId}/${relative}`,

        sharedPath: (scope, name) => tree[scope]?.[`@shared/${name}`] === undefined
            ? undefined
            : `/styles/${scope}/${name}`,

        // A stage template is a repository file, outside the scope
        // model - there is one copy and the style says where.
        readWorkspace: async relative => REPO[relative],
        pathOfWorkspace: relative => REPO[relative] === undefined ? undefined : `/repo/${relative}`
    };

    return new StyleRegistry(files, templating);
}

/** The repository the workspace's own templates and attachments live in. */
const REPO: Record<string, string> = {
    "docs/templates/middle.md": "THEIR SHAPE",
    "docs/api/contract.md": "THE CONTRACT",
    "docs/glossary.md": "THE WORDS",

    // Two files a stage can only name through a spec variable: one
    // inside the spec folder this suite's `input()` uses, one under a
    // folder named for the spec type.
    "specs/greeting/api.md": "THIS SPEC'S CONTRACT",
    "docs/types/full.md": "HOW A FULL SPEC IS SHAPED"
};

/** A spec folder holding exactly these documents - what a phase is handed. */
function folder(...documents: string[]): string[] {

    return documents;
}

/** What an implement run is handed - the rows somebody pressed Start on. */
const HANDED = [{ id: "1.1", text: "Add the parser", wave: 0 }, { id: "1.2", text: "Add the walker" }];

function input(over: Partial<PhaseInput> = {}): PhaseInput {

    return {
        style,
        config: configFromSettings(undefined),
        specDir: "specs/greeting",
        specType: "full",
        stageId: "middle",
        contents: folder("one.md"),
        ...over
    };
}

describe("what the phase is handed", () => {

    /*
     * The prompt is the ask and the facts - nothing a file could carry.
     * Inlining the phase prompt and the house style would bury the
     * request as a paragraph inside two hundred lines of reference
     * material.
     */
    it("inlines nothing that could be a file", async () => {

        const request = await assemble(input(), registry());

        for (const inlined of ["WHAT SDD IS", "WRITE THE MIDDLE", "GRAMMAR", "HOUSE"])
            expect(request.prompt).not.toContain(inlined);
    });

    /* The limit counts the grammar section too - a path and three rules, about 350 characters. */
    it("stays short - the ask, not the library", async () => {

        expect((await assemble(input(), registry())).prompt.length).toBeLessThan(1_900);
    });

    /*
     * Which phase and which spec, and no more. The verb lives
     * in `## The ask`, and two asks at opposite ends of one prompt is
     * one of them too many.
     */
    it("opens with the phase and the spec's name, and no verb", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt.startsWith("# middle for 'greeting'")).toBe(true);
        expect(request.prompt).not.toContain("# Write the middle");
    });

    /* One place says the verb, and it is the one section that knows the pass. */
    it("says rewrite once, in the ask, when the document is already there", async () => {

        const request = await assemble(input({ contents: folder("one.md", "two.md") }), registry());

        expect(request.prompt.startsWith("# middle for 'greeting'")).toBe(true);
        expect(request.prompt.split("rewrite the file")).toHaveLength(2);
        expect(request.prompt).toContain("Your job: **rewrite the file `two.md`**");
    });

    /*
     * A second pass is the same frame as a first, and the one thing
     * that differs - the file is already there - is said once, against
     * the file, in the document list.
     *
     * It must not be said four times: a paragraph declaring the pass, a
     * different lead-in to that list, a warning inside the note's own
     * section, and a clause in the closing ask. Counting the phase
     * prompt's `## Revising` and the grammar's section 9, one rule reached the
     * model six times in a turn.
     */
    it("says the file exists once, and bends the frame nowhere else", async () => {

        const request = await assemble(input({ contents: folder("one.md", "two.md") }), registry());

        expect(request.attachments.map(one => one.name)).toContain("current");
        expect(request.prompt).toContain("as it stands, including any");

        for (const gone of ["second pass", "not replacing it", "numbering included"])
            expect(request.prompt).not.toContain(gone);
    });

    it("says nothing about an existing file on a first draft", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).not.toContain("exists already");
        expect(request.prompt).not.toContain("- **current**");
    });

    /* One spelling of a file name per prompt - `quoted` is for dialogs. */
    it("names the document in backticks, the way every other line names a file", async () => {

        const request = await assemble(input({ contents: folder("one.md", "two.md") }), registry());

        expect(request.prompt).not.toContain("'two.md'");
    });

    /*
     * The spec folder is stated once at the top and the plugin states
     * the absolute target itself. A third spelling of the same location
     * is one more thing that can disagree with the other two.
     */
    it("asks for a file name, not a path, and points at the folder above", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).toContain("Your job: **write the file `two.md`**");
        expect(request.prompt).toContain("the spec folder: `specs/greeting`");
        expect(request.prompt).not.toContain("specs/greeting/two.md");
    });

    /*
     * One line back, not none. Asking for nothing would get exactly
     * that - a phase that wrote the file and said not a word, which
     * reads as a session that failed.
     */
    it("asks for one sentence back, not a summary of the document", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).toContain("reply with one sentence: what you wrote");
        expect(request.prompt).not.toContain("No summary is needed");
    });

});

describe("context - the spec's own documents", () => {

    /*
     * Attached, like every other file the phase reads. Listing them by
     * path under a `## Documents` heading would show the same files as
     * names in one list and as paths in another.
     */
    it("attaches them under their own names, beside the instructions", async () => {

        const request = await assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: HANDED }), registry());

        expect(request.attachments.map(one => one.name)).toEqual(["how", "one", "two"]);
        expect(request.prompt).toContain("- **one** - the spec's one.");
        expect(request.prompt).toContain("- **two** - the spec's two.");
    });

    /*
     * The output gate runs its own prompt file. It must not run `first`
     * - "Spec folder ... everything you write goes in there", "Write ."
     * over an empty target - with the task list glued on by the panel.
     */
    it("runs the implement prompt, with the handed tasks in it", async () => {

        const request = await assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: HANDED }), registry());

        expect(request.prompt).toContain("## Tasks to implement now");
        expect(request.prompt).toContain("- 1.1 Add the parser (wave 0)\n- 1.2 Add the walker\n");
        expect(request.prompt).toContain("**Implement the tasks above.**");
        expect(request.prompt).not.toContain("Write .");
        expect(request.prompt).not.toContain("everything you write goes in there");
    });

    /*
     * The row is the whole task: what the plan wrote under it, verbatim,
     * and the line it sits on - so the agent is not sent back to the
     * plan for the Files: line and the citations.
     */
    it("hands each task with its plan line and its detail lines under it", async () => {

        const handed = [
            { id: "1.1", text: "Add the parser", wave: 0, line: 12, details: ["- Files: `src/parser.ts`", "- _Requirements: 1.2_"] },
            { id: "1.2", text: "Add the walker", line: 15, details: [] }
        ];

        const request = await assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: handed }), registry());

        expect(request.prompt).toContain(
            "- 1.1 Add the parser (wave 0) - plan line 12\n"
            + "    - Files: `src/parser.ts`\n"
            + "    - _Requirements: 1.2_\n"
            + "- 1.2 Add the walker - plan line 15\n");
    });

    it("refuses an implement run handed no tasks", async () => {

        await expect(assemble(input({ stageId: "implement", contents: folder("one.md", "two.md") }), registry()))
            .rejects.toThrow(/prompts\/implement\.md.*no phase\.tasks to give/);
    });

    it("refuses a drafting prompt that writes the tasks, which a drafting run never has", async () => {

        const own = registry({ workspace: { "prompts/first.md": "${{ phase.tasks }}" } });

        await expect(assemble(input({ stageId: "first", contents: folder() }), own))
            .rejects.toThrow(/prompts\/first\.md.*no phase\.tasks to give/);
    });

    it("refuses an implement prompt that writes a target, which the output gate never has", async () => {

        const own = registry({ workspace: { "prompts/implement.md": "Write ${{ phase.target }}" } });

        await expect(assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: HANDED }), own))
            .rejects.toThrow(/prompts\/implement\.md.*no phase\.target to give/);
    });

    /* No second list of the same files - the point of attaching them. */
    it("names no paths for them in the prompt", async () => {

        const request = await assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: HANDED }), registry());

        expect(request.prompt).not.toContain("## Documents");
        expect(request.prompt).not.toContain("`specs/greeting/one.md`");
    });

    /*
     * `current` leads the documents because it is the subject of the
     * pass, not the first of its inputs.
     */
    it("puts `current` ahead of the other documents, on a second pass", async () => {

        const request = await assemble(input({ contents: folder("one.md", "two.md") }), registry());

        expect(request.attachments.map(one => one.name)).toEqual(["how", "current", "one"]);
    });

    /* Still repository-relative on the request, whatever the attachment carries. */
    it("keeps naming them by repository path for the surfaces that show them", async () => {

        const request = await assemble(input({ contents: folder("one.md", "two.md") }), registry());

        expect(request.documents).toEqual({
            one: "specs/greeting/one.md",
            current: "specs/greeting/two.md"
        });
        expect(request.context).toEqual(["specs/greeting/one.md"]);
    });

    /**
     * The same sentence whether or not earlier phases wrote, because it
     * is true either way and a frame holds no branch. It never calls the
     * folder empty: the files the ask arrived as are sitting in it,
     * copied there when the spec was created, and saying otherwise would
     * contradict what the agent sees the moment it looks.
     */
    it("says what it was given, without calling the folder empty", async () => {

        const bare = await assemble(input({ stageId: "first", contents: folder() }), registry());
        const later = await assemble(input(), registry());

        for (const request of [bare, later]) {
            expect(request.prompt).toContain("Attached files. This list is everything this phase receives");
            expect(request.prompt).toContain("ignore them, except `code-findings.md`");
        }

        expect(bare.prompt).not.toContain("- **one**");
        expect(later.prompt).toContain("- **one** - the spec's one.");
    });

    /*
     * A phase told only about the spec folder writes a document about a
     * codebase it never looked at - a design that invents modules, a
     * plan naming files that do not exist.
     */
    /*
     * The conventions file is offered as an example rather than
     * asserted. It must not read "follow `AGENTS.md`" - one of the two
     * spellings people use, and not the one this repository carries. A
     * phase told to follow a file that is not there follows nothing,
     * and nothing anywhere says so.
     */
    it("names the repository as context, without claiming a conventions file exists", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).toContain("Read repository code only when **how** calls for it");
        expect(request.prompt).not.toContain("follow `AGENTS.md`");
    });

    it("says it for a first document too, which has no spec documents at all", async () => {

        const request = await assemble(input({ stageId: "first", contents: folder() }), registry());

        expect(request.prompt).toContain("Read repository code only when **how** calls for it");
    });
});

describe("attached files", () => {

    const named = (request: { attachments: { name: string }[] }) => request.attachments.map(one => one.name);

    it("attaches the phase's own prompt and the documents it reads", async () => {

        expect(named(await assemble(input(), registry()))).toEqual(["how", "one"]);
    });

    /*
     * The one thing the style's intro says that nothing else does. It is a fact about the run rather than about the document,
     * so it sits with the other such facts instead of in six prompts
     * or a system message a style had to declare.
     *
     * Said as an instruction, not as an explanation of session
     * lifetimes. It does not read "Nothing after this reads this conversation", which would be forty-five words and also false on a
     * revise - the panel continues a stage's own session across passes,
     * so the next pass of this phase does read it. The next *phase*
     * never does, which is what this says and all it says.
     */
    it("tells the phase to put it in the file rather than in the reply", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).toContain("Chat is not the deliverable");
        expect(request.prompt).toContain("the next phase starts a new\nchat");
        expect(request.prompt).not.toContain("reads this conversation");
    });

    /*
     * The split survives the collapse: `middle` writes `two.md` and the
     * folder holds `instructions/format-two.md`, so it gets one. `first`
     * writes `one.md` and there is no `format-one.md`, so it does not -
     * reached by what is on disk rather than by a declaration.
     */
    it("hands every phase its own prompt and no shared file", async () => {

        const middle = await assemble(input(), registry());
        const first = await assemble(input({ stageId: "first", contents: folder() }), registry());

        expect(named(middle)).toEqual(["how", "one"]);
        expect(named(first)).toEqual(["how"]);
        expect(named(first)).not.toContain("format");
    });

    it("attaches absolute paths, since instruction files ship outside the repository", async () => {

        const request = await assemble(input(), registry());
        const by = (name: string) => request.attachments.find(one => one.name === name)?.path;

        expect(by("how")).toBe("/styles/builtin/t/instructions/middle.md");
    });

    /*
     * The path comes from the same folder as the text - attaching a file
     * from anywhere else would run the phase on instructions nobody
     * could find.
     */
    it("attaches the file from the folder the style lives in", async () => {

        const request = await assemble(input(), registry({ workspace: { "instructions/middle.md": "OURS" } }));

        expect(request.attachments.find(one => one.name === "how")?.path)
            .toBe("/styles/workspace/t/instructions/middle.md");
    });

    /*
     * Names only. The session was handed these files; repeating where
     * they live on a machine it is not browsing is a line of noise per
     * attachment that tells it nothing it can act on. The grammar is
     * the one path in the prompt: it is not attached, so the path is
     * the only way the session learns where it is.
     */
    it("lists them by name and purpose, without their paths", async () => {

        const request = await assemble(input(), registry());
        const [frame, grammar] = request.prompt.split("## Grammar");

        expect(request.prompt).toContain("- **how** - the instructions for this phase. Read it before writing.");
        expect(frame).not.toContain("/styles/builtin");
        expect(grammar).toContain("/styles/builtin/grammar.md");
    });
});

/*
 * The failure this exists to prevent: the phase prompts say
 * "the documents in your context", and the Copilot plugin delivers
 * context as content under a name. Handing over paths only would tell
 * the agent to work from something it was never given, so it would
 * answer in prose and write no file.
 */
describe("documents the session is given", () => {

    it("names each prior document by its stem, as the prompts refer to them", async () => {

        const request = await assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: HANDED }), registry());

        expect(request.documents).toEqual({
            one: "specs/greeting/one.md",
            two: "specs/greeting/two.md"
        });
    });

    it("keeps the stem of a hyphenated document", async () => {

        const style2 = parseStyle(STYLE.replace("produces: [two.md]", "produces: [data-model.md]"), "t");

        const request = await assemble(
            input({ style: style2, stageId: "implement", contents: folder("one.md", "data-model.md"), tasks: HANDED }), registry());

        expect(Object.keys(request.documents).sort()).toEqual(["data-model", "one"]);
    });

    it("adds the existing target as 'current' on a redraft, and not on a first draft", async () => {

        const first = await assemble(input(), registry());
        const redraft = await assemble(input({ contents: folder("one.md", "two.md") }), registry());

        expect(first.documents.current).toBeUndefined();
        expect(redraft.documents.current).toBe("specs/greeting/two.md");
    });

    it("gives the first stage no documents at all", async () => {

        const request = await assemble(input({ stageId: "first", contents: folder() }), registry());

        expect(request.documents).toEqual({});
    });
});

describe("what to write", () => {

    it("names the required document", async () => {

        const request = await assemble(input(), registry());

        expect(request.targets).toEqual(["specs/greeting/two.md"]);
    });

    /*
     * An optional output has no declaration, so nothing tells
     * a phase it may write one. A document no stage produces is
     * context for every later phase the moment it exists, and what a
     * phase *may* write belongs in that phase's own prompt - it is an
     * instruction, not a pipeline shape.
     */
    it("offers no list of optional documents", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).not.toContain("You may also write");
    });
});

describe("a stage's citation prefix", () => {

    /*
     * The sentence about it is a style's own words, so a style that
     * declares a prefix and never writes it into a frame is refused
     * rather than run. The panel parses a document's citations by the
     * prefix, so a prompt that never mentions one leaves the model
     * writing plain headings and the panel finding nothing. Worded and
     * exercised in `phasePrompt.test.ts`; here to pin that assembling is where
     * it stops.
     */
    it("refuses to assemble when the frame never says what the prefix is", async () => {

        const prefixed = parseStyle(STYLE.replace("produces: [two.md]", "produces: [two.md]\n    prefix: Two"), "t");

        await expect(assemble(input({ style: prefixed }), registry()))
            .rejects.toThrow(/declares 'prefix: Two'/);
    });

    it("says nothing about a prefix the style never declared", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).not.toContain("-<n>");
    });
});

describe("settings reaching a phase", () => {

    /*
     * Neither the spec type nor the checkpoint policy is in here. No
     * prompt mentions the spec type - it picks the pipeline, which
     * happens long before a prompt is built. Nothing in the product
     * enforces a checkpoint policy, so the prompt does not state one.
     */
    it("states the spec folder and nothing else about the run", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).toContain("the spec folder: `specs/greeting`");
        expect(request.prompt).not.toContain("Spec type:");
        expect(request.prompt).not.toContain("Checkpoints:");
    });

    it("resolves the ai settings from the file default, which every phase starts from", async () => {

        const config = configFromSettings({
            sdd: { uses: "eesha@1" },
            aiDefaults: { "eesha@1": { model: "auto" } }
        });

        expect((await assemble(input({ config }), registry())).ai)
            .toEqual({ uses: "eesha@1", args: { model: "auto" } });
    });

    it("never puts config into the prompt beyond the values a phase needs", async () => {

        const config = configFromSettings({ sdd: { styles: ["t"], source: "ado" } });
        const request = await assemble(input({ config }), registry());

        expect(request.prompt).not.toContain("ado");
        expect(request.prompt).not.toContain("specRoot");
    });
});

describe("whose text won", () => {

    it("reports which scope each piece of text came from", async () => {

        const request = await assemble(input(), registry({ workspace: { "instructions/middle.md": "OURS" } }));

        expect(request.sources.prompt.scope).toBe("workspace");
    });

    /*
     * Every instruction the phase runs on is a file it was handed, and
     * that is what lets the prompt name them instead of quoting them. A
     * composed prompt would break that: the file on disk would no
     * longer be what the phase ran on.
     */
    it("inlines no instruction text - the attached files are the instructions", async () => {

        const request = await assemble(input(), registry({ workspace: { "instructions/middle.md": "OURS" } }));

        expect(request.prompt).not.toContain("OURS");
        expect(request.attachments).toContainEqual({ name: "how", path: "/styles/workspace/t/instructions/middle.md" });
    });
});

describe("refusing to run half-assembled", () => {

    /*
     * A phase missing its instructions would still produce something -
     * a document written from nothing at all. That is worse than not
     * running, because the result looks like output.
     */
    it("refuses a stage whose prompt the style's folder does not hold", async () => {

        const without = { ...BUILTIN };
        delete without["instructions/middle.md"];

        const files: StyleFiles = {
            styles: async scope => scope === "builtin" ? ["t"] : [],
            read: async (scope, _id, relative) => scope === "builtin" ? without[relative] : undefined
        };

        await expect(assemble(input(), new StyleRegistry(files)))
            .rejects.toThrow(/Stage 'middle' of style 't' names 'instructions\/middle.md'/);
    });

    it("refuses a stage the spec type does not visit", async () => {

        await expect(assemble(input({ specType: "short" }), registry()))
            .rejects.toThrow(/'middle' is not in the 'short' pipeline/);
    });
});

/*
 * A revise is the same phase over the document it already wrote. What
 * changes with it is which instruction runs and - because that is one
 * decision, not two - whether the pass builds on the conversation
 * behind the draft.
 */
describe("revising", () => {

    /** The document exists, which is what a revise needs and a first pass does not have. */
    const written = () => folder("one.md", "two.md");

    const how = (request: Awaited<ReturnType<typeof assemble>>) =>
        request.attachments.find(one => one.name === "how")?.path;

    /*
     * The same instruction a second time: `## Revising` in the phase's
     * own prompt is what those sections are written for, and the
     * transcript behind the draft is history worth having.
     */
    it("runs the phase's own prompt again", async () => {

        const request = await assemble(input({ revise: true, contents: written() }), registry());

        expect(how(request)).toBe("/styles/builtin/t/instructions/middle.md");
    });

    /** The document being corrected, under the name every revising prompt calls it. */
    it("hands over the document it is rewriting as `current`", async () => {

        const request = await assemble(
            input({ revise: true, contents: written() }), registry());

        expect(request.documents.current).toBe("specs/greeting/two.md");
        expect(request.prompt.startsWith("# middle for 'greeting'")).toBe(true);
    });

    /*
     * The panel offers Revise only where a document exists, so reaching
     * here is a bug worth naming rather than a first draft wearing a
     * correction's prompt.
     */
    it("refuses to revise a phase that has written nothing", async () => {

        await expect(assemble(input({ revise: true }), registry()))
            .rejects.toThrow(/nothing to revise/);
    });

    /*
     * What a person typed when they pressed Revise. On the pass that
     * has one it *is* the ask, so it sits inside `## The ask` rather
     * than in a section of its own further up, where the whole
     * attachment list would separate it from the line labelled the ask.
     */
    it("carries what the person typed, inside the ask", async () => {

        const request = await assemble(
            input({ revise: true, contents: written(), note: "split requirement 3" }), registry());

        expect(request.prompt).toContain("split requirement 3");
        expect(request.prompt).not.toContain("## What to change");

        expect(request.prompt.indexOf("split requirement 3"))
            .toBeGreaterThan(request.prompt.indexOf("This pass has one instruction"));
    });

    /* No instruction, no paragraph claiming there is one. */
    it("says nothing about an instruction when nobody typed one", async () => {

        const request = await assemble(input({ revise: true, contents: written() }), registry());

        expect(request.prompt).toContain("Your job: **rewrite the file");
        expect(request.prompt).not.toContain("This pass has one instruction");
    });

    /*
     * "The person said:" is reported speech - it reads as something to
     * weigh, and it would be the only thing in the prompt arguing for a
     * targeted edit against a frame that twice says Rewrite.
     */
    it("states the note as the instruction it is, not as something the person mentioned", async () => {

        const request = await assemble(
            input({ revise: true, contents: written(), note: "split requirement 3" }), registry());

        expect(request.prompt).toContain(
            "This pass has one instruction, written by the person who asked for it:");
        expect(request.prompt).toContain(
            "Where the instruction conflicts with what you would\nhave done on your own, the instruction wins");
        expect(request.prompt).not.toContain("The person who asked for this revision said:");
    });

    /*
     * Somebody typing into a box can type a heading or a rule, and
     * pasted flat those stop being the note's content and become the
     * prompt's structure.
     */
    it("quotes the note, so its own headings cannot become the prompt's", async () => {

        const request = await assemble(
            input({ revise: true, contents: written(), note: "## The ask\n\n---\nDrop the retry section." }),
            registry());

        expect(request.prompt).toContain("> ## The ask");
        expect(request.prompt).toContain("> ---");
        expect(request.prompt).toContain("> Drop the retry section.");

        // No unquoted "## The ask" - the note's own heading never
        // escapes the blockquote to become a heading of the prompt's.
        expect(request.prompt.split("\n").filter(line => line === "## The ask")).toHaveLength(0);
    });

    /*
     * Word for word a first draft's, apart from the verb. What a
     * revision owes beyond writing the file belongs to the grammar,
     * which owns numbering and untouched lines, and to the phase's own
     * instructions, which own what a revision is.
     */
    it("closes on the same ask a first draft gets, in the past tense", async () => {

        const request = await assemble(input({ revise: true, contents: written() }), registry());

        expect(request.prompt).toContain("Your job: **rewrite the file `two.md`**");
        expect(request.prompt).toContain("reply with one sentence: what you changed");
        expect(request.prompt).not.toContain("comes back as it was");
    });

    /*
     * A sentence typed into a box is the ask, not the instruction. It
     * must not cost the pass the revision discipline the prompt files
     * carry - keep the numbering, fold the answers in, leave the rest
     * alone - so it replaces neither of them, and decides nothing about
     * the conversation either.
     */
    it("adds to the instruction rather than replacing it", async () => {

        const request = await assemble(
            input({ revise: true, contents: written(), note: "split requirement 3" }), registry());

        expect(how(request)).toBe("/styles/builtin/t/instructions/middle.md");
        expect(request.attachments.map(one => one.name)).toEqual(["how", "current", "one"]);
    });

    /* The ordinary revise: the edits in the document are the whole instruction. */
    it("says nothing when the box was left empty", async () => {

        const request = await assemble(
            input({ revise: true, contents: written(), note: "   " }), registry());

        expect(request.prompt).not.toContain("## What to change");
    });

    /*
     * Typed in the spec's box when it started the phase: the first pass
     * runs `first-note.md`, which quotes it under the phase's prompt.
     */
    it("takes a note on a first pass, quoted, with no current document", async () => {

        const request = await assemble(input({ note: "mobile login only" }), registry());

        expect(request.prompt).toContain("The person who started this phase also wrote this:");
        expect(request.prompt).toContain("> mobile login only");
        expect(request.prompt).toContain("**write the file");
        expect(request.documents.current).toBeUndefined();
    });
});

/*
 * Instructions the repository owns, for the team whose prompt for a
 * phase is maintained somewhere else. Pointing at the file beats
 * copying it into the style folder, which drifts the day they edit
 * theirs.
 */
describe("a stage template", () => {

    const WITH_TEMPLATE = STYLE.replace(
        "  - id: middle\n    produces: [two.md]",
        "  - id: middle\n    produces: [two.md]\n    instructions: docs/templates/middle.md");

    const pointing = parseStyle(WITH_TEMPLATE, "t");

    const shaped = () => registry({ builtin: { ...BUILTIN, "style.yml": WITH_TEMPLATE } });

    it("is the instruction the phase runs on, in place of the style's own", async () => {

        const request = await assemble(input({ style: pointing }), shaped());

        expect(request.sources.prompt.text).toBe("THEIR SHAPE");
        expect(request.sources.prompt.scope).toBe("repo");
    });

    /*
     * Attached from where it actually is. A phase told to follow
     * instructions it was handed the wrong copy of is the failure
     * `pathOf` exists to prevent, and a repository file is not the
     * registry's to resolve by precedence.
     */
    it("is attached from the repository, not from a style folder", async () => {

        const request = await assemble(input({ style: pointing }), shaped());

        expect(request.attachments.find(one => one.name === "how")?.path)
            .toBe("/repo/docs/templates/middle.md");
    });

    /*
     * Replaced, never layered. Two sets of instructions for one
     * document is two contracts a model has to reconcile - the same
     * reason a revise prompt replaces the phase's instead of joining
     * it.
     */
    it("replaces the style's prompt rather than joining it", async () => {

        const request = await assemble(input({ style: pointing }), shaped());

        expect(request.attachments.map(one => one.name)).toEqual(["how", "one"]);
        expect(request.sources.prompt.text).not.toContain("WRITE THE MIDDLE");
    });


    /*
     * Fatal, because the style has already said this workspace's shape
     * wins - carrying on would write a document in a shape nobody
     * chose, ours having been replaced.
     */
    it("refuses to run when the repository does not have it", async () => {

        const missing = parseStyle(
            STYLE.replace("  - id: middle\n    produces: [two.md]", "  - id: middle\n    produces: [two.md]\n    instructions: docs/templates/gone.md"),
            "t");

        await expect(assemble(input({ style: missing }), registry()))
            .rejects.toThrow(/not in the repository/);
    });

    /* A stage naming none is untouched - the style's own prompt. */
    it("changes nothing for a stage that names none", async () => {

        const request = await assemble(input({ style: pointing, stageId: "first" }), shaped());

        expect(request.sources.prompt.scope).toBe("builtin");
        expect(request.attachments.find(one => one.name === "how")?.path)
            .toBe("/styles/builtin/t/instructions/first.md");
    });
});
/**
 * The grammar - one file for every style, named under the prompt with
 * the rule for when to open it, never attached. An attachment is handed
 * as "read these first", so a question asked in a fresh session paid for
 * the whole grammar.
 */
describe("the document grammar", () => {

    const named = (request: { attachments: { name: string }[] }) => request.attachments.map(one => one.name);

    it("is named under every phase's prompt, and never attached", async () => {

        const middle = await assemble(input(), registry());
        const first = await assemble(input({ stageId: "first", contents: folder() }), registry());
        const out = await assemble(input({ stageId: "implement", contents: folder("one.md", "two.md"), tasks: HANDED }), registry());

        for (const request of [middle, first, out]) {

            expect(request.prompt).toContain("## Grammar\n\nThe document grammar is `/styles/builtin/grammar.md`.");
            expect(named(request)).not.toContain("grammar");
        }
    });

    it("says to open it only for a spec document", async () => {

        const request = await assemble(input(), registry());

        expect(request.prompt).toContain("Open it only when you write, edit or read a spec document.");
        expect(request.prompt).toContain("Do not open it for anything else");
        expect(request.prompt).toContain("the grammar wins");
    });

    /* Last, after the frame - no prompt file can drop it. */
    it("comes after everything the frame wrote", async () => {

        const request = await assemble(input(), registry({ workspace: { "prompts/first.md": "OUR FRAME" } }));

        expect(request.prompt.startsWith("OUR FRAME")).toBe(true);
        expect(request.prompt).toContain("## Grammar");
    });

    /* Ordinary precedence: the nearer scope wins. */
    it("takes the highest scope that has one", async () => {

        const mine = await assemble(input(), registry({
            profile: { "@shared/grammar.md": "THEIRS" },
            workspace: { "@shared/grammar.md": "MINE" }
        }));

        expect(mine.prompt).toContain("The document grammar is `/styles/workspace/grammar.md`.");
    });

    /* No style has its own. A copy left in a style folder is not read. */
    it("ignores a grammar.md inside a style folder", async () => {

        const request = await assemble(input(), registry({ workspace: { "grammar.md": "OLD COPY" } }));

        expect(request.prompt).not.toContain("/styles/workspace/t/grammar.md");
        expect(request.prompt).toContain("The document grammar is `/styles/builtin/grammar.md`.");
    });

    /* Nothing fails - the phase runs without a grammar, and the prompt says nothing about one. */
    it("adds nothing when no scope has one", async () => {

        const bare = { ...BUILTIN };

        delete bare["@shared/grammar.md"];

        const request = await assemble(input(), registry({ builtin: bare }));

        expect(request.prompt).not.toContain("## Grammar");
        expect(named(request)[0]).toBe("how");
    });
});

/*
 * A stage's own `attachments:` - the repository files a team says this
 * phase should be reading.
 *
 * The one input to a phase that no derivation could have produced.
 * Everything else assembly hands over is worked out from the style, the
 * pipeline and the folder; that `docs/api/contract.md` matters to the
 * design phase of this process is a fact about the repository, and the
 * only place it can be written down is the stage.
 */
describe("a stage's own attachments", () => {

    /** The test style with `attachments:` on `middle`, parsed. */
    const styled = (...paths: string[]) => parseStyle(
        STYLE.replace(
            "  - id: middle\n    produces: [two.md]",
            "  - id: middle\n    produces: [two.md]\n    attachments:\n"
            + paths.map(one => `      - ${one}`).join("\n")),
        "t");

    const named = (request: { attachments: { name: string }[] }) => request.attachments.map(one => one.name);

    /*
     * After `how`, and that order is the decision. The instruction says
     * what the phase is for; a reference file read ahead of it is a file
     * with no question attached to it.
     */
    it("attaches them after the instructions, in the order written", async () => {

        const request = await assemble(
            input({ style: styled("docs/api/contract.md", "docs/glossary.md") }),
            registry());

        expect(named(request)).toEqual(["how", "one", "contract", "glossary"]);
    });

    /* The stem, because that is the name the prompt's list calls it by. */
    it("names each one by its file stem, at the path it sits on in the repository", async () => {

        const request = await assemble(
            input({ style: styled("docs/api/contract.md") }), registry());

        expect(request.attachments).toContainEqual(
            { name: "contract", path: "/repo/docs/api/contract.md" });
    });

    /*
     * Reference material, not the pipeline's output. A phase that
     * treated its API contract as a document it was rewriting would
     * overwrite the repository's own file.
     */
    it("says they are to be read rather than written", async () => {

        const request = await assemble(
            input({ style: styled("docs/api/contract.md") }), registry());

        expect(request.prompt).toContain(
            "- **contract** - reference for this phase. Read it; you do not write it.");

        // Not "the spec's contract" - it is not the spec's, and a phase
        // told it was would look for something the pipeline wrote.
        expect(request.prompt).not.toContain("the spec's contract");
    });

    /* They are attached, so they stay out of the documents the walk derived. */
    it("keeps them out of the context and the documents", async () => {

        const request = await assemble(
            input({ style: styled("docs/api/contract.md") }), registry());

        expect(request.context).toEqual(["specs/greeting/one.md"]);
        expect(Object.keys(request.documents)).toEqual(["one"]);
    });

    /*
     * The failure this whole layer exists to refuse. `templatePath`
     * builds a path without touching the disk, so a missing file would
     * otherwise be attached as a path to nothing: the phase runs, writes
     * a plausible document, and the team that pointed at their contract
     * never learns the model was not shown it.
     */
    it("fails naming the file when one is not in the repository", async () => {

        await expect(assemble(
            input({ style: styled("docs/api/nope.md") }), registry()))
            .rejects.toThrow(/attaches 'docs\/api\/nope.md', which is not in the repository/);
    });

    /*
     * The output gate is the case this key was most wanted for - handing
     * the implement phase the contract it has to build against. Its
     * prompt is the one thing `pipeline` derives rather than reads, so
     * this checks that filling in `instructions/<previous>-implement.md`
     * carries the rest of the stage through rather than replacing it.
     */
    it("survives the output gate's derived prompt", async () => {

        const style = parseStyle(
            STYLE + "  - id: implement\n    attachments:\n      - docs/api/contract.md\n", "t");

        const request = await assemble(input({ style, stageId: "implement", tasks: HANDED }), registry());

        expect(named(request)).toEqual(["how", "one", "contract"]);
        expect(request.attachments.find(one => one.name === "how")?.path)
            .toBe("/styles/builtin/t/instructions/middle-implement.md");
    });

    it("changes nothing for a stage that declares none", async () => {

        expect(named(await assemble(input(), registry()))).toEqual(["how", "one"]);
    });
});

/*
 * The style's own top-level `attachments:` - reference files handed to
 * every stage that runs a model, on top of whatever a stage attaches
 * itself.
 *
 * Merged into a stage's own list before assembly reads it, so most of
 * what makes a stage's own attachment work - existence, spec variables,
 * staying out of the documents - is exercised there already. What is
 * this key's own to prove is that it reaches every stage and sits ahead
 * of a stage's more specific list.
 */
describe("the style's own attachments", () => {

    const named = (request: { attachments: { name: string }[] }) => request.attachments.map(one => one.name);

    /** The test style with a top-level `attachments:`, parsed. */
    const styled = (...paths: string[]) => parseStyle(
        STYLE.replace("specTypes:", `attachments:\n${paths.map(one => `  - ${one}`).join("\n")}\nspecTypes:`),
        "t");

    it("reaches every stage, not just the one a stage's own list would name", async () => {

        const style = styled("docs/glossary.md");

        const middle = await assemble(input({ style }), registry());
        const first = await assemble(input({ style, stageId: "first", contents: folder() }), registry());

        expect(named(middle)).toContain("glossary");
        expect(named(first)).toContain("glossary");
    });

    /*
     * General reference before what this one phase asked for - the
     * style's list is the same for every stage, a stage's own is not.
     */
    it("leads a stage's own attachments, both after the instructions", async () => {

        const style = parseStyle(
            STYLE
                .replace("specTypes:", "attachments:\n  - docs/glossary.md\nspecTypes:")
                .replace(
                    "  - id: middle\n    produces: [two.md]",
                    "  - id: middle\n    produces: [two.md]\n    attachments:\n      - docs/api/contract.md"),
            "t");

        const request = await assemble(input({ style }), registry());

        expect(named(request)).toEqual(["how", "one", "glossary", "contract"]);
    });

    it("fails naming the file when one is not in the repository", async () => {

        await expect(assemble(input({ style: styled("docs/nope.md") }), registry()))
            .rejects.toThrow(/attaches 'docs\/nope.md', which is not in the repository/);
    });

    it("changes nothing for a style that names none", async () => {

        expect(named(await assemble(input(), registry()))).toEqual(["how", "one"]);
    });

    it("may read a spec variable, resolved the same way a stage's own is", async () => {

        const style = styled("${{ spec.dir }}/api.md");

        const request = await assemble(
            input({ style }), registry({}, { workspaceFolder: "C:/repo" }));

        expect(request.attachments).toContainEqual({ name: "api", path: "/repo/specs/greeting/api.md" });
    });
});

/*
 * `${{ spec.… }}` - the read-only facts a style may name.
 *
 * A style is parsed once and run for every spec, so the parser leaves
 * these exactly as written and this is where they are answered: the
 * first moment there is a spec to have values. Nobody sets one, nothing
 * declares one, and the set is closed - see phase/specVars.ts.
 */
describe("the spec's own variables", () => {

    const REPO_ROOT = "C:/repo";

    /** The test style with `body` folded into the `middle` stage. */
    const styled = (body: string) => parseStyle(
        STYLE.replace("  - id: middle\n    produces: [two.md]", `  - id: middle\n    produces: [two.md]\n${body}`),
        "t");

    const named = (request: { attachments: { name: string }[] }) => request.attachments.map(one => one.name);

    const rooted = () => registry({}, { workspaceFolder: REPO_ROOT });

    /*
     * The case the key was wanted for: a reference file that belongs to
     * this spec rather than to the process. No walk could derive it -
     * the folder's own documents arrive as context, and a contract
     * dropped beside them is reference material, not a phase's output.
     */
    it("answers a spec-relative attachment, at the path it sits on in the repository", async () => {

        const request = await assemble(
            input({ style: styled("    attachments:\n      - ${{ spec.dir }}/api.md") }), rooted());

        expect(named(request)).toEqual(["how", "one", "api"]);
        expect(request.attachments).toContainEqual({ name: "api", path: "/repo/specs/greeting/api.md" });
    });

    it("answers the spec type in an attachment", async () => {

        const request = await assemble(
            input({ style: styled("    attachments:\n      - docs/types/${{ spec.type }}.md") }), rooted());

        expect(request.attachments).toContainEqual({ name: "full", path: "/repo/docs/types/full.md" });
    });

    it("answers one in a template, so a phase can run different instructions per type", async () => {

        const request = await assemble(
            input({ style: styled("    instructions: docs/types/${{ spec.type }}.md") }), rooted());

        expect(request.attachments.find(one => one.name === "how")?.path)
            .toBe("/repo/docs/types/full.md");
    });

    /*
     * The style's half of the ai settings, resolved before the merge -
     * which is what keeps them out of settings.json. The plugin's own
     * defaults there are read strictly and long before a spec exists, so
     * an expression written among them is refused by name rather than
     * quietly working in one file and not the other.
     */
    it("answers one in an ai arg", async () => {

        const request = await assemble(
            input({ style: styled("    ai:\n      systemMessage:\n        content: Working on ${{ spec.name }} (${{ spec.stage }}).") }),
            rooted());

        expect(request.ai.args.systemMessage)
            .toEqual({ content: "Working on greeting (middle)." });
    });

    /*
     * A reference nobody notices is missing is
     * worse than a phase that will not start. An expression resolving to
     * a file no spec has fails the same way a typo'd literal does.
     */
    it("still fails naming the file when what it resolves to is not there", async () => {

        await expect(assemble(
            input({ style: styled("    attachments:\n      - ${{ spec.dir }}/nope.md") }), rooted()))
            .rejects.toThrow(/attaches 'specs\/greeting\/nope.md', which is not in the repository/);
    });

    /*
     * The portability rule, applied to the half of the path that did not
     * exist when the parser checked it. A spec root configured outside
     * the workspace makes `${{ spec.path }}` land outside it, and an
     * attachment there is a file no teammate's checkout has.
     */
    it("refuses a resolved path that lands outside the repository", async () => {

        await expect(assemble(
            input({
                style: styled("    attachments:\n      - ${{ spec.path }}/api.md"),
                specPath: "C:/elsewhere/greeting"
            }),
            rooted()))
            .rejects.toThrow(/climbs out of the repository/);
    });

    /*
     * `spec.path` is the one fact a caller can fail to supply - a test,
     * an in-memory registry, anything with no disk behind it. Named
     * rather than blanked: a path rooted at nothing is exactly what this
     * refuses to produce.
     */
    it("says so when the run cannot supply the fact that was asked for", async () => {

        await expect(assemble(
            input({ style: styled("    attachments:\n      - ${{ spec.path }}/api.md") }), rooted()))
            .rejects.toThrow(/no spec.path to give/);
    });

    it("leaves a stage that writes none exactly as it was", async () => {

        const request = await assemble(input(), rooted());

        expect(named(request)).toEqual(["how", "one"]);
    });
});

/*
 * `spec.json` - what one spec is given, on top of what its style gives
 * every spec.
 *
 * The files here belong to neither the style nor the pipeline: a
 * contract this feature extends, notes a person typed, research that
 * happened somewhere else. They reach every phase and every revise of
 * the spec that declared them, and no other spec.
 */
describe("what one spec declares", () => {

    const SPEC_PATH = "/abs/specs/greeting";

    const named = (request: { attachments: { name: string }[] }) => request.attachments.map(one => one.name);

    const json = (...attachments: { file: string; desc: string }[]) =>
        JSON.stringify({ spec: 1, attachments });

    const declaring = (over: Partial<PhaseInput> = {}) => input({
        specPath: SPEC_PATH,
        specJson: json({ file: "docs/api/contract.md", desc: "the API contract this feature extends" }),
        ...over
    });

    /*
     * Last of the attachments, and that is the decision. The grammar is
     * the same for every style, the instruction the same for every run
     * of this phase - these files are about this spec and nothing else.
     */
    it("attaches them last, after the instructions", async () => {

        expect(named(await assemble(declaring(), registry())))
            .toEqual(["how", "one", "contract"]);
    });

    it("attaches the absolute path, which is what a provider opens", async () => {

        const request = await assemble(declaring(), registry());

        expect(request.attachments.find(one => one.name === "contract")?.path)
            .toBe("/repo/docs/api/contract.md");
    });

    /* A bare name is the spec's own file; the spec folder is where it is looked for. */
    it("resolves a bare name inside the spec folder", async () => {

        const request = await assemble(declaring({
            contents: folder("one.md", "notes.md"),
            specJson: json({ file: "notes.md", desc: "what the customer actually asked for" })
        }), registry());

        expect(request.attachments.find(one => one.name === "notes")?.path)
            .toBe(path.join(SPEC_PATH, "notes.md"));
    });

    /*
     * The author's own words, verbatim. Nothing in this layer could say
     * what `contract.md` holds, and the generic clause a document gets -
     * "the spec's contract" - reads as one of the pipeline's own outputs.
     */
    it("says what the file is for, in the words spec.json used", async () => {

        const request = await assemble(declaring(), registry());

        expect(request.prompt)
            .toContain("- **contract** - the API contract this feature extends");
    });

    /*
     * The requirement, stated as a test: every phase, and the revise
     * too. Both run through this function, which is why one check here
     * covers a promise made about two buttons.
     */
    it("reaches every phase of the pipeline", async () => {

        for (const stageId of ["first", "middle", "implement"])
            expect(named(await assemble(declaring({ stageId, tasks: stageId === "implement" ? HANDED : undefined }), registry())))
                .toContain("contract");
    });

    it("reaches a revise, where the phase is rewriting its own document", async () => {

        const request = await assemble(declaring({
            contents: folder("one.md", "two.md"),
            revise: true,
            note: "tighten requirement 3"
        }), registry());

        expect(named(request)).toContain("contract");
        expect(Object.keys(request.documents).sort()).toEqual(["current", "one"]);
    });

    /* Nothing declared is the ordinary case, and it is not an error or a warning. */
    it("is silent when the spec declares nothing", async () => {

        expect(named(await assemble(input({ specPath: SPEC_PATH }), registry())))
            .toEqual(["how", "one"]);
    });

    /*
     * A spec naming a file it has not written yet is a spec in progress.
     * The phase runs without it and the log says so - stopping here
     * would make `spec.json` a thing to be afraid of.
     */
    it("skips a file that is not in the spec folder", async () => {

        const request = await assemble(declaring({
            specJson: json({ file: "notes.md", desc: "the notes" })
        }), registry());

        expect(named(request)).toEqual(["how", "one"]);
    });

    it("skips a file that is not in the workspace", async () => {

        const request = await assemble(declaring({
            specJson: json({ file: "docs/nowhere.md", desc: "a file nobody wrote" })
        }), registry());

        expect(named(request)).toEqual(["how", "one"]);
    });

    /* A caller with no disk behind it - an in-memory registry - has no absolute path to give. */
    it("skips a spec-folder file when the caller gave no spec path", async () => {

        const request = await assemble(input({
            contents: folder("one.md", "notes.md"),
            specJson: json({ file: "notes.md", desc: "the notes" })
        }), registry());

        expect(named(request)).toEqual(["how", "one"]);
    });

    /* Named once. A file listed as an attachment and again as a document is two files to a reader. */
    it("names a declared document once, not twice", async () => {

        const request = await assemble(declaring({
            specJson: json({ file: "one.md", desc: "the first document, and read it closely" })
        }), registry());

        expect(named(request)).toEqual(["how", "one"]);
        expect(request.context).toEqual([]);
        expect(request.prompt).toContain("- **one** - the first document, and read it closely");
    });

    /*
     * `desc` is wording for the prompt. The plugin is handed a path and
     * a name, and a third key would travel to a provider with no field
     * for it.
     */
    it("keeps desc out of what the plugin is handed", async () => {

        const request = await assemble(declaring(), registry());

        expect(Object.keys(request.attachments[0]).sort()).toEqual(["name", "path"]);
    });

    /* A broken file stops the phase, naming the key - it is written by hand. */
    it("refuses a spec.json that does not parse", async () => {

        await expect(assemble(declaring({ specJson: "{ oops" }), registry()))
            .rejects.toThrow(/spec\.json is not valid JSON/);
    });

    it("refuses a key it does not have", async () => {

        await expect(assemble(
            declaring({ specJson: JSON.stringify({ spec: 1, attachment: [] }) }), registry()))
            .rejects.toThrow(/'attachment', which is not a key it has/);
    });
});

/*
 * The style's `ai:` reaching the request that runs the phase.
 *
 * The parser and the merge are tested where they live; what this checks
 * is that the two are joined - a style stating an opinion about a phase
 * and nobody passing it on would be a key that parses, validates and
 * changes nothing.
 */
describe("what the phase runs on", () => {

    const aiStyle = (block: string) => parseStyle(
        STYLE.replace("  - id: middle\n    produces: [two.md]", `  - id: middle\n    produces: [two.md]\n${block}`),
        "t");

    it("carries the style's opinion into the request", async () => {

        const style = aiStyle("    ai:\n      model: opus\n      thinking: high");

        const request = await assemble(input({ style }), registry());

        expect(request.ai.args).toMatchObject({ model: "opus", thinking: "high" });
    });

    /*
     * The stage is the only per-phase voice. Two files answering "why
     * is this phase on that model" would mean reading both to know.
     */
    it("beats the blanket default, which is more general than it", async () => {

        const style = aiStyle("    ai:\n      model: opus");

        const request = await assemble(input({
            style,
            config: configFromSettings({ aiDefaults: { "ai@1": { model: "claude-sonnet-5" } } })
        }), registry());

        expect(request.ai.args.model).toBe("opus");
    });

    /* Only the stage that declared it. A style's opinion about design is not one about tasks. */
    it("applies to the stage that declared it and no other", async () => {

        const style = aiStyle("    ai:\n      model: opus");

        expect((await assemble(input({ style }), registry())).ai.args.model).toBe("opus");
        expect((await assemble(input({ style, stageId: "first", contents: folder() }), registry())).ai.args.model)
            .toBe("auto");
    });

    it("leaves the plugin to the settings, whatever the style thinks", async () => {

        const style = aiStyle("    ai:\n      model: opus");

        const request = await assemble(input({
            style,
            config: configFromSettings({ sdd: { uses: "eesha@1" } })
        }), registry());

        expect(request.ai.uses).toBe("eesha@1");
        expect(request.ai.args.model).toBe("opus");
    });
});

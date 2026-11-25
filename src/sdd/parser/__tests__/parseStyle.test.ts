import { describe, expect, it } from "vitest";
import { isTerminal, pipeline, startsSession } from "../../model/style";
import { parseStyle } from "../parseStyle";

/**
 * A minimal style, spelled out once so each test below can bend one
 * thing and stay readable.
 *
 * It declares no stages at all, which is the ordinary case rather than
 * a trick: a spec type's list names the drafting phases, the two gates
 * open and close every pipeline on their own, and a phase called
 * `design` writes `design.md` from `instructions/design.md` and parks for a
 * human without anybody saying so. `stages:` exists for the exceptions,
 * and this style has none.
 *
 * Two spec types, because the interesting behaviour - what a stage
 * requires, what it receives - is a function of the type's list rather
 * than of the pool.
 */
function styleYaml(body?: string): string {

    return body ?? `
schema: 1
id: t
name: T
desc: A test style.
specTypes:
  - id: feature
    label: Feature
    stages: [requirements, design, tasks]
  - id: bug
    label: Bug fix
    stages: [requirements, tasks]
`;
}

/** The style under test, with `replace` applied to the source first. */
function parsed(replace?: [string | RegExp, string]) {

    const yaml = replace ? styleYaml().replace(replace[0], replace[1]) : styleYaml();

    return parseStyle(yaml, "t");
}

/** The same style with a `stages:` block holding the given entries. */
function withStage(entry: string) {

    return parsed([/^specTypes:/m, `stages:\n${entry}\nspecTypes:`]);
}

/** Like {@link withStage}, but `feature` also visits `implement` - for entries that override it. */
function withImplementStage(entry: string) {

    return parsed([
        /^specTypes:[\s\S]*$/m,
        `stages:\n${entry}\nspecTypes:\n  - id: feature\n    label: Feature\n    stages: [requirements, design, tasks, implement]\n`
    ]);
}

const stageOf = (id: string, style = parsed()) => style.stages.find(stage => stage.id === id)!;

describe("parseStyle", () => {

    it("reads the shape a style declares", () => {

        const style = parsed();

        expect(style.id).toBe("t");
        expect(style.name).toBe("T");
        expect(style.specTypes.map(specType => specType.label)).toEqual(["Feature", "Bug fix"]);
    });

    /*
     * The ask comes in the same way in every process, so `idea` is
     * never written down and can't be got wrong. `implement` is
     * different: this style's spec types never name it, so neither
     * pipeline ends in code - it ends at its last drafting phase.
     */
    it("opens every pipeline with the input gate, which nothing listed", () => {

        expect(parsed().specTypes[0].stages).toEqual(["idea", "requirements", "design", "tasks"]);
        expect(parsed().specTypes[1].stages).toEqual(["idea", "requirements", "tasks"]);
    });

    it("closes a pipeline with the output gate only when a spec type names it", () => {

        const style = parsed([/    stages: \[requirements, design, tasks\]/, "    stages: [requirements, design, tasks, implement]"]);

        expect(style.specTypes[0].stages).toEqual(["idea", "requirements", "design", "tasks", "implement"]);
        expect(style.specTypes[1].stages).toEqual(["idea", "requirements", "tasks"]);
    });

    /*
     * The whole of what a drafting phase is, from its id. The shipped
     * styles follow this convention, so writing it down is optional.
     */
    it("builds a drafting phase out of its id alone", () => {

        expect(stageOf("design")).toEqual({
            id: "design",
            label: "design",
            produces: ["design.md"],
            instructions: { root: "style", path: "instructions/design.md" }
        });
    });

    it("gives the input gate a document and no prompt, because nothing runs it", () => {

        const idea = stageOf("idea");

        expect(idea.produces).toEqual(["idea.md"]);
        expect(idea.instructions).toBeUndefined();
        expect(startsSession(idea)).toBe(true);
        expect(isTerminal(idea)).toBe(false);
    });

    it("gives the output gate no document and no prompt of its own, because it is terminal", () => {

        const style = parsed([/    stages: \[requirements, design, tasks\]/, "    stages: [requirements, design, tasks, implement]"]);
        const implement = stageOf("implement", style);

        expect(implement.produces).toEqual([]);
        expect(implement.instructions).toBeUndefined();
        expect(isTerminal(implement)).toBe(true);
        expect(startsSession(implement)).toBe(true);
    });

    it("puts no output gate in the pool at all when no spec type visits it", () => {

        expect(parsed().stages.find(stage => stage.id === "implement")).toBeUndefined();
    });

    /*
     * The one default the pool cannot hold. There is a single
     * `implement` stage shared by every spec type, and what it is handed
     * differs per type - a plan to build, or a list to file - so the
     * prompt is named for the stage that fed it and settled where the
     * type is known.
     */
    it("names the output gate's prompt after the stage that fed it, per spec type", () => {

        const style = parseStyle(`
schema: 1
id: t
name: T
desc: A test style.
specTypes:
  - id: feature
    label: Feature
    stages: [requirements, design, stories, implement]
  - id: bug
    label: Bug fix
    stages: [requirements, tasks, implement]
`, "t");
        const gate = (specType: string) => pipeline(style, specType).at(-1)!.instructions;

        expect(gate("feature")).toEqual({ root: "style", path: "instructions/stories-implement.md" });
        expect(gate("bug")).toEqual({ root: "style", path: "instructions/tasks-implement.md" });
    });

    /*
     * There is no `kind`: every stage a spec type lists is a drafting
     * phase, so a kind would have nothing to say.
     */
    it("carries no kind, session, context or requires - all four are derived", () => {

        // `attachments`, `ai`, `presets` and `prefix` are here and
        // undefined: they are the things a stage can be handed that no
        // derivation could have known - which of a repository's files
        // this phase reads, what it runs on, what its revise box
        // suggests, and what its own ids are called - so undefined is a
        // real answer rather than a default waiting to be filled in.
        expect(Object.keys(stageOf("design")).sort())
            .toEqual(["actionable", "ai", "attachments", "id", "instructions", "label", "prefix", "presets", "produces"]);

        expect(stageOf("design").attachments).toBeUndefined();
        expect(stageOf("design").ai).toBeUndefined();
        expect(stageOf("design").presets).toBeUndefined();
        expect(stageOf("design").prefix).toBeUndefined();
    });
});

describe("pipeline", () => {

    it("orders by the spec type, not by the pool - a design-first order works", () => {

        const swapped = parsed([/    stages: \[requirements, design, tasks\]/, "    stages: [design, requirements, tasks]"]);

        expect(pipeline(swapped, "feature").map(stage => stage.id))
            .toEqual(["idea", "design", "requirements", "tasks"]);
    });

    it("names the spec types it has when asked for one it does not", () => {

        expect(() => pipeline(parsed(), "chore")).toThrow(/no spec type 'chore'/);
    });
});

describe("a stage entry", () => {

    /*
     * The one thing no convention can know: a stage whose document has a
     * different name than its id.
     */
    it("replaces only what it names, and leaves the rest defaulted", () => {

        const style = withStage("  - id: design\n    produces: [spec.md]");

        expect(stageOf("design", style).produces).toEqual(["spec.md"]);
        expect(stageOf("design", style).instructions).toEqual({ root: "style", path: "instructions/design.md" });
    });

    /*
     * The id is the session name, the log bucket and the
     * per-stage settings key. A team that wants its own word for a phase
     * changes what is shown rather than moving all three.
     */
    it("can rename what is shown without moving the id", () => {

        const style = withStage("  - id: design\n    label: Solution outline");

        expect(stageOf("design", style).label).toBe("Solution outline");
        expect(stageOf("design", style).id).toBe("design");
    });

    it("can dress the input gate without being allowed to run it", () => {

        expect(stageOf("idea", withStage("  - id: idea\n    label: Capture")).label).toBe("Capture");

        expect(() => withStage("  - id: idea\n    instructions: docs/idea.md")).toThrow(/runs no model/);
    });

    it("refuses an artifact on the output gate - terminal means never satisfied", () => {

        expect(() => withStage("  - id: implement\n    produces: [done.md]")).toThrow(/it is terminal/);
    });

    it("refuses a phase that writes nothing, which could never complete", () => {

        expect(() => withStage("  - id: design\n    produces: []")).toThrow(/can never complete/);
    });

    it("rejects a duplicate entry, which two sessions would share", () => {

        expect(() => withStage("  - id: design\n    label: One\n  - id: design\n    label: Two"))
            .toThrow(/declares stage 'design' twice/);
    });

    /*
     * An entry nobody visits is dead configuration, and reads as an edit
     * that did nothing. Both causes - a typo, and a phase somebody
     * forgot to wire up - want fixing at the moment of writing.
     */
    it("rejects an entry no spec type visits", () => {

        expect(() => withStage("  - id: research\n    label: Research"))
            .toThrow(/'research', which no spec type visits/);
    });
});

describe("a stage's citation prefix", () => {

    it("carries the prefix a stage declares, and leaves it undefined otherwise", () => {

        const style = withStage("  - id: design\n    prefix: Design");

        expect(stageOf("design", style).prefix).toBe("Design");
        expect(stageOf("tasks", style).prefix).toBeUndefined();
    });

    it("refuses a prefix that is not an uppercase letter followed by letters and digits", () => {

        expect(() => withStage("  - id: design\n    prefix: design"))
            .toThrow(/not an uppercase letter/);

        expect(() => withStage("  - id: design\n    prefix: 'Design 1'"))
            .toThrow(/not an uppercase letter/);
    });

    it("refuses a one-character prefix and takes two", () => {

        expect(() => withStage("  - id: design\n    prefix: F"))
            .toThrow(/one character/);

        expect(stageOf("design", withStage("  - id: design\n    prefix: FT")).prefix).toBe("FT");
    });

    it("refuses a prefix on either gate, which writes no numbered document", () => {

        expect(() => withStage("  - id: idea\n    prefix: Idea"))
            .toThrow(/Gates write no numbered document/);

        expect(() => withStage("  - id: implement\n    prefix: Impl"))
            .toThrow(/Gates write no numbered document/);
    });
});

describe("spec types", () => {

    /*
     * `idea` is never the style's to place - it opens every pipeline
     * on its own, so listing it could only ever be a second one.
     */
    it("rejects listing the input gate, which is not the style's to place", () => {

        expect(() => parsed([/    stages: \[requirements, design, tasks\]/, "    stages: [idea, requirements]"]))
            .toThrow(/opens every pipeline on its own/);
    });

    /*
     * `implement` may be listed - a spec type opts into it - but it is
     * still terminal: anywhere but last, the stages after it would be
     * unreachable.
     */
    it("rejects the output gate anywhere but last", () => {

        expect(() => parsed([/    stages: \[requirements, design, tasks\]/, "    stages: [requirements, implement, design]"]))
            .toThrow(/visits it last, or not at all/);
    });

    /*
     * A stage nothing declared is an ordinary drafting phase, so a typo
     * here is not a load error. It is still caught, one step later
     * and less clearly: `instructions/requirments.md` is in no scope.
     */
    it("builds a stage for any id it names", () => {

        const style = parsed([/    stages: \[requirements, tasks\]/, "    stages: [requirements, research]"]);

        expect(stageOf("research", style).produces).toEqual(["research.md"]);
        expect(stageOf("research", style).instructions).toEqual({ root: "style", path: "instructions/research.md" });
    });

    it("rejects visiting one stage twice in a pipeline", () => {

        expect(() => parsed([/    stages: \[requirements, design, tasks\]/, "    stages: [requirements, design, requirements]"]))
            .toThrow(/visits 'requirements' twice/);
    });

    it("rejects an empty pipeline", () => {

        expect(() => parsed([/    stages: \[requirements, design, tasks\]/, "    stages: []"]))
            .toThrow(/lists no stages/);
    });

    it("rejects a duplicated spec type id", () => {

        expect(() => parsed([/  - id: bug/, "  - id: feature"])).toThrow(/declares spec type 'feature' twice/);
    });
});

describe("identity and schema", () => {

    it("insists the id matches the folder it was found in", () => {

        expect(() => parseStyle(styleYaml(), "other")).toThrow(/The folder is the identity/);
    });

    it("demands a schema line, naming what to write", () => {

        expect(() => parsed([/schema: 1\n/, ""])).toThrow(/must declare 'schema: 1'/);
    });

    it("refuses a style from a newer build rather than half-reading it", () => {

        expect(() => parsed([/schema: 1/, "schema: 2"])).toThrow(/newer version of Eesha Code/);
    });

    it("reports a YAML error against the style, not the line noise", () => {

        expect(() => parseStyle("id: [unclosed", "t")).toThrow(/Style 't' is not valid YAML/);
    });

    it("treats an empty file as a style that declares nothing", () => {

        expect(() => parseStyle("", "t")).toThrow(/Style 't' is empty/);
    });
});

/*
 * A path into the repository rather than into the style folder - the
 * one place a style points outside itself, and so the one place the
 * portability rule has to be restated against a different root.
 */
describe("a stage template", () => {

    /* The whole point of the collapse: a stage says nothing and still has its instructions. */
    it("derives from the id when a stage names none", () => {

        expect(stageOf("design").instructions).toEqual({ root: "style", path: "instructions/design.md" });
    });

    it("normalizes separators so a Windows-authored style resolves the same", () => {

        const style = withStage("  - id: design\n    instructions: docs\\templates\\design.md");

        expect(stageOf("design", style).instructions).toEqual({ root: "repo", path: "docs/templates/design.md" });
    });

    it("rejects an absolute path", () => {

        expect(() => withStage("  - id: design\n    instructions: C:/templates/design.md"))
            .toThrow(/relative to the repository/);
    });

    it("rejects a path climbing out of the repository", () => {

        expect(() => withStage("  - id: design\n    instructions: ../shared/design.md"))
            .toThrow(/climbs out of the repository/);
    });

    it("is refused on the input gate, where nothing would read it", () => {

        expect(() => withStage("  - id: idea\n    instructions: docs/templates/idea.md"))
            .toThrow(/names instructions/);
    });
});

/*
 * A stage's `attachments:` - the repository files a phase is handed
 * beside its instructions.
 *
 * The portability rule is `instructions:`'s, for the same
 * reason, so these tests are deliberately its tests again: the file has
 * to travel in git with the style pointing at it, or a teammate's
 * checkout resolves something else or nothing.
 */
describe("a stage's attachments", () => {

    it("are absent unless a stage names them - nothing derives a reference file", () => {

        expect(stageOf("design").attachments).toBeUndefined();
    });

    it("accepts a bare string as a list of one", () => {

        const style = withStage("  - id: design\n    attachments: docs/api/contract.md");

        expect(stageOf("design", style).attachments)
            .toEqual([{ root: "repo", path: "docs/api/contract.md" }]);
    });

    it("keeps the order written, which is the order they are attached", () => {

        const style = withStage(
            "  - id: design\n    attachments:\n      - docs/api/contract.md\n      - docs/glossary.md");

        expect(stageOf("design", style).attachments)
            .toEqual([
                { root: "repo", path: "docs/api/contract.md" },
                { root: "repo", path: "docs/glossary.md" }
            ]);
    });

    it("normalizes separators so a Windows-authored style resolves the same", () => {

        const style = withStage("  - id: design\n    attachments: docs\\api\\contract.md");

        expect(stageOf("design", style).attachments)
            .toEqual([{ root: "repo", path: "docs/api/contract.md" }]);
    });

    /* The error has to name the key that was written, not the one that shares the rule. */
    it("rejects an absolute path, naming attachments rather than template", () => {

        expect(() => withStage("  - id: design\n    attachments: C:/shared/contract.md"))
            .toThrow(/has an absolute 'attachments: C:\/shared\/contract.md'/);
    });

    it("rejects a path climbing out of the repository", () => {

        expect(() => withStage("  - id: design\n    attachments: ../shared/contract.md"))
            .toThrow(/'attachments: \.\.\/shared\/contract.md' that climbs out/);
    });

    it("rejects the same file twice - attached twice reads as two files", () => {

        expect(() => withStage(
            "  - id: design\n    attachments:\n      - docs/a.md\n      - docs/a.md"))
            .toThrow(/attaches 'docs\/a.md' twice/);
    });

    it("rejects an entry that is not text", () => {

        expect(() => withStage("  - id: design\n    attachments:\n      - 7"))
            .toThrow(/'attachments:' entry that is not text/);
    });

    /* Nothing runs the input gate, so a file named for it is a file nobody opens. */
    it("is refused on the input gate", () => {

        expect(() => withStage("  - id: idea\n    attachments: docs/api/contract.md"))
            .toThrow(/names attachments/);
    });

    it("is allowed on the output gate, which does run a model", () => {

        const style = withImplementStage("  - id: implement\n    attachments: docs/api/contract.md");

        expect(stageOf("implement", style).attachments)
            .toEqual([{ root: "repo", path: "docs/api/contract.md" }]);
    });
});

/*
 * The style's own top-level `attachments:` - reference files handed to
 * every stage that runs a model, not just one of them.
 *
 * Parsed the same way a stage's own list is - same portability rule,
 * same duplicate check, same shape errors - because it is the same key
 * with a wider reach. What that reach means to an assembled phase is
 * `assemble`'s question, not the parser's; this only checks the parser
 * reads and validates the key the way it reads every other.
 */
describe("the style's own attachments", () => {

    const withTop = (body: string) => parsed([/^specTypes:/m, `${body}\nspecTypes:`]);

    it("is absent unless the style names them", () => {

        expect(parsed().attachments).toBeUndefined();
    });

    it("accepts a bare string as a list of one", () => {

        expect(withTop("attachments: docs/glossary.md").attachments)
            .toEqual([{ root: "repo", path: "docs/glossary.md" }]);
    });

    it("keeps the order written", () => {

        expect(withTop("attachments:\n  - docs/house-style.md\n  - docs/glossary.md").attachments)
            .toEqual([
                { root: "repo", path: "docs/house-style.md" },
                { root: "repo", path: "docs/glossary.md" }
            ]);
    });

    it("rejects an absolute path, under the same rule as a stage's own", () => {

        expect(() => withTop("attachments: C:/shared/glossary.md"))
            .toThrow(/has an absolute 'attachments: C:\/shared\/glossary.md'/);
    });

    it("rejects a path climbing out of the repository", () => {

        expect(() => withTop("attachments: ../shared/glossary.md"))
            .toThrow(/'attachments: \.\.\/shared\/glossary.md' that climbs out/);
    });

    it("rejects the same file twice", () => {

        expect(() => withTop("attachments:\n  - docs/a.md\n  - docs/a.md"))
            .toThrow(/attaches 'docs\/a.md' twice/);
    });

    it("rejects an entry that is not text", () => {

        expect(() => withTop("attachments:\n  - 7"))
            .toThrow(/'attachments:' entry that is not text/);
    });

    /*
     * Unlike a stage's own list, there is no input gate to refuse this
     * on - the key names no stage at all, so every stage that reaches
     * assembly is free to receive it.
     */
    it("may read a spec variable, left for `assemble` to answer, same as a stage's own", () => {

        expect(withTop("attachments:\n  - ${{ spec.dir }}/glossary.md").attachments)
            .toEqual([{ root: "repo", path: "${{ spec.dir }}/glossary.md" }]);
    });

    it("is named alongside a stage's own in the placement error", () => {

        expect(() => parsed([/^desc: .*/m, "desc: ${{ spec.dir }}"]))
            .toThrow(/the style's own 'attachments:'/);
    });
});

/*
 * `${{ }}` in a style.yml.
 *
 * The notation is resolved when the file is read, so a style author can
 * spell the workspace root the way the rest of the product spells it.
 * Without it, a literal folder named `${{ workspaceFolder }}` would be
 * looked up under the repository. See core/templating/configScope.ts.
 */
describe("expressions in a style", () => {

    const templating = { workspaceFolder: "C:/repo", home: "C:/Users/me", processEnv: {} };

    const withTemplate = (value: string) => parseStyle(
        styleYaml().replace(
            /^specTypes:/m,
            `stages:\n  - id: design\n    instructions: ${value}\nspecTypes:`),
        "t",
        templating).stages.find(stage => stage.id === "design")!;

    /*
     * The prefix is redundant - a template is
     * already workspace-relative - but it is what a person writes, and
     * refusing the spelling the engine itself teaches is the wrong
     * answer to it.
     */
    it("resolves the workspace anchor in a template, folding it back to a relative path", () => {

        expect(withTemplate("${{ workspaceFolder }}/docs/shape.md").instructions?.path)
            .toBe("docs/shape.md");
    });

    it("leaves a plain relative template alone", () => {

        expect(withTemplate("docs/shape.md").instructions?.path).toBe("docs/shape.md");
    });

    /*
     * The portability rule: the file has to travel in git
     * with the style that points at it. An anchor that lands outside the
     * repository is the same mistake a `..` is, and earns the same error.
     */
    it("refuses a resolved path that lands outside the repository", () => {

        expect(() => withTemplate("${{ home }}/shape.md"))
            .toThrow(/climbs out of the repository/);
    });

    it("resolves anywhere else in the file, not only in a template", () => {

        const style = parseStyle(
            styleYaml().replace(/^desc: .*/m, "desc: Built for ${{ env.TEAM }}."),
            "t",
            { ...templating, processEnv: { TEAM: "platform" } });

        expect(style.desc).toBe("Built for platform.");
    });

    /* No workspace, so nothing for the anchor to mean - refused, never substituted empty. */
    it("refuses an expression when the caller has no workspace", () => {

        expect(() => parseStyle(
            styleYaml().replace(/^desc: .*/m, "desc: ${{ workspaceFolder }}"), "t"))
            .toThrow(/no workspace is open/);
    });

    it("still refuses an absolute template nobody templated", () => {

        expect(() => withTemplate("C:/elsewhere/shape.md"))
            .toThrow(/climbs out of the repository/);
    });
});

/*
 * `${{ spec.… }}` - the one namespace a style.yml is *not* read with.
 *
 * A style is a process, and a process is read once for every spec there
 * will ever be. So these are left exactly as written here and answered
 * in `assemble`, which is the first place that knows which spec is in
 * front of it. What this file still owes an author is everything that
 * can be checked without a spec: that the name is real, and that it was
 * written somewhere a phase will actually read it.
 */
describe("spec variables in a style", () => {

    const templating = { workspaceFolder: "C:/repo", home: "C:/Users/me", processEnv: {} };

    const withStageBody = (body: string, options?: typeof templating) => parseStyle(
        styleYaml().replace(/^specTypes:/m, `stages:\n  - id: design\n${body}specTypes:`),
        "t",
        options);

    it("leaves an attachment's expression as written, for the phase to answer", () => {

        const style = withStageBody("    attachments:\n      - ${{ spec.dir }}/api.md\n", templating);

        expect(stageOf("design", style).attachments)
            .toEqual([{ root: "repo", path: "${{ spec.dir }}/api.md" }]);
    });

    it("leaves one in a template and one in an ai arg the same way", () => {

        const style = withStageBody(
            "    instructions: docs/${{ spec.type }}.md\n    ai:\n      model: ${{ spec.stage }}-model\n",
            templating);

        expect(stageOf("design", style).instructions?.path).toBe("docs/${{ spec.type }}.md");
        expect(stageOf("design", style).ai).toEqual({ model: "${{ spec.stage }}-model" });
    });

    /*
     * The whole reason the set is closed. The value is a run away, but
     * the name is not - and a typo caught here is a message about the
     * line somebody just wrote rather than a phase that will not start.
     */
    it("refuses a name that is not one of them, and says which are", () => {

        expect(() => withStageBody("    attachments:\n      - ${{ spec.folder }}/api.md\n", templating))
            .toThrow(/'\$\{\{ spec.folder \}\}', which is not a spec variable.*spec.dir/s);
    });

    /*
     * Every other key is consumed before a spec is in hand - `produces:`
     * by the walk matching a folder against a pipeline - so an
     * expression there would be compared as literal text against a real
     * filename. Nothing errors, the pipeline is simply drawn wrong.
     */
    it("refuses one written where nothing would ever answer it", () => {

        expect(() => withStageBody("    produces:\n      - ${{ spec.type }}.md\n", templating))
            .toThrow(/somewhere a spec variable cannot be read/);
    });

    /*
     * No anchor is being read, so no workspace is needed to read the
     * file - which is what lets a style written this way load in a
     * session that has no workspace open.
     */
    it("needs no workspace, unlike every other expression", () => {

        const style = withStageBody("    attachments:\n      - ${{ spec.dir }}/api.md\n");

        expect(stageOf("design", style).attachments?.[0].path).toBe("${{ spec.dir }}/api.md");
    });

    /*
     * Deferring one namespace must not turn the pass lenient about the
     * rest. Left alone, `resolveKnown` leaves *everything* it cannot
     * answer as its own text - which is the silent failure the strict
     * default exists to stop.
     */
    it("keeps every other namespace strict alongside it", () => {

        expect(() => withStageBody(
            "    attachments:\n      - ${{ spec.dir }}/api.md\n      - ${{ vars.docs }}/api.md\n",
            templating))
            .toThrow(/vars are not available here/);
    });

    it("resolves the anchors in the same value it defers", () => {

        const style = withStageBody(
            "    attachments:\n      - ${{ workspaceFolder }}/docs/${{ spec.type }}.md\n", templating);

        expect(stageOf("design", style).attachments?.[0].path).toBe("docs/${{ spec.type }}.md");
    });
});

/*
 * A stage's `ai:` - what the process thinks this phase needs.
 *
 * The style's opinion, not the last word. Only a style knows which of
 * its phases is the hard one. Without `ai:` an author could shape a
 * phase completely and then leave every team to rediscover the same
 * setting in their own settings.json.
 */
describe("a stage's ai settings", () => {

    it("are absent unless a stage declares them, leaving settings in charge", () => {

        expect(stageOf("design").ai).toBeUndefined();
    });

    /* Untyped on purpose - the plugin owns its input list, as it does in settings.json. */
    it("carry whatever was written, without enumerating what a plugin takes", () => {

        const style = withStage("  - id: design\n    ai:\n      model: opus\n      thinking: high");

        expect(stageOf("design", style).ai).toEqual({ model: "opus", thinking: "high" });
    });

    /*
     * A style naming a plugin welds a portable process to it. `sdd.uses`
     * is where a team says which one they run, and they may not run this
     * one.
     */
    it("carry providers: blocks as written", () => {

        const style = withStage(
            "  - id: design\n    ai:\n      providers:\n        ghcp:\n          reasoningSummary: concise\n        kiro-cli:\n          model: sonnet");

        expect(stageOf("design", style).ai).toEqual({
            providers: { ghcp: { reasoningSummary: "concise" }, "kiro-cli": { model: "sonnet" } }
        });
    });

    it("refuse a providers: block that picks a runtime, or sets what the engine writes", () => {

        expect(() => withStage("  - id: design\n    ai:\n      providers:\n        ghcp:\n          provider: claude"))
            .toThrow(/sets 'provider' inside 'providers\.ghcp'/);

        expect(() => withStage("  - id: design\n    ai:\n      providers:\n        ghcp:\n          prompt: hi"))
            .toThrow(/'ai\.providers\.ghcp' that sets 'prompt', which the engine writes/);

        expect(() => withStage("  - id: design\n    ai:\n      providers: [ghcp]"))
            .toThrow(/'providers:' that is not a mapping/);
    });

    it("refuse to name the plugin, which is the team's call", () => {

        expect(() => withStage("  - id: design\n    ai:\n      uses: eesha@1"))
            .toThrow(/sets 'ai.uses'.*not the style's/s);
    });

    it("point at settings.json when they try", () => {

        expect(() => withStage("  - id: design\n    ai:\n      uses: eesha@1"))
            .toThrow(/'sdd.uses'/);
    });

    /*
     * The same five refused in settings.json, refused here, with the
     * same messages. An arg refused in one place and honoured in the
     * other is the kind of inconsistency that looks like it works.
     */
    it("refuse the args the engine writes, naming the key that would have worked", () => {

        expect(() => withStage("  - id: design\n    ai:\n      attachments: [docs/a.md]"))
            .toThrow(/'attachments', which the engine writes.*stage's 'attachments:'/s);

        expect(() => withStage("  - id: design\n    ai:\n      prompt: do it"))
            .toThrow(/'prompt', which the engine writes.*'instructions:'/s);

        expect(() => withStage("  - id: design\n    ai:\n      detach: true"))
            .toThrow(/report done with nothing on disk/);
    });

    it("name the stage whose block was wrong", () => {

        expect(() => withStage("  - id: design\n    ai:\n      title: x"))
            .toThrow(/stage 1 \('design'\) declares an 'ai:' that sets 'title'/);
    });

    /* Deliberately allowed: nothing overwrites it, and it appends rather than replaces. */
    it("allow a system message, which composes with the runtime's own", () => {

        const style = withStage(
            "  - id: design\n    ai:\n      systemMessage:\n        mode: append\n        content: house rules");

        expect(stageOf("design", style).ai)
            .toEqual({ systemMessage: { mode: "append", content: "house rules" } });
    });

    it("refuse a block that is not a mapping", () => {

        expect(() => withStage("  - id: design\n    ai: opus")).toThrow(/has an 'ai:' that is not a mapping/);
    });

    /* Nothing runs the input gate, so there is nothing for a model setting to apply to. */
    it("are refused on the input gate", () => {

        expect(() => withStage("  - id: idea\n    ai:\n      model: opus"))
            .toThrow(/is the input gate and declares 'ai:'/);
    });

    it("are allowed on the output gate, which runs a model like any other phase", () => {

        const style = withImplementStage("  - id: implement\n    ai:\n      model: opus");

        expect(stageOf("implement", style).ai).toEqual({ model: "opus" });
    });
});

/*
 * Every stage key at once, spelled the way the docs spell it.
 *
 * Each key has its own tests above; what this catches is the thing they
 * cannot - a combination that parses in pieces and not together, and a
 * documented example that was never run.
 */
describe("a fully declared stage", () => {

    const style = withStage([
        "  - id: design",
        "    label: Design",
        "    produces: [design.md]",
        "    instructions: docs/instructions/design.md",
        "    attachments:",
        "      - docs/api/contract.md",
        "      - docs/glossary.md",
        "    ai:",
        "      model: opus",
        "      reasoningEffort: high"
    ].join("\n"));

    it("reads every key, and derives nothing over what was written", () => {

        expect(stageOf("design", style)).toEqual({
            id: "design",
            label: "Design",
            produces: ["design.md"],
            instructions: { root: "repo", path: "docs/instructions/design.md" },
            attachments: [
                { root: "repo", path: "docs/api/contract.md" },
                { root: "repo", path: "docs/glossary.md" }
            ],
            ai: { model: "opus", reasoningEffort: "high" }
        });
    });

    /* The stage next to it says nothing and is still a whole phase. */
    it("leaves its neighbours defaulted", () => {

        expect(stageOf("tasks", style)).toEqual({
            id: "tasks",
            label: "tasks",
            produces: ["tasks.md"],
            instructions: { root: "style", path: "instructions/tasks.md" }
        });
    });
});

/*
 * The gate on `## Open Questions`. Default true is the load-bearing
 * part: a style by someone who never read about the key gets the gate - which is the point of having it.
 */
describe("parseStyle - blockOnOpenQuestions", () => {

    it("is on for a style that says nothing", () => {

        expect(parsed().blockOnOpenQuestions).toBe(true);
    });

    it("is off where a style turns it off", () => {

        expect(parsed([/^name: T$/m, "name: T\nblockOnOpenQuestions: false"]).blockOnOpenQuestions).toBe(false);
    });

    it("takes an explicit true", () => {

        expect(parsed([/^name: T$/m, "name: T\nblockOnOpenQuestions: true"]).blockOnOpenQuestions).toBe(true);
    });

    /*
     * YAML already reads `yes`, `on` and `true` as booleans, so anything
     * arriving as text is a line written wrong - and reading
     * `blockOnOpenQuestions: "false"` as on is an afternoon nobody gets
     * back.
     */
    it("refuses a value that is not true or false", () => {

        expect(() => parsed([/^name: T$/m, "name: T\nblockOnOpenQuestions: 'false'"]))
            .toThrow(/blockOnOpenQuestions.*not true or false/);
    });
});

/*
 * `presets:` - the starting sentences the revise box's split button
 * offers. Style-wide and per stage, same shape. The parser only reads
 * and checks the list; merging, the built-in fallback and spec
 * variables are `phase/presets.ts`'s job, tested there.
 */
describe("presets", () => {

    const withTop = (body: string) => parsed([/^specTypes:/m, `${body}\nspecTypes:`]);

    const two = "  - label: Tighten\n    text: Cut words.\n  - label: Match code\n    text: Fix what the code contradicts.";

    it("is absent on the style and on every stage unless written", () => {

        expect(parsed().presets).toBeUndefined();
        expect(stageOf("design").presets).toBeUndefined();
    });

    it("reads a style-wide list, in the order written", () => {

        expect(withTop(`presets:\n${two}`).presets).toEqual([
            { label: "Tighten", text: "Cut words." },
            { label: "Match code", text: "Fix what the code contradicts." }
        ]);
    });

    it("reads a stage's own list, and leaves the style-wide one absent", () => {

        const style = withStage(`  - id: design\n    presets:\n    ${two.replace(/\n/g, "\n    ")}`);

        expect(stageOf("design", style).presets).toEqual([
            { label: "Tighten", text: "Cut words." },
            { label: "Match code", text: "Fix what the code contradicts." }
        ]);
        expect(style.presets).toBeUndefined();
        expect(stageOf("tasks", style).presets).toBeUndefined();
    });

    it("trims label and text", () => {

        expect(withTop("presets:\n  - label: '  Tighten  '\n    text: '  Cut words.  '").presets)
            .toEqual([{ label: "Tighten", text: "Cut words." }]);
    });

    it("refuses a list that is not a list", () => {

        expect(() => withTop("presets: Tighten")).toThrow(/'presets:' that is not a list/);
    });

    it("refuses an empty list - leave the key out to keep the built-in sentences", () => {

        expect(() => withTop("presets: []")).toThrow(/empty 'presets:'.*Leave the key out/);
    });

    it("refuses an entry that is not a mapping", () => {

        expect(() => withTop("presets:\n  - Tighten")).toThrow(/preset 1 is not a mapping/);
    });

    it("refuses an entry missing its label or its text", () => {

        expect(() => withTop("presets:\n  - text: Cut words.")).toThrow(/preset 1 has no 'label:'/);
        expect(() => withTop("presets:\n  - label: Tighten")).toThrow(/preset 1 has no 'text:'/);
    });

    it("refuses a label or text that is not text", () => {

        expect(() => withTop("presets:\n  - label: 7\n    text: Cut words."))
            .toThrow(/preset 1 has a 'label:' that is not text/);
    });

    it("refuses a key that is neither label nor text", () => {

        expect(() => withTop("presets:\n  - label: Tighten\n    text: Cut words.\n    id: tighten"))
            .toThrow(/preset 1 declares 'id'.*'label:' and 'text:' and nothing else/);
    });

    it("refuses two entries with the same label", () => {

        expect(() => withTop("presets:\n  - label: Tighten\n    text: A.\n  - label: Tighten\n    text: B."))
            .toThrow(/declares preset 'Tighten' twice/);
    });

    it("names the stage when the fault is on one", () => {

        expect(() => withStage("  - id: design\n    presets: []"))
            .toThrow(/stage 1 \('design'\) declares an empty 'presets:'/);
    });

    it("is refused on both gates", () => {

        expect(() => withStage("  - id: idea\n    presets:\n      - label: A\n        text: B"))
            .toThrow(/\('idea'\) is a gate and declares 'presets:'/);

        expect(() => withImplementStage("  - id: implement\n    presets:\n      - label: A\n        text: B"))
            .toThrow(/\('implement'\) is a gate and declares 'presets:'/);
    });

    it("leaves a spec variable in the text as written, for the panel to answer", () => {

        const style = withTop("presets:\n  - label: Match code\n    text: Re-read what ${{ spec.name }} touches.");

        expect(style.presets).toEqual([{ label: "Match code", text: "Re-read what ${{ spec.name }} touches." }]);

        const staged = withStage("  - id: design\n    presets:\n      - label: Here\n        text: In ${{ spec.dir }}.");

        expect(stageOf("design", staged).presets).toEqual([{ label: "Here", text: "In ${{ spec.dir }}." }]);
    });

    it("still refuses a spec variable it does not know", () => {

        expect(() => withTop("presets:\n  - label: A\n    text: ${{ spec.folder }}"))
            .toThrow(/'\$\{\{ spec.folder \}\}', which is not a spec variable/);
    });
});

/*
 * `actionable: true` on a drafting stage: its document is worked from
 * its own page, and the output gate that runs the work is implied
 * after it - never listed, never drawn.
 */
describe("an actionable stage", () => {

    function actionable(specTypes: string) {

        return parsed([
            /^specTypes:[\s\S]*$/m,
            `stages:\n  - id: tasks\n    actionable: true\nspecTypes:\n${specTypes}`
        ]);
    }

    it("implies the output gate after it, and the stage carries the mark", () => {

        const style = actionable("  - id: feature\n    label: Feature\n    stages: [requirements, design, tasks]\n");

        expect(style.specTypes[0].stages).toEqual(["idea", "requirements", "design", "tasks", "implement"]);
        expect(stageOf("tasks", style).actionable).toBe(true);
        expect(stageOf("requirements", style).actionable).toBeUndefined();

        // The gate is a real stage: its prompt is derived from the stage before it.
        const stages = pipeline(style, "feature");

        expect(isTerminal(stages[stages.length - 1])).toBe(true);
        expect(stages[stages.length - 1].instructions).toEqual({ root: "style", path: "instructions/tasks-implement.md" });
    });

    it("implies it per spec type - one that ends elsewhere ends there", () => {

        const style = actionable(
            "  - id: feature\n    label: Feature\n    stages: [requirements, tasks]\n"
            + "  - id: memo\n    label: Memo\n    stages: [requirements]\n");

        expect(style.specTypes[0].stages).toEqual(["idea", "requirements", "tasks", "implement"]);
        expect(style.specTypes[1].stages).toEqual(["idea", "requirements"]);
    });

    it("refuses listing the gate as well", () => {

        expect(() => actionable("  - id: feature\n    label: Feature\n    stages: [requirements, tasks, implement]\n"))
            .toThrow(/list one or the other/);
    });

    it("refuses an actionable stage anywhere but last", () => {

        expect(() => actionable("  - id: feature\n    label: Feature\n    stages: [requirements, tasks, design]\n"))
            .toThrow(/move it last, or drop the key/);
    });

    it("refuses two actionable stages in one pipeline", () => {

        expect(() => parsed([
            /^specTypes:[\s\S]*$/m,
            "stages:\n  - id: design\n    actionable: true\n  - id: tasks\n    actionable: true\n"
            + "specTypes:\n  - id: feature\n    label: Feature\n    stages: [requirements, design, tasks]\n"
        ])).toThrow(/One stage per pipeline starts the implementation/);
    });

    it("refuses the key on a gate, and a value that is not a boolean", () => {

        expect(() => withImplementStage("  - id: implement\n    actionable: true")).toThrow(/is a gate and declares 'actionable:'/);
        expect(() => withStage("  - id: tasks\n    actionable: yes please")).toThrow(/not true or false/);
    });

    it("reads false as unsaid", () => {

        expect(stageOf("tasks", withStage("  - id: tasks\n    actionable: false")).actionable).toBeUndefined();
    });
});

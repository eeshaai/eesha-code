import { describe, expect, it } from "vitest";
import { startsSession } from "../../model/style";
import { parseStyle } from "../../parser/parseStyle";
import { contextFor, Exists, pipelineStateOf, revisableStages } from "../pipelineState";

/**
 * The walk against a style written for these tests, not against a
 * shipped one.
 *
 * The engine has no idea which styles exist, and a test suite organised
 * by style would quietly say otherwise - and would break when a
 * built-in's wording changed for reasons that have nothing to do with
 * the rule under test. What the shipped styles do is asserted once, as
 * a fixture check, in `src/sdd/__tests__/shippedStyles.test.ts`.
 *
 * So this style is built to have the shapes the rule needs: two spec
 * types that visit different stages, a stage with both required and
 * optional output, and a terminal implement stage at the end.
 */
const style = parseStyle(`
schema: 1
id: t
name: T
desc: A style written to exercise the walk.
specTypes:
  - id: full
    label: Full
    stages: [first, middle, last, implement]
  - id: short
    label: Short
    stages: [first, last, implement]
stages:
  - id: first
    produces: [one.md]
  - id: middle
    produces: [two.md]
  - id: last
    produces: [three.md]
`, "t");

/** The listing of a spec folder holding exactly these documents. */
const contents = (...documents: string[]) => documents;

/**
 * A spec folder holding these documents, and the idea document every
 * spec has.
 *
 * The pipeline opens with the input gate, so a folder without
 * `idea.md` is a spec nobody has created rather than one part-way
 * through - which is a real state, and asserted on its own below.
 */
function folder(...documents: string[]): Exists {

    return artifact => artifact === "idea.md" || documents.includes(artifact);
}

describe("where a spec is", () => {

    it("starts at the first stage when the folder is empty", () => {

        const state = pipelineStateOf(style, "full", folder());

        expect(state.next?.id).toBe("first");
        expect(state.stages.map(stage => stage.status))
            .toEqual(["done", "next", "upcoming", "upcoming", "upcoming"]);
        expect(state.complete).toBe(false);
    });

    /*
     * Nothing at all is the input gate's own state - a spec whose
     * folder ＋ New Spec has not written yet. Every other test starts
     * after it, because every real spec does.
     */
    it("starts at the input gate when even the ask is not written down", () => {

        const state = pipelineStateOf(style, "full", () => false);

        expect(state.next?.id).toBe("idea");
        expect(state.stages[0].missing).toEqual(["idea.md"]);
    });

    /*
     * The property idea depends on: a document written outside the
     * engine satisfies its stage, and the walk picks the spec up after
     * it without ever visiting the stage that would have written it.
     */
    it("skips a stage whose document already exists", () => {

        expect(pipelineStateOf(style, "full", folder("one.md")).next?.id).toBe("middle");
    });

    it("advances as each document lands", () => {

        expect(pipelineStateOf(style, "full", folder("one.md", "two.md")).next?.id).toBe("last");
    });

    it("settles on the implement stage when every document exists, and stays there", () => {

        const state = pipelineStateOf(style, "full", folder("one.md", "two.md", "three.md"));

        expect(state.next?.id).toBe("implement");
        expect(state.implement).toBe(true);
        expect(state.complete).toBe(true);
        expect(state.stages.map(stage => stage.status)).toEqual(["done", "done", "done", "done", "next"]);
    });

    /*
     * Every drafting phase waits to be pressed and both gates act the
     * moment they are reached, so what the next stage *is* answers the
     * only question anyone asks of it.
     */
    it("says what the next stage is", () => {

        expect(startsSession(pipelineStateOf(style, "full", folder()).next!)).toBe(false);
        expect(startsSession(pipelineStateOf(style, "full", folder("one.md", "two.md", "three.md")).next!)).toBe(true);
    });
});

describe("a stage that wrote something extra", () => {

    it("is satisfied by the document it declares", () => {

        expect(pipelineStateOf(style, "full", folder("one.md", "two.md")).next?.id).toBe("last");
    });

    /*
     * A document a phase writes only sometimes is declared nowhere,
     * so it can neither satisfy a stage nor hold the pipeline waiting
     * on a file nobody was going to write. The stage is still where
     * it was, still missing what it owes.
     */
    it("is not satisfied by a file no stage declares", () => {

        const state = pipelineStateOf(style, "full", folder("one.md", "aside.md"));

        expect(state.next?.id).toBe("middle");
        expect(state.stages[2].present).toEqual([]);
        expect(state.stages[2].missing).toEqual(["two.md"]);
    });
});

describe("the spec type decides the pipeline", () => {

    it("visits only the stages its type lists", () => {

        const state = pipelineStateOf(style, "short", folder("one.md"));

        expect(state.stages.map(stage => stage.stage.id)).toEqual(["idea", "first", "last", "implement"]);
        expect(state.next?.id).toBe("last");
    });

    it("reads one folder two ways, according to the type", () => {

        const documents = folder("one.md");

        expect(pipelineStateOf(style, "full", documents).next?.id).toBe("middle");
        expect(pipelineStateOf(style, "short", documents).next?.id).toBe("last");
    });

    it("calls the same folder complete under the type that skips a stage", () => {

        expect(pipelineStateOf(style, "short", folder("one.md", "three.md")).complete).toBe(true);
        expect(pipelineStateOf(style, "full", folder("one.md", "three.md")).complete).toBe(false);
    });
});

/*
 * Adoption: point a style at a folder someone else made. Nothing here
 * is a special path - the same reading of the same rule.
 */
describe("adopting a folder", () => {

    it("resumes mid-pipeline without being told anything", () => {

        expect(pipelineStateOf(style, "full", folder("one.md", "two.md")).next?.id).toBe("last");
    });

    it("shows a later document already written behind an earlier one that is not", () => {

        const state = pipelineStateOf(style, "full", folder("one.md", "three.md"));

        expect(state.next?.id).toBe("middle");
        expect(state.stages.map(stage => stage.status)).toEqual(["done", "done", "next", "done", "upcoming"]);
        expect(state.stages[2].missing).toEqual(["two.md"]);
    });
});

describe("context", () => {

    it("gives a stage every prior document, not just the previous one", () => {

        expect(contextFor(style, "full", "last", contents("one.md", "two.md"))).toEqual(["one.md", "two.md"]);
    });

    it("gives the first stage nothing", () => {

        expect(contextFor(style, "full", "first", contents("one.md"))).toEqual([]);
    });

    it("passes what exists and skips what does not", () => {

        expect(contextFor(style, "full", "last", contents("one.md"))).toEqual(["one.md"]);
    });

    it("hands implement everything the earlier phases wrote", () => {

        expect(contextFor(style, "full", "implement", contents("one.md", "two.md", "three.md")))
            .toEqual(["one.md", "two.md", "three.md"]);
    });

    /*
     * A file nobody writes is not passed straight through: anything
     * dropped in the folder would become prompt material for every
     * phase, described as one of the spec's own documents. Reference
     * material is declared in `spec.json`, where it says what it is.
     */
    it("leaves out a file no stage writes", () => {

        expect(contextFor(style, "full", "last", contents("one.md", "two.md", "aside.md")))
            .toEqual(["one.md", "two.md"]);
    });

    it("leaves out spec.json itself", () => {

        expect(contextFor(style, "full", "last", contents("one.md", "two.md", "spec.json")))
            .toEqual(["one.md", "two.md"]);
    });

    it("omits a document written by a stage this type does not visit", () => {

        expect(contextFor(style, "short", "last", contents("one.md", "two.md"))).toEqual(["one.md"]);
    });
});

/*
 * Every phase a revise is offered on: any drafting phase that has
 * written, not only the last one - the gates have nothing to rewrite.
 */
describe("the phases a revise is offered on", () => {

    /** The same shape as the style above - the input gate is there whether or not anyone says so; this one opts into the output gate too. */
    const gated = parseStyle(`
schema: 1
id: g
name: G
desc: A style with both gates.
specTypes:
  - id: full
    label: Full
    stages: [first, middle, implement]
stages:
  - id: first
    produces: [one.md]
  - id: middle
    produces: [two.md]
`, "g");

    /** The walk sees the folder; `written` is asked separately, because an empty file is an unwritten one. */
    const offered = (...documents: string[]) =>
        revisableStages(pipelineStateOf(gated, "full", folder(...documents)).stages, one => documents.includes(one))
            .map(stage => stage.id);

    it("is nothing while only the ask has been captured", () => {

        expect(offered("idea.md")).toEqual([]);
    });

    /*
     * The input gate's document was written by ＋ New Spec, not by a
     * model - there is no phase to run again over it.
     */
    it("is never the input gate", () => {

        expect(offered("idea.md")).not.toContain("idea");
    });

    it("is the drafting phase that has written, once one has", () => {

        expect(offered("idea.md", "one.md")).toEqual(["first"]);
    });

    /* It adds the later phase once that one writes too, keeping the earlier one offered. */
    it("is offered on both once both have written", () => {

        expect(offered("idea.md", "one.md", "two.md")).toEqual(["first", "middle"]);
    });

    /*
     * `produces` is empty on a terminal stage, and every() is true of an
     * empty list - so the kind is what excludes it, not the documents.
     */
    it("is never the output gate, which has no document to rewrite", () => {

        expect(offered("idea.md", "one.md", "two.md")).not.toContain("implement");
    });

    /*
     * The chips tick on content, not existence. A ticked chip with no
     * Revise beside it - or the reverse - is the panel disagreeing with
     * itself.
     */
    it("ignores a document that exists but is empty", () => {

        const stages = pipelineStateOf(gated, "full", folder("idea.md", "one.md", "two.md")).stages;

        expect(revisableStages(stages, one => one === "one.md").map(stage => stage.id)).toEqual(["first"]);
    });
});


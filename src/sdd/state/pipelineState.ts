import { isTerminal, pipeline, Stage, startsSession, Style } from "../model/style";

/**
 * Where a spec is, worked out from the style and the folder - nothing
 * else.
 *
 * There is no state file in a spec folder: two sources of truth that
 * can disagree are worse than one, and every advance would produce a
 * merge conflict. So the folder is the state, and this module reads it.
 *
 * Deliberately pure. It takes an {@link Exists} predicate rather than a
 * path, so the rule that decides what happens next can be tested
 * without a temp directory, and the same function serves the panel,
 * the runner, and import.
 */

/** Whether an artifact of the spec folder is on disk. Paths are spec-relative, as a style declares them. */
export type Exists = (artifact: string) => boolean;

export type StageStatus =

    /** Every artifact this stage produces is present. */
    | "done"

    /** The first stage that is not done - what a user acts on. */
    | "next"

    /** After `next`. Not reachable yet, and not necessarily empty - see {@link StageState.present}. */
    | "upcoming";

export interface StageState {

    stage: Stage;

    status: StageStatus;

    /** Artifacts of this stage that exist, whether required or optional. */
    present: string[];

    /**
     * Required artifacts that do not.
     *
     * Populated on any stage, not only the current one: a folder with
     * `tasks.md` but no `design.md` is a real thing to adopt, and the
     * panel showing a later stage already done behind an earlier one
     * that is not is more honest than hiding it.
     */
    missing: string[];
}

export interface PipelineState {

    specType: string;

    /** In the spec type's order, which is the pipeline. */
    stages: StageState[];

    /**
     * The stage a user acts on now, or `undefined` when every stage is
     * satisfied - which only happens in a style whose last stage
     * produces something. A style that ends at a terminal implement stage
     * settles on `implement` and stays there.
     */
    next?: Stage;

    /** `next` is a terminal implement stage: the documents are done and the work has moved to code. */
    implement: boolean;

    /** Every stage that can be satisfied is. */
    complete: boolean;
}

/** Reads a spec folder's state against one style and spec type. */
export function pipelineStateOf(style: Style, specTypeId: string, exists: Exists): PipelineState {

    const stages = pipeline(style, specTypeId);

    const satisfied = stages.map(stage =>
        !isTerminal(stage) && stage.produces.every(artifact => exists(artifact)));

    const at = satisfied.indexOf(false);

    const states: StageState[] = stages.map((stage, index) => ({
        stage,
        status: index === at ? "next" : satisfied[index] ? "done" : "upcoming",
        present: stage.produces.filter(artifact => exists(artifact)),
        missing: stage.produces.filter(artifact => !exists(artifact))
    }));

    const next = at < 0 ? undefined : stages[at];

    return {
        specType: specTypeId,
        stages: states,
        next,
        implement: next ? isTerminal(next) : false,
        complete: at < 0 || (next !== undefined && isTerminal(next))
    };
}

/**
 * Every phase a revise is offered on: any drafting phase whose document
 * is written, not only the last one.
 *
 * Drafting only, because the other two kinds have nothing to revise:
 * no model wrote the input gate's document, and the output gate has
 * none.
 *
 * `written` rather than this module's own `exists`: an empty file is
 * an unwritten one, and the panel's chips already say so. A ticked
 * chip with no Revise beside it - or the reverse - would be the panel
 * disagreeing with itself.
 */
export function revisableStages(
    stages: StageState[],
    written: (artifact: string) => boolean
): Stage[] {

    return stages
        .filter(one => !startsSession(one.stage) && one.stage.produces.every(written))
        .map(one => one.stage);
}

/**
 * The documents a stage is handed, as spec-relative paths.
 *
 * The folder, minus what this pipeline has not written yet. Every
 * prior stage's document that is on disk, plus every file the style
 * does not know about at all - the material a `file` idea copied in,
 * a `research.md` a phase wrote because the work called for it, a
 * report somebody dropped beside the spec. That second half is why
 * optional outputs need no declaration: an undeclared file in the
 * folder still reaches the phase.
 *
 * `tasks` needs `requirements.md`, which is two stages back, so "the
 * previous stage" would be wrong in the one case that matters most.
 *
 * Paths, never contents. Clean context means a phase free of the last
 * one's circling and failed tool calls, which the session boundary
 * already gives; it never meant distrusting an agent to open a file.
 */
export function contextFor(style: Style, specTypeId: string, stageId: string, contents: string[]): string[] {

    // The pipeline's own output, up to here, and nothing else.
    //
    // A document a later stage writes is not this phase's input -
    // handing `tasks.md` back to `design` would invert the pipeline. A
    // file no stage writes at all is not this phase's input either: it is not passed through, which would mean any file dropped in the folder silently became prompt material for every phase, described
    // as one of the spec's own documents. Reference material is declared
    // in `spec.json`, where it carries a description saying what it
    // is.
    const earlier = new Set(before(style, specTypeId, stageId).flatMap(stage => stage.produces));

    return contents.filter(one => earlier.has(one));
}

/** The stages of this pipeline that come before the named one. */
function before(style: Style, specTypeId: string, stageId: string): Stage[] {

    const stages = pipeline(style, specTypeId);
    const at = stages.findIndex(stage => stage.id === stageId);

    if (at < 0)
        throw new Error(`Stage '${stageId}' is not in the '${specTypeId}' pipeline of style '${style.id}'.`);

    return stages.slice(0, at);
}

/**
 * The style model - the shape of a spec-driven process, owned by SDD
 * core rather than by the workflow engine.
 *
 * A style is not a workflow file. A phase is one AI call producing one
 * or more documents, in a fixed order, with a human between. So this
 * model has no `jobs` (a stage is one call), no `session` (the session
 * is the stage id), no `context` and no `requires` (both follow from the
 * spec type's stage order, and the walk resolves them).
 */

/** The schema version of a `style.yml` this build understands. */
export const StyleSchema = 1;

/**
 * The two ends of a pipeline - one of them universal, one of them not.
 *
 * `idea` is the input gate: it runs no model, because its document
 * holds only what the person picked. The parser adds it to every
 * Eesha style's pipeline and it is never declared - every such process
 * takes an ask in the same way, so there is nothing for a style to say
 * about it. A native style (Kiro, Spec Kit) has no `idea`: the tool's
 * own first command takes the ask in.
 *
 * `implement` is the output gate, where the work becomes code; it is
 * terminal and produces nothing. Not every process ends in code, so a
 * spec type opts in by listing `implement` itself, last in its
 * `stages:`. Left out, the pipeline ends at its last drafting phase - an
 * ordinary stage, with an ordinary document. Listed anywhere but last,
 * the file fails to load: a terminal stage after other stages would
 * make them unreachable.
 *
 * Both ids are fixed because they are the session name, the derived
 * prompt path and the per-stage settings key. A style wanting its own
 * word sets {@link Stage.label}.
 */
export const IDEA = "idea";

/** @see IDEA */
export const IMPLEMENT = "implement";

/**
 * The tools whose own spec process a style can run instead of ours.
 *
 * `kiro` - Kiro's spec mode. Each phase is a new Kiro chat in mode
 * `spec`, sent the same kind of text Kiro's own `/spec` command sends.
 *
 * `speckit` - GitHub Spec Kit. Each phase sends one of its slash
 * commands (`/speckit.plan`, ...), which the repository installed with
 * `specify init`.
 *
 * A native style has no Idea phase, attaches no instruction files, and
 * sends each stage's {@link Stage.command} as the whole message.
 */
export const NATIVE_TOOLS = ["kiro", "speckit"] as const;

export type NativeTool = typeof NATIVE_TOOLS[number];

/** A phase of the process. */
export interface Stage {

    /** Referenced by {@link SpecType.stages}, the log bucket, and the session name. */
    id: string;

    /**
     * What a person sees on the chip. Defaults to the id. Separate from
     * the id so a team can rename a phase without moving its session
     * name, prompt path and settings key.
     */
    label: string;

    /**
     * Artifacts that must all exist for the stage to be satisfied,
     * relative to the spec folder. Required on every stage except
     * `implement`, which is terminal: its work becomes code, and git is
     * its record.
     */
    produces: string[];

    /**
     * The id this stage's own numbered items are cited by - `Req` for
     * `requirements.md`'s `Req-3`, `Gap` for a gap analysis's `Gap-11`.
     *
     * Undefined is the ordinary case: a stage with no prefix still gets
     * to declare its own ids the grammar's own way, one at a time, in
     * the heading. A prefix is a style handing every phase the same
     * answer up front instead of leaving each document to invent one.
     *
     * Refused on `idea` and `implement`, neither of which writes a
     * numbered document.
     */
    prefix?: string;

    /**
     * The instructions this phase runs on - the whole prompt. Absent on
     * `idea`, and only there: nothing runs the input gate.
     */
    instructions?: StageFile;

    /**
     * Reference files this phase is handed beside its instructions - an
     * API contract, a house style guide, a glossary.
     *
     * Unlike a `context` list, these cannot be derived from the pipeline:
     * nothing but the style author can know that the design phase should
     * read `docs/api/contract.md`.
     *
     * Attached like {@link template}, not listed like a spec document:
     * a document is the pipeline's own output, and a standards file
     * listed among them would read as something a phase wrote.
     *
     * `root` is always `repo`, so the file travels in git with the style
     * that points at it. Refused on the input gate, which nothing runs.
     */
    attachments?: StageFile[];

    /**
     * The plugin args the process has an opinion about - for example,
     * that the design phase wants more reasoning than the idea phase.
     *
     * Merged per key over the plugin's defaults in `settings.json`, so a
     * stage naming only `reasoningEffort` keeps the model those set. See
     * {@link aiFor}. There is no per-stage override in settings: a team
     * that wants different values shadows the style.
     *
     * No `uses`: which plugin runs a phase is a deployment decision, and
     * `sdd.uses` makes it. Otherwise untyped, as a settings entry is: the
     * plugin declares its own input schema. The engine-owned five keys
     * are refused at parse.
     */
    ai?: Record<string, unknown>;

    /**
     * The stage whose document is worked from its own page: every
     * checkbox row gets a live box and a ▶, and the implementation the
     * output gate runs is started from there. The gate itself is added
     * by the parser after this stage and never shown - a style that
     * declares this lists no `implement` stage at all.
     *
     * Only on the last drafting stage of every spec type that visits
     * it, and never on a gate.
     */
    actionable?: boolean;

    /**
     * Starting sentences for this phase's revise box - the split button
     * beside Send in the AI Session tab. Picking one only fills the box;
     * the person reads it, edits it, presses Send, and the text goes as
     * the note of a revise pass.
     *
     * Added after the style's own {@link Style.presets}, the way
     * `attachments` merge. Declared anywhere, the built-in sentences are
     * dropped; declared nowhere, they are what the menu shows. See
     * `phase/presets.ts`.
     *
     * May read the spec variables: they are answered when the panel
     * draws the stage, not when the style is read.
     *
     * Refused on both gates. Nothing runs the input gate, and the
     * output gate writes no document, so neither has a revise.
     */
    presets?: Preset[];

    /**
     * Native styles only: the whole message a first pass of this phase
     * sends, written in `style.yml`. May read the spec variables and
     * `${{ phase.target }}`, `${{ phase.existing }}` and, on the
     * implement phase, `${{ phase.tasks }}`. Anything typed in the box
     * goes after it, as typed. Required on every stage of a native
     * style; refused on any other.
     */
    command?: string;

    /**
     * Native styles only: the message a revise pass sends, with the
     * typed note after it. Absent, a built-in sentence asking to update
     * only this phase's document is used. A note that starts with `/` is
     * a slash command and is sent alone, as typed.
     */
    revise?: string;
}

/** One entry of a `presets:` list - what the menu shows, and what it puts in the box. */
export interface Preset {

    /** The menu item. */
    label: string;

    /** What lands in the compose box when it is picked. */
    text: string;
}

/**
 * A file a stage names - its instructions, or one of its attachments -
 * and which root it is relative to. The root is resolved here so nothing
 * downstream has to guess.
 */
export interface StageFile {

    /**
     * `style` - the style folder, resolved through the scopes, so a
     * workspace copy of `instructions/design.md` shadows the shipped one.
     * The default.
     *
     * `repo` - a file in this workspace, named by the stage's
     * `instructions:`. One copy, no scope ladder.
     */
    root: "style" | "repo";

    /** Relative to that root. */
    path: string;
}

/**
 * What ＋ New Spec offers, and the pipeline each choice runs.
 *
 * The spec type owns the order. {@link Style.stages} is a pool, not a
 * sequence; a type arranges the ones it needs. A bug fix that skips
 * design is expressed here and nowhere else.
 */
export interface SpecType {

    id: string;

    /** Shown in the picker. */
    label: string;

    /** Ordered stage ids. This is the pipeline. */
    stages: string[];
}

/** A parsed, validated `style.yml`. */
export interface Style {

    schema: number;

    /** Equals the folder name - the folder is the identity, the field asserts it. */
    id: string;

    /**
     * Where the style's folder was found - built-in, workspace or
     * profile. Set by the registry, not written in the file: it decides
     * where the style's `ai:` sits against the two settings files (see
     * `aiFor`). Absent on a style parsed by hand.
     */
    from?: "builtin" | "workspace" | "profile";

    name: string;

    desc: string;

    specTypes: SpecType[];

    /** The pool. Order here means nothing; {@link SpecType.stages} is the pipeline. */
    stages: Stage[];

    /**
     * An unanswered question under `## Open Questions` stops the phase
     * after it. True unless a `style.yml` says otherwise. See
     * `documents/openQuestions.ts` for what counts as answered.
     *
     * Every drafting document is checked, not only the one being
     * approved: an unanswered question in `requirements.md` makes
     * `design.md` wrong too. The idea document is exempt (no model
     * writes it) and implement writes no document.
     *
     * A style that turns this off keeps the sections; nothing acts on
     * them.
     */
    blockOnOpenQuestions: boolean;

    /**
     * Reference files handed to every stage that runs a model, on top of
     * the stage's own {@link Stage.attachments}. Same delivery and same
     * rules (`root` is `repo`, paths are workspace-relative, spec
     * variables allowed), merged ahead of the stage's own list when a
     * phase is assembled. `idea` never reaches assembly, so it is not
     * refused there.
     */
    attachments?: Stage["attachments"];

    /**
     * The plugin args every stage of this process starts from - the
     * style-wide default, same shape and same rules as {@link
     * Stage.ai}. Merged per key underneath a stage's own `ai:`, which is
     * itself merged over the plugin's defaults in `settings.json`: three
     * layers, each overriding only the keys it names. Written once here
     * instead of copied onto every stage - the way `attachments` at this
     * level already avoids repeating a style-wide file on every stage.
     *
     * `idea` never reaches assembly, so it is not refused here; it
     * simply never applies to a stage that runs no model.
     */
    ai?: Record<string, unknown>;

    /**
     * Starting sentences for every drafting phase's revise box, ahead of
     * each stage's own {@link Stage.presets}. Same shape, same rules.
     * Written once here rather than on every stage, the way the
     * style-wide `attachments` and `ai` are.
     */
    presets?: Preset[];

    /**
     * Where this style's spec folders live, written the way
     * `sdd.specsDir` is: relative to the workspace, or absolute.
     *
     * Undefined puts them under `sdd.specsDir`, with every other
     * style's. Set, New Spec creates this style's specs here, and an
     * untagged folder found here is read by this style.
     */
    specsDir?: string;

    /**
     * Set when this style runs a tool's own spec process - see
     * {@link NATIVE_TOOLS}. Absent for an Eesha style, which runs our
     * prompts, instructions and Idea phase.
     */
    native?: NativeTool;
}

/**
 * The stage that takes the ask in. The parser adds {@link IDEA} to every
 * Eesha style. A native style has none: Kiro and Spec Kit take the ask
 * in with their own first command.
 */
export function ideaOf(style: Style): Stage | undefined {

    return style.stages.find(stage => stage.id === IDEA);
}

/**
 * The runtime and mode a native style cannot run without, read from its
 * own `ai:` with the stage's on top - the Kiro style's
 * `provider: kiro-cli-v3` and `agentMode: spec`. They beat the compose
 * box's pick (see `aiFor`). Only Kiro has one: Spec Kit's commands run
 * on whichever runtime the repository installed them for.
 */
export function lockOf(style: Style, stage?: Stage): { provider: string; agentMode?: string } | undefined {

    if (style.native !== "kiro")
        return undefined;

    const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

    const provider = text(stage?.ai?.provider) ?? text(style.ai?.provider);
    const agentMode = text(stage?.ai?.agentMode) ?? text(style.ai?.agentMode);

    return provider ? { provider, ...(agentMode ? { agentMode } : {}) } : undefined;
}

/** The input gate - the stage ＋ New Spec writes, and the only one no model runs. */
export function isIdea(stage: Stage): boolean {

    return stage.id === IDEA;
}

/** The output gate: terminal when a spec type opts into it, last in its `stages:`. */
export function isTerminal(stage: Stage): boolean {

    return stage.id === IMPLEMENT;
}

/** Whether reaching this stage starts a conversation nobody waits on. The two gates do. */
export function startsSession(stage: Stage): boolean {

    return stage.id === IDEA || stage.id === IMPLEMENT;
}

/**
 * Where a style keeps one phase's instructions - the file attached to
 * the session under the name `how`.
 *
 * Not `prompts/`: that folder holds the three whole-message files a
 * phase is run with. See `phase/phasePrompt.ts`.
 */
export const INSTRUCTIONS_DIR = "instructions";

/** What a stage runs when it names no `instructions:` of its own. */
export function instructionsFile(stageId: string): string {

    return `${INSTRUCTIONS_DIR}/${stageId}.md`;
}

/**
 * What the implement gate runs - named after the stage before it, so a
 * pipeline ending in `tasks` runs `instructions/tasks-implement.md` and
 * one ending in `stories` runs `instructions/stories-implement.md`.
 */
export function gateInstructionsFile(previous: string, stageId: string): string {

    return `${INSTRUCTIONS_DIR}/${previous}-${stageId}.md`;
}

/**
 * The stages a spec type visits, in its order, resolved against the
 * pool - and the one place the output gate's prompt is decided.
 *
 * The terminal stage's prompt depends on the stage before it: a
 * pipeline ending in `tasks` runs `instructions/tasks-implement.md`, one
 * ending in `stories` runs `instructions/stories-implement.md`. The pool
 * holds one `implement` stage shared by every spec type, so this is
 * resolved per type and copied rather than mutated.
 */
export function pipeline(style: Style, specTypeId: string): Stage[] {

    const specType = style.specTypes.find(candidate => candidate.id === specTypeId);

    if (!specType)
        throw new Error(
            `Style '${style.id}' has no spec type '${specTypeId}' - it offers ${quoted(style.specTypes.map(type => type.id))}.`);

    const stages = specType.stages.map(id => style.stages.find(stage => stage.id === id)!);
    const last = stages.length - 1;

    // An `instructions:` path written on the stage wins; nothing to derive.
    if (stages[last].instructions)
        return stages;

    return stages.map((stage, index) => index === last
        ? { ...stage, instructions: { root: "style", path: gateInstructionsFile(stages[index - 1].id, stage.id) } as StageFile }
        : stage);
}

/** Renders a list for an error message: `'a', 'b' and 'c'`. */
export function quoted(values: string[]): string {

    const quotedValues = values.map(value => `'${value}'`);

    if (quotedValues.length <= 1)
        return quotedValues.join("");

    return `${quotedValues.slice(0, -1).join(", ")} and ${quotedValues[quotedValues.length - 1]}`;
}

import * as path from "path";

import { logger } from "../../core/logging/logger";
import { AiSettings, aiFor, SddConfig } from "../config/sddConfig";
import { parseSpecJson, SPEC_FILE } from "../config/specJson";
import { workspacePath } from "../model/repoPath";
import { isIdea, isTerminal, lockOf, pipeline, quoted, Stage, StageFile, Style } from "../model/style";
import { ResolvedFile, StyleRegistry } from "../registry/StyleRegistry";
import { contextFor } from "../state/pipelineState";
import { grammarSection } from "./grammar";
import { BUILT_IN, modeFor, promptFile, render } from "./phasePrompt";
import { resolveSpecVars, specExpressionsIn } from "./specVars";
import type { TaskRun } from "../../shared/taskRun";

/**
 * Turning "this stage is next" into the request that runs it.
 *
 * A phase's inputs come from five things it does not own: the style says
 * which prompt and which contracts, the registry says whose copy of each
 * won, the config says what it runs on, the folder says which documents
 * exist, and the spec's own `spec.json` says which reference files this
 * one spec was given. No stage declares its own documents.
 *
 * The prompt is the ask. Everything else - the phase's own
 * instructions, whatever the style declared, and the spec's documents -
 * is attached as a file, never pasted in. The grammar is not attached:
 * the prompt names its path and says when to open it.
 *
 * The few paths that do reach the model are repository-relative with
 * forward slashes: the agent works in the repository, and a
 * spec-relative `design.md` is ambiguous the moment two specs are open.
 */

export interface PhaseRequest {

    stage: Stage;

    /** The whole text handed to the model. */
    prompt: string;

    /** Documents this phase must write, repository-relative. */
    targets: string[];

    /**
     * Whether the first target is the plan the implement phase reads -
     * the stage marked actionable, else the last drafting stage before
     * the output gate. The session writing it gets the `check_plan`
     * tool. False for every other document.
     */
    writesPlan: boolean;


    /** Documents to read, repository-relative - every prior stage's output that exists. */
    context: string[];

    /**
     * Every file the phase reads: its own instructions,
     * the spec documents it works from, whatever the style declared,
     * then whatever this spec's own `spec.json` declared.
     *
     * Absolute paths, because the instruction files ship with the
     * app and are nowhere near the repository the agent works in.
     */
    attachments: { path: string; name: string }[];


    /**
     * The spec documents, named and repository-relative - the same set
     * as the document half of {@link attachments}, kept for surfaces
     * that show what a phase reads without caring how it reaches the
     * model. The panel is the one that wants it.
     *
     * Keyed by the document's stem, so `requirements.md` arrives as
     * `requirements` and the prompts' own wording resolves. `current`
     * is the existing target on a redraft.
     */
    documents: Record<string, string>;

    ai: AiSettings;

    /**
     * Whose copy of the phase's instructions won - a scope, or the
     * repository when the stage named its own `instructions:`. Carried so the
     * panel can say "design prompt: yours (override)".
     */
    sources: { prompt: ResolvedFile };

    /**
     * Send {@link prompt} exactly as built - no `## Target` paragraph
     * after it. Set for a native style, whose message is the tool's own
     * command: a slash command reads everything after it as its input.
     */
    verbatim?: boolean;

    /**
     * Files this phase's session may not write, repository-relative -
     * the documents of the spec's other phases. Set for a native style:
     * Kiro's spec mode goes on to the next document by itself, and this
     * is what stops it there. Refused at the permission check, so the
     * agent is told no and the turn goes on.
     */
    refuseWrites?: string[];
}

export interface PhaseInput {

    style: Style;

    config: SddConfig;

    /** The spec folder, repository-relative. */
    specDir: string;

    specType: string;

    stageId: string;

    /**
     * Run this stage again over the document it already wrote. The phase
     * is the same; what changes is that `current` is now the point of
     * the exercise rather than an accident of the folder, and that
     * `note` carries whatever the person typed.
     */
    revise?: boolean;

    /**
     * What the human asked for on this pass, typed when Revise was
     * pressed.
     *
     * It lands inside `## The ask` and does not replace the phase's own
     * prompt, so this pass keeps the revision discipline that file
     * carries: keep the numbering, fold the answers in, leave the rest
     * alone.
     *
     * Quoted rather than pasted in. It is somebody typing into a box, so
     * it can hold a `##` heading or a `---` of its own, and pasted flat
     * those become the prompt's structure instead of the note's content.
     *
     * Empty or absent is the ordinary case - the edits in the document
     * say what to change. Recorded in the spec's history with the rest
     * of the prompt, like every other turn.
     */
    note?: string;

    /**
     * What is in the spec folder, spec-relative.
     *
     * The list rather than a predicate, because context is derived from
     * the folder rather than from declarations - a phase is handed the
     * files that are there, and the only thing a style still says about
     * them is which stage writes which.
     */
    contents: string[];

    /**
     * The spec folder as a place on disk, absolute.
     *
     * Every attachment drawn from the spec folder needs it, because an
     * attachment is a path the provider opens rather than a path the
     * agent resolves. `specDir` cannot serve, being repository-relative
     * whenever the spec root is inside the repository. See `onDisk`.
     *
     * Optional, and its absence is the same silent skip a missing file
     * gets: a caller with no disk behind it - a test, an in-memory
     * registry - assembles a phase without the spec folder's own files
     * rather than failing over them.
     */
    specPath?: string;

    /**
     * The spec's own `spec.json`, as text, when the folder has one.
     *
     * Read by the caller rather than here, because this function has no
     * disk of its own - the same reason `contents` is a list rather than
     * a predicate. Parsed and checked here, so a broken file fails where
     * the message can name the phase it stopped.
     */
    specJson?: string;

    /**
     * The tasks handed to an implement run - the rows the person
     * pressed Start on, each with the wave the plan put it in, when the
     * plan declared one.
     *
     * Only the output gate is handed any. They land in the prompt as
     * `${{ phase.tasks }}`, one row each, so the sentences around them
     * are the prompt file's and not this code's. A drafting phase has
     * none, and a prompt writing the name there is refused.
     */
    tasks?: HandedTask[];
}

/** One task handed to the implement phase, as the panel read it off the plan. */
export interface HandedTask {

    /** `1.1` - the id as the plan writes it. */
    id: string;

    text: string;

    /** The wave the plan's dependency graph put it in. Absent when the plan declared no graph. */
    wave?: number;

    /** The line the row sits on in the plan, 1-based - what the prompt cites so the agent can open it. */
    line?: number;

    /**
     * Everything written under the row in the plan - its `Files:`, its
     * citations, its notes - as the panel read it. Handed over so the
     * agent has the whole task in the prompt rather than only its title.
     */
    details?: string[];

    /**
     * The task's `- Run:` line, when it has one. Such a task is never
     * handed to an agent: the panel runs its command or workflow, or
     * waits for a person to tick it, in its place in the plan.
     */
    run?: TaskRun;

    /** The `## ` heading the task sits under - a story, a phase. Passed to a `Run:` workflow as `group`, as the row's own button does. */
    group?: string;
}

export async function assemble(input: PhaseInput, registry: StyleRegistry): Promise<PhaseRequest> {

    const { style, config, specDir, specType, stageId } = input;

    const stages = pipeline(style, specType);

    const found = stages.find(candidate => candidate.id === stageId);

    if (!found)
        throw new Error(`Stage '${stageId}' is not in the '${specType}' pipeline of style '${style.id}'.`);

    // The plan: the stage marked actionable, else the one the output
    // gate reads - directly before it.
    const planStage = stages.find(candidate => candidate.actionable)
        ?? (isTerminal(stages[stages.length - 1]) ? stages[stages.length - 2] : undefined);

    const writesPlan = planStage?.id === stageId;

    // A tool's own process: its own words, nothing attached.
    if (style.native)
        return nativeRequest(input, found, stages, planStage);

    // The style's own attachments, ahead of the stage's - general
    // reference before what this one phase asked for. Merged here rather
    // than carried alongside so everything below treats the two lists as
    // one and does not have to know a style-wide list exists at all.
    const merged = [...(style.attachments ?? []), ...(found.attachments ?? [])];
    const declared = merged.length ? { ...found, attachments: merged } : found;

    // The stage as this spec makes it. A style is parsed once and run
    // for every spec, so the three keys a phase reads may hold
    // `${{ spec.… }}` that nothing else could answer - see
    // `specVars`. Everything below works on the result, because a path
    // still holding an expression is a path to a file nobody has.
    const stage = withSpec(declared, input, registry.workspaceFolder, style.id);

    // The input gate has no prompt because nothing runs it - its
    // document is written by ＋ New Spec. Reaching here means a surface
    // offered to run it, which is a mistake worth naming rather than a
    // missing-prompt error three frames down.
    if (isIdea(stage) || !stage.instructions)
        throw new Error(
            `Stage '${stageId}' of style '${style.id}' is the input gate - it runs no model, so there is `
            + "nothing to assemble. Its document is written when the spec is created, and edited by hand after.");

    // A revise rewrites what the phase already wrote, so there has to be
    // something there. The panel offers it only where there is, which
    // makes reaching here a bug worth naming.
    if (input.revise && !stage.produces.some(one => input.contents.includes(one)))
        throw new Error(
            `Stage '${stageId}' of style '${style.id}' has not written ${quoted(stage.produces)} yet, so `
            + "there is nothing to revise. A first pass runs the phase itself.");

    // A note is an instruction about a document that exists. On a first
    // pass it would be an ask nobody could act on, silently dropped - so
    // it is named here instead.
    if (input.note?.trim() && !input.revise)
        throw new Error(
            `Stage '${stageId}' of style '${style.id}' was given a revision note on a first pass. `
            + "There is no document to change yet, so the note has nothing to be about.");

    const prompt = await require_(registry, style.id, stage.instructions, stageId);

    // What this one spec was given, on top of what the style gives every
    // spec. Resolved before the documents so a broken `spec.json` fails
    // before anything else is built.
    const given = await specAttachments(input, registry);

    // Spec-relative, which is what an attachment's path is built from.
    // A file the spec declared is taken out, so a knowledge file sitting
    // in the spec folder is not also listed as one of the pipeline's own
    // documents - the same file named twice in one prompt is two files
    // to a reader, under two different descriptions.
    const declaredHere = new Set(given.map(one => one.path));

    const reading = contextFor(style, specType, stageId, input.contents)
        .filter(one => !declaredHere.has(onDisk(input, specDir, one)));

    const context = reading.map(one => join(specDir, one));

    const targets = stage.produces.map(one => join(specDir, one));

    const documents: Record<string, string> = {};

    for (const document of context)
        documents[stem(document)] = document;

    // The document being rewritten, when there is one. Named `current`
    // because that is what the revise prompts call it, and it must be
    // the file as it stands - a human's edits since the last draft are
    // decisions, not drafts.
    const existing = stage.produces.find(one => input.contents.includes(one));

    if (existing)
        documents.current = join(specDir, existing);

    // Every attachment a stage or a style declared is on disk before
    // anything is built from it.
    await requireAttachments(registry, style.id, stageId, stage.attachments ?? []);

    // The spec's own documents, and the one being rewritten kept apart
    // from them. A frame names `current` on its own line - on a second
    // pass it is the subject rather than an input - so it is not one of
    // the rows `${{ documents }}` renders.
    const rewriting_ = existing
        ? [{ name: "current", path: onDisk(input, specDir, existing) }]
        : [];

    const specDocuments: Attachment[] = reading.map(one =>
        ({ name: stem(one), path: onDisk(input, specDir, one) }));

    // Reference material, in one list: the style's and the stage's
    // first, then whatever this spec declared for itself. General before
    // specific, and a spec's own `desc` is the only clause here written
    // by somebody who knows what the file holds.
    const references: Attachment[] = [
        ...await instructionFiles(registry, style.id,
            (stage.attachments ?? []).map(one => [stem(one.path), one] as Named)),
        ...given
    ];

    // Everything the phase reads, in one list and in reading order.
    //
    // `how`, the phase's own instructions, leads. Then
    // this spec's documents, `current` first where there is one.
    // Reference material comes last: read before the instruction it is a
    // file with no question attached to it.
    //
    // The order here is the order the provider is handed them. What the
    // prompt *says* about them is the frame's, and a frame that drops a
    // row does not drop the attachment.
    const attachments = [
        ...await instructionFiles(registry, style.id, [["how", stage.instructions]]),
        ...rewriting_,
        ...specDocuments,
        ...references
    ];

    return {
        stage,
        // The grammar is named under the prompt rather than attached -
        // see `grammarSection`.
        prompt: await text(input, stage, registry, specDocuments, references)
            + grammarSection(registry.grammarPath()),
        targets,
        writesPlan,
        context,

        // `desc` is the prompt's business and nobody else's. The plugin
        // is handed a path and a name; a third key would travel down to
        // a provider that has no field for it.
        attachments: attachments.map(({ name, path }) => ({ name, path })),
        documents,
        ai: aiFor(config, style.ai, stage.ai, style.from),
        sources: { prompt }
    };
}

/**
 * A native style's phase: the stage's own `command:` (or `revise:`),
 * with whatever was typed after it, and nothing attached.
 *
 * Kiro's spec mode and Spec Kit's commands carry their own
 * instructions and know where their documents are, so the Eesha prompt
 * files, the instruction file and the grammar would only argue with
 * them. What stays the same: one new chat per phase, the documents the
 * phase must write, and the human between phases.
 *
 * A note is allowed on a first pass here, unlike an Eesha phase: it is
 * how New spec hands Kiro the description, the way `/spec new X` takes
 * its text. A note that starts with `/` is a slash command - Spec Kit's
 * `/speckit.clarify` from the revise box - and is sent alone.
 */
async function nativeRequest(
    input: PhaseInput,
    found: Stage,
    stages: Stage[],
    planStage: Stage | undefined
): Promise<PhaseRequest> {

    const { style, config, specDir, stageId } = input;

    const stage = withSpec(found, input, undefined, style.id);

    const exists = stage.produces.find(one => input.contents.includes(one));

    if (input.revise && !exists)
        throw new Error(
            `Stage '${stageId}' of style '${style.id}' has not written ${quoted(stage.produces)} yet, so `
            + "there is nothing to revise. A first pass runs the phase itself.");

    const note = input.note?.trim();

    // Every stage's documents that are on disk, in pipeline order - what
    // Kiro's own command lists, and what the panel shows as read.
    const documents: string[] = [];

    for (const one of stages)
        for (const file of one.produces)
            if (input.contents.includes(file) && !documents.includes(file))
                documents.push(file);

    const reading = documents.filter(file => !stage.produces.includes(file));

    const template = input.revise ? stage.revise ?? NATIVE_REVISE : stage.command!;

    const where = input.revise
        ? stage.revise ? `stage '${stageId}' revise: in style '${style.id}'` : "the built-in revise text"
        : `stage '${stageId}' command: in style '${style.id}'`;

    const rendered = render(
        template,
        { specDir, specPath: input.specPath, specType: input.specType, stageId },
        {
            target: named(stage),
            documents: documentRows([]),
            references: referenceRows([]),
            existing: documents.length ? documents.join(", ") : "none",
            prefix: stage.prefix,
            tasks: input.tasks?.length ? taskRows(input.tasks) : undefined
        },
        where,
        config.variables).trimEnd();

    const prompt = note?.startsWith("/")
        ? note
        : note ? `${rendered}

${note}` : rendered;

    const terminal = isTerminal(stage);

    // Every other phase's document. On the implement phase the plan is
    // left writable: Kiro ticks its own boxes.
    const refuse = stages
        .filter(one => one.id !== stage.id && !(terminal && one.id === planStage?.id))
        .flatMap(one => one.produces)
        .filter(file => !stage.produces.includes(file))
        .map(file => join(specDir, file));

    const context = reading.map(file => join(specDir, file));

    const documentMap: Record<string, string> = {};

    for (const file of context)
        documentMap[stem(file)] = file;

    if (exists)
        documentMap.current = join(specDir, exists);

    return {
        stage,
        prompt: `${prompt}
`,
        targets: stage.produces.map(file => join(specDir, file)),
        writesPlan: false,
        context,
        attachments: [],
        documents: documentMap,
        ai: aiFor(config, style.ai, stage.ai, style.from, lockOf(style, stage)),
        sources: { prompt: { text: template, scope: style.from ?? "builtin" } },
        verbatim: true,
        ...(refuse.length ? { refuseWrites: [...new Set(refuse)] } : {})
    };
}

/**
 * What a native revise sends when the stage wrote no `revise:` of its
 * own. The typed note goes after it.
 */
const NATIVE_REVISE = 'Update ${{ phase.target }} of the "${{ spec.name }}" spec. Read it again as it is now - '
    + "I may have edited it by hand - and change only that document, as asked below. Do not write or change "
    + "any other document of this spec, and stop when it is done.";

/**
 * The stage with its `${{ spec.… }}` answered.
 *
 * Three keys, and only three - `instructions:`, `attachments:` and `ai:`.
 * They are the ones read from here, which is the first moment a spec
 * exists to have values; every other key was consumed before it. The
 * parser refuses an expression anywhere else (see `checkSpecPlacement`),
 * so this is the enforcement's other half rather than a second guess at
 * it.
 *
 * The repository rule is applied a second time, and has to be. The
 * parser held what was written to "inside this repository", but half of
 * `${{ spec.path }}/api.md` did not exist then - and a spec root
 * configured outside the workspace makes that path land outside it. The
 * same `workspacePath` runs again over the real path, which is also what
 * folds an absolute one back to the repository-relative form everything
 * downstream expects.
 *
 * Untouched, object and all, when the stage writes no expression. That
 * is the overwhelming case, and it must not depend on a workspace being
 * open or a spec folder being on disk.
 */
function withSpec(
    stage: Stage,
    input: PhaseInput,
    workspaceFolder: string | undefined,
    styleId: string
): Stage {

    if (!specExpressionsIn([stage.instructions, stage.attachments, stage.ai]).length)
        return stage;

    const where = `Stage '${stage.id}' of style '${styleId}'`;

    const facts = {
        specDir: input.specDir,
        specPath: input.specPath,
        specType: input.specType,
        stageId: input.stageId
    };

    const file = (declared: StageFile, key: string): StageFile => {

        const resolved = resolveSpecVars(declared.path, facts, where);

        // Only the repository's own. A `style` root is relative to the
        // style folder, which is not the workspace and may not even be
        // in it - holding it to the repository rule would refuse a
        // shipped style's own prompt.
        return {
            ...declared,
            path: declared.root === "repo"
                ? workspacePath(resolved, where, key, workspaceFolder)
                : resolved
        };
    };

    return {
        ...stage,
        instructions: stage.instructions && file(stage.instructions, "instructions"),
        attachments: stage.attachments?.map(one => file(one, "attachments")),
        ai: stage.ai && resolveSpecVars(stage.ai, facts, where)
    };
}

/**
 * A spec document as a place on disk - what an attachment needs.
 *
 * Absolute wherever the caller knows where the spec folder is, which is
 * every caller that has a disk behind it: `SddCore` passes `specPath` on
 * every phase it assembles.
 *
 * Repository-relative when it does not, rather than dropped. A caller
 * with no disk is a test or an in-memory registry, and those paths still
 * resolve against the working directory, which is the repository.
 */
function onDisk(input: PhaseInput, specDir: string, file: string): string {

    return input.specPath ? path.join(input.specPath, file) : join(specDir, file);
}

/**
 * The reference files this one spec declared, as attachments.
 *
 * A bare name is a file in the spec folder; anything else is relative to
 * the workspace root, so a document the repository already owns is
 * pointed at rather than copied into every spec that reads it.
 *
 * A file that is not there is skipped and logged, not thrown. A spec
 * that names a file it does not have yet is a spec in progress, and
 * stopping the phase over it would make `spec.json` a thing to be afraid
 * of. The log line is how the person finds out, because the alternative
 * is a phase that quietly ran without the contract it was pointed at.
 *
 * The names are the file stems, and the clause each carries is the
 * author's own `desc` - nothing here could say what `contract.md` is.
 */
async function specAttachments(
    input: PhaseInput,
    registry: StyleRegistry
): Promise<Attachment[]> {

    if (!input.specJson?.trim())
        return [];

    const declared = parseSpecJson(input.specJson).attachments;

    const found: Attachment[] = [];

    for (const one of declared) {

        const missing = (why: string) =>
            logger.warning(
                `${SPEC_FILE} in '${input.specDir}' attaches '${one.file}', ${why}. `
                + `Stage '${input.stageId}' runs without it.`);

        // A bare name is the spec's own file, and `contents` already says
        // what the folder holds - no second look at the disk.
        if (!one.file.includes("/")) {

            if (!input.specPath)
                continue;

            if (!input.contents.includes(one.file)) {
                missing("which is not in the spec folder");
                continue;
            }

            found.push({ name: stem(one.file), path: path.join(input.specPath, one.file), desc: one.desc });
            continue;
        }

        const path_ = registry.templatePath(one.file);

        if (!path_ || await registry.template(one.file) === undefined) {
            missing("which is not in the workspace");
            continue;
        }

        found.push({ name: stem(one.file), path: path_, desc: one.desc });
    }

    return found;
}

/**
 * The phase's instruction files, as attachments.
 *
 * A style's own prompt is resolved through the registry so an overriding
 * copy wins the path as well as the text - attaching a built-in that a
 * workspace file shadows would run the phase on instructions nobody
 * could find. A repository's own is not the registry's to resolve by
 * precedence: there is one copy, and the stage named where it is.
 *
 * Skipped silently when the file access has no paths to give, which is
 * an in-memory registry in a test rather than anything a user meets.
 */
async function instructionFiles(
    registry: StyleRegistry,
    styleId: string,
    named: Named[]
): Promise<{ name: string; path: string }[]> {

    const files: { name: string; path: string }[] = [];

    for (const [name, template] of named) {

        const resolved = !template
            ? undefined
            : template.root === "repo"
                ? registry.templatePath(template.path)
                : await registry.pathOf(styleId, template.path);

        if (resolved)
            files.push({ name, path: resolved });
    }

    return files;
}

/** An attachment as the stage declared it, under the name the prompt will call it. */
type Named = [string, StageFile | undefined];

/**
 * One file on its way to the model, while the prompt is still being
 * built.
 *
 * `desc` is here and not on {@link PhaseRequest.attachments} because it
 * is wording: only `spec.json` can supply it, and only the prompt's
 * `## Attached` list reads it.
 */
interface Attachment {

    name: string;

    path: string;

    desc?: string;
}

/**
 * Every file a phase attached - the stage's own and the style's - is on
 * disk, or the error naming the one that is not.
 *
 * Fatal, and deliberately unlike the silent skip above it. That skip
 * costs nothing, because a phase without its instruction file fails on
 * the next line anyway. A missing attachment fails nowhere: the phase
 * runs, writes a plausible document, and the team that pointed at their
 * API contract never learns the model was not shown it.
 *
 * `templatePath` builds a path without touching the disk, so existence
 * is a separate question and this is where it gets asked.
 */
async function requireAttachments(
    registry: StyleRegistry,
    styleId: string,
    stageId: string,
    declared: StageFile[]
): Promise<void> {

    for (const one of declared)
        if (await registry.template(one.path) === undefined)
            throw new Error(
                `Stage '${stageId}' of style '${styleId}' attaches '${one.path}', which is not in the `
                + "repository. Add the file, or drop it from the stage's 'attachments:' or the style's own.");
}

/**
 * The prompt, written from the frame this pass runs.
 *
 * There is no assembly here beyond substitution. Which sentences appear,
 * in what order and under which headings is the frame file's business
 * and nothing else's - see `phasePrompt.ts`. What this builds is what a file
 * cannot know: which pass this is, what the phase writes, which of the
 * spec's documents it was handed, and which reference files came with
 * them.
 *
 * The style's own frame wins where it has one, resolved through the same
 * scopes as its prompts, so a repository can reword the wrapper for one
 * style without touching the others.
 *
 * `## Target` is appended after all of it by the plugin
 * ({@link withTarget} in `ai@1`), naming the full path and the working
 * directory it is relative to. A frame names the file and nothing about
 * where it lives: a third spelling of the location would be one more
 * thing that can disagree with the two that matter.
 */
async function text(
    input: PhaseInput,
    stage: Stage,
    registry: StyleRegistry,
    documents: Attachment[],
    references: Attachment[]
): Promise<string> {

    const mode = modeFor(rewriting(input, stage), input.note, isTerminal(stage));

    const file = promptFile(mode);

    // A style's own copy wherever it has one, this repository's
    // otherwise. The fallback is text rather than a file because a
    // style is free to carry no frames at all - most will.
    const own = await registry.file(input.style.id, file);

    const template = own?.text ?? BUILT_IN[mode];

    // A stage citing its items as `REQ-<n>` and a frame that never
    // says so is the silent half of a feature: the panel parses
    // citations by the prefix, and the model was never asked to write
    // any. Named here rather than discovered in a document.
    if (stage.prefix && !template.includes(`\${{ phase.prefix }}`))
        throw new Error(
            `Stage '${stage.id}' of style '${input.style.id}' declares 'prefix: ${stage.prefix}', but `
            + `'${file}' never writes '\${{ phase.prefix }}'. The prompt would not tell the phase which `
            + "prefix to cite, and the panel reads documents expecting it. Say it in the frame, or drop "
            + "the key.");

    return render(
        template,
        {
            specDir: input.specDir,
            specPath: input.specPath,
            specType: input.specType,
            stageId: stage.id
        },
        {
            target: named(stage),
            documents: documentRows(documents),
            references: referenceRows(references),
            existing: documents.length ? documents.map(one => path.basename(one.path)).join(", ") : "none",
            prefix: stage.prefix,

            // Absent rather than empty, so a frame writing the name on a
            // pass with no note is told about it rather than rendering a
            // paragraph about an instruction nobody gave.
            note: input.note?.trim() ? blockquote(input.note.trim()) : undefined,

            // Same rule: absent unless this run was handed any, so the
            // implement prompt is told when it has no tasks rather than
            // rendering a heading over nothing.
            tasks: input.tasks?.length ? taskRows(input.tasks) : undefined
        },
        own ? `${input.style.id}'s own ${file}` : file,
        input.config.variables);
}

/**
 * The spec's own documents as attachment rows.
 *
 * The clause is the document's name, because that is the whole of what
 * this layer knows - it is the requirements, or the design. Saying more
 * would be inventing meaning for a style's own filenames.
 */
function documentRows(documents: Attachment[]): string {

    return rows(
        documents.map(one => `- **${one.name}** - the spec's ${one.name}.`),
        "no documents from an earlier phase.");
}

/**
 * The reference files as attachment rows.
 *
 * A spec's own `desc` wins outright: it is the only clause here written
 * by somebody who knows what the file holds. Nothing else here can say
 * what `api-contract.md` is for. What it can say is the one thing true
 * of all of them - it is here to be read, not to be written.
 */
function referenceRows(references: Attachment[]): string {

    return rows(
        references.map(one =>
            `- **${one.name}** - ${one.desc ?? "reference for this phase. Read it; you do not write it."}`),
        "no reference files for this phase.");
}

/**
 * A group of attachment rows, or one row saying there are none.
 *
 * Never nothing. A list that just stops where a group was expected reads
 * as a prompt that failed to render - a paste that did not take, a
 * variable nobody answered - and the model has no way to tell that from
 * a spec that genuinely has no references. Said outright, there is
 * nothing to wonder about.
 *
 * A row rather than a bare word, because this always lands where rows
 * go: a line of prose in the middle of a bullet list ends the list. And
 * it says which group is empty, because both groups render into one flat
 * list - a lone `- None` at the end of it reads as a fourth file with an
 * odd name.
 *
 * @param empty what there is none of, as the clause beside `None`.
 */
function rows(lines: string[], empty: string): string {

    return lines.length ? lines.join("\n") : `- **None** - ${empty}`;
}

/**
 * What this phase writes, in backticks - the way the rest of the prompt
 * names a file. `quoted` is for error messages, and the two spellings
 * sitting a few lines apart in one prompt read as two different things.
 */
function named(stage: Stage): string | undefined {

    const files = stage.produces.map(one => `\`${one}\``);

    // Absent rather than empty for the output gate, which writes no
    // document: a prompt writing `${{ phase.target }}` there would
    // render "Write ." and nobody would be told.
    if (files.length === 0)
        return undefined;

    return files.length === 1 ? files[0] : `${files.slice(0, -1).join(", ")} and ${files[files.length - 1]}`;
}

/**
 * The handed tasks as rows - `- 1.1 Title (wave 0) - plan line 12`,
 * each with its own detail lines indented under it.
 *
 * The wave goes on the row, not in a sentence: the prompt file says
 * once what a wave means, and a row either names one or does not. A
 * plan with no dependency graph hands rows with no wave, and the file's
 * own words cover that case too.
 *
 * The details are the plan's, verbatim - the `Files:` line, the
 * citations, any note - so the task the agent reads here is the whole
 * task, and the line number is where to look in the plan for anything
 * around it.
 */
function taskRows(tasks: HandedTask[]): string {

    return tasks
        .map(task => {

            const head = `- ${task.id} ${task.text}`
                + (task.wave === undefined ? "" : ` (wave ${task.wave})`)
                + (task.line === undefined ? "" : ` - plan line ${task.line}`);

            const details = (task.details ?? [])
                .map(line => line.trim() ? `    ${line}` : "")
                .join("\n");

            return details ? `${head}\n${details}` : head;
        })
        .join("\n");
}

/** Whether the document this phase writes is already on disk. */
function rewriting(input: PhaseInput, stage: Stage): boolean {

    return stage.produces.some(one => input.contents.includes(one));
}

/**
 * The note, quoted.
 *
 * Somebody typing into a box can type a `##` heading or a `---`, and
 * pasted flat those stop being the note's content and become the
 * prompt's structure - a rule that closes a section early, a heading
 * that reads as the frame's own.
 */
function blockquote(note: string): string {

    return note.split(/\r?\n/).map(line => line.trim() ? `> ${line}` : ">").join("\n");
}

/**
 * The phase's instructions, wherever they were meant to come from.
 *
 * Fatal rather than skipped, either way: a phase missing its
 * instructions would still run, and would write a document from the
 * grammar alone. That is worse than not running, because the result
 * looks like output.
 *
 * The two messages differ because the fixes do. A missing style prompt
 * is a broken style; a missing `instructions:` file is a file this repository
 * said it owned and does not have.
 */
async function require_(
    registry: StyleRegistry,
    styleId: string,
    named: StageFile,
    stageId: string
): Promise<ResolvedFile> {

    const where = `Stage '${stageId}' of style '${styleId}'`;

    if (named.root === "repo") {

        const owned = await registry.template(named.path);

        if (!owned)
            throw new Error(
                `${where} names 'instructions: ${named.path}', which is not in the repository. Add the `
                + "file, or remove the key to run the style's own instructions for this phase.");

        return owned;
    }

    const resolved = await registry.file(styleId, named.path);

    if (!resolved)
        throw new Error(
            `${where} names '${named.path}', which is not in the style folder or any scope above it.`);

    return resolved;
}

/** `specs/one/data-model.md` becomes `data-model` - the name the prompts use. */
function stem(document: string): string {

    return document.split("/").pop()!.replace(/\.[^.]+$/, "");
}

/** Repository-relative, forward slashes - what a path reaching the model looks like. */
function join(specDir: string, artifact: string): string {

    const dir = specDir.replace(/\\/g, "/").replace(/\/+$/, "");

    return dir ? `${dir}/${artifact}` : artifact;
}

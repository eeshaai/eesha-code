import { parse } from "yaml";

import { checkProviderBlocks, PROVIDERS_KEY } from "../../core/agent/providerBlocks";
import { ConfigTemplating, resolveConfigValue } from "../../core/templating/configScope";
import { expressionsIn } from "../../core/templating/TemplateResolver";
import { refuseEngineArgs } from "../config/sddConfig";
import { workspacePath } from "../model/repoPath";
import {
    IMPLEMENT, instructionsFile, IDEA, NATIVE_TOOLS, NativeTool, Preset, quoted, Stage, Style, StyleSchema
} from "../model/style";
import { checkSpecNames, checkSpecPlacement, SPEC_NAMESPACE } from "../phase/specVars";

/**
 * Reads a `style.yml` into a {@link Style}. Every built-in style is
 * parsed through this same function, so a user's style and a shipped
 * one run identical code.
 *
 * Validation is strict about what would fail later and quietly - a
 * spec type naming a stage that does not exist, a pipeline that can
 * never reach its end - and says nothing about taste.
 *
 * @param folder The style folder's name. The `id:` field must equal it,
 * because resolution is by folder.
 *
 * @param templating What `${{ }}` in the file resolves against. Omitted
 * by a caller with no workspace (a test with an in-memory registry),
 * and then an expression in the file is refused.
 */
export function parseStyle(text: string, folder: string, templating?: ConfigTemplating): Style {

    // Resolved before any key is read, so every validator sees the text
    // the style meant. `spec` is left as written: a style is read once
    // for every spec, and `assemble` answers it. See `specVars`.
    const source = resolveConfigValue(
        readYaml(text, folder), `style '${folder}'`, templating ?? {}, [SPEC_NAMESPACE, PHASE_NAMESPACE]);

    // `${{ phase.… }}` is answered when the message is built, and only
    // a native stage's own message is built from this file.
    checkPhasePlacement(source, folder);

    checkSchema(source.schema, folder);

    // Names are checked now so a typo is reported against this file
    // rather than by the phase it would break. Placement is checked
    // because a spec variable outside the keys `assemble` reads would
    // stay literal text with no error.
    checkSpecNames(source, `Style '${folder}'`);
    checkSpecPlacement(withoutStageKeys(source), `Style '${folder}'`);

    const id = required(source.id, "id", folder);

    if (id !== folder)
        throw new Error(
            `Style folder '${folder}' declares 'id: ${id}'. The folder is the identity - rename one to match the other.`);

    // Read first: a native style follows different rules for almost
    // every key below.
    const native = parseNative(source.native, folder);

    // Spec types first: they say which stages exist. `stages:` holds
    // only what differs from the default.
    const pool = parsePool(source.stages, id, templating?.workspaceFolder, native);
    const shapes = withImpliedGate(parseSpecTypeShapes(source.specTypes, id), pool, id);
    const stages = materialize(pool, stageOrder(shapes, native), id, native);

    // Nothing else a native style sends: a stage with no command would
    // have no message at all.
    if (native) {

        const silent = stages.filter(stage => !stage.command).map(stage => stage.id);

        if (silent.length)
            throw new Error(
                `Style '${id}' is 'native: ${native}' and ${quoted(silent)} `
                + `${silent.length === 1 ? "has" : "have"} no 'command:'. A native stage sends its command `
                + "as the whole message, so every stage needs one.");

        if (source.attachments !== undefined && source.attachments !== null)
            throw new Error(
                `Style '${id}' is 'native: ${native}' and declares 'attachments:'. A native phase sends `
                + "only its command, so nothing would open them. Remove them.");
    }

    return {
        schema: StyleSchema,
        id,
        name: required(source.name, "name", folder),
        desc: required(source.desc, "desc", folder),

        // `idea` is added here so everything downstream sees the whole
        // pipeline in order - on an Eesha style only, since a native
        // tool takes the ask in with its own first command. `implement`
        // is not added - a spec type opts into it by listing it itself,
        // last (checked below), and one that never named it simply ends
        // at its last drafting phase.
        specTypes: native ? shapes : shapes.map(shape => ({ ...shape, stages: [IDEA, ...shape.stages] })),

        stages,

        // Default true, so a style that never heard of the key still
        // gets the gate.
        blockOnOpenQuestions: bool(source.blockOnOpenQuestions, "blockOnOpenQuestions", folder, true),

        // For every stage - see Style.attachments. No `idea` refusal
        // here, since this key is not about one stage.
        attachments: source.attachments !== undefined && source.attachments !== null
            ? parseAttachmentList(source.attachments, `Style '${folder}'`, templating?.workspaceFolder)
            : undefined,

        // The style-wide default every stage's own `ai:` sits on top of
        // - see `Style.ai`. Same validation as a stage's, minus the
        // idea refusal: this key is not about one stage, so there is
        // nothing to check it against.
        ai: source.ai !== undefined && source.ai !== null
            ? parseAi(source.ai, `Style '${folder}'`)
            : undefined,

        // Ahead of every stage's own - see Style.presets. No gate
        // refusal here either: this key is not about one stage.
        presets: source.presets !== undefined && source.presets !== null
            ? parsePresets(source.presets, `Style '${folder}'`)
            : undefined,

        // Written the way `sdd.specsDir` is, so no path rule beyond
        // being text - see Style.specsDir.
        specsDir: source.specsDir !== undefined && source.specsDir !== null
            ? required(source.specsDir, "specsDir", `Style '${folder}'`)
            : undefined,

        ...(native ? { native } : {})
    };
}

/** `native:`, when written - one of {@link NATIVE_TOOLS}. */
function parseNative(value: unknown, folder: string): NativeTool | undefined {

    if (value === undefined || value === null)
        return undefined;

    if (typeof value !== "string" || !NATIVE_TOOLS.includes(value as NativeTool))
        throw new Error(
            `Style '${folder}' has 'native: ${String(value)}'. It is one of ${quoted([...NATIVE_TOOLS])}, `
            + "or left out for a style that runs Eesha's own prompts.");

    return value as NativeTool;
}

/** The YAML itself, with a failure that names the file rather than the line noise. */
function readYaml(text: string, folder: string): any {

    let source: unknown;

    try {

        source = parse(text);

    } catch (error) {

        throw new Error(`Style '${folder}' is not valid YAML: ${(error as Error).message}`);
    }

    if (!source || typeof source !== "object" || Array.isArray(source))
        throw new Error(`Style '${folder}' is empty - a style.yml declares at least 'schema', 'id', 'stages' and 'specTypes'.`);

    return source;
}

/**
 * The version gate. Local to SDD core rather than an entry in the
 * engine's `SchemaVersions` table, because the style schema and the
 * workflow schema move independently.
 */
function checkSchema(value: unknown, folder: string): void {

    if (value === undefined || value === null)
        throw new Error(`Style '${folder}' must declare 'schema: ${StyleSchema}' as its first line.`);

    if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
        throw new Error(`Style '${folder}' has an invalid schema '${String(value)}' - expected the whole number ${StyleSchema}.`);

    if (value > StyleSchema)
        throw new Error(
            `Style '${folder}' declares schema ${value} and was written by a newer version of Eesha Code - update to read it.`);
}

/** A stage entry as written: an id, plus only what differs from the default. */
interface StageOverride extends Partial<Stage> {

    id: string;
}

/**
 * The stage entries a style wrote. `stages:` holds exceptions, not the
 * pipeline: a stage's id already says it writes `<id>.md` and runs
 * `instructions/<id>.md`, so this list is optional and usually absent.
 */
function parsePool(
    source: unknown,
    styleId: string,
    workspaceFolder: string | undefined,
    native: NativeTool | undefined
): Map<string, StageOverride> {

    if (source === undefined || source === null)
        return new Map();

    if (!Array.isArray(source))
        throw new Error(
            `Style '${styleId}' has a 'stages:' that is not a list. It holds one entry per stage that `
            + "differs from the default, and may be left out entirely.");

    const pool = new Map<string, StageOverride>();

    source.forEach((entry, index) => {

        const stage = parseOverride(entry, styleId, index, workspaceFolder, native);

        if (pool.has(stage.id))
            throw new Error(
                `Style '${styleId}' declares stage '${stage.id}' twice. Stage ids name sessions and format `
                + "entries, so they must be unique.");

        pool.set(stage.id, stage);
    });

    return pool;
}

function parseOverride(
    source: any,
    styleId: string,
    index: number,
    workspaceFolder: string | undefined,
    native: NativeTool | undefined
): StageOverride {

    const where = `Style '${styleId}' stage ${index + 1}`;

    if (!source || typeof source !== "object")
        throw new Error(`${where} is not a mapping.`);

    const id = required(source.id, "id", where);
    const named = `${where} ('${id}')`;

    const stage: StageOverride = { id };

    if (source.label !== undefined && source.label !== null)
        stage.label = required(source.label, "label", named);

    for (const key of ["command", "revise"] as const) {

        if (source[key] === undefined || source[key] === null)
            continue;

        // An Eesha phase sends a prompt file with the instructions
        // attached. A message of the stage's own would replace all of it.
        if (!native)
            throw new Error(
                `${named} declares '${key}:', which only a native style sends (one with 'native: kiro' or `
                + "'native: speckit'). An Eesha style's phases send its prompts/ files. Remove it.");

        stage[key] = required(source[key], key, named);
    }

    // A native phase sends its command and nothing else, so nothing
    // would ever read these.
    if (native)
        for (const key of ["instructions", "attachments"] as const)
            if (source[key] !== undefined && source[key] !== null)
                throw new Error(
                    `${named} declares '${key}:', but style '${styleId}' is 'native: ${native}'. A native `
                    + "phase sends only its 'command:', so nothing would open it. Remove it.");

    if (source.prefix !== undefined && source.prefix !== null) {

        // Neither gate writes a numbered document - the same reason
        // `produces` is refused on the output gate, and `instructions` is
        // refused on the input gate.
        if (id === IDEA || id === IMPLEMENT)
            throw new Error(
                `${named} is a gate and declares 'prefix:'. Gates write no numbered document, so there is `
                + "nothing for a citation prefix to name. Remove it.");

        const prefix = required(source.prefix, "prefix", named);

        if (!/^[A-Z][A-Za-z0-9]*$/.test(prefix))
            throw new Error(
                `${named} declares 'prefix: ${prefix}', which is not an uppercase letter followed by `
                + "letters and digits. It is written straight into an id with a hyphen and a number after "
                + "it - 'Req' becomes 'Req-3' - so anything else would read as a broken id.");

        // A single letter is legal in an id but tells a reader nothing -
        // `F-1` could be a feature, a finding or a fix.
        if (prefix.length < 2)
            throw new Error(
                `${named} declares 'prefix: ${prefix}', which is one character. Use at least two - `
                + "'FT' or 'Feat', not 'F' - so a citation like 'FT-1' says what it points at.");

        stage.prefix = prefix;
    }

    if (source.produces !== undefined && source.produces !== null) {

        // An output gate with an artifact would be satisfied the moment
        // the file appeared, and the pipeline would carry on past it.
        if (id === IMPLEMENT)
            throw new Error(
                `${named} is the output gate and declares 'produces' - it is terminal, so it produces `
                + "nothing. The work leaves the documents there and git is its record.");

        stage.produces = stringList(source.produces, named, "produces");

        if (stage.produces.length === 0)
            throw new Error(
                `${named} declares an empty 'produces'. A phase that writes no document can never complete, `
                + "so the walk would run it on every pass forever.");
    }

    if (source.instructions !== undefined && source.instructions !== null) {

        // Nothing runs the input gate, so instructions there would never
        // be read.
        if (id === IDEA)
            throw new Error(
                `${named} is the input gate and names instructions. It runs no model - ＋ New Spec writes its `
                + "document itself - so instructions there would never be read. Remove it.");

        stage.instructions = {
            root: "repo",
            path: workspacePath(
                required(source.instructions, "instructions", named), named, "instructions", workspaceFolder)
        };
    }

    if (source.attachments !== undefined && source.attachments !== null) {

        // Same reason as `instructions:`.
        if (id === IDEA)
            throw new Error(
                `${named} is the input gate and names attachments. It runs no model - ＋ New Spec writes `
                + "its document itself - so nothing would ever open them. Remove them.");

        stage.attachments = parseAttachmentList(source.attachments, named, workspaceFolder);
    }

    if (source.ai !== undefined && source.ai !== null) {

        // Same reason as `instructions:`.
        if (id === IDEA)
            throw new Error(
                `${named} is the input gate and declares 'ai:'. It runs no model - New Spec writes its `
                + "document itself - so there is nothing for these settings to apply to. Remove them.");

        stage.ai = parseAi(source.ai, named);
    }

    if (source.actionable !== undefined && source.actionable !== null) {

        if (id === IDEA || id === IMPLEMENT)
            throw new Error(
                `${named} is a gate and declares 'actionable:'. The key marks the drafting stage whose document `
                + "the implementation is started from - a gate has no document. Remove it.");

        if (source.actionable !== true && source.actionable !== false)
            throw new Error(`${named} has an 'actionable:' that is not true or false.`);

        stage.actionable = source.actionable;
    }

    if (source.presets !== undefined && source.presets !== null) {

        // Neither gate has a revise: nothing runs the input gate, and
        // the output gate writes no document to run again over.
        if (id === IDEA || id === IMPLEMENT)
            throw new Error(
                `${named} is a gate and declares 'presets:'. A preset is a starting sentence for revising `
                + "a document, and a gate writes none. Remove it.");

        stage.presets = parsePresets(source.presets, named);
    }

    return stage;
}

/**
 * A `presets:` list, style-wide or one stage's - same shape, same
 * rules. Each entry is a mapping with `label:` (the menu item) and
 * `text:` (what fills the box). Spec variables are left as written;
 * the panel answers them when it draws the stage.
 */
function parsePresets(source: unknown, named: string): Preset[] {

    if (!Array.isArray(source))
        throw new Error(
            `${named} has a 'presets:' that is not a list. Each entry is a mapping with 'label:' and 'text:'.`);

    if (source.length === 0)
        throw new Error(
            `${named} declares an empty 'presets:'. Leave the key out to keep the built-in sentences, or `
            + "list at least one.");

    const presets = source.map((entry, index) => {

        const where = `${named} preset ${index + 1}`;

        if (!entry || typeof entry !== "object" || Array.isArray(entry))
            throw new Error(`${where} is not a mapping with 'label:' and 'text:'.`);

        const unknown = Object.keys(entry).filter(key => key !== "label" && key !== "text");

        if (unknown.length)
            throw new Error(
                `${where} declares ${quoted(unknown)}. A preset has 'label:' and 'text:' and nothing else.`);

        return { label: required(entry.label, "label", where), text: required(entry.text, "text", where) };
    });

    const duplicate = firstDuplicate(presets.map(preset => preset.label));

    if (duplicate)
        throw new Error(
            `${named} declares preset '${duplicate}' twice. The label is what the menu shows, so two of `
            + "the same would be one item nobody could tell apart.");

    return presets;
}

/**
 * An `ai:` block, style-wide or one stage's - same shape, same rules.
 * `uses` is refused either way: which plugin runs a phase is a
 * deployment decision, made in `sdd.uses`, not a process's own.
 */
function parseAi(source: unknown, named: string): Record<string, unknown> {

    if (typeof source !== "object" || source === null || Array.isArray(source))
        throw new Error(`${named} has an 'ai:' that is not a mapping.`);

    const written = source as Record<string, unknown>;

    if (written.uses !== undefined && written.uses !== null)
        throw new Error(
            `${named} sets 'ai.uses'. Which plugin runs a phase is the team's call, not the style's - it `
            + "belongs in settings.json under 'sdd.uses'. A style naming one would not run for a team on a "
            + "different plugin.");

    refuseEngineArgs(Object.keys(written), `${named} declares an 'ai:' that`);

    // A block for one runtime is held to the same rules as the flat keys,
    // plus its own: it cannot pick the runtime it belongs to. Whether its
    // id is a registered runtime is checked when a phase runs, where the
    // settings that register them are read.
    if (written[PROVIDERS_KEY] !== undefined && written[PROVIDERS_KEY] !== null)
        for (const [id, block] of Object.entries(checkProviderBlocks(written[PROVIDERS_KEY], `${named}'s 'ai:'`)))
            refuseEngineArgs(Object.keys(block), `${named} declares an 'ai.${PROVIDERS_KEY}.${id}' that`);

    return { ...written };
}

/**
 * Every stage this style has, complete. The defaults land here, once,
 * so nothing downstream ever meets a half-declared stage.
 */
function materialize(
    pool: Map<string, StageOverride>,
    order: string[],
    styleId: string,
    native: NativeTool | undefined
): Stage[] {

    const orphans = [...pool.keys()].filter(id => !order.includes(id));

    if (orphans.length)
        throw new Error(
            `Style '${styleId}' declares ${quoted(orphans)}, which no spec type visits. `
            + `Add ${orphans.length === 1 ? "it" : "them"} to a spec type's 'stages:' list, or remove `
            + `${orphans.length === 1 ? "it" : "them"}.`);

    return order.map(id => {

        const written = pool.get(id);

        return {
            id,

            label: written?.label ?? id,

            // No default: undefined means the style has no opinion, and
            // the document declares its own ids the grammar's own way.
            prefix: written?.prefix,

            produces: written?.produces ?? (id === IMPLEMENT ? [] : [`${id}.md`]),

            // Neither gate gets a default. Nothing runs the input gate,
            // and the output gate's prompt depends on the stage before
            // it, which is a fact about a spec type, so `pipeline`
            // derives it. A native stage runs its command, not a file.
            instructions: written?.instructions
                ?? (native || id === IDEA || id === IMPLEMENT
                    ? undefined
                    : { root: "style", path: instructionsFile(id) }),

            // No default for any of these: undefined means the style has
            // no opinion - settings are in charge of `ai`, and the
            // built-in sentences of `presets`.
            attachments: written?.attachments,
            ai: written?.ai,
            presets: written?.presets,

            // Only ever true - false is the same as unsaid.
            actionable: written?.actionable ? true : undefined,

            // Native styles only - refused on any other by `parseOverride`.
            ...(written?.command ? { command: written.command } : {}),
            ...(written?.revise ? { revise: written.revise } : {})
        };
    });
}

/**
 * The output gate a spec type never wrote, added after its actionable
 * last stage - the way `idea` is added in front of every pipeline.
 *
 * A stage marked `actionable` is where the implementation is started
 * from, so a spec type ending in it ends in code, and the gate that
 * runs that code is implied. Listing `implement` as well is refused:
 * the two are one thing said twice, and the second would draw a phase
 * the first exists to remove. An actionable stage anywhere but last is
 * refused too - the gate after it would make the rest unreachable.
 */
function withImpliedGate(shapes: SpecTypeShape[], pool: Map<string, StageOverride>, styleId: string): SpecTypeShape[] {

    return shapes.map(shape => {

        const named = `Spec type '${shape.id}' of style '${styleId}'`;

        const actionable = shape.stages.filter(id => pool.get(id)?.actionable);

        if (!actionable.length)
            return shape;

        if (actionable.length > 1)
            throw new Error(
                `${named} visits ${quoted(actionable)}, which are all 'actionable'. One stage per pipeline `
                + "starts the implementation; the rest are plain documents.");

        const [stage] = actionable;

        if (shape.stages.includes(IMPLEMENT))
            throw new Error(
                `${named} lists '${IMPLEMENT}' and visits '${stage}', which is 'actionable'. An actionable stage `
                + "runs the implementation itself, so the output gate is implied - list one or the other.");

        if (shape.stages[shape.stages.length - 1] !== stage)
            throw new Error(
                `${named} visits '${stage}' before the end, and it is 'actionable'. The implementation is started `
                + "from it, so it is the last drafting phase - move it last, or drop the key.");

        return { ...shape, stages: [...shape.stages, IMPLEMENT] };
    });
}

/**
 * The order every stage is materialized in: `idea`, the middles in
 * the order the spec types first name them, then `implement` - only if
 * some spec type actually visits it, by listing it or by ending in an
 * actionable stage. A style no spec type ends in code gets no
 * `implement` stage in its pool at all. A native style gets no `idea`.
 */
function stageOrder(specTypes: SpecTypeShape[], native: NativeTool | undefined): string[] {

    const middles: string[] = [];
    let implemented = false;

    for (const specType of specTypes)
        for (const id of specType.stages)
            if (id === IMPLEMENT)
                implemented = true;
            else if (!middles.includes(id))
                middles.push(id);

    const opening = native ? [] : [IDEA];

    return implemented ? [...opening, ...middles, IMPLEMENT] : [...opening, ...middles];
}

/** What a spec type says in the file: an id, a label, and the middle of its pipeline. */
interface SpecTypeShape {

    id: string;

    label: string;

    stages: string[];
}

function parseSpecTypeShapes(source: unknown, styleId: string): SpecTypeShape[] {

    if (!Array.isArray(source) || source.length === 0)
        throw new Error(
            `Style '${styleId}' has no 'specTypes:' - a style offers at least one kind of spec, and the list `
            + "is what ＋ New Spec shows.");

    const specTypes = source.map((entry, index) => parseSpecTypeShape(entry, styleId, index));

    const duplicate = firstDuplicate(specTypes.map(specType => specType.id));

    if (duplicate)
        throw new Error(`Style '${styleId}' declares spec type '${duplicate}' twice.`);

    return specTypes;
}

function parseSpecTypeShape(source: any, styleId: string, index: number): SpecTypeShape {

    const where = `Style '${styleId}' spec type ${index + 1}`;

    if (!source || typeof source !== "object")
        throw new Error(`${where} is not a mapping.`);

    const id = required(source.id, "id", where);
    const named = `Spec type '${id}' of style '${styleId}'`;
    const ids = stringList(source.stages, named, "stages");

    if (ids.length === 0)
        throw new Error(
            `${named} lists no stages - the list is the drafting phases between the gates, so an empty one `
            + "is a process that takes the ask in and hands it straight back out.");

    // `idea` is added by the parser. Listing it could only go wrong: a
    // second one.
    if (ids.includes(IDEA))
        throw new Error(
            `${named} lists '${IDEA}'. The input gate opens every pipeline on its own - `
            + "list only the drafting phases (and 'implement' last, if this process ends in code).");

    // `implement` is not added by the parser - a spec type opts in by
    // naming it itself. But it is still terminal: listed anywhere but
    // last, the stages after it could never be reached.
    const implementAt = ids.indexOf(IMPLEMENT);

    if (implementAt >= 0 && implementAt !== ids.length - 1)
        throw new Error(
            `${named} lists '${IMPLEMENT}' before the end. The output gate is terminal - a spec type `
            + "visits it last, or not at all.");

    const duplicate = firstDuplicate(ids);

    if (duplicate)
        throw new Error(
            `${named} visits '${duplicate}' twice - a stage is satisfied by its artifacts, so it cannot `
            + "run again in one pipeline.");

    return { id, label: required(source.label, "label", where), stages: ids };
}

function required(value: unknown, key: string, where: string): string {

    if (typeof value === "string" && value.trim())
        return value.trim();

    if (value === undefined || value === null)
        throw new Error(`${where} has no '${key}:'.`);

    throw new Error(`${where} has a '${key}:' that is not text.`);
}

/**
 * An optional boolean with a default. A non-boolean is refused rather
 * than coerced: YAML already turns `yes` and `on` into `true`, so
 * anything else is a line written wrong, and `"false"` read as on
 * would be a hard surprise to find.
 */
function bool(value: unknown, key: string, where: string, fallback: boolean): boolean {

    if (value === undefined || value === null)
        return fallback;

    if (typeof value !== "boolean")
        throw new Error(`Style '${where}' has a '${key}:' that is not true or false.`);

    return value;
}

/** An `attachments:` list, resolved and checked. Shared by a stage's list and the style's own. */
function parseAttachmentList(
    source: unknown,
    named: string,
    workspaceFolder: string | undefined
): { root: "repo"; path: string }[] {

    const paths = stringList(source, named, "attachments")
        .map(one => workspacePath(one, named, "attachments", workspaceFolder));

    const duplicate = firstDuplicate(paths);

    if (duplicate)
        throw new Error(`${named} attaches '${duplicate}' twice.`);

    // `repo` always - see Stage.attachments.
    return paths.map(one => ({ root: "repo" as const, path: one }));
}

/** A list of strings, accepting a bare string as a list of one. */
function stringList(value: unknown, where: string, key: string): string[] {

    if (value === undefined || value === null)
        return [];

    const values = Array.isArray(value) ? value : [value];

    return values.map(entry => {

        if (typeof entry !== "string" || !entry.trim())
            throw new Error(`${where} has a '${key}:' entry that is not text.`);

        return entry.trim();
    });
}

function firstDuplicate(values: string[]): string | undefined {

    const seen = new Set<string>();

    for (const value of values) {

        if (seen.has(value))
            return value;

        seen.add(value);
    }

    return undefined;
}

/**
 * `${{ phase.… }}` - the same namespace `phase/phasePrompt.ts` answers.
 * Written out here rather than imported, so reading a style does not
 * load the compiled-in prompt texts.
 */
const PHASE_NAMESPACE = "phase";

/**
 * Refuses a `${{ phase.… }}` anywhere but a stage's `command:` or
 * `revise:` - the only text in a `style.yml` that is rendered as a
 * message. Anywhere else it would stay literal text with no error.
 */
function checkPhasePlacement(source: any, folder: string): void {

    const stages = Array.isArray(source?.stages)
        ? source.stages.map((stage: unknown) => stage && typeof stage === "object" && !Array.isArray(stage)
            ? Object.fromEntries(Object.entries(stage as Record<string, unknown>)
                .filter(([key]) => key !== "command" && key !== "revise"))
            : stage)
        : source?.stages;

    const stray = expressionsIn({ ...source, stages })
        .find(one => one.split(".")[0] === PHASE_NAMESPACE);

    if (stray)
        throw new Error(
            `Style '${folder}' writes '\${{ ${stray} }}' outside a stage's 'command:' or 'revise:'. `
            + "Phase variables are answered only when a native stage's message is built.");
}

/**
 * The stage keys a spec variable may be written in. All but `presets`
 * are read by `assemble`, after the spec is known; `presets` is read by
 * the panel when it draws the stage, which is later still.
 */
const SPEC_KEYS = ["instructions", "attachments", "ai", "presets", "command", "revise"] as const;

/**
 * The file with those four keys taken out of every stage, and the
 * style's own `attachments:` and `presets:` taken out too (both are
 * also read after the spec is known). What is left is everything a
 * spec variable must not appear in.
 *
 * This runs before `parsePool`, so the shape is not validated yet.
 * Anything not in the expected shape is left whole for the parser
 * proper to report.
 */
function withoutStageKeys(source: any): unknown {

    const { attachments, presets, ...rest } = source;

    if (!Array.isArray(rest.stages))
        return rest;

    return {
        ...rest,
        stages: rest.stages.map((stage: unknown) => {

            if (!stage || typeof stage !== "object" || Array.isArray(stage))
                return stage;

            return Object.fromEntries(
                Object.entries(stage as Record<string, unknown>)
                    .filter(([key]) => !SPEC_KEYS.includes(key as typeof SPEC_KEYS[number])));
        })
    };
}

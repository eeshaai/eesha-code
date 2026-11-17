import { parse } from "yaml";
import { SddConfig } from "../config/sddConfig";
import { ideaOf, quoted, Style } from "../model/style";
import { PipelineState, pipelineStateOf } from "../state/pipelineState";
import { SpecFiles } from "./specFiles";

/**
 * Finding specs, and working out which style to read each one by.
 *
 * A spec is a folder holding an opening document - the idea stage's
 * document, under any loaded style's name for it. A folder without one
 * is not a spec and does not appear; it is not reported as a problem.
 *
 * A native style's own folder is the exception, since Kiro and Spec Kit
 * write no Idea document. Under the Kiro style's `.kiro/specs` every
 * folder is a spec - Kiro keeps nothing else there, and a folder New
 * spec just made is empty until the first phase writes. Under Spec
 * Kit's `specs`, a folder is a spec once it holds one of the style's
 * documents (`spec.md`, ...), since `specs/` is a common name for other
 * things too.
 *
 * A stage whose artifacts exist is satisfied, so the walk lands a
 * half-finished folder on the right phase.
 *
 * Which style reads a folder is never guessed. With more than one style
 * enabled, a folder places only by its opening document's `style:` tag.
 * A single enabled style is the one case with nothing to guess, and an
 * untagged folder gets it.
 */

export interface Detection {

    /**
     * The style this folder is read by - its own `style:` tag, or
     * `sdd.styles` when exactly one is enabled and the folder has none.
     *
     * Absent when the folder does not say and more than one style is
     * enabled, when what it names is not installed, or when what it
     * names would not parse. These are different mistakes, so
     * {@link reason} says which.
     */
    style?: string;

    /** Why it landed where it did, in a sentence a user can act on. */
    reason: string;
}

export interface DiscoveredSpec {

    /** The folder name, which is the spec's name. */
    name: string;

    /**
     * The spec's label and identity, repository-relative.
     *
     * Shown in tooltips and used as the id a run is recorded under.
     * Not a place on disk: when the spec root is elsewhere this is not
     * where the spec is. Anything touching the filesystem wants
     * {@link folder}.
     */
    path: string;

    /**
     * Where the spec actually is, absolute. Do not rebuild it from
     * `path`; that is wrong whenever the spec root is set to another
     * folder.
     */
    folder: string;

    detection: Detection;

    /** The spec type its pipeline is read by. Absent when no style was determined. */
    specType?: string;

    /** Where it is. Absent when no style was determined. */
    state?: PipelineState;

    /**
     * When the folder was last worked on, epoch milliseconds - `0` when
     * it could not be read. Lets a client sort by "recently changed".
     * See {@link RowSort}.
     */
    modified: number;
}

export interface DiscoveryInput {

    config: SddConfig;

    /** Every style that loaded. A style that failed to parse cannot be matched against. */
    styles: Style[];

    /**
     * Why a style would not load, keyed by id.
     *
     * Without this an unparseable `style.yml` looks the same as a style
     * that does not exist. Optional because a caller with nothing broken
     * has nothing to say.
     */
    failures?: ReadonlyMap<string, string>;

    /**
     * The spec root, absolute - the same one {@link SpecFiles} reads.
     * Passed in rather than derived from `config.specRoot`, which a workspace
     * with several folders can override.
     */
    root: string;

    /**
     * What the root is called in {@link DiscoveredSpec.path} - the
     * `specsDir` it came from, as written. Defaults to
     * `config.specRoot`.
     */
    label?: string;

    /**
     * The one style whose own `specsDir` this root is. An untagged
     * folder here is read by it - there is nothing to guess. Absent for
     * the shared root, and for a root more than one style names.
     */
    owner?: string;
}

/** Every spec folder under the root, placed as well as the evidence allows. */
export async function discover(input: DiscoveryInput, files: SpecFiles): Promise<DiscoveredSpec[]> {

    const names = await files.specs();

    const found = await Promise.all(names.sort().map(name => discoverOne(name, input, files)));

    return found.filter((spec): spec is DiscoveredSpec => spec !== undefined);
}

/** One folder, or nothing when it holds no opening document. */
async function discoverOne(name: string, input: DiscoveryInput, files: SpecFiles): Promise<DiscoveredSpec | undefined> {

    const present = new Set(await files.contents(name));

    const owner = input.owner ? input.styles.find(style => style.id === input.owner) : undefined;

    if (!(owner?.native ? nativeSpec(owner, present) : openings(input.styles).some(filename => present.has(filename))))
        return undefined;

    const path = join(input.label ?? input.config.specRoot, name);
    const folder = absolute(input.root, name);

    // Read for every folder, placed or not: an unplaced spec is still a
    // row in the list and must sort by time like the others.
    const modified = await files.modified(name);

    const placement = await placedStyle(name, input, present, files);

    if (!placement)
        return { name, path, folder, modified, detection: { reason: unplaced(input) } };

    const style = input.styles.find(candidate => candidate.id === placement.id);

    if (!style)
        return { name, path, folder, modified, detection: { reason: unplaced(input, placement.id) } };

    const specType = await readSpecType(name, style, present, files);

    return {
        name,
        path,
        folder,
        modified,
        detection: {
            style: style.id,
            reason: placement.source === "tag"
                ? `Read as '${style.id}', its opening document's 'style:' tag.`
                : placement.source === "root"
                    ? `Read as '${style.id}', the style whose 'specsDir' this folder is in.`
                    : `Read as '${style.id}', the configured style.`
        },
        specType,
        state: pipelineStateOf(style, specType, artifact => present.has(artifact))
    };
}

/**
 * Which style owns this folder: the opening document's `style:`
 * frontmatter, checked under every loaded style's idea filename. With
 * no tag, a folder in a style's own `specsDir` goes to that style, and
 * one in the shared root places only when exactly one style is enabled.
 */
async function placedStyle(
    name: string,
    input: DiscoveryInput,
    present: Set<string>,
    files: SpecFiles
): Promise<{ id: string; source: "tag" | "root" | "config" } | undefined> {

    for (const filename of openings(input.styles)) {

        if (!present.has(filename))
            continue;

        const text = await files.read(name, filename);
        const declared = text === undefined ? undefined : frontmatterField(text, "style");

        if (declared)
            return { id: declared, source: "tag" };
    }

    if (input.owner)
        return { id: input.owner, source: "root" };

    return input.config.styles.length === 1 ? { id: input.config.styles[0], source: "config" } : undefined;
}

/**
 * The opening document of every loaded style - the filenames a folder
 * must hold one of to be a spec at all.
 *
 * Every loaded style's, not only the configured ones': a folder tagged
 * for a style `sdd.styles` no longer enables is still a spec, and the
 * tag is inside the document being looked for.
 *
 * Empty when no style loaded, which drops every folder. The page names
 * a broken configured style above the list anyway.
 */
function openings(styles: Style[]): string[] {

    return [...new Set(styles.map(style => ideaOf(style)?.produces[0]).filter((one): one is string => !!one))];
}

/** Whether a folder in a native style's own root is a spec - see the module comment. */
function nativeSpec(style: Style, present: Set<string>): boolean {

    return style.native === "kiro"
        || style.stages.some(stage => stage.produces.some(file => present.has(file)));
}

/**
 * Why nothing could be placed - the style is broken, is absent, or the
 * folder does not say which of several it follows. Three different
 * fixes, so the message says which.
 */
function unplaced(input: DiscoveryInput, styleId?: string): string {

    if (!styleId)
        return "This folder's opening document does not say which style it follows, and 'sdd.styles' in "
            + `settings.json enables more than one: ${quoted(input.config.styles)}. Add a 'style:' line to it.`;

    const failed = input.failures?.get(styleId);

    if (failed)
        return `Style '${styleId}' was found but could not be read: ${failed}`;

    return `No style '${styleId}' - 'sdd.styles' in settings.json names a style no scope holds. `
        + `It offers ${quoted(input.styles.map(one => one.id))}.`;
}

/**
 * The spec type this folder's pipeline is read by.
 *
 * From the opening document's frontmatter when it is there (a
 * frontmatter field is not a state file). A folder
 * somebody else wrote has none, so it falls back to the style's first
 * type. Getting it wrong is visible and cheap: the pipeline is drawn
 * with a phase too many or too few, and changing the type redraws it.
 */
async function readSpecType(
    name: string,
    style: Style,
    present: Set<string>,
    files: SpecFiles
): Promise<string> {

    const fallback = style.specTypes[0].id;
    const opening = ideaOf(style)?.produces[0];

    if (!opening || !present.has(opening))
        return fallback;

    const text = await files.read(name, opening);
    const declared = text === undefined ? undefined : frontmatterField(text, "type");

    return declared && style.specTypes.some(specType => specType.id === declared) ? declared : fallback;
}

/** One field from a leading `---` block, if there is one, it parses, and the field is text. */
function frontmatterField(text: string, key: string): string | undefined {

    const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);

    if (!match)
        return undefined;

    try {

        const front = parse(match[1]);
        const value = front?.[key];

        return typeof value === "string" ? value.trim() : undefined;

    } catch {

        // Malformed frontmatter is the document's problem, not
        // discovery's - it still places the spec, on the fallback.
        return undefined;
    }
}

/**
 * The repository-relative label, always forward-slashed: it is read by
 * people, embedded in prompts and used as a run id.
 */
function join(root: string, name: string): string {

    const base = root.replace(/\\/g, "/").replace(/\/+$/, "");

    return base ? `${base}/${name}` : name;
}

/**
 * The place on disk, in the platform's own separators.
 *
 * Not {@link join}: this is handed to `fs` and a file watcher, and on
 * Windows `C:\work\specs` must not come back as `C:/work/specs` for a
 * caller comparing it with something `path.join` produced.
 */
function absolute(root: string, name: string): string {

    const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";

    return `${root.replace(/[\\/]+$/, "")}${separator}${name}`;
}

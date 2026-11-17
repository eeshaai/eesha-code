import * as fs from "fs";
import * as path from "path";
import { logger } from "../../core/logging/logger";
import { freeStyleId, planEject, withStyleId } from "../eject/eject";
import { GRAMMAR_FILE } from "../phase/grammar";
import { STYLE_FILE } from "../registry/StyleRegistry";
import { STYLES_DIR } from "../registry/NodeStyleFiles";
import { WORKFLOWS_DIR } from "../SddCore";

/**
 * Ejecting a built-in style - copying every file of it, byte for byte,
 * into a folder the user owns, as a new style of its own: `custom-1`,
 * `custom-2`, the first id no scope holds yet.
 *
 * A new id rather than the built-in's own, because a style lives in one
 * place only - a copy named `custom` would clash with the shipped one
 * and neither would run. The built-in is a sample to start from, not a
 * style to override in place. Rename the copy freely: its folder and the
 * `id:` in its `style.yml` must stay equal.
 *
 * Every file comes along - `style.yml`, prompts, instructions - since a style does not borrow a file it lacks from the built-in.
 *
 * The shared grammar comes along too, because it is the file people most
 * need to change - it is what a phase is told about the shape of a line,
 * and correcting what the model keeps getting wrong means editing it. It
 * belongs to no style: it lands in the styles folder beside the style
 * folders, and only when that folder has none yet. Every style reads that
 * one copy, so an eject of a second style must not overwrite the edits
 * made for the first.
 *
 * The caller picks the built-in and the folder, and this does the copy.
 */

/** The three styles folders an eject reads or writes. */
export interface StylesFolders {

    /** The built-in styles that ship with the program. */
    builtin: string;

    /** The profile's styles, for every repository on this machine. */
    profile: string;

    /**
     * The workspace's styles, where the workspace-level
     * `.eesha` resolves. Nothing when no folder is open.
     */
    workspace?: string;
}

/**
 * Where the styles folders are.
 *
 * @param resources the `resources` folder that holds the built-in styles.
 * @param workspace the folder whose `.eesha` the workspace
 * scope is - handed in, never looked for.
 */
export function stylesFolders(resources: string, home: string, workspace?: string): StylesFolders {

    return {
        builtin: path.join(resources, STYLES_DIR),
        profile: path.join(home, WORKFLOWS_DIR, STYLES_DIR),
        ...(workspace ? { workspace: path.join(workspace, WORKFLOWS_DIR, STYLES_DIR) } : {})
    };
}

/** What one eject did. */
export interface Ejected {

    /** The built-in that was copied. */
    id: string;

    /** The new style's id - its folder name and its `id:`. */
    newId: string;

    /** The new style's folder. */
    targetRoot: string;

    /** How many of the style's files were copied. */
    files: number;

    /** Where the shared grammar was copied to, when it was. */
    grammarTo?: string;
}

/**
 * Every style id any of the three folders holds. A new style's id must
 * be free in all of them, not only the one written to: an id in two
 * places is refused, wherever the two are.
 */
export async function takenStyleIds(folders: StylesFolders): Promise<Set<string>> {

    return new Set([
        ...await styleIds(folders.builtin),
        ...await styleIds(folders.profile),
        ...(folders.workspace ? await styleIds(folders.workspace) : [])
    ]);
}

/**
 * Why `name` cannot be a new style's id, or nothing when it can. The id
 * is the copy's folder name, so the same rule as a spec's name.
 */
export function styleNameProblem(name: string, taken: ReadonlySet<string>): string | undefined {

    const trimmed = name.trim();

    if (!trimmed)
        return "The new style needs a name.";

    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed))
        return "Letters, digits, dots, dashes and underscores - it becomes a folder name.";

    if (taken.has(trimmed))
        return `A style named '${trimmed}' already exists.`;

    return undefined;
}

/** What copying a built-in would do, before anything is written - the copy window's list. */
export async function ejectPreview(folders: StylesFolders, id: string): Promise<{ files: string[]; suggested: string }> {

    return {
        files: (await filesUnder(path.join(folders.builtin, id))).sort(),
        suggested: freeStyleId(id, await takenStyleIds(folders))
    };
}

/**
 * Copies the built-in `id` into `stylesRoot` as a new style. Throws when
 * the new style's folder already has files in it - nothing is written
 * over - or when `name` cannot be used.
 *
 * @param name The new style's id. Left out, the first free `<id>-<n>`.
 */
export async function ejectStyle(folders: StylesFolders, id: string, stylesRoot: string, name?: string): Promise<Ejected> {

    const taken = await takenStyleIds(folders);

    const problem = name === undefined ? undefined : styleNameProblem(name, taken);

    if (problem)
        throw new Error(problem);

    const newId = name === undefined ? freeStyleId(id, taken) : name.trim();
    const sourceRoot = path.join(folders.builtin, id);
    const targetRoot = path.join(stylesRoot, newId);

    const plan = planEject({
        files: await filesUnder(sourceRoot),
        sourceRoot,
        targetRoot,
        exists: relative => fs.existsSync(path.join(targetRoot, ...relative.split("/")))
    });

    // A new id is free by construction, so this is a folder that appeared
    // between the check and now. Not written over.
    if (plan.collisions.length)
        throw new Error(`${targetRoot} already has files in it. Nothing was copied.`);

    for (const copy of plan.copies) {

        await fs.promises.mkdir(path.dirname(copy.to), { recursive: true });

        if (copy.relative === STYLE_FILE)
            await fs.promises.writeFile(
                copy.to, withStyleId(await fs.promises.readFile(copy.from, "utf8"), newId), "utf8");
        else
            await fs.promises.copyFile(copy.from, copy.to);
    }

    // The shared grammar, into the styles folder of the same scope - never
    // over a copy already there. See the note at the top.
    const grammarFrom = path.join(folders.builtin, GRAMMAR_FILE);
    const grammarTo = path.join(stylesRoot, GRAMMAR_FILE);
    const grammarCopied = fs.existsSync(grammarFrom) && !fs.existsSync(grammarTo);

    if (grammarCopied)
        await fs.promises.copyFile(grammarFrom, grammarTo);

    // Logged because anything that reads oddly afterwards starts here,
    // and by then the notice is gone.
    logger.info(`Ejected style '${id}' as '${newId}' to ${targetRoot} (${plan.copies.length} file(s)).`
        + (grammarCopied ? ` Copied the shared ${GRAMMAR_FILE} to ${grammarTo}.` : ""));

    return { id, newId, targetRoot, files: plan.copies.length, ...(grammarCopied ? { grammarTo } : {}) };
}

/**
 * What to do next, said once the copy is made: a new style is not on
 * offer until settings.json enables it, and the copy does not follow the built-in.
 */
export function ejectedText(done: Ejected): string {

    return `Copied the '${done.id}' sample to ${done.targetRoot} as a new style, '${done.newId}'. Add '${done.newId}' to sdd.styles in `
        + "settings.json to offer it in New Spec. To rename it, rename the folder and the 'id:' in its "
        + `${STYLE_FILE} together. It does not change when Eesha Code updates the sample. `
        + (done.grammarTo
            ? `The shared ${GRAMMAR_FILE} was copied to ${done.grammarTo}, and every style now reads that copy. `
            + "Edit it with care - it states the shapes the spec panel reads, and dropping one turns that part "
            + "of the panel off without saying so."
            : "");
}

/** The style ids under a styles folder - every directory in it. None when the folder is not there. */
export async function styleIds(root: string): Promise<string[]> {

    const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);

    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
}

/** Every file under a folder, relative and forward-slashed. */
async function filesUnder(root: string, relative = ""): Promise<string[]> {

    const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });

    const files: string[] = [];

    for (const entry of entries) {

        const child = relative ? `${relative}/${entry.name}` : entry.name;

        if (entry.isDirectory())
            files.push(...await filesUnder(root, child));
        else if (entry.isFile())
            files.push(child);
    }

    return files;
}

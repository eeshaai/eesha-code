import * as fs from "fs";
import * as path from "path";
import { logger } from "../../core/logging/logger";
import { Style } from "../model/style";
import { SddCore } from "../SddCore";

/**
 * Starting a spec: the input gate, without the questions.
 *
 * No model runs here. Everything `idea.md` contains is something the
 * person just told us - the spec type, the source, the work item or the
 * files, the name. Writing it is formatting. An AI pass would only put a
 * lossy copy between the ask and every phase after it.
 *
 * The caller asks the questions, and this file does the rest: what to
 * offer, how to read the answers, and writing the spec folder.
 */

/** One "[style] kind" row of the spec type pick. */
export interface SpecTypeOffer {

    label: string;

    id: { styleId: string; specTypeId: string };
}

/**
 * Every style in `sdd.styles`, loaded, and what each offers. A style
 * that fails to load is kept with its error rather than dropped, so the
 * pick can say why it is not on offer - and is logged.
 */
export async function specTypeOffers(core: SddCore): Promise<{
    styles: Style[];
    offers: SpecTypeOffer[];
    broken: { id: string; error: string }[];
}> {

    const loaded = await Promise.all(core.config.styles.map(id => core.registry.load(id)
        .then(style => ({ id, style }), (error: Error) => ({ id, error: error.message }))));

    const styles = loaded.flatMap(one => "style" in one ? [one.style] : []);
    const broken = loaded.flatMap(one => "error" in one ? [one] : []);

    for (const one of broken)
        logger.warning(`New Spec: style '${one.id}' could not be loaded - ${one.error}`);

    const offers = styles.flatMap(style => style.specTypes.map(specType => ({
        label: `[${style.name}] ${specType.label}`,
        id: { styleId: style.id, specTypeId: specType.id }
    })));

    return { styles, offers, broken };
}

/**
 * Kiro and Spec Kit, as New spec offers them, with why one cannot be
 * picked here. Their built-in styles are loaded whether or not
 * `sdd.styles` lists them: picking one is choosing to run that tool's
 * own process, not one of this workspace's Eesha styles.
 */
export async function nativeOffers(core: SddCore): Promise<{ style: Style; problem?: string }[]> {

    const offers: { style: Style; problem?: string }[] = [];

    for (const id of ["kiro", "speckit"]) {

        const style = await core.registry.load(id).catch(() => undefined);

        if (!style?.native)
            continue;

        offers.push({ style, problem: nativeProblem(core, style) });
    }

    return offers;
}

/** Why a native style cannot start a spec in this workspace, or nothing. */
function nativeProblem(core: SddCore, style: Style): string | undefined {

    if (style.native === "kiro") {

        const provider = typeof style.ai?.provider === "string" ? style.ai.provider : undefined;
        const allowed = core.config.providerIds;

        return provider && allowed && !allowed.includes(provider)
            ? `Kiro runs on '${provider}', which is not in ai.providers in settings.json.`
            : undefined;
    }

    // `specify init` writes `.specify/` - its scripts and templates.
    // Without them every /speckit command fails.
    return fs.existsSync(path.join(core.paths.workspace, ".specify"))
        ? undefined
        : "Spec Kit is not set up in this folder. Run 'specify init --here' in it first.";
}

/**
 * Makes a Kiro spec's folder, empty. The first phase writes into it -
 * Kiro's own start command creates the documents, not this.
 */
export async function createNativeFolder(core: SddCore, style: Style, name: string): Promise<void> {

    await fs.promises.mkdir(core.specPathOf(name, style), { recursive: true });

    logger.info(`New spec '${name}' (${style.id}) - made ${core.specDirOf(name, style)}.`);
}

/** How a source is named in the pick. */
export function sourceLabel(source: string): string {

    return source === "ado" ? "Azure DevOps work item"
        : source === "gh" ? "GitHub issue"
            : source === "file" ? "A file with the ask"
                : "Describe it myself";
}

/** What a source needs pointing at, once it has been chosen. */
export interface Pointer {

    /** `manual` - the one line saying what this is about. */
    description?: string;

    /** `ado` / `gh` - the work item id or issue number. */
    workItem?: string;

    /** `ado` / `gh` - the link, when one was pasted instead of an id. */
    url?: string;

    /** `file` - absolute paths, as picked. */
    files?: string[];
}

/**
 * A pasted link or a bare id, told apart. A URL keeps its tail as the
 * id, so the frontmatter carries the number either way.
 */
export function pointerFor(typed: string): Pointer {

    if (!/^https?:\/\//i.test(typed))
        return { workItem: typed };

    const tail = typed.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop();

    return {
        url: typed,
        workItem: tail && /^\d+$/.test(tail) ? tail : undefined
    };
}

/**
 * Every folder name already taken in every spec root, not only one
 * style's: a spec is known by its folder name, so one name in two roots
 * would be two specs nobody can tell apart.
 */
export async function takenSpecNames(core: SddCore): Promise<Set<string>> {

    return new Set((await Promise.all((await core.specRoots()).map(root => fs.promises
        .readdir(root.folder)
        .catch(() => [] as string[])))).flat());
}

/**
 * What is wrong with a typed spec name, or nothing. The name becomes a
 * directory that appears in every path the agent is given, and renaming
 * it later means moving a folder whose documents reference it.
 */
export function specNameProblem(value: string, taken: ReadonlySet<string>): string | undefined {

    const trimmed = value.trim();

    if (!trimmed)
        return "A spec needs a name.";

    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed))
        return "Letters, digits, dots, dashes and underscores - it becomes a folder name.";

    if (taken.has(trimmed))
        return `A spec folder named '${trimmed}' already exists.`;

    return undefined;
}

/**
 * Writes the new spec: its folder, the ask copied into it, and
 * `idea.md`. Answers the document's full path, for the host to open.
 */
export async function createSpec(core: SddCore, style: Style, answers: {
    name: string;
    specTypeId: string;
    source: string;
    pointer: Pointer;
}): Promise<string> {

    const { name, specTypeId, source, pointer } = answers;

    // Created here so the copied ask has somewhere to land before
    // `idea.md` is written. Discovery lists a folder only once its
    // opening document is in it, so nothing shows in the tree until
    // that write lands. Asked for by name rather than rebuilt from
    // `specDir`, which is repository-relative in one case and
    // absolute in the other.
    const folder = core.specPathOf(name, style);

    await fs.promises.mkdir(folder, { recursive: true });

    const copied = await copyAsk(pointer.files ?? [], folder);

    const { artifact, text } = await core.idea({
        specName: name,
        style: style.id,
        specType: specTypeId,
        source,
        description: pointer.description,
        workItem: pointer.workItem,
        url: pointer.url,
        files: copied
    });

    const document = path.join(folder, artifact);

    await fs.promises.writeFile(document, text, "utf8");

    logger.info(`New spec '${name}' (${style.id}/${specTypeId}, source ${source}) - wrote ${core.specDirOf(name, style)}/${artifact}.`);

    return document;
}

/**
 * Copies the picked files into the spec folder.
 *
 * Copied, not linked: the ask becomes part of the spec, goes into git
 * with it, and a teammate who clones the repository can read it. A path
 * to `C:\notes\` is none of those things.
 *
 * A name that collides gets a numeric suffix rather than overwriting.
 * Two files called `notes.md` from two folders is an ordinary pick.
 *
 * @returns The names inside the spec folder, in the order picked.
 */
async function copyAsk(files: string[], folder: string): Promise<string[]> {

    const taken = new Set<string>();
    const copied: string[] = [];

    for (const file of files) {

        const parsed = path.parse(path.basename(file));

        let name = parsed.base;

        for (let n = 2; taken.has(name.toLowerCase()); n++)
            name = `${parsed.name}-${n}${parsed.ext}`;

        taken.add(name.toLowerCase());

        await fs.promises.copyFile(file, path.join(folder, name));

        copied.push(name);
    }

    return copied;
}

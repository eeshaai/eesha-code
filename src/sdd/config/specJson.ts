import * as path from "path";

/**
 * `spec.json` - what one spec is given, beyond what its style gives
 * every spec.
 *
 * It sits in the spec folder beside `idea.md`, and it is optional. A
 * spec without one loses nothing.
 *
 * The line it holds: this file says what a spec is *given*. It never
 * says how a spec is *processed*. Stage order, gates and prompts stay in
 * `style.yml`; which plugin runs a phase stays in `settings.json`. A
 * spec able to change those would stop being comparable to any other
 * spec on the same style, which is the only thing a style is for.
 *
 * Unknown keys are refused rather than ignored. A misspelled key that
 * silently does nothing is exactly the failure this file exists to
 * prevent - the phase runs, writes a plausible document, and nobody
 * learns the model was never shown the file they pointed at. Refusing
 * also means every key added later is added deliberately, which is what
 * keeps the file from becoming a junk drawer.
 *
 * The one way round that is `metadata`: a single key that holds anything
 * at all - a story id, a ticket link, whatever a team's own workflows
 * want to keep with the spec. The engine never reads inside it and no
 * phase is shown it, so nothing can be misspelled into silently
 * changing a run. What is inside is the team's business.
 */

/** The file's name in a spec folder. */
export const SPEC_FILE = "spec.json";

/** The schema version of a `spec.json` this build understands. */
export const SpecSchema = 1;

/** One reference file this spec hands to its phases. */
export interface SpecAttachment {

    /**
     * A bare name (`notes.md`) is a file in the spec folder. Anything
     * else (`docs/api/contract.md`) is relative to the workspace root.
     *
     * Pointed at, never copied. A copy of a repository document in every
     * spec folder is stale the moment the original changes, and nobody
     * owns the copies.
     */
    file: string;

    /**
     * What the file is for, in the words of whoever wrote it. It becomes
     * the file's clause in the prompt's `## Attached` list, where nothing
     * else could say what `contract.md` is.
     */
    desc: string;
}

/** A parsed `spec.json`. */
export interface SpecFile {

    attachments: SpecAttachment[];

    /**
     * Whatever the spec's author put under `metadata`, as written. Not
     * checked, not read by the engine, not sent to any phase. Absent
     * when the file has none.
     */
    metadata?: unknown;
}

const KEYS = ["spec", "attachments", "metadata"];

const ATTACHMENT_KEYS = ["file", "desc"];

/**
 * A `spec.json`, checked.
 *
 * Every error names the key, because this file is written by hand and a
 * message that only says "invalid" leaves the author guessing.
 *
 * @param text the file's contents.
 */
export function parseSpecJson(text: string): SpecFile {

    let parsed: unknown;

    try {

        parsed = JSON.parse(text);

    } catch (error) {

        throw new Error(`${SPEC_FILE} is not valid JSON: ${(error as Error).message}`);
    }

    if (!isObject(parsed))
        throw new Error(`${SPEC_FILE} must hold an object.`);

    // The version first, so a file written against a later schema is
    // told what this build understands rather than failing on a key it
    // does not know yet.
    if (parsed.spec !== SpecSchema)
        throw new Error(
            `${SPEC_FILE} must declare 'spec: ${SpecSchema}'. `
            + (parsed.spec === undefined ? "It declares nothing." : `It declares '${String(parsed.spec)}'.`));

    refuseUnknown(parsed, KEYS, SPEC_FILE);

    return {
        attachments: attachmentsOf(parsed.attachments),
        ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {})
    };
}

function attachmentsOf(value: unknown): SpecAttachment[] {

    if (value === undefined || value === null)
        return [];

    if (!Array.isArray(value))
        throw new Error(`${SPEC_FILE} 'attachments' must be a list.`);

    return value.map((one, at) => {

        const where = `${SPEC_FILE} 'attachments[${at}]'`;

        if (!isObject(one))
            throw new Error(`${where} must be an object with 'file' and 'desc'.`);

        refuseUnknown(one, ATTACHMENT_KEYS, where);

        return { file: fileOf(one.file, where), desc: textOf(one.desc, where, "desc") };
    });
}

/**
 * The `file` value, checked as a path before anything tries to open it.
 *
 * Absolute paths and `..` are refused: a spec declares files inside the
 * repository, and a path leaving it is either a mistake or a spec that
 * only runs on one machine.
 */
function fileOf(value: unknown, where: string): string {

    const file = textOf(value, where, "file").replace(/\\/g, "/");

    if (path.isAbsolute(file) || /^[A-Za-z]:/.test(file))
        throw new Error(
            `${where} 'file' is '${file}', which is an absolute path. `
            + "Write a bare name for a file in the spec folder, or a workspace-relative path.");

    if (file.split("/").includes(".."))
        throw new Error(`${where} 'file' is '${file}', which leaves the workspace. Paths stay inside it.`);

    return file;
}

function textOf(value: unknown, where: string, key: string): string {

    if (typeof value !== "string" || !value.trim())
        throw new Error(`${where} must give '${key}' as text.`);

    return value.trim();
}

function refuseUnknown(value: Record<string, unknown>, known: string[], where: string): void {

    const stray = Object.keys(value).find(key => !known.includes(key));

    if (stray !== undefined)
        throw new Error(`${where} writes '${stray}', which is not a key it has. Known keys: ${known.join(", ")}.`);
}

function isObject(value: unknown): value is Record<string, unknown> {

    return typeof value === "object" && value !== null && !Array.isArray(value);
}

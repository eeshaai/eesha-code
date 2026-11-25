import { promises as fs } from "fs";
import * as path from "path";

import type { ModelChoice, ModeList } from "./AgentProvider";
import { profilePath } from "../loader/profilePaths";

/**
 * Each runtime's model list, kept in its own file:
 * `~/.eesha/models/<runtime>.json`.
 *
 * The picker reads this file and does not fetch when it is there. A
 * fetch starts the runtime's CLI, which is slow and sometimes fails, so
 * it happens only when the file is missing or when the person presses
 * the refresh button beside the picker. The person can edit the file by
 * hand to add a model the runtime does not list yet.
 *
 * In the profile folder, not the workspace: every workspace shares it,
 * and nothing here should reach git.
 */
export const MODEL_LIST_DIR = "models";

/** What one runtime's file holds. */
export interface ModelListFile {

    models: ModelChoice[];

    /** Kiro's modes, which come from the same fetch. */
    modes?: ModeList;
}

/** What reading a runtime's file found. */
export type ModelListRead =
    | { state: "missing" }
    | { state: "ok"; list: ModelListFile }

    /** The file is there but cannot be used - bad JSON or a wrong shape. `reason` says what is wrong. */
    | { state: "broken"; reason: string };

/** Written at the top of every file, for the person who opens it. */
const ABOUT = "Models offered in the picker for this runtime. Edit freely: only 'id' is required. "
    + "Pressing the refresh button beside the model picker fetches the list again and replaces this file.";

/**
 * The file for a runtime. An id that is not a plain file name (a custom
 * ACP runtime can be named anything) is encoded, so it can never point
 * outside the folder.
 *
 * @param root For tests - the real one is in the profile folder.
 */
export function modelListPath(runtime: string, root: string = profilePath(MODEL_LIST_DIR)): string {

    const plain = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(runtime);

    return path.join(root, `${plain ? runtime : encodeURIComponent(runtime).replace(/\./g, "%2E")}.json`);
}

/** Reads a runtime's file. Never throws. */
export async function readModelList(runtime: string, root?: string): Promise<ModelListRead> {

    let text: string;

    try {

        text = await fs.readFile(modelListPath(runtime, root), "utf8");

    } catch (error) {

        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return { state: "missing" };

        return { state: "broken", reason: `cannot be read: ${(error as Error).message}` };
    }

    let parsed: unknown;

    try {

        parsed = JSON.parse(text);

    } catch (error) {

        return { state: "broken", reason: `is not valid JSON: ${(error as Error).message}` };
    }

    const problem = shapeProblem(parsed);

    if (problem)
        return { state: "broken", reason: problem };

    const { models, modes } = parsed as ModelListFile;

    return { state: "ok", list: { models, ...(modes ? { modes } : {}) } };
}

/**
 * Writes a runtime's file. `replace: false` leaves a file that is already
 * there alone - for the first fetch, so a file the person made while the
 * fetch ran is never lost. Never throws: answers whether it was written.
 */
export async function writeModelList(
    runtime: string,
    list: ModelListFile,
    options: { replace: boolean; root?: string }
): Promise<boolean> {

    const file = modelListPath(runtime, options.root);

    try {

        await fs.mkdir(path.dirname(file), { recursive: true });

        if (!options.replace && await exists(file))
            return false;

        const body = { about: ABOUT, models: list.models, ...(list.modes ? { modes: list.modes } : {}) };

        // Written beside and then moved into place, so a reader never
        // sees half a file.
        const partial = `${file}.${process.pid}.tmp`;

        await fs.writeFile(partial, JSON.stringify(body, null, 2) + "\n", "utf8");
        await fs.rename(partial, file);

        return true;

    } catch {

        return false;
    }
}

async function exists(file: string): Promise<boolean> {

    try {

        await fs.access(file);

        return true;

    } catch {

        return false;
    }
}

/** What is wrong with a file's content, or nothing. Says where, so a hand edit is easy to fix. */
function shapeProblem(value: unknown): string | undefined {

    if (!value || typeof value !== "object" || Array.isArray(value))
        return "must be a JSON object with a 'models' list";

    const { models, modes } = value as Record<string, unknown>;

    if (!Array.isArray(models))
        return "needs a 'models' list";

    for (const [index, model] of models.entries()) {

        const where = `models[${index}]`;

        if (!model || typeof model !== "object" || Array.isArray(model))
            return `${where} must be an object`;

        const one = model as Record<string, unknown>;

        if (typeof one.id !== "string" || !one.id.trim())
            return `${where} needs an 'id'`;

        const wrong = wrongField(one, {
            name: "string", multiplier: "number", disabled: "boolean", price: "string",
            efforts: "string[]", reasoningEfforts: "string[]", aliases: "string[]"
        });

        if (wrong)
            return `${where}.${wrong}`;
    }

    if (modes === undefined)
        return undefined;

    if (!modes || typeof modes !== "object" || !Array.isArray((modes as ModeList).modes))
        return "'modes' must be an object with a 'modes' list";

    if ((modes as ModeList).current !== undefined && typeof (modes as ModeList).current !== "string")
        return "modes.current must be a string";

    for (const [index, mode] of (modes as ModeList).modes.entries()) {

        const where = `modes.modes[${index}]`;

        if (!mode || typeof mode !== "object" || typeof mode.id !== "string" || !mode.id.trim())
            return `${where} needs an 'id'`;

        const wrong = wrongField(mode as unknown as Record<string, unknown>, { name: "string", description: "string" });

        if (wrong)
            return `${where}.${wrong}`;
    }

    return undefined;
}

/** The first optional field of the wrong type, as "<field> must be a <type>". */
function wrongField(value: Record<string, unknown>, fields: Record<string, "string" | "number" | "boolean" | "string[]">): string | undefined {

    for (const [field, type] of Object.entries(fields)) {

        const got = value[field];

        if (got === undefined)
            continue;

        const ok = type === "string[]"
            ? Array.isArray(got) && got.every(item => typeof item === "string")
            : typeof got === type;

        if (!ok)
            return `${field} must be ${type === "string[]" ? "a list of strings" : `a ${type}`}`;
    }

    return undefined;
}

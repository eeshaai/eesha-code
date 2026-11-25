import * as path from "path";

import { eeshaPath, readJson } from "./paths";

/*
 * The server's own settings, read from `eesha` in
 * ~/.eesha/settings.json:
 *
 *   "eesha": {
 *     "port": 7420, "theme": "dark", "fontSize": 16,
 *     "workingFolders": ["C:\\src"],
 *     "runtimes": {
 *       "kiro-cli": { "toolsOff": ["str_replace", "fs_write"] }
 *     }
 *   }
 *
 * `workingFolders`: the folders where the person keeps their code. The
 * folder browser lists them beside the drives, and lists the git repos in
 * them (see gitReposIn in folders.ts) for a quick pick.
 *
 * `runtimes`: per runtime id, the runtime's own tools to turn off, by its
 * own names - the name in brackets on a tool call's log line.
 *
 * Everything else in that file (runtimes, models, MCP servers, feature
 * flags) is read by the engine the same way as the profile's settings.json.
 */

export const DEFAULT_PORT = 7420;

/**
 * The page's text size in px: what the A+ and A- buttons on the settings
 * page change, one px a press. Every size on the page - text and icons -
 * is worked out from it.
 */
export const FONT_SIZE = { default: 16, min: 11, max: 24 } as const;

/** Whether a value is a text size the page takes: a whole number from 12 to 24. */
export function isFontSize(value: unknown): value is number {

    return typeof value === "number" && Number.isInteger(value) && value >= FONT_SIZE.min && value <= FONT_SIZE.max;
}

/** "system" follows the computer's own dark or light setting. */
export type Theme = "dark" | "light" | "system";

const THEMES: readonly Theme[] = ["dark", "light", "system"];

/** What one runtime's sessions may use - `eesha.runtimes.<id>`. */
export interface RuntimeTools {

    /** The runtime's own tools to take away, by its own names. */
    toolsOff: string[];
}

export interface ServerSettings {

    port: number;

    theme: Theme;

    /** The page's text size in px - see FONT_SIZE. */
    fontSize: number;

    /** Where the person keeps their code: full paths, each once, in the file's order. Ones that do not exist now are kept. */
    workingFolders: string[];

    /** Per runtime id - see {@link RuntimeTools}. A runtime not listed keeps all its tools. */
    runtimes: Record<string, RuntimeTools>;

    /** What was wrong with the file, said once at start. The defaults are used instead. */
    problems: string[];
}

/** The `eesha` block, with defaults for what is missing or wrong. */
export function readServerSettings(file: string = eeshaPath("settings.json")): ServerSettings {

    return serverSettingsFrom(readJson(file));
}

/** The `eesha` block of a settings file's JSON - see {@link readServerSettings}. */
export function serverSettingsFrom(json: unknown): ServerSettings {

    const problems: string[] = [];

    const block = json && typeof json === "object" ? (json as Record<string, unknown>).eesha : undefined;

    if (block !== undefined && (typeof block !== "object" || block === null))
        problems.push("eesha must be an object - using the defaults.");

    const own = block && typeof block === "object" ? block as Record<string, unknown> : {};

    let port = DEFAULT_PORT;

    if (own.port !== undefined) {

        if (typeof own.port === "number" && Number.isInteger(own.port) && own.port >= 1024 && own.port <= 65535)
            port = own.port;
        else
            problems.push(`eesha.port must be a whole number from 1024 to 65535 - using ${DEFAULT_PORT}.`);
    }

    let theme: Theme = "dark";

    if (own.theme !== undefined) {

        if (THEMES.includes(own.theme as Theme))
            theme = own.theme as Theme;
        else
            problems.push("eesha.theme must be \"dark\", \"light\" or \"system\" - using dark.");
    }

    let fontSize: number = FONT_SIZE.default;

    if (own.fontSize !== undefined) {

        if (isFontSize(own.fontSize))
            fontSize = own.fontSize;
        else
            problems.push(`eesha.fontSize must be a whole number from ${FONT_SIZE.min} to ${FONT_SIZE.max} - using ${FONT_SIZE.default}.`);
    }

    const workingFolders = workingFoldersFrom(own.workingFolders, problems);

    const runtimes = runtimeToolsFrom(own.runtimes, problems);

    return { port, theme, fontSize, workingFolders, runtimes, problems };
}

/** Why `value` cannot be `eesha.workingFolders`, or nothing when it can. */
export function workingFoldersProblem(value: unknown): string | undefined {

    if (!Array.isArray(value) || value.some(one => typeof one !== "string" || !one.trim()))
        return "eesha.workingFolders must be a list of folder paths.";

    const relative = (value as string[]).find(one => !path.isAbsolute(one.trim()));

    if (relative !== undefined)
        return `"${relative}" in eesha.workingFolders is not a full folder path.`;

    return undefined;
}

/** `eesha.workingFolders`, each once. Nothing when it is wrong - the problem is said. */
function workingFoldersFrom(value: unknown, problems: string[]): string[] {

    if (value === undefined)
        return [];

    const problem = workingFoldersProblem(value);

    if (problem) {

        problems.push(`${problem.replace(/\.$/, "")} - no working folders are used.`);

        return [];
    }

    const folders: string[] = [];

    for (const one of value as string[]) {

        const resolved = path.resolve(one.trim());

        if (!folders.some(other => sameFolder(other, resolved)))
            folders.push(resolved);
    }

    return folders;
}

/** Whether two full paths are the same folder: case does not count on Windows. */
export function sameFolder(left: string, right: string): boolean {

    return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** `eesha.runtimes`, with what is wrong said and left out. */
function runtimeToolsFrom(value: unknown, problems: string[]): Record<string, RuntimeTools> {

    if (value === undefined)
        return {};

    if (!value || typeof value !== "object" || Array.isArray(value)) {

        problems.push("eesha.runtimes must be an object of runtime ids - no tools are turned off.");

        return {};
    }

    const runtimes: Record<string, RuntimeTools> = {};

    for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {

        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {

            problems.push(`eesha.runtimes.${id} must be an object with toolsOff - left out.`);

            continue;
        }

        const { toolsOff } = entry as Record<string, unknown>;

        if (toolsOff === undefined) {

            runtimes[id] = { toolsOff: [] };

            continue;
        }

        if (!Array.isArray(toolsOff) || toolsOff.some(one => typeof one !== "string" || !one.trim())) {

            problems.push(`eesha.runtimes.${id}.toolsOff must be a list of tool names - left out.`);

            runtimes[id] = { toolsOff: [] };

            continue;
        }

        runtimes[id] = { toolsOff: [...new Set((toolsOff as string[]).map(one => one.trim()))] };
    }

    return runtimes;
}

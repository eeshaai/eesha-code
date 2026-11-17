import * as fs from "fs";
import * as net from "net";

import { Providers } from "../core/agent/providerArgs";
import { EnvService } from "../core/env/envService";
import { BUILT_IN_ACP_AGENTS, FEATURE_FLAGS, loadEngineSettings, readJson as readSettingsJson, type EngineSettings } from "../core/settings/engineSettings";
import { defaultRuntimeOf, startRuntime } from "../chat/chatRules";
import { checkRuntimes, foundOnly } from "./doctor";
import { eeshaHome, eeshaPath, writeAtomic } from "./paths";
import type { SettingsChange, SettingsView, ThemeChoice } from "./protocol";
import { serverSettingsFrom, FONT_SIZE, isFontSize, readServerSettings, workingFoldersProblem } from "./settings";
import { probeAcp, type ProbeResult } from "./runtimeProbe";
import { scratchStats, trashStats } from "./storage";

/*
 * The settings page's side on the server: what it shows, and the two
 * ways it writes ~/.eesha/settings.json - a simple control's one
 * change, or the whole file from the text box. Either way the new text
 * is checked the way the engine reads it before it is written, so a
 * save can never leave a file every runtime then fails on.
 */

/**
 * The feature flags that change something in Eesha Code. The others
 * (spec documents, the Evaluator) belong to the engine.
 */
export const PAGE_FLAGS = ["Feature-SDD", "handover", "steering", "toolResults", "liveToolOutput", "sessionCost", "hideCopilotPremiumRequests"] as const;

const THEMES: readonly ThemeChoice[] = ["dark", "light", "system"];

function settingsFile(): string {

    return eeshaPath("settings.json");
}

function fileText(): string {

    try {

        return fs.readFileSync(settingsFile(), "utf8");

    } catch {

        return "";
    }
}

/** The merged settings as the engine reads them - from the file, or from `text` in its place. */
function load(text?: string): Promise<EngineSettings> {

    return loadEngineSettings(undefined, {
        profileDir: eeshaHome(),
        ...(text !== undefined ? { readFile: async (file: string) => file === settingsFile() ? text : undefined } : {})
    });
}

/** Every runtime Eesha Code knows, in the default picker order. */
function knownRuntimes(settings: EngineSettings): string[] {

    return [...Providers, ...Object.keys(settings.ai.acpAgents).filter(id => !(Providers as readonly string[]).includes(id))];
}

/**
 * The runtimes the picker shows: `ai.providers` when the file lists
 * them, else the ones found on this machine - the same list the chat's
 * picker offers (see `unlisted` in ServerChatHost.ts).
 */
function shownRuntimes(settings: EngineSettings): string[] {

    return settings.ai.providers ? [...settings.ai.providers] : foundOnly(knownRuntimes(settings), settings.ai.acpAgents, EnvService.machine());
}

/**
 * A runtime added by the person - an `ai.acpAgents` entry of their own,
 * not one built in. Only these can be removed from the settings page.
 */
function isOwnRuntime(id: string): boolean {

    return !(Providers as readonly string[]).includes(id) && !Object.prototype.hasOwnProperty.call(BUILT_IN_ACP_AGENTS, id);
}

/** Why `text` cannot be the settings file, or nothing when it can. */
export async function checkSettingsText(text: string): Promise<string | undefined> {

    let json: Record<string, unknown> | undefined;

    try {

        json = readSettingsJson(text, settingsFile());

    } catch (error) {

        return (error as Error).message;
    }

    const own = serverSettingsFrom(json ?? {});

    if (own.problems.length)
        return own.problems.map(problem => problem.replace(/ - using .*$/, ".")).join(" ");

    try {

        await load(text);

    } catch (error) {

        return (error as Error).message;
    }

    return undefined;
}

/** What the settings page shows. `inUse`: the chats the server holds, whose scratch folders are never counted. */
export async function settingsView(runningPort: number, inUse: ReadonlySet<string>): Promise<SettingsView> {

    const own = readServerSettings(settingsFile());

    const base = {
        file: settingsFile(),
        text: fileText(),
        theme: own.theme,
        fontSize: own.fontSize,
        port: own.port,
        runningPort,
        workingFolders: own.workingFolders,
        runtimeTools: own.runtimes,
        storage: { trash: trashStats(), scratch: scratchStats(inUse) }
    };

    let settings: EngineSettings;

    try {

        settings = await load();

    } catch (error) {

        return { ...base, problem: (error as Error).message, runtimes: [], providersListed: false, flags: [] };
    }

    const listed = settings.ai.providers;
    const known = knownRuntimes(settings);
    const shown = shownRuntimes(settings);
    const start = startRuntime(shown, defaultRuntimeOf(settings));

    // The picker's order: the listed ones as listed, then the rest.
    const order = listed ? [...listed, ...known.filter(id => !listed.includes(id))] : known;

    return {
        ...base,
        runtimes: checkRuntimes(order, settings.ai.acpAgents, EnvService.machine())
            .map(check => ({ ...check, shown: shown.includes(check.id), own: isOwnRuntime(check.id) })),
        providersListed: listed !== undefined,
        ...(start ? { defaultRuntime: start } : {}),
        flags: PAGE_FLAGS.map(name => ({ name, text: FEATURE_FLAGS[name], on: settings.features[name] === true }))
    };
}

/** The SDD module is turned on (`features["Feature-SDD"]`). Off when the settings cannot be read. */
export async function sddModuleOn(): Promise<boolean> {

    try {

        return (await load()).features["Feature-SDD"] === true;

    } catch {

        return false;
    }
}

/** A section of the file as an object to change - a new one when it is missing. */
function section(json: Record<string, unknown>, key: string): Record<string, unknown> {

    const value = json[key];

    return value && typeof value === "object" && !Array.isArray(value) ? { ...value as Record<string, unknown> } : {};
}

/** One change from a simple control, written into settings.json. A problem when it cannot be. */
export async function changeSettings(change: SettingsChange): Promise<{ problem: string } | { ok: true }> {

    let json: Record<string, unknown>;

    try {

        json = readSettingsJson(fileText(), settingsFile()) ?? {};

    } catch (error) {

        return { problem: `${(error as Error).message} Fix it in the text box below first.` };
    }

    if (change.theme !== undefined) {

        if (!THEMES.includes(change.theme))
            return { problem: "The theme is dark, light or system." };

        json.eesha = { ...section(json, "eesha"), theme: change.theme };
    }

    if (change.fontSize !== undefined) {

        if (!isFontSize(change.fontSize))
            return { problem: `The text size is a whole number from ${FONT_SIZE.min} to ${FONT_SIZE.max}.` };

        json.eesha = { ...section(json, "eesha"), fontSize: change.fontSize };
    }

    if (change.port !== undefined) {

        if (!Number.isInteger(change.port) || change.port < 1024 || change.port > 65535)
            return { problem: "The port is a whole number from 1024 to 65535." };

        json.eesha = { ...section(json, "eesha"), port: change.port };
    }

    if (change.workingFolders !== undefined) {

        const problem = workingFoldersProblem(change.workingFolders);

        if (problem)
            return { problem: problem.replace("eesha.workingFolders", "the working folders").replace(/^t/, "T") };

        // Read back the way the server reads it: full paths, each once.
        const folders = serverSettingsFrom({ eesha: { workingFolders: change.workingFolders } }).workingFolders;

        const block = section(json, "eesha");

        if (folders.length)
            block.workingFolders = folders;
        else
            delete block.workingFolders;

        json.eesha = block;
    }

    if (change.runtimeTools !== undefined) {

        const tools = runtimeToolsChange(change.runtimeTools);

        if ("problem" in tools)
            return tools;

        const block = section(json, "eesha");
        const runtimes = section(block, "runtimes");

        if (tools.toolsOff.length)
            runtimes[tools.id] = { toolsOff: tools.toolsOff };
        else
            delete runtimes[tools.id];

        if (Object.keys(runtimes).length)
            block.runtimes = runtimes;
        else
            delete block.runtimes;

        json.eesha = block;
    }

    // The settings as they are now, read once and only when a runtime
    // change needs them.
    let current: EngineSettings | undefined;

    const engine = async (): Promise<EngineSettings | { problem: string }> => {

        try {

            return current ??= await load();

        } catch (error) {

            return { problem: `${(error as Error).message} Fix it in the text box below first.` };
        }
    };

    // The runtimes the picker shows once this change is written.
    let shownAfter: string[] | undefined;

    if (change.providers !== undefined) {

        const providers = change.providers;

        if (!Array.isArray(providers) || providers.some(id => typeof id !== "string") || new Set(providers).size !== providers.length)
            return { problem: "Send the runtimes as a list of ids, each once." };

        if (!providers.length)
            return { problem: "Keep at least one runtime in the picker." };

        const settings = await engine();

        if ("problem" in settings)
            return settings;

        const ai = section(json, "ai");

        // The runtimes found, in the default order: the same as no list,
        // and a runtime installed later shows by itself.
        const found = foundOnly(knownRuntimes(settings), settings.ai.acpAgents, EnvService.machine());

        if (providers.length === found.length && providers.every((id, index) => id === found[index]))
            delete ai.providers;
        else
            ai.providers = providers;

        // Ticking or unticking a runtime never moves the default: with
        // none named, the one in effect now is written down. It also
        // keeps the engine's rule that the list holds ai@1's runtime -
        // without a name that is ghcp, which may not be ticked.
        const before = startRuntime(shownRuntimes(settings), defaultRuntimeOf(settings));

        if (defaultRuntimeOf(settings) === undefined && before && providers.includes(before))
            ai["ai@1"] = { ...section(ai, "ai@1"), provider: before };

        shownAfter = providers;

        if (Object.keys(ai).length)
            json.ai = ai;
        else
            delete json.ai;
    }

    if (change.defaultRuntime !== undefined) {

        const id = change.defaultRuntime;

        if (typeof id !== "string" || !id.trim())
            return { problem: "Send the default runtime's id." };

        const settings = await engine();

        if ("problem" in settings)
            return settings;

        if (!(shownAfter ?? shownRuntimes(settings)).includes(id))
            return { problem: `Tick ${id} first: the default runtime must be one the picker shows.` };

        const ai = section(json, "ai");

        ai["ai@1"] = { ...section(ai, "ai@1"), provider: id };
        json.ai = ai;
    }

    if (change.flag !== undefined) {

        const flag = change.flag as { name?: unknown; on?: unknown } | null;

        if (!flag || typeof flag !== "object" || !(PAGE_FLAGS as readonly unknown[]).includes(flag.name) || typeof flag.on !== "boolean")
            return { problem: "Not a flag this page changes." };

        json.features = { ...section(json, "features"), [flag.name as string]: flag.on };
    }

    return saveSettingsText(JSON.stringify(json, undefined, 2) + "\n");
}

/**
 * Reads settings.json, lets `edit` change it, then checks and writes it
 * the same way a control's change is. `edit` returns a problem to stop
 * without writing. Used by the connectors' choices (connectors/config.ts).
 */
export async function editSettingsJson(edit: (json: Record<string, unknown>) => string | undefined): Promise<{ problem: string } | { ok: true }> {

    let json: Record<string, unknown>;

    try {

        json = readSettingsJson(fileText(), settingsFile()) ?? {};

    } catch (error) {

        return { problem: `${(error as Error).message} Fix settings.json first.` };
    }

    const problem = edit(json);

    if (problem)
        return { problem };

    return saveSettingsText(JSON.stringify(json, undefined, 2) + "\n");
}

/** The whole file from the text box: checked, then written. */
export async function saveSettingsText(text: string): Promise<{ problem: string } | { ok: true }> {

    if (typeof text !== "string")
        return { problem: "Send the file's text." };

    const problem = await checkSettingsText(text);

    if (problem)
        return { problem };

    writeAtomic(settingsFile(), text);

    return { ok: true };
}

/**
 * One runtime's tool settings from the page, checked: a runtime id, and
 * tool names with no comma (the page splits on commas), each once.
 */
function runtimeToolsChange(value: unknown): { problem: string } | { id: string; toolsOff: string[] } {

    const { id, toolsOff } = (value ?? {}) as Record<string, unknown>;

    if (typeof id !== "string" || !RUNTIME_ID.test(id))
        return { problem: "Send the runtime's id." };

    if (!Array.isArray(toolsOff) || !toolsOff.every(one => typeof one === "string" && one.trim() && !one.includes(",")))
        return { problem: "Tools to turn off are tool names, separated by commas." };

    return { id, toolsOff: [...new Set((toolsOff as string[]).map(one => one.trim()))] };
}

/** A runtime's id: letters, digits, dot, dash and underscore, starting with a letter or digit. */
const RUNTIME_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/i;

/**
 * The arguments box's text as a list: split on spaces, with "double
 * quotes" around an argument that holds spaces. Nothing when a quote is
 * left open.
 */
export function splitArgs(text: string): string[] | undefined {

    const args: string[] = [];
    let current = "";
    let quoted = false;
    let started = false;

    for (const char of text) {

        if (char === "\"") {

            quoted = !quoted;
            started = true;

        } else if (/\s/.test(char) && !quoted) {

            if (started)
                args.push(current);

            current = "";
            started = false;

        } else {

            current += char;
            started = true;
        }
    }

    if (quoted)
        return undefined;

    if (started)
        args.push(current);

    return args;
}

/** What the Add runtime form sends - `POST /api/settings/runtime/add`. */
export interface NewRuntime {

    id?: unknown;

    command?: unknown;

    /** The arguments as typed on one line - see {@link splitArgs}. */
    args?: unknown;
}

/** The file as JSON, and the settings as the engine reads them. A problem when either cannot be read. */
async function readBoth(): Promise<{ json: Record<string, unknown>; settings: EngineSettings } | { problem: string }> {

    try {

        return { json: readSettingsJson(fileText(), settingsFile()) ?? {}, settings: await load() };

    } catch (error) {

        return { problem: `${(error as Error).message} Fix it in the text box below first.` };
    }
}

/**
 * Adds a runtime from the settings page: checks it, starts it once to
 * see that it speaks ACP (see runtimeProbe.ts), then writes it into
 * `ai.acpAgents`. When the file lists the runtimes the picker shows
 * (`ai.providers`), the new one goes on the end of that list; with no
 * list it shows by itself, since its program was just found.
 */
export async function addRuntime(input: NewRuntime, probe: typeof probeAcp = probeAcp): Promise<{ problem: string } | { ok: true }> {

    const id = typeof input.id === "string" ? input.id.trim() : "";
    const command = typeof input.command === "string" ? input.command.trim() : "";

    if (!RUNTIME_ID.test(id))
        return { problem: "The id is 1 to 40 letters, digits, dots, dashes or underscores, starting with a letter or a digit - for example my-agent." };

    if (!command)
        return { problem: "Type the command that starts the program - its name on PATH, or its full path." };

    const args = splitArgs(typeof input.args === "string" ? input.args : "");

    if (!args)
        return { problem: "A double quote in the arguments is not closed." };

    const both = await readBoth();

    if ("problem" in both)
        return both;

    const { json, settings } = both;

    if (knownRuntimes(settings).some(known => known.toLowerCase() === id.toLowerCase()))
        return { problem: `There is already a runtime called ${id}. Pick another id.` };

    const env = EnvService.machine();

    // The same lookup as "Found": on PATH, or a file at a full path.
    const [check] = checkRuntimes([id], { [id]: { agent: { command }, source: "settings page" } as never }, env);

    if (!check.found)
        return { problem: `'${command}' is not found on this machine: not on PATH, and not a file at that path.` };

    const answer: ProbeResult = await probe(command, args, env);

    if ("problem" in answer)
        return answer;

    const ai = section(json, "ai");
    const agents = section(ai, "acpAgents");

    agents[id] = { command, ...(args.length ? { args } : {}) };
    ai.acpAgents = agents;

    if (Array.isArray(ai.providers))
        ai.providers = [...ai.providers, id];

    json.ai = ai;

    return saveSettingsText(JSON.stringify(json, undefined, 2) + "\n");
}

/**
 * Removes a runtime the person added (see {@link isOwnRuntime}) from
 * `ai.acpAgents`, and from `ai.providers` when the file lists it. The
 * default runtime cannot be removed - another is picked first.
 */
export async function removeRuntime(id: unknown): Promise<{ problem: string } | { ok: true }> {

    if (typeof id !== "string" || !isOwnRuntime(id))
        return { problem: "Only a runtime you added can be removed." };

    const both = await readBoth();

    if ("problem" in both)
        return both;

    const { json, settings } = both;
    const ai = section(json, "ai");
    const agents = section(ai, "acpAgents");

    if (!Object.prototype.hasOwnProperty.call(agents, id))
        return { problem: `${id} is not in settings.json.` };

    if (startRuntime(shownRuntimes(settings), defaultRuntimeOf(settings)) === id)
        return { problem: `${id} is the default runtime. Pick another default first.` };

    delete agents[id];

    if (Object.keys(agents).length)
        ai.acpAgents = agents;
    else
        delete ai.acpAgents;

    if (Array.isArray(ai.providers))
        ai.providers = ai.providers.filter(one => one !== id);

    if (Object.keys(ai).length)
        json.ai = ai;
    else
        delete json.ai;

    return saveSettingsText(JSON.stringify(json, undefined, 2) + "\n");
}

/**
 * A port nothing listens on right now: the system picks one when asked
 * for port 0. Only a suggestion - the settings page puts it in the box,
 * and it is used from the next start once saved.
 */
export function freePort(): Promise<number> {

    return new Promise((resolve, reject) => {

        const server = net.createServer();

        server.once("error", reject);

        server.listen(0, "127.0.0.1", () => {

            const address = server.address();
            const port = typeof address === "object" && address ? address.port : 0;

            server.close(() => port ? resolve(port) : reject(new Error("The system gave no port.")));
        });
    });
}

import * as fs from "fs/promises";
import { readFileSync } from "fs";
import * as path from "path";

import { Providers } from "../agent/providerArgs";
import { checkProviderBlocks, mergeAiArgs, PROVIDERS_KEY } from "../agent/providerBlocks";
import { SETTINGS_FILE, WORKFLOWS_DIR } from "../loader/constants";
import { profileDirectory } from "../loader/profilePaths";
import {
    ConfigTemplating, resolveAnchorsOnly, resolveConfigValue, resolveVariables
} from "../templating/configScope";
import { RESERVED_NAMES } from "../templating/TemplateResolver";

/*
 * `settings.json` - the engine's one configuration file.
 *
 * Read from at most two places, most specific last:
 *
 *   1. `~/.eesha/settings.json`        - the person's
 *   2. `<workspaceFolder>/.eesha/settings.json` - the team's,
 *      committed and reviewed in PRs
 *
 * Merged per key, profile wins: when both files set the same key, the
 * person's own value is used. Whole-file-wins would make a person's
 * servers vanish the moment a repo commits any settings file.
 *
 * Every field has a default and both files are optional.
 *
 * A malformed file fails loudly, naming itself. The one silent path is
 * absence: a scope that declares nothing is the normal case.
 */

/**
 * The `sdd:` section, structurally loose on purpose. SDD validates its
 * own keys in `sddConfig.ts`; this layer only guarantees the section is
 * a mapping.
 */
export type SddSection = Record<string, unknown>;

/** The `env:` section - what `${{ env.NAME }}` may read. Deny wins. */
export interface EnvSettings {

    allowed: string[];

    denied: string[];
}

/** The `ai:` section, split into its two roles. */
export interface AiSettings {

    /**
     * Per-plugin defaults, keyed by plugin reference - `"ai@1"`,
     * verbatim. What a plugin's args start from before a stage or task
     * says anything of its own.
     */
    defaults: Record<string, Record<string, unknown>>;

    /**
     * Which settings file supplied each default, mirroring `defaults`
     * key for key, so a log can name the file that set a value.
     */
    defaultSources: Record<string, Record<string, string>>;

    /**
     * Which of the two scopes supplied each default, mirroring
     * `defaults` key for key, so a log tag can say `ws` or `up`.
     */
    defaultScopes: Record<string, Record<string, "workspace" | "profile">>;

    /**
     * {@link defaults}, one file at a time - what each scope declared,
     * before the merge. SDD reads these apart because a style sits
     * between them: the team's workspace file, then the style, then the
     * person's profile file.
     */
    scopedDefaults?: {
        workspace: Record<string, Record<string, unknown>>;
        profile: Record<string, Record<string, unknown>>;
    };

    /**
     * `ai.providers` - the runtimes this org uses, in the order the
     * runtime picker shows them. Every id is a known runtime (ghcp,
     * claude, an `ai.acpAgents` id), checked when the settings load.
     * Absent when neither file declares it: every known runtime is on
     * offer. The profile's list replaces the workspace's whole.
     */
    providers?: string[];

    /**
     * MCP server declarations, standard `mcpServers` entry shape plus
     * the one engine key, `disabled`. Which tools a session gets is
     * chosen per task - `ai@1`'s `mcp:` arg. Each entry keeps the path
     * of the file that declared it, for error messages.
     */
    mcpServers: Record<string, SourcedServer>;

    /**
     * ACP agent declarations, keyed by the id a task's `provider:` names.
     * Each names the command that speaks the Agent Client Protocol on
     * stdio - `{ command, args?, env? }`. Validated by `AcpProvider`;
     * this layer only carries them with their source file.
     */
    acpAgents: Record<string, SourcedAcpAgent>;
}

/** A server declaration plus which settings file said it. */
export interface SourcedServer {

    server: unknown;

    /** The declaring file's path, for error messages. */
    source: string;
}

/**
 * The ACP agents every build ships, so `provider: kiro-cli` works with
 * nothing under `ai.acpAgents` - the same way `ghcp` and `claude` work
 * with nothing at all. Each id ends in `-cli` because that is what a
 * person recognises; "acp" is not a term everyone knows.
 *
 * A settings file that declares the same id replaces the entry
 * wholesale, exactly as a workspace entry replaces a profile one -
 * except `extensions`: an entry that leaves it out keeps the built-in
 * one's (see `resolveAcpAgent`), so replacing Kiro's command does not
 * silently switch off its credits and context meter.
 *
 * `kiro-cli-v3` is Kiro's v3 engine, a beta behind the same binary. It
 * speaks ACP with different extras from v2, hence its own extension.
 */
export const BUILT_IN_ACP_AGENTS: Readonly<Record<string, { command: string; args?: string[]; extensions?: string[] }>> = {
    "kiro-cli": { command: "kiro-cli", args: ["acp"], extensions: ["kiro-v2"] },
    "kiro-cli-v3": { command: "kiro-cli", args: ["acp", "--agent-engine", "v3", "--auth-method", "cli"], extensions: ["kiro-v3"] },
    // `--disallow-temp-dir`: Copilot otherwise lets a tool into the system
    // temp folder without asking, so the folder boundary never sees it.
    "copilot-cli": { command: "copilot", args: ["--acp", "--stdio", "--disallow-temp-dir"], extensions: ["copilot-cli"] },
    "claude-cli": { command: "claude-agent-acp", extensions: ["claude-cli"] },
    "gemini-cli": { command: "gemini", args: ["--acp"] },
    "codex-cli": { command: "codex-acp" },
    "cursor-cli": { command: "cursor-agent", args: ["acp"] },
    "opencode-cli": { command: "opencode", args: ["acp"] }
};

/** The `source` tag a {@link BUILT_IN_ACP_AGENTS} entry carries. */
export const BUILT_IN_SOURCE = "built-in";

/** An ACP agent declaration plus which settings file said it. */
export interface SourcedAcpAgent {

    agent: unknown;

    /** The declaring file's path, or `built-in`, for error messages. */
    source: string;
}

/**
 * Every feature flag the engine knows, with what it does.
 *
 * A flag lets a feature ship on its own switch: the code is in the
 * build and a person decides for themselves. Most start off - that is
 * how something half-finished or risky ships dark - and one that has
 * earned its place starts on instead, which is what
 * {@link FEATURES_ON_BY_DEFAULT} names. Listing them here is what makes
 * a typo in the file an error instead of a switch that silently never
 * fires.
 *
 * Adding one: a line here, a line in the JSON schema, and the reader
 * asks `settings.features.<name>`. Removing one: delete the line and
 * every read - a file that still names it then fails loudly, which is
 * the point.
 */
export const FEATURE_FLAGS = {

    /**
     * Show a shell command's output under its tool row while it is
     * still running, instead of only when the call ends.
     */
    liveToolOutput: "Stream a running tool's output into its row in the log.",

    /**
     * Put money - dollars, or another currency an ACP agent names - in
     * the usage card. Copilot's credits and premium requests are an
     * allowance rather than a sum anybody is charged, so they show
     * either way; see `QUOTA_UNITS`.
     *
     * Off for everyone by default. The figures are recorded either
     * way - this only decides whether they are drawn - so turning it
     * on shows the whole history back, including the runs made while
     * it was off.
     */
    sessionCost: "Show what a session cost in money, not just in credits, in the usage card.",

    /**
     * The "What changed" button on a spec document, and the red-and-green
     * view behind it.
     *
     * On by default. Off, the button is not offered and the document is
     * read as it stands.
     */
    docDiff: "Offer \"What changed\" on a spec document - the last run's changes in red and green.",

    /**
     * Steering files: `.md` files whose header says `inclusion:`, handed
     * to AI chats - `always` on every new chat, `fileMatch` on an SDD
     * implement wave whose `Files:` lines match, tagged ones through the
     * `steering` tool, `manual` ones on `@name` in a compose box. See
     * `core/agent/steering`.
     *
     * Off by default. Off, no file is looked for and no chat gets the
     * `steering` tool.
     */
    steering: "Hand the project's steering files (.md files with an 'inclusion:' header) to AI chats.",

    /**
     * Leave Copilot's premium requests out of what a call charged, and
     * keep its credits only. Copilot's usage event carries both whatever
     * plan the account is on - premium requests are the unit of a
     * fixed-quota plan, credits of a usage-billed one - so one of the two
     * is always a figure the account is not billed in.
     *
     * On by default. Off, both are recorded. Only calls made
     * while it is on lose the figure: history keeps what it recorded.
     */
    hideCopilotPremiumRequests: "Record only Copilot's credits, not its premium requests, for what a call charged.",

    /**
     * The Handover button. It moves a
     * started chat to another runtime: it saves the conversation as a
     * Markdown file and starts a new session that reads it.
     *
     * On by default. Off, the button is not offered. A started chat's
     * runtime picker is locked either way, so with the flag off the only
     * way to another runtime is New Session, which starts empty.
     */
    handover: "Offer a Handover button that moves a started chat to another runtime, through a saved file the new runtime reads.",

    /**
     * Show what a finished tool call returned when its card is opened.
     * The providers keep only a short, one-line start of the result, so
     * the card says when the text was cut.
     *
     * Off by default. Off, a finished card shows only whether the call
     * worked and how long it took; a failed one still shows why.
     */
    toolResults: "Show what a finished tool call returned when its card in the chat is opened.",

    /**
     * The Evaluator page. It runs one
     * built-in eval set on several runtimes and models at once, tests
     * what each one built, and reports accuracy, time and usage side by
     * side.
     *
     * Off by default. Off, the command that opens the page is hidden.
     * Reports already saved stay on disk.
     */
    evals: "Offer the Evaluator page, which runs a built-in eval set on several runtimes and compares the results.",

    /**
     * The fake runtime - see `FakeProvider`. It calls no model and costs
     * nothing: it writes sample drafts, asks one question, and ticks
     * the tasks handed to it. For tests and for trying SDD by hand.
     *
     * Off by default. On, "fake" is added to the runtimes the pickers
     * offer.
     */
    fakeRuntime: "Offer a fake runtime that calls no model and costs nothing. It writes sample drafts, asks one question and ticks tasks. For testing only.",

    /**
     * The SDD module in Eesha Code. The name
     * is chosen so that it does not look like the `sdd:`
     * settings block.
     *
     * Off by default. Off, the SDD icon is not on the left strip and an
     * /sdd address goes to the start page. Only hidden: specs on disk,
     * the `sdd:` block and the server's SDD routes are not touched.
     */
    "Feature-SDD": "Show the SDD module in Eesha Code: the Spec explorer, the Specs item on a workspace's menu, and the /sdd pages."
} as const;

/** The `features:` section - every known flag, on or off. @see FEATURE_FLAGS */
export type FeatureFlags = { -readonly [Flag in keyof typeof FEATURE_FLAGS]: boolean };

/**
 * The flags that start on rather than off.
 *
 * A flag stays here once its feature is the way the panel is meant to
 * work and the switch is kept only so somebody can go back. Everything
 * not named here is off until a profile says otherwise.
 */
const FEATURES_ON_BY_DEFAULT: readonly (keyof FeatureFlags)[] = ["docDiff","hideCopilotPremiumRequests"
    , "handover"
];

/**
 * What a file that declares no `features` means: every flag at its own
 * default. @see FEATURES_ON_BY_DEFAULT
 */
export function defaultFeatures(): FeatureFlags {

    return Object.fromEntries(
        Object.keys(FEATURE_FLAGS).map(
            name => [name, FEATURES_ON_BY_DEFAULT.includes(name as keyof FeatureFlags)])) as FeatureFlags;
}

export interface EngineSettings {

    sdd: SddSection;

    ai: AiSettings;

    env: EnvSettings;

    /**
     * Folders the workspace scan skips when the repository has no
     * `.gitignore` to say so itself. Names, not globs.
     */
    ignore: string[];

    /**
     * The `variables` section, both scopes merged one leaf at a time
     * and every expression in it settled. Each top-level key is read
     * bare - `${{ Team.Name }}` - from any file the engine resolves.
     */
    variables: Record<string, unknown>;

    /**
     * One line per leaf the profile file overrode in the workspace
     * file, naming the leaf and both files. For a log: the person
     * wrote a value and sees another, and this says why.
     */
    variableOverrides: string[];

    /**
     * The person's own debug switch. `false` unless the profile file
     * says otherwise.
     *
     * It also takes the directory limit off an ai@1 session: normally
     * an agent is held to its `cwd` and the workspace's open folders (see
     * `pathJail.ts`); with this on it may read and write anywhere the
     * person can, and the shell sandbox goes off. The session logs it.
     *
     * Profile scope only, which is what makes that safe: the file
     * cannot arrive with a clone, so a repository cannot unlock its own
     * limits. A workspace file that declares it is an error - see
     * `parseDeclared`.
     */
    debug: boolean;

    /**
     * The feature flags this run has on - every known flag, with
     * its own default for any neither file named. @see FEATURE_FLAGS
     *
     * Either file may set them, so a team can turn a feature on for
     * everyone in a repository. Merged per flag, profile winning.
     */
    features: FeatureFlags;
}

/**
 * One file's declarations - only what it actually says, so the merge
 * can tell "declared empty" from "not declared".
 */
export interface DeclaredSettings {

    source: string;

    sdd?: SddSection;

    aiDefaults?: Record<string, Record<string, unknown>>;

    mcpServers?: Record<string, unknown>;

    acpAgents?: Record<string, unknown>;

    /** `ai.providers` as this file wrote it. @see AiSettings.providers */
    providers?: string[];

    envAllowed?: string[];

    envDenied?: string[];

    ignore?: string[];

    /** The file's `variables` section as written - nested, top-level names checked. */
    variables?: Record<string, unknown>;

    /** Profile scope only. @see EngineSettings.debug */
    debug?: boolean;

    /** Only the flags the file named. @see EngineSettings.features */
    features?: Partial<FeatureFlags>;
}

/**
 * The scan fallback when no `.gitignore` exists - the usual build
 * output and tool folders. Replaceable per scope via
 * `defaultFoldersToIgnoreScanning`.
 */
export const DEFAULT_IGNORED_FOLDERS: readonly string[] = [
    "node_modules", ".git", ".vscode", ".idea", "TestResults",
    "bin", "obj", "dist", "out", "coverage", "build", "target",
    "logs", "tmp", "temp"
];

/** `<workspaceFolder>/.eesha` - where the team's settings.json lives. */
export function workspaceConfigOf(workspaceFolder: string): string {

    return path.join(workspaceFolder, WORKFLOWS_DIR);
}

export interface LoadSettingsOptions {

    /** Injected so tests never read the real home directory. */
    profileDir?: string;

    /** Reads a file, or undefined when there is no such file. Injected so a test never touches a disk. */
    readFile?: (filePath: string) => Promise<string | undefined>;

    /** What `${{ home }}` resolves to. Defaults to the real home directory. */
    home?: string;

    /** The machine environment `${{ env.NAME }}` reads. Injected only by tests. */
    processEnv?: Record<string, string | undefined>;
}

/**
 * The settings a run under `workspaceFolder` gets: both scopes read,
 * parsed, merged, defaults applied.
 *
 * `workspaceFolder` may be undefined - the profile scope is still read.
 */
/**
 * The profile's `debug` flag alone, read synchronously.
 *
 * For the one reader that cannot wait: the plugin registry is built
 * synchronously at startup, and whether user plugins are sandboxed is
 * decided there. Only the profile can declare `debug` (see
 * `parseDeclared`), so only that file is read. Anything unreadable or
 * malformed reads as false - the safe answer.
 */
export function profileDebugFlag(profileDir = profileDirectory()): boolean {

    try {

        const json = JSON.parse(readFileSync(path.join(profileDir, SETTINGS_FILE), "utf8")) as { debug?: unknown };

        return json?.debug === true;

    } catch {

        return false;
    }
}

export async function loadEngineSettings(
    workspaceFolder: string | undefined,
    options: LoadSettingsOptions = {}
): Promise<EngineSettings> {

    const read = options.readFile ?? readFileOrUndefined;

    const profilePath = path.join(options.profileDir ?? profileDirectory(), SETTINGS_FILE);

    const workspacePath = workspaceFolder
        ? path.join(workspaceConfigOf(workspaceFolder), SETTINGS_FILE)
        : undefined;

    const [profileText, workspaceText] = await Promise.all([
        read(profilePath),
        workspacePath ? read(workspacePath) : Promise.resolve(undefined)
    ]);

    const profileJson = profileText !== undefined ? readJson(profileText, profilePath) : undefined;

    const workspaceJson = workspaceText !== undefined && workspacePath
        ? readJson(workspaceText, workspacePath)
        : undefined;

    /*
     * The deny list is read from the raw JSON of both scopes before
     * either file resolves: the veto must be known before any
     * `${{ env.X }}` resolves, and a personal deny has to hold while
     * the workspace file resolves.
     */
    const templating: ConfigTemplating = {
        workspaceFolder,
        home: options.home,
        processEnv: options.processEnv,
        denied: [...deniedIn(profileJson), ...deniedIn(workspaceJson)]
    };

    /*
     * The variables are settled first, from the raw JSON of both
     * scopes, because every other value in either file may read them.
     * Merged before settling, so a profile variable can be built from a
     * workspace one and the other way round. Checked here with the same
     * rules `parseDeclared` applies, so a bad name fails naming its
     * file before anything reads it.
     */
    const declaredVariables = [
        profileJson?.variables !== undefined ? variablesOf(profileJson.variables, profilePath) : undefined,
        workspaceJson?.variables !== undefined && workspacePath
            ? variablesOf(workspaceJson.variables, workspacePath)
            : undefined
    ];

    if (declaredVariables.some(Boolean))
        templating.variables = resolveVariables(
            mergeVariables(declaredVariables[0], declaredVariables[1]).variables,
            `'variables' in ${[profilePath, workspacePath].filter(Boolean).map(one => `'${one}'`).join(" / ")}`,
            templating);

    return mergeEngineSettings(
        profileJson !== undefined
            ? parseDeclared(
                resolved(profileJson, profilePath, templating), profilePath, "profile")
            : undefined,
        workspaceJson !== undefined && workspacePath
            ? parseDeclared(
                resolved(workspaceJson, workspacePath, templating), workspacePath, "workspace")
            : undefined);
}

/**
 * One file with its expressions resolved - all of them, except the env
 * reads inside `ai.mcpServers` and `ai.acpAgents`.
 *
 * Those go through the env gate, whose grants include a task's own
 * (`allowedEnv:`, the workflow's `env:` block), which do not exist when
 * a settings file is read. So those subtrees get their anchors and keep
 * their env reads; `resolveMcpServers` / `AcpProvider` answer them
 * later, under the gate.
 */
function resolved(
    json: Record<string, unknown>,
    source: string,
    templating: ConfigTemplating
): Record<string, unknown> {

    const ai = json.ai;

    const isSection = !!ai && typeof ai === "object" && !Array.isArray(ai);

    const servers = isSection ? (ai as Record<string, unknown>).mcpServers : undefined;
    const acpAgents = isSection ? (ai as Record<string, unknown>).acpAgents : undefined;

    if (servers === undefined && acpAgents === undefined)
        return resolveConfigValue(json, source, templating);

    // Deleted rather than set to `undefined`: `parseDeclared` reads
    // "declared" from the key being present.
    const withoutDeferred = { ...(ai as Record<string, unknown>) };

    delete withoutDeferred.mcpServers;
    delete withoutDeferred.acpAgents;

    const rest = resolveConfigValue({ ...json, ai: withoutDeferred }, source, templating);

    return {
        ...rest,
        ai: {
            ...(rest.ai as Record<string, unknown>),
            ...(servers !== undefined
                ? { mcpServers: resolveAnchorsOnly(servers, source, templating) }
                : {}),
            ...(acpAgents !== undefined
                ? { acpAgents: resolveAnchorsOnly(acpAgents, source, templating) }
                : {})
        }
    };
}

/**
 * `env.denied` as a file declares it, before resolution.
 *
 * Forgiving where {@link parseDeclared} is strict: this runs before
 * validation, so a malformed list must fall through to the real error.
 * A name written as an expression is skipped - a deny list cannot gate
 * its own resolution.
 */
function deniedIn(json: Record<string, unknown> | undefined): string[] {

    const env = json?.env;

    if (!env || typeof env !== "object" || Array.isArray(env))
        return [];

    const denied = (env as Record<string, unknown>).denied;

    if (!Array.isArray(denied))
        return [];

    return denied.filter(
        (name): name is string => typeof name === "string" && !name.includes("${{"));
}

/**
 * The valid top-level keys, for the error that names them.
 *
 * `eesha` (port and theme) is read by the server at start-up, from
 * ~/.eesha/settings.json. This parser reads the same file for
 * everything else, so it must let the key through. It reads nothing in
 * it.
 */
const TOP_KEYS = ["sdd", "ai", "env", "variables", "defaultFoldersToIgnoreScanning", "debug", "features", "eesha"] as const;

/** Which of the two files is being read - only `debug` cares. */
export type SettingsScope = "profile" | "workspace";

/**
 * One file's text into its declarations. Loud on everything except a
 * key simply not being there. Unknown top-level keys are errors: a
 * misspelled `env` that silently gates nothing looks applied and is not.
 */
export function parseEngineSettings(
    text: string,
    source: string,
    scope: SettingsScope = "profile"
): DeclaredSettings {

    const json = readJson(text, source);

    return json === undefined ? { source } : parseDeclared(json, source, scope);
}

/**
 * The file's JSON, and nothing more - no key is judged here.
 *
 * Split from {@link parseDeclared} because `${{ }}` resolution sits
 * between the two: expressions are substituted before any key is
 * validated. Undefined for an empty file, which is the one silent path.
 */
export function readJson(text: string, source: string): Record<string, unknown> | undefined {

    if (!text.trim())
        return undefined;

    let parsed: unknown;

    try {

        parsed = JSON.parse(text);

    } catch (error) {

        throw new Error(
            `'${source}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}. ` +
            "Plain JSON only - no comments.");
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error(`'${source}' must be a JSON object of settings sections.`);

    return parsed as Record<string, unknown>;
}

/** One file's parsed JSON into its declarations. @see parseEngineSettings */
export function parseDeclared(
    config: Record<string, unknown>,
    source: string,
    scope: SettingsScope = "profile"
): DeclaredSettings {

    for (const key of Object.keys(config))
        if (!(TOP_KEYS as readonly string[]).includes(key))
            throw new Error(
                `'${source}' has an unknown setting '${key}'. ` +
                `Valid sections: ${TOP_KEYS.join(", ")}.`);

    const declared: DeclaredSettings = { source };

    if (config.sdd !== undefined)
        declared.sdd = mapping(config.sdd, "sdd", source);

    if (config.ai !== undefined) {

        const ai = mapping(config.ai, "ai", source);

        const defaults: Record<string, Record<string, unknown>> = {};

        for (const [key, value] of Object.entries(ai)) {

            if (key === "mcpServers") {

                declared.mcpServers = mapping(value, "ai.mcpServers", source);

                continue;
            }

            if (key === "acpAgents") {

                declared.acpAgents = mapping(value, "ai.acpAgents", source);

                continue;
            }

            // The runtimes this org uses. Shape and duplicates here; the
            // ids are checked after the merge, when every `acpAgents`
            // entry of both files is known.
            if (key === PROVIDERS_KEY) {

                const ids = names(value, "ai.providers", source);

                const twice = ids.find((id, index) => ids.indexOf(id) !== index);

                if (twice)
                    throw new Error(`'${source}' lists '${twice}' twice in ai.providers.`);

                declared.providers = ids;

                continue;
            }

            // Every other key is a plugin reference with that plugin's
            // default args - `"ai@1": { "model": "auto" }`.
            defaults[key] = mapping(value, `ai.${key}`, source);

            // Shape only here. Whether each id is a registered runtime
            // needs both files' `acpAgents`, so it is checked after the
            // merge.
            if (defaults[key][PROVIDERS_KEY] !== undefined)
                checkProviderBlocks(defaults[key][PROVIDERS_KEY], `'${source}' ai.${key}`);
        }

        if (Object.keys(defaults).length)
            declared.aiDefaults = defaults;
    }

    if (config.env !== undefined) {

        const env = mapping(config.env, "env", source);

        for (const key of Object.keys(env))
            if (key !== "allowed" && key !== "denied")
                throw new Error(
                    `'${source}' has an unknown key 'env.${key}'. Valid: allowed, denied.`);

        if (env.allowed !== undefined)
            declared.envAllowed = names(env.allowed, "env.allowed", source);

        if (env.denied !== undefined)
            declared.envDenied = names(env.denied, "env.denied", source);
    }

    if (config.variables !== undefined)
        declared.variables = variablesOf(config.variables, source);

    if (config.defaultFoldersToIgnoreScanning !== undefined)
        declared.ignore = names(
            config.defaultFoldersToIgnoreScanning, "defaultFoldersToIgnoreScanning", source);

    if (config.debug !== undefined) {

        /*
         * The one key the workspace file may not set. Refused rather
         * than ignored, so it never reads as applied when it is not.
         */
        if (scope === "workspace")
            throw new Error(
                `'${source}' sets 'debug', which is a personal setting. ` +
                "Put it in your profile file, '~/.eesha/settings.json'.");

        if (typeof config.debug !== "boolean")
            throw new Error(`'${source}': 'debug' must be true or false.`);

        declared.debug = config.debug;
    }

    if (config.features !== undefined)
        declared.features = featuresOf(config.features, source);

    return declared;
}

/**
 * The `features:` section of one file, checked: a mapping, only flags
 * this build knows, and every value a boolean.
 *
 * Loud on an unknown name on purpose. A flag that is spelt wrong
 * would otherwise read as set and do nothing.
 */
function featuresOf(value: unknown, source: string): Partial<FeatureFlags> {

    const features = mapping(value, "features", source);

    const known = Object.keys(FEATURE_FLAGS);

    const declared: Partial<FeatureFlags> = {};

    for (const [name, flag] of Object.entries(features)) {

        if (!known.includes(name))
            throw new Error(
                `'${source}' has an unknown feature flag 'features.${name}'. ` +
                `Valid flags: ${known.join(", ")}.`);

        if (typeof flag !== "boolean")
            throw new Error(`'${source}': 'features.${name}' must be true or false.`);

        declared[name as keyof FeatureFlags] = flag;
    }

    return declared;
}

/**
 * Two scopes into the settings consumers read. Per key, profile wins -
 * a key the person set in their own file beats the workspace file:
 *
 *   - `sdd`: per field.
 *   - `ai` plugin defaults: per plugin, args merged per key.
 *   - `ai.mcpServers`: per server name, entry wholesale - half a server
 *     declaration merged from two files is nobody's intent.
 *   - `ai.acpAgents`: per agent id, entry wholesale, starting from
 *     `BUILT_IN_ACP_AGENTS`.
 *   - `env.allowed` / `env.denied`: the union.
 *   - `variables`: per leaf, however deep, profile winning a clash
 *     and each clash noted - see {@link mergeVariables}.
 *   - ignore list: the union.
 *   - `debug`: the profile's, or false. The workspace never sets it.
 *   - `features`: per flag, over each flag's own default.
 */
export function mergeEngineSettings(
    profile?: DeclaredSettings,
    workspace?: DeclaredSettings
): EngineSettings {

    const sdd = mergeSdd(profile?.sdd, workspace?.sdd);

    const defaults: Record<string, Record<string, unknown>> = {};

    const defaultSources: Record<string, Record<string, string>> = {};

    const defaultScopes: Record<string, Record<string, "workspace" | "profile">> = {};

    for (const scope of [workspace, profile])
        for (const [plugin, args] of Object.entries(scope?.aiDefaults ?? {})) {

            // `providers` per runtime and per key, like every other key
            // is per key - a person's `providers.ghcp.model` must not
            // wipe the team's `providers.kiro-cli`.
            defaults[plugin] = mergeAiArgs(defaults[plugin], args);

            for (const name of Object.keys(args)) {

                (defaultSources[plugin] ??= {})[name] = scope!.source;
                (defaultScopes[plugin] ??= {})[name] = scope === profile ? "profile" : "workspace";
            }
        }

    const mcpServers: Record<string, SourcedServer> = {};

    for (const scope of [workspace, profile])
        for (const [name, server] of Object.entries(scope?.mcpServers ?? {}))
            mcpServers[name] = { server, source: scope!.source };

    const acpAgents: Record<string, SourcedAcpAgent> = {};

    for (const [name, agent] of Object.entries(BUILT_IN_ACP_AGENTS))
        acpAgents[name] = { agent, source: BUILT_IN_SOURCE };

    for (const scope of [workspace, profile])
        for (const [name, agent] of Object.entries(scope?.acpAgents ?? {}))
            acpAgents[name] = { agent, source: scope!.source };

    const { variables, overrides } = mergeVariables(
        profile?.variables, workspace?.variables, profile?.source, workspace?.source);

    // The profile's list replaces the workspace's whole - a person with
    // a runtime of their own writes the full list they want offered.
    const providers = profile?.providers ?? workspace?.providers;

    if (providers)
        checkProviderList(providers, [...new Set([...Providers, ...Object.keys(acpAgents)])], defaults,
            (profile?.providers ? profile : workspace)!.source);

    return {
        sdd,
        ai: {
            defaults,
            defaultSources,
            defaultScopes,
            scopedDefaults: {
                workspace: workspace?.aiDefaults ?? {},
                profile: profile?.aiDefaults ?? {}
            },
            ...(providers ? { providers } : {}),
            mcpServers,
            acpAgents
        },
        env: {
            allowed: union(profile?.envAllowed, workspace?.envAllowed),
            denied: union(profile?.envDenied, workspace?.envDenied)
        },
        variables,
        variableOverrides: overrides,
        ignore: profile?.ignore || workspace?.ignore
            ? union(profile?.ignore, workspace?.ignore)
            : [...DEFAULT_IGNORED_FOLDERS],
        debug: profile?.debug ?? false,
        features: { ...defaultFeatures(), ...workspace?.features, ...profile?.features }
    };
}

/**
 * The `variables` section of one file, checked: a mapping, and no
 * top-level name that an expression already resolves. `${{ home }}`
 * declared here would either shadow the anchor or be shadowed by it,
 * and both are a value nobody meant.
 */
function variablesOf(value: unknown, source: string): Record<string, unknown> {

    const variables = mapping(value, "variables", source);

    for (const name of Object.keys(variables))
        if (RESERVED_NAMES.includes(name))
            throw new Error(
                `'${source}' declares a variable named '${name}', which \${{ ${name} }} already `
                + "means. Pick another name.");

    return variables;
}

/**
 * Two `variables` sections into one, leaf by leaf.
 *
 * Where both files have a mapping under the same key the merge goes
 * one level deeper, so a profile can carry `Team.Repo` while the
 * workspace carries `Team.Name`. Where they hold anything else - two
 * values, a value against a mapping, two lists - the profile wins
 * the key wholesale, and that is a clash worth a line: the person
 * reads one file and sees the other's value.
 */
export function mergeVariables(
    profile: Record<string, unknown> | undefined,
    workspace: Record<string, unknown> | undefined,
    profileSource = "profile",
    workspaceSource = "workspace"
): { variables: Record<string, unknown>; overrides: string[] } {

    const overrides: string[] = [];

    const isMapping = (value: unknown): value is Record<string, unknown> =>
        !!value && typeof value === "object" && !Array.isArray(value);

    const merge = (
        under: Record<string, unknown>,
        over: Record<string, unknown>,
        at: string
    ): Record<string, unknown> => {

        const merged: Record<string, unknown> = { ...under };

        for (const [key, value] of Object.entries(over)) {

            const here = at ? `${at}.${key}` : key;

            if (isMapping(merged[key]) && isMapping(value)) {

                merged[key] = merge(merged[key], value, here);

                continue;
            }

            if (Object.prototype.hasOwnProperty.call(under, key))
                overrides.push(
                    `variables.${here}: '${profileSource}' overrides '${workspaceSource}'.`);

            merged[key] = value;
        }

        return merged;
    };

    return { variables: merge(workspace ?? {}, profile ?? {}, ""), overrides };
}

/**
 * `sdd` per field - profile wins each key. Flat: every field is a
 * scalar. A stage's `ai:` lives in `style.yml`, and a style is shadowed
 * as a whole file rather than merged.
 */
function mergeSdd(profile?: SddSection, workspace?: SddSection): SddSection {

    return { ...workspace, ...profile };
}


function union(first?: readonly string[], second?: readonly string[]): string[] {

    return [...new Set([...(first ?? []), ...(second ?? [])])];
}

function mapping(value: unknown, what: string, source: string): Record<string, unknown> {

    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(`'${source}': '${what}' must be a mapping.`);

    return value as Record<string, unknown>;
}

/**
 * `ai.providers` checked against what this build can run: every id a
 * known runtime, and each plugin's default runtime on the list - a
 * default nobody may pick would be the one runtime every phase starts
 * on. A plugin default naming no `provider` runs on ai@1's own, `ghcp`.
 */
function checkProviderList(
    providers: string[],
    known: string[],
    defaults: Record<string, Record<string, unknown>>,
    source: string
): void {

    const unknown = providers.filter(id => !known.includes(id));

    if (unknown.length)
        throw new Error(
            `'${source}' lists ${unknown.map(id => `'${id}'`).join(", ")} in ai.providers, which this build `
            + `cannot run. Known runtimes: ${known.join(", ")}. An ACP agent of your own goes under ai.acpAgents first.`);

    const runtime = (defaults["ai@1"]?.provider as string | undefined)?.trim() || "ghcp";

    if (!providers.includes(runtime))
        throw new Error(
            `'${source}' lists ai.providers without '${runtime}', the runtime ai@1 starts on`
            + (defaults["ai@1"]?.provider ? "" : " when nothing names one")
            + `. Add it to the list, or set ai."ai@1".provider to one of: ${providers.join(", ")}.`);
}

function names(value: unknown, what: string, source: string): string[] {

    if (!Array.isArray(value) || value.some(item => typeof item !== "string"))
        throw new Error(`'${source}': '${what}' must be a list of names.`);

    return value as string[];
}

async function readFileOrUndefined(filePath: string): Promise<string | undefined> {

    try {

        return await fs.readFile(filePath, "utf8");

    } catch (error) {

        if ((error as NodeJS.ErrnoException).code === "ENOENT")
            return undefined;

        throw new Error(
            `Could not read '${filePath}': ${error instanceof Error ? error.message : String(error)}`);
    }
}

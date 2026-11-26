/**
 * SDD's configuration, read from the `sdd:` section of `settings.json`.
 *
 * A setting belongs here when changing it needs no understanding of the
 * engine. Stage shape, gates and what a phase is handed are the style's.
 *
 * AI settings live in two places: a style's stage may declare `ai:`,
 * and this section's defaults sit under it. {@link aiFor} merges the two
 * per key. `uses` stays here alone - which plugin runs a phase is a
 * deployment decision, and a style naming one would not run for a team
 * using another.
 *
 * Every field has a default and the section is optional, so a fresh
 * install works with nothing written.
 *
 * These settings never reach an AI. The engine reads them and hands each
 * phase only the values it needs.
 *
 * The settings loader only guarantees `sdd:` is a mapping; the meaning
 * of every key is validated here, where the error can name the valid
 * choices.
 */

import type { AiSource } from "../../shared/runMessages";
import { Providers } from "../../core/agent/providerArgs";
import { applyProviderBlock, refuseUnknownProviders } from "../../core/agent/providerBlocks";

/** Where the work item behind a spec comes from. These are what this build can read, not a style's choice. */
export const Sources = ["manual", "ado", "gh", "file"] as const;

export type Source = typeof Sources[number];

/**
 * What runs an `ai` stage.
 *
 * `args` is untyped on purpose. The plugin declares its own input
 * schema, so a new provider option passes through without a schema
 * change here.
 */
export interface AiSettings {

    /** A plugin reference, e.g. `ai@1`. */
    uses: string;

    args: Record<string, unknown>;
}

/**
 * A runtime and model that beat every file - settings, the style and a
 * stage that pins its own. Two things make one: a chat's own pick in
 * its compose box, and the runtime a phase's chat is already on when
 * the files now name another (a session id belongs to the runtime
 * that issued it). Phases have no pick of their own: style.yml and
 * settings.json decide.
 *
 * `model` is absent when only the runtime was picked. The model then
 * comes from the files as for any other run on that runtime: its
 * `providers:` block where one names a model, else the flat `model:`,
 * else `auto`. A model the runtime does not offer fails the run, naming
 * what it does offer.
 *
 * A pick of a runtime not in `ai.providers` - the list changed since it
 * was made - is ignored, and the files decide.
 */
export interface AiPick {

    provider: string;

    model?: string;

    /**
     * The agent's own mode (Kiro v3's `spec`, `plan`...), picked in the
     * compose box. Belongs to `provider` like `model` does, so picking a
     * new runtime drops it. Only the pick sets it - no file does.
     */
    mode?: string;

    /** How hard the model thinks (`low`...`max`), picked in the compose box. Belongs to `provider` like `mode`. */
    effort?: string;
}

/**
 * Args the engine writes itself, refused wherever a person can write one.
 *
 * {@link src/sdd/phase/runPhase} writes these five over whatever it was
 * handed, and both ways that goes wrong are silent. `prompt`, `title`
 * and `attachments` are always overwritten, so a value here is dropped
 * without a word. `detach` and `target` are set only when the engine
 * wants them, so on an ordinary phase the value survives - and
 * `detach: true` skips the check that the document was written.
 *
 * Each is refused naming the key that does what the author wanted.
 * `systemInstructions` is not here on purpose: it is `ai@1`'s own arg for
 * standing instruction on a single phase, always appended rather than
 * replacing anything, and a style is free to set it like any other
 * plugin arg.
 */
export const EngineArgs: Record<string, string> = {
    prompt:
        "The phase's instructions are the stage's 'instructions:' - a file, so one phase runs one set of "
        + "instructions from one owner. This key is the whole assembled prompt, which the engine writes: "
        + "the heading, the spec folder, the documents, and the ask that closes it.",

    attachments:
        "Extra files for a phase are the stage's 'attachments:', or one spec's own 'spec.json'. The "
        + "engine owns this list - it already carries the document grammar, the phase's instructions "
        + "and the spec's documents - and a value here would replace all of them rather than add to them.",

    title: "The engine writes it, from the stage and the spec.",

    target: "The engine writes it, from what the stage produces. It is how a phase is checked.",

    detach:
        "The engine decides whether a phase waits. Detached, nothing verifies that the document was "
        + "written, so the phase would report done with nothing on disk."
};

/**
 * Refuses any engine-owned arg in `keys`, naming the key that does what
 * its author wanted.
 *
 * Called from the style parser. It lives here because which args the
 * engine writes over is a fact about running a phase, and this is the
 * module that says what a phase runs on.
 */
export function refuseEngineArgs(keys: Iterable<string>, where: string): void {

    for (const key of keys)
        if (key in EngineArgs)
            throw new Error(`${where} sets '${key}', which the engine writes. ${EngineArgs[key]}`);
}

export interface SddConfig {

    /**
     * Style ids enabled for this workspace, one process per id.
     *
     * A spec's opening document says which of these it follows, in its
     * `style:` frontmatter. A folder with no tag places only when
     * exactly one style is enabled, because that is the only case with
     * nothing to guess.
     */
    styles: string[];

    /**
     * Where spec folders live - `sdd.specsDir` in settings.json.
     * Relative to the workspace, or absolute for a root outside it.
     * Defaults to `.eesha/specs`.
     */
    specRoot: string;

    /**
     * Where the work item behind a spec comes from.
     *
     * Undefined means the settings do not say, and ＋ New Spec asks.
     * Defaulting it here would make the setting impossible to leave
     * open.
     */
    source?: Source;

    /**
     * How many seconds the panel waits between one implementation
     * session and the next, so the person can press Stop before the
     * next one starts - `sdd.nextSessionDelaySeconds` in settings.json.
     * 0 starts the next one at once. Defaults to 10.
     */
    nextSessionDelaySeconds: number;

    /** Applies to every `ai` stage that has no entry of its own. */
    ai: AiSettings;

    /** A runtime and model over every file - see {@link AiPick}. */
    aiPick?: AiPick;

    /**
     * The runtimes a phase may run on: `ai.providers` when settings.json
     * lists them, else every known runtime - ghcp, claude and each
     * `ai.acpAgents` id. A `providers:` block or a `provider:` naming
     * anything else fails the phase. Absent when the caller did not say
     * (a test), and then not checked.
     */
    providerIds?: string[];

    /**
     * The plugin's `ai:` defaults one settings file at a time, so the
     * style can sit between them - see {@link aiFor}. Absent when the
     * caller handed the settings in merged (a test's slice); `ai.args`
     * is then the one settings layer.
     */
    aiScoped?: { workspace: Record<string, unknown>; profile: Record<string, unknown> };

    /**
     * The settled `variables` section of settings.json, both scopes
     * merged. A phase prompt reads them bare, `${{ Profile.CurrentTeam }}`.
     */
    variables?: Record<string, unknown>;

}

/** Where spec folders live when `sdd.specsDir` says nothing. See {@link SddConfig.specRoot}. */
export const SPEC_ROOT = ".eesha/specs";

export const Defaults: SddConfig = {
    styles: ["custom"],
    specRoot: SPEC_ROOT,
    nextSessionDelaySeconds: 10,

    // `auto` means "whatever the provider would have picked". A pinned
    // model name goes stale.
    // No `provider` here on purpose. `ai@1`'s manifest already defaults
    // it, and these args are merged key by key under whatever a stage
    // declares, so a `provider` stated here would reach a plugin that
    // never declared one.
    ai: { uses: "ai@1", args: { model: "auto" } }
};

/**
 * What SDD reads from the merged engine settings: its own section, and
 * the per-plugin defaults from `ai:`.
 *
 * Structural rather than importing the engine settings type, so a
 * caller (usually a test) can assemble the slice by hand.
 */
export interface SddSettingsSlice {

    /** The `sdd:` section, as declared - the loader guarantees a mapping and nothing more. */
    sdd?: Record<string, unknown>;

    /** `ai:`'s per-plugin defaults, keyed by plugin ref (`"ai@1"`). */
    aiDefaults?: Record<string, Record<string, unknown>>;

    /** `ai.acpAgents`, merged - only the ids are read, to know which runtimes are registered. */
    acpAgents?: Record<string, unknown>;

    /** `ai.providers`, when a settings file lists one - see {@link SddConfig.providerIds}. */
    providers?: string[];

    /** {@link aiDefaults} one file at a time - see {@link SddConfig.aiScoped}. */
    aiScopedDefaults?: {
        workspace: Record<string, Record<string, unknown>>;
        profile: Record<string, Record<string, unknown>>;
    };

    /** The settled `variables` section - see {@link SddConfig.variables}. */
    variables?: Record<string, unknown>;

    /** The `fakeRuntime` flag: on, the fake runtime is one more allowed runtime. */
    fakeRuntime?: boolean;
}

/** The allowed runtimes, plus the fake one when its flag is on - the same rule the pickers use. */
function withFake(ids: string[], fakeRuntime: boolean | undefined): string[] {

    return fakeRuntime && !ids.includes("fake") ? [...ids, "fake"] : ids;
}

/**
 * The SDD config the settings describe, or the defaults when they say nothing.
 *
 * @param aiPick a pick over every file, if any - see {@link AiPick}.
 * Not a setting, so it arrives beside the slice rather than inside it.
 */
export function configFromSettings(
    slice: SddSettingsSlice | undefined,
    aiPick?: AiPick
): SddConfig {

    const sdd = slice?.sdd ?? {};

    for (const key of Object.keys(sdd))
        if (!["styles", "specsDir", "source", "uses", "nextSessionDelaySeconds"].includes(key))
            throw new Error(
                `settings.json has an unknown key 'sdd.${key}'. `
                + "Valid: styles, specsDir, source, uses, nextSessionDelaySeconds.");

    const uses = text_(sdd.uses, "sdd.uses") ?? Defaults.ai.uses;

    // The plugin's own defaults from `ai:`, under the plugin `sdd.uses`
    // names - not ai@1's when the team pointed `uses` elsewhere.
    const args = { ...Defaults.ai.args, ...slice?.aiDefaults?.[uses] };

    const ai: AiSettings = { uses, args };

    return {
        styles: textList_(sdd.styles, "sdd.styles") ?? Defaults.styles,
        specRoot: text_(sdd.specsDir, "sdd.specsDir") ?? SPEC_ROOT,
        source: oneOf(sdd.source, Sources, "sdd.source"),
        nextSessionDelaySeconds: seconds_(sdd.nextSessionDelaySeconds, "sdd.nextSessionDelaySeconds")
            ?? Defaults.nextSessionDelaySeconds,
        ai,
        ...(aiPick ? { aiPick } : {}),
        ...(slice?.providers
            ? { providerIds: withFake([...slice.providers], slice.fakeRuntime) }
            : slice?.acpAgents
                ? { providerIds: withFake([...new Set([...Providers, ...Object.keys(slice.acpAgents)])], slice.fakeRuntime) }
                : {}),
        ...(slice?.aiScopedDefaults
            ? {
                aiScoped: {
                    workspace: slice.aiScopedDefaults.workspace[uses] ?? {},
                    profile: slice.aiScopedDefaults.profile[uses] ?? {}
                }
            }
            : {}),
        ...(slice?.variables && Object.keys(slice.variables).length ? { variables: slice.variables } : {})
    };
}

/**
 * Where a style came from - see {@link aiFor}. The same three places a
 * style folder can sit; `builtin` is the one shipped with Eesha Code.
 */
export type StyleOrigin = "builtin" | "workspace" | "profile";

/**
 * The settings a phase runs on, lowest first:
 *
 *   1. the plugin's own defaults ({@link Defaults})
 *   2. the workspace settings.json - the team's
 *   3. the style's top-level `ai:`, then the stage's own `ai:`
 *   4. the profile settings.json - the person's
 *   5. the panel pick, then the permission mode
 *
 * The person's own file beats everything the workspace says, the style
 * included. A style kept in the profile is the person's too, so it moves
 * above their settings file: steps 3 and 4 swap.
 *
 * Merged per key rather than per block at each step, so a stage naming
 * only `reasoningEffort` keeps the model the style or the settings chose.
 * Each layer's `providers:` block for the runtime that runs goes over
 * that layer's own flat keys before the next layer goes over both, and
 * every other runtime's block is dropped - see `providerBlocks.ts`. A
 * higher layer's flat key beats a lower layer's block. The runtime is
 * decided first, down the same ladder from the top.
 *
 * `uses` never comes from the style. Which plugin runs a phase is a
 * deployment decision, and a style naming one would tie a portable
 * process to a plugin the team may not run.
 *
 * @param styleArgs the style's own top-level `ai:`, if it declared one.
 * @param stageArgs the stage's own `ai:`, if it declared one.
 * @param styleFrom where the style was found. Absent is read as a
 * workspace style - a built-in one sits in the same place.
 * @param lock a runtime and mode the style's process cannot run
 * without - the Kiro style's `kiro-cli` in mode `spec`. They beat
 * the compose box's pick. The pick's model and effort still apply when
 * it picked the same runtime.
 */
export function aiFor(
    config: SddConfig,
    styleArgs?: Record<string, unknown>,
    stageArgs?: Record<string, unknown>,
    styleFrom?: StyleOrigin,
    lock?: AiLock
): AiSettings {

    const layers = layersOf(config, styleArgs, stageArgs, styleFrom);

    if (config.providerIds)
        for (const [, args, where] of layers)
            refuseUnknownProviders(args, config.providerIds, where);

    const [provider, source] = runtimeOf(config, layers, lock);

    // A runtime the files name that the org does not use. The pick is
    // already held to the list in `runtimeOf`; this is a style or a
    // settings file naming one.
    if (config.providerIds && source !== "default" && !config.providerIds.includes(provider))
        throw new Error(
            `This phase is set to run on '${provider}' (${sourceText(source)}), which is not in ai.providers. `
            + `Use one of: ${config.providerIds.join(", ")}.`);

    const args: Record<string, unknown> = Object.assign(
        {}, ...layers.map(([, layer]) => applyProviderBlock(layer, provider)));

    const pick = allowedPick(config, lock);

    // The pick's runtime and, when one was picked by hand, its model.
    // A runtime picked alone runs on whatever model the files give it.
    // Never the pick's mode: every phase writes files, and a mode like
    // Plan would stop it from writing its document. The runtime's own
    // default mode runs, unless the style's lock names one (below).
    if (pick) {

        args.provider = pick.provider;

        if (named(pick.model))
            args.model = pick.model;

        // Not on `auto`: the compose box hides the picker there, so a
        // level picked on another model could not be cleared.
        if (named(pick.effort) && named(args.model) && args.model !== "auto")
            args.effort = pick.effort;
    }

    // Last, so nothing above can undo it.
    if (lock) {

        args.provider = lock.provider;

        if (lock.agentMode)
            args.agentMode = lock.agentMode;
    }

    return { uses: config.ai.uses, args };
}

/** A runtime and mode a style's process cannot run without - see {@link aiFor}. */
export interface AiLock {

    provider: string;

    agentMode?: string;
}

/** Which layer a value came from, as an error says it. */
function sourceText(source: AiSource): string {

    return source === "stage" ? "this stage's ai: in style.yml"
        : source === "style" ? "the style's ai: in style.yml"
            : source === "settings" ? "settings.json"
                : source === "pick" ? "the chat's own runtime and model"
                    : "the default";
}

/**
 * The layers of {@link aiFor}, lowest first, each with the picker's name
 * for it and a name for an error. With the settings merged into one (a
 * test's slice, or a caller with no scopes), that one sits under the
 * style as the only settings layer.
 */
function layersOf(
    config: SddConfig,
    styleArgs: Record<string, unknown> | undefined,
    stageArgs: Record<string, unknown> | undefined,
    styleFrom: StyleOrigin | undefined
): [AiSource, Record<string, unknown> | undefined, string][] {

    const style: [AiSource, Record<string, unknown> | undefined, string][] = [
        ["style", styleArgs, "The style's 'ai:'"],
        ["stage", stageArgs, "This stage's 'ai:'"]
    ];

    const scoped = config.aiScoped;

    if (!scoped)
        return [["settings", config.ai.args, "settings.json's ai defaults"], ...style];

    const floor: [AiSource, Record<string, unknown> | undefined, string] =
        ["default", Defaults.ai.args, "The defaults"];

    const workspace: [AiSource, Record<string, unknown> | undefined, string] =
        ["settings", scoped.workspace, "The workspace settings.json's ai defaults"];

    const profile: [AiSource, Record<string, unknown> | undefined, string] =
        ["settings", scoped.profile, "Your profile settings.json's ai defaults"];

    return styleFrom === "profile"
        ? [floor, workspace, profile, ...style]
        : [floor, workspace, ...style, profile];
}

/**
 * The panel pick, when it names a runtime the org uses - a stale one is
 * not - and, under a lock, the locked runtime.
 */
function allowedPick(config: SddConfig, lock?: AiLock): AiPick | undefined {

    const pick = config.aiPick;

    if (lock && pick?.provider !== lock.provider)
        return undefined;

    return pick && (!config.providerIds || config.providerIds.includes(pick.provider)) ? pick : undefined;
}

/** A non-blank string, trimmed, or nothing. */
function named(value: unknown): string | undefined {

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The runtime a phase runs on and which layer said so: the pick, then
 * the layers from the top, then ai@1's own default. Only flat keys are
 * read - a `providers:` block cannot name a runtime.
 */
function runtimeOf(
    config: SddConfig,
    layers: [AiSource, Record<string, unknown> | undefined, string][],
    lock?: AiLock
): [string, AiSource] {

    if (lock)
        return [lock.provider, "style"];

    const pick = allowedPick(config);

    if (pick)
        return [pick.provider, "pick"];

    for (const [source, args] of [...layers].reverse()) {

        const provider = named(args?.provider);

        if (provider)
            return [provider, source];
    }

    return [DEFAULT_PROVIDER, "default"];
}

/**
 * Where each of `provider` and `model` for one stage comes from, for a
 * picker that shows the value in effect and has to say why.
 *
 * The same ladder as {@link aiFor}, walked from the top. `provider` has
 * a default (`ai@1` runs on `ghcp` when nobody says) and so does `model`
 * (`auto`, from {@link Defaults}).
 */
export function aiSourcesFor(
    config: SddConfig,
    styleArgs?: Record<string, unknown>,
    stageArgs?: Record<string, unknown>,
    styleFrom?: StyleOrigin,
    lock?: AiLock
): { provider: string; model: string; providerFrom: AiSource; modelFrom: AiSource } {

    const layers = layersOf(config, styleArgs, stageArgs, styleFrom);

    const [provider, providerFrom] = runtimeOf(config, layers, lock);

    const fallback = String(Defaults.ai.args.model);

    const model = ((): [string, AiSource] => {

        const picked = named(allowedPick(config, lock)?.model);

        if (picked)
            return [picked, "pick"];

        for (const [source, args] of [...layers].reverse()) {

            // Each layer as the runtime sees it: its block over its flat keys.
            const value = named(applyProviderBlock(args, provider).model);

            if (value)
                // The plugin's own `auto` sits in the settings layer when
                // the settings came in merged. The same value as the
                // default is reported as the default - a file that spells
                // out `auto` means the same thing as one that does not.
                return [value, source === "settings" && value === fallback ? "default" : source];
        }

        return [fallback, "default"];
    })();

    return { provider, model: model[0], providerFrom, modelFrom: model[1] };
}

/** Which layer set a value - see {@link aiSourcesFor}. The same type the panel sends the view. */
export type { AiSource };

/**
 * The runtime `ai@1` runs on when nothing names one - its manifest's
 * own default. Stated here for the one consumer that has to name it
 * without running the plugin: the picker. Not put into
 * {@link Defaults}, for the reason given there.
 */
export const DEFAULT_PROVIDER = "ghcp";

function text_(value: unknown, key: string): string | undefined {

    if (value === undefined || value === null)
        return undefined;

    if (typeof value !== "string" || !value.trim())
        throw new Error(`settings.json '${key}' must be text.`);

    return value.trim();
}

/** A whole number of seconds, 0 or more - or undefined when the key says nothing. */
function seconds_(value: unknown, key: string): number | undefined {

    if (value === undefined || value === null)
        return undefined;

    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
        throw new Error(`settings.json '${key}' must be a whole number of seconds, 0 or more.`);

    return value;
}

/** A non-empty list of non-empty strings, trimmed - or undefined when the key says nothing. */
function textList_(value: unknown, key: string): string[] | undefined {

    if (value === undefined || value === null)
        return undefined;

    if (!Array.isArray(value) || value.length === 0 || !value.every(one => typeof one === "string" && one.trim()))
        throw new Error(`settings.json '${key}' must be a non-empty list of style ids.`);

    return value.map(one => one.trim());
}

function oneOf<T extends readonly string[]>(value: unknown, allowed: T, key: string): T[number] | undefined {

    if (value === undefined || value === null)
        return undefined;

    if (typeof value !== "string" || !allowed.includes(value))
        throw new Error(`settings.json has '${key}: ${String(value)}' - expected one of ${allowed.map(one => `'${one}'`).join(", ")}.`);

    return value;
}

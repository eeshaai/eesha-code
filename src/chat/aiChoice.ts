import { coreProviders } from "../core/agent";
import { ModelChoice, ModeList, ToolChoice } from "../core/agent/AgentProvider";
import { modelListPath, ModelListRead, readModelList, writeModelList } from "../core/agent/modelListFile";
import { Providers } from "../core/agent/providerArgs";
import { logger } from "../core/logging/logger";
import { type EngineSettings, loadEngineSettings } from "../core/settings/engineSettings";
import { AiPick } from "../sdd/config/sddConfig";
import { AiChoiceMessage } from "../shared/runMessages";
import type { ChatStore } from "./chatStore";

/*
 * The compose row's runtime, model and permission pickers, with no
 * page code in them: what can be picked, the model lists behind it, and the
 * saved picks. The caller gives its own {@link AiChoiceEnv}.
 */

/** What the pickers need from the server they run in. */
export interface AiChoiceEnv {

    /**
     * Where the team's settings.json is read from, beside the profile's.
     * Nothing: the profile's settings.json only.
     */
    workspaceFolder(): string | undefined;

    /** A GitHub token for Copilot, or nothing - the CLI's own sign-in is used then. */
    token?(): Promise<string | undefined>;

    /** A warning for the person. `file`, when given, is offered to open. */
    warn(text: string, file?: string): void;

    /**
     * When settings.json lists no runtimes (`ai.providers`): which of
     * `all` the picker offers. The server offers only the runtimes whose
     * program is on the machine. Nothing: all of them.
     */
    unlisted?(all: string[], settings: EngineSettings): string[];
}

/**
 * The runtimes on offer with these settings: `ai.providers` when
 * settings.json lists them, in its order; else the two built in, then
 * every `ai.acpAgents` id - cut down by the host's `unlisted` when it
 * has one.
 */
export function offeredRuntimes(settings: EngineSettings, env: AiChoiceEnv): string[] {

    // The fake runtime goes last, and only with its flag on.
    const withFake = (list: string[]) => settings.features?.fakeRuntime &&!list.includes("fake") ? [...list, "fake"] : list;

    if (settings.ai.providers)
        return withFake([...settings.ai.providers]);

    const acp = Object.keys(settings.ai.acpAgents).filter(id => !(Providers as readonly string[]).includes(id));
    const all = [...Providers, ...acp];

    return withFake(env.unlisted ? env.unlisted(all, settings) : all);
}

/*
 * The runtime and model picked in a spec panel's compose row, for the
 * whole workspace. Kept in the chat store, not in settings.json: a
 * settings file is the team's or the person's standing configuration,
 * and "Copilot is out of credits until tomorrow" is neither.
 */

const PICK_KEY = "sdd.aiPick";

export function readAiPick(store: ChatStore): AiPick | undefined {

    const stored = store.get<AiPick>(PICK_KEY);

    // Shape-checked on the way out: saved values outlive builds.
    return isAiPick(stored) ? stored : undefined;
}

/** A stored pick's shape - saved values outlive builds. Shared with the chat's own pick. */
export function isAiPick(stored: AiPick | undefined): stored is AiPick {

    return stored !== undefined && stored !== null && typeof stored.provider === "string"
        && (stored.model === undefined || typeof stored.model === "string")
        && (stored.mode === undefined || typeof stored.mode === "string")
        && (stored.effort === undefined || typeof stored.effort === "string");
}

/** `undefined` clears it - the files decide again. */
export async function writeAiPick(store: ChatStore, pick: AiPick | undefined): Promise<void> {

    await store.update(PICK_KEY, pick);
}

/**
 * Every runtime a phase or chat can run on: `ai.providers` when
 * settings.json lists the org's own, in its order; else the two built
 * in, then every `ai.acpAgents` id the merged settings declare (the
 * shipped ACP agents included) - see {@link offeredRuntimes}. Read per
 * call - the file can change while the server runs, and this is called on
 * a refresh, not a keystroke.
 */
export async function providerIds(env: AiChoiceEnv): Promise<string[]> {

    try {

        return offeredRuntimes(await loadEngineSettings(env.workspaceFolder()), env);

    } catch (error) {

        // A malformed settings.json is reported where it is edited; the
        // picker just offers less.
        logger.warning(`No ai.acpAgents ids for the picker. ${String(error)}`);

        return [...Providers];
    }
}

/*
 * Each runtime's model list lives in `<profile>/models/<runtime>.json`
 * (see `core/agent/modelListFile.ts`). The rules:
 *
 *   1. The file is there: it is the list. Nothing is fetched.
 *   2. The file is missing: the runtime's CLI is asked once. A list that
 *      is not empty is written to the file. A failure writes nothing,
 *      and the next picker asks again.
 *   3. The refresh button: the CLI is asked again, and a list that is
 *      not empty replaces the file. A failure keeps the file as it was.
 *   4. A broken file (bad JSON, wrong shape) is reported once with a
 *      link to open it, and the picker offers `auto` for that runtime.
 *      It is never fetched over - only the refresh button replaces it.
 *
 * The file is read on every picker post, so a hand edit shows the next
 * time the picker is sent.
 */

/** One runtime's lists: its models and, for an agent that has them, its modes. */
interface Catalogue {

    models?: ModelChoice[];

    modes?: ModeList;
}

/**
 * This process's fetches, by runtime. The promise is kept rather than
 * the value, so pickers opened while a fetch is in flight share it. A
 * failure is dropped once it settles, so the next picker asks again. A
 * list that landed is kept - it stands in when the file could not be
 * written, or for an agent that answered that it has no models.
 */
const fetched = new Map<string, Promise<Catalogue | undefined>>();

/**
 * The checks in flight - file read, then the fetch when the file is
 * missing. Set the moment one starts, so a picker posted right after
 * already names the runtime as loading.
 */
const checking = new Map<string, Promise<Catalogue | undefined>>();

/** Refresh-button fetches in flight. */
const refreshing = new Map<string, Promise<boolean>>();

/** The broken-file reason already shown per runtime, so the same one is not shown on every post. */
const reported = new Map<string, string>();

/**
 * How long a model list may take before the fetch counts as failed - and
 * so is asked again next time. A CLI that never answers would otherwise
 * hold its runtime's list at "in flight" for the life of the process.
 */
const MODEL_FETCH_LIMIT_MS = 30_000;

function withinFetchLimit<T>(fetch: Promise<T> | undefined): Promise<T | undefined> {

    if (!fetch)
        return Promise.resolve(undefined);

    return new Promise((resolve, reject) => {

        const timer = setTimeout(
            () => reject(new Error(`no answer within ${MODEL_FETCH_LIMIT_MS / 1000}s`)),
            MODEL_FETCH_LIMIT_MS);

        fetch.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); });
    });
}

/**
 * A runtime's file, with a broken one reported to the person. Reported
 * once per reason - fixed and broken again in a new way is shown again.
 */
async function fileOf(provider: string, env: AiChoiceEnv): Promise<ModelListRead> {

    const read = await readModelList(provider);

    if (read.state !== "broken") {

        reported.delete(provider);

        return read;
    }

    if (reported.get(provider) !== read.reason) {

        reported.set(provider, read.reason);

        const file = modelListPath(provider);

        logger.warning(`The model list file for '${provider}' (${file}) ${read.reason}.`);

        env.warn(
            `The model list file for '${provider}' ${read.reason}. The model picker offers 'auto' for it until the file is fixed or you press refresh.`,
            file);
    }

    return read;
}

/** A runtime built only to answer a list, never to run a turn. */
function listingProvider(provider: string, env: AiChoiceEnv) {

    return coreProviders({
        ...(env.token ? { token: env.token } : {}),
        workspaceFolder: () => env.workspaceFolder()
    }).get(provider);
}

/**
 * Asks the runtime's CLI for its models and modes, together - an ACP
 * agent answers both from the one session it opens (see
 * `AcpProvider.listing`). The modes are extra: a failure there leaves
 * them out and still keeps the models. Throws when the models fail.
 */
async function fetchCatalogue(provider: string, env: AiChoiceEnv): Promise<Catalogue> {

    const built = await listingProvider(provider, env);

    const modes = withinFetchLimit(built.modes?.()).catch(error => {

        logger.warning(`No mode list from '${provider}' for the picker. ${String(error)}`);

        return undefined;
    });

    const models = await withinFetchLimit(built.models?.());

    return { models, modes: await modes };
}

/** Rule 2: the one fetch for a runtime with no file. */
function fetchOnce(provider: string, env: AiChoiceEnv): Promise<Catalogue | undefined> {

    const known = fetched.get(provider);

    if (known)
        return known;

    let failed = false;

    const fetching = (async (): Promise<Catalogue | undefined> => {

        try {

            const catalogue = await fetchCatalogue(provider, env);

            // Only a real list is saved. An empty one saved would leave
            // the picker on `auto` until somebody deleted the file.
            // `replace: false`: a file made while this ran is kept.
            if (catalogue.models?.length)
                await writeModelList(provider, { models: catalogue.models, modes: catalogue.modes }, { replace: false });

            return catalogue;

        } catch (error) {

            // Never fatal and never shown: without a list the dropdown
            // offers `auto` and what is in effect, which still works.
            logger.warning(`No model list from '${provider}' for the picker. ${String(error)}`);

            failed = true;

            return undefined;
        }
    })();

    fetched.set(provider, fetching);

    void fetching.then(() => {

        if (failed && fetched.get(provider) === fetching)
            fetched.delete(provider);
    });

    return fetching;
}

/** A runtime's lists: the file's, or the fetch's when there is no file. */
function catalogueOf(provider: string, env: AiChoiceEnv): Promise<Catalogue | undefined> {

    const running = checking.get(provider);

    if (running)
        return running;

    const check = (async (): Promise<Catalogue | undefined> => {

        const read = await fileOf(provider, env);

        if (read.state === "ok")
            return read.list;

        if (read.state === "broken")
            return undefined;

        return fetchOnce(provider, env);
    })();

    checking.set(provider, check);

    void check.then(() => {

        if (checking.get(provider) === check)
            checking.delete(provider);
    });

    return check;
}

/** A runtime's models: its file's, or one fetch when there is no file. */
export function modelsOf(provider: string, env: AiChoiceEnv): Promise<ModelChoice[] | undefined> {

    return catalogueOf(provider, env).then(catalogue => catalogue?.models);
}

/**
 * Rule 3: the refresh button. Asks the CLI again and, when it gives a
 * list that is not empty, replaces the file. A failure keeps the file
 * and says so. Answers whether the list was refreshed.
 *
 * A second press while one is running joins it.
 */
export function refreshModels(provider: string, env: AiChoiceEnv): Promise<boolean> {

    const running = refreshing.get(provider);

    if (running)
        return running;

    const refresh = (async (): Promise<boolean> => {

        let catalogue: Catalogue;

        try {

            catalogue = await fetchCatalogue(provider, env);

        } catch (error) {

            logger.warning(`Could not refresh the model list of '${provider}'. ${String(error)}`);

            env.warn(`Could not refresh the models for '${provider}': ${(error as Error).message ?? String(error)}. The current list is kept.`);

            return false;
        }

        if (!catalogue.models?.length) {

            env.warn(`'${provider}' gave no models. The current list is kept.`);

            return false;
        }

        const models = catalogue.models;

        // Stands in for the file when it cannot be written.
        fetched.set(provider, Promise.resolve(catalogue));

        if (!await writeModelList(provider, { models, modes: catalogue.modes }, { replace: true }))
            env.warn(`Got ${models.length} models for '${provider}' but could not save them to ${modelListPath(provider)}. They are used until Eesha Code is restarted.`);

        return true;
    })();

    refreshing.set(provider, refresh);

    void refresh.then(() => {

        if (refreshing.get(provider) === refresh)
            refreshing.delete(provider);
    });

    return refresh;
}

/**
 * Every runtime's lists that are in, and the runtimes still loading.
 * The file comes first. With no file, a landed fetch stands in, and a
 * check or fetch in flight names the runtime as loading. Never waits on
 * a CLI - the caller sends again when a fetch lands.
 */
async function cataloguesIn(providers: string[], env: AiChoiceEnv): Promise<{ settled: Record<string, Catalogue>; loading: string[] }> {

    const settled: Record<string, Catalogue> = {};
    const loading: string[] = [];

    for (const provider of new Set([...providers, ...fetched.keys(), ...checking.keys()])) {

        const read = await fileOf(provider, env);

        if (read.state === "ok") {

            settled[provider] = read.list;

            continue;
        }

        if (read.state === "broken")
            continue;

        const fetching = fetched.get(provider);

        // `Promise.race` against an already-resolved marker answers
        // "is it done" without waiting on one that is not.
        const catalogue = fetching ? await Promise.race([fetching, Promise.resolve(PENDING)]) : undefined;

        if (catalogue && catalogue !== PENDING)
            settled[provider] = catalogue;

        else if (catalogue === PENDING || checking.has(provider))
            loading.push(provider);
    }

    return { settled, loading };
}

const PENDING = Symbol("pending");

/**
 * What the picker is sent. Sent once right away with whatever lists
 * are already in, and again each time a list lands, so the panel is
 * never held up by a CLI.
 */
export async function aiChoiceMessage(store: ChatStore, env: AiChoiceEnv): Promise<AiChoiceMessage> {

    const providers = await providerIds(env);

    // A pick of a runtime the org no longer lists is cleared, so the
    // files decide again and the picker never shows a value it cannot
    // offer. The run itself ignores such a pick too (see `aiFor`).
    const stored = readAiPick(store);

    if (stored && !providers.includes(stored.provider))
        await writeAiPick(store, undefined);

    const pick = stored && providers.includes(stored.provider) ? stored : undefined;
    const { settled, loading } = await cataloguesIn(providers, env);

    const models: NonNullable<AiChoiceMessage["models"]> = {};
    const modes: NonNullable<AiChoiceMessage["modes"]> = {};

    for (const [provider, catalogue] of Object.entries(settled)) {

        if (catalogue.models)
            models[provider] = catalogue.models.map(model => ({
                id: model.id,
                name: model.name,
                ...(model.multiplier !== undefined ? { multiplier: model.multiplier } : {}),
                ...(model.disabled ? { disabled: true } : {}),
                ...(model.efforts?.length ? { efforts: model.efforts } : {}),
                ...(model.price ? { price: model.price } : {}),
                ...(model.aliases?.length ? { aliases: model.aliases } : {})
            }));

        if (catalogue.modes?.modes.length)
            modes[provider] = catalogue.modes;
    }

    const refreshingNow = [...refreshing.keys()];

    return {
        providers,
        ...(Object.keys(models).length ? { models } : {}),
        ...(Object.keys(modes).length ? { modes } : {}),
        ...(loading.length ? { loading } : {}),
        ...(refreshingNow.length ? { refreshing: refreshingNow } : {}),
        ...(pick ? { pick } : {})
    };
}

/**
 * Copilot's built-in tools, fetched once per process - listing them
 * starts a CLI, like its model list. A failure is not kept, so the next
 * picker asks again. Claude's list is a file read each time (see
 * `claudeTools.ts`): it first appears after a session has run.
 */
const toolLists = new Map<string, Promise<ToolChoice[] | undefined>>();

/** A runtime's built-in tools, for the Tools picker. Nothing when it cannot say. */
export function toolsOf(runtime: string, env: AiChoiceEnv): Promise<ToolChoice[] | undefined> {

    const known = toolLists.get(runtime);

    if (known)
        return known;

    const fetching = (async () => {

        try {

            return await (await listingProvider(runtime, env)).tools?.();

        } catch (error) {

            logger.warning(`Chat: no tool list from '${runtime}'. ${(error as Error).message}`);

            return undefined;
        }
    })();

    if (runtime !== "claude") {

        toolLists.set(runtime, fetching);

        void fetching.then(list => {

            if (!list && toolLists.get(runtime) === fetching)
                toolLists.delete(runtime);
        });
    }

    return fetching;
}

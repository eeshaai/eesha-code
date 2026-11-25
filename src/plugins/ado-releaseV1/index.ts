import { PluginContext, PluginHandleContext, PluginRequest, PluginResult } from "../../core/plugins/Plugin";
import { adoAuthHeader, isAdoAuth } from "../ado/auth";

/**
 * `ado-release@1` - Azure DevOps classic releases, over plain REST.
 *
 * Classic releases live on `vsrm.dev.azure.com`, which the official ADO
 * MCP server does not cover (it does build pipelines on `dev.azure.com`
 * and nothing under Release Management). So `mcp@1` cannot reach them,
 * and without this every workflow writes the same three `pwsh@1`
 * tasks.
 *
 * Four operations, one task each:
 *
 *   definitions  what release definitions the project has
 *   versions     the builds each artifact of one definition can take,
 *                and the definition's stages
 *   create       a release from a definition, its builds pinned, the
 *                named stages held until `promote`
 *   promote      start one stage of a release
 *
 * The same four are what the plugin's own tab calls through `handle`,
 * so a person picks releases and builds from live data and starts the
 * workflow with them already answered. The tab never asks mid-run: the
 * run's only stop is a `trigger: manual` gate, and `promote` is the
 * task that carries it.
 *
 * Auth is `az` by default, `pat` as the fallback - see `../ado/auth`.
 */
interface AdoReleaseArgs {

    orgUrl: string;

    project: string;

    operation: string;

    definition?: number;

    pin?: Record<string, unknown>;

    hold?: unknown[];

    description?: string;

    release?: number;

    stage?: string;

    auth?: string;

    patEnv?: string;
}

const API_VERSION = "7.1";

const REQUEST_TIMEOUT_MS = 30_000;

const OPERATIONS = ["definitions", "versions", "create", "promote"];

/** A release definition, as far as this plugin reads it. */
interface Definition {

    id: number;

    name: string;

    path?: string;

    environments?: { id: number; name: string; rank?: number }[];

    artifacts?: { alias: string; type?: string; definitionReference?: { definition?: { id?: string; name?: string } } }[];
}

interface ArtifactVersions {

    artifactVersions?: {
        alias: string;
        defaultVersion?: { id: string; name: string };
        versions?: { id: string; name: string }[];
    }[];
}

interface Release {

    id: number;

    name: string;

    environments?: { id: number; name: string; status?: string }[];
}

export async function execute(args: AdoReleaseArgs, ctx: PluginContext): Promise<PluginResult> {

    const invalid = validate(args);

    if (invalid)
        return { success: false, message: invalid };

    let api: ReleaseApi;

    try {

        api = await ReleaseApi.open(args.orgUrl, args.project, args.auth, args.patEnv, ctx);

    } catch (error) {

        return { success: false, message: messageOf(error) };
    }

    try {

        switch (args.operation) {

            case "definitions": {

                const definitions = await api.definitions();

                ctx.log(`${definitions.length} release definition${definitions.length === 1 ? "" : "s"} in ${args.project}.`, "system");

                return { success: true, artifacts: { definitions } };
            }

            case "versions": {

                const found = await api.versions(args.definition!);

                ctx.log(
                    `Definition ${args.definition}: ${found.versions.length} artifact${found.versions.length === 1 ? "" : "s"}, ` +
                    `stages ${found.environments.map(environment => environment.name).join(", ") || "(none)"}.`,
                    "system");

                return { success: true, artifacts: found };
            }

            case "create": {

                const release = await api.create(args.definition!, args.pin ?? {}, stringsOf(args.hold), args.description);

                ctx.log(`Created release ${release.name} (${release.id}) from definition ${args.definition}.`, "system");

                return {
                    success: true,
                    artifacts: {
                        releaseId: release.id,
                        name: release.name,
                        // Keyed by stage name, so a later task reads
                        // `.environments.UAT.id` with no search.
                        environments: environmentsByName(release)
                    }
                };
            }

            case "promote": {

                const started = await api.promote(args.release!, args.stage!);

                ctx.log(`Release ${args.release}: stage '${args.stage}' is now ${started.status}.`, "system");

                return { success: true, artifacts: { releaseId: args.release, stage: args.stage, status: started.status } };
            }

            default:
                return { success: false, message: `Unknown operation '${args.operation}'.` };
        }

    } catch (error) {

        return { success: false, message: messageOf(error) };
    }
}

/**
 * The tab's back end. The page asks for the same things a task can,
 * with the org and project in the payload: nothing is running, so there
 * are no args to read them from.
 */
export async function handle(request: PluginRequest, ctx: PluginHandleContext): Promise<unknown> {

    const payload = (request.payload ?? {}) as Partial<AdoReleaseArgs>;

    if (request.name !== "definitions" && request.name !== "versions")
        throw new Error(`ado-release@1 has no handler named '${request.name}' - the page may ask for definitions or versions.`);

    const invalid = validate({ ...payload, operation: request.name } as AdoReleaseArgs);

    if (invalid)
        throw new Error(invalid);

    const api = await ReleaseApi.open(payload.orgUrl!, payload.project!, payload.auth, payload.patEnv, ctx);

    return request.name === "definitions"
        ? api.definitions()
        : api.versions(payload.definition!);
}

/** The args a run cannot proceed without, each failure naming its field. */
function validate(args: AdoReleaseArgs): string | undefined {

    if (typeof args.orgUrl !== "string" || !/^https:\/\//.test(args.orgUrl.trim()))
        return "'orgUrl' must be the organization's https URL - https://dev.azure.com/{org}.";

    if (typeof args.project !== "string" || !args.project.trim())
        return "'project' must name the Azure DevOps project.";

    if (!OPERATIONS.includes(args.operation))
        return `'operation' must be one of ${OPERATIONS.join(", ")} - got '${String(args.operation)}'.`;

    if ((args.operation === "versions" || args.operation === "create") && !isId(args.definition))
        return `'definition' must be a release definition id for '${args.operation}' - got '${String(args.definition)}'.`;

    if (args.operation === "create") {

        if (args.pin !== undefined && (typeof args.pin !== "object" || args.pin === null || Array.isArray(args.pin)))
            return "'pin' must be a map of artifact alias to version id.";

        if (args.hold !== undefined && !Array.isArray(args.hold))
            return "'hold' must be a list of stage names.";
    }

    if (args.operation === "promote") {

        if (!isId(args.release))
            return `'release' must be a release id for 'promote' - got '${String(args.release)}'.`;

        if (typeof args.stage !== "string" || !args.stage.trim())
            return "'stage' must name the stage to promote.";
    }

    if (!isAdoAuth(args.auth))
        return `'auth' must be 'az' or 'pat' - got '${String(args.auth)}'.`;

    return undefined;
}

function isId(value: unknown): boolean {

    return Number.isInteger(Number(value)) && Number(value) > 0;
}

function stringsOf(value: unknown[] | undefined): string[] {

    return (value ?? []).map(String);
}

function messageOf(error: unknown): string {

    return error instanceof Error ? error.message : String(error);
}

/** A release's stages keyed by name - `{ UAT: { id, status } }`. */
function environmentsByName(release: Release): Record<string, { id: number; status?: string }> {

    return Object.fromEntries(
        (release.environments ?? []).map(environment => [environment.name, { id: environment.id, status: environment.status }]));
}

/**
 * The Release Management host for an organization URL. Classic releases
 * are served from `vsrm.dev.azure.com/{org}` (or
 * `{org}.vsrm.visualstudio.com`), never from `dev.azure.com`.
 */
export function releaseHostOf(orgUrl: string): string {

    const trimmed = orgUrl.trim().replace(/\/+$/, "");

    const modern = /^https:\/\/dev\.azure\.com\/([^/]+)$/i.exec(trimmed);

    if (modern)
        return `https://vsrm.dev.azure.com/${modern[1]}`;

    const legacy = /^https:\/\/([^./]+)\.visualstudio\.com$/i.exec(trimmed);

    if (legacy)
        return `https://${legacy[1]}.vsrm.visualstudio.com`;

    // Already the vsrm host, or a server of its own: taken as given.
    return trimmed;
}

/**
 * The four calls, with one auth header, one timeout and one error
 * shape. Failures name the operation and the HTTP status, never the
 * token.
 */
class ReleaseApi {

    private readonly base: string;

    private constructor(
        host: string,
        project: string,
        private readonly auth: string,
        private readonly ctx: Pick<PluginContext, "onCancel" | "cancelled"> | PluginHandleContext
    ) {

        this.base = `${host}/${encodeURIComponent(project.trim())}/_apis/release`;
    }

    static async open(
        orgUrl: string,
        project: string,
        auth: string | undefined,
        patEnv: string | undefined,
        ctx: Pick<PluginContext, "secret" | "onCancel" | "cancelled"> | PluginHandleContext
    ): Promise<ReleaseApi> {

        return new ReleaseApi(releaseHostOf(orgUrl), project, await adoAuthHeader(auth, patEnv, ctx), ctx);
    }

    async definitions(): Promise<{ id: number; name: string; path: string }[]> {

        const page = await this.call<{ value?: Definition[] }>(
            "GET", `definitions?api-version=${API_VERSION}`, undefined, "list release definitions");

        return (page.value ?? []).map(definition => ({ id: definition.id, name: definition.name, path: definition.path ?? "\\" }));
    }

    /**
     * What a release from this definition can be made of: per artifact,
     * the versions to pick from and the default; and the stages, so a
     * `hold` or a `promote` can name one.
     */
    async versions(definitionId: number): Promise<{
        versions: { alias: string; default?: { id: string; name: string }; versions: { id: string; name: string }[] }[];
        environments: { id: number; name: string }[];
    }> {

        const [definition, artifacts] = await Promise.all([
            this.call<Definition>(
                "GET", `definitions/${definitionId}?api-version=${API_VERSION}`, undefined, `read definition ${definitionId}`),
            this.call<ArtifactVersions>(
                "GET", `artifacts/versions?definitionId=${definitionId}&api-version=${API_VERSION}`, undefined,
                `list the builds definition ${definitionId} can take`)
        ]);

        return {
            versions: (artifacts.artifactVersions ?? []).map(artifact => ({
                alias: artifact.alias,
                default: artifact.defaultVersion,
                versions: (artifact.versions ?? []).map(version => ({ id: version.id, name: version.name }))
            })),
            environments: [...(definition.environments ?? [])]
                .sort((left, right) => (left.rank ?? 0) - (right.rank ?? 0))
                .map(environment => ({ id: environment.id, name: environment.name }))
        };
    }

    /**
     * A release with every artifact pinned - to `pin[alias]`, or the
     * definition's default (latest) when the alias is not named - and
     * the `hold` stages set to manual, so they wait for `promote`.
     *
     * Every alias is sent, not only the pinned ones: ADO refuses a
     * create that leaves an artifact out.
     */
    async create(definitionId: number, pin: Record<string, unknown>, hold: string[], description?: string): Promise<Release> {

        const available = await this.versions(definitionId);

        const unknown = Object.keys(pin).filter(alias => !available.versions.some(artifact => artifact.alias === alias));

        if (unknown.length)
            throw new Error(
                `'pin' names artifact${unknown.length === 1 ? "" : "s"} ${unknown.map(alias => `'${alias}'`).join(", ")}, ` +
                `which definition ${definitionId} does not have. It has: ${available.versions.map(artifact => artifact.alias).join(", ") || "(none)"}.`);

        const missingStage = hold.filter(stage => !available.environments.some(environment => environment.name === stage));

        if (missingStage.length)
            throw new Error(
                `'hold' names stage${missingStage.length === 1 ? "" : "s"} ${missingStage.map(stage => `'${stage}'`).join(", ")}, ` +
                `which definition ${definitionId} does not have. It has: ${available.environments.map(environment => environment.name).join(", ") || "(none)"}.`);

        const artifacts = available.versions.map(artifact => {

            const wanted = pin[artifact.alias] === undefined ? undefined : String(pin[artifact.alias]);

            const version = wanted === undefined
                ? artifact.default
                : artifact.versions.find(candidate => candidate.id === wanted || candidate.name === wanted);

            if (!version)
                throw new Error(wanted === undefined
                    ? `Artifact '${artifact.alias}' of definition ${definitionId} has no default version to take - pin one.`
                    : `Artifact '${artifact.alias}' of definition ${definitionId} has no version '${wanted}'. ` +
                        `It has: ${artifact.versions.map(candidate => `${candidate.name} (${candidate.id})`).join(", ") || "(none)"}.`);

            return { alias: artifact.alias, instanceReference: { id: version.id, name: version.name } };
        });

        return this.call<Release>(
            "POST",
            `releases?api-version=${API_VERSION}`,
            {
                definitionId,
                description: description ?? "",
                isDraft: false,
                reason: "manual",
                artifacts,
                manualEnvironments: hold
            },
            `create a release from definition ${definitionId}`);
    }

    /** Starts the named stage of a release. The stage is found by name on the release itself. */
    async promote(releaseId: number, stage: string): Promise<{ id: number; name: string; status: string }> {

        const release = await this.call<Release>(
            "GET", `releases/${releaseId}?api-version=${API_VERSION}`, undefined, `read release ${releaseId}`);

        const environment = (release.environments ?? []).find(candidate => candidate.name === stage);

        if (!environment)
            throw new Error(
                `Release ${releaseId} has no stage '${stage}'. ` +
                `It has: ${(release.environments ?? []).map(candidate => candidate.name).join(", ") || "(none)"}.`);

        return this.call<{ id: number; name: string; status: string }>(
            "PATCH",
            `releases/${releaseId}/environments/${environment.id}?api-version=${API_VERSION}`,
            { status: "inProgress" },
            `promote release ${releaseId} to '${stage}'`);
    }

    private async call<T>(method: string, pathAndQuery: string, body: unknown, what: string): Promise<T> {

        const controller = new AbortController();

        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        // A `handle` context has no cancel - nothing stops a page's
        // request but its timeout.
        if ("onCancel" in this.ctx)
            this.ctx.onCancel(() => controller.abort());

        try {

            const response = await fetch(`${this.base}/${pathAndQuery}`, {
                method,
                headers: {
                    "Authorization": this.auth,
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal
            });

            if (!response.ok)
                throw new Error(
                    `Could not ${what}: HTTP ${response.status}.` +
                    (response.status === 401 || response.status === 403
                        ? " An expired 'az login' and a PAT without Release (Read, write & execute) scope both land here."
                        : response.status === 404
                            ? " Check 'orgUrl', 'project' and the id."
                            : ""));

            return await response.json() as T;

        } catch (error) {

            if (controller.signal.aborted)
                throw new Error("cancelled" in this.ctx && this.ctx.cancelled
                    ? `Stopped while trying to ${what}.`
                    : `Timed out trying to ${what} after ${REQUEST_TIMEOUT_MS / 1000}s.`);

            throw error;

        } finally {

            clearTimeout(timer);
        }
    }
}

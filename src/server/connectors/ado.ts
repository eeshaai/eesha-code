import type { PathMatch } from "../../shared/composeFiles";
import { pathKey, pathName, sameText, type Access, type AdoConfig, type AdoProject, type AdoSource } from "./config";
import {
    adoTool as tool, API_VERSION, branchRef, enc, matches, orgApi, PROJECT, projectApi, projectFor, projectLabel, releaseApi, web,
    type AdoContext, type AdoSourceModule, type AdoTool
} from "./adoBase";
import { ADO_CODE_MODULES } from "./adoCode";
import { ADO_DOCS_MODULES } from "./adoDocs";
import { adoMineLevels, adoMineReference, MINE, mineRow } from "./adoMine";
import { ApiError } from "./http";
import { capped, count, htmlOf, plainText, schema, text, ToolError, whole, type ItemReference } from "./tools";

export type { AdoContext };
export { projectFor, projectLabel };

/*
 * Azure DevOps: work items, build pipelines and release pipelines.
 *
 * Three things for each: the `>ado>...` levels the compose box lists, the
 * one reference line a picked path adds to the message, and the tools the
 * AI calls.
 *
 * Only projects in `reach` are ever asked about, and a tool's source must
 * be on Read or Write - Write for a tool that changes something.
 */

const COMMENTS_VERSION = "api-version=7.1-preview.4";

const SOURCE_LABEL: Record<AdoSource, string> = {
    workitems: "Work items",
    queries: "Saved queries",
    repos: "Repos",
    pulls: "Pull requests",
    builds: "Build pipelines",
    releases: "Release pipelines",
    wiki: "Wiki",
    testplans: "Test plans"
};

/** The sources in other files, and saved queries below. */
function moduleOf(source: string): AdoSourceModule | undefined {

    return [QUERIES, ...ADO_CODE_MODULES, ...ADO_DOCS_MODULES].find(one => one.source === source);
}

// -------------------------------------------------------------------
// Pipelines, kept half an hour: they change rarely, and the picker
// asks on every pause in typing.
// -------------------------------------------------------------------

interface Pipeline {

    id: number;

    name: string;

    folder?: string;
}

function pipelines(context: AdoContext, project: AdoProject, kind: "builds" | "releases"): Promise<Pipeline[]> {

    return context.api.kept("pipelines", `${kind}:${projectLabel(project)}`, async () => {

        const url = kind === "builds"
            ? `${projectApi(project)}/build/definitions?$top=1000&queryOrder=definitionNameAscending&${API_VERSION}`
            : `${releaseApi(project)}/release/definitions?$top=1000&${API_VERSION}`;

        const answer = await context.api<{ value: { id: number; name: string; path?: string }[] }>(url);

        return answer.value.map(one => ({ id: one.id, name: one.name, folder: one.path && one.path !== "\\" ? one.path : undefined }));
    });
}

/** A pipeline named by a path level: its own name, or its id. */
async function pipelineAt(context: AdoContext, project: AdoProject, kind: "builds" | "releases", level: string): Promise<Pipeline | undefined> {

    const list = await pipelines(context, project, kind);

    return list.find(one => pathKey(pathName(one.name)) === pathKey(level)) ?? list.find(one => String(one.id) === level);
}

// -------------------------------------------------------------------
// Work items
// -------------------------------------------------------------------

const ROW_FIELDS = ["System.Id", "System.Title", "System.State", "System.WorkItemType", "System.TeamProject", "System.AssignedTo", "System.ChangedDate"];

interface WorkItem {

    id: number;

    fields: Record<string, unknown>;

    relations?: { rel: string; url: string; attributes?: { name?: string; comment?: string } }[];
}

function person(value: unknown): string | undefined {

    return value && typeof value === "object" ? (value as { displayName?: string }).displayName : typeof value === "string" ? value : undefined;
}

/** Work item rows: id, type, title, state, assigned to. */
function itemRow(item: WorkItem) {

    const f = item.fields;

    return {
        id: item.id,
        type: f["System.WorkItemType"],
        title: f["System.Title"],
        state: f["System.State"],
        assignedTo: person(f["System.AssignedTo"]),
        changed: f["System.ChangedDate"]
    };
}

async function itemsByIds(context: AdoContext, project: AdoProject, ids: number[]): Promise<WorkItem[]> {

    if (!ids.length)
        return [];

    const answer = await context.api<{ value: WorkItem[] }>(
        `${orgApi(project)}/wit/workitems?ids=${ids.join(",")}&fields=${ROW_FIELDS.join(",")}&errorPolicy=omit&${API_VERSION}`);

    // errorPolicy=omit leaves nulls for ids it cannot read.
    return answer.value.filter(Boolean).filter(item => sameText(String(item.fields["System.TeamProject"] ?? ""), project.project));
}

/** WIQL text inside single quotes. */
function wiqlText(value: string): string {

    return value.replace(/'/g, "''");
}

async function searchItems(context: AdoContext, project: AdoProject, words: string | undefined, top: number, wiql?: string): Promise<WorkItem[]> {

    const query = wiql ?? [
        "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project",
        words ? `AND [System.Title] CONTAINS '${wiqlText(words)}'` : "",
        "ORDER BY [System.ChangedDate] DESC"
    ].filter(Boolean).join(" ");

    const answer = await context.api<{ workItems?: { id: number }[] }>(
        `${projectApi(project)}/wit/wiql?$top=${top}&${API_VERSION}`, { method: "POST", body: { query } });

    return itemsByIds(context, project, (answer.workItems ?? []).slice(0, top).map(one => one.id));
}

/** One work item, checked to be in this project. Nothing when it is not there. */
async function itemIn(context: AdoContext, project: AdoProject, id: number, expand = false): Promise<WorkItem | undefined> {

    try {

        const item = await context.api<WorkItem>(`${orgApi(project)}/wit/workitems/${id}?${expand ? "$expand=relations&" : ""}${API_VERSION}`);

        return sameText(String(item.fields["System.TeamProject"] ?? ""), project.project) ? item : undefined;

    } catch (error) {

        if (error instanceof ApiError && error.status === 404)
            return undefined;

        throw error;
    }
}

async function itemOrFail(context: AdoContext, project: AdoProject, id: number, expand = false): Promise<WorkItem> {

    const item = await itemIn(context, project, id, expand);

    if (!item)
        throw new ToolError(`Work item ${id} is not in ${projectLabel(project)}, or cannot be read.`);

    return item;
}

const itemLink = (project: AdoProject, id: number) => `${web(project)}/_workitems/edit/${id}`;

// -------------------------------------------------------------------
// The compose box's levels
// -------------------------------------------------------------------

function sourceOn(config: AdoConfig, source: string): source is AdoSource {

    return source in SOURCE_LABEL && config.sources[source as AdoSource] !== "off";
}

/**
 * The project a path names, and the rest of the path. With one project in
 * reach the path has no project level.
 */
function splitProject(config: AdoConfig, path: readonly string[]): { project?: AdoProject; rest: readonly string[] } {

    if (config.reach.length === 1)
        return { project: config.reach[0], rest: path };

    const project = path.length ? config.reach.find(p => pathKey(pathName(projectLabel(p))) === pathKey(path[0])) : undefined;

    return { project, rest: path.slice(1) };
}

/** The rows for `>ado>` + `path` with `query` typed at the next level. */
export async function adoLevels(context: AdoContext, path: readonly string[], query: string): Promise<PathMatch[]> {

    const { config } = context;

    if (!config.reach.length)
        return [{ name: "nothing", detail: "No project in reach - add one on the Connectors page.", disabled: true }];

    // `mine` comes first, before the project level.
    if (path.length && sameText(path[0], MINE))
        return adoMineLevels(context, path.slice(1), query);

    if (config.reach.length > 1 && !path.length)
        return [
            ...mineRow(context, query),
            ...config.reach
                .map(p => pathName(projectLabel(p)))
                .filter(name => matches(name, query))
                .map(name => ({ name, detail: "Project" }))
        ];

    const { project, rest } = splitProject(config, path);

    if (!project)
        return [];

    if (!rest.length)
        return [...(path.length ? [] : mineRow(context, query)), ...(Object.keys(SOURCE_LABEL) as AdoSource[])
            .filter(source => config.sources[source] !== "off" && matches(source, query))
            .map(source => ({ name: source, detail: SOURCE_LABEL[source] }))];

    const [source, ...below] = rest;

    if (!sourceOn(config, source))
        return [];

    const module = moduleOf(source);

    if (module)
        return module.levels(context, project, below, query);

    if (source === "workitems") {

        if (below.length)
            return [];

        const term = query.trim();

        if (/^\d+$/.test(term)) {

            const item = await itemIn(context, project, Number(term));

            return item ? [itemMatch(item)] : [{ name: term, detail: "No such work item in this project.", disabled: true }];
        }

        return (await searchItems(context, project, term || undefined, 20)).map(itemMatch);
    }

    if (source !== "builds" && source !== "releases")
        return [];

    if (!below.length)
        return (await pipelines(context, project, source))
            .filter(one => matches(one.name, query))
            .slice(0, 50)
            .map(one => ({ name: pathName(one.name), detail: one.folder ? `${one.folder.replace(/^\\/, "")}` : undefined }));

    if (below.length > 1)
        return [];

    const pipeline = await pipelineAt(context, project, source, below[0]);

    if (!pipeline)
        return [];

    const writable = config.sources[source] === "write";
    const fresh: PathMatch = {
        name: "new",
        detail: source === "builds" ? "Ask the agent to start a new run" : "Ask the agent to start a new release",
        leaf: true,
        ...(writable ? {} : { disabled: true, hint: "Set this source to Read and write on the Connectors page." })
    };

    const rows = source === "builds"
        ? (await buildRuns(context, project, pipeline.id, 20)).map(run => ({
            name: String(run.id),
            detail: [run.buildNumber, run.result ?? run.status, run.sourceBranch?.replace(/^refs\/heads\//, "")].filter(Boolean).join(" - "),
            leaf: true
        }))
        : (await releases(context, project, pipeline.id, 20)).map(release => ({
            name: String(release.id),
            detail: [release.name, stagesLine(release)].filter(Boolean).join(" - "),
            leaf: true
        }));

    return [fresh, ...rows].filter(row => !query || matches(`${row.name} ${row.detail ?? ""}`, query));
}

function itemMatch(item: WorkItem): PathMatch {

    const row = itemRow(item);

    return { name: String(row.id), detail: `${row.type} - ${row.title} - ${row.state}`, leaf: true };
}

/**
 * The line a picked `>ado>...` path adds to the message: what it is, its title and state, its link, and which tools read
 * it. A container level (`>ado>workitems`) adds nothing. A path that does
 * not resolve gives a reason instead.
 */
export async function adoReference(context: AdoContext, path: readonly string[]): Promise<ItemReference> {

    const { config } = context;

    if (path.length && sameText(path[0], MINE))
        return adoMineReference(context, path.slice(1), adoReference);

    const { project, rest } = splitProject(config, path);

    if (!project)
        return path.length ? { problem: `${path[0]} is not a project in reach` } : {};

    const [source, level, run] = rest;

    if (!source)
        return {};

    if (!sourceOn(config, source))
        return { problem: `${source} is off or not an ADO source` };

    const module = moduleOf(source);

    if (module)
        return module.reference(context, project, rest.slice(1));

    const where = `in ${projectLabel(project)}`;

    if (source === "workitems") {

        if (!level)
            return {};

        if (!/^\d+$/.test(level))
            return { problem: `${level} is not a work item number` };

        const item = await itemIn(context, project, Number(level));

        if (!item)
            return { problem: `work item ${level} is not ${where}` };

        const row = itemRow(item);

        return {
            line: `ADO ${row.type} ${row.id} ${where} - ${row.title} - ${row.state} - ${itemLink(project, row.id)} - read it with ado_read_work_item.`,
            link: itemLink(project, row.id),
            subject: { kind: "workitem", number: Number(row.id), title: String(row.title ?? ""), project: pathName(projectLabel(project)) }
        };
    }

    if (!level || (source !== "builds" && source !== "releases"))
        return {};

    const pipeline = await pipelineAt(context, project, source, level);
    const kind = source === "builds" ? "build pipeline" : "release pipeline";

    if (!pipeline)
        return { problem: `${level} is not a ${kind} ${where}` };

    const named = `ADO ${kind} "${pipeline.name}" (id ${pipeline.id}) ${where}`;
    const pipelineLink = source === "builds" ? `${web(project)}/_build?definitionId=${pipeline.id}` : `${web(project)}/_release?definitionId=${pipeline.id}`;

    if (!run)
        return { line: `${named} - ${pipelineLink} - list its runs with ${source === "builds" ? "ado_list_build_runs" : "ado_list_releases"}.`, link: pipelineLink };

    if (run === "new") {

        if (config.sources[source] !== "write")
            return { problem: `${source} is read only, so a new run cannot be started` };

        return {
            line: source === "builds"
                ? `Asked: start a new run of ${named}. Start it with ado_start_build_run once the branch and parameters are clear.`
                : `Asked: start a new release of ${named}. Start it with ado_start_release.`
        };
    }

    if (!/^\d+$/.test(run))
        return { problem: `${run} is not a run number` };

    if (source === "builds") {

        const found = (await buildRuns(context, project, pipeline.id, 200)).find(one => one.id === Number(run));

        if (!found)
            return { problem: `run ${run} is not a run of ${pipeline.name}` };

        return { line: `ADO build run ${found.id} (${found.buildNumber}) of "${pipeline.name}" ${where} - ${found.result ?? found.status} - branch ${found.sourceBranch?.replace(/^refs\/heads\//, "")} - ${web(project)}/_build/results?buildId=${found.id} - read it with ado_read_build_run.`, link: `${web(project)}/_build/results?buildId=${found.id}` };
    }

    const found = (await releases(context, project, pipeline.id, 200)).find(one => one.id === Number(run));

    if (!found)
        return { problem: `release ${run} is not a release of ${pipeline.name}` };

    return { line: `ADO release ${found.id} (${found.name}) of "${pipeline.name}" ${where} - ${stagesLine(found)} - ${web(project)}/_releaseProgress?_a=release-pipeline-progress&releaseId=${found.id} - read it with ado_read_release.`, link: `${web(project)}/_releaseProgress?_a=release-pipeline-progress&releaseId=${found.id}` };
}

// -------------------------------------------------------------------
// Saved queries - the team's and the person's own work item queries
// -------------------------------------------------------------------

interface SavedQuery {

    id: string;

    name: string;

    path: string;

    isFolder?: boolean;

    children?: SavedQuery[];
}

/** Every saved query two folders deep, as id and path ("Shared Queries/Active bugs"). */
function savedQueries(context: AdoContext, project: AdoProject): Promise<{ id: string; path: string }[]> {

    return context.api.kept("queries", projectLabel(project), async () => {

        const answer = await context.api<{ value: SavedQuery[] }>(`${projectApi(project)}/wit/queries?$depth=2&$expand=minimal&${API_VERSION}`);
        const found: { id: string; path: string }[] = [];

        const walk = (list: SavedQuery[] | undefined) => {

            for (const one of list ?? []) {

                if (one.isFolder)
                    walk(one.children);
                else
                    found.push({ id: one.id, path: one.path });
            }
        };

        walk(answer.value);

        return found;
    });
}

async function savedQueryAt(context: AdoContext, project: AdoProject, given: string): Promise<{ id: string; path: string } | undefined> {

    const list = await savedQueries(context, project);

    return list.find(one => one.id.toLowerCase() === given.toLowerCase())
        ?? list.find(one => pathKey(pathName(one.path)) === pathKey(pathName(given)));
}

const QUERIES: AdoSourceModule = {

    source: "queries",

    levels: async (context, project, below, query) => below.length
        ? []
        : (await savedQueries(context, project))
            .filter(one => matches(one.path, query))
            .slice(0, 50)
            .map(one => ({ name: pathName(one.path), leaf: true })),

    reference: async (context, project, below) => {

        if (!below[0])
            return {};

        const found = await savedQueryAt(context, project, below[0]);

        return found
            ? { line: `ADO saved query "${found.path}" (id ${found.id}) in ${projectLabel(project)} - run it with ado_run_query.` }
            : { problem: `${below[0]} is not a saved query in ${projectLabel(project)}` };
    },

    tools: [

        tool("queries", false, {
            name: "ado_list_queries",
            description: "List the saved work item queries of an Azure DevOps project - shared ones and the person's own - with their ids.",
            inputSchema: schema({ project: PROJECT, name: { type: "string", description: "Words the path contains." } }),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const name = text(args, "name") ?? "";

                return { project: projectLabel(project), queries: (await savedQueries(context, project)).filter(one => matches(one.path, name)) };
            }
        }),

        tool("queries", false, {
            name: "ado_run_query",
            description: "Run a saved Azure DevOps work item query and list the work items it finds.",
            inputSchema: schema({
                project: PROJECT,
                query: { type: "string", description: "The query's id, or its path like Shared Queries/Active bugs." },
                top: { type: "integer", description: "How many, 1 to 200. Default 50." }
            }, ["query"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const found = await savedQueryAt(context, project, text(args, "query", true));

                if (!found)
                    throw new ToolError(`${String(args.query)} is not a saved query in ${projectLabel(project)}. List them with ado_list_queries.`);

                const answer = await context.api<{ workItems?: { id: number }[]; workItemRelations?: { target?: { id: number } }[] }>(
                    `${projectApi(project)}/wit/wiql/${enc(found.id)}?${API_VERSION}`);

                const ids = [...new Set([
                    ...(answer.workItems ?? []).map(one => one.id),
                    ...(answer.workItemRelations ?? []).map(one => one.target?.id).filter((id): id is number => typeof id === "number")
                ])];

                const top = count(args, "top", 50, 200);

                return { query: found.path, total: ids.length, items: (await itemsByIds(context, project, ids.slice(0, top))).map(itemRow) };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Builds and releases
// -------------------------------------------------------------------

interface BuildRun {

    id: number;

    buildNumber: string;

    status: string;

    result?: string;

    sourceBranch?: string;

    sourceVersion?: string;

    queueTime?: string;

    startTime?: string;

    finishTime?: string;

    definition?: { id: number; name: string };

    requestedFor?: { displayName?: string };

    reason?: string;
}

function buildRow(run: BuildRun) {

    return {
        id: run.id,
        number: run.buildNumber,
        pipeline: run.definition?.name,
        status: run.status,
        result: run.result,
        branch: run.sourceBranch,
        commit: run.sourceVersion,
        reason: run.reason,
        by: run.requestedFor?.displayName,
        queued: run.queueTime,
        started: run.startTime,
        finished: run.finishTime
    };
}

async function buildRuns(context: AdoContext, project: AdoProject, pipelineId: number | undefined, top: number, extra = ""): Promise<BuildRun[]> {

    const answer = await context.api<{ value: BuildRun[] }>(
        `${projectApi(project)}/build/builds?${pipelineId !== undefined ? `definitions=${pipelineId}&` : ""}$top=${top}&queryOrder=queueTimeDescending${extra}&${API_VERSION}`);

    return answer.value;
}

interface Release {

    id: number;

    name: string;

    status: string;

    createdOn?: string;

    description?: string;

    createdBy?: { displayName?: string };

    releaseDefinition?: { id: number; name: string };

    environments?: ReleaseStage[];
}

interface ReleaseStage {

    id: number;

    name: string;

    status: string;

    deploySteps?: {
        attempt?: number;
        status?: string;
        releaseDeployPhases?: {
            name?: string;
            status?: string;
            deploymentJobs?: { tasks?: { name?: string; status?: string; issues?: { message?: string }[]; logUrl?: string }[] }[];
        }[];
    }[];
}

function stagesLine(release: Release): string {

    return (release.environments ?? []).map(stage => `${stage.name}: ${stage.status}`).join(", ") || release.status;
}

async function releases(context: AdoContext, project: AdoProject, pipelineId: number | undefined, top: number): Promise<Release[]> {

    const answer = await context.api<{ value: Release[] }>(
        `${releaseApi(project)}/release/releases?${pipelineId !== undefined ? `definitionId=${pipelineId}&` : ""}$top=${top}&$expand=environments&${API_VERSION}`);

    return answer.value;
}

// -------------------------------------------------------------------
// The tools
// -------------------------------------------------------------------

/** Field names like System.State or Microsoft.VSTS.Common.Priority. */
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,127}$/;

function fieldPatch(fields: unknown): { op: "add"; path: string; value: unknown }[] {

    if (!fields || typeof fields !== "object" || Array.isArray(fields))
        throw new ToolError("fields must be an object of field name to value, like { \"System.State\": \"Active\" }.");

    const patch = Object.entries(fields as Record<string, unknown>).map(([name, value]) => {

        if (!FIELD_NAME.test(name))
            throw new ToolError(`${name} is not a field name.`);

        return { op: "add" as const, path: `/fields/${name}`, value };
    });

    if (!patch.length)
        throw new ToolError("Give at least one field to change.");

    return patch;
}

export const ADO_TOOLS: readonly AdoTool[] = [

    tool("workitems", false, {
        name: "ado_search_work_items",
        description: "Search Azure DevOps work items in a project. Give words to look for in titles, or a full WIQL query. Newest changed first.",
        inputSchema: schema({
            project: PROJECT,
            words: { type: "string", description: "Words the title contains." },
            wiql: { type: "string", description: "A full WIQL SELECT query instead of words. @project is this project." },
            top: { type: "integer", description: "How many, 1 to 100. Default 20." }
        }),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const wiql = text(args, "wiql");

            if (wiql && !/^\s*select\b/i.test(wiql))
                throw new ToolError("wiql must be a SELECT query.");

            const items = await searchItems(context, project, text(args, "words"), count(args, "top", 20, 100), wiql);

            return { project: projectLabel(project), items: items.map(itemRow) };
        }
    }),

    tool("workitems", false, {
        name: "ado_read_work_item",
        description: "Read one Azure DevOps work item: its fields (description, acceptance criteria, repro steps), its links, and its latest comments.",
        inputSchema: schema({ project: PROJECT, id: { type: "integer" }, comments: { type: "integer", description: "How many latest comments, 0 to 100. Default 30." } }, ["id"]),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const id = whole(args, "id", true);
            const item = await itemOrFail(context, project, id, true);
            const f = item.fields;
            const wanted = Math.min(whole(args, "comments") ?? 30, 100);

            const comments = wanted
                ? (await context.api<{ comments?: { text?: string; createdBy?: { displayName?: string }; createdDate?: string }[] }>(
                    `${projectApi(project)}/wit/workItems/${id}/comments?$top=${wanted}&order=desc&${COMMENTS_VERSION}`)).comments ?? []
                : [];

            const fields: Record<string, unknown> = {};

            for (const [name, value] of Object.entries(f)) {

                if (value === null || value === "" || /^System\.(Rev|Watermark|CommentCount|AuthorizedAs|PersonId|AuthorizedDate|RevisedDate|IterationId|AreaId|NodeName|TeamProject)$/.test(name))
                    continue;

                fields[name] = typeof value === "string" && /<[a-z][\s\S]*>/i.test(value) ? plainText(value) : person(value) ?? value;
            }

            return {
                id: item.id,
                project: projectLabel(project),
                link: itemLink(project, item.id),
                fields,
                links: (item.relations ?? []).map(one => ({
                    kind: one.attributes?.name ?? one.rel,
                    url: one.url,
                    ...(one.attributes?.comment ? { comment: one.attributes.comment } : {})
                })),
                comments: comments.map(one => ({ by: one.createdBy?.displayName, at: one.createdDate, text: plainText(one.text) }))
            };
        }
    }),

    tool("workitems", true, {
        name: "ado_add_work_item_comment",
        description: "Add a comment to an Azure DevOps work item. The person is asked first.",
        inputSchema: schema({ project: PROJECT, id: { type: "integer" }, text: { type: "string", description: "Plain text. Line breaks are kept." } }, ["id", "text"]),
        describe: args => `Add a comment to work item ${String(args.id)}:\n\n${String(args.text ?? "")}`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const id = whole(args, "id", true);

            await itemOrFail(context, project, id);

            const added = await context.api<{ id: number }>(`${projectApi(project)}/wit/workItems/${id}/comments?${COMMENTS_VERSION}`, {
                method: "POST",
                body: { text: htmlOf(text(args, "text", true)) }
            });

            return { added: true, commentId: added?.id, link: itemLink(project, id) };
        }
    }),

    tool("workitems", true, {
        name: "ado_update_work_item",
        description: "Change fields of an Azure DevOps work item, like System.State, System.AssignedTo or System.Title. The person is asked first.",
        inputSchema: schema({
            project: PROJECT,
            id: { type: "integer" },
            fields: { type: "object", description: "Field name to new value, like { \"System.State\": \"Resolved\" }." }
        }, ["id", "fields"]),
        describe: args => `Change work item ${String(args.id)}:\n\n${JSON.stringify(args.fields, undefined, 2)}`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const id = whole(args, "id", true);
            const patch = fieldPatch(args.fields);

            await itemOrFail(context, project, id);

            const item = await context.api<WorkItem>(`${orgApi(project)}/wit/workitems/${id}?${API_VERSION}`, {
                method: "PATCH",
                body: patch,
                contentType: "application/json-patch+json"
            });

            return { updated: true, item: itemRow(item), link: itemLink(project, id) };
        }
    }),

    tool("workitems", true, {
        name: "ado_create_work_item",
        description: "Create an Azure DevOps work item of a type like Bug, Task or User Story. The person is asked first.",
        inputSchema: schema({
            project: PROJECT,
            type: { type: "string", description: "Bug, Task, User Story, ..." },
            title: { type: "string" },
            fields: { type: "object", description: "More fields, like { \"System.Description\": \"...\" }." }
        }, ["type", "title"]),
        describe: args => `Create a ${String(args.type)}: "${String(args.title)}"${args.fields ? `\n\n${JSON.stringify(args.fields, undefined, 2)}` : ""}`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const type = text(args, "type", true);
            const patch = [{ op: "add" as const, path: "/fields/System.Title", value: text(args, "title", true) }, ...(args.fields ? fieldPatch(args.fields) : [])];

            const item = await context.api<WorkItem>(`${projectApi(project)}/wit/workitems/$${enc(type)}?${API_VERSION}`, {
                method: "POST",
                body: patch,
                contentType: "application/json-patch+json"
            });

            return { created: true, item: itemRow(item), link: itemLink(project, item.id) };
        }
    }),

    tool("builds", false, {
        name: "ado_list_build_pipelines",
        description: "List the build pipelines of an Azure DevOps project, with their ids.",
        inputSchema: schema({ project: PROJECT, name: { type: "string", description: "Words the name contains." } }),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const name = text(args, "name") ?? "";

            return { project: projectLabel(project), pipelines: (await pipelines(context, project, "builds")).filter(one => matches(one.name, name)) };
        }
    }),

    tool("builds", false, {
        name: "ado_list_build_runs",
        description: "List recent runs of Azure DevOps build pipelines, newest first. Filter by pipeline, branch or result.",
        inputSchema: schema({
            project: PROJECT,
            pipelineId: { type: "integer" },
            branch: { type: "string", description: "main or refs/heads/main" },
            result: { type: "string", enum: ["succeeded", "partiallySucceeded", "failed", "canceled"] },
            top: { type: "integer", description: "How many, 1 to 100. Default 20." }
        }),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const branch = text(args, "branch");
            const result = text(args, "result");
            const extra = `${branch ? `&branchName=${enc(branchRef(branch))}` : ""}${result ? `&resultFilter=${enc(result)}` : ""}`;

            return { project: projectLabel(project), runs: (await buildRuns(context, project, whole(args, "pipelineId"), count(args, "top", 20, 100), extra)).map(buildRow) };
        }
    }),

    tool("builds", false, {
        name: "ado_read_build_run",
        description: "Read one Azure DevOps build run: its state, and the steps that failed or warned with their messages and log ids. Read a step's log with ado_read_build_log.",
        inputSchema: schema({ project: PROJECT, id: { type: "integer", description: "The run's id." } }, ["id"]),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const id = whole(args, "id", true);
            const run = await context.api<BuildRun>(`${projectApi(project)}/build/builds/${id}?${API_VERSION}`);
            const timeline = await context.api<{ records?: { name: string; type: string; state?: string; result?: string; log?: { id: number }; issues?: { type?: string; message?: string }[]; errorCount?: number; warningCount?: number }[] } | undefined>(
                `${projectApi(project)}/build/builds/${id}/timeline?${API_VERSION}`);

            const records = timeline?.records ?? [];
            const notable = records.filter(one =>
                (one.result && one.result !== "succeeded" && one.result !== "skipped") || (one.issues?.length ?? 0) > 0);

            return {
                ...buildRow(run),
                link: `${web(project)}/_build/results?buildId=${id}`,
                steps: records.length,
                notable: notable.slice(0, 50).map(one => ({
                    name: one.name,
                    type: one.type,
                    result: one.result ?? one.state,
                    logId: one.log?.id,
                    issues: one.issues?.slice(0, 10).map(issue => `${issue.type ?? ""}: ${issue.message ?? ""}`.trim())
                }))
            };
        }
    }),

    tool("builds", false, {
        name: "ado_read_build_log",
        description: "Read one step's log of an Azure DevOps build run - the last lines by default.",
        inputSchema: schema({
            project: PROJECT,
            id: { type: "integer", description: "The run's id." },
            logId: { type: "integer", description: "From ado_read_build_run." },
            lines: { type: "integer", description: "How many last lines, 1 to 3000. Default 300." }
        }, ["id", "logId"]),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const log = await context.api<string>(
                `${projectApi(project)}/build/builds/${whole(args, "id", true)}/logs/${whole(args, "logId", true)}?${API_VERSION}`, { text: true, accept: "text/plain" });

            const all = log.split(/\r?\n/);
            const wanted = count(args, "lines", 300, 3000);

            return { totalLines: all.length, from: Math.max(all.length - wanted, 0) + 1, text: capped(all.slice(-wanted).join("\n"), 200_000) };
        }
    }),

    tool("builds", true, {
        name: "ado_start_build_run",
        description: "Start a new run of an Azure DevOps build pipeline. The person is asked first.",
        inputSchema: schema({
            project: PROJECT,
            pipelineId: { type: "integer" },
            branch: { type: "string", description: "main or refs/heads/main. Default: the pipeline's own." },
            parameters: { type: "object", description: "The pipeline's runtime parameters, name to value." }
        }, ["pipelineId"]),
        describe: args => `Start a run of build pipeline ${String(args.pipelineId)}${args.branch ? ` on ${String(args.branch)}` : ""}${args.parameters ? `\n\n${JSON.stringify(args.parameters, undefined, 2)}` : ""}`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const branch = text(args, "branch");

            if (args.parameters !== undefined && (typeof args.parameters !== "object" || args.parameters === null || Array.isArray(args.parameters)))
                throw new ToolError("parameters must be an object of name to value.");

            const run = await context.api<BuildRun>(`${projectApi(project)}/build/builds?${API_VERSION}`, {
                method: "POST",
                body: {
                    definition: { id: whole(args, "pipelineId", true) },
                    ...(branch ? { sourceBranch: branchRef(branch) } : {}),
                    ...(args.parameters ? { templateParameters: args.parameters } : {})
                }
            });

            return { action: "started", ...buildRow(run), link: `${web(project)}/_build/results?buildId=${run.id}` };
        }
    }),

    tool("builds", true, {
        name: "ado_cancel_build_run",
        description: "Cancel an Azure DevOps build run that is still going. The person is asked first.",
        inputSchema: schema({ project: PROJECT, id: { type: "integer" } }, ["id"]),
        describe: args => `Cancel build run ${String(args.id)}`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const run = await context.api<BuildRun>(`${projectApi(project)}/build/builds/${whole(args, "id", true)}?${API_VERSION}`, {
                method: "PATCH",
                body: { status: "cancelling" }
            });

            return { cancelling: true, ...buildRow(run) };
        }
    }),

    tool("releases", false, {
        name: "ado_list_release_pipelines",
        description: "List the release pipelines of an Azure DevOps project, with their ids.",
        inputSchema: schema({ project: PROJECT, name: { type: "string", description: "Words the name contains." } }),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const name = text(args, "name") ?? "";

            return { project: projectLabel(project), pipelines: (await pipelines(context, project, "releases")).filter(one => matches(one.name, name)) };
        }
    }),

    tool("releases", false, {
        name: "ado_list_releases",
        description: "List recent Azure DevOps releases, newest first, with each stage's status.",
        inputSchema: schema({ project: PROJECT, pipelineId: { type: "integer" }, top: { type: "integer", description: "How many, 1 to 100. Default 20." } }),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const list = await releases(context, project, whole(args, "pipelineId"), count(args, "top", 20, 100));

            return {
                project: projectLabel(project),
                releases: list.map(one => ({
                    id: one.id,
                    name: one.name,
                    pipeline: one.releaseDefinition?.name,
                    status: one.status,
                    by: one.createdBy?.displayName,
                    created: one.createdOn,
                    stages: (one.environments ?? []).map(stage => ({ id: stage.id, name: stage.name, status: stage.status }))
                }))
            };
        }
    }),

    tool("releases", false, {
        name: "ado_read_release",
        description: "Read one Azure DevOps release: each stage's status, and the tasks that failed with their messages.",
        inputSchema: schema({ project: PROJECT, id: { type: "integer" } }, ["id"]),
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const id = whole(args, "id", true);
            const release = await context.api<Release>(`${releaseApi(project)}/release/releases/${id}?${API_VERSION}`);

            return {
                id: release.id,
                name: release.name,
                pipeline: release.releaseDefinition?.name,
                status: release.status,
                description: release.description,
                link: `${web(project)}/_releaseProgress?_a=release-pipeline-progress&releaseId=${id}`,
                stages: (release.environments ?? []).map(stage => {

                    const last = stage.deploySteps?.[stage.deploySteps.length - 1];
                    const tasks = (last?.releaseDeployPhases ?? []).flatMap(phase => (phase.deploymentJobs ?? []).flatMap(job => job.tasks ?? []));

                    return {
                        id: stage.id,
                        name: stage.name,
                        status: stage.status,
                        attempt: last?.attempt,
                        failedTasks: tasks
                            .filter(task => task.status && !["succeeded", "skipped", "pending", "inProgress"].includes(task.status))
                            .map(task => ({ name: task.name, status: task.status, issues: task.issues?.slice(0, 10).map(issue => issue.message), log: task.logUrl }))
                    };
                })
            };
        }
    }),

    tool("releases", true, {
        name: "ado_start_release",
        description: "Create and start a new Azure DevOps release from a release pipeline, with its default artifact versions. The person is asked first.",
        inputSchema: schema({ project: PROJECT, pipelineId: { type: "integer" }, description: { type: "string" } }, ["pipelineId"]),
        describe: args => `Start a new release of release pipeline ${String(args.pipelineId)}${args.description ? `: ${String(args.description)}` : ""}`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const release = await context.api<Release>(`${releaseApi(project)}/release/releases?${API_VERSION}`, {
                method: "POST",
                body: { definitionId: whole(args, "pipelineId", true), description: text(args, "description") ?? "Started from Eesha Code", isDraft: false }
            });

            return { started: true, id: release.id, name: release.name, link: `${web(project)}/_releaseProgress?_a=release-pipeline-progress&releaseId=${release.id}` };
        }
    }),

    tool("releases", true, {
        name: "ado_retry_release_stage",
        description: "Deploy one stage of an Azure DevOps release again - for a stage that failed or was not deployed. The person is asked first.",
        inputSchema: schema({ project: PROJECT, releaseId: { type: "integer" }, stageId: { type: "integer", description: "From ado_read_release." }, comment: { type: "string" } }, ["releaseId", "stageId"]),
        describe: args => `Deploy stage ${String(args.stageId)} of release ${String(args.releaseId)} again`,
        run: async (args, context) => {

            const project = projectFor(context.config, args.project);
            const stage = await context.api<ReleaseStage>(
                `${releaseApi(project)}/release/releases/${whole(args, "releaseId", true)}/environments/${whole(args, "stageId", true)}?api-version=7.1-preview.7`, {
                    method: "PATCH",
                    body: { status: "inProgress", scheduledDeploymentTime: null, comment: text(args, "comment") ?? "Deployed again from Eesha Code" }
                });

            return { deploying: true, stage: stage?.name, status: stage?.status };
        }
    })
];

/** The tools the choices allow: none for a source that is off, the read ones for Read. */
export function adoToolsFor(sources: Record<AdoSource, Access>): AdoTool[] {

    return [QUERIES, ...ADO_CODE_MODULES, ...ADO_DOCS_MODULES].reduce<AdoTool[]>((all, one) => [...all, ...one.tools], [...ADO_TOOLS])
        .filter(one => sources[one.source as AdoSource] === "write" || (sources[one.source as AdoSource] === "read" && !one.write));
}

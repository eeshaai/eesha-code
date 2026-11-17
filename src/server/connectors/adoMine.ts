import type { PathMatch } from "../../shared/composeFiles";
import { pathKey, pathName, sameText, type AdoConfig, type AdoProject, type AdoSource } from "./config";
import { API_VERSION, enc, matches, projectApi, projectLabel, web, type AdoContext } from "./adoBase";
import { ApiError } from "./http";
import type { ItemReference } from "./tools";

/*
 * `>ado>mine>`: the person's own work items, pull requests, build runs
 * and saved queries across every project in reach, with no project step.
 *
 * An item is named `12` when one project is in reach, else with its
 * project first: `contoso/Web#12`. Work items, pull requests and queries
 * get the same reference line as under their project, made by ado.ts.
 */

export const MINE = "mine";

const MINE_SOURCES = {
    workitems: "Work items assigned to me, not closed",
    pulls: "Active pull requests I created or review",
    builds: "Build runs I started",
    queries: "My own saved queries (My Queries)"
} as const;

type MineSource = keyof typeof MINE_SOURCES;

type Reference = ItemReference;

function isOn(config: AdoConfig, source: string): source is MineSource {

    return source in MINE_SOURCES && config.sources[source as AdoSource] !== "off";
}

/** The `mine` row at `>ado>`, when one of its sources is on. */
export function mineRow(context: AdoContext, query: string): PathMatch[] {

    return Object.keys(MINE_SOURCES).some(source => isOn(context.config, source)) && matches(MINE, query)
        ? [{ name: MINE, detail: "My work items, pull requests, builds and queries, across every project in reach" }]
        : [];
}

/** The organizations in reach, each once, with their projects. */
function orgsOf(config: AdoConfig): { org: string; projects: AdoProject[] }[] {

    const orgs: { org: string; projects: AdoProject[] }[] = [];

    for (const project of config.reach) {

        const known = orgs.find(one => sameText(one.org, project.org));

        if (known)
            known.projects.push(project);
        else
            orgs.push({ org: project.org, projects: [project] });
    }

    return orgs;
}

const orgUrl = (org: string) => `https://dev.azure.com/${enc(org)}`;

/** The signed-in person's id in an organization. Kept a day. */
function myId(context: AdoContext, org: string): Promise<string> {

    return context.api.kept("me", org, async () =>
        (await context.api<{ authenticatedUser: { id: string } }>(`${orgUrl(org)}/_apis/connectionData`)).authenticatedUser.id);
}

function mineName(config: AdoConfig, project: AdoProject, key: string): string {

    return config.reach.length === 1 ? key : `${pathName(projectLabel(project))}#${key}`;
}

function parseMineName(config: AdoConfig, level: string): { project: AdoProject; key: string } | undefined {

    if (config.reach.length === 1)
        return { project: config.reach[0], key: level };

    const at = level.indexOf("#");

    if (at < 1)
        return undefined;

    const named = level.slice(0, at);
    const project = config.reach.find(p => pathKey(pathName(projectLabel(p))) === pathKey(named));

    return project ? { project, key: level.slice(at + 1) } : undefined;
}

/** Each project's answer, or nothing for a project that does not answer, so one bad project does not hide the rest. */
async function eachProject<T>(config: AdoConfig, load: (project: AdoProject) => Promise<T[]>): Promise<T[]> {

    const lists = await Promise.all(config.reach.map(project => load(project).catch(error => {

        if (error instanceof ApiError && (error.status === 404 || error.status === 403))
            return [];

        throw error;
    })));

    return lists.flat();
}

// -------------------------------------------------------------------
// The lists
// -------------------------------------------------------------------

const wiqlText = (value: string) => value.replace(/'/g, "''");

async function myWorkItems(context: AdoContext, words: string): Promise<PathMatch[]> {

    const { config } = context;

    const lists = await Promise.all(orgsOf(config).map(async ({ org, projects }) => {

        const query = [
            "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me",
            "AND [System.State] NOT IN ('Closed', 'Done', 'Removed')",
            `AND [System.TeamProject] IN (${projects.map(p => `'${wiqlText(p.project)}'`).join(", ")})`,
            /^\d+$/.test(words) ? `AND [System.Id] = ${words}` : words ? `AND [System.Title] CONTAINS '${wiqlText(words)}'` : "",
            "ORDER BY [System.ChangedDate] DESC"
        ].filter(Boolean).join(" ");

        const found = await context.api<{ workItems?: { id: number }[] }>(
            `${orgUrl(org)}/_apis/wit/wiql?$top=50&${API_VERSION}`, { method: "POST", body: { query } });
        const ids = (found.workItems ?? []).slice(0, 50).map(one => one.id);

        if (!ids.length)
            return [];

        const items = await context.api<{ value: ({ id: number; fields: Record<string, unknown> } | null)[] }>(
            `${orgUrl(org)}/_apis/wit/workitems?ids=${ids.join(",")}&fields=System.Id,System.Title,System.State,System.WorkItemType,System.TeamProject&errorPolicy=omit&${API_VERSION}`);

        return items.value.flatMap((item): PathMatch[] => {

            const project = item && projects.find(p => sameText(p.project, String(item.fields["System.TeamProject"] ?? "")));

            return item && project
                ? [{ name: mineName(config, project, String(item.id)), detail: `${item.fields["System.WorkItemType"]} - ${item.fields["System.Title"]} - ${item.fields["System.State"]}`, leaf: true }]
                : [];
        });
    }));

    return lists.flat();
}

interface MyPull {

    pullRequestId: number;

    title: string;

    creationDate?: string;

    repository: { name: string };
}

async function myPulls(context: AdoContext, words: string): Promise<PathMatch[]> {

    const { config } = context;

    const rows = await eachProject(config, async project => {

        const id = await myId(context, project.org);

        const [mine, review] = await Promise.all(["creatorId", "reviewerId"].map(async who =>
            (await context.api<{ value: MyPull[] }>(
                `${projectApi(project)}/git/pullrequests?searchCriteria.${who}=${enc(id)}&searchCriteria.status=active&$top=100&${API_VERSION}`)).value));

        const list: { project: AdoProject; pull: MyPull; why: string[] }[] = mine.map(pull => ({ project, pull, why: ["mine"] }));

        for (const pull of review) {

            const known = list.find(one => one.pull.pullRequestId === pull.pullRequestId);

            if (known)
                known.why.push("review");
            else
                list.push({ project, pull, why: ["review"] });
        }

        return list;
    });

    return rows
        .filter(({ pull }) => /^\d+$/.test(words) ? String(pull.pullRequestId) === words : matches(`${pull.title} ${pull.repository.name}`, words))
        .sort((a, b) => (b.pull.creationDate ?? "").localeCompare(a.pull.creationDate ?? ""))
        .slice(0, 30)
        .map(({ project, pull, why }) => ({
            name: mineName(config, project, String(pull.pullRequestId)),
            detail: `${pull.repository.name} - ${pull.title} - ${why.join(", ")}`,
            leaf: true
        }));
}

interface MyBuild {

    id: number;

    buildNumber: string;

    status: string;

    result?: string;

    sourceBranch?: string;

    queueTime?: string;

    definition?: { name: string };
}

const branchOf = (run: MyBuild) => run.sourceBranch?.replace(/^refs\/heads\//, "");

async function myBuilds(context: AdoContext, words: string): Promise<PathMatch[]> {

    const { config } = context;

    const runs = await eachProject(config, async project => {

        const id = await myId(context, project.org);
        const answer = await context.api<{ value: MyBuild[] }>(
            `${projectApi(project)}/build/builds?requestedFor=${enc(id)}&$top=20&queryOrder=queueTimeDescending&${API_VERSION}`);

        return answer.value.map(run => ({ project, run }));
    });

    return runs
        .filter(({ run }) => matches(`${run.id} ${run.buildNumber} ${run.definition?.name ?? ""} ${branchOf(run) ?? ""}`, words))
        .sort((a, b) => (b.run.queueTime ?? "").localeCompare(a.run.queueTime ?? ""))
        .slice(0, 20)
        .map(({ project, run }) => ({
            name: mineName(config, project, String(run.id)),
            detail: [run.definition?.name, run.buildNumber, run.result ?? run.status, branchOf(run)].filter(Boolean).join(" - "),
            leaf: true
        }));
}

interface QueryNode {

    id: string;

    path: string;

    isFolder?: boolean;

    children?: QueryNode[];
}

async function myQueries(context: AdoContext, words: string): Promise<PathMatch[]> {

    const { config } = context;

    // One level down, as the project's own `queries` list reads it, so a picked query is found there too.
    const found = await eachProject(config, async project => {

        const folder = await context.api<QueryNode>(`${projectApi(project)}/wit/queries/${enc("My Queries")}?$depth=1&$expand=minimal&${API_VERSION}`);

        return (folder.children ?? []).filter(one => !one.isFolder).map(query => ({ project, query }));
    });

    return found
        .filter(({ query }) => matches(query.path, words))
        .slice(0, 50)
        .map(({ project, query }) => ({ name: mineName(config, project, pathName(query.path)), detail: config.reach.length > 1 ? projectLabel(project) : undefined, leaf: true }));
}

// -------------------------------------------------------------------
// The levels and the reference line
// -------------------------------------------------------------------

/** The rows for `>ado>mine>` + `below`. */
export async function adoMineLevels(context: AdoContext, below: readonly string[], query: string): Promise<PathMatch[]> {

    if (!below.length)
        return (Object.keys(MINE_SOURCES) as MineSource[])
            .filter(source => isOn(context.config, source) && matches(source, query))
            .map(source => ({ name: source, detail: MINE_SOURCES[source] }));

    const [source] = below;

    if (below.length > 1 || !isOn(context.config, source))
        return [];

    const words = query.trim();

    return source === "workitems" ? myWorkItems(context, words)
        : source === "pulls" ? myPulls(context, words)
            : source === "builds" ? myBuilds(context, words)
                : myQueries(context, words);
}

/**
 * The line for `>ado>mine>source>item`. Work items, pull requests and
 * queries give the line their project's own path gives, through
 * `referenceAt` (ado.ts's `adoReference`); a build run is read here, as
 * the project's path needs its pipeline.
 */
export async function adoMineReference(
    context: AdoContext,
    below: readonly string[],
    referenceAt: (context: AdoContext, path: readonly string[]) => Promise<Reference>
): Promise<Reference> {

    const { config } = context;
    const [source, level] = below;

    if (!source)
        return {};

    if (!isOn(config, source))
        return { problem: `${source} is off or has no "mine" list - mine has ${Object.keys(MINE_SOURCES).join(", ")}` };

    if (!level)
        return {};

    const named = parseMineName(config, level);

    if (!named)
        return { problem: `${level} is not in a project in reach - write it as org/project#id` };

    const { project, key } = named;
    const projectPath = config.reach.length === 1 ? [] : [pathName(projectLabel(project))];

    if (source !== "builds")
        return referenceAt(context, [...projectPath, source, key]);

    if (!/^\d+$/.test(key))
        return { problem: `${key} is not a build run number` };

    let run: MyBuild;

    try {

        run = await context.api<MyBuild>(`${projectApi(project)}/build/builds/${key}?${API_VERSION}`);

    } catch (error) {

        if (error instanceof ApiError && error.status === 404)
            return { problem: `build run ${key} is not in ${projectLabel(project)}` };

        throw error;
    }

    return { line: `ADO build run ${run.id} (${run.buildNumber}) of "${run.definition?.name ?? "?"}" in ${projectLabel(project)} - ${run.result ?? run.status} - branch ${branchOf(run)} - ${web(project)}/_build/results?buildId=${run.id} - read it with ado_read_build_run.`, link: `${web(project)}/_build/results?buildId=${run.id}` };
}

import type { PathMatch } from "../../shared/composeFiles";
import {
    adoTool as tool, API_VERSION, enc, matches, PROJECT, projectApi, projectFor, projectLabel, searchApi, web,
    type AdoContext, type AdoSourceModule
} from "./adoBase";
import { pathKey, pathName, type AdoProject } from "./config";
import { capped, count, schema, text, ToolError, whole } from "./tools";

/*
 * Azure DevOps documents: the wiki and test plans. Both are read only
 * here - the wiki is edited in its own repo with git, and test results
 * come from pipelines.
 */

// -------------------------------------------------------------------
// Wiki
// -------------------------------------------------------------------

interface Wiki {

    id: string;

    name: string;

    type?: string;

    remoteUrl?: string;
}

interface WikiPage {

    path: string;

    remoteUrl?: string;

    content?: string;

    subPages?: WikiPage[];
}

function wikis(context: AdoContext, project: AdoProject): Promise<Wiki[]> {

    return context.api.kept("wikis", projectLabel(project), async () =>
        (await context.api<{ value: Wiki[] }>(`${projectApi(project)}/wiki/wikis?${API_VERSION}`)).value);
}

/** A wiki named by a path level or a tool's input: its name (dashes for spaces) or its id. */
async function wikiAt(context: AdoContext, project: AdoProject, given: string): Promise<Wiki | undefined> {

    const list = await wikis(context, project);

    return list.find(one => one.id.toLowerCase() === given.toLowerCase())
        ?? list.find(one => pathKey(pathName(one.name)) === pathKey(given));
}

/** The wiki a tool means: `wiki` when given, else the only one. */
async function wikiFor(context: AdoContext, project: AdoProject, given: unknown): Promise<Wiki> {

    if (typeof given === "string" && given.trim()) {

        const found = await wikiAt(context, project, given.trim());

        if (!found)
            throw new ToolError(`${given} is not a wiki in ${projectLabel(project)}. List them with ado_list_wiki_pages.`);

        return found;
    }

    const list = await wikis(context, project);

    if (list.length === 1)
        return list[0];

    if (!list.length)
        throw new ToolError(`${projectLabel(project)} has no wiki.`);

    throw new ToolError(`Say which wiki: ${list.map(one => one.name).join(", ")}.`);
}

/** Every page path of a wiki, kept ten minutes. */
function pagePaths(context: AdoContext, project: AdoProject, wiki: Wiki): Promise<string[]> {

    return context.api.kept("wikipages", `${projectLabel(project)}:${wiki.id}`, async () => {

        const root = await context.api<WikiPage>(`${projectApi(project)}/wiki/wikis/${enc(wiki.id)}/pages?path=/&recursionLevel=full&${API_VERSION}`);
        const paths: string[] = [];
        const walk = (page: WikiPage) => {

            if (page.path && page.path !== "/")
                paths.push(page.path);

            page.subPages?.forEach(walk);
        };

        walk(root);

        return paths;
    });
}

/** A page path from a path level: the level is the path with dashes for spaces. */
async function pageAt(context: AdoContext, project: AdoProject, wiki: Wiki, level: string): Promise<string | undefined> {

    return (await pagePaths(context, project, wiki)).find(one => pathKey(pathName(one)) === pathKey(level));
}

const WIKI_INPUT = { type: "string", description: "The wiki's name. Leave it out when the project has one wiki." };

const ADO_WIKI: AdoSourceModule = {

    source: "wiki",

    levels: async (context, project, below, query) => {

        if (!below.length)
            return (await wikis(context, project))
                .filter(one => matches(one.name, query))
                .map(one => ({ name: pathName(one.name), detail: one.type === "codeWiki" ? "Code wiki" : "Project wiki" }));

        if (below.length > 1)
            return [];

        const wiki = await wikiAt(context, project, below[0]);

        if (!wiki)
            return [];

        return (await pagePaths(context, project, wiki))
            .filter(one => matches(one, query))
            .slice(0, 50)
            .map((one): PathMatch => ({ name: pathName(one), leaf: true }));
    },

    reference: async (context, project, below) => {

        if (!below[0])
            return {};

        const wiki = await wikiAt(context, project, below[0]);

        if (!wiki)
            return { problem: `${below[0]} is not a wiki in ${projectLabel(project)}` };

        if (!below[1])
            return { line: `ADO wiki ${wiki.name} in ${projectLabel(project)} - ${web(project)}/_wiki/wikis/${enc(wiki.name)} - list its pages with ado_list_wiki_pages, read one with ado_read_wiki_page.`, link: `${web(project)}/_wiki/wikis/${enc(wiki.name)}` };

        const page = await pageAt(context, project, wiki, below[1]);

        if (!page)
            return { problem: `${below[1]} is not a page of the ${wiki.name} wiki` };

        return { line: `ADO wiki page "${page}" in the ${wiki.name} wiki of ${projectLabel(project)} - read it with ado_read_wiki_page.` };
    },

    tools: [

        tool("wiki", false, {
            name: "ado_list_wiki_pages",
            description: "List the wikis of an Azure DevOps project, or the page paths of one wiki.",
            inputSchema: schema({ project: PROJECT, wiki: WIKI_INPUT, words: { type: "string", description: "Words the page path contains." } }),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const list = await wikis(context, project);

                if (!args.wiki && list.length !== 1)
                    return { wikis: list.map(one => ({ name: one.name, kind: one.type, repo: one.remoteUrl })) };

                const wiki = await wikiFor(context, project, args.wiki);
                const words = text(args, "words") ?? "";

                return { wiki: wiki.name, pages: (await pagePaths(context, project, wiki)).filter(one => matches(one, words)) };
            }
        }),

        tool("wiki", false, {
            name: "ado_read_wiki_page",
            description: "Read one Azure DevOps wiki page as Markdown.",
            inputSchema: schema({
                project: PROJECT,
                wiki: WIKI_INPUT,
                path: { type: "string", description: "The page path, like /Home/Getting Started." }
            }, ["path"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const wiki = await wikiFor(context, project, args.wiki);
                const given = text(args, "path", true);
                const path = given.startsWith("/") ? given : (await pageAt(context, project, wiki, given)) ?? `/${given}`;
                const page = await context.api<WikiPage>(`${projectApi(project)}/wiki/wikis/${enc(wiki.id)}/pages?path=${enc(path)}&includeContent=true&${API_VERSION}`);

                return { wiki: wiki.name, path: page.path, link: page.remoteUrl, text: capped(page.content ?? "", 100_000) };
            }
        }),

        tool("wiki", false, {
            name: "ado_search_wiki",
            description: "Search the wiki pages of an Azure DevOps project. Needs the organization's search to be on.",
            inputSchema: schema({
                project: PROJECT,
                words: { type: "string" },
                top: { type: "integer", description: "How many, 1 to 100. Default 25." }
            }, ["words"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const answer = await context.api<{ count?: number; results?: { fileName?: string; path?: string; wiki?: { name?: string } }[] }>(
                    `${searchApi(project)}/search/wikisearchresults?${API_VERSION}`, {
                        method: "POST",
                        body: { searchText: text(args, "words", true), $top: count(args, "top", 25, 100), $skip: 0, filters: { Project: [project.project] } }
                    });

                return {
                    total: answer.count,
                    pages: (answer.results ?? []).map(one => ({ wiki: one.wiki?.name, path: one.path?.replace(/\.md$/, ""), file: one.fileName }))
                };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Test plans
// -------------------------------------------------------------------

interface TestPlan {

    id: number;

    name: string;

    state?: string;

    iteration?: string;

    areaPath?: string;

    owner?: { displayName?: string };

    startDate?: string;

    endDate?: string;
}

function testPlans(context: AdoContext, project: AdoProject): Promise<TestPlan[]> {

    return context.api.kept("testplans", projectLabel(project), async () =>
        (await context.api<{ value: TestPlan[] }>(`${projectApi(project)}/testplan/plans?${API_VERSION}`)).value);
}

const planLink = (project: AdoProject, plan: TestPlan) => `${web(project)}/_testPlans/define?planId=${plan.id}`;

const ADO_TESTPLANS: AdoSourceModule = {

    source: "testplans",

    levels: async (context, project, below, query) => below.length
        ? []
        : (await testPlans(context, project))
            .filter(plan => matches(`${plan.id} ${plan.name}`, query))
            .slice(0, 50)
            .map(plan => ({ name: String(plan.id), detail: `${plan.name}${plan.state ? ` - ${plan.state}` : ""}`, leaf: true })),

    reference: async (context, project, below) => {

        if (!below[0])
            return {};

        const plan = (await testPlans(context, project)).find(one => String(one.id) === below[0]);

        if (!plan)
            return { problem: `${below[0]} is not a test plan in ${projectLabel(project)}` };

        return { line: `ADO test plan ${plan.id} "${plan.name}" in ${projectLabel(project)}${plan.iteration ? ` - ${plan.iteration}` : ""} - ${planLink(project, plan)} - read it with ado_read_test_plan, its runs with ado_list_test_runs.`, link: planLink(project, plan) };
    },

    tools: [

        tool("testplans", false, {
            name: "ado_list_test_plans",
            description: "List the test plans of an Azure DevOps project.",
            inputSchema: schema({ project: PROJECT, words: { type: "string", description: "Words in the name." } }),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const words = text(args, "words") ?? "";

                return {
                    plans: (await testPlans(context, project)).filter(plan => matches(plan.name, words)).map(plan => ({
                        id: plan.id, name: plan.name, state: plan.state, iteration: plan.iteration, area: plan.areaPath,
                        owner: plan.owner?.displayName, start: plan.startDate, end: plan.endDate, link: planLink(project, plan)
                    }))
                };
            }
        }),

        tool("testplans", false, {
            name: "ado_read_test_plan",
            description: "Read an Azure DevOps test plan: its suites, or with a suite given, that suite's test cases and their latest outcome per configuration.",
            inputSchema: schema({
                project: PROJECT,
                plan: { type: "integer", description: "The plan id." },
                suite: { type: "integer", description: "A suite id from this plan." }
            }, ["plan"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const planId = whole(args, "plan", true);
                const suiteId = whole(args, "suite");
                const base = `${projectApi(project)}/testplan/Plans/${planId}`;

                if (suiteId === undefined) {

                    const suites = await context.api<{ value: { id: number; name: string; suiteType?: string; parentSuite?: { id?: number } }[] }>(`${base}/suites?${API_VERSION}`);

                    return { plan: planId, suites: suites.value.map(one => ({ id: one.id, name: one.name, kind: one.suiteType, parent: one.parentSuite?.id })) };
                }

                const points = await context.api<{ value: { testCaseReference?: { id?: number; name?: string }; configuration?: { name?: string }; tester?: { displayName?: string }; results?: { outcome?: string; lastResultState?: string } }[] }>(
                    `${base}/Suites/${suiteId}/TestPoint?${API_VERSION}`);

                return {
                    plan: planId,
                    suite: suiteId,
                    tests: points.value.map(one => ({
                        testCase: one.testCaseReference?.id,
                        title: one.testCaseReference?.name,
                        configuration: one.configuration?.name,
                        tester: one.tester?.displayName,
                        outcome: one.results?.outcome ?? "none"
                    }))
                };
            }
        }),

        tool("testplans", false, {
            name: "ado_list_test_runs",
            description: "List recent Azure DevOps test runs, newest first - of a plan when given - with pass and fail counts.",
            inputSchema: schema({
                project: PROJECT,
                plan: { type: "integer", description: "Only runs of this plan." },
                top: { type: "integer", description: "How many, 1 to 100. Default 20." }
            }),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const plan = whole(args, "plan");
                const answer = await context.api<{ value: { id: number; name: string; state?: string; totalTests?: number; passedTests?: number; unanalyzedTests?: number; startedDate?: string; completedDate?: string; webAccessUrl?: string }[] }>(
                    `${projectApi(project)}/test/runs?${plan !== undefined ? `planId=${plan}&` : ""}$top=${count(args, "top", 20, 100)}&${API_VERSION}`);

                return {
                    runs: answer.value
                        .sort((a, b) => b.id - a.id)
                        .map(one => ({ id: one.id, name: one.name, state: one.state, total: one.totalTests, passed: one.passedTests, notPassed: one.unanalyzedTests, started: one.startedDate, completed: one.completedDate, link: one.webAccessUrl }))
                };
            }
        }),

        tool("testplans", false, {
            name: "ado_read_test_run",
            description: "Read the results of one Azure DevOps test run - failed ones by default - with error messages and stack traces.",
            inputSchema: schema({
                project: PROJECT,
                run: { type: "integer" },
                outcome: { type: "string", enum: ["Failed", "Passed", "all"], description: "Default Failed." },
                top: { type: "integer", description: "How many, 1 to 1000. Default 100." }
            }, ["run"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const outcome = text(args, "outcome") ?? "Failed";
                const answer = await context.api<{ value: { id: number; testCaseTitle?: string; automatedTestName?: string; outcome?: string; errorMessage?: string; stackTrace?: string; durationInMs?: number }[] }>(
                    `${projectApi(project)}/test/Runs/${whole(args, "run", true)}/results?${outcome === "all" ? "" : `outcomes=${enc(outcome)}&`}$top=${count(args, "top", 100, 1000)}&${API_VERSION}`);

                return {
                    run: whole(args, "run", true),
                    results: answer.value.map(one => ({
                        title: one.testCaseTitle,
                        test: one.automatedTestName,
                        outcome: one.outcome,
                        ms: one.durationInMs,
                        error: one.errorMessage ? capped(one.errorMessage, 4_000) : undefined,
                        stack: one.stackTrace ? capped(one.stackTrace, 4_000) : undefined
                    }))
                };
            }
        })
    ]
};

export const ADO_DOCS_MODULES: readonly AdoSourceModule[] = [ADO_WIKI, ADO_TESTPLANS];

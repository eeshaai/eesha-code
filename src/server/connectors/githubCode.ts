import type { PathMatch } from "../../shared/composeFiles";
import { pathKey, pathName } from "./config";
import {
    API, enc, ghTool as tool, matches, orMissing, reachQualifiers, REPO_INPUT, repoApi, repoFor, repoIn, repoInReach, repoLevel, repoRows,
    type GithubContext, type GithubSourceModule
} from "./githubBase";
import { capped, count, schema, text, ToolError, whole } from "./tools";

/*
 * GitHub code: files and history (read only - the agent changes code
 * with git), Actions, and releases. All three live inside one repo, so
 * their paths start with the repo - left out when only one repo is in
 * reach.
 */

/** A repo's default branch, kept half an hour. */
async function defaultBranch(context: GithubContext, repo: string): Promise<string> {

    const found = await context.api.kept("repo", repo, () => repoIn(context, repo));

    if (!found)
        throw new ToolError(`${repo} is not there.`);

    return found.default_branch ?? "main";
}

// -------------------------------------------------------------------
// Files and history
// -------------------------------------------------------------------

/**
 * Every file and folder path on the default branch. The list is kept
 * under the commit the branch is on, which never changes, so it is
 * fetched again only when the branch moves.
 */
async function treePaths(context: GithubContext, repo: string): Promise<{ path: string; folder: boolean }[]> {

    const branch = await defaultBranch(context, repo);

    // This Accept asks for the commit's SHA alone, as text.
    const head = (await context.api.kept("head", `${repo}:${branch}`, () =>
        context.api<string>(`${repoApi(repo)}/commits/${enc(branch)}`, { accept: "application/vnd.github.sha", text: true }))).trim();

    return context.api.kept("tree", `${repo}:${head}`, async () => {

        const tree = await context.api<{ tree: { path: string; type: string }[]; truncated?: boolean }>(`${repoApi(repo)}/git/trees/${enc(head)}?recursive=1`);

        return tree.tree.map(one => ({ path: one.path, folder: one.type === "tree" }));
    });
}

const GITHUB_FILES: GithubSourceModule = {

    source: "files",

    levels: async (context, below, query) => {

        const { repo, rest } = repoLevel(context.config, below);

        if (!repo)
            return below.length ? [] : repoRows(context, query);

        if (rest.length)
            return [];

        const key = pathKey(query);

        return (await treePaths(context, repo))
            .filter(one => !key || pathKey(one.path).includes(key))
            // Names that hold what is typed come before paths that only hold it in a folder.
            .sort((a, b) => Number(!pathKey(a.path.split("/").pop() ?? "").includes(key)) - Number(!pathKey(b.path.split("/").pop() ?? "").includes(key)))
            .slice(0, 50)
            .map((one): PathMatch => ({ name: pathName(one.path), detail: one.folder ? "folder" : undefined, leaf: true }));
    },

    reference: async (context, below) => {

        const { repo, rest, problem } = repoLevel(context.config, below);

        if (problem)
            return { problem };

        if (!repo)
            return {};

        if (!rest[0])
            return { line: `GitHub repo ${repo} - read its files with gh_read_file, its history with gh_list_commits.` };

        const found = (await treePaths(context, repo)).find(one => pathKey(pathName(one.path)) === pathKey(rest[0]));

        if (!found)
            return { problem: `${rest[0]} is not on the default branch of ${repo}` };

        return { line: `GitHub ${found.folder ? "folder" : "file"} ${found.path} in ${repo} (default branch ${await defaultBranch(context, repo)}) - read it with gh_read_file.` };
    },

    tools: [

        tool("files", false, {
            name: "gh_read_file",
            description: "Read one file of a GitHub repo at a branch, tag or commit - or list a folder's entries when the path is a folder.",
            inputSchema: schema({
                repo: REPO_INPUT,
                path: { type: "string", description: "Like src/app.ts. Default: the root folder." },
                ref: { type: "string", description: "A branch, tag or commit. Default: the default branch." }
            }),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const path = (text(args, "path") ?? "").replace(/^\/+/, "");
                const ref = text(args, "ref");
                const url = `${repoApi(repo)}/contents/${path.split("/").map(enc).join("/")}${ref ? `?ref=${enc(ref)}` : ""}`;
                const found = await orMissing(() => context.api<{ type: string; path: string; content?: string; encoding?: string; size?: number }[] | { type: string; path: string; content?: string; encoding?: string; size?: number }>(url));

                if (!found)
                    throw new ToolError(`${path || "/"} is not in ${repo}${ref ? ` at ${ref}` : ""}.`);

                if (Array.isArray(found))
                    return { repo, folder: path || "/", ref, entries: found.map(one => `${one.path}${one.type === "dir" ? "/" : ""}`) };

                if (found.type !== "file")
                    return { repo, path: found.path, kind: found.type };

                // Files over 1 MB come without content; ask for the raw file.
                const body = found.encoding === "base64" && found.content
                    ? Buffer.from(found.content, "base64").toString("utf8")
                    : await context.api<string>(url, { text: true, accept: "application/vnd.github.raw+json" });

                return { repo, path: found.path, ref, text: capped(body, 200_000) };
            }
        }),

        tool("files", false, {
            name: "gh_list_branches",
            description: "List the branches of a GitHub repo.",
            inputSchema: schema({ repo: REPO_INPUT, name: { type: "string", description: "Words the branch name contains." } }),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const list = await context.api<{ name: string; commit: { sha: string }; protected?: boolean }[]>(`${repoApi(repo)}/branches?per_page=100`);
                const name = text(args, "name") ?? "";

                return { repo, branches: list.filter(one => matches(one.name, name)).map(one => ({ name: one.name, commit: one.commit.sha, protected: one.protected || undefined })) };
            }
        }),

        tool("files", false, {
            name: "gh_list_commits",
            description: "List recent commits of a GitHub repo, newest first - on a branch, and touching a path when given.",
            inputSchema: schema({
                repo: REPO_INPUT,
                ref: { type: "string", description: "A branch, tag or commit. Default: the default branch." },
                path: { type: "string", description: "Only commits that changed this file or folder." },
                author: { type: "string", description: "A GitHub login or email." },
                top: { type: "integer", description: "How many, 1 to 100. Default 20." }
            }),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const query = [
                    `per_page=${count(args, "top", 20, 100)}`,
                    text(args, "ref") ? `sha=${enc(text(args, "ref", true))}` : "",
                    text(args, "path") ? `path=${enc(text(args, "path", true))}` : "",
                    text(args, "author") ? `author=${enc(text(args, "author", true))}` : ""
                ].filter(Boolean).join("&");
                const list = await context.api<{ sha: string; html_url: string; author?: { login?: string } | null; commit: { message: string; author?: { name?: string; date?: string } } }[]>(`${repoApi(repo)}/commits?${query}`);

                return {
                    repo,
                    commits: list.map(one => ({ commit: one.sha, message: one.commit.message, by: one.author?.login ?? one.commit.author?.name, at: one.commit.author?.date, link: one.html_url }))
                };
            }
        }),

        tool("files", false, {
            name: "gh_read_commit",
            description: "Read one commit of a GitHub repo: its message and the changed files with their diff. The diff is cut when it is long.",
            inputSchema: schema({
                repo: REPO_INPUT,
                commit: { type: "string", description: "A commit id, or a branch or tag for its newest commit." },
                diffChars: { type: "integer", description: "Most diff characters to give, 0 to 400000. Default 60000." }
            }, ["commit"]),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const found = await orMissing(() => context.api<{ sha: string; html_url: string; commit: { message: string; author?: { name?: string; date?: string } }; files?: { filename: string; status: string; additions: number; deletions: number; patch?: string }[] }>(
                    `${repoApi(repo)}/commits/${enc(text(args, "commit", true))}`));

                if (!found)
                    throw new ToolError(`${String(args.commit)} is not a commit in ${repo}.`);

                let budget = Math.min(whole(args, "diffChars") ?? 60_000, 400_000);

                return {
                    repo,
                    commit: found.sha,
                    message: found.commit.message,
                    by: found.commit.author?.name,
                    at: found.commit.author?.date,
                    link: found.html_url,
                    files: (found.files ?? []).map(file => {

                        const patch = file.patch && budget > 0 ? (file.patch.length > budget ? `${file.patch.slice(0, budget)}\n... (cut)` : file.patch) : undefined;

                        budget = Math.max(budget - (patch?.length ?? 0), 0);

                        return { file: file.filename, status: file.status, added: file.additions, removed: file.deletions, ...(patch ? { diff: patch } : {}) };
                    })
                };
            }
        }),

        tool("files", false, {
            name: "gh_search_code",
            description: "Search code in the GitHub repos in reach, on their default branches. GitHub search terms like path:src or language:ts work.",
            inputSchema: schema({
                words: { type: "string" },
                repo: REPO_INPUT,
                top: { type: "integer", description: "How many, 1 to 100. Default 25." }
            }, ["words"]),
            run: async (args, context) => {

                const repo = args.repo ? repoFor(context.config, args.repo) : undefined;
                const q = `${text(args, "words", true)} ${repo ? `repo:${repo}` : reachQualifiers(context.config)}`;
                const answer = await context.api<{ total_count: number; items: { path: string; html_url: string; repository: { full_name: string } }[] }>(
                    `${API}/search/code?q=${enc(q)}&per_page=${count(args, "top", 25, 100)}`);

                return {
                    total: answer.total_count,
                    files: answer.items.filter(one => repoInReach(context.config, one.repository.full_name)).map(one => ({ repo: one.repository.full_name, path: one.path, link: one.html_url }))
                };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Actions
// -------------------------------------------------------------------

interface Workflow {

    id: number;

    name: string;

    path: string;

    state: string;

    html_url?: string;
}

interface WorkflowRun {

    id: number;

    name?: string;

    run_number: number;

    status: string;

    conclusion?: string | null;

    head_branch?: string;

    head_sha?: string;

    event?: string;

    display_title?: string;

    html_url: string;

    created_at?: string;

    updated_at?: string;

    actor?: { login?: string };
}

/** A workflow's path level: its file name, like ci.yml. */
const workflowFile = (workflow: Workflow) => workflow.path.split("/").pop() ?? String(workflow.id);

function workflows(context: GithubContext, repo: string): Promise<Workflow[]> {

    return context.api.kept("workflows", repo, async () =>
        (await context.api<{ workflows: Workflow[] }>(`${repoApi(repo)}/actions/workflows?per_page=100`)).workflows);
}

/** A workflow named by its file name, its name or its id. */
async function workflowAt(context: GithubContext, repo: string, given: string): Promise<Workflow | undefined> {

    const list = await workflows(context, repo);

    return list.find(one => String(one.id) === given || pathKey(workflowFile(one)) === pathKey(given))
        ?? list.find(one => pathKey(pathName(one.name)) === pathKey(given));
}

async function workflowOrFail(context: GithubContext, repo: string, given: unknown): Promise<Workflow> {

    if (typeof given !== "string" && typeof given !== "number")
        throw new ToolError("Give workflow: its file name, like ci.yml.");

    const found = await workflowAt(context, repo, String(given).trim());

    if (!found)
        throw new ToolError(`${String(given)} is not a workflow in ${repo}. List them with gh_list_workflows.`);

    return found;
}

function runRow(run: WorkflowRun) {

    return {
        id: run.id,
        workflow: run.name,
        number: run.run_number,
        title: run.display_title,
        status: run.conclusion ?? run.status,
        branch: run.head_branch,
        commit: run.head_sha,
        event: run.event,
        by: run.actor?.login,
        started: run.created_at,
        link: run.html_url
    };
}

const WORKFLOW_INPUT = { type: "string", description: "The workflow's file name, like ci.yml, or its id." };

const RUN_INPUT = { type: "integer", description: "The run id (from gh_list_workflow_runs), not the run number." };

const GITHUB_ACTIONS: GithubSourceModule = {

    source: "actions",

    levels: async (context, below, query) => {

        const { repo, rest } = repoLevel(context.config, below);

        if (!repo)
            return below.length ? [] : repoRows(context, query);

        if (!rest.length)
            return (await workflows(context, repo))
                .filter(one => matches(`${workflowFile(one)} ${one.name}`, query))
                .map(one => ({ name: workflowFile(one), detail: one.state === "active" ? one.name : `${one.name} - ${one.state}` }));

        if (rest.length > 1)
            return [];

        const workflow = await workflowAt(context, repo, rest[0]);

        if (!workflow)
            return [];

        const writable = context.config.sources.actions === "write";
        const fresh: PathMatch = {
            name: "new",
            detail: "Ask the agent to start a new run",
            leaf: true,
            ...(writable ? {} : { disabled: true, hint: "Set Actions to Read and write on the Connectors page." })
        };
        const runs = await context.api<{ workflow_runs: WorkflowRun[] }>(`${repoApi(repo)}/actions/workflows/${workflow.id}/runs?per_page=20`);
        const rows: PathMatch[] = runs.workflow_runs.map(run => ({
            name: String(run.id),
            detail: [`#${run.run_number}`, run.conclusion ?? run.status, run.head_branch, run.display_title].filter(Boolean).join(" - "),
            leaf: true
        }));

        return [fresh, ...rows].filter(row => !query || matches(`${row.name} ${row.detail ?? ""}`, query));
    },

    reference: async (context, below) => {

        const { repo, rest, problem } = repoLevel(context.config, below);

        if (problem)
            return { problem };

        if (!repo)
            return {};

        if (!rest[0])
            return { line: `GitHub Actions of ${repo} - list its workflows with gh_list_workflows.` };

        const workflow = await workflowAt(context, repo, rest[0]);

        if (!workflow)
            return { problem: `${rest[0]} is not a workflow in ${repo}` };

        const named = `GitHub Actions workflow ${workflowFile(workflow)} ("${workflow.name}") in ${repo}`;

        if (!rest[1])
            return { line: `${named} - ${workflow.html_url ?? ""} - list its runs with gh_list_workflow_runs.`, link: workflow.html_url };

        if (rest[1] === "new")
            return context.config.sources.actions === "write"
                ? { line: `Start a new run of ${named} with gh_run_workflow - the person is asked first.` }
                : { problem: "Actions is not set to Read and write" };

        if (!/^\d+$/.test(rest[1]))
            return { problem: `${rest[1]} is not a run id` };

        const run = await orMissing(() => context.api<WorkflowRun>(`${repoApi(repo)}/actions/runs/${rest[1]}`));

        if (!run)
            return { problem: `run ${rest[1]} is not in ${repo}` };

        return { line: `${named}, run ${run.id} (#${run.run_number}) - ${run.conclusion ?? run.status} - ${run.head_branch} - ${run.html_url} - read it with gh_read_workflow_run.`, link: run.html_url };
    },

    tools: [

        tool("actions", false, {
            name: "gh_list_workflows",
            description: "List the GitHub Actions workflows of a repo.",
            inputSchema: schema({ repo: REPO_INPUT }),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);

                return { repo, workflows: (await workflows(context, repo)).map(one => ({ file: workflowFile(one), name: one.name, id: one.id, state: one.state, path: one.path })) };
            }
        }),

        tool("actions", false, {
            name: "gh_list_workflow_runs",
            description: "List recent GitHub Actions runs of a repo, newest first - of one workflow, branch or status when given.",
            inputSchema: schema({
                repo: REPO_INPUT,
                workflow: WORKFLOW_INPUT,
                branch: { type: "string" },
                status: { type: "string", description: "Like failure, success, in_progress, queued, cancelled." },
                top: { type: "integer", description: "How many, 1 to 100. Default 20." }
            }),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const workflow = args.workflow ? await workflowOrFail(context, repo, args.workflow) : undefined;
                const query = [
                    `per_page=${count(args, "top", 20, 100)}`,
                    text(args, "branch") ? `branch=${enc(text(args, "branch", true))}` : "",
                    text(args, "status") ? `status=${enc(text(args, "status", true))}` : ""
                ].filter(Boolean).join("&");
                const answer = await context.api<{ workflow_runs: WorkflowRun[] }>(
                    `${repoApi(repo)}/actions/${workflow ? `workflows/${workflow.id}/` : ""}runs?${query}`);

                return { repo, runs: answer.workflow_runs.map(runRow) };
            }
        }),

        tool("actions", false, {
            name: "gh_read_workflow_run",
            description: "Read one GitHub Actions run: its jobs and their steps, with the failed ones marked. Read a job's log with gh_read_job_log.",
            inputSchema: schema({ repo: REPO_INPUT, run: RUN_INPUT }, ["run"]),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const id = whole(args, "run", true);
                const run = await orMissing(() => context.api<WorkflowRun>(`${repoApi(repo)}/actions/runs/${id}`));

                if (!run)
                    throw new ToolError(`Run ${id} is not in ${repo}.`);

                const jobs = await context.api<{ jobs: { id: number; name: string; status: string; conclusion?: string | null; started_at?: string; completed_at?: string; steps?: { number: number; name: string; status: string; conclusion?: string | null }[] }[] }>(
                    `${repoApi(repo)}/actions/runs/${id}/jobs?per_page=100`);

                return {
                    ...runRow(run),
                    jobs: jobs.jobs.map(job => ({
                        id: job.id,
                        name: job.name,
                        status: job.conclusion ?? job.status,
                        started: job.started_at,
                        completed: job.completed_at,
                        failedSteps: (job.steps ?? []).filter(step => step.conclusion === "failure").map(step => `${step.number}. ${step.name}`),
                        steps: (job.steps ?? []).map(step => `${step.number}. ${step.name} - ${step.conclusion ?? step.status}`)
                    }))
                };
            }
        }),

        tool("actions", false, {
            name: "gh_read_job_log",
            description: "Read the log of one GitHub Actions job. Gives the end of the log by default, where failures are.",
            inputSchema: schema({
                repo: REPO_INPUT,
                job: { type: "integer", description: "The job id, from gh_read_workflow_run." },
                chars: { type: "integer", description: "Most characters, 1 to 400000. Default 30000." },
                from: { type: "string", enum: ["end", "start"], description: "Default end." }
            }, ["job"]),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const job = whole(args, "job", true);
                const log = await orMissing(() => context.api<string>(`${repoApi(repo)}/actions/jobs/${job}/logs`, { text: true, accept: "application/vnd.github+json" }));

                if (log === undefined)
                    throw new ToolError(`Job ${job} has no log in ${repo} - it may not have started, or its logs ran out.`);

                const most = count(args, "chars", 30_000, 400_000);

                if (log.length <= most)
                    return { repo, job, log };

                return text(args, "from") === "start"
                    ? { repo, job, log: `${log.slice(0, most)}\n... (cut, ${log.length} characters in all)` }
                    : { repo, job, log: `... (cut, ${log.length} characters in all)\n${log.slice(-most)}` };
            }
        }),

        tool("actions", true, {
            name: "gh_run_workflow",
            description: "Start a GitHub Actions workflow that has a workflow_dispatch trigger, on a branch or tag, with its inputs. The person is asked first.",
            inputSchema: schema({
                repo: REPO_INPUT,
                workflow: WORKFLOW_INPUT,
                ref: { type: "string", description: "A branch or tag. Default: the default branch." },
                inputs: { type: "object", description: "The workflow's inputs, name to value." }
            }, ["workflow"]),
            describe: args => `Start the ${String(args.workflow)} workflow${args.repo ? ` in ${String(args.repo)}` : ""}${args.ref ? ` on ${String(args.ref)}` : ""}${args.inputs ? ` with ${JSON.stringify(args.inputs)}` : ""}`,
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const workflow = await workflowOrFail(context, repo, args.workflow);
                const ref = text(args, "ref") ?? await defaultBranch(context, repo);

                if (args.inputs !== undefined && (typeof args.inputs !== "object" || args.inputs === null || Array.isArray(args.inputs)))
                    throw new ToolError("inputs must be an object of input name to value.");

                await context.api(`${repoApi(repo)}/actions/workflows/${workflow.id}/dispatches`, {
                    method: "POST",
                    body: { ref, ...(args.inputs ? { inputs: args.inputs } : {}) }
                });

                return { started: true, workflow: workflowFile(workflow), ref, note: "GitHub does not give the new run's id. List the newest runs with gh_list_workflow_runs to find it." };
            }
        }),

        tool("actions", true, {
            name: "gh_rerun_workflow_run",
            description: "Run a GitHub Actions run again - only its failed jobs by default. The person is asked first.",
            inputSchema: schema({ repo: REPO_INPUT, run: RUN_INPUT, all: { type: "boolean", description: "Run every job again, not only the failed ones." } }, ["run"]),
            describe: args => `Run ${args.all ? "all jobs" : "the failed jobs"} of run ${String(args.run)} again${args.repo ? ` in ${String(args.repo)}` : ""}`,
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const id = whole(args, "run", true);

                await context.api(`${repoApi(repo)}/actions/runs/${id}/${args.all === true ? "rerun" : "rerun-failed-jobs"}`, { method: "POST", body: {} });

                return { started: true, run: id };
            }
        }),

        tool("actions", true, {
            name: "gh_cancel_workflow_run",
            description: "Cancel a GitHub Actions run that is still going. The person is asked first.",
            inputSchema: schema({ repo: REPO_INPUT, run: RUN_INPUT }, ["run"]),
            describe: args => `Cancel run ${String(args.run)}${args.repo ? ` in ${String(args.repo)}` : ""}`,
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const id = whole(args, "run", true);

                await context.api(`${repoApi(repo)}/actions/runs/${id}/cancel`, { method: "POST", body: {} });

                return { cancelling: true, run: id };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Releases
// -------------------------------------------------------------------

interface Release {

    id: number;

    tag_name: string;

    name?: string | null;

    body?: string | null;

    draft?: boolean;

    prerelease?: boolean;

    html_url: string;

    created_at?: string;

    published_at?: string | null;

    author?: { login?: string };

    assets?: { name: string; size: number; download_count?: number; browser_download_url?: string }[];
}

function releaseRow(release: Release) {

    return {
        tag: release.tag_name,
        name: release.name ?? undefined,
        draft: release.draft || undefined,
        prerelease: release.prerelease || undefined,
        by: release.author?.login,
        published: release.published_at ?? undefined,
        link: release.html_url
    };
}

const releaseState = (release: Release) => release.draft ? "draft" : release.prerelease ? "pre-release" : "published";

const GITHUB_RELEASES: GithubSourceModule = {

    source: "releases",

    levels: async (context, below, query) => {

        const { repo, rest } = repoLevel(context.config, below);

        if (!repo)
            return below.length ? [] : repoRows(context, query);

        if (rest.length)
            return [];

        return (await context.api<Release[]>(`${repoApi(repo)}/releases?per_page=50`))
            .filter(one => matches(`${one.tag_name} ${one.name ?? ""}`, query))
            .map(one => ({ name: pathName(one.tag_name), detail: [one.name, releaseState(one)].filter(Boolean).join(" - "), leaf: true }));
    },

    reference: async (context, below) => {

        const { repo, rest, problem } = repoLevel(context.config, below);

        if (problem)
            return { problem };

        if (!repo)
            return {};

        if (!rest[0])
            return { line: `GitHub releases of ${repo} - list them with gh_list_releases.` };

        const release = (await context.api<Release[]>(`${repoApi(repo)}/releases?per_page=100`)).find(one => pathKey(pathName(one.tag_name)) === pathKey(rest[0]));

        if (!release)
            return { problem: `${rest[0]} is not a release of ${repo}` };

        return { line: `GitHub release ${release.tag_name}${release.name ? ` "${release.name}"` : ""} of ${repo} - ${releaseState(release)} - ${release.html_url} - read it with gh_read_release.`, link: release.html_url };
    },

    tools: [

        tool("releases", false, {
            name: "gh_list_releases",
            description: "List the releases of a GitHub repo, newest first, drafts included when the person can see them.",
            inputSchema: schema({ repo: REPO_INPUT, top: { type: "integer", description: "How many, 1 to 100. Default 20." } }),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);

                return { repo, releases: (await context.api<Release[]>(`${repoApi(repo)}/releases?per_page=${count(args, "top", 20, 100)}`)).map(releaseRow) };
            }
        }),

        tool("releases", false, {
            name: "gh_read_release",
            description: "Read one GitHub release: its notes and files.",
            inputSchema: schema({ repo: REPO_INPUT, tag: { type: "string", description: "The release's tag, or latest." } }, ["tag"]),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const tag = text(args, "tag", true);
                const release = tag === "latest"
                    ? await orMissing(() => context.api<Release>(`${repoApi(repo)}/releases/latest`))
                    // A draft has no tag yet as far as /releases/tags is concerned - look in the list too.
                    : await orMissing(() => context.api<Release>(`${repoApi(repo)}/releases/tags/${enc(tag)}`))
                        ?? (await context.api<Release[]>(`${repoApi(repo)}/releases?per_page=100`)).find(one => one.tag_name === tag);

                if (!release)
                    throw new ToolError(`${tag} is not a release of ${repo}.`);

                return {
                    repo,
                    ...releaseRow(release),
                    notes: capped(release.body ?? "", 40_000),
                    files: (release.assets ?? []).map(one => ({ name: one.name, bytes: one.size, downloads: one.download_count, link: one.browser_download_url }))
                };
            }
        }),

        tool("releases", true, {
            name: "gh_create_release",
            description: "Make a GitHub release - a draft by default, which nobody sees until it is published on GitHub. The tag is made from target when it does not exist. The person is asked first.",
            inputSchema: schema({
                repo: REPO_INPUT,
                tag: { type: "string", description: "Like v1.4.0." },
                name: { type: "string" },
                notes: { type: "string", description: "Markdown. Left out with generateNotes, GitHub writes them from the merged pull requests." },
                target: { type: "string", description: "The branch or commit a new tag points to. Default: the default branch." },
                generateNotes: { type: "boolean" },
                draft: { type: "boolean", description: "Default true." },
                prerelease: { type: "boolean" }
            }, ["tag"]),
            describe: args => `Make ${args.draft === false ? "and publish " : "a draft of "}release ${String(args.tag)}${args.repo ? ` in ${String(args.repo)}` : ""}${args.name ? ` "${String(args.name)}"` : ""}${args.target ? ` from ${String(args.target)}` : ""}${args.notes ? `:\n\n${String(args.notes)}` : ""}`,
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const release = await context.api<Release>(`${repoApi(repo)}/releases`, {
                    method: "POST",
                    body: {
                        tag_name: text(args, "tag", true),
                        ...(text(args, "name") ? { name: text(args, "name") } : {}),
                        ...(text(args, "notes") ? { body: text(args, "notes") } : {}),
                        ...(text(args, "target") ? { target_commitish: text(args, "target") } : {}),
                        generate_release_notes: args.generateNotes === true,
                        draft: args.draft !== false,
                        prerelease: args.prerelease === true
                    }
                });

                return { created: true, ...releaseRow(release) };
            }
        })
    ]
};

export const GITHUB_CODE_MODULES: readonly GithubSourceModule[] = [GITHUB_FILES, GITHUB_ACTIONS, GITHUB_RELEASES];

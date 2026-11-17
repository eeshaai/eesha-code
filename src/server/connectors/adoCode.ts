import type { PathMatch } from "../../shared/composeFiles";
import {
    adoTool as tool, API_VERSION, branchRef, enc, matches, orgApi, PROJECT, projectApi, projectFor, projectLabel, searchApi, web,
    type AdoContext, type AdoSourceModule
} from "./adoBase";
import { pathKey, pathName, type AdoProject } from "./config";
import { ApiError } from "./http";
import { capped, count, schema, text, ToolError, whole } from "./tools";

/*
 * Azure DevOps code: repos (read only - the agent changes code with git)
 * and pull requests.
 */

// -------------------------------------------------------------------
// Repos
// -------------------------------------------------------------------

interface AdoRepo {

    id: string;

    name: string;

    defaultBranch?: string;

    remoteUrl?: string;

    webUrl?: string;

    size?: number;

    isDisabled?: boolean;
}

function repos(context: AdoContext, project: AdoProject): Promise<AdoRepo[]> {

    return context.api.kept("repos", projectLabel(project), async () =>
        (await context.api<{ value: AdoRepo[] }>(`${projectApi(project)}/git/repositories?${API_VERSION}`)).value);
}

/** A repo named by a path level or a tool's input: its name (dashes for spaces) or its id. */
async function repoAt(context: AdoContext, project: AdoProject, given: string): Promise<AdoRepo | undefined> {

    const list = await repos(context, project);

    return list.find(one => one.id.toLowerCase() === given.toLowerCase())
        ?? list.find(one => pathKey(pathName(one.name)) === pathKey(given));
}

async function repoOrFail(context: AdoContext, project: AdoProject, given: unknown): Promise<AdoRepo> {

    if (typeof given !== "string" || !given.trim())
        throw new ToolError("Give repo: the repo's name.");

    const found = await repoAt(context, project, given.trim());

    if (!found)
        throw new ToolError(`${given} is not a repo in ${projectLabel(project)}. List them with ado_list_repos.`);

    return found;
}

function repoRow(repo: AdoRepo) {

    return {
        name: repo.name,
        id: repo.id,
        defaultBranch: repo.defaultBranch?.replace(/^refs\/heads\//, ""),
        clone: repo.remoteUrl,
        link: repo.webUrl,
        disabled: repo.isDisabled || undefined
    };
}

const REPO_INPUT = { type: "string", description: "The repo's name." };

const ADO_REPOS: AdoSourceModule = {

    source: "repos",

    levels: async (context, project, below, query) => below.length
        ? []
        : (await repos(context, project))
            .filter(one => matches(one.name, query))
            .slice(0, 50)
            .map(one => ({ name: pathName(one.name), detail: one.defaultBranch?.replace(/^refs\/heads\//, ""), leaf: true })),

    reference: async (context, project, below) => {

        if (!below[0])
            return {};

        const repo = await repoAt(context, project, below[0]);

        if (!repo)
            return { problem: `${below[0]} is not a repo in ${projectLabel(project)}` };

        return { line: `ADO repo ${repo.name} in ${projectLabel(project)} - default branch ${repo.defaultBranch?.replace(/^refs\/heads\//, "")} - ${repo.webUrl} - read files with ado_read_repo_file; to clone it, run git clone ${repo.remoteUrl} inside one of this session's folders.`, link: repo.webUrl };
    },

    tools: [

        tool("repos", false, {
            name: "ado_list_repos",
            description: "List the git repos of an Azure DevOps project, with their default branch and clone URL.",
            inputSchema: schema({ project: PROJECT, name: { type: "string", description: "Words the name contains." } }),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const name = text(args, "name") ?? "";

                return { project: projectLabel(project), repos: (await repos(context, project)).filter(one => matches(one.name, name)).map(repoRow) };
            }
        }),

        tool("repos", false, {
            name: "ado_list_branches",
            description: "List the branches of an Azure DevOps repo, with the commit each points to.",
            inputSchema: schema({ project: PROJECT, repo: REPO_INPUT, name: { type: "string", description: "Words the branch name contains." } }, ["repo"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const repo = await repoOrFail(context, project, args.repo);
                const answer = await context.api<{ value: { name: string; objectId: string }[] }>(
                    `${projectApi(project)}/git/repositories/${repo.id}/refs?filter=heads/&$top=500&${API_VERSION}`);
                const name = text(args, "name") ?? "";

                return {
                    repo: repo.name,
                    branches: answer.value
                        .map(one => ({ name: one.name.replace(/^refs\/heads\//, ""), commit: one.objectId }))
                        .filter(one => matches(one.name, name))
                };
            }
        }),

        tool("repos", false, {
            name: "ado_list_commits",
            description: "List recent commits of an Azure DevOps repo, newest first - on a branch, and touching a path when given.",
            inputSchema: schema({
                project: PROJECT,
                repo: REPO_INPUT,
                branch: { type: "string", description: "Default: the repo's default branch." },
                path: { type: "string", description: "Only commits that changed this file or folder." },
                top: { type: "integer", description: "How many, 1 to 100. Default 20." }
            }, ["repo"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const repo = await repoOrFail(context, project, args.repo);
                const branch = text(args, "branch") ?? repo.defaultBranch?.replace(/^refs\/heads\//, "");
                const path = text(args, "path");
                const answer = await context.api<{ value: { commitId: string; comment: string; author?: { name?: string; date?: string }; remoteUrl?: string }[] }>(
                    `${projectApi(project)}/git/repositories/${repo.id}/commits?searchCriteria.$top=${count(args, "top", 20, 100)}`
                    + `${branch ? `&searchCriteria.itemVersion.version=${enc(branch)}&searchCriteria.itemVersion.versionType=branch` : ""}`
                    + `${path ? `&searchCriteria.itemPath=${enc(path)}` : ""}&${API_VERSION}`);

                return {
                    repo: repo.name,
                    branch,
                    commits: answer.value.map(one => ({ commit: one.commitId, message: one.comment, by: one.author?.name, at: one.author?.date, link: one.remoteUrl }))
                };
            }
        }),

        tool("repos", false, {
            name: "ado_read_repo_file",
            description: "Read one file of an Azure DevOps repo at a branch or commit - or list a folder's entries when the path is a folder.",
            inputSchema: schema({
                project: PROJECT,
                repo: REPO_INPUT,
                path: { type: "string", description: "Like /src/app.ts. Default: the root folder." },
                branch: { type: "string", description: "A branch name. Default: the repo's default branch." },
                commit: { type: "string", description: "A commit id, in place of a branch." }
            }, ["repo"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const repo = await repoOrFail(context, project, args.repo);
                const path = text(args, "path") ?? "/";
                const commit = text(args, "commit");
                const branch = text(args, "branch") ?? repo.defaultBranch?.replace(/^refs\/heads\//, "");
                const version = commit
                    ? `&versionDescriptor.version=${enc(commit)}&versionDescriptor.versionType=commit`
                    : branch ? `&versionDescriptor.version=${enc(branch)}&versionDescriptor.versionType=branch` : "";

                const base = `${projectApi(project)}/git/repositories/${repo.id}/items?path=${enc(path)}${version}`;
                const item = await context.api<{ isFolder?: boolean; content?: string; path: string; gitObjectType?: string }>(
                    `${base}&includeContent=true&${API_VERSION}`);

                if (item.isFolder || item.gitObjectType === "tree") {

                    const listing = await context.api<{ value: { path: string; isFolder?: boolean }[] }>(`${base}&recursionLevel=OneLevel&${API_VERSION}`);

                    return { repo: repo.name, folder: path, entries: listing.value.filter(one => one.path !== item.path).map(one => `${one.path}${one.isFolder ? "/" : ""}`) };
                }

                return { repo: repo.name, path: item.path, version: commit ?? branch, text: capped(item.content ?? "", 200_000) };
            }
        }),

        tool("repos", false, {
            name: "ado_search_code",
            description: "Search code in the Azure DevOps repos of a project. Needs the organization's Code Search extension.",
            inputSchema: schema({
                project: PROJECT,
                words: { type: "string", description: "What to look for. Code Search terms like file:*.cs or ext:ts work." },
                repo: { type: "string", description: "Only this repo." },
                top: { type: "integer", description: "How many, 1 to 100. Default 25." }
            }, ["words"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const repo = args.repo ? await repoOrFail(context, project, args.repo) : undefined;
                const answer = await context.api<{ count?: number; results?: { fileName: string; path: string; repository?: { name?: string }; versions?: { branchName?: string }[] }[] }>(
                    `${searchApi(project)}/search/codesearchresults?${API_VERSION}`, {
                        method: "POST",
                        body: {
                            searchText: text(args, "words", true),
                            $top: count(args, "top", 25, 100),
                            $skip: 0,
                            filters: { Project: [project.project], ...(repo ? { Repository: [repo.name] } : {}) }
                        }
                    });

                return {
                    total: answer.count,
                    files: (answer.results ?? []).map(one => ({ repo: one.repository?.name, path: one.path, branch: one.versions?.[0]?.branchName }))
                };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Pull requests
// -------------------------------------------------------------------

interface AdoPull {

    pullRequestId: number;

    title: string;

    description?: string;

    status: string;

    isDraft?: boolean;

    mergeStatus?: string;

    sourceRefName: string;

    targetRefName: string;

    creationDate?: string;

    createdBy?: { displayName?: string };

    repository: { id: string; name: string; webUrl?: string };

    reviewers?: { displayName?: string; vote?: number; isRequired?: boolean }[];

    lastMergeSourceCommit?: { commitId: string };
}

const branchName = (ref: string) => ref.replace(/^refs\/heads\//, "");

const pullLink = (project: AdoProject, pull: AdoPull) => `${web(project)}/_git/${enc(pull.repository.name)}/pullrequest/${pull.pullRequestId}`;

const VOTE: Record<string, string> = { "10": "approved", "5": "approved with suggestions", "0": "no vote", "-5": "waiting for author", "-10": "rejected" };

function pullRow(project: AdoProject, pull: AdoPull) {

    return {
        id: pull.pullRequestId,
        repo: pull.repository.name,
        title: pull.title,
        status: pull.status,
        draft: pull.isDraft || undefined,
        from: branchName(pull.sourceRefName),
        into: branchName(pull.targetRefName),
        by: pull.createdBy?.displayName,
        created: pull.creationDate,
        link: pullLink(project, pull)
    };
}

async function activePulls(context: AdoContext, project: AdoProject, top: number, status = "active", repoId?: string): Promise<AdoPull[]> {

    const answer = await context.api<{ value: AdoPull[] }>(
        `${projectApi(project)}/git/pullrequests?searchCriteria.status=${enc(status)}${repoId ? `&searchCriteria.repositoryId=${repoId}` : ""}&$top=${top}&${API_VERSION}`);

    return answer.value;
}

/** One pull request, checked to be in this project. */
async function pullIn(context: AdoContext, project: AdoProject, id: number): Promise<AdoPull | undefined> {

    try {

        return await context.api<AdoPull>(`${projectApi(project)}/git/pullrequests/${id}?${API_VERSION}`);

    } catch (error) {

        if (error instanceof ApiError && error.status === 404)
            return undefined;

        throw error;
    }
}

async function pullOrFail(context: AdoContext, project: AdoProject, id: number): Promise<AdoPull> {

    const pull = await pullIn(context, project, id);

    if (!pull)
        throw new ToolError(`Pull request ${id} is not in ${projectLabel(project)}.`);

    return pull;
}

const pullApi = (project: AdoProject, pull: AdoPull) => `${projectApi(project)}/git/repositories/${pull.repository.id}/pullRequests/${pull.pullRequestId}`;

const ADO_PULLS: AdoSourceModule = {

    source: "pulls",

    levels: async (context, project, below, query) => {

        if (below.length)
            return [];

        const term = query.trim();

        if (/^\d+$/.test(term)) {

            const pull = await pullIn(context, project, Number(term));

            return pull ? [{ name: term, detail: `${pull.repository.name} - ${pull.title} - ${pull.status}`, leaf: true }] : [];
        }

        return (await activePulls(context, project, 100))
            .filter(pull => matches(`${pull.title} ${pull.repository.name}`, term))
            .slice(0, 30)
            .map((pull): PathMatch => ({ name: String(pull.pullRequestId), detail: `${pull.repository.name} - ${pull.title}${pull.createdBy?.displayName ? ` - ${pull.createdBy.displayName}` : ""}`, leaf: true }));
    },

    reference: async (context, project, below) => {

        if (!below[0])
            return {};

        if (!/^\d+$/.test(below[0]))
            return { problem: `${below[0]} is not a pull request number` };

        const pull = await pullIn(context, project, Number(below[0]));

        if (!pull)
            return { problem: `pull request ${below[0]} is not in ${projectLabel(project)}` };

        return { line: `ADO pull request ${pull.pullRequestId} in ${projectLabel(project)}, repo ${pull.repository.name} - ${pull.title} - ${pull.isDraft ? `${pull.status}, draft` : pull.status} - ${branchName(pull.sourceRefName)} into ${branchName(pull.targetRefName)} - ${pullLink(project, pull)} - read it with ado_read_pull_request.`, link: pullLink(project, pull) };
    },

    tools: [

        tool("pulls", false, {
            name: "ado_search_pull_requests",
            description: "List Azure DevOps pull requests of a project, newest first - active by default.",
            inputSchema: schema({
                project: PROJECT,
                repo: REPO_INPUT,
                status: { type: "string", enum: ["active", "completed", "abandoned", "all"], description: "Default active." },
                words: { type: "string", description: "Words in the title." },
                top: { type: "integer", description: "How many, 1 to 100. Default 30." }
            }),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const repo = args.repo ? await repoOrFail(context, project, args.repo) : undefined;
                const words = text(args, "words") ?? "";
                const list = await activePulls(context, project, words ? 200 : count(args, "top", 30, 100), text(args, "status") ?? "active", repo?.id);

                return { pulls: list.filter(pull => matches(pull.title, words)).slice(0, count(args, "top", 30, 100)).map(pull => pullRow(project, pull)) };
            }
        }),

        tool("pulls", false, {
            name: "ado_read_pull_request",
            description: "Read one Azure DevOps pull request: description, reviewers and votes, changed files, and the comment threads. For the diff itself, fetch the branch with git.",
            inputSchema: schema({ project: PROJECT, id: { type: "integer" } }, ["id"]),
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const pull = await pullOrFail(context, project, whole(args, "id", true));

                const [threads, iterations] = await Promise.all([
                    context.api<{ value: { id: number; status?: string; isDeleted?: boolean; threadContext?: { filePath?: string; rightFileStart?: { line?: number } }; comments?: { author?: { displayName?: string }; content?: string; commentType?: string; publishedDate?: string; isDeleted?: boolean }[] }[] }>(
                        `${pullApi(project, pull)}/threads?${API_VERSION}`),
                    context.api<{ value: { id: number }[] }>(`${pullApi(project, pull)}/iterations?${API_VERSION}`)
                ]);

                const last = iterations.value[iterations.value.length - 1];
                const changes = last
                    ? await context.api<{ changeEntries?: { item?: { path?: string }; changeType?: string }[] }>(`${pullApi(project, pull)}/iterations/${last.id}/changes?$top=500&${API_VERSION}`)
                    : undefined;

                return {
                    ...pullRow(project, pull),
                    mergeStatus: pull.mergeStatus,
                    description: capped(pull.description ?? "", 20_000),
                    reviewers: (pull.reviewers ?? []).map(one => ({ name: one.displayName, vote: VOTE[String(one.vote ?? 0)] ?? one.vote, required: one.isRequired || undefined })),
                    files: (changes?.changeEntries ?? []).map(one => ({ path: one.item?.path, change: one.changeType })),
                    threads: threads.value
                        .filter(thread => !thread.isDeleted && thread.comments?.some(comment => comment.commentType !== "system"))
                        .map(thread => ({
                            id: thread.id,
                            status: thread.status,
                            file: thread.threadContext?.filePath,
                            line: thread.threadContext?.rightFileStart?.line,
                            comments: (thread.comments ?? [])
                                .filter(comment => !comment.isDeleted && comment.commentType !== "system")
                                .map(comment => ({ by: comment.author?.displayName, at: comment.publishedDate, text: comment.content }))
                        }))
                };
            }
        }),

        tool("pulls", true, {
            name: "ado_comment_pull_request",
            description: "Add a comment to an Azure DevOps pull request - on the whole request, or on a line of a file. The person is asked first.",
            inputSchema: schema({
                project: PROJECT,
                id: { type: "integer" },
                text: { type: "string", description: "Markdown." },
                file: { type: "string", description: "A changed file's path, like /src/app.ts, to comment on a line." },
                line: { type: "integer", description: "The line in the new version of the file." }
            }, ["id", "text"]),
            describe: args => `Comment on pull request ${String(args.id)}${args.file ? ` at ${String(args.file)}${args.line ? `:${String(args.line)}` : ""}` : ""}:\n\n${String(args.text ?? "")}`,
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const pull = await pullOrFail(context, project, whole(args, "id", true));
                const file = text(args, "file");
                const line = whole(args, "line");

                const thread = await context.api<{ id: number }>(`${pullApi(project, pull)}/threads?${API_VERSION}`, {
                    method: "POST",
                    body: {
                        comments: [{ parentCommentId: 0, content: text(args, "text", true), commentType: 1 }],
                        status: 1,
                        ...(file ? { threadContext: { filePath: file, ...(line ? { rightFileStart: { line, offset: 1 }, rightFileEnd: { line, offset: 1 } } : {}) } } : {})
                    }
                });

                return { added: true, thread: thread?.id, link: pullLink(project, pull) };
            }
        }),

        tool("pulls", true, {
            name: "ado_create_pull_request",
            description: "Open an Azure DevOps pull request from a branch that is already pushed. The person is asked first.",
            inputSchema: schema({
                project: PROJECT,
                repo: REPO_INPUT,
                title: { type: "string" },
                from: { type: "string", description: "The pushed branch with the changes." },
                into: { type: "string", description: "Default: the repo's default branch." },
                description: { type: "string", description: "Markdown." },
                draft: { type: "boolean" }
            }, ["repo", "title", "from"]),
            describe: args => `Open a ${args.draft ? "draft " : ""}pull request in ${String(args.repo)}: "${String(args.title)}" from ${String(args.from)}${args.into ? ` into ${String(args.into)}` : ""}`,
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const repo = await repoOrFail(context, project, args.repo);
                const into = text(args, "into") ?? repo.defaultBranch;

                if (!into)
                    throw new ToolError(`${repo.name} has no default branch - give into.`);

                const pull = await context.api<AdoPull>(`${projectApi(project)}/git/repositories/${repo.id}/pullrequests?${API_VERSION}`, {
                    method: "POST",
                    body: {
                        sourceRefName: branchRef(text(args, "from", true)),
                        targetRefName: branchRef(into),
                        title: text(args, "title", true),
                        description: text(args, "description") ?? "",
                        isDraft: args.draft === true
                    }
                });

                return { created: true, id: pull.pullRequestId, link: pullLink(project, pull) };
            }
        }),

        tool("pulls", true, {
            name: "ado_vote_pull_request",
            description: "Vote on an Azure DevOps pull request as the signed-in person: approve, approve with suggestions, wait for author, or reject. The person is asked first.",
            inputSchema: schema({
                project: PROJECT,
                id: { type: "integer" },
                vote: { type: "string", enum: ["approve", "approve-with-suggestions", "wait-for-author", "reject", "reset"] }
            }, ["id", "vote"]),
            describe: args => `Vote "${String(args.vote)}" on pull request ${String(args.id)}`,
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const pull = await pullOrFail(context, project, whole(args, "id", true));
                const votes: Record<string, number> = { "approve": 10, "approve-with-suggestions": 5, "wait-for-author": -5, "reject": -10, "reset": 0 };
                const vote = votes[text(args, "vote", true)];

                if (vote === undefined)
                    throw new ToolError("vote is approve, approve-with-suggestions, wait-for-author, reject or reset.");

                // The signed-in person, as this organization knows them.
                const me = await context.api<{ authenticatedUser: { id: string } }>(`${orgApi(project)}/connectionData`);

                await context.api(`${pullApi(project, pull)}/reviewers/${me.authenticatedUser.id}?${API_VERSION}`, { method: "PUT", body: { vote } });

                return { voted: text(args, "vote", true), link: pullLink(project, pull) };
            }
        }),

        tool("pulls", true, {
            name: "ado_complete_pull_request",
            description: "Complete (merge) an Azure DevOps pull request whose policies pass. The person is asked first.",
            inputSchema: schema({
                project: PROJECT,
                id: { type: "integer" },
                mergeStrategy: { type: "string", enum: ["noFastForward", "squash", "rebase", "rebaseMerge"], description: "Default: the repo's own." },
                deleteSourceBranch: { type: "boolean" }
            }, ["id"]),
            describe: args => `Complete (merge) pull request ${String(args.id)}${args.mergeStrategy ? ` with ${String(args.mergeStrategy)}` : ""}${args.deleteSourceBranch ? ", deleting its branch" : ""}`,
            run: async (args, context) => {

                const project = projectFor(context.config, args.project);
                const pull = await pullOrFail(context, project, whole(args, "id", true));
                const strategy = text(args, "mergeStrategy");

                const done = await context.api<AdoPull>(`${projectApi(project)}/git/repositories/${pull.repository.id}/pullrequests/${pull.pullRequestId}?${API_VERSION}`, {
                    method: "PATCH",
                    body: {
                        status: "completed",
                        lastMergeSourceCommit: pull.lastMergeSourceCommit,
                        completionOptions: { deleteSourceBranch: args.deleteSourceBranch === true, ...(strategy ? { mergeStrategy: strategy } : {}) }
                    }
                });

                return { status: done.status, link: pullLink(project, pull) };
            }
        })
    ]
};

export const ADO_CODE_MODULES: readonly AdoSourceModule[] = [ADO_REPOS, ADO_PULLS];

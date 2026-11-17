import type { PathMatch } from "../../shared/composeFiles";
import { sameText } from "./config";
import {
    API, enc, ghTool as tool, graphql, matches, numberName, orMissing, parseNumberName, reachQualifiers, REPO, REPO_INPUT, repoApi, repoFor,
    repoInReach, singleRepo, type GithubContext, type GithubSourceModule
} from "./githubBase";
import { capped, count, schema, text, ToolError, whole } from "./tools";

/*
 * GitHub work tracking: issues, discussions (read only) and projects
 * (read only). Issues and discussions are named like pull requests -
 * `12` with one repo in reach, else `owner/repo#12`. Projects belong to
 * an owner and are named `owner#3`.
 */

// -------------------------------------------------------------------
// Issues
// -------------------------------------------------------------------

interface Issue {

    number: number;

    title: string;

    state: string;

    state_reason?: string | null;

    body?: string | null;

    html_url: string;

    repository_url: string;

    user?: { login?: string };

    labels?: ({ name?: string } | string)[];

    assignees?: { login?: string }[];

    milestone?: { title?: string } | null;

    comments?: number;

    created_at?: string;

    updated_at?: string;

    closed_at?: string | null;

    pull_request?: unknown;
}

const repoOfIssue = (issue: Issue) => issue.repository_url.replace(`${API}/repos/`, "");

const labelNames = (issue: Issue) => (issue.labels ?? []).map(one => typeof one === "string" ? one : one.name).filter((name): name is string => !!name);

function issueRow(issue: Issue) {

    return {
        repo: repoOfIssue(issue),
        number: issue.number,
        title: issue.title,
        state: issue.state_reason && issue.state === "closed" ? `closed (${issue.state_reason})` : issue.state,
        labels: labelNames(issue),
        assignees: (issue.assignees ?? []).map(one => one.login),
        author: issue.user?.login,
        updated: issue.updated_at,
        link: issue.html_url
    };
}

async function searchIssues(context: GithubContext, words: string, extra: string, top: number, repo?: string): Promise<Issue[]> {

    const q = `is:issue ${extra} ${repo ? `repo:${repo}` : reachQualifiers(context.config)} ${words}`.replace(/\s+/g, " ").trim();
    const answer = await context.api<{ items: Issue[] }>(`${API}/search/issues?q=${enc(q)}&sort=updated&order=desc&per_page=${top}`);

    return answer.items.filter(item => repoInReach(context.config, repoOfIssue(item)));
}

/** An issue - not a pull request, which GitHub also answers on /issues. */
async function issueIn(context: GithubContext, repo: string, number: number): Promise<Issue | undefined> {

    const found = await orMissing(() => context.api<Issue>(`${repoApi(repo)}/issues/${number}`));

    return found && !found.pull_request ? found : undefined;
}

const NUMBER_INPUT = { type: "integer" };

const LIST_INPUT = (what: string) => ({ type: "array", items: { type: "string" }, description: what });

const GITHUB_ISSUES: GithubSourceModule = {

    source: "issues",

    levels: async (context, below, query) => {

        if (below.length)
            return [];

        const { config } = context;
        const term = query.trim();
        const only = singleRepo(config);

        if (only && /^\d+$/.test(term)) {

            const issue = await issueIn(context, only, Number(term));

            return issue ? [{ name: term, detail: `${issue.title} - ${issue.state}`, leaf: true }] : [];
        }

        return (await searchIssues(context, term, "is:open", 20)).map((issue): PathMatch => ({
            name: numberName(config, repoOfIssue(issue), issue.number),
            detail: `${issue.title}${issue.user?.login ? ` - ${issue.user.login}` : ""}`,
            leaf: true
        }));
    },

    reference: async (context, below) => {

        if (!below[0])
            return {};

        const named = parseNumberName(context.config, below[0]);

        if (!named)
            return { problem: `${below[0]} is not an issue - write it as owner/repo#12` };

        if (!repoInReach(context.config, named.repo))
            return { problem: `${named.repo} is not in reach` };

        const issue = await issueIn(context, named.repo, named.number);

        if (!issue)
            return { problem: `${named.repo}#${named.number} is not an issue there` };

        return {
            line: `GitHub issue ${named.repo}#${issue.number} - ${issue.title} - ${issue.state} - ${issue.html_url} - read it with gh_read_issue.`,
            link: issue.html_url,
            subject: { kind: "issue", number: issue.number, title: issue.title, repo: named.repo }
        };
    },

    tools: [

        tool("issues", false, {
            name: "gh_search_issues",
            description: "Search GitHub issues in the repos in reach, newest updated first.",
            inputSchema: schema({
                words: { type: "string", description: "Words to look for, or GitHub search terms like label:bug no:assignee." },
                repo: REPO_INPUT,
                state: { type: "string", enum: ["open", "closed", "all"], description: "Default open." },
                assignee: { type: "string", description: "A GitHub login." },
                top: { type: "integer", description: "How many, 1 to 100. Default 20." }
            }),
            run: async (args, context) => {

                const repo = args.repo ? repoFor(context.config, args.repo) : undefined;
                const state = text(args, "state") ?? "open";
                const assignee = text(args, "assignee");
                const extra = [state === "all" ? "" : `is:${state}`, assignee ? `assignee:${assignee.replace(/\s/g, "")}` : ""].join(" ");

                return { issues: (await searchIssues(context, text(args, "words") ?? "", extra, count(args, "top", 20, 100), repo)).map(issueRow) };
            }
        }),

        tool("issues", false, {
            name: "gh_read_issue",
            description: "Read one GitHub issue with its comments.",
            inputSchema: schema({ repo: REPO_INPUT, number: NUMBER_INPUT }, ["number"]),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const number = whole(args, "number", true);
                const found = await orMissing(() => context.api<Issue>(`${repoApi(repo)}/issues/${number}`));

                if (!found)
                    throw new ToolError(`${repo}#${number} is not there.`);

                if (found.pull_request)
                    throw new ToolError(`${repo}#${number} is a pull request - read it with gh_read_pull_request.`);

                const comments = await context.api<{ user?: { login?: string }; body?: string; created_at?: string }[]>(`${repoApi(repo)}/issues/${number}/comments?per_page=100`);

                return {
                    ...issueRow(found),
                    milestone: found.milestone?.title,
                    created: found.created_at,
                    closed: found.closed_at ?? undefined,
                    description: capped(found.body ?? "", 20_000),
                    comments: comments.map(one => ({ by: one.user?.login, at: one.created_at, text: one.body }))
                };
            }
        }),

        tool("issues", true, {
            name: "gh_comment_issue",
            description: "Add a comment to a GitHub issue. The person is asked first.",
            inputSchema: schema({ repo: REPO_INPUT, number: NUMBER_INPUT, body: { type: "string", description: "Markdown." } }, ["number", "body"]),
            describe: args => `Comment on issue ${String(args.repo ?? "")}#${String(args.number)}:\n\n${String(args.body ?? "")}`,
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const number = whole(args, "number", true);

                if (!await issueIn(context, repo, number))
                    throw new ToolError(`${repo}#${number} is not an issue.`);

                const comment = await context.api<{ html_url: string }>(`${repoApi(repo)}/issues/${number}/comments`, { method: "POST", body: { body: text(args, "body", true) } });

                return { added: true, link: comment.html_url };
            }
        }),

        tool("issues", true, {
            name: "gh_create_issue",
            description: "Open a GitHub issue. The person is asked first.",
            inputSchema: schema({
                repo: REPO_INPUT,
                title: { type: "string" },
                body: { type: "string", description: "Markdown." },
                labels: LIST_INPUT("Label names."),
                assignees: LIST_INPUT("GitHub logins.")
            }, ["title"]),
            describe: args => `Open an issue in ${String(args.repo ?? "")}: "${String(args.title)}"${Array.isArray(args.labels) && args.labels.length ? ` labelled ${args.labels.join(", ")}` : ""}${args.body ? `\n\n${String(args.body)}` : ""}`,
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const issue = await context.api<Issue>(`${repoApi(repo)}/issues`, {
                    method: "POST",
                    body: {
                        title: text(args, "title", true),
                        body: text(args, "body") ?? "",
                        ...(Array.isArray(args.labels) ? { labels: args.labels } : {}),
                        ...(Array.isArray(args.assignees) ? { assignees: args.assignees } : {})
                    }
                });

                return { created: true, number: issue.number, link: issue.html_url };
            }
        }),

        tool("issues", true, {
            name: "gh_update_issue",
            description: "Change a GitHub issue: close or reopen it, its title, description, labels or assignees. Labels and assignees given replace the old ones. The person is asked first.",
            inputSchema: schema({
                repo: REPO_INPUT,
                number: NUMBER_INPUT,
                state: { type: "string", enum: ["open", "closed"] },
                reason: { type: "string", enum: ["completed", "not_planned", "reopened"], description: "Why it was closed or opened." },
                title: { type: "string" },
                body: { type: "string" },
                labels: LIST_INPUT("Label names - replace the old ones."),
                assignees: LIST_INPUT("GitHub logins - replace the old ones.")
            }, ["number"]),
            describe: args => {

                const changes = [
                    args.state ? `state to ${String(args.state)}${args.reason ? ` (${String(args.reason)})` : ""}` : "",
                    args.title ? `title to "${String(args.title)}"` : "",
                    args.body !== undefined ? "the description" : "",
                    Array.isArray(args.labels) ? `labels to ${args.labels.join(", ") || "none"}` : "",
                    Array.isArray(args.assignees) ? `assignees to ${args.assignees.join(", ") || "none"}` : ""
                ].filter(Boolean);

                return `Change issue ${String(args.repo ?? "")}#${String(args.number)}: ${changes.join("; ") || "nothing"}`;
            },
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const number = whole(args, "number", true);

                if (!await issueIn(context, repo, number))
                    throw new ToolError(`${repo}#${number} is not an issue.`);

                const body = {
                    ...(text(args, "state") ? { state: text(args, "state") } : {}),
                    ...(text(args, "reason") ? { state_reason: text(args, "reason") } : {}),
                    ...(text(args, "title") ? { title: text(args, "title") } : {}),
                    ...(typeof args.body === "string" ? { body: args.body } : {}),
                    ...(Array.isArray(args.labels) ? { labels: args.labels } : {}),
                    ...(Array.isArray(args.assignees) ? { assignees: args.assignees } : {})
                };

                if (!Object.keys(body).length)
                    throw new ToolError("Give at least one thing to change.");

                return { changed: true, ...issueRow(await context.api<Issue>(`${repoApi(repo)}/issues/${number}`, { method: "PATCH", body })) };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Discussions - GraphQL only
// -------------------------------------------------------------------

interface Discussion {

    number: number;

    title: string;

    url: string;

    closed?: boolean;

    updatedAt?: string;

    category?: { name?: string };

    author?: { login?: string } | null;

    repository: { nameWithOwner: string };

    answer?: { id: string } | null;
}

const DISCUSSION_FIELDS = "number title url closed updatedAt category { name } author { login } repository { nameWithOwner } answer { id }";

export async function searchDiscussions(context: GithubContext, words: string, top: number, repo?: string): Promise<Discussion[]> {

    const q = `${repo ? `repo:${repo}` : reachQualifiers(context.config)} ${words}`.replace(/\s+/g, " ").trim();
    const data = await graphql<{ search: { nodes: (Discussion | Record<string, never>)[] } }>(context,
        `query($q: String!, $n: Int!) { search(type: DISCUSSION, query: $q, first: $n) { nodes { ... on Discussion { ${DISCUSSION_FIELDS} } } } }`,
        { q, n: top });

    return data.search.nodes
        .filter((one): one is Discussion => "number" in one)
        .filter(one => repoInReach(context.config, one.repository.nameWithOwner));
}

function discussionRow(one: Discussion) {

    return {
        repo: one.repository.nameWithOwner,
        number: one.number,
        title: one.title,
        category: one.category?.name,
        answered: one.answer ? true : undefined,
        closed: one.closed || undefined,
        author: one.author?.login,
        updated: one.updatedAt,
        link: one.url
    };
}

async function discussionIn(context: GithubContext, repo: string, number: number): Promise<Discussion | undefined> {

    const [owner, name] = repo.split("/");
    const data = await graphql<{ repository: { discussion: Discussion | null } | null }>(context,
        `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { ${DISCUSSION_FIELDS} } } }`,
        { owner, name, number }).catch(error => {

        // A number that is not a discussion is a NOT_FOUND error, not an empty answer.
        if (error instanceof ToolError)
            return { repository: null };

        throw error;
    });

    return data.repository?.discussion ?? undefined;
}

const GITHUB_DISCUSSIONS: GithubSourceModule = {

    source: "discussions",

    levels: async (context, below, query) => {

        if (below.length)
            return [];

        const { config } = context;
        const term = query.trim();
        const only = singleRepo(config);

        if (only && /^\d+$/.test(term)) {

            const found = await discussionIn(context, only, Number(term));

            return found ? [{ name: term, detail: `${found.title} - ${found.category?.name ?? ""}`, leaf: true }] : [];
        }

        return (await searchDiscussions(context, term, 20)).map((one): PathMatch => ({
            name: numberName(config, one.repository.nameWithOwner, one.number),
            detail: `${one.title}${one.category?.name ? ` - ${one.category.name}` : ""}`,
            leaf: true
        }));
    },

    reference: async (context, below) => {

        if (!below[0])
            return {};

        const named = parseNumberName(context.config, below[0]);

        if (!named)
            return { problem: `${below[0]} is not a discussion - write it as owner/repo#12` };

        if (!repoInReach(context.config, named.repo))
            return { problem: `${named.repo} is not in reach` };

        const found = await discussionIn(context, named.repo, named.number);

        if (!found)
            return { problem: `${named.repo}#${named.number} is not a discussion there` };

        return { line: `GitHub discussion ${named.repo}#${found.number} - ${found.title} - ${found.category?.name ?? ""} - ${found.url} - read it with gh_read_discussion.`, link: found.url };
    },

    tools: [

        tool("discussions", false, {
            name: "gh_search_discussions",
            description: "Search GitHub discussions in the repos in reach.",
            inputSchema: schema({
                words: { type: "string", description: "Words to look for, or GitHub search terms like is:answered category:Q&A." },
                repo: REPO_INPUT,
                top: { type: "integer", description: "How many, 1 to 100. Default 20." }
            }),
            run: async (args, context) => {

                const repo = args.repo ? repoFor(context.config, args.repo) : undefined;

                return { discussions: (await searchDiscussions(context, text(args, "words") ?? "", count(args, "top", 20, 100), repo)).map(discussionRow) };
            }
        }),

        tool("discussions", false, {
            name: "gh_read_discussion",
            description: "Read one GitHub discussion with its comments, their replies, and which comment is the answer.",
            inputSchema: schema({ repo: REPO_INPUT, number: NUMBER_INPUT }, ["number"]),
            run: async (args, context) => {

                const repo = repoFor(context.config, args.repo);
                const number = whole(args, "number", true);
                const [owner, name] = repo.split("/");
                const author = "author { login } body createdAt";
                const data = await graphql<{ repository: { discussion: (Discussion & { body?: string; comments: { nodes: { author?: { login?: string } | null; body: string; createdAt: string; isAnswer?: boolean; replies: { nodes: { author?: { login?: string } | null; body: string; createdAt: string }[] } }[] } }) | null } | null }>(context,
                    `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { discussion(number: $number) { ${DISCUSSION_FIELDS} body comments(first: 50) { nodes { ${author} isAnswer replies(first: 20) { nodes { ${author} } } } } } } }`,
                    { owner, name, number });
                const found = data.repository?.discussion;

                if (!found)
                    throw new ToolError(`${repo}#${number} is not a discussion.`);

                return {
                    ...discussionRow(found),
                    description: capped(found.body ?? "", 20_000),
                    comments: found.comments.nodes.map(one => ({
                        by: one.author?.login,
                        at: one.createdAt,
                        answer: one.isAnswer || undefined,
                        text: one.body,
                        replies: one.replies.nodes.map(reply => ({ by: reply.author?.login, at: reply.createdAt, text: reply.body }))
                    }))
                };
            }
        })
    ]
};

// -------------------------------------------------------------------
// Projects - GraphQL only, and the sign-in needs read:project
// -------------------------------------------------------------------

/** The owners a project may belong to: each owner in reach, and the owner of each repo in reach. */
function ownersInReach(context: GithubContext): string[] {

    const owners: string[] = [];

    for (const entry of context.config.reach) {

        const owner = entry.split("/")[0];

        if (!owners.some(one => sameText(one, owner)))
            owners.push(owner);
    }

    return owners;
}

function ownerFor(context: GithubContext, given: unknown): string {

    const owners = ownersInReach(context);

    if (given === undefined || given === null || given === "") {

        if (owners.length === 1)
            return owners[0];

        throw new ToolError(`Say which owner: ${owners.join(", ") || "nothing is in reach"}.`);
    }

    const found = typeof given === "string" ? owners.find(one => sameText(one, given.trim())) : undefined;

    if (!found)
        throw new ToolError(`${String(given)} is not an owner in reach. In reach: ${owners.join(", ") || "nothing"}.`);

    return found;
}

interface Project {

    number: number;

    title: string;

    url: string;

    closed?: boolean;

    shortDescription?: string | null;
}

const PROJECT_FIELDS = "number title url closed shortDescription";

async function projectsOf(context: GithubContext, owner: string): Promise<Project[]> {

    const data = await graphql<{ repositoryOwner: { projectsV2?: { nodes: Project[] } } | null }>(context,
        `query($owner: String!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectsV2(first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ${PROJECT_FIELDS} } } } } }`,
        { owner });

    return data.repositoryOwner?.projectsV2?.nodes ?? [];
}

/** A project's path level: `owner#3`. */
function parseProjectName(level: string): { owner: string; number: number } | undefined {

    const match = /^([A-Za-z0-9-]{1,39})#(\d+)$/.exec(level);

    return match ? { owner: match[1], number: Number(match[2]) } : undefined;
}

const FIELD_VALUE = (kind: string, value: string) => `... on ${kind} { ${value} field { ... on ProjectV2FieldCommon { name } } }`;

const GITHUB_PROJECTS: GithubSourceModule = {

    source: "projects",

    levels: async (context, below, query) => {

        if (below.length)
            return [];

        const rows: PathMatch[] = [];

        for (const owner of ownersInReach(context))
            for (const project of await projectsOf(context, owner))
                if (matches(`${owner} ${project.number} ${project.title}`, query))
                    rows.push({ name: `${owner}#${project.number}`, detail: `${project.title}${project.closed ? " - closed" : ""}`, leaf: true });

        return rows;
    },

    reference: async (context, below) => {

        if (!below[0])
            return {};

        const named = parseProjectName(below[0]);

        if (!named)
            return { problem: `${below[0]} is not a project - write it as owner#3` };

        if (!ownersInReach(context).some(one => sameText(one, named.owner)))
            return { problem: `${named.owner} is not an owner in reach` };

        const project = (await projectsOf(context, named.owner)).find(one => one.number === named.number);

        if (!project)
            return { problem: `${below[0]} is not a project there` };

        return { line: `GitHub project ${named.owner}#${project.number} "${project.title}" - ${project.url} - read its items with gh_read_project.`, link: project.url };
    },

    tools: [

        tool("projects", false, {
            name: "gh_list_projects",
            description: "List the GitHub projects (the boards) of the owners in reach.",
            inputSchema: schema({ owner: { type: "string", description: "A user or organization in reach. Default: every one." } }),
            run: async (args, context) => {

                const owners = args.owner ? [ownerFor(context, args.owner)] : ownersInReach(context);
                const projects = [];

                for (const owner of owners)
                    for (const project of await projectsOf(context, owner))
                        projects.push({ owner, number: project.number, title: project.title, closed: project.closed || undefined, description: project.shortDescription ?? undefined, link: project.url });

                return { projects };
            }
        }),

        tool("projects", false, {
            name: "gh_read_project",
            description: "Read the items of a GitHub project (a board): each issue, pull request or draft with its field values, like Status and Iteration. Items from repos not in reach are left out.",
            inputSchema: schema({
                owner: { type: "string", description: "The user or organization the project belongs to. Leave it out when one owner is in reach." },
                number: { type: "integer", description: "The project number." },
                top: { type: "integer", description: "How many items, 1 to 100. Default 100." }
            }, ["number"]),
            run: async (args, context) => {

                const owner = ownerFor(context, args.owner);
                const number = whole(args, "number", true);
                const content = "number title state url repository { nameWithOwner }";
                const data = await graphql<{
                    repositoryOwner: {
                        projectV2?: (Project & {
                            items: {
                                totalCount: number;
                                nodes: {
                                    type: string;
                                    content?: { number?: number; title?: string; state?: string; url?: string; repository?: { nameWithOwner: string } } | null;
                                    fieldValues: { nodes: { name?: string; text?: string; number?: number; date?: string; title?: string; field?: { name?: string } }[] };
                                }[];
                            };
                        }) | null;
                    } | null;
                }>(context,
                    `query($owner: String!, $number: Int!, $first: Int!) { repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) { ${PROJECT_FIELDS}
                        items(first: $first) { totalCount nodes { type
                            content { ... on Issue { ${content} } ... on PullRequest { ${content} } ... on DraftIssue { title } }
                            fieldValues(first: 20) { nodes {
                                ${FIELD_VALUE("ProjectV2ItemFieldSingleSelectValue", "name")}
                                ${FIELD_VALUE("ProjectV2ItemFieldTextValue", "text")}
                                ${FIELD_VALUE("ProjectV2ItemFieldNumberValue", "number")}
                                ${FIELD_VALUE("ProjectV2ItemFieldDateValue", "date")}
                                ${FIELD_VALUE("ProjectV2ItemFieldIterationValue", "title")}
                            } } } } } } } }`,
                    { owner, number, first: count(args, "top", 100, 100) });

                const project = data.repositoryOwner?.projectV2;

                if (!project)
                    throw new ToolError(`${owner}#${number} is not a project.`);

                let hidden = 0;
                const items = project.items.nodes.flatMap(item => {

                    const repo = item.content?.repository?.nameWithOwner;

                    if (repo && !repoInReach(context.config, repo)) {

                        hidden++;
                        return [];
                    }

                    const fields: Record<string, unknown> = {};

                    for (const value of item.fieldValues.nodes) {

                        const name = value.field?.name;

                        if (name && name !== "Title")
                            fields[name] = value.name ?? value.text ?? value.number ?? value.date ?? value.title;
                    }

                    return [{
                        kind: item.type.toLowerCase().replace("_", " "),
                        repo,
                        number: item.content?.number,
                        title: item.content?.title,
                        state: item.content?.state?.toLowerCase(),
                        link: item.content?.url,
                        fields
                    }];
                });

                return {
                    owner,
                    number: project.number,
                    title: project.title,
                    link: project.url,
                    total: project.items.totalCount,
                    items,
                    ...(hidden ? { note: `${hidden} items from repos not in reach were left out.` } : {})
                };
            }
        })
    ]
};

export const GITHUB_WORK_MODULES: readonly GithubSourceModule[] = [GITHUB_ISSUES, GITHUB_DISCUSSIONS, GITHUB_PROJECTS];

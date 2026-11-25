import type { PathMatch } from "../../shared/composeFiles";
import { pathKey, sameText, type Access, type GithubSource } from "./config";
import {
    API, enc, ghTool as tool, numberName, orMissing, parseNumberName, reachQualifiers, REPO, REPO_INPUT, repoApi, repoFor, repoIn, repoInReach,
    repoRow, repoRows, searchRepos, singleRepo, type GithubContext, type GithubSourceModule, type GithubTool
} from "./githubBase";
import { GITHUB_CODE_MODULES } from "./githubCode";
import { githubMineLevels, githubMineReference, mineRow, MINE } from "./githubMine";
import { GITHUB_WORK_MODULES } from "./githubWork";
import { capped, count, schema, text, ToolError, whole, type ItemReference } from "./tools";

/*
 * GitHub: pull requests and repos here, the other sources in
 * githubCode.ts and githubWork.ts.
 *
 * The same three things as ado.ts: the `>github>...` levels, the
 * reference line, and the tools. Only owners
 * and repos in `reach` are asked about. Repos are read only - the AI
 * clones with git, under its own permission level.
 */

export type { GithubContext } from "./githubBase";
export { repoInReach } from "./githubBase";

const SOURCE_LABEL: Record<GithubSource, string> = {
    repos: "Repos",
    files: "Files and history",
    pulls: "Pull requests",
    issues: "Issues",
    actions: "Actions",
    releases: "Releases",
    discussions: "Discussions",
    projects: "Projects"
};

/** The sources kept in their own files. */
function moduleOf(source: string): GithubSourceModule | undefined {

    return [...GITHUB_CODE_MODULES, ...GITHUB_WORK_MODULES].find(one => one.source === source);
}

// -------------------------------------------------------------------
// Pull requests
// -------------------------------------------------------------------

interface SearchedPull {

    number: number;

    title: string;

    state: string;

    draft?: boolean;

    html_url: string;

    repository_url: string;

    user?: { login?: string };

    updated_at?: string;

    pull_request?: { merged_at?: string | null };
}

interface Pull {

    number: number;

    title: string;

    state: string;

    draft?: boolean;

    merged?: boolean;

    body?: string | null;

    html_url: string;

    user?: { login?: string };

    head: { ref: string; sha: string; repo?: { full_name?: string } | null };

    base: { ref: string };

    mergeable_state?: string;

    additions?: number;

    deletions?: number;

    changed_files?: number;

    created_at?: string;

    updated_at?: string;
}

function repoOfSearched(item: SearchedPull): string {

    return item.repository_url.replace(`${API}/repos/`, "");
}

function pullRow(item: SearchedPull) {

    return {
        repo: repoOfSearched(item),
        number: item.number,
        title: item.title,
        state: item.pull_request?.merged_at ? "merged" : item.state,
        draft: item.draft || undefined,
        author: item.user?.login,
        updated: item.updated_at,
        link: item.html_url
    };
}

async function searchPulls(context: GithubContext, words: string, extra: string, top: number): Promise<SearchedPull[]> {

    const q = `is:pr ${extra} ${reachQualifiers(context.config)} ${words}`.replace(/\s+/g, " ").trim();
    const answer = await context.api<{ items: SearchedPull[] }>(`${API}/search/issues?q=${enc(q)}&sort=updated&order=desc&per_page=${top}`);

    return answer.items.filter(item => repoInReach(context.config, repoOfSearched(item)));
}

function pullIn(context: GithubContext, repo: string, number: number): Promise<Pull | undefined> {

    return orMissing(() => context.api<Pull>(`${repoApi(repo)}/pulls/${number}`));
}

// -------------------------------------------------------------------
// The compose box's levels
// -------------------------------------------------------------------

/**
 * The repo a path names, and the rest of the path. The first level after
 * `>github>` is the repo, as owner/name. With exactly
 * one repo in reach that level is left out and the repo is that one.
 * Below the repo level the sources see a context whose reach is just that
 * repo, so they leave out their own repo level and name a pull request,
 * issue or discussion by its number alone.
 */
function splitRepo(context: GithubContext, path: readonly string[]): { inRepo?: GithubContext; rest: readonly string[]; problem?: string } {

    if (singleRepo(context.config))
        return { inRepo: context, rest: path };

    if (!path.length)
        return { rest: [] };

    const [repo, ...rest] = path;

    if (!REPO.test(repo) || !repoInReach(context.config, repo))
        return { rest: [], problem: `${repo} is not a repo in reach - write it as owner/name` };

    return { inRepo: { ...context, config: { ...context.config, reach: [repo] } }, rest };
}

/** The rows for `>github>` + `path` with `query` typed at the next level. */
export async function githubLevels(context: GithubContext, path: readonly string[], query: string): Promise<PathMatch[]> {

    if (!context.config.reach.length)
        return [{ name: "nothing", detail: "Nothing in reach - add an owner or repo on the Connectors page.", disabled: true }];

    // `mine` comes first, before the repo level.
    if (!path.length)
        return [...mineRow(context, query), ...(singleRepo(context.config) ? await sourceLevels(context, [], query) : await repoRows(context, query))];

    if (sameText(path[0], MINE))
        return githubMineLevels(context, path.slice(1), query);

    const { inRepo, rest } = splitRepo(context, path);

    return inRepo ? sourceLevels(inRepo, rest, query) : [];
}

/** The rows below the repo level: the sources, then each source's own levels. */
async function sourceLevels(context: GithubContext, path: readonly string[], query: string): Promise<PathMatch[]> {

    const { config } = context;

    if (!path.length)
        return (Object.keys(SOURCE_LABEL) as GithubSource[])
            .filter(source => config.sources[source] !== "off" && pathKey(source).includes(pathKey(query)))
            .map(source => ({ name: source, detail: SOURCE_LABEL[source] }));

    const [source, ...below] = path;

    if (!(source in SOURCE_LABEL) || config.sources[source as GithubSource] === "off")
        return [];

    const module = moduleOf(source);

    if (module)
        return module.levels(context, below, query);

    if (below.length)
        return [];

    const term = query.trim();

    if (source === "pulls") {

        const only = singleRepo(config);

        if (only && /^\d+$/.test(term)) {

            const pull = await pullIn(context, only, Number(term));

            return pull ? [{ name: term, detail: `${pull.title} - ${pull.state}`, leaf: true }] : [];
        }

        return (await searchPulls(context, term, "is:open", 20)).map(item => ({
            name: numberName(config, repoOfSearched(item), item.number),
            detail: `${item.title}${item.user?.login ? ` - ${item.user.login}` : ""}`,
            leaf: true
        }));
    }

    return (await searchRepos(context, term, 20)).map(repo => ({
        name: repo.full_name,
        detail: repo.description ?? undefined,
        leaf: true
    }));
}

/** The line a picked `>github>...` path adds to the message - see `adoReference`. */
export async function githubReference(context: GithubContext, path: readonly string[]): Promise<ItemReference> {

    if (path.length && sameText(path[0], MINE))
        return githubMineReference(context, path.slice(1), sourceReference);

    const { inRepo, rest, problem } = splitRepo(context, path);

    if (problem)
        return { problem };

    return inRepo ? sourceReference(inRepo, rest) : {};
}

/** The line for a path below the repo level. */
async function sourceReference(context: GithubContext, path: readonly string[]): Promise<ItemReference> {

    const { config } = context;
    const [source, level] = path;

    if (!source)
        return {};

    if (!(source in SOURCE_LABEL) || config.sources[source as GithubSource] === "off")
        return { problem: `${source} is off or not a GitHub source` };

    const module = moduleOf(source);

    if (module)
        return module.reference(context, path.slice(1));

    if (!level)
        return {};

    if (source === "pulls") {

        const named = parseNumberName(config, level);

        if (!named)
            return { problem: `${level} is not a pull request - write it as owner/repo#12` };

        if (!repoInReach(config, named.repo))
            return { problem: `${named.repo} is not in reach` };

        const pull = await pullIn(context, named.repo, named.number);

        if (!pull)
            return { problem: `${named.repo}#${named.number} is not there` };

        const state = pull.merged ? "merged" : pull.draft ? `${pull.state}, draft` : pull.state;

        return { line: `GitHub pull request ${named.repo}#${pull.number} - ${pull.title} - ${state} - ${pull.head.ref} into ${pull.base.ref} - ${pull.html_url} - read it with gh_read_pull_request.`, link: pull.html_url };
    }

    if (!REPO.test(level))
        return { problem: `${level} is not a repo - write it as owner/name` };

    if (!repoInReach(config, level))
        return { problem: `${level} is not in reach` };

    const repo = await repoIn(context, level);

    if (!repo)
        return { problem: `${level} is not there` };

    return { line: `GitHub repo ${repo.full_name}${repo.description ? ` - ${repo.description}` : ""} - default branch ${repo.default_branch} - ${repo.html_url} - read it with gh_read_repo; to clone it, run git clone ${repo.clone_url} inside one of this session's folders.`, link: repo.html_url };
}

// -------------------------------------------------------------------
// The tools
// -------------------------------------------------------------------

export const GITHUB_TOOLS: readonly GithubTool[] = [

    tool("pulls", false, {
        name: "gh_search_pull_requests",
        description: "Search GitHub pull requests in the repos in reach, newest updated first.",
        inputSchema: schema({
            words: { type: "string", description: "Words to look for, or GitHub search terms like label:bug." },
            repo: REPO_INPUT,
            state: { type: "string", enum: ["open", "closed", "merged", "all"], description: "Default open." },
            author: { type: "string" },
            top: { type: "integer", description: "How many, 1 to 100. Default 20." }
        }),
        run: async (args, context) => {

            const repo = args.repo ? repoFor(context.config, args.repo) : undefined;
            const state = text(args, "state") ?? "open";
            const author = text(args, "author");
            const extra = [
                repo ? `repo:${repo}` : "",
                state === "open" ? "is:open" : state === "closed" ? "is:closed is:unmerged" : state === "merged" ? "is:merged" : "",
                author ? `author:${author.replace(/\s/g, "")}` : ""
            ].join(" ");

            // A named repo replaces the reach list in the search.
            const words = text(args, "words") ?? "";
            const items = repo
                ? (await context.api<{ items: SearchedPull[] }>(`${API}/search/issues?q=${enc(`is:pr ${extra} ${words}`.replace(/\s+/g, " ").trim())}&sort=updated&order=desc&per_page=${count(args, "top", 20, 100)}`)).items
                : await searchPulls(context, words, extra, count(args, "top", 20, 100));

            return { pulls: items.map(pullRow) };
        }
    }),

    tool("pulls", false, {
        name: "gh_read_pull_request",
        description: "Read one GitHub pull request: its description, changed files with their diff, reviews and comments. The diff is cut when it is long.",
        inputSchema: schema({
            repo: REPO_INPUT,
            number: { type: "integer" },
            diffChars: { type: "integer", description: "Most diff characters to give, 0 to 400000. Default 60000." }
        }, ["number"]),
        run: async (args, context) => {

            const repo = repoFor(context.config, args.repo);
            const number = whole(args, "number", true);
            const pull = await pullIn(context, repo, number);

            if (!pull)
                throw new ToolError(`${repo}#${number} is not there.`);

            const [files, reviews, comments, reviewComments] = await Promise.all([
                context.api<{ filename: string; status: string; additions: number; deletions: number; patch?: string }[]>(`${repoApi(repo)}/pulls/${number}/files?per_page=100`),
                context.api<{ user?: { login?: string }; state: string; body?: string; submitted_at?: string }[]>(`${repoApi(repo)}/pulls/${number}/reviews?per_page=100`),
                context.api<{ user?: { login?: string }; body?: string; created_at?: string }[]>(`${repoApi(repo)}/issues/${number}/comments?per_page=100`),
                context.api<{ user?: { login?: string }; body?: string; path?: string; line?: number | null; created_at?: string }[]>(`${repoApi(repo)}/pulls/${number}/comments?per_page=100`)
            ]);

            let budget = Math.min(whole(args, "diffChars") ?? 60_000, 400_000);
            let cut = false;

            const changed = files.map(file => {

                let patch = file.patch;

                if (patch && patch.length > budget) {

                    patch = budget > 0 ? `${patch.slice(0, budget)}\n... (cut)` : undefined;
                    cut = true;
                }

                budget = Math.max(budget - (patch?.length ?? 0), 0);

                return { file: file.filename, status: file.status, added: file.additions, removed: file.deletions, ...(patch ? { diff: patch } : {}) };
            });

            return {
                repo,
                number: pull.number,
                title: pull.title,
                state: pull.merged ? "merged" : pull.state,
                draft: pull.draft || undefined,
                author: pull.user?.login,
                from: pull.head.ref,
                into: pull.base.ref,
                headCommit: pull.head.sha,
                mergeable: pull.mergeable_state,
                link: pull.html_url,
                description: capped(pull.body ?? "", 20_000),
                files: changed,
                ...(cut || files.length >= 100 ? { note: "The diff was cut or there are more than 100 files. Fetch the branch with git to see all of it." } : {}),
                reviews: reviews.filter(one => one.state !== "PENDING").map(one => ({ by: one.user?.login, state: one.state, at: one.submitted_at, text: one.body || undefined })),
                comments: comments.map(one => ({ by: one.user?.login, at: one.created_at, text: one.body })),
                lineComments: reviewComments.map(one => ({ by: one.user?.login, file: one.path, line: one.line ?? undefined, at: one.created_at, text: one.body }))
            };
        }
    }),

    tool("pulls", true, {
        name: "gh_comment_pull_request",
        description: "Add a comment to a GitHub pull request. The person is asked first.",
        inputSchema: schema({ repo: REPO_INPUT, number: { type: "integer" }, body: { type: "string", description: "Markdown." } }, ["number", "body"]),
        describe: args => `Comment on pull request ${String(args.repo ?? "")}#${String(args.number)}:\n\n${String(args.body ?? "")}`,
        run: async (args, context) => {

            const repo = repoFor(context.config, args.repo);
            const comment = await context.api<{ html_url: string }>(`${repoApi(repo)}/issues/${whole(args, "number", true)}/comments`, {
                method: "POST",
                body: { body: text(args, "body", true) }
            });

            return { added: true, link: comment.html_url };
        }
    }),

    tool("pulls", true, {
        name: "gh_create_pull_request",
        description: "Open a GitHub pull request from a branch that is already pushed. The person is asked first.",
        inputSchema: schema({
            repo: REPO_INPUT,
            title: { type: "string" },
            head: { type: "string", description: "The pushed branch with the changes." },
            base: { type: "string", description: "The branch to merge into. Default: the repo's default branch." },
            body: { type: "string", description: "Markdown." },
            draft: { type: "boolean" }
        }, ["title", "head"]),
        describe: args => `Open a ${args.draft ? "draft " : ""}pull request in ${String(args.repo ?? "")}: "${String(args.title)}" from ${String(args.head)}${args.base ? ` into ${String(args.base)}` : ""}`,
        run: async (args, context) => {

            const repo = repoFor(context.config, args.repo);
            const base = text(args, "base") ?? (await repoIn(context, repo))?.default_branch;

            if (!base)
                throw new ToolError(`${repo} is not there.`);

            const pull = await context.api<Pull>(`${repoApi(repo)}/pulls`, {
                method: "POST",
                body: { title: text(args, "title", true), head: text(args, "head", true), base, body: text(args, "body") ?? "", draft: args.draft === true }
            });

            return { created: true, number: pull.number, link: pull.html_url };
        }
    }),

    tool("pulls", true, {
        name: "gh_approve_pull_request",
        description: "Approve a GitHub pull request, with an optional comment. The person is asked first.",
        inputSchema: schema({ repo: REPO_INPUT, number: { type: "integer" }, body: { type: "string" } }, ["number"]),
        describe: args => `Approve pull request ${String(args.repo ?? "")}#${String(args.number)}${args.body ? `:\n\n${String(args.body)}` : ""}`,
        run: async (args, context) => {

            const repo = repoFor(context.config, args.repo);
            const review = await context.api<{ html_url?: string; state?: string }>(`${repoApi(repo)}/pulls/${whole(args, "number", true)}/reviews`, {
                method: "POST",
                body: { event: "APPROVE", ...(text(args, "body") ? { body: text(args, "body") } : {}) }
            });

            return { approved: review.state === "APPROVED", link: review.html_url };
        }
    }),

    tool("repos", false, {
        name: "gh_search_repos",
        description: "Search the GitHub repos in reach by name, newest updated first.",
        inputSchema: schema({ words: { type: "string", description: "Words in the name." }, top: { type: "integer", description: "How many, 1 to 100. Default 20." } }),
        run: async (args, context) => ({ repos: (await searchRepos(context, text(args, "words") ?? "", count(args, "top", 20, 100))).map(repoRow) })
    }),

    tool("repos", false, {
        name: "gh_read_repo",
        description: "Read one GitHub repo: description, default branch, clone URL and README. Clone it with git clone into one of the session's folders.",
        inputSchema: schema({ repo: REPO_INPUT, readmeChars: { type: "integer", description: "Most README characters, 0 to 100000. Default 20000." } }),
        run: async (args, context) => {

            const repo = repoFor(context.config, args.repo);
            const found = await repoIn(context, repo);

            if (!found)
                throw new ToolError(`${repo} is not there.`);

            const most = Math.min(whole(args, "readmeChars") ?? 20_000, 100_000);
            let readme: string | undefined;

            if (most) {

                const raw = await orMissing(() => context.api<string>(`${repoApi(repo)}/readme`, { text: true, accept: "application/vnd.github.raw+json" }));

                readme = raw === undefined ? undefined : capped(raw, most);
            }

            return { ...repoRow(found), ...(readme ? { readme } : {}) };
        }
    })
];

/** The tools the choices allow - see `adoToolsFor`. */
export function githubToolsFor(sources: Record<GithubSource, Access>): GithubTool[] {

    return [...GITHUB_TOOLS, ...[...GITHUB_CODE_MODULES, ...GITHUB_WORK_MODULES].flatMap(one => one.tools)].filter(one => sources[one.source as GithubSource] === "write" || (sources[one.source as GithubSource] === "read" && !one.write));
}

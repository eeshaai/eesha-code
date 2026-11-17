import type { PathMatch } from "../../shared/composeFiles";
import { pathKey, sameText, type GithubConfig, type GithubSource } from "./config";
import { ApiError, type Api } from "./http";
import { ToolError, type ToolDef, type ItemReference } from "./tools";

/*
 * What every GitHub source shares: which repos are in reach, how a repo
 * or a numbered thing is named in a `>github>...` path, the web calls,
 * and the shape of one source (`GithubSourceModule`). github.ts holds
 * pull requests and repos; githubCode.ts files, actions and releases;
 * githubWork.ts issues, discussions and projects.
 */

export interface GithubContext {

    config: GithubConfig;

    api: Api;
}

export const API = "https://api.github.com";

export const REPO = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/;

export const enc = encodeURIComponent;

export const repoApi = (repo: string) => `${API}/repos/${repo.split("/").map(enc).join("/")}`;

/** Whether a repo is in reach: named itself, or its owner is. */
export function repoInReach(config: GithubConfig, repo: string): boolean {

    const owner = repo.split("/")[0];

    return config.reach.some(entry => sameText(entry, repo) || sameText(entry, owner));
}

/** The one repo in reach, when reach is exactly one repo - then the repo level is left out of paths. */
export function singleRepo(config: GithubConfig): string | undefined {

    return config.reach.length === 1 && config.reach[0].includes("/") ? config.reach[0] : undefined;
}

/** The repo a tool means, checked to be in reach. Left out: the only repo in reach. */
export function repoFor(config: GithubConfig, given: unknown): string {

    if (given === undefined || given === null || given === "") {

        const only = singleRepo(config);

        if (only)
            return only;

        throw new ToolError(`Say which repo, as owner/name. In reach: ${config.reach.join(", ") || "nothing"}.`);
    }

    if (typeof given !== "string" || !REPO.test(given.trim()))
        throw new ToolError("repo must be owner/name.");

    if (!repoInReach(config, given.trim()))
        throw new ToolError(`${given} is not in reach. In reach: ${config.reach.join(", ") || "nothing"}.`);

    return given.trim();
}

/** `repo:a/b user:c` - every search kept to what is in reach. */
export function reachQualifiers(config: GithubConfig): string {

    return config.reach.map(entry => entry.includes("/") ? `repo:${entry}` : `user:${entry}`).join(" ");
}

/** A numbered thing's path level - pull request, issue, discussion: `12` with one repo in reach, else `owner/repo#12`. */
export function numberName(config: GithubConfig, repo: string, number: number): string {

    return singleRepo(config) ? String(number) : `${repo}#${number}`;
}

/** A numbered thing's path level as repo and number. */
export function parseNumberName(config: GithubConfig, level: string): { repo: string; number: number } | undefined {

    const only = singleRepo(config);

    if (only && /^\d+$/.test(level))
        return { repo: only, number: Number(level) };

    const match = /^([^#]+)#(\d+)$/.exec(level);

    return match && REPO.test(match[1]) ? { repo: match[1], number: Number(match[2]) } : undefined;
}

/** A call that answers 404 as "not there". */
export async function orMissing<T>(load: () => Promise<T>): Promise<T | undefined> {

    try {

        return await load();

    } catch (error) {

        if (error instanceof ApiError && error.status === 404)
            return undefined;

        throw error;
    }
}

// -------------------------------------------------------------------
// Repos
// -------------------------------------------------------------------

export interface Repo {

    full_name: string;

    description?: string | null;

    private?: boolean;

    default_branch?: string;

    html_url: string;

    clone_url?: string;

    language?: string | null;

    updated_at?: string;

    pushed_at?: string;

    archived?: boolean;
}

export function repoRow(repo: Repo) {

    return {
        repo: repo.full_name,
        description: repo.description ?? undefined,
        private: repo.private,
        defaultBranch: repo.default_branch,
        language: repo.language ?? undefined,
        archived: repo.archived || undefined,
        pushed: repo.pushed_at,
        clone: repo.clone_url,
        link: repo.html_url
    };
}

export async function searchRepos(context: GithubContext, words: string, top: number): Promise<Repo[]> {

    const q = `${words ? `${words} in:name` : ""} ${reachQualifiers(context.config)}`.replace(/\s+/g, " ").trim();
    const answer = await context.api<{ items: Repo[] }>(`${API}/search/repositories?q=${enc(q)}&sort=updated&order=desc&per_page=${top}`);

    return answer.items.filter(item => repoInReach(context.config, item.full_name));
}

export function repoIn(context: GithubContext, repo: string): Promise<Repo | undefined> {

    return orMissing(() => context.api<Repo>(repoApi(repo)));
}

/**
 * For a source that lives inside one repo (files, actions, releases):
 * the repo the path means and the levels below it. With one repo in
 * reach the repo level is left out; else the first level is owner/name.
 */
export function repoLevel(config: GithubConfig, below: readonly string[]): { repo?: string; rest: readonly string[]; problem?: string } {

    const only = singleRepo(config);

    if (only)
        return { repo: only, rest: below };

    if (!below.length)
        return { rest: [] };

    if (!REPO.test(below[0]))
        return { rest: [], problem: `${below[0]} is not a repo - write it as owner/name` };

    if (!repoInReach(config, below[0]))
        return { rest: [], problem: `${below[0]} is not in reach` };

    return { repo: below[0], rest: below.slice(1) };
}

/** The repo rows of a repo level. */
export async function repoRows(context: GithubContext, query: string): Promise<PathMatch[]> {

    return (await searchRepos(context, query.trim(), 20)).map(repo => ({ name: repo.full_name, detail: repo.description ?? undefined }));
}

/** Whether a name holds what is typed, with dashes, spaces and case not counting. */
export function matches(name: string, query: string): boolean {

    return !query || pathKey(name).includes(pathKey(query));
}

// -------------------------------------------------------------------
// GraphQL - discussions and projects have no REST API
// -------------------------------------------------------------------

export async function graphql<T>(context: GithubContext, query: string, variables: Record<string, unknown>): Promise<T> {

    const answer = await context.api<{ data?: T; errors?: { type?: string; message?: string }[] }>(`${API}/graphql`, {
        method: "POST",
        body: { query, variables }
    });

    if (answer?.errors?.length) {

        if (answer.errors.some(one => one.type === "INSUFFICIENT_SCOPES"))
            throw new ToolError(`The GitHub sign-in is missing a permission: ${answer.errors.map(one => one.message).join(" ")} To add it, run gh auth refresh -s read:project in a terminal.`);

        if (answer.errors.every(one => one.type === "NOT_FOUND"))
            throw new ToolError(answer.errors.map(one => one.message).join(" "));

        throw new Error(`GitHub: ${answer.errors.map(one => one.message).join(" ")}`);
    }

    if (!answer?.data)
        throw new Error("GitHub gave no data.");

    return answer.data;
}

// -------------------------------------------------------------------
// One source
// -------------------------------------------------------------------

export const REPO_INPUT = { type: "string", description: "owner/name. Leave it out when only one repo is in reach." };

export type GithubTool = ToolDef<GithubContext>;

export function ghTool(source: GithubSource, write: boolean, def: Omit<GithubTool, "connector" | "source" | "write">): GithubTool {

    return { ...def, connector: "github", source, write };
}

/** One GitHub source beside pull requests and repos: its levels below `>github>source>`, its reference line, its tools. */
export interface GithubSourceModule {

    source: GithubSource;

    levels(context: GithubContext, below: readonly string[], query: string): Promise<PathMatch[]>;

    reference(context: GithubContext, below: readonly string[]): Promise<ItemReference>;

    tools: readonly GithubTool[];
}

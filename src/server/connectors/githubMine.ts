import type { PathMatch } from "../../shared/composeFiles";
import type { GithubSource } from "./config";
import { API, enc, matches, numberName, reachQualifiers, repoInReach, type GithubContext } from "./githubBase";
import { searchDiscussions } from "./githubWork";
import type { ItemReference } from "./tools";

/*
 * `>github>mine>`: the person's own open pull requests, issues and
 * discussions across everything in reach, with no repo step. A picked item is named like everywhere else (`owner/repo#12`,
 * or `12` with one repo in reach), so its reference line is the source's
 * own, made by github.ts.
 */

export const MINE = "mine";

const MINE_SOURCES = {
    pulls: "Open pull requests I opened, must review, or am assigned to",
    issues: "Open issues assigned to me or opened by me",
    discussions: "Discussions I started"
} as const;

type MineSource = keyof typeof MINE_SOURCES;

/** Each search that makes up a list, and the word the row gets for it. */
const WHO: Record<"pulls" | "issues", [string, string][]> = {
    pulls: [["author:@me", "mine"], ["review-requested:@me", "review asked"], ["assignee:@me", "assigned"]],
    issues: [["assignee:@me", "assigned"], ["author:@me", "mine"]]
};

function isOn(context: GithubContext, source: string): source is MineSource {

    return source in MINE_SOURCES && context.config.sources[source as GithubSource] !== "off";
}

/** The `mine` row at `>github>`, when one of its sources is on. */
export function mineRow(context: GithubContext, query: string): PathMatch[] {

    return Object.keys(MINE_SOURCES).some(source => isOn(context, source)) && matches(MINE, query)
        ? [{ name: MINE, detail: "My pull requests, issues and discussions, across everything in reach" }]
        : [];
}

interface Found {

    number: number;

    title: string;

    html_url: string;

    repository_url: string;

    updated_at?: string;
}

const repoOf = (item: Found) => item.repository_url.replace(`${API}/repos/`, "");

/** Open pull requests or issues for each of `who`, newest updated first, each once with every reason it is there. */
async function searchMine(context: GithubContext, source: "pulls" | "issues", words: string): Promise<{ item: Found; why: string[] }[]> {

    const kind = source === "pulls" ? "is:pr" : "is:issue";

    const lists = await Promise.all(WHO[source].map(async ([who, why]) => {

        const q = `${kind} is:open ${who} ${reachQualifiers(context.config)} ${words}`.replace(/\s+/g, " ").trim();
        const answer = await context.api<{ items: Found[] }>(`${API}/search/issues?q=${enc(q)}&sort=updated&order=desc&per_page=30`);

        return answer.items.filter(item => repoInReach(context.config, repoOf(item))).map(item => ({ item, why }));
    }));

    const rows: { item: Found; why: string[] }[] = [];

    for (const { item, why } of lists.flat()) {

        const known = rows.find(row => row.item.html_url === item.html_url);

        if (known)
            known.why.push(why);
        else
            rows.push({ item, why: [why] });
    }

    return rows.sort((a, b) => (b.item.updated_at ?? "").localeCompare(a.item.updated_at ?? "")).slice(0, 30);
}

/** The rows for `>github>mine>` + `below`. */
export async function githubMineLevels(context: GithubContext, below: readonly string[], query: string): Promise<PathMatch[]> {

    if (!below.length)
        return (Object.keys(MINE_SOURCES) as MineSource[])
            .filter(source => isOn(context, source) && matches(source, query))
            .map(source => ({ name: source, detail: MINE_SOURCES[source] }));

    const [source] = below;

    if (below.length > 1 || !isOn(context, source))
        return [];

    const words = query.trim();

    if (source === "discussions")
        return (await searchDiscussions(context, `author:@me ${words}`, 20)).map((one): PathMatch => ({
            name: numberName(context.config, one.repository.nameWithOwner, one.number),
            detail: `${one.title}${one.category?.name ? ` - ${one.category.name}` : ""}`,
            leaf: true
        }));

    return (await searchMine(context, source, words)).map(({ item, why }): PathMatch => ({
        name: numberName(context.config, repoOf(item), item.number),
        detail: `${item.title} - ${why.join(", ")}`,
        leaf: true
    }));
}

/** The line for `>github>mine>source>item`: the source's own line, from `sourceReference`. */
export async function githubMineReference(
    context: GithubContext,
    below: readonly string[],
    sourceReference: (context: GithubContext, path: readonly string[]) => Promise<ItemReference>
): Promise<ItemReference> {

    const [source, level] = below;

    if (!source)
        return {};

    if (!isOn(context, source))
        return { problem: `${source} is off or has no "mine" list - mine has ${Object.keys(MINE_SOURCES).join(", ")}` };

    return level ? sourceReference(context, [source, level]) : {};
}

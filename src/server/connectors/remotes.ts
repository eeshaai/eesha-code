import { findRepos, repoRemoteUrls } from "../git";
import { sameText, type AdoProject } from "./config";

/*
 * What the git remotes of the person's folders point to: the ADO
 * projects and GitHub repos the Connect window offers first. Only read, never saved by itself.
 */

export type Remote =
    | { kind: "ado"; org: string; project: string }
    | { kind: "github"; owner: string; repo: string };

function decode(part: string): string {

    try {

        return decodeURIComponent(part);

    } catch {

        return part;
    }
}

/**
 * One remote URL as an ADO project or a GitHub repo. The forms git
 * prints for each:
 *
 *   https://dev.azure.com/{org}/{project}/_git/{repo}   (also user@dev.azure.com)
 *   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 *   https://github.com/{owner}/{repo}[.git]
 *   git@github.com:{owner}/{repo}.git, ssh://git@github.com/{owner}/{repo}
 */
export function parseRemote(url: string): Remote | undefined {

    const text = url.trim();

    let match = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\//i.exec(text);

    if (match)
        return { kind: "ado", org: decode(match[1]), project: decode(match[2]) };

    match = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\//i.exec(text);

    if (match)
        return { kind: "ado", org: decode(match[1]), project: decode(match[2]) };

    match = /^(?:ssh:\/\/)?[^@]+@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)[:/]v3\/([^/]+)\/([^/]+)\//i.exec(text);

    if (match)
        return { kind: "ado", org: decode(match[1]), project: decode(match[2]) };

    match = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(text);

    if (match)
        return { kind: "github", owner: match[1], repo: match[2] };

    return undefined;
}

/** The ADO projects and GitHub repos the remotes of these folders' repositories point to, each once. */
export async function remotesOf(folders: readonly string[]): Promise<{ ado: AdoProject[]; github: string[] }> {

    const ado: AdoProject[] = [];
    const github: string[] = [];

    for (const repo of await findRepos(folders)) {

        for (const url of await repoRemoteUrls(repo)) {

            const remote = parseRemote(url);

            if (remote?.kind === "ado" && !ado.some(one => sameText(one.org, remote.org) && sameText(one.project, remote.project)))
                ado.push({ org: remote.org, project: remote.project });

            if (remote?.kind === "github") {

                const name = `${remote.owner}/${remote.repo}`;

                if (!github.some(one => sameText(one, name)))
                    github.push(name);
            }
        }
    }

    return { ado, github };
}

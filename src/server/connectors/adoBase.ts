import type { PathMatch } from "../../shared/composeFiles";
import { pathKey, pathName, sameText, type AdoConfig, type AdoProject, type AdoSource } from "./config";
import type { Api } from "./http";
import { ToolError, type ToolDef, type ItemReference } from "./tools";

/*
 * What every Azure DevOps source shares: the web addresses, which project
 * a tool means, and the shape of one source (`AdoSourceModule`) - its
 * `>ado>...` levels, its reference line and its tools. ado.ts holds work
 * items, saved queries, builds and releases; adoCode.ts repos and pull
 * requests; adoDocs.ts the wiki and test plans.
 */

export interface AdoContext {

    config: AdoConfig;

    api: Api;
}

export const API_VERSION = "api-version=7.1";

export const enc = encodeURIComponent;

export const projectApi = (p: AdoProject) => `https://dev.azure.com/${enc(p.org)}/${enc(p.project)}/_apis`;

export const orgApi = (p: AdoProject) => `https://dev.azure.com/${enc(p.org)}/_apis`;

export const releaseApi = (p: AdoProject) => `https://vsrm.dev.azure.com/${enc(p.org)}/${enc(p.project)}/_apis`;

/** Code and wiki search - only when the organization has the search extension. */
export const searchApi = (p: AdoProject) => `https://almsearch.dev.azure.com/${enc(p.org)}/${enc(p.project)}/_apis`;

export const web = (p: AdoProject) => `https://dev.azure.com/${enc(p.org)}/${enc(p.project)}`;

/** "contoso/Web" - how a project is named to the AI and in a tool's input. */
export function projectLabel(p: AdoProject): string {

    return `${p.org}/${p.project}`;
}

/**
 * The project a tool means: `project` as "org/project", or the only one
 * in reach when it is left out.
 */
export function projectFor(config: AdoConfig, given: unknown): AdoProject {

    if (given === undefined || given === null || given === "") {

        if (config.reach.length === 1)
            return config.reach[0];

        if (!config.reach.length)
            throw new ToolError("No ADO project is in reach. The person adds one on the Connectors page.");

        throw new ToolError(`Say which project: ${config.reach.map(projectLabel).join(", ")}.`);
    }

    if (typeof given !== "string")
        throw new ToolError("project must be text, like contoso/Web.");

    const found = config.reach.find(p =>
        sameText(projectLabel(p), given.trim()) || pathKey(pathName(projectLabel(p))) === pathKey(given));

    if (!found)
        throw new ToolError(`${given} is not in reach. In reach: ${config.reach.map(projectLabel).join(", ") || "nothing"}.`);

    return found;
}

/** Whether a name holds what is typed, with dashes, spaces and case not counting. */
export function matches(name: string, query: string): boolean {

    return !query || pathKey(name).includes(pathKey(query));
}

export const PROJECT = { type: "string", description: "The ADO project as org/project. Leave it out when only one project is in reach." };

export type AdoTool = ToolDef<AdoContext>;

export function adoTool(source: AdoSource, write: boolean, def: Omit<AdoTool, "connector" | "source" | "write">): AdoTool {

    return { ...def, connector: "ado", source, write };
}

/** A branch as ADO wants it: `refs/heads/main` for `main`. */
export function branchRef(branch: string): string {

    return branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
}

/** One ADO source beside the built-in ones: its levels below `>ado>source>`, its reference line, its tools. */
export interface AdoSourceModule {

    source: AdoSource;

    levels(context: AdoContext, project: AdoProject, below: readonly string[], query: string): Promise<PathMatch[]>;

    reference(context: AdoContext, project: AdoProject, below: readonly string[]): Promise<ItemReference>;

    tools: readonly AdoTool[];
}

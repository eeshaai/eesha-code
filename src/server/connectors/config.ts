import { eeshaPath, readJson } from "../paths";
import type { AdoChoices, AdoProject, ConnectorAccess, ConnectorId, GithubChoices } from "../protocol";
import { editSettingsJson } from "../settingsPage";

export type { AdoProject, ConnectorId };

/*
 * What the person chose when connecting, kept in ~/.eesha/settings.json:
 *
 *   "eesha": { "connectors": {
 *       "ado":    { "reach": [{ "org": "contoso", "project": "Web" }],
 *                   "sources": { "workitems": "write", "builds": "read", "releases": "off" } },
 *       "github": { "reach": ["contoso", "contoso/api"],
 *                   "sources": { "pulls": "read", "repos": "read" } }
 *   } }
 *
 * `reach` is what the AI may look at: ADO projects, GitHub owners or
 * single repos. `sources` is what it may do there: off, read, or read
 * and write. A connector with no entry is not connected. Sign-in itself
 * lives in the `az` and `gh` CLIs, never here.
 */

export type Access = ConnectorAccess;

export const ACCESS: readonly Access[] = ["off", "read", "write"];

export const CONNECTOR_IDS: readonly ConnectorId[] = ["ado", "github"];

export const ADO_SOURCES = ["workitems", "queries", "repos", "pulls", "builds", "releases", "wiki", "testplans"] as const;

export const GITHUB_SOURCES = ["repos", "files", "pulls", "issues", "actions", "releases", "discussions", "projects"] as const;

export type AdoSource = typeof ADO_SOURCES[number];

export type GithubSource = typeof GITHUB_SOURCES[number];

export type AdoConfig = AdoChoices;

export type GithubConfig = GithubChoices;

export interface ConnectorsConfig {

    ado?: AdoConfig;

    github?: GithubConfig;
}

/**
 * Sources that are only read. Code is changed with git, not through the
 * connector; queries, the wiki, test plans,
 * discussions and projects have no write tools.
 */
const READ_ONLY: ReadonlySet<string> = new Set([
    "ado.queries", "ado.repos", "ado.wiki", "ado.testplans",
    "github.repos", "github.files", "github.discussions", "github.projects"
]);

/** Whether a source may be set to this access. */
export function accessAllowed(connector: ConnectorId, source: string, access: Access): boolean {

    return access !== "write" || !READ_ONLY.has(`${connector}.${source}`);
}

/** An org, project, owner or repo name: no slashes, spaces only inside an ADO project. */
const ADO_ORG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

const ADO_PROJECT = /^[^/\\:*?"<>|#%&+]{1,64}$/;

const GITHUB_REACH = /^[A-Za-z0-9-]{1,39}(\/[A-Za-z0-9._-]{1,100})?$/;

/** Checks one connector's choices as the page or the command sent them. */
export function checkConnector(id: ConnectorId, value: unknown): { config: AdoConfig | GithubConfig } | { problem: string } {

    if (!value || typeof value !== "object")
        return { problem: "Send the connector's reach and sources." };

    const { reach, sources } = value as { reach?: unknown; sources?: unknown };

    if (!Array.isArray(reach))
        return { problem: "Send what is in reach as a list." };

    if (!sources || typeof sources !== "object")
        return { problem: "Send each source's access: off, read or write." };

    const names: readonly string[] = id === "ado" ? ADO_SOURCES : GITHUB_SOURCES;
    const checkedSources: Record<string, Access> = {};

    for (const name of names) {

        const access = (sources as Record<string, unknown>)[name] ?? "off";

        if (!ACCESS.includes(access as Access))
            return { problem: `${name} must be off, read or write.` };

        if (!accessAllowed(id, name, access as Access))
            return { problem: `${name} can only be off or read.` };

        checkedSources[name] = access as Access;
    }

    if (id === "ado") {

        const projects: AdoProject[] = [];

        for (const one of reach) {

            const { org, project } = (one ?? {}) as { org?: unknown; project?: unknown };

            if (typeof org !== "string" || !ADO_ORG.test(org) || typeof project !== "string" || !ADO_PROJECT.test(project.trim()))
                return { problem: "Each ADO entry is an organization and a project, like contoso and Web." };

            if (!projects.some(seen => sameText(seen.org, org) && sameText(seen.project, project.trim())))
                projects.push({ org, project: project.trim() });
        }

        return { config: { reach: projects, sources: checkedSources as Record<AdoSource, Access> } };
    }

    const entries: string[] = [];

    for (const one of reach) {

        if (typeof one !== "string" || !GITHUB_REACH.test(one.trim()))
            return { problem: "Each GitHub entry is an owner, like octocat, or a repo, like octocat/hello." };

        if (!entries.some(seen => sameText(seen, one.trim())))
            entries.push(one.trim());
    }

    return { config: { reach: entries, sources: checkedSources as Record<GithubSource, Access> } };
}

/** The `eesha.connectors` block of a settings file's JSON. Entries that do not check out are left out. */
export function connectorsFrom(json: unknown): ConnectorsConfig {

    const block = json && typeof json === "object" ? (json as Record<string, unknown>).eesha : undefined;
    const own = block && typeof block === "object" ? (block as Record<string, unknown>).connectors : undefined;

    if (!own || typeof own !== "object")
        return {};

    const config: ConnectorsConfig = {};

    for (const id of CONNECTOR_IDS) {

        const value = (own as Record<string, unknown>)[id];

        if (value === undefined)
            continue;

        const checked = checkConnector(id, value);

        if ("config" in checked)
            (config as Record<string, unknown>)[id] = checked.config;
    }

    return config;
}

/** The choices in ~/.eesha/settings.json now. */
export function readConnectors(file: string = eeshaPath("settings.json")): ConnectorsConfig {

    return connectorsFrom(readJson(file));
}

/** Saves one connector's choices; `undefined` removes them (Disconnect). */
export function saveConnector(id: ConnectorId, config: AdoConfig | GithubConfig | undefined): Promise<{ problem: string } | { ok: true }> {

    return editSettingsJson(json => {

        const eesha = json.eesha && typeof json.eesha === "object" && !Array.isArray(json.eesha)
            ? { ...json.eesha as Record<string, unknown> }
            : {};

        const connectors = eesha.connectors && typeof eesha.connectors === "object" && !Array.isArray(eesha.connectors)
            ? { ...eesha.connectors as Record<string, unknown> }
            : {};

        if (config)
            connectors[id] = config;
        else
            delete connectors[id];

        if (Object.keys(connectors).length)
            eesha.connectors = connectors;
        else
            delete eesha.connectors;

        if (Object.keys(eesha).length)
            json.eesha = eesha;
        else
            delete json.eesha;

        return undefined;
    });
}

/** Names compared the way ADO and GitHub compare them: case does not matter. */
export function sameText(left: string, right: string): boolean {

    return left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0;
}

/**
 * A name as a `>` path level: spaces and ">" turned into "-", so a
 * pipeline called "Web CI" is typed `Web-CI`. Compared with `pathKey`.
 */
export function pathName(name: string): string {

    return name.trim().replace(/[\s>]+/g, "-");
}

/** What two path levels are compared by: dashes, spaces and case do not matter. */
export function pathKey(name: string): string {

    return name.toLowerCase().replace(/[\s_-]+/g, "");
}

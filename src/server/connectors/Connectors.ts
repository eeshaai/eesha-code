import type { PathMatch } from "../../shared/composeFiles";
import type { ConnectorCard, OfferedGroup, WorkspaceLink } from "../protocol";
import { adoLevels, adoReference, adoToolsFor, type AdoContext } from "./ado";
import { API_VERSION, projectLabel } from "./adoBase";
import { ConnectorCache, type CacheMode } from "./cache";
import { findCli, installHint, signedInAs, startSignIn, Tokens, type SignIn, type SignInProgress } from "./cliAuth";
import { checkConnector, CONNECTOR_IDS, pathKey, pathName, readConnectors, saveConnector, type ConnectorId, type ConnectorsConfig } from "./config";
import { singleRepo } from "./githubBase";
import { apiFor, ApiError, type Api, type TokenSource } from "./http";
import { eeshaPath } from "../paths";
import { githubLevels, githubReference, githubToolsFor, type GithubContext } from "./github";
import { remotesOf } from "./remotes";
import { ToolError, type ToolDef, type ItemReference } from "./tools";

/*
 * The connectors as one service for the server: the Connectors page's
 * cards, sign-in, the compose box's `>` levels, the reference lines a
 * message gets, and the tools the AI calls through `eesha mcp`
 *
 * The choices are read from settings.json on every use, so a change on
 * the Connectors page or in the file counts at once.
 */

export const CONNECTOR_TITLE: Record<ConnectorId, string> = { ado: "Azure DevOps", github: "GitHub" };

/** A write the person is asked about before it runs. */
export interface WriteQuestion {

    connector: ConnectorId;

    tool: string;

    /** What it will do, in a line or a few. */
    text: string;
}

export interface ConnectorsDeps {

    /** The saved and recent folders, whose git remotes are offered first. */
    folders(): string[];

    /** A sign-in printed something, or ended. */
    onSignIn(id: ConnectorId, progress: SignInProgress & { done?: { ok: true; account?: string } | { problem: string } }): void;

    readConfig?(): ConnectorsConfig;

    /** For tests: the web calls and the tokens, in place of fetch and the CLIs. */
    fetcher?: typeof fetch;

    tokens?: TokenSource;

    /** Where the kept lists are written. `false`: memory only - the tests. Not given: ~/.eesha/cache/connectors.json. */
    cacheFile?: string | false;
}

/** A kept list younger than this gets no refresh row - it was just fetched. */
const REFRESH_ROW_AFTER_MS = 60_000;

/** "4 min", "2 h", "3 days" - how old a kept list is, for the refresh row. */
function ageOf(at: number): string {

    const minutes = Math.floor((Date.now() - at) / 60_000);

    if (minutes < 60)
        return `${minutes} min`;

    const hours = Math.floor(minutes / 60);

    return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} days`;
}

/** The levels of a `>` path, as the compose box sends them: `>ado>workitems>12` is ado, workitems, 12. */
const PATH_TOKEN = /(^|\s)>([^\s>][^\s]*)/g;

const PATH_SHAPE = /^[^>\s]+(>[^>\s]+)*>?$/;

const TRAILING_PUNCTUATION = /[.,!?;:)\]}'"]+$/;

/** Every `>` path written in a message, each once, as its levels. */
export function pathsIn(message: string): string[][] {

    const found: string[][] = [];
    const seen = new Set<string>();

    PATH_TOKEN.lastIndex = 0;

    let match: RegExpExecArray | null;

    while ((match = PATH_TOKEN.exec(message))) {

        const word = match[2].replace(TRAILING_PUNCTUATION, "").replace(/>+$/, "");

        if (!word || !PATH_SHAPE.test(word) || seen.has(word.toLowerCase()))
            continue;

        seen.add(word.toLowerCase());
        found.push(word.split(">"));
    }

    return found;
}

export class Connectors {

    private readonly tokens: TokenSource;

    private readonly signIns = new Map<ConnectorId, SignIn>();

    /** Lists and tagged answers - see cache.ts. */
    private readonly cache: ConnectorCache;

    constructor(private readonly deps: ConnectorsDeps) {

        this.tokens = deps.tokens ?? new Tokens();
        this.cache = new ConnectorCache(deps.cacheFile === false ? undefined : deps.cacheFile ?? eeshaPath("cache", "connectors.json"));
    }

    private config(): ConnectorsConfig {

        return this.deps.readConfig ? this.deps.readConfig() : readConnectors();
    }

    /** `mode`: how a list kept past its time is taken - see `CacheMode`. */
    private api(id: ConnectorId, mode: CacheMode = "wait", onSaved?: (at: number) => void): Api {

        return apiFor(id, this.tokens, { cache: this.cache, mode, ...(this.deps.fetcher ? { fetcher: this.deps.fetcher } : {}), ...(onSaved ? { onSaved } : {}) });
    }

    private adoContext(config: ConnectorsConfig, mode?: CacheMode, onSaved?: (at: number) => void): AdoContext | undefined {

        return config.ado ? { config: config.ado, api: this.api("ado", mode, onSaved) } : undefined;
    }

    private githubContext(config: ConnectorsConfig, mode?: CacheMode, onSaved?: (at: number) => void): GithubContext | undefined {

        return config.github ? { config: config.github, api: this.api("github", mode, onSaved) } : undefined;
    }

    /** Whether any connector is connected - then sessions get the tools. */
    connected(): boolean {

        const config = this.config();

        return !!(config.ado || config.github);
    }

    /** The connectors set up, in the order the `>` list shows them. */
    connectedIds(): ConnectorId[] {

        const config = this.config();

        return CONNECTOR_IDS.filter(id => !!config[id]);
    }

    /**
     * A picked `>` path as a workspace's link. Only an ADO work item or a
     * GitHub issue is one. The link keeps the item's own path - not the
     * `mine` one it may have been picked through, which stops working
     * once the item is closed or given to someone else.
     */
    async linkItem(path: readonly string[]): Promise<{ link: WorkspaceLink } | { problem: string }> {

        const found = await this.item(path);
        const subject = found?.subject;

        if (!subject)
            return { problem: found?.problem ? `Could not read that item: ${found.problem}.` : "Pick an Azure DevOps work item or a GitHub issue." };

        const config = this.config();
        const url = found?.link ? { url: found.link } : {};

        if (subject.kind === "workitem") {

            const oneProject = (config.ado?.reach.length ?? 0) === 1;

            return {
                link: {
                    connector: "ado",
                    kind: "workitem",
                    id: String(subject.number),
                    title: subject.title,
                    path: ["ado", ...(oneProject ? [] : [subject.project]), "workitems", String(subject.number)],
                    ...url
                }
            };
        }

        const oneRepo = config.github ? singleRepo(config.github) : undefined;

        return {
            link: {
                connector: "github",
                kind: "issue",
                id: `${subject.repo}#${subject.number}`,
                title: subject.title,
                path: ["github", ...(oneRepo ? [] : [subject.repo]), "issues", String(subject.number)],
                ...url
            }
        };
    }

    // ---------------------------------------------------------------
    // Connectors page
    // ---------------------------------------------------------------

    async cards(): Promise<ConnectorCard[]> {

        const config = this.config();
        const remotes = await remotesOf(this.deps.folders());

        return Promise.all(CONNECTOR_IDS.map(async id => {

            const cli = !!findCli(id);
            const account = cli ? await signedInAs(id) : undefined;

            return {
                id,
                title: CONNECTOR_TITLE[id],
                cli,
                ...(cli ? {} : { install: installHint(id) }),
                ...(account ? { account } : {}),
                ...(config[id] ? { config: config[id] } : {}),
                found: id === "ado" ? remotes.ado.map(one => `${one.org}/${one.project}`) : remotes.github,
                offered: !account ? [] : id === "github" ? await this.githubOffered() : await this.adoOffered(),
                signingIn: this.signIns.has(id)
            };
        }));
    }

    /**
     * The signed-in GitHub user and each organization they belong to, with
     * its repos (the most recently pushed first, up to 300), offered in the
     * Connect window under what the remotes point to. An owner covers all of
     * its repos. Kept an hour. Nothing when GitHub does not answer.
     */
    private async githubOffered(): Promise<OfferedGroup[]> {

        const api = this.api("github", "stale");

        try {

            return await api.kept("offered", "all", async () => {

                const [user, orgs] = await Promise.all([
                    api<{ login: string }>("https://api.github.com/user"),
                    api<{ login: string }[]>("https://api.github.com/user/orgs?per_page=100").catch(() => [])
                ]);

                const repos = async (first: string): Promise<string[]> => {

                    const names: string[] = [];

                    for (let page = 1; page <= 3; page++) {

                        const list = await api<{ full_name: string }[]>(`${first}&per_page=100&page=${page}`).catch(() => []);

                        names.push(...list.map(repo => repo.full_name));

                        if (list.length < 100)
                            break;
                    }

                    return names;
                };

                return Promise.all([
                    repos("https://api.github.com/user/repos?affiliation=owner&sort=pushed").then(items => ({ name: user.login, items })),
                    ...orgs.map(org => repos(`https://api.github.com/orgs/${encodeURIComponent(org.login)}/repos?sort=pushed`).then(items => ({ name: org.login, items })))
                ]);
            });

        } catch {

            return [];
        }
    }

    /**
     * Each ADO organization the az sign-in belongs to, with its projects as
     * "org/project", offered in the Connect window under what the remotes
     * point to. Without this, a person whose folders have no ADO remote had
     * nothing to tick. Kept an hour. An organization that does not
     * answer is left out; nothing when ADO does not answer at all.
     */
    private async adoOffered(): Promise<OfferedGroup[]> {

        const api = this.api("ado", "stale");

        try {

            return await api.kept("offered", "all", async () => {

                const me = await api<{ publicAlias: string }>(`https://app.vssps.visualstudio.com/_apis/profile/profiles/me?${API_VERSION}`);
                const orgs = await api<{ value: { accountName: string }[] }>(
                    `https://app.vssps.visualstudio.com/_apis/accounts?memberId=${encodeURIComponent(me.publicAlias)}&${API_VERSION}`);

                const groups = await Promise.all(orgs.value.map(async org => {

                    try {

                        const projects = await api<{ value: { name: string }[] }>(
                            `https://dev.azure.com/${encodeURIComponent(org.accountName)}/_apis/projects?$top=1000&${API_VERSION}`);

                        return { name: org.accountName, items: projects.value.map(project => `${org.accountName}/${project.name}`).sort((a, b) => a.localeCompare(b)) };

                    } catch {

                        return { name: org.accountName, items: [] };
                    }
                }));

                return groups.filter(group => group.items.length).sort((a, b) => a.name.localeCompare(b.name));
            });

        } catch {

            return [];
        }
    }

    /** Starts the CLI's sign-in. Progress and the end come through `onSignIn`. */
    signIn(id: ConnectorId): { problem: string } | { ok: true } {

        if (this.signIns.has(id))
            return { problem: "A sign-in is already running - finish it in the browser, or stop it." };

        const signIn = startSignIn(id, progress => this.deps.onSignIn(id, progress));

        this.signIns.set(id, signIn);

        void signIn.done.then(done => {

            this.signIns.delete(id);
            this.tokens.forget(id);
            // Maybe someone else now: nothing kept for the last account is shown again.
            this.cache.clear(id, true);
            this.deps.onSignIn(id, { done });
        });

        return { ok: true };
    }

    stopSignIn(id: ConnectorId): void {

        this.signIns.get(id)?.stop();
    }

    /** Saves a connector's choices as the page or the command sent them. */
    async save(id: ConnectorId, value: unknown): Promise<{ problem: string } | { ok: true }> {

        const checked = checkConnector(id, value);

        if ("problem" in checked)
            return checked;

        return saveConnector(id, checked.config);
    }

    /** Disconnect: forgets Eesha Code's choices and what it kept. The CLI stays signed in. */
    async remove(id: ConnectorId): Promise<{ problem: string } | { ok: true }> {

        this.tokens.forget(id);
        this.cache.clear(id, true);
        this.cache.save();

        return saveConnector(id, undefined);
    }

    // ---------------------------------------------------------------
    // The compose box
    // ---------------------------------------------------------------

    /**
     * The rows for a `>` path being typed. A kept list is
     * shown even past its time while a fresh one is fetched; then a last
     * row says how old it is, and picking it asks again with `refresh`.
     */
    async search(path: readonly string[], query: string, options: { refresh?: boolean; link?: WorkspaceLink } = {}): Promise<PathMatch[]> {

        const config = this.config();

        if (!path.length) {

            const on = CONNECTOR_IDS.filter(id => config[id] && id.includes(query.toLowerCase()));

            if (!config.ado && !config.github)
                return [{ name: "connect", detail: "No connector yet - connect ADO or GitHub on the Connectors page.", disabled: true }];

            // The workspace's work item or issue first, while its connector
            // is set up: picking it writes its whole path
            // (`>ado>workitems>12345`) and ends there.
            const link = options.link && config[options.link.connector] ? options.link : undefined;
            const name = link?.path.join(">");
            const words = query.toLowerCase();
            const first = link && name && (pathKey(name).includes(pathKey(query)) || link.title.toLowerCase().includes(words))
                ? [{ name, detail: `This workspace's ${link.kind === "workitem" ? "work item" : "issue"} - ${link.title}`, leaf: true }]
                : [];

            return [...first, ...on.map(id => ({ name: id, detail: CONNECTOR_TITLE[id] }))];
        }

        const [id, ...rest] = path;
        const mode: CacheMode = options.refresh ? "reload" : "stale";
        let oldest: number | undefined;
        const onSaved = (at: number) => { oldest = Math.min(oldest ?? at, at); };
        const ado = id.toLowerCase() === "ado" ? this.adoContext(config, mode, onSaved) : undefined;
        const github = id.toLowerCase() === "github" ? this.githubContext(config, mode, onSaved) : undefined;

        try {

            const rows = ado ? await adoLevels(ado, rest, query) : github ? await githubLevels(github, rest, query) : undefined;

            if (!rows)
                return [];

            if (oldest === undefined || Date.now() - oldest < REFRESH_ROW_AFTER_MS)
                return rows;

            return [...rows, {
                name: "refresh",
                detail: `Saved ${ageOf(oldest)} ago - pick to ask ${CONNECTOR_TITLE[ado ? "ado" : "github"]} again`,
                refresh: true
            }];

        } catch (error) {

            return [{ name: "problem", detail: (error as Error).message, disabled: true }];
        }

        return [];
    }

    /**
     * What one `>` path points at: its line for the AI, and its
     * web address when it has one. Nothing at all for a first word that is
     * not a connector's id - that is just text.
     */
    async item(path: readonly string[]): Promise<ItemReference | undefined> {

        const [id = "", ...rest] = path;
        const config = this.config();
        // A kept list past its time is good enough to name what a path points at.
        const ado = id.toLowerCase() === "ado" ? this.adoContext(config, "stale") : undefined;
        const github = id.toLowerCase() === "github" ? this.githubContext(config, "stale") : undefined;

        if (!ado && !github)
            return CONNECTOR_IDS.includes(id.toLowerCase() as ConnectorId)
                ? { problem: `${CONNECTOR_TITLE[id.toLowerCase() as ConnectorId]} is not connected` }
                : undefined;

        try {

            return ado ? await adoReference(ado, rest) : await githubReference(github!, rest);

        } catch (error) {

            return { problem: (error as Error).message };
        }
    }

    /**
     * One line per `>` path in the message. A path that does
     * not resolve is left as plain text and named in `note`.
     */
    async references(message: string): Promise<{ lines: string[]; note?: string }> {

        const lines: string[] = [];
        const problems: string[] = [];

        for (const path of pathsIn(message)) {

            const found = await this.item(path);

            if (found?.line)
                lines.push(found.line);
            else if (found?.problem)
                problems.push(`>${path.join(">")}: ${found.problem}`);
        }

        return {
            lines,
            ...(problems.length ? { note: `Sent as plain text - ${problems.join("; ")}.` } : {})
        };
    }

    // ---------------------------------------------------------------
    // The AI's tools
    // ---------------------------------------------------------------

    /** The tools the choices allow now. */
    private allowed(config: ConnectorsConfig): ToolDef<AdoContext | GithubContext>[] {

        return [
            ...(config.ado ? adoToolsFor(config.ado.sources) : []),
            ...(config.github ? githubToolsFor(config.github.sources) : [])
        ] as ToolDef<AdoContext | GithubContext>[];
    }

    /** The MCP tool list. */
    tools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {

        return this.allowed(this.config()).map(one => ({ name: one.name, description: one.description, inputSchema: one.inputSchema }));
    }

    /**
     * Runs one tool call. A tool that the choices do not allow is refused
     * even when a runtime calls it. A write asks the
     * person first, every time; no answer is a no.
     */
    async call(name: string, args: unknown, ask: (question: WriteQuestion) => Promise<boolean>): Promise<{ text: string; isError?: boolean }> {

        const config = this.config();
        const found = this.allowed(config).find(one => one.name === name);

        if (!found)
            return { text: `${name} is not allowed. The person chooses what the connectors may do on the Connectors page.`, isError: true };

        const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {};

        try {

            if (found.write) {

                const allowed = await ask({ connector: found.connector, tool: found.name, text: found.describe?.(input) ?? found.name });

                if (!allowed)
                    return { text: "The person said no. Nothing was changed.", isError: true };
            }

            const context = found.connector === "ado" ? this.adoContext(config) : this.githubContext(config);

            try {

                const result = await found.run(input, context!);

                return { text: JSON.stringify(result, undefined, 1) };

            } finally {

                // A write may have changed a kept list - a new wiki page, a
                // renamed repo. Even a failed one may have done part of it.
                if (found.write)
                    this.cache.clear(found.connector);
            }

        } catch (error) {

            if (error instanceof ToolError || error instanceof ApiError)
                return { text: error.message, isError: true };

            return { text: `${name} failed: ${(error as Error).message}`, isError: true };
        }
    }
}

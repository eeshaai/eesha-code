import { EnvService } from "../../env/envService";
import { SourcedServer } from "../../settings/engineSettings";
import {
    BARE_ENV_EXPRESSION, ENV_EXPRESSION, envNamesIn
} from "../../templating/configScope";

/**
 * MCP server declarations from `settings.json`, made ready for a
 * session.
 *
 * The declarations arrive already merged across the two settings scopes
 * (see `mergeEngineSettings`); this module handles each server:
 *
 *   - `disabled: true`, an engine key stripped before the SDK sees the
 *     server, skips it entirely.
 *   - `${{ env.NAME }}` in any string value is expanded under the env
 *     gate - see {@link expandEnv}.
 *
 * Which servers a session gets, and which of their tools, is the task's
 * `mcp:` arg - see {@link McpSelection}. A task that says nothing gets
 * every server and every tool.
 *
 * A malformed declaration throws, naming its file.
 */

/**
 * What one task asks for out of the servers settings.json declares -
 * `ai@1`'s `mcp:` arg.
 *
 * Both keys are allowlists, both optional, and absence means "all":
 *
 *   - no `servers`: every declared server.
 *   - `servers`: only those. A name settings.json does not declare is
 *     an error naming the declared ones, so a typo cannot silently
 *     start a session without the server the prompt asks for.
 *   - no `tools`: every tool of each selected server.
 *   - `tools`: per server, only those. A server named here that
 *     `servers` does not select, or settings.json does not declare, is
 *     the same error.
 *
 * A server `disabled: true` in settings.json stays out even when a task
 * names it. A task may choose among the machine's servers, never
 * declare one - which is why every provider strips `mcpServers` from
 * `extra`.
 */
export interface McpSelection {

    /** Server keys, as declared under `ai.mcpServers`. Absent means every server. */
    servers?: readonly string[];

    /** Bare tool names per server key. Absent means every tool of each selected server. */
    tools?: Readonly<Record<string, readonly string[]>>;
}

/**
 * An `mcp:` arg as written, checked for shape. Throws with the message
 * the task should fail with, naming the key and showing the form.
 *
 * Shape only: whether the names exist is checked in
 * {@link resolveMcpServers}, which has the declarations.
 */
export function parseMcpSelection(value: unknown): McpSelection | undefined {

    if (value === undefined)
        return undefined;

    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error(
            "'mcp' must be an object with 'servers' and/or 'tools', "
            + "e.g. mcp: { servers: [ado], tools: { ado: [wit_get_work_item] } }.");

    const raw = value as Record<string, unknown>;

    for (const key of Object.keys(raw))
        if (key !== "servers" && key !== "tools")
            throw new Error(`'mcp.${key}' is not a key here. Valid: servers, tools.`);

    const selection: McpSelection = {};

    if (raw.servers !== undefined) {

        if (!isStringList(raw.servers))
            throw new Error("'mcp.servers' must be a list of server names, e.g. mcp: { servers: [ado, github] }.");

        selection.servers = raw.servers;
    }

    if (raw.tools !== undefined) {

        if (!raw.tools || typeof raw.tools !== "object" || Array.isArray(raw.tools))
            throw new Error(
                "'mcp.tools' must map a server name to a list of tool names, "
                + "e.g. mcp: { tools: { ado: [wit_get_work_item, wit_update_work_item] } }.");

        const tools: Record<string, readonly string[]> = {};

        for (const [server, list] of Object.entries(raw.tools as Record<string, unknown>)) {

            if (!isStringList(list))
                throw new Error(
                    `'mcp.tools.${server}' must be a list of tool names, `
                    + `e.g. mcp: { tools: { ${server}: [wit_get_work_item] } }.`);

            tools[server] = list;
        }

        selection.tools = tools;
    }

    return selection;
}

function isStringList(value: unknown): value is string[] {

    return Array.isArray(value) && value.every(item => typeof item === "string");
}

/**
 * settings.json's servers plus the ones the program running the chat
 * adds itself - see `ProviderDeps.mcpServers`. A server the program adds
 * replaces a declared one with the same name.
 */
export function withHostServers(
    declared: Record<string, SourcedServer>,
    host: Record<string, unknown> | undefined
): Record<string, SourcedServer> {

    if (!host || !Object.keys(host).length)
        return declared;

    const merged = { ...declared };

    for (const [name, server] of Object.entries(host))
        merged[name] = { server, source: "the program running this chat" };

    return merged;
}

/** What a session gets: the cleaned servers, each carrying its `tools` allowlist when the task gave one. */
export interface McpResolution {

    /** Engine keys stripped, env expanded. Not yet normalized - that is `sessionConfig`'s step. */
    servers: Record<string, unknown>;
}

/**
 * The servers a session should get, or undefined when nothing is
 * declared (or every declared server is disabled, or the task selected
 * none of the ones that are).
 *
 * The env gate (who may grant `${{ env.NAME }}` a name, and who forbids
 * one) is the {@link EnvService}, defined there and only consulted here.
 *
 * @param selection the task's `mcp:` arg, already shape-checked by
 *                  {@link parseMcpSelection}. Undefined means every
 *                  server, every tool.
 */
export function resolveMcpServers(
    servers: Record<string, SourcedServer>,
    envs: EnvService,
    selection?: McpSelection
): McpResolution | undefined {

    checkSelection(servers, selection);

    const resolved: Record<string, unknown> = {};

    for (const [name, { server, source }] of Object.entries(servers)) {

        if (selection?.servers && !selection.servers.includes(name))
            continue;

        const processed = processServer(name, server, source, envs, selection?.tools?.[name]);

        if (processed !== undefined)
            resolved[name] = processed;
    }

    return Object.keys(resolved).length ? { servers: resolved } : undefined;
}

/**
 * Every name the selection uses, checked against what is declared,
 * before any server is processed, so a typo fails the session instead
 * of quietly starting it without the server.
 *
 * A disabled server is declared and therefore a valid name: the task
 * may ask for it, and settings.json says no without an error.
 */
function checkSelection(servers: Record<string, SourcedServer>, selection?: McpSelection): void {

    if (!selection)
        return;

    const declared = Object.keys(servers);
    const declaredList = declared.length ? declared.join(", ") : "(none)";

    for (const name of selection.servers ?? [])
        if (!declared.includes(name))
            throw new Error(
                `'mcp.servers' names '${name}', but settings.json declares no MCP server by that name. `
                + `Declared: ${declaredList}.`);

    for (const name of Object.keys(selection.tools ?? {})) {

        if (!declared.includes(name))
            throw new Error(
                `'mcp.tools' names '${name}', but settings.json declares no MCP server by that name. `
                + `Declared: ${declaredList}.`);

        if (selection.servers && !selection.servers.includes(name))
            throw new Error(
                `'mcp.tools' names '${name}', which 'mcp.servers' does not select. `
                + `Selected: ${selection.servers.join(", ")}.`);
    }
}

/**
 * One server through the whole pipeline: engine keys read and stripped,
 * env expanded under the gate. Returns undefined for a disabled server.
 *
 * @param taskTools the task's allowlist for this server, from its
 *                  `mcp.tools`. Becomes the server's `tools` key, the
 *                  SDK's own per-server allowlist. Absent means the key
 *                  is left as written.
 */
function processServer(
    name: string,
    declared: unknown,
    source: string,
    envs: EnvService,
    taskTools?: readonly string[]
): unknown {

    // Anything that is not a server object is left for the CLI to
    // complain about, as the normalizer does.
    if (!declared || typeof declared !== "object" || Array.isArray(declared))
        return declared;

    const entry = { ...(declared as Record<string, unknown>) };

    if (entry.disabled === true)
        return undefined;

    delete entry.disabled;

    // A `tools:` key the author wrote is a standard key and passes
    // through; the task's list, when given, replaces it.
    if (taskTools)
        entry.tools = [...taskTools];

    return expandEnv(entry, source, envs);
}

/**
 * `${{ env.NAME }}` in any string value, replaced with the variable's
 * value, only if something granted that name.
 *
 * The gate is a security boundary: a workspace settings.json arrives
 * with the repository, and without the gate a committed file could read
 * any secret off any machine that runs a workflow and hand it to a
 * server. Every grant is something a reviewer sees: `env.allowed` in
 * the same file, the workflow's `env:` block, the task's `allowedEnv:`
 * arg, or the person's own uncommitted `.env`.
 *
 * The gate follows where the value goes, not its spelling: a value
 * handed to a third-party server process is gated; a value the engine
 * consumes itself is only subject to `env.denied`.
 *
 * This runs as a second pass. `settings.json`'s anchors are resolved
 * when the file is read, but the grants include a task's own, which do
 * not exist yet, so `resolveAnchorsOnly` leaves `${{ env.… }}` alone
 * and it is answered here.
 *
 * The grants, the veto and the error messages are
 * {@link EnvService.resolve}'s. This function adds context: the file
 * and the expression that asked.
 *
 * Values only, walked recursively. Keys are structure.
 */
function expandEnv(value: unknown, source: string, envs: EnvService): unknown {

    if (typeof value === "string") {

        refuseBare(value, source, envs);

        return value.replace(new RegExp(ENV_EXPRESSION), (_, name: string) => {

            try {

                return envs.resolve(name);

            } catch (error) {

                throw new Error(
                    `${source} uses \${{ env.${name} }}: ` +
                    `${error instanceof Error ? error.message : String(error)}`);
            }
        });
    }

    if (Array.isArray(value))
        return value.map(entry => expandEnv(entry, source, envs));

    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value)
            .map(([key, entry]) => [key, expandEnv(entry, source, envs)]));

    return value;
}

/**
 * The bare `${VAR}` form, refused by name - but only for a name the gate
 * grants. It reads nothing, so the server would start with the
 * placeholder itself as its token and fail at the handshake, nowhere
 * near the line that caused it.
 *
 * The grant is what separates a mistake from another tool's dialect:
 * `${workspaceFolder}` and `${input:token}` mean something to whoever
 * else reads the file and must pass through untouched, while a name
 * `env.allowed` lists was plainly meant as an env read.
 */
function refuseBare(value: string, source: string, envs: EnvService): void {

    for (const [, name] of value.matchAll(new RegExp(BARE_ENV_EXPRESSION)))
        if (envs.granted(name))
            throw new Error(
                `${source} uses '\${${name}}', which reads nothing - it is passed through as literal ` +
                `text. Write it as '\${{ env.${name} }}' - the only form this file reads.`);
}

/**
 * The env var names a declaration reads, without resolving any of them.
 * The MCP panel shows these in a server's tooltip and in the first-start
 * confirmation.
 */
export function referencedEnv(server: unknown): string[] {

    return [...envNamesIn(server)];
}

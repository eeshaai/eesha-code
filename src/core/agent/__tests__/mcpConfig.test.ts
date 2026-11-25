import { describe, expect, it } from "vitest";

import { parseMcpSelection, referencedEnv, resolveMcpServers } from "../providers/mcpConfig";
import { EnvAccess, EnvService } from "../../env/envService";
import { SourcedServer } from "../../settings/engineSettings";

/**
 * MCP declarations through the per-server pipeline: the one engine key
 * (`disabled`), the task's own selection (`mcp.servers` / `mcp.tools`)
 * and the gated `${{ env.VAR }}` expansion. Reading and merging
 * settings.json belongs to `engineSettings` and is tested there; what
 * arrives here is the merged server map, each entry naming its source.
 */

const SOURCE = "'C:/repo/.eesha/settings.json'";

function sourced(servers: Record<string, unknown>): Record<string, SourcedServer> {

    return Object.fromEntries(Object.entries(servers)
        .map(([name, server]) => [name, { server, source: SOURCE }]));
}

/** A gate that allows nothing, unless a test opens it. */
function gate(overrides: Partial<EnvAccess> = {}): EnvService {

    return new EnvService({ env: {}, allowed: [], denied: [], ...overrides });
}

describe("resolveMcpServers", () => {

    it("returns undefined for an empty map", () => {

        expect(resolveMcpServers({}, gate())).toBeUndefined();
    });

    it("passes a plain server through", () => {

        expect(resolveMcpServers(sourced({ ado: { command: "npx" } }), gate())?.servers)
            .toEqual({ ado: { command: "npx" } });
    });

    describe("disabled", () => {

        it("skips a disabled server and keeps the rest", () => {

            const resolved = resolveMcpServers(sourced({
                off: { command: "npx", disabled: true },
                on: { command: "node" }
            }), gate());

            expect(resolved?.servers).toEqual({ on: { command: "node" } });
        });

        it("returns undefined when every server is disabled", () => {

            expect(resolveMcpServers(
                sourced({ off: { command: "npx", disabled: true } }), gate()))
                .toBeUndefined();
        });

        /* `disabled: false` is the UI's state, never forwarded. */
        it("strips the disabled key from an enabled server", () => {

            expect(resolveMcpServers(
                sourced({ on: { command: "npx", disabled: false } }), gate())?.servers.on)
                .toEqual({ command: "npx" });
        });
    });

    it("leaves a directly-written tools key alone", () => {

        expect(resolveMcpServers(
            sourced({ ado: { command: "npx", tools: ["one"] } }), gate())?.servers.ado)
            .toEqual({ command: "npx", tools: ["one"] });
    });

    /* A malformed entry is the CLI's to complain about. */
    it("passes a non-object server entry through untouched", () => {

        expect(resolveMcpServers(sourced({ s: "not a server" }), gate())?.servers.s)
            .toBe("not a server");
    });

    /*
     * Gated, because a workspace settings.json arrives with the
     * repository and must not read arbitrary secrets off the machine.
     * Three grants (env.allowed, the task's own env, the allowedEnv
     * arg), one veto (env.denied).
     */
    describe("${{ env.VAR }} expansion", () => {

        /*
         * The bare form every other MCP tool uses. It matches nothing
         * the engine reads, so it would be literal text handed to
         * the server - a token-shaped placeholder that fails at the
         * handshake, not at the line that wrote it.
         */
        it("refuses the bare ${VAR} spelling, naming the right one", () => {

            expect(() => resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${ADO_PAT}" } } }),
                gate({ env: { ADO_PAT: "secret" }, allowed: ["ADO_PAT"] })))
                .toThrow(/reads nothing.*\$\{\{ env\.ADO_PAT \}\}/s);
        });

        it("refuses the bare spelling inside a longer string", () => {

            expect(() => resolveMcpServers(
                sourced({ s: { type: "http", url: "u", headers: { Authorization: "Bearer ${GITHUB_TOKEN}" } } }),
                gate({ env: { GITHUB_TOKEN: "t" }, allowed: ["GITHUB_TOKEN"] })))
                .toThrow(/reads nothing.*\$\{\{ env\.GITHUB_TOKEN \}\}/s);
        });

        /*
         * The grant is what tells a mistake from another tool's dialect.
         * Both are bare `${...}`; only the granted one was meant as an
         * env read.
         */
        it("leaves an ungranted bare name alone while refusing a granted one", () => {

            const dialect = sourced({ s: { command: "npx", args: ["${workspaceFolder}"] } });

            expect(resolveMcpServers(dialect, gate({ allowed: ["ADO_PAT"], env: { ADO_PAT: "x" } }))
                ?.servers.s)
                .toEqual({ command: "npx", args: ["${workspaceFolder}"] });

            expect(() => resolveMcpServers(
                sourced({ s: { command: "npx", args: ["${ADO_PAT}"] } }),
                gate({ allowed: ["ADO_PAT"], env: { ADO_PAT: "x" } })))
                .toThrow(/reads nothing/);
        });

        it("does not mistake the real form for the bare one", () => {

            const resolved = resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } }),
                gate({ env: { ADO_PAT: "secret" }, allowed: ["ADO_PAT"] }));

            expect(resolved?.servers.s).toEqual({ command: "npx", env: { PAT: "secret" } });
        });

        it("expands a name granted by env.allowed, in any string value", () => {

            const resolved = resolveMcpServers(sourced({
                ado: {
                    command: "npx",
                    args: ["--org", "${{ env.ADO_ORG }}"],
                    env: { PAT: "${{ env.ADO_PAT }}" }
                },
                remote: {
                    type: "http",
                    url: "https://${{ env.MCP_HOST }}/mcp",
                    headers: { Authorization: "Bearer ${{ env.ADO_PAT }}" }
                }
            }), gate({
                env: { ADO_ORG: "contoso", ADO_PAT: "secret", MCP_HOST: "example.com" },
                allowed: ["ADO_ORG", "ADO_PAT", "MCP_HOST"]
            }));

            expect(resolved?.servers).toEqual({
                ado: {
                    command: "npx",
                    args: ["--org", "contoso"],
                    env: { PAT: "secret" }
                },
                remote: {
                    type: "http",
                    url: "https://example.com/mcp",
                    headers: { Authorization: "Bearer secret" }
                }
            });
        });

        it("expands a name granted by the task's allowedEnv arg", () => {

            const resolved = resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } }),
                gate({ env: { ADO_PAT: "secret" }, allowedEnv: ["ADO_PAT"] }));

            expect(resolved?.servers.s).toEqual({ command: "npx", env: { PAT: "secret" } });
        });

        /* The task's value wins over the machine's, as it does for a spawned process. */
        it("expands a name the task's env declares, preferring the task's value", () => {

            const resolved = resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } }),
                gate({
                    env: { ADO_PAT: "from-machine" },
                    taskEnv: { ADO_PAT: "from-task" }
                }));

            expect(resolved?.servers.s).toEqual({ command: "npx", env: { PAT: "from-task" } });
        });

        it("throws on a denied name even when everything else grants it", () => {

            expect(() => resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } }),
                gate({
                    env: { ADO_PAT: "set" },
                    allowed: ["ADO_PAT"],
                    allowedEnv: ["ADO_PAT"],
                    taskEnv: { ADO_PAT: "also set" },
                    denied: ["ADO_PAT"]
                })))
                .toThrow(/'ADO_PAT' is denied by 'env\.denied'/);
        });

        it("throws on a name nothing grants, saying how to grant it", () => {

            expect(() => resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } }),
                gate({ env: { ADO_PAT: "set-but-not-granted" } })))
                .toThrow(/env\.ADO_PAT.*env\.allowed.*'env:' block.*allowedEnv/s);
        });

        it("throws on a granted name that is not set", () => {

            expect(() => resolveMcpServers(
                sourced({ s: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } }),
                gate({ allowed: ["ADO_PAT"] })))
                .toThrow(/'ADO_PAT' is not set/);
        });

        /* Empty is a value someone chose. Only absence is a mistake. */
        it("accepts a granted name that is set but empty", () => {

            const resolved = resolveMcpServers(
                sourced({ s: { command: "npx", args: ["${{ env.EMPTY }}"] } }),
                gate({ env: { EMPTY: "" }, allowed: ["EMPTY"] }));

            expect(resolved?.servers.s).toEqual({ command: "npx", args: [""] });
        });

        it("leaves other dialects alone", () => {

            const resolved = resolveMcpServers(sourced({
                s: { command: "npx", args: ["${VAR}", "${input:token}", "${workspaceFolder}"] }
            }), gate({ env: { VAR: "never" } }));

            expect(resolved?.servers.s).toEqual({
                command: "npx",
                args: ["${VAR}", "${input:token}", "${workspaceFolder}"]
            });
        });

        /* Skipping runs before expanding. */
        it("does not expand inside a disabled server", () => {

            const resolved = resolveMcpServers(sourced({
                off: { command: "npx", env: { PAT: "${{ env.NOT_GRANTED }}" }, disabled: true },
                on: { command: "node" }
            }), gate());

            expect(resolved?.servers).toEqual({ on: { command: "node" } });
        });
    });

    /* A task's `mcp:` arg. Settings say what the machine has; the task can only narrow it. */
    describe("a task's selection", () => {

        const declared = () => sourced({
            ado: { command: "npx" },
            github: { command: "node" },
            playwright: { command: "npx", disabled: true }
        });

        it("gives every server when the task says nothing", () => {

            expect(Object.keys(resolveMcpServers(declared(), gate())?.servers ?? {}))
                .toEqual(["ado", "github"]);
        });

        it("keeps only the servers named", () => {

            const resolved = resolveMcpServers(declared(), gate(), { servers: ["github"] });

            expect(resolved?.servers).toEqual({ github: { command: "node" } });
        });

        it("gives nothing for an empty servers list - a phase that needs no server", () => {

            expect(resolveMcpServers(declared(), gate(), { servers: [] })).toBeUndefined();
        });

        /* Silent, because disabling was deliberate. */
        it("leaves a disabled server out even when the task names it", () => {

            const resolved = resolveMcpServers(declared(), gate(), { servers: ["github", "playwright"] });

            expect(resolved?.servers).toEqual({ github: { command: "node" } });
        });

        /* A silently dropped typo would start a session without the tool the prompt asks for. */
        it("fails on a server settings.json does not declare, naming the declared ones", () => {

            expect(() => resolveMcpServers(declared(), gate(), { servers: ["adoo"] }))
                .toThrow("'mcp.servers' names 'adoo', but settings.json declares no MCP server by that name. "
                    + "Declared: ado, github, playwright.");
        });

        it("becomes the server's tools allowlist", () => {

            const resolved = resolveMcpServers(declared(), gate(), { tools: { github: ["get_issue"] } });

            expect(resolved?.servers.github).toEqual({ command: "node", tools: ["get_issue"] });
        });

        it("leaves a server alone when the task's tools name only another", () => {

            const resolved = resolveMcpServers(declared(), gate(), { tools: { github: ["get_issue"] } });

            expect(resolved?.servers.ado).toEqual({ command: "npx" });
        });

        it("replaces a directly-written tools key with the task's list", () => {

            const resolved = resolveMcpServers(
                sourced({ ado: { command: "npx", tools: ["one", "two"] } }), gate(), { tools: { ado: ["one"] } });

            expect(resolved?.servers.ado).toEqual({ command: "npx", tools: ["one"] });
        });

        it("fails on a tools entry for a server the task did not select", () => {

            expect(() => resolveMcpServers(declared(), gate(), { servers: ["github"], tools: { ado: ["x"] } }))
                .toThrow("'mcp.tools' names 'ado', which 'mcp.servers' does not select. Selected: github.");
        });

        it("fails on a tools entry for a server settings.json does not declare", () => {

            expect(() => resolveMcpServers(declared(), gate(), { tools: { nope: ["x"] } }))
                .toThrow("'mcp.tools' names 'nope', but settings.json declares no MCP server by that name.");
        });
    });
});

/* The shape check `ai@1` runs on the arg. Names are `resolveMcpServers`'s question. */
describe("parseMcpSelection", () => {

    it("returns undefined for an absent arg", () => {

        expect(parseMcpSelection(undefined)).toBeUndefined();
    });

    it("passes a well-formed selection through", () => {

        expect(parseMcpSelection({ servers: ["ado"], tools: { ado: ["wit_get_work_item"] } }))
            .toEqual({ servers: ["ado"], tools: { ado: ["wit_get_work_item"] } });
    });

    it("accepts either key alone", () => {

        expect(parseMcpSelection({ servers: ["ado"] })).toEqual({ servers: ["ado"] });
        expect(parseMcpSelection({ tools: { ado: [] } })).toEqual({ tools: { ado: [] } });
    });

    it("refuses anything but an object, showing the form", () => {

        expect(() => parseMcpSelection(["ado"])).toThrow("'mcp' must be an object with 'servers' and/or 'tools'");
        expect(() => parseMcpSelection("ado")).toThrow("'mcp' must be an object");
        expect(() => parseMcpSelection(null)).toThrow("'mcp' must be an object");
    });

    it("refuses a key it does not know", () => {

        expect(() => parseMcpSelection({ server: ["ado"] }))
            .toThrow("'mcp.server' is not a key here. Valid: servers, tools.");
    });

    it("refuses servers that is not a list of names", () => {

        expect(() => parseMcpSelection({ servers: "ado" })).toThrow("'mcp.servers' must be a list of server names");
        expect(() => parseMcpSelection({ servers: [1] })).toThrow("'mcp.servers' must be a list of server names");
    });

    it("refuses tools that is not a map of lists", () => {

        expect(() => parseMcpSelection({ tools: ["x"] })).toThrow("'mcp.tools' must map a server name to a list");
        expect(() => parseMcpSelection({ tools: { ado: "x" } })).toThrow("'mcp.tools.ado' must be a list of tool names");
    });
});

/* The names a declaration reads, for the MCP panel to show before resolving. */
describe("referencedEnv", () => {

    it("collects every distinct name, wherever it appears", () => {

        expect(referencedEnv({
            command: "npx",
            args: ["--org", "${{ env.ORG }}"],
            env: { PAT: "${{ env.PAT }}", AGAIN: "${{ env.PAT }}" },
            headers: { Authorization: "Bearer ${{ env.PAT }}" }
        }).sort()).toEqual(["ORG", "PAT"]);
    });

    it("returns empty for a declaration that reads nothing", () => {

        expect(referencedEnv({ command: "npx", args: ["${VAR}"] })).toEqual([]);
    });
});

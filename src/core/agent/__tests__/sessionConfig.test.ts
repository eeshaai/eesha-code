import { describe, expect, it } from "vitest";

import { describeOptions, sessionConfig } from "../providers/CopilotProvider";

/**
 * What the Copilot provider asks the SDK for. Importing it loads the
 * SDK, but building the options is pure: no client, no CLI.
 *
 * Two rules: the model the caller named is the model asked for, and
 * `extra` overrides what the provider set itself. A default written
 * below the `extra` spread breaks both.
 */

const BASE = { workingDirectory: "C:/repo", env: {} };

describe("sessionConfig", () => {

    it("asks for the model the caller chose", () => {

        expect(sessionConfig({ ...BASE, model: "claude-sonnet-4.5" }).model)
            .toBe("claude-sonnet-4.5");
    });

    /*
     * `ai@1` strips `model` from the args it passes through, so it can
     * never arrive in `extra`. A default reading `extra.model` would
     * always fire.
     */
    it("does not look for the model in extra, where it can never be", () => {

        const config = sessionConfig({ ...BASE, model: "gpt-5", extra: {} });

        expect(config.model).toBe("gpt-5");
    });

    it("falls back to auto only when no one chose a model", () => {

        expect(sessionConfig(BASE).model).toBe("auto");
    });

    /* AgentSessionConfig.extra is applied over the fields the provider sets. */
    it("lets extra override a setting the provider made itself", () => {

        const config = sessionConfig({ ...BASE, extra: { enableHostGitOperations: false } });

        expect(config.enableHostGitOperations).toBe(false);
    });

    /*
     * The handler keeps a session inside its own directories. A
     * workflow that could replace it could approve its own way out.
     * One of the few exceptions to "extra overrides everything".
     */
    it("keeps its own permission handler when a task names one of its own", () => {

        const mine = () => ({ kind: "approve-once" as const });

        const config = sessionConfig({ ...BASE, extra: { onPermissionRequest: mine } });

        expect(config.onPermissionRequest).not.toBe(mine);
    });

    /* Allow all answers by itself; the thread is told what went through, and only that. */
    describe("the requests it allows without asking", () => {

        const told: unknown[] = [];

        const config = sessionConfig(
            BASE, undefined, undefined, undefined, false, undefined,
            permission => told.push(permission));

        it("says which request it allowed, with the command as sent", () => {

            told.length = 0;

            expect(config.onPermissionRequest?.({ kind: "shell", fullCommandText: "npm test" } as never, { sessionId: "s_1" }))
                .toEqual({ kind: "approve-once" });

            expect(told).toEqual([{ tool: "shell", input: "npm test" }]);
        });

        it("says nothing about a request it refused", () => {

            told.length = 0;

            expect(config.onPermissionRequest?.({ kind: "read", path: "C:/elsewhere/keys.txt" } as never, { sessionId: "s_1" }))
                .toMatchObject({ kind: "reject" });

            expect(told).toEqual([]);
        });
    });

    /* `debug: true` in the profile settings only; the loader refuses it in a workspace file. */
    describe("debug", () => {

        const open = () => sessionConfig(BASE, undefined, undefined, undefined, true);

        it("lets the permission handler approve a path it would otherwise reject", () => {

            expect(open().onPermissionRequest?.(
                { kind: "read", path: "C:/elsewhere/keys.txt" } as never,
                { sessionId: "s_1" }))
                .toEqual({ kind: "approve-once" });
        });

        it("lets the pre-tool hook through the same path", async () => {

            expect(await open().hooks!.onPreToolUse!(
                { toolName: "read", toolArgs: { path: "C:/elsewhere/keys.txt" } } as never,
                { sessionId: "s_1" }))
                .toBeUndefined();
        });

        it("changes nothing when it is not set", () => {

            const decision = sessionConfig(BASE).onPermissionRequest?.(
                { kind: "read", path: "C:/elsewhere/keys.txt" } as never,
                { sessionId: "s_1" }) as { kind: string };

            expect(decision.kind).toBe("reject");
        });
    });

    /*
     * `onPermissionRequest` only fires for calls that raise a permission
     * request, and the runtime has ways not to raise one: a persisted
     * approval, the system temp directory, allow-all mode.
     * `onPreToolUse` runs before every tool, so none of those route
     * around it.
     */
    describe("the pre-tool hook", () => {

        type Hook = NonNullable<NonNullable<ReturnType<typeof sessionConfig>["hooks"]>["onPreToolUse"]>;

        const hookOf = (directories?: string[]): Hook =>
            sessionConfig(BASE, directories).hooks!.onPreToolUse!;

        const run = async (hook: Hook, toolArgs: unknown) =>
            await hook({ toolName: "read", toolArgs } as never, { sessionId: "s_1" });

        it("is registered", () => {

            expect(hookOf()).toBeTypeOf("function");
        });

        it("lets a call inside the working directory through", async () => {

            expect(await run(hookOf(), { path: "C:/repo/src/app.ts" })).toBeUndefined();
        });

        it("denies a call outside it", async () => {

            const decision = await run(hookOf(), { path: "C:/elsewhere/keys.txt" });

            expect(decision?.permissionDecision).toBe("deny");
            expect(decision?.permissionDecisionReason).toContain("C:/elsewhere/keys.txt");
        });

        it("reads the same roots the permission handler does", async () => {

            expect(await run(hookOf(["C:/other"]), { path: "C:/other/a.ts" })).toBeUndefined();
        });

        it("keeps its own hook when a task supplies one", async () => {

            const config = sessionConfig({ ...BASE, extra: { hooks: { onPreToolUse: () => undefined } } });

            const decision = await config.hooks!.onPreToolUse!(
                { toolName: "read", toolArgs: { path: "C:/elsewhere/keys.txt" } } as never,
                { sessionId: "s_1" });

            expect(decision?.permissionDecision).toBe("deny");
        });
    });

    /*
     * With allow-all mode on, no permission request is raised and the
     * jail goes with it. Disabling it is documented as deny-wins.
     */
    it("locks bypass-permissions mode off", () => {

        expect(sessionConfig(BASE).managedSettings?.permissions?.disableBypassPermissionsMode)
            .toBe("disable");
    });

    it("keeps that lock when a task supplies managed settings of its own", () => {

        const config = sessionConfig({ ...BASE, extra: { managedSettings: { permissions: {} } } });

        expect(config.managedSettings?.permissions?.disableBypassPermissionsMode).toBe("disable");
    });

    it("keeps its own directories when a task tries to add more", () => {

        const config = sessionConfig(
            { ...BASE, extra: { additionalDirectories: ["C:/anywhere"] } },
            ["C:/other"]);

        expect(config.additionalDirectories).toEqual(["C:/other"]);
    });

    it("approves a request that names no path outside the session's directories", () => {

        const config = sessionConfig(BASE);

        expect(config.onPermissionRequest?.({ kind: "read", path: "C:/repo/src/app.ts" } as never, { sessionId: "s_1" }))
            .toEqual({ kind: "approve-once" });
    });

    it("rejects a request that names a path outside them", () => {

        const config = sessionConfig(BASE);

        const decision = config.onPermissionRequest?.(
            { kind: "read", path: "C:/elsewhere/keys.txt" } as never,
            { sessionId: "s_1" }) as { kind: string; feedback?: string };

        expect(decision.kind).toBe("reject");
        expect(decision.feedback).toContain("C:/elsewhere/keys.txt");
    });

    it("rejects a write outside them, which names its file under another key", () => {

        const config = sessionConfig(BASE);

        const decision = config.onPermissionRequest?.(
            { kind: "write", fileName: "C:/elsewhere/keys.txt", diff: "" } as never,
            { sessionId: "s_1" }) as { kind: string };

        expect(decision.kind).toBe("reject");
    });

    it("passes the extra directories through", () => {

        expect(sessionConfig(BASE, ["C:/other"]).additionalDirectories).toEqual(["C:/other"]);
    });

    it("leaves the extra directories unset when none are supplied", () => {

        expect(sessionConfig(BASE).additionalDirectories).toBeUndefined();
    });

    /*
     * MCP servers are machine setup, not workflow definition. A
     * `mcpServers:` block in `extra` is removed at the SDK boundary.
     * The engine's own resolution (the third parameter) and the CLI's
     * discovery files are the only sources.
     */
    it("removes mcpServers even when a task declares it in extra", () => {

        const config = sessionConfig({
            ...BASE,
            extra: { mcpServers: { ado: { command: "npx" } } }
        });

        expect(config.mcpServers).toBeUndefined();
        expect(config.enableConfigDiscovery).toBe(true);
    });

    /* The engine's own servers land after the deletion above. */
    it("sends the servers the engine resolved from settings.json", () => {

        const config = sessionConfig(
            BASE, undefined,
            { servers: { ado: { command: "node.exe" } } });

        expect(config.mcpServers).toMatchObject({ ado: { command: "node.exe" } });
    });

    it("keeps the engine's servers while still removing a task's own", () => {

        const config = sessionConfig(
            { ...BASE, extra: { mcpServers: { smuggled: { command: "evil" } } } },
            undefined,
            { servers: { ado: { command: "node.exe" } } });

        expect(config.mcpServers).toMatchObject({ ado: {} });
        expect((config.mcpServers as Record<string, unknown>).smuggled).toBeUndefined();
    });

    /* The full behaviour is mcpServers.test.ts's; this pins that sessionConfig applies it. */
    it("normalizes the engine's servers before the SDK sees them", () => {

        const config = sessionConfig(
            BASE, undefined,
            { servers: { ado: { command: "npx", args: ["-y"] } } });

        const ado = (config.mcpServers as unknown as Record<string, Record<string, unknown>>).ado;

        if (process.platform === "win32") {

            expect(ado.command).toBe("cmd");
            expect(ado.args).toEqual(["/c", "npx", "-y"]);

        } else {

            expect(ado.command).toBe("npx");
        }

        // `stdio` is accepted by both SDKs; `local` is not.
        expect(ado.type).toBe("stdio");
        expect(ado.tools).toEqual(["*"]);
    });

    /* `mcpServers: undefined` means something to the SDK, so the key is left off. */
    it("leaves mcpServers absent when the engine resolved none", () => {

        expect("mcpServers" in sessionConfig(
            BASE, undefined, { servers: {} }))
            .toBe(false);
        expect("mcpServers" in sessionConfig(BASE)).toBe(false);
    });

    /* Per-server tool choice arrives as the server's own `tools` key, not here. */
    it("leaves a task's excludedTools exactly as written", () => {

        const config = sessionConfig(
            { ...BASE, extra: { excludedTools: ["bash"] } },
            undefined,
            { servers: { ado: { command: "npx" } } });

        expect(config.excludedTools).toEqual(["bash"]);
    });

    it("sends a server's tool allowlist through as its own tools key", () => {

        const config = sessionConfig(
            BASE, undefined,
            { servers: { ado: { command: "npx", tools: ["wit_get_work_item"] } } });

        const ado = (config.mcpServers as unknown as Record<string, Record<string, unknown>>).ado;

        expect(ado.tools).toEqual(["wit_get_work_item"]);
    });
});

/**
 * What gets printed just before the SDK is handed the object. A
 * printout that quietly drops keys hides the bugs it exists to show.
 */
describe("describeOptions", () => {

    it("shows the whole object as sent", () => {

        const printed = describeOptions(sessionConfig({ ...BASE, model: "gpt-5" }, ["C:/other"]));

        expect(JSON.parse(printed)).toMatchObject({
            model: "gpt-5",
            additionalDirectories: ["C:/other"],
            enableConfigDiscovery: true
        });
    });

    /* JSON drops a function along with its key. */
    it("names the handlers instead of dropping them", () => {

        const printed = JSON.parse(describeOptions(sessionConfig(BASE)));

        expect(printed.onPermissionRequest).toBe("[handler]");
        expect(printed.onEvent).toBe("[handler]");
    });

    /* "Absent" and "sent as undefined" are different facts about a session. */
    it("shows a key that was sent as undefined", () => {

        expect(JSON.parse(describeOptions(sessionConfig(BASE))).additionalDirectories)
            .toBe("[unset]");
    });

    it("says so rather than throwing when the object cannot be printed", () => {

        const cyclic: Record<string, unknown> = {};

        cyclic.self = cyclic;

        expect(describeOptions(sessionConfig({ ...BASE, extra: { cyclic } })))
            .toContain("could not be printed");
    });

    /*
     * An in-process MCP server is a live object whose `_`-prefixed
     * fields hold schemas that point back at themselves. A throw there
     * would replace the whole log line with one error string.
     */
    it("skips private fields, so a cycle inside one cannot blank the line", () => {

        const live: Record<string, unknown> = { name: "ask" };

        live._registered = live;

        const printed = JSON.parse(describeOptions(sessionConfig({ ...BASE, extra: { live } })));

        expect(printed.live).toEqual({ name: "ask" });
    });

    /*
     * An MCP server's `env` and `headers` arrive with `${{ env.NAME }}`
     * already expanded, and this line goes into the run log.
     */
    it("never prints an MCP server's expanded env or headers, but keeps the names", () => {

        const secret = "abc123secret";

        const printed = describeOptions(sessionConfig(BASE, undefined, {
            servers: {
                ado: {
                    command: "npx",
                    env: { ADO_MCP_AUTH_TOKEN: secret },
                    headers: { Authorization: `Bearer ${secret}` }
                }
            }
        }));

        expect(printed).not.toContain(secret);

        expect(JSON.parse(printed).mcpServers.ado).toMatchObject({
            env: { ADO_MCP_AUTH_TOKEN: `[redacted, ${secret.length} chars]` },
            headers: { Authorization: `[redacted, ${`Bearer ${secret}`.length} chars]` }
        });
    });
});

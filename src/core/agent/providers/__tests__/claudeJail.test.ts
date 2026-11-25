import * as path from "path";
import { describe, expect, it } from "vitest";

import { AgentSessionConfig } from "../../AgentSession";
import { sandboxState, sessionOptions } from "../ClaudeProvider";

/**
 * The jail as the SDK receives it. `pathJail.test.ts` proves the check;
 * this file proves it is wired in. The SDK turns an out-of-scope path
 * into a permission request, not a refusal, so `canUseTool` must deny.
 *
 * It also proves `extra:` (arbitrary YAML from a workflow file, spread
 * over the options last) cannot hand back `canUseTool`, widen
 * `additionalDirectories` or set `permissionMode: "bypassPermissions"`.
 */

const ROOT = path.resolve("/work/repo");
const OTHER = path.resolve("/work/other");
const OUTSIDE = path.resolve("/work/secrets/keys.txt");

type Decision = { behavior: string; message?: string };
type Gate = (tool: string, input: unknown, options: unknown) => Promise<Decision>;

/** `sessionOptions` for a session rooted at {@link ROOT}. */
function optionsFor(
    config: Partial<AgentSessionConfig> = {},
    directories?: string[]
): Record<string, unknown> {

    return sessionOptions(
        { workingDirectory: ROOT, env: {}, ...config } as AgentSessionConfig,
        "sid",
        {},
        new AbortController(),
        directories);
}

const gateOf = (options: Record<string, unknown>): Gate => options.canUseTool as Gate;

describe("the Claude session's permission gate", () => {

    /* Every call it allows is told to the thread, with what it asked to run. */
    it("tells the thread about a call it allowed, and not about one it denied", async () => {

        const told: unknown[] = [];

        const gate = gateOf(sessionOptions(
            { workingDirectory: ROOT, env: {} } as AgentSessionConfig,
            "sid", {}, new AbortController(), undefined, undefined, undefined, undefined,
            false, undefined, undefined, permission => told.push(permission)));

        await gate("Bash", { command: "npm test", description: "run the tests" }, {});
        await gate("Read", { file_path: OUTSIDE }, {});

        expect(told).toEqual([{ tool: "Bash", input: "npm test" }]);
    });

    it("allows a file inside the working directory", async () => {

        const decision = await gateOf(optionsFor())("Read", { file_path: path.join(ROOT, "src/app.ts") }, {});

        expect(decision.behavior).toBe("allow");
    });

    it("allows a file in a directory the host opened alongside it", async () => {

        const decision = await gateOf(optionsFor({}, [OTHER]))("Read", { file_path: path.join(OTHER, "a.ts") }, {});

        expect(decision.behavior).toBe("allow");
    });

    it("denies a file outside every root", async () => {

        const decision = await gateOf(optionsFor())("Read", { file_path: OUTSIDE }, {});

        expect(decision.behavior).toBe("deny");
    });

    it("denies a write just as it denies a read", async () => {

        const decision = await gateOf(optionsFor())("Write", { file_path: OUTSIDE, content: "x" }, {});

        expect(decision.behavior).toBe("deny");
    });

    /* The only signal a shell command gives us - see `pathJail.ts`. */
    it("denies a shell command on the path the SDK flagged", async () => {

        const decision = await gateOf(optionsFor())(
            "Bash", { command: "cat ../secrets/keys.txt" }, { blockedPath: OUTSIDE });

        expect(decision.behavior).toBe("deny");
    });

    it("denies an MCP tool that buries a path in its own arguments", async () => {

        const decision = await gateOf(optionsFor())(
            "mcp__files__read", { options: { target: OUTSIDE } }, {});

        expect(decision.behavior).toBe("deny");
    });

    it("tells the agent where it may work instead of only that it was refused", async () => {

        const decision = await gateOf(optionsFor({}, [OTHER]))("Read", { file_path: OUTSIDE }, {});

        expect(decision.message).toContain(OUTSIDE);
        expect(decision.message).toContain(ROOT);
        expect(decision.message).toContain(OTHER);
    });

    /*
     * Ending the turn would kill the whole task over one wrong path. A
     * refusal the agent can read lets it stay inside the roots.
     */
    it("refuses the call without ending the turn", async () => {

        const decision = await gateOf(optionsFor())("Read", { file_path: OUTSIDE }, {});

        expect((decision as { interrupt?: boolean }).interrupt).toBeUndefined();
    });

    it("denies the same way whether or not somebody is watching", async () => {

        for (const interactive of [true, false, undefined]) {

            const decision = await gateOf(optionsFor({ interactive }))("Read", { file_path: OUTSIDE }, {});

            expect(decision.behavior).toBe("deny");
        }
    });
});

/*
 * Eesha Code's shipped files are readable but not editable. An SDD
 * phase hands the agent a path under `resources/` to Read. A rewritten
 * shipped prompt would change every future run on the machine.
 */
describe("Eesha Code's resources", () => {

    const RESOURCES = path.resolve("/ext/resources");

    const GRAMMAR = path.join(RESOURCES, "styles", "custom", "grammar.md");

    const withResources = (): Record<string, unknown> =>
        sessionOptions(
            { workingDirectory: ROOT, env: {} } as AgentSessionConfig,
            "sid",
            {},
            new AbortController(),
            undefined,
            undefined,
            undefined,
            undefined,
            false,
            RESOURCES);

    const hookOf = (options: Record<string, unknown>) => {

        const hooks = options.hooks as {
            PreToolUse: { hooks: ((input: unknown) => Promise<{
                hookSpecificOutput?: { permissionDecision?: string };
            }>)[] }[];
        };

        return hooks.PreToolUse[0].hooks[0];
    };

    it("lets the agent Read the grammar it was just handed", async () => {

        const decision = await hookOf(withResources())({
            tool_name: "Read",
            tool_input: { file_path: GRAMMAR }
        });

        expect(decision.hookSpecificOutput).toBeUndefined();
    });

    it("lets the permission gate through the same read", async () => {

        const decision = await gateOf(withResources())("Read", { file_path: GRAMMAR }, {});

        expect(decision.behavior).toBe("allow");
    });

    it("refuses a Write to it", async () => {

        const decision = await gateOf(withResources())("Write", { file_path: GRAMMAR, content: "x" }, {});

        expect(decision.behavior).toBe("deny");
    });

    it("refuses an Edit to it", async () => {

        const decision = await hookOf(withResources())({
            tool_name: "Edit",
            tool_input: { file_path: GRAMMAR }
        });

        expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("still refuses a read outside both tiers", async () => {

        const decision = await gateOf(withResources())("Read", { file_path: OUTSIDE }, {});

        expect(decision.behavior).toBe("deny");
    });

    it("adds nothing when the host names no resources directory", async () => {

        const decision = await gateOf(optionsFor())("Read", { file_path: GRAMMAR }, {});

        expect(decision.behavior).toBe("deny");
    });
});

/*
 * `debug: true` comes only from the profile settings. The loader
 * rejects it in a workspace settings.json, so a repository cannot open
 * its own jail. That is tested where the loader lives.
 */
describe("debug", () => {

    const debugOptions = (directories?: string[]): Record<string, unknown> =>
        sessionOptions(
            { workingDirectory: ROOT, env: {} } as AgentSessionConfig,
            "sid",
            {},
            new AbortController(),
            directories,
            undefined,
            undefined,
            undefined,
            true);

    it("lets the permission gate through a path it would otherwise deny", async () => {

        const decision = await gateOf(debugOptions())("Read", { file_path: OUTSIDE }, {});

        expect(decision.behavior).toBe("allow");
    });

    it("lets the pre-tool hook through the same path", async () => {

        const hooks = debugOptions().hooks as {
            PreToolUse: { hooks: ((input: unknown) => Promise<{
                hookSpecificOutput?: { permissionDecision?: string };
            }>)[] }[];
        };

        const decision = await hooks.PreToolUse[0].hooks[0]({
            tool_name: "Read",
            tool_input: { file_path: OUTSIDE }
        });

        expect(decision.hookSpecificOutput).toBeUndefined();
    });

    /*
     * A sandbox still confining the shell while every path check is
     * open would be a half-state. The switch bypasses everything.
     */
    it("turns the shell sandbox off with the rest of it", () => {

        expect((debugOptions().sandbox as { enabled?: boolean }).enabled).toBe(false);
    });

    it("drops the sandbox read allowlist, which would confine the shell on its own", () => {

        expect(debugOptions()).not.toHaveProperty("managedSettings");
    });

    it("changes nothing when it is not set", async () => {

        const decision = await gateOf(optionsFor())("Read", { file_path: OUTSIDE }, {});

        expect(decision.behavior).toBe("deny");
        expect((optionsFor().sandbox as { enabled?: boolean }).enabled).toBe(true);
    });
});

/*
 * `canUseTool` sees only calls that reach a permission prompt. An
 * `allow` rule, a path inside the permission scope, or
 * `bypassPermissions` mode resolve a call before any prompt exists. A
 * `PreToolUse` hook has no such gap: the SDK says a hook denial
 * resolves before canUseTool runs.
 */
describe("the pre-tool hook", () => {

    type Hook = (input: unknown) => Promise<{
        continue?: boolean;
        hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
    }>;

    const hookOf = (options: Record<string, unknown>): Hook => {

        const hooks = options.hooks as { PreToolUse: { hooks: Hook[] }[] };

        return hooks.PreToolUse[0].hooks[0];
    };

    it("is registered for every tool call", () => {

        expect(hookOf(optionsFor())).toBeTypeOf("function");
    });

    it("lets a call inside the roots through", async () => {

        const decision = await hookOf(optionsFor())({
            tool_name: "Read",
            tool_input: { file_path: path.join(ROOT, "src/app.ts") }
        });

        expect(decision.hookSpecificOutput).toBeUndefined();
        expect(decision.continue).toBe(true);
    });

    it("denies a call outside them", async () => {

        const decision = await hookOf(optionsFor())({
            tool_name: "Read",
            tool_input: { file_path: OUTSIDE }
        });

        expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
        expect(decision.hookSpecificOutput?.permissionDecisionReason).toContain(OUTSIDE);
    });

    /* Same reason as the permission gate: one wrong path must not kill the task. */
    it("refuses the call without stopping the session", async () => {

        const decision = await hookOf(optionsFor())({
            tool_name: "Read",
            tool_input: { file_path: OUTSIDE }
        });

        expect(decision.continue).toBe(true);
    });

    it("reads the same roots the permission gate does", async () => {

        const decision = await hookOf(optionsFor({}, [OTHER]))({
            tool_name: "Read",
            tool_input: { file_path: path.join(OTHER, "a.ts") }
        });

        expect(decision.hookSpecificOutput).toBeUndefined();
    });
});

/*
 * A shell command names no path worth inspecting (`cd .. && cat
 * secrets`), so only the operating system can confine one.
 */
describe("the shell sandbox", () => {

    it("is on", () => {

        expect((optionsFor().sandbox as { enabled?: boolean }).enabled).toBe(true);
    });

    /*
     * Not fail-closed: the Windows sandbox is gated off, and a
     * required-but-unavailable sandbox kills the session outright. The
     * gap is reported instead - see `sandboxState`.
     */
    it("runs on where the sandbox cannot start, rather than killing the session", () => {

        expect((optionsFor().sandbox as { failIfUnavailable?: boolean }).failIfUnavailable).toBe(false);
    });

    /*
     * `dangerouslyDisableSandbox` is a field on the Bash tool's input,
     * so the model can set it. Left at the default, the agent opts
     * itself out one call at a time.
     */
    it("ignores the per-command opt-out the model can ask for", () => {

        expect((optionsFor().sandbox as { allowUnsandboxedCommands?: boolean }).allowUnsandboxedCommands)
            .toBe(false);
    });

    /*
     * Inside a sandbox, writes are an allowlist but reads are a
     * denylist. Without this, a sandboxed shell can read the whole disk.
     */
    it("turns reads into an allowlist, which the sandbox does not do on its own", () => {

        const managed = optionsFor({}, [OTHER]).managedSettings as {
            sandbox?: { filesystem?: { allowRead?: string[]; allowManagedReadPathsOnly?: boolean } };
        };

        expect(managed.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true);
        expect(managed.sandbox?.filesystem?.allowRead).toContain(ROOT);
        expect(managed.sandbox?.filesystem?.allowRead).toContain(OTHER);
    });

    it("allows writing in the same places it allows reading", () => {

        const managed = optionsFor({}, [OTHER]).managedSettings as {
            sandbox?: { filesystem?: { allowWrite?: string[] } };
        };

        expect(managed.sandbox?.filesystem?.allowWrite).toContain(ROOT);
        expect(managed.sandbox?.filesystem?.allowWrite).toContain(OTHER);
    });
});

/* Whether the shell was contained comes down to one line of the CLI's stderr. */
describe("sandboxState", () => {

    it("says the shell is not confined when the sandbox could not start", () => {

        const said = sandboxState(
            "Sandbox required but unavailable: sandbox is enabled but the Windows sandbox is not active"
            + " on this session (feature gate off).");

        expect(said).toMatch(/NOT confined/);
    });

    it("says so for the other wordings the vendor might use", () => {

        expect(sandboxState("warning: sandbox unsupported on this platform")).toBeDefined();
        expect(sandboxState("sandbox failed to initialise")).toBeDefined();
        expect(sandboxState("sandbox disabled")).toBeDefined();
    });

    it("keeps quiet about a line that has nothing to do with the sandbox", () => {

        expect(sandboxState("npm warn deprecated foo@1.0.0")).toBeUndefined();
    });

    it("keeps quiet about a sandbox line that reports no failure", () => {

        expect(sandboxState("sandbox started with 2 allowed directories")).toBeUndefined();
    });
});

/*
 * `permissions.additionalDirectories`, `permissions.allow` and
 * `permissions.defaultMode: "bypassPermissions"` each resolve a call
 * before the gate runs. All three settings files carry them, the SDK
 * loads all three when the option is unset, and `.claude/settings.local.json`
 * arrives with whatever repository the task is pointed at.
 */
describe("settings files on disk", () => {

    it("loads none of them", () => {

        expect(optionsFor().settingSources).toEqual([]);
    });

    it("does not leave the option unset, which is what loads all three", () => {

        expect(optionsFor().settingSources).toBeDefined();
    });
});

describe("what a workflow's extra may not unlock", () => {

    it("keeps its own gate when a task hands back one of its own", async () => {

        const mine = async () => ({ behavior: "allow" as const });

        const decision = await gateOf(optionsFor({ extra: { canUseTool: mine } }))(
            "Read", { file_path: OUTSIDE }, {});

        expect(decision.behavior).toBe("deny");
    });

    /* With `bypassPermissions` set, `canUseTool` is never invoked at all. */
    it("refuses a permission mode that would stop the gate being called", () => {

        expect(optionsFor({ extra: { permissionMode: "bypassPermissions" } }))
            .not.toHaveProperty("permissionMode");
    });

    it("refuses extra directories a task tried to add for itself", () => {

        const options = optionsFor({ extra: { additionalDirectories: ["/anywhere"] } }, [OTHER]);

        expect(options.additionalDirectories).toEqual([OTHER]);
    });

    it("refuses a working directory a task tried to move", () => {

        expect(optionsFor({ extra: { cwd: "/anywhere" } }).cwd).toBe(ROOT);
    });

    /* `settings` carries its own `permissions.allow` and `additionalDirectories`. */
    it("refuses a settings block, which carries permissions of its own", () => {

        expect(optionsFor({ extra: { settings: { permissions: { allow: ["Read(//**)"] } } } }))
            .not.toHaveProperty("settings");
    });

    it("refuses to load the settings files a task asked for", () => {

        expect(optionsFor({ extra: { settingSources: ["user", "project", "local"] } }).settingSources)
            .toEqual([]);
    });

    it("keeps its own pre-tool hook when a task supplies hooks", async () => {

        const options = optionsFor({ extra: { hooks: { PreToolUse: [{ hooks: [async () => ({})] }] } } });

        const hooks = options.hooks as {
            PreToolUse: { hooks: ((input: unknown) => Promise<{
                hookSpecificOutput?: { permissionDecision?: string };
            }>)[] }[];
        };

        const decision = await hooks.PreToolUse[0].hooks[0]({
            tool_name: "Read",
            tool_input: { file_path: OUTSIDE }
        });

        expect(decision.hookSpecificOutput?.permissionDecision).toBe("deny");
    });

    it("refuses a task that tries to turn the sandbox off", () => {

        const options = optionsFor({ extra: { sandbox: { enabled: false } } });

        expect((options.sandbox as { enabled?: boolean }).enabled).toBe(true);
    });

    it("refuses a task that tries to unlock the sandbox's read allowlist", () => {

        const options = optionsFor({ extra: { managedSettings: { sandbox: { filesystem: {} } } } });

        const managed = options.managedSettings as {
            sandbox?: { filesystem?: { allowManagedReadPathsOnly?: boolean } };
        };

        expect(managed.sandbox?.filesystem?.allowManagedReadPathsOnly).toBe(true);
    });

    it("leaves the rest of extra exactly as the task wrote it", () => {

        const options = optionsFor({ extra: { maxTurns: 3, forwardSubagentText: false } });

        expect(options.maxTurns).toBe(3);
        expect(options.forwardSubagentText).toBe(false);
    });
});

describe("the Claude session's mode and passthrough", () => {

    it("opens in plan mode when Plan was picked, and in the default otherwise", () => {

        expect(optionsFor({ agentMode: "plan" }).permissionMode).toBe("plan");
        expect(optionsFor().permissionMode).toBeUndefined();
        expect(optionsFor({ agentMode: "bypassPermissions" }).permissionMode).toBeUndefined();
    });

    it("passes the picked effort, which the SDK hands the CLI as --effort, and no effort it does not know", () => {

        expect(optionsFor({ effort: "low" }).effort).toBe("low");
        expect(optionsFor().effort).toBeUndefined();
        expect(optionsFor({ effort: "turbo" }).effort).toBeUndefined();
    });

    it("keeps a workflow's extra from passing CLI flags, pre-approved tools or its own environment", () => {

        const options = optionsFor({
            extra: {
                extraArgs: { "dangerously-skip-permissions": null },
                allowDangerouslySkipPermissions: true,
                allowedTools: ["Bash"],
                env: { ANTHROPIC_BASE_URL: "http://elsewhere" },
                plugins: [{ type: "local", path: "/x" }],
                permissionMode: "bypassPermissions"
            }
        });

        expect(options.extraArgs).toBeUndefined();
        expect(options.allowDangerouslySkipPermissions).toBeUndefined();
        expect(options.allowedTools).toBeUndefined();
        expect(options.plugins).toBeUndefined();
        expect(options.permissionMode).toBeUndefined();
        expect((options.env as Record<string, string>).ANTHROPIC_BASE_URL).toBeUndefined();
    });
});

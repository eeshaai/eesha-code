import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";
import manifest from "../plugin.json";
import { createExecute } from "../index";
import { AgentProvider, AgentProviders } from "../../AgentProvider";
import { AgentSessions } from "../../AgentSessions";
import { AgentEvent, AgentMessage, AgentSession, AgentSessionConfig, isMutatingTool } from "../../AgentSession";
import { LogMeta } from "../../../models/run";
import { Plugin, PluginContext } from "../../../plugins/Plugin";
import { PluginManifest, pluginFromManifest } from "../../../plugins/PluginManifest";

/**
 * Driven entirely through a fake provider: no CLI, no auth, no network.
 * The fake is registered under the same id the real provider uses, so
 * the real one is never built and its module never loads.
 */

const agent = (provider: AgentProvider, sessions = new AgentSessions()): Plugin =>
    agentWith({ ghcp: provider }, sessions);

/** The same plugin over a whole registry, for tests about which provider a task reached. */
const agentWith = (
    registered: Record<string, AgentProvider>,
    sessions = new AgentSessions()
): Plugin => {

    const providers = new AgentProviders();

    for (const [id, provider] of Object.entries(registered))
        providers.register(id, () => provider);

    return pluginFromManifest(
        manifest as PluginManifest,
        createExecute({ providers, sessions, provider: "ghcp", maxHoldMs: 50, steeringOn: async () => true }) as never,
        "aiV1");
};

/** What the fake was asked for - the session's config and the message, in one place. */
type Seen = AgentSessionConfig & AgentMessage & {

    /** True when the caller waited for the turn; a detached task does not. */
    waited: boolean;

    /** The backstop handed to `sendAndWait` - `null` for no limit, undefined for the provider default. */
    timeoutMs?: number | null;
};

/**
 * Records what the plugin asked for, and answers with whatever the test
 * wants. `summary` and `files` are emitted as events, since deciding
 * that a mutating tool call means "a file changed" is the task's job.
 */
function runtime(
    result: { summary?: string; files?: string[]; sessionId?: string } = {},
    emit?: (publish: (event: AgentEvent) => void) => void
) {

    const seen: Seen[] = [];

    /** How each session was let go - "dispose" or "delete", in order. */
    const ended: string[] = [];

    const handlers = new Set<(event: AgentEvent) => void>();

    const publish = (event: AgentEvent) => {

        for (const handler of [...handlers])
            handler(event);
    };

    const turn = (message: AgentMessage, waited: boolean, config: AgentSessionConfig, timeoutMs?: number | null) => {

        seen.push({ ...config, ...message, waited, timeoutMs });

        emit?.(publish);

        if (!waited)
            return;

        for (const file of result.files ?? [])
            publish({
                kind: "tool.start", name: "tool.execution_start",
                tool: "write_file", path: file, detail: file, raw: {}
            });

        publish({ kind: "message", name: "assistant.message", text: result.summary ?? "done", raw: {} });
    };

    const session = (config: AgentSessionConfig): AgentSession => ({
        id: result.sessionId ?? "session-1",
        status: "idle",
        send: async message => turn(message, false, config),
        sendAndWait: async (message, timeoutMs) => turn(message, true, config, timeoutMs),
        abort: async () => undefined,
        dispose: async () => { ended.push("dispose"); },
        delete: async () => { ended.push("delete"); },
        on: handler => {

            handlers.add(handler);

            return () => handlers.delete(handler);
        }
    });

    const fake: AgentProvider = {
        createSession: async config => session(config)
    };

    return { fake, seen, publish, ended };
}

function failing(message: string): AgentProvider {

    return {
        createSession: async () => { throw new Error(message); }
    };
}

function context(overrides: Partial<PluginContext> = {}) {

    const logs: string[] = [];

    // The plugin labels lines with a kind rather than writing it into
    // the text, so the text alone cannot tell prose from a tool call.
    const labelled: { text: string; kind?: string }[] = [];

    // The whole label, for the fields `labelled` does not keep.
    // `labelled` entries are compared whole with `toContainEqual`, so
    // it cannot grow a field without breaking those.
    const meta: { text: string; meta?: LogMeta }[] = [];

    const ctx: PluginContext = {
        runId: "run-1",
        taskId: "release/draft/0",
        attempt: 1,
        cwd: "C:/work/repo",
        root: "C:/work/repo",
        env: { BUILD: "Release" },
        secret: () => undefined,
        log: (text, _stream, lineMeta) => {
            logs.push(text);
            labelled.push({ text, kind: lineMeta?.kind });
            meta.push({ text, meta: lineMeta });
        },
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined,
        ...overrides
    };

    return { ctx, logs, labelled, meta };
}

describe("ai@1", () => {

    it("runs the agent where the task runs, not where the workspace folder is", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Draft the spec." }, context({ cwd: "C:/work/repo/packages/api" }).ctx);

        expect(seen[0].workingDirectory).toBe("C:/work/repo/packages/api");
        expect(seen[0].prompt).toBe("Draft the spec.");
    });

    it("passes the model through untouched", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", model: "gpt-5" }, context().ctx);

        expect(seen[0].model).toBe("gpt-5");
    });

    // The tool policy is the provider's own vocabulary, so it rides
    // `extra` verbatim.
    it("carries the tool policy under the provider's own names", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", availableTools: ["builtin:*"], excludedTools: ["bash"] },
            context().ctx);

        expect(seen[0].extra).toEqual({
            availableTools: ["builtin:*"],
            excludedTools: ["bash"]
        });
    });

    it("hands args it does not recognise to the provider", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", model: "gpt-5", contextTier: "long_context", streaming: true },
            context().ctx);

        expect(seen[0].extra).toEqual({ contextTier: "long_context", streaming: true });
    });

    // Resolved before the plugin runs. Passed on, every runtime's
    // options would reach this one.
    it("refuses a providers: block that reached it unresolved", async () => {

        const { fake, seen } = runtime();

        const result = await agent(fake).execute(
            { prompt: "Go.", providers: { ghcp: { reasoningSummary: "concise" } } },
            context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("'providers' reached ai@1 unresolved");
        expect(seen).toHaveLength(0);
    });

    // Undefined rather than `{}`, so a provider can tell "nothing was
    // passed" from "an empty map was".
    it("passes no extra at all when every arg is one it declares", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", model: "gpt-5" }, context().ctx);

        expect(seen[0].extra).toBeUndefined();
    });

    // No restriction by default: gates are the workflow author's
    // decision, not this plugin's.
    it("narrows nothing when the task says nothing", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(seen[0].extra).toBeUndefined();
    });

    it("hands the task's resolved env to the session", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(seen[0].env).toEqual({ BUILD: "Release" });
    });

});

describe("choosing a provider", () => {

    it("runs on the provider the task names", async () => {

        const ghcp = runtime();
        const other = runtime();

        await agentWith({ ghcp: ghcp.fake, acme: other.fake })
            .execute({ prompt: "Go.", provider: "acme" }, context().ctx);

        expect(other.seen).toHaveLength(1);
        expect(ghcp.seen).toHaveLength(0);
    });

    // Two answers for "the task named none": the manifest default (the
    // host fills it in before `execute`) and `deps.provider` (what a
    // direct caller gets). Both are asserted.
    it("declares ghcp as the manifest default", () => {

        expect(manifest.args.find(arg => arg.name === "provider")?.default).toBe("ghcp");
    });

    it("falls back to the host's provider when the task names none", async () => {

        const ghcp = runtime();
        const other = runtime();

        await agentWith({ ghcp: ghcp.fake, acme: other.fake })
            .execute({ prompt: "Go." }, context().ctx);

        expect(ghcp.seen).toHaveLength(1);
        expect(other.seen).toHaveLength(0);
    });

    // An unknown name fails before a session starts, never silently
    // swaps to the default.
    it("fails with the registered ids when the name is not one of them", async () => {

        const result = await agent(runtime().fake)
            .execute({ prompt: "Go.", provider: "claude" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("claude");
        expect(result.message).toContain("ghcp");
    });

    it("does not print the provider itself - the host's args block already does", async () => {

        const ctx = context();

        await agentWith({ acme: runtime().fake })
            .execute({ prompt: "Go.", provider: "acme" }, ctx.ctx);

        expect(ctx.logs.join("\n")).not.toContain("provider : acme");
    });

});


/** Chat histories name a session by its opening text, so the title leads. */
describe("session title", () => {

    it("sends the title as the prompt's first line, ahead of the context", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Draft it.", title: "my-feature: draft requirements", context: { brief: "# brief" } },
            context().ctx);

        expect(seen[0].prompt.startsWith("my-feature: draft requirements\n\n")).toBe(true);
        expect(seen[0].prompt.indexOf("=== DOCUMENT")).toBeGreaterThan(0);
    });

    it("sends the prompt untouched when no title is given", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Draft it." }, context().ctx);

        expect(seen[0].prompt).toBe("Draft it.");
    });
});

/**
 * A rerun hands back the already-composed message from the AI Session
 * tab. `verbatim` stops the title, documents and target instruction
 * being composed around it a second time.
 */
describe("verbatim", () => {

    it("sends the prompt exactly as given, composing nothing around it", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            {
                prompt: "The whole message, as edited.",
                verbatim: true,
                title: "my-feature: draft requirements",
                context: { brief: "# brief" },
                target: "specs/requirements.md"
            },
            context().ctx);

        expect(seen[0].prompt).toBe("The whole message, as edited.");
    });

    it("still opens the attachments - they are files, not text in the prompt", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            {
                prompt: "The whole message, as edited.",
                verbatim: true,
                attachments: [{ name: "draft", path: "C:/work/repo/instructions/draft.md" }]
            },
            context().ctx);

        expect(seen[0].prompt).toBe("The whole message, as edited.");
        expect(seen[0].attachments).toEqual([{ name: "draft", path: "C:/work/repo/instructions/draft.md" }]);
    });

    it("composes as usual when it is off", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Draft it.", title: "my-feature: draft requirements" },
            context().ctx);

        expect(seen[0].prompt).toBe("my-feature: draft requirements\n\nDraft it.");
    });

    // The prompt line is what a surface draws as the person's turn, so
    // it must be the text actually sent, not a composed copy.
    it("logs the message it sent", async () => {

        const { fake } = runtime();
        const { ctx, labelled } = context();

        await agent(fake).execute(
            { prompt: "The whole message, as edited.", verbatim: true, title: "ignored" },
            ctx);

        expect(labelled.filter(line => line.kind === "prompt").map(line => line.text))
            .toEqual(["The whole message, as edited."]);
    });

    // A chat gone back to an earlier message sends a note in front of
    // what was typed. The thread shows what was typed.
    it("logs `shown` instead of the text sent, and sends the text", async () => {

        const { fake, seen } = runtime();
        const { ctx, labelled } = context();

        const sent = "## Earlier in this chat\n\n## My message\n\nUse 9090.";

        await agent(fake).execute({ prompt: sent, verbatim: true, shown: "Use 9090." }, ctx);

        expect(seen[0].prompt).toBe(sent);
        expect(labelled.filter(line => line.kind === "prompt").map(line => line.text)).toEqual(["Use 9090."]);
        expect(seen[0]).not.toHaveProperty("shown");
    });

    it("ignores `shown` on a composed send", async () => {

        const { fake } = runtime();
        const { ctx, labelled } = context();

        await agent(fake).execute({ prompt: "Draft it.", shown: "Something else." }, ctx);

        expect(labelled.filter(line => line.kind === "prompt").map(line => line.text)).toEqual(["Draft it."]);
    });
});

describe("what it reports", () => {

    it("returns the agent's closing message as 'summary'", async () => {

        const { fake } = runtime({ summary: "Wrote the requirements." });

        const result = await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(result.success).toBe(true);
        expect(result.artifacts).toEqual({ summary: "Wrote the requirements.", files: [] });
    });

    it("returns the files it touched, so a gate can point at them", async () => {

        const { fake } = runtime({ files: ["docs/spec.md", "src/api.ts"] });

        const result = await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(result.artifacts!.files).toEqual(["docs/spec.md", "src/api.ts"]);
    });

    it("logs the changed files, and says so plainly when there are none", async () => {

        const quiet = context();

        await agent(runtime({ files: [] }).fake).execute({ prompt: "Go." }, quiet.ctx);

        expect(quiet.logs.join("\n")).toContain("No files were changed.");

        const busy = context();

        await agent(runtime({ files: ["a.md", "b.md"] }).fake).execute({ prompt: "Go." }, busy.ctx);

        expect(busy.logs.join("\n")).toContain("Changed 2 file(s)");
        expect(busy.logs.join("\n")).toContain("a.md");
    });

    it("streams the agent's prose into the task's log as it arrives", async () => {

        const { fake } = runtime({}, publish => {

            publish({ kind: "message", name: "assistant.message", text: "Reading the repo...", raw: {} });

            publish({
                kind: "tool.start", name: "tool.execution_start",
                tool: "write_file", detail: "docs/spec.md", path: "docs/spec.md", raw: {}
            });
        });

        const { ctx, logs, labelled } = context();

        await agent(fake).execute({ prompt: "Go." }, ctx);

        // The text without a marker in it, and the kind beside it.
        expect(labelled).toContainEqual({ text: "Reading the repo...", kind: "message" });

        expect(logs.some(line => line.includes("write_file") && line.includes("docs/spec.md"))).toBe(true);

        expect(labelled.find(line => line.text.includes("write_file"))?.kind).toBe("tool.start");

        // The turn that was sent, labelled the same way.
        expect(labelled).toContainEqual({ text: "Go.", kind: "prompt" });
    });

});

/**
 * The provider's own session id, reported so a surface can offer to
 * reopen the conversation that wrote a document.
 */
describe("the session it held", () => {

    it("reports the session id as soon as the provider opens it, not at the end", async () => {

        const reported: string[] = [];

        const { fake } = runtime({ sessionId: "sess-abc-123" });

        const { ctx, logs } = context({ reportSession: id => reported.push(id) });

        await agent(fake).execute({ prompt: "Go." }, ctx);

        expect(reported).toEqual(["sess-abc-123"]);
        expect(logs.join("\n")).toContain("sess-abc-123");
    });

    it("also returns it, so a task that missed the live report still records it", async () => {

        const result = await agent(runtime({ sessionId: "sess-abc-123" }).fake)
            .execute({ prompt: "Go." }, context().ctx);

        expect(result.session).toEqual({ id: "sess-abc-123" });
    });

    // A session has an id from the moment it exists, so every path that
    // has a session has a handle to it.
    it("carries the id on a failed task too, which is the conversation most worth reopening", async () => {

        const { fake } = runtime({ sessionId: "sess-abc-123" });

        const result = await agent(fake).execute(
            { prompt: "Go.", target: "never-written.md" },
            context({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ghcp-target-")) }).ctx);

        expect(result.success).toBe(false);
        expect(result.session).toEqual({ id: "sess-abc-123" });
    });
});

describe("when things go wrong", () => {

    it("fails the task with the reason rather than throwing", async () => {

        const result = await agent(failing("Copilot CLI is not signed in.")).execute(
            { prompt: "Go." }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Copilot CLI is not signed in.");
    });

    // A network timeout's diagnosis lives in the error's properties and
    // cause chain.
    it("prints the full error - properties, stack, and cause chain - into the log", async () => {

        const inner = Object.assign(new Error("operation timed out"), { code: "ETIMEDOUT" });
        const outer = new Error("error sending request for url (https://api.example/models)", { cause: inner });

        const { ctx, logs } = context();

        await agent({ createSession: async () => { throw outer; } }).execute({ prompt: "Go." }, ctx);

        const detail = logs.join("\n");

        expect(detail).toContain("error sending request");
        expect(detail).toContain("Caused by:");
        expect(detail).toContain("operation timed out");
        expect(detail).toContain("ETIMEDOUT");
        expect(detail).toContain("at "); // a stack frame
    });

    it("keeps the log quiet about the error when the run was deliberately stopped", async () => {

        const { ctx, logs } = context({ cancelled: true });

        await agent(failing("aborted")).execute({ prompt: "Go." }, ctx);

        expect(logs.join("\n")).not.toContain("aborted");
    });

    it("says it was cancelled when the run was stopped, not that the agent failed", async () => {

        const result = await agent(failing("aborted")).execute(
            { prompt: "Go." }, context({ cancelled: true }).ctx);

        expect(result.success).toBe(false);
        expect(result.message).toBe("Cancelled before the agent finished.");
    });

    it("gives the runtime a signal that is already aborted if the run was stopped first", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context({ cancelled: true }).ctx);

        expect(seen[0].signal?.aborted).toBe(true);
    });

    // Proves the chain from session config back to the host's masker
    // is connected.
    it("routes a provider's registerSecret to the host's masker", async () => {

        const masked: string[] = [];

        const provider: AgentProvider = {
            createSession: async config => {

                config.registerSecret?.("pat-value");

                throw new Error("stop here - the registration already happened");
            }
        };

        await agent(provider).execute(
            { prompt: "Go." },
            context({ registerSecret: value => masked.push(value) }).ctx);

        expect(masked).toEqual(["pat-value"]);
    });

    it("aborts the signal when the run is stopped mid-session", async () => {

        const { fake, seen } = runtime();

        let stop = () => undefined as void;

        await agent(fake).execute({ prompt: "Go." }, context({ onCancel: handler => { stop = handler; } }).ctx);

        expect(seen[0].signal?.aborted).toBe(false);

        stop();

        expect(seen[0].signal?.aborted).toBe(true);
    });

});

describe("the id carries the guarantee", () => {

    it("resolves as ai@1", () => {

        const plugin = agent(runtime().fake);

        expect(plugin.id).toBe("ai");
        expect(plugin.version).toBe("1");
    });

    it("declares no secrets - a provider gets its credential from the host, never from the task", () => {

        expect(agent(runtime().fake).secrets).toBeUndefined();
    });

    // Only what the engine does with a session. Everything a session
    // can be told is the provider's vocabulary and travels as `extra`.
    // `allowedEnv` and `mcp` are the engine's own decisions: an env
    // gate, and a selection among settings.json's servers.
    it("takes a provider, a prompt, documents inline or attached, a target and a title", () => {

        expect(Object.keys(agent(runtime().fake).args!).sort())
            .toEqual([
                "allowedEnv", "attachments", "checkPlan", "cleanup", "context", "continueSession", "detach",
                "files", "interactive", "keep", "mcp", "model", "plan", "prompt", "provider", "refuseWrites",
                "systemInstructions", "target", "title", "verbatim"
            ]);
    });

    it("hands the mcp selection to the provider as its own field, not as extra", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", mcp: { servers: ["ado"], tools: { ado: ["wit_get_work_item"] } } },
            context().ctx);

        expect(seen[0].mcp).toEqual({ servers: ["ado"], tools: { ado: ["wit_get_work_item"] } });
        expect(seen[0].extra).toBeUndefined();
    });

    it("passes no mcp selection when the task says nothing - every server", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(seen[0].mcp).toBeUndefined();
    });

    // A wrong shape must never quietly select nothing, or everything.
    it("fails a malformed mcp selection before any session starts", async () => {

        const { fake, seen } = runtime();

        const result = await agent(fake).execute({ prompt: "Go.", mcp: ["ado"] }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("'mcp' must be an object");
        expect(seen).toHaveLength(0);
    });

    it("accepts args it does not declare, since the provider's surface is not ours", () => {

        expect(agent(runtime().fake).passthrough).toBe(true);
    });

});

/**
 * "Files changed" must mean changed. Read tools carry paths too, and
 * counting them over-reported.
 */
describe("which tools count as changing files", () => {

    it("counts writers", () => {

        for (const name of ["create", "edit", "write_file", "str_replace_editor", "apply_patch", "delete_file"])
            expect(isMutatingTool(name), name).toBe(true);
    });

    it("does not count readers", () => {

        for (const name of ["view", "read_file", "glob", "grep", "list_directory", "powershell", "bash", "search"])
            expect(isMutatingTool(name), name).toBe(false);
    });

    /* A titled call is judged by its verb; the file name or free text after it says nothing. */
    it("reads a titled call by its verb", () => {

        expect(isMutatingTool("Searching 'createSession'")).toBe(false);
        expect(isMutatingTool("Executing 'git mv a b && write.exe'")).toBe(false);
        expect(isMutatingTool("Reading write_file.ts")).toBe(false);
        expect(isMutatingTool("Running task 'edit the docs'")).toBe(false);

        expect(isMutatingTool("Writing readme.md")).toBe(true);
        expect(isMutatingTool("Editing view.ts")).toBe(true);
    });
});

/**
 * The `target` contract: the path the session must produce is stated to
 * the agent, and verified on disk after.
 */
describe("target", () => {

    const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "ghcp-target-"));

    it("states the target path last in the instructions", async () => {

        const { fake, seen } = runtime();
        const dir = tmpDir();

        fs.writeFileSync(path.join(dir, "requirements.md"), "# req");

        await agent(fake).execute(
            { prompt: "Draft it.", target: "requirements.md", context: { brief: "# the brief" } },
            context({ cwd: dir }).ctx);

        expect(seen[0].prompt).toContain("## Target");
        expect(seen[0].prompt).toContain("requirements.md");

        // Documents, then instructions, then target: last weighs most.
        expect(seen[0].prompt.indexOf("## Target"))
            .toBeGreaterThan(seen[0].prompt.indexOf("=== INSTRUCTIONS ==="));
    });

    // A bare relative path can be resolved against the wrong
    // repository, so the anchor is named. See `withTarget`.
    it("states the path relative, and names what it is relative to", async () => {

        const { fake, seen } = runtime();
        const dir = tmpDir();

        fs.writeFileSync(path.join(dir, "requirements.md"), "# req");

        await agent(fake).execute(
            { prompt: "Draft it.", target: "specs/one/requirements.md" },
            context({ cwd: dir }).ctx);

        const target = seen[0].prompt.slice(seen[0].prompt.indexOf("## Target"));

        expect(target).toContain("`specs/one/requirements.md`");
        expect(target).toContain("relative to the working directory");
        expect(target).toContain(dir);
    });

    /* Told relative, verified absolute. */
    it("still fails a session that did not write the target", async () => {

        const dir = tmpDir();

        const result = await agent(runtime().fake)
            .execute({ prompt: "Draft it.", target: "never-written.md" }, context({ cwd: dir }).ctx);

        expect(result.success).toBe(false);
    });

    it("warns when the session wrote files that do not include the target", async () => {

        const dir = tmpDir();

        // Target exists from a previous run - the session wrote elsewhere.
        fs.writeFileSync(path.join(dir, "requirements.md"), "# stale");

        const { ctx, logs } = context({ cwd: dir });

        const result = await agent(runtime({ files: ["d:/somewhere/else/requirements.md"] }).fake)
            .execute({ prompt: "Draft it.", target: "requirements.md" }, ctx);

        expect(result.success).toBe(true);
        expect(logs.join("\n")).toContain("Warning");
        expect(logs.join("\n")).toContain("may not be what wrote it");
    });

    it("does not warn when the session wrote the target itself", async () => {

        const dir = tmpDir();

        fs.writeFileSync(path.join(dir, "requirements.md"), "# fresh");

        const { ctx, logs } = context({ cwd: dir });

        await agent(runtime({ files: [path.join(dir, "requirements.md")] }).fake)
            .execute({ prompt: "Draft it.", target: "requirements.md" }, ctx);

        expect(logs.join("\n")).not.toContain("Warning");
    });

    it("succeeds when the session leaves the file on disk", async () => {

        const dir = tmpDir();

        fs.writeFileSync(path.join(dir, "requirements.md"), "# req");

        const result = await agent(runtime().fake).execute(
            { prompt: "Draft it.", target: "requirements.md" },
            context({ cwd: dir }).ctx);

        expect(result.success).toBe(true);
    });

    it("fails the task when the session ends without writing it", async () => {

        const result = await agent(runtime({ summary: "All done!" }).fake).execute(
            { prompt: "Draft it.", target: "requirements.md" },
            context({ cwd: tmpDir() }).ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("requirements.md");
    });

    it("changes nothing for a task that declares none", async () => {

        const { fake, seen } = runtime();

        const result = await agent(fake).execute({ prompt: "Just think." }, context().ctx);

        expect(result.success).toBe(true);
        expect(seen[0].prompt).not.toContain("## Target");
    });
});

/**
 * Args this plugin does not declare, carried to the provider verbatim.
 * MCP servers are not among them: a `mcpServers:` key that reaches the
 * provider this way is removed there (see sessionConfig).
 */
describe("passthrough args", () => {

    it("carries an undeclared arg to the runtime untouched", async () => {

        const { fake, seen } = runtime();
        const { ctx } = context();

        const result = await agent(fake).execute(
            { prompt: "read AB#4821", availableTools: ["ado-wit_work_item"] }, ctx);

        expect(result.success).toBe(true);
        expect(seen[0].extra).toEqual({ availableTools: ["ado-wit_work_item"] });
    });

    it("sends nothing when a task declares none, so the usual session is unchanged", async () => {

        const { fake, seen } = runtime();
        const { ctx } = context();

        await agent(fake).execute({ prompt: "just think" }, ctx);

        expect(seen[0].extra).toBeUndefined();
    });

    it("carries several at once, each under its own name", async () => {

        const { fake, seen } = runtime();
        const { ctx } = context();

        await agent(fake).execute(
            {
                prompt: "read AB#4821",
                availableTools: ["ado-wit_work_item"],
                excludedTools: ["shell"]
            },
            ctx);

        expect(seen[0].extra).toEqual({
            availableTools: ["ado-wit_work_item"],
            excludedTools: ["shell"]
        });
    });
});

/**
 * Attachments are files the session opens; `context` is text pasted into
 * the prompt. A file that ships with Eesha Code is nowhere near the
 * repository, so it can only be an attachment.
 */
describe("attachments", () => {

    it("passes them to the session untouched", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            {
                prompt: "Go.",
                attachments: [
                    { path: "C:/app/resources/styles/kiro/instructions/grammar.md", name: "grammar" },
                    { path: "C:/work/repo/specs/one/requirements.md", name: "requirements" }
                ]
            },
            context().ctx);

        expect(seen[0].attachments).toEqual([
            { path: "C:/app/resources/styles/kiro/instructions/grammar.md", name: "grammar" },
            { path: "C:/work/repo/specs/one/requirements.md", name: "requirements" }
        ]);
    });

    it("keeps a path from outside the working directory, which is the point", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", attachments: [{ path: "C:/app/resources/styles/kiro/instructions/how.md" }] },
            context({ cwd: "C:/work/repo" }).ctx);

        expect(seen[0].attachments?.[0].path).toBe("C:/app/resources/styles/kiro/instructions/how.md");
    });

    it("leaves the prompt alone - an attachment is not pasted in", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", attachments: [{ path: "C:/x/grammar.md", name: "grammar" }] },
            context().ctx);

        expect(seen[0].prompt).toBe("Go.");
    });

    it("adds the always steering files on a new chat, after the task's own", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.mkdirSync(path.join(dir, ".kiro", "steering"), { recursive: true });
        fs.writeFileSync(path.join(dir, ".kiro", "steering", "tech.md"), "---\ninclusion: always\n---\n");
        fs.writeFileSync(path.join(dir, "manual.md"), "---\ninclusion: manual\n---\n");

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", attachments: [{ path: "C:/x/grammar.md", name: "grammar" }] },
            context({ cwd: dir }).ctx);

        expect(seen[0].attachments).toEqual([
            { path: "C:/x/grammar.md", name: "grammar" },
            { path: path.join(dir, ".kiro", "steering", "tech.md"), name: "steering: .kiro/steering/tech.md" }
        ]);
    });

    it("uses no steering at all while the feature flag is off", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "rules.md"), "---\ninclusion: always\n---\n");
        fs.writeFileSync(path.join(dir, "api.md"), "---\ninclusion: manual\ntags: [api]\n---\n");

        const { fake, seen } = runtime();

        const providers = new AgentProviders();

        providers.register("ghcp", () => fake);

        const off = pluginFromManifest(
            manifest as PluginManifest,
            createExecute({ providers, sessions: new AgentSessions(), provider: "ghcp", steeringOn: async () => false }) as never,
            "aiV1");

        await off.execute({ prompt: "Use @api.", verbatim: true }, context({ cwd: dir }).ctx);

        expect(seen[0].attachments).toBeUndefined();
        expect(seen[0].steering).toBeUndefined();
    });

    it("hands tagged steering files to the session for its tool, not as attachments", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "api.md"), "---\ninclusion: manual\ntags: [api]\n---\n");

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context({ cwd: dir }).ctx);

        expect(seen[0].steering).toEqual([{ path: path.join(dir, "api.md"), relative: "api.md", tags: ["api"] }]);
        expect(seen[0].attachments).toBeUndefined();
    });

    it("attaches a fileMatch steering file when one of the chat's files matches, and stops offering it by tag", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "api.md"),
            "---\ninclusion: fileMatch\nfileMatchPattern: \"src/api/**\"\ntags: [api]\n---\n");
        fs.writeFileSync(path.join(dir, "ui.md"),
            "---\ninclusion: fileMatch\nfileMatchPattern: \"*.tsx\"\ntags: [ui]\n---\n");

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", files: ["src/api/users.ts"] }, context({ cwd: dir }).ctx);

        expect(seen[0].attachments).toEqual([{ path: path.join(dir, "api.md"), name: "steering: api.md" }]);
        expect(seen[0].steering).toEqual([{ path: path.join(dir, "ui.md"), relative: "ui.md", tags: ["ui"] }]);
    });

    it("refuses 'files' that is not a list of paths", async () => {

        const { fake } = runtime();

        const result = await agent(fake).execute({ prompt: "Go.", files: "src/a.ts" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("'files' must be a list");
    });

    it("adds steering to a verbatim message too - it is a file, not prompt text", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "rules.md"), "---\ninclusion: always\n---\n");

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", verbatim: true }, context({ cwd: dir }).ctx);

        expect(seen[0].attachments).toEqual([{ path: path.join(dir, "rules.md"), name: "steering: rules.md" }]);
    });

    it("does not attach a steering file the task already attached", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));
        const rules = path.join(dir, "rules.md");

        fs.writeFileSync(rules, "---\ninclusion: always\n---\n");

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Go.", attachments: [{ path: rules, name: "mine" }] },
            context({ cwd: dir }).ctx);

        expect(seen[0].attachments).toEqual([{ path: rules, name: "mine" }]);
    });

    it("attaches a manual steering file named as @name in a typed message, even on a continued chat", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "api.md"), "---\ninclusion: manual\n---\n");

        const sessions = new AgentSessions();
        const sent: AgentMessage[] = [];

        sessions.hold("owner", {
            id: "held-1",
            status: "idle",
            send: async () => undefined,
            sendAndWait: async message => { sent.push(message); },
            abort: async () => undefined,
            dispose: async () => undefined,
            on: () => () => undefined
        });

        const { fake } = runtime();
        const { ctx, logs } = context({ cwd: dir });

        await agent(fake, sessions).execute(
            { prompt: "Follow @api and @nope.", continueSession: "held-1", verbatim: true }, ctx);

        expect(sent[0].prompt).toBe("Follow @api and @nope.");
        expect(sent[0].attachments).toEqual([{ path: path.join(dir, "api.md"), name: "steering: api.md" }]);
        expect(logs).toContain("No manual steering file named @nope. The message was sent as typed.");
    });

    it("leaves @name alone in a message the plugin composed", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "api.md"), "---\ninclusion: manual\n---\n");

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Follow @api." }, context({ cwd: dir }).ctx);

        expect(seen[0].attachments).toBeUndefined();
    });

    it("does not attach steering again when a chat is continued", async () => {

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-steering-"));

        fs.writeFileSync(path.join(dir, "rules.md"), "---\ninclusion: always\n---\n");

        const sessions = new AgentSessions();
        const sent: AgentMessage[] = [];

        sessions.hold("owner", {
            id: "held-1",
            status: "idle",
            send: async () => undefined,
            sendAndWait: async message => { sent.push(message); },
            abort: async () => undefined,
            dispose: async () => undefined,
            on: () => () => undefined
        });

        const { fake } = runtime();

        await agent(fake, sessions).execute(
            { prompt: "Next.", continueSession: "held-1" }, context({ cwd: dir }).ctx);

        expect(sent[0].attachments).toBeUndefined();
    });

    it("sends none when the task attaches none", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(seen[0].attachments).toBeUndefined();
    });

    // A surface has only the log to read, and attachments are not in
    // the prompt text.
    it("reports them on the prompt line, so a thread can draw them", async () => {

        const { fake } = runtime();
        const { ctx, meta } = context();

        await agent(fake).execute(
            {
                prompt: "Go.",
                attachments: [{ path: "C:/app/resources/styles/kiro/glossary.md", name: "glossary" }]
            },
            ctx);

        expect(meta.find(line => line.meta?.kind === "prompt")?.meta?.attachments)
            .toEqual([{ path: "C:/app/resources/styles/kiro/glossary.md", name: "glossary" }]);
    });

    it("puts no attachment field on a prompt line that had none", async () => {

        const { fake } = runtime();
        const { ctx, meta } = context();

        await agent(fake).execute({ prompt: "Go." }, ctx);

        expect(meta.find(line => line.meta?.kind === "prompt")?.meta?.attachments).toBeUndefined();
    });
});

/**
 * `detach`: start the conversation and return. Waiting for a turn a
 * person is meant to answer would hang until the idle timeout.
 */
describe("handing a session over", () => {

    it("does not wait for the turn, and returns the id at once", async () => {

        const { fake, seen } = runtime({ sessionId: "chat-7" });

        const result = await agent(fake).execute(
            { prompt: "Talk to them.", detach: true }, context().ctx);

        expect(seen[0].waited).toBe(false);
        expect(result.success).toBe(true);
        expect(result.session).toEqual({ id: "chat-7" });
    });

    it("does not verify a target, since the work has not started", async () => {

        const { fake } = runtime({ sessionId: "chat-7" });

        const result = await agent(fake).execute(
            { prompt: "Talk to them.", detach: true, target: "never-written.md" },
            context({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ghcp-detach-")) }).ctx);

        expect(result.success).toBe(true);
    });

    it("says nothing about files changed, because none were", async () => {

        const { ctx, logs } = context();

        await agent(runtime({ sessionId: "chat-7" }).fake)
            .execute({ prompt: "Talk to them.", detach: true }, ctx);

        expect(logs.join("\n")).not.toContain("No files were changed");
        expect(logs.join("\n")).toContain("started.");
    });

    it("waits, verifies and reports as usual when it is not detached", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Draft it." }, context().ctx);

        expect(seen[0].waited).toBe(true);
    });
});

/**
 * `cleanup` - whether the provider's stored conversation survives the
 * task. Off by default. Only a successful, waited session is ever
 * deleted.
 */
describe("cleanup", () => {

    it("declares false as the manifest default", () => {

        expect(manifest.args.find(arg => arg.name === "cleanup")?.default).toBe(false);
    });

    it("keeps a successful session without being asked - the default is off", async () => {

        const { fake, ended } = runtime();

        const result = await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(result.success).toBe(true);
        expect(ended).toEqual(["dispose"]);
    });

    it("deletes the session when the task says cleanup: true", async () => {

        const { fake, ended, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", cleanup: true }, context().ctx);

        expect(ended).toEqual(["delete"]);

        // Declared, so it never leaks to the provider as passthrough.
        expect(seen[0].extra).toBeUndefined();
    });

    it("keeps a failed session even when asked to clean up - it is the conversation most worth reopening", async () => {

        const { fake, ended } = runtime();

        const result = await agent(fake).execute(
            { prompt: "Go.", cleanup: true, target: "never-written.md" },
            context({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ghcp-cleanup-")) }).ctx);

        expect(result.success).toBe(false);
        expect(ended).toEqual(["dispose"]);
    });

    it("does not touch a detached session, which was started for a person to join", async () => {

        const { fake, ended } = runtime({ sessionId: "chat-7" });

        await agent(fake).execute(
            { prompt: "Talk to them.", detach: true, cleanup: true }, context().ctx);

        expect(ended).not.toContain("delete");
    });

    it("falls back to dispose for a provider that cannot delete", async () => {

        const ended: string[] = [];

        const fake: AgentProvider = {
            createSession: async () => ({
                id: "s-1",
                status: "idle",
                send: async () => undefined,
                sendAndWait: async () => undefined,
                abort: async () => undefined,
                dispose: async () => { ended.push("dispose"); },
                on: () => () => undefined
            })
        };

        const result = await agent(fake).execute(
            { prompt: "Go.", cleanup: true }, context().ctx);

        expect(result.success).toBe(true);
        expect(ended).toEqual(["dispose"]);
    });

    it("logs a delete the provider refused, and does not fail the finished task over it", async () => {

        const fake: AgentProvider = {
            createSession: async () => ({
                id: "s-1",
                status: "idle",
                send: async () => undefined,
                sendAndWait: async () => undefined,
                abort: async () => undefined,
                dispose: async () => undefined,
                delete: async () => { throw new Error("store is locked"); },
                on: () => () => undefined
            })
        };

        const { ctx, logs } = context();

        const result = await agent(fake).execute({ prompt: "Go.", cleanup: true }, ctx);

        expect(result.success).toBe(true);
        expect(logs.join("\n")).toContain("Could not delete session s-1");
        expect(logs.join("\n")).toContain("store is locked");
    });
});

/**
 * `keep` and `continueSession` - a phase stays reachable after its turn,
 * and a later call naming its id continues the same conversation.
 */
describe("keep and continueSession", () => {

    it("declares false as the manifest default", () => {

        expect(manifest.args.find(arg => arg.name === "keep")?.default).toBe(false);
    });

    it("holds the session instead of disposing it", async () => {

        const sessions = new AgentSessions();
        const { fake, ended } = runtime({ sessionId: "chat-9" });

        const result = await agent(fake, sessions).execute({ prompt: "Go.", keep: true }, context().ctx);

        expect(result.success).toBe(true);
        expect(ended).toEqual([]);
        expect(sessions.get("chat-9")).toBeDefined();
    });

    // `detach`'s own policy releases the session once it goes idle -
    // right for a task nobody is going to talk to again. `keep` means
    // the opposite by definition ("hold instead of disposing it"), so a
    // caller naming both must not have its session vanish out from
    // under it at the first idle.
    it("keeps a detached session past its first idle, when keep is also set", async () => {

        const sessions = new AgentSessions();
        const { fake, publish } = runtime({ sessionId: "chat-9" });

        const result = await agent(fake, sessions).execute(
            { prompt: "Go.", detach: true, keep: true }, context().ctx);

        expect(result.success).toBe(true);
        expect(sessions.get("chat-9")).toBeDefined();

        publish({ kind: "idle", name: "session.idle", raw: {} });

        expect(sessions.get("chat-9")).toBeDefined();
    });

    // A wave's chat whose first send hits a quota error: still held, so
    // the panel can hand the work over to another runtime.
    it("holds a detached, kept session whose first send failed", async () => {

        const sessions = new AgentSessions();
        const ended: string[] = [];

        const fake: AgentProvider = {
            createSession: async () => ({
                id: "chat-5",
                status: "idle",
                send: async () => { throw new Error("You have exceeded your premium request allowance."); },
                sendAndWait: async () => undefined,
                abort: async () => undefined,
                dispose: async () => { ended.push("dispose"); },
                on: () => () => undefined
            })
        };

        const result = await agent(fake, sessions).execute(
            { prompt: "Go.", detach: true, keep: true }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.session?.id).toBe("chat-5");
        expect(sessions.get("chat-5")).toBeDefined();
        expect(ended).toEqual([]);
    });

    // Without `keep` nothing is going to talk to it again, so it is ended
    // rather than left running with nobody holding it.
    it("ends a detached session whose first send failed, when keep is not set", async () => {

        const sessions = new AgentSessions();
        const ended: string[] = [];

        const fake: AgentProvider = {
            createSession: async () => ({
                id: "chat-6",
                status: "idle",
                send: async () => { throw new Error("quota"); },
                sendAndWait: async () => undefined,
                abort: async () => undefined,
                dispose: async () => { ended.push("dispose"); },
                on: () => () => undefined
            })
        };

        const result = await agent(fake, sessions).execute({ prompt: "Go.", detach: true }, context().ctx);

        expect(result.success).toBe(false);
        expect(sessions.get("chat-6")).toBeUndefined();
        expect(ended).toEqual(["dispose"]);
    });

    it("logs that the session was kept open, naming it for a later continueSession", async () => {

        const { ctx, logs } = context();

        await agent(runtime({ sessionId: "chat-9" }).fake, new AgentSessions())
            .execute({ prompt: "Go.", keep: true }, ctx);

        expect(logs.join("\n")).toContain("Session chat-9 kept open");
        expect(logs.join("\n")).toContain("continueSession");
    });

    // A turn that ended without its target (the agent asked a question)
    // must stay reachable, or there is nothing for a revise to continue.
    it("holds a failed session too, when keep is set", async () => {

        const sessions = new AgentSessions();
        const { fake, ended } = runtime({ sessionId: "chat-9" });

        const result = await agent(fake, sessions).execute(
            { prompt: "Go.", keep: true, target: "never-written.md" },
            context({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), "ghcp-keep-")) }).ctx);

        expect(result.success).toBe(false);
        expect(ended).toEqual([]);
        expect(sessions.get("chat-9")).toBeDefined();
    });

    it("lets an explicit cleanup win over keep on a successful run", async () => {

        const sessions = new AgentSessions();
        const { fake, ended } = runtime({ sessionId: "chat-9" });

        await agent(fake, sessions).execute({ prompt: "Go.", keep: true, cleanup: true }, context().ctx);

        expect(ended).toEqual(["delete"]);
        expect(sessions.get("chat-9")).toBeUndefined();
    });

    it("does not hold a session when keep is not set - the default", async () => {

        const sessions = new AgentSessions();
        const { fake, ended } = runtime({ sessionId: "chat-9" });

        await agent(fake, sessions).execute({ prompt: "Go." }, context().ctx);

        expect(ended).toEqual(["dispose"]);
        expect(sessions.get("chat-9")).toBeUndefined();
    });

    it("continues a held session instead of creating a new one", async () => {

        const sessions = new AgentSessions();
        const prompts: string[] = [];

        const held: AgentSession = {
            id: "held-1",
            status: "idle",
            send: async () => undefined,
            sendAndWait: async message => { prompts.push(message.prompt); },
            abort: async () => undefined,
            dispose: async () => undefined,
            on: () => () => undefined
        };

        sessions.hold("owner", held);

        const { fake, seen } = runtime();

        const result = await agent(fake, sessions).execute(
            { prompt: "Second message.", continueSession: "held-1" }, context().ctx);

        expect(result.session).toEqual({ id: "held-1" });
        expect(prompts).toEqual(["Second message."]);

        // createSession was never reached.
        expect(seen).toHaveLength(0);
    });

    // A fresh session is wired to this call's own `aborter` at creation.
    // A held session was created on an earlier call, whose `aborter`
    // cannot be reached - without a handler, Stop on this turn does nothing.
    // `abort()` is every provider's own turn-stop, so this call's own
    // cancel hook has to reach it directly instead.
    it("reaches a continued session's own abort, since its own aborter is unreachable", async () => {

        const sessions = new AgentSessions();
        const aborted: string[] = [];

        const held: AgentSession = {
            id: "held-1",
            status: "idle",
            send: async () => undefined,
            sendAndWait: async () => undefined,
            abort: async () => { aborted.push("held-1"); },
            dispose: async () => undefined,
            on: () => () => undefined
        };

        sessions.hold("owner", held);

        const { fake } = runtime();
        const cancelHandlers: (() => void)[] = [];

        const result = await agent(fake, sessions).execute(
            { prompt: "Second message.", continueSession: "held-1" },
            context({ onCancel: handler => { cancelHandlers.push(handler); } }).ctx);

        expect(result.success).toBe(true);

        // Every registered handler fires, the same way the host's own
        // Stop reaches every one of them.
        cancelHandlers.forEach(handler => handler());

        expect(aborted).toEqual(["held-1"]);
    });

    // The registry is empty after a restart; the runtimes keep their
    // own transcripts.
    it("hands the id to the runtime when nothing here is holding it", async () => {

        const asked: (string | undefined)[] = [];

        const reopening: AgentProvider = {
            createSession: async config => {

                asked.push(config.resume);

                return {
                    id: "long-gone",
                    status: "idle",
                    resumed: true,
                    send: async () => undefined,
                    sendAndWait: async () => undefined,
                    abort: async () => undefined,
                    dispose: async () => undefined,
                    on: () => () => undefined
                };
            }
        };

        await agent(reopening, new AgentSessions()).execute(
            { prompt: "Go.", continueSession: "long-gone" }, context().ctx);

        expect(asked).toEqual(["long-gone"]);
    });

    it("names no conversation to reopen when none was asked for", async () => {

        const { fake, seen } = runtime();

        await agent(fake, new AgentSessions()).execute({ prompt: "Go." }, context().ctx);

        expect(seen[0].resume).toBeUndefined();
    });

    it("reads as continuing when the runtime reopened the conversation", async () => {

        const reopening: AgentProvider = {
            createSession: async () => ({
                id: "held-1",
                status: "idle",
                resumed: true,
                send: async () => undefined,
                sendAndWait: async () => undefined,
                abort: async () => undefined,
                dispose: async () => undefined,
                on: () => () => undefined
            })
        };

        const { ctx, logs } = context();

        await agent(reopening, new AgentSessions()).execute(
            { prompt: "Go.", continueSession: "held-1" }, ctx);

        expect(logs.join("\n")).toContain("Continuing session: held-1");
        expect(logs.join("\n")).not.toContain("Could not continue");
    });

    /*
     * The person asked for that conversation. A new one starting cold in
     * its place would answer with none of what was said, so the call
     * fails instead, sends nothing, and lets go of the session the
     * runtime opened in its place before anything records its id.
     */
    it("refuses to send when continueSession names one nothing can reopen", async () => {

        const { fake, seen, ended } = runtime({ sessionId: "chat-fresh" });
        const reported: string[] = [];

        const result = await agent(fake, new AgentSessions()).execute(
            { prompt: "Go.", continueSession: "long-gone" },
            context({ reportSession: id => { reported.push(id); } }).ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("Could not continue session long-gone");
        expect(result.message).toContain("Nothing was sent");
        expect(result.session).toBeUndefined();
        expect(seen).toHaveLength(0);
        expect(reported).toEqual([]);
        expect(ended).toEqual(["dispose"]);
    });

    // The refusal says why, so the panel can show it.
    it("says so when it cannot continue the session it was named", async () => {

        const { fake } = runtime({ sessionId: "chat-fresh" });
        const { ctx, logs } = context();

        await agent(fake, new AgentSessions()).execute(
            { prompt: "Go.", continueSession: "long-gone" }, ctx);

        expect(logs.join("\n")).toContain("Could not continue session long-gone");

        // Nothing held means something let the session go; another id
        // means it moved.
        expect(logs.join("\n")).toContain("Nothing is held now.");
    });

    // "The transcript is gone" and "the lookup itself kept failing" are
    // different refusals, and a provider that can tell them apart says
    // so through `resumeFailure` - the generic line is only the
    // fallback for one that cannot.
    it("uses the provider's own reason for the refusal when it gives one", async () => {

        const reopening: AgentProvider = {
            createSession: async () => ({
                id: "chat-fresh",
                status: "idle",
                resumed: false,
                resumeFailure: "the transcript is gone",
                send: async () => undefined,
                sendAndWait: async () => undefined,
                abort: async () => undefined,
                dispose: async () => undefined,
                on: () => () => undefined
            })
        };

        const result = await agent(reopening, new AgentSessions()).execute(
            { prompt: "Go.", continueSession: "long-gone" }, context().ctx);

        expect(result.message).toContain("the transcript is gone");
        expect(result.message).not.toContain("the runtime could not reopen it");
    });

    it("distinguishes a session it never held from one it ended", async () => {

        const { fake } = runtime({ sessionId: "chat-fresh" });

        const stale = context();

        await agent(fake, new AgentSessions()).execute(
            { prompt: "Go.", continueSession: "long-gone" }, stale.ctx);

        expect(stale.logs.join("\n")).toContain("never held it");

        const sessions = new AgentSessions();

        sessions.hold("owner", {
            id: "held-1",
            status: "idle",
            send: async () => undefined,
            sendAndWait: async () => undefined,
            abort: async () => undefined,
            dispose: async () => undefined,
            on: () => () => undefined
        });

        await sessions.end("held-1");

        const ended = context();

        await agent(runtime({ sessionId: "chat-2" }).fake, sessions).execute(
            { prompt: "Go.", continueSession: "held-1" }, ended.ctx);

        expect(ended.logs.join("\n")).toContain("it was ended");
    });

    it("logs 'Continuing session' rather than 'Session:' when reusing one", async () => {

        const sessions = new AgentSessions();

        const held: AgentSession = {
            id: "held-1",
            status: "idle",
            send: async () => undefined,
            sendAndWait: async () => undefined,
            abort: async () => undefined,
            dispose: async () => undefined,
            on: () => () => undefined
        };

        sessions.hold("owner", held);

        const { ctx, logs } = context();

        await agent(runtime().fake, sessions).execute(
            { prompt: "Go.", continueSession: "held-1" }, ctx);

        expect(logs.join("\n")).toContain("Continuing session: held-1");
    });
});

/**
 * Standing instructions hold for every turn of the session. The engine
 * does not name them; they travel under the provider's own name as
 * passthrough, so the whole shape (including `mode`) is the author's.
 */
describe("standing instructions", () => {

    const standing = { mode: "append", content: "You are one phase of a pipeline." };

    it("carries them to the session, separate from the prompt", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute(
            { prompt: "Write it.", systemMessage: standing }, context().ctx);

        expect(seen[0].extra).toEqual({ systemMessage: standing });
        expect(seen[0].prompt).toBe("Write it.");
    });

    it("sends none when the task declares none", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Write it." }, context().ctx);

        expect(seen[0].extra).toBeUndefined();
    });

    it("carries them on a detached session too, where they matter most", async () => {

        const { fake, seen } = runtime({ sessionId: "chat-9" });

        await agent(fake).execute(
            { prompt: "Talk to them.", detach: true, systemMessage: standing },
            context().ctx);

        expect(seen[0].extra).toEqual({ systemMessage: standing });
        expect(seen[0].waited).toBe(false);
    });
});

/**
 * The agent asking a person something mid-turn. Three things must line
 * up: the provider is told a person is there (`interactive`), the
 * question reaches the surface as a line it can draw and reply to, and
 * the session is reachable during the turn.
 */
describe("asking a person", () => {

    it("declares interactive off by default, so an unattended run never waits on nobody", () => {

        expect(manifest.args.find(arg => arg.name === "interactive")?.default).toBe(false);
    });

    it("tells the provider a person is there only when the task says exactly true", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", interactive: true }, context().ctx);
        await agent(fake).execute({ prompt: "Go." }, context().ctx);
        await agent(fake).execute({ prompt: "Go.", interactive: "yes" as unknown as boolean }, context().ctx);

        expect(seen.map(one => one.interactive)).toEqual([true, false, false]);

        // Its own field, never passthrough.
        expect(seen.every(one => one.extra === undefined)).toBe(true);
    });

    // A turn waiting on a person looks like a hung session to a clock.
    // With someone at the panel, Stop is the way out, not a timer.
    it("waits with no backstop when a person is there, and with the provider default when not", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go.", interactive: true }, context().ctx);
        await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(seen.map(one => one.timeoutMs)).toEqual([null, undefined]);
    });

    it("logs a question with its id and choices, so a surface can draw it and reply", async () => {

        const meta: { kind?: string; askId?: string; options?: unknown; multi?: boolean; text: string }[] = [];

        const { fake } = runtime({}, publish => publish({
            kind: "ask",
            name: "mcp__eesha__ask_user",
            askId: "ask-1",
            prompt: "Which store?",
            options: [{ label: "SQLite" }, { label: "Postgres", description: "a server" }],
            raw: {}
        }));

        await agent(fake).execute({ prompt: "Go.", interactive: true }, context({
            log: (text, _stream, m) => meta.push({ text, ...m })
        }).ctx);

        const asked = meta.find(line => line.kind === "ask");

        expect(asked?.askId).toBe("ask-1");
        expect(asked?.options).toEqual([{ label: "SQLite" }, { label: "Postgres", description: "a server" }]);
        expect(asked?.multi).toBeUndefined();

        // The choices are written into the text too, numbered, so a
        // plain log shows what was on offer.
        expect(asked?.text).toBe("Which store?\n1. SQLite\n2. Postgres - a server");
    });

    it("keeps the session reachable in the registry while the turn runs, then lets it go", async () => {

        const sessions = new AgentSessions();

        let duringTurn: AgentSession | undefined;

        const fake: AgentProvider = {
            createSession: async () => ({
                id: "chat-3",
                status: "idle",
                send: async () => undefined,
                sendAndWait: async () => { duringTurn = sessions.get("chat-3"); },
                abort: async () => undefined,
                dispose: async () => undefined,
                on: () => () => undefined
            })
        };

        await agent(fake, sessions).execute({ prompt: "Go." }, context().ctx);

        // Found mid-turn, when a question would be open.
        expect(duringTurn?.id).toBe("chat-3");

        expect(sessions.get("chat-3")).toBeUndefined();
    });
});

/**
 * `chat` - which conversation a session belongs to. The provider gets it
 * as its own field, so the host's permission check can file saved answers
 * under it.
 */
describe("chat", () => {

    it("hands the run's id and the task's id to the provider", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context().ctx);

        expect(seen.map(one => one.chat)).toEqual(["run-1/release/draft/0"]);
        expect(seen.every(one => one.extra === undefined)).toBe(true);
    });
});

describe("agent mode", () => {

    it("hands the picked mode to the provider as its own field, never as extra", async () => {

        const { fake, seen } = runtime();

        await agent(fake).execute({ prompt: "Go." }, context().ctx);
        await agent(fake).execute({ prompt: "Go.", agentMode: "spec" }, context().ctx);

        expect(seen.map(one => one.agentMode)).toEqual([undefined, "spec"]);
        expect(seen.every(one => one.extra === undefined)).toBe(true);
    });

    it("switches a held session to this turn's mode when it carries it on", async () => {

        const sessions = new AgentSessions();
        const { fake } = runtime({ sessionId: "chat-9" });

        const set: (string | undefined)[] = [];

        const recording: AgentProvider = {
            createSession: async config => ({
                ...await fake.createSession(config),
                setAgentMode: async mode => { set.push(mode); }
            })
        };

        await agent(recording, sessions).execute({ prompt: "Go.", keep: true }, context().ctx);
        await agent(recording, sessions).execute(
            { prompt: "Again.", keep: true, continueSession: "chat-9", agentMode: "plan" }, context().ctx);

        expect(set).toEqual(["plan"]);
    });

    it("fails the turn when the held session cannot switch mode", async () => {

        const sessions = new AgentSessions();
        const { fake } = runtime({ sessionId: "chat-9" });

        const refusing: AgentProvider = {
            createSession: async config => ({
                ...await fake.createSession(config),
                setAgentMode: async () => { throw new Error("This agent does not offer mode 'x'."); }
            })
        };

        await agent(refusing, sessions).execute({ prompt: "Go.", keep: true }, context().ctx);

        const result = await agent(refusing, sessions).execute(
            { prompt: "Again.", keep: true, continueSession: "chat-9", agentMode: "x" }, context().ctx);

        expect(result.success).toBe(false);
        expect(result.message).toContain("does not offer mode 'x'");
    });
});

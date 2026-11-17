import { describe, expect, it } from "vitest";
import { Task } from "../../models/task";
import { SecretMasker } from "../../runner/SecretMasker";
import type { TaskExecutionContext } from "../PluginHost";
import { Plugin, PluginContext, PluginResult } from "../Plugin";
import { PluginHost } from "../PluginHost";
import { PluginRegistry } from "../PluginRegistry";

interface Captured {

    text: string;

    stream: string;
}

function task(overrides: Partial<Task> = {}): Task {

    return { name: "s", needs: [], trigger: "auto", env: {}, vars: {}, dotenv: [], ...overrides };
}

function harness(masker = new SecretMasker()) {

    const output: Captured[] = [];

    const context: TaskExecutionContext = {
        runId: "run-1",
        taskId: "build#0",
        attempt: 1,
        ownerId: "build",
        taskIndex: 0,
        workspace: process.cwd(),
        cwd: process.cwd(),
        root: process.cwd(),
        home: "C:/Users/dev",
        env: { GREETING: "hello" },
        processEnv: {},
        runVariables: {},
        registerSecret: value => masker.register(value),
        onOutput: (text, stream) => {

            if (stream === "system")
                output.push({ text: masker.mask(text), stream });
            else
                for (const line of masker.push(text, stream))
                    output.push({ text: line, stream });
        },
        registerKill: () => undefined
    };

    return { context, output, text: () => output.map(o => o.text).join("\n") };
}

/** A plugin whose behaviour each test dictates. */
function fake(
    execute: (args: Record<string, unknown>, ctx: PluginContext) => Promise<PluginResult>,
    overrides: Partial<Plugin> = {}
): Plugin {

    return {
        id: "fake",
        version: "1",
        execute,
        ...overrides
    } as Plugin;
}

function hostWith(plugin?: Plugin) {

    const registry = new PluginRegistry();

    if (plugin)
        registry.register(plugin);

    return new PluginHost(registry);
}

describe("PluginHost", () => {

    it("runs a plugin and reports success", async () => {

        const host = hostWith(fake(async () => ({ success: true })));
        const { context } = harness();

        const result = await host.execute(task({ plugin: "fake@1" }), context);

        expect(result.success).toBe(true);
    });

    it("passes artifacts back so the task's artifact: can store them", async () => {

        const host = hostWith(fake(async () => ({ success: true, artifacts: { url: "https://x" } })));
        const { context } = harness();

        const result = await host.execute(task({ plugin: "fake@1" }), context);

        expect(result.artifacts).toEqual({ url: "https://x" });
    });

    it("passes a well-formed ui back for the run panel to draw", async () => {

        const ui = { type: "markdown" as const, label: "Report", content: "# Done" };
        const host = hostWith(fake(async () => ({ success: true, ui })));
        const { context } = harness();

        const result = await host.execute(task({ plugin: "fake@1" }), context);

        expect(result.ui).toEqual(ui);
    });

    it("drops a malformed ui and says why, without failing the task", async () => {

        const host = hostWith(fake(async () => ({
            success: true,
            ui: { type: "table", label: "Rows", rows: [["a"]] } as never
        })));
        const { context, text } = harness();

        const result = await host.execute(task({ plugin: "fake@1" }), context);

        expect(result.success).toBe(true);
        expect(result.ui).toBeUndefined();
        expect(text()).toContain("'columns'");
    });

    it("fails on a malformed reference, naming the expected shape", async () => {

        const { context, text } = harness();

        const result = await hostWith().execute(task({ plugin: "not-a-ref" }), context);

        expect(result.success).toBe(false);
        expect(text()).toContain("id@version");
    });

    it("fails on an unregistered plugin, and lists what is available", async () => {

        const host = hostWith(fake(async () => ({ success: true })));
        const { context, text } = harness();

        const result = await host.execute(task({ plugin: "missing@1" }), context);

        expect(result.success).toBe(false);
        expect(text()).toContain("missing@1");
        expect(text()).toContain("fake@1");
    });

    it("fails when a plugin throws, without letting the error escape", async () => {

        const host = hostWith(fake(async () => { throw new Error("boom"); }));
        const { context, text } = harness();

        const result = await host.execute(task({ plugin: "fake@1" }), context);

        expect(result.success).toBe(false);
        expect(text()).toContain("boom");
    });

    /*
     * The manifest says which args the plugin reports itself, so the
     * host does not log a duplicate. `ai@1` logs the full prompt it
     * sends, so its `prompt:` arg is marked `logged: false` here.
     */
    it("leaves out an arg the manifest marked 'logged: false'", async () => {

        const plugin = fake(
            async () => ({ success: true }),
            {
                args: {
                    prompt: { type: "string", logged: false },
                    provider: { type: "string" }
                }
            } as Partial<Plugin>);

        const { context, text } = harness();

        await hostWith(plugin)
            .execute(task({ plugin: "fake@1", args: { prompt: "Go.", provider: "ghcp" } }), context);

        expect(text()).not.toContain("Go.");
        expect(text()).toContain("[task] provider = \"ghcp\"");
    });

    describe("settings defaults", () => {

        it("fills what the task left unsaid, naming the declaring file in the log", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(async args => { seen = args; return { success: true }; }));

            host.refreshPluginDefaults({
                defaults: { "fake@1": { provider: "claude" } },
                defaultSources: { "fake@1": { provider: "ws/.eesha/settings.json" } }
            });

            const { context, text } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(seen.provider).toBe("claude");
            expect(text()).toContain("[settings(ws)] provider = \"claude\"");
        });

        it("never overrides what the task itself says", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(async args => { seen = args; return { success: true }; }));

            host.refreshPluginDefaults({
                defaults: { "fake@1": { provider: "claude" } },
                defaultSources: { "fake@1": { provider: "settings.json" } }
            });

            const { context, text } = harness();

            await host.execute(task({ plugin: "fake@1", args: { provider: "ghcp" } }), context);

            expect(seen.provider).toBe("ghcp");
            expect(text()).toContain("[task] provider = \"ghcp\"");
        });

        it("outranks the plugin manifest's own default", async () => {

            let seen: Record<string, unknown> = {};

            const plugin = fake(
                async args => { seen = args; return { success: true }; },
                { args: { provider: { type: "string", default: "ghcp" } } } as Partial<Plugin>);

            const host = hostWith(plugin);

            host.refreshPluginDefaults({
                defaults: { "fake@1": { provider: "claude" } },
                defaultSources: { "fake@1": { provider: "settings.json" } }
            });

            const { context } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(seen.provider).toBe("claude");
        });

        it("leaves the manifest default standing when no settings were pushed", async () => {

            let seen: Record<string, unknown> = {};

            const plugin = fake(
                async args => { seen = args; return { success: true }; },
                { args: { provider: { type: "string", default: "ghcp" } } } as Partial<Plugin>);

            const host = hostWith(plugin);
            const { context, text } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(seen.provider).toBe("ghcp");
            expect(text()).toContain("[manifest] provider = \"ghcp\"");
        });

        /*
         * `providers:` blocks, on a plugin with a `provider` arg: the
         * running runtime's block only, and the plugin never sees the key.
         */
        describe("providers: blocks", () => {

            const runtimePlugin = (onRun: (args: Record<string, unknown>) => void) => fake(
                async args => { onRun(args); return { success: true }; },
                // Like ai@1: undeclared args pass through to the runtime.
                { args: { provider: { type: "string", default: "ghcp" } }, passthrough: true } as Partial<Plugin>);

            const blocks = {
                defaults: {
                    "fake@1": {
                        model: "auto",
                        providers: {
                            ghcp: { model: "gpt-5.2", reasoningSummary: "concise" },
                            "kiro-cli": { model: "claude-sonnet-4.5" }
                        }
                    }
                },
                defaultSources: { "fake@1": { model: "settings.json", providers: "ws/.eesha/settings.json" } },
                acpAgents: { "kiro-cli": {} }
            };

            it("fills from settings.json's block for the runtime that runs", async () => {

                let seen: Record<string, unknown> = {};

                const host = hostWith(runtimePlugin(args => { seen = args; }));

                host.refreshPluginDefaults(blocks);

                const { context, text } = harness();

                await host.execute(task({ plugin: "fake@1", args: { provider: "kiro-cli" } }), context);

                expect(seen).not.toHaveProperty("providers");
                expect(seen).not.toHaveProperty("reasoningSummary");
                expect(seen.model).toBe("claude-sonnet-4.5");
                expect(text()).toMatch(/\[settings\(ws\)\] model\s+= "claude-sonnet-4\.5"/);
            });

            it("reads the manifest's runtime when nobody names one", async () => {

                let seen: Record<string, unknown> = {};

                const host = hostWith(runtimePlugin(args => { seen = args; }));

                host.refreshPluginDefaults(blocks);

                await host.execute(task({ plugin: "fake@1" }), harness().context);

                expect(seen).toMatchObject({ model: "gpt-5.2", reasoningSummary: "concise" });
            });

            it("lets a step's own flat key beat a settings.json block", async () => {

                let seen: Record<string, unknown> = {};

                const host = hostWith(runtimePlugin(args => { seen = args; }));

                host.refreshPluginDefaults(blocks);

                await host.execute(task({ plugin: "fake@1", args: { model: "gpt-5-mini" } }), harness().context);

                expect(seen.model).toBe("gpt-5-mini");
            });

            it("applies a step's own block over its flat keys", async () => {

                let seen: Record<string, unknown> = {};

                const host = hostWith(runtimePlugin(args => { seen = args; }));

                await host.execute(task({
                    plugin: "fake@1",
                    args: { provider: "claude", model: "x", providers: { claude: { model: "opus" }, ghcp: { model: "gpt" } } }
                }), harness().context);

                expect(seen).toEqual({ provider: "claude", model: "opus" });
            });

            it("holds a step to ai.providers when settings.json lists one", async () => {

                let ran = false;

                const host = hostWith(runtimePlugin(() => { ran = true; }));

                host.refreshPluginDefaults({ ...blocks, providers: ["ghcp"] });

                const { context, text } = harness();

                const offList = await host.execute(task({ plugin: "fake@1", args: { provider: "kiro-cli" } }), context);

                expect(offList.success).toBe(false);
                expect(text()).toContain("'kiro-cli', which is not in ai.providers");

                // The settings.json block for kiro-cli is itself off the list.
                const blocked = await host.execute(task({ plugin: "fake@1" }), harness().context);

                expect(blocked.success).toBe(false);
                expect(ran).toBe(false);
            });

            it("fails a block keyed by a runtime that is not registered", async () => {

                let ran = false;

                const host = hostWith(runtimePlugin(() => { ran = true; }));

                host.refreshPluginDefaults(blocks);

                const { context, text } = harness();

                const result = await host.execute(
                    task({ plugin: "fake@1", args: { providers: { kiro: { model: "x" } } } }), context);

                expect(ran).toBe(false);
                expect(result.success).toBe(false);
                expect(text()).toContain("'kiro', which is not a registered runtime");
            });
        });
    });

    describe("args", () => {

        it("resolves env templates before handing them over", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(async args => { seen = args; return { success: true }; }));
            const { context } = harness();

            await host.execute(task({ plugin: "fake@1", args: { message: "say ${{ env.GREETING }}" } }), context);

            expect(seen.message).toBe("say hello");
        });

        it("resolves run variables set by an earlier task", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(async args => { seen = args; return { success: true }; }));
            const { context } = harness();

            context.runVariables!.PR = { title: "Add caching" };

            await host.execute(task({ plugin: "fake@1", args: { title: "${{ run.context.PR.title }}" } }), context);

            expect(seen.title).toBe("Add caching");
        });

        it("fails when a template cannot be resolved, naming the input", async () => {

            const host = hostWith(fake(async () => ({ success: true })));
            const { context, text } = harness();

            const result = await host.execute(
                task({ plugin: "fake@1", args: { message: "${{ env.NOPE }}" } }), context);

            expect(result.success).toBe(false);
            expect(text()).toContain("message");
        });

        it("passes a literal-shaped arg through untouched, `${{ }}` and all", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(async args => { seen = args; return { success: true }; }));
            const { context } = harness();

            await host.execute(
                task({ plugin: "fake@1", args: { message: { literal: "the task reads ${{ env.NOPE }}" } } }), context);

            expect(seen.message).toBe("the task reads ${{ env.NOPE }}");
        });

        it("leaves non-string args untouched", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(async args => { seen = args; return { success: true }; }));
            const { context } = harness();

            await host.execute(task({ plugin: "fake@1", args: { count: 3, flag: true } }), context);

            expect(seen.count).toBe(3);
            expect(seen.flag).toBe(true);
        });

        it("fails when a required input is missing, naming it", async () => {

            const host = hostWith(fake(
                async () => ({ success: true }),
                { args: { script: { type: "string", required: true } } }
            ));

            const { context, text } = harness();

            const result = await host.execute(task({ plugin: "fake@1" }), context);

            expect(result.success).toBe(false);
            expect(text()).toContain("script");
        });

        it("fails on a type mismatch, naming the input and the expected type", async () => {

            const host = hostWith(fake(
                async () => ({ success: true }),
                { args: { count: { type: "number" } } }
            ));

            const { context, text } = harness();

            const result = await host.execute(
                task({ plugin: "fake@1", args: { count: "three" } }), context);

            expect(result.success).toBe(false);
            expect(text()).toContain("count");
            expect(text()).toContain("number");
        });

        it("applies a declared default when the task omits the input", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(
                async args => { seen = args; return { success: true }; },
                { args: { shell: { type: "string", default: "pwsh" } } }
            ));

            const { context } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(seen.shell).toBe("pwsh");
        });

        it("rejects an input the plugin does not declare, so a typo is caught rather than ignored", async () => {

            const host = hostWith(fake(
                async () => ({ success: true }),
                { args: { script: { type: "string" } } }
            ));

            const { context, text } = harness();

            const result = await host.execute(
                task({ plugin: "fake@1", args: { scrpit: "typo" } }), context);

            expect(result.success).toBe(false);
            expect(text()).toContain("scrpit");
        });

        describe("options", () => {

            const choosy = () => fake(
                async () => ({ success: true }),
                { args: { mode: { type: "string", options: ["stop", "continue"] } } }
            );

            it("rejects a value outside the declared options, and lists them", async () => {

                const host = hostWith(choosy());
                const { context, text } = harness();

                const result = await host.execute(
                    task({ plugin: "fake@1", args: { mode: "halt" } }), context);

                expect(result.success).toBe(false);
                expect(text()).toContain("halt");
                expect(text()).toContain("stop, continue");
            });

            it("accepts a declared one", async () => {

                const host = hostWith(choosy());
                const { context } = harness();

                const result = await host.execute(
                    task({ plugin: "fake@1", args: { mode: "continue" } }), context);

                expect(result.success).toBe(true);
            });

            // The validator can only see the expression; this is the only
            // place the value it resolves to is ever checked.
            it("checks the value a template resolved to, not the template", async () => {

                const host = hostWith(choosy());
                const { context, text } = harness();

                const result = await host.execute(
                    task({ plugin: "fake@1", args: { mode: "${{ env.GREETING }}" } }), context);

                expect(result.success).toBe(false);
                expect(text()).toContain("hello");
            });
        });
    });

    describe("context", () => {

        it("masks a secret the plugin read, if it later reaches the log", async () => {

            process.env.EESHA_PLUGINS_TEST_SECRET = "hunter2-very-secret";

            const host = hostWith(fake(async (_inputs, ctx) => {

                const token = ctx.secret("EESHA_PLUGINS_TEST_SECRET");

                ctx.log(`calling api with ${token}`);

                return { success: true };
            }));

            const { context, text } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(text()).toContain("***");
            expect(text()).not.toContain("hunter2-very-secret");

            delete process.env.EESHA_PLUGINS_TEST_SECRET;
        });

        it("returns undefined for a secret that is not set", async () => {

            let seen: unknown = "unset";

            const host = hostWith(fake(async (_i, ctx) => {

                seen = ctx.secret("EESHA_PLUGINS_DEFINITELY_NOT_SET");

                return { success: true };
            }));

            const { context } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(seen).toBeUndefined();
        });

        it("exposes runId, taskId and attempt", async () => {

            let seen: Partial<PluginContext> = {};

            const host = hostWith(fake(async (_i, ctx) => {

                seen = { runId: ctx.runId, taskId: ctx.taskId, attempt: ctx.attempt };

                return { success: true };
            }));

            const { context } = harness();

            await host.execute(task({ plugin: "fake@1" }), context);

            expect(seen).toEqual({ runId: "run-1", taskId: "build#0", attempt: 1 });
        });

        it("surfaces a plugin's failure message on stderr", async () => {

            const host = hostWith(fake(async () => ({ success: false, message: "the api said no" })));
            const { context, output } = harness();

            const result = await host.execute(task({ plugin: "fake@1" }), context);

            expect(result.success).toBe(false);
            expect(output.some(o => o.stream === "stderr" && o.text.includes("the api said no"))).toBe(true);
        });
    });

    /*
     * A plugin needs a way to declare a list of records. `string[]` is
     * too narrow, and `object` rejects arrays outright because
     * `typeof []` is `"object"`.
     */
    describe("array args", () => {

        const listing = (type: "array" | "object") => fake(
            async () => ({ success: true }),
            { args: { files: { type, label: "Files" } } } as Partial<Plugin>);

        it("accepts a list of records, which no other declared type allows", async () => {

            let seen: Record<string, unknown> = {};

            const host = hostWith(fake(
                async args => { seen = args; return { success: true }; },
                { args: { files: { type: "array", label: "Files" } } } as Partial<Plugin>));

            const files = [{ path: "/a.md", name: "a" }, { path: "/b.md", name: "b" }];
            const { context } = harness();

            const result = await host.execute(task({ plugin: "fake@1", args: { files } }), context);

            expect(result.success).toBe(true);
            expect(seen.files).toEqual(files);
        });

        it("accepts an empty list and a list of strings alike", async () => {

            const host = hostWith(listing("array"));
            const { context } = harness();

            for (const files of [[], ["one", "two"], [1, 2]])
                expect((await host.execute(task({ plugin: "fake@1", args: { files } }), context)).success).toBe(true);
        });

        it("still refuses something that is not a list", async () => {

            const host = hostWith(listing("array"));
            const { context, text } = harness();

            const result = await host.execute(
                task({ plugin: "fake@1", args: { files: { path: "/a.md" } } }), context);

            expect(result.success).toBe(false);
            expect(text()).toContain("must be a array");
        });

        /* `object` means a map, and a list is not one. */
        it("rejects arrays for 'object'", async () => {

            const host = hostWith(listing("object"));
            const { context } = harness();

            expect((await host.execute(task({ plugin: "fake@1", args: { files: [] } }), context)).success).toBe(false);
        });
    });

    describe("resolveInputs", () => {

        it("resolves without executing, for showing a human what a gated task will receive", async () => {

            let ran = false;

            const host = hostWith(fake(async () => { ran = true; return { success: true }; }));
            const { context } = harness();

            const resolved = host.resolveInputs(
                task({ plugin: "fake@1", args: { message: "${{ env.GREETING }}" } }), context);

            expect(resolved.success).toBe(true);
            expect(resolved.args).toEqual({ message: "hello" });
            expect(ran).toBe(false);
        });
    });
});

describe("file args", () => {

    const { mkdtempSync, writeFileSync, rmSync } = require("fs");
    const { join } = require("path");
    const { tmpdir } = require("os");

    function workspaceWith(files: Record<string, string>) {

        const dir = mkdtempSync(join(tmpdir(), "eesha-fileinput-"));

        for (const [name, content] of Object.entries(files))
            writeFileSync(join(dir, name), content, "utf8");

        return dir;
    }

    it("hands the plugin the file's content, anchored at the workspace", () => {

        const dir = workspaceWith({ "requirements.md": "# The requirements" });

        try {

            const { context } = harness();

            const resolved = hostWith().resolveInputs(
                task({ args: { requirements: { file: "requirements.md" } } }),
                { ...context, workspace: dir });

            expect(resolved.success).toBe(true);
            expect(resolved.args!.requirements).toBe("# The requirements");

        } finally {

            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("fails a required file input with the path named", () => {

        const dir = workspaceWith({});

        try {

            const { context } = harness();

            const resolved = hostWith().resolveInputs(
                task({ args: { requirements: { file: "requirements.md" } } }),
                { ...context, workspace: dir });

            // The declaration is the precondition: a phase must not run
            // without the document it builds on, and the failure names
            // exactly what is missing.
            expect(resolved.success).toBe(false);
            expect(resolved.message).toContain("requirements");
            expect(resolved.message).toContain("requirements.md");
            expect(resolved.message).toContain("does not exist");

        } finally {

            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("resolves an optional missing file to an empty string", () => {

        const dir = workspaceWith({});

        try {

            const { context } = harness();

            const resolved = hostWith().resolveInputs(
                task({ args: { principles: { file: "principles.md", optional: true } } }),
                { ...context, workspace: dir });

            expect(resolved.success).toBe(true);
            expect(resolved.args!.principles).toBe("");

        } finally {

            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("resolves templates inside the path", () => {

        const dir = workspaceWith({ "design.md": "the design" });

        try {

            const { context } = harness();

            const resolved = hostWith().resolveInputs(
                task({
                    vars: { doc: "design.md" },
                    args: { design: { file: "${{ vars.doc }}" } }
                }),
                { ...context, workspace: dir, vars: { doc: "design.md" } });

            expect(resolved.success).toBe(true);
            expect(resolved.args!.design).toBe("the design");

        } finally {

            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects a file input carrying an unknown key", () => {

        const { context } = harness();

        const resolved = hostWith().resolveInputs(
            task({ args: { requirements: { file: "requirements.md", optionall: true } } }),
            context);

        expect(resolved.success).toBe(false);
        expect(resolved.message).toContain("optionall");
    });

    it("rejects an 'optional:' that is not a boolean", () => {

        const { context } = harness();

        const resolved = hostWith().resolveInputs(
            task({ args: { requirements: { file: "requirements.md", optional: "yes" } } }),
            context);

        expect(resolved.success).toBe(false);
        expect(resolved.message).toContain("optional");
    });

    describe("undeclared args", () => {

        const declared = { greeting: { type: "string" as const } };

        it("rejects one by default, naming it and what the plugin does accept", () => {

            const plugin = fake(async () => ({ success: true }), { args: declared });
            const { context } = harness();

            const resolved = hostWith(plugin).resolveInputs(
                task({ plugin: "fake@1", args: { greeting: "hi", greetng: "typo" } }),
                context);

            expect(resolved.success).toBe(false);
            expect(resolved.message).toContain("greetng");
            expect(resolved.message).toContain("greeting");
        });

        it("hands one over when the plugin declares passthrough", () => {

            const plugin = fake(async () => ({ success: true }), { args: declared, passthrough: true });
            const { context } = harness();

            const resolved = hostWith(plugin).resolveInputs(
                task({ plugin: "fake@1", args: { greeting: "hi", contextTier: "long_context" } }),
                context);

            expect(resolved.success).toBe(true);
            expect(resolved.args).toEqual({ greeting: "hi", contextTier: "long_context" });
        });

        it("still checks the args the plugin does declare", () => {

            const plugin = fake(async () => ({ success: true }), { args: declared, passthrough: true });
            const { context } = harness();

            const resolved = hostWith(plugin).resolveInputs(
                task({ plugin: "fake@1", args: { greeting: 3, whatever: "fine" } }),
                context);

            expect(resolved.success).toBe(false);
            expect(resolved.message).toContain("greeting");
        });
    });
});

import { describe, expect, it } from "vitest";
import { aiFor, aiSourcesFor, configFromSettings, DEFAULT_PROVIDER, Defaults, SddSettingsSlice, SPEC_ROOT } from "../sddConfig";

/** The slice a caller hands over - the `sdd:` section plus the ai plugin defaults. */
function slice(sdd?: Record<string, unknown>, aiDefaults?: SddSettingsSlice["aiDefaults"]): SddSettingsSlice {

    return { sdd, aiDefaults };
}

describe("no settings at all", () => {

    /* Nothing on disk and New Spec still works. */
    it("is a working configuration", () => {

        expect(configFromSettings(undefined)).toEqual(Defaults);
        expect(configFromSettings(slice())).toEqual(Defaults);
        expect(configFromSettings(slice({}))).toEqual(Defaults);
    });

    it("hands back a copy, so one reader cannot edit another's defaults", () => {

        const config = configFromSettings(undefined);

        config.ai.args.model = "poisoned";

        expect(configFromSettings(undefined).ai.args.model).toBe("auto");
        expect(Defaults.ai.args.model).toBe("auto");
    });
});

describe("settings", () => {

    it("leaves source unset when the section does not say, so New Spec asks", () => {

        expect(configFromSettings(undefined).source).toBeUndefined();
        expect(configFromSettings(slice({ styles: ["kiro"] })).source).toBeUndefined();
        expect(configFromSettings(slice({ source: "ado" })).source).toBe("ado");
        expect(configFromSettings(slice({ source: "file" })).source).toBe("file");
    });

    it("reads the whole section", () => {

        const config = configFromSettings(slice({
            styles: ["spec-kit", "kiro"],
            source: "ado"
        }));

        expect(config).toMatchObject({
            styles: ["spec-kit", "kiro"],
            source: "ado"
        });
    });

    it("keeps the default for every key the section omits", () => {

        expect(configFromSettings(slice({ source: "gh" }))).toEqual({ ...Defaults, source: "gh" });
    });

    it("places specs at the default root when specsDir says nothing", () => {

        expect(configFromSettings(undefined).specRoot).toBe(SPEC_ROOT);
        expect(configFromSettings(slice({ styles: ["kiro"] })).specRoot).toBe(".eesha/specs");
    });

    it("takes specsDir as the root, relative or absolute", () => {

        expect(configFromSettings(slice({ specsDir: "docs/specs" })).specRoot).toBe("docs/specs");
        expect(configFromSettings(slice({ specsDir: "C:/code/spec-vault" })).specRoot).toBe("C:/code/spec-vault");
    });

    it("refuses a specsDir that is not text", () => {

        expect(() => configFromSettings(slice({ specsDir: 7 }))).toThrow(/'sdd.specsDir' must be text/);
        expect(() => configFromSettings(slice({ specsDir: "  " }))).toThrow(/'sdd.specsDir' must be text/);
    });

    it("reads the wait between implementation sessions, 10 seconds when not given", () => {

        expect(configFromSettings(slice({})).nextSessionDelaySeconds).toBe(10);
        expect(configFromSettings(slice({ nextSessionDelaySeconds: 0 })).nextSessionDelaySeconds).toBe(0);
        expect(configFromSettings(slice({ nextSessionDelaySeconds: 30 })).nextSessionDelaySeconds).toBe(30);

        for (const bad of [-1, 2.5, "10"])
            expect(() => configFromSettings(slice({ nextSessionDelaySeconds: bad })))
                .toThrow(/'sdd.nextSessionDelaySeconds' must be a whole number of seconds/);
    });

    it("names the allowed values when given one that is not", () => {

        expect(() => configFromSettings(slice({ source: "jira" }))).toThrow(/'manual', 'ado', 'gh', 'file'/);
    });

    /* Loud - a misspelled key silently doing nothing is how a setting looks applied and is not. */
    it("refuses an unknown key, listing the valid ones", () => {

        expect(() => configFromSettings(slice({ specRoot: "docs/specs" })))
            .toThrow(/unknown key 'sdd.specRoot'.*styles, specsDir, source, uses/);
    });

    it("refuses a styles that is not a non-empty list of ids", () => {

        expect(() => configFromSettings(slice({ styles: "kiro" }))).toThrow(/'sdd.styles' must be a non-empty list/);
        expect(() => configFromSettings(slice({ styles: [] }))).toThrow(/'sdd.styles' must be a non-empty list/);
        expect(() => configFromSettings(slice({ styles: ["kiro", 7] }))).toThrow(/'sdd.styles' must be a non-empty list/);
    });
});

/* `args` is unenumerated on purpose: the plugin owns its input schema. */
describe("ai settings", () => {

    it("defaults uses to ai@1 and takes that plugin's defaults as the args", () => {

        const config = configFromSettings(slice(
            undefined,
            { "ai@1": { model: "claude-opus-5", thinking: "high", somethingInventedLater: 7 } }));

        expect(config.ai.uses).toBe("ai@1");
        expect(config.ai.args).toEqual({
            model: "claude-opus-5",
            thinking: "high",
            somethingInventedLater: 7
        });
    });

    /* `sdd.uses` picks the plugin, and the defaults follow the pick. */
    it("takes the named plugin's defaults when sdd.uses points elsewhere", () => {

        const config = configFromSettings(slice(
            { uses: "eesha@1" },
            {
                "ai@1": { model: "not-this-one" },
                "eesha@1": { model: "this-one" }
            }));

        expect(config.ai.uses).toBe("eesha@1");
        expect(config.ai.args.model).toBe("this-one");
    });

    it("gives a phase the defaults when the style says nothing", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "auto" } }));

        expect(aiFor(config)).toEqual({ uses: "ai@1", args: { model: "auto" } });
    });

    /* Merged per key, not per block, so a stage naming only `thinking` keeps the default model. */
    it("merges a stage's own settings over the defaults one input at a time", () => {

        const config = configFromSettings(slice(
            undefined, { "ai@1": { model: "auto", temperatureLikeThing: 1 } }));

        expect(aiFor(config, { thinking: "high" }).args)
            .toEqual({ model: "auto", temperatureLikeThing: 1, thinking: "high" });
    });

    it("takes the plugin from the section and nowhere else", () => {

        const config = configFromSettings(slice({ uses: "eesha@1" }, { "eesha@1": { model: "claude-opus-5" } }));

        expect(aiFor(config)).toEqual({ uses: "eesha@1", args: { model: "claude-opus-5" } });
    });

    /*
     * The engine's default states no provider, so the per-key merge
     * cannot pass one to a team running a different plugin. `ai@1`'s
     * manifest supplies it.
     */
    it("states no provider of its own, so another plugin cannot inherit one", () => {

        const config = configFromSettings(slice({ uses: "eesha@1" }));

        expect(config.ai.args).not.toHaveProperty("provider");
        expect(aiFor(config).args).not.toHaveProperty("provider");
    });

    it("passes a provider the defaults state through to the plugin", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { provider: "acme" } }));

        expect(config.ai.args.provider).toBe("acme");
    });
});

/* Two layers: the section default, then the stage's `ai:`. */
describe("what a phase runs on", () => {

    it("takes the stage's own settings over the blanket default", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "auto" } }));

        expect(aiFor(config, { model: "opus" }).args).toEqual({ model: "opus" });
    });

    it("keeps what the stage did not mention", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "auto", provider: "acme" } }));

        expect(aiFor(config, { reasoningEffort: "high" }).args)
            .toEqual({ model: "auto", provider: "acme", reasoningEffort: "high" });
    });

    /* The parser refuses `ai.uses`; even handed one, the merge does not read it. */
    it("never takes the plugin from the stage", () => {

        const config = configFromSettings(slice({ uses: "eesha@1" }));

        expect(aiFor(config, { uses: "nope@9" } as Record<string, unknown>).uses).toBe("eesha@1");
    });

    it("is the plain defaults for a stage with no opinion", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "auto" } }));

        expect(aiFor(config, undefined)).toEqual(aiFor(config));
    });
});

/*
 * The person's pick from the panel's compose row. It beats every file,
 * including a stage that pins its own runtime - that is what it is for.
 */
describe("the person's pick", () => {

    const pick = { provider: "kiro-cli", model: "auto" };

    it("beats settings.json, the style and the stage", () => {

        const config = configFromSettings(
            slice(undefined, { "ai@1": { model: "gpt-5", provider: "ghcp" } }), pick);

        expect(aiFor(config, { provider: "claude" }, { provider: "ghcp", model: "gpt-5-mini" }).args)
            .toEqual({ provider: "kiro-cli", model: "auto" });
    });

    it("leaves every other arg where the files put it", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { reasoningEffort: "high" } }), pick);

        expect(aiFor(config, undefined, { contextTier: "long_context" }).args)
            .toEqual({ model: "auto", reasoningEffort: "high", provider: "kiro-cli", contextTier: "long_context" });
    });

    it("is not there when nobody picked", () => {

        const config = configFromSettings(slice());

        expect(config.aiPick).toBeUndefined();
        expect(aiFor(config, undefined, { provider: "claude" }).args.provider).toBe("claude");
    });

    it("carries a picked mode to ai@1 as agentMode, and nothing when none was picked", () => {

        const withMode = configFromSettings(slice(), { provider: "kiro-cli-v3", mode: "spec" });

        expect(aiFor(withMode).args.agentMode).toBe("spec");
        expect(aiFor(configFromSettings(slice(), pick)).args).not.toHaveProperty("agentMode");
    });

    it("carries a picked effort to ai@1 as effort, and nothing when none was picked", () => {

        const withEffort = configFromSettings(slice(), { provider: "claude", model: "sonnet", effort: "high" });

        expect(aiFor(withEffort).args.effort).toBe("high");
        expect(aiFor(configFromSettings(slice(), pick)).args).not.toHaveProperty("effort");
    });

    it("sends no effort on auto, where the picker is hidden", () => {

        expect(aiFor(configFromSettings(slice(), { provider: "claude", model: "auto", effort: "high" })).args)
            .not.toHaveProperty("effort");
        expect(aiFor(configFromSettings(slice(), { provider: "claude", effort: "high" })).args)
            .not.toHaveProperty("effort");
    });
});

/*
 * `providers:` blocks: only the running runtime's block is used, over
 * that layer's flat keys, and the pick switches which block that is.
 */
describe("providers: blocks", () => {

    const settings = {
        "ai@1": {
            provider: "ghcp",
            providers: {
                ghcp: { model: "gpt-5.2", reasoningSummary: "concise" },
                "kiro-cli": { model: "claude-sonnet-4.5" }
            }
        }
    };

    it("uses the running runtime's block and drops the rest", () => {

        const config = configFromSettings(slice(undefined, settings));

        expect(aiFor(config).args).toEqual({ provider: "ghcp", model: "gpt-5.2", reasoningSummary: "concise" });
    });

    it("switches block with the pick, so Copilot's options stay behind", () => {

        const config = configFromSettings(slice(undefined, settings), { provider: "kiro-cli" });

        expect(aiFor(config).args).toEqual({ provider: "kiro-cli", model: "claude-sonnet-4.5" });
    });

    it("puts a layer's block over its own flat keys, and a higher layer over both", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "auto" } }));

        const style = { reasoningEffort: "low", providers: { ghcp: { reasoningEffort: "high", model: "gpt-5.2" } } };
        const stage = { providers: { ghcp: { reasoningEffort: "xhigh" } } };

        expect(aiFor(config, style, stage).args)
            .toEqual({ model: "gpt-5.2", reasoningEffort: "xhigh" });
    });

    /* Every runtime inherits the flat keys, model included (chosen on purpose). */
    it("keeps the flat model under a pick of a runtime alone", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "gpt-5.2" } }), { provider: "kiro-cli" });

        expect(aiFor(config).args.model).toBe("gpt-5.2");
    });

    it("keeps a model picked by hand over every block", () => {

        const config = configFromSettings(slice(undefined, settings), { provider: "kiro-cli", model: "claude-opus-4" });

        expect(aiFor(config).args.model).toBe("claude-opus-4");
    });

    it("refuses a block for a runtime that is not registered", () => {

        const config = configFromSettings({ ...slice(), acpAgents: { "kiro-cli": {} } });

        expect(() => aiFor(config, { providers: { kiro: { model: "x" } } }))
            .toThrow(/'kiro', which is not a registered runtime\. Registered: ghcp, claude, kiro-cli/);
    });

    it("names the block's model and its layer in the picker", () => {

        const config = configFromSettings(slice(undefined, settings), { provider: "kiro-cli" });

        expect(aiSourcesFor(config)).toEqual({
            provider: "kiro-cli", providerFrom: "pick", model: "claude-sonnet-4.5", modelFrom: "settings"
        });

        expect(aiSourcesFor(configFromSettings(slice(undefined, settings)), { providers: { ghcp: { model: "gpt-5-mini" } } }))
            .toMatchObject({ model: "gpt-5-mini", modelFrom: "style" });
    });
});

/*
 * The order with the two settings files apart:
 * workspace settings, the style, profile settings, the pick.
 */
describe("the profile beats the workspace", () => {

    const scoped = (workspace: Record<string, unknown>, profile: Record<string, unknown>, providers?: string[]) =>
        configFromSettings({
            ...slice(undefined, { "ai@1": { ...workspace, ...profile } }),
            aiScopedDefaults: { workspace: { "ai@1": workspace }, profile: { "ai@1": profile } },
            acpAgents: { "kiro-cli": {} },
            ...(providers ? { providers } : {})
        });

    it("puts the person's settings over a workspace style", () => {

        const config = scoped({ model: "team" }, { model: "mine" });

        expect(aiFor(config, { model: "style" }, undefined, "workspace").args.model).toBe("mine");
    });

    it("puts the style over the team's settings", () => {

        const config = scoped({ model: "team" }, {});

        expect(aiFor(config, { model: "style" }, undefined, "workspace").args.model).toBe("style");
    });

    it("puts a style kept in the profile over the person's settings too", () => {

        const config = scoped({}, { model: "mine" });

        expect(aiFor(config, undefined, { model: "stage" }, "profile").args.model).toBe("stage");
    });

    /* A higher layer's flat key beats a lower layer's block. */
    it("lets a style's flat key beat the team's block", () => {

        const config = scoped({ providers: { ghcp: { model: "gpt-5.2" } } }, {});

        expect(aiFor(config, { model: "sonnet" }, undefined, "workspace").args.model).toBe("sonnet");
    });

    it("names the person's settings in the picker when they win", () => {

        const config = scoped({ model: "team" }, { model: "mine" });

        expect(aiSourcesFor(config, { model: "style" }, undefined, "workspace"))
            .toMatchObject({ model: "mine", modelFrom: "settings" });
    });

    describe("with ai.providers listed", () => {

        it("refuses a block for a runtime not on the list", () => {

            const config = scoped({}, {}, ["ghcp"]);

            expect(() => aiFor(config, { providers: { "kiro-cli": { model: "x" } } }))
                .toThrow(/'kiro-cli', which is not a registered runtime\. Registered: ghcp\./);
        });

        it("refuses a style that names a runtime not on the list", () => {

            const config = scoped({}, {}, ["ghcp"]);

            expect(() => aiFor(config, { provider: "kiro-cli" }))
                .toThrow(/set to run on 'kiro-cli' \(the style's ai: in style\.yml\), which is not in ai\.providers/);
        });

        it("ignores a pick of a runtime no longer on the list", () => {

            const config = configFromSettings({
                ...slice(undefined, { "ai@1": { provider: "ghcp" } }),
                providers: ["ghcp"]
            }, { provider: "kiro-cli" });

            expect(aiFor(config).args.provider).toBe("ghcp");
            expect(aiSourcesFor(config).providerFrom).toBe("settings");
        });

        it("lets a listed runtime with no block take every flat value", () => {

            const config = configFromSettings({
                ...slice(undefined, { "ai@1": { model: "sonnet", providers: { ghcp: { reasoningEffort: "high" } } } }),
                providers: ["ghcp", "kiro-cli"]
            }, { provider: "kiro-cli" });

            expect(aiFor(config).args).toEqual({ provider: "kiro-cli", model: "sonnet" });
        });
    });
});

/*
 * Which layer a picker's value came from. The picker shows the value
 * in effect and has to say why, so the ladder is walked from the top.
 */
describe("where a phase's runtime and model come from", () => {

    it("is the plugin's default when nobody says", () => {

        expect(aiSourcesFor(configFromSettings(slice()))).toEqual({
            provider: DEFAULT_PROVIDER, providerFrom: "default", model: "auto", modelFrom: "default"
        });
    });

    it("is the default even when settings.json spells out `auto`", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { model: "auto" } }));

        expect(aiSourcesFor(config).modelFrom).toBe("default");
    });

    it("names settings.json, the style and the stage, each over the last", () => {

        const config = configFromSettings(slice(undefined, { "ai@1": { provider: "ghcp", model: "gpt-5" } }));

        expect(aiSourcesFor(config)).toMatchObject({ providerFrom: "settings", modelFrom: "settings" });
        expect(aiSourcesFor(config, { provider: "claude" }))
            .toMatchObject({ provider: "claude", providerFrom: "style", model: "gpt-5", modelFrom: "settings" });
        expect(aiSourcesFor(config, { provider: "claude" }, { model: "opus" }))
            .toMatchObject({ provider: "claude", providerFrom: "style", model: "opus", modelFrom: "stage" });
    });

    it("names the pick over all of them", () => {

        const config = configFromSettings(
            slice(undefined, { "ai@1": { provider: "ghcp" } }), { provider: "kiro-cli", model: "auto" });

        expect(aiSourcesFor(config, undefined, { provider: "claude", model: "opus" })).toEqual({
            provider: "kiro-cli", providerFrom: "pick", model: "auto", modelFrom: "pick"
        });
    });
});

describe("the fake runtime in SDD", () => {

    const agents: SddSettingsSlice = { acpAgents: { kiro: {} } };

    it("keeps a fake pick when the fakeRuntime flag is on", () => {

        const config = configFromSettings({ ...agents, fakeRuntime: true }, { provider: "fake" });

        expect(config.providerIds).toContain("fake");
        expect(aiFor(config).args.provider).toBe("fake");
    });

    it("adds it to a listed ai.providers too, once", () => {

        expect(configFromSettings({ providers: ["claude"], fakeRuntime: true }).providerIds).toEqual(["claude", "fake"]);
        expect(configFromSettings({ providers: ["fake"], fakeRuntime: true }).providerIds).toEqual(["fake"]);
    });

    it("drops a fake pick when the flag is off", () => {

        const config = configFromSettings(agents, { provider: "fake" });

        expect(config.providerIds).not.toContain("fake");
        expect(aiFor(config).args.provider).not.toBe("fake");
    });
});

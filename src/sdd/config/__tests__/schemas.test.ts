import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { Defaults, EngineArgs, Sources } from "../sddConfig";

/**
 * The JSON schemas only help while they say the same thing the parsers
 * do, so the agreement is asserted rather than trusted.
 */

const root = path.resolve(__dirname, "..", "..", "..", "..");

function schema(name: string): any {

    return JSON.parse(fs.readFileSync(path.join(root, "resources", "schemas", `${name}.schema.json`), "utf8"));
}

/** The style schema, read from its file. */
function styleSchema(): any {

    return schema("sdd-style");
}

describe("the settings schema's sdd section", () => {

    const sdd = schema("settings").properties.sdd;

    /*
     * Through `anyOf`, because a ${{ }} expression is accepted wherever a
     * literal is. Read by shape rather than by index so the values
     * themselves are still asserted.
     */
    it("offers exactly the values the parser accepts", () => {

        expect(valuesOf(sdd.properties.source)).toEqual([...Sources]);
    });

    /** Every literal a key accepts, whether it is declared flat or as one branch of an `anyOf`. */
    function valuesOf(property: any): string[] | undefined {

        return property.enum ?? property.anyOf?.find((branch: any) => branch.enum)?.enum;
    }

    it("advertises the defaults the parser actually applies", () => {

        expect(sdd.properties.styles.default).toEqual(Defaults.styles);
        expect(sdd.properties.uses.default).toBe(Defaults.ai.uses);
    });

    /* No `stages`: per-phase settings are a stage's `ai:` in style.yml. */
    it("names every key the parser reads and no key it would reject", () => {

        expect(Object.keys(sdd.properties).sort())
            .toEqual(["nextSessionDelaySeconds", "source", "specsDir", "styles", "uses"]);
    });

    /*
     * Asserted on the resolved shape, not the `$ref`: a reference to a
     * closed object would pass a literal comparison. ai@1 is a
     * passthrough plugin, so a listed key is a suggestion, not a
     * whitelist.
     */
    it("leaves a plugin's defaults open, since the plugin owns its input list", () => {

        expect(argShape().additionalProperties).toBe(true);
    });

    it("suggests the args every plugin default takes, whatever it runs on", () => {

        const args = Object.keys(argShape().properties);

        for (const key of ["provider", "model", "mcp"])
            expect(args).toContain(key);
    });

    /*
     * A provider's own args are offered only to a block running on it,
     * so a Claude block is not told about ghcp's `reasoningEffort`. The
     * schema cannot see a provider inherited from `ai."ai@1"`, only one
     * written in the block itself - a block that says nothing gets
     * ghcp's, which is the manifest default it would run on anyway.
     * `StageArgsCompletionProvider` covers the inherited case, reading
     * the sibling section a schema cannot.
     */
    it("hangs ghcp's own args off the provider the block declares", () => {

        const args = Object.keys(ghcpShape().properties);

        for (const key of ["reasoningEffort", "contextTier", "reasoningSummary", "enableExperimentalMode"])
            expect(args).toContain(key);

        expect(Object.keys(argShape().properties)).not.toContain("reasoningEffort");

        // One branch for a block that declares ghcp, one for a block
        // that declares no provider at all.
        expect(argShape().allOf.map((branch: any) => branch.then.$ref))
            .toEqual(["#/$defs/ghcpArgs", "#/$defs/ghcpArgs"]);

        expect(argShape().allOf[0].if.properties.provider.const).toBe("ghcp");
        expect(argShape().allOf[1].if.not.required).toEqual(["provider"]);
    });

    /* Still a suggestion list: an arg the schema does not offer here is not thereby illegal. */
    it("keeps a ghcp arg legal in a block it is not offered to", () => {

        expect(argShape().additionalProperties).toBe(true);
    });

    /*
     * Inside `ai."ai@1"` the plugin is the key, so `uses` means nothing
     * there and would reach the provider as a stray arg.
     */
    it("does not suggest uses inside a plugin's own defaults", () => {

        expect(Object.keys(argShape().properties)).not.toContain("uses");
    });

    function argShape(): any {

        const settings = schema("settings");

        return settings.$defs.aiArgs;
    }

    function ghcpShape(): any {

        return schema("settings").$defs.ghcpArgs;
    }
});

describe("the settings schema's ai section", () => {

    const ai = schema("settings").properties.ai;

    it("leaves plugin defaults open, since each plugin owns its input list", () => {

        expect(ai.additionalProperties).not.toBe(false);
    });

    it("declares the engine's own server key", () => {

        const server = ai.properties.mcpServers.additionalProperties.properties;

        expect(server).toHaveProperty("disabled");
    });

    it("declares the mcp selection on the ai@1 defaults", () => {

        const args = schema("settings").$defs.aiArgs.properties;

        expect(args).toHaveProperty("mcp");
        expect(schema("settings").$defs.mcpSelection.properties).toHaveProperty("servers");
        expect(schema("settings").$defs.mcpSelection.properties).toHaveProperty("tools");
    });
});

describe("the style schema", () => {

    const style = styleSchema();

    it("names every key the parser reads and no key it would reject", () => {

        // No `idea` key: idea is a stage like any other, declared in
        // `stages:` and placed by a spec type's list.
        expect(Object.keys(style.properties).sort())
            .toEqual([
                "ai", "attachments", "blockOnOpenQuestions", "desc", "id", "name", "presets", "schema",
                "specTypes", "specsDir", "stages"
            ]);

        expect(Object.keys(style.properties.stages.items.properties).sort())
            .toEqual(["actionable", "ai", "attachments", "id", "instructions", "label", "prefix", "presets", "produces"]);
    });

    /*
     * A stage's `presets:` and the style's own share their shape through
     * `$ref`, the way `ai:` does - one definition, two sites.
     */
    it("gives a preset exactly label and text, on both sites", () => {

        expect(style.$defs.presets.items.required).toEqual(["label", "text"]);
        expect(style.$defs.presets.items.additionalProperties).toBe(false);
        expect(style.$defs.presets.minItems).toBe(1);
        expect(style.properties.presets.allOf).toEqual([{ $ref: "#/$defs/presets" }]);
        expect(style.properties.stages.items.properties.presets.allOf).toEqual([{ $ref: "#/$defs/presets" }]);
    });

    it("accepts a bare string where the parser accepts one", () => {

        expect(style.properties.stages.items.properties.produces.oneOf).toContainEqual({ type: "string" });
    });

    /*
     * An author copying the shipped style as an example must not see a
     * schema warning on valid YAML.
     */
    it("describes the shipped custom style without a stray key", () => {

        const custom = parse(fs.readFileSync(path.join(root, "resources", "styles", "custom", "style.yml"), "utf8"));

        expect(Object.keys(custom).every(key => key in style.properties)).toBe(true);

        for (const stage of custom.stages ?? [])
            expect(Object.keys(stage).every(key => key in style.properties.stages.items.properties)).toBe(true);

        for (const specType of custom.specTypes)
            expect(Object.keys(specType).every(key => key in style.properties.specTypes.items.properties)).toBe(true);
    });
});

/*
 * A stage's `ai:` in style.yml takes what `ai."<plugin>"` takes, minus
 * `uses` - which plugin runs a phase is the team's call, so the style
 * cannot name one.
 */
describe("the ai arg surfaces", () => {

    // The property site, for the description tests - a stage's `ai:`
    // and the style's own top-level `ai:` share their shape through
    // `$ref`, so what a person reads while typing lives on the
    // reference site, not the shared definition.
    const styleStageAi = () => schema("sdd-style").properties.stages.items.properties.ai;
    const styleTopAi = () => schema("sdd-style").properties.ai;

    // Asserted on the resolved shape, not the `$ref` - same reason the
    // settings-schema tests above resolve through `$defs.aiArgs` rather
    // than the reference site.
    const aiArgs = () => schema("sdd-style").$defs.aiArgs;

    const ghcpArgs = () => schema("sdd-style").$defs.ghcpArgs;

    /* ai@1 is a passthrough plugin, so a listed key is a suggestion and never a whitelist. */
    it("leaves the style's ai block open, as the settings entry is", () => {

        expect(aiArgs().additionalProperties).toBe(true);
    });

    it("suggests the same args a settings entry does", () => {

        const suggested = Object.keys(aiArgs().properties);

        for (const key of ["provider", "model"])
            expect(suggested).toContain(key);
    });

    /*
     * Narrowed the same way the settings schema is, and with the same
     * limit: only a `provider:` written in this block counts. A style
     * stage almost always inherits one from settings.json instead, and
     * that is a file this schema cannot see at all - so a stage that
     * names no provider is offered ghcp's args, and the run-time
     * narrowing is the completion provider's job.
     */
    it("hangs ghcp's own args off the provider the block declares", () => {

        expect(Object.keys(ghcpArgs().properties)).toContain("reasoningEffort");

        expect(Object.keys(aiArgs().properties)).not.toContain("reasoningEffort");

        expect(aiArgs().allOf.map((branch: any) => branch.then.$ref))
            .toEqual(["#/$defs/ghcpArgs", "#/$defs/ghcpArgs"]);

        expect(aiArgs().allOf[0].if.properties.provider.const).toBe("ghcp");
        expect(aiArgs().allOf[1].if.not.required).toEqual(["provider"]);
    });

    /* The parser refuses it too. */
    it("does not offer uses, which settings owns", () => {

        expect(Object.keys(aiArgs().properties)).not.toContain("uses");
    });

    /* Every refusal the parser makes should be visible while typing, not only at load. */
    it("says which args the engine writes, so the refusal is not a surprise", () => {

        for (const key of Object.keys(EngineArgs))
            expect(styleStageAi().description).toContain(key);
    });

    /* The style-wide default is the same shape a stage's own `ai:` is - one definition, two reference sites. */
    it("gives the style's own top-level ai: the same shape as a stage's", () => {

        expect(styleTopAi().allOf).toEqual(styleStageAi().allOf);
    });
});

/*
 * The `tasks.yml` and `workflows/*.yml` schemas spell out the args of the
 * four plugins a file writes by hand, so `args:` completes as you type. A
 * plugin's manifest is the only truth about its args, and nothing
 * generates these blocks. An arg left out of both schemas costs no
 * error (`additionalProperties` is open there) but silently loses its
 * completion. Asserted here so no arg goes missing.
 */
describe("the task schemas' plugin arg blocks", () => {

    /** Each `args_<id>_1` definition, and the manifest that owns it. */
    const plugins = {
        ai: path.join(root, "src", "core", "agent", "aiV1", "plugin.json"),
        file: path.join(root, "src", "plugins", "fileV1", "plugin.json"),
        pwsh: path.join(root, "src", "plugins", "pwshV1", "plugin.json"),
        shell: path.join(root, "src", "plugins", "shellV1", "plugin.json")
    };

    function manifestArgs(file: string): string[] {

        return JSON.parse(fs.readFileSync(file, "utf8")).args.map((arg: any) => arg.name);
    }

    for (const file of ["tasks", "workflow"])
        for (const [id, manifest] of Object.entries(plugins))

            /* Order too: the list is read top to bottom by a person comparing it against the manifest. */
            it(`lists every ${id}@1 arg in the ${file} schema, in the manifest's order`, () => {

                const declared = schema(file).definitions[`args_${id}_1`].properties;

                expect(Object.keys(declared)).toEqual(manifestArgs(manifest));
            });

    /** Every literal a key accepts, flat or through the `anyOf` that also allows a `${{ }}` expression. */
    function valuesOf(property: any): string[] | undefined {

        return property.enum ?? property.anyOf?.find((branch: any) => branch.enum)?.enum;
    }

    /* An arg the manifest gives a fixed list of values should complete to those values, not to any string. */
    it("offers a manifest's own options as the arg's values", () => {

        for (const [id, manifest] of Object.entries(plugins))
            for (const arg of JSON.parse(fs.readFileSync(manifest, "utf8")).args)
                if (arg.options)
                    expect(valuesOf(schema("tasks").definitions[`args_${id}_1`].properties[arg.name]))
                        .toEqual(arg.options);
    });
});

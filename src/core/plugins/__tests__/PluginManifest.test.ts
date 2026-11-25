import { describe, expect, it } from "vitest";
import {
    PluginManifest,
    PluginManifestError,
    folderNameFor,
    pluginFromManifest,
    versionString
} from "../PluginManifest";

// `plugin.json`, when present, is authoritative over the id and
// version a plugin's own JavaScript exports.

const noop = async () => ({ success: true });

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {

    return {
        id: "deployer",
        version: { major: 2, minor: 4, patch: 1 },
        ...overrides
    };
}

describe("a plugin manifest", () => {

    it("carries id, description, artifacts and secrets straight through", () => {

        const plugin = pluginFromManifest(manifest({
            description: "Deploys things.",
            artifacts: ["url"],
            secrets: ["DEPLOY_TOKEN"]
        }), noop);

        expect(plugin.id).toBe("deployer");
        expect(plugin.description).toBe("Deploys things.");
        expect(plugin.artifacts).toEqual(["url"]);
        expect(plugin.secrets).toEqual(["DEPLOY_TOKEN"]);
    });

    it("turns its ordered args into the schema the engine validates against", () => {

        const plugin = pluginFromManifest(manifest({
            args: [
                { name: "target", type: "string", label: "Target", required: true },
                { name: "dryRun", type: "boolean", label: "Dry run", default: false }
            ]
        }), noop);

        expect(plugin.args).toEqual({
            target: { type: "string", required: true, description: "Target", default: undefined },
            dryRun: { type: "boolean", required: undefined, description: "Dry run", default: false }
        });
    });

    it("prefers an input's description over its label, since the label is only a caption", () => {

        const plugin = pluginFromManifest(manifest({
            args: [{ name: "target", type: "string", label: "Target", description: "Where to deploy." }]
        }), noop);

        expect(plugin.args!.target.description).toBe("Where to deploy.");
    });

    // A choice is a string with a shorter list of legal values, not a
    // type of its own.
    describe("an input constrained to options", () => {

        it("carries them into the schema", () => {

            const plugin = pluginFromManifest(manifest({
                args: [{ name: "mode", type: "string", options: ["fast", "careful"] }]
            }), noop);

            expect(plugin.args!.mode.options).toEqual(["fast", "careful"]);
        });

        it("carries the multiline hint too, so a form can draw a multi-line box", () => {

            const plugin = pluginFromManifest(manifest({
                args: [{ name: "script", type: "string", multiline: true }]
            }), noop);

            expect(plugin.args!.script.multiline).toBe(true);
        });

        it("rejects options on anything but a string", () => {

            expect(() => pluginFromManifest(manifest({
                args: [{ name: "retries", type: "number", options: ["1", "2"] as string[] }]
            }), noop)).toThrow(PluginManifestError);
        });

        it("rejects an empty option list", () => {

            expect(() => pluginFromManifest(manifest({
                args: [{ name: "mode", type: "string", options: [] }]
            }), noop)).toThrow(PluginManifestError);
        });

        it("rejects a default that is not one of them", () => {

            expect(() => pluginFromManifest(manifest({
                args: [{ name: "mode", type: "string", options: ["fast"], default: "careful" }]
            }), noop)).toThrow(/careful/);
        });

        it("accepts a default that is", () => {

            expect(() => pluginFromManifest(manifest({
                args: [{ name: "mode", type: "string", options: ["fast"], default: "fast" }]
            }), noop)).not.toThrow();
        });
    });

    // Lets a workflow name the variable a credential comes from,
    // instead of the plugin fixing one name for everyone.
    describe("a secret named by an arg", () => {

        it("carries the input's name through to the plugin", () => {

            const plugin = pluginFromManifest(manifest({
                args: [{ name: "patEnv", type: "string", default: "ADO_PAT" }],
                secretsFrom: "patEnv"
            }), noop);

            expect(plugin.secretsFrom).toBe("patEnv");
        });

        // Otherwise the plugin loads, the task runs, and the credential is
        // simply absent - reported against a variable the user did set.
        it("refuses one that names no arg", () => {

            expect(() => pluginFromManifest(manifest({
                args: [{ name: "patEnv", type: "string" }],
                secretsFrom: "tokenEnv"
            }), noop)).toThrow(/no arg by that name/);
        });

        it("refuses one that names an input which is not a string", () => {

            expect(() => pluginFromManifest(manifest({
                args: [{ name: "patEnv", type: "number" }],
                secretsFrom: "patEnv"
            }), noop)).toThrow(/has to be a string/);
        });
    });

});

// The version is split into three so a workflow can pin the major
// alone: a fix ships to everyone, and a breaking change forces a new
// major, folder, and reference.
describe("versioning", () => {

    it("resolves a reference by major alone, so minor and patch can move underneath it", () => {

        expect(pluginFromManifest(manifest(), noop).version).toBe("2");
    });

    it("still reports the full version for a human", () => {

        expect(versionString({ major: 2, minor: 4, patch: 1 })).toBe("2.4.1");
    });

    it("names the folder a plugin belongs in", () => {

        expect(folderNameFor(manifest())).toBe("deployerV2");
    });

    it("accepts a plugin sitting in the folder its version implies", () => {

        expect(() => pluginFromManifest(manifest(), noop, "deployerV2")).not.toThrow();
    });

    // Otherwise `uses: deployer@2` would resolve to a folder labelled
    // v1, and the directory listing - the thing you actually look at -
    // would be lying about which major is installed.
    it("refuses a plugin whose folder disagrees with its manifest", () => {

        expect(() => pluginFromManifest(manifest(), noop, "deployerV1"))
            .toThrow(/folder named 'deployerV1'.*belongs in 'deployerV2'/s);
    });

    it("refuses major 0, because there is no such reference", () => {

        expect(() => pluginFromManifest(manifest({ version: { major: 0, minor: 1, patch: 0 } }), noop))
            .toThrow(/no 'uses: deployer@0'/);
    });

    it("refuses a version that is not three whole numbers", () => {

        expect(() => pluginFromManifest(
            manifest({ version: { major: 1, minor: 2 } as never }), noop))
            .toThrow(PluginManifestError);
    });

});

describe("what a manifest must say", () => {

    it("refuses one with no id", () => {

        expect(() => pluginFromManifest(manifest({ id: undefined as never }), noop))
            .toThrow(/'id' of lowercase letters/);
    });

    it("refuses an id that is not lowercase kebab", () => {

        expect(() => pluginFromManifest(manifest({ id: "My_Task" }), noop))
            .toThrow(/'id' of lowercase letters/);
    });

    it("accepts a hyphenated id, which every bundled plugin uses", () => {

        expect(pluginFromManifest(manifest({ id: "ghcp" }), noop).id).toBe("ghcp");
    });

    it("refuses an arg with no name, rather than producing a schema keyed 'undefined'", () => {

        expect(() => pluginFromManifest(
            manifest({ args: [{ type: "string" } as never] }), noop))
            .toThrow(/arg with no 'name'/);
    });

});

// The manifests that actually ship. If one disagrees with its folder
// or its reference, every workflow using it breaks at once, so these
// are checked here rather than discovered at startup.
describe("the bundled manifests", () => {

    const bundled: [string, PluginManifest][] = [
        ["pwshV1", require("../../../plugins/pwshV1/plugin.json")],
        ["shellV1", require("../../../plugins/shellV1/plugin.json")],
        ["fileV1", require("../../../plugins/fileV1/plugin.json")],
        // In the engine rather than the plugin library - its
        // conversations outlive the tasks that start them - but the
        // manifest is the same contract, so it is checked alongside them.
        ["aiV1", require("../../agent/aiV1/plugin.json")]
    ];

    it.each(bundled)("%s is valid and sits in the right folder", (folder, source) => {

        expect(() => pluginFromManifest(source, noop, folder)).not.toThrow();
    });

    it("pwsh@1 declares the artifacts a workflow reads with ${{ run.context.X.stdout }}", () => {

        const pwsh = pluginFromManifest(bundled[0][1], noop, "pwshV1");

        expect(pwsh.artifacts).toEqual(["stdout", "stderr", "exitCode"]);
    });

    // No bundled plugin declares `artifactsFrom`, so this is checked
    // against a manifest of its own: it is what any plugin whose caller
    // chooses its output keys depends on.
    it("takes its output keys from a named input when the manifest says so", () => {

        const plugin = pluginFromManifest(
            {
                id: "drafter",
                name: "Drafter",
                description: "Drafts named fields.",
                version: { major: 1, minor: 0, patch: 0 },
                artifactsFrom: "fields",
                args: [
                    { name: "fields", type: "string[]", label: "Fields", default: ["title", "description"] }
                ],
                execution: { target: "index.js" }
            } as unknown as PluginManifest,
            noop,
            "drafterV1");

        expect(plugin.artifactsFrom).toBe("fields");
        expect(plugin.args!.fields.default).toEqual(["title", "description"]);
    });

});

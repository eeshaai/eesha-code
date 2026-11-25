import * as path from "path";
import { describe, expect, it } from "vitest";

import {
    BUILT_IN_ACP_AGENTS,
    BUILT_IN_SOURCE,
    DEFAULT_IGNORED_FOLDERS,
    DeclaredSettings,
    loadEngineSettings,
    mergeEngineSettings,
    parseEngineSettings,
    workspaceConfigOf
} from "../engineSettings";

/**
 * The one settings file, in its three responsibilities: parsing one
 * scope loudly, merging two scopes per key with the profile winning,
 * and loading from the two known paths and nowhere else.
 */

const SOURCE = "'C:/repo/.eesha/settings.json'";

describe("parseEngineSettings", () => {

    it("returns only the source for an empty file", () => {

        expect(parseEngineSettings("", SOURCE)).toEqual({ source: SOURCE });
        expect(parseEngineSettings("   \n", SOURCE)).toEqual({ source: SOURCE });
    });

    /* Loud, naming the file - the engine's own config, written by the person reading the error. */
    it("throws on invalid JSON, naming the file", () => {

        expect(() => parseEngineSettings("{ not json", SOURCE))
            .toThrow(/settings\.json.*not valid JSON.*no comments/s);
    });

    it("throws on a non-object file", () => {

        expect(() => parseEngineSettings("[1]", SOURCE))
            .toThrow(/must be a JSON object/);
    });

    /*
     * A misspelled `env` that silently gates nothing is a security
     * setting that looks applied and is not - hence loud, not tolerant.
     */
    it("throws on an unknown top-level key, listing the valid ones", () => {

        expect(() => parseEngineSettings(`{ "evn": {} }`, SOURCE))
            .toThrow(/unknown setting 'evn'.*sdd, ai, env, variables, defaultFoldersToIgnoreScanning/);
    });

    /*
     * Eesha Code keeps its port and theme in the same file the engine
     * reads. The block is accepted and ignored here, so the file loads.
     */
    it("accepts Eesha Code's own block and reads nothing from it", () => {

        expect(parseEngineSettings(`{ "eesha": { "port": 7421, "theme": "light" } }`, SOURCE))
            .toEqual({ source: SOURCE });
    });

    it("throws on an unknown env key", () => {

        expect(() => parseEngineSettings(`{ "env": { "alowed": [] } }`, SOURCE))
            .toThrow(/unknown key 'env\.alowed'.*allowed, denied/);
    });

    it("throws on a non-list env.allowed", () => {

        expect(() => parseEngineSettings(`{ "env": { "allowed": "PAT" } }`, SOURCE))
            .toThrow(/'env\.allowed' must be a list of names/);
    });

    it("keeps the sdd section structurally loose - SDD validates its own keys", () => {

        const declared = parseEngineSettings(
            `{ "sdd": { "style": "kiro", "anything": 1 } }`, SOURCE);

        expect(declared.sdd).toEqual({ style: "kiro", anything: 1 });
    });

    /* The ai section splits: `mcpServers` is servers, every other key is a plugin's defaults. */
    it("splits ai into plugin defaults and mcpServers", () => {

        const declared = parseEngineSettings(JSON.stringify({
            ai: {
                "ai@1": { model: "auto" },
                mcpServers: { ado: { command: "npx" } }
            }
        }), SOURCE);

        expect(declared.aiDefaults).toEqual({ "ai@1": { model: "auto" } });
        expect(declared.mcpServers).toEqual({ ado: { command: "npx" } });
    });

    it("splits ai into plugin defaults and acpAgents", () => {

        const declared = parseEngineSettings(JSON.stringify({
            ai: {
                "ai@1": { model: "auto" },
                acpAgents: { kiro: { command: "kiro-cli", args: ["acp"] } }
            }
        }), SOURCE);

        expect(declared.aiDefaults).toEqual({ "ai@1": { model: "auto" } });
        expect(declared.acpAgents).toEqual({ kiro: { command: "kiro-cli", args: ["acp"] } });
    });

    it("reads env and the ignore list", () => {

        const declared = parseEngineSettings(JSON.stringify({
            env: { allowed: ["PAT"], denied: ["AWS_SECRET"] },
            defaultFoldersToIgnoreScanning: ["node_modules"]
        }), SOURCE);

        expect(declared.envAllowed).toEqual(["PAT"]);
        expect(declared.envDenied).toEqual(["AWS_SECRET"]);
        expect(declared.ignore).toEqual(["node_modules"]);
    });

    it("reads variables as written, nested and all", () => {

        const declared = parseEngineSettings(JSON.stringify({
            variables: { Team: { Name: "Payments", Repos: ["api", "web"] }, CurrentUser: "octocat" }
        }), SOURCE);

        expect(declared.variables).toEqual({
            Team: { Name: "Payments", Repos: ["api", "web"] }, CurrentUser: "octocat"
        });
    });

    it("refuses a non-mapping variables section", () => {

        expect(() => parseEngineSettings(`{ "variables": ["Team"] }`, SOURCE))
            .toThrow(/'variables' must be a mapping/);
    });

    /*
     * `${{ home }}` declared here would either shadow the anchor or be
     * shadowed by it - a value nobody meant either way. Refused by name.
     */
    it("refuses a variable named like something an expression already resolves", () => {

        for (const name of ["home", "env", "vars", "params", "run", "cwd", "workspaceFolder", "runId", "spec"])
            expect(() => parseEngineSettings(`{ "variables": { "${name}": "x" } }`, SOURCE))
                .toThrow(new RegExp(`declares a variable named '${name}'.*already.*means`));
    });

    it("reads debug from a profile file", () => {

        expect(parseEngineSettings(`{ "debug": true }`, SOURCE, "profile").debug).toBe(true);
        expect(parseEngineSettings(`{ "debug": false }`, SOURCE, "profile").debug).toBe(false);
    });

    /* Personal switch. A committed file turning it on for the whole team is not what it is for. */
    it("refuses debug in a workspace file, saying where it belongs", () => {

        expect(() => parseEngineSettings(`{ "debug": true }`, SOURCE, "workspace"))
            .toThrow(/personal setting.*profile file/s);
    });

    it("refuses a debug that is not a boolean", () => {

        expect(() => parseEngineSettings(`{ "debug": "yes" }`, SOURCE))
            .toThrow(/'debug' must be true or false/);
    });

    it("reads a feature flag from a profile file", () => {

        expect(parseEngineSettings(`{ "features": { "liveToolOutput": true } }`, SOURCE).features)
            .toEqual({ liveToolOutput: true });
    });

    /*
     * A flag that is spelt wrong would otherwise read as set
     * and switch nothing on.
     */
    it("refuses a feature flag it has never heard of, naming the ones it knows", () => {

        expect(() => parseEngineSettings(`{ "features": { "liveToolOutputs": true } }`, SOURCE))
            .toThrow(/unknown feature flag 'features.liveToolOutputs'.*liveToolOutput/s);
    });

    /* Their features are always on now: an older file that still names them loads as before. */
    it("skips the removed flags Feature-SDD and widgets", () => {

        expect(parseEngineSettings(`{ "features": { "Feature-SDD": true, "widgets": true, "liveToolOutput": true } }`, SOURCE).features)
            .toEqual({ liveToolOutput: true });
    });

    it("refuses a feature flag that is not a boolean", () => {

        expect(() => parseEngineSettings(`{ "features": { "liveToolOutput": "on" } }`, SOURCE))
            .toThrow(/'features.liveToolOutput' must be true or false/);
    });

    /* A team can turn a feature on for everyone in a repository. */
    it("reads a feature flag from a workspace file", () => {

        expect(parseEngineSettings(
            `{ "features": { "liveToolOutput": true } }`, SOURCE, "workspace").features)
            .toEqual({ liveToolOutput: true });
    });
});

describe("mergeEngineSettings", () => {

    /** Every shipped agent as the merge carries it. */
    function builtInAcpAgents(): Record<string, unknown> {

        return Object.fromEntries(Object.entries(BUILT_IN_ACP_AGENTS)
            .map(([id, agent]) => [id, { agent, source: BUILT_IN_SOURCE }]));
    }

    function scope(source: string, fields: Partial<DeclaredSettings> = {}): DeclaredSettings {

        return { source, ...fields };
    }

    it("applies pure defaults when neither scope exists", () => {

        const merged = mergeEngineSettings(undefined, undefined);

        expect(merged.sdd).toEqual({});
        expect(merged.ai).toEqual({
            defaults: {},
            defaultSources: {},
            defaultScopes: {},
            scopedDefaults: { workspace: {}, profile: {} },
            mcpServers: {},
            acpAgents: builtInAcpAgents()
        });
        expect(merged.env).toEqual({ allowed: [], denied: [] });
        expect(merged.ignore).toEqual([...DEFAULT_IGNORED_FOLDERS]);
        expect(merged.debug).toBe(false);
        // Every flag the engine knows, at its own default. The list is
        // asserted whole on purpose: a flag added without a default
        // would otherwise read as `undefined` at every call site and
        // never fire.
        expect(merged.features).toEqual({ liveToolOutput: false, sessionCost: false, docDiff: true, steering: false, hideCopilotPremiumRequests: true, handover: true, toolResults: false, evals: false, fakeRuntime: false });
    });

    /* Per key, profile wins - a key the person set beats the team file, and the team file fills the rest. */
    it("merges sdd per field, profile winning a clash", () => {

        const merged = mergeEngineSettings(
            scope("profile", { sdd: { style: "mine", source: "ado" } }),
            scope("workspace", { sdd: { style: "kiro" } }));

        expect(merged.sdd).toEqual({ style: "mine", source: "ado" });
    });

    /* A person's block for one runtime must not wipe the team's block for another. */
    it("merges ai providers: blocks per runtime and per key", () => {

        const merged = mergeEngineSettings(
            scope("profile", { aiDefaults: { "ai@1": { providers: { ghcp: { model: "gpt-5.2" } } } } }),
            scope("workspace", {
                aiDefaults: { "ai@1": { providers: { ghcp: { reasoningSummary: "concise" }, "kiro-cli": { model: "sonnet" } } } }
            }));

        expect(merged.ai.defaults["ai@1"].providers).toEqual({
            ghcp: { reasoningSummary: "concise", model: "gpt-5.2" },
            "kiro-cli": { model: "sonnet" }
        });
    });

    /* ai.providers: the runtimes this org uses. */
    describe("ai.providers", () => {

        it("is read from either file, the profile's replacing the workspace's whole", () => {

            expect(mergeEngineSettings(undefined, scope("workspace", { providers: ["ghcp", "kiro-cli"] })).ai.providers)
                .toEqual(["ghcp", "kiro-cli"]);

            expect(mergeEngineSettings(
                scope("profile", { providers: ["ghcp", "claude"] }),
                scope("workspace", { providers: ["ghcp", "kiro-cli"] })).ai.providers)
                .toEqual(["ghcp", "claude"]);
        });

        it("is absent when neither file lists one", () => {

            expect(mergeEngineSettings(undefined, undefined).ai.providers).toBeUndefined();
        });

        it("refuses a runtime this build cannot run, naming the known ones", () => {

            expect(() => mergeEngineSettings(undefined, scope("workspace", { providers: ["ghcp", "kiro"] })))
                .toThrow(/lists 'kiro' in ai\.providers.*Known runtimes: ghcp, claude, kiro-cli/s);
        });

        it("refuses a list without the runtime ai@1 starts on", () => {

            expect(() => mergeEngineSettings(undefined, scope("workspace", { providers: ["kiro-cli"] })))
                .toThrow(/without 'ghcp', the runtime ai@1 starts on when nothing names one/);

            expect(() => mergeEngineSettings(undefined, scope("workspace", {
                providers: ["kiro-cli"],
                aiDefaults: { "ai@1": { provider: "kiro-cli" } }
            }))).not.toThrow();
        });

        it("refuses a name listed twice, or a list that is not names", () => {

            expect(() => parseEngineSettings(JSON.stringify({ ai: { providers: ["ghcp", "ghcp"] } }), SOURCE))
                .toThrow(/lists 'ghcp' twice/);

            expect(() => parseEngineSettings(JSON.stringify({ ai: { providers: "ghcp" } }), SOURCE))
                .toThrow(/'ai\.providers' must be a list of names/);
        });

        it("is not read as a plugin's defaults", () => {

            expect(parseEngineSettings(JSON.stringify({ ai: { providers: ["ghcp"] } }), SOURCE).aiDefaults)
                .toBeUndefined();
        });
    });

    it("keeps each file's ai defaults apart as well as merged", () => {

        const merged = mergeEngineSettings(
            scope("profile", { aiDefaults: { "ai@1": { model: "mine" } } }),
            scope("workspace", { aiDefaults: { "ai@1": { model: "ours" } } }));

        expect(merged.ai.scopedDefaults).toEqual({
            workspace: { "ai@1": { model: "ours" } },
            profile: { "ai@1": { model: "mine" } }
        });
    });

    it("refuses a providers: block that names its own runtime", () => {

        expect(() => parseEngineSettings(
            JSON.stringify({ ai: { "ai@1": { providers: { ghcp: { provider: "claude" } } } } }), SOURCE))
            .toThrow(/sets 'provider' inside 'providers\.ghcp'/);
    });

    /* Every sdd field is a scalar; per-phase settings live in the style, which is shadowed whole. */
    it("merges sdd one field deep and no deeper", () => {

        const merged = mergeEngineSettings(
            scope("profile", { sdd: { uses: "eesha@1", specsDir: "docs/specs" } }),
            scope("workspace", { sdd: { uses: "ai@1" } }));

        expect(merged.sdd).toEqual({ uses: "eesha@1", specsDir: "docs/specs" });
    });

    it("merges a plugin's defaults per arg", () => {

        const merged = mergeEngineSettings(
            scope("profile", { aiDefaults: { "ai@1": { model: "mine", thinking: "high" } } }),
            scope("workspace", { aiDefaults: { "ai@1": { model: "auto" } } }));

        expect(merged.ai.defaults).toEqual({ "ai@1": { model: "mine", thinking: "high" } });
    });

    it("records which file supplied each default, profile winning a clash", () => {

        const merged = mergeEngineSettings(
            scope("profile", { aiDefaults: { "ai@1": { model: "mine", thinking: "high" } } }),
            scope("workspace", { aiDefaults: { "ai@1": { model: "auto" } } }));

        expect(merged.ai.defaultSources).toEqual({
            "ai@1": { model: "profile", thinking: "profile" }
        });
    });

    /*
     * Servers merge per name, entry wholesale - half a declaration
     * assembled from two files is nobody's intent. Each survivor keeps
     * its own file as source, so errors name the file that declared it.
     */
    it("merges mcpServers per name, wholesale, keeping each entry's source", () => {

        const merged = mergeEngineSettings(
            scope("profile", {
                mcpServers: {
                    ado: { command: "profile", env: { A: "1" } },
                    personal: { command: "node" }
                }
            }),
            scope("workspace", { mcpServers: { ado: { command: "workspace" } } }));

        expect(merged.ai.mcpServers).toEqual({
            ado: { server: { command: "profile", env: { A: "1" } }, source: "profile" },
            personal: { server: { command: "node" }, source: "profile" }
        });
    });

    /* Same rule as mcpServers, for the same reason - half an agent declaration merged from two files is nobody's intent. */
    it("merges acpAgents per id, wholesale, keeping each entry's source", () => {

        const merged = mergeEngineSettings(
            scope("profile", {
                acpAgents: {
                    kiro: { command: "profile-kiro" },
                    personal: { command: "node" }
                }
            }),
            scope("workspace", { acpAgents: { kiro: { command: "workspace-kiro" } } }));

        expect(merged.ai.acpAgents).toEqual({
            ...builtInAcpAgents(),
            kiro: { agent: { command: "profile-kiro" }, source: "profile" },
            personal: { agent: { command: "node" }, source: "profile" }
        });
    });

    /* The shipped ids work with an empty settings.json, and a settings file that names one replaces it wholesale. */
    it("ships the seven -cli ids, each replaceable by a settings file", () => {

        expect(Object.keys(mergeEngineSettings(undefined, undefined).ai.acpAgents)).toEqual([
            "kiro-cli", "copilot-cli", "claude-cli", "gemini-cli", "codex-cli", "cursor-cli", "opencode-cli"
        ]);

        const merged = mergeEngineSettings(
            undefined,
            scope("workspace", { acpAgents: { "kiro-cli": { command: "my-kiro" } } }));

        expect(merged.ai.acpAgents["kiro-cli"]).toEqual({ agent: { command: "my-kiro" }, source: "workspace" });
        expect(merged.ai.acpAgents["copilot-cli"].source).toBe(BUILT_IN_SOURCE);
    });

    /* Unions: a personal deny holds in every repository; a team deny holds for every person. */
    it("unions env.allowed and env.denied across the scopes", () => {

        const merged = mergeEngineSettings(
            scope("profile", { envAllowed: ["A"], envDenied: ["SECRET"] }),
            scope("workspace", { envAllowed: ["A", "B"] }));

        expect(merged.env.allowed).toEqual(["A", "B"]);
        expect(merged.env.denied).toEqual(["SECRET"]);
    });

    it("takes debug from the profile, false when it says nothing", () => {

        expect(mergeEngineSettings(scope("profile", { debug: true }), scope("workspace")).debug)
            .toBe(true);

        expect(mergeEngineSettings(scope("profile"), scope("workspace")).debug).toBe(false);
    });

    /* Every known flag is present either way, so a reader never checks for undefined. */
    it("takes feature flags from the profile, each at its own default when it says nothing", () => {

        // Naming one flag leaves every other at its default rather than
        // switching them all off - `docDiff` stays on.
        expect(mergeEngineSettings(
            scope("profile", { features: { liveToolOutput: true } }), scope("workspace")).features)
            .toEqual({ liveToolOutput: true, sessionCost: false, docDiff: true, steering: false, hideCopilotPremiumRequests: true, handover: true, toolResults: false, evals: false, fakeRuntime: false });

        expect(mergeEngineSettings(scope("profile"), scope("workspace")).features)
            .toEqual({ liveToolOutput: false, sessionCost: false, docDiff: true, steering: false, hideCopilotPremiumRequests: true, handover: true, toolResults: false, evals: false, fakeRuntime: false });
    });

    /* A flag that starts on is still a flag: a profile can turn it off. */
    it("lets a profile switch off a flag that is on by default", () => {

        expect(mergeEngineSettings(
            scope("profile", { features: { handover: false } }), scope("workspace")).features)
            .toEqual({ liveToolOutput: false, sessionCost: false, docDiff: true, steering: false, hideCopilotPremiumRequests: true, handover: false, toolResults: false, evals: false, fakeRuntime: false });
    });

    /* The diff view ships on, so the switch that matters is the one that takes it away. */
    it("lets a profile switch off the diff view", () => {

        expect(mergeEngineSettings(
            scope("profile", { features: { docDiff: false } }), scope("workspace")).features.docDiff)
            .toBe(false);
    });

    /* Per flag, profile winning - the team sets a flag, the person can always set it back. */
    it("merges feature flags per flag, profile winning a clash", () => {

        expect(mergeEngineSettings(
            scope("profile", { features: { liveToolOutput: true, docDiff: false } }),
            scope("workspace", { features: { docDiff: true, sessionCost: true } })).features)
            .toEqual({ liveToolOutput: true, sessionCost: true, docDiff: false, steering: false, hideCopilotPremiumRequests: true, handover: true, toolResults: false, evals: false, fakeRuntime: false });
    });

    /* Per leaf, so a person's leaves and the team's leaves sit under one key. */
    it("merges variables one leaf at a time, profile winning a clash and saying so", () => {

        const merged = mergeEngineSettings(
            scope("up.json", { variables: { Team: { Name: "Mine", Repo: "C:/src" }, CurrentUser: "octocat" } }),
            scope("ws.json", { variables: { Team: { Name: "Payments", Org: "contoso" } } }));

        expect(merged.variables).toEqual({
            Team: { Name: "Mine", Org: "contoso", Repo: "C:/src" },
            CurrentUser: "octocat"
        });

        expect(merged.variableOverrides).toEqual(["variables.Team.Name: 'up.json' overrides 'ws.json'."]);
    });

    /* A mapping against a value is a clash too - there is no half-merge of those. */
    it("replaces a variable wholesale when the two files disagree on its shape", () => {

        const merged = mergeEngineSettings(
            scope("up.json", { variables: { Team: "Mine", Tags: ["a"] } }),
            scope("ws.json", { variables: { Team: { Name: "Payments" }, Tags: ["b"] } }));

        expect(merged.variables).toEqual({ Team: "Mine", Tags: ["a"] });

        expect(merged.variableOverrides).toEqual([
            "variables.Team: 'up.json' overrides 'ws.json'.",
            "variables.Tags: 'up.json' overrides 'ws.json'."
        ]);
    });

    it("has no variables and no overrides when neither scope declares any", () => {

        const merged = mergeEngineSettings(scope("profile"), scope("workspace"));

        expect(merged.variables).toEqual({});
        expect(merged.variableOverrides).toEqual([]);
    });

    it("unions the ignore lists when any scope declares one", () => {

        const merged = mergeEngineSettings(
            scope("profile", { ignore: ["bin"] }),
            scope("workspace", { ignore: ["obj", "bin"] }));

        expect(merged.ignore).toEqual(["bin", "obj"]);
    });
});

describe("loadEngineSettings", () => {

    const WORKSPACE = path.resolve("C:/repo");
    const PROFILE = path.resolve("C:/Users/dev/.eesha");

    /** A fake disk keyed by absolute path, plus a record of what was asked for. */
    function disk(files: Record<string, string>) {

        const asked: string[] = [];

        return {
            asked,
            read: async (filePath: string) => {

                asked.push(filePath);

                return files[filePath];
            }
        };
    }

    it("reads exactly the two known paths", async () => {

        const at = disk({});

        await loadEngineSettings(WORKSPACE, { profileDir: PROFILE, readFile: at.read });

        expect(at.asked.sort()).toEqual([
            path.join(PROFILE, "settings.json"),
            path.join(workspaceConfigOf(WORKSPACE), "settings.json")
        ].sort());
    });

    it("skips the workspace path when nothing is open", async () => {

        const at = disk({});

        await loadEngineSettings(undefined, { profileDir: PROFILE, readFile: at.read });

        expect(at.asked).toEqual([path.join(PROFILE, "settings.json")]);
    });

    /* Absence is the normal case - a fresh install writes nothing and works. */
    it("answers with defaults when neither file exists", async () => {

        const settings = await loadEngineSettings(WORKSPACE, {
            profileDir: PROFILE,
            readFile: disk({}).read
        });

        expect(settings.ignore).toEqual([...DEFAULT_IGNORED_FOLDERS]);
        expect(settings.ai.mcpServers).toEqual({});
    });

    it("merges the two files, profile winning", async () => {

        const at = disk({
            [path.join(PROFILE, "settings.json")]:
                JSON.stringify({ sdd: { style: "mine", source: "gh" } }),
            [path.join(workspaceConfigOf(WORKSPACE), "settings.json")]:
                JSON.stringify({ sdd: { style: "kiro" } })
        });

        const settings = await loadEngineSettings(WORKSPACE, {
            profileDir: PROFILE,
            readFile: at.read
        });

        expect(settings.sdd).toEqual({ style: "mine", source: "gh" });
    });

    it("fails loudly on a malformed file, naming its path", async () => {

        const at = disk({
            [path.join(workspaceConfigOf(WORKSPACE), "settings.json")]: "{ nope"
        });

        await expect(loadEngineSettings(WORKSPACE, { profileDir: PROFILE, readFile: at.read }))
            .rejects.toThrow(/settings\.json.*not valid JSON/);
    });
});

/*
 * `${{ }}` in settings.json. Resolved between the JSON read and the
 * validation pass, so an expression may sit under any key and every
 * validator still sees the value the file meant.
 */
describe("loadEngineSettings resolving expressions", () => {

    const WORKSPACE = path.resolve("C:/repo");
    const PROFILE = path.resolve("C:/Users/dev/.eesha");

    const load = (files: Record<string, string>, processEnv: Record<string, string> = {}) =>
        loadEngineSettings(WORKSPACE, {
            profileDir: PROFILE,
            home: "C:/Users/dev",
            processEnv,
            readFile: async (filePath: string) => files[filePath]
        });

    const workspaceFile = (json: string) => ({
        [path.join(workspaceConfigOf(WORKSPACE), "settings.json")]: json
    });

    it("resolves an anchor", async () => {

        const settings = await load(workspaceFile(
            `{ "sdd": { "specsDir": "\${{ workspaceFolder }}/specs" } }`));

        expect(settings.sdd.specsDir).toBe(`${WORKSPACE}/specs`);
    });

    it("resolves an env read inside a plugin default", async () => {

        const settings = await load(
            workspaceFile(`{ "ai": { "ai@1": { "model": "\${{ env.MODEL }}" } } }`),
            { MODEL: "gpt-5" });

        expect(settings.ai.defaults["ai@1"]).toEqual({ model: "gpt-5" });
    });

    /* The veto, from the file that declares it. */
    it("refuses a name its own env.denied vetoes", async () => {

        await expect(load(workspaceFile(
            `{ "env": { "denied": ["TOKEN"] }, "ai": { "ai@1": { "k": "\${{ env.TOKEN }}" } } }`),
            { TOKEN: "secret" }))
            .rejects.toThrow(/'env.denied' vetoes/);
    });

    /* A personal deny has to hold while the committed file resolves - that is the case the gate is for. */
    it("applies the profile's deny list to the workspace file", async () => {

        await expect(load({
            [path.join(PROFILE, "settings.json")]: `{ "env": { "denied": ["TOKEN"] } }`,
            ...workspaceFile(`{ "ai": { "ai@1": { "k": "\${{ env.TOKEN }}" } } }`)
        }, { TOKEN: "secret" }))
            .rejects.toThrow(/'env.denied' vetoes/);
    });

    it("names the file an expression could not be resolved in", async () => {

        await expect(load(workspaceFile(`{ "sdd": { "style": "\${{ vars.x }}" } }`)))
            .rejects.toThrow(path.join(workspaceConfigOf(WORKSPACE), "settings.json"));
    });

    /*
     * An MCP declaration's env reads need a task's grants, which do not
     * exist yet, so they survive for `resolveMcpServers` to answer.
     */
    it("resolves anchors inside an MCP declaration but leaves its env reads for the gate", async () => {

        const settings = await load(workspaceFile(JSON.stringify({
            ai: {
                mcpServers: {
                    ado: {
                        command: "npx",
                        args: ["--root", "${{ workspaceFolder }}"],
                        env: { PAT: "${{ env.ADO_PAT }}" }
                    }
                }
            }
        })), { ADO_PAT: "secret" });

        expect(settings.ai.mcpServers.ado.server).toEqual({
            command: "npx",
            args: ["--root", WORKSPACE],
            env: { PAT: "${{ env.ADO_PAT }}" }
        });
    });

    /* The veto reaches the subtree the gate finishes, so a denied name never survives to be granted. */
    it("still refuses a denied name inside an MCP declaration", async () => {

        await expect(load(workspaceFile(JSON.stringify({
            env: { denied: ["ADO_PAT"] },
            ai: { mcpServers: { ado: { command: "npx", env: { PAT: "${{ env.ADO_PAT }}" } } } }
        })), { ADO_PAT: "secret" }))
            .rejects.toThrow(/'env.denied' vetoes/);
    });

    /* Same split as mcpServers, for the same reason - an ACP agent's declared env is a third-party process's grant too. */
    it("resolves anchors inside an ACP agent declaration but leaves its env reads for the gate", async () => {

        const settings = await load(workspaceFile(JSON.stringify({
            ai: {
                acpAgents: {
                    kiro: {
                        command: "kiro-cli",
                        args: ["acp", "--cwd", "${{ workspaceFolder }}"],
                        env: { KIRO_API_KEY: "${{ env.KIRO_API_KEY }}" }
                    }
                }
            }
        })), { KIRO_API_KEY: "secret" });

        expect(settings.ai.acpAgents.kiro.agent).toEqual({
            command: "kiro-cli",
            args: ["acp", "--cwd", WORKSPACE],
            env: { KIRO_API_KEY: "${{ env.KIRO_API_KEY }}" }
        });
    });

    it("still refuses a denied name inside an ACP agent declaration", async () => {

        await expect(load(workspaceFile(JSON.stringify({
            env: { denied: ["KIRO_API_KEY"] },
            ai: { acpAgents: { kiro: { command: "kiro-cli", env: { KEY: "${{ env.KIRO_API_KEY }}" } } } }
        })), { KIRO_API_KEY: "secret" }))
            .rejects.toThrow(/'env.denied' vetoes/);
    });

    /* A file with mcpServers and nothing else must not lose the rest of its sections. */
    it("keeps every other section when it lifts mcpServers out", async () => {

        const settings = await load(workspaceFile(JSON.stringify({
            sdd: { style: "spec-kit", specsDir: "${{ workspaceFolder }}/specs" },
            ai: { "ai@1": { model: "auto" }, mcpServers: { ado: { command: "npx" } } }
        })));

        expect(settings.sdd.style).toBe("spec-kit");
        expect(settings.sdd.specsDir).toBe(`${WORKSPACE}/specs`);
        expect(settings.ai.defaults["ai@1"]).toEqual({ model: "auto" });
        expect(settings.ai.mcpServers.ado.server).toEqual({ command: "npx" });
    });

    it("settles a variable that reads an anchor, an env var and another variable", async () => {

        const settings = await load(workspaceFile(JSON.stringify({
            variables: {
                Repo: "${{ home }}/src/${{ Team.Name }}",
                Team: { Name: "${{ env.TEAM }}" }
            }
        })), { TEAM: "Payments" });

        expect(settings.variables).toEqual({
            Repo: "C:/Users/dev/src/Payments",
            Team: { Name: "Payments" }
        });
    });

    /* The reason the section exists: every other value in the file may read it. */
    it("lets the rest of the file read a variable bare", async () => {

        const settings = await load(workspaceFile(JSON.stringify({
            variables: { Team: { Name: "Payments" }, Model: "sonnet" },
            sdd: { specsDir: "${{ workspaceFolder }}/specs/${{ Team.Name }}" },
            ai: {
                "ai@1": { model: "${{ Model }}" },
                mcpServers: { ado: { command: "npx", args: ["${{ Team.Name }}"] } }
            }
        })));

        expect(settings.sdd.specsDir).toBe(`${WORKSPACE}/specs/Payments`);
        expect(settings.ai.defaults["ai@1"]).toEqual({ model: "sonnet" });
        expect(settings.ai.mcpServers.ado.server).toEqual({ command: "npx", args: ["Payments"] });
    });

    /* Merged before settling, so the two files can build on each other. */
    it("lets a profile variable read a workspace one, and the other way round", async () => {

        const settings = await load({
            [path.join(PROFILE, "settings.json")]:
                JSON.stringify({ variables: { Repo: "${{ home }}/${{ Team.Name }}", CurrentUser: "octocat" } }),
            ...workspaceFile(JSON.stringify({ variables: { Team: { Name: "Payments", Owner: "${{ CurrentUser }}" } } }))
        });

        expect(settings.variables).toEqual({
            Repo: "C:/Users/dev/Payments",
            CurrentUser: "octocat",
            Team: { Name: "Payments", Owner: "octocat" }
        });
    });

    it("fails on two variables that read each other, naming both", async () => {

        await expect(load(workspaceFile(JSON.stringify({
            variables: { A: "${{ B }}", B: "${{ A }}" }
        }))))
            .rejects.toThrow(/'variables' in .*settings\.json.*Cannot resolve '\$\{\{ B \}\}' in 'A'.*reads a variable that reads it back/s);
    });

    it("fails on a variable that reads a name nothing declares, listing what exists", async () => {

        await expect(load(workspaceFile(JSON.stringify({
            variables: { Team: { Name: "Payments" } },
            sdd: { specsDir: "${{ Tean.Name }}" }
        }))))
            .rejects.toThrow(/'Tean' is not a thing\. Available: .*Team/);
    });

    it("still refuses a denied env name inside a variable", async () => {

        await expect(load(workspaceFile(JSON.stringify({
            env: { denied: ["TOKEN"] },
            variables: { T: "${{ env.TOKEN }}" }
        })), { TOKEN: "secret" }))
            .rejects.toThrow(/'env.denied' vetoes/);
    });

    /* A profile of plain values must work with nothing open - that is the usual profile. */
    it("reads plain variables from the profile with no workspace open", async () => {

        const settings = await loadEngineSettings(undefined, {
            profileDir: PROFILE,
            readFile: async (filePath: string) => ({
                [path.join(PROFILE, "settings.json")]: `{ "variables": { "CurrentUser": "octocat" } }`
            })[filePath]
        });

        expect(settings.variables).toEqual({ CurrentUser: "octocat" });
    });

    it("refuses a variable with an expression when no workspace is open", async () => {

        await expect(loadEngineSettings(undefined, {
            profileDir: PROFILE,
            readFile: async (filePath: string) => ({
                [path.join(PROFILE, "settings.json")]: `{ "variables": { "Repo": "\${{ home }}/src" } }`
            })[filePath]
        })).rejects.toThrow(/no workspace is open/);
    });

    /* The ordinary file, which must not need a workspace or an environment to be read. */
    it("leaves a file with no expressions untouched", async () => {

        const settings = await load(workspaceFile(`{ "sdd": { "style": "spec-kit" } }`));

        expect(settings.sdd.style).toBe("spec-kit");
    });
});

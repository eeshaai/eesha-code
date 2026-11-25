import { describe, expect, it } from "vitest";

import { referencedAcpAgentEnv, resolveAcpAgent, sessionEnvRuntime } from "../acpConfig";
import { EnvAccess, EnvService } from "../../../env/envService";
import { BUILT_IN_ACP_AGENTS, SourcedAcpAgent } from "../../../settings/engineSettings";

/**
 * One `ai.acpAgents.<id>` declaration through validation and the gated
 * `${{ env.NAME }}` expansion. Same pipeline `mcpConfig.test.ts` covers
 * for `ai.mcpServers`.
 */

const SOURCE = "'C:/repo/.eesha/settings.json'";

function declared(agent: unknown): SourcedAcpAgent {

    return { agent, source: SOURCE };
}

function gate(overrides: Partial<EnvAccess> = {}): EnvService {

    return new EnvService({ env: {}, allowed: [], denied: [], ...overrides });
}

describe("resolveAcpAgent", () => {

    it("resolves a plain command with no args or env", () => {

        expect(resolveAcpAgent("kiro", declared({ command: "kiro-cli" }), gate()))
            .toEqual({ command: "kiro-cli", args: [], env: {}, extensions: [] });
    });

    describe("extensions", () => {

        it("ships kiro-cli on Kiro's v3 engine, and no other Kiro id", () => {

            const builtIn = (id: string) => resolveAcpAgent(id, { agent: BUILT_IN_ACP_AGENTS[id], source: "built-in" }, gate());

            expect(builtIn("kiro-cli")).toMatchObject({
                command: "kiro-cli",
                args: ["acp", "--agent-engine", "v3", "--auth-method", "cli"],
                extensions: ["kiro-v3"]
            });
            expect(Object.keys(BUILT_IN_ACP_AGENTS).filter(id => id.startsWith("kiro"))).toEqual(["kiro-cli"]);
        });

        it("keeps a built-in id's extensions when a settings entry leaves them out", () => {

            expect(resolveAcpAgent("kiro-cli", declared({ command: "C:/tools/kiro-cli.exe", args: ["acp"] }), gate()).extensions)
                .toEqual(["kiro-v3"]);
        });

        it("switches them off with an empty list, and takes a list as written", () => {

            expect(resolveAcpAgent("kiro-cli", declared({ command: "kiro-cli", extensions: [] }), gate()).extensions)
                .toEqual([]);
            expect(resolveAcpAgent("my-kiro", declared({ command: "kiro-cli", extensions: ["kiro-v3"] }), gate()).extensions)
                .toEqual(["kiro-v3"]);
        });

        it("gives any other id none", () => {

            expect(resolveAcpAgent("my-agent", declared({ command: "agent" }), gate()).extensions).toEqual([]);
        });

        it("rejects extensions that are not a list of strings", () => {

            expect(() => resolveAcpAgent("kiro", declared({ command: "kiro-cli", extensions: "kiro-v3" }), gate()))
                .toThrow(/ai\.acpAgents\.kiro\.extensions must be a list of strings/);
        });
    });

    it("carries args through unchanged", () => {

        expect(resolveAcpAgent("kiro", declared({ command: "kiro-cli", args: ["acp", "--agent", "my-agent"] }), gate()).args)
            .toEqual(["acp", "--agent", "my-agent"]);
    });

    describe("validation", () => {

        it("rejects a declaration that is not an object", () => {

            expect(() => resolveAcpAgent("kiro", declared("kiro-cli"), gate()))
                .toThrow(/ai\.acpAgents\.kiro must be an object/);
        });

        it("rejects a missing command", () => {

            expect(() => resolveAcpAgent("kiro", declared({}), gate()))
                .toThrow(/ai\.acpAgents\.kiro\.command must be a non-empty string/);
        });

        it("rejects args that are not a list of strings", () => {

            expect(() => resolveAcpAgent("kiro", declared({ command: "kiro-cli", args: [1, 2] }), gate()))
                .toThrow(/ai\.acpAgents\.kiro\.args must be a list of strings/);
        });

        it("rejects an env value that is not a string", () => {

            expect(() => resolveAcpAgent("kiro", declared({ command: "kiro-cli", env: { KEY: 1 } }), gate()))
                .toThrow(/ai\.acpAgents\.kiro\.env\.KEY must be a string/);
        });

        it("names the declaring file in every error", () => {

            expect(() => resolveAcpAgent("kiro", declared({}), gate()))
                .toThrow(SOURCE);
        });
    });

    describe("env expansion", () => {

        it("resolves ${{ env.NAME }} when the gate grants it", () => {

            const envs = gate({ env: { KIRO_API_KEY: "secret-value" }, allowed: ["KIRO_API_KEY"] });

            expect(resolveAcpAgent(
                "kiro",
                declared({ command: "kiro-cli", env: { KIRO_API_KEY: "${{ env.KIRO_API_KEY }}" } }),
                envs
            ).env).toEqual({ KIRO_API_KEY: "secret-value" });
        });

        it("fails loudly when nothing grants the name", () => {

            expect(() => resolveAcpAgent(
                "kiro",
                declared({ command: "kiro-cli", env: { KIRO_API_KEY: "${{ env.KIRO_API_KEY }}" } }),
                gate()
            )).toThrow(/KIRO_API_KEY/);
        });
    });
});

describe("referencedAcpAgentEnv", () => {

    it("names the env vars a declaration reads, without resolving them", () => {

        expect(referencedAcpAgentEnv(declared({ command: "kiro-cli", env: { KEY: "${{ env.KIRO_API_KEY }}" } })))
            .toEqual(["KIRO_API_KEY"]);
    });

    it("returns nothing for a malformed declaration - that is resolveAcpAgent's error to raise", () => {

        expect(referencedAcpAgentEnv(declared("kiro-cli"))).toEqual([]);
    });
});

describe("sessionEnvRuntime", () => {

    it("names an agent that runs Claude `claude-cli`, whatever its own id is", () => {

        expect(sessionEnvRuntime("claude-cli", ["claude-cli"])).toBe("claude-cli");
        expect(sessionEnvRuntime("my-claude", ["claude-cli"])).toBe("claude-cli");
    });

    it("names every other agent by its own id", () => {

        expect(sessionEnvRuntime("kiro-cli", ["kiro-v3"])).toBe("kiro-cli");
        expect(sessionEnvRuntime("gemini-cli", [])).toBe("gemini-cli");
    });
});

import { describe, expect, it } from "vitest";

import { AcpAgentContext, AcpConfigOption, applyEffort, effortsByModel } from "../AcpProvider";
import { claudeCliPrice } from "../claudeCliAcpExtension";
import { claudeEffort } from "../ClaudeProvider";

/*
 * The Effort picker's levels and the price beside a model - claude-cli's
 * off its session config options, claude's own levels.
 */

const effort = (values: string[]): AcpConfigOption => ({
    id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "default",
    options: ["default", ...values].map(value => ({ value, name: value }))
});

const models: AcpConfigOption = {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "default",
    options: [{ value: "default", name: "Default" }, { value: "sonnet", name: "Sonnet" }, { value: "haiku", name: "Haiku" }]
};

describe("effortsByModel", () => {

    it("reads each model's levels by putting the listing session on it, as claude-agent-acp answers", async () => {

        const sent: unknown[] = [];

        // claude-agent-acp 0.73.0: Haiku has no effort option at all.
        const ctx = {
            request: async (method: string, params: { value: string }) => {

                sent.push(params.value);

                return { configOptions: params.value === "haiku" ? [models] : [models, effort(["low", "high", "max"])] };
            }
        } as unknown as AcpAgentContext;

        expect(await effortsByModel(ctx, "S", { configOptions: [models, effort(["low", "high"])] }))
            .toEqual({ default: ["low", "high", "max"], sonnet: ["low", "high", "max"] });
        expect(sent).toEqual(["default", "sonnet", "haiku"]);
    });

    it("asks nothing of an agent with no effort option", async () => {

        const ctx = { request: async () => { throw new Error("should not be asked"); } } as unknown as AcpAgentContext;

        expect(await effortsByModel(ctx, "S", { configOptions: [models] })).toBeUndefined();
    });
});

describe("applyEffort", () => {

    it("sets the picked level on the effort option, and leaves it alone when none was picked", async () => {

        const calls: unknown[] = [];
        const lines: string[] = [];
        const ctx = { request: async (method: string, params: unknown) => { calls.push({ method, params }); return {}; } } as unknown as AcpAgentContext;
        const session = { sessionId: "S", newSessionResponse: { configOptions: [effort(["low", "high"])] } };

        expect(await applyEffort(ctx, session, "high", text => lines.push(text))).toBe("high");
        expect(calls).toEqual([{ method: "session/set_config_option", params: { sessionId: "S", configId: "effort", value: "high" } }]);
        expect(lines).toEqual(["Effort: high (set on the session)."]);

        expect(await applyEffort(ctx, session, undefined)).toBeUndefined();
        expect(calls).toHaveLength(1);
    });

    it("runs at the default, and says why, when the agent refuses the level", async () => {

        const lines: string[] = [];
        const ctx = { request: async () => { throw new Error("Invalid value"); } } as unknown as AcpAgentContext;

        expect(await applyEffort(ctx, { sessionId: "S", newSessionResponse: {} }, "max", text => lines.push(text))).toBeUndefined();
        expect(lines[0]).toBe("Effort: 'max' was not set - Invalid value. The model runs at its default.");
    });
});

describe("claudeCliPrice", () => {

    it("reads the price per million tokens off a model's description", () => {

        expect(claudeCliPrice({ description: "Opus 5 with 1M context · Best for everyday, complex tasks · $5/$25 per Mtok" })).toBe("$5/$25");
        expect(claudeCliPrice({ description: "Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok" })).toBe("$1/$5");
    });

    it("gives nothing when the description names no price - as it does on some accounts", () => {

        expect(claudeCliPrice({ description: "Opus 5 with 1M context · Best for everyday, complex tasks" })).toBeUndefined();
        expect(claudeCliPrice({})).toBeUndefined();
    });
});

describe("claudeEffort", () => {

    it("takes Claude's own levels, and refuses anything else with a line", () => {

        const lines: string[] = [];

        expect(claudeEffort("xhigh")).toBe("xhigh");
        expect(claudeEffort(undefined)).toBeUndefined();
        expect(claudeEffort("turbo", text => lines.push(text))).toBeUndefined();
        expect(lines[0]).toContain("'turbo' is not one Claude takes");
    });
});

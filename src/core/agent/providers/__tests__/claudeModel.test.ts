import { describe, expect, it } from "vitest";

import type { ModelInfo } from "@anthropic-ai/claude-agent-sdk";

import { AgentSessionConfig } from "../../AgentSession";
import { chosenModel, claudeModelChoices, sessionOptions } from "../ClaudeProvider";

function options(config: Partial<AgentSessionConfig>): Record<string, unknown> {

    return sessionOptions(
        { workingDirectory: "/repo", env: {}, ...config } as AgentSessionConfig,
        "new-id",
        {},
        new AbortController());
}

describe("the model a Claude session asks for", () => {

    it("names a picked model to the SDK", () => {

        expect(options({ model: "claude-sonnet-5" }).model).toBe("claude-sonnet-5");
        expect(options({ model: "default" }).model).toBe("default");
    });

    // "auto" is not a model name: sent as one, the API answers `model_not_found`.
    it("leaves the choice to the CLI for auto, blank or no model", () => {

        for (const model of ["auto", " auto ", "", "  ", undefined])
            expect(options({ model }), String(model)).not.toHaveProperty("model");
    });

    it("trims a picked name", () => {

        expect(chosenModel(" claude-opus-5 ")).toBe("claude-opus-5");
        expect(chosenModel("auto")).toBeUndefined();
    });
});

/*
 * The model list is saved under exact ids. A short name (`sonnet`) moves
 * to a newer model when one comes out, and a saved list named "Sonnet 5"
 * would go on running Sonnet 5.5.
 */
describe("the Claude model list", () => {

    const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

    function row(value: string, displayName: string, resolvedModel?: string, efforts = true): ModelInfo {

        return {
            value, displayName, description: "",
            ...(resolvedModel ? { resolvedModel } : {}),
            ...(efforts ? { supportsEffort: true, supportedEffortLevels: [...EFFORTS] } : {})
        };
    }

    // As Claude Code 2.1.319 answered, shortened.
    const cli = [
        row("default", "Default (recommended)", "claude-opus-5-5"),
        row("opus", "Opus 5.5", "claude-opus-5-5"),
        row("sonnet", "Sonnet 5.5", "claude-sonnet-5-5"),
        row("claude-fable-5-2", "Fable 5.2", "claude-fable-5-2"),
        row("haiku", "Haiku 5.5", "claude-haiku-5-5", false),
        row("fable", "Fable 5.1", "claude-fable-5-1"),
        row("claude-sonnet-5", "Sonnet 5", "claude-sonnet-5")
    ];

    it("keeps each model under the exact id it runs, with its short names beside it", () => {

        expect(claudeModelChoices(cli)).toEqual([
            { id: "claude-opus-5-5", name: "Opus 5.5", efforts: [...EFFORTS], aliases: ["default", "opus"] },
            { id: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: [...EFFORTS], aliases: ["sonnet"] },
            { id: "claude-fable-5-2", name: "Fable 5.2", efforts: [...EFFORTS] },
            { id: "claude-haiku-5-5", name: "Haiku 5.5", aliases: ["haiku"] },
            { id: "claude-fable-5-1", name: "Fable 5.1", efforts: [...EFFORTS], aliases: ["fable"] },
            { id: "claude-sonnet-5", name: "Sonnet 5", efforts: [...EFFORTS] }
        ]);
    });

    it("keeps the default row's name when no other row runs that model", () => {

        expect(claudeModelChoices([row("default", "Default (recommended)", "claude-opus-5-5")]))
            .toEqual([{ id: "claude-opus-5-5", name: "Default (recommended)", efforts: [...EFFORTS], aliases: ["default"] }]);
    });

    it("gives the short names as they are when the CLI does not say what they run", () => {

        expect(claudeModelChoices([row("opus", "Opus 5.5"), row("sonnet", "Sonnet 5.5", "  ")]).map(choice => choice.id))
            .toEqual(["opus", "sonnet"]);
    });
});

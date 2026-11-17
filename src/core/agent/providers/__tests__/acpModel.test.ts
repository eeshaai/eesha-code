import { describe, expect, it } from "vitest";

import {
    AcpActiveSession, AcpAgentContext, AcpConfigOption, AcpModelState, applyModel, choicesOf, modelChoices, modelList,
    modelOption
} from "../AcpProvider";

/*
 * The model on an ACP session is listed one of two ways. The protocol's
 * session config options: the select with `category: "model"` lists
 * what the agent runs, and `session/set_config_option` picks one. Or
 * the older `models` field, set with `session/set_model` - Kiro's.
 */

const modelSelect: AcpConfigOption = {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "sonnet",
    options: [
        { value: "sonnet", name: "Claude Sonnet" },
        { value: "haiku", name: "Claude Haiku" }
    ]
};

const grouped: AcpConfigOption = {
    ...modelSelect,
    options: [
        { group: "fast", name: "Fast", options: [{ value: "haiku", name: "Claude Haiku" }] },
        { group: "smart", name: "Smart", options: [{ value: "opus", name: "Claude Opus" }] }
    ]
};

const modeSelect: AcpConfigOption = {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "ask",
    options: [{ value: "ask", name: "Ask" }]
};

function harness(options: AcpConfigOption[] | undefined) {

    const calls: unknown[] = [];
    const lines: string[] = [];

    const ctx = {
        request(method: string, params?: unknown) {

            calls.push({ method, params });

            return Promise.resolve({ configOptions: options ?? [] });
        }
    } as unknown as AcpAgentContext;

    const session = {
        sessionId: "sess-1",
        newSessionResponse: { configOptions: options }
    } as unknown as AcpActiveSession;

    return { ctx, session, calls, lines, log: (text: string) => { lines.push(text); } };
}

/** Kiro's shape: no `configOptions`, a `models` field instead. */
const kiroModels: AcpModelState = {
    currentModelId: "auto",
    availableModels: [
        { modelId: "auto", name: "auto" },
        { modelId: "claude-sonnet-5", name: "claude-sonnet-5", description: "" }
    ]
};

function kiroHarness() {

    const h = harness(undefined);

    (h.session as { newSessionResponse: unknown }).newSessionResponse = { models: kiroModels };

    return h;
}

describe("modelList", () => {

    it("reads the older models field when there is no model config option", () => {

        const list = modelList({ models: kiroModels });

        expect(list?.via).toBe("set_model");
        expect(modelChoices(list!).map(choice => choice.value)).toEqual(["auto", "claude-sonnet-5"]);
    });

    it("prefers the config option when an agent sends both", () => {

        expect(modelList({ configOptions: [modelSelect], models: kiroModels })?.via).toBe("config_option");
    });

    it("is nothing when the agent lists no models either way", () => {

        expect(modelList({})).toBeUndefined();
        expect(modelList({ models: { currentModelId: "x", availableModels: [] } })).toBeUndefined();
        expect(modelList(undefined)).toBeUndefined();
    });

    it("names a model by its id when it has no name", () => {

        const list = modelList({ models: { currentModelId: "a", availableModels: [{ modelId: "a" }] } });

        expect(modelChoices(list!)).toEqual([{ value: "a", name: "a" }]);
    });
});

describe("modelOption", () => {

    it("is the select tagged model, not the mode or a boolean", () => {

        expect(modelOption([modeSelect, modelSelect])?.id).toBe("model");
        expect(modelOption([modeSelect])).toBeUndefined();
        expect(modelOption([{ ...modelSelect, type: "boolean", currentValue: true }])).toBeUndefined();
        expect(modelOption(undefined)).toBeUndefined();
    });

    it("flattens grouped choices", () => {

        expect(choicesOf(grouped).map(choice => choice.value)).toEqual(["haiku", "opus"]);
        expect(choicesOf(modelSelect).map(choice => choice.value)).toEqual(["sonnet", "haiku"]);
    });
});

describe("applyModel", () => {

    it("sets the model the task asked for, by the option's id, and says so", async () => {

        const h = harness([modeSelect, modelSelect]);

        expect(await applyModel(h.ctx, h.session, "haiku", h.log)).toBe("haiku");

        expect(h.calls).toEqual([{
            method: "session/set_config_option",
            params: { sessionId: "sess-1", configId: "model", value: "haiku" }
        }]);
        expect(h.lines).toEqual(["Model: Claude Haiku (set on the session)."]);
    });

    it("leaves auto to the agent and only reports what it is on", async () => {

        const h = harness([modelSelect]);

        expect(await applyModel(h.ctx, h.session, "auto", h.log)).toBe("sonnet");
        expect(await applyModel(h.ctx, h.session, undefined, h.log)).toBe("sonnet");

        expect(h.calls).toEqual([]);
        expect(h.lines).toEqual([
            "Model: Claude Sonnet (the agent's own choice).",
            "Model: Claude Sonnet (the agent's own choice)."
        ]);
    });

    it("refuses a model the agent does not list, naming what it does", async () => {

        const h = harness([modelSelect]);

        await expect(applyModel(h.ctx, h.session, "gpt-5", h.log))
            .rejects.toThrow(/does not offer model 'gpt-5'. It offers: sonnet, haiku/);

        expect(h.calls).toEqual([]);
    });

    it("finds a model inside a group", async () => {

        const h = harness([grouped]);

        await applyModel(h.ctx, h.session, "opus", h.log);

        expect(h.calls).toHaveLength(1);
    });

    it("uses session/set_model for an agent that lists models the older way (Kiro)", async () => {

        const h = kiroHarness();

        await applyModel(h.ctx, h.session, "claude-sonnet-5", h.log);

        expect(h.calls).toEqual([{
            method: "session/set_model",
            params: { sessionId: "sess-1", modelId: "claude-sonnet-5" }
        }]);
        expect(h.lines).toEqual(["Model: claude-sonnet-5 (set on the session)."]);
    });

    it("reports the older list's current model when left on auto", async () => {

        const h = kiroHarness();

        await applyModel(h.ctx, h.session, "auto", h.log);

        expect(h.calls).toEqual([]);
        expect(h.lines).toEqual(["Model: auto (the agent's own choice)."]);
    });

    it("refuses a model missing from the older list too", async () => {

        const h = kiroHarness();

        await expect(applyModel(h.ctx, h.session, "gpt-9", h.log))
            .rejects.toThrow(/does not offer model 'gpt-9'. It offers: auto, claude-sonnet-5/);
    });

    it("says the model is ignored when the agent offers no model option", async () => {

        const h = harness([modeSelect]);

        expect(await applyModel(h.ctx, h.session, "haiku", h.log)).toBeUndefined();

        expect(h.calls).toEqual([]);
        expect(h.lines[0]).toMatch(/offers no model option, so 'model: haiku' is ignored/);
    });
});

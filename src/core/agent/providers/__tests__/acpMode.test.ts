import { describe, expect, it } from "vitest";

import {
    AcpActiveSession, AcpAgentContext, AcpConfigOption, applyAgentMode, applyPermissionOption, modeOption
} from "../AcpProvider";
import { kiroV3Extension, kiroV3RateMultiplier } from "../kiroV3AcpExtension";

/*
 * Kiro v3's modes and its Autopilot switch, as kiro-cli 2.24.1 sent them
 * on `session/new` (observed, no prompt sent): a select with
 * `category: "mode"`, and a select `autopilot` with no category.
 */

const modeSelect: AcpConfigOption = {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "vibe",
    options: [
        { value: "vibe", name: "Default", description: "General coding assistance" },
        { value: "spec", name: "Spec", description: "Structured feature development" },
        { value: "plan", name: "Plan" }
    ]
};

const autopilot: AcpConfigOption = {
    id: "autopilot", name: "Autopilot", type: "select", currentValue: "on",
    options: [
        { value: "on", name: "Autopilot" },
        { value: "off", name: "Supervised" }
    ]
};

const modelSelect: AcpConfigOption = {
    id: "model", name: "Model", category: "model", type: "select", currentValue: "auto",
    options: [{ value: "auto", name: "Auto" }]
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

describe("modeOption", () => {

    it("is the select tagged mode, not the model or another option", () => {

        expect(modeOption([modelSelect, autopilot, modeSelect])?.id).toBe("mode");
        expect(modeOption([modelSelect, autopilot])).toBeUndefined();
        expect(modeOption(undefined)).toBeUndefined();
    });
});

describe("applyAgentMode", () => {

    it("sets the picked mode with set_config_option and says so", async () => {

        const h = harness([modeSelect, modelSelect]);

        expect(await applyAgentMode(h.ctx, h.session, "spec", h.log)).toBe("spec");

        expect(h.calls).toEqual([{
            method: "session/set_config_option",
            params: { sessionId: "sess-1", configId: "mode", value: "spec" }
        }]);
        expect(h.lines).toEqual(["Mode: Spec (set on the session)."]);
    });

    it("leaves the agent's default when nothing is picked, and reports it", async () => {

        const h = harness([modeSelect]);

        expect(await applyAgentMode(h.ctx, h.session, undefined, h.log)).toBe("vibe");

        expect(h.calls).toEqual([]);
        expect(h.lines).toEqual(["Mode: Default (the agent's own default)."]);
    });

    it("sends nothing when the session is already in the picked mode", async () => {

        const h = harness([modeSelect]);

        await applyAgentMode(h.ctx, h.session, "vibe", h.log);
        await applyAgentMode(h.ctx, h.session, "plan", h.log, "plan");

        expect(h.calls).toEqual([]);
    });

    it("switches a held session by the mode it is in now, not the one it opened in", async () => {

        const h = harness([modeSelect]);

        await applyAgentMode(h.ctx, h.session, "vibe", h.log, "spec");

        expect(h.calls).toHaveLength(1);
    });

    it("refuses a mode the agent does not list, naming what it does", async () => {

        const h = harness([modeSelect]);

        await expect(applyAgentMode(h.ctx, h.session, "bug-fix", h.log))
            .rejects.toThrow(/does not offer mode 'bug-fix'. It offers: vibe, spec, plan/);

        expect(h.calls).toEqual([]);
    });

    it("says a picked mode is ignored by an agent with no modes", async () => {

        const h = harness([modelSelect]);

        expect(await applyAgentMode(h.ctx, h.session, "spec", h.log)).toBeUndefined();

        expect(h.calls).toEqual([]);
        expect(h.lines[0]).toMatch(/offers no modes, so 'spec' is ignored/);
    });
});

describe("applyPermissionOption", () => {

    // With Autopilot on, Kiro never asks, and a call it never asks about
    // never reaches the folder boundary.
    it("turns Kiro v3's Autopilot off", async () => {

        const h = harness([modeSelect, autopilot]);

        await applyPermissionOption(h.ctx, h.session, [kiroV3Extension], h.log);

        expect(h.calls).toEqual([
            { method: "session/set_config_option", params: { sessionId: "sess-1", configId: "autopilot", value: "off" } }
        ]);
        expect(h.lines).toEqual(["Autopilot: off (Supervised)."]);
    });

    it("does nothing without an extension that names the option", async () => {

        const h = harness([autopilot]);

        expect(await applyPermissionOption(h.ctx, h.session, [], h.log)).toBeUndefined();

        expect(h.calls).toEqual([]);
    });

    it("does nothing when the agent did not offer the option on this session", async () => {

        const h = harness([modeSelect]);

        expect(await applyPermissionOption(h.ctx, h.session, [kiroV3Extension], h.log)).toBeUndefined();

        expect(h.calls).toEqual([]);
    });
});

describe("kiroV3RateMultiplier", () => {

    it("reads the credit rate off a model choice", () => {

        expect(kiroV3RateMultiplier({ value: "claude-haiku-4.5", _meta: { kiro: { rateMultiplier: 0.4 } } })).toBe(0.4);
    });

    it("is nothing when the choice carries no number", () => {

        expect(kiroV3RateMultiplier({ value: "auto" })).toBeUndefined();
        expect(kiroV3RateMultiplier({ _meta: { kiro: { rateMultiplier: "1" } } })).toBeUndefined();
        expect(kiroV3RateMultiplier(undefined)).toBeUndefined();
    });
});

import { describe, expect, it } from "vitest";

import { defaultFeatures, type EngineSettings } from "../../core/settings/engineSettings";
import { type AiChoiceEnv, offeredRuntimes } from "../aiChoice";

/*
 * The runtimes the pickers offer, and the fake runtime's flag: off by
 * default and then never offered; on, offered last.
 */

function settings(fakeRuntime: boolean, providers?: string[]): EngineSettings {

    return {
        ai: { acpAgents: { kiro: {} }, ...(providers ? { providers } : {}) },
        features: { ...defaultFeatures(), fakeRuntime }
    } as unknown as EngineSettings;
}

const env = { warn: () => undefined } as unknown as AiChoiceEnv;

describe("offeredRuntimes and the fake runtime", () => {

    it("is off by default", () => {

        expect(defaultFeatures().fakeRuntime).toBe(false);
    });

    it("does not offer the fake runtime with its flag off", () => {

        expect(offeredRuntimes(settings(false), env)).not.toContain("fake");
        expect(offeredRuntimes(settings(false, ["claude"]), env)).toEqual(["claude"]);
    });

    it("offers it last with its flag on", () => {

        expect(offeredRuntimes(settings(true), env)).toEqual(["ghcp", "claude", "kiro", "fake"]);
        expect(offeredRuntimes(settings(true, ["claude"]), env)).toEqual(["claude", "fake"]);
    });

    it("offers it once when settings.json already lists it", () => {

        expect(offeredRuntimes(settings(true, ["fake", "claude"]), env)).toEqual(["fake", "claude"]);
    });

    it("is offered after `unlisted` cuts the list down", () => {

        const cut = { ...env, unlisted: () => ["claude"] } as AiChoiceEnv;

        expect(offeredRuntimes(settings(true), cut)).toEqual(["claude", "fake"]);
    });
});

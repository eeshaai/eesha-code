// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { checkStartPick } from "../workspaces";

/*
 * The runtime, model and Permissions level a new session can be started
 * with from the start page's box.
 */
describe("checkStartPick", () => {

    const runtimes = ["claude", "ghcp", "kiro"];

    it("takes nothing at all", () => {

        expect(checkStartPick({}, runtimes)).toEqual({ pick: {} });
    });

    it("takes a runtime and its model", () => {

        expect(checkStartPick({ runtime: "claude", model: "sonnet" }, runtimes)).toEqual({ pick: { runtime: "claude", model: "sonnet" } });
    });

    it("refuses a runtime not on offer", () => {

        expect(checkStartPick({ runtime: "gemini" }, runtimes)).toHaveProperty("problem");
    });

    it("refuses a model without a runtime", () => {

        expect(checkStartPick({ model: "sonnet" }, runtimes)).toHaveProperty("problem");
    });

    it("refuses a model id on two lines", () => {

        expect(checkStartPick({ runtime: "claude", model: "a\nb" }, runtimes)).toHaveProperty("problem");
    });

    it("takes a level the runtime offers, with no runtime pick", () => {

        expect(checkStartPick({ level: { runtime: "claude", level: "manual" } }, runtimes))
            .toEqual({ pick: { level: { runtime: "claude", level: "manual" } } });

        expect(checkStartPick({ level: { runtime: "kiro", level: "agent" } }, runtimes))
            .toEqual({ pick: { level: { runtime: "kiro", level: "agent" } } });
    });

    it("refuses a level the runtime does not offer", () => {

        // Manual is an SDK level; an ACP agent offers Agent's Choice instead.
        expect(checkStartPick({ level: { runtime: "kiro", level: "manual" } }, runtimes)).toHaveProperty("problem");
        expect(checkStartPick({ level: { runtime: "claude", level: "agent" } }, runtimes)).toHaveProperty("problem");
        expect(checkStartPick({ level: { runtime: "claude", level: "max" } }, runtimes)).toHaveProperty("problem");
    });

    it("refuses a level with no runtime or a runtime not on offer", () => {

        expect(checkStartPick({ level: { level: "auto" } }, runtimes)).toHaveProperty("problem");
        expect(checkStartPick({ level: { runtime: "gemini", level: "auto" } }, runtimes)).toHaveProperty("problem");
    });
});

import * as path from "path";
import { describe, expect, it } from "vitest";

import { configScope, resolveConfigValue } from "../configScope";

/**
 * `${{ }}` in the two configuration files. Asserted here is the part
 * that is not the resolver's: which namespaces exist before a run does,
 * what the deny list vetoes, and the refusal when there is no workspace.
 */

const WORKSPACE = "C:/repo";

const SOURCE = "C:/repo/.eesha/settings.json";

const templating = (extra: Record<string, unknown> = {}) => ({
    workspaceFolder: WORKSPACE,
    home: "C:/Users/me",
    processEnv: { TEAM: "platform", TOKEN: "secret" },
    ...extra
});

describe("configScope", () => {

    it("offers the four anchors, with cwd standing at the workspace root", () => {

        const scope = configScope(templating())!;

        expect(scope.workspaceFolder).toBe(WORKSPACE);
        expect(scope.workspaceConfig).toBe(path.join(WORKSPACE, ".eesha"));
        expect(scope.cwd).toBe(WORKSPACE);
        expect(scope.home).toBe("C:/Users/me");
    });

    /*
     * A run's namespaces, from a file read before any run exists. Left
     * undefined rather than empty so the resolver's own explanation -
     * "vars are not available here" - is what a person reads.
     */
    it("offers no vars, params or run context", () => {

        const scope = configScope(templating())!;

        expect(scope.vars).toBeUndefined();
        expect(scope.params).toBeUndefined();
        expect(scope.run).toBeUndefined();
    });

    it("has nothing to anchor to without a workspace", () => {

        expect(configScope({ workspaceFolder: undefined })).toBeUndefined();
    });
});

describe("resolveConfigValue", () => {

    it("leaves a file that writes no expression exactly as it was", () => {

        const value = { sdd: { style: "kiro" }, ai: { "ai@1": { model: "auto" } } };

        expect(resolveConfigValue(value, SOURCE, {})).toBe(value);
    });

    it("resolves an anchor wherever it sits in the structure", () => {

        const resolved = resolveConfigValue(
            { sdd: { specsDir: "${{ workspaceFolder }}/specs" } },
            SOURCE,
            templating());

        expect(resolved).toEqual({ sdd: { specsDir: "C:/repo/specs" } });
    });

    it("reads the machine environment", () => {

        expect(resolveConfigValue({ team: "${{ env.TEAM }}" }, SOURCE, templating()))
            .toEqual({ team: "platform" });
    });

    /* settings.json declares the deny list, so an env read here must not bypass it. */
    it("refuses a name env.denied vetoes, saying so", () => {

        expect(() => resolveConfigValue(
            { token: "${{ env.TOKEN }}" }, SOURCE, templating({ denied: ["token"] })))
            .toThrow(/'env.denied' vetoes/);
    });

    it("keeps a name the deny list does not name", () => {

        expect(resolveConfigValue(
            { team: "${{ env.TEAM }}" }, SOURCE, templating({ denied: ["TOKEN"] })))
            .toEqual({ team: "platform" });
    });

    /* A run's namespace, asked for too early - the resolver's own message, with the file named. */
    it("explains a namespace that does not exist here", () => {

        expect(() => resolveConfigValue({ x: "${{ vars.retries }}" }, SOURCE, templating()))
            .toThrow(/vars are not available here/);
    });

    it("names the file it could not resolve", () => {

        expect(() => resolveConfigValue({ x: "${{ env.MISSING }}" }, SOURCE, templating()))
            .toThrow(SOURCE);
    });

    /* An empty string would produce a path rooted at the top of the filesystem. */
    it("refuses rather than substituting nothing when no workspace is open", () => {

        expect(() => resolveConfigValue({ x: "${{ workspaceFolder }}/a" }, SOURCE, {}))
            .toThrow(/no workspace is open/);
    });
});

/*
 * `style.yml` defers `spec`, which `src/sdd/phase/specVars` finishes
 * later. Deferring one namespace must not make the pass lenient about
 * the others.
 */
describe("resolveConfigValue with a deferred namespace", () => {

    it("leaves a deferred expression exactly as written", () => {

        expect(resolveConfigValue({ x: "${{ spec.dir }}/a" }, SOURCE, templating(), ["spec"]))
            .toEqual({ x: "${{ spec.dir }}/a" });
    });

    it("resolves everything else in the same value", () => {

        expect(resolveConfigValue(
            { x: "${{ workspaceFolder }}/${{ spec.type }}.md" }, SOURCE, templating(), ["spec"]))
            .toEqual({ x: `${WORKSPACE}/\${{ spec.type }}.md` });
    });

    it("still fails on a namespace nobody deferred", () => {

        expect(() => resolveConfigValue(
            { x: "${{ spec.dir }}", y: "${{ vars.docs }}" }, SOURCE, templating(), ["spec"]))
            .toThrow(/vars are not available here/);
    });

    it("needs no workspace when every expression is deferred", () => {

        expect(resolveConfigValue({ x: "${{ spec.dir }}/a" }, SOURCE, {}, ["spec"]))
            .toEqual({ x: "${{ spec.dir }}/a" });
    });

    it("still refuses when one of them is not", () => {

        expect(() => resolveConfigValue({ x: "${{ spec.dir }}", y: "${{ home }}" }, SOURCE, {}, ["spec"]))
            .toThrow(/no workspace is open/);
    });
});

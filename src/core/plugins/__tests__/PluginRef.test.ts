import { describe, expect, it } from "vitest";
import { parsePluginRef, pluginRefKey } from "../PluginRef";

describe("parsePluginRef", () => {

    it("accepts id@version", () => {

        expect(parsePluginRef("ai@1")).toEqual({ id: "ai", version: "1" });
    });

    it("accepts a single-word id", () => {

        expect(parsePluginRef("pwsh@1")).toEqual({ id: "pwsh", version: "1" });
    });

    it("accepts a multi-digit version", () => {

        expect(parsePluginRef("pwsh@12")).toEqual({ id: "pwsh", version: "12" });
    });

    it("trims surrounding whitespace", () => {

        expect(parsePluginRef("  pwsh@1  ")).toEqual({ id: "pwsh", version: "1" });
    });

    it("rejects a bare id - an implicit version would let a workflow's meaning change under it", () => {

        expect(parsePluginRef("ghcp")).toBeUndefined();
    });

    it("rejects the bare word ai, which the parser must have resolved already", () => {

        expect(parsePluginRef("ai")).toBeUndefined();
    });

    it("rejects a missing id", () => {

        expect(parsePluginRef("@1")).toBeUndefined();
    });

    it("rejects uppercase", () => {

        expect(parsePluginRef("Foo@1")).toBeUndefined();
    });

    it("rejects a dotted version", () => {

        expect(parsePluginRef("a@1.2")).toBeUndefined();
    });

    it("rejects a namespaced marketplace-style reference", () => {

        expect(parsePluginRef("actions/setup-node@v4")).toBeUndefined();
    });

    it("rejects empty and undefined", () => {

        expect(parsePluginRef("")).toBeUndefined();
        expect(parsePluginRef(undefined)).toBeUndefined();
    });

    it("rejects leading and trailing hyphens", () => {

        expect(parsePluginRef("-foo@1")).toBeUndefined();
        expect(parsePluginRef("foo-@1")).toBeUndefined();
    });

    it("round-trips through pluginRefKey", () => {

        expect(pluginRefKey(parsePluginRef("github-pr@1")!)).toBe("github-pr@1");
    });
});

import { describe, expect, it } from "vitest";

import { Plugin } from "../Plugin";
import { PluginOrigin, PluginRegistry } from "../PluginRegistry";

// Same rule `mergeScopes` applies to tasks and workflows: the narrowest
// scope wins, and a wider scope stepping aside is not an error.

const plugin = (id = "deploy"): Plugin =>
    ({ id, version: "1", execute: async () => ({ success: true }) });

function registry(...origins: PluginOrigin[]): PluginRegistry {

    const built = new PluginRegistry();

    for (const origin of origins)
        built.register(plugin(), origin, `${origin}/deploy.js`);

    return built;
}

const originOf = (built: PluginRegistry) =>
    built.describe({ id: "deploy", version: "1" })?.origin;

describe("plugin scope precedence", () => {

    it.each([
        ["folder", "workspace"],
        ["folder", "profile"],
        ["workspace", "profile"]
    ] as [PluginOrigin, PluginOrigin][])(
        "a %s plugin silently shadows the %s copy",
        (narrow, wide) => {

            const built = registry(narrow);

            expect(() => built.register(plugin(), wide)).not.toThrow();
            expect(originOf(built)).toBe(narrow);
        });

    it("keeps the narrower plugin's own source path, not the shadowed one's", () => {

        const built = registry("folder");

        built.register(plugin(), "profile", "profile/deploy.js");

        expect(built.describe({ id: "deploy", version: "1" })?.sourcePath).toBe("folder/deploy.js");
    });

    it("registers all three scopes' distinct ids without complaint", () => {

        const built = new PluginRegistry();

        built.register(plugin("build"), "folder");
        built.register(plugin("deploy"), "workspace");
        built.register(plugin("pull"), "profile");

        expect(built.keys()).toEqual(["build@1", "deploy@1", "pull@1"]);
    });
});

describe("plugin clashes that are still errors", () => {

    it.each(["folder", "workspace", "profile"] as PluginOrigin[])(
        "two %s plugins declaring one id - a plausible accident with no right answer",
        origin => {

            expect(() => registry(origin, origin)).toThrow("deploy@1");
        });

    it.each(["folder", "workspace", "profile"] as PluginOrigin[])(
        "a %s plugin colliding with a bundled id - a builtin is never shadowed",
        origin => {

            const built = registry("builtin");

            expect(() => built.register(plugin(), origin)).toThrow("deploy@1");
            expect(originOf(built)).toBe("builtin");
        });

    // `builtin` is not on the specificity ladder: it is neither
    // shadowed by a user plugin nor able to shadow one. Both directions
    // throw.
    it("a builtin arriving after a user plugin, which is just as much a mistake", () => {

        const built = registry("folder");

        expect(() => built.register(plugin(), "builtin")).toThrow("deploy@1");
    });

    // Shadowing is directional: only a wider scope steps aside. The
    // loader always reads narrowest-first, so this order does not
    // arise in practice, but it should fail loudly if that changes.
    it("a narrower plugin arriving after a wider one already claimed the id", () => {

        const built = registry("profile");

        expect(() => built.register(plugin(), "folder")).toThrow("deploy@1");
    });
});

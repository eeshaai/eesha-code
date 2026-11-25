import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { NodeStyleFiles } from "../NodeStyleFiles";
import { StyleRegistry } from "../StyleRegistry";
import { Scope, StyleFiles } from "../styleFiles";

const shipped = fs.readFileSync(
    path.resolve(__dirname, "..", "..", "..", "..", "resources", "styles", "custom", "style.yml"), "utf8");

/** Scopes as a table: `{ workspace: { custom: { "instructions/design.md": "..." } } }`. */
type Tree = Partial<Record<Scope, Record<string, Record<string, string>>>>;

function files(tree: Tree): StyleFiles {

    return {
        styles: async scope => Object.keys(tree[scope] ?? {}),
        read: async (scope, styleId, relative) => tree[scope]?.[styleId]?.[relative]
    };
}

function registry(tree: Tree): StyleRegistry {

    return new StyleRegistry(files(tree));
}

/** The shipped style, rewritten under another id so a scope can hold a different one. */
function as(id: string, name = id): string {

    return shipped.replace("id: custom", `id: ${id}`).replace("name: Custom", `name: ${name}`);
}

const BUILTIN: Tree = { builtin: { custom: { "style.yml": shipped } } };

describe("loading a style", () => {

    it("parses the built-in through the same parser a written one uses", async () => {

        const style = await registry(BUILTIN).load("custom");

        expect(style.id).toBe("custom");
        expect(style.stages).toHaveLength(5);
    });

    it("says where the style was found", async () => {

        expect((await registry(BUILTIN).load("custom")).from).toBe("builtin");
        expect((await registry({ profile: { mine: { "style.yml": as("mine") } } }).load("mine")).from).toBe("profile");
    });

    /*
     * A style lives in one place. A copy of the built-in under its own id
     * is not an override - it is a clash, and neither runs.
     */
    it("refuses a workspace style with a built-in's id, pointing at Eject Style", async () => {

        const mine = shipped.replace("name: Custom", "name: Ours");

        await expect(registry({ ...BUILTIN, workspace: { custom: { "style.yml": mine } } }).load("custom"))
            .rejects.toThrow(/Style 'custom' is in more than one place: builtin, workspace\..*Eject Style/s);
    });

    it("refuses the same id in the profile and the workspace", async () => {

        const tree: Tree = {
            profile: { mine: { "style.yml": as("mine") } },
            workspace: { mine: { "style.yml": as("mine") } }
        };

        await expect(registry(tree).load("mine")).rejects.toThrow(/'mine' is in more than one place: profile, workspace/);
    });

    it("says where a style is meant to live when there is no such id", async () => {

        await expect(registry(BUILTIN).load("research")).rejects.toThrow(/No style 'research'/);
    });

    it("reports a broken style rather than skipping it", async () => {

        const tree: Tree = { workspace: { custom: { "style.yml": shipped.replace("name: Custom\n", "") } } };

        await expect(registry(tree).load("custom")).rejects.toThrow(/has no 'name:'/);
    });
});

describe("listing styles", () => {

    it("lists an id found in two places once, carrying the clash as its error", async () => {

        const tree: Tree = { ...BUILTIN, workspace: { custom: { "instructions/tasks.md": "ours" } } };
        const [entry] = await registry(tree).list();

        expect(entry.id).toBe("custom");
        expect(entry.scope).toBeUndefined();
        expect(entry.prompts).toEqual(["builtin", "workspace"]);
        expect(entry.error).toMatch(/in more than one place/);
    });

    it("lists a style each scope contributes separately", async () => {

        const tree: Tree = {
            builtin: { custom: { "style.yml": shipped } },
            workspace: { research: { "style.yml": as("research", "Research") } }
        };

        expect((await registry(tree).list()).map(entry => `${entry.id}:${entry.scope}`))
            .toEqual(["custom:builtin", "research:workspace"]);
    });

    /*
     * One unparseable folder must not empty the picker. A broken style
     * the user can see and read the error of is recoverable; one that
     * silently vanished is a bug report.
     */
    it("carries a parse failure on the entry instead of throwing", async () => {

        const tree: Tree = {
            builtin: { custom: { "style.yml": shipped } },
            workspace: { broken: { "style.yml": "schema: 1\nid: broken\nname: B\ndesc: d\nformat:\n  grammar: instructions/g.md\n" } }
        };

        const entries = await registry(tree).list();

        expect(entries.map(entry => entry.id)).toEqual(["broken", "custom"]);
        expect(entries[0].error).toMatch(/no 'specTypes:'/);
        expect(entries[1].error).toBeUndefined();
    });

    it("flags a prompts-only folder whose style exists nowhere", async () => {

        const tree: Tree = { workspace: { ghost: { "instructions/design.md": "x" } } };

        expect((await registry(tree).list())[0].error).toMatch(/only overrides prompts of a style that does not exist/);
    });
});

describe("prompt resolution", () => {

    const tree: Tree = {
        builtin: {
            custom: {
                "style.yml": shipped,
                "instructions/design.md": "built-in design",
                "instructions/tasks.md": "built-in tasks"
            }
        }
    };

    it("reads the file from the style's own folder", async () => {

        const resolved = await registry(tree).file("custom", "instructions/design.md");

        expect(resolved?.text).toBe("built-in design");
        expect(resolved?.scope).toBe("builtin");
    });

    /* Replacing one prompt of a built-in in place is not allowed: copy the style under a new id. */
    it("refuses a folder that replaces one prompt of the built-in", async () => {

        const mine: Tree = { ...tree, workspace: { custom: { "instructions/tasks.md": "ours tasks" } } };

        await expect(registry(mine).file("custom", "instructions/tasks.md")).rejects.toThrow(/in more than one place/);
    });

    it("returns nothing for a prompt no scope has", async () => {

        expect(await registry(tree).file("custom", "instructions/nope.md")).toBeUndefined();
    });
});

/*
 * Prompts do not compose: a `.append.md` beside one is not stitched onto the end of it. A scope that wants different words writes
 * the whole file, so the text a phase runs is one file with one owner,
 * and the question behind surprising output - which file said this -
 * has one answer.
 */
describe("nothing composes", () => {

    it("ignores a file that only adds to a prompt, whatever it is named", async () => {

        const tree: Tree = {
            workspace: {
                mine: {
                    "style.yml": as("mine"),
                    "instructions/design.md": "ours design",
                    "instructions/design.append.md": "house rule"
                }
            }
        };

        const resolved = await registry(tree).file("mine", "instructions/design.md");

        expect(resolved?.text).toBe("ours design");
        expect(resolved?.scope).toBe("workspace");
    });
});

describe("on disk", () => {

    const builtin = path.resolve(__dirname, "..", "..", "..", "..", "resources", "styles");

    it("reads the shipped styles directory as the built-in scope", async () => {

        const registered = new StyleRegistry(new NodeStyleFiles({ builtin }));

        expect((await registered.list()).map(entry => entry.id)).toContain("custom");
        expect((await registered.load("custom")).stages).toHaveLength(5);
    });

    it("treats an absent scope directory as empty rather than an error", async () => {

        const registered = new StyleRegistry(
            new NodeStyleFiles({ builtin, workspace: path.join(builtin, "does-not-exist") }));

        expect((await registered.list()).map(entry => entry.id)).toContain("custom");
    });

    /*
     * `package.json` is real and readable, so this fails loudly if the
     * guard ever goes - a non-existent target would pass either way.
     */
    it("refuses to read a path climbing out of the style folder", async () => {

        const nodeFiles = new NodeStyleFiles({ builtin });

        expect(await nodeFiles.read("builtin", "custom", "../../../package.json")).toBeUndefined();
        expect(await nodeFiles.read("builtin", "custom", "style.yml")).toBeDefined();
    });

    it("allows a path that wanders but lands back inside", async () => {

        expect(await new NodeStyleFiles({ builtin }).read("builtin", "custom", "../custom/style.yml")).toBeDefined();
    });
});

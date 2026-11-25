import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { ideaOf, isTerminal, pipeline, startsSession } from "../model/style";
import { parseStyle } from "../parser/parseStyle";
import { GRAMMAR_FILE } from "../phase/grammar";

/**
 * The shipped `custom` style as a *fixture*: it is valid, and it is
 * shaped the way we meant it.
 *
 * The one place in this codebase that names a style. Everything else -
 * the walk, the parser, the registry, the config - is tested against
 * styles written for the test, because the engine has no idea which
 * styles exist and a suite organised by style would quietly say
 * otherwise.
 *
 * What this file is for, then, is narrow and worth having:
 *
 *   - The shipped style goes through the same parser a hand-written one
 *     does. A built-in needing its own code path would mean the format
 *     was missing something.
 *   - Every prompt the style names exists beside it. A style that parses
 *     but points at a file nobody wrote fails at the worst moment,
 *     mid-phase, in front of a user.
 *   - The pipeline is what the documentation claims.
 */

const root = path.resolve(__dirname, "..", "..", "..");
const stylesDir = path.join(root, "resources", "styles");

function load(id: string) {

    return parseStyle(fs.readFileSync(path.join(stylesDir, id, "style.yml"), "utf8"), id);
}

const shipped = fs.readdirSync(stylesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name);

describe("every shipped style", () => {

    it.each(shipped)("%s parses through the same function a written style does", id => {

        expect(load(id).id).toBe(id);
    });

    it.each(shipped)("%s names only prompts that exist beside it", id => {

        const style = load(id);

        // A stage that names no file of its own runs `instructions/<id>.md`
        // from the style folder, so what a shipped style points at is
        // its own prompts - checked against the folder below.
        const named = style.stages
            .map(stage => stage.instructions)
            .filter(one => one?.root === "style")
            .map(one => one!.path);

        for (const prompt of named)
            expect(fs.existsSync(path.join(stylesDir, id, ...prompt.split("/")))).toBe(true);
    });

    /*
     * One grammar for every style, beside the style folders. A shipped
     * style carrying its own would be a file nothing reads.
     */
    it("ships the one shared grammar, and no style carries its own", () => {

        expect(fs.existsSync(path.join(stylesDir, GRAMMAR_FILE))).toBe(true);

        for (const id of shipped)
            expect(fs.existsSync(path.join(stylesDir, id, GRAMMAR_FILE))).toBe(false);
    });

    it.each(shipped)("%s ends every pipeline somewhere a user can act", id => {

        const style = load(id);

        for (const specType of style.specTypes)
            expect(pipeline(style, specType.id).length).toBeGreaterThan(0);
    });
});

describe("custom", () => {

    const custom = load("custom");

    it("takes the ask in, runs the drafting phases gated, and hands the work out", () => {

        expect(custom.stages.map(stage => stage.id))
            .toEqual(["idea", "requirements", "design", "tasks", "implement"]);

        // Everything between the gates is a drafting phase, and every one
        // of them waits to be pressed, so no key says so.
        expect(custom.stages.filter(stage => !startsSession(stage)).map(stage => stage.id))
            .toEqual(["requirements", "design", "tasks"]);
    });

    it("skips design for a bug and keeps it for a feature", () => {

        expect(pipeline(custom, "feature").map(stage => stage.id))
            .toEqual(["idea", "requirements", "design", "tasks", "implement"]);

        expect(pipeline(custom, "bug").map(stage => stage.id))
            .toEqual(["idea", "requirements", "tasks", "implement"]);
    });

    /**
     * The two gates, which every style has. Both start a conversation
     * nothing waits on, and each declares which gate it is rather than
     * leaving the code to work it out from an empty `produces`.
     */
    it("declares both gates, and only the output one is terminal", () => {

        const idea = ideaOf(custom)!;
        const implement = custom.stages.find(stage => stage.id === "implement")!;

        expect(idea.id).toBe("idea");
        expect(idea.produces).toEqual(["idea.md"]);
        expect(isTerminal(idea)).toBe(false);
        expect(startsSession(idea)).toBe(true);

        expect(implement.id).toBe("implement");
        expect(implement.produces).toEqual([]);
        expect(isTerminal(implement)).toBe(true);
        expect(startsSession(implement)).toBe(true);
    });

    /*
     * One document per drafting phase. A stage producing two would be
     * one a human could only half-approve at its gate.
     */
    it("gates each drafting phase on exactly one document", () => {

        for (const stage of custom.stages.filter(one => !startsSession(one)))
            expect(stage.produces).toHaveLength(1);
    });
});

import { describe, expect, it } from "vitest";
import { Stage } from "../../model/style";
import { DEFAULT_PRESETS, presetsFor } from "../presets";

/*
 * The starting sentences one stage's revise box offers. The parser has
 * already checked each list; this is the merge, the fallback and the
 * spec variables.
 */
describe("presetsFor", () => {

    const facts = { specDir: ".eesha/specs/login", specPath: "C:/repo/.eesha/specs/login", specType: "feature", stageId: "design" };

    const stage = (presets?: Stage["presets"]): Stage => ({
        id: "design",
        label: "design",
        produces: ["design.md"],
        instructions: { root: "style", path: "instructions/design.md" },
        presets
    });

    const tighten = { label: "Tighten", text: "Cut words." };
    const match = { label: "Match code", text: "Fix what the code contradicts." };

    it("gives the built-in sentences when neither the style nor the stage declares any", () => {

        expect(presetsFor({}, stage(), facts, "t")).toEqual(DEFAULT_PRESETS);
        expect(presetsFor({ presets: undefined }, stage(undefined), facts, "t")).toEqual(DEFAULT_PRESETS);
    });

    it("has two built-in sentences, the ones used when the style names none", () => {

        expect(DEFAULT_PRESETS.map(preset => preset.label))
            .toEqual(["Revise (Prompt changed)", "Revise (Prev doc(s) changed)"]);
    });

    it("replaces the built-in sentences with the style's own", () => {

        expect(presetsFor({ presets: [tighten] }, stage(), facts, "t")).toEqual([tighten]);
    });

    it("replaces them with the stage's own, when only the stage declares any", () => {

        expect(presetsFor({}, stage([match]), facts, "t")).toEqual([match]);
    });

    it("puts the style's list ahead of the stage's - general before specific", () => {

        expect(presetsFor({ presets: [tighten] }, stage([match]), facts, "t")).toEqual([tighten, match]);
    });

    it("answers a spec variable in the text, and in the label", () => {

        const declared = [{ label: "For ${{ spec.name }}", text: "Re-read what ${{ spec.name }} touches in ${{ spec.dir }}, ${{ spec.stage }} pass." }];

        expect(presetsFor({ presets: declared }, stage(), facts, "t")).toEqual([{
            label: "For login",
            text: "Re-read what login touches in .eesha/specs/login, design pass."
        }]);
    });

    it("does not change the lists it was given", () => {

        const declared = [{ label: "A", text: "${{ spec.name }}" }];
        const own = stage([{ label: "B", text: "${{ spec.type }}" }]);

        presetsFor({ presets: declared }, own, facts, "t");

        expect(declared[0].text).toBe("${{ spec.name }}");
        expect(own.presets![0].text).toBe("${{ spec.type }}");
    });

    it("refuses a spec fact this run cannot give, naming where", () => {

        const declared = [{ label: "A", text: "${{ spec.path }}" }];

        expect(() => presetsFor({ presets: declared }, stage(), { ...facts, specPath: undefined }, "Style 't' stage 'design' presets"))
            .toThrow(/Style 't' stage 'design' presets writes '\$\{\{ spec.path \}\}', but this run has no spec.path/);
    });
});

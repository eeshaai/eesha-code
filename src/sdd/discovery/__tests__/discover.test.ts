import { describe, expect, it } from "vitest";
import { configFromSettings } from "../../config/sddConfig";
import { parseStyle } from "../../parser/parseStyle";
import { discover } from "../discover";
import { SpecFiles } from "../specFiles";

/**
 * Two styles written for these tests, differing the way real ones do:
 * different opening documents, one with a phase a spec type may skip,
 * one with an optional artifact.
 */
const alpha = parseStyle(`
schema: 1
id: alpha
name: Alpha
desc: Three documents.
specTypes:
  - id: feature
    label: Feature
    stages: [spec, plan, implement]
  - id: bug
    label: Bug
    stages: [spec, implement]
stages:
  - id: spec
    produces: [alpha-spec.md]
  - id: plan
    produces: [alpha-plan.md]
`, "alpha");

const beta = parseStyle(`
schema: 1
id: beta
name: Beta
desc: Two documents.
specTypes:
  - id: standard
    label: Standard
    stages: [outline]
stages:
  - id: outline
    produces: [beta-outline.md]
`, "beta");

/** A spec root as a table: `{ greeting: { "alpha-spec.md": "..." } }`. */
type Root = Record<string, Record<string, string>>;

function files(root: Root): SpecFiles {

    return {
        specs: async () => Object.keys(root),
        contents: async spec => Object.keys(root[spec] ?? {}),
        read: async (spec, artifact) => root[spec]?.[artifact],
        // Nothing here is ordered by time.
        modified: async () => 0
    };
}

/**
 * @param configuredStyles `sdd.styles` - defaults to just `alpha` enabled,
 * so an untagged folder still places with nothing to guess.
 * @param root the absolute spec root. Defaults to somewhere unlike the
 * repository-relative `specs`, so a test on `folder` fails if it is ever
 * derived from `config.specRoot`.
 */
function input(configuredStyles = ["alpha"], styles = [alpha, beta], root = "/elsewhere/team-specs") {

    return { config: configFromSettings({ sdd: { styles: configuredStyles } }), styles, root };
}

describe("finding specs", () => {

    it("lists every folder under the root, in order, with its path", async () => {

        const found = await discover(
            input(), files({ zebra: { "idea.md": "" }, apple: { "idea.md": "" } }));

        expect(found.map(spec => spec.name)).toEqual(["apple", "zebra"]);
        expect(found[0].path).toBe(".eesha/specs/apple");
    });

    it("finds nothing in an empty root without complaining", async () => {

        expect(await discover(input(), files({}))).toEqual([]);
    });

    /* A spec is a folder holding an opening document. Anything else is somebody else's folder. */
    it("leaves out a folder with no opening document", async () => {

        const found = await discover(
            input(), files({ notes: {}, real: { "idea.md": "" } }));

        expect(found.map(spec => spec.name)).toEqual(["real"]);
    });

    /* A folder written by plain Kiro is not a spec until the opening document is written. */
    it("leaves out a folder of later documents that never had an opening one", async () => {

        const found = await discover(
            input(), files({ adopted: { "alpha-spec.md": "# Thing", "alpha-plan.md": "# Plan" } }));

        expect(found).toEqual([]);
    });

    /* With no style parsed there is no opening filename to look for. */
    it("finds nothing when no style loaded at all", async () => {

        const found = await discover(
            { ...input(["gamma"], []), failures: new Map([["gamma", "Style 'gamma' is not valid YAML."]]) },
            files({ one: { "idea.md": "" } }));

        expect(found).toEqual([]);
    });
});

describe("placing a folder", () => {

    /* An untagged folder is read by the one enabled style, whatever is in it. */
    it("reads every folder by the configured style", async () => {

        const found = await discover(
            input(["beta"]), files({ one: { "idea.md": "", "alpha-spec.md": "" } }));

        expect(found[0].detection.style).toBe("beta");
        expect(found[0].detection.reason).toContain("the configured style");
    });

    /* A folder whose later documents somebody else wrote walks the same pipeline. */
    it("resumes a half-finished folder at the phase that comes next", async () => {

        const found = await discover(input(), files({ one: { "idea.md": "", "alpha-spec.md": "" } }));

        expect(found[0].detection.style).toBe("alpha");
        expect(found[0].state?.next?.id).toBe("plan");
    });

    it("places a finished folder on its implement stage", async () => {

        const found = await discover(
            input(), files({ one: { "idea.md": "", "alpha-spec.md": "", "alpha-plan.md": "" } }));

        expect(found[0].state?.next?.id).toBe("implement");
        expect(found[0].state?.complete).toBe(true);
    });

    it("puts a folder holding only its opening document on the first drafting phase", async () => {

        const found = await discover(input(), files({ one: { "idea.md": "" } }));

        expect(found[0].detection.style).toBe("alpha");
        expect(found[0].state?.next?.id).toBe("spec");
    });

    /* The message says which setting and what is on offer. */
    it("places nothing when the configured style is not installed, and names the setting", async () => {

        const found = await discover(
            input(["nope"]), files({ one: { "idea.md": "", "alpha-spec.md": "" } }));

        expect(found[0].detection.style).toBeUndefined();
        expect(found[0].state).toBeUndefined();
        expect(found[0].detection.reason).toContain("'sdd.styles'");
        expect(found[0].detection.reason).toContain("'alpha'");
    });

    /* An installed style that does not parse is reported with the parser's words, not as absent. */
    it("names the parse failure when the configured style is installed but broken", async () => {

        const found = await discover(
            {
                ...input(["gamma"], [alpha]),
                failures: new Map([["gamma", "Style 'gamma' stage 2 ('design') has an 'instructions: x' that climbs out of the repository."]])
            },
            files({ one: { "idea.md": "" } }));

        expect(found[0].detection.style).toBeUndefined();
        expect(found[0].detection.reason).toContain("was found but could not be read");
        expect(found[0].detection.reason).toContain("climbs out of the repository");
        expect(found[0].detection.reason).not.toContain("no scope holds");
    });

    /* A failure for a style nobody configured says nothing about the one that is. */
    it("still reports an absent style as absent when some other style is the broken one", async () => {

        const found = await discover(
            { ...input(["nope"]), failures: new Map([["beta", "Style 'beta' is not valid YAML."]]) },
            files({ one: { "idea.md": "" } }));

        expect(found[0].detection.reason).toContain("no scope holds");
    });
});

describe("more than one style enabled", () => {

    it("reads a folder by its own 'style:' tag rather than the enabled order", async () => {

        const found = await discover(
            input(["alpha", "beta"]),
            files({ one: { "idea.md": "---\nstyle: beta\n---\n", "beta-outline.md": "" } }));

        expect(found[0].detection.style).toBe("beta");
        expect(found[0].detection.reason).toContain("its opening document's 'style:' tag");
    });

    /* Nothing to guess from when more than one style is enabled and the folder never said. */
    it("does not place an untagged folder when more than one style is enabled", async () => {

        const found = await discover(input(["alpha", "beta"]), files({ one: { "idea.md": "" } }));

        expect(found[0].detection.style).toBeUndefined();
        expect(found[0].state).toBeUndefined();
        expect(found[0].detection.reason).toContain("does not say which style");
        expect(found[0].detection.reason).toContain("'style:'");
    });

    /* The tag is honoured even for a style `sdd.styles` no longer enables - it already ran under it. */
    it("still reads a tag naming a style that is installed but not currently enabled", async () => {

        const found = await discover(
            input(["alpha"]),
            files({ one: { "idea.md": "---\nstyle: beta\n---\n", "beta-outline.md": "" } }));

        expect(found[0].detection.style).toBe("beta");
    });

    /* A tag naming a style nobody has is reported the same way an absent configured style is. */
    it("reports a tag naming a style no scope holds", async () => {

        const found = await discover(
            input(["alpha", "beta"]),
            files({ one: { "idea.md": "---\nstyle: nope\n---\n" } }));

        expect(found[0].detection.style).toBeUndefined();
        expect(found[0].detection.reason).toContain("No style 'nope'");
    });
});

describe("the spec type", () => {

    it("comes from the opening document's frontmatter when it is there", async () => {

        const found = await discover(input(), files({
            one: { "idea.md": "---\ntype: bug\nspec: 1\n---\n\n# Thing\n" }
        }));

        expect(found[0].specType).toBe("bug");
        expect(found[0].state?.stages.map(stage => stage.stage.id)).toEqual(["idea", "spec", "implement"]);
    });

    it("falls back to the style's first type for a folder somebody else wrote", async () => {

        const found = await discover(input(), files({ one: { "idea.md": "", "alpha-spec.md": "# Thing\n" } }));

        expect(found[0].specType).toBe("feature");
        expect(found[0].state?.next?.id).toBe("plan");
    });

    it("ignores a type the style does not offer rather than inventing a pipeline", async () => {

        const found = await discover(input(), files({ one: { "idea.md": "---\ntype: spike\n---\n", "alpha-spec.md": "" } }));

        expect(found[0].specType).toBe("feature");
    });

    it("survives frontmatter that does not parse", async () => {

        const found = await discover(input(), files({ one: { "idea.md": "---\ntype: [oops\n---\n", "alpha-spec.md": "" } }));

        expect(found[0].specType).toBe("feature");
        expect(found[0].detection.style).toBe("alpha");
    });

    /* The same folder is complete as a bug and unfinished as a feature. */
    it("changes what the same folder means", async () => {

        const asBug = await discover(input(), files({
            one: { "idea.md": "---\ntype: bug\n---\n", "alpha-spec.md": "" }
        }));

        const asFeature = await discover(input(), files({ one: { "idea.md": "", "alpha-spec.md": "" } }));

        expect(asBug[0].state?.complete).toBe(true);
        expect(asFeature[0].state?.complete).toBe(false);
    });
});

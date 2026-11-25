import { describe, expect, it } from "vitest";
import {
    anchorId, anchorsByLine, parseRefLabel, parseRefLink, requirementAnchors, requirementPreviews, resolveRef
} from "../specRefs";

const REQUIREMENTS = [
    "# Requirements Document",
    "",
    "## Requirements",
    "",
    "### Requirement 1: Greet a named person",
    "",
    "**User Story:** As a developer, I want a greeting.",
    "",
    "**Acceptance Criteria:**",
    "",
    "1. WHEN run THEN THE script SHALL print a greeting.",
    "2. IF no name THEN THE script SHALL fail.",
    "",
    "### Requirement 2: Log every greeting",
    "",
    "#### Acceptance Criteria",
    "",
    "1. WHEN it completes THEN THE script SHALL append a line.",
    "",
    "## Assumptions",
    "",
    "1. Not a criterion.",
    ""
].join("\n");

describe("requirementAnchors", () => {

    it("anchors requirements and their criteria", () => {

        expect(requirementAnchors(REQUIREMENTS)).toEqual([
            { id: "1", line: 5 },
            { id: "1.1", line: 11 },
            { id: "1.2", line: 12 },
            { id: "2", line: 14 },
            { id: "2.1", line: 18 }
        ]);
    });

    it("stops at the next section, so its lists are not criteria", () => {

        const ids = requirementAnchors(REQUIREMENTS).map(anchor => anchor.id);

        expect(ids).not.toContain("2.2");
    });

    it("ignores numbered lists with no criteria marker above them", () => {

        const doc = "### Requirement 1: Thing\n\n1. Just a list.\n";

        expect(requirementAnchors(doc)).toEqual([{ id: "1", line: 1 }]);
    });

    it("keys criteria by the number as written, not by position", () => {

        const doc = "### Requirement 4: Thing\n**Acceptance Criteria:**\n1. One.\n3. Three.\n";

        expect(requirementAnchors(doc).map(anchor => anchor.id)).toEqual(["4", "4.1", "4.3"]);
    });

    it("returns nothing for missing or unrelated content", () => {

        expect(requirementAnchors(undefined)).toEqual([]);
        expect(requirementAnchors("# Design Document\n\n## Overview\n")).toEqual([]);
    });
});

describe("anchorsByLine", () => {

    it("keys anchors by their source line", () => {

        expect(anchorsByLine(requirementAnchors(REQUIREMENTS)).get(11)).toBe("1.1");
    });
});

describe("anchorId", () => {

    it("agrees on one id for a reference and its landing place", () => {

        expect(anchorId("requirements", "1.1")).toBe("sdd-ref-requirements-1-1");
        expect(anchorId("requirements", "2")).toBe("sdd-ref-requirements-2");
    });
});

describe("requirementPreviews", () => {

    const byId = (content: string) => new Map(requirementPreviews(content).map(one => [one.id, one]));

    it("carries the criterion's own words", () => {

        expect(byId(REQUIREMENTS).get("1.1")?.text)
            .toBe("WHEN run THEN THE script SHALL print a greeting.");
    });

    it("names the requirement a criterion sits under", () => {

        expect(byId(REQUIREMENTS).get("1.2")?.heading).toBe("Requirement 1: Greet a named person");
        expect(byId(REQUIREMENTS).get("2.1")?.heading).toBe("Requirement 2: Log every greeting");
    });

    it("shows a requirement's opening paragraph when it is cited whole", () => {

        expect(byId(REQUIREMENTS).get("1")?.text)
            .toBe("User Story: As a developer, I want a greeting.");
    });

    it("is empty for a requirement whose heading is followed straight by its criteria", () => {

        expect(byId(REQUIREMENTS).get("2")?.text).toBe("");
    });

    it("joins a wrapped criterion into one sentence", () => {

        const doc = [
            "### Requirement 1: Thing",
            "#### Acceptance Criteria",
            "1. WHEN the run finishes THEN THE panel SHALL show",
            "   the result it was given.",
            "2. Next."
        ].join("\n");

        expect(byId(doc).get("1.1")?.text)
            .toBe("WHEN the run finishes THEN THE panel SHALL show the result it was given.");
    });

    it("stops at the next criterion rather than swallowing it", () => {

        expect(byId(REQUIREMENTS).get("1.1")?.text).not.toContain("no name");
    });

    it("strips the markdown a card would otherwise render as written", () => {

        const doc = "### Requirement 1: Thing\n#### Acceptance Criteria\n1. THE `writer` SHALL **flush**.\n";

        expect(byId(doc).get("1.1")?.text).toBe("THE writer SHALL flush.");
    });

    it("keeps a long criterion short enough to stay a card", () => {

        const long = "x".repeat(400);
        const doc = `### Requirement 1: Thing\n#### Acceptance Criteria\n1. ${long}\n`;

        const text = byId(doc).get("1.1")!.text;

        expect(text.length).toBeLessThanOrEqual(301);
        expect(text.endsWith("…")).toBe(true);
    });

    it("anchors exactly where requirementAnchors does", () => {

        expect(requirementPreviews(REQUIREMENTS).map(({ id, line }) => ({ id, line })))
            .toEqual(requirementAnchors(REQUIREMENTS));
    });
});

/**
 * A stage that declared `prefix: Req` in `style.yml` writes
 * `### Req-3: Title` instead of `### Requirement 3: Title`, and its
 * criteria compose as `Req-3.2` - only the requirement half carries the
 * word, the same `.2` as always underneath it.
 */
describe("a requirements document with a declared prefix", () => {

    const PREFIXED = [
        "### Req-1: Greet a named person",
        "",
        "**User Story:** As a developer, I want a greeting.",
        "",
        "#### Acceptance Criteria",
        "",
        "1. WHEN run THEN THE script SHALL print a greeting.",
        "2. IF no name THEN THE script SHALL fail."
    ].join("\n");

    it("reads the prefixed heading and composes prefixed criterion ids", () => {

        expect(requirementAnchors(PREFIXED, "Req")).toEqual([
            { id: "Req-1", line: 1 },
            { id: "Req-1.1", line: 7 },
            { id: "Req-1.2", line: 8 }
        ]);
    });

    /*
     * `Req-1` still looks like a self-declared id to the generic
     * mechanism `### 2.` describes - it just is not read as a
     * *requirement*, so its criteria are not composed under it.
     */
    it("reads the heading as a bare declared id, without linking its criteria, when no prefix is given", () => {

        expect(requirementAnchors(PREFIXED)).toEqual([{ id: "Req-1", line: 1 }]);
    });

    it("reads a plain document when no prefix is given", () => {

        expect(requirementAnchors(REQUIREMENTS, undefined).map(one => one.id))
            .toEqual(["1", "1.1", "1.2", "2", "2.1"]);
    });

    it("accepts a space where the prefix and number meet, not only a hyphen", () => {

        expect(requirementAnchors("### Req 1: Title\n", "Req")).toEqual([{ id: "Req-1", line: 1 }]);
    });
});

describe("parseRefLink", () => {

    const cite = (href: string, text: string) => parseRefLink(href, text);

    it("reads a citation of another phase", () => {

        expect(cite("requirements.md", "Requirements : 1.2, 3.1")).toEqual({
            href: "requirements.md",
            name: "Requirements",
            refs: ["1.2", "3.1"]
        });
    });

    it("reads a citation of a file outside the spec", () => {

        expect(cite("../../docs/product/checkout-prd.md", "checkout-prd : 3.2")).toEqual({
            href: "../../docs/product/checkout-prd.md",
            name: "checkout-prd",
            refs: ["3.2"]
        });
    });

    it("reads a requirement cited whole", () => {

        expect(cite("requirements.md", "Requirements : 2")?.refs).toEqual(["2"]);
    });

    it("keeps the name as written, since it is shown rather than matched", () => {

        expect(cite("requirements.md", "Needs : 1.1")?.name).toBe("Needs");
    });

    it("tolerates the spacing around the colon and the commas", () => {

        expect(cite("requirements.md", "Requirements:1.1 ,2.3")?.refs).toEqual(["1.1", "2.3"]);
    });

    /*
     * The pair is the test. An ordinary link is the common case by far,
     * and dressing one up as a broken citation is worse than never
     * linking it.
     */
    it("is nothing for an ordinary link", () => {

        expect(cite("https://example.com", "the docs")).toBeUndefined();
        expect(cite("./setup.md", "setting it up")).toBeUndefined();
        expect(cite("requirements.md", "Requirements")).toBeUndefined();
    });

    it("is nothing when the target is not markdown", () => {

        expect(cite("docs/prd.pdf", "prd : 3.2")).toBeUndefined();
        expect(cite("../spec", "spec : 1.1")).toBeUndefined();
    });

    /* A `.md` on another host is not a file this repository can resolve. */
    it("is nothing for a markdown file somewhere else on the web", () => {

        expect(cite("https://example.com/docs/prd.md", "prd : 3.2")).toBeUndefined();
        expect(cite("//example.com/prd.md", "prd : 3.2")).toBeUndefined();
    });

    /*
     * The grammar asks for nothing after `.md`, but a model will add an
     * anchor anyway - and that is still a citation. Refusing it would leave a
     * control rendering as a plain link that merely opens the file,
     * which is a failure nobody would report as a parsing bug.
     */
    it("drops an anchor or a query rather than refusing the citation", () => {

        expect(cite("requirements.md#requirement-1", "Requirements : 1.1")?.href).toBe("requirements.md");
        expect(cite("requirements.md?plain=1", "Requirements : 1.1")?.href).toBe("requirements.md");
        expect(cite("../docs/prd.md#top", "prd : 2.1")?.href).toBe("../docs/prd.md");
    });
});

describe("resolveRef", () => {

    const from = "C:/repo/.eesha/specs/demo/tasks.md";

    it("resolves a sibling document in the spec folder", () => {

        expect(resolveRef(from, "requirements.md"))
            .toBe("C:/repo/.eesha/specs/demo/requirements.md");
    });

    it("climbs out of the spec folder", () => {

        expect(resolveRef(from, "../../../docs/product/checkout-prd.md"))
            .toBe("C:/repo/docs/product/checkout-prd.md");
    });

    it("ignores a leading ./", () => {

        expect(resolveRef(from, "./design.md"))
            .toBe("C:/repo/.eesha/specs/demo/design.md");
    });

    /*
     * An artifact path arrives in the platform's own spelling and a link
     * is always written with forward slashes. Comparing the two without
     * normalising finds nothing at all on Windows.
     */
    it("reads a backslashed document path", () => {

        expect(resolveRef("C:\\repo\\specs\\demo\\tasks.md", "requirements.md"))
            .toBe("C:/repo/specs/demo/requirements.md");
    });
});

/**
 * A document numbers its own items, and a citation of one has to land
 * on it. `1.2` is only for requirements documents; a gap analysis
 * writes `G11`, a functional spec writes `FR-1`.
 */
describe("ids a document declares for itself", () => {

    const ids = (content: string) => requirementPreviews(content).map(one => one.id);
    const byId = (content: string) => new Map(requirementPreviews(content).map(one => [one.id, one]));

    const GAPS = [
        "# Gap analysis",
        "",
        "## Gaps",
        "",
        "### G10: Citations are unchecked outside the panel",
        "",
        "A reviewer on GitHub sees links, not drift.",
        "",
        "### G11: A renumbered requirement is silent",
        "",
        "Nothing reports the plan citing criteria that moved."
    ].join("\n");

    it("anchors an id declared in its own heading", () => {

        expect(ids(GAPS)).toEqual(["G10", "G11"]);
    });

    it("carries the heading and the paragraph under it", () => {

        const gap = byId(GAPS).get("G11")!;

        expect(gap.heading).toBe("G11: A renumbered requirement is silent");
        expect(gap.text).toBe("Nothing reports the plan citing criteria that moved.");
    });

    /* A functional spec can write every requirement as a bold-led bullet. */
    it("anchors a bold-led list item", () => {

        const spec = [
            "# Spec",
            "",
            "## Requirements",
            "",
            "- **FR-1**: The system MUST read the environment.",
            "- **FR-2**: The system MUST fail loudly when it cannot."
        ].join("\n");

        expect(ids(spec)).toEqual(["FR-1", "FR-2"]);
        expect(byId(spec).get("FR-2")?.text).toBe("FR-2: The system MUST fail loudly when it cannot.");
    });

    /*
     * The requirements shape keeps its own reading - a requirement
     * expects criteria beneath it, which a bare declared id does not.
     */
    it("reads a requirements document by its numbered headings and criteria", () => {

        expect(ids(REQUIREMENTS)).toEqual(["1", "1.1", "1.2", "2", "2.1"]);
    });

    it("declares nothing for an ordinary heading", () => {

        expect(ids("# Design\n\n## Overview\n\n### Design Decisions\n")).toEqual([]);
    });

    /* A version number in a heading is not an id. */
    it("does not read a heading that merely mentions a number", () => {

        expect(ids("## Requires Node 18\n\nSomething.\n")).toEqual([]);
    });
});

describe("parseRefLabel", () => {

    it("reads a plain label, the shape a spec without prefixes uses", () => {

        expect(parseRefLabel("Requirements: 1.1, 2.3")).toEqual({
            target: "requirements",
            head: "Requirements: ",
            refs: ["1.1", "2.3"]
        });
    });

    it("reads a Validates line naming plain ids", () => {

        expect(parseRefLabel("Validates: Requirements 1.1, 2.1")?.refs).toEqual(["1.1", "2.1"]);
    });

    it("reads a Validates line naming prefixed ids", () => {

        const label = parseRefLabel("Validates: Requirements Req-3.2, Req-3.1");

        expect(label?.target).toBe("requirements");
        expect(label?.refs).toEqual(["Req-3.2", "Req-3.1"]);
    });

    it("reads a bare label naming one prefixed id", () => {

        expect(parseRefLabel("Requirements: Req-3.2")?.refs).toEqual(["Req-3.2"]);
    });
});

describe("citing an id a document owns", () => {

    it("reads a non-numeric id", () => {

        expect(parseRefLink("gap-analysis.md", "Gap Analysis : G11")).toEqual({
            href: "gap-analysis.md",
            name: "Gap Analysis",
            refs: ["G11"]
        });
    });

    it("reads several of them", () => {

        expect(parseRefLink("spec.md", "spec : FR-1, FR-2")?.refs).toEqual(["FR-1", "FR-2"]);
    });

    /* How a design names its properties - `### Property 12: ...`. */
    it("reads an id that is a word and a number", () => {

        expect(parseRefLink("design.md", "Design : Dec-5, Property 12")).toEqual({
            href: "design.md",
            name: "Design",
            refs: ["Dec-5", "Property 12"]
        });

        expect(parseRefLink("design.md", "Design : Property  12")?.refs).toEqual(["Property 12"]);
    });

    it("gives a spaced id a DOM id with no space in it", () => {

        expect(anchorId("design", "Property 12")).toBe("sdd-ref-design-Property-12");
    });

    /* A digit is the guard. Prose after a colon is still prose. */
    it("is nothing when the text is a phrase rather than ids", () => {

        expect(parseRefLink("gap-analysis.md", "Gap Analysis : see below")).toBeUndefined();
        expect(parseRefLink("gap-analysis.md", "Gap Analysis : the eleventh gap")).toBeUndefined();
    });
});

/**
 * A gap analysis written as `## G11 -- feature flag`. H2 rather than
 * H3, a double dash rather than a colon, and the id followed by a
 * space.
 *
 * Kept as its own case because without it the citation would parse
 * nowhere and the panel would fall through to opening the file, which
 * is a failure that looks like a working link.
 */
describe("a gap analysis with H2 headings", () => {

    const GAPS = [
        "# Gap analysis",
        "",
        "## G11 -- feature flag",
        "",
        "The flag is read in two places and defaulted in neither.",
        "",
        "## G12 -- retry budget",
        "",
        "Nothing bounds the retries."
    ].join("\n");

    it("anchors an H2 id separated by a double dash", () => {

        expect(requirementPreviews(GAPS).map(one => one.id)).toEqual(["G11", "G12"]);
    });

    it("carries the heading and the paragraph a card shows", () => {

        const gap = requirementPreviews(GAPS).find(one => one.id === "G11")!;

        expect(gap.heading).toBe("G11 -- feature flag");
        expect(gap.text).toBe("The flag is read in two places and defaulted in neither.");
    });

    it("stops at the next gap", () => {

        expect(requirementPreviews(GAPS).find(one => one.id === "G11")?.text)
            .not.toContain("retries");
    });

    it("is cited as written", () => {

        expect(parseRefLink("gap-analysis.md", "Gap Analysis : G11")?.refs).toEqual(["G11"]);
    });
});

/**
 * Every shape a document may declare an id in, and the ones it must not
 * read as declarations.
 *
 * A matrix rather than a case per shape, because the argument for the
 * wide rule is the whole list. What keeps that width safe is a single
 * guard - an id declared outside a heading must begin with a letter -
 * and the second half of this table is that guard's test.
 */
describe("where a document may declare an id", () => {

    const declares = (line: string) =>
        requirementPreviews(`${line}\n\nBody text.\n`).map(one => one.id);

    it.each([
        ["## G11 -- feature flag", "G11"],
        ["### G11: feature flag", "G11"],
        ["#### G11", "G11"],
        ["# G11 -- feature flag", "G11"],
        ["## FR-1 The system must", "FR-1"],
        ["## 3.2 Something", "3.2"],
        ["**G11** -- feature flag", "G11"],
        ["- **G11**: feature flag", "G11"],
        ["- G11 -- feature flag", "G11"],
        ["1. G11 -- feature flag", "G11"],
        ["| G11 | feature flag |", "G11"],
        ["### Property 1: Always reported", "Property 1"],
        ["### Dec-5: Keep one parser", "Dec-5"]
    ])("declares an id in %j", (line, id) => {

        expect(declares(line)).toEqual([id]);
    });

    it.each([
        // Ordinary markdown that merely opens with a number.
        ["1. Just a list."],
        ["2) Another one."],
        ["- an ordinary bullet"],

        // A heading that mentions a number without naming anything.
        ["## Requires Node 18"],
        ["## Overview"],

        // The id has to lead. Nothing can tell these from prose.
        ["## Gap G11 -- feature flag"],
        ["## Feature flag (G11)"],
        ["## G 11 -- feature flag"],

        // A word and a number declare an id only with a colon after.
        ["### Phase 2 Overview"]
    ])("declares nothing in %j", line => {

        expect(declares(line)).toEqual([]);
    });

    /* A table row is shown as a row, not as a line of pipes. */
    it("reads a table row as its cells", () => {

        const row = requirementPreviews("| G11 | the flag is read in two places |")[0];

        expect(row.text).toBe("G11 · the flag is read in two places");
    });

    /*
     * The guard that lets the rule be this wide: inside an acceptance
     * criteria list, a numbered line is a criterion and nothing else.
     */
    it("previews every requirement and criterion of a requirements document", () => {

        expect(requirementPreviews(REQUIREMENTS).map(one => one.id))
            .toEqual(["1", "1.1", "1.2", "2", "2.1"]);
    });
});

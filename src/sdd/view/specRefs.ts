/**
 * Citations - `[Requirements : 1.2, 3.1](requirements.md)` - read as
 * navigation.
 *
 * A citation is an ordinary markdown link, so it still works on GitHub
 * and in any editor. The panel adds the jump, the card and the stale
 * check on top. The href decides which document is meant.
 *
 * A link that does not match the shape is left as a link, never an
 * error. A reference that does match but points nowhere is reported,
 * not swallowed: a revise that renumbers the requirements leaves the
 * plan citing criteria that no longer exist, and hiding that is how a
 * spec drifts out of sync.
 */

/** A citation - `[Requirements : 1.2, 3.1](requirements.md)` - decomposed. */
export interface SpecRefLink {

    /**
     * The link's href exactly as written: a path to a `.md` file,
     * relative to the document the link is in. Kept unresolved because
     * only the caller knows which document is being read.
     */
    href: string;

    /** The name before the colon, as the author wrote it. Shown, not interpreted. */
    name: string;

    /** The ids, as the target document spells them - "1.2", "G11", "FR-1". */
    refs: string[];
}

/**
 * A citation, or nothing. Both halves have to fit: the href names a
 * markdown file, and the text is a name, a colon and ids. An ordinary
 * link is left alone.
 */
export function parseRefLink(href: string, text: string): SpecRefLink | undefined {

    // A fragment or a query is dropped rather than refused. A model that
    // adds `#requirement-1` has still written a citation, and refusing
    // it would turn the control into a plain link.
    const link = href.trim().replace(/[#?].*$/, "");

    // A `.md` on another host is not a file in this repository.
    if (!/\.md$/i.test(link) || /^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("//"))
        return undefined;

    const match = REF_TEXT.exec(text.trim());

    if (!match)
        return undefined;

    const [, name, list] = match;

    return {
        href: link,
        name: name.trim(),

        // `Property  12` and `Property 12` are the same id. The heading
        // side collapses spaces the same way, so the two compare equal.
        refs: list.split(",").map(ref => ref.trim().replace(/\s+/g, " ")).filter(Boolean)
    };
}

/**
 * An id, as whatever document owns it spells it: `1.2`, `G11`, `FR-1`,
 * `T004`, `Property 12`. It must carry a digit, so `[the docs : see
 * below](x.md)` stays a link. The digit may sit after the letters
 * (`FR-1`) or between them (`G11`).
 *
 * One space is allowed, and only between a word and a number, because
 * that is how a design names its properties - `### Property 1: ...`.
 */
const REF_ID = String.raw`(?:[A-Za-z]+\s+\d[\w.-]*|[\w.-]*\d[\w.-]*)`;

/**
 * `Requirements : 1.2, 3.1` - a name, a colon, then the ids.
 *
 * The name is lazy up to the *last* colon before the ids, so a name
 * carrying one of its own reads as part of the name rather than ending
 * it early.
 */
const REF_TEXT = new RegExp(String.raw`^(.+?)\s*:\s*(${REF_ID}(?:\s*,\s*${REF_ID})*)$`);

/**
 * Where a citation points, as a path in the same shape the panel keys
 * its documents by. Relative to the document holding the link, the same
 * way GitHub resolves it.
 *
 * Slashes are normalised both ways: an artifact path arrives in the
 * platform's own spelling, a link is always written with forward
 * slashes, and on Windows the two would never compare equal otherwise.
 */
export function resolveRef(fromDocument: string, href: string): string {

    const parts = fromDocument.replace(/\\/g, "/").split("/");

    // The document's own folder - the link is relative to that, not to
    // the document.
    parts.pop();

    for (const segment of href.replace(/\\/g, "/").split("/")) {

        if (segment === "" || segment === ".")
            continue;

        if (segment === "..")
            parts.pop();
        else
            parts.push(segment);
    }

    return parts.join("/");
}

/** A `Requirements: 1.1, 2.3` phrase, decomposed. */
export interface SpecRefLabel {

    /**
     * The phase the references point at, lowercased - "requirements".
     * Matched against stage names: phase name = file name = the noun
     * these labels use.
     */
    target: string;

    /** Everything before the numbers, kept verbatim. */
    head: string;

    /** The references as written - "1.1", "2.3". */
    refs: string[];
}

/**
 * `Requirements: 1.1, 2.3` and `Validates: Requirements 1.1, 2.1` - the
 * two spellings the templates use, and anything shaped like them.
 *
 * The noun is captured rather than hardcoded, so `Design: 2.1` resolves
 * against the design phase with no change here. Whether the noun names
 * a real phase is decided by the caller against the spec's stages.
 *
 * An id is a plain `1.1` or a prefixed `Req-3.2` - a stage with a
 * declared prefix cites its own items that way, so a Validates line
 * naming them has to read both.
 */
const REF_ID_PLAIN = String.raw`(?:[A-Za-z]+-)?\d+(?:\.\d+)?`;

const REF_LABEL = new RegExp(String.raw`^(?:validates:\s*)?([A-Za-z]+)\s*:?\s*(${REF_ID_PLAIN}(?:\s*[,/]\s*${REF_ID_PLAIN})*)$`, "i");

export function parseRefLabel(text: string): SpecRefLabel | undefined {

    const trimmed = text.trim();

    const match = REF_LABEL.exec(trimmed);

    if (!match)
        return undefined;

    const [, noun, list] = match;

    return {
        target: noun.toLowerCase(),
        head: trimmed.slice(0, trimmed.length - list.length),
        refs: list.split(/[,/]/).map(ref => ref.trim())
    };
}

/**
 * Whether a stage is the phase a reference names. Singular and plural
 * both count: a task writes `_Requirements: 1.1_` and a design writes
 * `**Requirement 1.1**`, and both mean the same phase.
 */
export function matchesTarget(stage: string, target: string): boolean {

    return stage === target || stage === `${target}s` || `${stage}s` === target;
}

/** A place a reference can land: a requirement, or one of its acceptance criteria. */
export interface RequirementAnchor {

    /** "1" for the requirement itself, "1.2" for its second acceptance criterion. */
    id: string;

    /**
     * 1-based line in the text it was parsed from. react-markdown
     * carries the same coordinate on every node, so an anchor can be
     * attached to an element without the renderer reading the document.
     */
    line: number;
}

/**
 * `### Requirement 3: Title` - the numbering references are written
 * against. The word is `Requirement` unless the stage declared its own
 * `prefix:`, in which case it is that instead - `### Req-3: Title`.
 * Either separator reads, so a plain `Requirement 3` and a prefixed
 * `Req-3` are the same shape to this regex.
 *
 * The prefix is not escaped: `parseStyle` already refuses one that is
 * not `^[A-Z][A-Za-z0-9]*$`, so there is nothing in it a regex would
 * read specially. It also refuses a one-character prefix, but nothing
 * here depends on that.
 */
function requirementPattern(prefix?: string): RegExp {

    return new RegExp(String.raw`^#{2,4}\s+${prefix ?? "requirement"}[\s-]+(\d+)\b`, "i");
}

/**
 * The criteria marker, in both spellings that occur: the H4 the format
 * rules ask for, and the bold line the drafts actually tend to write.
 */
const CRITERIA = /^(?:#{2,6}\s+|\*\*)acceptance\s+criteria:?(?:\*\*)?:?\s*$/i;

/** `1. WHEN ... THEN ...` - a criterion, numbered as the references cite it. */
const CRITERION = /^(\d+)[.)]\s+\S/;

const HEADING = /^#{1,3}\s/;

/**
 * An id a document declares in a heading of its own - `### G11: The
 * plan cites criteria that moved`, `#### FR-1`. The general case of
 * {@link REQUIREMENT}, for gap lists, other spec formats, ADRs.
 *
 * The id is the heading's first token and must carry a digit, so
 * `### Overview` declares nothing and `### Requirement 3` is left to
 * {@link REQUIREMENT}, which knows to expect criteria beneath it.
 */
const ID_HEADING = /^#{1,6}\s+([\w.-]*\d[\w.-]*?)[.:)\-–—]?(?:\s|$)/;

/**
 * `### Property 1: ...` - an id that is a word and a number. The colon
 * is required, so `### Phase 2 Overview` stays an ordinary heading.
 */
const ID_HEADING_SPACED = /^#{1,6}\s+([A-Za-z]+\s+\d[\w.-]*?):(?:\s|$)/;

/**
 * The same id, declared anywhere a line opens with it, such as
 * `- **FR-1**: The system MUST ...`. Strips whatever opens the line - a
 * list marker, a table pipe, bold - and reads the id from what is left.
 *
 * The id must begin with a letter. `1. Just a list.` is ordinary
 * markdown, and reading it as a declaration would anchor every numbered
 * list in every document.
 */
const ID_LEADS = /^(?:[-*+]\s+|\d+[.)]\s+|\|\s*)?(?:\*\*|__)?([A-Za-z][\w.-]*\d[\w.-]*?)(?:\*\*|__)?[.:)\-–—|]?(?:\s|$)/;

/**
 * An anchor with the words at it - what a hover card shows. The text is
 * collected in the same read that checks references, because the cited
 * document is usually not the one on screen.
 */
export interface RequirementPreview extends RequirementAnchor {

    /** `Requirement 3: Retry on timeout` - the heading this sits under, markdown stripped. */
    heading: string;

    /**
     * The criterion itself, or a requirement's opening paragraph, joined
     * into one sentence so the card does not show the file's line wraps.
     */
    text: string;
}

/** Any heading, unlike {@link HEADING} - what ends a block of prose rather than a requirement. */
const ANY_HEADING = /^#{1,6}\s/;

/** The bullet or number that opens a line. A card does not repeat it. */
const MARKER = /^(?:\d+[.)]|[-*+])\s+/;

/** Long enough for a criterion, short enough that a card never becomes the document. */
const PREVIEW_LENGTH = 300;

/**
 * Every anchor a requirements document offers, in document order.
 *
 * Criteria are keyed by the number as written, not by list position,
 * because the written number is what a task cites. A repeated number
 * resolves to the last one.
 *
 * Anchors are only collected under an explicit acceptance-criteria
 * marker. Taking any numbered list under a requirement heading would
 * anchor a list inside a user story and send readers to the wrong line.
 */
export function requirementAnchors(content: string | undefined, prefix?: string): RequirementAnchor[] {

    return requirementPreviews(content, prefix).map(({ id, line }) => ({ id, line }));
}

/**
 * The same walk, keeping the words as well as the positions. One pass,
 * so the anchor and its text can never disagree about where a
 * requirement starts.
 *
 * @param prefix The word this document's own numbered items are cited
 * by, when the stage declared one - `Req` for `Req-3`. Absent reads a
 * plain `Requirement 3` heading, the default.
 */
export function requirementPreviews(content: string | undefined, prefix?: string): RequirementPreview[] {

    if (!content)
        return [];

    const lines = content.split(/\r?\n/);

    const previews: RequirementPreview[] = [];

    const requirementLine = requirementPattern(prefix);

    let requirement: string | undefined = undefined;
    let heading = "";
    let inCriteria = false;

    lines.forEach((raw, index) => {

        const line = raw.trim();

        const found = requirementLine.exec(line);

        if (found) {

            // The id itself carries the prefix - `Req-3`, not `3` - so
            // a criterion beneath it composes as `Req-3.2` from nothing
            // more than the existing `${requirement}.${criterion}` join
            // below.
            requirement = prefix ? `${prefix}-${found[1]}` : found[1];
            heading = plain(line.replace(/^#{1,6}\s+/, ""));
            inCriteria = false;

            previews.push({
                id: requirement,
                line: index + 1,
                heading,

                // The paragraph under the heading - the user story,
                // where there is one.
                text: blockAt(lines, next(lines, index + 1))
            });

            return;
        }

        // Checked before the general heading reset, because the H4
        // spelling of the marker is itself a heading.
        if (CRITERIA.test(line)) {

            inCriteria = true;

            return;
        }

        // An id the document declares in a heading of its own. Checked
        // before the reset below, because such a heading both ends
        // whatever requirement was open and declares something itself.
        const declared = ID_HEADING.exec(line) ?? ID_HEADING_SPACED.exec(line);

        if (declared) {

            requirement = undefined;
            inCriteria = false;
            heading = plain(line.replace(/^#{1,6}\s+/, ""));

            previews.push({
                id: declared[1].replace(/\s+/g, " "),
                line: index + 1,
                heading,
                text: blockAt(lines, next(lines, index + 1))
            });

            return;
        }

        // Anything at ### or shallower ends the requirement - the next
        // section (`## Assumptions`, `## Open Questions`) is not part of
        // it, and its lists must not be anchored as criteria.
        if (HEADING.test(line)) {

            requirement = undefined;
            inCriteria = false;
            heading = plain(line.replace(/^#{1,6}\s+/, ""));

            return;
        }

        // A line that opens with an id declares it and ends nothing.
        // Skipped while criteria are open, or a criterion reading
        // `G11 SHALL ...` would be read twice.
        const leads = inCriteria ? null : ID_LEADS.exec(line);

        if (leads) {

            previews.push({
                id: leads[1],
                line: index + 1,
                heading,
                text: rowOrBlock(lines, index)
            });

            return;
        }

        const criterion = CRITERION.exec(line);

        if (criterion && inCriteria && requirement)
            previews.push({
                id: `${requirement}.${criterion[1]}`,
                line: index + 1,
                heading,
                text: blockAt(lines, index)
            });
    });

    return previews;
}

/**
 * A declaration's words. A table row has its cells joined with " · ";
 * anything else is an ordinary block of prose.
 */
function rowOrBlock(lines: string[], from: number): string {

    const line = lines[from].trim();

    if (!line.startsWith("|"))
        return blockAt(lines, from);

    const cells = line.split("|").map(cell => plain(cell)).filter(Boolean);

    return cells.join(" · ");
}

/** The next line with anything on it, or the end - where a heading's paragraph starts. */
function next(lines: string[], from: number): number {

    let at = from;

    while (at < lines.length && lines[at].trim() === "")
        at += 1;

    return at;
}

/**
 * One block of prose starting at a line, as a sentence.
 *
 * Stops at a blank line, a heading, or the next list item, so a
 * criterion never swallows the one after it. Empty when `from` is past
 * the end or lands on something that starts a different block.
 */
function blockAt(lines: string[], from: number): string {

    const first = lines[from]?.trim();

    if (!first || ANY_HEADING.test(first) || CRITERIA.test(first))
        return "";

    const block = [plain(first.replace(MARKER, ""))];

    for (let at = from + 1; at < lines.length; at += 1) {

        const line = lines[at].trim();

        if (!line || ANY_HEADING.test(line) || MARKER.test(line))
            break;

        block.push(plain(line));
    }

    const text = block.join(" ").replace(/\s+/g, " ").trim();

    return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH).trimEnd()}…` : text;
}

/** Markdown emphasis and backticks taken off, because a card renders plain text. */
function plain(text: string): string {

    return text.replace(/[*_`]/g, "").trim();
}

/** Anchors by the source line they sit on - how a rendered element finds its own id. */
export function anchorsByLine(anchors: RequirementAnchor[]): Map<number, string> {

    return new Map(anchors.map(anchor => [anchor.line, anchor.id]));
}

/** The DOM id a reference and its landing place agree on. */
export function anchorId(target: string, ref: string): string {

    // A space is not allowed in a DOM id, and `Property 1` carries one.
    return `sdd-ref-${target}-${ref.replace(/[.\s]/g, "-")}`;
}

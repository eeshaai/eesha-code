/**
 * Review notes - the margin comments a reader leaves on a spec
 * document, and how they are found again after a revise moves every
 * line.
 *
 * Like a code review host: store the line and the text that was on it,
 * then re-find the text on load. A note whose text has moved re-anchors
 * silently. A note whose text is gone is neither deleted nor guessed
 * at - it is reported as orphaned and shown apart from the document.
 */

/** A comment on one block of a document. Serialised to `review.json` beside the spec. */
export interface ReviewNote {

    /** Stable across re-anchoring - what a reply or a resolve names. */
    id: string;

    /**
     * The document this is about.
     *
     * On disk it is relative to the workspace root, so the file survives
     * being opened on another machine; in the view it is the absolute
     * path, because that is what the panel opens. The store converts
     * between the two.
     */
    artifact: string;

    /** The file line the note was written against. A hint after the document changes, not a fact. */
    line: number;

    /**
     * The line's text when the note was written, normalised. The actual
     * anchor. Kept short so a paragraph with one corrected word is still
     * recognised.
     */
    anchorText: string;

    /** What the reader wrote. */
    body: string;

    /** ISO 8601. */
    createdAt: string;

    /** Dealt with. Kept rather than deleted, so a document's review history survives. */
    resolved?: boolean;
}

/** A note placed against the document as it stands now. */
export interface AnchoredNote extends ReviewNote {

    /** The line it is on today, or undefined when its text is no longer in the document. */
    at: number | undefined;

    /** Its text was found somewhere other than where it was written. */
    moved: boolean;
}

/** How much of a line is kept as the anchor. Long enough to be unique, short enough to survive an edit. */
const ANCHOR_LENGTH = 80;

/**
 * A line reduced to what should still match after someone fixes a typo
 * in it - whitespace collapsed, and the leading markup that a reformat
 * moves around (`#`, `-`, `>`, `1.`) taken off.
 */
export function normaliseAnchor(line: string): string {

    return line
        // The marker has to be followed by a space to be a marker.
        // Otherwise the first asterisk of a `**User Story:**` line is
        // eaten as a bullet and the note anchors to text the document
        // does not contain.
        .replace(/^\s*(?:[-*+][ \t]+|\d+[.)][ \t]+|#{1,6}[ \t]+|>[ \t]*)/, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, ANCHOR_LENGTH);
}

/** The anchor text for a file line - what a new note records. */
export function anchorFor(content: string, line: number): string {

    return normaliseAnchor(content.split("\n")[line - 1] ?? "");
}

/**
 * Every note placed against the document as it stands.
 *
 * Three outcomes per note, in order of preference: still where it was
 * written; found elsewhere, nearest first, because a revise that adds a
 * paragraph moves everything below it by the same small amount; or
 * nowhere, which is orphaned rather than lost.
 *
 * An empty anchor never matches: a note on a blank line would otherwise
 * land on the first blank line in the document.
 */
export function anchorNotes(notes: readonly ReviewNote[], content: string): AnchoredNote[] {

    const lines = content.split("\n").map(normaliseAnchor);

    return notes.map(note => {

        if (!note.anchorText)
            return { ...note, at: undefined, moved: false };

        if (lines[note.line - 1] === note.anchorText)
            return { ...note, at: note.line, moved: false };

        let best: number | undefined;

        for (let index = 0; index < lines.length; index++) {

            if (lines[index] !== note.anchorText)
                continue;

            const line = index + 1;

            if (best === undefined || Math.abs(line - note.line) < Math.abs(best - note.line))
                best = line;
        }

        return { ...note, at: best, moved: best !== undefined };
    });
}

/** Open notes by the line they sit on - what the gutter draws a badge from. */
export function notesByLine(notes: readonly AnchoredNote[]): Map<number, AnchoredNote[]> {

    const byLine = new Map<number, AnchoredNote[]>();

    for (const note of notes) {

        if (note.at === undefined)
            continue;

        const existing = byLine.get(note.at);

        if (existing)
            existing.push(note);
        else
            byLine.set(note.at, [note]);
    }

    return byLine;
}

/**
 * The open notes as one revision instruction.
 *
 * Each note is quoted against the line it is about, because "this is
 * too vague" means nothing without the sentence it was said about.
 * Ordered by position. Resolved notes are left out - handing them back
 * would ask for the work twice.
 */
export function reviseInstruction(notes: readonly AnchoredNote[], content: string): string {

    const lines = content.split("\n");

    const open = notes
        .filter(note => !note.resolved)
        .sort((left, right) => (left.at ?? Number.MAX_SAFE_INTEGER) - (right.at ?? Number.MAX_SAFE_INTEGER));

    if (open.length === 0)
        return "";

    const parts = open.map(note => {

        const quoted = note.at === undefined
            ? "(the text this was written against is no longer in the document)"
            : `> ${(lines[note.at - 1] ?? "").trim()}`;

        const where = note.at === undefined ? "somewhere now gone" : `line ${note.at}`;

        return [`**${where}**`, quoted, "", note.body.trim()].join("\n");
    });

    return [
        `${open.length} review ${open.length === 1 ? "note was" : "notes were"} left on this document. `
        + "Address every one of them.",
        "",
        parts.join("\n\n---\n\n")
    ].join("\n");
}

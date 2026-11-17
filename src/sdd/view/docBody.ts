/**
 * A spec document split into the parts the viewer shows differently -
 * frontmatter as metadata chips, the rest as markdown.
 *
 * Kept apart from `SddRunView` so `offset` can be tested: a wrong line
 * gutter cannot be spotted by looking at the screen.
 */

/** A document's frontmatter, its body, and how far the body sits into the file. */
export interface DocBody {

    /** Frontmatter keys and values, in the order written. Empty when the document has none. */
    meta: [string, string][];

    /** Everything after the frontmatter - what actually gets rendered as markdown. */
    body: string;

    /**
     * Lines the frontmatter occupied, so `bodyLine + offset` is the
     * line the file itself would show.
     *
     * Non-zero on `idea.md` (written with frontmatter by
     * `renderIdea`) and on requirements, whose prompt carries that
     * frontmatter over. The design and tasks prompts say "No
     * frontmatter". Ignoring the offset would leave the gutter right on
     * two documents of a spec and six lines out on the other two.
     */
    offset: number;
}

/** Splits YAML frontmatter off a document - rendered as metadata chips, never as raw text. */
export function splitFrontmatter(content: string): DocBody {

    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(content);

    if (!match)
        return { meta: [], body: content, offset: 0 };

    const meta = match[1]
        .split(/\r?\n/)
        .map(line => /^([A-Za-z_][\w]*):\s*(.*)$/.exec(line))
        .filter((entry): entry is RegExpExecArray => entry !== null)
        .map(entry => [entry[1], entry[2]] as [string, string])
        .filter(([, value]) => value.trim().length > 0);

    // Counted off the matched text, not the parsed keys: a blank line or
    // a key this parser skips still occupied a line in the file.
    const offset = (match[0].match(/\n/g) ?? []).length;

    return { meta, body: content.slice(match[0].length), offset };
}

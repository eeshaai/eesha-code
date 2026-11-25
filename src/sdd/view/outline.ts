/**
 * A document's headings, for the reader who has scrolled far enough to
 * forget which requirement they are inside.
 *
 * Read off the text rather than off the rendered DOM, so the outline
 * exists before the document is on screen and carries real file line
 * numbers rather than element positions.
 *
 * Fenced code is skipped. A shell block full of `# comments` would
 * otherwise fill the outline with headings the document does not have,
 * and a design document is mostly fenced code.
 */

export interface OutlineItem {

    /** File line, so clicking one lands on the same block the gutter numbers. */
    line: number;

    /** 1 for `#`, 2 for `##`, and so on. */
    depth: number;

    /** The heading text, markdown markers stripped. */
    text: string;

    /** Not a heading: a row the document lists, folded in by {@link withRows}. */
    row?: true;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/**
 * @param offset Lines of frontmatter that were split off, so the
 * numbers reported are the file's own.
 */
export function outlineOf(body: string, offset = 0): OutlineItem[] {

    const items: OutlineItem[] = [];

    let fence: string | undefined;

    body.split("\n").forEach((line, index) => {

        const fenceMark = /^\s*(`{3,}|~{3,})/.exec(line);

        if (fenceMark) {

            // A fence closes only on its own kind, so a ``` inside a
            // ~~~ block does not end it.
            if (fence === undefined)
                fence = fenceMark[1][0];
            else if (fenceMark[1][0] === fence)
                fence = undefined;

            return;
        }

        if (fence !== undefined)
            return;

        const heading = HEADING.exec(line);

        if (heading)
            items.push({
                line: index + 1 + offset,
                depth: heading[1].length,
                text: heading[2].replace(/[*_`]/g, "").trim()
            });
    });

    return items;
}

/**
 * The outline with a document's own rows folded in - a plan's tasks
 * under the heading they sit beneath, each one level deeper than it
 * for every level of nesting it has. A plan is one `## Tasks` heading
 * over forty rows; an outline that shows only the heading is a map with
 * one place on it.
 *
 * @param rows The rows to add, by file line, in any order. `level` is
 * the row's own nesting, 1 for a top-level row; absent reads as 1.
 */
export function withRows(items: readonly OutlineItem[], rows: readonly { line: number; text: string; level?: number }[]): OutlineItem[] {

    const added = rows.map(row => ({
        line: row.line,
        depth: (sectionAt(items, row.line)?.depth ?? 1) + (row.level ?? 1),
        text: row.text,
        row: true as const
    }));

    return [...items, ...added].sort((left, right) => left.line - right.line);
}

/** Whether the item at an index has anything under it: the next item is deeper. */
export function hasChildren(items: readonly OutlineItem[], index: number): boolean {

    return index + 1 < items.length && items[index + 1].depth > items[index].depth;
}

/**
 * The items still showing when some are collapsed. A collapsed item
 * stays; everything under it - every following item deeper than it -
 * is left out.
 *
 * @param closed The file lines of the collapsed items.
 */
export function visibleOf(items: readonly OutlineItem[], closed: ReadonlySet<number>): OutlineItem[] {

    const shown: OutlineItem[] = [];

    let hideDeeperThan: number | undefined;

    for (const item of items) {

        if (hideDeeperThan !== undefined && item.depth > hideDeeperThan)
            continue;

        hideDeeperThan = closed.has(item.line) ? item.depth : undefined;

        shown.push(item);
    }

    return shown;
}

/** The last heading at or above a line - what the reader is currently inside. */
export function sectionAt(items: readonly OutlineItem[], line: number): OutlineItem | undefined {

    let found: OutlineItem | undefined;

    for (const item of items) {

        if (item.line > line)
            break;

        found = item;
    }

    return found;
}

/**
 * The heading a line sits under, with every heading above it that it
 * belongs to - outermost first. What the bar over a scrolled document
 * shows: `Requirements › Requirement 3 › Criteria`.
 *
 * A parent is the nearest earlier item that is less deep. A skipped
 * level (`#` then `###`) is not filled in; the chain has what the
 * document has.
 */
export function chainAt(items: readonly OutlineItem[], line: number): OutlineItem[] {

    const here = sectionAt(items, line);

    if (!here)
        return [];

    const chain = [here];

    for (let index = items.indexOf(here) - 1; index >= 0 && chain[0].depth > 1; index--)
        if (items[index].depth < chain[0].depth)
            chain.unshift(items[index]);

    return chain;
}

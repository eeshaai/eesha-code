/**
 * Which tasks cite each requirement - drawn on the requirements page,
 * beside each requirement and each acceptance criterion.
 *
 * The plan already says which criteria each task answers for: the
 * `_Requirements: 1.2, 3.1_` line under the task. Read the other way
 * round, the same lines say which criteria no task answers for. That is
 * work nobody planned, and without this it is found at code review,
 * after the code was written without it. So the requirements page shows
 * the tasks that cite each criterion, or "No task" when none does.
 *
 * Nothing is written into the requirements file. The marks are worked
 * out from the two documents every time the page draws.
 *
 * A citation counts here exactly when the plan page shows it as one:
 * the same two readers decide - `parseRefLink` for the link spelling,
 * `parseRefLabel` for `_Requirements: 1.2_` and
 * `**Validates: Requirements 1.2**` - and the caller decides where it
 * points the same way the plan page does. So the two pages cannot
 * disagree about whether a task cites a criterion.
 */

import { parseRefLabel, parseRefLink, requirementPreviews } from "./specRefs";

/** Where a citation in the plan points, before it is resolved: a link's href, or the phase a plain-text spelling names. */
export type CitationTarget = { href: string } | { noun: string };

/**
 * The marks for one document, by line: 1-based, in the text that was
 * read, which is what react-markdown numbers its nodes by. Each value
 * is the tasks that cite the id on that line, in plan order. An empty
 * list means no task cites it.
 *
 * A line with nothing to show has no entry.
 */
export type TaskMarks = Map<number, string[]>;

/**
 * A task row and its id - `- [ ] 1.2 Title`, `- [x]* 3.1 Title`,
 * `- [ ] T004 [P] Title`. Every box state the engine's parser reads,
 * Kiro's `[~]` and `[-]` included: a row not read as a row would hand
 * its citations to the task above it.
 */
const ROW = /^\s*-\s+\[[ xX~-]\]\\?\*?\s+(\d+(?:\.\d+)*|T\d+)\b/;

/** Any checkbox line. One with no task number ends the row above it, and names no task itself. */
const CHECKBOX = /^\s*-\s*\[[ xX~-]\]/;

/** A heading ends the details of the row above it: `## Phase 2` is not part of the last task of phase 1. */
const HEADING = /^\s{0,3}#{1,6}\s/;

/** A fence opening or closing. Nothing inside one is a task or a citation - the plan page does not draw it as either. */
const FENCE = /^\s*(?:```|~~~)/;

/** An inline code span. Taken out first: a link inside backticks is code, not a link. */
const CODE_SPAN = /`[^`\n]*`/g;

/** Any link - `parseRefLink` decides whether it is a citation. The same pattern the page uses to find the files a document cites. */
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Emphasis - `**...**`, `__...__`, `*...*`, `_..._` - with the words
 * inside in the third group. `parseRefLabel` decides whether they are a
 * citation.
 *
 * It must open after a space, a bracket or the start of the line, never
 * inside a word, as in markdown itself. So the underscore in
 * `snake_case` does not open an emphasis that swallows the citation
 * after it.
 */
const EMPHASIS = /(^|[^\w*])(\*\*|__|\*|_)([^*_\n]+?)\2(?![\w*])/g;

/**
 * The marks for a document, read from the plan.
 *
 * @param document The text on screen, with its frontmatter split off,
 * so the line numbers are the ones its rendered nodes carry.
 * @param prefix The document's own citation prefix, when its stage
 * declared one - `Req` for `Req-3.2`.
 * @param plan The plan's text.
 * @param pointsHere Whether a citation in the plan points at this
 * document. The caller resolves it the same way the plan page does.
 *
 * Empty when no citation in the plan points at this document - before
 * the plan is written, or when it cites only other documents. A page
 * full of "No task" then would be wrong, not useful.
 */
export function taskMarks(
    document: string | undefined,
    prefix: string | undefined,
    plan: string | undefined,
    pointsHere: (target: CitationTarget) => boolean
): TaskMarks {

    const marks: TaskMarks = new Map();

    if (!document || !plan)
        return marks;

    const read = citedBy(plan, pointsHere);

    if (!read)
        return marks;

    const { cited, order } = read;

    const tasksOf = (...ids: string[]) => [...new Set(ids.flatMap(id => [...cited.get(id) ?? []]))]
        .sort((one, other) => order.get(one)! - order.get(other)!);

    const previews = requirementPreviews(document, prefix);

    // `1.2` belongs to `1`, `Req-1.2` to `Req-1`.
    const parentOf = (id: string) => id.slice(0, id.lastIndexOf("."));

    const withCriteria = new Set(previews.filter(one => one.kind === "criterion").map(one => parentOf(one.id)));

    for (const preview of previews) {

        // A task that cites the whole requirement answers for each of
        // its criteria too.
        if (preview.kind === "criterion")
            marks.set(preview.line, tasksOf(preview.id, parentOf(preview.id)));

        // A requirement with criteria is marked only when a task cites
        // it whole; otherwise its criteria already say everything. One
        // with no criteria can only be cited whole, so it is always
        // marked.
        if (preview.kind === "requirement") {

            const tasks = tasksOf(preview.id);

            if (tasks.length || !withCriteria.has(preview.id))
                marks.set(preview.line, tasks);
        }
    }

    return marks;
}

/**
 * Each id the plan cites in this document, with the tasks that cite it,
 * and each task's place in the plan - or nothing, when no citation in
 * the plan points at this document at all.
 *
 * A citation belongs to the task row above it, as a detail line does.
 * A heading ends the row's details, and so does a checkbox line with no
 * task number. A citation that belongs to no task still counts as the
 * plan citing this document; it just names no task.
 */
function citedBy(plan: string, pointsHere: (target: CitationTarget) => boolean) {

    const cited = new Map<string, Set<string>>();
    const order = new Map<string, number>();

    let owner: string | undefined;
    let fenced = false;
    let pointed = false;

    for (const line of plan.split(/\r?\n/)) {

        if (FENCE.test(line)) {

            fenced = !fenced;
            continue;
        }

        if (fenced)
            continue;

        if (HEADING.test(line)) {

            owner = undefined;
            continue;
        }

        const row = ROW.exec(line);

        if (row) {

            owner = row[1];

            if (!order.has(owner))
                order.set(owner, order.size);
        }
        else if (CHECKBOX.test(line))
            owner = undefined;

        // A row's own title is read too: a citation may sit on it.
        for (const refs of citationsOn(line, pointsHere)) {

            pointed = true;

            if (owner === undefined)
                continue;

            for (const ref of refs) {

                const tasks = cited.get(ref) ?? new Set<string>();

                tasks.add(owner);
                cited.set(ref, tasks);
            }
        }
    }

    return pointed ? { cited, order } : undefined;
}

/** The ids of each citation on a line that points at this document. */
function citationsOn(line: string, pointsHere: (target: CitationTarget) => boolean): string[][] {

    const text = line.replace(CODE_SPAN, " ");

    const found: string[][] = [];

    for (const [, words, href] of text.matchAll(LINK)) {

        const link = parseRefLink(href, words);

        if (link && pointsHere({ href: link.href }))
            found.push(link.refs);
    }

    for (const match of text.matchAll(EMPHASIS)) {

        const label = parseRefLabel(match[3]);

        if (label && pointsHere({ noun: label.target }))
            found.push(label.refs);
    }

    return found;
}

/**
 * Reading `## Open Questions` - the one thing in a document that can
 * stop the pipeline.
 *
 * A phase asks a person what it cannot settle, and if nobody answers it
 * writes the question down. This file decides whether that has
 * happened, and the advance controls read the answer.
 *
 * What counts as answered is an `A:` line, not the section. The section
 * keeps every question the document has raised, answered or not, until
 * a later pass tidies the answered ones away into
 * `## Answered Questions`. Blocking on the section's existence would
 * mean a person who has answered still cannot advance until a model
 * pass runs. Blocking on the unanswered items alone means an answer
 * typed into the document lifts the block the moment it is saved.
 *
 * Tolerant on the way in, strict on what blocks. The shared grammar
 * (`resources/styles/grammar.md`, "Questions and assumptions") says a
 * question is `- **QN-n** text` with an optional `**A:**` line under it.
 * An item that does not follow it - no id, a different bullet, a
 * document by an agent that ignored the grammar - still counts
 * as a question, and without an answer line it still blocks. The cost
 * of reading a stray line as a question is a person deleting it; the
 * cost of missing one is the thing this exists to prevent.
 */

/** One question found under `## Open Questions`. */
export interface OpenQuestion {

    /**
     * The `QN-n` id, when the item carries one.
     *
     * Absent for an item that does not follow the grammar. It still
     * counts - see the file comment - and the panel names it by
     * {@link text} instead.
     */
    id?: string;

    /** The question itself, without the id or the bullet. */
    text: string;

    /** The `A:` line's text, when there is one. An item with an answer does not block. */
    answer?: string;
}

/** The heading the questions live under. */
const HEADING = /^#{1,6}\s+open\s+questions\s*$/i;

/** Any heading at all - where the section ends. */
const ANY_HEADING = /^#{1,6}\s+/;

/**
 * A question item.
 *
 * The bullet may be `-`, `*` or `1.` because all three are markdown
 * lists and a document that used the wrong one is still a document with
 * questions in it. The id is optional for the same reason.
 */
const ITEM = /^\s*(?:[-*+]|\d+\.)\s+(?:\*\*(QN-\d+)\*\*\s*)?(.*)$/;

/**
 * An answer line.
 *
 * The emphasis is what the grammar asks for and what a person copying
 * the shape will type, but a bare `A:` is the same statement and is
 * accepted. Leading whitespace is the indent under the question.
 */
const ANSWER = /^\s*(?:\*\*A:\*\*|__A:__|A:)\s*(.*)$/i;

/**
 * Every question under `## Open Questions`, answered or not.
 *
 * @param document The markdown as it sits on disk.
 *
 * @returns the questions in the order they appear. Empty for a document
 * with no such section, which is the ordinary case.
 */
export function openQuestions(document: string): OpenQuestion[] {

    const lines = document.split(/\r?\n/);

    const found: OpenQuestion[] = [];

    let inSection = false;

    // Where an `A:` line lands. A question's answer may sit a line or
    // two below it, so the item stays current until the next item or
    // the end of the section.
    let current: OpenQuestion | undefined;

    for (const line of lines) {

        if (ANY_HEADING.test(line)) {

            // A second `## Open Questions` would be a malformed
            // document, but reading both is closer to what it means
            // than reading the first and stopping.
            inSection = HEADING.test(line);

            current = undefined;

            continue;
        }

        if (!inSection)
            continue;

        const answer = current && !current.answer ? ANSWER.exec(line) : undefined;

        if (answer) {

            current!.answer = answer[1].trim();

            continue;
        }

        const item = ITEM.exec(line);

        if (!item)
            continue;

        // A bullet with nothing on it is a list someone started and did
        // not finish, not a question.
        if (!item[1] && !item[2].trim()) {

            current = undefined;

            continue;
        }

        current = { ...(item[1] ? { id: item[1] } : {}), text: item[2].trim() };

        found.push(current);
    }

    return found;
}

/** The questions nobody has answered - the ones that block. */
export function unansweredQuestions(document: string): OpenQuestion[] {

    return openQuestions(document).filter(question => question.answer === undefined);
}

/**
 * The document with an answer written under one question - what the
 * answer box under a question saves.
 *
 * The answer goes on an indented `**A:**` line, the shape the grammar
 * asks for, right after the question's own lines. It is kept on one
 * line: the parser reads one `A:` line, so line breaks become spaces.
 *
 * @param index The question's place among {@link openQuestions} of the
 * same document, answered ones included.
 *
 * @returns the document unchanged when there is no such question, it is
 * answered already, or the answer is blank.
 */
export function answerQuestion(document: string, index: number, answer: string): string {

    const text = answer.replace(/\s*\r?\n\s*/g, " ").trim();

    const question = openQuestions(document)[index];

    if (!text || !question || question.answer !== undefined)
        return document;

    const newline = document.includes("\r\n") ? "\r\n" : "\n";
    const lines = document.split(/\r?\n/);

    // Walk the section the way `openQuestions` does, to the index-th item.
    let inSection = false;
    let seen = -1;
    let at = -1;

    for (let line = 0; line < lines.length && at < 0; line++) {

        if (ANY_HEADING.test(lines[line])) {

            inSection = HEADING.test(lines[line]);

            continue;
        }

        const item = inSection ? ITEM.exec(lines[line]) : undefined;

        if (!item || (!item[1] && !item[2].trim()))
            continue;

        if (++seen === index)
            at = line;
    }

    if (at < 0)
        return document;

    const indent = /^\s*/.exec(lines[at])![0];

    // After the question's wrapped lines, before the next item, heading
    // or blank line.
    let end = at + 1;

    while (end < lines.length && lines[end].trim() && !ITEM.test(lines[end]) && !ANY_HEADING.test(lines[end]))
        end++;

    lines.splice(end, 0, `${indent}  **A:** ${text}`);

    return lines.join(newline);
}

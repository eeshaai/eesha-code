/**
 * What a keystroke does to the text in a field.
 *
 * The document editors are plain textareas, so every markdown
 * shortcut comes down to the same three numbers: the text, and where
 * the selection starts and ends. These functions take those three and
 * return the three they should become - no DOM, no React, no event.
 * The view reads them off the element, calls one of these, and writes
 * them back.
 *
 * Pure so the string handling can be tested without mounting a panel.
 */

/** A field's text and its selection - everything a shortcut needs to know, and everything it changes. */
export interface Field {

    text: string;

    /** Selection start, as an offset into `text`. Equal to `end` when nothing is selected. */
    start: number;

    /** Selection end, as an offset into `text`. */
    end: number;
}

/**
 * One step of indent. Two spaces rather than a tab: markdown nesting
 * is counted in spaces, and a tab renders at a different width in
 * every viewer.
 */
const INDENT = "  ";

/** The characters a bare caret grows over, when a shortcut is pressed with nothing selected. */
const WORD = /[\w-]/;

/** Links and paths a `[](...)` should hold, rather than describe. */
const TARGET = /^(?:[a-z][a-z0-9+.-]*:\/\/|[#/]|\.{1,2}\/)/i;

/**
 * The word under the caret, when there is no selection. Pressing
 * Ctrl+B mid-word means "make this word bold" everywhere else.
 */
function grown(field: Field): Field {

    if (field.start !== field.end)
        return field;

    let start = field.start;
    let end = field.end;

    while (start > 0 && WORD.test(field.text[start - 1]))
        start--;

    while (end < field.text.length && WORD.test(field.text[end]))
        end++;

    return { text: field.text, start, end };
}

/**
 * The selection wrapped in `mark`, or unwrapped when it already is.
 *
 * `**` for bold, `*` for italic, `` ` `` for code.
 *
 * A mark only counts as ours when the character outside it is not the
 * same character. Otherwise selecting `bold` inside `**bold**` and
 * pressing Ctrl+I would find a `*` either side, take one off each, and
 * turn bold into italic.
 */
export function wrap(field: Field, mark: string): Field {

    const { text, start, end } = grown(field);

    const outside = text.slice(start - mark.length, start) === mark
        && text.slice(end, end + mark.length) === mark
        && text[start - mark.length - 1] !== mark[0]
        && text[end + mark.length] !== mark[0];

    if (outside)
        return {
            text: text.slice(0, start - mark.length) + text.slice(start, end) + text.slice(end + mark.length),
            start: start - mark.length,
            end: end - mark.length
        };

    const selected = text.slice(start, end);

    // The same marks inside the selection - the whole of `**bold**` was
    // selected instead of the word. The same press still takes them off.
    const inside = selected.length >= mark.length * 2
        && selected.startsWith(mark)
        && selected.endsWith(mark);

    if (inside)
        return {
            text: text.slice(0, start) + selected.slice(mark.length, -mark.length) + text.slice(end),
            start,
            end: end - mark.length * 2
        };

    return {
        text: text.slice(0, start) + mark + selected + mark + text.slice(end),
        start: start + mark.length,
        end: end + mark.length
    };
}

/**
 * The selection turned into a link.
 *
 * Text becomes the label and `url` is left selected, so the next thing
 * typed replaces it. A URL, path, or anchor becomes the target instead,
 * with the caret in the empty label.
 */
export function link(field: Field): Field {

    const { text, start, end } = grown(field);

    const selected = text.slice(start, end);

    if (selected && TARGET.test(selected))
        return {
            text: text.slice(0, start) + "[](" + selected + ")" + text.slice(end),
            start: start + 1,
            end: start + 1
        };

    const made = "[" + selected + "](url)";

    return {
        text: text.slice(0, start) + made + text.slice(end),
        start: start + selected.length + 3,
        end: start + selected.length + 6
    };
}

/**
 * The lines the selection touches, moved one step in or out.
 *
 * Tab is the reason this exists: in a textarea it moves focus out of
 * the field, which is wrong in a document full of nested lists.
 *
 * A caret with nothing selected indents where it stands, which at the
 * head of a line is the same as indenting the line.
 */
export function indent(field: Field, out: boolean): Field {

    const { text, start, end } = field;

    if (start === end && !out)
        return {
            text: text.slice(0, start) + INDENT + text.slice(start),
            start: start + INDENT.length,
            end: start + INDENT.length
        };

    const from = text.lastIndexOf("\n", start - 1) + 1;

    // A selection that ends just after a newline has not reached the
    // line below it, so that line is not indented.
    const last = end > start && text[end - 1] === "\n" ? end - 1 : end;

    const after = text.indexOf("\n", last);
    const to = after < 0 ? text.length : after;

    const lines = text.slice(from, to).split("\n");

    let first = 0;
    let total = 0;

    const moved = lines.map((line, at) => {

        const was = line.length;

        const next = out
            ? line.replace(/^(\t| {1,2})/, "")
            : INDENT + line;

        const delta = next.length - was;

        if (at === 0)
            first = delta;

        total += delta;

        return next;
    });

    return {
        text: text.slice(0, from) + moved.join("\n") + text.slice(to),

        // The caret keeps its place in its line rather than jumping to
        // the end of the block.
        start: Math.max(from, start + first),
        end: Math.max(from, end + total)
    };
}

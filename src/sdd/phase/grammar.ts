/**
 * The document grammar - one file, shared by every style.
 *
 * It states the shapes the spec panel parses: requirement headings,
 * citation links, acceptance criteria blocks, task checkbox rows, the
 * Open Questions section. That text is what makes the outline, the
 * links between documents and the implement lens work at all.
 *
 * **One file, at a fixed place.** It sits directly in the styles folder
 * as `grammar.md`, beside the style folders rather than inside one, and
 * the workspace copy beats the profile one beats the built-in. No style
 * has its own and no key in `style.yml` points elsewhere: a phase that
 * needs a shape the grammar does not state says so in its own
 * instructions file. Eject Style copies the built-in out once, and from
 * then on that copy is yours to edit.
 *
 * Nothing checks your copy. A copy dropping one of the shapes turns
 * that part of the panel off silently, since every parser treats what
 * it cannot read as prose. Worth knowing before you edit it.
 *
 * **Named, not attached.** An attachment is handed as "read these
 * first", so a person asking one question in a fresh session paid for
 * the whole grammar. The phase prompt names the file instead, with the
 * rule for when to open it - see {@link grammarSection}.
 */

/** The file, relative to a styles folder. */
export const GRAMMAR_FILE = "grammar.md";

/**
 * What is added under every phase prompt when a grammar is found:
 * where it is, and when to open it.
 *
 * Written by the engine rather than by a style's prompt files, so
 * rewording or ejecting a prompt cannot drop the rule, and every style
 * gets the same one.
 *
 * @param file Where the grammar resolved to. Absent when no scope has
 * one, which adds nothing - a phase runs without it rather than failing
 * over it.
 */
export function grammarSection(file?: string): string {

    if (!file)
        return "";

    return "\n\n## Grammar\n\n"
        + `The document grammar is \`${file}\`. It is the required shape of every line in a spec document.\n\n`
        + "- Open it only when you write, edit or read a spec document.\n"
        + "- Do not open it for anything else - answering a question, reading code, running a command.\n"
        + "- When anything else disagrees with it about the shape of a line in a spec document, the grammar wins.";
}

/**
 * Painting the words that changed, inside markdown that has already
 * been rendered.
 *
 * The other way to do this is to edit the markdown before it is
 * rendered - wrap the changed words in tags and let the renderer draw
 * them. That way is shorter and wrong: inside a ``` fence the tags
 * print on screen as characters, inside a table they break the row, and
 * inside a link they break the link. A design document has all three.
 *
 * So the renderer does its job untouched, and this runs over what it
 * produced: find the text, split it into words, wrap the ones that
 * moved. Nothing it does can change what the markdown means.
 *
 * Positions are not carried across from the source. The source says
 * `**Monday**` where the screen says `Monday`, and a count of words is
 * not the same on both sides. Instead the two word lists are lined up
 * against each other - see {@link align} - so a word is marked only
 * when it is really the same word.
 */

import { align, normalize, tokenize } from "../../view/diff/textWords";

/** Enough of a rendered node for this to walk. The renderer's own types are not a dependency. */
interface Node {

    type: string;

    /** Text nodes only. */
    value?: string;

    /** Elements only. */
    tagName?: string;

    properties?: Record<string, unknown>;

    children?: Node[];
}

/**
 * Tags whose text is not prose and is left alone: code, and anything
 * drawn from code. Marking a word inside a fence would colour a
 * variable name because a sentence three blocks up was reworded.
 */
const OPAQUE = new Set(["code", "pre", "style", "script"]);

/** Every text node under this one, in reading order, with the parent that holds it. */
function textNodes(node: Node, into: { parent: Node; index: number }[]): void {

    if (!node.children)
        return;

    for (let index = 0; index < node.children.length; index++) {

        const child = node.children[index];

        if (child.type === "text" && typeof child.value === "string")
            into.push({ parent: node, index });

        else if (child.tagName === undefined || !OPAQUE.has(child.tagName))
            textNodes(child, into);
    }
}

/** One word of a text node: where it sits in the node's own string. */
interface Word {

    /** Which entry of the gathered text nodes it belongs to. */
    node: number;

    from: number;

    to: number;

    text: string;
}

/** Splits a string into its words, keeping where each one sat. */
function wordsOf(value: string, node: number): Word[] {

    const words: Word[] = [];
    const pattern = /\S+/g;

    let match = pattern.exec(value);

    while (match) {

        words.push({ node, from: match.index, to: match.index + match[0].length, text: match[0] });
        match = pattern.exec(value);
    }

    return words;
}

/**
 * Marks the words of a rendered block that changed.
 *
 * `source` is the markdown the block was rendered from, and `changed`
 * says which of *its* words moved - one flag per word of
 * `tokenize(source)`. `className` is what a marked word is wrapped in.
 *
 * A word the rendering dropped (markdown syntax) is never marked, and a
 * rendered word that lines up with nothing stays plain. Both are the
 * safe way round: an unmarked word costs a reader a second look, a
 * wrongly marked one costs them their trust in the colour.
 */
export function markWords(tree: Node, source: string, changed: readonly boolean[], className: string): void {

    const holders: { parent: Node; index: number }[] = [];

    textNodes(tree, holders);

    const words: Word[] = [];

    for (let index = 0; index < holders.length; index++) {

        const holder = holders[index];

        words.push(...wordsOf(holder.parent.children![holder.index].value ?? "", index));
    }

    if (words.length === 0)
        return;

    const matched = align(
        tokenize(source).map(normalize),
        words.map(word => normalize(word.text)));

    /** Which rendered words to wrap, gathered per text node so each node is rebuilt once. */
    const marked = new Map<number, Word[]>();

    for (let index = 0; index < words.length; index++) {

        const from = matched[index];

        if (from === undefined || !changed[from])
            continue;

        const list = marked.get(words[index].node);

        if (list)
            list.push(words[index]);
        else
            marked.set(words[index].node, [words[index]]);
    }

    // Rebuilt back to front, so an earlier replacement does not move the
    // index of a later one.
    for (const [node, list] of [...marked.entries()].sort((a, b) => b[0] - a[0])) {

        const holder = holders[node];
        const value = holder.parent.children![holder.index].value ?? "";

        const parts: Node[] = [];

        let at = 0;

        for (const word of list) {

            if (word.from > at)
                parts.push({ type: "text", value: value.slice(at, word.from) });

            parts.push({
                type: "element",
                tagName: "span",
                properties: { className: [className] },
                children: [{ type: "text", value: word.text }]
            });

            at = word.to;
        }

        if (at < value.length)
            parts.push({ type: "text", value: value.slice(at) });

        holder.parent.children!.splice(holder.index, 1, ...parts);
    }
}

/**
 * The same thing as a plugin the renderer will run.
 *
 * Built once per block and held, because the renderer treats a new
 * plugin list as a new document and parses the whole thing again.
 */
export function wordMarkPlugin(source: string, changed: readonly boolean[], className: string) {

    return () => (tree: Node) => markWords(tree, source, changed, className);
}

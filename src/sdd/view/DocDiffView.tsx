import React, { useMemo } from "react";

import Markdown from "../../view/Markdown";
import { textDiffChanges } from "../../view/diff/textChanges";
import { TextDiff } from "../../view/ui";
import type { TextDiffWords } from "../../view/ui";
import { wordMarkPlugin } from "./wordMarks";

/**
 * The document as a before and after, so a reader can see what the last
 * run changed instead of reading the whole thing again.
 *
 * The blocks are compared here, and the UI library's TextDiff draws them - a
 * `+` and green for what arrived, a `-` and red for what went, the old
 * version over the new one for a rewritten block. This view draws each
 * block's text as markdown, with the words that moved picked out.
 *
 * Every block is rendered on its own rather than as one merged document.
 * That is what lets a removed block be drawn at all - it is not in the
 * current text - and it keeps a table or a fence whole.
 *
 * What it costs: a reference-style link defined elsewhere in the
 * document has nothing to resolve against here, and headings carry no
 * anchors. Both are reading aids for the whole document, and this view
 * is not the whole document - it is what moved.
 */

/** One block of markdown, with the words that moved inside it picked out. */
function Block({ text, words }: { text: string; words?: TextDiffWords }) {

    const plugins = useMemo(
        () => words && words.changed.some(Boolean) ? [wordMarkPlugin(text, words.changed, words.className)] : undefined,
        [text, words]);

    return <Markdown expandableDiagrams={false} rehypePlugins={plugins}>{text}</Markdown>;
}

export interface DocDiffViewProps {

    /** The document as it was put aside before the phase last ran, or undefined when none was. */
    baseline: string | undefined;

    /** The document as it stands. */
    current: string;
}

/**
 * The whole view. Renders nothing of its own around the blocks - the
 * caller owns the scrolling box, the same way it does for the reading
 * view.
 */
export default function DocDiffView({ baseline, current }: DocDiffViewProps) {

    const changes = useMemo(() => textDiffChanges(baseline, current), [baseline, current]);

    return (
        <TextDiff
            changes={changes}
            renderBlock={(text, words) => <Block text={text} words={words} />}
            noBeforeText="Nothing to compare against - this document has not been rewritten since it was first drafted."
            noChangeText="No change since the last time this phase ran." />
    );
}

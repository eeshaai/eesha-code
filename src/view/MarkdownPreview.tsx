import React from "react";
import type { Components } from "react-markdown";

import Markdown from "./Markdown";
import { markSpecWords } from "./text/specWords";

/*
 * A Markdown file, rendered - the Preview of a .md file tab.
 *
 * Spec mode colours the spec words (EARS keywords, and Spec Kit's MUST)
 * the way the SDD Doc tab does. The file tab turns it on by itself for a
 * file in a `spec` or `specs` folder, and has a switch to turn it off.
 */

export interface MarkdownPreviewProps {

    /** The file's text. */
    text: string;

    /** Colour the spec words. */
    specMode?: boolean;
}

/** The blocks whose text holds spec words. Code is left alone - see `markSpecWords`. */
const SPEC_COMPONENTS: Components = {
    p: ({ children }) => <p>{markSpecWords(children)}</p>,
    li: ({ children }) => <li>{markSpecWords(children)}</li>,
    td: ({ children }) => <td>{markSpecWords(children)}</td>,
    th: ({ children }) => <th>{markSpecWords(children)}</th>,
    blockquote: ({ children }) => <blockquote>{markSpecWords(children)}</blockquote>
};

export default function MarkdownPreview({ text, specMode = false }: MarkdownPreviewProps) {

    return (
        <div className="md-body eesha-md-preview" data-spec-mode={specMode ? "on" : "off"}>
            <Markdown components={specMode ? SPEC_COMPONENTS : undefined}>{text}</Markdown>
        </div>
    );
}

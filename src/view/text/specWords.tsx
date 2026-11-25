import React from "react";

/*
 * Spec words, coloured: the EARS keywords an acceptance criterion is
 * written in, and the MUST / MUST NOT Spec Kit writes its requirements
 * with. One copy for every surface that shows a spec document - the SDD
 * Doc tab and the Markdown preview of a file in a spec folder.
 *
 * Only uppercase, whole words, so ordinary prose ("shall we", "the
 * file", "you must") is left alone.
 */

/** Every spec word, longest first so `SHALL NOT` wins over `SHALL`. */
export const SPEC_WORDS = /\b(SHALL NOT|MUST NOT|WHEN|WHILE|WHERE|IF|THEN THE|SHALL|MUST|THE)\b/g;

/** The words that open the trigger half of a sentence. The rest open the obligation half. */
export const CONDITIONS = new Set(["WHEN", "WHILE", "WHERE", "IF"]);

/**
 * Wraps every spec word in the strings under a node in a coloured span,
 * leaving the markdown's own elements (bold, code, links) as they were
 * built - only text is rewritten.
 *
 * @param keep an element whose contents are its own business - a link
 * that draws its own preview, say - and are left untouched.
 */
export function markSpecWords(
    node: React.ReactNode,
    keep?: (element: React.ReactElement) => boolean,
    key = 0
): React.ReactNode {

    if (typeof node === "string") {

        const parts = node.split(SPEC_WORDS);

        if (parts.length === 1)
            return node;

        return (
            <React.Fragment key={key}>
                {parts.map((part, index) => index % 2
                    ? (
                        <span
                            key={index}
                            className={`sdd-ears sdd-ears--${CONDITIONS.has(part) ? "condition" : "outcome"}`}>
                            {part}
                        </span>
                    )
                    : part)}
            </React.Fragment>
        );
    }

    if (Array.isArray(node))
        return node.map((child, index) => markSpecWords(child, keep, index));

    if (React.isValidElement(node)) {

        if (keep?.(node))
            return node;

        // Already coloured - by a block this one sits in, say a list
        // item around a paragraph.
        const className = (node.props as { className?: unknown }).className;

        if (typeof className === "string" && className.split(" ").includes("sdd-ears"))
            return node;

        // Code is quoted text: `WHEN` in a code span is not a keyword.
        if (node.type === "code" || node.type === "pre")
            return node;

        const element = node as React.ReactElement<{ children?: React.ReactNode }>;

        if (element.props.children === undefined)
            return node;

        return React.cloneElement(element, undefined, markSpecWords(element.props.children, keep));
    }

    return node;
}

/**
 * Whether a file's Markdown preview starts in spec mode: some folder on
 * its path is named exactly `spec` or `specs` - `.kiro/specs/x/design.md`,
 * `specs/001-login/spec.md`. A whole folder name, not a part of one, so
 * `inspect/` or `spec-notes/` is not one. Case is ignored.
 */
export function isSpecPath(file: string): boolean {

    const folders = file.split(/[\\/]+/).slice(0, -1);

    return folders.some(folder => /^specs?$/i.test(folder));
}

/** Whether a file is Markdown, by its extension. */
export function isMarkdownPath(file: string): boolean {

    return /\.(md|markdown|mdx)$/i.test(file);
}

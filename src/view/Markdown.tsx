import React, { useContext, useMemo } from "react";
import ReactMarkdown, { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CommandBlockContext, isShellFence } from "./commandBlock";
import { Mermaid, mermaidSource } from "./Mermaid";
import { CodeBlock } from "./ui";

/** Every piece of text under a node, in order - what a code fence holds. */
function textOf(node: React.ReactNode): string {

    if (typeof node === "string" || typeof node === "number")
        return String(node);

    if (Array.isArray(node))
        return node.map(textOf).join("");

    if (React.isValidElement(node))
        return textOf((node.props as { children?: React.ReactNode }).children);

    return "";
}

/**
 * A fenced code block, as the UI library's CodeBlock: the language, a copy
 * button and line numbers. `children` is what react-markdown hands a
 * `pre` - a `code` element whose class names the language.
 */
export function CodeFence({ children }: { children: React.ReactNode }) {

    const code = React.Children.toArray(children)[0];

    const className = React.isValidElement(code)
        ? (code.props as { className?: string }).className ?? ""
        : "";

    const language = /\blanguage-([\w+-]+)/.exec(className)?.[1];
    const text = textOf(children).replace(/\n$/, "");

    // A shell command, where the host can run one (see commandBlock.ts).
    const Command = useContext(CommandBlockContext);

    if (Command && language && isShellFence(language))
        return <Command code={text} language={language} />;

    return <CodeBlock code={text} language={language} />;
}

/**
 * The one markdown renderer every page surface uses, so a feature
 * (a diagram, GFM tables) lands once for all of them.
 *
 * Renders no wrapper of its own. The caller owns the box around the
 * document: the `.md-body` class, its pointer handlers, its ref.
 */
export interface MarkdownProps {

    children: string;

    /**
     * Element renderers layered over the defaults. Pass a stable object
     * (a module constant or a `useMemo` result): react-markdown treats
     * these as component types, so a new object on every render makes
     * React mount them from scratch and a drawn diagram is thrown away
     * on each pointer move.
     */
    components?: Components;

    /**
     * Whether a diagram offers its expand button. Off inside a dialog
     * that is already the expanded view, where a second overlay would
     * take two Escapes to leave.
     */
    expandableDiagrams?: boolean;

    /**
     * What the renderers read besides the text - a pinned line, a
     * task's state - folded into one value. The memo below compares
     * props, so a renderer that reads state through a ref draws that
     * state only when this changes. Leave it out when the renderers
     * read nothing but the text.
     */
    revision?: unknown;

    /**
     * Plugins that run over the rendered document before React draws
     * it - the diff view's word marks. Pass a stable array, for the
     * same reason `components` must be stable: a new one means a new
     * document, and the whole text is parsed again.
     */
    rehypePlugins?: React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"];
}

/** A ```mermaid fence is a diagram; any other fence is a code block. */
function preRenderer(expandable: boolean): NonNullable<Components["pre"]> {

    return ({ children }) => {

        const diagram = mermaidSource(children);

        return diagram === undefined
            ? <CodeFence>{children}</CodeFence>
            : <Mermaid code={diagram} expandable={expandable} />;
    };
}

const PRE_EXPANDABLE = preRenderer(true);
const PRE_FIXED = preRenderer(false);

function Markdown({ children, components, expandableDiagrams = true, rehypePlugins }: MarkdownProps) {

    // `revision` is read by the memo's compare, never here.

    const pre = expandableDiagrams ? PRE_EXPANDABLE : PRE_FIXED;

    // Merged once per distinct input, so the identity react-markdown
    // sees changes only when a caller's own renderers do.
    const merged = useMemo<Components>(() => ({ pre, ...components }), [pre, components]);

    return (
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={rehypePlugins} components={merged}>
            {children}
        </ReactMarkdown>
    );
}

/**
 * Memoized, because react-markdown parses its text on every render
 * and a spec document is long. Without this, every render of the
 * panel around it - a streamed log line, the status clock's tick, a
 * keystroke in a note box - parsed the whole document again. The
 * text is a string and the renderers are stable by contract (see
 * `components`), so a shallow compare is exact.
 */
export default React.memo(Markdown);

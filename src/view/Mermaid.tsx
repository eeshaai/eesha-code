import React, { useEffect, useRef, useState } from "react";
import { Button, Modal, UiIcon } from "./ui";

/**
 * A ```mermaid fence, rendered as a diagram.
 *
 * Mermaid is initialized per render, not once at module load: the theme
 * and font come from the page theme and can change under a running page.
 * Initialize is cheap; the render is the work.
 *
 * It is imported per render too, as a dynamic import. Mermaid is ten
 * times the rest of the panel, so it is fetched as its own chunk when a
 * fence is first met, and its per-diagram chunks stay lazy behind it.
 *
 * A diagram that fails to parse shows its error and its source, so the
 * author can see where the parser stopped.
 *
 * Expanding fills the panel, not the screen: a page cannot count on
 * the Fullscreen API. The expanded copy is a second copy of the same
 * SVG drawn over the document, so the document keeps its layout and
 * scroll position.
 */

/** Unique per render call: Mermaid uses the id for the SVG's internal ids and rejects a repeat. */
let sequence = 0;

/** The page's current theme, as Mermaid names it. */
function mermaidTheme(): "dark" | "default" {

    const classes = document.body.classList;

    return classes.contains("eesha-light") || classes.contains("eesha-high-contrast-light")
        ? "default"
        : "dark";
}

/**
 * The theme, watched. The page swaps the class on <body> when the user
 * switches themes; a painted SVG cannot follow, so it is redrawn.
 */
function useMermaidTheme(): "dark" | "default" {

    const [theme, setTheme] = useState(mermaidTheme);

    useEffect(() => {

        const observer = new MutationObserver(() => setTheme(mermaidTheme()));

        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });

        return () => observer.disconnect();
    }, []);

    return theme;
}

/**
 * How the expanded diagram is being looked at. Scale 1 at the origin is
 * "fitted to the panel" - the state the overlay opens in and the state
 * Reset returns to.
 */
interface View {
    scale: number;
    x: number;
    y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

/** Below a quarter the diagram is a smudge; above eight it is one node. */
function clampScale(scale: number): number {

    return Math.min(8, Math.max(0.25, scale));
}

/**
 * Zoom and pan for the expanded diagram.
 *
 * The view is a transform on the SVG's box rather than a scroll
 * position, because zoom has to happen about a point: the thing under
 * the pointer stays under the pointer. `transform-origin` is the box's
 * top-left corner, so the pointer is over
 * `(point - origin - translate) / scale` in the diagram's own space, and
 * the `k` factor holds that still while the scale changes.
 */
function useZoomPan(active: boolean) {

    const stage = useRef<HTMLDivElement>(null);
    const content = useRef<HTMLDivElement>(null);

    /** The gesture in progress: where it started, and the view it started from. */
    const drag = useRef<{ pointer: number; x: number; y: number; from: View } | null>(null);

    /** Whether the last gesture moved. A pan that ends over the backdrop must not read as a click on it. */
    const dragged = useRef(false);

    const [view, setView] = useState<View>(FIT);

    /* Every expand starts fitted. */
    useEffect(() => {

        if (active)
            setView(FIT);

    }, [active]);

    /** `at` is in stage coordinates; without one, zoom about the stage's centre. */
    const zoom = (factor: number, at?: { x: number; y: number }) => {

        setView(previous => {

            const scale = clampScale(previous.scale * factor);
            const box = content.current;

            if (box === null)
                return { ...previous, scale };

            const point = at ?? { x: (stage.current?.clientWidth ?? 0) / 2, y: (stage.current?.clientHeight ?? 0) / 2 };

            const k = scale / previous.scale;
            const qx = point.x - box.offsetLeft;
            const qy = point.y - box.offsetTop;

            return { scale, x: qx - (qx - previous.x) * k, y: qy - (qy - previous.y) * k };
        });
    };

    /* A native listener, because React's wheel listener is passive and
       cannot preventDefault - without that the wheel scrolls the
       document behind the overlay. The effect captures the first `zoom`,
       which is safe: it reads nothing from its render. */
    useEffect(() => {

        const element = stage.current;

        if (!active || element === null)
            return;

        const wheel = (event: WheelEvent) => {

            event.preventDefault();

            const box = element.getBoundingClientRect();

            zoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - box.left, y: event.clientY - box.top });
        };

        element.addEventListener("wheel", wheel, { passive: false });

        return () => element.removeEventListener("wheel", wheel);

    }, [active]);

    const pan = {

        onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {

            if (event.button !== 0)
                return;

            drag.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY, from: view };
            dragged.current = false;

            event.currentTarget.setPointerCapture(event.pointerId);
        },

        onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {

            const start = drag.current;

            if (start === null || start.pointer !== event.pointerId)
                return;

            const dx = event.clientX - start.x;
            const dy = event.clientY - start.y;

            /* A few pixels of slop, so a click that trembles is still a click. */
            if (Math.abs(dx) + Math.abs(dy) > 3)
                dragged.current = true;

            setView({ ...start.from, x: start.from.x + dx, y: start.from.y + dy });
        },

        onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {

            if (drag.current?.pointer === event.pointerId)
                drag.current = null;
        }
    };

    return { view, stage, content, pan, zoom, dragged, reset: () => setView(FIT) };
}

/**
 * @param expandable Whether the diagram offers its own overlay. Off when
 * it is already inside one - a dialog over a dialog takes two Escapes to
 * leave.
 */
export function Mermaid({ code, expandable = true }: { code: string; expandable?: boolean }) {

    const theme = useMermaidTheme();

    const [svg, setSvg] = useState<string>();
    const [error, setError] = useState<string>();
    const [expanded, setExpanded] = useState(false);

    const { view, stage, content, pan, zoom, dragged, reset } = useZoomPan(expanded);

    /* The overlay's keyboard: + - 0 zoom. Escape is the library Modal's,
       which closes only this dialog and lets the press go no further. */
    useEffect(() => {

        if (!expanded)
            return;

        const key = (event: KeyboardEvent) => {

            if (event.key === "+" || event.key === "=")
                zoom(1.25);

            else if (event.key === "-")
                zoom(0.8);

            else if (event.key === "0")
                reset();
        };

        window.addEventListener("keydown", key);

        return () => window.removeEventListener("keydown", key);

    }, [expanded]);

    useEffect(() => {

        let cancelled = false;

        draw().then(
            svg => {

                if (cancelled)
                    return;

                setSvg(svg);
                setError(undefined);
            },
            (failure: unknown) => {

                if (cancelled)
                    return;

                setSvg(undefined);
                setError(failure instanceof Error ? failure.message : String(failure));
            });

        async function draw(): Promise<string> {

            const mermaid = (await import("mermaid")).default;

            mermaid.initialize({
                startOnLoad: false,

                // This component renders the failure itself, next to
                // the source.
                suppressErrorRendering: true,

                // The SVG reaches the DOM raw, so Mermaid's sanitizer
                // stays on.
                securityLevel: "strict",

                theme,
                fontFamily: getComputedStyle(document.body).getPropertyValue("--font-family-default").trim() || undefined
            });

            return (await mermaid.render(`sdd-mermaid-${++sequence}`, code)).svg;
        }

        return () => { cancelled = true; };

    }, [code, theme]);

    if (error !== undefined)
        return (
            <div className="mermaid mermaid--failed">

                <div className="mermaid__error">Diagram did not parse: {error}</div>

                <pre><code>{code}</code></pre>
            </div>
        );

    if (svg === undefined)
        return <div className="mermaid mermaid--pending">Drawing diagram…</div>;

    return (
        <div className="mermaid">

            {/* The frame stays put and its contents scroll, so a wide
                diagram does not carry the expand button off the edge. */}
            <div className="mermaid__scroll" dangerouslySetInnerHTML={{ __html: svg }} />

            {expandable && (
                <Button
                    className="mermaid__expand"
                    variant="secondary"
                    fill="outline"
                    size="icon"
                    title="Expand diagram"
                    aria-label="Expand diagram"
                    onClick={() => setExpanded(true)}>
                    <UiIcon name="open-full" />
                </Button>
            )}

            {/* The library Modal, stretched over the whole panel. */}
            <Modal
                show={expanded}
                onHide={() => setExpanded(false)}
                className="mermaid-overlay"
                ariaLabel="Expanded diagram">

                    <div className="mermaid-overlay__tools">

                        <Button variant="secondary" fill="outline" size="icon" title="Zoom out - minus" aria-label="Zoom out" onClick={() => zoom(0.8)}>
                            <UiIcon name="remove" />
                        </Button>

                        <Button variant="secondary" fill="outline" size="sm" title="Reset - 0" aria-label="Reset zoom" onClick={reset}>
                            {Math.round(view.scale * 100)}%
                        </Button>

                        <Button variant="secondary" fill="outline" size="icon" title="Zoom in - plus" aria-label="Zoom in" onClick={() => zoom(1.25)}>
                            <UiIcon name="add" />
                        </Button>

                        <Button
                            className="mermaid-overlay__close"
                            variant="secondary"
                            fill="outline"
                            size="icon"
                            title="Close - Esc"
                            aria-label="Close diagram"
                            onClick={() => setExpanded(false)}>
                            <UiIcon name="close" />
                        </Button>
                    </div>

                    {/* A click on empty space closes - but not the end
                        of a pan, and not a click on the diagram. */}
                    <div
                        className="mermaid-overlay__stage"
                        ref={stage}
                        {...pan}
                        onClick={event => {

                            if (!dragged.current && (event.target as Element).closest("svg") === null)
                                setExpanded(false);
                        }}>

                        <div
                            className="mermaid-overlay__svg"
                            ref={content}
                            style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
                            dangerouslySetInnerHTML={{ __html: svg }} />
                    </div>
            </Modal>
        </div>
    );
}

/**
 * The source of a ```mermaid fence, or undefined for every other block.
 *
 * react-markdown hands a fence over as <pre><code class="language-x">,
 * so the language lives one level below the element being replaced.
 */
export function mermaidSource(children: React.ReactNode): string | undefined {

    const child = React.Children.toArray(children)[0];

    if (!React.isValidElement(child))
        return undefined;

    const props = child.props as { className?: string; children?: React.ReactNode };

    if (!/\blanguage-mermaid\b/.test(props.className ?? ""))
        return undefined;

    return String(props.children ?? "").replace(/\n$/, "");
}

import { RefObject, useEffect, useState } from "react";

/**
 * Where a reader is in a scrolled document: the file line of the last
 * block that has reached the top of the pane.
 *
 * Read from the DOM on scroll, one read per frame. Only the blocks are
 * looked at, never moved - the headings keep scrolling with the text,
 * so the gutter's line numbers stay beside the blocks they number.
 * Making the headings themselves sticky would break that (see
 * `_sdd-doc.scss`).
 *
 * The top counts from under the bar that sits there (`.sdd-crumbs__bar`),
 * so a heading hidden behind the bar is already "passed", and a heading
 * jumped to - which lands just under the bar - counts as reached. The
 * bar keeps its height while hidden, so this line does not move.
 */
export interface ScrolledLine {

    /** The line at the top of the pane. Undefined above the first block. */
    top: number | undefined;

    /** Whether the `keep` line's block is anywhere on screen. */
    keepInView: boolean;
}

/**
 * @param pane The scrolling element. Blocks are its `.md-body [data-line]` elements.
 * @param watch Anything that moves the blocks or swaps the pane - the
 * document, the tab, full screen. A change re-reads.
 * @param keep A line whose visibility is also reported - the pinned block.
 */
export function useScrolledLine(pane: RefObject<HTMLElement | null>, watch: readonly unknown[], keep?: number): ScrolledLine {

    const [state, setState] = useState<ScrolledLine>({ top: undefined, keepInView: false });

    useEffect(() => {

        const element = pane.current;

        if (!element) {

            setState(current => current.top === undefined && !current.keepInView
                ? current
                : { top: undefined, keepInView: false });

            return;
        }

        let frame = 0;

        const read = () => {

            frame = 0;

            const box = element.getBoundingClientRect();
            const bar = element.querySelector<HTMLElement>(".sdd-crumbs__bar")?.offsetHeight ?? 0;
            const edge = box.top + bar + 1;

            // Blocks come in document order, so their tops only grow:
            // a search, not a walk, and a long plan costs a dozen reads
            // a frame rather than hundreds.
            const blocks = element.querySelectorAll<HTMLElement>(".md-body [data-line]");

            let low = 0;
            let high = blocks.length - 1;
            let found = -1;

            while (low <= high) {

                const middle = (low + high) >> 1;

                if (blocks[middle].getBoundingClientRect().top <= edge) {
                    found = middle;
                    low = middle + 1;
                } else
                    high = middle - 1;
            }

            // Not scrolled at all: nothing has been passed yet, even when
            // the first block starts right under the bar, because nothing
            // sits above the document in the pane.
            const line = found < 0 || element.scrollTop <= 0 ? undefined : Number(blocks[found].dataset.line);
            const top = line !== undefined && Number.isFinite(line) ? line : undefined;

            let keepInView = false;

            if (keep !== undefined) {

                const held = element.querySelector<HTMLElement>(".md-body [data-line=\"" + keep + "\"]")?.getBoundingClientRect();

                keepInView = held !== undefined && held.bottom > edge && held.top < box.bottom;
            }

            setState(current => current.top === top && current.keepInView === keepInView
                ? current
                : { top, keepInView });
        };

        const onScroll = () => {

            if (!frame)
                frame = requestAnimationFrame(read);
        };

        read();

        element.addEventListener("scroll", onScroll, { passive: true });

        // A diagram finishing or the pane resizing moves blocks without
        // a scroll.
        const observer = new ResizeObserver(onScroll);

        observer.observe(element);

        return () => {

            element.removeEventListener("scroll", onScroll);
            observer.disconnect();
            cancelAnimationFrame(frame);
        };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pane, keep, ...watch]);

    return state;
}

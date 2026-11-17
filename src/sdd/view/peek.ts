/**
 * The card a rested pointer opens on a reference - a requirement
 * citation in a document, or a wave number in the Wave graph. One set of
 * timings and one placement rule, so every such card opens and closes
 * the same way.
 */

/**
 * How long a pointer rests on a reference before the card opens. Long
 * enough that a pointer crossing a reference does not open it.
 */
export const PEEK_MS = 300;

/**
 * How long an open card survives a pointer that has left the reference.
 *
 * The card sits `PEEK_GAP` away from the button, so a pointer moving
 * from one to the other is briefly over neither. This delay covers that
 * crossing; the card cancels the timer when the pointer enters it.
 */
export const PEEK_CLOSE_MS = 250;

/** How far the card sits off the reference, and how close to the window edge it may get. */
export const PEEK_GAP = 6;
export const PEEK_MARGIN = 12;

/** The card's width, needed here rather than only in CSS - the flip has to know it before it renders. */
export const PEEK_WIDTH = 380;

/** Where a card was placed: pinned under the reference, or above it when there was no room below. */
export interface PeekAt {

    left: number;

    /** One of the two is set. `bottom` is the flip - measured from the window's bottom edge, as CSS wants it. */
    top?: number;
    bottom?: number;
}

/**
 * Where the card goes for a reference with this box: under it, or above
 * it when there is no room below, and pulled back from the right edge.
 */
export function placePeek(box: DOMRect): PeekAt {

    const left = Math.max(
        PEEK_MARGIN,
        Math.min(box.left, window.innerWidth - PEEK_WIDTH - PEEK_MARGIN));

    const below = window.innerHeight - box.bottom;

    return below > window.innerHeight / 3
        ? { left, top: box.bottom + PEEK_GAP }
        : { left, bottom: window.innerHeight - box.top + PEEK_GAP };
}

/*
 * Small pieces the SDD run view (SddRunView.tsx) uses: its constants,
 * the link to another spec document with its hover preview, the EARS
 * word marks, the outline list and its sticky section bar, the wave
 * badge, task text, the view's icons, and text-box helpers.
 */

import React, { useEffect, useRef, useState } from "react";
import { Components } from "react-markdown";
import { LogLine } from "../../core/models/run";
import { SpecStage } from "../../shared/runMessages";
import { UiIcon, type IconName } from "../../view/ui";
import Markdown from "../../view/Markdown";
import { markSpecWords } from "../../view/text/specWords";
import { Field, link } from "./mdKeys";
import { hasChildren, OutlineItem, sectionAt, visibleOf } from "./outline";
import { RequirementPreview, SpecRefLink as SpecRefLinkData } from "./specRefs";
import { PEEK_CLOSE_MS, PEEK_MS, PeekAt, placePeek } from "./peek";

/**
 * A session's mark in the sessions pane, as the UI library's status dot:
 * pulsing yellow while a question waits, blue while the agent works, red
 * when the run failed - and the words a screen reader says for each.
 */
export const PANE_DOT: Record<string, { status: "connecting" | "busy" | "error"; words: string }> = {
    waiting: { status: "connecting", words: "Waiting for you" },
    running: { status: "busy", words: "Working" },
    failed: { status: "error", words: "Failed" }
};

/** The lane picker's row for the phase's own lines rather than one chat. */
export const COMMON = "@common";

/** How many levels of a plan's tasks the outline lists: `1.`, `1.1` and `1.1.1`. */
export const OUTLINE_TASK_LEVELS = 3;

/** A document with nothing collapsed in its outline. */
export const NOTHING_CLOSED: ReadonlySet<number> = new Set();


/** A question or a permission request in these lines that has no answer yet. */
export function hasOpenAsk(lines: readonly LogLine[]): boolean {

    const answered = new Set(lines.filter(line => line.kind === "answer" && line.askId).map(line => line.askId));

    return lines.some(line => line.kind === "ask" && line.askId && !answered.has(line.askId));
}

/** basename without importing path into the page bundle. */
export function fileName(artifact: string): string {

    return artifact.split(/[\\/]/).pop() ?? artifact;
}

/** The position: the first document phase whose artifact is missing. Undefined when every document exists. */
export function positionOf(stages: SpecStage[]): SpecStage | undefined {

    return stages.find(stage => stage.artifact && !stage.exists);
}

/** The stage before a hidden gate - the actionable one whose page starts what the gate runs. */
export function beforeGate(stages: SpecStage[], gateName: string): SpecStage | undefined {

    const index = stages.findIndex(stage => stage.name === gateName);

    return index > 0 ? stages[index - 1] : undefined;
}

/** The hidden gate right after a stage, when there is one. */
export function hiddenGateAfter(stages: SpecStage[], name: string): SpecStage | undefined {

    const index = stages.findIndex(stage => stage.name === name);

    const next = index >= 0 ? stages[index + 1] : undefined;

    return next?.hidden ? next : undefined;
}

/** The last document that exists - when a gate is parked, this is the one being approved. */
export function underReview(stages: SpecStage[]): SpecStage | undefined {

    return [...stages].reverse().find(stage => stage.artifact && stage.exists);
}

/** The class a followed reference's landing place wears while it flashes, and for how long. */
export const FLASH = "sdd-ref-target--flash";

/**
 * What Next and a group's ▶ do, for their tooltip: the open tasks are
 * worked one after another in the plan's order, each the way its line
 * says.
 */
export const NEXT_TITLE = "one after another in the plan's order, wave by wave: agent tasks in an agent chat, a Run: command in a shell, a Run: workflow in the run panel, and a task done by hand waits for your tick. A command or workflow that succeeds ticks its own box; one that fails stops the plan there";
export const FLASH_MS = 1100;

/**
 * The same flash on a note card, when a margin mark has just brought the
 * panel to it. Same length as the reference flash on purpose.
 */
export const NOTE_FLASH = "ee-comment--highlight";

/**
 * Whether two paths name the same file.
 *
 * A stage's artifact arrives in the platform's spelling and a resolved
 * citation is always forward-slashed, so both are normalised. Compared
 * case-insensitively because Windows treats `Requirements.md` and
 * `requirements.md` as one file.
 */
export function samePath(left: string | undefined, right: string): boolean {

    return left !== undefined
        && left.replace(/\\/g, "/").toLowerCase() === right.replace(/\\/g, "/").toLowerCase();
}

/** The plain words a node renders to - a reference is recognised by its text, not its markup. */
export function plainText(node: React.ReactNode): string {

    if (typeof node === "string" || typeof node === "number")
        return String(node);

    if (Array.isArray(node))
        return node.map(plainText).join("");

    if (React.isValidElement(node))
        return plainText((node.props as { children?: React.ReactNode }).children);

    return "";
}

/**
 * A cross-phase reference, rendered as one control for the whole
 * phrase rather than one per number (a sub-task can cite nine
 * criteria). Following it marks every criterion it names at once.
 *
 * A number the target document does not contain is struck through. A
 * phrase whose every number is stale is not a control at all.
 *
 * Only rendered for a link whose href is a `.md` file and whose text is
 * a name, a colon and numbers - see `citation`. Every other link is
 * left as written.
 */
export function SpecRefLink({ link, known, previews, missing, unnumbered, target, head, onFollow }: {
    link: SpecRefLinkData;

    /**
     * The exact text before the ids, when the document wrote one -
     * `Requirements: `. Absent for a citation link, which is rendered
     * from its own parts.
     */
    head?: string;
    /** Anchors the target document offers, or undefined while it is still unread. */
    known: Set<string> | undefined;
    /** The words behind those anchors, for the card a rested pointer opens. */
    previews: Map<string, RequirementPreview> | undefined;
    /** The link points at a file that is not there. */
    missing: boolean;
    /**
     * The target is a real document that numbers nothing this
     * recognises - a PRD from another team, for example. Kept apart
     * from `missing`: a stale number is the writer's mistake, a document
     * that numbers differently is not, so it must not be struck through.
     */
    unnumbered: boolean;
    /** What to call the target when speaking about it - the file's name. */
    target: string;
    onFollow(): void;
}) {

    // Where the card is, or undefined for closed. Placement is measured
    // once when it opens; a scroll closes the card (see below).
    const [peek, setPeek] = useState<PeekAt | undefined>(undefined);

    const host = useRef<HTMLButtonElement>(null);
    const card = useRef<HTMLSpanElement>(null);
    const timer = useRef<number | undefined>(undefined);
    const closeTimer = useRef<number | undefined>(undefined);

    const cancel = () => {

        if (timer.current === undefined)
            return;

        window.clearTimeout(timer.current);
        timer.current = undefined;
    };

    const cancelClose = () => {

        if (closeTimer.current === undefined)
            return;

        window.clearTimeout(closeTimer.current);
        closeTimer.current = undefined;
    };

    // A revise can rebuild the document and unmount this control while
    // a timer is pending. Without this the timer fires into a gone
    // component.
    useEffect(() => () => { cancel(); cancelClose(); }, []);

    /**
     * A scroll closes the card, because the card is placed once and
     * never moved, so scrolling would leave it pointing at nothing.
     *
     * Captured on the window because scroll does not bubble, and the
     * scrolling element is the reading pane, several ancestors up. The
     * card's own scrolling is excluded so a long criterion can be read.
     */
    useEffect(() => {

        if (peek === undefined)
            return;

        const scrolled = (event: Event) => {

            const target = event.target as Node | null;

            if (target && card.current?.contains(target))
                return;

            cancel();
            cancelClose();
            setPeek(undefined);
        };

        window.addEventListener("scroll", scrolled, true);

        return () => window.removeEventListener("scroll", scrolled, true);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [peek]);

    // Unknown is not broken, and neither is unnumbered: until the target
    // has been read, nothing contradicts the reference.
    const broken = (ref: string) => !unnumbered && known !== undefined && !known.has(ref);

    const live = !missing && !unnumbered && link.refs.some(ref => !broken(ref));

    /**
     * What the card shows: every reference that resolves, in the order
     * the phrase cites them. A stale number is skipped; the
     * strike-through on the phrase already marks it.
     */
    const cards = link.refs
        .map(ref => previews?.get(ref))
        .filter((one): one is RequirementPreview => one !== undefined);

    /**
     * Open after the rest, placed against the reference as it sits now.
     * Flipped above the reference when there is no room below, and
     * pulled back from the right edge.
     */
    const rest = () => {

        cancel();
        cancelClose();

        if (!cards.length)
            return;

        timer.current = window.setTimeout(() => {

            const box = host.current?.getBoundingClientRect();

            if (box)
                setPeek(placePeek(box));

        }, PEEK_MS);
    };

    /**
     * Start closing, from the reference or from the card. The delay lets
     * the pointer cross `PEEK_GAP`; the card's mouse-enter cancels it.
     */
    const leave = () => {

        cancel();

        if (peek === undefined)
            return;

        cancelClose();
        closeTimer.current = window.setTimeout(() => setPeek(undefined), PEEK_CLOSE_MS);
    };

    const phrase = (
        <>
            {head ?? `${link.name} : `}
            {link.refs.map((ref, index) => (
                <React.Fragment key={`${ref}-${index}`}>
                    {index > 0 && ", "}
                    <span
                        className={`sdd-ref__id${broken(ref) ? " sdd-ref__id--broken" : ""}`}
                        title={broken(ref) ? `${ref} is not in ${target} - this reference is stale` : undefined}>
                        {ref}
                    </span>
                </React.Fragment>
            ))}
        </>
    );

    if (!live)
        return (
            <span
                className="sdd-ref sdd-ref--dead"
                title={missing
                    ? `${target} is not there`
                    : unnumbered
                        ? `${target} does not number its requirements the way this spec does, so these references cannot be checked`
                        : `Nothing in ${target} matches - these references are stale`}>
                {phrase}
            </span>
        );

    return (
        <>
            <button
                ref={host}
                type="button"
                className="sdd-ref"

                // No `title` while a card can open: the browser's own
                // tooltip appears over it on the same rest, saying less.
                title={cards.length ? undefined : `Go to ${target} ${link.refs.join(", ")}`}
                onMouseEnter={rest}
                onMouseLeave={leave}

                // Following is the answer the card was a preview of.
                onClick={() => { leave(); onFollow(); }}>
                {phrase}
            </button>

            {peek && (
                <span
                    ref={card}
                    className="sdd-peek"
                    role="tooltip"
                    style={{ left: peek.left, top: peek.top, bottom: peek.bottom }}

                    // A card taller than 45vh scrolls, so the pointer must
                    // be able to reach it and stay. Entering cancels the
                    // close the reference's mouse-leave started.
                    onMouseEnter={cancelClose}
                    onMouseLeave={leave}>

                    {cards.map(card => (
                        <span className="sdd-peek__item" key={card.id}>

                            <span className="sdd-peek__head">
                                <span className="sdd-peek__id">{card.id}</span>
                                {card.heading}
                            </span>

                            {card.text && <span className="sdd-peek__text">{highlightEars(card.text)}</span>}
                        </span>
                    ))}

                    <span className="sdd-peek__hint">Click to open {target}</span>
                </span>
            )}
        </>
    );
}

/**
 * Wraps the spec words - EARS keywords, and Spec Kit's MUST - in every
 * string this node contains, leaving the markdown structure (bold,
 * code, links) exactly as react-markdown built it. The same colouring
 * the Markdown preview's spec mode uses; see `view/text/specWords`.
 */
export function highlightEars(node: React.ReactNode): React.ReactNode {

    // A reference control owns its own contents.
    return markSpecWords(node, element => element.type === SpecRefLink);
}

/**
 * What to call a phase on screen. Messages carry the id; a style that
 * wants its own word sets a label, and this is where it is applied.
 */
export function labelOf(stages: SpecStage[], name: string | undefined): string {

    return stages.find(stage => stage.name === name)?.label ?? name ?? "";
}


/** What an execution stage's lens reads: the last existing document before it. Undefined until that document exists. */
export function lensDocOf(stages: SpecStage[], name: string): SpecStage | undefined {

    const index = stages.findIndex(stage => stage.name === name);

    if (index < 0)
        return undefined;

    return [...stages.slice(0, index)].reverse().find(stage => stage.artifact && stage.exists);
}

/**
 * Scroll an outline list just enough to show its lit entry.
 *
 * By hand rather than `scrollIntoView`, which also scrolls every
 * scrolling box around the list - the document pane among them.
 */
export function keepHereInView(list: HTMLElement | null) {

    const item = list?.querySelector<HTMLElement>(".sdd-outline__item--here");

    if (!list || !item)
        return;

    const box = list.getBoundingClientRect();
    const place = item.getBoundingClientRect();

    if (place.top < box.top)
        list.scrollTop -= box.top - place.top;

    else if (place.bottom > box.bottom)
        list.scrollTop += place.bottom - box.bottom;
}

/**
 * The outline's list. An item with something under it has an arrow in
 * front that hides or shows what is under it; the text still goes to
 * the line.
 *
 * When the reader is inside a collapsed group, the collapsed item is
 * the one lit, so the highlight is never on a hidden row.
 *
 * @param closed The file lines of the collapsed items.
 */
export function OutlineList({ items, here, closed, onToggle, go }: {
    items: readonly OutlineItem[];
    here: number | undefined;
    closed: ReadonlySet<number>;
    onToggle: (line: number) => void;
    go: (line: number) => void;
}) {

    const shown = visibleOf(items, closed);

    const lit = here === undefined ? undefined : sectionAt(shown, here)?.line;

    return (
        <>
            {shown.map(item => {

                const parent = hasChildren(items, items.indexOf(item));
                const open = !closed.has(item.line);

                return (
                    <div key={item.line} className={"sdd-outline__row sdd-outline__row--" + item.depth}>

                        {parent
                            ? (
                                <button
                                    className="sdd-outline__fold"
                                    aria-label={(open ? "Collapse " : "Expand ") + item.text}
                                    aria-expanded={open}
                                    title={open ? "Hide what is under this" : "Show what is under this"}
                                    onClick={() => onToggle(item.line)}>
                                    <UiIcon name={open ? "expand" : "chevron-right"} size="sm" />
                                </button>
                            )
                            : <span className="sdd-outline__fold sdd-outline__fold--none" />}

                        <button
                            className={"sdd-outline__item sdd-outline__item--" + item.depth
                                + (lit === item.line ? " sdd-outline__item--here" : "")}
                            title={item.text + " (line " + item.line + ")"}
                            onClick={() => go(item.line)}>
                            {item.text}
                        </button>
                    </div>
                );
            })}
        </>
    );
}

/**
 * The bar across the top of a scrolled document: the heading the top
 * of the pane is under, and every heading above that one it belongs
 * to. Pressing one goes to it.
 *
 * It sits in a sticky box of no height, so showing or hiding it moves
 * nothing under it - the gutter measured every block where it is, and
 * it stays there. It lies over the text, the way the heading it names
 * would if the heading itself stuck.
 */
export function stickyChain(chain: readonly OutlineItem[], go: (line: number) => void) {

    return (
        <div className="sdd-crumbs">

            {/* Always there, hidden when empty: the scroll reading counts
                the top of the pane from under it, and a heading jumped to
                lands under it, so the line it measures must not come and
                go with the text. */}
            <nav
                className={"sdd-crumbs__bar" + (chain.length === 0 ? " sdd-crumbs__bar--empty" : "")}
                aria-label="Section you are in"
                aria-hidden={chain.length === 0}>
                {chain.map((item, index) => (
                    <React.Fragment key={item.line}>

                        {index > 0 && <span className="sdd-crumbs__sep" aria-hidden="true">›</span>}

                        <button
                            className="sdd-crumbs__item"
                            title={"Go to " + item.text + " (line " + item.line + ")"}
                            onClick={() => go(item.line)}>
                            {item.text}
                        </button>
                    </React.Fragment>
                ))}
            </nav>
        </div>
    );
}

/**
 * One wave of the plan and how far it has got: ticked count and
 * whether an agent is in it.
 */
export interface WaveRow {

    id: number;

    done: number;

    total: number;

    /** Done when every task is ticked, running while an agent works it, pending until then. */
    state: "done" | "running" | "pending";
}

/**
 * The wave a task sits in, when the plan declared a dependency graph,
 * and where that wave stands - ticked, being worked, or waiting.
 * Display only: the agent reads the same graph out of the file.
 */
export function WaveBadge({ row }: { row: WaveRow | undefined }) {

    if (row === undefined)
        return null;

    const title = row.state === "done"
        ? `Wave ${row.id} - every task ticked (${row.done}/${row.total})`
        : row.state === "running"
            ? `Wave ${row.id} - an agent is working it (${row.done}/${row.total} ticked); the next wave starts when every task here is ticked`
            : `Wave ${row.id} - starts once the waves it waits for are ticked (${row.done}/${row.total} ticked)`;

    return (
        // No mark of its own: the row's ▶ beside the checkbox already
        // shows done, working and waiting. The colour says the wave's.
        <span className={`sdd-task__wave sdd-task__wave--${row.state}`} title={title}>
            wave {row.id}
        </span>
    );
}

/**
 * A task row's text: inline markdown (code spans, bold, links) rendered
 * without the `<p>` wrapper, since a task row is one line inside a
 * `<span>`.
 */
export const TASK_TEXT: Components = { p: ({ children }) => <>{children}</> };

export function TaskText({ text }: { text: string }) {

    return <Markdown components={TASK_TEXT}>{text}</Markdown>;
}


/**
 * One rendered block, and where it sits.
 *
 * The gutter is its own column rather than a `::before` on each block.
 * That costs a measuring pass but keeps line numbers out of a copied
 * selection, and gives the change bar and note mark somewhere to sit.
 */
export interface Mark {

    /** The file's own line number, frontmatter included. */
    line: number;

    /** The last file line this block covers - a paragraph is rarely one line. */
    end: number;

    /** Pixels from the top of the reading pane, and how tall the block is. */
    top: number;

    height: number;

    /**
     * The height of the block's first line. The line number is centred
     * in a box of this height so it sits on the line it names, whatever
     * size that line is set in.
     */
    lead: number;
}

/** Whether two measurements say the same thing - what stops a resize observer looping. */
export function sameMarks(left: readonly Mark[], right: readonly Mark[]): boolean {

    return left.length === right.length
        && left.every((mark, index) =>
            mark.line === right[index].line
            && mark.end === right[index].end
            && mark.top === right[index].top
            && mark.height === right[index].height
            && mark.lead === right[index].lead);
}

/**
 * The toolbar's icons, by the name this view uses, as names from the
 * UI library's icon set.
 */
export const ICONS = {
    edit: "edit",
    save: "save",
    outline: "list-bullet",
    notes: "chat",
    full: "open-full",
    exit: "close-full",
    reload: "refresh",
    cancel: "close",
    check: "check",
    undo: "undo",
    trash: "delete",
    open: "expand",
    diff: "diff",
    shut: "chevron-right",
    paneOpen: "panel-right-open",
    paneClose: "panel-right-close"
} satisfies Record<string, IconName>;

/**
 * The sizes the document can be read at. Fixed steps, each one checked
 * against the layout. 1 is the default size, where a document opens.
 */
export const TYPE_SCALES = [0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];

/** The steps an icon may be drawn at. A prop takes a step, never a pixel count. */
export type IconSize = "xs" | "sm" | "md" | "lg" | "xl";

/** The UI library's step for each of this view's. */
export const ICON_SIZES = { xs: "xs", sm: "sm", md: "base", lg: "lg", xl: "xl" } as const;

/**
 * Decoration only. Every button carries its own `aria-label`, so the
 * icon is hidden from the accessibility tree.
 */
export function Icon({ name, size = "md" }: { name: keyof typeof ICONS; size?: IconSize }) {

    return <UiIcon name={ICONS[name]} size={ICON_SIZES[size]} />;
}

/** What a textarea currently holds and where its selection is - the shape every shortcut in {@link mdKeys} works on. */
export function fieldOf(area: HTMLTextAreaElement): Field {

    return { text: area.value, start: area.selectionStart, end: area.selectionEnd };
}

/**
 * A shortcut's result written back into the field it came from.
 *
 * Uses the prototype's value setter, not `area.value = text`. React
 * keeps a tracker on the DOM node with the last value it saw, and a
 * plain assignment updates that tracker too, so the `input` event that
 * follows looks like a no-op and React drops it. The setter leaves the
 * tracker stale, so React sees the change.
 *
 * The selection is restored after the text, because assigning a value
 * moves the caret to the end.
 */
export function applyToField(area: HTMLTextAreaElement, next: Field) {

    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

    setter?.call(area, next.text);

    area.setSelectionRange(next.start, next.end);
    area.dispatchEvent(new Event("input", { bubbles: true }));
}

/** A note's id. Time plus randomness, so two notes in the same second differ. */
export function noteId(): string {

    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * A path as a `file://` URI: forward slashes, and the third slash a
 * Windows drive letter needs. Display only; `openFile` takes the real
 * path.
 */
export function fileUri(path: string): string {

    const slashed = path.replace(/\\/g, "/");

    return "file://" + (slashed.startsWith("/") ? "" : "/") + slashed;
}

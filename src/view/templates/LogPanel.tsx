import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { cleanText, LOG_LEVELS, LogEntry, LogLevel } from "./logEntry";
import { Button, Checkbox, EmptyNote, Input, LoadingSpinner, Select, UiIcon } from "../ui";

/** The levels as the level picker lists them, each with a capital letter. */
const LEVEL_ITEMS = LOG_LEVELS.map(level => ({ level, label: level.charAt(0).toUpperCase() + level.slice(1) }));

/**
 * The one log view every panel renders through - see `logEntry.ts`
 * for the shape it draws from.
 *
 * Filters by a minimum level and by category (multi-select, empty
 * selection meaning every category), searches message text, colours
 * by level, and stays pinned to the newest line until the reader
 * scrolls up.
 */

export interface LogPanelProps {

    entries: readonly LogEntry[];

    /**
     * What to draw instead of the panel when nothing has been logged.
     *
     * Omit it and the panel is drawn as usual, with an empty body. A log
     * in a drawer is better off saying one sentence; a log with a tab of
     * its own is not.
     */
    emptyText?: string;

    /**
     * Something is producing lines that have not arrived yet.
     *
     * Only changes what an empty body says: "Loading logs..." while it
     * is true, "No logs yet" when it is not. The first line can take
     * several seconds, and a blank body across that gap reads as a
     * panel that failed.
     */
    loading?: boolean;

    /** Opens a URL found in a message - the host decides what "open" means. */
    openLink?(url: string): void;
}

const URL_PATTERN = /(https?:\/\/[^\s<>"']+)/g;

/**
 * Categories that arrive as a stream, where one line is more of the
 * last one - the only ones whose repeated meta tag is worth hiding.
 *
 * Stated as what continues rather than what stands alone: every
 * discrete engine event has a time worth reading; only prose split
 * across lines does not.
 *
 * A category this does not know is a task's own name - `shell@1`
 * printing two hundred lines - which is what the collapse is for, so
 * an unknown category continues too.
 */
const CONTINUES = new Set(["message", "reasoning", "prompt", "delta"]);

/** Whether an entry is one of a stream, rather than a thing that happened on its own. */
function continues(category: string): boolean {

    return CONTINUES.has(category) || !KNOWN_KINDS.has(category);
}

/**
 * The categories the engine sets itself - `LogMeta.kind`.
 *
 * Anything else is the fallback a caller supplied, which is a task or
 * plugin name and therefore process output.
 */
const KNOWN_KINDS = new Set([
    "message", "reasoning", "tool.start", "tool.output", "tool.end", "notice",
    "ask", "answer", "delta", "prompt", "error"
]);

/** A regex's own syntax, escaped out of search text so a `.` or `(` in it means itself. */
function escapeForRegExp(text: string): string {

    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One piece of text, with every case-insensitive match of `needle` wrapped for the reader to spot. */
function highlighted(text: string, needle: string): React.ReactNode {

    if (!needle)
        return text;

    const parts = text.split(new RegExp(`(${escapeForRegExp(needle)})`, "ig"));

    if (parts.length === 1)
        return text;

    return parts.map((part, index) =>
        part.toLowerCase() === needle.toLowerCase()
            ? <mark key={index} className="log-view__highlight">{part}</mark>
            : <React.Fragment key={index}>{part}</React.Fragment>
    );
}

/** Splits a message on URLs (rendered as clickable links) and highlights `needle` in the rest. */
function renderMessage(
    text: string,
    openLink: ((url: string) => void) | undefined,
    needle: string
): React.ReactNode {

    const cleaned = cleanText(text);
    const parts = cleaned.split(URL_PATTERN);

    if (parts.length === 1)
        return highlighted(cleaned, needle);

    return parts.map((part, index) =>
        index % 2 === 1
            ? (
                openLink ? (
                    <a
                        key={index}
                        href={part}
                        className="log-view__link"
                        onClick={event => {
                            event.preventDefault();
                            openLink(part);
                        }}>
                        {part}
                    </a>
                ) : <React.Fragment key={index}>{part}</React.Fragment>
            )
            : <React.Fragment key={index}>{highlighted(part, needle)}</React.Fragment>
    );
}

/**
 * How many lines the panel draws when it opens, and how many more each
 * "Load earlier" click adds.
 *
 * A long run has thousands of lines, and drawing all of them when the
 * tab opens would freeze the panel. Lines that arrive after it opened are
 * always drawn - only the old ones wait for a click.
 */
const PAGE = 20;

/** How many lines of one message are shown before the rest is folded away. */
const FOLD_AFTER = 3;

/**
 * A message's text, folded to its first {@link FOLD_AFTER} lines when
 * it has more, with a toggle to see the rest and to fold it again.
 *
 * A build's stack trace or a tool's forty-line result is one entry,
 * and left unfolded it pushes every line after it off the screen.
 * Folded, the reader scrolls past entries, not past output. Counted
 * on newlines, not on wrapped width: a wrapped paragraph is still one
 * line the reader meant to read whole.
 */
function LogMessage({ text, openLink, needle }: { text: string; openLink?(url: string): void; needle: string }) {

    const [open, setOpen] = useState(false);

    const cleaned = cleanText(text);
    const lines = cleaned.split("\n");
    const hidden = lines.length - FOLD_AFTER;

    if (hidden <= 0)
        return <span className="log-view__text">{renderMessage(cleaned, openLink, needle)}</span>;

    const shown = open ? cleaned : lines.slice(0, FOLD_AFTER).join("\n");

    return (
        <>
            <span className="log-view__text">{renderMessage(shown, openLink, needle)}</span>
            <Button
                type="button"
                fill="ghost"
                size="sm"
                className="log-view__fold"
                aria-expanded={open}
                onClick={() => setOpen(current => !current)}>
                <UiIcon name={open ? "collapse" : "expand"} />
                {open ? "Show less" : `${hidden} more ${hidden === 1 ? "line" : "lines"}`}
            </Button>
        </>
    );
}

/** One line's worth of `HH:MM:SS`. */
function formatTime(at: number): string {

    return new Date(at).toLocaleTimeString("en-US", { hour12: false });
}

/** `{3 keys}` / `[5]` - what a collapsed value reads before anyone asks to see the rest of it. */
function summarize(value: unknown): string {

    if (Array.isArray(value))
        return `[${value.length}]`;

    const keys = Object.keys(value as object);

    return `{${keys.length} ${keys.length === 1 ? "key" : "keys"}}`;
}

/** A structured payload, collapsed to a one-word summary until clicked - the closest a plain JSON value gets to a browser console's object. */
function LogValue({ value }: { value: unknown }) {

    const [open, setOpen] = useState(false);

    if (!open)
        return (
            <Button
                type="button"
                fill="ghost"
                size="sm"
                className="log-view__value log-view__value--collapsed"
                onClick={() => setOpen(true)}>
                <UiIcon name="chevron-right" /> {summarize(value)}
            </Button>
        );

    return (
        <div className="log-view__value log-view__value--expanded">
            <Button type="button" fill="ghost" size="sm" className="log-view__value-toggle" onClick={() => setOpen(false)}>
                <UiIcon name="expand" /> {summarize(value)}
            </Button>
            <pre className="log-view__value-json">{JSON.stringify(value, null, 2)}</pre>
        </div>
    );
}

export default function LogPanel({ entries, loading, emptyText, openLink }: LogPanelProps) {

    const [minLevel, setMinLevel] = useState<LogLevel>("info");
    const [categories, setCategories] = useState<ReadonlySet<string>>(new Set());
    const [search, setSearch] = useState("");

    const allCategories = useMemo(
        () => [...new Set(entries.map(entry => entry.category))].sort((a, b) => a.localeCompare(b)),
        [entries]);

    const minRank = LOG_LEVELS.indexOf(minLevel);
    const needle = search.trim();
    const needleLower = needle.toLowerCase();

    const visible = useMemo(() => {

        return entries.filter(entry =>
            LOG_LEVELS.indexOf(entry.level) >= minRank
            && (categories.size === 0 || categories.has(entry.category))
            && (!needleLower
                || entry.message.toLowerCase().includes(needleLower)
                || entry.category.toLowerCase().includes(needleLower)));

    }, [entries, minRank, categories, needleLower]);

    /*
     * How many of the oldest visible lines are not drawn yet. Counted
     * from the top, so new lines arriving at the bottom are drawn and
     * the lines the reader is looking at never shift out of view.
     *
     * Starts over at the last PAGE lines whenever what the panel shows
     * changes underneath it: another filter, another step's log (its
     * first line differs), or a cleared log (fewer lines than were
     * hidden).
     */
    const windowKey = `${entries[0]?.id ?? ""}|${minRank}|${needleLower}|${[...categories].sort().join(",")}`;

    const [logWindow, setLogWindow] = useState(() => ({ key: windowKey, hidden: Math.max(0, visible.length - PAGE) }));

    let hidden = logWindow.hidden;

    if (logWindow.key !== windowKey || logWindow.hidden > visible.length) {

        hidden = Math.max(0, visible.length - PAGE);
        setLogWindow({ key: windowKey, hidden });
    }

    const drawn = hidden > 0 ? visible.slice(hidden) : visible;

    // Where the reader was, measured from the bottom, so lines added
    // above do not push what they were reading down the screen.
    const keepFromBottom = useRef<number | undefined>(undefined);

    const loadEarlier = (): void => {

        const element = bodyRef.current;

        if (element)
            keepFromBottom.current = element.scrollHeight - element.scrollTop;

        setLogWindow(current => ({ ...current, hidden: Math.max(0, current.hidden - PAGE) }));
    };

    const toggleCategory = (category: string): void => {

        setCategories(current => {

            const next = new Set(current);

            if (next.has(category))
                next.delete(category);
            else
                next.add(category);

            return next;
        });
    };

    // Pinned to the newest line until the reader scrolls away from the
    // bottom.
    const bodyRef = useRef<HTMLDivElement>(null);
    const stuckToBottom = useRef(true);

    useEffect(() => {

        const element = bodyRef.current;

        if (element && stuckToBottom.current)
            element.scrollTop = element.scrollHeight;

    }, [visible.length]);

    // Before paint, so the reader never sees the jump - see `loadEarlier`.
    useLayoutEffect(() => {

        const element = bodyRef.current;

        if (element && keepFromBottom.current !== undefined)
            element.scrollTop = element.scrollHeight - keepFromBottom.current;

        keepFromBottom.current = undefined;

    }, [hidden]);

    const onScroll = (): void => {

        const element = bodyRef.current;

        if (!element)
            return;

        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 4;

        stuckToBottom.current = atBottom;
    };

    // Only where the caller asked for it - see `emptyText`.
    if (entries.length === 0 && emptyText !== undefined)
        return <div className="log-view log-view--empty">{emptyText}</div>;

    return (
        <div className="log-view">

            <div className="log-view__toolbar">

                {/* The library's Select, in level order rather than A-Z,
                    with no search box for four choices. */}
                <span className="log-view__level">
                    <Select
                        aria-label="Minimum level"
                        items={LEVEL_ITEMS}
                        labelKey="label"
                        valueKey="level"
                        sort={false}
                        hideSearch
                        value={minLevel}
                        onChange={level => setMinLevel(level as LogLevel)} />
                </span>

                {allCategories.length > 1 && (
                    <details className="log-view__categories">
                        <summary>
                            {categories.size === 0 ? "All categories" : `${categories.size} categor${categories.size === 1 ? "y" : "ies"}`}
                        </summary>
                        <div className="log-view__categories-list">
                            {allCategories.map(category => (
                                <Checkbox
                                    key={category}
                                    label={category}
                                    checked={categories.size === 0 || categories.has(category)}
                                    onChange={() => toggleCategory(category)} />
                            ))}
                        </div>
                    </details>
                )}

                <span className="log-view__search">
                    <Input
                        type="text"
                        placeholder="Filter..."
                        aria-label="Filter log text"
                        value={search}
                        onChange={event => setSearch(event.target.value)} />
                </span>
            </div>

            <div className="log-view__body" ref={bodyRef} onScroll={onScroll}>

                {/* Three empty states the reader must be able to tell
                    apart: lines are coming, nothing is coming, or the
                    filter hid every line. A blank body under a full
                    toolbar reads as broken in all three. Filtered-to-
                    nothing stays separate because an unstarted log has
                    no filter to blame. */}
                {entries.length === 0 && (
                    loading
                        ? <LoadingSpinner message="Loading logs..." />
                        : <EmptyNote icon="notes" text="No logs yet" />
                )}

                {entries.length > 0 && visible.length === 0 && (
                    <EmptyNote icon="filter-off" text="No lines match the current filter." />
                )}

                {hidden > 0 && (
                    <Button type="button" fill="ghost" size="sm" className="log-view__load-earlier" onClick={loadEarlier}>
                        <UiIcon name="collapse" /> Load earlier ({hidden} more)
                    </Button>
                )}

                {drawn.map((entry, index) => {

                    const previous = drawn[index - 1];

                    /*
                     * The meta tag is shown only when level or category
                     * changes, so a burst from one source does not
                     * repeat it on every line - but only where the line
                     * continues the last one, see {@link continues}.
                     * Three questions in a row happened at three
                     * different times and each keeps its tag.
                     */
                    const showMeta = !previous
                        || previous.level !== entry.level
                        || previous.category !== entry.category
                        || !continues(entry.category);

                    return (
                        <div
                            key={entry.id}
                            className={`log-view__line log-view__line--${entry.level}`}
                            data-category={entry.category}>
                            {showMeta && (
                                <span className="log-view__meta">
                                    {formatTime(entry.at)} [{entry.level}] [{highlighted(entry.category, needle)}]
                                </span>
                            )}
                            {entry.agent && (
                                <span className="log-view__agent" title="From a sub-agent">{entry.agent}</span>
                            )}
                            <LogMessage text={entry.message} openLink={openLink} needle={needle} />
                            {entry.data !== undefined && <LogValue value={entry.data} />}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

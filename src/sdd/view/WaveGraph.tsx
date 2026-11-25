import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { needsOf, wavesAfter } from "../../shared/waveOrder";
import { Button, UiIcon } from "../../view/ui";
import type { IconName } from "../../view/ui";
import { PEEK_CLOSE_MS, PEEK_MS, PeekAt, placePeek } from "./peek";
import type { SpecTask, TaskWave } from "./taskList";
import { branchClashes, fileLinks, needsLabel, startingPoints, waveRows } from "./waveLayout";

/**
 * The Wave graph tab of the implement phase: the plan's waves top down,
 * an arrow for every wave a wave waits for, starting points side by
 * side in the first row, and the branches below them joining where a
 * wave waits for more than one.
 *
 * It draws and starts; it decides nothing. Whether a card may start is
 * the same answer the Tasks tab's ▶ gets (`face`), and starting it goes
 * through the same hand-over (`start`).
 */

/** How a card looks and whether it can be pressed - the Tasks tab row's own answer. */
export interface CardFace {

    state: "done" | "running" | "queued" | "open" | "waiting";

    /** The line under the title: "done", "can start now". */
    line: string;

    /**
     * The waves it waits for, when it is waiting. The card says
     * "waits for wave 1" itself, so each number can open its own card.
     */
    waits?: number[];

    /** The tooltip: why it can or cannot start. */
    title: string;

    canStart: boolean;
}

interface Props {

    waves: TaskWave[];

    /** Every unit of work, in the plan's order. */
    units: SpecTask[];

    face(unit: SpecTask): CardFace;

    /** Hand these to the host - the same call the Tasks tab's ▶ makes. */
    start(units: SpecTask[]): void;

    /** What "Run till here" would run for a wave, or for one task of it. */
    till(wave: number, task?: SpecTask): TillFace;

    /** Press "Run till here": the panel asks first, then runs. */
    runTill(wave: number, task?: SpecTask): void;
}

/** A "Run till here" button's answer: how many tasks it runs, and why it cannot when it cannot. */
export interface TillFace {

    count: number;

    /** Set when the button is off: a by-hand task on the way, a busy panel, nothing left. */
    why?: string;
}

const ICON: Record<CardFace["state"], IconName> = {
    done: "check",
    running: "more",
    queued: "hourglass",
    open: "not-run",
    waiting: "lock"
};

/** A line drawn over the graph, in the canvas's own pixels. */
interface Line {

    key: string;

    kind: "needs" | "clash";

    path: string;

    /** Where its words sit, if it has any. */
    label?: { x: number; y: number; text: string };
}

/** The gap between rows, in pixels - the horizontal part of an arrow runs in its middle. */
const ROW_GAP = 40;

/** The task's title without markdown marks - a card has one plain line. */
function plain(text: string): string {

    return text.replace(/[`*_]/g, "");
}

/** The class a wave box wears, and for how long, after a wave number was followed to it. */
const FLASH = "sdd-waves__wave--flash";
const TASK_FLASH = "sdd-waves__task--flash";
const FLASH_MS = 1100;

/** What a wave number's card shows: the wave, what it waits for, and its tasks. */
interface WaveInfo {

    id: number;

    needs: number[];

    tasks: { id: string; text: string; state: CardFace["state"] }[];
}

const STATE_WORD: Record<CardFace["state"], string> = {
    done: "done",
    running: "running",
    queued: "queued",
    open: "can start",
    waiting: "waiting"
};

/**
 * Opening and closing a popup on the element `host` points at: open
 * after the pointer rests, stay open while it crosses to the popup or is
 * on it, close when it leaves both, and close on any scroll but the
 * popup's own - it is placed once and would point at nothing.
 */
function usePeek<T extends HTMLElement>() {

    const [peek, setPeek] = useState<PeekAt | undefined>(undefined);

    const host = useRef<T>(null);
    const card = useRef<HTMLSpanElement>(null);
    const timer = useRef<number | undefined>(undefined);
    const closeTimer = useRef<number | undefined>(undefined);

    const cancel = () => {

        window.clearTimeout(timer.current);
        timer.current = undefined;
    };

    const cancelClose = () => {

        window.clearTimeout(closeTimer.current);
        closeTimer.current = undefined;
    };

    useEffect(() => () => { cancel(); cancelClose(); }, []);

    useEffect(() => {

        if (peek === undefined)
            return;

        const scrolled = (event: Event) => {

            if (card.current?.contains(event.target as Node | null))
                return;

            cancel();
            cancelClose();
            setPeek(undefined);
        };

        window.addEventListener("scroll", scrolled, true);

        return () => window.removeEventListener("scroll", scrolled, true);

    }, [peek]);

    const rest = () => {

        cancel();
        cancelClose();

        timer.current = window.setTimeout(() => {

            const box = host.current?.getBoundingClientRect();

            if (box)
                setPeek(placePeek(box));

        }, PEEK_MS);
    };

    const leave = () => {

        cancel();

        if (peek === undefined)
            return;

        cancelClose();
        closeTimer.current = window.setTimeout(() => setPeek(undefined), PEEK_CLOSE_MS);
    };

    /** Shut at once - for a click inside the popup that moves the graph. */
    const close = () => {

        cancel();
        cancelClose();
        setPeek(undefined);
    };

    return { peek, host, card, rest, leave, close, cancelClose };
}

/**
 * A wave number written anywhere in the graph - "after wave 0",
 * "waits for wave 1". A pointer resting on it opens a card listing the
 * wave's tasks, the same card a requirement citation opens in a
 * document; a click scrolls to the wave and lights it.
 */
function WaveRef({ info, go }: { info: WaveInfo | undefined; go(wave: number): void }) {

    const { peek, host, card, rest, leave, cancelClose } = usePeek<HTMLButtonElement>();

    if (!info)
        return null;

    const ticked = info.tasks.filter(task => task.state === "done").length;

    return (
        <>
            <button
                ref={host}
                type="button"
                className="sdd-ref sdd-waves__ref"
                aria-label={`Wave ${info.id}: ${info.tasks.map(task => `${task.id} ${plain(task.text)}`).join(", ")}`}
                onMouseEnter={rest}
                onMouseLeave={leave}
                onFocus={rest}
                onBlur={leave}
                onClick={() => { leave(); go(info.id); }}>
                {info.id}
            </button>

            {peek && (
                <span
                    ref={card}
                    className="sdd-peek"
                    role="tooltip"
                    style={{ left: peek.left, top: peek.top, bottom: peek.bottom }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={leave}>

                    <span className="sdd-peek__head">
                        <span className="sdd-peek__id">Wave {info.id}</span>
                        {needsLabel(info.needs)} · {ticked} of {info.tasks.length} done
                    </span>

                    {info.tasks.map(task => (
                        <span className="sdd-peek__item" key={task.id}>
                            <span className="sdd-peek__head">
                                <span className="sdd-peek__id">{task.id}</span>
                                {STATE_WORD[task.state]}
                            </span>
                            <span className="sdd-peek__text">{plain(task.text)}</span>
                        </span>
                    ))}

                    <span className="sdd-peek__hint">Click to go to wave {info.id}</span>
                </span>
            )}
        </>
    );
}

/**
 * "wave 1", "waves 2 and 3" - with every number its own `WaveRef`.
 * `prefix` is the words before it: "after", "waits for".
 */
function WaveRefs({ prefix, ids, info, go }: { prefix: string; ids: readonly number[]; info(id: number): WaveInfo | undefined; go(wave: number): void }) {

    return (
        <>
            {prefix} {ids.length === 1 ? "wave" : "waves"}{" "}
            {ids.map((id, index) => (
                <React.Fragment key={id}>
                    {index > 0 && (index === ids.length - 1 ? " and " : ", ")}
                    <WaveRef info={info(id)} go={go} />
                </React.Fragment>
            ))}
        </>
    );
}

/** One task named in a card's popup, with the files that tie it to the card. */
interface Tie {

    id: string;

    text: string;

    state: CardFace["state"];

    paths: string[];
}

/** What a task card's popup lists. */
interface TaskInfo {

    /** The earlier tasks it builds on - they edited a file it edits. */
    buildsOn: Tie[];

    /** The later tasks that build on it. */
    usedBy: Tie[];

    /** Tasks on another branch that edit the same file while it is still to do. */
    clashes: Tie[];
}

/**
 * A task card: one button over the whole card that starts the task, and
 * the popup a resting pointer opens on it - what it builds on, what uses
 * it, and what edits the same file on another branch. The file links
 * live here, in words, instead of as lines over the graph.
 */
function TaskCard({ unit, look, icon, className, info, line, start, goTask, till }: {
    unit: SpecTask;
    look: CardFace;
    icon: IconName;
    className: string;
    info: TaskInfo;
    line: React.ReactNode;
    start(): void;
    goTask(id: string): void;

    /** "Run till this task" - only on a card that waits. */
    till?: { face: TillFace; run(): void };
}) {

    const { peek, host, card, rest, leave, close, cancelClose } = usePeek<HTMLButtonElement>();

    const section = (heading: string, ties: Tie[], warn = false) => ties.length > 0 && (
        <span className="sdd-peek__item">
            <span className={`sdd-waves__peek-heading${warn ? " sdd-waves__peek-heading--warn" : ""}`}>{heading}</span>
            {ties.map(tie => (
                <span className="sdd-peek__item" key={tie.id}>
                    <span className="sdd-peek__head">
                        <button
                            type="button"
                            className={`sdd-ref sdd-waves__ref${warn ? " sdd-waves__ref--warn" : ""}`}
                            aria-label={`Go to ${tie.id} ${plain(tie.text)}`}
                            onClick={() => { close(); goTask(tie.id); }}>
                            {tie.id}
                        </button>
                        <span className="sdd-peek__text">{plain(tie.text)}</span>
                        · {STATE_WORD[tie.state]}
                    </span>
                    <span className={`sdd-waves__peek-path${warn ? " sdd-waves__peek-path--warn" : ""}`}>{tie.paths.join(", ")}</span>
                </span>
            ))}
        </span>
    );

    const tied = info.buildsOn.length + info.usedBy.length + info.clashes.length > 0;

    return (
        <div data-task={unit.id} className={className}>
            <button
                ref={host}
                type="button"
                className="sdd-waves__task-hit"
                aria-label={`${unit.id} ${plain(unit.text)}`}

                // Not `disabled`: the browser sends a disabled button no
                // pointer events, and a card that cannot start is the one
                // whose popup says why.
                aria-disabled={!look.canStart}
                onMouseEnter={rest}
                onMouseLeave={leave}
                onFocus={rest}
                onBlur={leave}
                onClick={() => {

                    // A card that cannot start keeps its popup open: the
                    // popup is the answer to the press.
                    if (!look.canStart)
                        return;

                    close();
                    start();
                }} />
            <UiIcon name={icon} className="sdd-waves__task-icon" />
            <span className="sdd-waves__task-body">
                <span className="sdd-waves__task-title">
                    <b>{unit.id}</b> {plain(unit.text)}
                </span>
                <span className="sdd-waves__task-line">{line}</span>

                {/* Its own button, above the card's: a stray click on a
                    waiting card must not start several chats. */}
                {till && (
                    <button
                        type="button"
                        className="sdd-waves__till"
                        disabled={till.face.why !== undefined}
                        title={till.face.why ?? `Run what this task waits for, then only this task, then stop (${till.face.count} tasks)`}
                        onClick={() => { close(); till.run(); }}>
                        <UiIcon name="skip-next" />
                        Run till this task{till.face.why === undefined ? ` · ${till.face.count}` : ""}
                    </button>
                )}
            </span>

            {peek && (
                <span
                    ref={card}
                    className="sdd-peek"
                    role="tooltip"
                    style={{ left: peek.left, top: peek.top, bottom: peek.bottom }}
                    onMouseEnter={cancelClose}
                    onMouseLeave={leave}>

                    <span className="sdd-peek__item">
                        <span className="sdd-peek__head">
                            <span className="sdd-peek__id">{unit.id}</span>
                            {STATE_WORD[look.state]}
                        </span>
                        <span className="sdd-peek__text">{plain(unit.text)}</span>
                    </span>

                    {section("Builds on", info.buildsOn)}
                    {section("Used by", info.usedBy)}
                    {section("Same file on another branch", info.clashes, true)}

                    <span className="sdd-peek__hint">
                        {look.title}{tied ? " · click a task id to go to it" : ""}
                    </span>
                </span>
            )}
        </div>
    );
}

export default function WaveGraph({ waves, units, face, start, till, runTill }: Props) {

    const canvas = useRef<HTMLDivElement>(null);

    const [lines, setLines] = useState<Line[]>([]);

    const [size, setSize] = useState({ width: 0, height: 0 });

    const byId = useMemo(() => new Map(units.map(unit => [unit.id, unit])), [units]);

    const filesOf = (id: string) => byId.get(id)?.files ?? [];

    const rows = useMemo(() => waveRows(waves), [waves]);

    const entries = useMemo(() => startingPoints(waves), [waves]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const clashes = useMemo(() => branchClashes(waves, filesOf), [waves, byId]);

    // eslint-disable-next-line react-hooks/exhaustive-deps
    const links = useMemo(() => fileLinks(waves, filesOf), [waves, byId]);

    // Only a clash with both sides still to do is worth a warning: once
    // one side is ticked its edit is in git, and the other side simply
    // builds on it.
    const live = clashes.filter(clash => clash.tasks.every(id => { const unit = byId.get(id); return unit !== undefined && face(unit).state !== "done"; }));

    const clashed = new Set(live.flatMap(clash => clash.tasks));

    // The units the graph puts in no wave: worked last, one at a time.
    const waved = new Set(waves.flatMap(wave => wave.tasks));

    const alone = units.filter(unit => !waved.has(unit.id));

    const done = units.filter(unit => face(unit).state === "done").length;

    // Measured after every render that could move a box. The lines are
    // the only thing here that needs real positions, so they are drawn
    // last, over the boxes, from where the boxes actually ended up.
    useLayoutEffect(() => {

        const root = canvas.current;

        if (!root)
            return;

        const measure = () => {

            const base = root.getBoundingClientRect();

            const box = (selector: string) => {

                const element = root.querySelector<HTMLElement>(selector);

                if (!element)
                    return undefined;

                const rect = element.getBoundingClientRect();

                return {
                    left: rect.left - base.left + root.scrollLeft,
                    top: rect.top - base.top + root.scrollTop,
                    width: rect.width,
                    height: rect.height
                };
            };

            const next: Line[] = [];

            for (const row of rows)
                for (const wave of row)
                    for (const needed of wave.needs) {

                        const from = box(`[data-wave="${needed}"]`);
                        const to = box(`[data-wave="${wave.id}"]`);

                        if (!from || !to)
                            continue;

                        const x1 = from.left + from.width / 2;
                        const y1 = from.top + from.height;
                        const x2 = to.left + to.width / 2;
                        const y2 = to.top - 2;
                        const mid = to.top - ROW_GAP / 2;

                        next.push({ key: `needs:${needed}>${wave.id}`, kind: "needs", path: `M ${x1} ${y1} V ${mid} H ${x2} V ${y2}` });
                    }

            for (const clash of clashes) {

                // A clash with a ticked task is over - the file is
                // already in git, and only the other side is left to do.
                if (clash.tasks.some(id => { const unit = byId.get(id); return !unit || face(unit).state === "done"; }))
                    continue;

                const one = box(`[data-task="${clash.tasks[0]}"]`);
                const two = box(`[data-task="${clash.tasks[1]}"]`);

                if (!one || !two)
                    continue;

                // Side by side: a curve under both cards, through the
                // gap below the row, so it never crosses a card between
                // them. Otherwise from the bottom of the upper card to
                // the top of the lower one.
                const level = Math.abs((one.top + one.height / 2) - (two.top + two.height / 2)) < one.height;

                const [upper, lower] = one.top <= two.top ? [one, two] : [two, one];

                if (level) {

                    const x1 = one.left + one.width / 2;
                    const x2 = two.left + two.width / 2;
                    const y = Math.max(one.top + one.height, two.top + two.height);
                    const dip = ROW_GAP / 2;

                    // No words on this one: the gap under a row is where
                    // the arrows to the next row run, and both cards
                    // already say which task and which file.
                    next.push({
                        key: `clash:${clash.tasks.join(">")}`,
                        kind: "clash",
                        path: `M ${x1} ${one.top + one.height} C ${x1} ${y + dip}, ${x2} ${y + dip}, ${x2} ${two.top + two.height}`
                    });

                    continue;
                }

                const [x1, y1, x2, y2] = [upper.left + upper.width / 2, upper.top + upper.height, lower.left + lower.width / 2, lower.top];

                next.push({
                    key: `clash:${clash.tasks.join(">")}`,
                    kind: "clash",
                    path: `M ${x1} ${y1} L ${x2} ${y2}`,
                    label: { x: (x1 + x2) / 2, y: (y1 + y2) / 2 - 6, text: clash.paths.join(", ") }
                });
            }

            setLines(next);
            setSize({ width: root.scrollWidth, height: root.scrollHeight });
        };

        measure();

        const observer = new ResizeObserver(measure);

        observer.observe(root);

        return () => observer.disconnect();

    }, [rows, clashes, units]);

    const direct = useMemo(() => needsOf(waves), [waves]);

    /** What a wave number's card lists - built when it opens, so it always shows the boxes as they are now. */
    const infoOf = (id: number): WaveInfo | undefined => {

        const wave = waves.find(one => one.id === id);

        if (!wave)
            return undefined;

        return {
            id,
            needs: direct.get(id) ?? [],
            tasks: wave.tasks
                .map(task => byId.get(task))
                .filter((unit): unit is SpecTask => unit !== undefined)
                .map(unit => ({ id: unit.id, text: unit.text, state: face(unit).state }))
        };
    };

    /** Scrolls a box into view and lights it for a moment. */
    const land = (selector: string, flash: string) => {

        const box = canvas.current?.querySelector<HTMLElement>(selector);

        if (!box)
            return;

        box.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });

        box.classList.remove(flash);

        // Read once so the class coming back starts the animation again.
        void box.offsetWidth;

        box.classList.add(flash);

        window.setTimeout(() => box.classList.remove(flash), FLASH_MS);
    };

    /** What clicking a wave number does. */
    const go = (id: number) => land(`[data-wave="${id}"]`, FLASH);

    /** What clicking a task id in a card's popup does. */
    const goTask = (id: string) => land(`[data-task="${id}"]`, TASK_FLASH);

    /** The open units of a wave and of every wave down its branch - what "Start from here" hands over. */
    const fromHere = (wave: number) => {

        const ids = new Set([wave, ...wavesAfter(waves, wave)]);

        const tasks = new Set(waves.filter(one => ids.has(one.id)).flatMap(one => one.tasks));

        return units.filter(unit => tasks.has(unit.id) && face(unit).state !== "done");
    };

    const card = (unit: SpecTask) => {

        const look = face(unit);

        const clash = clashed.has(unit.id) && look.state !== "done";

        const icon: IconName = clash && look.state !== "running" ? "warning" : unit.run && look.state === "open" ? "terminal" : ICON[look.state];

        const clashLine = live.find(one => one.tasks.includes(unit.id));

        const wave = waves.find(one => one.tasks.includes(unit.id))?.id;

        const other = clashLine?.tasks.find(id => id !== unit.id);

        const tie = (id: string, paths: string[]): Tie | undefined => {

            const found = byId.get(id);

            return found ? { id, text: found.text, state: face(found).state, paths } : undefined;
        };

        const info: TaskInfo = {
            buildsOn: links.filter(link => link.to === unit.id).map(link => tie(link.from, link.paths)).filter((one): one is Tie => one !== undefined),
            usedBy: links.filter(link => link.from === unit.id).map(link => tie(link.to, link.paths)).filter((one): one is Tie => one !== undefined),
            clashes: live
                .filter(one => one.tasks.includes(unit.id))
                .map(one => tie(one.tasks.find(id => id !== unit.id)!, one.paths))
                .filter((one): one is Tie => one !== undefined)
        };

        return (
            <TaskCard
                key={unit.id}
                unit={unit}
                look={look}
                icon={icon}
                info={info}
                className={[
                    "sdd-waves__task",
                    `sdd-waves__task--${look.state}`,
                    unit.optional ? "sdd-waves__task--optional" : "",
                    clash ? "sdd-waves__task--clash" : ""
                ].filter(Boolean).join(" ")}
                line={<>
                    {look.waits?.length ? <WaveRefs prefix="waits for" ids={look.waits} info={infoOf} go={go} /> : look.line}
                    {clash && other && ` · ${clashLine!.paths.join(", ")} also in ${other}`}
                    {unit.optional ? " · optional" : ""}
                </>}
                start={() => start([unit])}
                goTask={goTask}
                till={wave !== undefined && look.state === "waiting" && unit.run?.kind !== "manual"
                    ? { face: till(wave, unit), run: () => runTill(wave, unit) }
                    : undefined} />
        );
    };

    const waveBox = (id: number, needs: number[], tasks: string[]) => {

        const shown = tasks.map(task => byId.get(task)).filter((unit): unit is SpecTask => unit !== undefined);

        const ticked = shown.filter(unit => face(unit).state === "done").length;

        const finished = shown.length > 0 && ticked === shown.length;

        const running = shown.some(unit => face(unit).state === "running");

        const handed = fromHere(id);

        const ready = shown.some(unit => face(unit).canStart);

        const path = till(id);

        return (
            <div
                key={id}
                data-wave={id}
                className={`sdd-waves__wave${finished ? " sdd-waves__wave--done" : running ? " sdd-waves__wave--running" : ""}`}>

                <div className="sdd-waves__head">
                    <span className="sdd-waves__name">
                        <b>Wave {id}</b> ·{" "}
                        {needs.length
                            ? <WaveRefs prefix="after" ids={needs} info={infoOf} go={go} />
                            : <span className="sdd-waves__entry">{needsLabel(needs)}</span>}
                    </span>
                    <span className="sdd-waves__count">{ticked} of {shown.length} done</span>
                    {!finished && (
                        <Button
                            fill="ghost"
                            size="sm"
                            disabled={!ready}
                            title={ready
                                ? `Start this wave and then every wave that waits for it, one after another (${handed.length} task${handed.length === 1 ? "" : "s"})`
                                : "Nothing in this wave can start yet"}
                            onClick={() => start(handed)}>
                            <UiIcon name="run" /> Start from here
                        </Button>
                    )}
                    {!finished && (
                        <Button
                            fill="ghost"
                            size="sm"
                            disabled={path.why !== undefined}
                            title={path.why ?? `Run what this wave waits for, then this wave, then stop (${path.count} task${path.count === 1 ? "" : "s"})`}
                            onClick={() => runTill(id)}>
                            <UiIcon name="skip-next" /> Run till here{path.why === undefined ? ` · ${path.count} task${path.count === 1 ? "" : "s"}` : ""}
                        </Button>
                    )}
                </div>

                <div className="sdd-waves__tasks">{shown.map(card)}</div>
            </div>
        );
    };

    return (
        <section className="sdd-waves" aria-label="Wave graph">

            <div className="sdd-waves__bar">
                <span className="sdd-waves__summary">
                    {entries.length} starting point{entries.length === 1 ? "" : "s"} · {done} of {units.length} tasks done
                    {live.length > 0 && ` · ${live.length} file clash${live.length === 1 ? "" : "es"} between branches`}
                </span>
            </div>

            <div className="sdd-waves__canvas" ref={canvas}>

                {rows.map((row, index) => (
                    <div key={index} className="sdd-waves__row" style={{ marginBottom: ROW_GAP }}>
                        {row.map(wave => waveBox(wave.id, wave.needs, wave.tasks))}
                    </div>
                ))}

                {alone.length > 0 && (
                    <div className="sdd-waves__row">
                        <div className="sdd-waves__wave sdd-waves__wave--alone" data-wave="alone">
                            <div className="sdd-waves__head">
                                <span className="sdd-waves__name"><b>No wave</b> · each task alone, after every wave</span>
                                <span className="sdd-waves__count">
                                    {alone.filter(unit => face(unit).state === "done").length} of {alone.length} done
                                </span>
                            </div>
                            <div className="sdd-waves__tasks">{alone.map(card)}</div>
                        </div>
                    </div>
                )}

                <svg
                    className="sdd-waves__lines"
                    width={size.width}
                    height={size.height}
                    aria-hidden="true">
                    <defs>
                        <marker id="sdd-waves-head" orient="auto" markerWidth="8" markerHeight="8" refX="6" refY="4">
                            <path d="M0 0 L8 4 L0 8 Z" className="sdd-waves__head-mark" />
                        </marker>
                    </defs>
                    {lines.map(line => (
                        <g key={line.key} className={`sdd-waves__line sdd-waves__line--${line.kind}`}>
                            <path d={line.path} markerEnd={line.kind === "clash" ? undefined : "url(#sdd-waves-head)"} />
                            {line.label && <text x={line.label.x} y={line.label.y}>{line.label.text}</text>}
                        </g>
                    ))}
                </svg>
            </div>

            <div className="sdd-waves__legend" aria-hidden="true">
                <span><UiIcon name="check" /> done</span>
                <span><UiIcon name="more" /> running here</span>
                <span><UiIcon name="not-run" /> can start now</span>
                <span><UiIcon name="lock" /> waits for an earlier wave</span>
                <span><UiIcon name="terminal" /> Run step</span>
                <span><UiIcon name="warning" /> another branch edits the same file</span>
            </div>
        </section>
    );
}

/*
 * The SDD run view's tabs, each drawn: Doc, Tasks, Wave graph, Prompt,
 * Logs and the others a phase can have; and the Run till here dialog.
 * The phase's conversation is not here: it is the phase chat, a normal
 * session beside the spec.
 *
 * Part of SddRunView - see runState.tsx for how the parts fit.
 */

import React from "react";
import { splitWave, wavesOf } from "../phase/waves";
import { Button, Checkbox, EmptyNote, LoadingSpinner, Modal, Textarea } from "../../view/ui";
import Markdown from "../../view/Markdown";
import { PhaseTab } from "../../view/PhasePanel";
import { problemsTab } from "../../view/templates/ProblemsTab";
import DocDiffView from "./DocDiffView";
import LogPanel from "../../view/templates/LogPanel";
import { runTitle } from "./sessionRuns";
import { isTaskDone, SpecTask, waveOf } from "./taskList";
import WaveGraph from "./WaveGraph";
import { stickyChain, TaskText, Icon } from "./runViewHelpers";
import type { RunState } from "./runState";
import type { ImplementState } from "./implementState";
import type { DocEditing } from "./docEditing";
import type { DocParts } from "./docParts";

export function usePhaseTabs(ctx: RunState & ImplementState & DocEditing & DocParts) {

    const {
        props, specStages, isRunning, startPhase, startTasks, queuedTasks, openFile, logsByTask,
        stopPhase, sessionCost, docDiff,
        problems, docStage, artifact, content, draftingStage, current, promptPath,
        promptText, setPanePick, pointPane, tabIds, pluginTabs,
        editing, diffing, closing, setClosing, editorRef, blockRef, typeScale, hoverLine,
        setHoverLine, pinned, setPinned, blockEdit, setBlockEdit, composing, showNotes, openComposer,
        full, marks, setDrafts, draft, promptEditing, promptClosing, setPromptClosing,
        promptEditorRef, promptBodyRef, promptDraft, body, bodyRef, gutterChars, readingRef,
        baselineBody, docChain, notesHere, openNotes, tasks, units, unitsDone,
        setLaunched, chats, chatTasksOf, isWorking, waves, yourTurn, runningWave, tasksRef,
        goToRunningWave, pending, logLines, lanePicker, logEntries, phaseUsage, listedRuns, talksTo,
        paneRun, paneLines, paneEntries, askingStage, logsLoading, unitById, questionBoxes, handed,
        tillOf, tillFace, tillAsk, setTillAsk, tillPicked, setTillPicked, askTill, graphFace,
        blockOf, openBlock, commitBlock, saveNow, savePrompt, discardPrompt, promptChain,
        promptHeadings, goToPromptLine, discardDraft, goToLine, renderRevision, markdownComponents,
        outlineRail, notesRail, currentLabel, nameOf, docTools, docInfo, promptTools,
        promptOutlineRail, taskTree
    } = ctx;

    /** Every tab this view can draw, by id; `tabIds` says which of them this phase gets. */
    const allTabs: Record<string, PhaseTab> = {

        tasks: {
            id: "tasks",
            label: "Tasks",
            count: pending.length,
            title: "The plan as an execution dashboard - each unit of work starts its own agent chat",
            render: () => artifact === undefined ? null : (
                <section className="sdd-doc" aria-label="Tasks">

                    <div className="sdd-doc__bar">

                        {/* What the plan is and how far it has got, and
                            nothing to press.

                            Starting the whole remaining plan lives
                            beside the spec title, where it can be
                            reached from any phase - a second button
                            here would be the same button twice on screen,
                            since this tab is only open once every
                            document is written, which is exactly when
                            the one above appears. Each row keeps its
                            own play button, and its own chat.

                            No edit either, by design: changing
                            the plan mid-implementation goes through
                            the tasks phase's own session, the recorded
                            path. */}
                        <div className="sdd-doc__tools">

                            {tasks.length > 0 && (
                                <span className="sdd-tasks__count">{unitsDone}/{units.length} done</span>
                            )}

                            {nameOf(artifact, Boolean(docStage?.exists))}
                        </div>
                    </div>

                    <div className="sdd-doc__body">

                        {!docStage?.exists && (
                            <EmptyNote icon="file" text="Not written yet." />
                        )}

                        {docStage?.exists && content === undefined && (
                            <LoadingSpinner message="Loading…" />
                        )}

                        {content !== undefined && (
                            <div className="sdd-tasks" ref={tasksRef}>

                                {/* Which wave the agent is in, when the
                                    plan has waves and one is being
                                    worked. Pressing it lands on that
                                    wave's first row; each row's badge
                                    says where its own wave stands. */}
                                {runningWave !== undefined && (
                                    <button
                                        className="sdd-tasks__running"
                                        title={`Scroll to wave ${runningWave}`}
                                        onClick={goToRunningWave}>
                                        {yourTurn !== undefined
                                            ? `Your turn: task ${yourTurn}`
                                            : `Running wave ${runningWave}`}
                                    </button>
                                )}

                                {tasks.length === 0 && (
                                    <EmptyNote icon="checklist" text="No tasks found - the plan has no checkbox lines to run." />
                                )}

                                {tasks.map(task => (
                                    <div key={task.line} className="sdd-task">
                                        {taskTree(task, 0)}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </section>
            )
        },

        doc: {
            id: "doc",
            label: "Doc",
            count: openNotes.length,
            title: openNotes.length
                ? openNotes.length + " open review note" + (openNotes.length === 1 ? "" : "s")
                : "The document - read it, pin a block, leave a note, edit a block in place or the whole file",
            info: artifact === undefined ? undefined : docInfo("document", docTools, artifact),
            render: () => artifact === undefined ? null : (
                <section
                    className={"sdd-doc" + (full ? " sdd-doc--full" : "")}
                    aria-label="Document">

                    {/* Escape pressed in the editor over a draft nobody
                        has saved. Three answers, because there are three
                        - and picking one of them for the reader is how
                        an hour of typing gets lost.

                        The UI library's Modal: named, focus on Save,
                        a backdrop, and Escape to leave. */}
                    <Modal
                        show={editing && closing}
                        centered
                        ariaLabel="Unsaved changes"
                        className="sdd-ask"
                        onHide={() => setClosing(false)}>

                        <Modal.Header>
                            <Modal.Title>Save your changes?</Modal.Title>
                        </Modal.Header>

                        <Modal.Body>
                            {artifact.split(/[\\/]/).pop()} has changes that are not on disk yet.
                        </Modal.Body>

                        <Modal.Footer>

                            <Button
                                size="sm"
                                onClick={() => setClosing(false)}>
                                Keep editing
                            </Button>

                            <Button
                                size="sm"
                                onClick={() => { setClosing(false); discardDraft(); }}>
                                Discard
                            </Button>

                            <Button
                                variant="primary"
                                size="sm"
                                autoFocus
                                onClick={() => { setClosing(false); saveNow(true); }}>
                                Save
                            </Button>
                        </Modal.Footer>
                    </Modal>

                    <div className="sdd-doc__split">

                        {outlineRail}

                        <div className="sdd-doc__body" ref={bodyRef}>

                            {!editing && stickyChain(docChain, goToLine)}

                            {questionBoxes}

                            {content === undefined && (
                                <LoadingSpinner message="Loading…" />
                            )}

                            {content !== undefined && editing && (
                                <Textarea
                                    className="sdd-doc__editor"
                                    ref={editorRef}
                                    value={draft}
                                    onChange={event => setDrafts(previous => ({ ...previous, [artifact]: event.target.value }))}

                                    /* On, because this is a document being proof-read, not a
                                       code field. The misspelling in a requirement is the
                                       thing the reader is here to catch, and the editor
                                       already knows how to point at it. */
                                    spellCheck={true}
                                />
                            )}

                            {/* What the last run changed, in place of the
                                document. Alone in its box: the outline,
                                the margin and the notes all anchor to
                                lines of the document being read, and half
                                the lines here come from the version
                                before it. */}
                            {content !== undefined && !editing && diffing && docDiff && (
                                <div
                                    className="sdd-doc__reading"
                                    style={{ "--type-scale": typeScale } as React.CSSProperties}>

                                    <div className="md-body">
                                        <DocDiffView baseline={baselineBody} current={body} />
                                    </div>
                                </div>
                            )}

                            {content !== undefined && !editing && !(diffing && docDiff) && (
                                <div
                                    className="sdd-doc__reading"
                                    style={{
                                        "--type-scale": typeScale,
                                        "--gutter-chars": gutterChars
                                    } as React.CSSProperties}
                                    ref={readingRef}>

                                    {/*
                                        The margin: where a block is, and what is on it.

                                        One number per block would be wrong. Rendered blocks are
                                        not source lines, so the column would read 74, 77, 78, 81, 85
                                        - true, and a sequence with holes in it looks like a bug
                                        rather than like a file.

                                        A range says the same thing without the holes. "74-76" then
                                        "78-81" explains its own gap: the line between them is the
                                        blank one that ended the paragraph. The numbers read as a
                                        file instead of as a fault.

                                        Beside it, the one mark that is about the block rather than
                                        about where it sits: a note. What changed is not marked here - the "What changed" button shows it.
                                    */}
                                    <div className="md-gutter">
                                        {marks.map(mark => {

                                            const here = notesHere.get(mark.line) ?? [];
                                            const open = here.filter(one => !one.resolved).length;

                                            return (
                                                <React.Fragment key={mark.line}>

                                                <div
                                                    className={"md-gutter__row"
                                                        + (pinned === mark.line || hoverLine === mark.line
                                                            ? " md-gutter__row--live"
                                                            : "")}

                                                    /*
                                                     * As tall as the whole block, so the mark
                                                     * centres against it.
                                                     *
                                                     * It is not one line tall, which would put the mark level with the first line - right for line numbers, and wrong for a mark about the block as a whole.
                                                     */
                                                    style={{ top: mark.top, height: mark.height }}>

                                                    {/*
                                                        Where this block is in the file.

                                                        `data-mark` and never `data-line`: the measuring pass
                                                        collects every `[data-line]` inside the reading pane,
                                                        the gutter is inside that pane, and a mark that
                                                        answered to it would be measured as a block and
                                                        positioned against itself.
                                                    */}
                                                    {/*
                                                        Only the first line, and level with it rather than
                                                        centred on the block. A block that holds other blocks
                                                        (a task and its sub-items) would centre its number on top
                                                        of a child's. The full range is in the tooltip.
                                                    */}
                                                    <span
                                                        className="md-gutter__num"
                                                        data-mark={mark.line}
                                                        style={{ height: mark.lead }}
                                                        title={mark.end > mark.line
                                                            ? "Lines " + mark.line + " to " + mark.end + " of the file"
                                                            : "Line " + mark.line + " of the file"}>
                                                        {mark.line}
                                                    </span>

                                                    {/*
                                                        The left margin offers the two things you can do TO a
                                                        block: say something about it, and change it. What a
                                                        block already HAS is shown on the other side, beside
                                                        the text it is about - as a card where there is room,
                                                        and behind a mark of its own where there is not.
                                                    */}
                                                    <div className="md-gutter__tools">

                                                        <button
                                                            className="md-gutter__mark md-gutter__note"
                                                            data-mark={mark.line}
                                                            aria-label="Leave a note on this block"
                                                            tabIndex={pinned === mark.line ? 0 : -1}
                                                            title="Leave a note on this block"
                                                            onClick={() => {

                                                                setPinned(mark.line);

                                                                // One place to write a note, whatever the panel
                                                                // is wide enough for: the notes panel, with the
                                                                // composer pinned under its list.
                                                                openComposer(mark.line);
                                                            }}>
                                                            +
                                                        </button>

                                                        {/*
                                                            The same thing Enter does to the pinned block, for
                                                            the hand that is already on the mouse. Without it,
                                                            a reader who spots a wrong line would have to first
                                                            learn that blocks can be pinned.

                                                            It pins as well as opens, so the keyboard picks up
                                                            where the pointer left off rather than on whatever
                                                            block was pinned before.
                                                        */}
                                                        <button
                                                            className="md-gutter__mark md-gutter__edit"
                                                            data-mark={mark.line}
                                                            aria-label="Edit this block"
                                                            tabIndex={pinned === mark.line ? 0 : -1}
                                                            title="Edit this block"
                                                            onClick={() => {

                                                                setPinned(mark.line);
                                                                openBlock(mark.line, mark.end);
                                                            }}>
                                                            <Icon name="edit" size="sm" />
                                                        </button>
                                                    </div>
                                                </div>
                                                </React.Fragment>
                                            );
                                        })}
                                    </div>

                                    {/*
                                        Too narrow for a card, so the mark answers for it:
                                        hovering the margin mark shows what the note says,
                                        where it says it. A read-only look - the actions
                                        stay in the rail, which is a click away and is
                                        where a narrow panel expects to do its work.
                                    */}
                                    {/*
                                        No room for the cards, so the same column carries a
                                        mark instead - one per block that has something to
                                        say, on the side the note would have been. What
                                        opens is the card itself, actions included: a
                                        different way of reaching a note, not a lesser one.
                                    */}
                                    {/*
                                        The marks, on every width.

                                        They do not wait for the margin to be too narrow to spell the notes out beside the text. Notes are not drawn inline,
                                        so this is the only thing in the margin
                                        that says a block has been written about -
                                        and it is the way into the panel that
                                        holds them.
                                    */}
                                    <div className="md-marks">
                                            {marks.map(mark => {

                                                const here = notesHere.get(mark.line) ?? [];

                                                if (here.length === 0 && composing?.line !== mark.line)
                                                    return null;

                                                const open = here.filter(one => !one.resolved).length;

                                                return (
                                                    <button
                                                        key={mark.line}
                                                        className={"md-marks__mark" + (open > 0 ? " md-marks__mark--open" : "")}
                                                        data-mark={mark.line}

                                                        // Centred on its block, and as tall as it -
                                                        // a 16px icon is a small thing to have to
                                                        // find with a pointer.
                                                        style={{ top: mark.top, height: mark.height }}
                                                        aria-label={here.length + " note" + (here.length === 1 ? "" : "s") + " on this block"}
                                                        title={here.length + " note" + (here.length === 1 ? "" : "s") + " - click to read them in the notes panel"}

                                                        // Click, not hover. A hover popup would close
                                                        // the moment you moved towards it, which
                                                        // would make reading a note a knack rather than an
                                                        // action. This opens the panel and scrolls it
                                                        // to this line's notes, where they can be read,
                                                        // edited and resolved at rest.
                                                        onClick={() => showNotes(mark.line)}>
                                                        <Icon name="notes" />
                                                        {here.length > 1 && (
                                                            <span className="sdd-doc__count">{here.length}</span>
                                                        )}
                                                    </button>
                                                );
                                            })}
                                    </div>

                                    <div
                                        className="md-body"
                                        onMouseMove={event => {

                                            const block = blockOf(event.target);
                                            const line = block ? Number(block.dataset.line) : undefined;

                                            // Only on a crossing, so moving the pointer
                                            // through a paragraph is not a render per pixel.
                                            setHoverLine(current => current === line ? current : line);
                                        }}
                                        onMouseLeave={() => setHoverLine(undefined)}
                                        onClick={event => {

                                            const block = blockOf(event.target);

                                            if (!block)
                                                return;

                                            /*
                                             * A click pins, and does nothing else.
                                             *
                                             * It does not open the editor on a second click, which would collide with the ordinary way people select a word: double-clicking one is two clicks, and it would open an editor over the text being copied. Counting the clicks does not
                                             * separate them either - by the time the second
                                             * arrives the first has already fired, and on an
                                             * already-pinned block that first click IS the
                                             * one that opened it. Only a timer could tell the
                                             * two apart, and a click that waits to find out
                                             * is a click that feels broken.
                                             *
                                             * So the document keeps the gestures a document
                                             * owns - selecting, and saying which line you are
                                             * on - and Enter opens the pinned block.
                                             */
                                            setPinned(Number(block.dataset.line));
                                        }}>
                                    <Markdown components={markdownComponents} revision={renderRevision}>
                                        {body}
                                    </Markdown>
                                    </div>

                                    {/* The block editor, laid exactly over the block it
                                        replaces rather than swapping it out of the
                                        document. Everything around it stays rendered,
                                        which is the whole point: proof-reading and fixing
                                        stop being two modes you flip between and lose
                                        your place in. */}
                                    {blockEdit && (() => {

                                        const mark = marks.find(one => one.line === blockEdit.start);

                                        return (
                                            <div
                                                className="sdd-block-edit"
                                                style={{ top: mark ? mark.top - 6 : 0 }}>

                                                <Textarea
                                                    className="sdd-block-edit__field"
                                                    ref={blockRef}
                                                    autoFocus
                                                    spellCheck={true}
                                                    rows={Math.max(2, blockEdit.text.split(String.fromCharCode(10)).length)}
                                                    value={blockEdit.text}
                                                    onChange={event => setBlockEdit({ ...blockEdit, text: event.target.value })}
                                                    onKeyDown={event => {

                                                        if (event.key === "Escape") {

                                                            /*
                                                             * The field owns this Escape, and only
                                                             * this one.
                                                             *
                                                             * Without stopping it the same keypress
                                                             * would carry on up to the window handler,
                                                             * which drops the pin - so closing an
                                                             * editor would also lose the block you were
                                                             * working on. The activeElement guard up
                                                             * there cannot catch it: by the time the
                                                             * event reaches the window this field has
                                                             * already been unmounted, and focus is
                                                             * back on the body.
                                                             */
                                                            event.stopPropagation();
                                                            setBlockEdit(undefined);

                                                        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey))
                                                            commitBlock();
                                                    }} />

                                                <div className="sdd-block-edit__tools">
                                                    <span className="sdd-block-edit__hint">
                                                        Lines {blockEdit.start}
                                                        {blockEdit.end > blockEdit.start ? "\u2013" + blockEdit.end : ""}
                                                        {" · Ctrl+Enter keeps it, Esc drops it"}
                                                    </span>
                                                    <Button size="sm" onClick={() => setBlockEdit(undefined)}>Cancel</Button>
                                                    <Button variant="primary" size="sm" onClick={commitBlock}>Keep</Button>
                                                </div>
                                            </div>
                                        );
                                    })()}
                                </div>
                            )}
                        </div>

                        {notesRail}
                    </div>
                </section>
            )
        },

        logs: {
            id: "logs",
            label: "Logs",
            count: logLines.length,
            title: current ? `What ${currentLabel} said while it ran` : "Activity",
            tools: lanePicker,
            // No empty text: the tab is the log's own, so it draws the
            // panel whether or not the phase has said anything yet.
            render: () => (
                <div className="log-tab">
                    <LogPanel entries={logEntries} loading={logsLoading} />
                </div>
            )
        },

        /*
         * There is no Env tab.
         *
         * A phase declares no `params:`, no `vars:` and no `env:` of
         * its own (see `runTitle`), so the four anchors would be the
         * whole of it - and those are written into the phase's own log,
         * beside what ran and what it was handed.
         */

        prompt: {
            id: "prompt",
            label: "Prompt",
            title: `The fixed instruction ${currentLabel} runs on - editable, and it belongs to the style rather than to this spec`,
            info: promptPath === undefined ? undefined : docInfo("prompt", promptTools, promptPath),

            /*
             * The contract behind the phase - read here, and edited here too.
             *
             * A prompt is shared by every spec of this style and this
             * panel is about one spec, and that is said in the line above
             * the file. The person who wants the wording changed is the
             * person reading it, so there is no need to send them to
             * another editor to change one sentence.
             *
             * Everything the Doc tab does except the review layer. See
             * `promptTools`.
             */
            render: () => promptPath === undefined ? null : (
                <section
                    className={"sdd-doc" + (full ? " sdd-doc--full" : "")}
                    aria-label="Prompt">

                    {/* The same question the document asks, for the same
                        reason - see the Doc tab. */}
                    <Modal
                        show={promptEditing && promptClosing}
                        centered
                        ariaLabel="Unsaved changes"
                        className="sdd-ask"
                        onHide={() => setPromptClosing(false)}>

                        <Modal.Header>
                            <Modal.Title>Save your changes?</Modal.Title>
                        </Modal.Header>

                        <Modal.Body>
                            {promptPath.split(/[\\/]/).pop()} has changes that are not on disk yet.
                        </Modal.Body>

                        <Modal.Footer>

                            <Button
                                size="sm"
                                onClick={() => setPromptClosing(false)}>
                                Keep editing
                            </Button>

                            <Button
                                size="sm"
                                onClick={() => { setPromptClosing(false); discardPrompt(); }}>
                                Discard
                            </Button>

                            <Button
                                variant="primary"
                                size="sm"
                                autoFocus
                                onClick={() => { setPromptClosing(false); savePrompt(true); }}>
                                Save
                            </Button>
                        </Modal.Footer>
                    </Modal>

                    <div className="sdd-doc__split">

                        {promptOutlineRail}

                        <div className="sdd-doc__body" ref={promptBodyRef}>

                            {!promptEditing && stickyChain(promptChain, goToPromptLine)}

                            {/* Who else this edit lands on. Said once,
                                above the file, rather than in a tooltip
                                nobody opens - a prompt is the style's,
                                so a change here is a change to every
                                spec that follows it. */}
                            <p className="sdd-doc__shared">
                                This prompt belongs to the style, not to this spec. Editing it changes
                                what every spec following this style runs.
                            </p>

                            {promptText === undefined && (
                                <LoadingSpinner message="Loading…" />
                            )}

                            {promptText === "" && !promptEditing && (
                                <EmptyNote icon="error" text={"The prompt file is missing - " + promptPath} />
                            )}

                            {promptText !== undefined && promptEditing && (
                                <Textarea
                                    className="sdd-doc__editor"
                                    ref={promptEditorRef}
                                    value={promptDraft}
                                    onChange={event => setDrafts(previous => ({ ...previous, [promptPath]: event.target.value }))}
                                    spellCheck={true}
                                />
                            )}

                            {promptDraft && !promptEditing && (
                                <div
                                    className="md-body sdd-prompt"
                                    style={{ "--type-scale": typeScale } as React.CSSProperties}>
                                    <Markdown components={promptHeadings}>{promptDraft}</Markdown>
                                </div>
                            )}
                        </div>
                    </div>
                </section>
            )
        },

        // The plan's waves as a top-down graph. Every card is the Tasks
        // tab's row in another shape: the same answer to whether it may
        // start, and the same hand-over when pressed.
        waves: {
            id: "waves",
            label: "Wave graph",
            title: "The plan's waves top down - which can be worked at the same time, and what each one waits for",
            render: () => (
                <WaveGraph
                    waves={waves}
                    units={units}
                    face={graphFace}
                    start={picked => {

                        startTasks(picked.map(handed));
                        setLaunched(picked[0]?.id);
                    }}
                    till={(wave, unit) => tillFace(wave, unit?.id)}
                    runTill={(wave, unit) => askTill(wave, unit?.id)} />
            )
        },

        // The run panel's Problems tab, whole - the same list, the
        // same count and the same colour on it. No `locate`: the run
        // panel points a row at a step because an issue names one,
        // and a spec issue names no step, so there is nothing here
        // for a row to point at.
        problems: problemsTab({
            problems: problems ?? [],
            emptyText: "The spec is valid."
        })
    };

    const tabs = [...tabIds.map(id => allTabs[id]), ...pluginTabs];

    /**
     * The question every "Run till here" press asks: what runs, chat by
     * chat, what does not start, and which optional tasks on the way to
     * take along. Read from the plan as it is now, so a box ticked while
     * it is open is already left out.
     */
    const tillPath = tillAsk ? tillOf(tillAsk.wave, tillAsk.only) : undefined;

    // The plan's order, which is the order the host is handed them in.
    const tillRun = tillPath
        ? units.filter(unit => tillPath.tasks.includes(unit) || (tillPicked.includes(unit.id) && tillPath.optional.includes(unit)))
        : [];

    // Cut the way the host cuts them: one lane per wave, a `Run:` task a step of its own.
    const tillSteps = wavesOf(tillRun.map(unit => ({ ...unit, wave: waveOf(unit.id, waves) })))
        .flatMap(wave => splitWave(wave));

    const tillChats = tillSteps.every(step => !(step.length === 1 && step[0].run));

    // Only when one task was pressed: the rest of its wave stays as it is.
    const tillLeft = tillAsk?.only === undefined
        ? []
        : units.filter(unit => waveOf(unit.id, waves) === tillAsk.wave && !isTaskDone(unit) && !tillRun.includes(unit) && !isWorking(unit.id) && !queuedTasks.includes(unit.id));

    const tillTarget = tillAsk?.only === undefined ? undefined : unitById.get(tillAsk.only);

    const tillWhy = tillAsk ? tillFace(tillAsk.wave, tillAsk.only).why : undefined;

    const tillDialog = (
        <Modal
            show={tillAsk !== undefined}
            centered
            ariaLabel="Run till here"
            className="sdd-ask sdd-till"
            onHide={() => setTillAsk(undefined)}>

            <Modal.Header>
                <Modal.Title>
                    {tillTarget
                        ? <>Run till {tillTarget.id} <TaskText text={tillTarget.text} /></>
                        : `Run till wave ${tillAsk?.wave}`}
                </Modal.Title>
            </Modal.Header>

            <Modal.Body>
                <p className="sdd-till__lead">
                    These run one after another. Each box is one {tillChats ? "chat" : "step"}.
                    Nothing after {tillTarget ? tillTarget.id : `wave ${tillAsk?.wave}`} starts.
                </p>

                {tillSteps.map((step, index) => {

                    const run = step.length === 1 && step[0].run;

                    const last = index === tillSteps.length - 1;

                    return (
                        <div key={step[0].id} className={`sdd-till__step${last ? " sdd-till__step--target" : ""}`}>
                            <span className="sdd-till__head">
                                <b>{run ? "Run step" : `Chat ${tillSteps.slice(0, index + 1).filter(one => !(one.length === 1 && one[0].run)).length}`}</b>
                                {step[0].wave !== undefined && ` · wave ${step[0].wave}`}
                                {last && tillTarget && " · only this task"}
                            </span>
                            {step.map(unit => (
                                <span key={unit.id} className="sdd-till__task">
                                    {unit.id} <TaskText text={unit.text} />
                                </span>
                            ))}
                            {last && tillLeft.length > 0 && (
                                <span className="sdd-till__left">
                                    Not started: {tillLeft.map(unit => unit.id).join(", ")}
                                </span>
                            )}
                        </div>
                    );
                })}

                {tillPath && tillPath.optional.length > 0 && (
                    <div className="sdd-till__optional" role="group" aria-label="Optional tasks on the way">
                        <span className="sdd-till__head"><b>Optional tasks on the way - run them too?</b></span>
                        {tillPath.optional.map(unit => (
                            <Checkbox
                                key={unit.id}
                                size="sm"
                                label={`${unit.id} ${unit.text.replace(/[`*_]/g, "")} · wave ${waveOf(unit.id, waves)}`}
                                checked={tillPicked.includes(unit.id)}
                                onChange={event => setTillPicked(previous => event.target.checked
                                    ? [...previous, unit.id]
                                    : previous.filter(id => id !== unit.id))} />
                        ))}
                    </div>
                )}

                {tillWhy && <p className="sdd-till__why">{tillWhy}</p>}
            </Modal.Body>

            <Modal.Footer>

                <Button
                    size="sm"
                    onClick={() => setTillAsk(undefined)}>
                    Cancel
                </Button>

                <Button
                    variant="primary"
                    size="sm"
                    autoFocus
                    disabled={tillWhy !== undefined || tillRun.length === 0}
                    onClick={() => {

                        startTasks(tillRun.map(handed));
                        setLaunched(tillRun[0]?.id);
                        setTillAsk(undefined);
                    }}>
                    Run {tillRun.length} task{tillRun.length === 1 ? "" : "s"}
                    {tillSteps.length > 1 && ` in ${tillSteps.length} ${tillChats ? "chats" : "steps"}`}
                </Button>
            </Modal.Footer>
        </Modal>
    );

    return {
        allTabs, tabs, tillPath, tillRun, tillSteps, tillChats, tillLeft, tillTarget,
        tillWhy, tillDialog
    } as const;
}

/** What usePhaseTabs gives the parts after it. */
export type PhaseTabs = ReturnType<typeof usePhaseTabs>;

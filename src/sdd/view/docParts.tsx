/*
 * Pieces the SDD run view's tabs are built from: the Markdown
 * renderers, the outline and notes rails, the phase rail's items and
 * card, the Start and Next button, the tool rows above the Doc and
 * Prompt tabs, and the task rows of a plan with their run buttons.
 *
 * Part of SddRunView - see runState.tsx for how the parts fit.
 */

import React, { useMemo, useRef, useState } from "react";
import { Components } from "react-markdown";
import { CopyButton, Button, Checkbox, CommentBox, UiIcon } from "../../view/ui";
import Markdown, { CodeFence } from "../../view/Markdown";
import { Mermaid, mermaidSource } from "../../view/Mermaid";
import { PhaseItem, PhaseState } from "../../view/PhaseSteps";
import { blockedBy } from "./openQuestionGate";
import { anchorFor, reviseInstruction } from "../../view/templates/reviewNotes";
import { isTaskDone, pendingUnder, reposOf, SpecTask, waveOf } from "./taskList";
import { fileName, NEXT_TITLE, highlightEars, labelOf, OutlineList, WaveBadge, TaskText, TYPE_SCALES, Icon, fileUri } from "./runViewHelpers";
import type { RunState } from "./runState";
import type { ImplementState } from "./implementState";
import type { DocEditing } from "./docEditing";

/**
 * The task ids on the Next button. A big first wave would stretch the
 * button across the panel, so only the first three are written out
 * and the rest are a count - "1, 2.1, 2.2 +17 more". The button's
 * tooltip still lists every task with its name.
 */
function idsOnButton(ids: string[]) {

    const shown = 3;

    return ids.length > shown
        ? `${ids.slice(0, shown).join(", ")} +${ids.length - shown} more`
        : ids.join(", ");
}

export function useDocParts(ctx: RunState & ImplementState & DocEditing) {

    const {
        specStages, documents, requestDocument, saveDocument, gate, decide, isRunning, startPhase,
        startTasks, runCommand, runningCommands, stopCommand, runWorkflow, workflows, queuedTasks, markDone, openFile, stopPhase,
        docDiff, stopAfterCurrent, setStopAfterCurrent, nextSessionIn, position, executionLens,
        docStage, artifact, busy, draftingStage, current, promptPath, pointPane, followNext, notesToChat,
        shownTab, editing, setEditing, diffing, setDiffing, typeStep, setTypeStep, typeScale, pinned,
        blockEdit, outlineOpen, setOutlineOpen, closedIn, toggleOutlineItem, notesOpen, setNotesOpen,
        composing, setComposing, notesBodyRef, closeComposer, cancelComposer, full, setFull, draft,
        dirty, promptEditing, setPromptEditing, promptDirty, meta, knownByArtifact, inlinePlan,
        outline, docSection, outlineBodyRef, anchored, orphans, openNotes, changedBlocks, planStage,
        planLabel, launched, setLaunched, chats, chatFor, isWorking, waves, implementing, yourTurn,
        doneIds, runningWave, waveRowOf, openWork, nextUp, nextStep, showChat, waitingStages,
        boundary, gateApproves, blockedWork, toggleTask, handed, tillFace, askTill, outOfOrder,
        blockProps, savePrompt, discardPrompt, promptOutline, promptSection, promptOutlineBodyRef,
        goToPromptLine, discardDraft, goToLine, addNote, noteContents, citation, legacyCitation,
        planRow, citingTasks, followTask
    } = ctx;

    /**
     * After a requirement or a criterion: the tasks that cite it - "Tasks
     * 1.2, 3.1" - or "No task" in the warning colour. Only the document
     * the plan cites has any.
     *
     * Each task id is its own button, which opens the plan at that
     * task's row. Pressed through the ref, so a press always uses this
     * render's plan, not the one the memoized document was drawn with.
     */
    const taskMark = (node: { position?: { start: { line: number } } } | undefined): React.ReactNode => {

        const tasks = node?.position ? citingTasks.get(node.position.start.line) : undefined;

        if (!tasks)
            return null;

        if (!tasks.length)
            return <span className="sdd-task-mark sdd-task-mark--none">No task</span>;

        return (
            <span className="sdd-task-mark">
                {tasks.length === 1 ? "Task" : "Tasks"}{" "}
                {tasks.map((id, index) => (
                    <React.Fragment key={id}>
                        {index > 0 && ", "}
                        <button
                            type="button"
                            className="sdd-task-mark__id"
                            title={`Open task ${id} in the plan`}
                            onClick={() => renderers.current.followTask(id)}>
                            {id}
                        </button>
                    </React.Fragment>
                ))}
            </span>
        );
    };

    const renderers = useRef({ blockProps, citation, legacyCitation, planRow, taskMark, followTask });

    renderers.current = { blockProps, citation, legacyCitation, planRow, taskMark, followTask };

    /**
     * Everything the renderers above read through the ref, as one
     * string: the memoized document re-renders when this changes and
     * at no other time. A row's ▶ turning into "…", a pin moving -
     * each is in here; a log line streaming past is not.
     *
     * What changed since the last run is not in here. The
     * reading view draws no mark for it, so none of these renderers
     * reads it - the diff view does, and it is its own component.
     */
    const renderRevision = [
        specStages.map(stage => `${stage.name}:${stage.exists ? 1 : 0}`).join(","),
        Object.entries(documents).map(([path, text]) => `${path}:${text?.length ?? -1}`).join(","),
        Object.keys(knownByArtifact).join(","),
        pinned,
        inlinePlan,
        workflows.join(","),
        busy,
        blockedWork,
        blockEdit?.start,
        launched,
        queuedTasks.join(","),
        (runningCommands ?? []).join("\n"),
        [...doneIds].join(","),
        chats.map(chat => `${chat.sessionId}:${chat.ended ? 1 : 0}`).join(","),
        [...citingTasks].map(([line, tasks]) => `${line}:${tasks.join(",")}`).join(";")
    ].join("|");

    /**
     * The renderers for a task's detail lines in the implement lens -
     * only the citation ones. The lines are a snippet cut out of the
     * plan, so their line numbers are the snippet's, not the file's:
     * the block marks and row controls below would land on the wrong
     * lines, and the details have no headings or checkbox rows anyway.
     */
    const detailComponents = useMemo<Components>(() => ({
        a: ({ children, href }) => renderers.current.citation(href, children),
        em: ({ children }) => renderers.current.legacyCitation(children, <em>{children}</em>),
        strong: ({ children }) => renderers.current.legacyCitation(children, <strong>{children}</strong>)
    }), []);

    const markdownComponents = useMemo<Components>(() => ({
        p: ({ children, node }) => <p {...renderers.current.blockProps(node)}>{highlightEars(children)}</p>,
        td: ({ children }) => <td>{highlightEars(children)}</td>,

        /* A table is numbered once, at its own first line. A number per
           row would have to live inside the table's box and would break the
           column alignment the table is drawn for - and nobody says "line 61"
           about a table row anyway, they say "the url row". */
        table: ({ children, node }) => <table {...renderers.current.blockProps(node)}>{children}</table>,
        blockquote: ({ children, node }) => <blockquote {...renderers.current.blockProps(node)}>{children}</blockquote>,

        /* Headings and list items carry the anchors a reference lands on -
           `### Requirement 2` and each of its numbered criteria. An element
           with no anchor on its line renders as plain markdown. A
           requirement heading (H2 to H4) and a criterion also end with
           the tasks that cite them. */
        h1: ({ children, node }) => <h1 {...renderers.current.blockProps(node)}>{children}</h1>,
        h2: ({ children, node }) => <h2 {...renderers.current.blockProps(node)}>{children}{renderers.current.taskMark(node)}</h2>,
        h3: ({ children, node }) => <h3 {...renderers.current.blockProps(node)}>{children}{renderers.current.taskMark(node)}</h3>,
        h4: ({ children, node }) => <h4 {...renderers.current.blockProps(node)}>{children}{renderers.current.taskMark(node)}</h4>,
        h5: ({ children, node }) => <h5 {...renderers.current.blockProps(node)}>{children}</h5>,
        h6: ({ children, node }) => <h6 {...renderers.current.blockProps(node)}>{children}</h6>,
        /* A plan's checkbox row carries its own controls - a live box and
           the ▶ that starts it - ahead of the text. The disabled box GFM
           drew is hidden by the class, not removed: the row's text still
           reads exactly as written. */
        li: ({ children, node, className }) => {

            const controls = renderers.current.planRow(node);

            const props: { className?: string } = renderers.current.blockProps(node);

            // GFM's own class on a checkbox row (`task-list-item`) is
            // what hides the bullet - kept, whatever else is added.
            const classes = [className, props.className, controls ? "sdd-inline__row" : undefined].filter(Boolean).join(" ");

            return (
                <li {...props} className={classes || undefined}>
                    {controls}
                    {highlightEars(children)}
                    {renderers.current.taskMark(node)}
                </li>
            );
        },

        /* A citation is a link to a `.md` file whose text is a name and some
           numbers. Every other link stays a link. */
        a: ({ children, href }) => renderers.current.citation(href, children),

        /* And the plain-text emphasis spelling - read so a spec somebody
           else made works untouched. Anything else emphasised stays
           emphasis; EARS highlighting still comes from the enclosing
           block, so nothing here re-wraps it. */
        em: ({ children }) => renderers.current.legacyCitation(children, <em>{children}</em>),
        strong: ({ children }) => renderers.current.legacyCitation(children, <strong>{children}</strong>),

        /* A ```mermaid fence is a diagram; any other fence is the UI
           library's CodeBlock. Both sit in a box that carries the block's
           line number, like every other block. */
        pre: ({ children, node }) => {

            const diagram = mermaidSource(children);

            return diagram === undefined
                ? <div {...renderers.current.blockProps(node)}><CodeFence>{children}</CodeFence></div>
                : <div {...renderers.current.blockProps(node)}><Mermaid code={diagram} /></div>;
        }
    }), []);


    /**
     * Whether a rail can be shown at all.
     *
     * Nothing to put a rail beside while the execution lens is on or
     * before the phase has written its document.
     */
    const railsAllowed = !executionLens && Boolean(docStage?.exists);

    /**
     * The outline, on the left.
     *
     * It is a map of the document and belongs beside its start, so it
     * takes the left edge and the notes take the right. Two panels
     * rather than one that moves: they are open independently, and
     * a panel that changed sides depending on what was in it would put
     * the outline somewhere new the moment the notes came out.
     */
    const outlineRail = outlineOpen && railsAllowed && (
            <aside
            className="sdd-rail sdd-rail--left"
            aria-label="Outline">

                {/* No head: no title, no tabs, no close button.

                    Outline and Notes each have a button in the bar
                    above, those buttons light up to say which is
                    showing, and pressing the lit one closes that rail.
                    A title would repeat what the lit button already says,
                    tabs would be the same switch twice, and a close
                    button would be a third way to do what the toggle does. */}

                <div className="sdd-rail__body" ref={outlineBodyRef}>

                    {outline.length === 0 && (
                        <div className="sdd-doc__empty">No headings in this document.</div>
                    )}

                    <OutlineList
                        items={outline}
                        here={docSection?.line}
                        closed={closedIn(artifact)}
                        onToggle={line => toggleOutlineItem(artifact, line)}
                        go={goToLine} />
                </div>
            </aside>
    );

    /**
     * The notes, on the right.
     *
     * A note belongs beside the text it is about, which is the right
     * margin - the same side the inline cards use, so a note is found
     * on the same edge whether the panel is wide enough to spell it out
     * or not.
     */
    const notesRail = notesOpen && railsAllowed && (
            <aside
            className="sdd-rail sdd-rail--right"
            aria-label="Review notes">

                <div className="sdd-rail__body" ref={notesBodyRef}>

                    {anchored.length === 0 && !composing && (
                        <div className="sdd-doc__empty">
                            No notes yet. The {"+"} beside any line leaves one.
                        </div>
                    )}

                    {[...anchored]
                        .sort((left, right) =>
                            Number(left.resolved) - Number(right.resolved)
                            || (left.at ?? Number.MAX_SAFE_INTEGER) - (right.at ?? Number.MAX_SAFE_INTEGER))
                        .map(note => (
                            <div
                                key={note.id}

                                // Where the margin mark scrolls to. The note's
                                // anchored position, not the line it was written
                                // against - the mark is drawn at the anchored one.
                                data-note-line={note.at}
                                className="sdd-note">

                                {noteContents(note)}
                            </div>
                        ))}

                    {/* The loop closing. Every open note, quoted against
                        the line it is about, put in the message box of
                        the phase's chat - which is the one thing a
                        markdown editor cannot do with a comment. The page
                        goes to that chat when another one is beside the
                        spec; nothing is sent until Send is pressed there,
                        so whoever clicks this still reads and can edit
                        the text.

                        Targets `docStage`, the document the notes are
                        actually anchored to (`openNotes` is already
                        scoped to it) - never some other phase, since
                        more than one can be current. */}
                    {docStage?.revisable && openNotes.length > 0 && (
                        <Button
                            variant="primary"
                            size="sm"
                            className="sdd-rail__send"
                            disabled={busy || !notesToChat}
                            title={"Put all " + openNotes.length + " open notes in the message box of this phase's chat as one message - you read it back there before it goes"}
                            onClick={() => notesToChat?.(docStage.name, reviseInstruction(openNotes, draft))}>
                            Send {openNotes.length} note{openNotes.length === 1 ? "" : "s"} to the chat
                        </Button>
                    )}

                    {orphans.length > 0 && (
                        <div className="sdd-rail__foot">
                            {orphans.length} note{orphans.length === 1 ? " is" : "s are"} orphaned -
                            the text they were written against is no longer in the document.
                        </div>
                    )}
                </div>

                {/*
                    The composer, under the list rather than in it.

                    It is not the first card in the rail's body, which would scroll: on a document with twenty notes you would press + and the field you meant to type into would be somewhere above the top of the panel. Pinned here it is
                    in the same place every time, and the list keeps its own
                    scroll behind it.
                */}
                {composing && (
                    <div className="sdd-rail__compose">

                        <div className="sdd-note sdd-note--new">

                            {/* The UI library's CommentBox, with the line it is
                                about quoted. Escape closes it and keeps the text
                                (see `noteDrafts`), and does not also drop the
                                pin; Cancel throws the text away. */}
                            <CommentBox
                                where={`Line ${composing.line}`}
                                quote={anchorFor(draft, composing.line) || undefined}
                                placeholder="What is wrong with this block?"
                                value={composing.text}
                                onChange={text => setComposing({ ...composing, text })}
                                onSubmit={() => addNote(composing.line, composing.text)}
                                onCancel={cancelComposer}
                                onEscape={closeComposer}
                                autoFocus />
                        </div>
                    </div>
                )}
            </aside>
    );

    /** What the rail draws for each phase - four renderings, on the run panel's discs. */
    const items: PhaseItem[] = specStages.filter(stage => !stage.hidden).map(stage => {

        const done = Boolean(stage.artifact && stage.exists);
        const active = stage.name === position?.name;
        const label = stage.label ?? stage.name;

        // Done, running (an agent is drafting this phase's document
        // right now - even a done one, mid-revise), active (the
        // position, idle or parked), pending.
        const state: PhaseState = stage.name === draftingStage
            ? "running"
            : done ? "done" : active ? "active" : "pending";

        return {
            id: stage.name,
            label,
            state,
            ...(waitingStages.has(stage.name) ? { waiting: true } : {}),
            title: stage.artifact ?? `${label} - execution phase`
        };
    });


    /**
     * What is wrong with the spec as a whole, above the tabs. Only a
     * definition that resolved no artifacts, so far - what the spec is
     * doing or asking sits beside the title instead.
     */
    const card = !specStages.some(stage => stage.artifact)
        ? (
            <div className="phase-card">
                <span className="phase-card__text sdd-plugin__why--blocked">
                    no artifacts resolved - the definition&apos;s stages declare no artifact:, or the spec&apos;s params could not resolve
                </span>
            </div>
        )
        : undefined;

    const currentLabel = current ? current.label ?? current.name : "";

    /** The file name - the last `parts` of its path - and the way to open the file once it is on disk. */
    const nameOf = (path: string, exists: boolean, parts = 1) => {

        const shown = path.split(/[\\/]/).slice(-parts).join("/");

        return (
            <span className="sdd-doc__name">
                {exists ? (
                    <button
                        className="sdd-doc__open"
                        title={`Open ${path}`}
                        onClick={() => openFile(path)}>
                        {shown}
                    </button>
                ) : shown}
            </span>
        );
    };

    /**
     * What happens next, beside the title - so it can be pressed from
     * any phase, without first opening the one it is about.
     *
     * One primary action at a time: the parked gate's, the next
     * phase's, or the execution phase's once every document is written
     * and tasks remain. While something runs, what is running and Stop.
     * Starting a phase needs no run, only the files.
     *
     * All three read "Next: <phase>". They are the same act from the
     * reader's side - move the spec on one step - and calling one of
     * them Start suggested a beginning rather than the next thing in a
     * sequence that is already under way.
     */
    const startAll = planStage && !position && openWork.length > 0;

    // One answer for both ways past a boundary - the parked gate's
    // Next and the file-derived one below it are the same act.
    const blockedNext = blockedBy(specStages, boundary, fileName);

    const primary = gate
        ? (
            <Button
                variant="primary"
                size="sm"
                disabled={blockedNext !== undefined}
                title={blockedNext
                    ?? (gateApproves ? `Starting ${labelOf(specStages, boundary)} approves ${gateApproves}` : undefined)}
                onClick={() => {

                    if (boundary)
                        followNext(boundary);

                    decide(true);
                }}>
                Next: {labelOf(specStages, boundary)}
            </Button>
        )
        : isRunning && yourTurn !== undefined
            ? (
                <>
                    <span className="sdd-view__doing">
                        {`Your turn: finish task ${yourTurn} yourself`}
                    </span>

                    {markDone && (
                        <Button
                            variant="primary"
                            size="sm"
                            title={`Tick task ${yourTurn}'s box - the next wave starts`}
                            onClick={() => markDone(yourTurn)}>
                            Mark {yourTurn} as Done
                        </Button>
                    )}
                </>
            )
        : isRunning
            ? (
                <>
                    <span className="sdd-view__doing">
                        {nextSessionIn !== undefined
                            ? `next session starts in ${nextSessionIn}s…`
                            : implementing
                                ? `implementing${runningWave !== undefined ? ` wave ${runningWave}` : ""}…`
                                : draftingStage ? `drafting ${labelOf(specStages, draftingStage)}…` : "working…"}
                    </span>

                    {/* Lets the session running now finish, and keeps the
                        queued ones from starting after it. Pressed again,
                        the sessions carry on. */}
                    {implementing && setStopAfterCurrent && (
                        <Button
                            size="sm"
                            variant={stopAfterCurrent ? "primary" : undefined}
                            title={stopAfterCurrent
                                ? "On - no new session starts after this one. Press to turn it off"
                                : "Let the current session finish, then start no more"}
                            onClick={() => setStopAfterCurrent(!stopAfterCurrent)}>
                            {stopAfterCurrent ? "✓ Stop after current session" : "Stop after current session"}
                        </Button>
                    )}

                    {/* The way out of a phase that hangs, drifts, or was
                        simply the wrong button. Only where the host
                        offers one - see SddViewProps.stopPhase. */}
                    {stopPhase && (
                        <Button
                            size="sm"
                            title={implementing
                                ? "Stop - no further wave starts; the chat already open stays yours to close"
                                : "Stop the drafting agent - the phase ends without its document"}
                            onClick={() => stopPhase()}>
                            Stop
                        </Button>
                    )}
                </>
            )
            : boundary
                ? (
                    <Button
                        variant="primary"
                        size="sm"
                        disabled={blockedNext !== undefined}
                        title={blockedNext
                            ?? (gateApproves
                                ? `Starting ${labelOf(specStages, boundary)} approves ${gateApproves}`
                                : undefined)}
                        onClick={() => {

                            followNext(boundary);
                            startPhase(boundary);
                        }}>
                        Next: {labelOf(specStages, boundary)}
                    </Button>
                )
                : startAll
                    ? (
                        <Button
                            variant="primary"
                            size="sm"
                            disabled={blockedWork !== undefined}
                            title={blockedWork
                                ?? (nextStep.length
                                    ? `Starts with ${nextStep.length === 1 ? "task" : `these ${nextStep.length} tasks, in one chat`}:\n`
                                        + nextStep.map(unit => `${unit.id} ${unit.text}`).join("\n")
                                        + `\n\nThen every open task after them ${NEXT_TITLE}`
                                    : `Work every open task ${NEXT_TITLE}`)}
                            onClick={() => {

                                if (planStage)
                                    followNext(planStage.name);

                                startTasks(openWork.map(handed));

                                setLaunched(nextUp?.id);
                            }}>
                            Next: {planLabel}{nextStep.length ? ` ${idsOnButton(nextStep.map(unit => unit.id))}` : ""}
                        </Button>
                    )
                    : null;

    /**
     * The file a tab is about, at the left of the panel's footer.
     *
     * It is not the first line of the document, where a long URI would take up to three lines above the text. In the footer it is the
     * file name only; the full location is in the tooltip, since the
     * two files this is drawn for - a spec document and the prompt that
     * writes it - are often called the same thing, and the location is
     * the only part that tells them apart. Clicking opens the real file. The copy
     * button after it puts the full path - the real one, not the URI -
     * on the clipboard.
     */
    const pathLine = (path: string) => {

        const uri = fileUri(path);
        const cut = uri.lastIndexOf("/") + 1;

        return (
            <div className="sdd-doc__file-row">
                <button
                    className="sdd-doc__file"
                    title={`${uri}\nOpen it`}
                    onClick={() => openFile(path)}>
                    <span className="sdd-doc__file-name">{uri.slice(cut)}</span>
                </button>
                <CopyButton text={path} label="Copy full path" className="sdd-doc__copy" />
            </div>
        );
    };

    /**
     * The header's right end: what the frontmatter says, then what
     * happens next.
     *
     * What is not here is View session - the conversation that drafted a document is not offered; what the phase said is
     * in its Logs tab, and the chats that implemented tasks are
     * reachable from their own rows - and the file name, which is in
     * the tab it is about (see `pathLine`).
     */
    const actions = (
        <>
            {/* What the frontmatter says, in the header rather than as a
                row of chips inside the document. */}
            {shownTab !== "prompt" && !executionLens && meta.length > 0 && (
                <span
                    className="sdd-doc__meta"
                    title={meta.map(([key, value]) => key + ": " + value).join("\n")}>
                    {(meta.find(([key]) => key === "type") ?? meta[0])[1]}
                </span>
            )}

            {primary}
        </>
    );

    /**
     * The outline's switch, at the far left of the footer - the column
     * it opens is on that side of the document. `what` is what the
     * headings are of: the document or the prompt.
     */
    const outlineToggle = (what: string) => (
        <Button
            fill="ghost"
            size="icon"
            className={"sdd-doc__toggle" + (outlineOpen ? " sdd-doc__toggle--on" : "")}
            aria-label="Outline"
            title={`Outline - the ${what}'s headings`}
            onClick={() => setOutlineOpen(open => !open)}>
            <Icon name="outline" />
        </Button>
    );

    /**
     * The document's own controls - the editor and the reading tools.
     *
     * In the footer's left part while the Doc tab is open, between the
     * outline's switch and the file name (see `docInfo`): they act on
     * what that tab is showing, and have no business being on screen
     * while the log is open. Full screen keeps the footer, so they stay
     * in the same place there too.
     */
    const docTools = artifact === undefined ? undefined : (
        <>
            {/* What the last run of this phase changed. Hidden when
                there is nothing to compare against - a first draft has
                no earlier version - and when nothing moved, because a
                button that opens "no change" is a button that wasted
                the press. Away while the editor is open: the comparison
                is about the document on disk, and away entirely when the
                `docDiff` flag is off. */}
            {docDiff && !editing && changedBlocks > 0 && (
                <Button
                    fill="ghost"
                    size="icon"
                    className={"sdd-doc__toggle" + (diffing ? " sdd-doc__toggle--on" : "")}
                    aria-label="What changed"
                    aria-pressed={diffing}
                    title={`What the last run of this phase changed - ${changedBlocks} block${changedBlocks === 1 ? "" : "s"}`}
                    onClick={() => setDiffing(open => !open)}>
                    <Icon name="diff" />
                </Button>
            )}

            {dirty && <span className="sdd-doc__dirty" title="Unsaved changes"><UiIcon name="dot" size="xs" /></span>}

            {/* Edit is the way in. It is not a toggle: once the editor
                is open, Cancel and Save are the two ways back out, and
                an Edit button beside them would be offering something
                already being done. */}
            {!editing && !dirty && (
                <Button
                    fill="ghost"
                    size="icon"
                    aria-label="Edit"
                    title="Edit the whole document as text - Ctrl+S saves, Ctrl+Enter saves and closes, Esc leaves"
                    onClick={() => setEditing(true)}>
                    <Icon name="edit" />
                </Button>
            )}

            {/* The pair, shown whenever there is something to keep or
                throw away - typed into the editor, or edited into a
                single block in place. Same two actions either way,
                because it is the same draft. */}
            {(editing || dirty) && (
                <>
                    <Button
                        fill="ghost"
                        size="icon"
                        aria-label={editing ? "Cancel" : "Discard changes"}
                        title={dirty
                            ? "Throw away every unsaved change to this document"
                            : "Close the editor"}
                        onClick={discardDraft}>
                        <Icon name="cancel" />
                    </Button>

                    <Button
                        variant="primary"
                        fill="solid"
                        size="icon"
                        disabled={!dirty}
                        aria-label="Save"
                        title={dirty ? "Write the document to disk - Ctrl+S" : "No unsaved changes"}
                        onClick={() => {

                            saveDocument(artifact, draft);

                            // Saving finishes the edit. The document is
                            // on disk, and the rendering is what a
                            // reviewer wants back.
                            setEditing(false);
                        }}>
                        <Icon name="save" />
                    </Button>
                </>
            )}

            {/* The reading tools. Icons rather than words: these are
                things you reach for while reading rather than things
                you decide to do. Away while the editor is open - there
                is nothing to read at a size or leave a note on. */}
            {!editing && (
                <>
                    <Button
                        fill="ghost"
                        size="icon"
                        className="sdd-doc__toggle"
                        disabled={typeStep === 0}
                        aria-label="Smaller text"
                        title="Read the document smaller"
                        onClick={() => setTypeStep(step => Math.max(0, step - 1))}>
                        <span className="sdd-doc__type-a sdd-doc__type-a--small" aria-hidden="true">A</span>
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className={"sdd-doc__toggle" + (typeScale !== 1 ? " sdd-doc__toggle--on" : "")}
                        aria-label={typeScale === 1 ? "Text size" : "Reset text size"}
                        title={typeScale === 1
                            ? "The default size"
                            : "Back to the default size"}
                        onClick={() => setTypeStep(TYPE_SCALES.indexOf(1))}>
                        <span className="sdd-doc__count">{Math.round(typeScale * 100)}%</span>
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className="sdd-doc__toggle"
                        disabled={typeStep === TYPE_SCALES.length - 1}
                        aria-label="Bigger text"
                        title="Read the document bigger"
                        onClick={() => setTypeStep(step => Math.min(TYPE_SCALES.length - 1, step + 1))}>
                        <span className="sdd-doc__type-a sdd-doc__type-a--big" aria-hidden="true">A</span>
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className={"sdd-doc__toggle" + (notesOpen ? " sdd-doc__toggle--on" : "")}
                        aria-label={openNotes.length
                            ? "Review notes - " + openNotes.length + " open"
                            : "Review notes"}
                        title={openNotes.length
                            ? openNotes.length + " open review note" + (openNotes.length === 1 ? "" : "s")
                            : "Review notes - leave one on any block"}
                        onClick={() => setNotesOpen(open => !open)}>
                        <Icon name="notes" />
                        {openNotes.length > 0 && (

                            /* A badge on the icon's corner, not a number
                               beside it: beside it the number widened the
                               button and read as a word next to a picture.
                               Past nine it says "9+" - three digits in a
                               small circle is a smudge, and the exact
                               number is in the title and the label. */
                            <span className="sdd-doc__badge" aria-hidden="true">
                                {openNotes.length > 9 ? "9+" : openNotes.length}
                            </span>
                        )}
                    </Button>

                    {/* Read the file again. The panel is not the only thing
                        that writes these documents, and nothing on disk
                        tells the page it changed. Off while a draft is
                        unsaved: the body renders the draft, so re-reading
                        would change nothing on screen and look broken. */}
                    <Button
                        fill="ghost"
                        size="icon"
                        className="sdd-doc__toggle"
                        disabled={dirty}
                        aria-label="Reload"
                        title={dirty
                            ? "Save or discard your changes first - a reload would not show them"
                            : "Read the document from disk again"}
                        onClick={() => requestDocument(artifact)}>
                        <Icon name="reload" />
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className={"sdd-doc__toggle" + (full ? " sdd-doc__toggle--on" : "")}
                        aria-label={full ? "Leave full screen" : "Full screen"}
                        title={full
                            ? "Back to the panel - Escape does it too"
                            : "The document takes the whole panel - the header stands down"}
                        onClick={() => setFull(!full)}>
                        <Icon name={full ? "exit" : "full"} />
                    </Button>
                </>
            )}
        </>
    );

    /**
     * The left part of the footer for a file tab: the outline's switch,
     * the tab's own controls, then the file name. The right part is
     * left to the panel's own button.
     */
    const docInfo = (what: string, tools: React.ReactNode, path: string) => (
        <>
            {outlineToggle(what)}
            <div className="sdd-doc__footer-tools">{tools}</div>
            {pathLine(path)}
        </>
    );

    /**
     * The prompt's own controls - the document's set, minus the review
     * layer.
     *
     * Same buttons, same order, same icons as `docTools`, so moving
     * between the two tabs does not move the reader's hand. What is not
     * here is Notes: a note is written to be handed back to the phase
     * that produced the document, and nothing rewrites a prompt.
     */
    const promptTools = promptPath === undefined ? undefined : (
        <>
            {promptDirty && <span className="sdd-doc__dirty" title="Unsaved changes"><UiIcon name="dot" size="xs" /></span>}

            {!promptEditing && !promptDirty && (
                <Button
                    fill="ghost"
                    size="icon"
                    aria-label="Edit"
                    title="Edit the prompt as text - it belongs to the style, so this changes it for every spec that follows it"
                    onClick={() => setPromptEditing(true)}>
                    <Icon name="edit" />
                </Button>
            )}

            {(promptEditing || promptDirty) && (
                <>
                    <Button
                        fill="ghost"
                        size="icon"
                        aria-label={promptEditing ? "Cancel" : "Discard changes"}
                        title={promptDirty
                            ? "Throw away every unsaved change to this prompt"
                            : "Close the editor"}
                        onClick={discardPrompt}>
                        <Icon name="cancel" />
                    </Button>

                    <Button
                        variant="primary"
                        fill="solid"
                        size="icon"
                        disabled={!promptDirty}
                        aria-label="Save"
                        title={promptDirty ? "Write the prompt to disk - Ctrl+S" : "No unsaved changes"}
                        onClick={() => savePrompt(true)}>
                        <Icon name="save" />
                    </Button>
                </>
            )}

            {!promptEditing && (
                <>
                    <Button
                        fill="ghost"
                        size="icon"
                        className="sdd-doc__toggle"
                        disabled={typeStep === 0}
                        aria-label="Smaller text"
                        title="Read the prompt smaller"
                        onClick={() => setTypeStep(step => Math.max(0, step - 1))}>
                        <span className="sdd-doc__type-a sdd-doc__type-a--small" aria-hidden="true">A</span>
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className={"sdd-doc__toggle" + (typeScale !== 1 ? " sdd-doc__toggle--on" : "")}
                        aria-label={typeScale === 1 ? "Text size" : "Reset text size"}
                        title={typeScale === 1
                            ? "The default size"
                            : "Back to the default size"}
                        onClick={() => setTypeStep(TYPE_SCALES.indexOf(1))}>
                        <span className="sdd-doc__count">{Math.round(typeScale * 100)}%</span>
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className="sdd-doc__toggle"
                        disabled={typeStep === TYPE_SCALES.length - 1}
                        aria-label="Bigger text"
                        title="Read the prompt bigger"
                        onClick={() => setTypeStep(step => Math.min(TYPE_SCALES.length - 1, step + 1))}>
                        <span className="sdd-doc__type-a sdd-doc__type-a--big" aria-hidden="true">A</span>
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className="sdd-doc__toggle"
                        disabled={promptDirty}
                        aria-label="Reload"
                        title={promptDirty
                            ? "Save or discard your changes first - a reload would not show them"
                            : "Read the prompt from disk again"}
                        onClick={() => requestDocument(promptPath)}>
                        <Icon name="reload" />
                    </Button>

                    <Button
                        fill="ghost"
                        size="icon"
                        className={"sdd-doc__toggle" + (full ? " sdd-doc__toggle--on" : "")}
                        aria-label={full ? "Leave full screen" : "Full screen"}
                        title={full
                            ? "Back to the panel - Escape does it too"
                            : "The prompt takes the whole panel - the header stands down"}
                        onClick={() => setFull(!full)}>
                        <Icon name={full ? "exit" : "full"} />
                    </Button>
                </>
            )}
        </>
    );

    /**
     * The prompt's outline, on the left - the document's rail, for the
     * other file this panel can edit.
     *
     * Its own rather than `outlineRail`: that one is built from the
     * document's headings and scrolls by the document's block marks,
     * neither of which exists here.
     */
    const promptOutlineRail = outlineOpen && promptPath !== undefined && !promptEditing && (
        <aside
            className="sdd-rail sdd-rail--left"
            aria-label="Outline">

            <div className="sdd-rail__body" ref={promptOutlineBodyRef}>

                {promptOutline.length === 0 && (
                    <div className="sdd-doc__empty">No headings in this prompt.</div>
                )}

                <OutlineList
                    items={promptOutline}
                    here={promptSection?.line}
                    closed={closedIn(promptPath)}
                    onToggle={line => toggleOutlineItem(promptPath, line)}
                    go={goToPromptLine} />
            </div>
        </aside>
    );

    /**
     * The rows opened to read the whole task - the detail lines under
     * the title - keyed by line. A row shows its title only; the plan's
     * `Files:`, citations and any paragraph are one click away rather
     * than always on screen, which would make the list a document.
     */
    const [openTasks, setOpenTasks] = useState<Set<number>>(new Set());

    const toggleOpen = (line: number) =>
        setOpenTasks(current => {

            const next = new Set(current);

            if (next.has(line))
                next.delete(line);
            else
                next.add(line);

            return next;
        });

    /** The chevron in front of a row that has something under it; an empty slot otherwise, so titles line up. */
    const detailsToggle = (task: SpecTask) => task.details.length
        ? (
            <Button
                fill="ghost"
                size="icon"
                className="sdd-task__open"
                title={openTasks.has(task.line) ? "Hide the task's details" : "Show the whole task - its files, citations and notes"}
                aria-expanded={openTasks.has(task.line)}
                onClick={() => toggleOpen(task.line)}>
                <UiIcon name={openTasks.has(task.line) ? "expand" : "chevron-right"} />
            </Button>
        )
        : <span className="sdd-task__open sdd-task__open--none" />;

    /**
     * The detail lines under a row, as the markdown they are. A
     * citation in them is the same hover-and-click control the Doc tab
     * draws, and it re-renders when a cited document arrives - which is
     * what `revision` carries - so the card has the words to show.
     */
    const taskDetails = (task: SpecTask) => (
        <div className="sdd-task__details">
            <Markdown components={detailComponents} revision={renderRevision}>{task.details.join("\n")}</Markdown>
        </div>
    );

    /**
     * A `Run:` row's one control, the same the Doc tab draws: nothing
     * but the box for a task done by hand, the terminal button for a
     * command, ▶ for a workflow - and never the agent's ▶, since such a
     * row is not an agent's.
     */
    const runControl = (unit: SpecTask) => {

        const run = unit.run!;

        const done = isTaskDone(unit);

        if (run.kind === "manual")
            return <span className="sdd-task__play sdd-task__play--hand" title="Done by hand - tick the box when it is"><UiIcon name="by-hand" /></span>;

        // Why this row may not start yet - the plan's order.
        const early = done ? undefined : outOfOrder([unit.id]);

        // Running now, and the host can stop it: the button is Stop.
        if (run.kind === "command" && stopCommand && runningCommands?.includes(run.command))
            return (
                <Button
                    fill="ghost"
                    size="icon"
                    className="sdd-task__play sdd-task__play--terminal"
                    title={`Stop: ${run.command}`}
                    onClick={() => stopCommand(run.command)}>
                    <UiIcon name="stop" />
                </Button>
            );

        if (run.kind === "command")
            return (
                <Button
                    fill="ghost"
                    size="icon"
                    className={`sdd-task__play sdd-task__play--terminal${done ? " sdd-task__play--done text-success" : ""}`}
                    disabled={done || early !== undefined}
                    title={done ? "Done - the checkbox in tasks.md is ticked" : early ?? `Run: ${run.command}`}
                    onClick={() => runCommand(run.command)}>
                    <UiIcon name={done ? "check" : "terminal"} />
                </Button>
            );

        const known = workflows.includes(run.name);

        return (
            <Button
                fill="ghost"
                size="icon"
                className={`sdd-task__play${done ? " sdd-task__play--done text-success" : ""}${known ? "" : " sdd-task__play--unknown text-error"}`}
                disabled={done || !known || early !== undefined}
                title={done
                    ? "Done - the checkbox in tasks.md is ticked"
                    : known
                    ? early ?? `Run the workflow '${run.name}' - tick the box when it is green`
                    : `No workflow named '${run.name}' under .eesha/workflows`}
                onClick={() => runWorkflow(run.name, {
                    task: unit.id,
                    taskTitle: unit.text,
                    ...(unit.group !== undefined ? { group: unit.group } : {}),
                    files: unit.files,
                    repos: reposOf(unit.files),
                    ...run.args
                })}>
                <UiIcon name={done ? "check" : known ? "run" : "help"} />
            </Button>
        );
    };

    /**
     * The row's own box, live: the same tick the Doc tab's box writes,
     * so a task done by hand - or by an agent that stopped before
     * ticking - is ticked here without leaving the lens. Reads the
     * row's own mark, not `isTaskDone`: a group's box is its own line
     * in the plan, whatever sits under it.
     */
    const taskBox = (task: SpecTask) => (
        <Checkbox
            className="sdd-task__box"
            checked={task.done}
            disabled={blockEdit !== undefined}
            title={task.done ? "Ticked in tasks.md - click to untick" : "Click to tick this box in tasks.md"}
            onChange={() => toggleTask(task.line)}
        />
    );

    /**
     * A group's row: a heading, not work of its own. Its ▶ starts the
     * work under it - every open agent task, any depth - and shows the
     * done mark once everything under it is ticked.
     */
    const groupRow = (task: SpecTask, depth: number) => (
        <div
            key={task.line}
            className={`sdd-task__row${openTasks.has(task.line) ? " sdd-task__row--open" : ""}`}
            style={depth ? { paddingLeft: `calc(${depth} * (var(--control-height) + var(--spacing-sm)))` } : undefined}>

            {detailsToggle(task)}

            {taskBox(task)}

            {/* The group's ▶: every agent task still open under it, at
                any depth, handed over in one press. The host splits them
                by wave and opens one chat per wave, later waves waiting
                on earlier ones - the same thing "Next: Implementation"
                does for the whole plan, limited to this group. */}
            {(() => {

                const under = pendingUnder(task);

                const fresh = under.filter(leaf => !isWorking(leaf.id) && !queuedTasks.includes(leaf.id));

                const done = isTaskDone(task);

                // Every open task under it is already in a chat or
                // waiting its turn: the group is as busy as its rows.
                const held = !done && under.length > 0 && fresh.length === 0;

                const early = fresh.length ? outOfOrder(fresh.map(leaf => leaf.id)) : undefined;

                return (
                    <Button
                        fill="ghost"
                        size="icon"
                        className={`sdd-task__play${done ? " sdd-task__play--done text-success" : ""}${held ? " sdd-task__play--working text-info" : ""}`}
                        disabled={done || fresh.length === 0 || busy || blockedWork !== undefined || early !== undefined}
                        title={done
                            ? "Done - everything under it is ticked"
                            : under.length === 0
                            ? "Nothing open under this group - only its own box is left to tick"
                            : held
                            ? "Every open task under this group is already in a chat or waiting its turn"
                            : blockedWork
                            ?? early
                            ?? `Start every open task under this group (${fresh.length}) - ${NEXT_TITLE}`}
                        onClick={() => {

                            startTasks(fresh.map(handed));
                            setLaunched(fresh[0]?.id);
                        }}>
                        <UiIcon name={done ? "check" : held ? "more" : "run"} />
                    </Button>
                );
            })()}

            <span className={`sdd-task__text sdd-task__group${isTaskDone(task) ? " sdd-task__text--done" : ""}`}>
                {task.id && `${task.id}. `}<TaskText text={task.text} />
            </span>

            {openTasks.has(task.line) && taskDetails(task)}
        </div>
    );

    /**
     * A task and everything under it, as rows: a group's heading then
     * its children one level deeper, a unit as its own row. Any depth -
     * the rule is what a row has under it, never how deep it sits.
     */
    const taskTree = (task: SpecTask, depth: number): React.ReactNode => task.subtasks.length
        ? (
            <React.Fragment key={task.line}>
                {groupRow(task, depth)}
                {task.subtasks.map(child => taskTree(child, depth + 1))}
            </React.Fragment>
        )
        : unitRow(task, depth);

    /**
     * One unit of work as a row: ▶, the text, its markers, its chat.
     *
     * The same row for a sub-task and for a task with none - the two
     * are the same thing to the agent, the graph and the count, so they
     * are the same thing here. `indented` is the only difference: a
     * sub-task sits under its group's heading.
     */
    const unitRow = (unit: SpecTask, depth: number) => (
        <div
            key={unit.line}
            data-task-id={unit.id}
            className={`sdd-task__row${openTasks.has(unit.line) ? " sdd-task__row--open" : ""}`}
            style={depth ? { paddingLeft: `calc(${depth} * (var(--control-height) + var(--spacing-sm)))` } : undefined}>

            {detailsToggle(unit)}

            {taskBox(unit)}

            {unit.run
                ? runControl(unit)
                : (() => {

                    // The same four faces the plan page's row shows, so
                    // a task reads the same wherever it is looked at.
                    const done = isTaskDone(unit);

                    const working = !done && isWorking(unit.id);

                    const queued = !done && !working && queuedTasks.includes(unit.id);

                    const early = done ? undefined : outOfOrder([unit.id]);

                    return (
                        <Button
                            fill="ghost"
                            size="icon"
                            className={`sdd-task__play${done ? " sdd-task__play--done text-success" : ""}${working || queued ? " sdd-task__play--working text-info" : ""}`}
                            disabled={done || working || queued || busy || blockedWork !== undefined || early !== undefined}
                            title={done
                                ? "Done - the checkbox in tasks.md is ticked"
                                : working
                                ? "An agent is working this task - it completes when the checkbox ticks"
                                : queued
                                ? "Waiting - queued behind the wave being worked; this starts when every task before it is ticked"
                                : blockedWork
                                ?? early
                                ?? "Start an agent chat for exactly this task - ticking its checkbox is its definition of done"}
                            onClick={() => {

                                startTasks([handed(unit)]);
                                setLaunched(unit.id);
                            }}>
                            <UiIcon name={done ? "check" : working ? "more" : queued ? "hourglass" : "run"} />
                        </Button>
                    );
                })()}

            <span className={`sdd-task__text${isTaskDone(unit) ? " sdd-task__text--done" : ""}`}>
                {unit.id && `${unit.id} `}<TaskText text={unit.text} />
            </span>

            {unit.optional && (
                <span className="sdd-task__optional" title="Optional - can be skipped for a faster first cut">
                    optional
                </span>
            )}

            <WaveBadge row={waveRowOf(unit.id)} />

            {/* "Run till here", only on a row that waits: a row that can
                start now already has its ▶, and that is the same thing. */}
            {(() => {

                const wave = waveOf(unit.id, waves);

                if (wave === undefined
                    || unit.run?.kind === "manual"
                    || isTaskDone(unit)
                    || isWorking(unit.id)
                    || queuedTasks.includes(unit.id)
                    || outOfOrder([unit.id]) === undefined)
                    return null;

                const path = tillFace(wave, unit.id);

                return (
                    <button
                        type="button"
                        className="sdd-task__till"
                        disabled={path.why !== undefined}
                        title={path.why ?? `Run what ${unit.id} waits for, then only ${unit.id}, then stop (${path.count} tasks)`}
                        onClick={() => askTill(wave, unit.id)}>
                        <UiIcon name="skip-next" />
                        Run till here{path.why === undefined ? ` · ${path.count}` : ""}
                    </button>
                );
            })()}

            {/* This row's own chat. Opens the conversation for this task
                specifically - including a finished one, which is where
                the argument about how it was done still lives. The page
                goes to that chat, with the spec beside it. */}
            {chatFor(unit.id) && (
                <button
                    className="sdd-task__session"
                    title={`Open the chat that worked task ${unit.id}`}
                    onClick={() => showChat(chatFor(unit.id)!)}>
                    session
                </button>
            )}

            {/* A chat is *working* this row: either the click this panel
                just saw, or one still on record and not yet reported
                idle. The second outlives a reload - and the `ended` half
                is what stops a row saying "in chat…" forever after the
                agent stopped without ticking the box. */}
            {openTasks.has(unit.line) && taskDetails(unit)}

            {isWorking(unit.id) && !isTaskDone(unit) && (
                <span className="sdd-task__pending" title="An agent is working this task - it completes when the checkbox ticks">
                    in chat…
                </span>
            )}
        </div>
    );

    return {
        renderers, renderRevision, detailComponents, markdownComponents, railsAllowed, outlineRail,
        notesRail, items, card, currentLabel, nameOf, startAll, blockedNext, primary, pathLine,
        actions, outlineToggle, docTools, docInfo, promptTools, promptOutlineRail, openTasks,
        setOpenTasks, toggleOpen, detailsToggle, taskDetails, runControl, taskBox, groupRow,
        taskTree, unitRow
    } as const;
}

/** What useDocParts gives the parts after it. */
export type DocParts = ReturnType<typeof useDocParts>;

/*
 * What the SDD run view keeps for the phase on screen: the props it was
 * given, the phase picked in the rail, the open tab, the Doc tab's edit
 * and diff modes, the outline, the review notes and their drafts, the
 * prompt editor, and the links between the spec's documents.
 *
 * Part of SddRunView. SddRunView.tsx calls the use... function of each
 * part one after another, always in the same order, so React sees the
 * same hooks in the same order on every render. Each part hands
 * everything it made to the parts after it.
 */

import { useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RunStatus } from "../../core/models/run";
import { SpecStage, StageAi } from "../../shared/runMessages";
import { changedCount, diffBlocks } from "../../view/diff/blockDiff";
import { pluginAppTabs } from "../../view/templates/PluginAppTab";
import { splitFrontmatter } from "./docBody";
import { chainAt, outlineOf, sectionAt, withRows } from "./outline";
import { useScrolledLine } from "./scrolledLine";
import { anchorNotes, notesByLine, reviseInstruction } from "../../view/templates/reviewNotes";
import { RunPick, stageOf } from "./sessionRuns";
import { onSddFocus } from "./host";
import { RequirementPreview, anchorId, anchorsByLine, parseRefLink, requirementAnchors, requirementPreviews, resolveRef } from "./specRefs";
import { parseTasks, parseWaves, SpecTask } from "./taskList";
import { OUTLINE_TASK_LEVELS, NOTHING_CLOSED, positionOf, beforeGate, underReview, FLASH, FLASH_MS, NOTE_FLASH, lensDocOf, keepHereInView, Mark, sameMarks, TYPE_SCALES } from "./runViewHelpers";
import { SddViewProps } from "../../view/templates/TemplateRunView";

export function useRunState(props: SddViewProps) {

    const { specStages, documents, requestDocument, saveDocument, gate, decide, isRunning, title, startPhase, startTasks, runCommand, runWorkflow, workflows, queuedTasks, waitingTasks, markDone, openSession, taskSessions, openFile, logsByTask, taskStatuses, stopPhase, sessionCost, docDiff, stopAfterCurrent, setStopAfterCurrent, nextSessionAt, runningCommands, stopCommand } = props;

    /** Seconds left before the next implementation session starts, during the wait between two. */
    const [nextSessionIn, setNextSessionIn] = useState<number | undefined>();

    useEffect(() => {

        if (nextSessionAt === undefined)
            return setNextSessionIn(undefined);

        const tick = () => setNextSessionIn(Math.max(0, Math.ceil((nextSessionAt - Date.now()) / 1000)));

        tick();

        const timer = setInterval(tick, 250);

        return () => clearInterval(timer);
    }, [nextSessionAt]);

    const {
        notes, saveNotes, baselines, requestBaseline, problems, notesToChat
    } = props;

    const { pluginApps, pluginSandboxed, pluginBridge } = props;

    const { sessionRuns, sessionLines, requestSessionLines, widths, saveWidths } = props;

    const position = positionOf(specStages);

    /** Which chip's document is on screen - selection, not a state. */
    const [selectedName, setSelectedName] = useState<string | undefined>(undefined);

    const chosen = specStages.find(stage => stage.name === selectedName);

    // An execution stage has no document of its own; its lens reads the
    // last existing document before it (implement reads tasks.md).
    const executionLens = chosen && !chosen.artifact
        ? lensDocOf(specStages, chosen.name)
        : undefined;

    /**
     * The phase on screen: whatever was picked, always. A phase with no
     * document still has its log and its prompt.
     *
     * The fallback chain is only for before anyone has picked: the
     * document at a parked gate (advancing approves it), then the
     * position, then anything that exists.
     */
    const landed = chosen
        ?? (gate ? underReview(specStages) : undefined)
        ?? specStages.find(stage => stage.name === position?.name)
        ?? underReview(specStages);

    // A hidden gate is nobody's phase: what it runs is started from the
    // actionable stage before it, and that is where its lines show.
    const selected = landed?.hidden ? beforeGate(specStages, landed.name) ?? landed : landed;

    // The first phase shown is kept as if it had been picked. Without
    // this the fallback above keeps working out the phase again, so a
    // document landing would move the screen on to the next phase by itself.
    // The panel never changes phase on its own - only the reader does.
    useEffect(() => {

        if (selectedName === undefined && selected)
            setSelectedName(selected.name);

    }, [selectedName, selected?.name]);

    /** The stage whose artifact is on screen - the selection itself, or the execution lens's source. */
    const docStage = executionLens ?? selected;

    const artifact = docStage?.artifact;
    const content = artifact ? documents[artifact] : undefined;

    /**
     * Actually working. A run parked at a gate is still `running` but
     * nothing is drafting, so chips must not pulse and the compose
     * box's fresh-start fallback must not hide.
     */
    const busy = isRunning && !gate;

    /**
     * The stage whose task is executing now, read from the task ids
     * (`stage/job/index`), not from the position: a revise reworks a
     * phase whose document exists, so the position would be wrong.
     */
    const draftingStage = busy
        ? Object.entries(taskStatuses)
            .find(([, status]) => status === RunStatus.Running)?.[0]
            .split("/")[0]
        : undefined;

    /** The phase whose tabs are on the right - the selection, whichever kind of phase it is. */
    const current = selected;

    /** The fixed instruction the current phase runs on, when the style names one. */
    const promptPath = current?.prompt;

    /** Its text, once the host has answered - `""` for a file that is not there. */
    const promptText = promptPath ? documents[promptPath] : undefined;

    /**
     * The open tab: the one a phase opened on, until the reader picks
     * another. Set when the phase is opened - see the effect on
     * `current` - and never changed by the panel after that.
     */
    const [tab, setTab] = useState<string | undefined>(undefined);

    /** A tab asked for while the phase is changing - see `pointPane`. */
    const nextTab = useRef<string | undefined>(undefined);

    /**
     * What the sessions pane shows, as last picked or followed. Without
     * an iteration it follows that owner's newest run, so a phase run
     * again moves the pane on to the new run. See `paneRun`.
     */
    const [panePick, setPanePick] = useState<RunPick | undefined>(undefined);

    /**
     * The phase on the left that a run belongs to. A hidden gate's run
     * belongs to the phase before it - the gate is never selected.
     */
    const paneStageOf = (ownerId: string): string => {

        const name = stageOf(ownerId);

        const stage = specStages.find(one => one.name === name);

        return stage?.hidden ? beforeGate(specStages, name)?.name ?? name : name;
    };

    /**
     * Points the sessions pane at a run, and the left side at its phase.
     *
     * The two always match: the pane only ever shows the selected
     * phase's sessions (see `paneRun`), so moving it to another phase's
     * session means selecting that phase too.
     */
    const pointPane = (pick: RunPick) => {

        setPanePick(pick);
        setSelectedName(paneStageOf(pick.ownerId));
    };

    /**
     * Moves the view to the phase a Next button is starting, so the
     * chat that starts is the one on screen. Pressing Next is the
     * reader's own act, so this does not break "the panel never changes
     * phase on its own". The conversation itself is the phase chat,
     * which the page goes to once the phase starts in it.
     */
    const followNext = (stageName: string) => {

        setPanePick(undefined);
        setSelectedName(paneStageOf(stageName));
    };

    // The page points the view at a phase, or at one session of
    // it. Through a ref, so the one listener always reads this draw's
    // stages.
    const focusRef = useRef<(focus: { phase?: string; ownerId?: string; iteration?: number }) => void>(() => undefined);

    focusRef.current = focus => {

        if (focus.ownerId)
            pointPane(focus.iteration !== undefined ? { ownerId: focus.ownerId, iteration: focus.iteration } : { ownerId: focus.ownerId });
        else if (focus.phase)
            setSelectedName(focus.phase);
    };

    useEffect(() => onSddFocus(focus => focusRef.current(focus)), []);

    /** Whether the plan on screen has a dependency graph - what the Wave graph tab needs to draw anything. */
    const lensHasWaves = useMemo(
        () => executionLens !== undefined && parseWaves(content).length > 0,
        [executionLens, content]);

    /**
     * Which tabs this phase gets, in screen order. A document phase
     * edits and reviews; an execution phase has tasks; a document not
     * yet written has only its log and prompt. The conversation is not
     * a tab: it is the phase chat, a normal session beside the spec.
     */
    const tabIds = [
        ...(executionLens ? ["tasks"] : []),
        ...(!executionLens && docStage?.exists ? ["doc"] : []),
        "logs",
        ...(promptPath ? ["prompt"] : []),

        // The execution phase only, beside its prompt, and only when the
        // plan has a graph to draw.
        ...(lensHasWaves ? ["waves"] : []),

        // Last, and only when somebody is validating this spec. It is
        // about the whole spec, so it does not change with the phase.
        ...(problems ? ["problems"] : [])
    ];

    /*
     * After the phase's own tabs, whatever the phase: every plugin that
     * ships an app. Each page is told the spec as this panel knows it.
     */
    const pluginTabs = pluginAppTabs({
        apps: pluginApps,
        on: "spec",
        sandboxed: pluginSandboxed,
        bridge: pluginBridge,
        state: {
            surface: "spec",
            running: isRunning,
            spec: title,
            stages: specStages.map(stage => ({
                name: stage.name,
                label: stage.label,
                artifact: stage.artifact,
                exists: stage.exists,
                sessionId: stage.sessionId,
                openQuestions: stage.openQuestions?.length ?? 0
            })),
            taskStatuses: Object.fromEntries(
                Object.entries(taskStatuses).map(([id, status]) => [id, RunStatus[status]])),
            gate: gate ? { taskId: gate.taskId, name: gate.name, stage: gate.stage } : undefined
        }
    });

    /**
     * The tab a phase opens on: tasks for a plan, the document for a
     * written phase, and for a phase still to be written what it will be
     * told (its prompt), or its log.
     */
    const firstTab = executionLens ? "tasks"
        : docStage?.exists ? "doc"
            : promptPath ? "prompt" : "logs";

    /** The tab actually open: the pick, when this phase offers it; otherwise {@link firstTab}. */
    const shownTab = tab !== undefined && (tabIds.includes(tab) || pluginTabs.some(plugin => plugin.id === tab))
        ? tab
        : firstTab;

    /**
     * The whole document as text, being edited - the Doc tab's other
     * mode. A toggle in the document's bar, not a tab of its own.
     */
    const [editing, setEditing] = useState(false);

    /**
     * Whether the Doc tab is showing what the last run changed instead
     * of the document. The third mode, beside reading and editing.
     *
     * Its own state rather than a third value of `editing`, because the
     * two answer different questions - one is "am I writing", which
     * guards unsaved work, and this is "am I comparing", which guards
     * nothing.
     */
    const [diffing, setDiffing] = useState(false);

    /**
     * Whether the editor is asking before it closes. Escape with an
     * unsaved draft asks rather than saving or discarding. Only set
     * when the draft is dirty.
     */
    const [closing, setClosing] = useState(false);

    /**
     * The whole-document editor's field. The window keyboard handler
     * below needs to tell it apart from the inline block editor and the
     * two note composers, which own their own Escape and Ctrl+Enter.
     */
    const editorRef = useRef<HTMLTextAreaElement>(null);

    /** The inline block editor's field, for the same reason - and because Tab indents in both. */
    const blockRef = useRef<HTMLTextAreaElement>(null);

    // Leaving a document closes the editor, but never the draft - see
    // `drafts`. The comparison closes too: it is about one document,
    // and the next one has its own.
    useEffect(() => {

        setEditing(false);
        setClosing(false);
        setDiffing(false);

    }, [artifact]);


    /**
     * How large the document is being read at, as an index into
     * {@link TYPE_SCALES}. Held for as long as the panel is open.
     */
    const [typeStep, setTypeStep] = useState(TYPE_SCALES.indexOf(1));

    const typeScale = TYPE_SCALES[typeStep];

    /**
     * The block the pointer is over. Tracked in state because
     * `.md-body` and `.md-gutter` are siblings, so no CSS selector can
     * reach from a hovered paragraph to its gutter mark.
     */
    const [hoverLine, setHoverLine] = useState<number | undefined>(undefined);

    /**
     * The pinned block, as a file line. A pin is clicked once and
     * stays; the arrow keys move it without the mouse.
     */
    const [pinned, setPinned] = useState<number | undefined>(undefined);

    /** The block open for editing in place, as the source lines it covers. */
    const [blockEdit, setBlockEdit] = useState<{ start: number; end: number; text: string } | undefined>(undefined);

    /**
     * The two side rails, each with its own switch, so both can be open
     * at once. The outline starts open because a spec is long. Each
     * setting holds for as long as the panel is open.
     */
    const [outlineOpen, setOutlineOpen] = useState(true);

    /**
     * The outline items collapsed in each document, by file line, keyed
     * by the document (a stage's artifact, or a prompt's path). Kept for
     * as long as the panel is open; everything starts expanded.
     */
    const [outlineClosed, setOutlineClosed] = useState<ReadonlyMap<string, ReadonlySet<number>>>(new Map());

    const closedIn = (doc: string | undefined): ReadonlySet<number> =>
        (doc !== undefined && outlineClosed.get(doc)) || NOTHING_CLOSED;

    const toggleOutlineItem = (doc: string | undefined, line: number) => {

        if (doc === undefined)
            return;

        setOutlineClosed(current => {

            const lines = new Set(current.get(doc));

            if (lines.has(line))
                lines.delete(line);
            else
                lines.add(line);

            return new Map(current).set(doc, lines);
        });
    };

    // Open on load when a note was being rewritten before a reload: the
    // rewrite is kept (see `noteEdit`), and the field is in this rail.
    const [notesOpen, setNotesOpen] = useState(() => props.savedDocDrafts?.noteEdit !== undefined);

    /**
     * Note groups the reader has folded away, by line. Kept only while
     * the panel is open; it is a view setting, not part of the note.
     */
    const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());

    const fold = (line: number) => setFolded(current => {

        const next = new Set(current);

        if (!next.delete(line))
            next.add(line);

        return next;
    });

    /** A note being rewritten, and the text so far. */
    const [noteEdit, setNoteEdit] = useState<{ id: string; text: string } | undefined>(() => props.savedDocDrafts?.noteEdit);

    /** A note being written, against the line it is about. */
    const [composing, setComposing] = useState<{ line: number; text: string } | undefined>(undefined);

    /**
     * Note text typed but not saved, by document and line. Escape and
     * an outside click close the composer but keep the text; only
     * Cancel drops it, and Add clears it by saving.
     */
    const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>(() => props.savedDocDrafts?.notes ?? {});

    const draftKey = (line: number) => `${artifact ?? ""}:${line}`;

    /**
     * The line whose notes the panel should scroll to and flash. The
     * nonce makes a second click on the same mark count as a change.
     */
    const [notesAt, setNotesAt] = useState<{ line: number; nonce: number } | undefined>(undefined);

    const notesJumps = useRef(0);

    /** The notes panel's scrolling list, so a mark can bring its own notes into view. */
    const notesBodyRef = useRef<HTMLDivElement>(null);

    const noteFlashTimer = useRef<number | undefined>(undefined);

    /** Open the notes panel on one line's notes - what a margin mark does. */
    const showNotes = (line: number) => {

        setNotesOpen(true);
        notesJumps.current += 1;
        setNotesAt({ line, nonce: notesJumps.current });
    };

    /** Open the composer on a line, with whatever was last typed against it. */
    const openComposer = (line: number) => {

        setNotesOpen(true);
        setComposing({ line, text: noteDrafts[draftKey(line)] ?? "" });
    };

    /** Close the composer and keep the text - Escape and an outside click both land here. */
    const closeComposer = () => {

        if (composing)
            setNoteDrafts(current => ({ ...current, [draftKey(composing.line)]: composing.text }));

        setComposing(undefined);
    };

    /** Forget a line's draft - it has either been saved or thrown away. */
    const dropDraft = (line: number) => setNoteDrafts(current => {

        const next = { ...current };

        delete next[draftKey(line)];

        return next;
    });

    /** Close the composer and drop the text. */
    const cancelComposer = () => {

        if (composing)
            dropDraft(composing.line);

        setComposing(undefined);
    };


/**
     * The document over the whole panel: the stepper, the gate and the
     * log are hidden.
     */
    const [full, setFull] = useState(false);

    /** Where every rendered block sits, measured after each render - see {@link Mark}. */
    const [marks, setMarks] = useState<Mark[]>([]);

    /** Where the prose stops, and how wide the pane is - the two numbers that decide whether a note fits beside it. */
    const [margin, setMargin] = useState({ edge: 0, width: 0 });

    /**
     * Unsaved edits, kept per artifact so toggling to Preview - or
     * looking at another phase - never silently discards typing. A draft
     * dies only when it matches the saved content again.
     */
    const [drafts, setDrafts] = useState<Record<string, string>>(() => props.savedDocDrafts?.docs ?? {});

    const draft = artifact !== undefined ? drafts[artifact] ?? content ?? "" : "";
    const dirty = artifact !== undefined && drafts[artifact] !== undefined && drafts[artifact] !== content;

    /** What each document read as the last time it arrived, so a change from disk can be told from a switch of phase. */
    const arrived = useRef<Record<string, string | undefined>>({});

    // The file changed on disk under a document with no unsaved edits
    // - an agent ticked a box through `task_done`, a pull landed - so
    // the new text is what to show. A draft that still matched the old
    // text is not an edit, only a copy the checkbox click left behind,
    // and it goes; one that differs is real typing and stays, which
    // the dirty mark then says.
    useEffect(() => {

        if (artifact === undefined)
            return;

        const before = arrived.current[artifact];

        arrived.current[artifact] = content;

        if (content === undefined || before === undefined || before === content)
            return;

        setDrafts(previous => {

            if (previous[artifact] === undefined || previous[artifact] !== before)
                return previous;

            return Object.fromEntries(Object.entries(previous).filter(([file]) => file !== artifact));
        });

    }, [artifact, content]);

    /*
     * The prompt, as a second editable file.
     *
     * It shares `drafts` (keyed by path) and nothing else. `editing`,
     * `dirty` and `draft` stay about the document alone, because the
     * gutter, change bars, note anchors and Revise guard all read them.
     *
     * No review layer here - no blocks, gutter or notes. A note is
     * handed back to the phase that wrote the document; nothing
     * rewrites a prompt.
     *
     * Editing a prompt changes the file wherever it lives (see
     * `SddCore`: the `resources/styles` folder, the user's home,
     * or the workspace). So it changes that style for every spec that
     * follows it, and an edit to a built-in style's prompt is
     * overwritten on the next update of Eesha Code. The tab says so.
     */
    const [promptEditing, setPromptEditing] = useState(false);

    const [promptClosing, setPromptClosing] = useState(false);

    const promptEditorRef = useRef<HTMLTextAreaElement>(null);

    /** The prompt's reading pane, for the outline to scroll inside. */
    const promptBodyRef = useRef<HTMLDivElement>(null);

    const promptDraft = promptPath !== undefined ? drafts[promptPath] ?? promptText ?? "" : "";

    const promptDirty = promptPath !== undefined
        && drafts[promptPath] !== undefined
        && drafts[promptPath] !== promptText;

    // Fetch the viewed document the first time it is looked at, and
    // whenever a save round-trips new content.
    useEffect(() => {

        if (artifact && docStage?.exists && content === undefined)
            requestDocument(artifact);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artifact, docStage?.exists, content]);

    // Opening a phase opens its default tab, and keeps it: the tab is set
    // here, not left undefined, so the default cannot change under the
    // reader later - Logs would turn into Doc by itself when the document
    // lands. The panel never changes tab on its own; only the reader
    // does. The draft is never forgotten - see `drafts`.
    useEffect(() => {

        setTab(nextTab.current ?? firstTab);
        nextTab.current = undefined;

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [current?.name]);

    // Sent here from the chat's history: that conversation, in
    // the sessions pane, with the left side moved to its phase.
    useEffect(() => {

        const focus = props.focus;

        if (focus)
            pointPane({ ownerId: focus.ownerId });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.focus?.seq]);

    // The prompt is read up front. The host answers "" for a file that
    // is not there, which the tab reports rather than hides.
    useEffect(() => {

        if (promptPath && documents[promptPath] === undefined)
            requestDocument(promptPath);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [promptPath, documents[promptPath ?? ""]]);

    /**
     * A block editor closes when the document changes under it. It
     * commits by splicing its text back at the line numbers it opened
     * with, and a rewritten file makes those numbers name other text.
     */
    useEffect(() => {

        setBlockEdit(undefined);

    }, [artifact, content]);

    useEffect(() => {

        if (artifact !== undefined && content !== undefined && drafts[artifact] === content)
            setDrafts(previous => {

                const { [artifact]: retired, ...rest } = previous;

                return rest;
            });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artifact, content]);

    // A different prompt closes the editor, but never the draft.
    useEffect(() => {

        setPromptEditing(false);
        setPromptClosing(false);

    }, [promptPath]);

    // A saved prompt round-trips its new text back; a draft that now
    // matches it is retired.
    useEffect(() => {

        if (promptPath !== undefined && promptText !== undefined && drafts[promptPath] === promptText)
            setDrafts(previous => {

                const { [promptPath]: retired, ...rest } = previous;

                return rest;
            });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [promptPath, promptText]);

    /**
     * What is on screen, and where it sits in the file.
     *
     * Split from `draft`, not `content`, so a preview shows the edit
     * being typed rather than the saved document.
     *
     * `offset` turns a markdown position into a file line. See
     * `docBody`: it is the frontmatter's height, zero when there is
     * none.
     */
    /*
     * The draft as the expensive readings below see it.
     *
     * Splitting the frontmatter, diffing against the baseline and
     * anchoring every note are all work over the whole document, and
     * they would be redone on every keystroke in the editor. Deferred, the
     * keystroke's own render reuses the last results and the textarea
     * paints at once; React re-runs them afterwards at a lower
     * priority, and a further keystroke throws that pass away rather
     * than waiting for it. Everything drawn from these catches up
     * within a frame of typing pausing. Anything that writes - saving,
     * committing a block, adding a note - reads `draft` itself.
     */
    const settled = useDeferredValue(draft);

    const { meta, body, offset } = useMemo(
        () => splitFrontmatter(settled),
        [settled]);

    /** The scrolling document pane - what a followed reference moves, and what remembers where you were. */
    const bodyRef = useRef<HTMLDivElement>(null);

    /** Scroll offset per artifact, so leaving a document and coming back keeps the reader's place. */
    const scrollTops = useRef<Record<string, number>>({});

    const flashTimer = useRef<number | undefined>(undefined);

    /**
     * Every file the citations in this document point at. Scanned
     * rather than declared, because a cited PRD is only known from the
     * document that cites it. Fetched like a stage's own document so a
     * card can open on it.
     */
    const cited = useMemo(() => {

        if (!artifact)
            return [];

        const found = new Set<string>();

        for (const [, text, href] of body.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)/g))
            if (parseRefLink(href, text))
                found.add(resolveRef(artifact, href));

        return [...found];

    }, [artifact, body]);

    const unread = [
        ...specStages
            .filter(stage => stage.artifact && stage.exists && documents[stage.artifact] === undefined)
            .map(stage => stage.artifact!),

        ...cited.filter(path => documents[path] === undefined)
    ];

    useEffect(() => {

        for (const path of unread)
            requestDocument(path);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unread.join("\n")]);

    /** Each stage's own citation prefix, by the artifact it writes - what a document's ids are read against. */
    const prefixByArtifact = useMemo(() => {

        const prefixes: Record<string, string | undefined> = {};

        for (const stage of specStages)
            if (stage.artifact)
                prefixes[stage.artifact] = stage.prefix;

        return prefixes;
    }, [specStages]);

    /**
     * What each document offers a reference, by artifact: the ids that
     * decide whether it resolves, and the words behind each one.
     */
    const previewsByArtifact = useMemo(() => {

        const previews: Record<string, Map<string, RequirementPreview>> = {};

        for (const [path, text] of Object.entries(documents))
            previews[path] = new Map(
                requirementPreviews(text, prefixByArtifact[path]).map(one => [one.id, one]));

        return previews;
    }, [documents, prefixByArtifact]);

    /** The anchors each document offers, by artifact - what decides whether a reference resolves. */
    const knownByArtifact = useMemo(() => {

        const known: Record<string, Set<string>> = {};

        for (const [path, previews] of Object.entries(previewsByArtifact))
            known[path] = new Set(previews.keys());

        return known;
    }, [previewsByArtifact]);

    /**
     * The viewed document's anchors by source line. Parsed from `body`,
     * not `content`: react-markdown's line numbers are relative to what
     * it was handed, which has the frontmatter split off.
     */
    const lineAnchors = useMemo(
        () => anchorsByLine(requirementAnchors(body, docStage?.prefix)),
        [body, docStage?.prefix]);

    /** The document as lines, in the file's own numbering. */
    const fileLines = useMemo(() => draft.split("\n"), [draft]);

    // Every kind of unsaved typing goes to the host on every change, so
    // a reload - the one a returning server connection makes too - puts
    // it back: edited documents, notes not added, the block open for
    // editing in place, and the note being rewritten.
    const onDocDraftsChange = props.onDocDraftsChange;

    useEffect(() => onDocDraftsChange?.({
        docs: drafts,
        notes: noteDrafts,
        ...(blockEdit && artifact !== undefined
            ? { block: { doc: artifact, ...blockEdit, was: fileLines.slice(blockEdit.start - 1, blockEdit.end).join("\n") } }
            : {}),
        ...(noteEdit ? { noteEdit } : {})

        // `fileLines` is left out on purpose: it is read only while a
        // block is open, and the document does not change under an open
        // block - a change closes it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [drafts, noteDrafts, blockEdit, noteEdit, artifact, onDocDraftsChange]);

    /**
     * The block that was open when the page last loaded, opened again
     * once its document is back - only when the lines it opened on still
     * read the same. Otherwise the file changed since, and splicing the
     * text in at those line numbers would overwrite other text: the same
     * rule that closes an open block when the file changes under it.
     */
    const savedBlock = useRef(props.savedDocDrafts?.block);

    useEffect(() => {

        const block = savedBlock.current;

        if (!block || artifact !== block.doc || content === undefined)
            return;

        savedBlock.current = undefined;

        if (fileLines.slice(block.start - 1, block.end).join("\n") === block.was)
            setBlockEdit({ start: block.start, end: block.end, text: block.text });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artifact, content]);

    /**
     * Characters the widest line range in this document needs: twice
     * the digits of the last line number, plus the dash. Exact, because
     * every character comes out of the reading width and the stylesheet
     * already leaves slack per character.
     */
    const gutterChars = useMemo(
        () => String(fileLines.length).length * 2 + 1,
        [fileLines.length]);

    /** The reading pane - the box marks are measured against, and what the gutter is laid over. */
    const readingRef = useRef<HTMLDivElement>(null);

    /**
     * Where every block ended up, measured from the DOM.
     * `getBoundingClientRect` rather than `offsetTop`: a Mermaid frame
     * is positioned, so a block inside one would measure against the
     * frame instead of the pane.
     *
     * Deduplicated by line: `li > p` and `blockquote > p` both report
     * the same starting line. The outer element comes first, so first
     * wins.
     */
    useLayoutEffect(() => {

        const pane = readingRef.current;
        const document_ = pane?.querySelector<HTMLElement>(".md-body");

        if (!pane || !document_) {

            setMarks(current => current.length === 0 ? current : []);

            return;
        }

        const measure = () => {

            const frame = pane.getBoundingClientRect();
            const base = frame.top;
            const seen = new Set<number>();
            const next: Mark[] = [];

            /*
             * Where the prose stops. The reading measure is padding on
             * each block, so text ends short of the block's right edge,
             * and a note can sit in that gap. Measured, because the
             * measure is in `ch` and depends on font and size.
             */
            let edge = 0;

            for (const element of Array.from(document_.querySelectorAll<HTMLElement>("[data-line]"))) {

                const line = Number(element.dataset.line);

                if (!Number.isFinite(line) || seen.has(line))
                    continue;

                seen.add(line);

                const box = element.getBoundingClientRect();
                const style = window.getComputedStyle(element);

                edge = Math.max(
                    edge,
                    box.left - frame.left + box.width - (Number.parseFloat(style.paddingRight) || 0));

                // `line-height: normal` computes to the string, not a
                // length, so the font size carries the fallback.
                const lead = Number.parseFloat(style.lineHeight)
                    || Number.parseFloat(style.fontSize) * 1.4
                    || 20;

                next.push({
                    line,
                    end: Number(element.dataset.end) || line,
                    top: Math.round(box.top - base),
                    height: Math.round(box.height),
                    lead: Math.round(Math.min(lead, box.height || lead))
                });
            }

            // Compared before it is stored, or the observer below would
            // re-render on its own output for ever.
            setMarks(current => sameMarks(current, next) ? current : next);

            setMargin(current =>
                Math.abs(current.edge - edge) < 1 && Math.abs(current.width - frame.width) < 1
                    ? current
                    : { edge: Math.round(edge), width: Math.round(frame.width) });
        };

        measure();

        // A diagram finishing, a font loading or a resize moves every
        // block below it without a React render.
        const observer = new ResizeObserver(measure);

        observer.observe(pane);

        return () => observer.disconnect();

        // `shownTab` is here even though the effect never reads it: the
        // Doc tab's own subtree unmounts when you leave it and remounts
        // fresh when you come back, and none of the other deps below
        // necessarily change on that remount. Without it this effect
        // keeps whatever `marks` were last measured - stale positions,
        // or none - until some unrelated dep happens to change, and the
        // gutter would render rows stacked on top of each other until then.
        //
        // `blockEdit?.start`, not `blockEdit`: the editor opening,
        // closing or moving to another block changes the layout under
        // it; the text typed into it does not, since it floats over the
        // block. On the whole object, every keystroke re-measured every
        // block in the document.
    }, [body, artifact, editing, executionLens, blockEdit?.start, full, typeScale, shownTab]);

    // The document as it stood before the last phase wrote it. Asked
    // for once per document; the host answers with `null` when there is
    // no version on record, which is why an absent key means unasked.
    useEffect(() => {

        if (artifact && docStage?.exists && baselines[artifact] === undefined)
            requestBaseline(artifact);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artifact, docStage?.exists, baselines]);

    /**
     * That version's own body, frontmatter dropped.
     *
     * Dropped on both sides, so a spec whose `spec.json` stamped a new
     * date into the document does not read as a change to the document.
     */
    const baselineBody = useMemo(() => {

        const text = artifact ? baselines[artifact] ?? undefined : undefined;

        return text === undefined ? undefined : splitFrontmatter(text).body;

    }, [artifact, baselines]);

    /**
     * What changed since that version, chunk by chunk - what the diff
     * view draws and what the button counts.
     *
     * Compared against what is on screen, drafts included, so an
     * unsaved edit shows as a change like any other.
     */
    const blockChanges = useMemo(
        () => diffBlocks(baselineBody, body),
        [baselineBody, body]);

    /**
     * The plan on screen: the stage marked actionable, else the document
     * the execution stage reads. Rows are read from the text being
     * rendered (`settled`), so a row and its controls agree on the line
     * even with an unsaved edit in the document.
     */
    const planArtifact = specStages.find(stage => stage.actionable)?.artifact
        ?? (() => {

            const execution = specStages.find(stage => !stage.artifact && lensDocOf(specStages, stage.name));

            return execution ? lensDocOf(specStages, execution.name)?.artifact : undefined;
        })();

    const inlinePlan = !editing && artifact !== undefined && artifact === planArtifact;

    const inlineRows = useMemo(() => inlinePlan ? parseTasks(settled) : [], [inlinePlan, settled]);

    /**
     * This document's headings, with the file's own line numbers - and,
     * on the plan, its tasks under them, so the outline is a map of the
     * work rather than one heading over all of it.
     *
     * Three levels of task, no deeper: a top-level row is often a whole
     * user story, and its sub-tasks are where the work is. Below `1.1.1`
     * the outline would be longer than the plan.
     */
    const outline = useMemo(() => {

        if (!inlinePlan)
            return outlineOf(body, offset);

        const rows: { line: number; text: string; level: number }[] = [];

        const collect = (tasks: readonly SpecTask[], level: number) => {

            for (const task of tasks) {

                rows.push({ line: task.line, text: task.id ? `${task.id}. ${task.text}` : task.text, level });

                if (level < OUTLINE_TASK_LEVELS)
                    collect(task.subtasks, level + 1);
            }
        };

        collect(inlineRows, 1);

        return withRows(outlineOf(body, offset), rows);

    }, [body, offset, inlinePlan, inlineRows]);

    /** The line at the top of the document pane, and whether the pinned block is still on screen. */
    const docScroll = useScrolledLine(
        bodyRef,
        [artifact, body, editing, full, typeScale, shownTab, executionLens],
        pinned);

    /**
     * Where the outline marks the reader as being: the pinned block
     * while it is on screen, else what is at the top of the pane. The
     * pin first, because a heading clicked near the end of a document
     * cannot scroll to the top - the pane runs out first - and the
     * outline should still light up what was clicked.
     */
    const docHere = pinned !== undefined && docScroll.keepInView ? pinned : docScroll.top;

    const docSection = sectionAt(outline, docHere ?? 0);

    /** The parent headings of what is at the top of the pane, for the bar over it. */
    const docChain = useMemo(() => chainAt(outline, docScroll.top ?? 0), [outline, docScroll.top]);

    /** The outline's scrolling list, so the lit entry can be kept in sight. */
    const outlineBodyRef = useRef<HTMLDivElement>(null);

    useEffect(() => keepHereInView(outlineBodyRef.current), [docSection?.line, outlineOpen]);

    /** Every note on the document on screen, placed against it as it stands now. */
    const anchored = useMemo(
        () => artifact
            ? anchorNotes(notes.filter(note => note.artifact === artifact), settled)
            : [],
        [notes, artifact, settled]);

    const notesHere = useMemo(() => notesByLine(anchored), [anchored]);

    /** Notes whose text is no longer in the document. Shown apart rather than dropped. */
    const orphans = anchored.filter(note => note.at === undefined && !note.resolved);

    const openNotes = anchored.filter(note => !note.resolved);

    /**
     * How much room is left beside the prose, and whether a note fits.
     * Below the limit nothing is drawn in the margin at all.
     */
    const marginLeft = margin.edge + 24;

    const marginRoom = margin.width - marginLeft;

    const notesInline = marginRoom >= 220;

    // `notesInline`, `marginRef` and `folded` belong to the inline
    // margin layout, which is not drawn.

    /** The margin column, so its cards can be pushed apart after they render. */
    const marginRef = useRef<HTMLDivElement>(null);

    /**
     * Cards that would overlap, pushed down. Done after the render
     * because a card's height is only known once it is drawn: each card
     * takes the lower of where it wants to be and where the one above
     * ended.
     */
    useLayoutEffect(() => {

        const column = marginRef.current;

        if (!column)
            return;

        let taken = 0;

        for (const slot of Array.from(column.children) as HTMLElement[]) {

            const wants = Number(slot.dataset.top ?? 0);
            const at = Math.max(wants, taken);

            slot.style.transform = at === wants ? "" : "translateY(" + (at - wants) + "px)";

            taken = at + slot.offsetHeight + 8;
        }
    });

    /**
     * How many blocks differ from the version put aside before this
     * phase last ran - what the "What changed" button says, and whether
     * it is offered at all.
     *
     * The document itself carries no mark. A bar in the margin
     * would say only "look here" and leave the reader to find what moved
     * inside the block; the button shows them.
     */
    const changedBlocks = changedCount(blockChanges);

    /**
     * A reference the reader followed - the document to show, and the
     * criteria to flash once it is on screen. Cleared when the flash
     * ends, so returning to that document later restores the reader's
     * own position rather than jumping again.
     */
    const [jump, setJump] = useState<{ artifact: string; target: string; refs: string[]; nonce: number } | undefined>(undefined);

    const jumps = useRef(0);

    /**
     * Following a citation. One of this spec's own documents moves the
     * panel to it and flashes the criteria. Anything else has no chip
     * to switch to, so it opens as a file tab.
     */
    const followCitation = (path: string, stage: SpecStage | undefined, refs: string[]) => {

        if (!stage?.artifact)
            return openFile(path);

        jumps.current += 1;

        setSelectedName(stage.name);
        setJump({ artifact: stage.artifact, target: stage.name, refs, nonce: jumps.current });
    };

    /**
     * Where the reader was in each document, remembered as they leave
     * it. Recorded in the effect's cleanup rather than on every scroll
     * event, so a programmatic scroll is never mistaken for the reader's.
     */
    useEffect(() => {

        const element = bodyRef.current;

        // Nothing until the document is on screen. Running while the
        // pane still says "Loading…" would record a clamped zero over
        // the position being restored.
        if (!element || !artifact || content === undefined)
            return;

        // A pending jump owns the scroll; restoring first would fight it.
        if (jump?.artifact !== artifact)
            element.scrollTop = scrollTops.current[artifact] ?? 0;

        return () => {

            scrollTops.current[artifact] = element.scrollTop;
        };

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [artifact, content]);

    /**
     * The file lines lit by a landing, read by `blockProps` so a render
     * during the flash draws the class again rather than wiping it -
     * pinning the landing is one such render.
     */
    const flashing = useRef<Set<number>>(new Set());

    /**
     * The landing: scroll to the first criterion the reference named,
     * pin it so the outline points at it, and flash every one of them.
     *
     * The class is put on the elements directly as well as through
     * `flashing`, so the highlight shows at once rather than after the
     * pin's render. Nothing else writes these class names.
     */
    useEffect(() => {

        if (!jump || jump.artifact !== artifact || content === undefined || editing)
            return;

        // The document is drawn from `settled`, which lags `draft` by a
        // deferred render. On the render that switches documents the
        // pane still holds the one the citation was clicked in, so the
        // landing is not there yet. Waiting for the next run - this
        // effect follows `settled` - rather than clearing the jump, which
        // would leave the reader at the old document's scroll offset with
        // nothing highlighted.
        if (settled !== draft)
            return;

        const gentle = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

        const frame = requestAnimationFrame(() => {

            const landings = jump.refs
                .map(ref => document.getElementById(anchorId(jump.target, ref)))
                .filter((element): element is HTMLElement => element !== null);

            // Nothing to land on - clear the jump rather than leaving it
            // armed, or it would fire the moment the document changes.
            if (landings.length === 0) {

                setJump(undefined);

                return;
            }

            landings[0].scrollIntoView({ block: "center", behavior: gentle ? "auto" : "smooth" });

            const lines = landings
                .map(landing => Number(landing.closest<HTMLElement>("[data-line]")?.dataset.line))
                .filter(line => Number.isFinite(line));

            flashing.current = new Set(lines);

            for (const landing of landings)
                landing.classList.add(FLASH);

            // The outline's "you are here" follows the pin, so the
            // landing takes it - otherwise the rail would keep pointing at
            // whatever was pinned the last time this document was open.
            if (lines.length > 0)
                setPinned(lines[0]);

            window.clearTimeout(flashTimer.current);

            flashTimer.current = window.setTimeout(() => {

                flashing.current = new Set();

                for (const landing of landings)
                    landing.classList.remove(FLASH);

                setJump(undefined);

            }, FLASH_MS);
        });

        return () => cancelAnimationFrame(frame);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [jump, artifact, content, editing, settled, draft]);

    useEffect(() => () => window.clearTimeout(flashTimer.current), []);

    /**
     * A click outside the notes panel closes the composer and keeps the
     * text, like Escape. The controls that open the composer are
     * excluded, or pressing one would close it in the same gesture.
     */
    useEffect(() => {

        if (!composing)
            return;

        const outside = (event: MouseEvent) => {

            const target = event.target as HTMLElement | null;

            if (target?.closest(".sdd-rail--right, .md-gutter__note, .md-marks__mark"))
                return;

            closeComposer();
        };

        window.addEventListener("mousedown", outside, true);

        return () => window.removeEventListener("mousedown", outside, true);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [composing]);

    /**
     * A margin mark's landing: scroll the panel to that line's notes
     * and flash them. Scrolled by `scrollTop` rather than
     * `scrollIntoView`, which would also scroll every ancestor and move
     * the document beside it.
     */
    useEffect(() => {

        if (!notesAt || !notesOpen)
            return;

        const gentle = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

        const frame = requestAnimationFrame(() => {

            const body = notesBodyRef.current;

            const cards = body
                ? Array.from(body.querySelectorAll<HTMLElement>(`[data-note-line="${notesAt.line}"]`))
                : [];

            // Nothing there. Clear the request rather than leaving it
            // armed.
            if (!body || cards.length === 0) {

                setNotesAt(undefined);

                return;
            }

            body.scrollTo({
                top: Math.max(0, cards[0].offsetTop - body.clientHeight / 2 + cards[0].offsetHeight / 2),
                behavior: gentle ? "auto" : "smooth"
            });

            // The class the UI library's CommentBox lights itself with.
            for (const card of cards)
                card.firstElementChild?.classList.add(NOTE_FLASH);

            window.clearTimeout(noteFlashTimer.current);

            noteFlashTimer.current = window.setTimeout(() => {

                for (const card of cards)
                    card.firstElementChild?.classList.remove(NOTE_FLASH);

                setNotesAt(undefined);

            }, FLASH_MS);
        });

        return () => cancelAnimationFrame(frame);

    }, [notesAt, notesOpen]);

    useEffect(() => () => window.clearTimeout(noteFlashTimer.current), []);

    return {
        props, specStages, documents, requestDocument, saveDocument, gate, decide, isRunning, title,
        startPhase, startTasks, runCommand, runWorkflow, workflows, queuedTasks, waitingTasks,
        markDone, openSession, taskSessions, openFile, logsByTask, taskStatuses, stopPhase,
        sessionCost, docDiff, stopAfterCurrent, setStopAfterCurrent, nextSessionAt, runningCommands, stopCommand,
        nextSessionIn, setNextSessionIn, notes, saveNotes,
        baselines, requestBaseline, notesToChat,
        problems, pluginApps, pluginSandboxed, pluginBridge,
        sessionRuns, sessionLines, requestSessionLines, widths, saveWidths, position, selectedName,
        setSelectedName, chosen, executionLens, landed, selected, docStage, artifact, content, busy,
        draftingStage, current, promptPath, promptText, tab, setTab, nextTab, panePick, setPanePick,
        paneStageOf, pointPane, followNext,
        lensHasWaves, tabIds, pluginTabs, firstTab, shownTab, editing, setEditing, diffing, setDiffing,
        closing, setClosing, editorRef, blockRef, typeStep, setTypeStep, typeScale, hoverLine,
        setHoverLine, pinned, setPinned, blockEdit, setBlockEdit, outlineOpen, setOutlineOpen,
        outlineClosed, setOutlineClosed, closedIn, toggleOutlineItem, notesOpen, setNotesOpen,
        folded, setFolded, fold, noteEdit, setNoteEdit, composing, setComposing, noteDrafts,
        setNoteDrafts, draftKey, notesAt, setNotesAt, notesJumps, notesBodyRef, noteFlashTimer,
        showNotes, openComposer, closeComposer, dropDraft, cancelComposer, full, setFull, marks,
        setMarks, margin, setMargin, drafts, setDrafts, draft, dirty, arrived, promptEditing,
        setPromptEditing, promptClosing, setPromptClosing, promptEditorRef, promptBodyRef,
        promptDraft, promptDirty, settled, meta, body, offset, bodyRef, scrollTops, flashTimer,
        cited, unread, prefixByArtifact, previewsByArtifact, knownByArtifact, lineAnchors, fileLines,
        gutterChars, readingRef, baselineBody, blockChanges, planArtifact, inlinePlan, inlineRows,
        outline, docScroll, docHere, docSection, docChain, outlineBodyRef, anchored, notesHere,
        orphans, openNotes, marginLeft, marginRoom, notesInline, marginRef,
        changedBlocks, jump, setJump, jumps, followCitation, flashing
    } as const;
}

/** What useRunState gives the parts after it. */
export type RunState = ReturnType<typeof useRunState>;

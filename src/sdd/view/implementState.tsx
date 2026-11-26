/*
 * What the SDD run view works out for an implementation phase: the
 * plan's tasks, the chat each task ran in and its lane, the waves and
 * which one is running, what is next, the logs and the sessions pane
 * pick, the open questions and the Run till here choice.
 *
 * Part of SddRunView - see runState.tsx for how the parts fit.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { LogLine } from "../../core/models/run";
import { SpecStage, TaskSession } from "../../shared/runMessages";
import { namesOf, openBefore, stepsOf, tillHere } from "../../shared/waveOrder";
import { splitWave, wavesOf } from "../phase/waves";
import { Button, Select, Textarea } from "../../view/ui";
import { entryFromLine } from "../../view/templates/logEntry";
import { answerQuestion, openQuestions as questionsIn } from "../documents/openQuestions";
import { blockedBy } from "./openQuestionGate";
import { PaneRun, paneRuns, pickedRun, runDetail, runKey, stageOf, withNextRun } from "./sessionRuns";
import { phaseLines } from "../../view/usageTable";
import { allTasks, isAgentTask, isTaskDone, parseTasks, parseWaves, pendingWork, SpecTask, toggleCheckbox, waveOf, workUnits } from "./taskList";
import { CardFace, TillFace } from "./WaveGraph";
import { needsLabel } from "./waveLayout";
import { COMMON, hasOpenAsk, fileName, hiddenGateAfter, lensDocOf, WaveRow } from "./runViewHelpers";
import type { RunState } from "./runState";

export function useImplementState(ctx: RunState) {

    const {
        specStages, documents, saveDocument, gate, startTasks, queuedTasks, waitingTasks,
        openSession, taskSessions, logsByTask, sessionRuns, sessionLines, requestSessionLines,
        position, selected, docStage, artifact, busy, draftingStage, current, setTab, panePick,
        paneStageOf, pointPane, editing, setDrafts, draft, dirty, inlineRows
    } = ctx;

    /**
     * The execution phase and the plan it reads, found whether or not
     * that phase is selected - the header's Next: Implementation needs
     * them from any phase, which is the point of putting it there.
     */
    const planStage = specStages.find(stage => !stage.artifact && lensDocOf(specStages, stage.name));

    const planText = planStage ? documents[lensDocOf(specStages, planStage.name)!.artifact!] : undefined;

    const tasks = useMemo(() => parseTasks(planText), [planText]);

    /** What the button that starts the plan says - the phase's own word for itself. */
    const planLabel = planStage ? planStage.label ?? planStage.name : "tasks";

    /**
     * The units of work - sub-tasks, and tasks that have none. What a
     * row's ▶ starts, what the counts count, and what the plan's
     * dependency graph names. A group with sub-tasks is a heading here,
     * the way the tasks phase describes it: a container, not work.
     */
    const units = useMemo(() => workUnits(tasks), [tasks]);

    const unitsDone = units.filter(isTaskDone).length;


    /**
     * The task a single ▶ launched a chat for, still unticked - shown
     * as "in chat…". Display only: completion truth is the checkbox on
     * disk, which the folder watcher streams back in.
     */
    const [launched, setLaunched] = useState<string | undefined>(undefined);

    /**
     * The implementation chats, newest first - the order every lookup
     * below wants, because a task started twice has two chats and the
     * newer one is the live conversation.
     */
    const chats = useMemo(() => [...taskSessions].reverse(), [taskSessions]);

    /**
     * The chat working this row, if there is one: the row's own ▶
     * opened it, or it is the wave's chat and this task is on the list
     * it was handed. A record whose task is `*` (one chat for the whole remaining
     * list) is not matched here - it belongs to no row in particular.
     */
    const chatFor = (taskId: string | undefined) =>
        taskId ? chats.find(entry => entry.task === taskId || entry.tasks?.includes(taskId)) : undefined;

    /**
     * The task ids an implementation chat was handed, from its record -
     * so the picker and the sessions pane can name all of them, not only
     * the first task or the wave. `at` picks the record of an earlier run
     * of the same chat: the newest one opened by then.
     */
    const chatTasksOf = (ownerId: string, at?: number): string[] | undefined => {

        const sign = ownerId.indexOf("@");

        if (sign < 0)
            return undefined;

        const own = chats.filter(entry => entry.task === ownerId.slice(sign + 1));

        return ((at !== undefined ? own.find(entry => entry.at <= at) : undefined) ?? own[0])?.tasks;
    };

    /** A chat's row in the lane picker: `wave:2 · 2.1, 2.2`, or `1.1, 1.2, 1.3` for a chat of a plan with no graph. */
    const laneName = (lane: string): string => {

        const key = lane.slice(lane.indexOf("@") + 1);
        const ids = chatTasksOf(lane);

        if (key.startsWith("wave:"))
            return ids?.length ? `${key} · ${ids.join(", ")}` : key;

        return ids && ids.length > 1 ? ids.join(", ") : key;
    };

    /** The most recent implementation chat of any kind - what the lens's View session opens. */
    const latestChat = chats[0];

    /** Opens a chat: its phase chat, else by its runtime's id. */
    const openChat = (chat: TaskSession) => openSession(chat);

    /**
     * Whether an agent is working this row right now.
     *
     * `launched` covers the moment between the click and the panel
     * writing the chat down; the record covers everything after,
     * including across a reload. A chat the engine has reported idle is
     * neither - it is a conversation to reopen, not work in progress.
     */
    const isWorking = (taskId: string | undefined) => {

        const chat = chatFor(taskId);

        return chat ? !chat.ended : launched === taskId;
    };

    /**
     * The plan's dependency graph, when it declared one. Advisory: a
     * plan without it (or with a malformed one) simply has no waves, and
     * everything below falls back to strict document order.
     */
    const waves = useMemo(() => parseWaves(planText), [planText]);

    /** The execution phase is what is busy - a wave's chat is open, or is being opened. */
    const implementing = draftingStage !== undefined && draftingStage === planStage?.name;

    // The `Run:` task the plan waits on you for. Nothing runs while it
    // waits, so the bar says so instead of "implementing…".
    const yourTurn = implementing ? waitingTasks?.[0] : undefined;

    const doneIds = useMemo(() => new Set(units.filter(isTaskDone).map(unit => unit.id)), [units]);

    /**
     * Every wave of the plan with how far it has got - what each row's
     * wave badge shows. Progress is the checkboxes on disk: a
     * wave is done when every task in it is ticked, running when the
     * execution phase is busy and a chat is working one of its tasks,
     * and waiting otherwise. With branches the first wave not done is
     * not always the one being worked, so the chats say which is.
     */
    const waveRows = useMemo(() => waves.map((wave): WaveRow => {

        const done = wave.tasks.filter(id => doneIds.has(id)).length;
        const finished = done === wave.tasks.length;
        const running = !finished && implementing && wave.tasks.some(isWorking);

        return {
            id: wave.id,
            done,
            total: wave.tasks.length,
            state: finished ? "done" : running ? "running" : "pending"
        };

    // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [waves, doneIds, implementing, chats, launched]);

    const runningWave = waveRows.find(row => row.state === "running")?.id;

    /** The wave a task id sits in, as a row, when the plan has waves. */
    const waveRowOf = (taskId: string) => {

        const id = waveOf(taskId, waves);

        return id === undefined ? undefined : waveRows.find(row => row.id === id);
    };

    /** The rows of the plan, so the running-wave line can scroll to one. */
    const tasksRef = useRef<HTMLDivElement>(null);

    /**
     * Scrolls the first task of the running wave into view - what the
     * line above the rows does when pressed. The wave's tasks are ids;
     * each row carries its own, so the first one on the list is the
     * one to land on.
     */
    const goToRunningWave = () => {

        const first = waves.find(wave => wave.id === runningWave)?.tasks[0];

        if (first === undefined)
            return;

        tasksRef.current
            ?.querySelector<HTMLElement>(`[data-task-id="${first}"]`)
            ?.scrollIntoView({ block: "center", behavior: "smooth" });
    };

    /**
     * The agent's units of work still open - what the Tasks tab counts.
     *
     * The units are sub-tasks where a group has them, because that is
     * what an agent is handed and what the dependency graph names.
     */
    const pending = pendingWork(tasks).filter(isAgentTask);

    /**
     * What Next: Implementation hands over - every open unit of work,
     * `Run:` tasks included. The host walks them wave by wave, one
     * after another in the plan's order: agent tasks in a chat, a
     * command in a shell, a workflow in the run panel, and a task
     * done by hand waits for its tick. Each carries its wave, which is
     * what the host groups by.
     */
    const openWork = pendingWork(tasks);

    /**
     * The task Next starts first - the open one earliest in the plan's
     * order, waves first, the same order the host works them in. Shown
     * on the button so nobody has to guess where it picks up.
     */
    const nextSteps = stepsOf(openWork.map(unit => ({ id: unit.id, wave: waveOf(unit.id, waves) })));

    // Stable, so tasks of one wave keep the plan's order.
    const nextUp = [...openWork].sort((left, right) => nextSteps.get(left.id)! - nextSteps.get(right.id)!)[0];

    /**
     * Everything Next hands over first: the first task, and every agent
     * task after it in the same wave up to the first `Run:` or by-hand
     * task - one chat's work, cut the way the host cuts it (`wavesOf`,
     * then `splitWave`). A `Run:` task first is a step of its own. Named
     * in full on the button, so the reader sees every task the chat will
     * be given, not just the one it starts with.
     */
    const nextStep = useMemo(
        () => wavesOf(openWork.map(unit => ({ ...unit, wave: waveOf(unit.id, waves) })))
            .flatMap(wave => splitWave(wave))
            .find(step => step.some(unit => unit.id === nextUp?.id)) ?? [],
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [openWork.map(unit => unit.id).join(" "), waves, nextUp?.id]);

    /**
     * The chats an execution phase has open or on record in this
     * panel, one bucket each - `implement@wave:2`, `implement@1.4` -
     * newest last, the order they were opened. Several stay on record
     * (one per wave, each kept open to answer), so the Logs and AI
     * Session tabs show one at a time and a picker says which. A
     * document phase has none.
     */
    /**
     * The hidden gate behind the selected stage, when it is the
     * actionable one: its chats and notes are shown here, since it has
     * no tabs of its own.
     */
    const gateBehind = selected?.actionable ? hiddenGateAfter(specStages, selected.name) : undefined;

    const lanes = useMemo(
        () => {

            const owners = [selected?.name, gateBehind?.name].filter((name): name is string => name !== undefined);

            return Object.keys(logsByTask).filter(key => owners.some(name => key.startsWith(`${name}@`)));
        },
        [logsByTask, selected, gateBehind]);

    /** The lane picked by hand, per phase - `COMMON` for the phase's own lines. */
    const [pickedLanes, setPickedLanes] = useState<Record<string, string>>({});

    /** Picks a lane on the page of the phase it belongs to. */
    const setPickedLane = (lane: string) =>
        setPickedLanes(picks => ({ ...picks, [lane === COMMON ? selected?.name ?? "" : paneStageOf(lane)]: lane }));

    /**
     * What each phase showed the first time it was on screen: its newest
     * chat when it already had some, else its own lines.
     *
     * Written once per phase and never again. The picker does not work out "the newest chat" on every render: a chat that appeared later - a wave starting, or an old chat loaded after a revise - would take the screen over by itself. Only the reader changes the chat on screen.
     */
    const firstLanes = useRef<Record<string, string>>({});

    if (selected && firstLanes.current[selected.name] === undefined)
        firstLanes.current[selected.name] = lanes[lanes.length - 1] ?? COMMON;

    const wantedLane = selected ? pickedLanes[selected.name] ?? firstLanes.current[selected.name] : undefined;

    // `common` is the phase's own bucket. A lane that has gone - its
    // lines cleared - falls back to it rather than to another chat.
    const shownLane = wantedLane !== undefined && wantedLane !== COMMON && lanes.includes(wantedLane)
        ? wantedLane
        : undefined;

    const logLines = useMemo(
        () => {

            if (shownLane !== undefined)
                return logsByTask[shownLane]?.lines ?? [];

            // The gate's own notes - what started, what stopped short -
            // follow its drafting lines, in the order they arrived.
            const own = selected
                ? [...(logsByTask[selected.name]?.lines ?? []), ...(gateBehind ? logsByTask[gateBehind.name]?.lines ?? [] : [])]
                : [];

            if (own.length || (selected && logsByTask[selected.name]))
                return own;

            return Object.keys(logsByTask).some(key => specStages.some(stage => stage.name === key))
                ? []
                : Object.values(logsByTask).flatMap(task => task.lines);
        },
        [logsByTask, selected, specStages, shownLane, gateBehind]);

    /**
     * The picker over the lanes, for the two tabs that read them. The
     * panel's own lines - what started, what stopped short - stay under
     * the phase's plain name and are the first row, `common`.
     */
    const lanePicker = lanes.length > 0 && selected
        ? (
            <Select
                className="sdd-lanes"
                aria-label="Which chat these lines are from"
                sort={false}
                hideSearch={lanes.length < 8}
                items={[
                    { lane: COMMON, label: "common" },
                    ...lanes.map(lane => ({ lane, label: laneName(lane) }))
                ]}
                labelKey="label"
                valueKey="lane"
                value={shownLane ?? COMMON}
                onChange={lane => setPickedLane(String(lane))} />
        )
        : undefined;


    /**
     * The picker row a chat on record is, when this panel has its
     * lines - `implement@wave:2` for the chat filed under `wave:2`.
     */
    const laneOf = (chat: TaskSession) =>
        lanes.find(lane => lane.slice(lane.indexOf("@") + 1) === chat.task);

    /**
     * A chat, opened - what the session buttons on the task rows do. A
     * wave's chat is a normal session, and the page goes to it, with
     * the spec beside it.
     */
    const showChat = (chat: TaskSession) => openChat(chat);

    const logEntries = useMemo(
        () => logLines.map((line, index) => entryFromLine(line, index, selected?.name ?? "engine")),
        [logLines, selected]);

    /**
     * What each phase of this spec has charged, with each phase's chats
     * under it - the usage card's Totals table. See `phaseLines`.
     *
     * Worked out here rather than sent by the host because this is the
     * one place that holds every owner's lines at once - and because a
     * figure sent from the host would be whatever was on disk when it
     * was sent, while this one includes the turn that is billing right
     * now.
     */
    const phaseUsage = useMemo(
        () => phaseLines(
            specStages,
            logsByTask,
            owner => runDetail({ ownerId: owner, iteration: 0, current: false, at: 0 })),
        [logsByTask, specStages]);

    /**
     * The runs the sessions pane lists, in its order - see `paneRuns` -
     * and, for a phase whose conversation was cut, the one it would
     * start next.
     *
     * That last row is the whole reason this is not just `paneRuns`.
     * After New Session a phase has runs but no current one, and its
     * next conversation exists only as an empty compose box. Without a
     * row for it, opening an earlier run would be a one-way trip: the live
     * thread would have nothing to click back to.
     */
    const listedRuns = useMemo(
        () => withNextRun(
            paneRuns(sessionRuns ?? [], specStages),
            specStages,
            ownerId => logsByTask[ownerId]?.lines[0]?.at),
        [sessionRuns, specStages, logsByTask]);

    /**
     * A document phase whose conversation takes a typed message. Not the
     * execution phase (it has no thread of its own) and not a hidden
     * gate (nobody visits it).
     */
    const talksTo = (ownerId: string): SpecStage | undefined => {

        const stage = specStages.find(one => one.name === ownerId);

        return stage?.artifact && !stage.hidden ? stage : undefined;
    };

    /**
     * The run the sessions pane shows.
     *
     * A pick naming a run is that run; a pick naming only an owner is
     * that owner's live conversation, which `listedRuns` always has
     * a row for. Nothing picked yet: the phase drafting now, else the
     * newest run.
     */
    const paneRun = useMemo((): PaneRun | undefined => {

        if (!current)
            return undefined;

        // Always the phase selected on the left - never another one, so
        // New Session there can only start the phase you are looking at.
        // A pick for another phase is stale: picks move the left side
        // along with them (see `pointPane`), so it is left over from
        // before the selection changed.
        const picked = panePick && paneStageOf(panePick.ownerId) === current.name
            ? pickedRun(listedRuns, panePick)
            : undefined;

        const own = picked ?? pickedRun(listedRuns, { ownerId: current.name });

        if (own)
            return own;

        // A document phase nobody has run yet: an empty conversation to
        // type into. Anything
        // else with no session shows none.
        return talksTo(current.name)
            ? { ownerId: current.name, iteration: 1, current: true, at: Date.now(), note: "New session", pending: true }
            : undefined;

    }, [panePick, listedRuns, current?.name, specStages]);

    /**
     * Its lines: the panel's own log for a run it still holds, the
     * host's answer for an earlier one. Undefined while that answer is
     * on its way.
     */
    const paneLines: LogLine[] | undefined = !paneRun
        ? []
        : paneRun.current
            ? logsByTask[paneRun.ownerId]?.lines ?? []
            : sessionLines?.[runKey(paneRun)];

    const paneKey = paneRun ? runKey(paneRun) : undefined;

    // An earlier run is asked for once, when it is first shown. Its
    // lines never change, so the answer is kept for as long as the
    // panel is open.
    useEffect(() => {

        if (paneRun && !paneRun.current && sessionLines?.[runKey(paneRun)] === undefined)
            requestSessionLines?.(paneRun.ownerId, paneRun.iteration);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [paneKey, paneRun?.current]);

    const paneEntries = useMemo(
        () => (paneLines ?? []).map((line, index) => entryFromLine(line, index, paneRun?.ownerId ?? "engine")),
        [paneLines, paneRun?.ownerId]);

    /**
     * The phase with a question nobody has answered yet - read across
     * every phase's log, not only the one on screen. It marks the
     * phase's row in the sessions pane. It never moves the reader to
     * another phase.
     */
    const askingStage = useMemo(
        () => {

            for (const [name, log] of Object.entries(logsByTask)) {

                if (!specStages.some(stage => stage.name === name))
                    continue;

                if (hasOpenAsk(log.lines))
                    return name;
            }

            return undefined;
        },
        [logsByTask, specStages]);

    /**
     * The phases in the rail with a question or permission request
     * nobody has answered - the phase's own, or one from an
     * implementation chat, marked on the phase whose page holds that
     * chat (a hidden gate's chats are on the plan's page). The mark is
     * how a question in a phase you are not on gets seen, because the panel does not move you to it.
     *
     * A chat that has ended counts for nothing: its ask was left behind
     * unanswered, and nothing waits on it any more.
     */
    const waitingStages = useMemo(
        () => {

            const waiting = new Set<string>();

            for (const [owner, log] of Object.entries(logsByTask)) {

                if (!specStages.some(stage => stage.name === stageOf(owner)) || !hasOpenAsk(log.lines))
                    continue;

                const at = owner.indexOf("@");

                if (at >= 0) {

                    const chat = chats.find(entry => entry.task === owner.slice(at + 1));

                    if (!chat || chat.ended)
                        continue;
                }

                waiting.add(paneStageOf(owner));
            }

            return waiting;
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [logsByTask, specStages, chats]);

    // A question is answered in the phase chat, where it is asked. The
    // spec does not move the reader to it: the rail chip's waiting mark
    // says a question is there.

    /**
     * The phase on screen is the one drafting - so an empty log is a
     * log that has not started arriving, not a phase that never ran.
     *
     * The guard is not redundant: `draftingStage` is undefined when
     * nothing is running and `current` is undefined before a phase is
     * picked, and two undefineds match - an idle panel would otherwise
     * claim to be loading.
     */
    const logsLoading = draftingStage !== undefined && draftingStage === current?.name;

    // The phase the primary plugin would start: the parked gate's stage
    // when a run is waiting, otherwise the position - starting a phase
    // needs no run to be waiting, only the files.
    const boundary = gate?.stage ?? position?.name;

    // "starting design approves requirements.md" - the last document
    // that *exists* before the boundary. Existence matters: when design
    // was skipped (a gap in the phases), starting tasks approves
    // requirements.md, and naming the absent design.md would say the
    // press meant something it did not.
    const approves = useMemo(() => {

        if (!boundary)
            return undefined;

        const index = specStages.findIndex(stage => stage.name === boundary);

        return [...specStages.slice(0, index < 0 ? undefined : index)]
            .reverse()
            .find(stage => stage.artifact && stage.exists);
    }, [boundary, specStages]);

    const gateApproves = approves?.artifact ? fileName(approves.artifact) : undefined;

    /**
     * The plan is started by starting the execution phase, so what
     * blocks it is every drafting document - `tasks.md` included,
     * because the execution phase comes last and everything is before
     * it. See `openQuestionGate.ts`.
     */
    const blockedWork = blockedBy(specStages, planStage?.name, fileName);

    /**
     * The plan worked from its own page.
     *
     * When the document on screen is the plan the execution phase
     * reads, every checkbox row in it gets a live box and each unit of
     * work gets the same ▶ the implement lens gives it - so a plan is
     * started from where it is read, and nobody has to change phase to
     * press play.
     *
     * Rows are read from the text being rendered (`settled`), so a row
     * and its controls agree on the line even with an unsaved edit in
     * the document. What a ▶ starts, and what state it shows, comes
     * from the plan on disk (`units`), looked up by id: a row typed a
     * moment ago and not yet saved has a box but nothing to start.
     */
    // `planArtifact`, `inlinePlan` and `inlineRows` are declared above
    // the outline, which folds the plan's rows into itself.

    /** Every checkbox row of the rendered plan by its file line - groups included, since a group has a box too. */
    const inlineRowAt = useMemo(() => {

        const rows = new Map<number, { row: SpecTask; group: boolean }>();

        for (const task of allTasks(inlineRows))
            rows.set(task.line, { row: task, group: task.subtasks.length > 0 });

        return rows;

    }, [inlineRows]);

    const unitById = useMemo(() => new Map(units.map(unit => [unit.id, unit])), [units]);

    /**
     * A person's click on a box - the one write this product makes into
     * a plan by itself. Flipped in the draft so the box moves at once,
     * and written to disk unless the document already holds edits that
     * were not saved: then the tick joins them and Save writes both,
     * rather than a click on a checkbox quietly saving a half-finished
     * paragraph.
     */
    const toggleTask = (fileLine: number) => {

        if (artifact === undefined)
            return;

        const text = toggleCheckbox(draft, fileLine);

        if (text === draft)
            return;

        setDrafts(previous => ({ ...previous, [artifact]: text }));

        if (!dirty)
            saveDocument(artifact, text);
    };

    /** What is typed in each open question's answer box, by document and the question's place. */
    const [answers, setAnswers] = useState<Record<string, string>>({});

    /**
     * Writes an answer under an open question: an `**A:**`
     * line, saved at once like a ticked box. With unsaved edits it goes
     * into the draft instead, and is saved with them.
     */
    const answerOpen = (index: number) => {

        if (artifact === undefined)
            return;

        const key = `${artifact}#${index}`;
        const text = answerQuestion(draft, index, answers[key] ?? "");

        if (text === draft)
            return;

        setDrafts(previous => ({ ...previous, [artifact]: text }));
        setAnswers(previous => ({ ...previous, [key]: "" }));

        if (!dirty)
            saveDocument(artifact, text);
    };

    /**
     * The unanswered questions of the document on screen, each with a
     * box to answer it in. Only while the style blocks on them - the
     * panel sends `openQuestions` only then - and not while the whole
     * file is being edited, where the reader types the line by hand.
     */
    const questionBoxes = artifact !== undefined && !!docStage?.openQuestions?.length && !editing
        ? (
            <div className="sdd-questions" role="group" aria-label="Open questions">

                <div className="sdd-questions__head">
                    Open questions - answer each one to unblock the next phase
                </div>

                {questionsIn(draft).map((question, index) => question.answer !== undefined ? null : (
                    <div key={index} className="sdd-questions__item">

                        <div className="sdd-questions__text">
                            {question.id && <strong>{question.id} </strong>}
                            {question.text}
                        </div>

                        <div className="sdd-questions__answer">

                            <Textarea
                                rows={1}
                                aria-label={`Answer to ${question.id ?? `question ${index + 1}`}`}
                                placeholder="Type the answer"
                                value={answers[`${artifact}#${index}`] ?? ""}
                                onChange={event => {

                                    const value = event.target.value;

                                    setAnswers(previous => ({ ...previous, [`${artifact}#${index}`]: value }));
                                }}
                                onKeyDown={event => {

                                    if (event.key === "Enter" && !event.shiftKey) {

                                        event.preventDefault();
                                        answerOpen(index);
                                    }
                                }} />

                            <Button
                                size="sm"
                                variant="primary"
                                disabled={!(answers[`${artifact}#${index}`] ?? "").trim()}
                                title="Write this answer under the question in the document, as an A: line"
                                onClick={() => answerOpen(index)}>
                                Save answer
                            </Button>
                        </div>
                    </div>
                ))}
            </div>
        )
        : undefined;

    /**
     * A unit as the host is handed it: id, title, wave, and the plan's
     * own detail lines with the line they sit on - so the implement
     * prompt carries the whole task, not its title.
     */
    const handed = (unit: SpecTask) => ({
        id: unit.id,
        text: unit.text,
        wave: waveOf(unit.id, waves),
        line: unit.line,
        details: unit.details,
        ...(unit.run ? { run: unit.run } : {}),
        ...(unit.group !== undefined ? { group: unit.group } : {})
    });

    /**
     * What "Run till here" would hand over for a wave, or for one task
     * of it: the open work of the waves it waits for, then the wave (or
     * just the task). Tasks already in a chat or queued are left out -
     * they are being worked anyway. `manual` is the by-hand tasks on the
     * way: no chat can do those, so any one of them turns the button off.
     */
    const tillOf = (wave: number, only?: string) => {

        const order = units.map(unit => ({ id: unit.id, wave: waveOf(unit.id, waves), done: isTaskDone(unit), optional: unit.optional }));

        const path = tillHere(order, waves, wave, only);

        const free = (ids: string[]) => ids
            .map(id => unitById.get(id))
            .filter((unit): unit is SpecTask => unit !== undefined && !isWorking(unit.id) && !queuedTasks.includes(unit.id));

        const tasks = free(path.tasks);

        return {
            tasks,
            optional: free(path.optional).filter(unit => unit.run?.kind !== "manual"),
            manual: tasks.filter(unit => unit.run?.kind === "manual")
        };
    };

    /** A "Run till here" button's count, and why it is off when it is. */
    const tillFace = (wave: number, only?: string): TillFace => {

        const path = tillOf(wave, only);

        const why = busy
            ? "The panel is busy - wait for the work running now to finish"
            : blockedWork
            ?? (path.manual.length
                ? `Not yet - ${namesOf(path.manual.map(unit => unit.id))} ${path.manual.length === 1 ? "is a by-hand task" : "are by-hand tasks"} on the way. Do ${path.manual.length === 1 ? "it" : "them"}, tick the box, then this works`
                : path.tasks.length === 0
                ? "Nothing left to run - every task on the way is ticked or already in a chat"
                : undefined);

        return { count: path.tasks.length, why };
    };

    /** The "Run till here" press waiting on its question, and the optional tasks ticked in it. */
    const [tillAsk, setTillAsk] = useState<{ wave: number; only?: string } | undefined>(undefined);

    const [tillPicked, setTillPicked] = useState<string[]>([]);

    const askTill = (wave: number, only?: string) => {

        setTillPicked([]);
        setTillAsk({ wave, only });
    };

    /** The row's ▶: the same hand-over the implement lens's row makes. */
    const startUnit = (unit: SpecTask) => {

        startTasks([handed(unit)]);
        setLaunched(unit.id);
    };

    /**
     * Why these tasks may not start yet, or undefined when they may.
     *
     * The plan's order: a task starts only once every task of the
     * waves its wave waits for is ticked - or is in a chat or queued
     * ahead of it, which gets worked first. The host refuses the same press; this
     * only greys the button out so nobody has to press to find out.
     */
    const outOfOrder = (ids: string[]): string | undefined => {

        const order = units.map(unit => ({
            id: unit.id,
            wave: waveOf(unit.id, waves),
            done: isTaskDone(unit),
            optional: unit.optional
        }));

        const ahead = new Set(units.filter(unit => isWorking(unit.id) || queuedTasks.includes(unit.id)).map(unit => unit.id));

        const before = openBefore(order, ids, ahead, waves);

        return before.length
            ? `Not yet - the plan puts ${namesOf(before)} first, and ${before.length === 1 ? "it is" : "they are"} not ticked`
            : undefined;
    };


    /**
     * A Wave graph card's look and whether it may be pressed - the same
     * answer the Tasks tab's ▶ gets for the same task, said in words.
     */
    const graphFace = (unit: SpecTask): CardFace => {

        if (isTaskDone(unit))
            return {
                state: "done",
                // Ticked with no chat on record here: someone else's
                // work, pulled in with git, or a box ticked by hand.
                line: chatFor(unit.id) ? "done" : "done · no chat here",
                title: chatFor(unit.id)
                    ? "Done - the checkbox in tasks.md is ticked"
                    : "Done - the checkbox in tasks.md is ticked, but no chat in this panel worked it: ticked by hand, or by someone else and pulled in with git",
                canStart: false
            };

        if (isWorking(unit.id))
            return { state: "running", line: "running on this laptop", title: "An agent is working this task - it completes when the checkbox ticks", canStart: false };

        if (queuedTasks.includes(unit.id))
            return { state: "queued", line: "queued", title: "Queued - this starts when the work ahead of it is ticked", canStart: false };

        const early = outOfOrder([unit.id]);

        if (early !== undefined) {

            const order = units.map(one => ({ id: one.id, wave: waveOf(one.id, waves), done: isTaskDone(one), optional: one.optional }));

            const blockers = openBefore(order, [unit.id], new Set(), waves);

            const blocking = [...new Set(blockers.map(id => waveOf(id, waves)))]
                .filter((wave): wave is number => wave !== undefined)
                .sort((left, right) => left - right);

            return {
                state: "waiting",
                line: blocking.length
                    ? needsLabel(blocking).replace(/^after/, "waits for")
                    : "waits for earlier tasks",
                waits: blocking,
                title: early,
                canStart: false
            };
        }

        const held = busy ? "The panel is busy - wait for the work running now to finish" : blockedWork;

        return {
            state: "open",
            line: unit.run ? "Run step · can start now" : "can start now",
            title: held ?? (unit.run
                ? "Run this step - the engine runs it, not an agent"
                : "Start an agent chat for exactly this task - ticking its checkbox is its definition of done"),
            canStart: held === undefined
        };
    };

    return {
        planStage, planText, tasks, planLabel, units, unitsDone, launched, setLaunched, chats,
        chatFor, chatTasksOf, laneName, latestChat, openChat, isWorking, waves, implementing,
        yourTurn, doneIds, waveRows, runningWave, waveRowOf, tasksRef, goToRunningWave, pending,
        openWork, nextSteps, nextUp, nextStep, gateBehind, lanes, pickedLanes,
        setPickedLanes, setPickedLane, firstLanes, wantedLane, shownLane, logLines, lanePicker,
        laneOf, showChat, logEntries, phaseUsage, listedRuns, talksTo, paneRun, paneLines, paneKey,
        paneEntries, askingStage, waitingStages, logsLoading, boundary, approves,
        gateApproves, blockedWork, inlineRowAt, unitById, toggleTask, answers, setAnswers,
        answerOpen, questionBoxes, handed, tillOf, tillFace, tillAsk, setTillAsk, tillPicked,
        setTillPicked, askTill, startUnit, outOfOrder, graphFace
    } as const;
}

/** What useImplementState gives the parts after it. */
export type ImplementState = ReturnType<typeof useImplementState>;

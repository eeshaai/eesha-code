import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";

import { markTaskDone } from "../../core/agent/providers/planTools";
import { EnvService } from "../../core/env/envService";
import type { EventWriter } from "../../core/events/EventWriter";
import { sessionRuns } from "../../core/events/runEvents";
import { WORKFLOWS_SUBDIR } from "../../core/loader/constants";
import { namesOf, openBefore, stepsOf } from "../../shared/waveOrder";
import type { ToSddView } from "../../shared/sddMessages";
import type { TaskRun } from "../../shared/taskRun";
import type { AiPick } from "../config/sddConfig";
import type { DiscoveredSpec } from "../discovery/discover";
import { parsePlan, Plan } from "../documents/parsePlan";
import { isTerminal } from "../model/style";
import type { HandedTask } from "../phase/assemble";
import { runPhase } from "../phase/runPhase";
import { conflicts, planOrder, wavesOf } from "../phase/waves";
import { SddCore, WORKFLOWS_DIR } from "../SddCore";
import { providerOf } from "./aiArgs";
import { filesOfWave, Lane, laneBucket, laneRun, lanesOfWave, laneTask, portable } from "./lanes";
import type { PhaseChat, SddHost } from "./sddHost";
import { chatsWorking, endChatTask, rememberTaskSession } from "./taskSessions";
import { stageOf } from "../view/sessionRuns";

/*
 * The implementation phase of one spec: a plan's waves handed to agent
 * chats one at a time, in the plan's order, with `Run:` tasks, the wait
 * between sessions, "Stop after current session", and tasks done by
 * hand. Kept apart from SddController.ts so that file is not
 * one class for everything.
 *
 * It owns the lanes and what goes with them. What it needs from the
 * spec around it - the busy flag, the spec's history, the page, the
 * notices - it reaches through `ImplementOwner`, which the controller
 * gives it.
 */

/** What the implementation run needs from the spec controller. */
export interface ImplementOwner {

    readonly host: SddHost;
    readonly specName: string;

    /** The folder the agent, git and plan commands run in. */
    readonly workspace: string;

    /** The spec's history file. */
    readonly events: EventWriter;

    /** The spec is working - a phase or lanes. One thing at a time. */
    busy: boolean;

    /** The stage the busy flag was raised for. */
    busyStage: string | undefined;

    /** Stop was pressed - read by the plugin's cancel checks. */
    cancelRequested: boolean;

    /** Every way to stop what is starting now. */
    readonly phaseStops: Set<() => void>;

    /** A page shows the spec now. */
    readonly attached: boolean;

    post(message: ToSddView): void;
    note(text: string, stageId?: string): void;
    fail(text: string, stageId?: string): void;

    /** The spec read from disk now, or nothing when it is gone. */
    current(): Promise<{ core: SddCore; spec: DiscoveredSpec } | undefined>;

    /** Core with this runtime and model pick. */
    core(pick: AiPick): Promise<SddCore>;

    /** Draws the spec again. */
    send(): Promise<void>;

    /** The spec is done with - see `SddController.teardown`. */
    teardown(): void;

    /** A new phase chat for a run of `phase`, named after the spec and `label` - see `SddController.newChat`. */
    newChat(phase: string, label: string): Promise<PhaseChat | undefined>;

    postSessionRuns(): void;
    workflowFile(name: string): string | undefined;
}

/** What a lane's chat is called after the spec's name - "Wave 2", "Wave 2, part 2", "Task 1.4", "Tasks 1-3". */
function laneLabel(lane: Lane): string {

    const first = lane.wave[0];
    const waveId = first.wave;

    if (lane.wave.length === 1)
        return `Task ${first.id}`;

    if (waveId === undefined)
        return `Tasks ${first.id}-${lane.wave[lane.wave.length - 1].id}`;

    return lane.part && lane.part > 1 ? `Wave ${waveId}, part ${lane.part}` : `Wave ${waveId}`;
}

/** A plan that stopped at a chat: that chat's own lane, and the lanes queued behind it that were dropped. */
export interface StoppedPlan {
    readonly lane: Lane;
    readonly queued: readonly Lane[];
}

export class ImplementRun {

    /**
     * The implementation in flight - Next: Implementation, or a row's
     * ▶ - as lanes, one per wave. A lane is `running` once its chat is
     * open (`sessionId` is the chat), `queued` until its turn. One lane
     * runs at a time, in the plan's order: a later wave builds on the
     * code the earlier ones wrote, so it starts only once every earlier
     * task is ticked. `busy` holds while any lane is alive, which is
     * what refuses a revise of the plan while an agent is ticking its
     * boxes.
     */
    private lanes: Lane[] = [];

    /**
     * Plans that stopped at a chat, by that chat's session id: its own
     * lane, and the lanes that were queued behind it and dropped.
     *
     * A chat stops with a box unticked - a network drop, usually - and
     * the plan stops with it (see `laneEnded`). A message into that chat
     * (Retry, or anything typed) puts both back, so once the chat ticks
     * its boxes the plan carries on by itself rather than waiting for
     * ▶. Cleared by ▶ and Next, which each say what runs next. Stop
     * fills it for every chat it stops, so Resume undoes the Stop.
     */
    private readonly stranded = new Map<string, StoppedPlan>();

    /** The timer counting down to the next lane's start, while one is. */
    private nextLaneTimer: ReturnType<typeof setTimeout> | undefined;

    /** When the next lane starts, as `Date.now()` - for the view to count down. */
    private nextLaneAt: number | undefined;

    /**
     * The "Stop after current session" switch. On, the session running
     * now finishes and no queued one starts after it. Off again once the
     * lanes end, so it never carries into the next run.
     */
    private stopAfterCurrent = false;

    /** The next chat a lane starts is the one the page goes to - set by a press of ▶ or Next. */
    private followFirst = false;

    constructor(private readonly owner: ImplementOwner) { }

    // What the controller may read about the lanes. Each gives back a
    // lane or a yes/no, never the list itself, so only this class
    // changes which lanes there are.

    /** True while any lane is alive - running, starting or queued. */
    hasLanes(): boolean {
        return this.lanes.length > 0;
    }

    /** The stage the first lane files its lines under, or nothing when there are no lanes. */
    firstLaneStage(): string | undefined {
        return this.lanes[0]?.stageId;
    }

    /** The lane whose work runs in this phase chat, if one does. */
    laneOfChat(chatId: string): Readonly<Lane> | undefined {
        return this.lanes.find(one => one.chatId === chatId);
    }

    /** The lane whose chat's lines go under this bucket - `implement@wave:2` - if one is. */
    laneOfBucket(bucket: string): Readonly<Lane> | undefined {
        return this.lanes.find(one => laneBucket(one) === bucket);
    }

    /** True while this lane is still one of the lanes - not ended, dropped or stopped since it was read. */
    stillRuns(lane: Readonly<Lane>): boolean {
        return this.lanes.includes(lane as Lane);
    }

    /** True when a lane for this bucket waits its turn behind another. */
    hasQueuedLane(bucket: string): boolean {
        return this.lanes.some(lane => lane.state === "queued" && laneBucket(lane) === bucket);
    }

    /** The lanes whose chat is made and running - not `Run:` tasks, and not chats still being made. */
    openChatLanes(): Readonly<Lane>[] {
        return this.lanes.filter(lane => lane.state === "running" && !laneRun(lane) && lane.chatId);
    }

    /** The lanes still waiting their turn. */
    queuedLanes(): Readonly<Lane>[] {
        return this.lanes.filter(lane => lane.state === "queued");
    }

    /** Takes one lane off the run without redrawing or ending the run - for a chat handed over to another runtime. */
    removeLaneForHandover(lane: Readonly<Lane>): void {
        this.lanes = this.lanes.filter(one => one !== lane);
    }

    // The plans that stopped at a chat - see `stranded`. A chat is named
    // by its phase chat's id.

    /** True when the plan stopped at this chat, so a message into it carries the plan on. */
    isStoppedAt(chatId: string): boolean {
        return this.stranded.has(chatId);
    }

    /** The plan that stopped at this chat, if one did. */
    stoppedPlanAt(chatId: string): StoppedPlan | undefined {
        return this.stranded.get(chatId);
    }

    /** Forgets every plan that stopped at a chat. */
    forgetStoppedPlans(): void {
        this.strand(all => all.clear());
    }

    /** Remembers that the plan stopped at this chat, so a message into it can carry the plan on. */
    keepStoppedPlan(chatId: string, plan: StoppedPlan): void {
        this.strand(all => all.set(chatId, plan));
    }

    /**
     * Changes which chats a plan stopped at, and tells each chat whose
     * answer changed - its Resume button shows or goes.
     */
    private strand(change: (all: Map<string, StoppedPlan>) => void): void {

        const before = new Set(this.stranded.keys());

        change(this.stranded);

        for (const chatId of new Set([...before, ...this.stranded.keys()]))
            if (before.has(chatId) !== this.stranded.has(chatId))
                this.owner.host.resumeChanged(chatId);
    }

    /**
     * Puts back the plan that stopped at this chat: its lane runs again
     * and the lanes behind it are queued again. Replaces any lanes there
     * are, so call it only when there are none.
     */
    putBackStoppedPlan(chatId: string, plan: StoppedPlan): void {

        this.strand(all => all.delete(chatId));

        plan.lane.state = "running";
        plan.lane.waitsForTick = false;

        for (const queued of plan.queued)
            queued.state = "queued";

        this.lanes = [plan.lane, ...plan.queued];
    }

    /**
     * Hands tasks to agent sessions nobody waits on - one per wave.
     *
     * The same plugin every drafting phase runs on, with `detach` set,
     * so each session lands on whatever `provider:` the implement stage
     * is configured with. Not run *by* the engine even so, and this is
     * the honest shape of that: the style's implement prompt, with one
     * wave's tasks in it, opened in the user's own agent session. Git
     * is the record and the ticked checkbox is the completion signal.
     *
     * What the engine does own is the order. The plan's dependency
     * graph says which tasks share a wave; each wave is a lane, and the
     * lanes run one at a time, in the plan's order, because a later
     * wave builds on the code the earlier ones wrote. Nothing starts
     * while an earlier task is unticked: a ▶ on task 10 with task 1
     * open is refused, and says which tasks are in the way. A lane
     * whose chat stops with a box unticked ends there and takes every
     * lane queued behind it with it; pressing ▶ or Next again resumes
     * from the unticked box, because the checkboxes are the only
     * position there is.
     *
     * A ▶ while a lane runs queues behind it - allowed only when every
     * task before it is ticked or already in a lane ahead. Two presses
     * on the same task are two agents handed the same work, which is
     * never what anybody meant - so the panel asks before adding a
     * chat to work something a chat is already working.
     */
    async implement(tasks: HandedTask[]): Promise<void> {

        if (!tasks.length)
            return this.owner.note("Nothing to implement - every task is ticked.");

        // A drafting phase, not a lane: its agent is writing the very
        // document these tasks come from.
        if (this.owner.busy && !this.lanes.length)
            return this.owner.note("Already working - the panel takes one thing at a time.");

        // Set before the first await, so a second click that is already
        // in the queue finds it - the guard is against the double press,
        // which happens faster than any of this resolves.
        const first = !this.owner.busy;

        this.owner.busy = true;
        this.owner.cancelRequested = false;

        // ▶ or Next says what runs from here; a plan that stopped
        // earlier is not put back behind it.
        this.strand(all => all.clear());

        // The first chat this press starts is the one the page goes to.
        this.followFirst = true;

        try {

            const found = await this.owner.current();

            if (!found) {

                this.owner.fail(`'${this.owner.specName}' is no longer under the spec root.`);

                return this.endLanesIfIdle();
            }

            const implement = found.spec.state?.stages.find(stage => isTerminal(stage.stage));

            if (!implement) {

                this.owner.fail("This spec's style declares no implementation stage, so there is nothing to hand tasks to.");

                return this.endLanesIfIdle();
            }

            const stageId = implement.stage.id;

            // Already in a lane, running or queued: nothing to add. The
            // rest is checked against the chats on record.
            const held = new Set(this.lanes.flatMap(lane => lane.wave.map(task => task.id)));

            const fresh = tasks.filter(task => !held.has(task.id));

            if (!fresh.length) {

                this.owner.note("Every one of those tasks is already in a lane - running or waiting its turn.", stageId);

                return this.endLanesIfIdle();
            }

            const plan = this.plan(found.spec);

            // The plan's order, checked before anything else: a task
            // starts only once every task of the waves its wave waits
            // for is ticked - or is in a lane ahead of it, which will be
            // worked first. A hard stop, not a question: the order is
            // why the plan has waves.
            const before = openBefore(planOrder(plan), fresh.map(task => task.id), held, plan?.waves);

            if (before.length) {

                this.owner.fail(
                    `${fresh.length === 1 ? `Task ${fresh[0].id} cannot` : "These tasks cannot"} start yet - `
                    + `the plan puts ${namesOf(before)} before ${fresh.length === 1 ? "it" : "them"}, and `
                    + `${before.length === 1 ? "that is" : "those are"} not ticked. Nothing started.`,
                    stageId);

                return this.endLanesIfIdle();
            }

            if (!await this.confirmDuplicate(fresh, stageId))
                return this.endLanesIfIdle();

            this.owner.busyStage = stageId;
            this.owner.post({ type: "busy", stageId });

            const waves = wavesOf(fresh);

            // The plan's own `Files:` lines, checked before any chat
            // opens: two tasks of one wave naming the same path would
            // be two agents editing one file at once. The tasks phase
            // is told not to build such a wave; this is where the
            // engine stops trusting that it listened. Nothing starts -
            // the fix is a revise of the plan, and the message says
            // which tasks and which path.
            const filesOf = (id: string) => plan?.tasks.find(task => task.id === id)?.files ?? [];

            // Agent tasks only: a `Run:` task is not an agent editing
            // files, so it cannot be one of two agents on one file. And
            // only the plan's own waves: a plan with no graph is one
            // chat working its tasks one after another (see `wavesOf`),
            // and two of them naming one file is just the next task
            // picking up where the last one left off.
            const unsafe = waves
                .filter(wave => wave[0]?.wave !== undefined)
                .map(wave => conflicts(wave.filter(task => !task.run), filesOf))
                .flat();

            if (unsafe.length) {

                this.owner.fail(
                    "The plan puts tasks that touch the same file in one wave: "
                    + unsafe.map(one => `${one.tasks.join(" and ")} both name '${one.path}'`).join("; ")
                    + ". Nothing started - revise the plan so they sit in different waves.",
                    stageId);

                return this.endLanesIfIdle();
            }

            for (const wave of waves)
                this.lanes.push(...lanesOfWave(stageId, wave));

            if (first && waves.length > 1)
                this.owner.note(
                    `${waves.length} waves handed over - one at a time, each starting once every task of the waves it waits for is ticked.`,
                    stageId);

            await this.startFreeLanes(found);

        } catch (error) {

            // Catches what `startLane`'s own try does not: reading the
            // spec, resolving its style. Without it a failure there is
            // an unhandled rejection inside a `void` call - which is
            // exactly the shape of a click that did nothing and said
            // nothing.
            this.owner.fail((error as Error).message);
            this.endLanes();
        }
    }

    /**
     * Starts the next queued lane when none is running: the one earliest
     * in the plan, and only once every task before it is ticked on disk.
     * If one is not, nothing queued can start - they are all later - so
     * the queue is dropped and the note names what is in the way.
     * Called when lanes are added and when one ends.
     */
    private async startFreeLanes(found: { core: SddCore; spec: DiscoveredSpec }): Promise<void> {

        // A ▶ pressed during the wait between sessions starts the next
        // one now; the timer would only find it already running.
        this.cancelNextLaneTimer();

        while (!this.lanes.some(lane => lane.state !== "queued")) {

            const queued = this.lanes.filter(lane => lane.state === "queued");

            if (!queued.length)
                break;

            // Read now, not when the lanes were queued: the chat before
            // this one has been ticking boxes since.
            const plan = this.plan(found.spec);

            const order = planOrder(plan);

            const steps = stepsOf(order);

            const stepOf = (lane: Lane) =>
                Math.min(...lane.wave.map(task => steps.get(task.id) ?? Number.MAX_SAFE_INTEGER));

            // Stable, so lanes the plan cannot place keep the order they came in.
            const sorted = [...queued].sort((left, right) => stepOf(left) - stepOf(right));

            const blockers = (lane: Lane) => openBefore(order, lane.wave.map(task => task.id), new Set(), plan?.waves);

            // The earliest lane that may start. With every wave waiting
            // for the one before it, that is the earliest lane or none;
            // with branches, a lane on one branch is not held back by an
            // unticked task on another.
            const next = sorted.find(lane => !blockers(lane).length) ?? sorted[0];

            const before = blockers(next);

            if (before.length) {

                this.lanes = this.lanes.filter(lane => lane.state !== "queued");

                this.owner.note(
                    `${namesOf(queued.flatMap(lane => lane.wave.map(task => task.id)))} will not start - `
                    + `${namesOf(before)} ${before.length === 1 ? "is" : "are"} not ticked, and the plan puts `
                    + `${before.length === 1 ? "it" : "them"} first. Press ▶ or Next again once ${before.length === 1 ? "it is" : "they are"} done.`,
                    next.stageId);

                break;
            }

            next.state = "starting";

            await this.startLane(found, next);
        }

        this.postLanes();
        this.endLanesIfIdle();
    }

    /** Which tasks are waiting their turn, for the rows to say so. */
    postLanes(): void {

        this.owner.post({
            type: "lanes",
            queued: this.lanes.filter(lane => lane.state === "queued").flatMap(lane => lane.wave.map(task => task.id)),
            waiting: this.lanes.filter(lane => lane.waitsForTick).map(lane => lane.wave[0].id),
            stopAfterCurrent: this.stopAfterCurrent,
            ...(this.nextLaneAt !== undefined
                ? { nextStartsIn: Math.max(0, Math.ceil((this.nextLaneAt - Date.now()) / 1000)) }
                : {})
        });
    }

    /** The "Stop after current session" switch, from the view. Only means something while lanes run. */
    setStopAfterCurrent(on: boolean): void {

        this.stopAfterCurrent = on && this.lanes.length > 0;

        // Pressed during the wait between sessions: the wait is the
        // gap the switch is about, so nothing more starts.
        if (this.stopAfterCurrent && this.nextLaneTimer !== undefined)
            return this.stopBeforeNextLane();

        this.postLanes();
    }

    /**
     * The wait between one session and the next - `seconds` is
     * `sdd.nextSessionDelaySeconds` from settings.json. Stop during it
     * ends the lanes, which clears the timer; when it runs out the next
     * queued lane starts.
     */
    private startNextLaneTimer(seconds: number): void {

        this.cancelNextLaneTimer();

        this.nextLaneAt = Date.now() + seconds * 1000;

        const next = this.lanes.filter(lane => lane.state === "queued").flatMap(lane => lane.wave.map(task => task.id));

        this.owner.note(
            `Next session (${namesOf(next)}) starts in ${seconds} seconds - press Stop to keep it from starting.`,
            this.lanes[0]?.stageId);

        this.nextLaneTimer = setTimeout(() => {

            this.nextLaneTimer = undefined;
            this.nextLaneAt = undefined;

            void (async () => {

                try {

                    // Stop pressed, or the panel let go, while it waited.
                    if (!this.lanes.length)
                        return;

                    const found = await this.owner.current();

                    if (!found) {

                        this.owner.fail(`'${this.owner.specName}' is no longer under the spec root.`);

                        return this.endLanes();
                    }

                    await this.startFreeLanes(found);

                } catch (error) {

                    this.owner.fail((error as Error).message, this.lanes[0]?.stageId);
                    this.endLanes();
                }
            })();
        }, seconds * 1000);

        this.postLanes();
    }

    cancelNextLaneTimer(): void {

        if (this.nextLaneTimer !== undefined)
            clearTimeout(this.nextLaneTimer);

        this.nextLaneTimer = undefined;
        this.nextLaneAt = undefined;
    }

    /** "Stop after current session" took effect: the queued lanes are dropped, and the note says which. */
    private stopBeforeNextLane(): void {

        this.cancelNextLaneTimer();

        const queued = this.lanes.filter(lane => lane.state === "queued");

        this.lanes = this.lanes.filter(lane => !queued.includes(lane));

        if (queued.length)
            this.owner.note(
                `Stopped after the current session - ${namesOf(queued.flatMap(lane => lane.wave.map(task => task.id)))} `
                + "did not start. Press ▶ or Next again to carry on.",
                queued[0].stageId);

        this.postLanes();
        this.endLanesIfIdle();
    }

    /**
     * Every lane is gone - ticked through, stopped short, or Stop
     * pressed. Lets go of the busy state the lanes held, and redraws
     * for whoever is looking. Safe to call twice.
     */
    endLanes(): void {

        this.lanes = [];
        this.cancelNextLaneTimer();
        this.stopAfterCurrent = false;
        this.owner.busy = false;
        this.owner.busyStage = undefined;
        this.owner.phaseStops.clear();
        this.owner.post({ type: "busy" });
        this.postLanes();

        // Attached: redraw for whoever is looking at it. Not: the tab
        // that was here closed mid-lane (see `SddController.detach`), which
        // held this instance open only for this - now that the lanes
        // are done, there is nothing left to watch.
        if (this.owner.attached)
            void this.owner.send();
        else
            this.owner.teardown();
    }

    /** `endLanes`, but only when nothing is running or waiting any more. */
    private endLanesIfIdle(): void {

        if (!this.lanes.length)
            this.endLanes();
    }

    /**
     * Opens the chat for one lane and records it: the phase's one
     * Implementation chat - a normal session - made by the first wave
     * and used again by every later one. Returns once the chat
     * is made and its turn handed to it; the turn's end is the lane's
     * end - see `runLaneTurn`.
     */
    private async startLane(found: { core: SddCore; spec: DiscoveredSpec }, lane: Lane): Promise<void> {

        if (laneRun(lane))
            return this.startRunLane(found, lane);

        const { stageId, wave } = lane;

        // The run's name in the spec's record - `implement@wave:2`,
        // `implement@1.4` - and the phase the chat was made for.
        const bucket = laneBucket(lane);

        try {

            // The tasks go in with the request and come out inside the
            // prompt, where the style's own `prompts/implement.md` puts
            // them. Nothing is glued on here: every sentence the agent
            // reads is in a file somebody can reword.
            const request = await found.core.phase(found.spec, stageId, undefined, wave);

            // One chat for the whole phase: a later wave goes on in the
            // chat the earlier ones ran in, so the phase is one
            // conversation. A new chat only for the first wave, or when
            // that chat is gone or busy.
            const chat = this.phaseChat(stageId) ?? await this.owner.newChat(bucket, request.stage.label);

            if (!chat) {

                this.owner.fail(`The session for ${laneLabel(lane).toLowerCase()} could not be made.`, stageId);

                return this.dropLane(lane);
            }

            lane.chatId = chat.chatId;

            // A new chat for this work is a new run of the bucket: the run
            // before it is cut off, and the start names the chat, which the
            // spec's sessions and the spec's ⋯ menu read.
            this.owner.events.control("restart", bucket);
            this.owner.events.control("start", bucket, { chatId: chat.chatId });
            this.owner.postSessionRuns();

            // Filed against the work it was handed, which is what lets
            // the lens offer the chat from each row and from the wave
            // strip, and what the duplicate check reads next time. One
            // task is filed under its own id; a wave under the wave's
            // name, with every task in it listed. The runtime's
            // conversation is added when the turn ends.
            await rememberTaskSession(this.owner.host.store, this.owner.specName, {
                task: laneTask(lane),
                tasks: wave.map(task => task.id),
                chatId: chat.chatId,
                provider: providerOf(request.ai.args),
                at: Date.now()
            });

            // Stop pressed while the chat was being made. The chat is
            // real and recorded above, so it can still be opened; the
            // lane it was part of is over.
            if (!this.lanes.includes(lane))
                return;

            lane.state = "running";

            await this.owner.send();

            // The press that started the run moves the page to its first
            // chat. Waves started after it by the run itself do not: the
            // person may be reading something else by then.
            if (this.followFirst) {

                this.followFirst = false;
                this.owner.post({ type: "phaseChat", stageId, chatId: chat.chatId });
            }

            const waiting = this.lanes.filter(one => one.state === "queued").length;

            this.owner.note(
                `Started ${laneLabel(lane).toLowerCase()}${wave.length > 1 ? ` (${wave.length} tasks)` : ""}`
                + (waiting ? ` - ${waiting} more step${waiting === 1 ? "" : "s"} waiting.` : "."),
                stageId);

            void this.runLaneTurn(found, lane, chat, request);

        } catch (error) {

            this.owner.fail((error as Error).message, stageId);
            this.dropLane(lane);
        }
    }

    /**
     * The chat this execution phase ran its waves in: the newest one on
     * the spec's record, when it is still there and idle. Nothing: the
     * first wave, or the chat was deleted, or it is working.
     */
    private phaseChat(stageId: string): PhaseChat | undefined {

        const newest = sessionRuns(this.owner.events.read())
            .filter(run => run.chatId !== undefined && run.ownerId.includes("@") && stageOf(run.ownerId) === stageId)
            .reduce<{ chatId?: string; at: number } | undefined>((best, run) => !best || run.at >= best.at ? run : best, undefined);

        const chat = newest?.chatId ? this.owner.host.phaseChat(newest.chatId) : undefined;

        return chat && !chat.working ? chat : undefined;
    }

    /**
     * The lane's turn in its chat, to its end: the same call a drafting
     * phase makes, run in the chat, which writes the conversation down
     * and draws it. Then the plan's checkboxes say what comes next - see
     * `laneEnded`.
     */
    private async runLaneTurn(found: { core: SddCore; spec: DiscoveredSpec }, lane: Lane, chat: PhaseChat, request: Awaited<ReturnType<SddCore["phase"]>>): Promise<void> {

        const bucket = laneBucket(lane);

        let failed: string | undefined;

        try {

            const outcome = await runPhase(
                {
                    request,
                    keep: true,
                    specId: found.spec.path,
                    workspace: this.owner.workspace,
                    runId: `sdd:${found.spec.path}`,
                    processEnv: EnvService.machine(),

                    // The chat ticks its boxes through `task_done` - one
                    // character in this file, never the file through the
                    // model.
                    plan: this.planPath(found.spec),

                    // The wave's own `Files:` lines, so a `fileMatch`
                    // steering file for those paths comes with the chat.
                    files: filesOfWave(this.plan(found.spec), lane.wave),

                    via: (call, check) => chat.runOwned(call, check)
                },
                this.owner.host.plugins(),
                () => true);

            if (!outcome.success)
                failed = outcome.message ?? "The chat's turn did not complete.";

        } catch (error) {

            failed = (error as Error).message;
        }

        // The conversation the turn opened, on the run's record and on
        // the chat's task record - so a later look can find it.
        const held = chat.held();

        if (held) {

            lane.sessionId = held.sessionId;
            this.owner.events.session(bucket, held.sessionId, held.provider, held.model);
        }

        this.owner.events.control("end", bucket, { status: failed ? "failed" : "success", ...(failed ? { text: failed } : {}) });

        await endChatTask(this.owner.host.store, this.owner.specName, chat.chatId, held);

        this.owner.postSessionRuns();

        // Stop pressed, or the lanes ended, while it ran: what comes
        // next is not this turn's call.
        if (!this.lanes.includes(lane))
            return void await this.owner.send();

        // The chat says why in its own thread; the spec says it too.
        if (failed && !this.owner.cancelRequested)
            this.owner.note(failed, lane.stageId);

        await this.owner.send();
        await this.laneEnded(lane);
    }

    /**
     * Starts a `Run:` task in its place in the plan.
     *
     * - By hand: nothing runs. The lane waits for a person to tick the
     *   box; the folder watcher hears the tick (see `tickedByHand`).
     * - A command: run by the host (in a shell, with its output in the
     *   Logs tab). Exit 0 ticks the box;
     *   anything else leaves it unticked and stops what is queued. When
     *   the host cannot report an exit code, the lane waits for a tick
     *   by hand, as for a task done by hand.
     * - A workflow: started through the run panel, the same as the
     *   row's own button. Green ticks the box; red, or params not
     *   answered, leaves it unticked and stops what is queued.
     *
     * Returns once the task is started; its end is handled on its own.
     */
    private async startRunLane(found: { core: SddCore; spec: DiscoveredSpec }, lane: Lane): Promise<void> {

        const task = lane.wave[0];
        const run = laneRun(lane)!;

        lane.state = "running";

        if (run.kind === "manual") {

            lane.waitsForTick = true;
            this.postLanes();

            this.owner.note(`Task ${task.id} is done by hand - press "Mark ${task.id} as Done", or tick its box, when it is. The next task waits for that.`, lane.stageId);

            return;
        }

        const outcome = run.kind === "command"
            ? this.runLaneCommand(found, lane, run.command)
            : this.runLaneWorkflow(found, task, run);

        this.owner.note(
            run.kind === "command"
                ? `Task ${task.id}: running \`${run.command}\`.`
                : `Task ${task.id}: running the workflow '${run.name}'.`,
            lane.stageId);

        void outcome
            .then(result => this.runLaneEnded(lane, result))
            .catch(error => {

                this.owner.fail((error as Error).message, lane.stageId);
                return this.runLaneEnded(lane, { ok: false, why: "it could not be started" });
            });
    }

    /**
     * A plan's command in the spec's folder: it runs with no terminal
     * on screen, so what it prints goes to the implementation's Logs tab
     * and Stop ends it. Answers whether it exited 0, or `undefined` when
     * the host cannot say (it was stopped), in which case the person
     * ticks the box.
     */
    private async runLaneCommand(
        found: { spec: DiscoveredSpec },
        lane: Lane,
        command: string): Promise<{ ok: boolean; why?: string } | undefined> {

        const cwd = this.owner.host.folderOf(found.spec.folder) ?? this.owner.workspace;

        let stop: (() => void) | undefined;

        const exitCode = await this.owner.host.runInTerminal(cwd, command, {
            output: text => this.owner.post({ type: "log", stageId: lane.stageId, text, stream: "stdout" }),
            onStop: kill => {

                stop = kill;
                this.owner.phaseStops.add(kill);
            }
        }).finally(() => {

            if (stop)
                this.owner.phaseStops.delete(stop);
        });

        if (exitCode === undefined)
            return undefined;

        return exitCode === 0 ? { ok: true } : { ok: false, why: `it exited with code ${exitCode}` };
    }

    /** A plan's workflow, started the way the row's button starts it. Answers whether it went green. */
    private async runLaneWorkflow(
        found: { spec: DiscoveredSpec },
        task: HandedTask,
        run: Extract<TaskRun, { kind: "workflow" }>): Promise<{ ok: boolean; why?: string }> {

        const file = this.owner.workflowFile(run.name);

        if (!file)
            return { ok: false, why: `there is no workflow named '${run.name}' under ${WORKFLOWS_DIR}/${WORKFLOWS_SUBDIR}` };

        const specFolder = portable(found.spec.folder, this.owner.workspace);

        const files = filesOfWave(this.plan(found.spec), [task]);

        const green = await this.owner.host.runWorkflow(
            file,
            run.name,
            {
                spec: specFolder,
                task: task.id,
                taskTitle: task.text,
                ...(task.group !== undefined ? { group: task.group } : {}),
                files,
                repos: [...new Set(files.map(one => one.split("/")[0]).filter(Boolean))],
                ...run.args
            });

        if (green === undefined)
            return { ok: false, why: "it did not run - it was already running, or its params were not answered" };

        return green ? { ok: true } : { ok: false, why: "the workflow failed" };
    }

    /**
     * A command or workflow lane finished. Success ticks the task's box
     * and the plan moves on; failure leaves it unticked and stops what is
     * queued. `undefined` - a command whose exit code the terminal could
     * not report - keeps the lane waiting for a tick by hand.
     */
    private async runLaneEnded(lane: Lane, result: { ok: boolean; why?: string } | undefined): Promise<void> {

        // Stop pressed, or the lanes ended some other way, while it ran.
        if (!this.lanes.includes(lane))
            return;

        const task = lane.wave[0];

        if (result === undefined) {

            lane.waitsForTick = true;

            // Ticked by hand while the command ran: nothing left to wait for.
            await this.tickedByHand();

            if (!this.lanes.includes(lane))
                return;

            this.postLanes();

            this.owner.note(`The terminal cannot say whether task ${task.id}'s command worked - press "Mark ${task.id} as Done", or tick its box, when it did. The next task waits for that.`, lane.stageId);

            return;
        }

        const found = await this.owner.current();

        const planPath = found ? this.planPath(found.spec) : undefined;

        if (result.ok && planPath)
            markTaskDone(planPath, { task: task.id });

        if (!result.ok)
            this.owner.note(`Task ${task.id} did not finish - ${result.why}. Its box stays unticked.`, lane.stageId);

        await this.laneEnded(lane);
    }

    /**
     * Mark done, pressed on a task the plan waits on a person for: ticks
     * its box, the same one-character change `task_done` makes, then
     * moves the plan on without waiting for the folder watcher. A task
     * no lane waits on is left alone - the button only exists for one.
     */
    async markDone(taskId: string): Promise<void> {

        const lane = this.lanes.find(one => one.waitsForTick && one.wave[0].id === taskId);

        if (!lane)
            return;

        const found = await this.owner.current();

        const planPath = found ? this.planPath(found.spec) : undefined;

        if (!planPath)
            return this.owner.fail(`Could not find the plan to tick task ${taskId} in.`, lane.stageId);

        const said = markTaskDone(planPath, { task: taskId });

        if (!said.startsWith("Ticked") && !said.includes("already ticked"))
            return this.owner.fail(said, lane.stageId);

        await this.tickedByHand();
    }

    /**
     * The folder watcher saw a document change: a lane waiting on a
     * person's tick moves on once its task is ticked.
     */
    async tickedByHand(): Promise<void> {

        const waiting = this.lanes.filter(lane => lane.waitsForTick);

        if (!waiting.length)
            return;

        const found = await this.owner.current();

        if (!found)
            return;

        const ticked = this.ticked(found.spec);

        for (const lane of waiting)
            if (lane.waitsForTick && this.lanes.includes(lane) && ticked.has(lane.wave[0].id)) {

                // Cleared before the await, so a second watcher event
                // for the same save does not end the lane twice.
                lane.waitsForTick = false;

                await this.laneEnded(lane);
            }
    }

    /** A lane that is over, whichever way. The others carry on. */
    private dropLane(lane: Lane): void {

        this.lanes = this.lanes.filter(one => one !== lane);
        this.postLanes();
        this.endLanesIfIdle();
    }

    /**
     * A lane's chat went idle. What decides the next step is the plan
     * on disk, not the agent's word: every task of the wave ticked
     * means the lane is done and the next one may start; anything
     * unticked means no lane queued behind it starts, and the note
     * says which task. A plan can be
     * abandoned with a box unticked, and rolling on over it is the one
     * thing the instructions tell the agent never to do - so the panel
     * does not either.
     */
    async laneEnded(lane: Lane): Promise<void> {

        try {

            const found = await this.owner.current();

            if (!found) {

                this.owner.fail(`'${this.owner.specName}' is no longer under the spec root.`);

                return this.endLanes();
            }

            // The disk's own account of the wave, beside the agent's
            // `## Changed` in its reply. Read-only, and only where the
            // repository is one: a workspace with no git, or no git on
            // the machine, gets no line rather than an error.
            // A chat's lane only: a `Run:` task says for itself how it went.
            if (!laneRun(lane))
                await this.reportWorkingTree(lane.stageId);

            const ticked = this.ticked(found.spec);

            const unticked = lane.wave.filter(task => !ticked.has(task.id)).map(task => task.id);

            this.lanes = this.lanes.filter(one => one !== lane);

            // Now, not after the next chat opens: a task done by hand
            // would say "your turn" for as long as that takes.
            this.postLanes();

            if (unticked.length) {

                // Everything queued comes after it in the plan, so
                // nothing queued can start over it.
                const blocked = this.lanes.filter(one => one.state === "queued");

                this.lanes = this.lanes.filter(one => !blocked.includes(one));

                // Kept, so a message into this chat can pick the plan
                // back up - see `stranded`. A `Run:` task has no chat.
                if (lane.chatId && !laneRun(lane))
                    this.strand(all => all.set(lane.chatId!, { lane, queued: blocked }));

                this.owner.note(
                    (laneRun(lane)
                        ? `Task ${unticked[0]} is not ticked, so the plan stops here.`
                        : `The agent stopped with ${unticked.join(", ")} unticked - the chat says what blocked it.`)
                    + (blocked.length
                        ? ` ${namesOf(blocked.flatMap(one => one.wave.map(task => task.id)))} waited on it and will not start yet.`
                        : "")
                    + (this.stranded.has(lane.chatId ?? "")
                        ? " Press Resume in the chat, or send it a message, and the plan carries on once its boxes are ticked"
                            + " - or press ▶ or Next again to resume from there."
                        : " Press ▶ or Next again to resume from there once it is sorted."),
                    lane.stageId);

            } else if (!this.lanes.length)
                this.owner.note("Every task handed over is ticked.", lane.stageId);

            const anotherQueued = this.lanes.some(one => one.state === "queued")
                && !this.lanes.some(one => one.state !== "queued");

            // Between sessions: the switch stops here, or the next one
            // waits the seconds settings.json gives, so Stop can still
            // be pressed. 0 means no wait.
            if (anotherQueued && this.stopAfterCurrent)
                return this.stopBeforeNextLane();

            const delay = found.core.config.nextSessionDelaySeconds;

            if (anotherQueued && delay > 0)
                return this.startNextLaneTimer(delay);

            await this.startFreeLanes(found);

        } catch (error) {

            this.owner.fail((error as Error).message, lane.stageId);
            this.endLanes();
        }
    }

    /**
     * The plan, read from disk now.
     *
     * It is the last document before the implement stage that exists -
     * `tasks.md` in the shipped style, whatever a style of your own
     * calls it. Undefined when there is none.
     */
    private plan(spec: DiscoveredSpec): Plan | undefined {

        const file = this.planPath(spec);

        return file && fs.existsSync(file) ? parsePlan(fs.readFileSync(file, "utf8")) : undefined;
    }

    /**
     * Where the plan is on disk, absolute - the stage marked actionable,
     * else the last document before the implement stage that exists.
     * Undefined when there is none yet.
     */
    private planPath(spec: DiscoveredSpec): string | undefined {

        const stages = spec.state?.stages ?? [];
        const at = stages.findIndex(stage => isTerminal(stage.stage));
        const before = at < 0 ? stages : stages.slice(0, at);

        const plan = before.find(stage => stage.stage.actionable)?.present[0]
            ?? [...before].reverse().find(stage => stage.present.length)?.present[0];

        return plan ? path.join(spec.folder, plan) : undefined;
    }

    /**
     * What a turn typed into a wave chat gets: the plan, so it can tick
     * its boxes, and the paths its tasks' `Files:` lines name.
     */
    turnFiles(spec: DiscoveredSpec, taskIds: readonly string[]): { plan?: string; files: string[] } {

        const plan = this.planPath(spec);

        return { ...(plan ? { plan } : {}), files: filesOfWave(this.plan(spec), taskIds.map(id => ({ id }))) };
    }

    /**
     * The tasks a wave chat was handed, read from the plan now - what
     * the implementation phase's prompt lists. A typed turn in a wave
     * chat is built on that prompt. A task the plan no longer has is
     * left out.
     */
    handedTasks(spec: DiscoveredSpec, taskIds: readonly string[]): HandedTask[] {

        const plan = this.plan(spec);

        return taskIds.flatMap(id => {

            const task = plan?.tasks.find(one => one.id === id);

            if (!task)
                return [];

            const wave = plan?.waves?.find(one => one.tasks.includes(id))?.id;

            return [{ id, text: task.title, line: task.line, ...(wave !== undefined ? { wave } : {}) }];
        });
    }

    /** The ids ticked in the plan on disk. No plan means nothing is ticked. */
    private ticked(spec: DiscoveredSpec): Set<string> {

        return new Set((this.plan(spec)?.tasks ?? []).filter(task => task.done).map(task => task.id));
    }

    /**
     * One log line with `git status --short` of the workspace - what
     * the working tree holds now that the wave's chat has stopped.
     *
     * Not a verdict: the engine judges nothing here, and a clean tree
     * is reported as such. Skipped without a word when git is not
     * there or the workspace is not a repository.
     */
    private reportWorkingTree(stageId: string): Promise<void> {

        return new Promise(resolve => {

            execFile("git", ["status", "--short"], { cwd: this.owner.workspace, windowsHide: true }, (error, stdout) => {

                if (!error)
                    this.owner.post({
                        type: "log",
                        stageId,
                        text: `Working tree (git status --short):\n${stdout.trim() || "  clean"}\n`,
                        stream: "system"
                    });

                resolve();
            });
        });
    }

    /**
     * Asks before handing the same work to a second agent.
     *
     * The panel cannot know whether an earlier chat is still alive - it
     * was handed over, and nothing reports back. What it does know is
     * that one was started for this work, which is enough to ask rather
     * than to either block a legitimate restart or duplicate silently.
     */
    private async confirmDuplicate(tasks: { id: string }[], stageId: string): Promise<boolean> {

        const working = chatsWorking(this.owner.host.store, this.owner.specName, tasks.map(task => task.id));

        if (!working.length)
            return true;

        const what = tasks.length === 1 ? `task ${tasks[0].id}` : `these ${tasks.length} tasks`;

        const choice = await this.owner.host.choose(
            `A chat was already started for ${what}.`,
            "Starting another gives two agents the same work in the same repository.",
            ["Open that chat", "Start another"]);

        if (choice === "Start another")
            return true;

        // Dismissing the dialog is a decision, and the panel says so.
        // A click that quietly does nothing is indistinguishable from a
        // broken button.
        if (choice === "Open that chat") {

            // A wave chat is a normal session: the page goes to it.
            if (working[0].chatId)
                this.owner.post({ type: "phaseChat", stageId, chatId: working[0].chatId });
            else if (working[0].sessionId)
                await this.owner.host.openSession(working[0].sessionId);

            this.owner.note(`Reopened the chat already working ${what} - no new session started.`, stageId);

        } else

            this.owner.note(`Cancelled - a chat was already started for ${what}.`, stageId);

        return false;
    }
}

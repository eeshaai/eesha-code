import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { unansweredQuestions } from "../documents/openQuestions";
import { DiscoveredSpec } from "../discovery/discover";
import { isIdea, isTerminal, lockOf, NativeTool, Preset, Stage, StageFile, Style } from "../model/style";
import { presetsFor } from "../phase/presets";
import type { HandedTask } from "../phase/assemble";
import { hasContent } from "../../core/loader/hasContent";
import { logger } from "../../core/logging/logger";
import { runPhase } from "../phase/runPhase";
import { attachmentsToSend, recordSent, sha1Of } from "../phase/resend";
import { STYLES_DIR } from "../registry/NodeStyleFiles";
import { SddCore, WORKFLOWS_DIR } from "../SddCore";
import { revisableStages } from "../state/pipelineState";
import { OpenQuestionRef, SpecStage, StageAi } from "../../shared/runMessages";
import { PanelWidths, SpecMessage, ToPanel, ToSddView } from "../../shared/sddMessages";
import { ReviewNote } from "../../view/templates/reviewNotes";
import { baseline, readNotes, snapshot, writeNotes } from "./reviewStore";
import { EnvService } from "../../core/env/envService";
import { endChatTask, reopenChatTask, taskSessions } from "./taskSessions";
import { EventWriter } from "../../core/events/EventWriter";
import { specEventsPath } from "../../core/events/eventFile";
import { RunEvent, currentChat, currentEvents, lastSession, lineFrom, sessionRuns, sessionToContinue, supersededSpend } from "../../core/events/runEvents";
import { loadEngineSettings } from "../../core/settings/engineSettings";
import { profileDirectory } from "../../core/loader/profilePaths";
import { AiPick, aiSourcesFor, StyleOrigin } from "../config/sddConfig";
import type { AgentAttachment } from "../../core/agent";
import { aiChoiceMessage, modelsOf, readAiPick, refreshModels, writeAiPick } from "../../chat/aiChoice";
import { type SavedAnswer } from "../../core/models/permissionCard";
import type { AiChoiceMessage } from "../../shared/runMessages";
import { WORKFLOWS_SUBDIR } from "../../core/loader/constants";
import type { PhaseOwner } from "../../chat/chatHost";
import type { PhaseChat, SddDisposable, SddHost, SddSurface } from "./sddHost";
import { modelOf, providerOf } from "./aiArgs";
import { ImplementRun } from "./implementRun";
import { laneBucket, portable } from "./lanes";
import { Scopes } from "../registry/styleFiles";

/** Where the spec panel's column widths are kept - one set for every spec, so a width dragged once holds. */
// Percent of the panel, as the UI library's split keeps it.
const LAYOUT_KEY = "sdd.panelLayout.percent";

/**
 * One spec, worked from a panel: the phases, the waves, a phase's run,
 * review notes, handover, open questions, Run till here and Start from
 * here, Stop after current session, and tasks done by hand.
 *
 * It answers the messages of `SddRunView` - the same component the run
 * panel uses, so the phase rail and its tabs (Doc, Logs, Prompt, Revise,
 * Tasks), Start, the implement lens and Open session exist once -
 * from a spec folder instead of from a
 * workflow run.
 *
 * No server code in here: everything the app around it
 * owns - the page, saved values, pop-ups, terminals, the folder watch -
 * goes through its {@link SddHost}. The workspace folder is handed in by
 * the caller and never looked for here. The server (`src/server/sddSpecs.ts`)
 * runs this.
 *
 * The implementation phase - waves, `Run:` tasks, the wait between
 * sessions, Stop after current session - is in implementRun.ts. The
 * conversations are phase chats: normal sessions, which the chat code
 * runs. SDD hands them their turns and is asked on every turn typed in
 * them - see `phaseOwner`.
 */
export class SddController {

    /**
     * What lives for as long as the spec is being worked on, closed tab
     * or not: the folder watcher and the session listener. Torn down
     * only in {@link teardown} - never by a tab closing on its own.
     */
    private readonly disposables: SddDisposable[] = [];

    /**
     * The page currently showing this spec, or none. `undefined`
     * between a tab closing and either a reopen or this instance being
     * torn down - see {@link detach}. A phase in flight does not wait on
     * this: `post` writes every line to disk regardless, and a reopen
     * replays it.
     */
    private surface: SddSurface | undefined;

    private busy = false;

    /** The stage the busy flag was raised for - where a stop is logged. */
    private busyStage?: string;

    /**
     * This spec's history on disk - every phase, every revise, from the
     * first draft on.
     *
     * One file for the life of the spec: a revise is another episode of
     * the same story, and reading why the first draft chose what it
     * chose is most of what someone opens the history for. Nothing
     * prunes it.
     *
     * Created here rather than passed in so the panel owns the one
     * writer for its own file - see the one-writer rule in
     * {@link EventWriter}.
     */
    private readonly events: EventWriter;

    /**
     * The implementation in flight - the plan's waves as lanes, the wait
     * between sessions, "Stop after current session" - see
     * implementRun.ts.
     */
    private readonly waves: ImplementRun;

    /**
     * True only while the panel is posting lines it just read back.
     *
     * Every line the panel sends to the view goes through `post`, which
     * is also where it is written down - one choke point, so a new
     * caller cannot forget. Replay sends lines that are already in the
     * file, and without this each panel open would write the whole
     * history again.
     */
    private replaying = false;

    /**
     * Every way to stop the phase in flight, when one is. A set, not a
     * slot: `runPhase` routes both the plugin's cancel handlers and any
     * process kill through the same hook, and a single slot would keep
     * only whichever registered last. Cleared with the busy flag.
     */
    private readonly phaseStops = new Set<() => void>();

    /** The plan rows' commands running now, by command, with how to stop each - the row's button is Stop while it runs. */
    private readonly commandStops = new Map<string, () => void>();

    /** Set by Stop (and by dispose), read by the plugin's cancellation checks. */
    private cancelRequested = false;

    /**
     * This instance is finished with - see {@link teardown}. Work that
     * was already in flight when it happened still resolves, and what
     * it finds is a spec nobody is watching any more: the folder may be
     * gone, and a fresh panel may already be open on the same spec. So
     * nothing it has to say is shown - no toast, no log line, no event
     * written. Everything the instance had to report, it reported
     * before teardown, which is the last thing each of its callers do.
     */
    private gone = false;

    /**
     * The stage an implementation conversation's output is filed under.
     *
     * Learned from the style on the first send, and given a default
     * rather than left undefined: a log line with no bucket is a log
     * line nobody sees, and the built-in styles all call it this.
     */
    private implementStage = "implement";

    /** Watches this spec's folder. Replaced if the spec moves, disposed with the controller. */
    private watcher: SddDisposable | undefined;

    /** The folder currently being watched, so an unchanged path does not rebuild the watcher. */
    private watching: string | undefined;

    /**
     * Every document handed to the view, and the text it was last
     * handed. The view asks for a document once and keeps it, so when
     * the file changes on disk underneath it - an agent ticking a box
     * through `task_done`, a hand edit, a pull - this is how the panel
     * knows which documents to send again, and can skip one that did
     * not change. Keyed by the path the view asked with, so no path
     * from the watcher has to be matched against it.
     */
    private readonly served = new Map<string, string>();

    /**
     * A conversation to put on screen once the view can take it - see
     * {@link focus}. Held until the page says `ready`, since a message
     * posted to a view still loading is lost.
     */
    private pendingFocus?: string;

    /** The page has said `ready` since it was last attached. */
    private viewReady = false;

    /**
     * @param workspace the folder the spec's phases run in, and where
     * its settings are read. Handed in by the caller - never looked for
     * here.
     */
    constructor(
        private readonly host: SddHost,
        private readonly workspace: string,
        private readonly specName: string
    ) {

        this.events = new EventWriter(
            specEventsPath(workspace, specName),
            `sdd:${specName}`,
            error => logger.warning(`Spec '${specName}': could not record an event. ${(error as Error).message}`));

        // Its getters and setters reach this instance's own state, so
        // the run and the rest of the spec share one busy flag.
        const self = this;

        this.waves = new ImplementRun({
            host,
            specName,
            workspace,
            events: this.events,
            get busy() { return self.busy; },
            set busy(on) { self.busy = on; },
            get busyStage() { return self.busyStage; },
            set busyStage(stage) { self.busyStage = stage; },
            get cancelRequested() { return self.cancelRequested; },
            set cancelRequested(on) { self.cancelRequested = on; },
            phaseStops: this.phaseStops,
            get attached() { return self.attached; },
            post: message => this.post(message),
            note: (text, stageId) => this.note(text, stageId),
            fail: (text, stageId) => this.fail(text, stageId),
            current: () => this.current(),
            core: pick => this.core(pick),
            send: () => this.send(),
            teardown: () => this.teardown(),
            newChat: (phase, label) => this.newChat(phase, label),
            postSessionRuns: () => this.postSessionRuns(),
            workflowFile: name => this.workflowFile(name)
        });

        this.disposables.push(

            // The folder is the state, so the panel follows the disk: a
            // document written by a phase, edited by hand, or arriving
            // in a pull all mean the same thing here. Which folder is
            // known only once the spec has been read, so the watcher is
            // set up by the first send rather than here - see `follow`.
            { dispose: () => this.watcher?.dispose() }
        );
    }

    /**
     * Draws this spec on a page - the first one, or a reopen after a
     * tab closed on a phase that kept running. Everything that outlives
     * a closed tab (the watcher, the session listener, `busy` itself) is
     * already set up by the time this runs.
     */
    attach(surface: SddSurface): void {

        this.surface = surface;
        this.viewReady = false;
    }

    /**
     * The page closed. Not the same as this spec being done with: a
     * drafting phase left running with its surface gone should keep
     * writing into the repository exactly as a workflow run does - closing a
     * tab by accident must not cost the run.
     *
     * `busy`, the events writer, the watcher and the session listener
     * all outlive this - {@link teardown} is where those go, and it runs
     * from here only when there is nothing left for them to watch.
     */
    detach(): void {

        this.surface = undefined;

        if (!this.busy)
            this.teardown();
    }

    /** Whether a page shows this spec right now. */
    get attached(): boolean {

        return this.surface !== undefined;
    }

    /**
     * One message from the page. Every handler's last resort is here: a
     * `void` call on a rejected promise is silent - the click lands, the
     * work throws somewhere nobody wrapped, and the panel shows neither a
     * result nor an error.
     */
    receive(message: ToPanel): void {

        void this.onMessage(message).catch(error => this.fail((error as Error).message));
    }

    /**
     * A phase or implementation chat to open on, with its conversation
     * showing - the chat's history list names one. Shown by
     * {@link postFocus} once the page can take it.
     */
    focus(ownerId: string | undefined): void {

        this.pendingFocus = ownerId;
    }

    /** Puts the conversation asked for by {@link focus} on screen, when the page is ready for it. */
    postFocus(): void {

        if (!this.pendingFocus || !this.viewReady)
            return;

        this.post({ type: "focus", ownerId: this.pendingFocus });
        this.pendingFocus = undefined;
    }

    /** Draws the spec again from disk. */
    refresh(): Promise<void> {

        return this.send();
    }

    /**
     * The instance itself is done: nothing is running, and nothing is
     * showing it. Tells the host (so a later open starts clean rather
     * than finding a dead entry) and lets go of the watcher and the
     * session listener - the two things a closed tab alone does not
     * touch.
     *
     * Called from {@link detach} when the tab closes on an idle
     * spec, and from the end of a phase that finished after its tab had
     * already closed - see `run` and `implement`.
     */
    private teardown(): void {

        this.gone = true;

        this.waves.cancelNextLaneTimer();

        this.host.released();

        for (const disposable of this.disposables)
            disposable.dispose();
    }

    /**
     * Stops the phase in flight - the panel's own Stop control. The panel closing does not reach this; see `detach`.
     *
     * Cooperative flag first, stops second: the flag answers the
     * plugin's `isCancelled` checks, and the stops reach the agent
     * directly - the plugin's cancel handlers (its AbortController) and
     * any process kill, whichever registered. Nothing to await - the
     * running `runPhase` call unwinds through its own finally, which is
     * what clears the busy state.
     */
    private stopPhase(): void {

        if (!this.busy)
            return;

        this.cancelRequested = true;

        // Plans kept from earlier stops are dropped. The chats this Stop
        // stops are kept again below, so Resume carries on from here.
        this.waves.forgetStoppedPlans();

        for (const stop of [...this.phaseStops])
            try {

                stop();

            } catch {

                // One stop throwing must not keep the others from
                // firing - and must never take the panel down.
            }

        // Lanes of waves: a wave's chat has its turn stopped here, and no
        // further wave starts. The chat stays: any message typed into it
        // carries the plan on from where it stopped - see `stranded`.
        if (this.waves.hasLanes()) {

            // Chats only: a command or workflow already started carries
            // on in its own terminal or run panel.
            const open = this.waves.openChatLanes();

            const queued = this.waves.queuedLanes();

            open.forEach((lane, index) => {

                const chatId = lane.chatId!;
                const chat = this.host.phaseChat(chatId);

                if (chat?.working)
                    chat.stop();

                // The queued lanes go with the first chat only, so
                // resuming two stopped chats does not queue them twice.
                this.waves.keepStoppedPlan(chatId, { lane, queued: index === 0 ? queued : [] });
            });

            this.note(
                open.length
                    ? `Stopped - the ${open.length === 1 ? "chat's agent is" : `${open.length} chats' agents are`} stopped and no further wave will start. Press Resume in the chat, or send it a message, to carry on from where it stopped.`
                    : "Stopped - no further wave will start.",
                this.waves.firstLaneStage());
            this.waves.endLanes();

            return;
        }

        this.note("Stopping - the phase's agent is being shut down.", this.busyStage);
    }

    /**
     * A fresh core every time, so a settings or style edit is in
     * effect on the next phase without reopening the panel. The pick
     * from the compose row rides in the same way - see `aiChoice.ts`.
     */
    private async core(aiPick: AiPick | undefined = readAiPick(this.host.store)): Promise<SddCore> {

        return SddCore.create({
            workspace: this.workspace,
            resources: this.host.resources,
            home: os.homedir(),
            profile: profileDirectory()
        }, { aiPick });
    }

    /**
     * The pick a phase's conversation holds it to: the runtime and model
     * it was opened on. A started phase stays there whatever the
     * workspace pick says now - only Handover or New Session moves it.
     * Nothing for a phase with no
     * conversation.
     *
     * @param now the runtime the phase would run on with no hold.
     */
    private heldPick(stageId: string, now: string, events: readonly RunEvent[] = this.events.read()): AiPick | undefined {

        const last = lastSession(events, stageId);

        if (!last?.provider || last.provider === now)
            return undefined;

        return { provider: last.provider, ...(last.model ? { model: last.model } : {}) };
    }

    /**
     * The chat of the phase's current run, and the conversation it holds.
     * Nothing when the run has no chat - a fresh phase, a run from before
     * phase chats were sessions, or a chat deleted since.
     */
    private heldChat(phase: string): { chat: PhaseChat; session?: { sessionId: string; provider?: string; model?: string } } | undefined {

        const chatId = currentChat(this.events.read(), phase);
        const chat = chatId ? this.host.phaseChat(chatId) : undefined;

        return chat ? { chat, session: chat.held() } : undefined;
    }

    /**
     * A new chat for a run of `phase`, named after the spec and the
     * phase, numbered from its second run on.
     */
    private async newChat(phase: string, label: string): Promise<PhaseChat | undefined> {

        const runs = sessionRuns(this.events.read()).filter(run => run.ownerId === phase).length;
        const chatId = await this.host.newPhaseChat(phase, `${this.specName} · ${label}${runs ? ` #${runs + 1}` : ""}`);

        return this.host.phaseChat(chatId);
    }

    /**
     * SDD's side of a phase chat (see `PhaseOwner`), asked on every turn
     * the person types there. The turn runs on the phase's AI, carries
     * the phase's write block, and holds the spec busy - so no other
     * phase starts under it - until it ends, when the phase's document
     * is read again.
     *
     * Made by the server for a spec no tab shows, too. Such an instance
     * lets go of itself once the turn ends.
     *
     * A wave chat - `implement@wave:2` - runs on the implementation
     * phase's AI and can tick the plan's boxes. A plan stopped at it
     * (Stop, or a box left unticked) carries on once its turn ends.
     */
    phaseOwner(chatId: string, phase: string): PhaseOwner {

        // The stage the chat's phase is: a wave chat's is the part before `@`.
        const at = phase.indexOf("@");
        const stage = at < 0 ? phase : phase.slice(0, at);
        const wave = at >= 0;

        // The task ids a wave chat was handed, from its record.
        const handed = () => {

            const record = taskSessions(this.host.store, this.specName).find(entry => entry.chatId === chatId);

            return record?.tasks ?? (record ? [record.task] : []);
        };

        const request = async (pick?: AiPick) => {

            const found = await this.current();

            if (!found)
                throw new Error(`'${this.specName}' is no longer under the spec root.`);

            // A wave chat's phase is the implementation phase, whose
            // prompt lists the tasks the chat was handed.
            const tasks = wave ? this.waves.handedTasks(found.spec, handed()) : undefined;

            const asked = await this.phaseRequest(found, stage, undefined, tasks);

            // The chat is held to a runtime: the spec's AI as it is when
            // it is on that runtime, else the spec's AI built for it.
            if (!pick || (providerOf(asked.ai.args) === pick.provider && !pick.model))
                return asked;

            const moved = await (await this.core(pick)).phase(found.spec, stage, undefined, tasks);

            if (providerOf(moved.ai.args) !== pick.provider)
                throw new Error(`${pick.provider} is not listed in ai.providers, so this chat cannot run on it. Use Handover to move it to another runtime.`);

            return moved;
        };

        return {
            plugins: () => this.host.plugins(),

            ai: async pick => (await request(pick)).ai,

            extras: async () => {

                const asked = await request();
                const refuse = asked.refuseWrites?.length
                    ? { refuseWrites: asked.refuseWrites.map(file => path.resolve(this.workspace, file)) }
                    : {};

                if (!wave)
                    return refuse;

                // A wave chat ticks its boxes through `task_done`, and gets
                // the steering files its tasks' `Files:` lines match.
                const found = await this.current();

                return { ...refuse, ...(found ? this.waves.turnFiles(found.spec, handed()) : {}) };
            },

            refuse: () => this.busy
                ? `Still working on ${this.busyStage ?? "another phase"} of ${this.specName} - wait for it, or stop it on the spec.`
                : undefined,

            resumable: () => wave && this.waves.isStoppedAt(chatId),

            started: stop => {

                // The plan stopped at this wave chat: it is put back, so
                // the plan carries on once this turn ticks the boxes.
                const stopped = wave ? this.waves.stoppedPlanAt(chatId) : undefined;

                if (stopped && !this.waves.hasLanes()) {

                    this.waves.putBackStoppedPlan(chatId, stopped);
                    this.waves.postLanes();
                }

                if (wave)
                    void reopenChatTask(this.host.store, this.specName, chatId);

                this.busy = true;
                this.busyStage = stage;
                this.cancelRequested = false;
                this.phaseStops.add(stop);
                this.post({ type: "busy", stageId: stage });
            },

            ended: async () => {

                // The conversation the chat holds now - a Handover in the
                // chat may have moved it - so a later Revise carries on
                // the right one. Only for the phase's current chat: an
                // earlier chat of the phase typed into again is not the
                // run the record follows.
                const held = this.host.phaseChat(chatId)?.held();
                const events = this.events.read();
                const last = lastSession(events, phase);

                if (held && held.sessionId !== last?.sessionId && currentChat(events, phase) === chatId)
                    this.events.session(phase, held.sessionId, held.provider, held.model);

                if (wave) {

                    await endChatTask(this.host.store, this.specName, chatId, held);

                    // A plan put back at the start of this turn: the
                    // boxes say what comes next, and the lanes hold the
                    // spec busy until they end.
                    const lane = this.waves.laneOfChat(chatId);

                    if (lane && this.waves.stillRuns(lane)) {

                        this.phaseStops.clear();
                        await this.send();

                        return this.waves.laneEnded(lane);
                    }
                }

                this.busy = false;
                this.busyStage = undefined;
                this.phaseStops.clear();
                this.post({ type: "busy" });

                if (this.attached) {

                    await this.send();
                    await this.refreshDocument(phase);

                } else
                    this.teardown();
            }
        };
    }

    /**
     * The request a phase runs with. With a conversation already open on
     * another runtime than the workspace pick, it is built again on the
     * conversation's own runtime - never a silent move. A runtime no
     * longer in `ai.providers` cannot be held to, and says so rather than
     * running somewhere else.
     */
    private async phaseRequest(
        found: { core: SddCore; spec: DiscoveredSpec },
        stageId: string,
        revise?: { note?: string; first?: boolean },
        tasks?: HandedTask[]
    ): Promise<Awaited<ReturnType<SddCore["phase"]>>> {

        const request = await found.core.phase(found.spec, stageId, revise, tasks);
        const held = this.heldPick(stageId, providerOf(request.ai.args));

        if (!held)
            return request;

        const again = await (await this.core(held)).phase(found.spec, stageId, revise, tasks);

        if (providerOf(again.ai.args) !== held.provider)
            throw new Error(`${stageId} runs on ${held.provider}, which ai.providers no longer lists. Use Handover to move it to another runtime, or New Session to start again.`);

        return again;
    }

    /**
     * The conversation so far, put back on screen.
     *
     * Everything this spec's phases have said, in the order they said
     * it, drawn by the same view that drew it live - because they are
     * the same lines.
     *
     * `currentEvents` drops what a re-run superseded, so a phase drafted
     * twice shows its second draft rather than both stacked up. The
     * earlier one is still in the file for anyone who goes looking.
     *
     * A question that was open when the page closed comes back as
     * history rather than as live buttons, and needs no special record
     * to do it: an `ask` with no `answer` beside it *is* an unanswered
     * question, the same way a `tool.start` with no `tool.end` is a call
     * that never returned.
     */
    private replay(): void {

        const all = this.events.read();

        const events = currentEvents(all);

        if (!events.length)
            return;

        this.postSpent(all);

        this.replaying = true;

        try {

            for (const event of events) {

                const line = lineFrom(event);

                if (line)
                    this.post({
                        type: "log",
                        stageId: line.ownerId,
                        text: line.text,
                        stream: line.stream,
                        meta: line
                    });
            }

        } finally {

            this.replaying = false;
        }
    }

    /**
     * Tells the view what each phase's hidden earlier conversations
     * charged, so the total it shows covers every run of the phase and
     * not only the lines on screen - see `supersededSpend`. One phase
     * when `stageId` is given (right after its lines were cleared),
     * every phase otherwise (on replay).
     */
    private postSpent(events: readonly RunEvent[], stageId?: string): void {

        const spent = supersededSpend(events);

        const owners = stageId === undefined ? [...spent.keys()] : [stageId];

        for (const owner of owners) {

            const carried = spent.get(owner);

            this.post({
                type: "spent",
                stageId: owner,
                spent: carried?.spent ?? [],
                models: carried?.models ?? []
            });
        }
    }

    /** The column widths the person last dragged, and the sessions pane's list. */
    private postLayout(): void {

        this.post({
            type: "layout",
            widths: this.host.profileStore.get<PanelWidths>(LAYOUT_KEY)
        });

        this.postSessionRuns();
    }

    /**
     * Every session run this spec has had, for the sessions pane - the
     * list only, without the lines.
     */
    private postSessionRuns(): void {

        this.post({
            type: "sessionRuns",
            runs: sessionRuns(this.events.read()).map(({ lines, ...run }) => {

                void lines;

                return run;
            })
        });
    }

    /**
     * The lines of one run, for the pane to show a run the panel's own
     * log no longer holds - one a re-run or New Session cut off.
     * Nothing is posted for a run that is not in the file.
     */
    private postSessionLines(ownerId: string, iteration: number): void {

        const run = sessionRuns(this.events.read())
            .find(one => one.ownerId === ownerId && one.iteration === iteration);

        if (!run)
            return;

        this.post({
            type: "sessionLines",
            ownerId,
            iteration,
            lines: run.lines.flatMap(event => {

                const line = lineFrom(event, ownerId);

                return line ? [line] : [];
            })
        });
    }

    /**
     * The feature flags the sessions pane reads.
     *
     * For example `sessionCost`: whether the usage card draws what a
     * session has cost. A settings file that does not parse leaves every
     * flag off, which is also the default - the phases themselves report
     * that file's error when they run, so this stays quiet about it.
     */
    private async postFeatures(): Promise<void> {

        const settings = await loadEngineSettings(this.workspace, {
            profileDir: path.join(os.homedir(), WORKFLOWS_DIR)
        }).catch(() => undefined);

        this.post({
            type: "features",
            sessionCost: settings?.features.sessionCost === true,

            // On only when the settings say so. When settings cannot
            // be read at all, every flag reads as off.
            docDiff: settings?.features.docDiff === true,

            handover: settings?.features.handover === true,

            toolResults: settings?.features.toolResults === true
        });
    }

    /** The spec as it is on disk right now - never cached, because the folder is the state. */
    private async current(): Promise<{ core: SddCore; spec: DiscoveredSpec } | undefined> {

        const core = await this.core();
        const spec = (await core.specs()).find(candidate => candidate.name === this.specName);

        return spec ? { core, spec } : undefined;
    }

    private async send(): Promise<void> {

        try {

            const found = await this.current();

            if (!found)
                return this.fail(`'${this.specName}' is no longer under the spec root.`);

            this.follow(found.spec.folder);

            const summaries = await found.core.listStyles();
            const summary = summaries.find(one => one.id === found.spec.detection.style);

            const message: SpecMessage = {
                name: found.spec.name,
                path: found.spec.path,
                style: found.spec.detection.style,
                styleName: summary?.name,
                specType: found.spec.specType,
                detection: found.spec.detection.reason,

                // The gate is the style's own switch, and `!== false`
                // rather than `=== true`: a style that failed to load
                // reports nothing here, and a spec being drawn for a
                // style nobody could parse is not the moment to quietly
                // drop a safety check.
                stages: await this.stages(
                    found.core,
                    found.spec,
                    summary?.blockOnOpenQuestions !== false,
                    summary?.presets,
                    summary?.ai,
                    summary?.scope,
                    summary?.native)
            };

            this.post({ type: "spec", spec: message });

            // Which feature flags the usage card should honour. Read
            // fresh here, like the rest of the settings, so turning one
            // on or off shows on the next redraw.
            void this.postFeatures();

            // What a plan row's `Run:` line may name, so a row can say
            // when its name resolves to nothing before anyone presses it.
            this.post({ type: "workflows", names: this.workflowNames() });

            // Row commands still running, so a redrawn row shows Stop.
            this.postCommands();

            // What the compose row's picker offers. Sent now with the
            // model lists already in, so the picker is never held up by
            // a CLI, then once more as each runtime's list lands. After
            // the first fetch every list is cached, so on a later
            // refresh the follow-ups are immediate.
            //
            // Only the runtimes a phase of this spec is on right now are
            // asked - not every `ai.acpAgents` id, which would start
            // seven agents that are mostly not installed. A runtime just
            // picked is in this set on the very next refresh, which the
            // pick itself triggers.
            //
            // The fetches start before the first post, so it already
            // names those runtimes as loading, and each one ending - with
            // a list or without - sends again, so no runtime stays shown
            // as loading.
            const fetching = [...new Set(message.stages.flatMap(stage => stage.ai ? [stage.ai.provider] : []))]
                .map(provider => modelsOf(provider, this.host.ai));

            this.post({ type: "aiChoice", choice: await this.choiceMessage() });

            for (const one of fetching)
                void one.then(async () => {

                    if (this.surface)
                        this.post({ type: "aiChoice", choice: await this.choiceMessage() });
                });

            // What a freshly opened page does not otherwise learn: a phase can
            // still be running on the host after the page reloads (the
            // tab lost focus and its page was dropped, or the tab
            // was closed and reopened while a phase kept going - see
            // `detach`). Without this, the reloaded view starts
            // from "nothing is running" and stays wrong until the phase
            // actually ends, so pressing Send on what looks like a done
            // phase gets rejected as "already working" for a reason the
            // screen never showed.
            this.post({ type: "busy", stageId: this.busy ? this.busyStage : undefined });

            // The implementation chats this machine started. Empty is
            // the honest answer for a spec whose chats were never here -
            // the view then offers no Open session button, exactly as
            // it does for a teammate's spec.
            this.post({
                type: "sessions",
                sessions: taskSessions(this.host.store, this.specName).map(chat => ({
                    ...chat,

                    // Whether this app still holds the conversation,
                    // which is what the compose box needs to know.
                    // `ended` is a different fact - nobody is working in
                    // it - and a finished chat is still there to talk to.
                    live: chat.chatId !== undefined || (chat.sessionId !== undefined && this.host.sessions().get(chat.sessionId) !== undefined),

                    // The plan stopped at this chat - Stop, or the agent
                    // stopped with a box unticked - and a message into it
                    // carries the plan on.
                    ...(chat.chatId && this.waves.isStoppedAt(chat.chatId) ? { resumable: true } : {})
                }))
            });

            // The notes travel with the spec, so they are sent with it
            // rather than fetched when a rail is opened: a badge in the
            // gutter has to be there the moment the document is, or the
            // reader scrolls past a comment that arrived a beat later.
            this.post({ type: "notes", notes: readNotes(found.spec.folder, this.workspace) });

            this.postLayout();

        } catch (error) {

            this.fail((error as Error).message);
        }
    }

    /**
     * Watches this spec's own folder, and nothing else.
     *
     * The spec folder *is* the state this panel renders, so it is the
     * only thing worth following. Watching the whole workspace would
     * mean every unrelated markdown save re-reads the spec, re-lists
     * every style, and posts to every open panel.
     *
     * Set up here rather than in the constructor because the folder is
     * not known until the spec has been read, and re-pointed only when
     * that path changes - a spec folder renamed under the panel is rare,
     * and rebuilding a watcher on every send would be a leak in a loop.
     *
     * What this deliberately gives up: a prompt override edited under
     * `.eesha/styles` does not refresh the prompt chip live. Reopening the panel picks it up, and that is a fair trade
     * against re-reading on every save in the repository.
     */
    private follow(specFolder: string): void {

        if (this.watching === specFolder)
            return;

        this.watcher?.dispose();
        this.watching = specFolder;

        // The documents first, then the chips: a checkbox row is drawn
        // from the document text, and a chip saying "done" over a row
        // still unticked is the wrong order to learn it in.
        this.watcher = this.host.watch(specFolder, () => {

            this.resendChanged();
            void this.send();

            // A box ticked by hand may be what a waiting `Run:` task needs.
            void this.waves.tickedByHand()
                .catch(error => logger.warning(`Spec '${this.specName}': could not check the plan's ticks. ${(error as Error).message}`));
        });
    }

    /**
     * Whether the page may read or save this file. The page names the
     * path, and that comes over HTTP, so it is checked here rather than
     * trusted. Allowed: the workspace, this spec's own folder, the
     * workspace's folders, and the style folders a phase's prompt file
     * can come from (the Prompt tab edits it).
     */
    private mayTouch(file: string): boolean {

        const target = path.resolve(file);

        const roots = [
            this.workspace,
            this.watching,
            path.join(this.host.resources, STYLES_DIR),
            path.join(profileDirectory(), STYLES_DIR),
            path.join(os.homedir(), WORKFLOWS_DIR, STYLES_DIR)
        ];

        return roots.some(root => root !== undefined && inside(root, target)) || this.host.folderOf(target) !== undefined;
    }

    /** One document to the view, remembered as what the view now holds. */
    private serve(file: string, content: string): void {

        this.served.set(file, content);
        this.post({ type: "document", path: file, content });
    }

    /**
     * Every served document whose text on disk is no longer what the
     * view was handed goes again. A deleted one goes as empty, which is
     * what a request for a missing file answers too.
     */
    private resendChanged(): void {

        for (const [file, last] of this.served) {

            const now = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";

            if (now !== last)
                this.serve(file, now);
        }
    }

    /**
     * The stepper's chips.
     *
     * `artifact` and `prompt` are absolute, because the view hands both
     * straight to the host - a document to open, a prompt to read
     * before running the phase behind it.
     *
     * An implement stage carries no artifact, which is what makes the view
     * treat it as an execution phase and give it the implement lens
     * over the last document before it.
     *
     * @param stylePresets The style's own `presets:`, merged ahead of
     * each stage's. Absent when the style declares none, or when the
     * caller only wants the artifact paths.
     * @param styleAi The style's own top-level `ai:`, one rung of the
     * ladder the picker reports. Absent for the same reasons.
     * @param styleFrom Where the style's folder was found, which decides
     * where that rung sits against the two settings files.
     */
    private async stages(
        core: SddCore,
        spec: DiscoveredSpec,
        blockOnOpenQuestions: boolean,
        stylePresets?: Preset[],
        styleAi?: Record<string, unknown>,
        styleFrom?: StyleOrigin,
        native?: NativeTool
    ): Promise<SpecStage[]> {

        // Kiro's runtime and mode, which beat the compose box's pick -
        // so the picker shows what the phase really runs on.
        const lock = (stage: Stage) => native
            ? lockOf({ native, ai: styleAi } as Style, stage)
            : undefined;

        if (!spec.state || !spec.detection.style)
            return [];

        const styleId = spec.detection.style;
        const specDir = spec.folder;
        const specType = spec.state.specType;

        // Read once for the whole list rather than per stage: this is a
        // file read, and there are as many stages as the style declares.
        const history = this.events.read();

        // A started phase shows the runtime its conversation is on, not
        // the workspace pick - see `heldPick`.
        const heldCores = new Map<string, SddCore>();

        for (const stage of spec.state.stages) {

            if (isIdea(stage.stage))
                continue;

            const now = aiSourcesFor(core.config, styleAi, stage.stage.ai, styleFrom, lock(stage.stage)).provider;
            const held = this.heldPick(stage.stage.id, now, history);

            if (held)
                heldCores.set(stage.stage.id, await this.core(held));
        }

        // Learned here rather than hardcoded at the one place that reads
        // it: a style is free to call its terminal stage whatever it
        // likes, and the log bucket has to match what the chips are.
        //
        // The output gate, asked as a question rather than matched on a
        // stage id - a style is free to call it whatever it likes.
        this.implementStage =
            spec.state.stages.find(stage => isTerminal(stage.stage))?.stage.id ?? this.implementStage;

        // The phases Revise is offered on, decided in SDD core - the
        // rule is about the style's pipeline, and `hasContent` is the
        // same test the chips tick on, so the two cannot disagree.
        const revisable = new Set(revisableStages(
            spec.state.stages, artifact => hasContent(path.join(specDir, artifact)))
            .map(stage => stage.id));

        return spec.state.stages.map((stage, index, all) => {

            const artifact = stage.stage.produces[0]
                ? path.join(specDir, stage.stage.produces[0])
                : undefined;

            // The output gate after an actionable stage is not a phase
            // anyone visits: the plan's own page starts the work. Still
            // sent - it is where the chats are filed - but marked, so
            // the rail leaves it out.
            const hidden = isTerminal(stage.stage) && all[index - 1]?.stage.actionable === true;

            return {
                name: stage.stage.id,

                ...(stage.stage.actionable ? { actionable: true } : {}),

                ...(hidden ? { hidden: true } : {}),

                // Only when it differs. A label equal to the id is a
                // field on every chip saying nothing.
                label: stage.stage.label === stage.stage.id ? undefined : stage.stage.label,
                prefix: stage.stage.prefix,
                artifact,
                // `hasContent`, not `existsSync`: an empty document is
                // an unwritten one - the chip must offer Start, not tick.
                exists: artifact ? hasContent(artifact) : undefined,
                // The input gate has none - nothing runs it, so there is
                // no instructions file for the panel to point at.
                prompt: stage.stage.instructions
                    ? this.instructionPath(core, styleId, stage.stage.instructions)
                    : undefined,

                revisable: revisable.has(stage.stage.id) ? true : undefined,
                sessionId: sessionToContinue(history, stage.stage.id, undefined),

                // The input gate is exempt: nothing runs it, so its
                // document has no questions of its own. Everything else
                // that wrote a document is read - see
                // `documents/openQuestions.ts`.
                openQuestions: blockOnOpenQuestions && artifact && !isIdea(stage.stage)
                    ? unansweredIn(artifact)
                    : undefined,

                // Only where a revise can happen - neither gate. The
                // facts are the same ones `SddCore.phase` hands
                // `assemble`, so `${{ spec.dir }}` in a preset reads
                // the way it does in an attachment.
                presets: !isIdea(stage.stage) && !isTerminal(stage.stage)
                    ? presetsFor(
                        { presets: stylePresets },
                        stage.stage,
                        {
                            specDir: spec.path,
                            specPath: spec.folder,
                            specType,
                            stageId: stage.stage.id
                        },
                        `Style '${styleId}' stage '${stage.stage.id}' presets`)
                    : undefined,

                // What this phase would run on if started now, and who
                // said so - the picker's label. Not on the input gate,
                // which runs nothing.
                ai: !isIdea(stage.stage)
                    ? aiSourcesFor((heldCores.get(stage.stage.id) ?? core).config, styleAi, stage.stage.ai, styleFrom, lock(stage.stage)) satisfies StageAi
                    : undefined
            };
        });
    }

    /**
     * Where a phase's instructions resolved to.
     *
     * A repository's own file is where the stage said it is - one copy,
     * no scope ladder. A style's own prompt is the highest scope
     * holding it, mirroring how the registry picks the text, so the
     * file the panel opens for editing is the file the phase will
     * actually be given rather than the built-in it shadows.
     *
     * Missing is undefined rather than an error: assembly refuses the
     * phase with the path in the message, which says more than a chip
     * that opens nothing.
     */
    private instructionPath(core: SddCore, styleId: string, template: StageFile): string | undefined {

        if (template.root === "repo") {

            const owned = path.join(this.workspace, ...template.path.split("/"));

            return fs.existsSync(owned) ? owned : undefined;
        }

        const roots: Record<string, string | undefined> = {
            builtin: path.join(core.paths.resources, STYLES_DIR),
            profile: core.paths.home ? path.join(core.paths.home, WORKFLOWS_DIR, STYLES_DIR) : undefined,
            workspace: path.join(this.workspace, WORKFLOWS_DIR, STYLES_DIR)
        };

        for (const scope of [...Scopes].reverse()) {

            const root = roots[scope];
            const file = root && path.join(root, styleId, ...template.path.split("/"));

            if (file && fs.existsSync(file))
                return file;
        }

        return undefined;
    }

    private async onMessage(message: ToPanel): Promise<void> {

        switch (message.type) {

            case "ready":

                this.replay();
                void this.postPluginApps();

                await this.send();

                this.viewReady = true;

                return this.postFocus();

            // A plugin's page asking for something. Answered whatever
            // happens; the page shows the failure.
            case "pluginRequest": {

                const reply = await this.host.answerPluginRequest(
                    message.request,
                    {
                        cwd: this.workspace,
                        root: this.workspace,

                        // A target is a phase. There is no "run the
                        // whole spec": phases are started one at a time.
                        run: async (target, params) => {

                            if (!target)
                                throw new Error("Name the phase to start - eesha.run(\"design\").");

                            if (params && Object.keys(params).length)
                                throw new Error("A phase takes no params - eesha.run(\"design\") with nothing else.");

                            await this.run(target);
                        }
                    });

                return void this.post({ type: "pluginReply", reply });
            }

            // A citation may name a file that is not there - a PRD moved
            // since the spec cited it, or a path the model got wrong -
            // and the panel asks for whatever a document points at. So a
            // missing file is an answer rather than a throw: empty
            // content, which the view reads as "nothing to check these
            // references against".
            // A path outside the folders this spec works in is answered
            // as missing - see `mayTouch`.
            case "requestDocument":
                return this.serve(
                    message.path,
                    this.mayTouch(message.path) && fs.existsSync(message.path) ? fs.readFileSync(message.path, "utf8") : "");

            case "saveDocument": {

                if (!this.mayTouch(message.path))
                    return this.fail(`Not saved: ${message.path} is outside this spec's folders.`);

                fs.writeFileSync(message.path, message.content, "utf8");

                this.serve(message.path, message.content);

                return void this.send();
            }

            case "open":
                return this.host.openFile(message.path);

            // A plan row's command button. It runs with no terminal,
            // so what it prints goes to the implementation's Logs tab. Nothing waits
            // for it and nothing is ticked: the box is the person's to
            // tick once it went the way they wanted.
            case "runCommand": {

                // The folder the plan's paths are relative to: the
                // workspace folder holding the spec, not the first
                // folder - in a workspace with several folders those differ.
                const found = await this.current();

                const cwd = found ? this.host.folderOf(found.spec.folder) ?? this.workspace : this.workspace;

                const stageId = this.implementStage;
                const command = message.command;

                if (this.commandStops.has(command))
                    return this.note(`Already running: ${command}`, stageId);

                // The host hands over how to stop it; the row's
                // button is Stop until the command ends.
                return this.host.sendToTerminal(cwd, command, {
                    output: text => this.post({ type: "log", stageId, text, stream: "stdout" }),
                    onStop: stop => {

                        this.commandStops.set(command, stop);
                        this.postCommands();
                    },
                    ended: () => {

                        if (this.commandStops.delete(command))
                            this.postCommands();
                    }
                });
            }

            case "stopCommand":
                return void this.commandStops.get(message.command)?.();

            // A plan row's workflow, by name, through the run panel like
            // any other start - with what the row knows of its task
            // answered already and the rest asked.
            case "runWorkflow": {

                const file = this.workflowFile(message.name);

                if (!file)
                    return this.fail(`No workflow named '${message.name}' under ${WORKFLOWS_DIR}/${WORKFLOWS_SUBDIR} - the plan's Run: line names nothing.`);

                const found = await this.current();

                const specFolder = found ? portable(found.spec.folder, this.workspace) : undefined;

                return void this.host.runWorkflow(
                    file,
                    message.name,
                    { ...(specFolder !== undefined ? { spec: specFolder } : {}), ...message.params });
            }

            case "saveNotes":
                return void this.onNotes(message.notes);

            case "requestBaseline":
                return void this.onBaseline(message.path);


            // A wave chat is a normal session: the page goes to it. One
            // from before waves ran in sessions has only its runtime id.
            case "openSession":

                if (typeof message.chatId === "string")
                    return this.post({ type: "phaseChat", stageId: this.implementStage, chatId: message.chatId });

                return message.sessionId ? void this.host.openSession(message.sessionId) : undefined;

            case "requestSessionLines":
                return void this.postSessionLines(message.ownerId, message.iteration);

            case "saveLayout":
                return void this.host.profileStore.update(LAYOUT_KEY, message.widths);

            // "Send notes to the chat" on the Doc tab: the notes go into
            // the message box of the phase's chat, to read and send there.
            case "notesToChat": {

                if (typeof message.stageId !== "string" || typeof message.text !== "string")
                    return;

                const chatId = currentChat(this.events.read(), message.stageId);

                if (!chatId)
                    return this.note(`${message.stageId} has no chat yet - start it first, then send the notes.`, message.stageId);

                return this.post({ type: "phaseChat", stageId: message.stageId, chatId, text: message.text });
            }

            case "setAiChoice":
                return void this.setAiChoice(message.pick);

            // The refresh button beside a model picker. Sent now so the
            // button shows it is busy, and again once the fetch ends.
            case "refreshModels":

                if (typeof message.provider !== "string" || !message.provider.trim())
                    return;

                {
                    const refreshing = refreshModels(message.provider.trim(), this.host.ai);
                    const postChoice = async (): Promise<void> => {

                        if (this.surface)
                            this.post({ type: "aiChoice", choice: await this.choiceMessage() });
                    };

                    return void postChoice().then(() => refreshing).then(postChoice);
                }

            case "run":
                return void this.run(message.stageId, message.revise, message.note);

            case "cancel":
                return void this.stopPhase();

            case "markDone":
                return void this.waves.markDone(message.taskId);

            case "stopAfterCurrent":
                return this.waves.setStopAfterCurrent(message.on);

            case "implement":
                return void this.waves.implement(message.tasks);

            // No engine gate holds an SDD phase: the walk parks, and a
            // human pressing Start is the approval. Accepted so the
            // view's own gate path is never a dead message.
            case "decide":
                return void this.send();
        }
    }

    private async run(stageId: string, revise = false, note?: string): Promise<void> {

        const typed = !revise ? note?.trim() : undefined;

        // A Kiro or Spec Kit phase takes typed text in its first message
        // - Kiro's own `/spec new X` takes the description that way, and
        // New spec starts a Kiro spec's first phase with it. An Eesha
        // phase's first pass takes no note: what is typed after it goes
        // in its chat.
        const native = typed ? await this.native() : false;

        // `revise` runs a document phase again over the document it
        // already wrote, carrying the person's note.
        await this.launch(stageId, {
            revision: revise
                ? { note: note ?? "" }
                : native ? { note: typed!, first: true } : undefined
        });
    }

    /** Whether this spec runs a tool's own process - Kiro's or Spec Kit's. */
    private async native(): Promise<boolean> {

        const found = await this.current();
        const styleId = found?.spec.detection.style;

        if (!found || !styleId)
            return false;

        return Boolean((await found.core.registry.load(styleId).catch(() => undefined))?.native);
    }

    /**
     * Runs one phase - Start and Revise, from the buttons.
     *
     * Not the compose box. A typed message is always a turn on a
     * conversation that already exists (see `sendMessage`), so it goes
     * through `continueSession` and never through here. A phase is
     * started by its own button and by nothing else, which is what
     * makes "this phase has a session" the same fact as "this phase has
     * been started".
     */
    private async launch(
        stageId: string,
        start: { revision?: { note: string; first?: boolean }; files?: AgentAttachment[] }
    ): Promise<void> {

        if (this.busy)
            return this.note(`Already working - ${stageId} was not started.`, stageId);

        // Set before the first await, so a second click that is already
        // in the queue finds it - the same guard `implement` documents.
        // Two presses of Start are two agents handed the same phase in
        // the same repository, and the second is never what anybody
        // meant.
        this.busy = true;
        this.busyStage = stageId;
        this.cancelRequested = false;

        try {

            const found = await this.current();

            if (!found)
                return this.fail(`'${this.specName}' is no longer under the spec root.`, stageId);

            this.post({ type: "busy", stageId });

            // Put the document this phase is about to rewrite aside
            // *first*. A moment later the old text is gone, and the only
            // baseline left would be the draft the reader is already
            // looking at - which answers nothing about what changed.
            // `false`: this call wants the artifact paths and nothing
            // else, and reading every document for questions nobody is
            // going to look at is a file read per stage for nothing.
            for (const stage of await this.stages(found.core, found.spec, false))
                if (stage.name === stageId && stage.artifact && stage.exists)
                    snapshot(found.spec.folder, this.workspace, stage.artifact);

            const request = await this.phaseRequest(found, stageId, start.revision);
            const plugins = this.host.plugins();
            const provider = providerOf(request.ai.args);
            const model = modelOf(request.ai.args);

            // Read before this attempt records anything of its own, so
            // it answers "was there already a conversation" rather than
            // "is there one now". The phase's chat carries it on only
            // when the conversation it holds was opened by the runtime
            // about to be used: a session id belongs to whoever issued
            // it, so a spec drafted on Claude and revised with
            // `provider: ghcp` gets a new chat rather than hand Copilot
            // an id it has never seen.
            const held = this.heldChat(stageId);
            const continuing = held?.session && (held.session.provider === undefined || held.session.provider === provider)
                ? held.session.sessionId
                : undefined;

            // A marker, not a deletion: the file is append-only and
            // rewriting it to cut a section out is the one operation
            // that could lose the rest. Written only for a genuine
            // restart - no conversation to carry on, so what this phase
            // wrote last time stops being the current draft. A revise
            // that continues the same conversation is not a restart: the
            // agent still has every earlier turn, and cutting the view
            // here would hide forty of them behind the one line about to
            // be sent.
            if (!continuing)
                this.events.control("restart", stageId);

            // A fresh start is a new chat: a clean session for each run of
            // a phase. A Revise that carries the conversation on stays in
            // the chat it was in.
            const chat = continuing ? held!.chat : await this.newChat(stageId, request.stage.label);

            if (!chat)
                return this.fail(`The ${stageId} session could not be made.`, stageId);

            // The revise note rides on the record, so the sessions pane
            // can name this run by what the person asked for.
            const note = start.revision?.note.trim();

            this.events.control("start", stageId, { ...(note ? { text: note } : {}), chatId: chat.chatId });

            // The page goes to the chat the phase runs in.
            this.post({ type: "phaseChat", stageId, chatId: chat.chatId });

            if (!continuing)
                this.postSessionRuns();

            // The view's own copy of this stage's conversation, wiped to
            // match a genuine restart - `sessionOpened` below reconciles
            // state mid-run via `send()`, which must not also imply "a
            // phase started" or every run would clear itself out from
            // under its own first reply. Left alone on a continue: the
            // conversation on screen is still the true one, and a
            // reopened panel would show all of it right back anyway.
            if (!continuing) {

                this.post({ type: "clearLog", stageId });

                // The lines just wiped still count towards what the
                // phase has cost - see `postSpent`.
                this.postSpent(this.events.read(), stageId);
            }

            // A continued conversation already holds every file it was
            // sent - only the ones that changed since go again. See
            // `attachmentsToSend`.
            const fingerprint = sha1Of(file => fs.readFileSync(file));
            const attachments = attachmentsToSend(continuing, request.attachments, fingerprint);

            // Taken now, so the documents are fingerprinted as they were
            // sent, not as the agent leaves them.
            const sentPrints = new Map(request.attachments.map(one => [one.path, fingerprint(one.path)] as const));

            // The panel's Stop stops the chat's turn.
            this.phaseStops.add(() => chat.stop());

            const outcome = await runPhase(
                {
                    request: attachments.length === request.attachments.length
                        ? request
                        : { ...request, attachments },
                    specId: found.spec.path,
                    workspace: this.workspace,
                    runId: `sdd:${found.spec.path}`,
                    processEnv: EnvService.machine(),
                    keep: true,
                    continueSession: continuing,
                    ...(start.files?.length ? { sentFiles: start.files } : {}),

                    // A person is at this spec, so a question the agent
                    // asks has someone to wait for - the phase's chat
                    // shows it and takes the answer. Only a spec run says
                    // this; a workflow run stays unattended.
                    interactive: true,

                    // In the phase's chat, which writes the conversation
                    // down, draws it, and keeps its own stop and session id.
                    via: (call, check) => chat.runOwned(call, check)
                },
                plugins,
                // `resolve`, not `join`: a target is repository-relative
                // when specs live in the repository and absolute when the
                // settings name a root elsewhere. `resolve` takes the
                // absolute one as-is and anchors the other, where `join`
                // would glue them into a path that exists nowhere.
                // `hasContent`, not `existsSync`: a phase that left a
                // zero-byte document did not produce it.
                target => hasContent(path.resolve(this.workspace, target)));

            // Recorded whether or not the phase succeeded, since the
            // conversation behind a failure is the one most worth
            // reopening. The chat has it in its own file; the spec's
            // file keeps it so a later Revise can tell whether to carry
            // it on.
            if (outcome.sessionId) {

                recordSent(outcome.sessionId, request.attachments, file => sentPrints.get(file));
                this.events.session(stageId, outcome.sessionId, provider, model);
            }

            // The reason travels with the record, not only in a toast
            // that closes and a log line nothing writes down - a
            // reopened panel could otherwise see a `start` with no
            // explanation for why there was never an `end` worth having.
            this.events.control(
                "end", stageId,
                { status: outcome.success ? "success" : "failed", ...(outcome.message ? { text: outcome.message } : {}) });

            if (!outcome.success)
                this.fail(outcome.message ?? "The phase did not complete.", stageId);

        } catch (error) {

            // The phase threw rather than returning, so nothing above
            // wrote its ending. A phase with a `start` and no `end` is a
            // phase that died, which is worth being able to see - but
            // "died" is what an unfinished file already says, and saying
            // it explicitly is better than leaving a reader to infer it.
            this.events.control("end", stageId, { status: "failed", text: (error as Error).message });

            this.fail((error as Error).message, stageId);

        } finally {

            this.busy = false;
            this.busyStage = undefined;
            this.phaseStops.clear();
            this.post({ type: "busy" });

            // Attached: redraw for whoever is looking at it. Not: the
            // tab that was here closed mid-phase (see `detach`),
            // which held this instance open only for this moment - now
            // that the phase is done, there is nothing left to watch.
            if (this.surface) {

                await this.send();
                await this.refreshDocument(stageId);

            } else
                this.teardown();
        }
    }

    /**
     * Pushes the phase's own document fresh from disk once it ends.
     *
     * `send()` refreshes the stage list and notes but never document
     * content - the view only re-reads a document when it has none
     * cached (see `requestDocument`), so without this push the panel
     * would keep showing what was on screen before the phase ran until
     * the document tab's own Reload button was clicked.
     */
    private async refreshDocument(stageId: string): Promise<void> {

        const found = await this.current();
        const artifact = found?.spec.state?.stages.find(one => one.stage.id === stageId)?.stage.produces[0];

        if (!found || !artifact)
            return;

        const file = path.join(found.spec.folder, artifact);

        this.post({
            type: "document",
            path: file,
            content: fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
        });
    }

    /**
     * Notes written back, then read back.
     *
     * Echoed from disk rather than from the message, so the panel and
     * the file cannot disagree about what was saved.
     */
    private async onNotes(notes: ReviewNote[]): Promise<void> {

        const found = await this.current();

        if (!found)
            return this.fail(`'${this.specName}' is no longer under the spec root.`);

        writeNotes(found.spec.folder, this.workspace, notes);

        this.post({ type: "notes", notes: readNotes(found.spec.folder, this.workspace) });
    }

    /**
     * The document as it stood before the last phase touched it.
     *
     * A spec with no snapshot answers with no content, which the view
     * reads as "nothing to compare" and marks nothing. Answering with
     * an empty document instead would mark every line of a first
     * draft as new, which is true and worthless.
     */
    private async onBaseline(artifact: string): Promise<void> {

        const found = await this.current();

        if (!found)
            return;

        this.post({ type: "baseline", path: artifact, content: baseline(found.spec.folder, this.workspace, artifact) });
    }

    /**
     * The compose row's picker: which runtime and model every phase
     * runs on from now, for the whole workspace. Nothing is sent and no
     * session is touched here - the next Send, Start, Revise or Next
     * reads the pick (see `core`) and does what the change calls for
     * (see `continueSession`). Every open spec panel is re-sent, since
     * the pick is theirs too.
     *
     * Not refused while a phase is working: the pick only matters to
     * the next turn, and the person switching runtimes because this
     * one has stopped answering is the usual case, not the odd one.
     */
    private async setAiChoice(pick: { provider: string; model?: string; mode?: string } | undefined): Promise<void> {

        await writeAiPick(this.host.store, pick);

        await this.host.redrawAll();
    }

    /**
     * The compose row's choices: the runtimes and models, each runtime's
     * Permissions level, and how many saved answers hold for this spec.
     */
    private async choiceMessage(): Promise<AiChoiceMessage> {

        const choice = { ...await aiChoiceMessage(this.host.store, this.host.ai) };

        choice.levels = this.host.permissions.levels(choice.providers);
        choice.savedAnswers = (await this.savedAnswers()).length;

        return choice;
    }

    /** The saved answers that hold in this spec's chats. Empty when the spec is gone. */
    private async savedAnswers(): Promise<SavedAnswer[]> {

        const found = await this.current();

        return found ? this.host.permissions.saved(found.spec.path, this.workspace) : [];
    }

    /** A saved answer was added or removed somewhere: the compose row's count is sent again. */
    async savedAnswersChanged(): Promise<void> {

        if (this.surface)
            this.post({ type: "aiChoice", choice: await this.choiceMessage() });
    }

    /** Where this workspace keeps its workflow files. */
    private get workflowsDir(): string {

        return path.join(this.workspace, WORKFLOWS_DIR, WORKFLOWS_SUBDIR);
    }

    /**
     * The names a plan row's `Run:` line may use: every `.yml`/`.yaml`
     * under `workflows/`, sub-folders included, as its path without the
     * extension - `story-start`, `ado/release`.
     */
    private workflowNames(): string[] {

        const names: string[] = [];

        const walk = (dir: string, prefix: string) => {

            let entries: fs.Dirent[];

            try {

                entries = fs.readdirSync(dir, { withFileTypes: true });

            } catch {

                return;
            }

            for (const entry of entries)
                if (entry.isDirectory())
                    walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
                else if (/.ya?ml$/i.test(entry.name))
                    names.push(prefix + entry.name.replace(/.ya?ml$/i, ""));
        };

        walk(this.workflowsDir, "");

        return names.sort();
    }

    /** The file a `Run:` name resolves to, or nothing. */
    private workflowFile(name: string): string | undefined {

        for (const extension of [".yml", ".yaml"]) {

            const candidate = path.join(this.workflowsDir, ...name.split("/")) + extension;

            if (fs.existsSync(candidate))
                return candidate;
        }

        return undefined;
    }

    /**
     * Why the phase, or the panel, did not do what was asked.
     *
     * Logged as well as shown. A toast is gone the moment it is
     * dismissed and a panel row goes with the panel, so a failure that
     * lands only there leaves nothing to paste when someone reports it
     * an hour later - which is the whole reason for a log file.
     *
     * The message, not the stack. Sourcemaps do not ship,
     * so a stack off the bundle names lines nobody can look up. The same
     * reasoning `messageOf` in `core/logging/logger.ts` already carries.
     *
     * `stageId`, when a failure belongs to one phase's run, also puts
     * the reason in that phase's own log - the same way `note` does for
     * a refusal. Without it a failed run would leave only a toast: the
     * popup closes, the tab still says nothing happened, and reopening
     * the panel shows a phase with a `start` and no `end` message,
     * which explains that something died but never says what.
     */
    private fail(text: string, stageId?: string): void {

        if (this.gone)
            return;

        logger.error(`Spec '${this.specName}': ${text}`);

        if (stageId)
            this.post({ type: "log", stageId, text: `${text}\n`, stream: "stderr" });

        this.post({ type: "error", text });
        this.host.showError(`${this.specName}: ${text}`);
    }

    /** Tells the view which row commands are running now. */
    private postCommands(): void {

        this.post({ type: "commands", running: [...this.commandStops.keys()] });
    }

    /**
     * Why nothing happened.
     *
     * Into the panel's own log as well as a toast, because the log is
     * where someone watching a phase is already looking - and a refusal
     * that leaves no trace there reads as a button that does not work.
     *
     * `stageId` defaults to `this.implementStage` - the style's own
     * terminal stage, learned in `stages()` - rather than the literal
     * word "implement". A style is free to call that stage anything it
     * likes, and a refusal filed under a stage id no tab in the view
     * answers to is a refusal nobody sees.
     */
    private note(text: string, stageId = this.implementStage): void {

        if (this.gone)
            return;

        this.post({ type: "log", stageId, text: `${text}\n` });
        this.host.showInfo(`${this.specName}: ${text}`);
    }

    /**
     * The page of the plugin this spec's phases run on - `sdd.uses`,
     * one for the whole workspace - made ready by the host for its page.
     * Same rule as the run panel: a plugin nothing here calls gets no
     * tab. Nothing to send to when no tab is open.
     */
    async postPluginApps(): Promise<void> {

        if (!this.surface)
            return;

        let core: SddCore;

        try {

            core = await this.core();

        } catch (error) {

            // A broken settings.json is reported by `send`, where the
            // panel can show it; here it only means no app tab.
            logger.warning(`No plugin app tabs for '${this.specName}': ${String(error)}`);

            return;
        }

        const { apps, sandboxed } = this.host.pluginApps(new Set([core.config.ai.uses]));

        this.post({ type: "pluginApps", apps, sandboxed });
    }

    private post(message: ToSddView): void {

        if (this.gone)
            return;

        // The one place a line reaches the view is the one place it is
        // written down. A second path for "and also record it" is a path
        // somebody forgets on the next line they add. Written down
        // whether or not a page is open right now - a phase kept
        // running after its tab closed still needs its lines on disk
        // for the reopen that replays them.
        if (message.type === "log" && !this.replaying)
            this.events.log({
                ownerId: message.stageId,
                at: Date.now(),
                stream: message.stream ?? "stdout",
                text: message.text,
                ...message.meta
            });

        // No tab showing this spec right now - see `detach`. The
        // line above already put this on disk; there is no view to
        // hand it to. A question is the one line that cannot wait for
        // the tab to come back: the agent is stopped until it is
        // answered, so the person is told it is there.
        if (!this.surface) {

            if (message.type === "log" && message.meta?.kind === "ask" && !this.replaying)
                this.host.announceAsk(`spec '${this.specName}'`, message.meta.prompt ?? message.text, message.meta.permission,
                    () => this.current().then(found => found && this.host.showSpec(found.spec)));

            return;
        }

        // A question needs a person, not just a tab open somewhere -
        // brought to the front even if they are looking at something
        // else, the same as any other prompt for input would be.
        if (message.type === "log" && message.meta?.kind === "ask")
            this.surface.reveal();

        // Never throws: the server drops a message for a tab that has gone.
        this.surface.post(message);
    }
}

/**
 * The unanswered questions in one document, or nothing.
 *
 * `undefined` rather than an empty array for the ordinary case, so the
 * message carries the field only for a document that actually holds
 * one - and a view finding nothing has nothing to refuse.
 *
 * An unreadable file is treated as having none. It has already been
 * seen to have content by this point, so a failure here is a race with
 * something writing it, and refusing every advance button over a
 * transient read error would be the worse answer.
 */
function unansweredIn(artifact: string): OpenQuestionRef[] | undefined {

    try {

        const questions = unansweredQuestions(fs.readFileSync(artifact, "utf8"))
            .map(question => ({ ...(question.id ? { id: question.id } : {}), text: question.text }));

        return questions.length ? questions : undefined;

    } catch {

        return undefined;
    }
}

/** Whether `file` is `folder` or anywhere under it. Both are made absolute first. */
function inside(folder: string, file: string): boolean {

    const relative = path.relative(path.resolve(folder), path.resolve(file));

    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

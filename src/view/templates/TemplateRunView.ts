import type { RefObject } from "react";
import { LogLine, ModelSpend, RunStatus, Spend } from "../../core/models/run";
import { BrowsedParam, Param, Workflow } from "../../core/models/workflowTypes";
import { GateRequest, RunOutput, RunContext, TaskContext } from "../../core/execution/callbacks";
import type { PluginUi } from "../../core/plugins/Plugin";
import { TaskProblem, ValidationIssue } from "../../core/validation/ValidationIssue";
import { PluginAppMessage, RunSummary, SpecStage, TaskSession } from "../../shared/runMessages";
import type { PanelWidths, SessionRunSummary } from "../../shared/sddMessages";
import type { SavedAnswerRow } from "../../shared/chatMessages";
import type { PermissionLevel } from "../../core/models/permissionCard";
import { PluginBridge } from "../pluginBridge";
import { RunGraph } from "../runGraph";
import { ReviewNote } from "./reviewNotes";
import type { TaskRun } from "../../shared/taskRun";
import type { FileMatch, SentFile } from "../../shared/composeFiles";

/** One task's accumulated log lines. */
export interface CmdLogs {

    lines: LogLine[];

    /**
     * What this owner's earlier conversations charged - the lines a
     * re-run or a clear took off the screen. The AI Session tab adds it
     * to what `lines` charged, so its total covers every run. Absent
     * when nothing was hidden, or nothing hidden was billed.
     */
    spent?: Spend[];

    /** The same hidden charges split by model - see {@link spent}. */
    spentModels?: ModelSpend[];
}

/**
 * Everything an engine's run surface receives.
 *
 * The props carry the messages and the state built from them; a
 * template view owns only presentation, so SDD's phase panel and the
 * run panel read the same status and gate.
 */
export interface TemplateRunViewProps {

    workflow: Workflow;

    /** The tree row's label - what an inline run is titled. */
    title: string;

    /** False for `tasks.yml`; a staged workflow brings its own stages. */
    staged: boolean;

    /** The projected graph every template shares - see {@link RunGraph}. */
    graph: RunGraph;

    /** The run as a whole - the worst of its jobs. */
    runStatus: RunStatus;

    isRunning: boolean;

    startTime?: string;

    exitTime?: string;

    ownerStatuses: Record<string, RunStatus>;

    taskStatuses: Record<string, RunStatus>;

    /** How many times each task has been tried - a revise names the next one. */
    taskAttempts: Record<string, number>;

    /**
     * The agent conversation each task held, keyed by task id.
     *
     * Only `ai@1` tasks appear, and only once the panel has seen the
     * run: the id arrives on the live status update. A task with no
     * entry offers no button.
     */
    taskSessionIds: Record<string, string>;

    taskProblems: Record<string, TaskProblem>;

    /**
     * Every validation issue for this definition, in validator order.
     *
     * Not the same set as {@link taskProblems}: that one is keyed by
     * task id, so it drops issues that belong to no single task - a bad
     * `label:`, two tasks declaring one `artifact:`.
     */
    problems: ValidationIssue[];

    /**
     * What the run's tasks produced, keyed by `artifact:` name - what
     * `${{ run.context.NAME }}` reads downstream. Only tasks declaring
     * `artifact:` appear; the others produced no run variable.
     */
    outputs: Record<string, RunOutput>;

    /**
     * The file-level context this run resolved. Undefined until a run has
     * started - see {@link RunContext}.
     */
    context?: RunContext;

    /**
     * Each task's resolved `args:`, keyed by task id - the values the
     * plugin received, not the templates. Only tasks that ran appear.
     *
     * No tab draws these: the engine logs the same answer into each
     * step's own log before it runs (see `describeArgSources`). Kept on
     * the contract for templates that want them, and because the host
     * builds them for its rerun box anyway.
     */
    taskArgs: Record<string, Record<string, unknown>>;

    /**
     * Where each arg's value came from, same keys as {@link taskArgs} -
     * "caller (task args)", "settings.json default (...)", "plugin
     * manifest default". Live sessions only; a replayed run has values
     * with no origins, and the view shows the value alone.
     */
    taskArgOrigins: Record<string, Record<string, string>>;

    /**
     * The context each task ran under, keyed by task id. Shown in the Data
     * tab instead of the file-level `vars`, `env` and `cwd` when a
     * station is selected: a job can declare `vars:` over the file's.
     */
    taskContexts: Record<string, TaskContext>;

    /**
     * The tab a plugin handed back for its step, keyed by task id - see
     * `PluginResult.ui`. Only steps whose plugin returned one appear,
     * and only for a run this page held; a run read back from the
     * store has none.
     */
    taskUi: Record<string, PluginUi>;

    /**
     * Every plugin that ships an app, each becoming a tab of its own -
     * see `PluginAppTab`. Shown whether or not anything is running.
     */
    pluginApps: PluginAppMessage[];

    /** False under the profile's `debug: true`: plugin pages then run with no iframe sandbox. */
    pluginSandboxed: boolean;

    /** How a plugin's page reaches the host - one per panel, shared by every app in it. */
    pluginBridge: PluginBridge;

    logsByTask: Record<string, CmdLogs>;

    /** The `trigger: manual` task this run is parked at, if any. */
    gate?: GateRequest;

    /** The open log's task and its job, or undefined when none is open. */
    selected?: { ownerId: string; jobId: string };

    onSelect(selection: { ownerId: string; jobId: string } | undefined): void;

    /** Scrolled into view as log lines arrive. */
    logEndRef: RefObject<HTMLDivElement | null>;

    run(): void;

    stop(): void;

    restart(): void;

    /**
     * Runs one `ai@1` task of the finished run again; every other task
     * keeps its result. `name` lets the input box say which task it is
     * asking about.
     *
     * Without `prompt`, the host offers the task's last prompt for
     * editing first and runs what comes back (the rail's rerun arrow).
     * With one, it is the whole message a person edited in the AI
     * Session tab, and it runs as written with nothing added. See
     * `editedRerun`.
     */
    rerunTask(taskId: string, name: string, plugin?: string, prompt?: string): void;

    openLink(url: string): void;

    /** Answers the pending gate. */
    decide(approved: boolean, reason?: string): void;

    /**
     * Hands a person's answer to the agent that asked for it.
     *
     * `sessionId` is the conversation's id, not the task's: the host
     * keeps no task-to-session map, and this view already has one in
     * {@link taskSessionIds}. The site is needed too, because the answer
     * is echoed into that task's log. `askId` says which question is
     * being answered - two can be open at once.
     *
     * Always passed. A session that ended before the answer arrives is
     * the host's to report, not this view's to guess at.
     */
    answerQuestion(
        site: { ownerId: string; taskIndex: number },
        sessionId: string,
        askId: string,
        answer: string
    ): void;

    /**
     * Sends a new, free-form message into a running task's session -
     * the AI Session tab's compose box.
     *
     * Same site shape as {@link answerQuestion}, for the same reason:
     * the host echoes the sent text into that task's own log.
     */
    sendMessage(
        site: { ownerId: string; taskIndex: number },
        sessionId: string,
        text: string,
        files?: SentFile[]
    ): void;

    /** The compose box's "@" file search - see `ChatViewProps.searchFiles`. */
    searchFiles?(query: string): Promise<FileMatch[]>;

    /**
     * SDD only - empty for other templates. The phase-to-file map from
     * the SpecState message: every stage in definition order, its
     * artifact when it is a document phase, and whether the file exists.
     */
    specStages: SpecStage[];

    /** Document contents by artifact path, filled as Document messages answer requests. */
    documents: Record<string, string>;

    /** Asks the host for a document's content - answered via {@link documents}. */
    requestDocument(path: string): void;

    /** Writes an edited document back to disk. The refreshed content and spec state come back as messages. */
    saveDocument(path: string, content: string): void;

    /**
     * SDD only. Start the named phase from the files alone - see the
     * StartPhase message.
     *
     * `revise` runs a phase again over the document it already wrote:
     * a human's edits and any answers under `## Open Questions` are the
     * input. With a style `revise` prompt the pass runs on that, from
     * the documents alone; without one, the phase prompt runs again on
     * the conversation behind the draft.
     */
    startPhase(stage: string, revise?: boolean, note?: string): void;

    /**
     * SDD only. Hand these tasks over - every remaining one from the
     * title's button, the open ones under a group, or the one a row's ▶
     * was pressed on. `wave` is the task's entry in the plan's
     * dependency graph, when it declared one. `run` is the task's
     * `Run:` line: such a task goes to the terminal, a workflow, or a
     * person's tick instead of an agent. `group` is the `## ` heading
     * it sits under.
     */
    startTasks(tasks: { id: string; text: string; wave?: number; line?: number; details?: string[]; run?: TaskRun; group?: string }[]): void;

    /** A plan row's `Run: `command``: run it as a shell command in the spec's folder. */
    runCommand(command: string): void;

    /**
     * A plan row's `Run: <workflow>`: start that workflow with the
     * params the row answers already; the rest are asked at start.
     */
    runWorkflow(name: string, params: Record<string, unknown>): void;

    /** The names a `Run:` line may resolve to - so a row can say when its name resolves to nothing. */
    workflows: string[];

    /** Tasks handed over and waiting for a repository another chat holds - the rows say so. */
    queuedTasks: string[];

    /**
     * Reopen the chat that did a piece of the work: the session that
     * drafted a document or implemented a task - its phase chat when it
     * has one, else its runtime's id.
     */
    openSession(chat: { sessionId?: string; chatId?: string }): void;

    /**
     * SDD only. The chats that implemented tasks, newest last - which
     * task each was launched for, on this machine. Empty for a spec
     * whose tasks were worked somewhere else.
     */
    taskSessions: TaskSession[];

    /** SDD only. Open a definition-declared file (a phase's prompt) in an editor tab. */
    openFile(path: string): void;

    /**
     * Every declared param with its current answer - what the Params tab
     * shows and edits.
     *
     * Not `workflow.params`: the definition carries an answer only once a
     * run has frozen one onto it, so an answer supplied but not yet run
     * would be missing there. Empty for a definition declaring none.
     */
    params: Param[];

    /**
     * Hands edited answers to the host. An empty value un-answers the
     * param rather than answering it with nothing - see the SetParams
     * message.
     */
    setParams(values: Record<string, unknown>): void;

    /**
     * Asks the host for the open dialog on one file or folder param.
     * What it picks arrives as `browsed`; a cancelled dialog sends
     * nothing.
     */
    browseParam(name: string): void;

    /**
     * The last thing the open dialog picked, for the Params tab to put
     * in that param's box. `seq` climbs per pick, so picking the same
     * path twice still lands. Undefined until a dialog has picked.
     */
    browsed?: BrowsedParam;

    /**
     * When the definition file was last written, as of the read that
     * produced what is on screen. The panel re-reads its file when it
     * opens, not when the file changes, so a time older than your last
     * save shows the edit has not been picked up.
     */
    savedAt?: number;

    /**
     * This workflow's recorded runs, newest first - what the Runs tab
     * lists. {@link outputs} and {@link context} are the live run; a row
     * here is a past run, summarised - see `RunSummary`.
     */
    runs: RunSummary[];

    /** Asks the host for the run list again - answered into {@link runs}. */
    requestRuns(): void;

    /**
     * Asks the host to go back to the workflow's runs landing - the
     * `<- Runs` link in the run view's bar. Absent for views with no
     * landing to go back to (a single task, an SDD spec).
     */
    showRuns?(): void;

    /**
     * Asks the host to throw away this workflow's recorded history.
     *
     * The host confirms with the person, decides which runs count as
     * history (a run parked at a gate does not), and answers with a
     * fresh {@link runs} list. The view must not empty its own list on
     * click: it has not been told the delete happened.
     */
    clearRuns(): void;

    /**
     * Asks the host to re-read the definition and send `Init` again -
     * what closing and reopening the panel does. The view resets itself
     * from that `Init`, so nothing is cleared here.
     */
    reload(): void;

    /** The column widths last dragged - see `PhasePanel`. */
    widths?: PanelWidths;

    /** Keeps the widths a drag ended on. Absent, no resize bar is drawn. */
    saveWidths?(widths: PanelWidths): void;
}

/**
 * The part of {@link TemplateRunViewProps} the SDD view reads.
 *
 * Extracted so a caller with a spec but no run can render the same
 * panel. `SddRunView` never touches the workflow-run fields (`workflow`,
 * `graph`, `runStatus`, ...), and requiring them would force a caller
 * to make up an execution graph for a folder of documents.
 * `TemplateRunViewProps` is assignable to this, so the run panel can pass
 * its own props.
 */
/**
 * The Doc tab's typing not yet saved, kept by the host through a reload:
 * edited documents and notes typed but not added, by document; the block
 * open for editing in place, with the source it opened on (`was`), so a
 * file changed since does not get the text spliced over other lines;
 * and the note being rewritten.
 */
export interface DocDrafts {
    docs: Record<string, string>;
    notes: Record<string, string>;
    block?: { doc: string; start: number; end: number; text: string; was: string };
    noteEdit?: { id: string; text: string };
}

export type SddViewProps = Pick<TemplateRunViewProps,
    | "specStages"
    | "documents"
    | "requestDocument"
    | "saveDocument"
    | "gate"
    | "decide"
    | "isRunning"
    | "title"
    | "startPhase"
    | "startTasks"
    | "runCommand"
    | "runWorkflow"
    | "workflows"
    | "queuedTasks"
    | "openSession"
    | "taskSessions"
    | "openFile"
    | "logsByTask"
    | "taskStatuses"
    | "pluginApps"
    | "pluginSandboxed"
    | "pluginBridge"
    | "widths"
    | "saveWidths"> & {

        /**
         * Stop the phase that is drafting now - kill its agent session.
         * Offered only by the spec panel; the run panel stops runs
         * through the run header, so it passes nothing and no second
         * Stop appears.
         */
        stopPhase?(): void;

        /**
         * The Doc tab's unsaved edits, by document, and its notes typed
         * but not added, by document and line - as saved before the page
         * last loaded, so a reload does not throw them away.
         */
        savedDocDrafts?: Partial<DocDrafts>;

        /** Called whenever an unsaved edit or note changes - for the host to keep. */
        onDocDraftsChange?(drafts: DocDrafts): void;

        /**
         * "Send notes to the chat" on the Doc tab: the open notes as one
         * message, put in the message box of the phase's chat - read back
         * and sent there.
         */
        notesToChat?(stageId: string, text: string): void;

        /**
         * The `Run:` task the plan is waiting on a person for - done by
         * hand, or a command whose exit code the terminal could not
         * report. Nothing runs while it waits, so the bar says it is
         * your turn and offers Mark done instead of Stop.
         */
        waitingTasks?: string[];

        /**
         * A conversation to go to - a phase, or an implementation chat
         * such as `implement@wave:2` - asked for from the chat's
         * history. Each new `seq` is one ask, so asking for the same one
         * twice moves there twice.
         */
        focus?: { ownerId: string; seq: number };

        /** Mark done: ticks that task's box, and the next wave starts. */
        markDone?(taskId: string): void;

        /**
         * The "Stop after current session" switch while implementation
         * sessions run: on, no queued session starts after the current
         * one. Offered only by the spec panel.
         */
        stopAfterCurrent?: boolean;

        setStopAfterCurrent?(on: boolean): void;

        /** The plan rows' commands running now that can be stopped - their button shows Stop. Spec panel only. */
        runningCommands?: string[];

        /** Stops a plan row's running command. */
        stopCommand?(command: string): void;

        /**
         * During the wait between two implementation sessions: when the
         * next one starts, as `Date.now()`. The bar counts down to it.
         */
        nextSessionAt?: number;

        /**
         * Every review note on this spec, across its documents. Shared
         * and committed with the spec, so the next person to open it -
         * on another machine, in a pull request - sees it.
         */
        notes: ReviewNote[];

        /**
         * The `sessionCost` feature flag: whether the usage card above
         * the compose box draws what the session has cost. Off - the
         * default, and what a surface that passes nothing gets - the
         * card shows the context window and each model's tokens, and
         * no money at all.
         */
        sessionCost?: boolean;

        /**
         * The `docDiff` feature flag: whether the Doc tab offers "What
         * changed", and the red-and-green view behind it. Off - the
         * default, and what a surface that passes nothing gets - the
         * document is read as it stands, and nothing marks what the last
         * run changed.
         */
        docDiff?: boolean;

        /** The whole set, rewritten. There are few of them; a partial update would need a merge. */
        saveNotes(notes: ReviewNote[]): void;

        /**
         * Each document as it stood before the last phase rewrote it.
         *
         * Three states: absent means nobody has asked yet, `null` means
         * the host answered and there is no version on record, and a
         * string is the text to compare against. Merging the last two
         * would mark every line of a first draft as new.
         */
        baselines: Record<string, string | null>;

        requestBaseline(path: string): void;

        /**
         * What a validator says about this spec. Optional; the Problems
         * tab appears only when it is given, because no validator runs
         * on a spec folder. Passing this is the
         * whole wiring - the tab is shared with the run panel (see
         * `ProblemsTab`).
         */
        problems?: readonly ValidationIssue[];

        /** Every session run of the spec, oldest first - what the pane lists. */
        sessionRuns?: SessionRunSummary[];

        /**
         * The lines of earlier runs the pane asked for, keyed by
         * `runKey`. A run the panel's own log still holds is read from
         * {@link logsByTask} instead.
         */
        sessionLines?: Record<string, LogLine[]>;

        /** Asks the host for one earlier run's lines - answered into {@link sessionLines}. */
        requestSessionLines?(ownerId: string, iteration: number): void;
    };

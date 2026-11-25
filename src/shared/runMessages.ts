import { RunStatus } from "../core/models/run";
import type { PluginAppSurface } from "../core/plugins/Plugin";

export const Messages = {

    Ready: "ready",

    RunWorkflow: "runWorkflow",
    StopWorkflow: "stopWorkflow",
    RestartWorkflow: "restartWorkflow",
    OpenLink: "openLink",

    /** A human answering a `trigger: manual` gate. */
    DecideGate: "decideGate",

    /**
     * A human answering a question an `ai@1` task's agent asked.
     *
     * Carries the agent session's id (see `taskSessionIds`), the ask's
     * id, and what was typed or picked. The host calls `respond` on the
     * session; a session that has since ended is said so in the log.
     *
     * Not `DecideGate`: a gate is the engine parking a run with two
     * answers. This is the agent asking mid-turn.
     */
    Answer: "answer",

    /**
     * The page asks to run one `ai@1` task of the finished run again.
     * Carries the task id and its display name. Every other task keeps
     * its result - the server re-runs only that task.
     *
     * `prompt` tells the two senders apart:
     *
     * - The rail's rerun arrow sends none. The host offers the task's
     *   own `prompt:` arg in an input box.
     * - The AI Session tab sends the prompt a person edited in the
     *   thread. No box opens. It is the whole composed message, so the
     *   rerun also sets `ai@1`'s `verbatim`. See `RunPanel.rerunTask`.
     */
    RerunTask: "rerunTask",

    /**
     * The page sends a new, free-form message into a running `ai@1`
     * task's session - the AI Session tab's compose box.
     *
     * Not `RerunTask`: the step keeps running and this adds to its
     * turn, rather than starting the step over. Not `Answer`: nothing
     * is waiting on this text, so the host calls `send` rather than
     * `respond`. See `RunPanel.sendMessage`.
     */
    SendMessage: "sendMessage",

    /**
     * The compose box's "@" file search: `{ requestId, query }` from the
     * page, answered with `FileMatches` - `{ requestId, files }`.
     */
    SearchFiles: "searchFiles",
    FileMatches: "fileMatches",

    /**
     * The page asks the host to re-read the definition and send `Init`
     * again - the same refresh a close-and-reopen does, without the
     * close. The host's rules still hold: a running or parked session
     * keeps the definition it is showing (see `RunPanel.pushInit`).
     */
    Reload: "reload",

    Init: "init",
    WorkflowStarted: "workflowStarted",
    WorkflowFinished: "workflowFinished",

    /** The run stopped at a gate and is waiting on a person. */
    Gate: "gate",
    GateResolved: "gateResolved",

    /**
     * A task's `artifact:` produced a run variable.
     *
     * Sent as it happens; the whole set also rides `Init`, so a panel
     * that opens onto a finished or parked run shows the same thing as
     * one that watched the run produce it.
     */
    Variable: "variable",

    /**
     * The file-level context a starting run resolved - anchors, `params:`
     * and file-level `vars:`.
     *
     * Sent once at run start rather than streamed: none of it changes
     * while the run goes on. It also rides `Init`, so a panel opening
     * onto a finished run sees the same thing.
     */
    Context: "context",

    /**
     * A task's `args:` resolved, as the plugin received them.
     *
     * Sent when the task runs, and the whole set rides `Init` for a
     * panel opening onto a finished or parked run.
     */
    TaskArgs: "taskArgs",

    /**
     * The context one task ran under - its own `cwd:`, `vars:` and
     * declared `env:`, after its job's and the file's are merged in.
     *
     * Per task because a job can declare `vars:` over the file's, so the
     * file-level answer is not this task's.
     */
    TaskContext: "taskContext",

    /**
     * A plugin handed back a tab for its step - see `PluginResult.ui`.
     * Sent when the step ends, and the whole set rides `Init` for a
     * panel opening onto a session this window still holds.
     */
    TaskUi: "taskUi",

    /**
     * Every plugin that ships an app, with each app's page ready to
     * show - see {@link PluginAppMessage}. Rides `Init` and is re-sent
     * after Reload Plugins.
     */
    PluginApps: "pluginApps",

    /** A plugin's app asking the host for something - see {@link PluginRequestMessage}. */
    PluginRequest: "pluginRequest",

    /** The host's answer, by the request's id - see {@link PluginReplyMessage}. */
    PluginReply: "pluginReply",

    /** An owner's status changed - a task's own (inline) or a job's (default). */
    OwnerStatus: "ownerStatus",
    TaskStatus: "taskStatus",
    Log: "log",

    /**
     * The run's `params:` and the answer each currently holds.
     *
     * Rides `Init`, and is re-sent whenever an answer changes - by the
     * Params panel, or by the prompt a run puts up when something has no
     * answer at all. A panel that edited a value and a prompt that took
     * one must never disagree about what the next run will use.
     */
    Params: "params",

    /**
     * The Params panel handing back edited answers.
     *
     * An empty value un-answers the param rather than answering it with
     * nothing, so a required one goes back to being asked for before the
     * next run - the only way out of an answer already given.
     */
    SetParams: "setParams",

    /**
     * The Params panel asking for the open dialog on one file or folder
     * param (`name`). Answered with `Browsed`.
     */
    BrowseParam: "browseParam",

    /**
     * What the open dialog picked for a param: `name` and `value` - a
     * path, or the paths of a list. Not sent for a cancelled dialog. The
     * panel puts it in the box; Save still records it.
     */
    Browsed: "browsed",

    /** SDD only. The phase↔file map: every stage, its artifact (if a document phase), and whether the file exists. */
    SpecState: "specState",

    /** The page asks for a document's content by its artifact path. */
    GetDocument: "getDocument",

    /** One document's content, answering GetDocument - and re-sent after a save. */
    Document: "document",

    /** The page hands back an edited document to write to disk. */
    SaveDocument: "saveDocument",

    /**
     * SDD only. Start the named phase from the files alone - no waiting
     * run required. The engine satisfies every phase whose document
     * already exists and enters at this one, with its own gate counted
     * as answered by this click.
     */
    StartPhase: "startPhase",

    /**
     * SDD only. Launch one native agent chat carrying these tasks - every
     * remaining one, or the one a row's ▶ was pressed on - each checkbox
     * ticked before the next begins. The engine never implements; the
     * ticked checkbox is the completion signal, and the watched
     * checkboxes report progress row by row. Starting the first task is
     * what approves the plan.
     */
    StartTasks: "startTasks",

    /**
     * SDD only. Reopen the chat that did a piece of the work - a phase's
     * document, or a task.
     */
    OpenSession: "openSession",

    /**
     * SDD only. The chats that implemented tasks: which task each one
     * was launched for, newest last.
     *
     * Sent apart from SpecState because it is answered from a different
     * place. A phase's session id comes from the run store. A task's
     * chat is kept in the workspace's store (taskSessions.ts).
     */
    TaskSessions: "taskSessions",

    /** SDD only. Open a file the definition itself declared - a phase's prompt - in a tab. */
    OpenFile: "openFile",

    /**
     * The page asks for this workflow's recorded runs - what the runs
     * landing lists.
     *
     * Asked for rather than pushed, and asked again on every `Init`. The
     * row for a run only exists once the engine has written it, which is
     * after `WorkflowStarted` reaches the panel. A panel that refreshed
     * on the start message alone would miss the run it just started.
     */
    GetRuns: "getRuns",

    /** This workflow's recorded runs, newest first, answering GetRuns. */
    Runs: "runs",

    /**
     * The page asks the host to open one recorded run as the panel's
     * subject - the runs landing's row click. The host replays the run
     * from the store into a session and attaches it, so what arrives
     * back is an ordinary `Init`: the run's own frozen definition, its
     * statuses, its logs.
     */
    OpenRun: "openRun",

    /**
     * The page asks to go back to the workflow's runs landing - the
     * `<- Runs` link. Host-driven rather than a local view flip: the
     * panel may be showing a stored run's session, and the landing must
     * sit on the workflow file's session again so its Run button runs
     * the file, not the record.
     */
    ShowRuns: "showRuns",

    /**
     * The page asks to leave the landing for the run view without
     * starting anything - the landing's Open button. What arrives back
     * is the definition at rest: every step pending, the gate marked,
     * args unresolved.
     */
    ShowWorkflow: "showWorkflow",

    /**
     * The page asks to throw away this workflow's recorded history.
     *
     * Carries nothing: the workflow is the session's own, and which runs
     * go is the server's rule: only finished runs can be cleared. A page naming ids
     * could ask to delete a run parked at a gate, which it may not.
     *
     * The host confirms with the person before deleting, then answers
     * with a fresh `Runs` list.
     */
    ClearRuns: "clearRuns",

    /**
     * The rail's width, in percent. `Layout` goes host to page on
     * `Ready`; `SaveLayout` comes back after a drag, and the host keeps
     * it for every run panel - see `PanelWidths`.
     */
    Layout: "layout",
    SaveLayout: "saveLayout",

} as const;

/**
 * One plugin's app, as the panel shows it.
 *
 * `html` is the whole page, assembled by the host: the plugin's own
 * `index.html` with its scripts and styles pulled inline and the `eesha`
 * client put in front. The page drops it into an iframe as-is.
 */
export interface PluginAppMessage {

    /** `id@version` - what a request from this page is addressed to. */
    ref: string;

    /** The plugin id alone, for anything keyed per plugin rather than per version. */
    id: string;

    label: string;

    /** Which panel the tab belongs in - see `PluginApp.surface`. */
    surface: PluginAppSurface;

    html: string;
}

/** What a plugin's app can ask for. `id` is the page's own, echoed on the reply. */
export type PluginRequestMessage =
    | { id: number; ref: string; kind: "call"; name: string; payload?: unknown }
    | { id: number; ref: string; kind: "db"; op: "run" | "get" | "all"; sql: string; params?: unknown[] | Record<string, unknown> }

    /** Start something: a task id in the run panel, a stage id in the spec panel, nothing for "the whole definition". `params` answers the workflow's `params:` first - whole definition only. */
    | { id: number; ref: string; kind: "run"; target?: string; params?: Record<string, unknown> };

export interface PluginReplyMessage {

    id: number;

    ok: boolean;

    value?: unknown;

    error?: string;
}

/**
 * How many recorded runs the landing asks for. A cap, because a
 * scheduled workflow has thousands of rows behind it. Fifteen fits on
 * one screen.
 */
export const RUN_LIST_LIMIT = 15;

/**
 * One recorded run, as the runs landing lists it.
 *
 * Deliberately not `RunRecord`: that carries the whole frozen workflow
 * snapshot, which is the largest thing in the database and of no use to
 * a list. Everything here is what a row draws.
 */
export interface RunSummary {

    id: string;

    /**
     * What the run resolved its `label:` to, when its file declared one.
     * Absent otherwise, and the list falls back to the workflow's name.
     */
    label?: string;

    status: RunStatus;

    startedAt: number;

    /** Absent for a run that never finished - one still going, or one lost to a crash. */
    finishedAt?: number;

    /**
     * The run this panel is showing right now.
     *
     * Decided on the host, which is the only side that knows the
     * session's run id. A page cannot work it out: `Init` carries the
     * id, but a panel showing a file that has never run carries none,
     * and every row would then match.
     */
    current?: boolean;
}

/** One stage in the SpecState message - name always, artifact only for document phases. */
export interface SpecStage {

    /**
     * The plan: this stage's document is worked from its own page -
     * boxes and ▶ on its rows - and the implementation starts from
     * there. See the style's `actionable:`.
     */
    actionable?: true;

    /**
     * Not a phase anyone visits: the output gate behind an actionable
     * stage. Still here because the chats it runs are filed under its
     * name; the rail leaves it out and the plan's tabs show its lines.
     */
    hidden?: true;

    /** The stage id - what every message names, and what the host acts on. */
    name: string;

    /**
     * What to show a person, when the style gives its phase a word of
     * its own. Absent means the id reads well enough.
     */
    label?: string;

    /**
     * The id this phase's own numbered items are cited by - `Req` for a
     * requirement, `Gap` for a gap analysis entry. Absent means the
     * document declares its own ids the grammar's default way, and the
     * view reads its headings for the plain `Requirement N` shape it has
     * always understood.
     */
    prefix?: string;

    artifact?: string;

    exists?: boolean;

    /**
     * The prompt file this phase runs, resolved and absolute, so a
     * person can read or edit it before running. One field whether it
     * is the style's shipped prompt or a `template:` file this
     * repository named; the panel has already resolved which won.
     */
    prompt?: string;

    /**
     * Whether this phase can be run again over the document it has
     * already written.
     *
     * Decided by the host, because the rule is about the style's
     * pipeline: any drafting phase holding a document, not only the
     * last one. A rewrite can leave later phases stale; the host names
     * those in a confirmation before the revise runs. The view still
     * hides the button while something is running, while a gate is
     * open, and once the implementation has started.
     */
    revisable?: boolean;

    /**
     * The provider's own id for the session that last drafted this
     * phase's document, when this machine has the run that held it.
     * Absent for a teammate's spec: their session was never here.
     */
    sessionId?: string;

    /**
     * Questions this phase's document raised that nobody has answered.
     *
     * Absent when there are none, and absent for every stage when the
     * style has `blockOnOpenQuestions: false`, so the view does not need
     * to know the setting.
     *
     * Present means the controls that advance past this phase are
     * refused, naming these. The phase's own Start and Revise are not:
     * running the phase again is how the answers get folded in.
     */
    openQuestions?: OpenQuestionRef[];

    /**
     * Starting sentences for this phase's revise box - the split button
     * beside Send. Already merged (style-wide first, then the stage's
     * own), already defaulted when the style declares none, and with
     * every `${{ spec.… }}` answered, so the view draws the list as it
     * is. Absent on a gate: nothing there is revised.
     */
    presets?: { label: string; text: string }[];

    /**
     * The runtime and model this phase runs on right now, and which
     * layer decided each - what the compose row's picker shows. Already
     * resolved down the whole ladder (the person's pick, the stage, the
     * style, settings.json, the plugin's default), so the view has
     * nothing to work out. Absent on a gate: nothing there runs a model.
     */
    ai?: StageAi;
}

/** See {@link SpecStage.ai}. */
export interface StageAi {

    provider: string;

    model: string;

    providerFrom: AiSource;

    modelFrom: AiSource;
}

/** Which layer set a value the picker shows. `pick` is the person's own choice in the panel. */
export type AiSource = "pick" | "stage" | "style" | "settings" | "default";

/**
 * What the picker on the compose row has to offer - sent once per
 * panel refresh, and again when the model list arrives.
 */
export interface AiChoiceMessage {

    /** Every runtime a phase can run on: the built-in two, then every `ai.acpAgents` id. */
    providers: string[];

    /**
     * The models each runtime offers, keyed by runtime id, once each
     * list has been fetched - Copilot's and Claude's from their CLIs,
     * an ACP agent's from its session config options. A runtime with
     * no entry yet has not answered, or could not; its dropdown then
     * offers `auto`, whatever is in effect, and a typed id.
     *
     * `multiplier` is the model's cost as a multiple of the base rate -
     * Copilot's premium requests, Kiro v3's credits - shown next to its
     * name. Other runtimes never send one.
     *
     * `disabled` is a model the account cannot run (Copilot's policy) -
     * shown greyed out, not pickable. `efforts` are the levels the Effort
     * picker offers for the model; `price` is the runtime's own cost text,
     * shown where there is no multiplier. `aliases` are other names for
     * the same model (Claude's `opus`), so a pick saved under one shows on
     * this row.
     */
    models?: Record<string, { id: string; name?: string; multiplier?: number; disabled?: boolean; efforts?: string[]; price?: string; aliases?: string[] }[]>;

    /**
     * The modes each runtime offers (Kiro v3's Default, Spec, Plan...),
     * keyed by runtime id, and the one a new session starts in. A runtime
     * with no entry has no modes, and the compose box shows no mode picker.
     */
    modes?: Record<string, { current?: string; modes: { id: string; name?: string; description?: string }[] }>;

    /**
     * The runtimes whose models and modes are still being fetched. The
     * compose box shows the model button as loading for one of these,
     * so it is not mistaken for a runtime with no list. A fetch that
     * ends, with a list or without, drops out of here, and the picker is
     * sent again.
     */
    loading?: string[];

    /**
     * The runtimes whose refresh button is fetching their list again.
     * The current list stays usable meanwhile; the button shows it is busy.
     */
    refreshing?: string[];

    /** The person's own pick, when one is in effect. Absent means the files decide. */
    pick?: { provider: string; model?: string; mode?: string; effort?: string };

    /**
     * Our own permission level for every runtime in
     * {@link providers}, and whether it is an ACP agent. Set, the compose
     * row shows the Permissions picker.
     */
    levels?: Record<string, { level: "manual" | "agent" | "semi" | "auto"; acp: boolean }>;

    /** With {@link levels}: how many saved answers hold for this chat. */
    savedAnswers?: number;
}

/** One unanswered question, as the view needs to name it. */
export interface OpenQuestionRef {

    /** The `QN-n` id, when the document wrote one. A document that did not still blocks. */
    id?: string;

    /** The question itself. */
    text: string;
}

/**
 * One implementation chat this machine started for a spec. Best-effort:
 * a task with no entry offers no button.
 */
export interface TaskSession {

    /**
     * What the chat was handed: a task's id from the plan when it got
     * one task, `wave:<n>` when it got a whole wave.
     */
    task: string;

    /**
     * Every task id the chat was handed, so a row can find the wave
     * chat that is working it. Absent: `task` alone says what it was for.
     */
    tasks?: string[];

    /**
     * The runtime's own id for the conversation. Absent until the
     * runtime has opened one - a wave chat is on record from its start.
     */
    sessionId?: string;

    /**
     * The phase chat the work runs in - a normal session, which the
     * page goes to. Absent for a chat from before waves ran in sessions.
     */
    chatId?: string;

    /**
     * The runtime the chat was opened on - `ghcp`, `kiro-cli`. The chat
     * stays on it until the Handover button moves it to a new chat.
     * Absent: not known.
     */
    provider?: string;

    /** When it was launched. Ordering only - newest wins for a task started more than once. */
    at: number;

    /**
     * The agent in it stopped working. The conversation can still be
     * reopened; this only says nobody is working in it now, which tells
     * a row waiting on an agent from one waiting on a person. Absent
     * means still going as far as this window knows.
     */
    ended?: boolean;

    /**
     * This window still holds the conversation, so a message typed into
     * it reaches somebody. Not the same as `ended`: a chat whose agent
     * has stopped is still held, and answering it is the point. False
     * for a chat this window never started, or one it has let go.
     *
     * Sent with the message, never written down - whether a session is
     * held is a fact about this window, not about the spec.
     */
    live?: boolean;

    /**
     * The plan stopped at this chat - Stop was pressed, or its agent
     * stopped with a box unticked - and a message into it puts the plan
     * back. The view shows a Resume button for it. Sent with the
     * message, never written down, like `live`.
     */
    resumable?: boolean;
}

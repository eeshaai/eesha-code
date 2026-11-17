import { GateRequest } from "../core/execution/callbacks";
import { ReviewNote } from "../view/templates/reviewNotes";
import type { TaskRun } from "./taskRun";
import { LogLine, LogMeta, ModelSpend, Spend } from "../core/models/run";
import {
    AiChoiceMessage, PluginAppMessage, PluginReplyMessage, PluginRequestMessage, SpecStage, TaskSession
} from "./runMessages";

/**
 * What the styles panel and its page say to each other.
 *
 * The page renders `SddRunView`, so these carry that view's own
 * vocabulary - {@link SpecStage}, {@link TaskSession}, {@link
 * GateRequest}. The panel does the translating: SDD core's model stops
 * at the server, and what crosses to the browser is what the
 * view already draws.
 */

export interface SpecMessage {

    name: string;

    /** Repository-relative. */
    path: string;

    style?: string;

    styleName?: string;

    specType?: string;

    /** Why it was placed where it was, in a sentence. */
    detection: string;

    /** In pipeline order - what the stepper draws. */
    stages: SpecStage[];

    /** Set when a phase is parked for a human. */
    gate?: GateRequest;
}

/**
 * The spec panel's column widths in percent of the panel, as last
 * dragged - the rail on the left and the sessions pane on the right. A
 * width missing means that column has not been dragged and keeps its
 * default.
 */
export interface PanelWidths {

    rail?: number;

    sessions?: number;

    /**
     * The sessions pane was hidden with the footer's button. Kept with
     * the widths so it stays hidden across specs and reloads until
     * shown again.
     */
    sessionsHidden?: boolean;
}

/**
 * One run of one owner's conversation, for the sessions pane - see
 * `SessionRun` in `runEvents.ts`, which this is without its lines.
 */
export interface SessionRunSummary {

    /** The phase, or the implementation chat - `implement@wave:2`. */
    ownerId: string;

    /** 1 for the owner's first run. */
    iteration: number;

    /** The run the panel's own log still holds. Only the last run of an owner can be. */
    current: boolean;

    at: number;

    sessionId?: string;

    provider?: string;

    model?: string;

    /** The revise note the person started it with, if any. */
    note?: string;

    /** How it ended, when it did - `success` or `failed`. */
    status?: string;

    /** The phase chat it ran in - a normal session. Absent for a run from before phase chats were sessions. */
    chatId?: string;
}

export type ToPanel =
    | { type: "ready" }
    | { type: "requestDocument"; path: string }
    | { type: "saveDocument"; path: string; content: string }
    | { type: "decide"; approved: boolean; reason?: string }

    /**
     * Start a phase. With `revise`, `note` is the revision instruction;
     * empty is a real answer - the phase runs again over the document as
     * it stands. Without it, `note` is a Kiro or Spec Kit spec's
     * description, which its first command takes.
     */
    | { type: "run"; stageId: string; revise?: boolean; note?: string }
    | { type: "cancel" }

    /** Mark done on a task the plan waits on a person for: tick its box, and the plan moves on. */
    | { type: "markDone"; taskId: string }

    /** The "Stop after current session" button: on, no queued implementation session starts after the one running now. */
    | { type: "stopAfterCurrent"; on: boolean }
    | { type: "implement"; tasks: { id: string; text: string; wave?: number; line?: number; details?: string[]; run?: TaskRun; group?: string }[] }

    /** A plan row's `Run: `command`` - run in a terminal, not by the engine. */
    | { type: "runCommand"; command: string }

    /** Stop a plan row's command that is running - only where the host can stop it. */
    | { type: "stopCommand"; command: string }

    /**
     * A plan row's `Run: <workflow>`: the workflow by name, with the
     * params the row already answers - what the engine knows of the
     * task, plus the `key=value` pairs on the line. The rest are asked.
     */
    | { type: "runWorkflow"; name: string; params: Record<string, unknown> }
    /** A chat that did a piece of the work: its phase chat when it has one - the page goes there - else its runtime's id. */
    | { type: "openSession"; sessionId?: string; chatId?: string }

    /**
     * "Send notes to the chat" on the Doc tab: the notes as one message,
     * put in the message box of the phase's chat - read back and sent
     * there. Answered with `phaseChat` and the text.
     */
    | { type: "notesToChat"; stageId: string; text: string }

    /**
     * The runtime and model every phase runs on from now, picked in the
     * compose row. One pick for the whole workspace, over every settings
     * file and style. No `pick` means reset: the files decide again.
     */
    | { type: "setAiChoice"; pick?: { provider: string; model?: string; mode?: string; effort?: string } }

    /** The refresh button beside a model picker - fetch the runtime's list again and replace its file. */
    | { type: "refreshModels"; provider: string }

    | { type: "open"; path: string }

    /** The whole set, rewritten. There are few of them, and a partial update is a merge nobody needs. */
    | { type: "saveNotes"; notes: ReviewNote[] }

    /** The document as it stood before the last phase wrote it - what the change marks compare against. */
    | { type: "requestBaseline"; path: string }

    /** A plugin's app asking the host for something - same shape as the run panel's. */
    | { type: "pluginRequest"; request: PluginRequestMessage }

    /** The lines of one earlier run, for the sessions pane - answered by `sessionLines`. */
    | { type: "requestSessionLines"; ownerId: string; iteration: number }

    /** Column widths the person just dragged - kept for every spec panel. */
    | { type: "saveLayout"; widths: PanelWidths };

export type ToSddView =
    | { type: "spec"; spec: SpecMessage }

    | { type: "document"; path: string; content: string }
    | { type: "busy"; stageId?: string }

    /**
     * Something the view sent for this phase never reached the spec -
     * the page says why. A line the view drew as sending is dropped.
     */
    | { type: "unsent"; stageId: string }
    /**
     * One line of a phase's log.
     *
     * `stream` and `meta` travel with it because the panel cannot
     * recover them from the text. `meta` is the plugin's own labelling
     * of the line (what it is, and a tool call's parts), and the AI
     * Session tab is built from it. Absent on lines the panel writes
     * itself.
     */
    | {
        type: "log";
        stageId: string;
        text: string;
        stream?: "stdout" | "stderr" | "system";
        meta?: LogMeta;
    }
    | { type: "sessions"; sessions: TaskSession[] }

    /** The workflows a plan row's `Run:` line may name - file names under `workflows/`, extension dropped. */
    | { type: "workflows"; names: string[] }

    /**
     * The tasks queued behind the wave being worked - see
     * `SddSpecPanel.implement`. `waiting` is the `Run:` task the plan
     * waits on a person to tick. Sent whenever either changes.
     *
     * `stopAfterCurrent` is the "Stop after current session" switch.
     * `nextStartsIn` is set during the wait between two sessions: the
     * seconds left before the next one starts.
     */
    | { type: "lanes"; queued: string[]; waiting: string[]; stopAfterCurrent?: boolean; nextStartsIn?: number }

    /** The plan rows' commands running now that can be stopped - their buttons show Stop. */
    | { type: "commands"; running: string[] }
    | { type: "error"; text: string }

    /** What the spec's AI picker offers and what is picked - see {@link AiChoiceMessage}. */
    | { type: "aiChoice"; choice: AiChoiceMessage }

    /** Opened from the chat's history: go to this phase's (or chat's) conversation. */
    | { type: "focus"; ownerId: string }

    /** Wipes a phase's log in the view - sent right before the "cleared" line so nothing old is left above it. */
    | { type: "clearLog"; stageId: string }

    /**
     * What a phase's earlier conversations charged - the drafts a re-run
     * or New Session took off the screen. The view adds it to the lines
     * it shows, so the total above the compose box covers every run of
     * the phase. Sent on replay and after every `clearLog`.
     */
    | { type: "spent"; stageId: string; spent: Spend[]; models: ModelSpend[] }

    /**
     * The `sessionCost` feature flag. Off - which is the default and
     * what a view assumes until this arrives - the usage card draws no
     * money at all. Its own message rather than a field on `spec`,
     * because it is read fresh from settings on every redraw and the
     * spec itself is not.
     */
    | { type: "features"; sessionCost: boolean; docDiff: boolean; handover?: boolean; toolResults?: boolean }

    /** Every note on this spec. */
    | { type: "notes"; notes: ReviewNote[] }

    /** `content` absent means no version was recorded - the view marks nothing rather than marking everything. */
    | { type: "baseline"; path: string; content?: string }

    /** Every plugin app, ready to show. `sandboxed` false means the profile's `debug: true` took the iframe sandbox off. */
    | { type: "pluginApps"; apps: PluginAppMessage[]; sandboxed: boolean }

    | { type: "pluginReply"; reply: PluginReplyMessage }

    /** The column widths last dragged. Sent on every refresh. */
    | { type: "layout"; widths?: PanelWidths }

    /** Every session run of this spec, oldest first, for the sessions pane. */
    | { type: "sessionRuns"; runs: SessionRunSummary[] }

    /** A phase just started in this chat - the page goes to it. */
    | { type: "phaseChat"; stageId: string; chatId: string; text?: string }

    /** One run's lines, as asked for by `requestSessionLines`. */
    | { type: "sessionLines"; ownerId: string; iteration: number; lines: LogLine[] };

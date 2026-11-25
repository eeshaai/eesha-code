import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AccountUsage, AskOption, AskPermission, ContextItem, ContextPart, ContextUsage, LogAttachment, ModelSpend, RuntimeCommand, Spend, addModelSpend, addSpend, isQuota } from "../core/models/run";
import { sumCells, totalCells, usageCell, usageCells, usageColumns, type UsageColumn, type UsageLine } from "./usageTable";
import { labelVerb } from "../core/agent/providers/describe";
import { latestPlan } from "./chat/PlanStrip";
import { Button, ChatResume, SavedAnswersModal, UsageButton, ChatAnswered, ChatHandoverLine, ChatIntro, ChatProse, ChatRetry, ChatToolCall, ChatToolRun, ChatTurn, ChatTurnNote, ChatTurnText, ChatMessage, ContextWindowButton, CopyButton, UsageCard, UsageRow, UsageSection, UsageTable, ModelRefreshButton, PlanStrip, StatusIndicator, ThinkingBlock, Chip, ClickAwayListener, ContextWindowMeter, ElapsedTimer, Input, MessageJumpButtons, Modal, PermissionPanel, PermissionCard as UiPermissionCard, PermissionLevelPicker, QuestionsPanel, QuestionType, SavedPermissionsList, Select, ShortTime, Progress, PromptInput, PromptInputProvider, Textarea, Toggle, ToolGroup, ToolPanel, UiIcon, UsageBar, usePromptInputContext } from "./ui";
import { ToolBody, readFile, readRange, toolHeading, toolIcon, toolSummary } from "./chat/toolKinds";
import Markdown from "./Markdown";
import { fileToBase64 } from "./files/attachments";
import { commandItems, fileItems, pathItems, toolItems } from "./mentions/mentionItems";
import { cleanText, LogEntry } from "./templates/logEntry";
import { elapsedText } from "./templates/runList";
import { pathLabel } from "./text/changedFiles";
import { joinMultiAnswer } from "./text/multiAnswer";
import { thinkingSummary } from "./text/plainLine";
import { prettyJson } from "./text/prettyJson";
import { AiChoiceMessage, AiSource, StageAi } from "../shared/runMessages";
import type { AgentModeOption, ContextWindowSegment, McpServerOption, ModelOption, PromptInputAttachment, ProviderPart, PromptInputReference, Question, QuestionAnswer, ToolOption, ToolSelection } from "./ui";
import { MAX_UPLOAD_BYTES } from "../shared/composeFiles";
import type { FileMatch, PathMatch, SentFile } from "../shared/composeFiles";
import {
    ACP_LEVEL_NOTE, ACP_LEVELS, ANSWER_WORDS, answerText, KIND_NAMES, LEVEL_NAMES, levelHint, SDK_LEVELS,
    type AnswerScope, type CardAnswer, type PermissionCard as GateCardData, type PermissionLevel
} from "../core/models/permissionCard";
import type { SavedAnswerRow } from "../shared/chatMessages";
import { contextFile, isFullPath, plainPath } from "../shared/contextFiles";

/**
 * The runtime and model picker on the compose row.
 *
 * `current` is what the phase behind this thread runs on right now,
 * resolved by the host down the whole ladder, with which layer said
 * so. `choice` is what can be picked. `onPick` sets the pick for the
 * whole workspace; called with nothing, it clears the pick and the
 * files decide again.
 */
export interface ComposeAi {

    current: StageAi;

    choice: AiChoiceMessage;

    onPick(pick?: { provider: string; model?: string; mode?: string; effort?: string }): void;

    /**
     * The chat has started, so it stays on its runtime: the runtime
     * picker is locked. Only Handover (below) or a new chat moves it.
     */
    locked?: boolean;

    /**
     * A spec's phase chat: the spec picks the model and effort, in the
     * spec tab's header. The line here shows only the runtime - a model
     * or effort picked here would be thrown away, since the turn runs on
     * the spec's AI. No mode either: see {@link noMode}.
     */
    held?: boolean;

    /**
     * No Mode button: a spec's header. Every phase writes files, so a
     * mode like Plan could only stop it from writing its document. The
     * engine runs the runtime's own default mode (sddConfig.ts `aiFor`).
     */
    noMode?: boolean;

    /**
     * The Handover button, when the `handover` flag is on and the chat
     * has started.
     */
    handover?: ComposeHandover;
}

/** What the Handover modal calls back - see {@link ComposeAi.handover}. */
export interface ComposeHandover {

    /** Start: stop this chat's session and carry on on this runtime and model. */
    onStart(pick: { provider: string; model?: string }): void;

    /** A runtime was picked in the modal - its model list may not be fetched yet. */
    onModels(provider: string): void;
}

/**
 * The Permissions dropdown: our own check's level for the runtime
 * this chat is on. Where it is given, it is drawn on the compose row.
 */
export interface ComposeLevels {

    level: PermissionLevel;

    /** The runtime is an ACP agent: Agent's Choice in Manual's place. */
    acp: boolean;

    /** The runtime as the header names it. */
    runtimeName: string;

    /** How many saved answers hold for this chat - the foot row's count. */
    savedAnswers: number;

    onPick(level: PermissionLevel): void;

    /** "Saved answers" at the foot: open the list. */
    onSavedAnswers(): void;
}

/**
 * The UI library's Tools and MCP servers pickers on the compose row:
 * what is on offer, and the pick to show. What is picked goes back with
 * each message (see `ChatViewProps.onSend`).
 */
export interface ComposeTools {

    tools: ToolOption[];

    mcpServers: McpServerOption[];

    /**
     * The pick to show. A new object puts it in the pickers again - a
     * different chat opened, say - so the caller keeps one per pick.
     */
    selection: ToolSelection;
}

/**
 * The conversation with the agent, drawn as a thread.
 *
 * Five kinds of line are drawn: what the person sent, what the agent
 * said, what it thought, the tools it called, and the questions it
 * stopped to ask. Everything else - engine output and runtime `notice`
 * lines - is narration about the session and goes to the Logs tab.
 *
 * This works because `ai@1` labels each line (`kind` and the tool
 * call's parts travel as `LogMeta`), so nothing here guesses from text.
 */

export interface ChatViewProps {

    entries: readonly LogEntry[];

    /** Shown in the body when nothing has arrived yet. */
    emptyText?: string;

    /**
     * Takes the person's answer to a question the agent asked, by the
     * ask's id. Absent, a question is drawn with no answer box: the
     * surface has no live session to send an answer to.
     */
    onAnswer?(askId: string, answer: string): void;

    /**
     * Takes an edited prompt and runs the task again on it.
     *
     * The text handed back is the whole message as sent, so whatever
     * runs it must send it exactly - see `ai@1`'s `verbatim` arg.
     *
     * Absent, the prompt is read-only. Surfaces withhold it while a run
     * is going, and a replayed conversation never has it.
     */
    onRerun?(prompt: string): void;

    /**
     * "Go back to here" under one of the person's messages, and Send on
     * one edited in place (`edited`). `turnId` is the message's turn -
     * its first line's entry id - and `text` the message as shown. Drawn
     * only while the agent is not working. Absent: neither is offered.
     */
    onGoBack?(turnId: string, text: string, edited?: string): void;

    /**
     * Sends a new, free-form message into the turn in flight. Absent,
     * no compose box is drawn - the surface has no live session to send
     * into, or the step is not running.
     *
     * `files` are what was attached in the box - see `composeFiles.ts`.
     */
    onSend?(text: string, files?: SentFile[], tools?: ToolSelection): void;

    /**
     * The compose box's "@" file search, answered by the host. Absent,
     * "@" is plain text.
     */
    searchFiles?(query: string): Promise<FileMatch[]>;

    /**
     * The compose box's ">" list (the connectors), answered by the
     * host: the rows one level below `path`. Absent, ">" is plain text.
     * `refresh`: the person picked the refresh row - ask the service again.
     */
    searchPaths?(path: string[], query: string, options?: { refresh?: boolean }): Promise<PathMatch[]>;

    /**
     * Stops the agent. Drawn as the compose box's Send button while
     * `running` is true and nothing is typed - once text is typed the
     * button is Send again, so a message can still go in mid-turn.
     * Absent, the button is only ever Send.
     */
    onStop?(): void;

    /** The Stop button's tooltip - what stopping ends here. Absent, a plain one. */
    stopTitle?: string;

    /**
     * What is typed in the compose box, kept by the caller rather than
     * the box itself.
     *
     * The tab this thread sits in only renders while it is the open
     * one (see `PhasePanel`), so a box that kept its own state would
     * forget what was half-typed the moment a reader switched tabs and
     * came back. Absent, the box keeps its own state instead - a caller
     * with nowhere durable to put it still gets a working box, just
     * without the persistence.
     */
    composeDraft?: string;

    /** Where a keystroke in the compose box goes - see {@link composeDraft}. */
    onComposeDraftChange?(text: string): void;

    /**
     * Starting sentences the compose box offers from a small menu beside
     * Send. Picking one only fills the box - same as typing it by hand -
     * so whoever picked it still reads the text and can edit it before
     * anything is sent. Absent or empty, no menu is drawn.
     */
    composePresets?: readonly { id: string; label: string; text: string }[];

    /**
     * The runtime and model picker on the compose row - see
     * {@link ComposeAi}. Absent, the row has no picker; the surface
     * has no way to change what a phase runs on.
     */
    composeAi?: ComposeAi;

    /**
     * The refresh button beside the model picker (and in the Handover
     * modal): fetch this runtime's model list again. Absent, no button.
     */
    onRefreshModels?(provider: string): void;

    /**
     * Asks the host to compact this conversation - the Compact button in
     * the context meter's panel. Shown only when the newest context
     * reading says its session can (`ContextUsage.compactable`), and
     * disabled while a turn runs. Absent, no button.
     */
    onCompact?(): void;

    /**
     * The Permissions dropdown - see {@link ComposeLevels}. Absent, no
     * dropdown is drawn.
     */
    composeLevels?: ComposeLevels;

    /** The saved answers list, while it is open - see {@link SavedAnswersList}. */
    savedAnswers?: SavedAnswersList;

    /**
     * The runtime, mode and model pickers in the compose box's bottom row,
     * left of the Permissions dropdown, instead of a line of their own above the text.
     * For a wide page, such as the chat page.
     */
    composeAiInToolbar?: boolean;

    /**
     * The runtime, mode, model and permission names in the compose box, and
     * the names in their lists, in capital case: "copilot" reads "Copilot".
     * The chat page sets it.
     */
    composeCapitalNames?: boolean;

    /**
     * The Usage button and the context window's meter button, in the
     * compose box and in the bar that takes its place while a question
     * is open. Default on. The chat page turns them off: its Session
     * panel shows both.
     */
    showMeters?: boolean;

    /**
     * The Tools and MCP servers pickers - see {@link ComposeTools}.
     * Absent, neither picker is drawn and nothing about tools is sent.
     */
    composeTools?: ComposeTools;

    /**
     * Drawn in the foot above the compose box - the chat's
     * changed-files bar. Absent, nothing is.
     */
    composeHeader?: React.ReactNode;

    /**
     * Files to put in the compose box as file chips - see the `addFiles`
     * message. Held until the box is on screen (an open question card
     * hides it). `onComposeFilesAdded` is called once they are in, so the
     * caller drops them and a redraw does not add them again.
     */
    composeAddFiles?: readonly { path: string; name?: string }[];
    onComposeFilesAdded?(): void;

    /**
     * Set: the box is off and never sends - an evaluation's variant that
     * got its one message. The text is the box's placeholder. Its Stop
     * still works.
     */
    composeSendOff?: string;

    /** The box's placeholder, when it is not the usual "Reply - Enter to send". */
    composePlaceholder?: string;

    /**
     * The runtime's slash commands. "/" as the first character in the
     * box lists them; a pick writes "/name " into the box. A "/" anywhere
     * else is plain text, and so is a first "/" when there are none.
     */
    composeCommands?: readonly RuntimeCommand[];

    /**
     * Opens a file when an attachment chip is clicked.
     * Absent, the chips are still drawn but disabled.
     */
    onOpenFile?(path: string): void;

    /**
     * Opens a file listed in the context window - a steering file, a
     * CLAUDE.md. Its own call, apart from `onOpenFile`, because such a
     * file can be outside the session's folders, and the host shows it
     * only when the runtime listed it. Absent, those rows are plain text.
     */
    onOpenContextFile?(path: string): void;

    /**
     * Whether the agent is still working, for the compose box's own
     * hint about where a message sent mid-turn goes.
     */
    running?: boolean;

    /**
     * The agent was stopped with work left. Shows a Resume button at the
     * end of the thread that sends {@link RESUME_MESSAGE} through
     * `onSend`, the same as typing it. Not shown while running, or when
     * the last turn already has Retry.
     */
    resumable?: boolean;

    /**
     * What this conversation's earlier, no-longer-shown runs charged.
     * Added to what `entries` charged, so the total in the foot covers
     * every run of the phase and not only the lines on screen. Absent
     * when nothing was hidden.
     */
    spentBefore?: readonly Spend[];

    /** The same carried-over charges split by model - see {@link spentBefore}. */
    modelsBefore?: readonly ModelSpend[];

    /**
     * What each phase of the spec this conversation belongs to has
     * charged, with each phase's chats under it - the usage card's
     * Totals table. Absent on a surface with no spec above the
     * conversation, such as the run panel or a plain chat; there the
     * card shows the session split by model instead.
     */
    phaseUsage?: readonly UsageLine[];

    /**
     * Whether the usage card draws money at all - the `sessionCost`
     * feature flag.
     *
     * Absent or false, which is the default everywhere, the card shows
     * the context window and how many tokens each model read and wrote,
     * and not one figure in dollars or credits. The figures are still
     * recorded, so turning the flag on shows the whole history back.
     */
    showCost?: boolean;

    /**
     * Whether an opened tool card shows what the finished call returned.
     * The `toolResults` feature flag. Absent or false, the default, it
     * shows only whether the call worked and how long it took.
     */
    showToolResults?: boolean;
}

/**
 * One tool call: `tool.start` and `tool.end` are two lines about one
 * call, and the thread shows them as one row.
 */
interface ToolCall {

    id: string;

    name: string;

    /** The vendor's id for the call, when it gave one - what its end is matched on. */
    callId?: string;

    /** What the call was given. */
    detail?: string;

    /**
     * The engine said "yes" to this call by itself (Allow all, or Manual
     * with nobody watching). The row says so on its header.
     */
    allowed?: boolean;

    /**
     * Our own check's word on the call, drawn after its name:
     * "allowed by your answer `npm run build *` (this session)",
     * "refused: ~/.ssh is never allowed, in any mode".
     */
    note?: string;

    /** Our own check refused the call - it did not run. */
    refused?: boolean;

    /**
     * A row that is only a request, with no call of its own - one with no
     * call id. Its argument is what was asked.
     */
    request?: boolean;

    /**
     * On an `allowed` call: what the runtime asked to run, exactly as it
     * sent it. Shown when the row is opened, if it says something the
     * call's own argument does not.
     */
    asked?: string;

    /**
     * What the call has printed so far, while it is still running -
     * only when the `liveToolOutput` feature flag is on and the
     * provider streams it. It is dropped as the call finishes: the
     * outcome is the record of what came back.
     */
    output?: string;

    /** Absent while it is still running. */
    outcome?: { ok?: boolean; ms?: number; detail?: string };
}

/**
 * A turn that is text and nothing else. Named because `ThinkingBlock`
 * and the merge rule in `turnsFrom` both take one on its own.
 */
type ProseTurn = {
    id: string;
    shape: "user" | "ai" | "thought" | "failed";
    agent?: string;
    text: string;

    /**
     * When its last line arrived - the moment it was finished. A turn
     * is several log lines joined, and the newest one's time is when
     * the agent stopped writing it.
     */
    at: number;

    /**
     * This turn is the message the task was sent. It is the only turn
     * that can be edited and rerun: an `answer` looks identical and sits
     * on the same side, but it is a reply to a mid-turn question, and
     * rerunning with it would send the reply as the instruction.
     */
    prompt?: boolean;

    /** The files sent with the message, on the prompt turn only. They are not in `text`. */
    attachments?: readonly LogAttachment[];

    /** Lines sent to the agent under the message - see `LogMeta.sentWith`. On the prompt turn only. */
    sentWith?: readonly string[];

    /** A prompt the view drew before the host logged it - see `LogMeta.pending`. */
    pending?: "sending" | "failed";

    /**
     * Still being written. Drawn with a caret, and never joined to the
     * turn before it; the completed line that follows replaces it. See
     * `withLine`.
     */
    live?: boolean;

    /**
     * The tokens the turn that ended with this answer read and wrote, as
     * the runtime reported them - drawn under the answer by the UI
     * library's UsageBar. Absent when the runtime reported no counts.
     */
    usage?: { inputTokens: number; outputTokens: number };
};

/**
 * A turn of the conversation. `tools` is a run of calls with nothing
 * said between them, drawn as one block with one row per call.
 */
type Turn =
    | ProseTurn
    | { id: string; shape: "tools"; agent?: string; calls: ToolCall[] }

    /**
     * A line across the thread where the chat moved to another runtime
     * (the Handover button). `file` is the saved transcript, opened on a
     * click.
     */
    | { id: string; shape: "handover"; agent?: string; text: string; file?: string }

    /**
     * The agent asking, and waiting. Open, it carries the answer box;
     * answered, it carries the answer. An `answer` line closes the
     * question it names and is drawn inside it, not as its own turn.
     */
    | {
        id: string;
        shape: "ask";
        agent?: string;
        askId: string;
        text: string;
        options?: AskOption[];
        multi?: boolean;

        /** Set when the question is a permission request - drawn as a request, not a question. */
        permission?: AskPermission;

        /** When it was asked, so an unanswered one can say how long it has been waiting. */
        at: number;

        /** The person's reply, once there is one. */
        answer?: string;

        /**
         * Closed by a message the person sent into the conversation
         * rather than by an answer naming it - see `turnsFrom`. `answer`
         * is empty then, and the question is drawn as plain text with
         * no answer row: the reply is the message turn that follows.
         */
        viaMessage?: boolean;
    };

/**
 * The kinds that are turns in the conversation, and which side of the
 * thread each sits on. Everything else is narration about it.
 */
const SPOKEN: Record<string, "user" | "ai" | "thought" | "failed"> = {
    "prompt": "user",
    "message": "ai",
    "reasoning": "thought",

    // The person's reply to a question sits on their side.
    "answer": "user",

    "error": "failed"

    /*
     * `notice` is deliberately absent. Notices are the bulk of what a
     * session emits, and drawn here they buried the exchange. The Logs
     * tab has every one.
     */
};

type AskTurn = Extract<Turn, { shape: "ask" }>;

/**
 * Groups adjacent questions into batches - several questions asked in
 * the same message land as consecutive `ask` turns with nothing between
 * them, and that run is what a batch is. A question asked long after an
 * unrelated one happened to still be open is not adjacent, and is its
 * own batch of one.
 */
function askBatches(turns: readonly Turn[]): readonly AskTurn[][] {

    const batches: AskTurn[][] = [];

    for (let i = 0; i < turns.length;) {

        if (turns[i].shape !== "ask") {

            i++;
            continue;
        }

        let end = i;

        while (end < turns.length && turns[end].shape === "ask")
            end++;

        batches.push(turns.slice(i, end) as AskTurn[]);

        i = end;
    }

    return batches;
}

/**
 * The card for a batch of open questions, pinned at the foot of the thread.
 *
 * A permission request is drawn as one - the UI library's PermissionPanel:
 * the tool, what it would be given, and a button per answer the agent
 * offers - one request at a time. Anything else is the library's
 * QuestionsPanel: one question at a time, Back and Next between them, and
 * Submit on the last, which sends every answer at once.
 *
 * Answered members of the batch are drawn as ordinary turns, above this
 * (see the caller).
 */
function AskCard({ batch, onAnswer }: {
    batch: readonly AskTurn[];
    onAnswer: (askId: string, answer: string) => void;
}) {

    const open = batch.filter(turn => turn.answer === undefined);

    const request = open.find(turn => turn.permission);

    // Our own check's card - drawn by us, not the runtime's choices.
    if (request?.permission?.card)
        return <GateCard key={request.askId} turn={request} card={request.permission.card} onAnswer={onAnswer} />;

    if (request)
        return <PermissionCard key={request.askId} turn={request} onAnswer={onAnswer} />;

    if (!open.length)
        return null;

    return <QuestionsCard key={open.map(turn => turn.askId).join(",")} open={open} onAnswer={onAnswer} />;
}

/**
 * A permission request: the library's PermissionPanel, and under it a way
 * to refuse with a reason. Typed words never allow anything - both
 * runtimes read them as a no, and Copilot hands them to the agent as the
 * reason, so it can try something else.
 */
function PermissionCard({ turn, onAnswer }: {
    turn: AskTurn;
    onAnswer: (askId: string, answer: string) => void;
}) {

    const [reason, setReason] = useState("");
    const [sent, setSent] = useState<string>();

    const send = (value: string): void => {

        if (sent !== undefined)
            return;

        setSent(value);
        onAnswer(turn.askId, value);
    };

    // What was just sent, until the echoed line arrives with the same words.
    if (sent !== undefined)
        return <ChatAnswered answer={sent} />;

    return (
        <div className="chat-permission">

            <PermissionPanel
                request={{ toolName: turn.permission!.tool, inputText: prettyJson(turn.permission!.input ?? "") }}
                isResponding={false}
                options={(turn.options ?? []).map(option => ({
                    label: option.label,
                    description: option.description,
                    allows: option.allows
                }))}
                onChoose={label => send(label)} />

            <form
                className="chat-permission__reason"
                onSubmit={event => {

                    event.preventDefault();

                    if (reason.trim())
                        send(reason.trim());
                }}>

                <Input
                    aria-label="Refuse with a reason"
                    placeholder="Or refuse, and tell the agent why"
                    value={reason}
                    onChange={event => setReason(event.target.value)} />

                <Button type="submit" size="sm" fill="outline" variant="danger" disabled={!reason.trim()}>
                    Refuse
                </Button>
            </form>
        </div>
    );
}

/**
 * The folders never offered on the outside-folder card.
 * The card is our own, so Eesha Code's profile folder is the one named.
 */
const NEVER_OFFERED = "Never offered, in any mode: ~/.eesha, the agents' own settings folders"
    + " (~/.claude, ~/.copilot, ~/.kiro), ~/.ssh, ~/.aws, a drive root and your home folder."
    + " Calls there are refused without a card.";

/**
 * A card from our own permission check.
 * Drawn by the UI library's PermissionCard; what is said here is what
 * only Eesha Code knows: the chat's folders on an outside-folder card,
 * why edits have no Always, and the folders never offered. The answer
 * goes back as one line - see answerText.
 */
function GateCard({ turn, card, onAnswer }: {
    turn: AskTurn;
    card: GateCardData;
    onAnswer: (askId: string, answer: string) => void;
}) {

    const [sent, setSent] = useState<string>();

    const send = (answer: CardAnswer): void => {

        if (sent !== undefined)
            return;

        const text = answerText(answer);

        setSent(text);
        onAnswer(turn.askId, text);
    };

    // What was just sent, until the echoed line arrives with the same words.
    if (sent !== undefined)
        return <ChatAnswered answer={sent} />;

    const input = turn.permission?.input;

    // What the call was handed, for a tool whose input is not the line shown.
    const showInput = input && input !== card.shown && card.type !== "command" && card.type !== "chained" && card.type !== "outside";

    const lines = [
        ...(card.outside ? [`This session's folders: ${card.outside.chatFolders.join(", ") || "none"}`] : []),
        ...(card.lines ?? [])
    ];

    return (
        <UiPermissionCard
            title={card.title}
            level={card.level}
            shown={card.shown}
            sentAs={card.sentAs}
            where={card.where}
            input={showInput ? input : undefined}
            lines={lines}
            patterns={card.remember}
            defaultPattern={card.pick}
            scopes={card.scopes}
            scopeLabels={SCOPE_BUTTONS}
            folders={card.outside?.folders}
            folderNote={OUTSIDE_FOLDER_NOTE}
            addFolderLabel="Add folder to this session"
            notes={card.type === "edit" && card.scopes.length > 0 ? [EDIT_NOTE] : undefined}
            explainButtons={card.type !== "chained"}
            noReason={card.noReason}
            footnote={card.type === "outside" ? NEVER_OFFERED : undefined}
            onAnswer={send} />
    );
}

/** Under the folders an outside-folder card offers to add. */
const OUTSIDE_FOLDER_NOTE = "An added folder works like one you add with the folder button. The agent can read and edit"
    + " there, under the session's Permissions level, and this session does not ask about it again.";

/** Why an edit card has no Always button. */
const EDIT_NOTE = "Always is not offered for edits. A file path only means something inside one folder.";

/** The button for each way to save a yes. */
const SCOPE_BUTTONS: Readonly<Record<AnswerScope, string>> = {
    session: ANSWER_WORDS.session,
    folder: ANSWER_WORDS.folder,
    always: ANSWER_WORDS.always
};

/**
 * The open questions: the library's QuestionsPanel. A question with
 * choices takes one (or, when several may be picked, any number) plus
 * words of the person's own; one without takes words. A typed number
 * still picks the choice it points at - see {@link resolveAnswer}. Every
 * answer goes when Submit is pressed, blank ones included: a blank reply
 * is a deliberate answer, and the agent is told there is nothing more.
 */
function QuestionsCard({ open, onAnswer }: {
    open: readonly AskTurn[];
    onAnswer: (askId: string, answer: string) => void;
}) {

    // Made once for this set of questions: the panel starts again at the
    // first question whenever it is handed a new list.
    const questions = useMemo<Question[]>(() => open.map(turn => ({
        id: turn.askId,
        text: turn.text,
        type: !turn.options?.length
            ? QuestionType.FreeText
            : turn.multi
                ? QuestionType.MultiChoice
                : QuestionType.SingleChoice,
        options: turn.options?.map(option => option.label),
        optionDescriptions: turn.options?.map(option => option.description ?? ""),
        allowOtherOption: true
    })), []); // The key on the caller's element remounts this for a new set.

    const [answers, setAnswers] = useState<Record<number, QuestionAnswer>>({});

    /** What went, per question - shown at once, until the echoed lines arrive. */
    const [sent, setSent] = useState<string[]>();

    // The card closes on Submit rather than waiting for the echo, so the
    // same questions cannot be answered twice. What was sent stays showing.
    if (sent)
        return (
            <div className="chat-ask-card">
                {open.map((turn, index) => (
                    <div key={turn.askId}>
                        <div className="chat-ask-card__question">{turn.text}</div>
                        <ChatAnswered answer={sent[index]} />
                    </div>
                ))}
            </div>
        );

    return (
        <QuestionsPanel
            className="chat-ask-card"
            questions={questions}
            retryCount={0}
            answers={answers}
            errors={{}}
            isSubmitting={false}
            onAnswerChange={(index, value) => setAnswers(current => ({ ...current, [index]: value }))}
            onSubmit={() => {

                const finals = open.map((turn, index) => resolveAnswer(questionAnswerText(answers[index], turn.options), turn.options, turn.multi));

                setSent(finals);

                open.forEach((turn, index) => onAnswer(turn.askId, finals[index]));
            }} />
    );
}

/** A question's answer as one line of text: words as typed, or the ticked options and the typed text joined. */
function questionAnswerText(answer: QuestionAnswer | undefined, options: readonly AskOption[] | undefined): string {

    if (answer === undefined)
        return "";

    if (typeof answer === "string")
        return answer;

    return joinMultiAnswer((options ?? []).map(option => option.label), answer.picked, answer.other);
}

/** The name of a row that is only a request allowed without asking - one with no call id. */
const ALLOWED_PREFIX = "Allowed without asking: ";

/** The mark on a call's row when the engine allowed it by itself. */
const ALLOWED_MARK = "auto-allowed";

export function turnsFrom(entries: readonly LogEntry[]): Turn[] {

    const turns: Turn[] = [];

    /**
     * Requests allowed without asking whose call has no row yet, by the
     * call's id. A runtime can ask before it reports the call started;
     * the row picks the mark up when it arrives.
     */
    const allowedAhead = new Map<string, LogEntry>();

    /** Marks a call's row as allowed without asking. */
    const markAllowed = (call: ToolCall, entry: LogEntry): void => {

        call.allowed = true;

        if (entry.permission?.note) {

            call.note = entry.permission.note;

            if (entry.permission.refused)
                call.refused = true;
        }

        const input = entry.permission?.input;

        if (input && input !== call.detail)
            call.asked = input;
    };

    /** The row of the call an allowed request names, in any turn. */
    const rowOf = (callId: string): ToolCall | undefined => {

        for (let index = turns.length - 1; index >= 0; index--) {

            const turn = turns[index];

            const call = turn.shape === "tools" ? turn.calls.find(one => one.callId === callId) : undefined;

            if (call)
                return call;
        }

        return undefined;
    };

    /**
     * Closes the open call a `tool.end` belongs to.
     *
     * Every turn is searched, not just the last block. A call's two
     * halves are not always adjacent: Copilot reports progress as a
     * notice while a call runs, and ACP can put a plan or mode change in
     * the same gap. Stopping at the first non-tool turn left the start
     * stuck on "running" and drew the end as a second row.
     */
    const finish = (entry: LogEntry): boolean => {

        /*
         * By id where there is one, and only then by name. A model
         * issues several `Read`s in one message and their ends arrive
         * in any order, so matching by name alone paired durations with
         * the wrong calls. The name is the fallback for a provider that
         * gave no id.
         */
        const matches = (one: ToolCall): boolean => !one.outcome
            && (entry.callId && one.callId
                ? one.callId === entry.callId
                : one.name === entry.tool);

        for (let index = turns.length - 1; index >= 0; index--) {

            const turn = turns[index];

            if (turn.shape !== "tools")
                continue;

            const call = [...turn.calls].reverse().find(matches);

            if (call) {

                call.outcome = { ok: entry.ok, ms: entry.ms, detail: entry.detail };

                return true;
            }
        }

        return false;
    };

    /** Puts a running call's newest output on the row it belongs to. */
    const printing = (entry: LogEntry): void => {

        for (let index = turns.length - 1; index >= 0; index--) {

            const turn = turns[index];

            if (turn.shape !== "tools")
                continue;

            const call = [...turn.calls].reverse().find(
                one => !one.outcome && one.callId && one.callId === entry.callId);

            if (call) {

                call.output = entry.message;

                return;
            }
        }
    };

    for (const entry of entries) {

        const last = turns[turns.length - 1];

        // A turn's token report goes on the answer it came after. The
        // line itself is narration and is not drawn.
        if (entry.models?.length)
            countTokens(turns, entry.models);

        // Output belongs to a row that already exists; a chunk whose
        // start was never seen has nowhere to go and is dropped.
        if (entry.category === "tool.output") {

            printing(entry);

            continue;
        }

        if (entry.category === "tool.end") {

            // A call whose start was never seen is shown finished
            // rather than dropped.
            if (!finish(entry) && entry.tool)
                turns.push({
                    id: entry.id,
                    shape: "tools",
                    agent: entry.agent,
                    calls: [{
                        id: entry.id,
                        name: entry.tool,
                        outcome: { ok: entry.ok, ms: entry.ms, detail: entry.detail }
                    }]
                });

            continue;
        }

        // Where the chat changed runtime: a divider, not a message.
        if (entry.category === "handover") {

            turns.push({ id: entry.id, shape: "handover", text: cleanText(entry.message), ...(entry.detail ? { file: entry.detail } : {}) });

            continue;
        }

        /*
         * A request allowed without a card marks the row of the call it
         * was for, found by the call's id - not a row of its own, which
         * would show every call twice. When the call has no row yet, the
         * mark waits for it.
         *
         * Only a request with no call id (some Copilot requests are not
         * for a tool call) still gets its own finished row, so it is not
         * lost. Its outcome is set from the start, so no `tool.end`
         * pairs with it.
         */
        if (entry.category === "notice" && entry.permission) {

            if (entry.callId) {

                const row = rowOf(entry.callId);

                if (row)
                    markAllowed(row, entry);
                else
                    allowedAhead.set(entry.callId, entry);

                continue;
            }

            // Our own check's request says how it was decided on the row
            // itself; a check without a note only ever says "allowed".
            const call: ToolCall = entry.permission.note
                ? {
                    id: entry.id,
                    name: entry.permission.tool,
                    detail: entry.permission.input,
                    allowed: true,
                    request: true,
                    note: entry.permission.note,
                    ...(entry.permission.refused ? { refused: true } : {}),
                    outcome: { ok: !entry.permission.refused }
                }
                : {
                    id: entry.id,
                    name: `${ALLOWED_PREFIX}${entry.permission.tool}`,
                    detail: entry.permission.input,
                    allowed: true,
                    request: true,
                    outcome: { ok: true }
                };

            if (last?.shape === "tools" && last.agent === entry.agent)
                last.calls.push(call);
            else
                turns.push({ id: entry.id, shape: "tools", agent: entry.agent, calls: [call] });

            continue;
        }

        if (entry.category === "tool.start" && entry.tool) {

            const call: ToolCall = { id: entry.id, name: entry.tool, callId: entry.callId, detail: entry.detail };

            const ahead = entry.callId ? allowedAhead.get(entry.callId) : undefined;

            if (ahead && entry.callId) {

                markAllowed(call, ahead);

                allowedAhead.delete(entry.callId);
            }

            if (last?.shape === "tools" && last.agent === entry.agent)
                last.calls.push(call);
            else
                turns.push({ id: entry.id, shape: "tools", agent: entry.agent, calls: [call] });

            continue;
        }

        // A question: its own turn, open until an answer names it.
        if (entry.category === "ask") {

            const text = cleanText(entry.message);

            if (text)
                turns.push({
                    id: entry.id,
                    shape: "ask",
                    agent: entry.agent,
                    askId: entry.askId ?? entry.id,
                    at: entry.at,

                    // The message has the choices written out for the
                    // log's sake; they are drawn as buttons here, so
                    // show the question alone when it is available.
                    text: (entry.options?.length && entry.prompt) ? entry.prompt : text,

                    options: entry.options,
                    multi: entry.multi,
                    permission: entry.permission
                });

            continue;
        }

        /*
         * An answer closes the question it names. Every turn is
         * searched, since the question is not always the last thing
         * said. An answer whose question is not in the log (one that
         * starts mid-conversation) falls through to an ordinary turn.
         */
        if (entry.category === "answer" && entry.askId) {

            const asked = turns.find(turn => turn.shape === "ask" && turn.askId === entry.askId);

            if (asked?.shape === "ask") {

                asked.answer = cleanText(entry.message);

                continue;
            }
        }

        // Text still being written. Its own turn, never joined to the
        // one before and never merged into: the completed line behind
        // it replaces it (see `withLine`).
        if (entry.category === "delta") {

            const text = cleanText(entry.message);

            // Not the entry's id: every chunk is a new line with its
            // own id, and the row is keyed by this. A new key each
            // chunk made React build the card again from scratch, and
            // the card's fade-in played on every chunk - the answer
            // flickered the whole time it streamed. One live turn per
            // channel and speaker (see `withLine`), so this is unique.
            if (text)
                turns.push({
                    id: `live:${entry.channel ?? "message"}:${entry.agent ?? ""}`,
                    shape: entry.channel === "reasoning" ? "thought" : "ai",
                    agent: entry.agent,
                    text,
                    at: entry.at,
                    live: true
                });

            continue;
        }

        const shape = SPOKEN[entry.category];

        // Narration. The Logs tab has it; a conversation does not.
        if (!shape)
            continue;

        const text = cleanText(entry.message);

        if (!text)
            continue;

        /*
         * A message the person sent settles every question still open
         * before it. The agent asked, the turn ended without an answer
         * (the window closed, the machine restarted), and the person
         * carried on by sending a message into the reopened
         * conversation - that message is their reply, and the agent
         * reads it as one. Left open, the question would say "waiting"
         * for good and hide the compose box again on every reopen.
         * The reply itself is drawn as the message turn below, not
         * copied into the question.
         */
        if (entry.category === "prompt")
            for (const turn of turns)
                if (turn.shape === "ask" && turn.answer === undefined) {

                    turn.answer = "";
                    turn.viaMessage = true;
                }

        // Joined with a newline, not a space: lines were split on line
        // endings, and spaces would lose lists and code blocks. Never
        // onto a live turn (that text is a draft). Never onto or from
        // the prompt: it is one whole message, and whatever is joined
        // to it is what a rerun would send - an `answer` whose question
        // is missing lands here on the same side of the thread.
        if (last && last.shape === shape && last.agent === entry.agent && !last.live
            && !last.prompt && entry.category !== "prompt") {

            last.text += "\n" + text;
            last.at = entry.at;

            continue;
        }

        turns.push({
            id: entry.id,
            shape,
            agent: entry.agent,
            text,
            at: entry.at,
            ...(entry.category === "prompt"
                ? {
                    prompt: true,
                    ...(entry.attachments?.length ? { attachments: entry.attachments } : {}),
                    ...(entry.sentWith?.length ? { sentWith: entry.sentWith } : {}),
                    ...(entry.pending ? { pending: entry.pending } : {})
                }
                : {})
        });
    }

    // Adjacent tool blocks from the same agent are joined into one.
    for (let index = turns.length - 1; index > 0; index--) {

        const turn = turns[index];
        const before = turns[index - 1];

        if (turn.shape === "tools" && before.shape === "tools" && turn.agent === before.agent) {

            before.calls.push(...turn.calls);

            turns.splice(index, 1);
        }
    }

    thinkingFirst(turns);

    return turns;
}

/**
 * Puts the agent's thinking above the answer it led to.
 *
 * The Copilot SDK sends a model call's finished answer first and its
 * thinking a moment after, so the thinking would be drawn under the answer
 * and the answer's time would sit between them. A thinking row straight after
 * a finished answer from the same agent, with nothing between, belongs
 * to that answer: the two swap places. Thinking for a later step always
 * has a tool row before it, so it is left where it is. A thinking row
 * that ends up next to another one from the same agent is joined to it.
 */
export function thinkingFirst(turns: Turn[]): void {

    for (let index = 1; index < turns.length; index++) {

        const turn = turns[index];
        const before = turns[index - 1];

        if (turn.shape !== "thought" || before.shape !== "ai" || before.live || turn.agent !== before.agent)
            continue;

        turns[index - 1] = turn;
        turns[index] = before;

        const earlier = turns[index - 2];

        if (index >= 2 && earlier.shape === "thought" && earlier.agent === turn.agent && !earlier.live && !turn.live) {

            earlier.text += "\n" + turn.text;
            earlier.at = turn.at;

            turns.splice(index - 1, 1);
        }
    }
}

/**
 * Adds one turn's reported tokens to the newest agent answer. A runtime
 * that reports no counts leaves the answer without any.
 */
function countTokens(turns: Turn[], models: readonly ModelSpend[]): void {

    const input = models.reduce((sum, model) => sum + (model.inputTokens ?? 0), 0);
    const output = models.reduce((sum, model) => sum + (model.outputTokens ?? 0), 0);

    if (!input && !output)
        return;

    for (let index = turns.length - 1; index >= 0; index--) {

        const turn = turns[index];

        if (turn.shape === "ai") {

            turn.usage = {
                inputTokens: (turn.usage?.inputTokens ?? 0) + input,
                outputTokens: (turn.usage?.outputTokens ?? 0) + output
            };

            return;
        }
    }
}

/**
 * Where the turn stands, for the status line at the foot of the thread.
 *
 * `working` counts up from `since` and says what the agent is doing
 * right now; `finished` says how long the last turn took. Undefined
 * when nothing has been sent, so a thread with no turn shows no line.
 */
export type TurnStatus =
    | { state: "working"; since: number; doing: string }
    | { state: "finished"; since: number; until: number };

/**
 * The lines that are the turn's own work: what was sent, what the agent
 * wrote, thought, ran or asked, and the error that ended it. A finished
 * turn ends at the last of these - see {@link turnStatus}.
 */
const TURN_WORK = new Set(["prompt", "answer", "message", "delta", "reasoning", "tool.start", "tool.output", "tool.end", "ask", "error"]);

/**
 * Reads the turn's state off the log.
 *
 * The turn starts at the last thing the person sent - the prompt, or
 * the answer to a question, since answering one sets the agent going
 * again. With no such line but a session that is running (the prompt
 * has not been logged yet), the first line stands in.
 *
 * What it is doing is read off the tail of the log: text still
 * streaming means it is writing or thinking, a tool call with no end
 * yet means that call is running, and anything else is the gap between
 * two events - the model wait. That gap is the one state with nothing
 * else on screen, and the reason this line exists.
 *
 * A finished turn ends at the last thing the agent said or did; the log
 * has no "idle" line of its own. Not at its last line of any kind: notes
 * written later - "Kept the changes.", "Undone: ...", "Folders changed"
 * - are saved with the time they were written, and the "Finished in"
 * time grew to that, and stayed grown after a reload.
 */
export function turnStatus(entries: readonly LogEntry[], running: boolean | undefined): TurnStatus | undefined {

    // A prompt the view drew itself has not started a turn yet, and it
    // is not where the last one ended either.
    entries = entries.filter(entry => !entry.pending);

    let start = -1;

    for (let index = entries.length - 1; index >= 0; index--) {

        if (entries[index].category === "prompt" || entries[index].category === "answer") {

            start = index;
            break;
        }
    }

    if (start < 0 && running && entries.length)
        start = 0;

    if (start < 0)
        return undefined;

    const since = entries[start].at;

    if (!running) {

        let until = since;

        for (let index = entries.length - 1; index > start; index--)
            if (TURN_WORK.has(entries[index].category)) {

                until = entries[index].at;
                break;
            }

        return { state: "finished", since, until: Math.max(since, until) };
    }

    const last = entries[entries.length - 1];

    if (last.category === "delta")
        return { state: "working", since, doing: last.channel === "reasoning" ? "thinking" : "writing" };

    /*
     * The newest call still open. Ends are matched the way `turnsFrom`
     * matches them: by the vendor's id where both sides carry one, by
     * name otherwise.
     */
    const open: LogEntry[] = [];

    for (const entry of entries.slice(start)) {

        if (entry.category === "tool.start" && entry.tool)
            open.push(entry);

        if (entry.category === "tool.end") {

            const index = open.findIndex(one => entry.callId && one.callId
                ? one.callId === entry.callId
                : one.tool === entry.tool);

            if (index >= 0)
                open.splice(index, 1);
        }
    }

    const call = open[open.length - 1];

    return { state: "working", since, doing: call ? `running ${call.tool}` : "waiting for the model" };
}

/**
 * What the Retry button sends when the thread has no message of yours
 * to send again - see {@link retrySend}. Plain text, the same as typing
 * it: it goes through the surface's own send, so every rule a typed
 * message meets (a runtime hand-over, a chat that has finished, a
 * conversation that cannot be reopened) applies to it too.
 */
export const RETRY_MESSAGE = "continue";

/** What the Resume button sends. Plain text, sent the same way as Retry's. */
export const RESUME_MESSAGE = "continue";

/**
 * How close to the bottom, in pixels, still counts as at the bottom -
 * so the thread keeps following new text. A smaller number would let
 * one nudge of the mouse wheel stop it following.
 */
const NEAR_BOTTOM = 40;

/**
 * Whether the Resume button shows: the surface says the agent was
 * stopped with work left, nothing is running, a message can be sent,
 * and the last turn has no Retry button of its own - one button under
 * the error is enough.
 */
export function showsResume(resumable: boolean | undefined, running: boolean | undefined, canSend: boolean, retryId: string | undefined): boolean {

    return resumable === true && !running && canSend && retryId === undefined;
}

/**
 * The error turn that gets the Retry button, or nothing.
 *
 * Only when the conversation's last turn is an error and nothing is
 * running: that error is what ended it. An error the agent carried on
 * past - a sub-agent failing mid-turn - has turns after it, so it never
 * gets one. And only where a message could be typed and sent now
 * (`canSend`), since Retry is nothing more than sending one.
 */
export function retryTurnId(turns: readonly Turn[], running: boolean | undefined, canSend: boolean): string | undefined {

    if (running || !canSend)
        return undefined;

    const last = turns[turns.length - 1];

    return last?.shape === "failed" ? last.id : undefined;
}

/**
 * What the Retry button sends, for a conversation whose last turn is the
 * error that ended it - see {@link retryTurnId}.
 *
 * Your last message again, with the files it carried, whatever the agent
 * did with it before the error. It sends the message again, not
 * "continue", because an agent that had never started on the message
 * answered that there was nothing to continue.
 *
 * Your last message is the last one you sent as a task - never an answer
 * to the agent's question, which sent again would read as the
 * instruction. {@link RETRY_MESSAGE} only when the thread has no such
 * message at all, as a spec chat whose prompt was not logged.
 *
 * `again` says which, for the button's tooltip.
 */
export function retrySend(turns: readonly Turn[]): { text: string; files?: SentFile[]; again: boolean } {

    if (turns[turns.length - 1]?.shape === "failed")
        for (let index = turns.length - 2; index >= 0; index--) {

            const turn = turns[index];

            if (turn.shape !== "user" || !turn.prompt)
                continue;

            const files = (turn.attachments ?? []).map((file): SentFile =>
                ({ kind: "path", path: file.path, ...(file.name ? { name: file.name } : {}) }));

            if (turn.text.trim() || files.length)
                return { text: turn.text, ...(files.length ? { files } : {}), again: true };

            break;
        }

    return { text: RETRY_MESSAGE, again: false };
}

/**
 * Whether a turn names its speaker: only where the speaker changes, so
 * a sub-agent's name is not repeated on every turn it takes.
 */
/**
 * Whether a turn is left out of the thread. The turn is still kept: the
 * card pinned at the foot is drawn from it.
 *
 * An open question is not in the thread yet: it shows only in the card at
 * the foot, and joins the thread with its answer once that is sent.
 * Drawing it in both places put the same sentence on screen twice. With no
 * session to answer into, or with the turn that asked it over, it stays
 * here - nothing else would show it.
 *
 * A permission request never joins the thread. The call's own tool row
 * says how it was decided ("allowed by your answer ...", "denied by you",
 * "not answered, so it did not run"), so a block per request only said the
 * same thing twice, and a real chat asks hundreds of times. It shows here
 * only while it is waiting in a view that has no card to answer it with -
 * nothing else would say what the agent is waiting on.
 */
export function hiddenInThread(turn: Turn, askLive: boolean, canAnswer: boolean): boolean {

    if (turn.shape !== "ask")
        return false;

    const open = turn.answer === undefined;

    if (turn.permission)
        return !(open && askLive && !canAnswer);

    return open && askLive && canAnswer;
}

/**
 * The rows the thread draws: the turns left after {@link hiddenInThread},
 * with tool blocks of the same agent that now sit side by side joined into
 * one. `turnsFrom` joins only blocks that were side by side in the log, so
 * a permission question between two calls kept them apart even though
 * the question itself is not drawn - one call alone, then "Used 2 tools".
 * The turns given are not changed: a joined block is a new object.
 */
export function threadRows(turns: readonly Turn[], askLive: boolean, canAnswer: boolean): Turn[] {

    const rows: Turn[] = [];

    for (const turn of turns) {

        if (hiddenInThread(turn, askLive, canAnswer))
            continue;

        const before = rows[rows.length - 1];

        if (turn.shape === "tools" && before?.shape === "tools" && before.agent === turn.agent)
            rows[rows.length - 1] = { ...before, calls: [...before.calls, ...turn.calls] };
        else
            rows.push(turn);
    }

    return rows;
}

export function namesSpeaker(turns: readonly Turn[], index: number): boolean {

    const turn = turns[index];

    if (!turn.agent)
        return false;

    const before = turns[index - 1];

    return !before || before.agent !== turn.agent;
}

/**
 * How far from the top of the view a message of yours still counts as
 * at the top - where the last jump left it. A little more than the
 * scroll margin a jump stops at, so pressing ↑ again goes on to the
 * message before it instead of to the same one.
 */
const JUMP_SLACK = 8;

/**
 * Where ↑ and ↓ beside Usage go: from what is on screen. ↑ goes to the
 * nearest message of yours above the top of the view, ↓ to the first
 * one below it. Your messages are given as how far each one's top is
 * below the top of the view (negative: scrolled past), in thread order;
 * `room` is how far the thread can still scroll down. With no room
 * left, ↓ has nowhere to go - the rest is already on screen.
 *
 * The index of the message each way, or undefined for a way with none.
 */
export function jumpTargets(tops: readonly number[], room: number): { up?: number; down?: number } {

    let up: number | undefined;
    let down: number | undefined;

    tops.forEach((top, index) => {

        if (top < -JUMP_SLACK)
            up = index;
        else if (top > JUMP_SLACK && down === undefined && room > 1)
            down = index;
    });

    return { up, down };
}

/**
 * One tool call, closed by default: the UI library's ToolPanel. The
 * closed row shows an icon for the kind of tool, the verb in bold and
 * what it acted on ("Read app.js", "Run npm test"), and how long it took.
 * A read's file is a link that opens it, with the lines it asked for
 * beside it. A failed call says why under its row. Opening it shows the
 * call drawn by its kind (see `ToolBody`): a command as a terminal, an
 * edit as old text over new, anything else as its arguments.
 */
function ToolRow({ call, showResult, onOpenFile }: {
    call: ToolCall;

    /** The `toolResults` flag: show what a finished call returned. */
    showResult?: boolean;

    /** Opens a file a read was about, from the link on its row. */
    onOpenFile?(path: string): void;
}) {

    const failed = call.outcome?.ok === false;

    // "Reading app.js" is shown as "Read" and "app.js"; a bare tool
    // name has no heading and keeps its own look.
    const heading = toolHeading(call.name);
    const shown = heading?.verb ?? call.name;
    const file = onOpenFile ? readFile(call.name, call.detail) : undefined;
    const range = readRange(call.name, call.detail);

    // What came back, on a call that worked. A failed call's `detail` is
    // why it failed, and is already shown under its row. The providers
    // keep only the start of a result and end a cut one with "...", so
    // the card says so rather than pass it off as all of it.
    const returned = showResult && call.outcome && !failed ? call.outcome.detail ?? "" : "";
    const output = returned.endsWith("...")
        ? `${returned}\n\n(Cut short - only the start of what the tool returned is kept.)`
        : returned;

    return (
        <ChatToolCall
            name={call.name}
            input={call.detail === undefined ? undefined : prettyJson(call.detail)}
            icon={toolIcon(call.name)}
            // The mark goes on the shown name; our own check's note says
            // how the call was decided.
            title={call.note
                ? `${shown} · ${call.note}`
                : call.allowed && !call.name.startsWith(ALLOWED_PREFIX)
                    ? `${shown} · ${ALLOWED_MARK}`
                    : heading
                        ? shown
                        : undefined}
            // A titled call shows what it acted on after the verb; a bare
            // name keeps its argument line - without it the row says nothing.
            detail={heading
                ? heading.target
                : call.detail && !call.name.startsWith(ALLOWED_PREFIX) && !labelVerb(call.name) ? call.detail : undefined}
            onDetailClick={file ? () => onOpenFile?.(file) : undefined}
            tags={range ? [range] : undefined}
            running={!call.outcome}
            failed={failed}
            failureReason={call.outcome?.detail}
            output={output}
            durationMs={call.outcome?.ms}
            liveOutput={call.output}
            allowed={call.allowed}
            refused={call.refused}
            body={
                <ToolBody
                    name={call.name}
                    detail={call.detail}
                    asked={call.asked}
                    live={call.outcome ? undefined : call.output}
                    output={output || undefined} />
            } />
    );
}

/**
 * The answer as the agent should hear it. A number picks a choice: "2"
 * becomes the second option's label, and "1, 3" becomes both when more
 * than one may be picked. Anything else is sent as typed.
 */
export function resolveAnswer(typed: string, options?: readonly AskOption[], multi?: boolean): string {

    const text = typed.trim();

    if (!options?.length || !text)
        return text;

    const pick = (part: string): string | undefined => {

        if (!/^\d+$/.test(part))
            return undefined;

        const index = Number(part) - 1;

        return index >= 0 && index < options.length ? options[index].label : undefined;
    };

    if (multi && /^\d+(\s*,\s*\d+)+$/.test(text)) {

        const labels = text.split(",").map(part => pick(part.trim()));

        return labels.every(label => label !== undefined) ? labels.join(", ") : text;
    }

    return pick(text) ?? text;
}

/**
 * The small mark in front of the status line: a tick when the turn is
 * done, a pulsing dot while it works, a question mark while it waits
 * on the reader. The colour and the pulse come from the status line's
 * own modifier class - see _chat.scss.
 */
function StatusMark({ state }: { state: "working" | "finished" | "waiting" }) {

    // The UI library's status dot, the same one the tabs and the sessions
    // dropdown carry: blue while working, green once finished, pulsing
    // yellow while it waits on you. The words beside it say the state.
    return (
        <StatusIndicator
            className="chat-view__status-mark"
            status={state === "finished" ? "online" : state === "working" ? "busy" : "connecting"}
            srLabel="" />
    );
}

/** Where a picker value came from, said the way the tooltip says it. */
function sourceText(source: AiSource): string {

    switch (source) {

        case "pick": return "your pick in this panel";
        case "stage": return "this stage's ai: in style.yml";
        case "style": return "the style's ai: in style.yml";
        case "settings": return "settings.json";
        default: return "the default";
    }
}

/**
 * What the runtime dropdown shows for an id. Only the label changes:
 * `ghcp` is still what settings.json, a style and a stage's `ai:`
 * say, and what every message carries. Any id not listed shows as
 * itself.
 */
const RUNTIME_LABELS: Record<string, string> = { ghcp: "copilot" };

export const runtimeLabel = (id: string): string => RUNTIME_LABELS[id] ?? id;

/**
 * The models the compose box's model button offers for the runtime in
 * effect, as the UI library's PromptInput takes them.
 *
 * `auto` first, always. The value in effect is kept in the list even
 * when the catalogue does not carry it - a model pinned in settings.json
 * that the account cannot see is still what the phase will be sent, and
 * the button must say so rather than show the first thing it can. One
 * entry per id: a catalogue can carry its own `auto`, and the value in
 * effect may be in the catalogue too - it then keeps the name and
 * multiplier the runtime sent. The multiplier (Copilot's premium
 * requests, Kiro v3's credit rate) shows beside the name, "free" for 0.
 *
 * "Custom…" at the end of the menu (the library's `allowCustomModel`)
 * takes a typed id for a model the list does not carry - the fetch
 * failed, or the id is newer than the CLI knows. The runtime checks it
 * when the session opens, and refuses one it does not know rather than
 * running on something else.
 */
export function modelOptionsOf(current: StageAi, choice: AiChoiceMessage): ModelOption[] {

    const listed = choice.models?.[current.provider] ?? [];
    const inEffect = listedModelOf(current, choice);
    const inEffectId = inEffect?.id ?? current.model;

    return [
        { id: "auto", name: "auto" },
        inEffect ?? { id: current.model, name: current.model },
        ...listed
    ]
        .filter((model, index, all) => all.findIndex(one => one.id === model.id) === index)
        .map(model => ({
            id: model.id,
            name: model.name ?? model.id,
            ...(model.multiplier !== undefined
                ? { costMultiplier: model.multiplier === 0 ? "free" : `${model.multiplier}x` }
                : "price" in model && model.price ? { costMultiplier: model.price } : {}),

            // Greyed out, not hidden - except the one in effect, which
            // stays pickable so the button still says what will run.
            ...("disabled" in model && model.disabled && model.id !== inEffectId
                ? { disabled: true, description: "Not enabled for your account" }
                : {})
        }));
}

/**
 * The listed row for the model in effect: the row with its id, else the
 * row that has it as another name - a pick saved as `opus` shows on the
 * `claude-opus-5-5` row.
 */
export function listedModelOf(current: StageAi, choice: AiChoiceMessage): NonNullable<AiChoiceMessage["models"]>[string][number] | undefined {

    const listed = choice.models?.[current.provider] ?? [];

    return listed.find(model => model.id === current.model)
        ?? listed.find(model => model.aliases?.includes(current.model));
}

/**
 * The mode button's list and value for the runtime in effect, when that
 * runtime has modes (Kiro v3). Undefined hides the button.
 *
 * The value is the person's pick when it is for this runtime, else the
 * mode a new session starts in.
 */
export function modeChoiceOf(current: StageAi, choice: AiChoiceMessage): { options: AgentModeOption[]; value?: string } | undefined {

    const listed = choice.modes?.[current.provider];

    if (!listed?.modes.length)
        return undefined;

    const picked = choice.pick?.provider === current.provider ? choice.pick.mode : undefined;

    return {
        options: listed.modes.map(mode => ({
            id: mode.id,
            name: mode.name ?? mode.id,
            ...(mode.description ? { description: mode.description } : {})
        })),
        value: picked ?? listed.current
    };
}

/**
 * The pick to send when only the model or only the mode changes: the
 * runtime in effect, and the other of the two kept as it was picked.
 * Without this, picking a mode would drop a picked model and the other
 * way round.
 */
export function pickWith(
    current: StageAi,
    choice: AiChoiceMessage,
    change: { model?: string; mode?: string; effort?: string }
): { provider: string; model?: string; mode?: string; effort?: string } {

    const own = choice.pick?.provider === current.provider ? choice.pick : undefined;
    const model = "model" in change ? change.model : own?.model;
    const mode = "mode" in change ? change.mode : own?.mode;
    const effort = "effort" in change ? change.effort : own?.effort;

    return {
        provider: current.provider,
        ...(model ? { model } : {}),
        ...(mode ? { mode } : {}),
        ...(effort ? { effort } : {})
    };
}

/** The Effort picker's "no pick" entry: the model's own default. */
export const DEFAULT_EFFORT = "default";

/**
 * The Effort picker's list and value for the model in effect, when the
 * runtime lists effort levels for it (claude, claude-cli). Undefined
 * hides the picker - always on `auto`, where the runtime picks the
 * model and so its effort too. "Default" comes first - the model's own
 * level.
 *
 * The value is the person's pick when it is for this runtime and this
 * model offers it, else Default: a level picked on another model that
 * this one lacks would only be refused when the session opens.
 */
export function effortChoiceOf(current: StageAi, choice: AiChoiceMessage): { options: { id: string; label: string }[]; value: string } | undefined {

    if (current.model === "auto")
        return undefined;

    const listed = listedModelOf(current, choice);
    const efforts = listed && "efforts" in listed ? listed.efforts : undefined;

    if (!efforts?.length)
        return undefined;

    const picked = choice.pick?.provider === current.provider ? choice.pick.effort : undefined;

    return {
        options: [
            { id: DEFAULT_EFFORT, label: "Default effort" },
            ...efforts.map(level => ({ id: level, label: `Effort: ${level}` }))
        ],
        value: picked && efforts.includes(picked) ? picked : DEFAULT_EFFORT
    };
}

/**
 * The provider line above the compose text: runtime › mode › model ›
 * effort, each a word that opens its own list - see the UI library's
 * `ProviderPart`. Mode shows only for a runtime that has modes, effort
 * only for a model that lists levels.
 *
 * Every change is a pick sent the moment it is made; nothing goes to the
 * agent here - the next message runs on it. Changing the runtime drops
 * the picked model, mode and effort: they belong to the runtime they were
 * picked for, and carrying a model over would hand Claude a Copilot
 * model name.
 *
 * Once the chat has started (`locked`) the runtime cannot change here.
 * With Handover offered, the runtime word opens the Handover modal
 * instead of a list.
 *
 * A part the person picked, over what the files say, is drawn in the
 * accent colour, and the runtime gets a ✕ that clears the whole pick.
 * The tooltips say which file did say.
 *
 * `running`: a turn is in flight. The mode and the model cannot change
 * until it ends; the runtime and the effort can - the same as when they
 * were the toolbar's buttons.
 */
export function providerPartsOf(
    ai: ComposeAi,
    { running, onHandover, refreshModels }: { running: boolean; onHandover(): void; refreshModels?(provider: string): void }
): ProviderPart[] {

    const { current, choice, onPick, locked, held, noMode, handover } = ai;

    const own = choice.pick?.provider === current.provider ? choice.pick : undefined;
    const runtime = runtimeLabel(current.provider);

    // The list includes whatever is in effect even when the panel does
    // not offer it (an ACP agent removed from settings.json since), so
    // the line never shows a blank for a real value.
    const providers = choice.providers.includes(current.provider)
        ? choice.providers
        : [current.provider, ...choice.providers];

    const parts: ProviderPart[] = [{
        id: "runtime",
        title: "Runtime",
        icon: "sparkle",
        options: providers.map(id => ({ id, name: runtimeLabel(id) })),
        value: current.provider,
        onChange: id => { if (id !== current.provider) onPick({ provider: id }); },
        ...(handover
            ? {
                onClick: onHandover,
                ariaLabel: `Handover - now on ${runtime}`,
                tooltip: `On ${runtime}. Click to move this session to another runtime`
            }
            : {
                tooltip: `Runtime - from ${sourceText(current.providerFrom)}`,
                disabled: locked === true,
                picked: choice.pick !== undefined
            }),
        ...(!locked && !handover
            ? {
                onReset: () => onPick(undefined),
                resetLabel: "Reset the runtime and model",
                resetTitle: "Back to what settings.json and the style say"
            }
            : {})
    }];

    // A phase chat: the runtime only. The spec's header shows the model
    // and the effort, and picks them.
    if (held)
        return parts;

    const mode = noMode ? undefined : modeChoiceOf(current, choice);

    if (mode)
        parts.push({
            id: "mode",
            title: "Mode",
            icon: "route",
            narrow: "icon",
            options: mode.options,
            value: mode.value ?? "",
            onChange: id => { if (id !== mode.value) onPick(pickWith(current, choice, { mode: id })); },
            disabled: running,
            picked: own?.mode !== undefined
        });

    // Disabled with "Loading…" while the runtime's models and modes are
    // still being fetched (an ACP agent starts a session to list them).
    // The mode part shows up once they land.
    const loading = choice.loading?.includes(current.provider) === true;
    const refreshing = choice.refreshing?.includes(current.provider) === true;

    // A model saved under another name (`opus`) shows as its listed row.
    const model = listedModelOf(current, choice)?.id ?? current.model;

    parts.push({
        id: "model",
        title: "Model",
        icon: "brain",
        narrow: "cut",
        options: modelOptionsOf(current, choice),
        value: model,
        onChange: id => { if (id !== model) onPick(pickWith(current, choice, { model: id })); },
        allowCustom: true,
        loading,
        ...(loading
            ? { ariaLabel: "Loading models…", tooltip: "Loading models…" }
            : { tooltip: `Model - from ${sourceText(current.modelFrom)}` }),
        disabled: running,
        picked: own?.model !== undefined,
        // At the foot of the model list: fetch the runtime's list again.
        // The host replaces ~/.eesha/models/<runtime>.json when
        // the fetch gives a list, and keeps the list it has when it fails.
        ...(refreshModels
            ? {
                actions: [{
                    id: "refresh",
                    label: "Refresh the model list",
                    icon: "refresh",
                    title: refreshing
                        ? "Fetching the model list again…"
                        : "Fetch the model list again. Replaces the saved list for this runtime.",
                    busy: refreshing,
                    onClick: () => refreshModels(current.provider)
                }]
            }
            : {})
    });

    const effort = effortChoiceOf(current, choice);

    if (effort)
        parts.push({
            id: "effort",
            title: "Effort",
            icon: "speed",
            prefix: "Effort:",
            options: effort.options.map(one => ({ id: one.id, name: one.id === DEFAULT_EFFORT ? "Default" : one.id })),
            value: effort.value,
            onChange: id => {

                if (id !== effort.value)
                    onPick(pickWith(current, choice, { effort: id === DEFAULT_EFFORT ? undefined : id }));
            },
            tooltip: "How hard the model thinks - higher is slower and costs more",
            picked: effort.value !== DEFAULT_EFFORT
        });

    return parts;
}

/**
 * The Handover modal: the runtime and model to carry the chat on, then
 * Start. The runtime it is on now is not offered - handing over to
 * itself would only throw the session away.
 *
 * The model list is the picked runtime's, once fetched; until then it
 * offers `auto`, which lets the runtime choose.
 */
export function HandoverModal({ show, current, choice, handover, refreshModels, onClose }: {
    show: boolean;
    current: StageAi;
    choice: AiChoiceMessage;
    handover: ComposeHandover;

    /** See `ChatViewProps.onRefreshModels`. */
    refreshModels?(provider: string): void;

    onClose(): void;
}) {

    const others = choice.providers.filter(id => id !== current.provider);

    const [provider, setProvider] = useState<string | undefined>(others[0]);
    const [model, setModel] = useState("auto");

    // Opened again, or the list changed under it: a runtime still on offer.
    const picked = provider !== undefined && others.includes(provider) ? provider : others[0];

    // Its model list, which may not have been asked for yet.
    useEffect(() => {

        if (show && picked)
            handover.onModels(picked);

    }, [show, picked]);

    const models = [
        { id: "auto", label: "auto" },
        ...(picked ? choice.models?.[picked] ?? [] : [])
            .filter(one => one.id !== "auto")
            .map(one => ({ id: one.id, label: one.name ?? one.id }))
    ];

    // Its models are still being fetched (an ACP agent starts a session to
    // list them): the model field says so and cannot be opened till then.
    const loading = picked !== undefined && choice.loading?.includes(picked) === true;

    const start = (): void => {

        if (!picked)
            return;

        onClose();
        handover.onStart({ provider: picked, ...(model !== "auto" ? { model } : {}) });
    };

    return (
        <Modal show={show} centered ariaLabel="Hand this session over to another runtime" onHide={onClose}>

            <Modal.Header closeButton onClose={onClose}>
                <Modal.Title>Handover</Modal.Title>
            </Modal.Header>

            <Modal.Body>
                <div className="chat-handover">

                    <p className="chat-handover__text">
                        Now on {runtimeLabel(current.provider)}. The conversation so far is saved to a file,
                        and a new session on the runtime you pick reads it, then tells you where things stand.
                    </p>

                    {others.length
                        ? (
                            <>
                                <label className="chat-handover__field">
                                    <span>Runtime</span>
                                    <Select
                                        aria-label="Hand over to runtime"
                                        size="sm"
                                        sort={false}
                                        hideSearch
                                        items={others.map(id => ({ id, label: runtimeLabel(id) }))}
                                        labelKey="label"
                                        valueKey="id"
                                        value={picked}
                                        onChange={id => { setProvider(String(id)); setModel("auto"); }} />
                                </label>

                                <div className="chat-handover__field">
                                    <span>Model</span>
                                    <span className="chat-handover__model">
                                        <Select
                                            aria-label="Hand over to model"
                                            size="sm"
                                            sort={false}
                                            items={models}
                                            labelKey="label"
                                            valueKey="id"
                                            disabled={loading}
                                            placeholder="Loading models…"
                                            value={loading ? undefined : models.some(one => one.id === model) ? model : "auto"}
                                            onChange={id => setModel(String(id))} />

                                        {picked && refreshModels && (
                                            <ModelRefreshButton
                                                provider={picked}
                                                busy={choice.refreshing?.includes(picked) === true}
                                                onRefresh={refreshModels} />
                                        )}
                                    </span>
                                </div>
                            </>
                        )
                        : <p className="chat-handover__text">No other runtime is listed in <code>ai.providers</code>.</p>}
                </div>
            </Modal.Body>

            <Modal.Footer>
                <Button type="button" fill="ghost" size="sm" onClick={onClose}>Cancel</Button>
                <Button type="button" variant="primary" size="sm" disabled={!picked} onClick={start}>Start</Button>
            </Modal.Footer>
        </Modal>
    );
}

/**
 * The Permissions dropdown on the compose row.
 * The UI library's PermissionLevelPicker: a header naming the runtime,
 * one row per level with what it does, and "Saved answers (N)" at the
 * foot. The button shows the level's name.
 */
function LevelPicker({ levels, capitalNames, plain }: { levels: ComposeLevels; capitalNames?: boolean; plain?: boolean }) {

    const offered = levels.acp ? ACP_LEVELS : SDK_LEVELS;

    return (
        <PermissionLevelPicker
            levels={offered.map(level => ({
                id: level,
                name: LEVEL_NAMES[level],
                hint: levelHint(level, levels.acp),
                note: levels.acp && (level === "agent" || level === "semi") ? ACP_LEVEL_NOTE : undefined
            }))}
            value={levels.level}
            title={`Permissions for ${levels.runtimeName}`}
            onChange={level => levels.onPick(level as PermissionLevel)}
            savedCount={levels.savedAnswers}
            onOpenSaved={levels.onSavedAnswers}
            capitalizeNames={capitalNames}
            plain={plain} />
    );
}

/** The list opened from "Saved answers" - see {@link ComposeLevels}. */
export interface SavedAnswersList {

    answers: readonly SavedAnswerRow[];

    /** The chat's name, for the "This session" group. */
    chat: string;

    /** The working folder, for the "This folder" group. */
    folder: string;

    onRemove(id: string): void;

    onClose(): void;
}

/**
 * The saved answers that hold for this chat, grouped by how long they
 * hold. Answers are only ever added from cards; here they
 * can only be removed.
 */
function SavedAnswers({ list }: { list: SavedAnswersList }) {

    const rows = (scope: SavedAnswerRow["scope"]) => list.answers
        .filter(one => one.scope === scope)
        .map(one => ({ id: one.id, pattern: one.shown, kind: KIND_NAMES[one.kind], savedAt: one.savedAt, by: runtimeLabel(one.agent) }));

    return (
        <SavedAnswersModal
            groups={[
                { title: `This session · "${list.chat}"`, answers: rows("session") },
                { title: `This folder · ${list.folder}`, answers: rows("folder") },
                { title: "Always · every session, every folder", answers: rows("always") }
            ]}
            onRemove={list.onRemove}
            onClose={list.onClose} />
    );
}

/**
 * The box at the foot of the thread for adding a new message to the
 * turn in flight - plain text only.
 *
 * Kept apart from the question card ({@link AskCard}): that one settles
 * the pending questions and locks once sent, while this can be used again and again
 * as the conversation goes on.
 */
/**
 * `$0.87` for dollars, `1.25 credits`, `3 premium requests`, `0.87 EUR`
 * for anything else. Two decimals, or four when the figure would
 * otherwise read as nothing.
 */
/**
 * Account usage in the shape the card draws - rows of text. Anything
 * else a stored log carries (a hand-edited file, say) is left out
 * rather than drawn. Exported for tests.
 */
export function isAccountUsage(value: unknown): value is AccountUsage {

    const rows = (value as { rows?: unknown } | undefined)?.rows;

    return Array.isArray(rows)
        && rows.every(row => typeof (row as { key?: unknown } | null)?.key === "string"
            && typeof (row as { value?: unknown }).value === "string");
}

/**
 * Several charges as one line. When they come from more than one
 * runtime, each says which - `ghcp 1.25 credits · kiro-cli 0.78
 * credits` - since two runtimes' "credits" are different allowances.
 */
export function spendsText(spends: readonly Spend[]): string {

    const runtimes = new Set(spends.map(spend => spend.runtime ?? ""));

    return spends
        .map(spend => runtimes.size > 1 && spend.runtime ? `${runtimeLabel(spend.runtime)} ${spendText(spend)}` : spendText(spend))
        .join(" · ");
}

export function spendText(spend: Spend): string {

    const digits = spend.amount > 0 && spend.amount < 0.01 ? 4 : 2;

    const amount = Number.isInteger(spend.amount) && spend.unit !== "USD"
        ? String(spend.amount)
        : spend.amount.toFixed(digits);

    return spend.unit === "USD" ? `$${amount}` : `${amount} ${spend.unit}`;
}

/**
 * The part of a charge this reader has asked to see.
 *
 * `showCost` is the `sessionCost` feature flag. Off, money is dropped
 * and an allowance is kept: credits and premium requests say how much
 * of a seat's quota went, which is not the same as putting a price in
 * front of somebody who did not ask for one.
 */
export function shownSpend(spend: readonly Spend[] | undefined, showCost: boolean): Spend[] {

    return (spend ?? []).filter(one => showCost || isQuota(one));
}

/** `42k` - a token count as the meter prints it. */
export function tokenText(count: number): string {

    return count >= 1000 ? `${Math.round(count / 1000)}k` : String(count);
}

/** `12k in / 800 out`, or nothing when the runtime counted neither. */
function flowText(input: number, output: number): string | undefined {

    const parts = [
        input > 0 ? `${tokenText(input)} in` : "",
        output > 0 ? `${tokenText(output)} out` : ""
    ].filter(Boolean);

    return parts.length ? parts.join(" / ") : undefined;
}

/** What a model (or a runtime's models together) read and wrote. */
function tokenFlow(model: { inputTokens?: number; outputTokens?: number }): string | undefined {

    return flowText(model.inputTokens ?? 0, model.outputTokens ?? 0);
}

/**
 * What a set of models read and wrote between them.
 *
 * This is what fills the card when the money is hidden. Tokens are not
 * a price, so the `sessionCost` flag has no business hiding them - and
 * without them a Claude session, whose every charge is in dollars, lost
 * the last-turn and per-session rows altogether rather than losing the
 * figures in them.
 */
export function modelFlow(models: readonly ModelSpend[] | undefined): string | undefined {

    let input = 0;
    let output = 0;

    for (const model of models ?? []) {

        input += model.inputTokens ?? 0;
        output += model.outputTokens ?? 0;
    }

    return flowText(input, output);
}

/**
 * What the Usage button opens - see {@link SessionUsage}. The context
 * window is not here - it has its own meter button, so each figure has
 * one place.
 */
function UsageDialog({ show, onHide, ...card }: {
    show: boolean;
    onHide(): void;
    session: readonly Spend[];
    last?: readonly Spend[];
    sessionModels: readonly ModelSpend[];
    lastModels?: readonly ModelSpend[];
    phases?: readonly UsageLine[];
    accounts: readonly AccountUsage[];
    showCost: boolean;
}) {

    // The UI library's Modal: the backdrop, the close button or Escape
    // closes it.
    return (
        <Modal
            show={show}
            centered
            ariaLabel="What this session has used"
            onHide={onHide}>

            <Modal.Header closeButton onClose={onHide}>
                <Modal.Title>Usage</Modal.Title>
            </Modal.Header>

            <Modal.Body>
                <SessionUsage {...card} />
            </Modal.Body>
        </Modal>
    );
}

/**
 * What a conversation's lines add up to, for the Usage dialog and the
 * meters: this session's charges and per-model figures, the phase's (with
 * `spentBefore` / `modelsBefore` - earlier runs of it), the last turn's,
 * the newest context window, and each runtime's account.
 *
 * Reads saved lines as well as live ones - see the saved-record test in
 * `__tests__/savedUsage.test.ts`, which holds a saved run to
 * check this so a change to the saved format cannot quietly break saved records.
 */
export function usageFrom(
    entries: readonly { cost?: Spend[]; models?: ModelSpend[]; context?: ContextUsage; account?: unknown }[],
    spentBefore?: readonly Spend[],
    modelsBefore?: readonly ModelSpend[]
) {

    // Two totals, not one. `session` is this conversation and only
    // this conversation; `phase` adds what the runs before it
    // charged, which are the drafts a re-run or New Session took
    // off the screen. They differ whenever a phase has been run
    // more than once, and a single figure could only ever be
    // honest about one of them.
    let session = [] as Spend[];
    let sessionModels = [] as ModelSpend[];
    let last: Spend[] | undefined;
    let lastModels: ModelSpend[] | undefined;
    let context: ContextUsage | undefined;
    const accounts = new Map<string, AccountUsage>();

    for (const entry of entries) {

        if (entry.cost?.length) {

            session = addSpend(session, entry.cost);

            // The newest bill, not added to anything: one turn's own
            // charge, which is what "last turn" means.
            last = entry.cost;
        }

        if (entry.models?.length) {

            sessionModels = addModelSpend(sessionModels, entry.models);
            lastModels = entry.models;
        }

        // A state rather than a charge, so the newest wins outright.
        if (entry.context)
            context = entry.context;

        // Account-wide, and a state too. Only the rows shape is drawn:
        // a log keeps whatever it was given, and any other shape, read
        // as-is, would crash the panel.
        if (isAccountUsage(entry.account))
            accounts.set(entry.account.runtime ?? "", entry.account);
    }

    const phase = spentBefore?.length ? addSpend(addSpend([], spentBefore), session) : session;

    const models = modelsBefore?.length
        ? addModelSpend(addModelSpend([], modelsBefore), sessionModels)
        : sessionModels;

    return { session, sessionModels, phase, models, last, lastModels, context, accounts: [...accounts.values()] };
}

/**
 * What the Usage button opens: what the conversation used, a table of
 * where the spend went, and each runtime's account.
 *
 * In a spec (`phases` given): Last turn and This session total, then a
 * Totals table - a row per phase, with its chats under it, and the
 * Spec row; a column per runtime and model. Anywhere else (a workflow
 * step, a plain chat): one table, Last turn and Session, a Total row
 * and a row per model. A session runs on one runtime, so there is no
 * runtime to split by there.
 *
 * Every figure here is one the runtime reported. A runtime that sent
 * nothing for a section leaves that section out rather than showing a
 * zero, because a zero reads as "this was free" and it is not.
 */
function SessionUsage({ session, last, sessionModels, lastModels, phases, accounts, showCost }: {
    session: readonly Spend[];
    last?: readonly Spend[];
    sessionModels: readonly ModelSpend[];
    lastModels?: readonly ModelSpend[];
    phases?: readonly UsageLine[];
    accounts: readonly AccountUsage[];
    showCost: boolean;
}) {

    // Credits or requests - an allowance, not money and not tokens -
    // when money is off but a charge still shows.
    const allowance = [last, session].some(spend => shownSpend(spend, showCost).length > 0);

    const heading = showCost ? "Cost" : allowance ? "Usage" : "Tokens";

    /**
     * One total as this reader may see it: the money when they asked
     * for money, the tokens when they did not. Nothing only when the
     * runtime reported neither.
     */
    const total = (spend: readonly Spend[] | undefined, ran: readonly ModelSpend[] | undefined): string | undefined => {

        const shown = shownSpend(spend, showCost);

        return shown.length ? spendsText(shown) : modelFlow(ran);
    };

    const lastTotal = total(last, lastModels);
    const sessionTotal = total(session, sessionModels);

    return (
        <UsageCard>

            {phases
                ? (
                    <>
                        {(lastTotal ?? sessionTotal) !== undefined && (
                            <UsageSection heading={heading}>

                                {lastTotal !== undefined && (
                                    <UsageRow label="Last turn" value={lastTotal} />
                                )}

                                {sessionTotal !== undefined && (
                                    <UsageRow
                                        label="This session total"
                                        value={sessionTotal}
                                        hint="What the conversation on screen has run up, from its first turn to its last."
                                        strong />
                                )}
                            </UsageSection>
                        )}

                        <PhaseTotals phases={phases} showCost={showCost} />
                    </>
                )
                : (
                    <SessionTable
                        heading={heading}
                        last={last}
                        session={session}
                        lastModels={lastModels}
                        sessionModels={sessionModels}
                        lastTotal={lastTotal}
                        sessionTotal={sessionTotal}
                        showCost={showCost} />
                )}

            {accounts.map(account => (
                <AccountSection key={account.runtime ?? ""} account={account} showCost={showCost} />
            ))}
        </UsageCard>
    );
}

/**
 * What a cell says: the charge this reader may see, else the tokens,
 * else a dash.
 *
 * `bare` drops the word "credits" - the Totals table, whose heading
 * says the unit once instead, so its columns fit the dialog. Any other
 * unit (dollars, premium requests) keeps its name, so a figure in one
 * is never read as credits.
 */
function cellText(cell: ModelSpend | undefined, showCost: boolean, bare = false): string {

    if (!cell)
        return "—";

    const shown = shownSpend(cell.cost, showCost);

    if (!shown.length)
        return tokenFlow(cell) ?? "—";

    return bare
        ? shown.map(spend => spend.unit === CREDITS ? spendText(spend).slice(0, -` ${CREDITS}`.length) : spendText(spend)).join(" · ")
        : spendsText(shown);
}

/** The unit the Totals table leaves out of its cells and names in its heading. */
const CREDITS = "credits";

/** A model's name in a column or row head - Kiro's charges come with none. */
function modelName(model: string): string {

    return model || "model not reported";
}

/**
 * A workflow step's or a plain chat's usage: Last turn and Session
 * columns, a Total row, and a row per model under it.
 *
 * The model rows are left out when the runtime named no model at all -
 * Kiro, whose one row would repeat the Total row word for word.
 */
function SessionTable({ heading, last, session, lastModels, sessionModels, lastTotal, sessionTotal, showCost }: {
    heading: string;
    last?: readonly Spend[];
    session: readonly Spend[];
    lastModels?: readonly ModelSpend[];
    sessionModels: readonly ModelSpend[];
    lastTotal?: string;
    sessionTotal?: string;
    showCost: boolean;
}) {

    if (lastTotal === undefined && sessionTotal === undefined)
        return null;

    const lastCells = usageCells(last ?? [], lastModels ?? []);
    const sessionCells = usageCells(session, sessionModels);

    const columns = usageColumns([sessionCells, lastCells]);

    const named = columns.some(column => column.model !== "");

    return (
        <UsageSection heading={heading}>
            <UsageTable
                head={[[
                    { key: "name" },
                    { key: "last", text: "Last turn" },
                    { key: "session", text: "Session" }
                ]]}
                rows={[
                    { key: "total", label: "Total", kind: "total", cells: [{ text: lastTotal ?? "—" }, { text: sessionTotal ?? "—" }] },
                    ...(named
                        ? columns.map(column => ({
                            key: `${column.runtime ?? ""}|${column.model}`,
                            label: modelName(column.model),
                            kind: "sub" as const,
                            cells: [
                                { text: cellText(usageCell(lastCells, column), showCost) },
                                { text: cellText(usageCell(sessionCells, column), showCost) }
                            ]
                        }))
                        : [])
                ]} />
        </UsageSection>
    );
}

/**
 * The spec's Totals: a row per phase in pipeline order - a phase that
 * has not run yet keeps its row, all dashes - with each of its chats
 * under it, and the Spec row last. A column per runtime and model,
 * grouped under the runtime, and a total column for a runtime with more
 * than one.
 *
 * There is no column adding the runtimes together: Copilot's credits
 * and Kiro's are different allowances, and their sum is no figure at all.
 */
function PhaseTotals({ phases, showCost }: { phases: readonly UsageLine[]; showCost: boolean }) {

    const rows = phases.map(line => ({ line, cells: usageCells(line.cost, line.models) }));

    const columns = usageColumns(rows.map(row => row.cells));

    if (!columns.length)
        return null;

    // The Spec row adds the phases, not their chats - a chat is already
    // inside its phase's row.
    const spec = totalCells(rows.filter(row => !row.line.lane).map(row => row.cells));

    const groups: { runtime?: string; columns: UsageColumn[] }[] = [];

    for (const column of columns) {

        const group = groups[groups.length - 1];

        if (group && group.runtime === column.runtime)
            group.columns.push(column);
        else
            groups.push({ runtime: column.runtime, columns: [column] });
    }

    /** One row's cells, in column order, with each wide runtime's total after its models. */
    const cellsOf = (cells: readonly ModelSpend[]) => groups.flatMap(group => {

        const own = group.columns.map(column => cellText(usageCell(cells, column), showCost, true));

        if (group.columns.length < 2)
            return own.map(text => ({ text, total: false }));

        const mine = cells.filter(cell => cell.runtime === group.runtime);

        return [
            ...own.map(text => ({ text, total: false })),
            { text: mine.length ? cellText(sumCells(mine, "", group.runtime), showCost, true) : "—", total: true }
        ];
    });

    // The Spec row holds every figure in the table, so it says whether
    // any cell is a bare number of credits.
    const inCredits = spec.some(cell => shownSpend(cell.cost, showCost).some(spend => spend.unit === CREDITS));

    return (
        <UsageSection heading={inCredits ? `Totals (${CREDITS})` : "Totals"}>
            <UsageTable
                scroll
                head={[
                    [
                        { key: "name", rowSpan: 2 },
                        ...groups.map(group => ({
                            key: group.runtime ?? "",
                            kind: "group" as const,
                            colSpan: group.columns.length + (group.columns.length > 1 ? 1 : 0),
                            text: group.runtime ? runtimeLabel(group.runtime) : "unknown"
                        }))
                    ],
                    groups.flatMap(group => [
                        ...group.columns.map(column => ({
                            key: `${group.runtime ?? ""}|${column.model}`,
                            text: modelName(column.model),
                            ...(column.model ? {} : { title: "This runtime says what a turn charged, not which model it was for" })
                        })),
                        ...(group.columns.length > 1
                            ? [{ key: `${group.runtime ?? ""}|total`, kind: "total" as const, text: "total" }]
                            : [])
                    ])
                ]}
                rows={[
                    ...rows.map(({ line, cells }, index) => ({
                        key: `${index}|${line.label}`,
                        label: line.label,
                        ...(line.lane ? { kind: "sub" as const } : {}),
                        cells: cellsOf(cells)
                    })),
                    { key: "spec", label: "Spec", kind: "spec" as const, cells: cellsOf(spec).map(cell => ({ text: cell.text })) }
                ]} />
        </UsageSection>
    );
}

/**
 * The context window: the UI library's meter - one bar of the whole
 * window, a slice per category the runtime named, and what is free - and
 * under it the categories that open into the files and tools inside them.
 *
 * In the usage card when there is no compose box, and otherwise in the
 * popup behind the compose box's own meter button.
 */
function ContextSection({ context, onOpenFile }: { context: ContextUsage; onOpenFile?(path: string): void }) {

    return (
        <UsageSection heading="Context window">

            {/* The UI library's meter, the categories in its legend, each
                opening into the files or tools inside it. A runtime that
                gives only a share (Kiro v3) has it drawn by share - see
                `contextSegments`. */}
            <ContextWindowMeter {...contextSegments(context, onOpenFile)} />
        </UsageSection>
    );
}

/**
 * The popup behind either context meter button - in the compose box, or
 * on the status line. With `compact`, and a reading whose session can,
 * a Compact button under the meter. With `onOpenFile`, the files in the
 * window are links - see `ChatViewProps.onOpenContextFile`.
 */
function contextPanel(context: ContextUsage, compact?: ContextCompact, onOpenFile?: (path: string) => void): React.ReactNode {

    const full = compactReady(context);

    return (
        <UsageCard className="chat-context-panel">
            <ContextSection context={context} onOpenFile={onOpenFile} />

            {compact && context.compactable && (
                <div className="chat-context-panel__compact">
                    <Button
                        type="button"
                        size="sm"
                        disabled={compact.busy || !full}
                        title={compact.busy
                            ? "Wait for the turn to finish"
                            : !full
                                ? `Available once the context is over ${COMPACT_FROM_PERCENT}% full. On a short conversation the summary can be bigger than the conversation itself.`
                                : "Summarise the conversation so far and carry on from the summary. Uses a model call, so it costs credits."}
                        onClick={compact.onCompact}>
                        Compact
                    </Button>
                </div>
            )}
        </UsageCard>
    );
}

/**
 * How full the context must be before Compact is enabled. On
 * Kiro v3: compacting a two-message chat takes it from 7% to 16% - the
 * summary is bigger than what it replaced - and still costs credits.
 */
export const COMPACT_FROM_PERCENT = 50;

/** Whether the window is full enough for Compact to be worth it - see {@link COMPACT_FROM_PERCENT}. */
export function compactReady(context: ContextUsage): boolean {

    return context.size > 0 && (context.used / context.size) * 100 > COMPACT_FROM_PERCENT;
}

/** The Compact button's wiring - see `ChatViewProps.onCompact`. */
interface ContextCompact {

    onCompact(): void;

    /** A turn is running - the runtime would refuse. */
    busy: boolean;
}

/**
 * The slices of the window, for the UI library's meters.
 *
 * A runtime that gives only a share (Kiro v3) has token counts per part
 * that do not add up to its share, and no window size. So the meter is
 * given the share as it is, and splits it between the parts by their
 * tokens: the total is the runtime's, only the split comes from the
 * counts. With no parts yet, the share is one "Used" slice.
 *
 * With `onOpenFile`, a row that is a file is a link that calls it with
 * the file's path.
 */
export function contextSegments(context: ContextUsage, onOpenFile?: (path: string) => void): { segments: ContextWindowSegment[]; usedTokens: number; maxTokens: number; usedPercent?: number } {

    const parts = partSegments(context.parts ?? [], onOpenFile);

    if (context.percentOnly) {

        const used = parts.length ? parts : [{ key: "used", label: "Used", tokens: 0, color: CONTEXT_COLORS[0] }];

        return {
            maxTokens: 100,
            usedPercent: Math.min(100, Math.max(0, context.used)),
            usedTokens: tokensOf(used),
            // The free space is what the share leaves.
            segments: [...used, { key: "__free", label: "Free", tokens: 0, color: "#3a3a42", reserved: true }]
        };
    }

    const free = Math.max(0, context.size - context.used);

    const used = parts.length ? parts : [{ key: "used", label: "Used", tokens: context.used, color: CONTEXT_COLORS[0] }];

    return {
        maxTokens: context.size,
        usedTokens: tokensOf(used),
        segments: [
            ...used,
            { key: "free", label: "Free", tokens: free, color: "var(--color-fg-muted)", reserved: true }
        ]
    };
}

/** The tokens in the slices that are not reserved. */
function tokensOf(segments: readonly ContextWindowSegment[]): number {

    return segments.filter(one => !one.reserved).reduce((sum, one) => sum + one.tokens, 0);
}

/**
 * The window's categories as meter slices, each opening into what is in
 * it. The files a runtime found but did not load go in a slice of their
 * own right after their category, with no tokens, so they are not read
 * as part of what fills the window.
 */
function partSegments(parts: readonly ContextPart[], onOpenFile?: (path: string) => void): ContextWindowSegment[] {

    const segments: ContextWindowSegment[] = [];

    parts.forEach((part, index) => {

        const items = shortPaths(part.items ?? []);

        const loaded = items.filter(item => !notLoaded(item));
        const found = items.filter(notLoaded);

        segments.push({
            key: part.name,
            label: part.name,
            tokens: part.tokens,
            color: CONTEXT_COLORS[index % CONTEXT_COLORS.length],
            ...(loaded.length ? { items: loaded.map(item => itemOf(item, onOpenFile)) } : {})
        });

        if (found.length)
            segments.push({
                key: `${part.name}\u0000not-loaded`,
                label: "Found, not loaded",
                tokens: 0,
                color: "var(--color-fg-muted)",
                items: found.map(item => itemOf(item, onOpenFile))
            });
    });

    return segments;
}

/** A row of the window as the page shows it. `path`: the row is a file, and this opens it - see `contextFile`. */
type ShownItem = ContextItem & { path?: string };

/** One row inside a category. A file shows where it is on hover, and with `onOpenFile` a click opens it. */
function itemOf(item: ShownItem, onOpenFile?: (path: string) => void) {

    const path = item.path;

    return {
        key: item.name,
        label: item.name,
        tokens: item.tokens,
        ...(path !== undefined ? { title: path } : {}),
        ...(path !== undefined && onOpenFile ? { onClick: () => onOpenFile(path) } : {})
    };
}

/**
 * A file the runtime found but did not put in the window: marked
 * `not loaded`, or given 0 tokens (Kiro). A 0-token name with no folder
 * in it is not taken for a file - a tool, say.
 */
function notLoaded(item: ContextItem): boolean {

    return item.note === "not loaded" || (item.tokens === 0 && /[\\/]/.test(item.name));
}

/**
 * File paths as a person reads them. Kiro sends them as it found them:
 * encoded (`/c%3A/work/repo/...`) or not (`/c:/work/repo/...`), and
 * always from the drive down, so the file's own name is the part cut
 * off. So each is decoded, and the folders every full path in the list
 * shares are dropped - but never a folder starting with a dot, so a
 * steering file still reads `.kiro/steering/...`. A name listed twice
 * once both spellings read the same is kept once, with the larger count.
 *
 * A row that is a file keeps the path it is opened by in `path` - the
 * short name alone could not find the file again.
 *
 * Exported for tests.
 */
export function shortPaths(items: readonly ContextItem[]): ShownItem[] {

    const plain = items.map((item): ShownItem => {

        const path = contextFile(item);

        return { ...item, name: plainPath(item.name), ...(path !== undefined ? { path } : {}) };
    });

    const full = plain.map(item => item.name).filter(isFullPath);

    // The folders all full paths share, whole folders only.
    let shared = full.length ? full[0].slice(0, full[0].lastIndexOf("/") + 1) : "";

    for (const path of full)
        while (shared && !path.toLowerCase().startsWith(shared.toLowerCase()))
            shared = shared.slice(0, shared.lastIndexOf("/", shared.length - 2) + 1);

    const dot = shared.indexOf("/.");

    if (dot >= 0)
        shared = shared.slice(0, dot + 1);

    const kept = new Map<string, ShownItem>();

    for (const item of plain) {

        const name = shared && isFullPath(item.name) ? item.name.slice(shared.length) : item.name;

        const before = kept.get(name.toLowerCase());

        if (!before || item.tokens > before.tokens)
            kept.set(name.toLowerCase(), { ...item, name });
    }

    return [...kept.values()];
}

/**
 * The whole account's usage this billing period, as the runtime last
 * reported it - not this session's, which is the section at the top.
 *
 * The runtime's own rows, as they come: this knows no vendor's fields.
 * A row marked as money shows only when money is switched on - the same
 * rule `shownSpend` applies to every other figure on this card. The
 * heading says which runtime reported it and when, since a copy kept
 * from an earlier session is shown until a fresh one arrives.
 */
function AccountSection({ account, showCost }: { account: AccountUsage; showCost: boolean }) {

    const rows = account.rows.filter(row => showCost || !row.money);

    const when = typeof account.at === "number" && Number.isFinite(account.at)
        ? new Date(account.at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : undefined;

    return (
        <UsageSection heading={`Account${account.runtime ? ` · ${runtimeLabel(account.runtime)}` : ""}`}>

            {rows.map(row => (
                <UsageRow key={row.key} label={row.key} value={row.value} />
            ))}

            {when && <UsageRow label="As of" value={when} muted />}
        </UsageSection>
    );
}

/**
 * The context meter's slice colours: the theme's chart colours, in turn,
 * so the slices follow the page theme like everything else.
 */
const CONTEXT_COLORS = [
    "var(--color-info)",
    "var(--color-keyword)",
    "var(--color-warning)",
    "var(--color-success)",
    "var(--color-error)",
    "var(--color-link)"
];

/**
 * The box a message is typed into: the UI library's PromptInput, with this
 * panel's own controls in its toolbar - the runtime and model picker, the
 * permission picker and the starting-sentence menu.
 *
 * What the library's box brings is off where the panel has no use for it:
 * no help button, no grammar checking. Its attach button and "@" file
 * search are on: files go with the message - see `send` below. Enter sends,
 * Shift+Enter is a new line; while the agent works an empty box shows Stop
 * and a typed one still sends, so a message can go in mid-turn.
 */
function ComposeBox({ onSend, sendOff, placeholder, searchFiles, searchPaths, onStop, draft, onDraftChange, presets, ai, aiInToolbar, capitalNames, refreshModels, levels, tools, addFiles, onFilesAdded, commands, context, compact, openContextFile, status, usage, jump }: {
    onSend: (text: string, files?: SentFile[], tools?: ToolSelection) => void;

    /** See `ChatViewProps.composeSendOff`. */
    sendOff?: string;

    /** See `ChatViewProps.composePlaceholder`. */
    placeholder?: string;

    /** See `ChatViewProps.searchFiles`. */
    searchFiles?(query: string): Promise<FileMatch[]>;

    /** See `ChatViewProps.searchPaths`. */
    searchPaths?(path: string[], query: string, options?: { refresh?: boolean }): Promise<PathMatch[]>;

    /** Present only while the agent is working - see `ChatViewProps.onStop`. */
    onStop?: () => void;

    /** Not shown: the library's Stop button carries its own title. */
    stopTitle?: string;
    draft?: string;
    onDraftChange?(text: string): void;
    presets?: readonly { id: string; label: string; text: string }[];
    ai?: ComposeAi;

    /** See `ChatViewProps.composeAiInToolbar`. */
    aiInToolbar?: boolean;

    /** See `ChatViewProps.composeCapitalNames`. */
    capitalNames?: boolean;

    /** See `ChatViewProps.onRefreshModels`. */
    refreshModels?(provider: string): void;

    /** See `ChatViewProps.composeLevels`. */
    levels?: ComposeLevels;

    tools?: ComposeTools;

    /** See `ChatViewProps.composeAddFiles`. */
    addFiles?: readonly { path: string; name?: string }[];
    onFilesAdded?(): void;

    /** See `ChatViewProps.composeCommands`. */
    commands?: readonly RuntimeCommand[];

    /** The session's context window, for the box's own meter button. */
    context?: ContextUsage;

    /** The Compact button in the meter's panel - see `ChatViewProps.onCompact`. */
    compact?: ContextCompact;

    /** See `ChatViewProps.onOpenContextFile`. */
    openContextFile?(path: string): void;

    /** Where the turn stands, on the left of the strip at the top of the box. */
    status?: React.ReactNode;

    /** The Usage button, on the right of that strip after the window's meter button. */
    usage?: React.ReactNode;

    /** ↑ and ↓ between your messages, after Usage at the right end of that strip. */
    jump?: React.ReactNode;
}) {

    // The window's popup lines up with the whole box, not its own button.
    const boxRef = useRef<HTMLDivElement>(null);

    // A short word from the box - a file refused as too large - under it
    // for a few seconds.
    const [notice, setNotice] = useState<string>();

    // The Handover modal is open. Drawn outside the input box: the box is
    // a CSS container, which would hold a fixed overlay inside itself.
    const [handing, setHanding] = useState(false);

    useEffect(() => {

        if (!notice)
            return;

        const timer = setTimeout(() => setNotice(undefined), 6000);

        return () => clearTimeout(timer);

    }, [notice]);

    // Trimmed, and nothing sent when nothing is left - the same rule the
    // box has always sent by. Files picked with "/" go by their path under
    // the folder the host searched; uploaded files go as their bytes, and
    // the host saves them before the agent is given them.
    const send = async (
        text: string,
        references: readonly PromptInputReference[] = [],
        uploads: readonly PromptInputAttachment[] = [],
        picked?: ToolSelection
    ): Promise<void> => {

        if (sendOff)
            return setNotice(sendOff);

        const trimmed = text.trim();

        const files: SentFile[] = [
            ...references
                .filter(one => one.type === "file")
                .map((one): SentFile => ({ kind: "path", path: one.value, ...(one.label ? { name: one.label } : {}) })),
            ...await Promise.all(uploads.map(async (one): Promise<SentFile> => ({
                kind: "upload",
                name: one.file.name,
                contentBase64: await fileToBase64(one.file)
            })))
        ];

        if (trimmed || files.length)
            onSend(trimmed, files.length ? files : undefined, tools ? picked : undefined);
    };

    const getMentionItems = (trigger: string, query: string) =>
        trigger === "/" ? commandItems(commands ?? [], query)
            : trigger === "#" ? toolItems(tools?.tools ?? [], tools?.mcpServers ?? [], query)
                : [];

    return (
        <div className="chat-compose" ref={boxRef}>
            <PromptInputProvider
                sessionId="chat"
                isLoading={onStop !== undefined}
                disabled={sendOff !== undefined}
                onSendMessage={(text, picked, _options, attachments, references) => send(text, references, attachments, picked)}
                onSendFollowUp={text => send(text)}
                maxAttachmentSizeBytes={MAX_UPLOAD_BYTES}
                onNotify={(_kind, message) => setNotice(message)}
                onCancel={() => onStop?.()}
                onModelChange={() => undefined}>

                <DraftSync draft={draft} onDraftChange={onDraftChange} />

                {tools && <ToolsSync tools={tools} />}

                {addFiles?.length ? <AddFilesSync files={addFiles} onAdded={onFilesAdded} /> : null}

                <PromptInput
                    placeholder={sendOff ?? placeholder ?? "Reply - Enter to send, Shift+Enter for a new line"}
                    minRows={1}
                    maxRows={6}
                    attachmentsEnabled
                    showHelp={false}
                    // What the next message runs on, as a line above the
                    // text: runtime, mode, model and effort - see
                    // providerPartsOf.
                    providerParts={ai && providerPartsOf(ai, {
                        running: onStop !== undefined,
                        onHandover: () => setHanding(true),
                        refreshModels
                    })}
                    providerPlacement={aiInToolbar ? "toolbar" : "line"}
                    // Plain dropdowns side by side - "Claude ▾ Sonnet 5.5 ▾"
                    // - in the toolbar and on the line above
                    // the text alike.
                    providerLook="menus"
                    capitalizeNames={capitalNames}

                    // "@" searches the workspace through the host; a pick
                    // becomes a chip in the box and goes with the message.
                    // "@name" typed out is a manual steering file instead
                    // (read by the engine), and "#" is the tools and MCP
                    // servers.
                    fileTrigger="@"
                    onFileSearch={searchFiles
                        ? query => searchFiles(query).then(found => fileItems(found.map(one => ({ name: one.name, path: one.path }))))
                        : undefined}

                    // The rows of the "/" commands and the "#" tools and
                    // MCP servers, filtered and sorted here.
                    getMentionItems={getMentionItems}

                    // ">" goes down a connector's levels one ">" at a
                    // time: >ado>workitems>12345. Only a page that passes
                    // `searchPaths` has it.
                    onPathSearch={searchPaths
                        ? (path, query, options) => searchPaths(path, query, options).then(pathItems)
                        : undefined}

                    // "/" as the first character lists the runtime's
                    // commands. A "/" anywhere else is plain text.
                    commands={commands}

                    // The strip at the top of the box: where the turn
                    // stands on the left; the window's meter button,
                    // Usage, and ↑ ↓ on the right. Up here rather than in
                    // the toolbar, so the toolbar keeps its room for the
                    // message's own settings.
                    header={(status || context || usage || jump) && (
                        <>
                            {status}
                            {(context || usage || jump) && (
                                <span className="chat-compose__meters">
                                    {/* Its share on the button, and on a
                                        click the window's section with the
                                        parts that open. */}
                                    {context && (
                                        <ContextWindowButton
                                            {...contextSegments(context)}
                                            // A file opens in a tab, so the popup over it closes.
                                            renderPanel={close => contextPanel(context, compact, openContextFile && (path => { close(); openContextFile(path); }))}
                                            anchorRef={boxRef} />
                                    )}
                                    {usage}
                                    {jump}
                                </span>
                            )}
                        </>
                    )}
                    // The row in groups, a bar between each: Permissions |
                    // presets and attach | the library's Advanced. The
                    // library draws no bar after host controls of its own,
                    // so the one after Permissions is ours.
                    toolbarExtras={(
                        <>
                            {levels ? <LevelPicker levels={levels} capitalNames={capitalNames} plain /> : null}

                            <span className="ee-prompt-input__toolbar-divider" aria-hidden="true" />
                        </>
                    )}
                    attachStart={presets && presets.length > 0 && <PresetMenu presets={presets} />} />
            </PromptInputProvider>

            {notice && <div className="chat-compose__notice" role="status">{notice}</div>}

            {ai?.handover && (
                <HandoverModal
                    show={handing}
                    current={ai.current}
                    choice={ai.choice}
                    handover={ai.handover}
                    refreshModels={refreshModels}
                    onClose={() => setHanding(false)} />
            )}
        </div>
    );
}

/**
 * Hands the library's pickers the lists on offer, and puts a pick in
 * them. The lists arrive after the box is drawn (a runtime's tool list
 * is a CLI call away), and the library only takes its options once, on
 * mount - so they are set here, through its own actions, whenever they
 * change. The pick is set when a new one arrives and not otherwise, so
 * a click in a picker is never undone by a redraw.
 */
function ToolsSync({ tools }: { tools: ComposeTools }) {

    const { state, actions } = usePromptInputContext();

    useEffect(() => {

        actions.setOptions({ tools: tools.tools, mcpServers: tools.mcpServers });

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tools.tools, tools.mcpServers]);

    useEffect(() => {

        const shown = state.toolSelection;
        const wanted = tools.selection;

        actions.setAutoTools(wanted.autoTools);
        actions.setAutoMcpServers(wanted.autoMcpServers);

        // The library toggles one id at a time: toggle what differs.
        for (const id of new Set([...shown.enabledToolIds, ...wanted.enabledToolIds]))
            if (shown.enabledToolIds.includes(id) !== wanted.enabledToolIds.includes(id))
                actions.toggleTool(id);

        for (const id of new Set([...shown.enabledMcpServerIds, ...wanted.enabledMcpServerIds]))
            if (shown.enabledMcpServerIds.includes(id) !== wanted.enabledMcpServerIds.includes(id))
                actions.toggleMcpServer(id);

        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [tools.selection]);

    return null;
}

/**
 * Keeps the box's text and the caller's copy of it in step.
 *
 * The text lives in the box, whoever else keeps a copy. Every keystroke
 * going up to the run view and back down as a prop re-rendered the whole
 * run view - the thread above with every turn's markdown - per key press,
 * which is what made typing lag during a run. So a keystroke re-renders the
 * box alone, and the caller's copy is brought up to date a moment after
 * typing pauses, at once when the box empties (a send), and when the box
 * goes away. The caller's copy still does its one job: giving the text back
 * when the tab is opened again.
 */
/**
 * Puts files handed in from outside the box in as file chips - the same
 * chips the "/" search makes - then tells the caller they are in. Each new
 * list is added once; a file already in the box is not added again.
 */
function AddFilesSync({ files, onAdded }: { files: readonly { path: string; name?: string }[]; onAdded?(): void }) {

    const { actions } = usePromptInputContext();

    useEffect(() => {

        for (const file of files)
            actions.addReference({ type: "file", value: file.path, label: file.name ?? file.path.split(/[\\/]/).pop() ?? file.path });

        onAdded?.();

        // A new list is new files; a new callback is not.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [files]);

    return null;
}

function DraftSync({ draft, onDraftChange }: { draft?: string; onDraftChange?(text: string): void }) {

    const { state, actions } = usePromptInputContext();

    /** The value the caller last agreed with - a `draft` other than this came from outside. */
    const synced = useRef(draft ?? "");

    /**
     * A push to the caller not sent yet. Holds the callback from the render
     * the typing happened in: the caller's callback is bound to the thread
     * it was rendered for, and a push that fires after the caller has moved
     * to another thread must still land on the one that was typed into.
     */
    const pending = useRef<{ timer: ReturnType<typeof setTimeout>; push(): void } | undefined>(undefined);

    const flush = (): void => {

        const waiting = pending.current;

        if (!waiting)
            return;

        pending.current = undefined;
        clearTimeout(waiting.timer);
        waiting.push();
    };

    // The caller's draft on first draw.
    useEffect(() => {

        actions.setText(draft ?? "");

    }, []);

    // The caller handed over a different draft - another thread's box, or
    // its copy changed for a reason of its own (the notes put into it).
    // Whatever was typed for the previous one goes up first, then this
    // becomes the text.
    useEffect(() => {

        if ((draft ?? "") === synced.current)
            return;

        flush();

        synced.current = draft ?? "";
        actions.setText(draft ?? "");

    }, [draft]);

    // Typing, or a send emptying the box: goes up to the caller.
    useEffect(() => {

        if (!onDraftChange || state.text === synced.current)
            return;

        if (pending.current) {

            clearTimeout(pending.current.timer);
            pending.current = undefined;
        }

        const value = state.text;

        const push = (): void => {

            synced.current = value;
            onDraftChange(value);
        };

        if (value === "") {

            push();
            return;
        }

        const timer = setTimeout(() => {

            pending.current = undefined;
            push();

        }, 250);

        pending.current = { timer, push };

    }, [state.text]);

    // Nothing typed is lost to the box being taken down mid-pause.
    useEffect(() => flush, []);

    return null;
}

/**
 * The starting-sentence menu. Each one just fills the box: nothing is sent
 * until Send itself is pressed, so picking one still leaves it to be read
 * and edited. Closed by a click outside it (the UI library's
 * ClickAwayListener) or Escape, the usual way a menu that floats over the
 * rest of the box behaves.
 */
function PresetMenu({ presets }: { presets: readonly { id: string; label: string; text: string }[] }) {

    const { actions } = usePromptInputContext();

    const [open, setOpen] = useState(false);

    useEffect(() => {

        if (!open)
            return;

        const onEscape = (event: KeyboardEvent) => {

            if (event.key === "Escape")
                setOpen(false);
        };

        document.addEventListener("keydown", onEscape);

        return () => document.removeEventListener("keydown", onEscape);

    }, [open]);

    return (
        <ClickAwayListener onClickAway={() => setOpen(false)}>
            <div className="chat-compose__presets">

                {/* The library's own toolbar button, so it is outlined and
                sized like the attach button beside it. */}
                <button
                    type="button"
                    className="ee-prompt-input__toolbar-btn chat-compose__caret"
                    aria-label="Starting sentences for this message"
                    title="Starting sentences"
                    aria-haspopup="menu"
                    aria-expanded={open}
                    onClick={() => setOpen(current => !current)}>
                    <UiIcon name="expand" size="sm" />
                </button>

                {open && (
                    <div className="chat-compose__menu" role="menu">
                        {presets.map(preset => (
                            <button
                                key={preset.id}
                                type="button"
                                role="menuitem"
                                className="chat-compose__menu-item"
                                onClick={() => {

                                    actions.setText(preset.text);
                                    setOpen(false);
                                }}>
                                {preset.label}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </ClickAwayListener>
    );
}

/**
 * Whether two turns would draw the same thing.
 *
 * `turnsFrom` builds every turn afresh each time the log changes, and
 * while an answer streams the log changes several times a second. The
 * turns before the live one are the same turns each time, just new
 * objects - so this is what decides whether a drawn row can be left
 * alone. Field by field rather than by identity for that reason.
 */
function sameTurn(a: Turn, b: Turn): boolean {

    if (a === b)
        return true;

    if (a.id !== b.id || a.shape !== b.shape || a.agent !== b.agent)
        return false;

    if (a.shape === "tools" && b.shape === "tools")
        return a.calls.length === b.calls.length && a.calls.every((call, index) => {

            const other = b.calls[index];

            return call.id === other.id && call.name === other.name && call.callId === other.callId
                && call.detail === other.detail && call.allowed === other.allowed && call.asked === other.asked
                && call.note === other.note && call.refused === other.refused
                && call.outcome?.ok === other.outcome?.ok && call.outcome?.ms === other.outcome?.ms
                && call.outcome?.detail === other.outcome?.detail;
        });

    if (a.shape === "ask" && b.shape === "ask")
        return a.askId === b.askId && a.text === b.text && a.at === b.at && a.answer === b.answer
            && a.viaMessage === b.viaMessage && a.multi === b.multi
            && JSON.stringify(a.options) === JSON.stringify(b.options)
            && JSON.stringify(a.permission) === JSON.stringify(b.permission);

    if (a.shape === "handover" && b.shape === "handover")
        return a.text === b.text && a.file === b.file;

    if (a.shape !== "tools" && a.shape !== "ask" && a.shape !== "handover"
        && b.shape !== "tools" && b.shape !== "ask" && b.shape !== "handover")
        return a.text === b.text && a.at === b.at && a.prompt === b.prompt && a.live === b.live
            && a.pending === b.pending
            && JSON.stringify(a.attachments) === JSON.stringify(b.attachments)
            && JSON.stringify(a.usage) === JSON.stringify(b.usage);

    return false;
}

/**
 * The new turn list, with every turn that has not changed swapped for
 * the object drawn last time - so a row's `turn` prop keeps its
 * identity and `TurnRow`'s memo can skip it.
 */
function reuseTurns(previous: readonly Turn[], next: Turn[]): Turn[] {

    const byId = new Map(previous.map(turn => [turn.id, turn]));

    return next.map(turn => {

        const before = byId.get(turn.id);

        return before && sameTurn(before, turn) ? before : turn;
    });
}

/**
 * One row of the thread. Memoized: with every finished turn kept as
 * the same object between renders (see `reuseTurns`) and the callbacks
 * kept stable (see `ChatView`), a streamed chunk re-draws only the row
 * that is being written, not the whole conversation above it.
 */
const TurnRow = memo(function TurnRow({ turn, named, stamped, askLive, canAnswer, showToolResults, onRerun, onGoBack, onOpenFile, onRetry, retryAgain }: {
    turn: Turn;

    /** The `toolResults` flag - see {@link ChatViewProps.showToolResults}. */
    showToolResults: boolean;

    /** Whether to show which sub-agent spoke - it changed from the row before. */
    named: boolean;

    stamped: boolean;

    askLive: boolean;

    /** Whether the surface can take an answer at all. */
    canAnswer: boolean;

    onRerun?(prompt: string): void;

    /** See `ChatViewProps.onGoBack`. Given only to the person's messages, and only while the agent is not working. */
    onGoBack?(turnId: string, text: string, edited?: string): void;

    onOpenFile?(path: string): void;

    /** Sends {@link retrySend}'s message. Given only to the error that ended the last turn - see {@link retryTurnId}. */
    onRetry?(): void;

    /** The Retry button sends your last message again - false only when there is none. */
    retryAgain?: boolean;
}) {

    // Where the chat moved runtime: a line across, and the saved
    // transcript behind a click.
    if (turn.shape === "handover")
        return <ChatHandoverLine text={turn.text} file={turn.file} onOpenFile={onOpenFile} />;

    return (
        <ChatTurn shape={turn.shape} agent={named ? turn.agent : undefined}>

            {turn.shape === "tools"
                ? (
                    <ChatToolRun
                        calls={turn.calls.map(call => ({
                            key: call.id,
                            status: !call.outcome ? "pending" as const : call.outcome.ok === false ? "danger" as const : "success" as const,
                            content: <ToolRow call={call} showResult={showToolResults} onOpenFile={onOpenFile} />
                        }))}
                        summary={toolSummary(turn.calls.map(call => call.name))}
                        // The time shows only once every call has said how long it took.
                        durationMs={turn.calls.every(call => call.outcome?.ms !== undefined)
                            ? turn.calls.reduce((sum, call) => sum + (call.outcome?.ms ?? 0), 0)
                            : undefined} />
                )
                : turn.shape === "ask"
                    ? (turn.answer !== undefined && !turn.viaMessage
                        // Answered: the question, and the reply under it.
                        ? (
                            <>
                                <ChatTurnText>{turn.text}</ChatTurnText>
                                <ChatAnswered answer={turn.answer} />
                            </>
                        )
                        // Otherwise the question alone, as it arrived.
                        // Answering it is done from the card pinned at
                        // the foot (see `activeBatch` in ChatView); with
                        // no session to answer into, a note says so.
                        : (
                            <>
                                <ChatTurnText>{turn.text}</ChatTurnText>
                                {!canAnswer && askLive && (
                                    <ChatTurnNote>Waiting for an answer nobody at this panel can give.</ChatTurnNote>
                                )}
                            </>
                        ))
                    : turn.shape === "thought"
                        ? (
                            <ThinkingBlock
                                text={turn.text}
                                summary={thinkingSummary(turn.text, turn.live === true)}
                                live={turn.live}
                                renderText={text => <div className="md-body"><Markdown expandableDiagrams={false}>{text}</Markdown></div>} />
                        )
                        : turn.shape === "user" || turn.shape === "ai"
                            ? (
                                <ChatProse
                                    role={turn.shape}
                                    text={turn.text}
                                    live={turn.live}
                                    at={turn.at}
                                    stamped={stamped}
                                    pending={turn.pending}
                                    attachments={turn.attachments?.map(file => ({ path: file.path, label: pathLabel(file.path) }))}
                                    sentWith={turn.sentWith}
                                    usage={turn.usage}
                                    bodyClassName="md-body"
                                    renderText={text => <Markdown expandableDiagrams={false}>{text}</Markdown>}
                                    onRerun={onRerun}
                                    onGoBack={onGoBack ? () => onGoBack(turn.id, turn.text) : undefined}
                                    onEditSend={onGoBack ? text => onGoBack(turn.id, turn.text, text) : undefined}
                                    onOpenFile={onOpenFile} />
                            )
                            : (
                                /* An error is plain text; rendering it as
                                   markdown turns a stray `#` into a heading. */
                                <>
                                    <ChatTurnText>{turn.text}</ChatTurnText>
                                    {onRetry && <ChatRetry again={retryAgain === true} onRetry={onRetry} />}
                                </>
                            )}
        </ChatTurn>
    );
});

export default function ChatView({
    entries, emptyText, onAnswer, onRerun, onGoBack, onSend, searchFiles, searchPaths, onStop, stopTitle, onOpenFile, onOpenContextFile, running, resumable, composeDraft, onComposeDraftChange, composePresets,
    composeAi, composeAiInToolbar, composeCapitalNames, showMeters = true, onRefreshModels, composeLevels, savedAnswers, composeTools, composeHeader, composeAddFiles, onComposeFilesAdded, composeCommands, composeSendOff, composePlaceholder,
    spentBefore, modelsBefore, phaseUsage, showCost, onCompact, showToolResults
}: ChatViewProps) {

    // What the session has cost so far, what its last turn cost, which
    // models it spent that on, and how full its window is - see
    // {@link Meter}. All read off the lines: bills added up, the last
    // bill kept on its own, the newest window report kept.
    const usage = useMemo(() => usageFrom(entries, spentBefore, modelsBefore), [entries, spentBefore, modelsBefore]);

    // The Usage dialog is open. Held here, not in the button: the button
    // moves between the compose box and the line above it, and the dialog
    // must stay open across that move.
    const [usageOpen, setUsageOpen] = useState(false);

    // The Compact button in the meter's panel - see `onCompact`.
    const compact: ContextCompact | undefined = onCompact ? { onCompact, busy: running === true } : undefined;

    // Built once per change to the log, and finished turns keep the
    // object they had last time - see `reuseTurns`. Without both, a
    // streamed chunk re-parsed every turn's markdown in the thread.
    const drawn = useRef<readonly Turn[]>([]);

    // The rows drawn last time - a joined tool block keeps its object
    // while nothing in it changed (see `threadRows`).
    const drawnRows = useRef<readonly Turn[]>([]);

    const turns = useMemo(() => {

        const next = reuseTurns(drawn.current, turnsFrom(entries));

        drawn.current = next;

        return next;

    }, [entries]);

    // The row callbacks, with one identity for the life of the thread.
    // The callers' own change every render (they close over the run
    // view's state), and a fresh callback would re-draw every row.
    // These read the newest ones at call time instead.
    const latest = useRef({ onRerun, onGoBack, onOpenFile, onSend });
    latest.current = { onRerun, onGoBack, onOpenFile, onSend };

    const rerun = useCallback((prompt: string) => latest.current.onRerun?.(prompt), []);
    const goBack = useCallback((turnId: string, text: string, edited?: string) => latest.current.onGoBack?.(turnId, text, edited), []);
    const openFile = useCallback((path: string) => latest.current.onOpenFile?.(path), []);

    const retryId = retryTurnId(turns, running, onSend !== undefined);

    // Whether there is a message of yours for ↑ and ↓ to go to.
    const hasYours = turns.some(turn => turn.shape === "user");

    // The agent's newest plan, for the strip above the compose box.
    const plan = useMemo(() => latestPlan(entries), [entries]);

    const resume = showsResume(resumable, running, onSend !== undefined, retryId);

    // The agent's newest finished answer carries the time it was
    // written. One stamp, not one per line: what the thread needs to
    // say is when the agent last spoke. A live turn is skipped - it
    // has no actions row yet, and its time is still moving.
    let stampedId: string | undefined;

    for (let index = turns.length - 1; index >= 0 && stampedId === undefined; index--)
        if (turns[index].shape === "ai" && !(turns[index] as ProseTurn).live)
            stampedId = turns[index].id;

    // A question with no answer on it is still waiting - the same rule
    // replay uses. The oldest one, since it has waited longest: only it
    // gets the box, so the person answers a batch of questions one at a
    // time rather than juggling several boxes at once.
    const waiting = turns.find(turn => turn.shape === "ask" && turn.answer === undefined);

    // Whether that question can still be answered in place. Only while
    // the turn that asked it is running in this window: `respond` needs
    // the session that raised it, and that session is held only for the
    // length of the turn. A question left open by a turn that has ended
    // (the window was closed, the machine restarted) has nothing to
    // answer into - and it must not hide the compose box, since the
    // compose box is the one path that reopens the conversation and
    // carries it on. Without this, a restart mid-question locked the
    // phase: the card blocked the box, and the card's own Send found no
    // session.
    const askLive = waiting !== undefined && running === true;

    // What the thread draws: hidden questions left out, the tool blocks
    // on either side of one joined.
    const rows = reuseTurns(drawnRows.current, threadRows(turns, askLive, onAnswer !== undefined));

    drawnRows.current = rows;

    // The batch `waiting` belongs to, whole - answered members included,
    // so the card can number against what was asked ("Question 2 of 3"),
    // not against what is left. Pinned at the foot of the thread beside
    // the compose box, not drawn in place: the question still shows
    // inline as it arrived, but answering it is not something to go
    // hunting up the thread for.
    const activeBatch = askLive && waiting.shape === "ask"
        ? askBatches(turns).find(batch => batch.some(turn => turn.id === waiting.id))
        : undefined;

    /*
     * Whether there is a meter at all: something the card could show.
     *
     * The window, or the tokens each model read, or - only when the
     * `sessionCost` flag is on - the bill. Money is listed last and
     * gated because with the flag off it is not a reason to draw
     * anything, and a runtime that reports no window would otherwise
     * take the model's token counts down with it.
     */

    // The compose box shows - and carries the window on its own meter.
    const composing = onSend !== undefined && !askLive && !(onAnswer && activeBatch);

    // The Usage button: only when its dialog has something in it. The
    // window is not one of those - it has its own meter button.
    const meter = showMeters && (usage.accounts.length > 0
        || usage.models.length > 0
        || shownSpend(usage.phase, showCost === true).length > 0);

    // The window's meter button, where meters show.
    const meterContext = showMeters ? usage.context : undefined;

    // Where the turn stands, for the status line. Its clock is the UI
    // library's ElapsedTimer, counting from when the turn started (read
    // off the log, so a panel opened mid-turn shows the real time), and
    // ticking on its own - the thread above does not redraw each second.
    const status = turnStatus(entries, running);

    // Working and for how long, waiting on you, or done. In the foot
    // rather than after the last turn, so the clock stays in view while
    // the thread is scrolled anywhere. A question waiting on the reader
    // is the one state drawn loud - see _chat.scss.
    const statusLine = status && (
        <div
            className={`chat-view__status chat-view__status--${askLive ? "waiting" : status.state}`}
            role="status">
            <StatusMark state={askLive ? "waiting" : status.state} />
            {/* The tooltip has what the agent is doing in full, for when
                the compose box's strip cuts it short. */}
            <span title={!askLive && status.state === "working" ? status.doing : undefined}>
                {askLive
                    ? "Waiting for your answer"
                    : status.state === "working"
                        ? <>Working · <ElapsedTimer active since={status.since} format={elapsedText} /> · {status.doing}</>
                        : `Finished in ${elapsedText(status.until - status.since)}`}
            </span>
        </div>
    );

    const usageButton = meter && (
        <UsageButton
            open={usageOpen}
            over={usage.accounts.some(account => account.overLimit === true)}
            onToggle={() => setUsageOpen(current => !current)} />
    );

    // Pinned to the newest turn until the reader scrolls away from the
    // bottom, the same as the log.
    const bodyRef = useRef<HTMLDivElement>(null);
    const innerRef = useRef<HTMLDivElement>(null);
    const stuckToBottom = useRef(true);

    // The thread's height when the code last looked - see onScroll.
    const seenHeight = useRef(0);

    // ↑ and ↓ beside Usage - see {@link jumpTargets}. Which way can move
    // is read off the page after a scroll, and after the thread grows or
    // changes size. Two flags, so a scroll that changes neither does not
    // draw the view again.
    const [canUp, setCanUp] = useState(false);
    const [canDown, setCanDown] = useState(false);

    /** Your messages on the page, and the index of the one each way goes to. */
    const findJumps = useCallback((): { yours: HTMLElement[]; up?: number; down?: number } => {

        const element = bodyRef.current;
        const inner = innerRef.current;

        if (!element || !inner)
            return { yours: [] };

        const yours = [...inner.querySelectorAll<HTMLElement>(".ee-chat-turn--user")];

        // Measured from where a jump stops: the top of the view plus the
        // messages' scroll margin (see _chat.scss).
        const margin = yours.length ? parseFloat(getComputedStyle(yours[0]).scrollMarginTop) || 0 : 0;
        const line = element.getBoundingClientRect().top + margin;

        return {
            yours,
            ...jumpTargets(
                yours.map(one => one.getBoundingClientRect().top - line),
                element.scrollHeight - element.scrollTop - element.clientHeight)
        };
    }, []);

    // At most once a frame: a scroll sends many events.
    const measureFrame = useRef(0);

    const measureJumps = useCallback(() => {

        cancelAnimationFrame(measureFrame.current);

        measureFrame.current = requestAnimationFrame(() => {

            const { up, down } = findJumps();

            setCanUp(up !== undefined);
            setCanDown(down !== undefined);
        });
    }, [findJumps]);

    useEffect(() => () => cancelAnimationFrame(measureFrame.current), []);

    const jump = useCallback((direction: "up" | "down") => {

        const { yours, up, down } = findJumps();
        const index = direction === "up" ? up : down;

        if (index === undefined)
            return;

        // Off the bottom at once, not at the smooth scroll's first step:
        // a line arriving in between would pull the thread back down.
        if (direction === "up")
            stuckToBottom.current = false;

        yours[index].scrollIntoView({ block: "start", behavior: "smooth" });
    }, [findJumps]);

    // In the compose box only, beside Usage - not on the line drawn
    // above the box when there is no box.
    const jumpPair = hasYours && (
        <MessageJumpButtons
            canUp={canUp}
            canDown={canDown}
            onUp={() => jump("up")}
            onDown={() => jump("down")} />
    );

    // Sending a message - typed, Retry or Resume - jumps to the bottom
    // and follows the answer again, wherever the reader had scrolled to:
    // the answer is what they are waiting for.
    const sendAndFollow = useCallback((text: string, files?: SentFile[], tools?: ToolSelection) => {

        stuckToBottom.current = true;

        const element = bodyRef.current;

        if (element)
            element.scrollTop = element.scrollHeight;

        latest.current.onSend?.(text, files, tools);
    }, []);

    // Read at click time, so the button keeps one callback and the
    // memoized rows are not drawn again on every new line.
    const retryWith = retryId ? retrySend(turns) : undefined;
    const retryRef = useRef(retryWith);
    retryRef.current = retryWith;

    const retry = useCallback(() => {

        const what = retryRef.current;

        if (what)
            sendAndFollow(what.text, what.files);
    }, [sendAndFollow]);

    // What counts as "the thread changed".
    //
    // Not the entry count on its own. A streaming answer replaces the
    // last entry in place instead of appending (see `withLine`), so the
    // count sits still for the whole time the agent is writing, and the
    // completed line that follows drops the live one and appends - also
    // no change in count. Watching the last entry's id and how long its
    // text is catches both.
    const lastEntry = entries[entries.length - 1];
    const threadMark = `${entries.length}:${lastEntry?.id ?? ""}:${lastEntry?.message.length ?? 0}`;

    useEffect(() => {

        const element = bodyRef.current;

        if (element && stuckToBottom.current)
            element.scrollTop = element.scrollHeight;

        if (element)
            seenHeight.current = element.scrollHeight;

        measureJumps();

    }, [threadMark, measureJumps]);

    // Content can still grow after that effect runs - markdown, mermaid,
    // code blocks and images lay out on their own timing, past the DOM
    // commit this effect fires on. A resize observer catches that late
    // growth and re-pins while still stuck to the bottom.
    //
    // It watches the inner wrapper, not the scroller: a scroller's own
    // box does not change size when what is inside it grows, so an
    // observer on the scroller never fires.
    useEffect(() => {

        const element = bodyRef.current;
        const inner = innerRef.current;

        if (!element || !inner)
            return;

        const observer = new ResizeObserver(() => {

            if (stuckToBottom.current)
                element.scrollTop = element.scrollHeight;

            seenHeight.current = element.scrollHeight;

            measureJumps();
        });

        observer.observe(inner);

        return () => observer.disconnect();

    }, [measureJumps]);

    // A new question jumps to the bottom even if the reader had scrolled
    // away to read something earlier - unlike ordinary output, a
    // question is addressed to them specifically and waits on their
    // answer, not something they can catch up on later.
    const waitingId = waiting?.id;

    useEffect(() => {

        const element = bodyRef.current;

        if (waitingId === undefined || !element)
            return;

        element.scrollTop = element.scrollHeight;
        stuckToBottom.current = true;

    }, [waitingId]);

    // Near the bottom pins the thread again; far from it lets go - the
    // reader scrolled away. "Far" is judged twice: against the thread's
    // height now, and against its height when it was last seen. A scroll
    // event can land after the thread grew (a taller compose box, a late
    // usage line) but before the resize observer pins it again. Read
    // only against the new height it looked far from the bottom, so it
    // let go though nobody scrolled, and the end of the answer stayed
    // under the box. A real scroll away is far by both.
    const onScroll = (): void => {

        const element = bodyRef.current;

        if (!element)
            return;

        const room = (height: number) => height - element.scrollTop - element.clientHeight;

        if (room(element.scrollHeight) < NEAR_BOTTOM)
            stuckToBottom.current = true;
        else if (room(seenHeight.current) >= NEAR_BOTTOM)
            stuckToBottom.current = false;

        seenHeight.current = element.scrollHeight;

        measureJumps();
    };

    return (
        <div className="chat-view" ref={bodyRef} onScroll={onScroll}>

            {/* Everything the thread holds, in one box the scroller can
                measure. The scroller's own height never changes, so the
                resize observer above has to watch this instead. */}
            <div className="chat-view__inner" ref={innerRef}>

                {turns.length === 0 && (
                    <ChatIntro>
                        {emptyText ?? "Nothing yet - what the agent is asked, and what it answers, appears here."}
                    </ChatIntro>
                )}

                {rows.map((turn, index) => (

                            <TurnRow
                                key={turn.id}
                                turn={turn}
                                named={namesSpeaker(rows, index)}
                                stamped={turn.id === stampedId}
                                askLive={askLive}
                                canAnswer={onAnswer !== undefined}
                                showToolResults={showToolResults === true}

                                // Only the prompt can be rerun; an answer
                                // on the same side is not the instruction.
                                onRerun={turn.shape === "user" && turn.prompt && onRerun ? rerun : undefined}

                                // The person's messages, while the agent is
                                // not working - going back mid-turn would cut
                                // a conversation still being written.
                                onGoBack={turn.shape === "user" && turn.prompt && onGoBack && running !== true ? goBack : undefined}

                                onOpenFile={onOpenFile ? openFile : undefined}
                                onRetry={turn.id === retryId ? retry : undefined}
                                retryAgain={turn.id === retryId && retryWith?.again} />
                ))}

                {/* The agent was stopped with work left: one click sends
                    it on from where it stopped. */}
                {resume && <ChatResume onResume={() => sendAndFollow(RESUME_MESSAGE)} />}

                {/* Absorbs whatever room the thread does not fill, so the
                    foot sits at the bottom of the pane rather than floating
                    right under a short thread with empty space beneath.
                    Once the thread is tall enough to scroll, this collapses
                    to nothing and costs it no room. */}
                <div className="chat-view__spacer" />

                {/* The foot: stuck to the bottom of the pane, so what is in
                    it stays in view while the thread scrolls under it.
                    Holds the open question's card when there is one to
                    answer - pinned here rather than in place, so answering
                    it never means scrolling to find it. Otherwise the
                    compose box, absent while a question is open on a
                    running turn: typing there would start a new turn on
                    top of the one `respond` is waiting on. A question
                    left open by a turn that has ended does not hold the
                    box back - it is the only way to carry on. Rendered
                    only when it has something to hold, so an empty foot
                    never covers the last turn. */}
                {status || meter || composeHeader || plan || (onAnswer && activeBatch) || (onSend && !askLive) ? (
                    <div className="chat-view__foot">

                        {composeHeader}

                        {/* The agent's plan: open while it works, one
                            line once the turn ends. */}
                        {plan && <PlanStrip steps={plan} running={running === true} />}

                        {meter && (
                            <UsageDialog
                                show={usageOpen}
                                onHide={() => setUsageOpen(false)}
                                session={usage.session}
                                last={usage.last}
                                sessionModels={usage.sessionModels}
                                lastModels={usage.lastModels}
                                phases={phaseUsage}
                                accounts={usage.accounts}
                                showCost={showCost === true} />
                        )}

                        {savedAnswers && <SavedAnswers list={savedAnswers} />}

                        {/* One line above the compose box, only when there
                            is no compose box to carry these - a question
                            is open, or this surface has no box. Where the
                            turn stands on the left, Usage and the window
                            on the right. With a box, the status is the
                            strip at its top and the two buttons sit in
                            its toolbar. */}
                        {!composing && (statusLine || usageButton || meterContext) && (
                            <div className="chat-view__bar">

                                {statusLine}

                                {usageButton && <div className="chat-view__meter">{usageButton}</div>}

                                {/* The same library meter button the box
                                    has, with the same popup. */}
                                {meterContext && (
                                    <ContextWindowButton
                                        {...contextSegments(meterContext)}
                                        renderPanel={close => contextPanel(meterContext, compact, onOpenContextFile && (path => { close(); onOpenContextFile(path); }))} />
                                )}
                            </div>
                        )}

                        {onAnswer && activeBatch
                            ? (
                                // Never taller than part of the window: a long
                                // card scrolls inside instead of going off screen.
                                <div className="chat-view__ask">
                                    <AskCard batch={activeBatch} onAnswer={onAnswer} />
                                </div>
                            )
                            : (onSend && !askLive && (
                                <ComposeBox
                                    onSend={sendAndFollow}
                                    sendOff={composeSendOff}
                                    placeholder={composePlaceholder}
                                    searchFiles={searchFiles}
                                    searchPaths={searchPaths}
                                    onStop={running ? onStop : undefined}
                                    stopTitle={stopTitle}
                                    draft={composeDraft}
                                    onDraftChange={onComposeDraftChange}
                                    presets={composePresets}
                                    ai={composeAi}
                                    refreshModels={onRefreshModels}
                                    levels={composeLevels}
                                    aiInToolbar={composeAiInToolbar}
                                    capitalNames={composeCapitalNames}
                                    tools={composeTools}
                                    addFiles={composeAddFiles}
                                    onFilesAdded={onComposeFilesAdded}
                                    commands={composeCommands}
                                    context={meterContext}
                                    compact={compact}
                                    openContextFile={onOpenContextFile}
                                    status={statusLine}
                                    usage={usageButton}
                                    jump={jumpPair} />
                            ))}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

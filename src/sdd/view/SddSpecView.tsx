import React, { useEffect, useMemo, useRef, useState } from "react";
import { LogLine, RunStatus } from "../../core/models/run";
import { GateRequest } from "../../core/execution/callbacks";
import { AiChoiceMessage, PluginAppMessage, SpecStage, TaskSession } from "../../shared/runMessages";
import { PanelWidths, SessionRunSummary, ToSddView } from "../../shared/sddMessages";
import { PluginBridge } from "../../view/pluginBridge";
import { ReviewNote } from "../../view/templates/reviewNotes";
import { withLine } from "../../view/templates/logEntry";
import { runKey } from "./sessionRuns";
import SddRunView from "./SddRunView";
import { CmdLogs, type DocDrafts } from "../../view/templates/TemplateRunView";
import { dropUnsent } from "./unsentLine";
import { host, onSddMessage } from "./host";

/** What the page keeps through a reload, in the host's page state: the Doc tab's unsaved edits and notes. */
interface KeptState {
    docDrafts?: Partial<DocDrafts>;
}

const kept = (): KeptState => (host.getState() as KeptState | undefined) ?? {};

/** The Doc tab's unsaved edits and notes, kept - the same way. */
const keepDocDrafts = (drafts: DocDrafts) => host.setState({ ...kept(), docDrafts: drafts });

/**
 * The spec panel: `SddRunView` fed from a spec folder read through
 * SDD core instead of from a workflow run. This file is only a message
 * pump. Rendering decisions belong in `SddRunView`.
 */

/** One more line of output for a phase, keyed by phase id so a failure stays separate from the drafting before it. */
function append(
    current: Record<string, CmdLogs>,
    key: string,
    line: Omit<LogLine, "ownerId">
): Record<string, CmdLogs> {

    let lines = current[key]?.lines ?? [];

    // The real prompt line takes the place of the oldest one still
    // drawn as sending - see `sendMessage` below.
    if (line.kind === "prompt" && !line.pending) {

        const index = lines.findIndex(one => one.pending === "sending");

        if (index >= 0)
            lines = [...lines.slice(0, index), ...lines.slice(index + 1)];
    }

    return {
        ...current,

        // `withLine`, not a plain append: a streaming delta replaces the
        // last live line instead of stacking half-finished copies of it.
        // What the hidden drafts charged rides along - see `spent`.
        [key]: { ...current[key], lines: withLine(lines, { ownerId: key, ...line }) }
    };
}

export default function SddSpecView() {

    const [title, setTitle] = useState("");
    const [specStages, setSpecStages] = useState<SpecStage[]>([]);

    /** What a plan row's `Run:` line may name - see the `workflows` message. */
    const [workflows, setWorkflows] = useState<string[]>([]);

    /** Tasks queued behind the wave being worked - see the `lanes` message. */
    const [queuedTasks, setQueuedTasks] = useState<string[]>([]);

    /** The `Run:` task waiting on a person's tick - see the `lanes` message. */
    const [waitingTasks, setWaitingTasks] = useState<string[]>([]);

    /** The "Stop after current session" switch - see the `lanes` message. */
    const [stopAfterCurrent, setStopAfterCurrent] = useState(false);

    /** When the next implementation session starts, during the wait before it - see the `lanes` message. */
    const [nextSessionAt, setNextSessionAt] = useState<number | undefined>();
    const [runningCommands, setRunningCommands] = useState<string[]>([]);
    const [documents, setDocuments] = useState<Record<string, string>>({});
    const [isRunning, setIsRunning] = useState(false);
    const [taskStatuses, setTaskStatuses] = useState<Record<string, RunStatus>>({});
    const [logsByTask, setLogsByTask] = useState<Record<string, CmdLogs>>({});

    /** The logs as last drawn - read by the message handler, which is set up once. */
    const logsRef = useRef(logsByTask);

    logsRef.current = logsByTask;

    const [savedDocDrafts] = useState(() => kept().docDrafts);
    const [taskSessions, setTaskSessions] = useState<TaskSession[]>([]);

    const [gate, setGate] = useState<GateRequest | undefined>();

    /** The review, as it stands on disk. Shared with whoever else opens this spec. */
    const [notes, setNotes] = useState<ReviewNote[]>([]);

    /**
     * The `sessionCost` feature flag - see the `features` message.
     * False until the host says otherwise, which is also its default,
     * so money is never drawn before anyone has asked for it.
     */
    const [sessionCost, setSessionCost] = useState(false);

    /** The `toolResults` feature flag - what a finished tool call returned, on its card. Off until the host says. */
    const [toolResults, setToolResults] = useState(false);

    /**
     * The `docDiff` feature flag - whether the Doc tab offers "What
     * changed". False until the host says otherwise, like every flag
     * here, so the button never appears for a moment before the answer
     * arrives and then vanishes.
     */
    const [docDiff, setDocDiff] = useState(false);

    /**
     * Each document's previous version. `null` means the host has no
     * version on record; an absent key means the view has not asked yet.
     */
    const [baselines, setBaselines] = useState<Record<string, string | null>>({});

    /** Every plugin that ships an app - a tab each. Sent on ready and after Reload Plugins. */
    const [pluginApps, setPluginApps] = useState<PluginAppMessage[]>([]);

    const [pluginSandboxed, setPluginSandboxed] = useState(true);

    /** What the spec's AI picker offers. Sent on every refresh, and again when the model list is in. */
    const [aiChoice, setAiChoice] = useState<AiChoiceMessage | undefined>();

    /** Column widths last dragged. */
    const [widths, setWidths] = useState<PanelWidths | undefined>();

    /** Every session run of this spec, for the sessions pane. */
    const [sessionRuns, setSessionRuns] = useState<SessionRunSummary[]>([]);

    /** Earlier runs' lines, as the pane asked for them - keyed by `runKey`. */
    const [sessionLines, setSessionLines] = useState<Record<string, LogLine[]>>({});

    /** A conversation to go to, from the chat's history. `seq` makes a second ask for the same one count. */
    const [focus, setFocus] = useState<{ ownerId: string; seq: number } | undefined>();

    const pluginBridge = useMemo(
        () => new PluginBridge(request => host.postMessage({ type: "pluginRequest", request })),
        []);

    useEffect(() => {

        /*
         * Log lines are applied in batches, one state update per paint.
         * A phase's answer streams as
         * a delta up to ten times a second, and each one would be its own render of the whole spec panel. Lines wait until the next
         * frame (or 100ms, for a hidden panel that gets no frames) and
         * land together. Every other message applies the waiting lines
         * first, so `clearLog` and `busy` keep their place in the order.
         */
        let queued: { stageId: string; line: Omit<LogLine, "ownerId"> }[] = [];
        let frame: number | undefined;
        let backstop: ReturnType<typeof setTimeout> | undefined;

        const flushLogs = (): void => {

            if (frame !== undefined)
                cancelAnimationFrame(frame);

            if (backstop !== undefined)
                clearTimeout(backstop);

            frame = undefined;
            backstop = undefined;

            if (queued.length === 0)
                return;

            const lines = queued;

            queued = [];

            setLogsByTask(current => {

                let next = current;

                for (const { stageId, line } of lines)
                    next = append(next, stageId, line);

                return next;
            });
        };

        const queueLog = (stageId: string, line: Omit<LogLine, "ownerId">): void => {

            queued.push({ stageId, line });

            if (frame === undefined)
                frame = requestAnimationFrame(flushLogs);

            if (backstop === undefined)
                backstop = setTimeout(flushLogs, 100);
        };

        const onMessage = (event: MessageEvent<ToSddView>) => {

            const message = event.data;

            if (message.type === "log") {

                queueLog(message.stageId, {
                    text: message.text,

                    stream: message.stream ?? "stdout",
                    at: Date.now(),

                    // The plugin's own labelling, whole. A `LogLine` is
                    // a `LogMeta`, so the fields match on both sides.
                    ...message.meta
                });

                return;
            }

            flushLogs();

            if (message.type === "spec") {

                setTitle(message.spec.name);
                setSpecStages(message.spec.stages);
                setGate(message.spec.gate);

            } else if (message.type === "document")
                setDocuments(current => ({ ...current, [message.path]: message.content }));
            else if (message.type === "workflows")
                setWorkflows(message.names);
            else if (message.type === "commands")
                setRunningCommands(message.running);
            else if (message.type === "lanes") {

                setQueuedTasks(message.queued);
                setWaitingTasks(message.waiting);
                setStopAfterCurrent(message.stopAfterCurrent === true);
                setNextSessionAt(message.nextStartsIn !== undefined ? Date.now() + message.nextStartsIn * 1000 : undefined);

            }

            else if (message.type === "busy") {

                setIsRunning(Boolean(message.stageId));

                // The view reads which chip is drafting off a walker
                // task id, `stage/job/index`. One phase is one call, so
                // a single entry in that shape is enough.
                setTaskStatuses(message.stageId ? { [`${message.stageId}/write/0`]: RunStatus.Running } : {});

                // No log clearing here. This message also arrives as a
                // reconciliation - `send()` re-sends it whenever the
                // host's state changes for any reason while a phase is
                // still running, not only when one just started - and
                // treating every arrival as "a phase started" would wipe
                // the conversation out from under a run already in
                // progress. A phase that is genuinely starting over
                // gets its own `clearLog` (see `launch` and `newSession`).

            } else if (message.type === "unsent")
                setLogsByTask(current => dropUnsent(current, message.stageId));


            else if (message.type === "clearLog")
                setLogsByTask(current => ({ ...current, [message.stageId]: { lines: [] } }));

            // What the hidden earlier lines charged - kept beside the
            // lines, so the tab showing them has both.
            else if (message.type === "spent")
                setLogsByTask(current => ({
                    ...current,
                    [message.stageId]: {
                        lines: current[message.stageId]?.lines ?? [],
                        spent: message.spent,
                        spentModels: message.models
                    }
                }));

            else if (message.type === "sessions")
                setTaskSessions(message.sessions);

            // Off until the host says otherwise, so a card drawn before
            // this lands never shows money the reader has not asked for.
            else if (message.type === "features") {
                setSessionCost(message.sessionCost);
                setDocDiff(message.docDiff);
                setToolResults(message.toolResults === true);
            }

            else if (message.type === "notes")
                setNotes(message.notes);

            else if (message.type === "baseline")
                setBaselines(current => ({ ...current, [message.path]: message.content ?? null }));

            else if (message.type === "pluginApps") {

                setPluginApps(message.apps);
                setPluginSandboxed(message.sandboxed);

            } else if (message.type === "pluginReply")
                pluginBridge.onReply(message.reply);

            // The model list arrives on its own message once the CLI
            // answers, and every later refresh sends the picker twice -
            // once without it, once with. The list already in hand is
            // kept over a message that lacks one, so the model field
            // never flickers back to free text.
            else if (message.type === "aiChoice")
                setAiChoice(prior => ({
                    ...message.choice,
                    models: message.choice.models ?? prior?.models,
                    modes: message.choice.modes ?? prior?.modes
                }));

            else if (message.type === "focus")
                setFocus(prior => ({ ownerId: message.ownerId, seq: (prior?.seq ?? 0) + 1 }));

            else if (message.type === "layout") {

                setWidths(message.widths);

            } else if (message.type === "sessionRuns")
                setSessionRuns(message.runs);

            else if (message.type === "sessionLines")
                setSessionLines(current => ({ ...current, [runKey(message)]: message.lines }));

            else if (message.type === "error")
                setLogsByTask(current =>
                    append(current, "error", { text: `${message.text}\n`, stream: "stderr", at: Date.now() }));
        };

        const stopListening = onSddMessage(onMessage);

        host.postMessage({ type: "ready" });

        return () => {

            stopListening();

            // Nothing to draw into any more; only the timers are stopped.
            queued = [];
            flushLogs();
        };
    }, [pluginBridge]);

    return (
        <SddRunView
            title={title}
            specStages={specStages}
            documents={documents}
            isRunning={isRunning}
            taskStatuses={taskStatuses}
            logsByTask={logsByTask}
            taskSessions={taskSessions}
            gate={gate}
            requestDocument={path => host.postMessage({ type: "requestDocument", path })}
            saveDocument={(path, content) => host.postMessage({ type: "saveDocument", path, content })}
            decide={(approved, reason) => host.postMessage({ type: "decide", approved, reason })}
            startPhase={(stage, revise, note) => host.postMessage({ type: "run", stageId: stage, revise, note })}
            stopPhase={() => host.postMessage({ type: "cancel" })}
            savedDocDrafts={savedDocDrafts}
            onDocDraftsChange={keepDocDrafts}
            aiChoice={aiChoice}
            setAiChoice={pick => host.postMessage({ type: "setAiChoice", pick })}
            notesToChat={(stageId, text) => host.postMessage({ type: "notesToChat", stageId, text })}
            refreshModels={provider => host.postMessage({ type: "refreshModels", provider })}
            startTasks={tasks => host.postMessage({ type: "implement", tasks })}
            runCommand={command => host.postMessage({ type: "runCommand", command })}
            runWorkflow={(name, params) => host.postMessage({ type: "runWorkflow", name, params })}
            workflows={workflows}
            queuedTasks={queuedTasks}
            waitingTasks={waitingTasks}
            markDone={taskId => host.postMessage({ type: "markDone", taskId })}
            stopAfterCurrent={stopAfterCurrent}
            setStopAfterCurrent={on => host.postMessage({ type: "stopAfterCurrent", on })}
            nextSessionAt={nextSessionAt}
            runningCommands={runningCommands}
            stopCommand={command => host.postMessage({ type: "stopCommand", command })}
            openSession={chat => host.postMessage({ type: "openSession", ...(chat.sessionId ? { sessionId: chat.sessionId } : {}), ...(chat.chatId ? { chatId: chat.chatId } : {}) })}
            openFile={path => host.postMessage({ type: "open", path })}
            notes={notes}
            sessionCost={sessionCost}
            toolResults={toolResults}
            docDiff={docDiff}

            // Optimistic, then corrected: the host echoes what it wrote,
            // so a failed write shows as the note reverting.
            saveNotes={next => {

                setNotes(next);
                host.postMessage({ type: "saveNotes", notes: next });
            }}
            baselines={baselines}
            requestBaseline={path => host.postMessage({ type: "requestBaseline", path })}
            pluginApps={pluginApps}
            pluginSandboxed={pluginSandboxed}
            pluginBridge={pluginBridge}
            sessionRuns={sessionRuns}
            sessionLines={sessionLines}
            requestSessionLines={(ownerId, iteration) => host.postMessage({ type: "requestSessionLines", ownerId, iteration })}
            widths={widths}
            focus={focus}

            // Drawn at once, kept by the host for every spec panel.
            saveWidths={next => {

                setWidths(next);
                host.postMessage({ type: "saveLayout", widths: next });
            }} />
    );
}

import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LogLine, RuntimeCommand, TurnChanges } from "../../core/models/run";
import type { PromptRef, SavedAnswerRow, ToChatHost, ToChatView, ToolsetChoice } from "../../shared/chatMessages";
import type { ComposeTools } from "../ChatView";
import { runtimeLabel, usageFrom } from "../ChatView";
import SessionPanel, { type SessionExtras } from "./SessionPanel";
import type { AiChoiceMessage, StageAi } from "../../shared/runMessages";
import ChatView from "../ChatView";
import { repoFolderName, turnHover, turnTitle, withNames } from "../text/changedFiles";
import { type AgentFile, type PendingRepo, agentChangedFiles, changedTurns, pendingChanges, turnMessages } from "./pendingChanges";
import { markUnsent, sendingLine, withHostLine } from "./sendingLine";
import { fileSearch, pathSearch } from "../fileSearch";
import { ChangedFiles, GoBackModal, TurnChangesList, type GoBackAsk } from "../ui";
import { entryFromLine } from "../templates/logEntry";
import LogPanel from "../templates/LogPanel";
import { host } from "../hostApi";

/*
 * The chat's view on the page: `ChatView` fed from one chat's lines.
 * This file is only a message pump; drawing the thread is `ChatView`'s.
 */

function post(message: ToChatHost): void {

    host.postMessage(message);
}

/** The compose box's "/" search, over the host. */
const files = fileSearch((requestId, query) => post({ type: "searchFiles", requestId, query }));

/** The compose box's ">" list, over the host - the connectors. */
const paths = pathSearch((requestId, path, query, refresh) => post({ type: "searchPaths", requestId, path, query, ...(refresh ? { refresh } : {}) }));

/** The snapshots a turn is known by, without its file list. */
function turnOf(changed: TurnChanges): Omit<TurnChanges, "files"> {

    return { root: changed.root, before: changed.before, after: changed.after };
}

/**
 * One repository's changes as the library's changed-files parts take them,
 * with the host's own record kept beside. `dropUndone` leaves out the files
 * put back since.
 */
function repoRow(repo: PendingRepo, dropUndone = false) {

    const files = repo.changed.files.filter(file => !dropUndone || !repo.undone.has(file.path)).map(withNames);

    return { root: repo.changed.root, name: repoFolderName(repo.changed.root), files, undone: repo.undone, changed: repo.changed };
}

/**
 * Which of the person's messages a turn is, the way the host counts
 * them: the how-manyth prompt line, from 0. Nothing when the turn is not
 * a prompt line here.
 */
export function promptIndexOf(lines: readonly LogLine[], entryIds: readonly string[], turnId: string): number | undefined {

    const at = entryIds.indexOf(turnId);

    if (at < 0 || lines[at]?.kind !== "prompt")
        return undefined;

    return lines.slice(0, at).filter(line => line.kind === "prompt" && line.pending === undefined).length;
}

/**
 * The compose box always has the runtime, mode and model pickers in its
 * bottom row, names in capital case, and no Usage or context meter
 * buttons - the Session panel shows both. The changed-files bar always
 * has Review all.
 *
 * @param emptyText   What the empty thread says.
 * @param side        The places for the log, for every turn's changed
 *                    files and for the Session panel: each one given is
 *                    drawn into its element, beside the thread, which
 *                    stays on screen. Several can show at once.
 * @param sessionExtras What the Session panel shows that the chat does
 *                    not know - the folders, connectors, steering files
 *                    and turned-off tools. Drawn with `side.session`.
 * @param onAgentFiles Told the files the chat's turns changed (see
 *                    `agentChangedFiles`) each time that list changes -
 *                    the file tree marks them.
 * @param onTurnMessages Told what was asked for each turn that changed
 *                    files (see `turnMessages`) - the turn diffs show it.
 * @param variant     An evaluation's variant: the pane only shows the
 *                    run. No message box, so nothing is typed or sent
 *                    here and no setup is picked - no Go back, no
 *                    Compact, no Handover. The variant got its message
 *                    and setup when it was made; Stop is in its column's
 *                    head on the Evaluator page.
 * @param takeSend    Asked with each message before it is sent. True:
 *                    the page took it for itself (a page command such
 *                    as `>spec>new`), so nothing is drawn and nothing
 *                    goes to the agent.
 */
export default function ChatPane({ emptyText, side, sessionExtras, onAgentFiles, onTurnMessages, variant, takeSend }: {
    emptyText: string;
    takeSend?(text: string): boolean;
    variant?: boolean;
    side: { logs?: HTMLElement; changes?: HTMLElement; session?: HTMLElement };
    sessionExtras?: SessionExtras;
    onAgentFiles?(files: AgentFile[]): void;
    onTurnMessages?(messages: Record<string, string>): void;
}) {

    const [lines, setLines] = useState<LogLine[]>([]);
    const [running, setRunning] = useState(false);

    // A stopped plan waits on this phase chat: the thread offers Resume.
    const [resumable, setResumable] = useState(false);

    const [ai, setAi] = useState<{ choice: AiChoiceMessage; current: StageAi; locked?: boolean } | undefined>();
    const [sessionCost, setSessionCost] = useState(false);

    /** The host has a ">" list - see `ChatHost.searchPaths`. */
    const [pathsOn, setPathsOn] = useState(false);

    /** What the Tools and MCP servers pickers offer, and this chat's pick. */
    const [toolset, setToolset] = useState<ToolsetChoice | undefined>();

    /**
     * What is typed in the compose box. Kept here so the host can add
     * text to it (`addText`) or put a message back in it (`refill`).
     */
    const [draft, setDraft] = useState("");

    /** Files sent in with `addFiles` that the compose box has not taken yet. */
    const [addedFiles, setAddedFiles] = useState<{ path: string; name?: string }[] | undefined>();

    /** The runtime's slash commands, as last kept in its file - see the `commands` message. */
    const [commands, setCommands] = useState<RuntimeCommand[]>([]);

    /** The go-back dialog, open: the message, and what the host said going back would do. */
    const [goBackAsk, setGoBackAsk] = useState<(GoBackAsk & { prompt: PromptRef }) | undefined>();

    /** The saved answers list, open: the rows the host sent last. */
    const [saved, setSaved] = useState<{ answers: SavedAnswerRow[]; chat: string; folder: string } | undefined>();

    useEffect(() => {

        /*
         * Log lines land in batches, one state update per paint, the same
         * as the spec panel: an answer streams up to ten deltas a second,
         * and each one was otherwise a render of the whole thread.
         */
        let queued: LogLine[] = [];
        let frame: number | undefined;
        let backstop: ReturnType<typeof setTimeout> | undefined;

        const flush = (): void => {

            if (frame !== undefined)
                cancelAnimationFrame(frame);

            if (backstop !== undefined)
                clearTimeout(backstop);

            frame = undefined;
            backstop = undefined;

            if (!queued.length)
                return;

            const arrived = queued;

            queued = [];

            setLines(current => arrived.reduce<LogLine[]>((next, line) => withHostLine(next, line), current));
        };

        const onMessage = (event: MessageEvent<ToChatView>) => {

            const message = event.data;

            if (message.type === "log") {

                queued.push({
                    ownerId: "chat",
                    text: message.text,
                    stream: message.stream ?? "stdout",
                    at: Date.now(),
                    ...message.meta
                });

                if (frame === undefined)
                    frame = requestAnimationFrame(flush);

                if (backstop === undefined)
                    backstop = setTimeout(flush, 100);

                return;
            }

            // Lines first, so a clear or a busy keeps its place in the order.
            flush();

            // Another chat on screen, new or reopened.
            if (message.type === "clearLog") {

                setLines([]);
                setAddedFiles(undefined);
                setSaved(undefined);
            }

            // The chat on screen: the page keeps its id in the address.
            else if (message.type === "chat")
                host.setState({ chatId: message.chatId });

            else if (message.type === "toolset")
                setToolset(message.choice);

            else if (message.type === "addFiles")
                setAddedFiles(prior => [...(prior ?? []), ...message.files]);

            // At the end of what is typed, a blank line apart.
            else if (message.type === "addText")
                setDraft(prior => prior.trim() ? `${prior.replace(/\s+$/, "")}\n\n${message.text}\n` : `${message.text}\n`);

            else if (message.type === "goBackInfo")
                setGoBackAsk({
                    prompt: message.prompt, files: message.files, about: message.about,
                    ...(message.text !== undefined ? { text: message.text } : {})
                });

            // After going back: the message, back in the box to send again.
            else if (message.type === "refill") {

                setDraft(message.text);
                setAddedFiles(message.files.length ? message.files : undefined);
            }

            else if (message.type === "unsent")
                setLines(current => markUnsent(current, message.text));

            else if (message.type === "busy")
                setRunning(message.running);

            else if (message.type === "resumable")
                setResumable(message.on);

            // A later message without the model lists keeps the lists
            // already in hand, so the model field never flickers.
            else if (message.type === "aiChoice")
                setAi(prior => ({
                    current: message.current,
                    ...(message.locked ? { locked: true } : {}),
                    choice: {
                        ...message.choice,
                        models: message.choice.models ?? prior?.choice.models,
                        modes: message.choice.modes ?? prior?.choice.modes
                    }
                }));

            else if (message.type === "commands")
                setCommands(message.commands);

            // Sent when the list is opened, and again after a removal.
            else if (message.type === "savedAnswers")
                setSaved({ answers: message.answers, chat: message.chat, folder: message.folder });
            else if (message.type === "fileMatches")
                files.receive(message.requestId, message.files);
            else if (message.type === "pathMatches")
                paths.receive(message.requestId, message.items);
            else if (message.type === "features") {

                setSessionCost(message.sessionCost);
                setPathsOn(message.paths === true);
            }
        };

        window.addEventListener("message", onMessage);
        post({ type: "ready" });

        return () => {

            window.removeEventListener("message", onMessage);

            queued = [];
            flush();
        };
    }, []);

    /** The newest turn's changed files still waiting on Keep or Undo - one entry per repository. */
    const pending = useMemo(() => pendingChanges(lines), [lines]);

    /** Every turn that changed files - only worked out while the side panel shows them. */
    const showTurns = side.changes !== undefined;

    const turns = useMemo(() => showTurns ? changedTurns(lines) : [], [lines, showTurns]);

    // The same, in the library parts' shape.
    const pendingRows = useMemo(() => pending.map(repo => repoRow(repo, true)), [pending]);

    const turnRows = useMemo(() => turns.map(turn => ({ key: turn.key, title: turnTitle(turn.message), hover: turnHover(turn.message), repos: turn.repos.map(repo => repoRow(repo)) })), [turns]);

    // The files the turns changed, for the host - told only when the list
    // itself changes, not on every new line of the thread.
    const tellAgentFiles = useRef(onAgentFiles);
    tellAgentFiles.current = onAgentFiles;

    const wantAgentFiles = onAgentFiles !== undefined;

    const agentFiles = useMemo(() => wantAgentFiles ? JSON.stringify(agentChangedFiles(lines)) : "[]", [lines, wantAgentFiles]);

    useEffect(() => {

        if (wantAgentFiles)
            tellAgentFiles.current?.(JSON.parse(agentFiles) as AgentFile[]);

    }, [agentFiles, wantAgentFiles]);

    // What each turn was asked, the same way.
    const tellTurnMessages = useRef(onTurnMessages);
    tellTurnMessages.current = onTurnMessages;

    const wantTurnMessages = onTurnMessages !== undefined;

    const asked = useMemo(() => wantTurnMessages ? JSON.stringify(turnMessages(lines)) : "{}", [lines, wantTurnMessages]);

    useEffect(() => {

        if (wantTurnMessages)
            tellTurnMessages.current?.(JSON.parse(asked) as Record<string, string>);

    }, [asked, wantTurnMessages]);

    // In the library's terms. The pick is a new object only when the host
    // sends a new one, so a redraw never resets a picker mid-click.
    const composeTools = useMemo((): ComposeTools | undefined => toolset && {
        tools: toolset.tools.map(tool => ({ id: tool.id, name: tool.id, ...(tool.description ? { description: tool.description } : {}) })),
        mcpServers: toolset.servers.map(server => ({
            id: server.id, name: server.id, status: "online" as const,
            ...(server.description ? { description: server.description } : {})
        })),
        selection: {
            autoTools: toolset.autoTools,
            enabledToolIds: toolset.enabledTools,
            autoMcpServers: toolset.autoServers,
            enabledMcpServerIds: toolset.enabledServers
        }
    }, [toolset]);

    // Started: a message has gone out. From then on the runtime is
    // locked, and changed only through Handover or a new chat.
    const started = useMemo(() => lines.some(line => line.kind === "prompt" && line.pending === undefined), [lines]);

    const entries = useMemo(() => lines.map((line, index) => entryFromLine(line, index, "chat")), [lines]);

    // What the Session panel shows of the charges, the context and the account.
    const sessionUsage = useMemo(() => usageFrom(entries), [entries]);

    return (
        <div className="chat-pane">
            <ChatView
                entries={entries}
                emptyText={emptyText}
                running={running}
                resumable={resumable}
                showCost={sessionCost}
                // A variant's column has no message box: nothing is sent from it.
                onSend={variant ? undefined : (text, sent, tools) => {

                    // A page command: the page acts on it, the agent never sees it.
                    if (takeSend?.(text))
                        return;

                    // Drawn now, as "Sending…": the host logs the real
                    // line only once the message has gone, which on a
                    // new turn is after the session has started. The
                    // real line takes its place, or `unsent` marks it.
                    // Attachments show on the real line.
                    setLines(current => [...current, sendingLine(text)]);

                    post({ type: "send", text, files: sent, ...(tools ? { tools } : {}) });
                }}
                onAnswer={(askId, answer) => post({ type: "answer", askId, answer })}
                onGoBack={variant ? undefined : (turnId, text, edited) => {

                    const index = promptIndexOf(lines, entries.map(entry => entry.id), turnId);

                    if (index !== undefined)
                        post({ type: "goBackCheck", prompt: { index, text }, ...(edited !== undefined ? { text: edited } : {}) });
                }}
                onStop={() => post({ type: "cancel" })}
                onCompact={variant ? undefined : () => post({ type: "compact" })}
                stopTitle="Stop the agent"
                composeDraft={draft}
                onComposeDraftChange={setDraft}
                composeAddFiles={addedFiles}
                onComposeFilesAdded={() => setAddedFiles(undefined)}
                searchFiles={files.search}
                searchPaths={pathsOn ? paths.search : undefined}
                composeCommands={commands}
                onOpenFile={path => post({ type: "open", path })}
                onOpenContextFile={path => post({ type: "openContextFile", path })}
                onRefreshModels={provider => post({ type: "refreshModels", provider })}
                composeAi={ai
                    ? {
                        current: ai.current,
                        choice: ai.choice,
                        onPick: pick => post({ type: "setAiChoice", pick }),
                        locked: started || ai.locked === true,
                        ...(ai.locked ? { held: true } : {}),
                        ...(started && !variant
                            ? {
                                handover: {
                                    onStart: pick => post({ type: "handover", ...pick }),
                                    onModels: provider => post({ type: "listModels", provider })
                                }
                            }
                            : {})
                    }
                    : undefined}
                composeLevels={ai?.choice.levels?.[ai.current.provider]
                    ? {
                        level: ai.choice.levels[ai.current.provider].level,
                        acp: ai.choice.levels[ai.current.provider].acp,
                        runtimeName: runtimeLabel(ai.current.provider),
                        savedAnswers: ai.choice.savedAnswers ?? 0,
                        onPick: level => post({ type: "setPermissionLevel", provider: ai.current.provider, level }),
                        onSavedAnswers: () => post({ type: "listSavedAnswers" })
                    }
                    : undefined}
                savedAnswers={saved
                    ? {
                        ...saved,
                        onRemove: id => post({ type: "removeSavedAnswer", id }),
                        onClose: () => setSaved(undefined)
                    }
                    : undefined}
                composeHeader={pending.length && !running
                    ? (
                        <ChangedFiles
                            repos={pendingRows}
                            onDiff={(repo, path) => post({ type: "diffFile", changed: turnOf(repo.changed), path })}
                            onUndo={(repo, paths) => post({ type: "undoFiles", changed: repo.changed, paths })}
                            onReviewAll={left => post({ type: "reviewFiles", changes: left.map(one => ({ ...one.repo.changed, files: one.files.map(file => ({ path: file.path, status: file.status })) })) })}
                            onKeep={() => {

                                for (const repo of pending)
                                    post({ type: "keepFiles", changed: turnOf(repo.changed) });
                            }} />
                    )
                    : undefined}
                composeAiInToolbar
                composeCapitalNames
                showMeters={false}
                composeTools={composeTools} />

            <GoBackModal
                ask={goBackAsk}
                onClose={() => setGoBackAsk(undefined)}
                onConfirm={restoreFiles => {

                    if (goBackAsk)
                        post({
                            type: "goBack", prompt: goBackAsk.prompt, restoreFiles,
                            ...(goBackAsk.text !== undefined ? { text: goBackAsk.text } : {})
                        });

                    setGoBackAsk(undefined);
                }} />

            {side.logs && createPortal(
                <div className="log-tab">
                    <LogPanel entries={entries} loading={running} />
                </div>,
                side.logs)}

            {side.changes && createPortal(
                <TurnChangesList
                    turns={turnRows}
                    onDiff={(repo, path, now) => post({ type: now ? "diffFile" : "diffTurn", changed: turnOf(repo.changed), path })}
                    onUndo={(repo, path) => post({ type: "undoFiles", changed: repo.changed, paths: [path] })} />,
                side.changes)}

            {side.session && createPortal(
                <SessionPanel
                    entries={entries}
                    runtime={ai?.current.provider}
                    model={ai ? ai.choice.models?.[ai.current.provider]?.find(one => one.id === ai.current.model)?.name ?? ai.current.model : undefined}
                    level={ai?.choice.levels?.[ai.current.provider]?.level}
                    context={sessionUsage.context}
                    session={sessionUsage.session}
                    sessionModels={sessionUsage.sessionModels}
                    accounts={sessionUsage.accounts}
                    showCost={sessionCost}
                    running={running}
                    onCompact={() => post({ type: "compact" })}
                    onOpenFile={path => post({ type: "open", path })}
                    onOpenContextFile={path => post({ type: "openContextFile", path })}
                    extras={sessionExtras ?? { folders: [] }} />,
                side.session)}
        </div>
    );
}

import * as fs from "fs";
import * as path from "path";

import { readCommandList } from "../core/agent/commandListFile";
import { answerShown } from "../core/agent/permissions/gate";
import { claudeCutPoint, cutsClaude, forkClaudeConversation } from "../core/agent/providers/claudeRewind";
import { cutKiroConversation, isKiroV3 } from "../core/agent/providers/kiroSessions";
import { EnvService } from "../core/env/envService";
import { EventWriter } from "../core/events/EventWriter";
import { chatEventsPath, stamp } from "../core/events/eventFile";
import { currentEvents, lastSession, lineFrom, RunEvent } from "../core/events/runEvents";
import { logger } from "../core/logging/logger";
import { isPermissionLevel, levelFits, type SavedAnswer } from "../core/models/permissionCard";
import type { ContextUsage, TurnChanges } from "../core/models/run";
import { contextFiles } from "../shared/contextFiles";
import { loadEngineSettings } from "../core/settings/engineSettings";
import { aiFor, AiPick, aiSourcesFor, configFromSettings, DEFAULT_PROVIDER } from "../sdd/config/sddConfig";
import { goBackPrompt, handoverStartPrompt, handoverTranscript } from "../sdd/phase/handover";
import type { PluginHost } from "../core/plugins/PluginHost";
import { type CallResult, runCall, type SessionCall, type SessionHost } from "../sdd/phase/runPhase";
import type {
    ChatSummary, ChatToolset, PromptRef, SavedAnswerRow, SentToolSelection, ToChatHost, ToChatView
} from "../shared/chatMessages";
import type { SentFile } from "../shared/composeFiles";
import type { StageAi } from "../shared/runMessages";
import {
    aiChoiceMessage, isAiPick, modelsOf, offeredRuntimes, providerIds, refreshModels, toolsOf
} from "./aiChoice";
import { type ChatHost, type ChatSurface, type PhaseOwner, TURN_FAILED, TURN_STOPPED } from "./chatHost";
import { listChats } from "./chatHistory";
import { isAcpRuntime, levelsOf, writeLevel } from "./permissionLevels";
import { chatPick, defaultRuntimeOf, newChatId, startRuntime } from "./chatRules";
import { toolsetChoice, toolsetFrom, toolsetKey, withToolset } from "./chatToolset";
import { resolveSentFiles } from "./sentFiles";
import { typedMessageIn, withSentFiles } from "./typedMessage";
import { changedBetween, contentAt, repoRoot, snapshot } from "./turnSnapshot";

/**
 * One chat with an agent, not tied to a spec phase or a workflow step.
 *
 * A turn runs through `ai@1`, the same plugin a phase runs through, so
 * steering files, MCP servers, permissions and settings.json's provider
 * blocks behave as they do there. Every line the turn prints is written
 * to the chat's own events file and drawn on its surface; reopening the
 * surface redraws the thread from that file.
 *
 * No server code in here: everything the server owns - saved values,
 * folders, pop-ups, the diff view - goes through its {@link ChatHost}.
 */

/** Whose lines they are, inside a chat's events file. One chat per file, so one owner. */
const OWNER = "chat";

/** A chat's own runtime and model - see {@link ChatController.pickOf}. */
export const PICK_PREFIX = "chat.pick:";

/** A chat's own Tools and MCP servers pick - see `chatToolset.ts`. */
export const TOOLSET_PREFIX = "chat.toolset:";

/** The pick the chat's conversation was last opened with, as `toolsetKey` writes it. */
export const APPLIED_PREFIX = "chat.applied:";

/** Names given to chats by hand - see {@link ChatController.renameChat}. */
export const TITLES_KEY = "chat.titles";

/**
 * The file a chat's next message carries, after going back on a runtime
 * whose conversation could not be cut - see {@link ChatController.goBack}.
 * `{ path, lines }`, the path full: the working folder can still change
 * before that message.
 */
export const CARRY_PREFIX = "chat.carry:";

/** What the copy of a chat that went back is called. */
export const BEFORE_GOING_BACK = " (before going back)";

/**
 * One chat on screen: its thread, its running turn and the session it
 * holds. It is drawn in one browser tab.
 */
export class ChatController {

    private surface?: ChatSurface;

    chatId: string;

    private events: EventWriter;

    /** A turn is running. One at a time: a message sent meanwhile goes into it. */
    private busy = false;

    /** How many prompt lines this chat has posted - see `sendAndSettle`. */
    private promptsPosted = 0;

    private cancelRequested = false;

    /** What stops the turn in flight - the plugin's cancel and any process kill. */
    private readonly stops = new Set<() => void>();

    /** Set while old lines are drawn again, so they are not written down twice. */
    private replaying = false;

    /** Its tab was closed: the chat is over, and the turn in flight is stopped. */
    private closed = false;

    /**
     * The questions the agent asked in the running turn that nobody
     * answered yet, by ask id, oldest first. Two can be open at once. An
     * answer line closes one - the person's, or the one a stopped turn
     * writes - and the turn's end closes them all.
     */
    private readonly asking = new Map<string, string>();

    constructor(
        private readonly host: ChatHost,
        chatId: string
    ) {

        this.chatId = chatId;
        this.events = this.writerFor(chatId);
    }

    /** Drawn here from now on. The thread is drawn once the view says it is ready. */
    attach(surface: ChatSurface): void {

        this.surface = surface;
    }

    detach(surface?: ChatSurface): void {

        if (!surface || this.surface === surface)
            this.surface = undefined;
    }

    /** Whether a turn is running. */
    get working(): boolean {

        return this.busy;
    }

    /**
     * The newest question the agent asked in the running turn and nobody
     * answered yet - it is stopped until someone does. Nothing when no
     * question is open. The chat list marks such a chat.
     */
    get waiting(): string | undefined {

        return [...this.asking.values()].pop();
    }

    /**
     * Whether a runtime has answered in this chat at least once - its
     * conversation is then tied to the folder it started in.
     */
    get started(): boolean {

        return lastSession(this.events.read(), OWNER) !== undefined;
    }

    /** The conversation it holds now - the last one a runtime opened in it. Nothing before its first turn. */
    held(): { sessionId: string; provider?: string; model?: string } | undefined {

        return lastSession(this.events.read(), OWNER);
    }

    /** A message from the view it is drawn in. */
    receive(message: ToChatHost): void {

        void this.onMessage(message).catch(error => this.fail((error as Error).message));
    }

    /** Puts `text` in the view's compose box, in place of what it holds. */
    putDraft(text: string): void {

        this.post({ type: "refill", text, files: [] });
    }

    /** The view was emptied for another chat: draw this one into it. */
    async redraw(): Promise<void> {

        this.post({ type: "clearLog" });

        await this.ready();
    }

    /**
     * Its tab was closed: the chat ends. The turn in flight is stopped
     * and the session let go; its file stays, so the history still
     * lists it and it can be opened again.
     */
    async close(): Promise<void> {

        this.closed = true;
        this.surface = undefined;

        this.stop();

        await this.letGo();
    }

    /** Ends the session this chat holds, if this program still holds one. */
    private async letGo(): Promise<void> {

        const last = lastSession(this.events.read(), OWNER);

        if (last && this.host.sessions().get(last.sessionId))
            try {

                await this.host.sessions().end(last.sessionId);

            } catch (error) {

                logger.warning(`Chat: could not stop session ${last.sessionId}. ${(error as Error).message}`);
            }
    }

    /** The name the history shows: given by hand, else the first thing asked. */
    title(): string {

        return this.titles()[this.chatId]
            ?? listChats(this.host.historyKey()).find(chat => chat.id === this.chatId)?.title
            ?? "New session";
    }

    /**
     * The chat as Markdown, for Export: the same text a Handover writes
     * to its file - what each side said, and each tool call with the
     * first lines of its output. Only what the chat shows today. Nothing
     * when nobody wrote in it yet.
     */
    exportText(): { title: string; text: string } | undefined {

        const shown = currentEvents(this.events.read());

        if (!shown.some(event => event.kind === "prompt" && event.ownerId === OWNER))
            return undefined;

        const last = shown.reduce<RunEvent | undefined>((found, event) => event.kind === "session" && event.ownerId === OWNER ? event : found, undefined);
        const title = this.title();

        return { title, text: handoverTranscript(shown, OWNER, { title, from: last?.provider, model: last?.model, at: Date.now() }).text };
    }

    private get workspace(): string | undefined {

        return this.host.workspace();
    }

    /** Where settings.json is read beside the profile's. */
    private get settingsFolder(): string | undefined {

        return this.host.ai.workspaceFolder();
    }

    private writerFor(chatId: string): EventWriter {

        return new EventWriter(
            chatEventsPath(this.host.historyKey(), chatId),
            `chat:${chatId}`,
            error => logger.warning(`Chat: could not record an event. ${(error as Error).message}`));
    }

    private async onMessage(message: ToChatHost): Promise<void> {

        switch (message.type) {

            case "ready":
                return this.ready();

            case "send":
                return this.sendAndSettle(message.text, message.files, message.tools);

            case "answer":
                return this.answer(message.askId, message.answer);

            case "cancel":
                return this.stop();

            case "newChat":
                return this.newChat();

            case "compact":
                return this.compact();

            case "setAiChoice":

                // An evaluation's variant keeps the setup it was made
                // with: a pick that still arrives changes nothing.
                if (this.setupLocked())
                    return this.postAiChoice();

                await this.host.store.update(PICK_PREFIX + this.chatId, message.pick);

                return this.postAiChoice();

            case "handover":

                // Checked, not trusted: the message comes from the page.
                if (typeof message.provider !== "string" || !message.provider.trim())
                    return;

                return this.handover(
                    message.provider.trim(),
                    typeof message.model === "string" && message.model.trim() ? message.model.trim() : undefined);

            // The modal picked a runtime - its models, once they land.
            case "listModels":

                if (typeof message.provider !== "string" || !message.provider.trim())
                    return;

                // Sent now, while the fetch is in flight, so the modal
                // says the models are loading. Sent again once it ends,
                // with a list or without, so that never stays on.
                {
                    const fetching = modelsOf(message.provider.trim(), this.host.ai);

                    // In this order: the loading post never lands last.
                    return void this.postAiChoice()
                        .then(() => fetching)
                        .then(() => this.surface ? this.postAiChoice() : undefined);
                }

            // The refresh button beside a model picker. Sent now so the
            // button shows it is busy, and again once the fetch ends.
            case "refreshModels":

                if (typeof message.provider !== "string" || !message.provider.trim())
                    return;

                {
                    const refreshing = refreshModels(message.provider.trim(), this.host.ai);

                    return void this.postAiChoice()
                        .then(() => refreshing)
                        .then(() => this.surface ? this.postAiChoice() : undefined);
                }

            // The Permissions picker.
            case "setPermissionLevel":

                // Checked, not trusted: a level the runtime's kind does not offer is refused.
                if (typeof message.provider !== "string" || !message.provider.trim()
                    || !isPermissionLevel(message.level) || !levelFits(message.level, isAcpRuntime(message.provider.trim())))
                    return;

                await writeLevel(this.host.store, message.provider.trim(), message.level);

                return this.postAiChoice();

            case "listSavedAnswers":
                return this.postSavedAnswers();

            case "removeSavedAnswer":

                if (typeof message.id !== "string")
                    return;

                this.host.permissions.remove(message.id);

                await this.postSavedAnswers();

                return this.postAiChoice();

            case "searchFiles": {

                const root = this.workspace;

                let files: Awaited<ReturnType<ChatHost["searchFiles"]>> = [];

                try {

                    files = root ? await this.host.searchFiles(root, message.query) : [];

                } catch (error) {

                    logger.warning(`Chat: file search failed. ${(error as Error).message}`);
                }

                return this.post({ type: "fileMatches", requestId: message.requestId, files });
            }

            case "searchPaths": {

                let items: Awaited<ReturnType<ChatHost["searchPaths"]>> = [];

                try {

                    items = await this.host.searchPaths(message.path, message.query, message.refresh);

                } catch (error) {

                    items = [{ name: "-", detail: (error as Error).message, disabled: true }];
                }

                return this.post({ type: "pathMatches", requestId: message.requestId, items });
            }

            case "open":
                return this.host.openFile(message.path);

            case "openContextFile":
                return this.openContextFile(message.path);

            case "listHistory":
                return this.postHistory();

            case "openChat":
                return this.openChat(message.chatId);

            case "renameChat":
                return this.renameChat(message.chatId);

            case "deleteChat":
                return this.deleteChat(message.chatId);

            case "diffFile":
                return this.diffFile(message.changed, message.path);

            case "diffTurn":
                return this.diffTurn(message.changed, message.path);

            case "undoFiles":
                return this.undoFiles(message.changed, message.paths);

            case "reviewFiles":
                return this.reviewFiles(message.changes);

            // Keep: the bar goes, and stays gone after a reload.
            case "keepFiles":
                return this.post({
                    type: "log", stream: "system", text: "Kept the changes.\n",
                    meta: { kind: "files.kept", changed: { ...message.changed, files: [] } }
                });

            case "goBackCheck":
                return this.goBackCheck(message.prompt, typeof message.text === "string" ? message.text : undefined);

            case "goBack":
                return this.goBack(
                    message.prompt,
                    message.restoreFiles === true,
                    typeof message.text === "string" ? message.text : undefined);
        }
    }

    /** Names given by hand, by chat id. Kept in the chat store beside the picks. */
    private titles(): Record<string, string> {

        const stored = this.host.store.get<unknown>(TITLES_KEY);

        return stored && typeof stored === "object" ? stored as Record<string, string> : {};
    }

    /**
     * The history list: the chats. The chat on screen is listed even before its first message,
     * so the list always shows where you are.
     */
    private postHistory(): void {

        const titles = this.titles();

        const chats: ChatSummary[] = listChats(this.host.historyKey()).map(chat => ({
            ...chat,
            ...(typeof titles[chat.id] === "string" ? { title: titles[chat.id] } : {}),
            ...(chat.id === this.chatId ? { current: true } : {})
        }));

        if (!chats.some(chat => chat.current))
            chats.unshift({ id: this.chatId, title: titles[this.chatId] ?? "New session", at: Date.now(), current: true });

        this.post({ type: "history", chats });
    }

    /**
     * Puts another chat on screen: its thread, and its own runtime pick.
     * The one left keeps its file; this program's hold on its session is
     * let go, and the runtime keeps the conversation to reopen later.
     *
     * Refused while a turn runs - the chat on screen is the one working.
     * A chat already on screen in another tab is put in front there
     * instead: one chat is never drawn twice.
     */
    private async switchTo(chatId: string): Promise<boolean> {

        if (chatId === this.chatId)
            return true;

        const holder = this.host.holder(chatId, this);

        if (holder) {

            this.host.show(holder);

            return false;
        }

        if (this.busy) {

            this.note("Still working - stop the agent first, then switch sessions.");

            return false;
        }

        const last = lastSession(this.events.read(), OWNER);

        if (last && this.host.sessions().get(last.sessionId))
            try {

                await this.host.sessions().end(last.sessionId);

            } catch (error) {

                logger.warning(`Chat: could not stop session ${last.sessionId}. ${(error as Error).message}`);
            }

        this.chatId = chatId;
        this.events = this.writerFor(chatId);

        await this.host.changed(this);

        this.post({ type: "clearLog" });
        this.post({ type: "chat", chatId });
        this.replay();

        await this.postAiChoice();

        return true;
    }

    /** Puts an earlier chat on screen - the history list's click. Public so the server can open one from outside. */
    async openChat(chatId: string): Promise<void> {

        // Only a chat that is in the list - the id names a file.
        if (!listChats(this.host.historyKey()).some(chat => chat.id === chatId) && chatId !== this.chatId)
            return this.note("That session is gone - it may have been deleted in another window.");

        await this.switchTo(chatId);
    }

    private async renameChat(chatId: string): Promise<void> {

        const titles = this.titles();
        const known = listChats(this.host.historyKey()).find(chat => chat.id === chatId);

        const name = await this.host.askText({
            title: "Rename session",
            value: titles[chatId] ?? known?.title ?? "",
            prompt: "Leave empty to go back to the first message as its name."
        });

        // Escape: nothing changes.
        if (name === undefined)
            return;

        const next = { ...titles };

        if (name.trim())
            next[chatId] = name.trim();
        else
            delete next[chatId];

        await this.host.store.update(TITLES_KEY, next);

        this.host.renamed(chatId);
        this.postHistory();
    }

    /**
     * Deletes a chat's file for good, after asking. The runtime's own
     * transcript is not touched. Deleting the chat on screen sends the
     * tab to its workspace's page, or starts a new chat (see
     * `replaceDeleted`).
     */
    private async deleteChat(chatId: string): Promise<void> {

        if (chatId === this.chatId && this.busy)
            return this.note("Still working - stop the agent first, then delete the session.");

        // Its file is still being written there.
        if (this.host.holder(chatId, this))
            return this.note("That session is open in another tab. Close it there first, then delete it.");

        const known = listChats(this.host.historyKey()).find(chat => chat.id === chatId);

        const title = this.titles()[chatId] ?? known?.title ?? "this session";

        if (!await this.host.confirm(`Delete '${title}'? Its thread cannot be brought back.`, "Delete"))
            return;

        const onScreen = chatId === this.chatId;

        // Its runtime session ends while its file still says which one it is.
        if (onScreen)
            await this.letGo();

        let problem: string | undefined;

        try {

            fs.rmSync(chatEventsPath(this.host.historyKey(), chatId), { force: true });

        } catch (error) {

            problem = (error as Error).message;
        }

        if (onScreen)
            await this.replaceDeleted(problem === undefined);

        if (problem !== undefined)
            return this.fail(`Could not delete the session: ${problem}`);

        this.host.deleted(chatId);

        const titles = { ...this.titles() };

        delete titles[chatId];

        await this.host.store.update(TITLES_KEY, titles);
        await this.host.store.update(PICK_PREFIX + chatId, undefined);

        this.postHistory();
    }

    /**
     * Deletes several chats for good after one question - all the chats
     * of a folder, or of one day in it, in the chat list.
     * `question` is what the person is asked. Nothing is deleted when any
     * of them is working or open in another tab. Chats
     * already gone are left out. Public so the server can delete many at
     * once; the chat's own view only deletes one at a time.
     */
    async deleteChats(chatIds: readonly string[], question: string): Promise<void> {

        const known = listChats(this.host.historyKey());
        const wanted = [...new Set(chatIds)].filter(chatId => known.some(chat => chat.id === chatId));

        if (!wanted.length)
            return this.note("Those sessions are gone - they may have been deleted in another tab.");

        if (this.refuseBusy(wanted, known))
            return;

        if (!await this.host.confirm(question, "Delete"))
            return;

        // Checked again: one may have been opened or started while the question was up.
        if (this.refuseBusy(wanted, known))
            return;

        const onScreen = wanted.includes(this.chatId);

        // Its runtime session ends while its file still says which one it is.
        if (onScreen)
            await this.letGo();

        const deleted: string[] = [];
        const failed: string[] = [];

        for (const chatId of wanted) {

            try {

                fs.rmSync(chatEventsPath(this.host.historyKey(), chatId), { force: true });

            } catch (error) {

                failed.push((error as Error).message);

                continue;
            }

            deleted.push(chatId);
            this.host.deleted(chatId);
        }

        // As for one chat.
        if (onScreen)
            await this.replaceDeleted(failed.length === 0);

        const titles = { ...this.titles() };

        for (const chatId of deleted)
            delete titles[chatId];

        await this.host.store.update(TITLES_KEY, titles);

        for (const chatId of deleted)
            await this.host.store.update(PICK_PREFIX + chatId, undefined);

        if (failed.length)
            this.fail(`Could not delete ${failed.length} of the ${wanted.length} sessions: ${failed[0]}`);

        this.postHistory();
    }

    /**
     * The chat on screen was deleted. `clean`: everything asked was
     * deleted - a chat in a workspace then sends its tab to the
     * workspace's page (see `ChatHost.leaveDeleted`). Otherwise a new
     * chat takes its place on screen, and says what could not be deleted.
     *
     * Either way this moves on to a new chat, so nothing is written into
     * the deleted file again. With the tab gone it is drawn nowhere, and
     * goes as every chat with nothing said goes.
     */
    private async replaceDeleted(clean: boolean): Promise<void> {

        if (clean)
            this.host.leaveDeleted?.();

        await this.newChat();
    }

    /**
     * Before deleting several chats: when any of them is working or open
     * in another tab, says which and answers true -
     * nothing may be deleted then.
     */
    private refuseBusy(chatIds: readonly string[], known: readonly { id: string; title: string }[]): boolean {

        const busy = chatIds.filter(chatId => (chatId === this.chatId && this.busy) || this.host.holder(chatId, this));

        if (!busy.length)
            return false;

        const titles = this.titles();

        const names = busy
            .slice(0, 5)
            .map(chatId => `'${titles[chatId] ?? known.find(chat => chat.id === chatId)?.title ?? chatId}'`)
            .join(", ") + (busy.length > 5 ? ` and ${busy.length - 5} more` : "");

        this.note(busy.length === 1
            ? `Nothing was deleted. ${names} is working or open in another tab - stop it or close it there first.`
            : `Nothing was deleted. ${busy.length} of the sessions are working or open in another tab: ${names}. Stop them or close them there first.`);

        return true;
    }

    /** A fresh view: the thread so far, and everything the compose row needs. */
    private async ready(): Promise<void> {

        this.post({ type: "chat", chatId: this.chatId });
        this.replay();

        this.post({ type: "busy", running: this.busy });

        this.postResume();

        await this.postFeatures();

        await this.postAiChoice();
    }

    /**
     * Whether the thread offers Resume: a phase chat a stopped plan waits
     * on. Public: SDD calls it when the plan stops at the chat or carries
     * on from it - see `SddHost.resumeChanged`.
     */
    postResume(): void {

        this.post({ type: "resumable", on: this.host.owner?.()?.resumable() === true });
    }

    /**
     * settings.json was changed (from the settings page):
     * the flags the view draws by and the runtime list are sent again, so
     * the chat on screen shows the change without being opened again.
     */
    async settingsChanged(): Promise<void> {

        await this.postFeatures();

        await this.postAiChoice();
    }

    /**
     * The message with one line for each ">" path in it, under it - see
     * `ChatHost.pathReferences`. `sentWith`: those lines, which the
     * thread shows under the message as typed. A path that could not be read is
     * said in the log; the message goes anyway.
     */
    private async withPathLines(message: string): Promise<{ prompt: string; sentWith?: string[] }> {

        if (!/(^|\s)>\S/.test(message))
            return { prompt: message };

        try {

            const { lines, note } = await this.host.pathReferences(message);

            if (note)
                this.post({ type: "log", text: `${note}\n`, stream: "system" });

            if (!lines.length)
                return { prompt: message };

            return {
                prompt: `${message}\n\n${lines.join("\n")}`,
                sentWith: lines
            };

        } catch (error) {

            this.post({ type: "log", text: `The > paths could not be read, so the message went without them. ${(error as Error).message}\n`, stream: "system" });

            return { prompt: message };
        }
    }

    /** The feature flags the view draws by. */
    private async postFeatures(): Promise<void> {

        let sessionCost = false;

        try {

            sessionCost = (await loadEngineSettings(this.settingsFolder)).features.sessionCost === true;

        } catch {

            // A broken settings.json is reported by the turn that reads it.
        }

        this.post({ type: "features", sessionCost, paths: true });
    }

    /** The chat's lines, drawn again from its file. */
    private replay(): void {

        this.replaying = true;

        try {

            for (const event of currentEvents(this.events.read())) {

                const line = lineFrom(event, OWNER);

                if (line)
                    this.post({ type: "log", text: line.text, stream: line.stream, meta: line });
            }

        } finally {

            this.replaying = false;
        }
    }

    /**
     * This chat's own pick, when it made one. Kept per chat in the
     * chat store, not in the workspace pick the spec panel reads:
     * switching this chat to Copilot must not move every phase to
     * Copilot too.
     */
    private pickOf(chatId: string): AiPick | undefined {

        const stored = this.host.store.get<AiPick>(PICK_PREFIX + chatId);

        // Shape-checked on the way out: saved values outlive builds.
        return isAiPick(stored) ? stored : undefined;
    }

    /**
     * What the next turn runs on, and how the picker should show it.
     *
     * The same ladder a phase goes down, with this chat's pick where the
     * workspace pick would be - or, with no pick, the default runtime
     * when it is on offer, else the first one on offer (see
     * {@link chatPick} and {@link startRuntime}).
     */
    private async resolveAi(): Promise<{ ai: { uses: string; args: Record<string, unknown> }; current: StageAi; own?: AiPick }> {

        if (!this.workspace)
            throw new Error("Open a folder first - the session works in the workspace.");

        const settings = await loadEngineSettings(this.settingsFolder);

        const stored = this.pickOf(this.chatId);

        // A chat with no pick of its own starts on the default runtime
        // when it is on offer, else on the first one on offer. With no
        // `ai.providers` and no `unlisted` from the host, the settings
        // decide, as for a phase.
        const offered = settings.ai.providers ?? (this.host.ai.unlisted ? offeredRuntimes(settings, this.host.ai) : undefined);
        const pick = chatPick(stored, settings.ai.providers, startRuntime(offered, defaultRuntimeOf(settings)));

        // The pick in effect is the chat's own only when `chatPick` kept
        // it; a first-runtime default is the settings speaking.
        const own = stored !== undefined && pick === stored ? stored : undefined;

        // The same config a spec panel builds (see `SddCore.create`),
        // less the styles - a chat runs none.
        const config = configFromSettings({
            sdd: settings.sdd,
            aiDefaults: settings.ai.defaults,
            acpAgents: settings.ai.acpAgents,
            providers: settings.ai.providers,
            aiScopedDefaults: settings.ai.scopedDefaults,
            variables: settings.variables,
            fakeRuntime: settings.features?.fakeRuntime

            // The providers use the permission check.
        }, pick);

        const ai = aiFor(config);
        const sources = aiSourcesFor(config);

        return {
            ai,
            own,
            current: own ? sources : { ...sources, providerFrom: sources.providerFrom === "pick" ? "settings" : sources.providerFrom }
        };
    }

    /**
     * The runtime and model this chat's next turn would run on, for a
     * short job beside the chat that is not part of it - the
     * commit message button. A started chat answers with the runtime it
     * started on. Nothing of the chat changes.
     */
    async sideJobAi(): Promise<{ uses: string; args: Record<string, unknown> }> {

        const { ai } = await this.resolveAi();

        const last = lastSession(this.events.read(), OWNER);

        if (!last?.provider || providerOf(ai.args) === last.provider)
            return ai;

        return { ...ai, args: { ...ai.args, provider: last.provider, ...(last.model ? { model: last.model } : {}) } };
    }

    /**
     * Whether this chat's runtime, model, mode and effort cannot be
     * picked: it is an evaluation's variant. Its setup is picked when the
     * variant is made, and stays, so its numbers are about one setup.
     */
    private setupLocked(): boolean {

        return this.host.unattended?.() === true;
    }

    /**
     * The compose row's picker. Sent now with the model lists already in,
     * then once more when this runtime's list lands.
     */
    private async postAiChoice(): Promise<void> {

        let resolved: Awaited<ReturnType<ChatController["resolveAi"]>>;

        try {

            resolved = await this.resolveAi();

        } catch (error) {

            // No picker is the lesser harm; the next Send says why.
            logger.warning(`Chat: could not resolve the runtime. ${(error as Error).message}`);

            return;
        }

        // A phase chat runs on the spec's AI, held to the runtime its
        // conversation is on: the picker shows that, and stays locked -
        // the spec's own picker changes it.
        const owner = this.host.owner?.();

        if (owner) {

            const last = lastSession(this.events.read(), OWNER);
            const spec = last?.provider ? undefined : await owner.ai().catch(() => undefined);
            const provider = last?.provider ?? (spec ? providerOf(spec.args) : undefined);

            if (provider)
                resolved = {
                    ...resolved,
                    own: undefined,
                    current: { provider, model: (last?.provider ? last.model : spec ? modelOf(spec.args) : undefined) ?? "auto", providerFrom: "stage", modelFrom: "stage" }
                };
        }

        // An evaluation's variant: nobody is asked, so it has no level to
        // pick, and its runtime and model are not picked here - see `setupLocked`.
        const unattended = this.host.unattended?.() === true;

        const locked = owner !== undefined || this.setupLocked();

        const post = async () => {

            const choice = { ...await aiChoiceMessage(this.host.store, this.host.ai) };

            // The workspace pick belongs to the spec panel. What this
            // picker shows as picked is the chat's own, or nothing.
            delete choice.pick;

            if (resolved.own)
                choice.pick = resolved.own;

            // The permission check: a level per runtime.
            if (!unattended)
                choice.levels = levelsOf(this.host.store, choice.providers);

            choice.savedAnswers = this.savedAnswers().length;

            this.post({ type: "aiChoice", choice, current: resolved.current, ...(locked ? { locked: true } : {}) });
        };

        // The fetch starts before the first post, so that post already
        // names the runtime as loading. Sent again once it ends, with a
        // list or without, so the loading state never stays on.
        const fetching = modelsOf(resolved.current.provider, this.host.ai);

        await post();

        void fetching.then(() => this.surface ? post() : undefined);

        void this.postToolset(resolved.current.provider);
        void this.postCommands(resolved.current.provider);
    }

    /** The saved answers that hold for this chat. Empty with no folder. */
    private savedAnswers(): SavedAnswer[] {

        const folder = this.workspace;

        return folder ? this.host.permissions.saved(this.chatId, folder) : [];
    }

    /** The saved answers list, opened from the foot of the Permissions picker. */
    private postSavedAnswers(): void {

        const folder = this.workspace ?? "";

        const answers: SavedAnswerRow[] = this.savedAnswers()
            .map(answer => ({ ...answer, shown: answerShown(answer, folder || undefined) }));

        this.post({ type: "savedAnswers", answers, chat: this.title(), folder });
    }

    /** How many command lists were asked for - an older read never posts over a newer one. */
    private commandsAsked = 0;

    /**
     * The compose box's slash commands: the runtime's kept list, read from
     * its file - never fetched, so nothing waits. See `commandListFile.ts`.
     */
    private async postCommands(runtime: string): Promise<void> {

        const asked = ++this.commandsAsked;

        const commands = await readCommandList(runtime);

        if (asked === this.commandsAsked)
            this.post({ type: "commands", commands });
    }

    /** This chat's pick, shape-checked: saved values outlive builds. */
    private toolsetOf(chatId: string): ChatToolset {

        const stored = this.host.store.get<unknown>(TOOLSET_PREFIX + chatId);

        return stored && typeof stored === "object" ? stored as ChatToolset : {};
    }

    /**
     * Puts the chat's tools pick and standing instructions on a typed
     * turn's args. `tools`: the pickers' state as sent, which becomes the
     * chat's pick first - see `chatToolset.ts`. Returns the pick's key,
     * which tells a turn whether the tools changed since the conversation
     * opened.
     */
    private async applyToolset(ai: { args: Record<string, unknown> }, provider: string, tools: SentToolSelection | undefined): Promise<string> {

        if (tools)
            await this.host.store.update(
                TOOLSET_PREFIX + this.chatId, toolsetFrom(this.toolsetOf(this.chatId), provider, tools));

        const toolset = this.toolsetOf(this.chatId);

        // Sent back, so a compose box drawn again (after a question card,
        // say) shows the pick just made rather than the one before it.
        if (tools)
            void this.postToolset(provider);

        ai.args = withToolset(ai.args, provider, toolset);

        // The standing instructions, after any the settings
        // give. Only read when a session starts.
        const standing = this.host.systemInstructions(provider);

        if (standing) {

            const given = typeof ai.args.systemInstructions === "string" ? ai.args.systemInstructions : undefined;

            ai.args = { ...ai.args, systemInstructions: given && !given.startsWith("file://") ? `${given}\n\n${standing}` : standing };
        }

        return toolsetKey(provider, toolset);
    }

    /**
     * The Tools and MCP servers pickers: what is on offer for the runtime
     * this chat is on, and what it picked. The servers are settings.json's
     * own, less the ones switched off there.
     */
    private async postToolset(runtime: string): Promise<void> {

        let servers: { id: string }[] = [];

        try {

            servers = Object.entries((await loadEngineSettings(this.settingsFolder)).ai.mcpServers)
                .filter(([, declared]) => !(declared.server as { disabled?: unknown } | undefined)?.disabled)
                .map(([id]) => ({ id }));

        } catch (error) {

            logger.warning(`Chat: no MCP servers for the picker. ${(error as Error).message}`);
        }

        const tools = (await toolsOf(runtime, this.host.ai)) ?? [];

        this.post({ type: "toolset", choice: toolsetChoice(this.toolsetOf(this.chatId), runtime, tools, servers) });
    }

    /**
     * One message from the compose box.
     *
     * Into the turn in flight when there is one. Otherwise a new turn on
     * this chat's conversation, carried on the way a phase's is (see
     * `SddSpecPanel.continueSession`): always on the runtime it started
     * on - only the Handover button moves it - where the same model
     * carries on and a new model reopens the conversation on it.
     *
     * `fresh` is a Handover's first message (see {@link handover}): sent
     * as it is into a new session on the chat's pick, which the Handover
     * has just set. No files, and nothing carried on.
     */
    /**
     * A message from the compose box: {@link send}, then `unsent` to the
     * view when no prompt line was posted while it ran. The view drew
     * the typed text as "Sending…" the moment it was sent; without this
     * a message that never went (no folder, still starting, a failed
     * send, a runtime that would not start) would say "Sending…" for
     * good. Every way it fails ends the same way: no prompt line.
     */
    private async sendAndSettle(text: string, files: SentFile[] | undefined, tools?: SentToolSelection): Promise<void> {

        const before = this.promptsPosted;

        try {

            await this.send(text, files, tools);

        } finally {

            if (this.promptsPosted === before)
                this.post({ type: "unsent", text });
            else
                this.host.typedIn?.();
        }
    }

    private async send(
        text: string,
        files: SentFile[] | undefined,
        tools?: SentToolSelection,
        fresh = false
    ): Promise<void> {

        const workspace = this.workspace;

        if (!workspace)
            return this.note("Open a folder first - the session works in the workspace.");

        const sent = await resolveSentFiles([...files ?? []], workspace, path.join(this.host.scratchFolder(workspace), "attachments"), true);

        // ">" paths (connectors): one line each goes to the
        // agent under the message. The thread shows the message as typed.
        const withPaths = await this.withPathLines(text);

        // A folder added to the context goes the same way: its path, as a
        // line under the message. It is not a folder of the session.
        const folderLines = sent.folders.map(folder => `Folder in context: ${folder}`);
        const prompt = folderLines.length ? `${withPaths.prompt}\n\n${folderLines.join("\n")}` : withPaths.prompt;
        const sentWith = folderLines.length ? [...(withPaths.sentWith ?? []), ...folderLines] : withPaths.sentWith;

        if (sent.note)
            this.post({ type: "log", text: `${sent.note}\n`, stream: "system" });

        const last = lastSession(this.events.read(), OWNER);

        if (this.busy) {

            const session = last ? this.host.sessions().get(last.sessionId) : undefined;

            // The first turn, before its conversation has an id.
            if (!session)
                return this.note("Still starting - send it again in a moment.");

            // `@name` pulls in a `manual` steering file for this message.
            const typed = withSentFiles(await typedMessageIn(prompt, this.host.folders(), this.settingsFolder), sent.attachments);

            try {

                await session.send(typed.message);

            } catch (error) {

                return this.note(`Could not send the message: ${(error as Error).message}`);
            }

            if (typed.note)
                this.post({ type: "log", text: `${typed.note}\n`, stream: "system" });

            return this.post({
                type: "log", text: `${text}\n`, stream: "stdout",
                meta: {
                    kind: "prompt",
                    ...(typed.attachments.length ? { attachments: typed.attachments } : {}),
                    ...(sentWith ? { sentWith } : {})
                }
            });
        }

        // A phase chat: SDD says which AI it runs on and what the turn
        // carries, and may hold it back while another phase runs.
        const owner = this.host.owner?.();
        const refused = owner?.refuse();

        if (refused)
            return this.note(refused);

        this.busy = true;
        this.cancelRequested = false;
        this.post({ type: "busy", running: true });

        owner?.started(() => this.stop());

        // So the fallback write below does not repeat what `onSession` did.
        let recorded: string | undefined;

        // Why the turn failed, when it does - see `onOutput` below.
        let problem: string | undefined;

        // Each watched repository's working tree before the turn, so what
        // it changed can be listed, diffed and undone - see
        // `turnSnapshot.ts`.
        let before: { root: string; tree: string }[] = [];

        // How the turn ended, for the notice.
        let succeeded = false;

        // The runtime it ran on - its session may have sent a new
        // command list, read again at the end.
        let turnRuntime: string | undefined;

        // The earlier messages' file this message carries - see `goBack`.
        let carry: { path: string; lines: number } | undefined;

        try {

            before = await this.snapshotsBefore();

            // Never worth holding the message back for: without the copy,
            // "What changed" only compares against an older one.
            await owner?.keepBaseline().catch(error =>
                logger.warning(`Chat: the phase document was not put aside before the turn. ${(error as Error).message}`));

            // A phase chat runs on the spec's AI, on the runtime it is
            // held to: the one it started on, or the one a Handover just
            // picked. The pickers do not choose it.
            let { ai } = owner
                ? { ai: await owner.ai(fresh ? this.pickOf(this.chatId) : last?.provider ? { provider: last.provider } : undefined) }
                : await this.resolveAi();

            // A started chat stays on the runtime it started on, whatever
            // the settings' default says now - only the Handover button
            // moves it.
            if (!owner && !fresh && last?.provider && providerOf(ai.args) !== last.provider) {

                await this.host.store.update(
                    PICK_PREFIX + this.chatId, { provider: last.provider, ...(last.model ? { model: last.model } : {}) });

                ({ ai } = await this.resolveAi());

                void this.postAiChoice();

                // Held and still elsewhere: its runtime is no longer in
                // `ai.providers`. Never a silent move.
                if (providerOf(ai.args) !== last.provider)
                    throw new Error(`This session runs on ${last.provider}, which ai.providers no longer lists. Use Handover to move it to another runtime, or start a new session.`);
            }

            const provider = providerOf(ai.args);

            // The host may hold the turn back until the person has chosen
            // something - see `ChatHost.beforeTurn`.
            const held = await this.host.beforeTurn?.(provider);

            if (held)
                throw new Error(held);

            turnRuntime = provider;
            const model = modelOf(ai.args);

            // The tools and standing instructions are the chat's own. A
            // phase chat runs as SDD runs the phase: the spec's AI as it
            // is, with neither.
            const key = owner ? undefined : await this.applyToolset(ai, provider, tools);
            const applied = this.host.store.get<string>(APPLIED_PREFIX + this.chatId);

            // A Handover start has already let the old session go, and
            // carries nothing on: neither of these applies to it.
            const modelChanged = !fresh && last !== undefined && last.model !== undefined && (model ?? "auto") !== last.model;

            // Tools and servers are fixed when a session starts, so a new
            // pick reopens the conversation the way a new model does.
            const toolsChanged = key !== undefined && !fresh && last !== undefined && !modelChanged && applied !== undefined && applied !== key;

            if (last && (modelChanged || toolsChanged)) {

                // Nothing will talk to the held session again: it is
                // reopened on the new model or tools - `ai@1` carries a
                // held session on as it is.
                if (this.host.sessions().get(last.sessionId))
                    try {

                        await this.host.sessions().end(last.sessionId);

                    } catch (error) {

                        logger.warning(`Chat: could not stop session ${last.sessionId}. ${(error as Error).message}`);
                    }

                this.post({
                    type: "log", stream: "system",
                    text: modelChanged
                        ? `Model changed from ${last.model} to ${model ?? "auto"} - reopening the conversation.\n`
                        : "Tools or MCP servers changed - reopening the conversation with them.\n"
                });
            }

            // After going back on a runtime that could not cut its
            // conversation: this message starts a new one, so what was
            // said before goes with it as a file. The thread shows only
            // what was typed.
            carry = !fresh && !last ? this.carryOf(this.chatId) : undefined;

            const outcome = await runCall(
                {
                    session: OWNER,
                    prompt: carry
                        ? goBackPrompt(currentEvents(this.events.read()), OWNER, { path: shownPath(workspace, carry.path), lines: carry.lines }, prompt)
                        : prompt,
                    ...(carry || prompt !== text ? { shown: text } : {}),
                    attachments: [],
                    ...(sent.attachments.length ? { sentFiles: sent.attachments } : {}),

                    // Only sent on a non-verbatim call, which this never
                    // is: a chat is named by its first message.
                    title: "chat",

                    ai,
                    keep: true,

                    // An evaluation's variant runs with nobody to answer it.
                    interactive: this.host.unattended?.() !== true,

                    // As typed. A Handover start is sent as written too.
                    verbatim: true,
                    ...(last && !fresh ? { continueSession: last.sessionId } : {}),

                    // A phase chat's: the files it may not write, the plan it ticks.
                    ...(owner ? await owner.extras() : {})
                },
                this.sessionHost(workspace, provider, model, {
                    recorded: id => { recorded = id; },
                    problem: line => { problem = line; },
                    sentWith
                }),
                this.plugins(owner));

            if (outcome.sessionId && outcome.sessionId !== recorded)
                this.events.session(OWNER, outcome.sessionId, provider, model);

            if ((outcome.sessionId || recorded) && key !== undefined)
                await this.host.store.update(APPLIED_PREFIX + this.chatId, key);

            // The new conversation has it now.
            if (carry && (outcome.sessionId || recorded))
                await this.host.store.update(CARRY_PREFIX + this.chatId, undefined);

            succeeded = outcome.success;

            if (!outcome.success && !this.cancelRequested)
                this.fail(outcome.timedOut
                    ? "The turn hit its time limit and was stopped."
                    : problem
                        ? `The message did not go through. ${problem.replace(/^The agent could not finish:\s*/, "")}`
                        : `The message did not go through, and the runtime gave no reason. ${this.host.logPlace} has the full log.`);

        } catch (error) {

            this.fail((error as Error).message);

        } finally {

            await this.endTurn(before, turnRuntime, succeeded);

            // The spec reads the phase's document again. After the turn
            // is over, so a phase started from it finds the chat free.
            if (owner)
                await owner.ended(succeeded).catch(error =>
                    logger.warning(`Chat: the spec could not finish the turn's end. ${(error as Error).message}`));
        }
    }

    /**
     * A turn SDD hands this chat: the first message of a phase, a Revise,
     * or a wave of Implementation. It runs like a typed turn - written
     * down, drawn, the files it changed listed, the host told when it
     * ends - only the call is SDD's: the phase's prompt with its title,
     * its documents, the document it must write and the files it may
     * not. `check` says why the turn failed when the plugin said it went
     * well but the phase did not (see `RunPhaseInput.via`); it is said in
     * the thread. The owner's `started` and `ended` are not called: SDD
     * waits for this itself.
     *
     * Refused, with nothing done, while another turn runs - see `working`.
     */
    async runOwned(call: SessionCall, check: (result: CallResult) => string | undefined = () => undefined): Promise<CallResult> {

        const workspace = this.workspace;

        if (!workspace || this.busy)
            return { success: false };

        this.busy = true;
        this.cancelRequested = false;
        this.post({ type: "busy", running: true });

        const provider = providerOf(call.ai.args);
        const model = modelOf(call.ai.args);

        let recorded: string | undefined;
        let problem: string | undefined;
        let before: { root: string; tree: string }[] = [];
        let result: CallResult = { success: false };
        let succeeded = false;

        try {

            before = await this.snapshotsBefore();

            // Held after the turn, as every turn of a chat is, and waited
            // for: the chat's own end is the turn's end.
            result = await runCall(
                { ...call, session: OWNER, keep: true, detach: undefined },
                this.sessionHost(workspace, provider, model, {
                    recorded: id => { recorded = id; },
                    problem: line => { problem = line; }
                }),
                this.plugins(this.host.owner?.()));

            if (result.sessionId && result.sessionId !== recorded)
                this.events.session(OWNER, result.sessionId, provider, model);

            const missing = check(result);

            succeeded = result.success && !missing;

            if (!succeeded && !this.cancelRequested)
                this.fail(missing ?? (result.timedOut
                    ? "The turn hit its time limit and was stopped."
                    : problem
                        ? `The phase did not complete. ${problem.replace(/^The agent could not finish:\s*/, "")}`
                        : `The phase did not complete, and the runtime gave no reason. ${this.host.logPlace} has the full log.`));

        } catch (error) {

            this.fail((error as Error).message);

            result = { success: false };

        } finally {

            await this.endTurn(before, provider, succeeded);
        }

        return result;
    }

    /**
     * Where a turn runs and who hears from it: this chat's ids, its file
     * and its view. `recorded` hears the session id the moment the plugin
     * opens it; `problem` hears the last error line - the plugin host
     * writes the plugin's own reason last. `sentWith`: the ">" path lines
     * that go under the message - see `withPathLines`.
     */
    private sessionHost(
        workspace: string,
        provider: string,
        model: string | undefined,
        hear: { recorded(id: string): void; problem(line: string): void; sentWith?: string[] }
    ): SessionHost {

        return {
            specId: `chat:${this.chatId}`,
            workspace,
            runId: `chat:${this.chatId}`,
            processEnv: EnvService.machine(),
            onOutput: (line, stream, meta) => {

                // The thread draws no log lines, so the reason goes into
                // the failure it shows.
                if (stream === "stderr" && !meta?.kind && line.trim())
                    hear.problem(line.trim());

                this.post({ type: "log", text: line, stream, meta: hear.sentWith && meta?.kind === "prompt" ? { ...meta, sentWith: hear.sentWith } : meta });
            },
            onSession: id => {

                hear.recorded(id);
                this.events.session(OWNER, id, provider, model);
            },
            registerKill: kill => { this.stops.add(kill); },
            isCancelled: () => this.cancelRequested
        };
    }

    /** The plugins a turn runs with: a phase chat's are the spec's. */
    private plugins(owner: PhaseOwner | undefined): PluginHost {

        return owner ? owner.plugins() : this.host.plugins();
    }

    /**
     * The end of every turn, however it went: the files it changed, busy
     * off, the host told. `runtime`: the one it ran on, whose session may
     * have sent a new command list.
     */
    private async endTurn(before: readonly { root: string; tree: string }[], runtime: string | undefined, succeeded: boolean): Promise<void> {

        // An evaluation's variant: a turn that did not end by itself is
        // written down, so the Evaluator's report does not compare it with
        // the finished ones. Not drawn in the thread.
        if (this.host.unattended?.() === true && (this.cancelRequested || !succeeded))
            this.post({
                type: "log", stream: "system",
                text: this.cancelRequested ? "Stopped.\n" : "The turn failed.\n",
                meta: { kind: this.cancelRequested ? TURN_STOPPED : TURN_FAILED }
            });

        // Whatever the turn's outcome: a turn stopped halfway can
        // still have written half the files.
        if (before.length)
            await this.postChanges(before);

        this.busy = false;
        this.stops.clear();
        this.asking.clear();
        this.post({ type: "busy", running: false });

        // A runtime's first session sends its command list: the box
        // has it from this turn on, not only from the next chat.
        if (runtime)
            void this.postCommands(runtime);

        // Its tab closed while the turn ran: the session it opened
        // may only have been recorded after the close let go.
        if (this.closed)
            await this.letGo();
        else
            await this.host.changed(this);

        // After `changed`, so a name the runtime just gave the chat
        // is the one the notice shows. Not for a turn the person
        // stopped: they pressed Stop, and know.
        if (!this.cancelRequested)
            this.host.notify(this, { kind: "ended", outcome: succeeded ? "done" : "failed" });
    }

    /**
     * The Handover modal's Start: this chat moves to another runtime.
     *
     * The conversation so far is written to a Markdown file in the
     * working folder first - nothing is stopped if that fails. Then the
     * old session is let go, the chat's pick becomes the new runtime and
     * model, and a new session starts whose first message points at the
     * file. It reads it, says in one line where things stand, and waits.
     *
     * A chat with no session yet has nothing to carry: the pick changes
     * and nothing else happens.
     */
    private async handover(provider: string, model: string | undefined): Promise<void> {

        const workspace = this.workspace;

        if (!workspace)
            return this.note("Open a folder first - the session works in the workspace.");

        if (this.busy)
            return this.note("Still working - stop the agent first, then hand over.");

        if (!(await providerIds(this.host.ai)).includes(provider))
            return this.note(`${provider} is not listed in ai.providers, so the session cannot move to it.`);

        const pick = { provider, ...(model ? { model } : {}) };
        const last = lastSession(this.events.read(), OWNER);

        if (!last) {

            await this.host.store.update(PICK_PREFIX + this.chatId, pick);

            return this.postAiChoice();
        }

        if (last.provider === provider)
            return this.note(`This session is already on ${provider}.`);

        const events = currentEvents(this.events.read());
        const at = Date.now();

        const title = this.titles()[this.chatId]
            ?? listChats(this.host.historyKey()).find(chat => chat.id === this.chatId)?.title
            ?? "Chat";

        const transcript = handoverTranscript(events, OWNER, { title, from: last.provider, model: last.model, at });
        const file = path.join(this.host.scratchFolder(workspace), "handovers", `${this.chatId}-${stamp(at)}.md`);

        try {

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, transcript.text, "utf8");

        } catch (error) {

            return this.fail(`Handover stopped: could not save the conversation to ${file}. ${(error as Error).message}`);
        }

        if (this.host.sessions().get(last.sessionId))
            try {

                await this.host.sessions().end(last.sessionId);

            } catch (error) {

                logger.warning(`Chat: could not stop session ${last.sessionId}. ${(error as Error).message}`);
            }

        await this.host.store.update(PICK_PREFIX + this.chatId, pick);
        await this.postAiChoice();

        const from = `${last.provider ?? "unknown"}${last.model ? ` (${last.model})` : ""}`;
        const to = `${provider}${model ? ` (${model})` : ""}`;

        // The divider in the thread. `detail` carries the file, which the
        // view opens on a click.
        this.post({
            type: "log", stream: "system",
            text: `Handed over from ${from} to ${to}\n`,
            meta: { kind: "handover", detail: file }
        });

        // The path the agent is given is relative to the working folder:
        // every runtime reads inside it without asking.
        const relative = path.relative(workspace, file).split(path.sep).join("/");

        await this.send(
            handoverStartPrompt(events, OWNER, { path: relative, lines: transcript.lines, from: last.provider }),
            undefined, undefined, true);
    }

    /** The file a chat's next message carries, shape-checked: saved values outlive builds. */
    private carryOf(chatId: string): { path: string; lines: number } | undefined {

        const stored = this.host.store.get<unknown>(CARRY_PREFIX + chatId) as { path?: unknown; lines?: unknown } | undefined;

        return stored && typeof stored.path === "string" && typeof stored.lines === "number"
            ? { path: stored.path, lines: stored.lines }
            : undefined;
    }

    /**
     * The message the view named, found in this chat's file: the whole
     * file, where the message is in it, and its line. Nothing when the
     * view's thread and the file disagree - the view is then out of date.
     */
    private findPrompt(ref: PromptRef | undefined): { events: RunEvent[]; position: number; line: RunEvent } | undefined {

        // Checked, not trusted: it comes from the page.
        if (!ref || !Number.isInteger(ref.index) || ref.index < 0 || typeof ref.text !== "string")
            return undefined;

        const events = this.events.read();

        // Counted the way the view counts them: in the lines it was sent.
        const line = currentEvents(events).filter(event => event.kind === "prompt" && event.ownerId === OWNER)[ref.index];

        if (!line || folded(line.text ?? "") !== folded(ref.text))
            return undefined;

        const position = events.indexOf(line);

        return position < 0 ? undefined : { events, position, line };
    }

    /**
     * What happens to the runtime's conversation when the chat goes back
     * to the message at `position`.
     *
     * `real`: Claude's conversation is cut just before it, for free - only
     * on the two Claude runtimes, and only when the message went to the
     * conversation the chat is on now. Everything else starts a new
     * conversation (`fresh`); `reason` says why when a cut was expected.
     */
    private async cutPlan(events: readonly RunEvent[], position: number, workspace: string): Promise<
        | { how: "real"; sessionId: string; upTo: string; provider?: string; model?: string }
        | { how: "kiro"; sessionId: string; provider: string; model?: string; prompts: string[] }
        | { how: "fresh"; reason?: string }
    > {

        const last = lastSession(events, OWNER);

        if (!last)
            return { how: "fresh" };

        const kiro = !cutsClaude(last.provider) && last.provider !== undefined
            && isKiroV3(await loadEngineSettings(this.settingsFolder), last.provider);

        if (!cutsClaude(last.provider) && !kiro)
            return { how: "fresh" };

        // The conversation the message went to: the newest one recorded
        // before it. The record is written before the message's line.
        let sentTo: string | undefined;

        for (let index = position - 1; index >= 0 && sentTo === undefined; index--) {

            const event = events[index];

            if (event.ownerId !== OWNER)
                continue;

            if (event.kind === "cleared" || event.kind === "rewound")
                break;

            if (event.kind === "session" && event.sessionId)
                sentTo = event.sessionId;
        }

        if (sentTo !== last.sessionId)
            return { how: "fresh", reason: "That message went to an earlier conversation, before a handover or an earlier go back." };

        const prompts = events.slice(position)
            .filter(event => event.kind === "prompt" && event.ownerId === OWNER)
            .map(event => event.text ?? "");

        // Kiro's conversation is read and cut in one go, by `goBack`: it
        // takes starting Kiro, which the dialog should not wait for.
        if (kiro)
            return { how: "kiro", sessionId: last.sessionId, provider: last.provider!, ...(last.model ? { model: last.model } : {}), prompts };

        const cut = await claudeCutPoint(last.sessionId, workspace, prompts);

        if (cut.kind === "at")
            return { how: "real", sessionId: last.sessionId, upTo: cut.upTo, provider: last.provider, model: last.model };

        return cut.kind === "empty" ? { how: "fresh" } : { how: "fresh", reason: cut.reason };
    }

    /**
     * What changed in each watched repository since a message was sent:
     * from the snapshot taken before the first turn after it that changed
     * files there, to the files as they are now. Files the person changed
     * by hand since then are in it too - the dialog lists them all.
     */
    private async changesSince(events: readonly RunEvent[], position: number): Promise<TurnChanges[]> {

        const watched = await this.watchedRoots();

        const firstBefore = new Map<string, string>();

        for (const event of events.slice(position)) {

            if (event.kind !== "files.changed" || event.ownerId !== OWNER)
                continue;

            for (const changed of [event.changed, ...(event.changedMore ?? [])]) {

                const root = changed ? watched.find(one => one === path.resolve(changed.root)) : undefined;

                if (changed && root && !firstBefore.has(root))
                    firstBefore.set(root, changed.before);
            }
        }

        const found: TurnChanges[] = [];

        for (const [root, before] of firstBefore)
            try {

                const now = await snapshot(root);
                const files = await changedBetween(root, before, now);

                if (files.length)
                    found.push({ root, before, after: now, files });

            } catch (error) {

                logger.warning(`Chat: could not list the files changed in ${root} since that message. ${(error as Error).message}`);
            }

        return found;
    }

    /** The files `changesSince` listed, as one list for the dialog. */
    private static fileNames(changes: readonly TurnChanges[]): string[] {

        return changes.flatMap(one =>
            one.files.map(file => changes.length > 1 ? `${path.basename(one.root)}/${file.path}` : file.path));
    }

    /**
     * "Go back to here", or Send on an edited message: tells the view
     * what going back would do, for its dialog. Nothing is changed.
     */
    private async goBackCheck(ref: PromptRef, text?: string): Promise<void> {

        const workspace = this.workspace;

        if (!workspace)
            return this.note("Open a folder first - the session works in the workspace.");

        if (this.busy)
            return this.note("Still working - stop the agent first, then go back.");

        const found = this.findPrompt(ref);

        if (!found)
            return this.note("That message is not in this session any more. Reopen the session and try again.");

        const plan = await this.cutPlan(found.events, found.position, workspace);
        const files = ChatController.fileNames(await this.changesSince(found.events, found.position));

        const earlier = found.events.slice(0, found.position).some(event => event.kind === "prompt" && event.ownerId === OWNER);

        const about = plan.how === "real"
            ? "Claude's conversation is cut at the same point, so the agent forgets everything from that message on."
            : plan.how === "kiro"
                ? "Kiro's conversation is cut at the same point, so the agent forgets everything from that message on."
                + ` If the message is not found in Kiro's conversation, the next message starts a new one${earlier ? ", and what was said before goes with it as a file" : ""}.`
                : `The next message starts a new conversation${earlier ? ", and what was said before that message goes with it as a file" : ""}.`
                + (plan.reason ? ` ${plan.reason}` : "");

        this.post({ type: "goBackInfo", prompt: ref, ...(text !== undefined ? { text } : {}), files, about });
    }

    /**
     * Goes back to just before one of the person's messages.
     *
     * 1. The chat as it is is copied to a new chat, "<title> (before going
     *    back)", which keeps the whole conversation - and the runtime's
     *    conversation, untouched.
     * 2. This chat loses that message and everything after it.
     * 3. On Claude, its conversation is cut at the same point, into a new
     *    one this chat carries on from. Anywhere else, or when the cut
     *    cannot be made, the next message starts a new conversation and
     *    takes what was said before with it, as a file.
     * 4. With `restoreFiles`, the files are put back as they were when the
     *    message was sent. Only files in git repositories can be.
     * 5. The message goes back into the compose box - or, with `edited`,
     *    the edited text is sent with the message's files.
     */
    private async goBack(ref: PromptRef, restoreFiles: boolean, edited?: string): Promise<void> {

        const workspace = this.workspace;

        if (!workspace)
            return this.note("Open a folder first - the session works in the workspace.");

        if (this.busy)
            return this.note("Still working - stop the agent first, then go back.");

        const found = this.findPrompt(ref);

        if (!found)
            return this.note("That message is not in this session any more. Reopen the session and try again.");

        const { events, position, line } = found;

        let plan = await this.cutPlan(events, position, workspace);
        const changes = restoreFiles ? await this.changesSince(events, position) : [];

        // The copy first: nothing is cut until the chat as it was is safe.
        const title = this.title();
        const copyId = newChatId(Date.now());
        const copyTitle = `${title}${BEFORE_GOING_BACK}`;

        if (!this.writerFor(copyId).rewrite(events))
            return this.fail("Could not go back: the session could not be copied first. Nothing was changed.");

        for (const prefix of [PICK_PREFIX, TOOLSET_PREFIX, APPLIED_PREFIX, CARRY_PREFIX]) {

            const value = this.host.store.get<unknown>(prefix + this.chatId);

            if (value !== undefined)
                await this.host.store.update(prefix + copyId, value);
        }

        await this.host.store.update(TITLES_KEY, { ...this.titles(), [copyId]: copyTitle });

        this.host.copied(this.chatId, copyId);

        // Nothing talks to the old conversation from this chat again. It
        // is the copy's now.
        await this.letGo();

        let forked: string | undefined;

        // Who made the copy, for the thread's note.
        const cutBy = plan.how === "kiro" ? "Kiro" : "Claude";

        if (plan.how === "real") {

            const made = await forkClaudeConversation(plan.sessionId, workspace, plan.upTo, title);

            if ("sessionId" in made)
                forked = made.sessionId;
            else
                plan = { how: "fresh", reason: made.reason };

        } else if (plan.how === "kiro") {

            // After `letGo`: the chat's own Kiro has stopped, and this one
            // reads the session from disk.
            const made = await cutKiroConversation(plan.provider, plan.sessionId, workspace, plan.prompts, this.settingsFolder);

            if (made.kind === "forked")
                forked = made.sessionId;
            else
                plan = made.kind === "empty" ? { how: "fresh" } : { how: "fresh", reason: made.reason };
        }

        const kept = events.slice(0, position);
        const at = Date.now();

        const mark: RunEvent = forked && plan.how !== "fresh"
            ? {
                kind: "session", ownerId: OWNER, at, sessionId: forked,
                ...(plan.provider ? { provider: plan.provider } : {}),
                ...(plan.model ? { model: plan.model } : {})
            }
            : { kind: "rewound", ownerId: OWNER, at };

        if (!this.events.rewrite([...kept, mark]))
            return this.fail(`Could not go back: this session's file could not be written. It is unchanged, and '${copyTitle}' is a copy of it.`);

        // A new conversation with earlier messages: they go with the next
        // message, as a file - the same one a Handover writes.
        const said = forked ? undefined : await this.writeCarry(kept, title, workspace);

        if (said)
            await this.host.store.update(CARRY_PREFIX + this.chatId, said);
        else
            await this.host.store.update(CARRY_PREFIX + this.chatId, undefined);

        const restored = changes.length ? await this.putBack(changes) : undefined;

        // The thread as it is now.
        this.post({ type: "clearLog" });
        this.replay();

        const notes = [
            `Went back to before your message. The session as it was is kept as '${copyTitle}'.`,
            forked
                ? `${cutBy}'s conversation was cut at the same point.`
                : `The next message starts a new conversation${said ? ", and what was said before goes with it as a file" : ""}.`
                + (plan.how === "fresh" && plan.reason ? ` ${plan.reason}` : ""),
            restored
        ].filter((one): one is string => typeof one === "string" && one.length > 0);

        this.post({ type: "log", stream: "system", text: `${notes.join(" ")}\n`, meta: { kind: "notice" } });

        await this.host.changed(this);
        this.host.renamed();

        const files = (line.attachments ?? []).map(file => ({ path: file.path, ...(file.name ? { name: file.name } : {}) }));

        if (edited !== undefined)
            return this.send(edited, files.map(file => ({ kind: "path" as const, ...file })));

        this.post({ type: "refill", text: (line.text ?? "").replace(/\r/g, "").replace(/\n+$/, ""), files });
    }

    /**
     * Writes what was said before the message gone back to, for the next
     * message to carry - the Handover's own file format. Nothing when
     * nothing was said, or the file could not be written (the next
     * message then starts with no history, and the thread says so).
     */
    private async writeCarry(kept: readonly RunEvent[], title: string, workspace: string): Promise<{ path: string; lines: number } | undefined> {

        const shown = currentEvents(kept);

        if (!shown.some(event => event.kind === "prompt" && event.ownerId === OWNER))
            return undefined;

        const at = Date.now();
        const last = shown.reduce<RunEvent | undefined>((found, event) => event.kind === "session" && event.ownerId === OWNER ? event : found, undefined);

        const transcript = handoverTranscript(shown, OWNER, { title, from: last?.provider, model: last?.model, at });
        const file = path.join(this.host.scratchFolder(workspace), "handovers", `${this.chatId}-${stamp(at)}.md`);

        try {

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, transcript.text, "utf8");

        } catch (error) {

            this.fail(`Could not save the earlier messages to ${file}, so the next message starts with none of them. ${(error as Error).message}`);

            return undefined;
        }

        return { path: file, lines: transcript.lines };
    }

    /**
     * Puts files back as `changesSince` found them before: changed and
     * deleted files get their old content, added ones go to the trash.
     *
     * @returns one sentence for the thread on what was and was not done
     */
    private async putBack(changes: readonly TurnChanges[]): Promise<string> {

        const done: string[] = [];
        const failed: string[] = [];

        for (const changed of changes)
            for (const file of changed.files) {

                const name = changes.length > 1 ? `${path.basename(changed.root)}/${file.path}` : file.path;
                const absolute = await this.ownFile(changed, file.path);

                if (!absolute)
                    continue;

                try {

                    if (file.status === "added") {

                        if (fs.existsSync(absolute))
                            await this.host.trash(absolute);

                    } else {

                        const content = await contentAt(changed.root, changed.before, file.path);

                        if (content === undefined)
                            throw new Error("its earlier content could not be read");

                        fs.mkdirSync(path.dirname(absolute), { recursive: true });
                        fs.writeFileSync(absolute, content);
                    }

                    done.push(name);

                } catch (error) {

                    failed.push(`${name} (${(error as Error).message})`);
                }
            }

        return [
            done.length ? `Put back ${done.length === 1 ? "1 file" : `${done.length} files`}: ${done.join(", ")}.` : "",
            failed.length ? `Could not put back: ${failed.join(", ")}.` : ""
        ].filter(Boolean).join(" ");
    }

    /**
     * The git repositories a turn is watched in: each of the chat's
     * change folders'. Each once, however many folders sit in it.
     * Folders outside git are left out.
     */
    private async watchedRoots(): Promise<string[]> {

        const folders = this.host.changeFolders();

        const roots: string[] = [];

        for (const folder of folders) {

            const root = await repoRoot(folder);

            if (root && !roots.includes(root))
                roots.push(root);
        }

        return roots;
    }

    /** Each watched repository's working tree now. When git fails in one, that one is left out. */
    private async snapshotsBefore(): Promise<{ root: string; tree: string }[]> {

        const taken: { root: string; tree: string }[] = [];

        for (const root of await this.watchedRoots())
            try {

                taken.push({ root, tree: await snapshot(root) });

            } catch (error) {

                // Never worth holding the message back for.
                logger.warning(`Chat: no snapshot of ${root} before the turn, so the files it changed there will not be listed. ${(error as Error).message}`);
            }

        return taken;
    }

    /**
     * Lists what the turn changed, as one line the view draws as the
     * changed-files bar - the first repository with changes in
     * `changed`, any others in `changedMore`.
     */
    private async postChanges(before: readonly { root: string; tree: string }[]): Promise<void> {

        const found: TurnChanges[] = [];

        for (const { root, tree } of before)
            try {

                const after = await snapshot(root);
                const files = await changedBetween(root, tree, after);

                if (files.length)
                    found.push({ root, before: tree, after, files });

            } catch (error) {

                logger.warning(`Chat: could not list the files the turn changed in ${root}. ${(error as Error).message}`);
            }

        if (!found.length)
            return;

        const count = found.reduce((sum, one) => sum + one.files.length, 0);

        // With several repositories, each path says which one it is in.
        const paths = found.flatMap(one =>
            one.files.map(file => found.length > 1 ? `${path.basename(one.root)}/${file.path}` : file.path));

        this.post({
            type: "log",
            stream: "system",
            text: `Changed ${count === 1 ? "1 file" : `${count} files`}: ${paths.join(", ")}\n`,
            meta: { kind: "files.changed", changed: found[0], ...(found.length > 1 ? { changedMore: found.slice(1) } : {}) }
        });
    }

    /**
     * Checked, not trusted: the snapshot and path come back from the
     * page. The root must be one of the repositories this chat
     * watches, and the path must stay inside it.
     */
    private async ownFile(changed: { root: string }, file: string): Promise<string | undefined> {

        const root = (await this.watchedRoots()).find(one => one === path.resolve(changed.root));

        if (!root)
            return undefined;

        const absolute = path.resolve(root, file);

        return absolute.startsWith(root + path.sep) ? absolute : undefined;
    }

    /**
     * A file row of the context window was clicked - a steering file, a
     * CLAUDE.md. Such a file can be outside the chat's folders, so it is
     * shown only when the newest context window the runtime reported
     * lists it: the page could send any path.
     */
    private openContextFile(file: string): void {

        let context: ContextUsage | undefined;

        for (const event of currentEvents(this.events.read()))
            if (event.context)
                context = event.context;

        if (!context || !contextFiles(context).includes(file))
            return this.host.note("That file is not in the context window any more.");

        this.host.openFile(file, true);
    }

    /** The file before the turn on the left, as it is now on the right. */
    private async diffFile(changed: { root: string; before: string; after: string }, file: string): Promise<void> {

        const absolute = await this.ownFile(changed, file);

        if (!absolute)
            return;

        await this.host.showDiff(changed, file, absolute);
    }

    /** What one turn did to the file: before it against after it. */
    private async diffTurn(changed: { root: string; before: string; after: string }, file: string): Promise<void> {

        if (!await this.ownFile(changed, file))
            return;

        await this.host.showTurnDiff(changed, file);
    }

    /** Every file in `changes` at once, each checked like `diffFile`. */
    private async reviewFiles(changes: readonly TurnChanges[]): Promise<void> {

        const files: { changed: TurnChanges; file: string; absolute: string }[] = [];

        for (const changed of changes)
            for (const file of changed.files) {

                const absolute = await this.ownFile(changed, file.path);

                if (absolute)
                    files.push({ changed, file: file.path, absolute });
            }

        if (files.length)
            await this.host.showReview(files);
    }

    /**
     * Puts files back as they were before the turn: a changed or deleted
     * file gets its old content, an added one goes to the trash.
     *
     * A file that changed again since the turn ended is asked about
     * first - undoing it loses that later work too.
     */
    private async undoFiles(changed: TurnChanges, paths: readonly string[]): Promise<void> {

        const wanted = changed.files.filter(file => paths.includes(file.path));

        const plan: { file: TurnChanges["files"][number]; absolute: string }[] = [];

        for (const file of wanted) {

            const absolute = await this.ownFile(changed, file.path);

            if (absolute)
                plan.push({ file, absolute });
        }

        // Changed again after the turn: the file on disk is not what the
        // turn left.
        const since: string[] = [];

        for (const { file, absolute } of plan) {

            const left = await contentAt(changed.root, changed.after, file.path);
            const now = fs.existsSync(absolute) ? fs.readFileSync(absolute) : undefined;

            if ((left === undefined) !== (now === undefined) || (left && now && !left.equals(now)))
                since.push(file.path);
        }

        if (since.length
            && !await this.host.confirm(
                `${since.join(", ")} changed again after the turn. Undo anyway? The later changes are lost too.`,
                "Undo anyway"))
            return;

        const undone: TurnChanges["files"] = [];

        for (const { file, absolute } of plan)
            try {

                if (file.status === "added") {

                    if (fs.existsSync(absolute))
                        await this.host.trash(absolute);

                } else {

                    const content = await contentAt(changed.root, changed.before, file.path);

                    if (content === undefined)
                        throw new Error("its content before the turn could not be read");

                    fs.mkdirSync(path.dirname(absolute), { recursive: true });
                    fs.writeFileSync(absolute, content);
                }

                undone.push(file);

            } catch (error) {

                this.fail(`Could not undo ${file.path}: ${(error as Error).message}`);
            }

        if (undone.length)
            this.post({
                type: "log",
                stream: "system",
                text: `Undone: ${undone.map(file => file.path).join(", ")}\n`,
                meta: { kind: "files.undone", changed: { ...changed, files: undone } }
            });
    }

    /** The person's answer to a question the agent asked, handed to the session that asked it. */
    private async answer(askId: string, answer: string): Promise<void> {

        const last = lastSession(this.events.read(), OWNER);
        const session = last ? this.host.sessions().get(last.sessionId) : undefined;

        if (!session?.respond)
            return this.note("The agent is not waiting for an answer any more.");

        try {

            await session.respond(askId, answer);

        } catch (error) {

            return this.note(`Could not answer the agent: ${(error as Error).message}`);
        }

        this.post({ type: "log", text: `${answer}\n`, stream: "stdout", meta: { kind: "answer", askId } });
    }

    /** Stop: the cooperative flag first, then every registered stop. Public so the server can end the chat. */
    stop(): void {

        if (!this.busy)
            return;

        this.cancelRequested = true;

        for (const stop of [...this.stops])
            try {

                stop();

            } catch {

                // One stop throwing must not keep the others from firing.
            }
    }

    /**
     * A saved permission answer was added or removed - from a card in this
     * chat or another one, or from the list in another tab. Sends the
     * compose row's choices again, so "Saved answers (N)" shows the new
     * count.
     */
    async savedAnswersChanged(): Promise<void> {

        await this.postAiChoice();
    }

    /**
     * The folders this chat works in were changed (in the
     * folder list). A session keeps the folders it started with, so the
     * one this program holds is let go, and the next message reopens the
     * conversation with the new folders. Refused while a turn runs: false.
     */
    async foldersChanged(): Promise<boolean> {

        if (this.busy) {

            this.note("Still working - stop the agent first, then change the folders.");

            return false;
        }

        await this.letGo();

        // A notice, so the thread shows it - the person just changed them.
        this.post({
            type: "log", stream: "system", text: "Folders changed - the next message reopens the conversation with them.\n",
            meta: { kind: "notice" }
        });

        return true;
    }

    /**
     * New Session: a new chat with its own file. The old file stays on
     * disk, and the runtime keeps its transcript. The new chat starts on
     * the first runtime again - a pick belongs to the chat it was made in.
     *
     * Refused while a turn runs: that turn is the one being talked to.
     */
    async newChat(): Promise<void> {

        if (this.busy)
            return this.note("Still working - stop the agent first, then start a new session.");

        await this.switchTo(newChatId(Date.now()));
    }

    /**
     * The Compact button in the context meter: the open conversation
     * summarises itself and carries on from the summary. Only the session
     * this program still holds can - after a reload there is nothing open
     * to compact until the next message reopens it. The outcome goes into
     * the thread either way.
     */
    private async compact(): Promise<void> {

        if (this.busy)
            return this.note("A turn is still running. Compact once it has finished.");

        const last = lastSession(this.events.read(), OWNER);
        const session = last ? this.host.sessions().get(last.sessionId) : undefined;

        if (!session)
            return this.note("Nothing to compact: this conversation is not open in this window. Send a message first, then compact.");

        if (!session.compact)
            return this.note("This runtime cannot compact a conversation.");

        this.post({ type: "log", text: "Compacting the conversation...\n", stream: "system", meta: { kind: "notice" } });

        const result = await session.compact();

        this.post({
            type: "log",
            text: result.ok
                ? "Compacted - the conversation so far is now a summary. The context meter updates with your next message.\n"
                : `Not compacted. ${result.reason ?? ""}\n`,
            stream: "system",
            meta: { kind: "notice" }
        });
    }

    /** Said in a notice: nothing happened, and the thread is not the place for why. */
    private note(text: string): void {

        this.host.note(text);
    }

    /** Into the thread, where the person is looking, and the log. */
    private fail(text: string): void {

        logger.error(`Chat: ${text}`);

        this.post({ type: "log", text: `${text}\n`, stream: "stderr", meta: { kind: "error" } });
    }

    private post(message: ToChatView): void {

        if (message.type === "log" && message.meta?.kind === "prompt" && !this.replaying)
            this.promptsPosted++;

        // The one place a line reaches the view is the one place it is
        // written down - whether or not the view is open right now.
        if (message.type === "log" && !this.replaying)
            this.events.log({
                ownerId: OWNER,
                at: Date.now(),
                stream: message.stream ?? "stdout",
                text: message.text,
                ...message.meta
            });

        // The questions still open - see `waiting`. Never from lines drawn
        // again: those questions were closed long ago.
        if (message.type === "log" && message.meta?.askId && !this.replaying) {

            if (message.meta.kind === "ask")
                this.asking.set(message.meta.askId, (message.meta.prompt ?? message.text).trim());
            else if (message.meta.kind === "answer")
                this.asking.delete(message.meta.askId);
        }

        // Every question, the chat drawn or not - the host may tell the
        // person wherever they are looking.
        if (message.type === "log" && message.meta?.kind === "ask" && !this.replaying)
            this.host.notify(this, { kind: "asked", text: (message.meta.prompt ?? message.text).trim() });

        // Not drawn anywhere right now. A question still needs the
        // person - the agent is stopped until it is answered - so they
        // are told, and Open puts the chat back on screen.
        if (!this.surface) {

            if (message.type === "log" && message.meta?.kind === "ask" && !this.replaying)
                this.host.announceAsk(`chat '${this.title()}'`, message.meta.prompt ?? message.text, message.meta.permission,
                    () => this.host.show(this));

            return;
        }

        try {

            this.surface.post(message);

        } catch {

            // The page went away between the check and the post.
        }
    }
}

/**
 * A file's path as the agent is told it: relative to the working folder
 * when it is inside it - every runtime reads there without asking - and
 * full otherwise.
 */
function shownPath(workspace: string, file: string): string {

    const relative = path.relative(workspace, file);

    return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
        ? relative.split(path.sep).join("/")
        : file;
}

/** Spaces and line breaks folded to one space - the view's copy of a message and the file's may differ in those. */
function folded(text: string): string {

    return text.replace(/\s+/g, " ").trim();
}

/** Which runtime the resolved args name - `ai@1`'s own default when none. */
function providerOf(args: Record<string, unknown>): string {

    return typeof args.provider === "string" && args.provider.trim() ? args.provider.trim() : DEFAULT_PROVIDER;
}

/** The model the resolved args name, or nothing when it is left to the runtime. */
function modelOf(args: Record<string, unknown>): string | undefined {

    return typeof args.model === "string" && args.model.trim() ? args.model.trim() : undefined;
}

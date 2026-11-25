import * as path from "path";

import type { PhaseOwner } from "../../../chat/chatHost";
import { typedMessageIn } from "../../../chat/typedMessage";
import { AgentSessions } from "../../../core/agent";
import { PluginHost } from "../../../core/plugins/PluginHost";
import { PluginRegistry } from "../../../core/plugins/PluginRegistry";
import type { TaskSession } from "../../../shared/runMessages";
import type { ToPanel, ToSddView } from "../../../shared/sddMessages";
import { SddController } from "../SddController";
import type { SessionCall } from "../../phase/runPhase";
import type { CommandRun, PhaseChat, SddHost, SddStore } from "../sddHost";
import * as shared from "../taskSessions";

/*
 * A spec panel for tests, with no server behind it: the
 * controller, a host that writes down what it was asked to do, and a
 * page that keeps what it was sent. SddController.flows.test.ts drives
 * it the way a person's clicks would.
 *
 * It behaves like a real host for the same calls - one
 * terminal per folder, the error and info notices in their own lists,
 * a question with several answers counted as a warning and answered
 * with nothing.
 */

/** What the host was asked to do, in order. Emptied by `reset`. */
export const recorded = {
    info: [] as string[],
    errors: [] as string[],
    warnings: [] as string[],
    opened: [] as string[],
    sessionsOpened: [] as { sessionId: string }[],
    terminals: [] as { cwd: string; sent: string[]; shown: number }[],
    workflows: [] as { file: string; name: string; params: Record<string, unknown> }[],
    levelsSet: [] as { provider: string; level: string }[],
    resumeChanged: [] as string[],
    forgotten: [] as { specPath: string; stageId: string }[]
};

/**
 * What a terminal answers when a command ends. Not set: it cannot report
 * an exit code. A test sets it to answer one - late, if it wants. Cleared
 * by `reset`.
 */
export const terminal = {
    exit: undefined as undefined | ((command: string, run?: CommandRun) => Promise<number | undefined>),

    /** The hooks a row's command button handed over, in order - a test plays the host with them. */
    sentRuns: [] as CommandRun[]
};

/** A folder watch the controller asked for. `fire` is a file in it changing. */
export interface TestWatch {
    folder: string;
    fire(): void;
    disposed: boolean;
}

/** Every folder watch made since `reset`, in order. */
export const watchers: TestWatch[] = [];

/** The conversations the app holds - one for every test. */
const sessions = new AgentSessions();

export function agentSessions(): AgentSessions {

    return sessions;
}

/** Saved values in memory, the two calls of `SddStore`. */
function memoryStore(): SddStore {

    const values = new Map<string, unknown>();

    return {
        get: <T>(key: string) => values.get(key) as T | undefined,
        update: async (key, value) => {

            if (value === undefined)
                values.delete(key);
            else
                values.set(key, value);
        }
    };
}

/** What one test's program keeps: the folder's saved values and the profile's. */
export interface TestContext {
    readonly store: SddStore;
    readonly profileStore: SddStore;
}

export function context(): TestContext {

    return { store: memoryStore(), profileStore: memoryStore() };
}

export function taskSessions(ctx: TestContext, specName: string): TaskSession[] {

    return shared.taskSessions(ctx.store, specName);
}

export function rememberTaskSession(ctx: TestContext, specName: string, session: TaskSession): Promise<void> {

    return shared.rememberTaskSession(ctx.store, specName, session);
}

export function chatsWorking(ctx: TestContext, specName: string, taskIds: string[]): TaskSession[] {

    return shared.chatsWorking(ctx.store, specName, taskIds);
}

/** One page showing a spec: what it was sent, and a way to click. */
export class TestPanel {

    readonly posted: ToSddView[] = [];

    disposed = false;

    constructor(private readonly onMessage: (message: ToPanel) => void, private readonly onClose: () => void) { }

    /** A click in the page. One turn of the event loop is given to it. */
    async receive(message: unknown): Promise<void> {

        await (this.onMessage(message as ToPanel) as unknown);
    }

    /** Messages of one type, in order. */
    sent<T = unknown>(type: string): T[] {

        return this.posted.filter(message => message.type === type) as unknown as T[];
    }

    /** The page closed. */
    dispose(): void {

        if (this.disposed)
            return;

        this.disposed = true;
        this.onClose();
    }
}

/** Every page made since `reset`. */
export const panels: TestPanel[] = [];

/**
 * A phase chat in a test: it writes down the turns SDD handed it and
 * runs none - `runPhase` is replaced in the tests, so nothing reaches
 * here unless a test calls its `via`. A test sets `next` to answer one.
 */
export interface TestChat extends PhaseChat {
    phase: string;
    title: string;
    calls: SessionCall[];
    working: boolean;
    session?: { sessionId: string; provider?: string; model?: string };
    stopped: number;
}

/** The phase chats SDD made since `reset`, by id. */
export const phaseChats = new Map<string, TestChat>();

function testChat(chatId: string, phase: string, title: string): TestChat {

    const chat: TestChat = {
        chatId,
        phase,
        title,
        calls: [],
        working: false,
        stopped: 0,
        held: () => chat.session,
        runOwned: async call => {

            chat.calls.push(call);

            return { success: true };
        },
        stop: () => { chat.stopped++; }
    };

    return chat;
}

/** One spec's controller and the page showing it now, if any. */
interface Open {
    controller: SddController;
    panel?: TestPanel;
}

/** The specs held now, by name - one panel per spec. */
const open = new Map<string, Open>();

/** Empties everything above, for the next test. */
export function reset(): void {

    for (const list of Object.values(recorded))
        list.length = 0;

    watchers.length = 0;
    terminal.exit = undefined;
    terminal.sentRuns.length = 0;
    panels.length = 0;
    phaseChats.clear();
    open.clear();
}

/** SDD's side of a phase chat SDD made - what the server hands the chat. */
export function ownerOf(specName: string, chatId: string): PhaseOwner {

    const held = open.get(specName);
    const chat = phaseChats.get(chatId);

    if (!held || !chat)
        throw new Error(`No phase chat ${chatId} of ${specName} here.`);

    return held.controller.phaseOwner(chatId, chat.phase);
}

/**
 * A message typed into a phase chat SDD made, as the chat code runs it:
 * SDD is asked first, then told the turn started; `end` ends the turn.
 * Returns why SDD refused it instead, when it did.
 */
export function typedTurn(specName: string, chatId: string): string | { end(success?: boolean): Promise<void> } {

    const owner = ownerOf(specName, chatId);
    const chat = phaseChats.get(chatId)!;
    const refused = owner.refuse();

    if (refused)
        return refused;

    chat.working = true;
    owner.started(() => chat.stop());

    return {
        end: async (success = true) => {

            chat.working = false;
            await owner.ended(success);
        }
    };
}

/** The folder and resources a test's spec lives in. */
export interface TestPlace {
    workspace: string;
    resources: string;
}

function hostFor(ctx: TestContext, place: TestPlace, specName: string): SddHost {

    let plugins: PluginHost | undefined;

    const terminalIn = (cwd: string) => {

        let terminal = recorded.terminals.find(one => one.cwd === cwd);

        if (!terminal) {

            terminal = { cwd, sent: [], shown: 0 };
            recorded.terminals.push(terminal);
        }

        terminal.shown++;

        return terminal;
    };

    const inside = (folder: string, file: string) => {

        const relative = path.relative(folder, path.resolve(file));

        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };

    return {
        store: ctx.store,
        profileStore: ctx.profileStore,
        ai: { workspaceFolder: () => place.workspace, warn: text => { recorded.warnings.push(text); } },
        resources: place.resources,
        permissions: {
            levels: providers => Object.fromEntries(providers.map(provider => [provider, { level: "auto" as const, acp: false }])),
            setLevel: async (provider, level) => { recorded.levelsSet.push({ provider, level }); },
            saved: () => [],
            remove: () => false,
            forget: (specPath, stageId) => { recorded.forgotten.push({ specPath, stageId }); }
        },

        // Nothing here runs a real phase: `runPhase` is replaced in the
        // tests, so the plugins only have to be handed on.
        plugins: () => plugins ??= new PluginHost(new PluginRegistry()),
        sessions: agentSessions,

        pluginApps: () => ({ apps: [], sandboxed: false }),
        answerPluginRequest: async request => ({ id: request.id, ok: false, error: "No plugin pages in these tests." }),

        watch: (folder, onChange) => {

            const watch: TestWatch = { folder, fire: onChange, disposed: false };

            watchers.push(watch);

            return { dispose: () => { watch.disposed = true; } };
        },

        folderOf: file => inside(place.workspace, file) ? place.workspace : undefined,

        typedMessage: (text, roots) => typedMessageIn(text, [...roots, place.workspace], place.workspace),

        searchFiles: async () => [],

        openFile: file => { recorded.opened.push(file); },

        openSession: async sessionId => { recorded.sessionsOpened.push({ sessionId }); },

        newPhaseChat: async (phase, title) => {

            const chatId = `chat-${phaseChats.size + 1}`;

            phaseChats.set(chatId, testChat(chatId, phase, title));

            return chatId;
        },

        phaseChat: chatId => phaseChats.get(chatId),

        resumeChanged: chatId => { recorded.resumeChanged.push(chatId); },

        sendToTerminal: (cwd, command, run) => {

            terminalIn(cwd).sent.push(command);

            if (run)
                terminal.sentRuns.push(run);
        },

        // Unless a test says otherwise, a terminal that cannot report an exit code - the person ticks the box.
        runInTerminal: async (cwd, command, run) => {

            terminalIn(cwd).sent.push(command);

            return terminal.exit?.(command, run);
        },

        runWorkflow: async (file, name, params) => {

            recorded.workflows.push({ file, name, params });

            return undefined;
        },

        choose: async text => {

            recorded.warnings.push(text);

            return undefined;
        },

        showError: text => { recorded.errors.push(text); },
        showInfo: text => { recorded.info.push(text); },

        announceAsk: (where, prompt) => { recorded.info.push(`${where} is waiting: ${prompt ?? ""}`); },

        showSpec: async spec => { await openSpec(ctx, place, spec.name); },

        redrawAll: async () => {

            for (const one of open.values())
                if (one.panel)
                    await one.controller.refresh();
        },

        released: () => { open.delete(specName); }
    };
}

/**
 * Shows a spec on a page, as opening it from the specs list does: a
 * spec already shown is drawn again, one whose page closed while a
 * phase ran gets a new page, and any other gets its controller.
 */
export async function openSpec(ctx: TestContext, place: TestPlace, specName: string): Promise<TestPanel> {

    let entry = open.get(specName);

    if (!entry) {

        entry = { controller: new SddController(hostFor(ctx, place, specName), place.workspace, specName) };
        open.set(specName, entry);
    }

    if (!entry.panel || entry.panel.disposed) {

        const held = entry;

        const panel = new TestPanel(
            message => held.controller.receive(message),
            () => {

                if (held.panel === panel)
                    held.panel = undefined;

                held.controller.detach();
            });

        held.panel = panel;
        panels.push(panel);

        held.controller.attach({ post: message => { panel.posted.push(message); }, reveal: () => undefined });
    }

    await entry.controller.refresh();

    return entry.panel!;
}

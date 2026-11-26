import type { AgentSessions } from "../../core/agent";
import type { AskPermission } from "../../core/models/run";
import type { PluginHost } from "../../core/plugins/PluginHost";
import type { AiChoiceEnv } from "../../chat/aiChoice";
import type { PermissionLevel, SavedAnswer } from "../../core/models/permissionCard";
import type { FileMatch } from "../../shared/composeFiles";
import type { AgentAttachment, AgentMessage } from "../../core/agent";
import type { PluginAppMessage, PluginReplyMessage, PluginRequestMessage } from "../../shared/runMessages";
import type { ToSddView } from "../../shared/sddMessages";
import type { DiscoveredSpec } from "../discovery/discover";
import type { CallResult, SessionCall } from "../phase/runPhase";

/*
 * What one spec's panel needs from the app it runs in. The app
 * supplies one, so the spec logic itself - `SddController` - has
 * no server code in it.
 */

/**
 * Small saved values: two calls, read and write.
 */
export interface SddStore {

    get<T>(key: string): T | undefined;

    /** `undefined` removes the value. */
    update(key: string, value: unknown): PromiseLike<void>;
}

/** Where one spec is drawn: a browser page. */
export interface SddSurface {

    /** One message to the page. Never throws for a page that has gone. */
    post(message: ToSddView): void;

    /** Brought to the front - the agent asked a question and waits for the person. */
    reveal(): void;
}

/**
 * What the controller wants to hear about a plan command it started,
 * when the command runs with no terminal on screen.
 */
export interface CommandRun {

    /** A piece of what the command printed, as it prints it. */
    output?(text: string): void;

    /** How to stop the command - called once, right after it starts. */
    onStop?(stop: () => void): void;

    /** The command ended - by itself, by Stop, or because it could not start. */
    ended?(): void;
}

/** Something that can be let go of - a folder watch, a listener. */
/**
 * A phase chat as SDD drives it: a normal session SDD made for one phase
 * (see `ChatSpecLink`). The chat writes the conversation down and draws
 * it; SDD hands it the phase's turns and waits for them.
 */
export interface PhaseChat {

    readonly chatId: string;

    /** A turn is running in it - one SDD handed it, or one the person typed. */
    readonly working: boolean;

    /** The conversation it holds now - the last one a runtime opened in it. Nothing before its first turn. */
    held(): { sessionId: string; provider?: string; model?: string } | undefined;

    /** Runs a turn SDD hands it and waits for its end - see `ChatController.runOwned`. */
    runOwned(call: SessionCall, check?: (result: CallResult) => string | undefined): Promise<CallResult>;

    /** Stops the turn in flight. */
    stop(): void;
}

export interface SddDisposable {

    dispose(): void;
}

/**
 * The permission levels and saved answers of the app. The same ones the
 * chats use: a level is kept per runtime, so a pick here is a pick there.
 */
export interface SddPermissions {

    /** The level and kind of each runtime in the list. */
    levels(providers: readonly string[]): Record<string, { level: PermissionLevel; acp: boolean }>;

    /** One runtime's level, from now on. */
    setLevel(provider: string, level: PermissionLevel): Promise<void>;

    /** The saved answers that hold in any chat of this spec, for its working folder. */
    saved(specPath: string, folder: string): SavedAnswer[];

    /** Removes one saved answer. False when it was already gone. */
    remove(id: string): boolean;

    /** A phase's chat was cleared or started again: its "this session" answers go. */
    forget(specPath: string, stageId: string): void;
}

export interface SddHost {

    /**
     * Saved values for the workspace: the runtime and model pick and the
     * implementation chats of every spec. They
     * live in the host's saved values store.
     */
    readonly store: SddStore;

    /** Saved values for every folder: the panel's column widths. */
    readonly profileStore: SddStore;

    /** What the runtime, model and permission pickers need. */
    readonly ai: AiChoiceEnv;

    /** The permission levels and saved answers. */
    readonly permissions: SddPermissions;

    /** The `resources` folder that holds the built-in styles. */
    readonly resources: string;

    /** The plugins a phase runs with - `ai@1` among them. */
    plugins(): PluginHost;

    /** The live agent conversations this app holds. */
    sessions(): AgentSessions;

    /**
     * The tabs of the plugins in `only`, each page made ready for the
     * surface it is drawn in, and whether plugins run in the sandbox.
     */
    pluginApps(only: ReadonlySet<string>): { apps: PluginAppMessage[]; sandboxed: boolean };

    /** Answers one request from a plugin's page. `run` starts a phase. Never throws. */
    answerPluginRequest(
        request: PluginRequestMessage,
        deps: { cwd: string; root: string; run(target: string | undefined, params?: Record<string, unknown>): Promise<void> }
    ): Promise<PluginReplyMessage>;

    /**
     * Calls `onChange` when a Markdown file under `folder` is created,
     * changed or deleted, at any depth.
     */
    watch(folder: string, onChange: () => void): SddDisposable;

    /**
     * The folder of the workspace that holds `file`, or nothing. A workspace
     * has one or more folders; this is the folder a plan's
     * paths are relative to.
     */
    folderOf(file: string): string | undefined;

    /**
     * A message a person typed, ready to send to an agent. `@name` pulls
     * in a steering file - looked for in `roots` and in the workspace's own
     * folders.
     */
    typedMessage(text: string, roots: readonly string[]): Promise<{ message: AgentMessage; attachments: AgentAttachment[]; note?: string }>;

    /** Files under `root` for the "@" search in the compose box. */
    searchFiles(root: string, query: string): Promise<FileMatch[]>;

    /** Opens a file for the person. */
    openFile(file: string): void;

    /** Opens an implementation chat where the person can talk to it. */
    openSession(sessionId: string): Promise<void>;

    /**
     * Makes a phase chat for `phase` of this spec - a stage id, or
     * `<stage id>@wave:<n>`: a new session in the spec's workspace, its
     * folder first, named `title` and listed with the other sessions.
     * Returns its id. Nothing runs in it yet.
     */
    newPhaseChat(phase: string, title: string): Promise<string>;

    /** A phase chat, opened with no tab when none shows it. Nothing when it is gone. */
    phaseChat(chatId: string): PhaseChat | undefined;

    /**
     * The plan stopped at this phase chat, or carries on from it: the
     * chat, when a tab shows it, asks again whether to show Resume. A chat
     * no tab shows asks when it is opened.
     */
    resumeChanged(chatId: string): void;

    /**
     * Types a command into a terminal standing in `cwd` and shows it.
     * Nothing waits for it - a plan row's own command button. `run` gets
     * what it prints, when there is no terminal to show it in.
     */
    sendToTerminal(cwd: string, command: string, run?: CommandRun): void;

    /**
     * Runs a command in a terminal standing in `cwd` and waits for it to
     * end. Answers its exit code, or nothing when the terminal cannot
     * report one - then the person ticks the box by hand. With no
     * terminal on screen, what it prints goes to `run.output` and how to
     * stop it is handed over with `run.onStop`, so SDD's Stop ends it.
     */
    runInTerminal(cwd: string, command: string, run?: CommandRun): Promise<number | undefined>;

    /**
     * Starts a workflow file the way a person starts it, with `params`
     * already answered and the rest asked. Answers whether it went
     * green, or nothing when it did not run at all - already running,
     * or its params were not answered.
     */
    runWorkflow(file: string, name: string, params: Record<string, unknown>): Promise<boolean | undefined>;

    /**
     * Asks a question that must be answered before going on. Answers the
     * choice picked, or nothing when the person backs out.
     */
    choose(text: string, detail: string, choices: string[]): Promise<string | undefined>;

    /** A short notice that something did not work. */
    showError(text: string): void;

    /** A short notice of what happened, or why nothing did. */
    showInfo(text: string): void;

    /**
     * Tells the person an agent is blocked on a question while no
     * surface shows this spec. `open` puts the spec back on screen.
     */
    announceAsk(where: string, prompt: string | undefined, permission: AskPermission | undefined, open: () => unknown): void;

    /** Puts a spec on screen, as opening it from the specs list does. */
    showSpec(spec: DiscoveredSpec): Promise<void>;

    /** This spec is done with: nothing runs and nothing shows it. */
    released(): void;
}

import * as fs from "fs";
import * as path from "path";

import { agentRuntime, type AgentSessions, coreProviders } from "../core/agent";
import { logger } from "../core/logging/logger";
import type { PluginDatabase } from "../core/plugins/PluginDatabase";
import { PluginHost } from "../core/plugins/PluginHost";
import { profileDebugFlag } from "../core/settings/engineSettings";
import { buildRegistry } from "../plugins";
import { answerPluginRequest, pluginApps } from "../plugins/app/PluginAppHost";
import type { ChatStore } from "../chat/chatStore";
import { levelGate, levelsOf, writeLevel } from "../chat/permissionLevels";
import { type AnswerBook, samePath } from "../core/agent/permissions";
import { typedMessageIn } from "../chat/typedMessage";
import type { DiscoveredSpec } from "../sdd/discovery/discover";
import { phaseChatKey, specChatPrefix } from "../sdd/phase/runPhase";
import type { CommandRun, PhaseChat, SddDisposable, SddHost, SddStore } from "../sdd/panel/sddHost";
import type { ChatSpecLink } from "../shared/chatMessages";
import { serverAiEnv } from "./ServerChatHost";
import { CommandRuns, findShells, type Shell } from "./commands";
import type { Connectors } from "./connectors/Connectors";
import { CONNECTORS_SERVER_NAME } from "./connectors/mcpBridge";
import { memoryEnv } from "./memory/claudeMemory";
import type { Memory } from "./memory/Memory";
import { isInside, searchFolders } from "./folders";
import type { PromptRequest } from "./protocol";
import { readServerSettings } from "./settings";

/*
 * What one spec's controller (src/sdd/panel/SddController.ts) gets from
 * Eesha Code - the browser's answers.
 *
 * Starting a workflow run from a spec is not available here. For that
 * the host gives the answer the interface already allows - "did not
 * run", "cannot tell" - and says so in a notice.
 */

/** What a spec's host needs from the server around it. */
export interface SddHostServer {

    readonly store: ChatStore;

    /** Shared with the chats, so a session is held once. */
    readonly sessions: AgentSessions;

    /** The answers saved from permission cards, shared with the chats. */
    readonly answers: AnswerBook;

    /** The sandbox worker user plugins run in - dist/pluginWorker.js. */
    readonly workerPath: string;

    /** The `resources` folder that holds the built-in styles. */
    readonly resources: string;

    readonly connectors: Connectors;

    /** The memories kept between sessions - a phase's session gets their tools. */
    readonly memory: Memory;

    /** dist/cli.js - started as `eesha mcp --chat <id>` for the connector and memory tools. */
    readonly cliPath: string;

    /**
     * The nonce the page's script policy allows. A plugin's page sits in
     * an iframe that takes the page's policy, so its scripts carry this.
     */
    readonly pluginNonce: string;

    /** The data plugins keep for one main folder (`eesha.db` on a plugin's page) - beside that folder's run database. */
    pluginDatabase(mainFolder: string): PluginDatabase | undefined;

    /**
     * Makes a phase chat: a new session in the place's folders, in the
     * place's workspace, with the spec link saved on it and named
     * `title`. Returns its id.
     */
    newPhaseChat(place: SddPlace, link: ChatSpecLink, title: string): Promise<string>;

    /** A phase chat, opened with no tab when none shows it. Nothing when it is gone. */
    phaseChat(chatId: string): PhaseChat | undefined;

    /** A stopped plan waits on this phase chat, or no longer does - see `SddHost.resumeChanged`. */
    resumeChanged(chatId: string): void;
}

/** What the host tells the spec's own place in the server. */
export interface SddHostEvents {

    /** A short notice for the person: to the tab showing the spec, or to every tab. */
    note(text: string): void;

    /** A question with one answer. Nothing when no tab shows the spec, or the person backs out. */
    ask(prompt: PromptRequest): Promise<string | undefined>;

    /** Shows a file as a tab in the page. */
    openFile(file: string): void;

    /** The agent asks something while no tab shows the spec. */
    asked(where: string): void;

    /** Every spec on screen in this workspace is drawn again - the AI pick or the permission mode changed. */
    redrawAll(): Promise<void>;

    /** The spec is done with: nothing runs and nothing shows it. */
    released(): void;
}

/** One workspace's SDD place: its key and its folders. */
export interface SddPlace {

    /** The workspace's key - see `workspaceKey`. */
    key: string;

    /**
     * The workspace's main folder: the repository. The specs are kept
     * here (`.eesha/specs`, or what
     * `sdd.specsDir` says). The agent, git and a plan's commands run
     * here, and SDD's settings, styles and workflows are read from here.
     */
    mainFolder: string;

    /** The workspace's folders, the main one first. Every phase session may use them. */
    folders: readonly string[];
}

/**
 * Saved values under a prefix of the server's store, so SDD's keys never
 * meet the chats'. Each workspace gets its own prefix.
 */
export function prefixedStore(store: ChatStore, prefix: string): SddStore {

    return {
        get: <T>(key: string) => store.get<T>(prefix + key),
        update: (key, value) => store.update(prefix + key, value)
    };
}

/** The store key prefix of one workspace's SDD values. */
export function sddStorePrefix(workspaceKey: string): string {

    return `sdd@${workspaceKey}/`;
}

/** The store key prefix of SDD values for every workspace - the panel's column widths. */
export const SDD_PROFILE_PREFIX = "sdd@profile/";

/**
 * A watch over one folder's Markdown files, at any depth. Node's own
 * recursive watch; a burst of events is told once. A folder that cannot
 * be watched (not there yet) is watched by nothing - the spec is drawn
 * again on the next open.
 */
export function watchMarkdown(folder: string, onChange: () => void): SddDisposable {

    let timer: ReturnType<typeof setTimeout> | undefined;
    let watcher: fs.FSWatcher | undefined;

    try {

        watcher = fs.watch(folder, { recursive: true }, (_event, file) => {

            if (file && !String(file).toLowerCase().endsWith(".md"))
                return;

            clearTimeout(timer);
            timer = setTimeout(onChange, 100);
        });

        watcher.on("error", error => logger.warning(`Eesha Code: stopped watching ${folder}. ${error.message}`));

    } catch (error) {

        logger.warning(`Eesha Code: could not watch ${folder}. ${(error as Error).message}`);
    }

    return {
        dispose: () => {

            clearTimeout(timer);
            watcher?.close();
        }
    };
}

/**
 * The host for one spec. `specId` names the spec to the connector tools
 * (`eesha mcp --chat <specId>`). It is not a chat id: the server
 * finds the spec by it and asks a write in the tab showing the spec, or
 * refuses the write when no tab shows it.
 */
export function serverSddHost(
    server: SddHostServer,
    place: SddPlace,
    specId: string,
    events: SddHostEvents,
    spec?: { name: string; folder?: string }
): SddHost {

    let plugins: PluginHost | undefined;

    /** Whether user plugins, and their pages, run sandboxed - false only under the profile's `debug: true`. */
    let sandboxed = true;

    /** The workspace's folders. */
    const roots = (): string[] => [...place.folders];

    const cannot = (what: string) => events.note(`${what} is not available here - do it by hand.`);

    /** The plugins a phase runs with, read on first use. */
    const loadPlugins = (): PluginHost => {

        if (plugins)
            return plugins;

        // The bundled plugins, then each workspace folder's
        // `.eesha/plugins`, then the profile's - the same
        // places we read, so a style's `uses:` can name a
        // plugin of the repository. Every session goes through the same
        // permission check as a chat: the level picked for its runtime.
        const built = buildRegistry(
            server.workerPath,
            roots().map(folder => ({ path: folder, origin: "folder" as const })),
            agentRuntime(
                coreProviders({
                    workspaceFolder: () => undefined,
                    resources: () => server.resources,
                    directories: () => roots(),
                    toolsOff: provider => readServerSettings().runtimes[provider]?.toolsOff ?? [],
                    // Claude's own memory, off while ours is on - see claudeMemory.ts.
                    sessionEnv: provider => memoryEnv(provider, server.memory.choices()),
                    mcpServers: () => server.connectors.connected() || server.memory.on()
                        ? { [CONNECTORS_SERVER_NAME]: { command: process.execPath, args: [server.cliPath, "mcp", "--chat", specId] } }
                        : {},

                    // One check per session, filed under the chat the
                    // phase names. A session started with no chat has none.
                    permissions: (provider, workingDirectory, chat) => chat
                        ? levelGate({
                            store: server.store,
                            book: server.answers,
                            provider,
                            chatId: chat,
                            workingFolder: workingDirectory,
                            addFolder: () => events.note("A spec works in its workspace's folders - change them in the workspace.")
                        })
                        : undefined
                }),
                server.sessions),
            { workspaceFolder: () => undefined },
            {
                // `debug: true` in the profile's settings.json runs
                // user plugins in-process.
                sandboxed: !profileDebugFlag(),

                // A bundled plugin's page is a file under resources.
                builtinAppsRoot: path.join(server.resources, "plugins")
            });

        for (const failure of built.failures)
            logger.warning(`Eesha Code: plugin at ${failure.sourcePath} did not load: ${failure.message}`);

        sandboxed = built.sandboxed;
        plugins = new PluginHost(built.registry);

        return plugins;
    };

    return {
        store: prefixedStore(server.store, sddStorePrefix(place.key)),
        profileStore: prefixedStore(server.store, SDD_PROFILE_PREFIX),
        ai: serverAiEnv(text => events.note(text)),
        resources: server.resources,

        permissions: {
            levels: providers => levelsOf(server.store, providers),
            setLevel: (provider, level) => writeLevel(server.store, provider, level),
            saved: (specPath, folder) => server.answers.list().filter(answer =>
                answer.scope === "always"
                || (answer.scope === "folder" && answer.folder !== undefined && samePath(answer.folder, folder))
                || (answer.scope === "session" && answer.chatId?.startsWith(specChatPrefix(specPath)) === true)),
            remove: id => server.answers.remove(id),
            forget: (specPath, stageId) => server.answers.removeChat(phaseChatKey(specPath, stageId))
        },

        plugins: loadPlugins,

        sessions: () => server.sessions,

        // A plugin's own page, put together here, with
        // the page's nonce on every script. The spec page shows it in an
        // iframe with the same sandbox.
        pluginApps: only => {

            const host = loadPlugins();

            return { apps: pluginApps(host, server.pluginNonce, only), sandboxed };
        },

        answerPluginRequest: (request, deps) =>
            answerPluginRequest(request, loadPlugins(), server.pluginDatabase(place.mainFolder), deps),

        watch: watchMarkdown,

        // The workspace folder that holds the file. A spec under none
        // of them finds nothing, and the controller uses the main folder.
        folderOf: file => place.folders.find(folder => isInside(folder, path.resolve(file))),

        typedMessage: (text, extra) => typedMessageIn(text, [...extra, ...roots()], undefined),

        searchFiles: (_root, query) => searchFolders(roots(), query),

        // A relative path is the controller's, which is relative to the main folder.
        openFile: file => events.openFile(path.resolve(place.mainFolder, file)),

        // Only a chat from before waves ran in sessions: it has no session here to go to.
        openSession: async () => events.note("That chat is from before waves ran in sessions, so it has no session here to open."),

        // A phase chat is a normal session of the spec's workspace.
        newPhaseChat: (phase, title) => {

            if (!spec)
                throw new Error("This spec cannot make a session.");

            return server.newPhaseChat(place, { spec: spec.name, ...(spec.folder ? { folder: spec.folder } : {}), phase }, title);
        },
        phaseChat: chatId => server.phaseChat(chatId),

        resumeChanged: chatId => server.resumeChanged(chatId),

        // A plan row's command button: run in the plan shell, in the
        // spec's folder. Nothing waits for it; the row hears when it ends.
        sendToTerminal: (cwd, command, run) => void runAndTell(cwd, command, events.note, run).finally(() => run?.ended?.()),

        // A plan task that is a command: run, and its exit code ticks
        // the box or not. Nothing when it could not run or was stopped -
        // then the person ticks it by hand.
        runInTerminal: async (cwd, command, run) => {

            const end = await runAndTell(cwd, command, events.note, run);

            return end.code ?? undefined;
        },

        runWorkflow: async (_file, name) => {

            cannot(`Starting the workflow '${name}'`);

            return undefined;
        },

        // Every choice is its own button; backing out is no answer.
        choose: async (text, detail, choices) => {

            if (!choices.length)
                return undefined;

            const answer = await events.ask({ kind: "choose", text, ...(detail ? { detail } : {}), choices });

            return answer !== undefined && choices.includes(answer) ? answer : undefined;
        },

        showError: text => events.note(text),
        showInfo: text => events.note(text),

        announceAsk: where => events.asked(where),

        // Putting another spec on screen is the person's click: a page
        // load at its address. Nothing here can do it for them.
        showSpec: async (_spec: DiscoveredSpec) => undefined,

        redrawAll: () => events.redrawAll(),

        released: () => events.released()
    };
}

/** How many characters of a command's output are kept for the notice at its end. */
const OUTPUT_KEPT = 4_000;

/** How many of the last lines a failed command's notice shows. */
const LINES_SHOWN = 15;

/**
 * The shell a plan's command runs in. Plans are written by an AI, which
 * writes bash-like lines (`a && b`, `./script.sh`), so on Windows Git
 * Bash comes first, then PowerShell 7, then cmd. Never Windows
 * PowerShell 5.1: `a && b` is a syntax error there. Elsewhere, the first
 * shell found.
 */
export function planShell(shells: readonly Shell[] = findShells(), windows = process.platform === "win32"): Shell | undefined {

    if (!windows)
        return shells[0];

    return ["gitbash", "pwsh", "cmd"].map(id => shells.find(one => one.id === id)).find(Boolean);
}

/** Stops for the plan commands running now, so the server can end them when it closes. */
const running = new Set<() => void>();

/** Ends every plan command still running - the server is closing. */
export function stopPlanCommands(): void {

    for (const stop of [...running])
        stop();
}

/**
 * Runs a plan's command in `cwd` - what a person would type into a terminal.
 * Eesha Code has no terminal, so the person is told when it starts and how
 * it ended, with the last lines it printed when it failed; what it prints
 * also goes to `run.output` as it comes, and `run.onStop` gets how to end
 * it. Answers its exit code; `null` when it could not start or was
 * stopped.
 */
export function runAndTell(cwd: string, command: string, note: (text: string) => void, run: CommandRun = {}): Promise<{ code: number | null; output: string }> {

    const shell = planShell();

    if (!shell) {

        note(`No shell found on this machine, so this did not run - run it yourself in ${cwd}: ${command}`);

        return Promise.resolve({ code: null, output: "" });
    }

    note(`Running in ${cwd} (${shell.label}): ${command}`);

    return new Promise(resolve => {

        let output = "";
        let stop: (() => void) | undefined;

        const runs = new CommandRuns((_view, _id, part) => {

            if ("text" in part) {

                output = (output + part.text).slice(-OUTPUT_KEPT);
                run.output?.(part.text);

                return;
            }

            if (stop)
                running.delete(stop);

            const { code, problem, stopped } = part.done;

            const tail = output.trimEnd().split(/\r?\n/).slice(-LINES_SHOWN).join("\n");

            note(stopped
                ? `Stopped: ${command}`
                : problem
                    ? `Could not run ${command}: ${problem}`
                    : code === 0
                        ? `Done: ${command}`
                        : `${command} ended with exit code ${code}.${tail ? `\n${tail}` : ""}`);

            resolve({ code: problem || stopped ? null : code, output });
        });

        const id = runs.start("sdd", shell, command, cwd);

        stop = () => runs.stop("sdd", id);
        running.add(stop);
        run.onStop?.(stop);
    });
}

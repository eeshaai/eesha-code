import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { agentRuntime, AgentSessions, coreProviders } from "../core/agent";
import { AnswerBook, samePath } from "../core/agent/permissions";
import { EnvService } from "../core/env/envService";
import { logger } from "../core/logging/logger";
import type { AskPermission, TurnChanges } from "../core/models/run";
import { PluginHost } from "../core/plugins/PluginHost";
import { buildRegistry } from "../plugins";
import type { AiChoiceEnv } from "../chat/aiChoice";
import type { ChatController } from "../chat/ChatController";
import type { ChatHost, ChatNotice, ChatPermissions, PhaseOwner } from "../chat/chatHost";
import type { ChatStore } from "../chat/chatStore";
import { levelGate } from "../chat/permissionLevels";
import { contentAt } from "../chat/turnSnapshot";
import type { ChatSpecLink } from "../shared/chatMessages";
import type { FileMatch, PathMatch } from "../shared/composeFiles";
import { type Connectors, pathsIn } from "./connectors/Connectors";
import { CONNECTORS_SERVER_NAME } from "./connectors/mcpBridge";
import { foundOnly } from "./doctor";
import { CLAUDE_MEMORY_ACTION, CLAUDE_MEMORY_HELD, CLAUDE_MEMORY_QUESTION, claudeWaits, memoryEnv } from "./memory/claudeMemory";
import { saveMemoryChoices } from "./memory/config";
import { type Memory, MEMORY_PATH, type SessionPlace } from "./memory/Memory";
import { standingInstructions } from "./instructions";
import { readServerSettings } from "./settings";
import { isInside, searchFolders } from "./folders";
import { eeshaPath } from "./paths";
import { type DiffFrom, KEEP_FOLDER, type PromptRequest, type ReviewFile, type ToPage, type WorkspaceLink, workspaceKey } from "./protocol";
import { readSession, rememberFolders, SavedSession, writeSession } from "./sessions";
import { sessionWorkspace } from "./workspaces";
import { moveToTrash } from "./storage";

/**
 * How Eesha Code answers the runtime and model pickers: settings from the
 * profile only, and with no `ai.providers` list, only the runtimes whose
 * program is on this machine - the ones the settings page shows ticked.
 * `note`: a warning for the person, beside the log line.
 */
export function serverAiEnv(note: (text: string) => void): AiChoiceEnv {

    return {

        // Settings are the profile's only: ~/.eesha/settings.json.
        workspaceFolder: () => undefined,

        warn: (text, file) => {

            logger.warning(`Eesha Code: ${text}${file ? ` (${file})` : ""}`);
            note(file ? `${text} (${file})` : text);
        },

        unlisted: (all, settings) => foundOnly(all, settings.ai.acpAgents, EnvService.machine())
    };
}

/** What one chat's host needs from the server around it. */
export interface HostServer {

    readonly store: ChatStore;

    /** Shared by every chat, so a session is held once however many tabs come and go. */
    readonly sessions: AgentSessions;

    /** The answers saved from permission cards, shared by every chat. */
    readonly answers: AnswerBook;

    /** The sandbox worker user plugins run in - dist/pluginWorker.js. */
    readonly workerPath: string;

    /** Where the log is - said when a turn fails with no reason. */
    readonly logPlace: string;

    /** ADO and GitHub - the `>` picker, the reference lines and the AI's tools. */
    readonly connectors: Connectors;

    /** The memories kept between sessions - the `>memory` rows, the lines a session is told and the AI's tools. */
    readonly memory: Memory;

    /** dist/cli.js - started as `eesha mcp --chat <id>` by a runtime for the connector and memory tools. */
    readonly cliPath: string;

    /** One message to the tab showing this chat. Dropped when no tab does. */
    toPage(chat: ChatController, message: ToPage): void;

    /** Asks the tab showing this chat. Nothing when no tab does, or the person backs out. */
    ask(chat: ChatController, prompt: PromptRequest): Promise<string | undefined>;

    /** Every tab, for a chat with no tab of its own that needs the person. */
    toAll(message: ToPage): void;

    /** The other chat with this id, if one is open. */
    holder(chatId: string, asking: ChatController): ChatController | undefined;

    /** A chat was renamed or switched: titles and folders are sent again. */
    chatChanged(chat: ChatController): void;

    /** A chat was renamed - every tab's title is sent again. `chatId`: renamed by the person, so Kiro's copy is renamed too. */
    renamed(chatId?: string): void;

    /** A chat was deleted: its folder list and empty scratch folder go. */
    chatDeleted(chatId: string): void;

    /** Keeps a folder in the session list with no session in it, as a workspace of its own. */
    keepFolder(folder: string): Promise<void>;

    /** A turn ended or the agent asked something: the page shows a notice. */
    notify(chat: ChatController, notice: ChatNotice): void;

    /** SDD's side of a phase chat - see `PhaseOwner`. Nothing when its spec's workspace is gone. */
    phaseOwner(chatId: string, workspace: string, link: ChatSpecLink): PhaseOwner | undefined;
}

/** The largest file the page shows - from a thread link or the files pane. */
const MAX_SHOWN_BYTES = 2 * 1024 * 1024;

/**
 * What one chat in Eesha Code gets from the program around it - the
 * browser's answers (see `ChatHost`).
 *
 * Pop-ups and the diff are drawn by the page. Settings come only
 * from ~/.eesha/settings.json - never from a repository.
 *
 * A chat with no folder works in its scratch folder,
 * ~/.eesha/scratch/<chat id>. One that got its conversation there
 * stays there: folders added later are extras the agent may also use.
 */
export class ServerChatHost implements ChatHost {

    readonly store: ChatStore;

    readonly ai: AiChoiceEnv;

    readonly logPlace: string;

    private chat?: ChatController;

    /** The folders picked, in order - never the scratch folder. Saved in sessions/<chat id>.json. */
    private folderList: string[];

    /** Works in scratch for good - see `SavedSession.scratch`. */
    private pinned: boolean;

    /** Uses another chat's scratch folder - see `SavedSession.scratchOf`. */
    private scratchOf?: string;

    /** May also use the system temp folder - see `SavedSession.tempFolder`. */
    private tempFolder: boolean;

    /** The key of the workspace the session was started in - see `SavedSession.workspace`. */
    private workspaceId?: string;

    /** Set on a phase chat - see `SavedSession.spec`. */
    private specLink?: ChatSpecLink;

    /** A phase chat somebody typed into - see `SavedSession.typed`. */
    private typed: boolean;

    private pluginHost?: PluginHost;

    /**
     * A permission card added a folder while a turn ran. The runtime gets
     * it when the turn ends: the conversation is reopened then, never
     * halfway through a turn.
     */
    private reopenAfterTurn = false;

    /** Our own permission check. Answers are the server's, shared by every chat. */
    readonly permissions: ChatPermissions;

    constructor(private readonly server: HostServer, saved: SavedSession) {

        this.store = server.store;
        this.logPlace = server.logPlace;

        this.permissions = {
            saved: (chatId, folder) => server.answers.applying(chatId, folder),
            remove: id => server.answers.remove(id)
        };
        this.folderList = [...saved.folders];
        this.pinned = saved.scratch;
        this.scratchOf = saved.scratchOf;
        this.tempFolder = saved.tempFolder === true;
        this.workspaceId = saved.workspace;
        this.specLink = saved.spec;
        this.typed = saved.typed === true;

        this.ai = serverAiEnv(text => this.note(text));
    }

    /** The chat this host answers for. Set once, right after the chat is made. */
    bind(chat: ChatController): void {

        this.chat = chat;
    }

    /**
     * Replaces the chat's folders and saves them. `scratch`: it works in
     * scratch for good from now on. `workspace`: the key of the workspace
     * it is in from now on - unchanged when not given. The chat reopens its
     * conversation itself.
     */
    setFolders(folders: readonly string[], scratch = this.pinned, workspace: string | undefined = this.workspaceId): void {

        this.folderList = [...folders];
        this.pinned = scratch;
        this.workspaceId = workspace;

        this.save();
    }

    /** Writes what is saved for the chat - see `SavedSession`. */
    private save(): void {

        if (this.chat)
            writeSession(this.chat.chatId, {
                folders: this.folderList, scratch: this.pinned, ...(this.scratchOf ? { scratchOf: this.scratchOf } : {}),
                ...(this.tempFolder ? { tempFolder: true } : {}),
                ...(this.workspaceId ? { workspace: this.workspaceId } : {}),
                ...(this.specLink ? { spec: this.specLink } : {}),
                ...(this.typed ? { typed: true } : {})
            });
    }

    /**
     * A message typed into the chat was sent. A phase chat is marked for
     * good, so the session list's Recent shows it from now on.
     */
    typedIn(): void {

        if (!this.chat || !this.specLink || this.typed)
            return;

        this.typed = true;
        this.save();
        this.server.chatChanged(this.chat);
    }

    /** The spec and phase this chat was made for, when it is a phase chat. */
    spec(): ChatSpecLink | undefined {

        return this.specLink;
    }

    /** SDD's side of a phase chat. Nothing for any other chat. */
    owner(): PhaseOwner | undefined {

        return this.chat && this.specLink && this.workspaceId
            ? this.server.phaseOwner(this.chat.chatId, this.workspaceId, this.specLink)
            : undefined;
    }

    /** The key of the workspace the session was started in, if it was. */
    workspaceKey(): string | undefined {

        return this.workspaceId;
    }

    /**
     * A permission card's "Add folder to this chat", answered mid-turn.
     * The folder joins the list the page shows and is saved; the check
     * lets the turn use it at once. The working folder never moves: a chat
     * in its scratch folder stays there for good.
     */
    addFolderFromCard(folder: string): void {

        if (!this.chat || this.folderList.some(one => samePath(one, folder)))
            return;

        this.setFolders([...this.folderList, folder], this.inScratch() ? true : this.pinned);

        this.reopenAfterTurn = true;

        void rememberFolders(this.store, [folder]).catch(error =>
            logger.warning(`Eesha Code: could not remember the folder. ${(error as Error).message}`));

        this.server.chatChanged(this.chat);
    }

    /** The agent works in the scratch folder: the chat has no folder, or got its conversation with none. */
    inScratch(): boolean {

        return this.pinned || !this.folderList.length;
    }

    /** The folders picked - what the page shows. */
    userFolders(): string[] {

        return [...this.folderList];
    }

    /** The scratch folder, or the first folder picked. The scratch folder is made here - the agent starts in it. */
    workspace(): string | undefined {

        if (!this.inScratch())
            return this.folderList[0];

        const scratch = this.scratchFolder();

        fs.mkdirSync(scratch, { recursive: true });

        return scratch;
    }

    /** Where the agent works first, then the other folders picked. */
    folders(): string[] {

        return this.inScratch() ? [this.scratchFolder(), ...this.folderList] : [...this.folderList];
    }

    /** Every folder picked - added later ones too. Never the scratch folder: what the agent writes there is not listed. */
    changeFolders(): string[] {

        return [...this.folderList];
    }

    /** Every chat is filed under the profile's no-workspace folder - one history for the whole server. */
    historyKey(): string | undefined {

        return undefined;
    }

    /**
     * ~/.eesha/scratch/<chat id> - outside every repository, and one
     * of the folders the agent may use. A copy made by going back uses
     * the scratch folder of the chat it was copied from.
     */
    scratchFolder(): string {

        return eeshaPath("scratch", this.scratchOf ?? this.chat?.chatId ?? "none");
    }

    plugins(): PluginHost {

        if (this.pluginHost)
            return this.pluginHost;

        // The registry, with no folder open: the bundled
        // plugins, user plugins from ~/.eesha/plugins only. Folders
        // are read when a session starts, so a session opened after a
        // folder change gets the new ones.
        const { registry, failures } = buildRegistry(
            this.server.workerPath,
            [],
            agentRuntime(
                coreProviders({
                    workspaceFolder: () => undefined,

                    // The connector tools, when a connector is connected:
                    // our own MCP server, reached through `eesha mcp`,
                    // which passes each call to this server with the
                    // session's id. Read when a session starts.
                    mcpServers: () => this.hostServers(),

                    // Claude's own memory, off while ours is on - see claudeMemory.ts.
                    sessionEnv: provider => memoryEnv(provider, this.server.memory.choices()),

                    // The runtime's own tools the settings turn off.
                    toolsOff: provider => readServerSettings().runtimes[provider]?.toolsOff ?? [],
                    directories: () => {

                        const scratch = this.scratchFolder();

                        fs.mkdirSync(scratch, { recursive: true });

                        const folders = this.folders();
                        const all = folders.includes(scratch) ? folders : [...folders, scratch];

                        // The workspace allowed the system temp folder when this session was made.
                        return this.tempFolder ? [...all, os.tmpdir()] : all;
                    },

                    // One check per session, made when it starts: the chat
                    // and its working folder are fixed for its life.
                    permissions: (provider, workingDirectory) => this.chat
                        ? levelGate({
                            store: this.store,
                            provider,
                            chatId: this.chat.chatId,
                            workingFolder: workingDirectory,
                            book: this.server.answers,
                            addFolder: folder => this.addFolderFromCard(folder)
                        })
                        : undefined
                }),
                this.server.sessions),
            { workspaceFolder: () => undefined });

        for (const failure of failures)
            logger.warning(`Eesha Code: plugin at ${failure.sourcePath} did not load: ${failure.message}`);

        this.pluginHost = new PluginHost(registry);

        return this.pluginHost;
    }

    sessions(): AgentSessions {

        return this.server.sessions;
    }

    /** The MCP servers Eesha Code adds to a session - see `ProviderDeps.mcpServers`. */
    private hostServers(): Record<string, unknown> {

        if (!this.chat)
            return {};

        const servers: Record<string, unknown> = {};

        // One server for both: the connectors' tools and the memory's.
        if (this.server.connectors.connected() || this.server.memory.on())
            servers[CONNECTORS_SERVER_NAME] = { command: process.execPath, args: [this.server.cliPath, "mcp", "--chat", this.chat.chatId] };

        return servers;
    }

    /**
     * `.eesha/system.md` in each folder of the chat, `kiro.md` beside
     * it on a Kiro runtime, and a line naming the tools turned off - see
     * instructions.ts.
     */
    systemInstructions(provider: string): string | undefined {

        const standing = standingInstructions(this.folderList, provider, readServerSettings().runtimes[provider]);
        const link = this.link();
        const line = link
            ? `This workspace is for ${link.kind === "workitem" ? "Azure DevOps work item" : "GitHub issue"} ${link.id} - ${link.title}${link.url ? ` - ${link.url}` : ""}. `
                + `Read it with the ${link.connector === "ado" ? "ado" : "gh"} tools when the task needs its details.`
            : undefined;

        // Memory last: how to use it, and the titles saved now.
        const memory = this.server.memory.instructions(this.memoryPlace());

        return [standing, line, memory].filter(Boolean).join("\n\n") || undefined;
    }

    /**
     * What this session's memory reaches: the workspace it is in, and the
     * folders picked. A session in its scratch folder has neither - only
     * the global memories.
     */
    memoryPlace(): SessionPlace {

        if (this.inScratch())
            return { folders: [] };

        const workspace = sessionWorkspace(this.store, this.workspaceId, this.folderList[0]);

        return {
            ...(workspace ? { workspace: { key: workspaceKey(workspace), name: workspace.name } } : {}),
            folders: [...this.folderList]
        };
    }

    /**
     * Before a typed turn on Claude while memory is on: Claude's own
     * memory has to be off first. Asked once; the answer is saved.
     */
    async beforeTurn(provider: string): Promise<string | undefined> {

        if (!this.chat || !claudeWaits(provider, this.server.memory.choices()))
            return undefined;

        const answer = await this.server.ask(this.chat, { kind: "confirm", text: CLAUDE_MEMORY_QUESTION, action: CLAUDE_MEMORY_ACTION });

        if (answer !== CLAUDE_MEMORY_ACTION)
            return CLAUDE_MEMORY_HELD;

        const saved = await saveMemoryChoices({ claudeMemoryOff: true });

        return "problem" in saved ? saved.problem : undefined;
    }

    /**
     * The work item or issue of the workspace this session is in: the one
     * it was started in, else the one whose main folder is its first
     * folder.
     */
    private link(): WorkspaceLink | undefined {

        if (this.inScratch())
            return undefined;

        return sessionWorkspace(this.store, this.workspaceId, this.folderList[0])?.link;
    }

    /** The rows for a `>` path being typed - see `Connectors.search`. */
    async searchPaths(path: readonly string[], query: string, refresh?: boolean): Promise<PathMatch[]> {

        const memory = this.server.memory;

        // `>memory>...`: the saved memories this session can use.
        if (path[0]?.toLowerCase() === MEMORY_PATH)
            return memory.search(path.slice(1), query, this.memoryPlace());

        const link = this.link();
        const rows = await this.server.connectors.search(path, query, { ...(refresh ? { refresh } : {}), ...(link ? { link } : {}) });

        if (path.length)
            return rows;

        // The first level: memory beside the connectors. With no
        // connector, their "connect one" row gives way to it.
        const own = memory.rootRow(query);

        return own.length ? [...rows.filter(row => !row.disabled), ...own] : rows;
    }

    /**
     * One line per `>` path in a message - see `Connectors.references`.
     * A `>memory>level>id` path is read here: it is this session's own.
     */
    async pathReferences(text: string): Promise<{ lines: string[]; note?: string }> {

        const found = await this.server.connectors.references(text);
        const lines = [...found.lines];
        const problems: string[] = [];

        for (const path of pathsIn(text)) {

            if (path[0]?.toLowerCase() !== MEMORY_PATH)
                continue;

            const one = this.server.memory.reference(path.slice(1), this.memoryPlace());

            if (one.line)
                lines.push(one.line);
            else if (one.problem)
                problems.push(`>${path.join(">")}: ${one.problem}`);
        }

        const note = [found.note, problems.length ? `Sent as plain text - ${problems.join("; ")}.` : undefined].filter(Boolean).join(" ");

        return { lines, ...(note ? { note } : {}) };
    }

    /** Over every folder of the chat, not only the working one. */
    searchFiles(_root: string, query: string): Promise<FileMatch[]> {

        return searchFolders(this.folders(), query);
    }

    note(text: string): void {

        if (this.chat)
            this.server.toPage(this.chat, { type: "eesha.note", text });
    }

    async askText(request: { title: string; value: string; prompt: string }): Promise<string | undefined> {

        if (!this.chat)
            return undefined;

        return this.server.ask(this.chat, { kind: "text", title: request.title, value: request.value, text: request.prompt });
    }

    /**
     * Set by the server just before a delete that leaves a folder with no
     * session, and taken away after it: the delete's question offers to
     * keep that folder in the list. The person decides.
     */
    keepOffer?: { folder: string; label: string };

    async confirm(text: string, action: string): Promise<boolean> {

        if (!this.chat)
            return false;

        // One question only: a second one asked in the same delete offers nothing.
        const offer = this.keepOffer;

        this.keepOffer = undefined;

        const answer = await this.server.ask(this.chat, { kind: "confirm", text, action, ...(offer ? { keep: offer.label } : {}) });

        if (offer && answer === action + KEEP_FOLDER) {

            await this.server.keepFolder(offer.folder);

            return true;
        }

        return answer === action;
    }

    /**
     * Shows a file the thread links to, in the page. Only a file inside
     * the chat's folders or its scratch folder: the link is in text the
     * agent wrote, and could name any path.
     */
    openFile(file: string): void {

        if (!this.chat)
            return;

        const chat = this.chat;

        const root = this.inScratch() ? this.scratchFolder() : this.folderList[0];

        const absolute = path.resolve(root, file);

        const allowed = [...this.folderList, this.scratchFolder()].some(folder => isInside(folder, absolute));

        if (!allowed)
            return this.server.toPage(chat, { type: "eesha.file", path: file, problem: "Only files inside this session's workspace open here." });

        const read = readShown(absolute);

        this.server.toPage(chat, "text" in read
            ? { type: "eesha.file", path: absolute, text: read.text }
            : { type: "eesha.file", path: file, problem: read.problem });
    }

    /** Before the turn against the file as it is now - deleted and not put back, an empty right side. */
    async showDiff(changed: Omit<TurnChanges, "files">, file: string, absolute: string): Promise<void> {

        if (!this.chat)
            return;

        this.server.toPage(this.chat, { type: "eesha.diff", ...await this.diffOf(changed, file, absolute), from: diffFrom(changed, file) });
    }

    /** One turn's own change to the file, from its two snapshots - the changed-files panel. */
    async showTurnDiff(changed: Omit<TurnChanges, "files">, file: string): Promise<void> {

        if (!this.chat)
            return;

        this.server.toPage(this.chat, { type: "eesha.diff", ...await this.diffOf(changed, file), turn: true, from: diffFrom(changed, file) });
    }

    /** Review all: every file the turn changed, in one window. */
    async showReview(files: { changed: TurnChanges; file: string; absolute: string }[]): Promise<void> {

        if (!this.chat)
            return;

        const shown: ReviewFile[] = [];

        for (const { changed, file, absolute } of files)
            shown.push({
                ...await this.diffOf(changed, file, absolute),
                file,
                status: changed.files.find(one => one.path === file)?.status ?? "modified",
                changed
            });

        this.server.toPage(this.chat, { type: "eesha.review", files: shown });
    }

    /**
     * One file before the turn and now, as the page shows it. With no
     * `absolute`: before the turn and right after it, from the turn's
     * own snapshot.
     */
    private async diffOf(changed: Omit<TurnChanges, "files">, file: string, absolute?: string): Promise<{ path: string; before?: string; after: string; binary?: boolean }> {

        // With several folders, the dialog says which repository the file is in.
        const label = this.folderList.length > 1 ? `${path.basename(changed.root)}/${file}` : file;

        const before = await contentAt(changed.root, changed.before, file);

        let after: Buffer | undefined;

        if (absolute === undefined)
            after = await contentAt(changed.root, changed.after, file);

        else
            try {

                after = fs.readFileSync(absolute);

            } catch {

                // Deleted.
            }

        if ((before && isBinary(before)) || (after && isBinary(after)))
            return { path: label, after: "", binary: true };

        return {
            path: label,
            ...(before ? { before: before.toString("utf8") } : {}),
            after: after?.toString("utf8") ?? ""
        };
    }

    /**
     * A file the turn added, undone: moved to ~/.eesha/trash, not
     * deleted.
     */
    async trash(absolute: string): Promise<void> {

        await moveToTrash(absolute);
    }

    /** A chat with no tab open is waiting: every open tab is told, with a way to open it. */
    announceAsk(where: string, _prompt: string | undefined, _permission: AskPermission | undefined): void {

        if (this.chat)
            this.server.toAll({ type: "eesha.attention", text: `The agent in ${where} is waiting for an answer.`, chatId: this.chat.chatId });
    }

    holder(chatId: string, asking: ChatController): ChatController | undefined {

        return this.server.holder(chatId, asking);
    }

    /** The other chat is in another browser tab, which a page cannot bring forward. */
    show(_chat: ChatController): void {

        this.note("That session is open in another browser tab.");
    }

    /**
     * The chat on this tab is another one now (the chat's own New chat,
     * or the chat on screen was deleted) or a turn ended. A chat opened
     * again keeps the folders it was saved with; a new one starts with
     * none, in its scratch folder.
     */
    async changed(chat: ChatController): Promise<void> {

        const saved = readSession(chat.chatId);

        this.folderList = saved ? [...saved.folders] : [];
        this.pinned = saved?.scratch ?? false;
        this.scratchOf = saved?.scratchOf;
        this.tempFolder = saved?.tempFolder === true;
        this.workspaceId = saved?.workspace;
        this.specLink = saved?.spec;
        this.typed = saved?.typed === true;

        if (!saved)
            writeSession(chat.chatId, { folders: [], scratch: false });

        // A card added a folder during the turn that just ended: the
        // runtime gets it now, when the next message reopens the conversation.
        if (this.reopenAfterTurn && !chat.working) {

            this.reopenAfterTurn = false;

            await chat.foldersChanged();
        }

        this.server.chatChanged(chat);
    }

    /**
     * Going back kept the chat as it was under a new id: the copy gets the
     * same folders, and works in the same scratch folder - see
     * `SavedSession.scratchOf`.
     */
    copied(fromId: string, toId: string): void {

        const saved = readSession(fromId);

        writeSession(toId, {
            folders: saved ? [...saved.folders] : [...this.folderList],
            scratch: saved?.scratch ?? this.pinned,
            scratchOf: saved?.scratchOf ?? fromId,
            ...((saved ? saved.tempFolder : this.tempFolder) ? { tempFolder: true as const } : {}),
            ...((saved ? saved.workspace : this.workspaceId) ? { workspace: (saved ? saved.workspace : this.workspaceId)! } : {})
        });

        // Its "This session" answers hold in the copy too.
        this.server.answers.copyChat(fromId, toId);
    }

    renamed(chatId?: string): void {

        this.server.renamed(chatId);
    }

    deleted(chatId: string): void {

        this.server.chatDeleted(chatId);
    }

    notify(chat: ChatController, notice: ChatNotice): void {

        this.server.notify(chat, notice);
    }
}

/**
 * A file's text, for the page to show - a thread link or the files pane.
 * Not a folder, not past 2 MB, not binary; each says why it is not shown.
 */
export function readShown(absolute: string): { text: string } | { problem: string } {

    try {

        const stat = fs.statSync(absolute);

        if (!stat.isFile())
            return { problem: "Not a file." };

        if (stat.size > MAX_SHOWN_BYTES)
            return { problem: `Too large to show here (${Math.round(stat.size / 1024)} KB). Open it in your editor: ${absolute}` };

        const bytes = fs.readFileSync(absolute);

        return isBinary(bytes)
            ? { problem: `Not a text file. Open it in another program: ${absolute}` }
            : { text: bytes.toString("utf8") };

    } catch (error) {

        return { problem: (error as Error).message };
    }
}

/** Where a turn's diff came from, for the page's address. */
function diffFrom(changed: { root: string; before: string; after: string }, file: string): DiffFrom {

    return { root: changed.root, before: changed.before, after: changed.after, file };
}

/** A NUL byte in the first 8 KB: not text. */
function isBinary(bytes: Buffer): boolean {

    return bytes.subarray(0, 8192).includes(0);
}

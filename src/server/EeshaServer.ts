import * as crypto from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";

import { AgentSessions } from "../core/agent";
import { AnswerBook } from "../core/agent/permissions";
import { logger } from "../core/logging/logger";
import { PluginDatabase } from "../core/plugins/PluginDatabase";
import { resolveDatabasePath } from "../core/store/databaseLocation";
import { loadEngineSettings } from "../core/settings/engineSettings";
import { aiChoiceMessage, providerIds } from "../chat/aiChoice";
import { ChatController, PICK_PREFIX, TITLES_KEY } from "../chat/ChatController";
import type { ChatNotice, PhaseOwner } from "../chat/chatHost";
import type { PhaseChat } from "../sdd/panel/sddHost";
import type { SddPlace } from "./ServerSddHost";
import { listChats, searchChats } from "../chat/chatHistory";
import { defaultRuntimeOf, newChatId, startRuntime } from "../chat/chatRules";
import type { ChatStore } from "../chat/chatStore";
import type { ChatSpecLink, ToChatHost, ToChatView } from "../shared/chatMessages";
import { ServerChatHost, serverAiEnv, HostServer, readShown } from "./ServerChatHost";
import { EvalChatHost } from "./EvalChatHost";
import { dropStart, evalCopyDir, evalDir, evalNames, evalOfChat, evalScratchDir, evalStateFile, type EvalVariant, isEvalName, makeCopy, readEval, type SavedEval, saveStart, variantMessage, writeEval } from "./evals";
import { copyChanges, folderBytes, turnReportsOfFile } from "./evalReport";
import { evalTasks, evalTasksDir, findingInFolder, taskClosing } from "./evalTasks";
import { runtimeVersion } from "./runtimeVersion";
import { FileStore } from "./fileStore";
import { COMMAND_LIMIT, CommandRuns, findShells, type Shell } from "./commands";
import { CONNECTOR_IDS, type ConnectorId } from "./connectors/config";
import { CONNECTORS_SERVER_NAME } from "./connectors/mcpBridge";
import { INSTRUCTIONS_FOLDER } from "./instructions";
import { Connectors } from "./connectors/Connectors";
import { checkMemoryChange, saveMemoryChoices } from "./memory/config";
import { Memory, MEMORY_TOOL_PREFIX, type SessionPlace } from "./memory/Memory";
import { MemoryStore } from "./memory/memoryStore";
import { gitReposIn, isInside, listFiles, listFolders, workingFoldersHere } from "./folders";
import { commitFiles, commitList, fileDiff, findRepos, GitError, isGitAction, repoLists, repoOf, repoStatus, RepoWatch, runAction } from "./git";
import { writeCommitMessage } from "./gitMessage";
import { deleteInKiro, KiroList, kiroSessionOf, renameInKiro } from "./kiroList";
import { eeshaPath, readJson } from "./paths";
import { chatEventsPath, eventsRoot } from "../core/events/eventFile";
import { levelsOf, writeLevel } from "../chat/permissionLevels";
import { AiOptions, ALIAS_LIMIT, API, ChatInfo, ChatMark, ChatRow, type CopyStyleAsk, EVAL_TEXT_MAX, EVAL_VARIANTS_MAX, type EvalFileChange, type EvalReport, type EvalRow, type EvalVariantReport, type EvalView, folderKey, isChatMark, type KiroRow, type NewSpecAsk, PromptRequest, SessionInfo, SettingsChange, ToPage, type UpgradedView, type WorkspaceLink, workspaceKey } from "./protocol";
import { placeProblem, placeRoots, type SddServer, SddSpecs, specProblem } from "./sddSpecs";
import { NO_WORKSPACE_SPECS, specCommand, specPathReference, specPathRows } from "./sddPaths";
import type { PathMatch } from "../shared/composeFiles";
import { isSpecAction } from "../shared/specPaths";
import { chatPath, isOwnPart, NO_WORKSPACE_PART, type PageRoute, resolveAddress, workspaceParts, workspacePath } from "../shared/pageAddress";
import type { ToPanel } from "../shared/sddMessages";
import { cookieKey, hostAllowed, isKey, KEY_HEADER, keyCookie, originAllowed, sameSite } from "./security";
import { checkFolders, isChatId, readSession, recentFolders, rememberFolders, removeSession, sessionIds, writeSession } from "./sessions";
import { archiveWorkspace, checkStartPick, checkWorkspace, defaultWorkspaceName, newWorkspaceId, readWorkspaces, removeWorkspace, saveWorkspace, sessionFolders, workspaceAt, workspaceByKey } from "./workspaces";
import { readServerSettings, sameFolder, serverSettingsFrom, FONT_SIZE, type Theme } from "./settings";
import { addRuntime, changeSettings, evalsOn, freePort, type NewRuntime, removeRuntime, saveSettingsText, settingsView } from "./settingsPage";
import { emptyTrash, moveToTrash, removeOrphanScratch } from "./storage";
import { buildFromSource, checkForUpdate, installKind, isVersion, noteRebuilt, startUpgradeHelper } from "./update";
import { packageVersion } from "./version";

export interface ServerOptions {

    port: number;

    theme: Theme;

    /** The page's text size in px. Default 13. */
    fontSize?: number;

    /** See security.ts. */
    key: string;

    /** dist/web - the page and its scripts. */
    webRoot: string;

    /** dist/pluginWorker.js. */
    workerPath: string;

    /** Said when a turn fails with no reason. */
    logPlace: string;

    store: ChatStore;

    /** `eesha stop` asked. The server is closed by whoever started it. */
    onStop(): void;

    /** Built from source after a click on the version: close, and start the new dist/server.js in this one's place. */
    onRestart(): void;

    /** How long a chat with no tab open is kept before its session is let go. Default ten minutes. */
    idleMs?: number;

    /** How the last upgrade started from the page went - sent with the hello for a few minutes. See update.ts. */
    upgraded?: UpgradedView;

    /** The `resources` folder with SDD's built-in styles. Default: the repository's own, beside Eesha Code. */
    resources?: string;
}

/** One browser tab's event stream. */
interface Tab {

    /** Made by the page, new on every load. */
    id: string;

    response: http.ServerResponse;

    /**
     * The page whose stream carries this tab's messages - set for an
     * Evaluator column's frame, which opens no stream of its own (see
     * API.join). Its messages go out on that page's stream, marked with
     * this tab's id.
     */
    via?: Tab;

    chat?: ChatEntry;

    /** What the chat is drawn on while this tab shows it. */
    surface?: { post(message: ToChatView): void };

    /** Questions asked and not answered yet, by id. */
    prompts: Map<number, (value: string | undefined) => void>;

    /** Keeps the stream open. None on a column's tab: its page's stream has one. */
    ping?: ReturnType<typeof setInterval>;

    /** The git panel is open: its repositories are watched. */
    gitWatch?: RepoWatch;

    /** The git panel's AI button is writing a message - this stops it. */
    gitJob?: { stop(): void };
}

/** One chat kept by the server - with a tab showing it, or waiting for one. */
interface ChatEntry {

    controller: ChatController;

    host: ServerChatHost;

    tab?: Tab;

    /** Lets the chat go once nobody has looked at it for a while. */
    idle?: ReturnType<typeof setTimeout>;

    /** The open question the chat list was last told about - see `questionChanged`. */
    listedQuestion?: string;
}

/** A view id the page made: letters, digits and dashes. */
const VIEW_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The largest request body - a message with a 10 MB upload, in base64, fits. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

/** A comment line every 25 seconds keeps an idle stream from being cut. */
const PING_MS = 25_000;

/** The longest text the chat search takes. */
const SEARCH_LIMIT = 200;

/** In the store: the pinned and archived chats, chat id to "pinned" or "archived". */
const MARKS_KEY = "eesha.marks";

/** In the store: the names given to folders, folder key (see `folderKey`) to alias. */
const ALIASES_KEY = "eesha.aliases";

/** The most chats one delete from a folder's or a day's menu takes. */
const DELETE_LIMIT = 5000;

/** The longest end of a delete question - `in 'api'`, sent by the page. */
const WHERE_LIMIT = 200;

/**
 * How long a page's commands keep running after its stream ends. A
 * stream that comes back in time (the network blinked) keeps them; a
 * page that was closed or reloaded has them stopped.
 */
const RUN_GRACE_MS = 30_000;

/**
 * The addresses that get the page: each view, and Settings
 * with each of its sections. Kept the same as PAGE_PATHS in web/pageRoute.ts - a test checks.
 */
export const PAGE_PATHS: ReadonlySet<string> = new Set([
    "/",
    "/settings",
    "/settings/general",
    "/settings/connectors",
    "/settings/memory",
    "/settings/runtimes",
    "/settings/features",
    "/settings/storage",
    "/sdd",
    "/workspace",
    "/eval"
]);

/** The longest a variant's mode or effort is. */
const EVAL_OPTION_LIMIT = 60;

/** What a variant runs on and is sent - everything of it but its name, its session and its copy. */
type VariantSetup = Pick<EvalVariant, "provider" | "model" | "mode" | "effort" | "extra">;

/**
 * What a variant's column may not send: each starts a turn, changes the
 * one the variant had, or changes its setup. A variant gets one message
 * and its setup on the create page - a second one would spoil the comparison.
 */
const EVAL_COLUMN_REFUSED: ReadonlySet<string> = new Set(["send", "newChat", "compact", "handover", "goBack", "setAiChoice"]);

/** An evaluation counted: each variant's changed files and copy size, by name, and the whole size. */
interface EvalCount {

    variants: Map<string, { files?: EvalFileChange[]; filesProblem?: string; bytes: number }>;

    bytes: number;

    /** What the count was made from - see `countKey`. The same key: the count still holds. */
    key: string;
}

const EVAL_ONE_MESSAGE = "A variant gets one message and its setup when the evaluation is made. Its column only shows the run. To try something else, use Copy as new variant.";

/** One evaluation's page: `/eval/<name>`. The name is checked by the page's own request, not here. */
const EVAL_PAGE = /^\/eval\/[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;

const CONTENT_TYPES: Record<string, string> = {
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".woff2": "font/woff2"
};

/**
 * The page's rules: only our own scripts run, and nothing loads from
 * anywhere else. The nonce is for a plugin's page in a spec: it sits in
 * an iframe that takes this policy, so its scripts carry the nonce.
 *
 * Frames: the Evaluator page shows each variant's chat in a frame, and
 * that frame is this same page. So the page may frame itself and be
 * framed by itself, and by nothing else.
 */
const pagePolicy = (nonce: string) => [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'"
].join("; ");

/**
 * The Eesha Code server: the page, one event stream per browser tab, and
 * the requests the page sends. Listens on 127.0.0.1 only.
 *
 * Each chat is one `ChatController` - kept here while a tab shows it, and for a while after
 * the tab closes so a reload picks up where it was, a turn in flight
 * included. A chat is shown in one tab at a time: opening it in a second
 * tab moves it there.
 */
export class EeshaServer implements HostServer, SddServer {

    readonly store: ChatStore;

    /** The folder with SDD's built-in styles. */
    readonly resources: string;

    /** The specs open in the SDD module - see sddSpecs.ts. */
    readonly sdd: SddSpecs;

    readonly sessions = new AgentSessions();

    /** The answers saved from permission cards - ~/.eesha/permissions.json, read on every question. */
    readonly answers = new AnswerBook(eeshaPath("permissions.json"));

    readonly workerPath: string;

    /** See pagePolicy. New on every server start; only the page's policy and plugin pages carry it. */
    readonly pluginNonce = crypto.randomBytes(18).toString("base64");

    /** The plugin data of each main folder, opened on first use and closed with the server. */
    private readonly pluginDatabases = new Map<string, PluginDatabase>();

    readonly logPlace: string;

    readonly connectors: Connectors;

    /** The memories kept between sessions - ~/.eesha/memory.db. See memory/Memory.ts. */
    readonly memory: Memory;

    readonly cliPath: string;

    private readonly tabs = new Map<string, Tab>();

    private readonly chats = new Set<ChatEntry>();

    /** Chats whose turn ended while no tab showed them, and how - until a tab opens them. See `ChatRow.unseen`. */
    private readonly unseen = new Map<string, "done" | "failed">();

    /** Kiro's own sessions in the list's folders - see `kiroList.ts`. */
    private readonly kiro = new KiroList(() => this.toAll({ type: "eesha.listChanged" }));

    private nextPrompt = 1;

    /** An upgrade from the footer's version runs: a second one is refused. */
    private upgrading = false;

    /** Commands started from a Run button. Their output goes to the tab that started them. */
    private readonly runs = new CommandRuns((view, id, part) => {

        const tab = this.tabs.get(view);

        if (tab)
            this.send(tab, { type: "eesha.run", id, ...part });
    });

    /** The shells on this machine - looked for once, the first time the page asks. */
    private shellList?: Shell[];

    private http?: http.Server;

    /** The page's colours - from the start's settings, then from the settings page. */
    private theme: Theme;

    /** The page's text size in px - the same way. */
    private fontSize: number;

    /** The Evaluator is on (`features.evals`) - read at start and when the settings page writes. */
    private evals = false;

    /** Each open evaluation's own saved values, by its name - one per evaluation, so two writers never overwrite each other. */
    private readonly evalStores = new Map<string, FileStore>();

    /** The evaluations being made now, by name: a second request for the same name is refused. */
    private readonly evalsMaking = new Set<string>();

    /**
     * Each evaluation's changed files and sizes, as last counted. They are
     * counted only while no variant works - counting means reading every
     * file of every copy, which would slow the variants being timed - and
     * the report shows these meanwhile.
     */
    private readonly evalCounts = new Map<string, EvalCount>();

    constructor(private readonly options: ServerOptions) {

        this.theme = options.theme;
        this.fontSize = options.fontSize ?? FONT_SIZE.default;
        this.store = options.store;
        this.workerPath = options.workerPath;
        this.logPlace = options.logPlace;

        // dist/cli.js sits beside dist/pluginWorker.js.
        this.cliPath = path.join(path.dirname(options.workerPath), "cli.js");

        this.resources = options.resources ?? path.join(__dirname, "..", "..", "resources");
        this.sdd = new SddSpecs(this);

        this.connectors = new Connectors({
            folders: () => [...readWorkspaces(this.store).map(one => one.folders[0]!), ...recentFolders(this.store)],
            onSignIn: (id, progress) => this.toAll({ type: "eesha.connectorSignIn", id, ...progress })
        });

        this.memory = new Memory({ store: new MemoryStore(eeshaPath("memory.db")) });

        // A saved answer counts in every chat it holds for, so every chat on
        // screen gets its "Saved answers (N)" again. A chat in no tab gets
        // it when a tab draws it.
        this.answers.onChange(() => {

            for (const entry of this.chats)
                if (entry.tab)
                    void entry.controller.savedAnswersChanged();
        });
    }

    /** Starts listening on 127.0.0.1. Fails when the port is taken. */
    async listen(): Promise<void> {

        this.evals = await evalsOn();

        const server = http.createServer((request, response) => {

            this.handle(request, response).catch(error => {

                logger.error(`Eesha Code: ${request.method} ${request.url} failed. ${(error as Error).message}`);

                if (!response.headersSent)
                    sendJson(response, 500, { problem: "The server failed - see its log." });
                else
                    response.end();
            });
        });

        this.http = server;

        return new Promise((resolve, reject) => {

            server.once("error", reject);
            server.listen(this.options.port, "127.0.0.1", () => {

                server.off("error", reject);
                resolve();
            });
        });
    }

    /** The port listened on - the one asked for, or the one picked when 0 was asked for. */
    get port(): number {

        const address = this.http?.address();

        return address && typeof address === "object" ? address.port : this.options.port;
    }

    /**
     * Where plugins keep their data for one main folder: `plugins/` beside
     * that folder's run database.
     */
    pluginDatabase(mainFolder: string): PluginDatabase {

        const directory = path.join(path.dirname(resolveDatabasePath(mainFolder)), "plugins");

        let database = this.pluginDatabases.get(directory);

        if (!database) {

            database = new PluginDatabase(directory);
            this.pluginDatabases.set(directory, database);
        }

        return database;
    }

    /** Stops every turn, lets every session go and stops listening. */
    async close(): Promise<void> {

        for (const tab of [...this.tabs.values()])
            this.endTab(tab);

        this.sdd.close();

        for (const database of this.pluginDatabases.values())
            database.close();

        this.pluginDatabases.clear();

        this.memory.store.close();

        this.runs.stopAll();

        const closing = [...this.chats].map(entry => {

            clearTimeout(entry.idle);

            return entry.controller.close();
        });

        this.chats.clear();

        // A runtime that will not let go is not worth hanging the stop on.
        await Promise.race([Promise.allSettled(closing), new Promise(resolve => setTimeout(resolve, 5000))]);

        await new Promise<void>(resolve => {

            if (!this.http)
                return resolve();

            this.http.close(() => resolve());
            this.http.closeAllConnections();
        });
    }

    // ---------------------------------------------------------------
    // Requests
    // ---------------------------------------------------------------

    private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {

        const port = this.port;

        if (!hostAllowed(request, port))
            return sendText(response, 403, "Refused: this server only answers to 127.0.0.1 and localhost.");

        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

        if (url.pathname.startsWith("/control/"))
            return this.control(request, response, url);

        // The link the command printed: the key is swapped for a cookie,
        // and taken out of the address.
        if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("key")) {

            if (!sameSite(request) || !isKey(url.searchParams.get("key") ?? undefined, this.options.key))
                return sendText(response, 403, "Refused: that link's key is wrong. Run `eesha status` for the right link.");

            url.searchParams.delete("key");

            response.writeHead(302, {
                "Set-Cookie": keyCookie(this.options.key),
                Location: `/${url.search}`,
                "Cache-Control": "no-store"
            });

            return void response.end();
        }

        if (!isKey(cookieKey(request), this.options.key))
            return sendText(response, 401, "Not signed in. Open the link `eesha start` printed - run `eesha status` to see it again.");

        if (request.method === "GET") {

            if (!sameSite(request))
                return sendText(response, 403, "Refused: requests from other sites are not answered.");

            if (url.pathname === "/events")
                return this.events(request, response, url);

            if (url.pathname.startsWith("/assets/"))
                return this.asset(response, decodeURIComponent(url.pathname.slice("/assets/".length)));

            // An older address of a session or a workspace page moves to
            // its new one, once (shared/pageAddress.ts).
            const moved = this.newAddressOf(url);

            if (moved)
                return sendRedirect(response, moved);

            // The start page, Settings, the Evaluator: one page, which
            // reads the path to know what to show.
            if (PAGE_PATHS.has(url.pathname) || EVAL_PAGE.test(url.pathname))
                return this.page(response);

            if (url.pathname.replace(/\/+$/, "") === `/${NO_WORKSPACE_PART}`)
                return sendRedirect(response, "/");

            // A workspace or a session by its name. A renamed one moves
            // to its new address; one that is not there gets the page,
            // which says so.
            if (!url.pathname.includes(".") && !isOwnPart(url.pathname.split("/")[1] ?? "")) {

                const found = resolveAddress(url.pathname, url.search, this.chatRows(), readWorkspaces(this.store));

                if (found && !sameAddress(url, found.address))
                    return sendRedirect(response, found.address);

                return this.page(response, found?.route ?? missingRoute(url.pathname));
            }

            return sendText(response, 404, "Not found.");
        }

        if (request.method === "POST") {

            if (!originAllowed(request, port))
                return sendText(response, 403, "Refused: only this server's own page may send requests.");

            if (!(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json"))
                return sendText(response, 415, "Send JSON.");

            let body: Record<string, unknown>;

            try {

                body = await readJsonBody(request);

            } catch (error) {

                return sendJson(response, 400, { problem: (error as Error).message });
            }

            return this.api(response, url.pathname, body);
        }

        sendText(response, 405, "Method not allowed.");
    }

    /**
     * The new address of an older one: `/?chat=<id>` (with `spec` and
     * `specFolder`) and `/workspace?workspace=<key>`. Nothing: not one, or
     * nothing is there - the page then says so as it did. A column's
     * frame (`column=1`) keeps its address.
     */
    private newAddressOf(url: URL): string | undefined {

        const query = url.searchParams;
        const name = query.get("spec") || undefined;
        const folder = query.get("specFolder") || undefined;
        const spec = name ? { spec: name, ...(folder ? { folder } : {}) } : undefined;

        if (url.pathname === "/" && query.get("chat") && query.get("column") !== "1") {

            const chat = this.chatRows().find(one => one.chatId === query.get("chat"));

            return chat ? chatPath(chat, workspaceParts(readWorkspaces(this.store)), spec) : undefined;
        }

        if (url.pathname.replace(/\/+$/, "") === "/workspace" && query.get("workspace"))
            return workspacePath(query.get("workspace")!, workspaceParts(readWorkspaces(this.store)), spec);

        return undefined;
    }

    /**
     * The page, with the theme set before anything draws, so it never
     * flashes light. `route`: what a workspace or session address found,
     * for the page to read (pageRoute.ts).
     */
    private page(response: http.ServerResponse, route?: PageRoute): void {

        let html: string;

        try {

            html = fs.readFileSync(path.join(this.options.webRoot, "index.html"), "utf8");

        } catch {

            return sendText(response, 500, "The page is missing - build Eesha Code first (npm run build in Eesha Code).");
        }

        response.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Security-Policy": pagePolicy(this.pluginNonce),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store"
        });

        const themed = html.replaceAll("__THEME__", this.theme).replaceAll("__FONT_SIZE__", String(this.fontSize));

        // In the head, before the scripts read it.
        const meta = route ? `<meta name="eesha-route" content="${attributeText(JSON.stringify(route))}">\n` : "";

        response.end(meta ? themed.replace(/<\/head>|<body/, found => `${meta}${found}`) : themed);
    }

    /** A file of the page: a script, its stylesheet, a chunk. Nothing outside dist/web. */
    private asset(response: http.ServerResponse, relative: string): void {

        const root = path.resolve(this.options.webRoot);
        const file = path.resolve(root, relative);

        if (!file.startsWith(root + path.sep))
            return sendText(response, 404, "Not found.");

        let bytes: Buffer;

        try {

            bytes = fs.readFileSync(file);

        } catch {

            return sendText(response, 404, "Not found.");
        }

        response.writeHead(200, {
            "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-cache"
        });

        response.end(bytes);
    }

    /**
     * `eesha status` and `eesha stop`, and `eesha mcp` asking
     * for the connector tools. The key comes in a header - the command
     * reads it from ~/.eesha/key.
     */
    private async control(request: http.IncomingMessage, response: http.ServerResponse, url: URL): Promise<void> {

        const given = request.headers[KEY_HEADER];

        if (!isKey(typeof given === "string" ? given : undefined, this.options.key))
            return sendJson(response, 401, { problem: "Wrong key." });

        if (request.method === "GET" && url.pathname === "/control/status")
            return sendJson(response, 200, {
                pid: process.pid,
                port: this.port,
                tabs: this.tabs.size,
                chats: this.chats.size,
                working: [...this.chats].filter(entry => entry.controller.working).length,

                // Spec runs in flight - `eesha restart` refuses on these too, as the upgrade does.
                specsWorking: this.sdd.working
            });

        if (request.method === "POST" && url.pathname === "/control/stop") {

            sendJson(response, 200, { ok: true });

            return this.options.onStop();
        }

        if (request.method === "POST" && url.pathname.startsWith("/control/connectors/"))
            return this.connectorControl(request, response, url.pathname);

        sendJson(response, 404, { problem: "Not found." });
    }

    /**
     * The connector tools for `eesha mcp --chat <id>`: the
     * list the choices allow, and one call. A write is asked in the tab
     * showing that session; with no tab, it is refused.
     */
    private async connectorControl(request: http.IncomingMessage, response: http.ServerResponse, route: string): Promise<void> {

        let body: Record<string, unknown>;

        try {

            body = await readJsonBody(request);

        } catch (error) {

            return sendJson(response, 400, { problem: (error as Error).message });
        }

        // The memory tools sit on the same server as the connectors' tools.
        if (route === "/control/connectors/tools")
            return sendJson(response, 200, { tools: [...this.connectors.tools(), ...this.memory.tools()] });

        if (route !== "/control/connectors/call")
            return sendJson(response, 404, { problem: "Not found." });

        if (typeof body.name !== "string")
            return sendJson(response, 400, { problem: "Send the tool's name." });

        const chatId = typeof body.chat === "string" ? body.chat : undefined;

        const entry = chatId ? [...this.chats].find(one => one.controller.chatId === chatId) : undefined;

        // A spec's phase: asked in the tab showing the spec. With no
        // such tab it is refused, as for a chat.
        const specView = !entry && chatId ? this.sdd.viewOf(chatId) : undefined;

        // A variant of an evaluation: nobody is asked, so every change is refused.
        const unattended = entry?.host.unattended() === true;

        const ask = async (question: { connector: string; tool: string; text: string }): Promise<boolean> => {

            if (unattended)
                return false;

            if (specView)
                return await this.askTab(specView, { kind: "write", ...question }) === "allow";

            if (!entry?.tab)
                return false;

            return await this.ask(entry.controller, { kind: "write", ...question }) === "allow";
        };

        if (body.name.startsWith(MEMORY_TOOL_PREFIX)) {

            // What the session can reach: a chat's own workspace and folders,
            // or the workspace a spec's phase runs in.
            const place: SessionPlace | undefined = entry ? entry.host.memoryPlace() : chatId ? this.sdd.memoryPlaceOf(chatId) : undefined;

            if (!place)
                return sendJson(response, 200, { text: "This session is not open in Eesha Code any more, so its memory cannot be reached.", isError: true });

            // A Claude variant that runs on Claude's own memory has none of ours.
            if (unattended && entry && !entry.host.ownMemory())
                return sendJson(response, 200, { text: "Refused: Eesha Code's memory is off for this variant. It runs with Claude's own memory.", isError: true });

            // Without this a save would go through when the person chose not to be asked.
            if (unattended && this.memory.writes(body.name))
                return sendJson(response, 200, { text: "Refused: this session is a variant of an evaluation. It can read the memory but not change it.", isError: true });

            return sendJson(response, 200, await this.memory.call(body.name, body.arguments, place, {
                ask,
                note: text => {

                    if (entry)
                        this.toPage(entry.controller, { type: "eesha.note", text });
                    else if (specView)
                        this.toTab(specView, { type: "eesha.note", text });
                }
            }));
        }

        sendJson(response, 200, await this.connectors.call(body.name, body.arguments, ask));
    }

    /** The Memory section of Settings, and the memory row of its Connectors section. */
    private async memoryApi(response: http.ServerResponse, route: string, body: Record<string, unknown>): Promise<void> {

        const workspaces = readWorkspaces(this.store);

        let result: { problem: string } | { ok: true } = { ok: true };

        if (route === API.memoryChoices) {

            const checked = checkMemoryChange(body.choices);

            result = "problem" in checked ? checked : await saveMemoryChoices(checked.change);
        }

        if (route === API.memorySave)
            result = this.memory.save(body.memory, workspaces);

        if (route === API.memoryRemove)
            result = this.memory.remove(body.id);

        if (route === API.memoryRepoint)
            result = this.memory.repoint(body.from, body.to);

        if ("problem" in result)
            return sendJson(response, 400, result);

        return sendJson(response, 200, this.memory.view(workspaces, recentFolders(this.store)));
    }

    /** The Connectors page. */
    private async connectorApi(response: http.ServerResponse, route: string, body: Record<string, unknown>): Promise<void> {

        if (route === API.connectors)
            return sendJson(response, 200, { cards: await this.connectors.cards() });

        const id = body.id as ConnectorId;

        if (!CONNECTOR_IDS.includes(id))
            return sendJson(response, 400, { problem: "Say which connector: ado or github." });

        if (route === API.connectorSignIn) {

            if (body.stop === true) {

                this.connectors.stopSignIn(id);

                return sendJson(response, 200, { ok: true });
            }

            const started = this.connectors.signIn(id);

            return sendJson(response, "problem" in started ? 409 : 200, started);
        }

        const result = route === API.connectorSave
            ? await this.connectors.save(id, body.config)
            : await this.connectors.remove(id);

        if ("problem" in result)
            return sendJson(response, 400, result);

        return sendJson(response, 200, { cards: await this.connectors.cards() });
    }

    private async api(response: http.ServerResponse, route: string, body: Record<string, unknown>): Promise<void> {

        switch (route) {

            case API.chat: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                const message = body.message as ToChatHost | undefined;

                if (!message || typeof message !== "object" || typeof message.type !== "string")
                    return sendJson(response, 400, { problem: "Not a session message." });

                // An evaluation's variant gets its one message and its setup from the create page - never from its column.
                if (entry.host instanceof EvalChatHost && EVAL_COLUMN_REFUSED.has(message.type)) {

                    const tab = this.tabOf(body.view);

                    if (tab)
                        this.send(tab, { type: "eesha.note", text: EVAL_ONE_MESSAGE });

                    return sendJson(response, 409, { problem: EVAL_ONE_MESSAGE });
                }

                entry.controller.receive(message);

                return sendJson(response, 200, { ok: true });
            }

            case API.join: {

                const stream = this.tabOf(body.stream);
                const view = typeof body.view === "string" ? body.view : "";
                const chatId = typeof body.chat === "string" ? body.chat : undefined;

                // A column rides on a page's own stream - never on another column's.
                if (!stream || stream.via)
                    return sendJson(response, 409, { problem: "The page's stream is not open - reload the page." });

                // The same column again is fine; a page's own id is not a column's.
                if (!VIEW_ID.test(view) || (this.tabs.has(view) && !this.tabs.get(view)!.via))
                    return sendJson(response, 400, { problem: "Bad view id." });

                if (chatId !== undefined && !isChatId(chatId))
                    return sendJson(response, 400, { problem: "Bad session id." });

                this.openTab({ id: view, response: stream.response, via: stream, prompts: new Map() }, chatId);

                return sendJson(response, 200, { ok: true });
            }

            case API.leave: {

                const tab = this.tabOf(body.view);

                if (tab?.via)
                    this.endTab(tab);

                return sendJson(response, 200, { ok: true });
            }

            case API.folders: {

                const folder = typeof body.path === "string" && body.path ? body.path : undefined;

                if (folder && !path.isAbsolute(folder))
                    return sendJson(response, 400, { problem: "Not a full folder path." });

                const listing = await listFolders(folder, body.files === true);

                if (folder)
                    return sendJson(response, 200, listing);

                // The top level: the drives, the folders used before, the
                // working folders, and the git repos in them.
                const recent = recentFolders(this.store);
                const working = workingFoldersHere(readServerSettings().workingFolders);
                const repos = (await gitReposIn(working)).filter(repo => !recent.some(one => sameFolder(one, repo)));

                return sendJson(response, 200, { ...listing, recent, repos, working });
            }

            case API.newSession: {

                // From a workspace's heading: its main folder, and the
                // rest of the workspace when it is one.
                const from = typeof body.folder === "string" && body.folder ? body.folder : undefined;
                const named = typeof body.workspace === "string" && body.workspace ? workspaceByKey(this.store, body.workspace) : undefined;
                const saved = from ? (named && folderKey(named.folders[0]!) === folderKey(from) ? named : workspaceAt(this.store, from)) : undefined;

                const checked = checkFolders(from ? sessionFolders(from, saved) : body.folders);

                if ("problem" in checked)
                    return sendJson(response, 400, saved ? { problem: `${checked.problem}. Fix it with Edit workspace on the workspace's menu.` } : checked);

                // The start page's pickers. Only asked for the runtime
                // list when something was picked.
                const wanted = body.runtime !== undefined || body.model !== undefined || body.level !== undefined;
                const started = wanted ? checkStartPick(body, await providerIds(serverAiEnv(text => this.toAll({ type: "eesha.note", text })))) : { pick: {} };

                if ("problem" in started)
                    return sendJson(response, 400, started);

                const chatId = newChatId(Date.now());

                writeSession(chatId, {
                    folders: checked.folders,
                    scratch: false,
                    ...(saved?.tempFolder ? { tempFolder: true } : {}),
                    ...(saved ? { workspace: workspaceKey(saved) } : {})
                });

                // The runtime and model picked on the start page, or else
                // the folder's saved ones, become this session's own pick,
                // as if picked in its compose box.
                const pick = started.pick.runtime
                    ? { provider: started.pick.runtime, ...(started.pick.model ? { model: started.pick.model } : {}) }
                    : saved?.runtime ? {
                        provider: saved.runtime,
                        ...(saved.model ? { model: saved.model } : {}),
                        ...(saved.model && saved.effort ? { effort: saved.effort } : {})
                    } : undefined;

                if (pick)
                    await this.store.update(PICK_PREFIX + chatId, pick);

                // A level is kept per runtime, as the compose box's picker keeps it.
                if (started.pick.level)
                    await writeLevel(this.store, started.pick.level.runtime, started.pick.level.level);

                if (checked.folders.length)
                    await rememberFolders(this.store, checked.folders);

                this.sweepEmpty(chatId);

                return sendJson(response, 200, { chatId });
            }

            case API.setWorkspace: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                if (entry.controller.working)
                    return sendJson(response, 409, { problem: "Still working - stop the agent first, then change the workspace." });

                const checked = checkFolders(body.folders);

                if ("problem" in checked)
                    return sendJson(response, 400, checked);

                const before = entry.host.userFolders();

                const started = entry.controller.started;
                const scratch = entry.host.inScratch();

                // Once a runtime answered, the conversation is tied to the
                // folder it started in: a runtime finds its transcript by
                // that folder. Before that, anything goes.
                if (started && !scratch && !samePath(checked.folders[0], before[0]))
                    return sendJson(response, 400, { problem: "The first folder is where this session's conversation started, so it stays first. Start a new session to work in another folder." });

                const unchanged = checked.folders.length === before.length && checked.folders.every((one, index) => samePath(one, before[index]));

                if (unchanged)
                    return sendJson(response, 200, { ok: true });

                // A chat that got its conversation in scratch stays there.
                // A new first folder: the session is in that folder's
                // newest workspace from now on, or in none.
                const moved = !samePath(checked.folders[0], before[0]);
                const placed = moved ? (checked.folders[0] ? workspaceAt(this.store, checked.folders[0]) : undefined) : undefined;

                entry.host.setFolders(checked.folders, started && scratch, moved ? (placed ? workspaceKey(placed) : undefined) : entry.host.workspaceKey());

                if (checked.folders.length)
                    await rememberFolders(this.store, checked.folders);

                // Only a conversation that exists needs reopening.
                if (started)
                    await entry.controller.foldersChanged();

                this.chatChanged(entry.controller);

                return sendJson(response, 200, { ok: true });
            }

            case API.chats: {

                const chats = this.chatRows();
                const workspaces = readWorkspaces(this.store);

                // Only folders the list already shows.
                const folders = new Set([
                    ...chats.flatMap(row => row.folders[0] ? [folderKey(row.folders[0])] : []),
                    ...workspaces.map(workspaceKey)
                ]);

                return sendJson(response, 200, { chats, aliases: this.aliases(), workspaces, kiro: this.kiro.listed(folders) });
            }

            case API.openKiro: {

                const row = typeof body.sessionId === "string" ? this.kiro.row(body.sessionId) : undefined;

                if (!row)
                    return sendJson(response, 404, { problem: "That Kiro session is not in the list any more. Reload the page." });

                try {

                    const chatId = await this.kiro.open(row, (id, folders) => writeSession(id, { folders, scratch: false }));

                    // On Kiro's runtime, under Kiro's name.
                    await this.store.update(PICK_PREFIX + chatId, { provider: row.runtime });

                    const titles = this.store.get<unknown>(TITLES_KEY);

                    await this.store.update(TITLES_KEY, { ...(titles && typeof titles === "object" ? titles : {}), [chatId]: row.title });

                    this.toAll({ type: "eesha.listChanged" });

                    return sendJson(response, 200, { chatId });

                } catch (error) {

                    return sendJson(response, 502, { problem: `Could not open the Kiro session: ${(error as Error).message}` });
                }
            }

            case API.deleteKiro:
            case API.renameKiro: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                const row = typeof body.sessionId === "string" ? this.kiro.row(body.sessionId) : undefined;

                if (!row)
                    return sendJson(response, 404, { problem: "That Kiro session is not in the list any more. Reload the page." });

                const deleting = route === API.deleteKiro;

                if (deleting && row.working)
                    return sendJson(response, 409, { problem: "Kiro says this session is working now. Stop it in Kiro first, then delete it." });

                // The question waits for the person; a note says when Kiro refused.
                void (deleting ? this.deleteKiroRow(entry, row) : this.renameKiroRow(entry, row));

                return sendJson(response, 200, { ok: true });
            }

            case API.aiOptions:
                return sendJson(response, 200, await this.aiOptions());

            case API.saveWorkspace: {

                // Only the runtime ids - no model list is fetched for a save.
                const checked = checkWorkspace(body, await providerIds(serverAiEnv(text => this.toAll({ type: "eesha.note", text }))));

                if ("problem" in checked)
                    return sendJson(response, 400, checked);

                // With a key: the workspace changed. Its main folder stays -
                // its sessions and SDD are kept under it.
                const editKey = typeof body.key === "string" && body.key ? body.key : undefined;
                const existing = editKey ? workspaceByKey(this.store, editKey) : undefined;

                if (editKey && !existing)
                    return sendJson(response, 404, { problem: "That workspace is not in the list any more. Reload the page." });

                if (existing && folderKey(existing.folders[0]!) !== folderKey(checked.workspace.folders[0]!))
                    return sendJson(response, 400, { problem: "A workspace keeps its main folder. Add a new workspace for another one." });

                // The link: the saved one when the page sent its path back
                // unchanged - no connector call, so an edit saves even when
                // the connector cannot be reached. Else asked of the connector.
                let link: WorkspaceLink | undefined;

                if (checked.linkPath) {

                    const saved = existing?.link;

                    if (saved && saved.path.join(">").toLowerCase() === checked.linkPath.join(">").toLowerCase())
                        link = saved;
                    else {

                        const made = await this.connectors.linkItem(checked.linkPath);

                        if ("problem" in made)
                            return sendJson(response, 400, made);

                        link = made.link;
                    }
                }

                // A new one: a second workspace on the same main folder gets a key of its own.
                const now = Date.now();
                const id = existing ? existing.id : newWorkspaceId(this.store, checked.workspace.folders[0]!, now);
                const created = existing ? existing.created : now;

                const workspace = {
                    ...(id ? { id } : {}),
                    ...(created !== undefined ? { created } : {}),
                    ...(existing?.archived ? { archived: true as const } : {}),
                    ...checked.workspace,
                    ...(link ? { link } : {}),
                    name: checked.workspace.name ?? defaultWorkspaceName(checked.workspace.folders[0]!, this.aliases())
                };

                await saveWorkspace(this.store, workspace);
                await rememberFolders(this.store, workspace.folders);

                this.toAll({ type: "eesha.listChanged" });

                return sendJson(response, 200, { ok: true });
            }

            case API.workspaceItem: {

                const path = stringList(body.path);

                if (!path?.length)
                    return sendJson(response, 400, { problem: "Say which item." });

                const made = await this.connectors.linkItem(path);

                return sendJson(response, "problem" in made ? 400 : 200, made);
            }

            case API.archiveWorkspace: {

                if (typeof body.key !== "string" || !body.key || typeof body.archived !== "boolean")
                    return sendJson(response, 400, { problem: "Send the workspace's key, and archived as true or false." });

                if (!await archiveWorkspace(this.store, body.key, body.archived))
                    return sendJson(response, 404, { problem: "That workspace is not in the list any more. Reload the page." });

                this.toAll({ type: "eesha.listChanged" });

                return sendJson(response, 200, { ok: true });
            }

            case API.removeWorkspace: {

                const key = typeof body.key === "string" && body.key ? body.key
                    : typeof body.folder === "string" && path.isAbsolute(body.folder) ? folderKey(body.folder) : undefined;

                if (!key)
                    return sendJson(response, 400, { problem: "Send the workspace's key." });

                await removeWorkspace(this.store, key);

                this.toAll({ type: "eesha.listChanged" });

                return sendJson(response, 200, { ok: true });
            }

            case API.sessionInfo: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                // The same files, in the same order, that instructions.ts
                // reads when a session starts.
                const instructionFiles: SessionInfo["instructionFiles"] = [];

                for (const [name, kiroOnly] of [["system.md", false], ["kiro.md", true]] as const)
                    for (const folder of entry.host.userFolders()) {

                        const file = path.join(folder, INSTRUCTIONS_FOLDER, name);

                        if (fs.existsSync(file))
                            instructionFiles.push({ path: file, ...(kiroOnly ? { kiroOnly } : {}) });
                    }

                const info: SessionInfo = {
                    instructionFiles,
                    sentServers: this.connectors.connected() || this.memory.on() ? [CONNECTORS_SERVER_NAME] : []
                };

                return sendJson(response, 200, info);
            }

            case API.workspaceName: {

                const folder = body.folder;
                const key = typeof body.key === "string" && body.key ? body.key : undefined;
                const name = typeof body.name === "string" ? body.name.trim() : undefined;

                if (typeof folder !== "string" || !path.isAbsolute(folder) || name === undefined)
                    return sendJson(response, 400, { problem: "Send a full folder path and its name - empty to show the folder's own name." });

                if (name.length > ALIAS_LIMIT || /[\r\n]/.test(name))
                    return sendJson(response, 400, { problem: `A name is one line of up to ${ALIAS_LIMIT} characters.` });

                // A workspace keeps its own name; any other folder an alias.
                const workspace = key ? workspaceByKey(this.store, key) : workspaceAt(this.store, folder);

                if (workspace)
                    await saveWorkspace(this.store, { ...workspace, name: name || defaultWorkspaceName(workspace.folders[0]!, {}) });
                else
                    await this.setAlias(folder, name);

                this.toAll({ type: "eesha.listChanged" });

                return sendJson(response, 200, { ok: true });
            }

            case API.deleteChats: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                const chatIds = body.chatIds;
                const where = body.where;

                // A row's own Delete: one session, named in the question.
                const one = body.row === true;

                if (!Array.isArray(chatIds) || !chatIds.length || chatIds.length > DELETE_LIMIT || !chatIds.every(isChatId)
                    || (one && chatIds.length !== 1)
                    || (!one && (typeof where !== "string" || !where.trim() || where.length > WHERE_LIMIT || /[\r\n]/.test(where))))
                    return sendJson(response, 400, { problem: "Send the session ids to delete and where they are listed." });

                // Only chats the list shows - the question counts them.
                const listed = new Map(this.chatRows().map(row => [row.chatId, row]));
                const rows = [...new Set(chatIds)].flatMap(chatId => listed.get(chatId) ?? []);

                if (!rows.length)
                    return sendJson(response, 404, { problem: "Those sessions are not here any more." });

                const question = one
                    ? rowDeleteQuestion(rows[0]!)
                    : deleteQuestion(
                        rows.length,
                        rows.filter(row => row.mark === "pinned").length,
                        rows.filter(row => row.mark === "archived").length,
                        (where as string).trim());

                // The question waits for the person; the chat says itself what came of it.
                void this.deleteRows(entry, rows, question);

                return sendJson(response, 200, { ok: true });
            }

            case API.exportChat: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                const exported = entry.controller.exportText();

                if (!exported)
                    return sendJson(response, 400, { problem: "Nothing was said in this session yet, so there is nothing to export." });

                return sendJson(response, 200, exported);
            }

            case API.searchChats: {

                const query = body.query;

                if (typeof query !== "string" || query.length > SEARCH_LIMIT)
                    return sendJson(response, 400, { problem: `Send the text to search for, up to ${SEARCH_LIMIT} characters.` });

                // Only chats the list shows: a file with no saved folders cannot be opened here.
                const hits = searchChats(undefined, query)
                    .filter(hit => readSession(hit.id))
                    .map(hit => ({ chatId: hit.id, line: hit.line }));

                return sendJson(response, 200, { hits });
            }

            case API.markChat: {

                const chatId = body.chatId;
                const mark = body.mark;

                if (!isChatId(chatId) || !(mark === null || isChatMark(mark)))
                    return sendJson(response, 400, { problem: "Send a session id and a mark: \"pinned\", \"archived\" or null." });

                if (!readSession(chatId))
                    return sendJson(response, 404, { problem: "This session is not here any more." });

                await this.setMark(chatId, mark);

                this.toAll({ type: "eesha.listChanged" });

                return sendJson(response, 200, { ok: true });
            }

            case API.reply: {

                const tab = this.tabOf(body.view);

                const id = typeof body.id === "number" ? body.id : undefined;

                const answer = id !== undefined ? tab?.prompts.get(id) : undefined;

                if (tab && id !== undefined && answer) {

                    tab.prompts.delete(id);
                    answer(typeof body.value === "string" ? body.value : undefined);
                }

                return sendJson(response, 200, { ok: true });
            }

            case API.files: {

                const entry = this.tabOf(body.view)?.chat;

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                const host = entry.host;

                if (body.path === undefined)
                    return sendJson(response, 200, {
                        entries: host.folders().map(folder => ({
                            name: samePath(folder, host.scratchFolder()) ? "Scratch folder" : path.basename(folder) || folder,
                            path: folder,
                            folder: true
                        }))
                    });

                const folder = paneTarget(host, body.path);

                if (typeof folder !== "string")
                    return sendJson(response, 403, folder);

                try {

                    return sendJson(response, 200, { entries: await listFiles(folder) });

                } catch (error) {

                    // The scratch folder is made when the agent first starts in it.
                    if ((error as NodeJS.ErrnoException).code === "ENOENT" && samePath(folder, host.scratchFolder()))
                        return sendJson(response, 200, { entries: [] });

                    return sendJson(response, 200, { problem: (error as Error).message });
                }
            }

            case API.file: {

                const entry = this.tabOf(body.view)?.chat;

                // A tab showing a spec: a file inside its workspace.
                const spec = !entry && typeof body.view === "string" ? this.sdd.shownIn(body.view) : undefined;

                if (spec) {

                    const file = typeof body.path === "string" && path.isAbsolute(body.path) ? path.resolve(body.path) : undefined;

                    if (!file || !placeRoots(spec.place).some(folder => isInside(folder, file)))
                        return sendJson(response, 403, { problem: "Only files inside this workspace are shown here." });

                    return sendJson(response, 200, readShown(file));
                }

                if (!entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                // A steering file or CLAUDE.md the context window lists and
                // this chat was already shown: read wherever it is. Any
                // other file only inside the chat's folders.
                const listed = typeof body.path === "string" && path.isAbsolute(body.path) && entry.host.mayShow(path.resolve(body.path));

                const file = listed ? path.resolve(body.path as string) : paneTarget(entry.host, body.path);

                if (typeof file !== "string")
                    return sendJson(response, 403, file);

                return sendJson(response, 200, readShown(file));
            }

            case API.shells:
                return sendJson(response, 200, { shells: this.shells().map(({ id, label, kind }) => ({ id, label, kind })) });

            case API.run: {

                const tab = this.tabOf(body.view);
                const entry = tab?.chat;

                if (!tab || !entry)
                    return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

                const { code, shell, folder } = body;

                if (typeof code !== "string" || !code.trim() || code.length > COMMAND_LIMIT)
                    return sendJson(response, 400, { problem: `Send the command to run, up to ${COMMAND_LIMIT} characters.` });

                const picked = this.shells().find(one => one.id === shell);

                if (!picked)
                    return sendJson(response, 400, { problem: "That shell is not on this machine." });

                // Only one of the folders the agent works in - the page lists the same ones.
                const where = typeof folder === "string" ? entry.host.folders().find(one => samePath(one, folder)) : undefined;

                if (!where)
                    return sendJson(response, 403, { problem: "Commands run only in this session's workspace." });

                // The scratch folder is made when the agent first starts in it.
                fs.mkdirSync(where, { recursive: true });

                return sendJson(response, 200, { id: this.runs.start(tab.id, picked, code, where) });
            }

            case API.runStop:
                if (typeof body.view === "string" && typeof body.id === "string")
                    this.runs.stop(body.view, body.id);

                return sendJson(response, 200, { ok: true });

            case API.gitStatus:
            case API.gitLists:
            case API.gitCommits:
            case API.gitCommitFiles:
            case API.gitDiff:
            case API.gitAction:
            case API.gitWatch:
            case API.gitMessage:
                return this.git(response, route, body);

            case API.settings:
                return sendJson(response, 200, await settingsView(this.port, this.scratchInUse()));

            case API.freePort:
                return sendJson(response, 200, { port: await freePort() });

            case API.settingsChange:
            case API.settingsSave:
            case API.runtimeAdd:
            case API.runtimeRemove: {

                const result = route === API.settingsSave
                    ? await saveSettingsText(body.text as string)
                    : route === API.runtimeAdd
                        ? await addRuntime(body as NewRuntime)
                        : route === API.runtimeRemove
                            ? await removeRuntime(body.id)
                            : await changeSettings(body as SettingsChange);

                if ("problem" in result)
                    return sendJson(response, 400, result);

                this.settingsWritten();

                return sendJson(response, 200, await settingsView(this.port, this.scratchInUse()));
            }

            case API.connectors:
            case API.connectorSignIn:
            case API.connectorSave:
            case API.connectorRemove:
                return this.connectorApi(response, route, body);

            case API.memory:
            case API.memoryChoices:
            case API.memorySave:
            case API.memoryRemove:
            case API.memoryRepoint:
                return this.memoryApi(response, route, body);

            case API.emptyTrash:

                emptyTrash();

                return sendJson(response, 200, await settingsView(this.port, this.scratchInUse()));

            case API.removeScratch:

                removeOrphanScratch(this.scratchInUse());

                return sendJson(response, 200, await settingsView(this.port, this.scratchInUse()));

            case API.updateCheck:
                return sendJson(response, 200, await checkForUpdate());

            case API.updateStart:
                return this.upgrade(response, body.version);

            case API.sdd:
            case API.sddSpecs:
            case API.sddOpen:
            case API.sddOffers:
            case API.sddCreate:
            case API.sddCopyOffers:
            case API.sddCopyStyle:
            case API.sddSort:
            case API.sddClearHistory:
            case API.sddExplorer:
            case API.sddArchive:
            case API.sddRecent:
            case API.sddSessions:
            case API.sddWidget:
            case API.sddStart:
            case API.sddCommand:
            case API.sddPick:
            case API.sddPickLink:
                return this.sddApi(response, route, body);

            case API.evalList:
            case API.evalGet:
            case API.evalCreate:
            case API.evalSend:
            case API.evalTasks:
            case API.evalVariantAdd:
            case API.evalStop:
            case API.evalReport:
            case API.evalPick:
            case API.evalVariantRemove:
            case API.evalDelete:
                return this.evalApi(response, route, body);
        }

        sendJson(response, 404, { problem: "Not found." });
    }

    /**
     * The git panel's requests.
     * Only the repositories this tab's chat's folders give; nothing that
     * changes a repository while the chat's agent is working.
     */
    private async git(response: http.ServerResponse, route: string, body: Record<string, unknown>): Promise<void> {

        const tab = this.tabOf(body.view);
        const entry = tab?.chat;

        if (!tab || !entry)
            return sendJson(response, 409, { problem: "This tab shows no session - reload the page." });

        if (route === API.gitMessage && body.stop === true) {

            tab.gitJob?.stop();

            return sendJson(response, 200, { ok: true });
        }

        const repos = await findRepos(entry.host.userFolders());

        if (route === API.gitWatch) {

            if (body.on === true) {

                tab.gitWatch ??= new RepoWatch(root => this.send(tab, { type: "eesha.gitChanged", root }));
                tab.gitWatch.set(repos.map(repo => repo.root));

            } else {

                tab.gitWatch?.close();
                tab.gitWatch = undefined;
            }

            return sendJson(response, 200, { ok: true });
        }

        if (route === API.gitStatus) {

            // The folders may have changed since the watch started.
            tab.gitWatch?.set(repos.map(repo => repo.root));

            const read = await Promise.all(repos.map(async repo => {

                try {

                    return { status: await repoStatus(repo) };

                } catch (error) {

                    return { problem: { root: repo.root, problem: (error as Error).message } };
                }
            }));

            return sendJson(response, 200, {
                repos: read.flatMap(one => one.status ? [one.status] : []),
                problems: read.flatMap(one => one.problem ? [one.problem] : [])
            });
        }

        const repo = repoOf(repos, body.root);

        if (!repo)
            return sendJson(response, 404, { problem: "That repository is not in this session's workspace any more." });

        try {

            switch (route) {

                case API.gitLists:
                    return sendJson(response, 200, await repoLists(repo));

                case API.gitCommits:
                    return sendJson(response, 200, { commits: await commitList(repo) });

                case API.gitCommitFiles:
                    return sendJson(response, 200, { files: await commitFiles(repo, typeof body.hash === "string" && /^[0-9a-f]{4,64}$/i.test(body.hash) ? body.hash : "-") });

                case API.gitDiff: {

                    const ask = body.ask as Record<string, unknown> | undefined;

                    if (!ask || !["staged", "changes", "conflict", "commit"].includes(ask.side as string))
                        return sendJson(response, 400, { problem: "Say which diff to show." });

                    return sendJson(response, 200, await fileDiff(repo, ask as never));
                }

                case API.gitAction: {

                    if (entry.controller.working)
                        return sendJson(response, 409, { problem: "The agent is working. Wait for it to finish, or stop it, then try again." });

                    if (!isGitAction(body.action))
                        return sendJson(response, 400, { problem: "Not a git action." });

                    const text = await runAction(repo, body.action, { trash: moveToTrash });

                    return sendJson(response, 200, { ok: true, ...(text ? { text } : {}) });
                }

                case API.gitMessage: {

                    if (tab.gitJob)
                        return sendJson(response, 409, { problem: "Already writing a message - click the AI button again to stop it." });

                    let stopped = false;
                    let stopSession: (() => void) | undefined;

                    const job = { stop: () => { stopped = true; stopSession?.(); } };

                    tab.gitJob = job;

                    try {

                        const message = await writeCommitMessage({
                            ai: await entry.controller.sideJobAi(),
                            root: repo.root,
                            workerPath: this.workerPath,
                            onStop: stop => { stopSession = stop; },
                            stopped: () => stopped
                        });

                        return sendJson(response, 200, { message });

                    } finally {

                        if (tab.gitJob === job)
                            tab.gitJob = undefined;
                    }
                }
            }

        } catch (error) {

            // Git's own words for a git failure; ours for a check that refused.
            if (!(error instanceof GitError))
                logger.warning(`Eesha Code: git panel ${route} failed. ${(error as Error).message}`);

            return sendJson(response, 200, { problem: (error as Error).message });
        }

        sendJson(response, 404, { problem: "Not found." });
    }

    /** The last upgrade from the page, for five minutes after this server started. */
    private recentUpgrade(): UpgradedView | undefined {

        const upgraded = this.options.upgraded;

        return upgraded && Date.now() - upgraded.at < 5 * 60_000 ? upgraded : undefined;
    }

    /**
     * A click on the footer's version (see update.ts). Refused while a
     * session works - the restart would end its turn.
     *
     * From source: `npm run build` while this server still runs - a
     * failed build leaves it running - then it restarts itself.
     * From npm: a helper is started and this server stops; the helper
     * installs `version` and starts Eesha Code again.
     */
    private async upgrade(response: http.ServerResponse, version: unknown): Promise<void> {

        const working = [...this.chats].filter(entry => entry.controller.working).length + this.sdd.working;

        if (working)
            return sendJson(response, 409, { problem: `${working === 1 ? "A session is" : `${working} sessions are`} working. Stop ${working === 1 ? "it" : "them"} or let ${working === 1 ? "it" : "them"} finish, then upgrade.` });

        if (this.upgrading)
            return sendJson(response, 409, { problem: "An upgrade already runs." });

        const kind = installKind();

        if (kind === "npm" && !isVersion(version))
            return sendJson(response, 400, { problem: "Say which version to install." });

        this.upgrading = true;

        try {

            if (kind === "source") {

                logger.info("Eesha Code: npm run build, from a click on the version.");

                const built = await buildFromSource();

                if ("problem" in built) {

                    this.upgrading = false;

                    logger.warning(`Eesha Code: the build failed. ${built.problem}`);

                    return sendJson(response, 200, built);
                }

                noteRebuilt();

                logger.info("Eesha Code: built - restarting.");

                sendJson(response, 200, { ok: true });

                return this.options.onRestart();
            }

            startUpgradeHelper(version as string);

        } catch (error) {

            this.upgrading = false;

            return sendJson(response, 200, { problem: `Could not start the upgrade. ${(error as Error).message}` });
        }

        logger.info(`Eesha Code: upgrading to ${version as string} - stopping, the helper starts it again.`);

        sendJson(response, 200, { ok: true });

        this.options.onStop();
    }

    /** The chats this server holds, by id, and the scratch folders they use - never counted as left over. */
    private scratchInUse(): Set<string> {

        return new Set([...this.chats].flatMap(entry => [entry.controller.chatId, path.basename(entry.host.scratchFolder())]));
    }

    /**
     * settings.json was written from the settings page. A new theme shows
     * in every tab at once. Every chat on screen gets its flags and its
     * runtime list again. A turn already running keeps what it started with.
     */
    private settingsWritten(): void {

        const { theme, fontSize } = serverSettingsFrom(readJson(eeshaPath("settings.json")));

        if (theme !== this.theme) {

            this.theme = theme;

            this.toAll({ type: "eesha.theme", theme });
        }

        if (fontSize !== this.fontSize) {

            this.fontSize = fontSize;

            this.toAll({ type: "eesha.fontSize", fontSize });
        }

        // The Evaluator's link shows from the next page load.
        void evalsOn().then(on => { this.evals = on; });

        for (const entry of this.chats)
            if (entry.tab)
                void entry.controller.settingsChanged().catch(error =>
                    logger.warning(`Eesha Code: could not send the new settings to session ${entry.controller.chatId}. ${(error as Error).message}`));
    }

    // ---------------------------------------------------------------
    // Tabs and chats
    // ---------------------------------------------------------------

    /**
     * One tab's event stream. With a chat id, that chat is drawn in the
     * tab - taken from another tab if one shows it. The page waits for
     * the hello before it sends anything.
     */
    private events(request: http.IncomingMessage, response: http.ServerResponse, url: URL): void {

        const view = url.searchParams.get("view") ?? "";
        const chatId = url.searchParams.get("chat") ?? undefined;

        if (!VIEW_ID.test(view))
            return sendText(response, 400, "Bad view id.");

        if (chatId !== undefined && !isChatId(chatId))
            return sendText(response, 400, "Bad session id.");

        response.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store",
            Connection: "keep-alive"
        });

        response.write(": open\n\n");

        const tab: Tab = {
            id: view,
            response,
            prompts: new Map(),
            ping: setInterval(() => response.write(": ping\n\n"), PING_MS)
        };

        request.on("close", () => this.endTab(tab));

        this.openTab(tab, chatId);
    }

    /**
     * A tab that came: its chat drawn, and the hello sent. The same id
     * again is a reconnect after the network or the server blinked - the
     * old one ends.
     */
    private openTab(tab: Tab, chatId: string | undefined): void {

        const view = tab.id;
        const old = this.tabs.get(view);

        if (old)
            this.endTab(old);

        this.tabs.set(view, tab);

        const entry = chatId !== undefined ? this.entryFor(chatId) : undefined;

        if (entry)
            this.attach(entry, tab);

        // The chat this tab showed before may be an empty one left behind.
        if (chatId !== undefined)
            this.sweepEmpty(chatId);

        this.send(tab, { type: "eesha.hello", view, theme: this.theme, fontSize: this.fontSize, evals: this.evals, version: packageVersion(), install: installKind(), ...(entry ? { chat: this.infoOf(entry) } : {}), ...(this.recentUpgrade() ? { upgraded: this.recentUpgrade() } : {}) });

        if (chatId !== undefined && !entry)
            this.send(tab, { type: "eesha.unknownChat", chatId });
    }

    private shells(): Shell[] {

        return this.shellList ??= findShells();
    }

    private tabOf(view: unknown): Tab | undefined {

        return typeof view === "string" ? this.tabs.get(view) : undefined;
    }

    /** The chat kept for this id, or a new one for a chat that has folders saved. */
    private entryFor(chatId: string): ChatEntry | undefined {

        for (const entry of this.chats)
            if (entry.controller.chatId === chatId)
                return entry;

        const saved = readSession(chatId);

        if (!saved)
            return this.evals ? this.evalEntry(chatId) : undefined;

        const host = new ServerChatHost(this, saved);
        const controller = new ChatController(host, chatId);

        host.bind(controller);

        const entry: ChatEntry = { controller, host };

        this.chats.add(entry);

        return entry;
    }

    // ---------------------------------------------------------------
    // The Evaluator (see evals.ts)
    // ---------------------------------------------------------------

    /** A new chat for a variant of an evaluation, when the id is one's. It is kept and let go like any chat. */
    private evalEntry(chatId: string): ChatEntry | undefined {

        const found = evalOfChat(chatId);

        if (!found)
            return undefined;

        const host = new EvalChatHost(this, found.saved, found.variant, this.evalStore(found.saved.name));
        const controller = new ChatController(host, chatId);

        host.bind(controller);

        const entry: ChatEntry = { controller, host };

        this.chats.add(entry);

        return entry;
    }

    /** One evaluation's own saved values - its variants' runtime and model picks. */
    private evalStore(name: string): FileStore {

        let store = this.evalStores.get(name);

        if (!store) {

            store = new FileStore(evalStateFile(name));
            this.evalStores.set(name, store);
        }

        return store;
    }

    private evalWorking(chatId: string): boolean {

        return [...this.chats].some(entry => entry.controller.chatId === chatId && entry.controller.working);
    }

    private evalView(saved: SavedEval): EvalView {

        // A chat file with a message in it, or its send written down: that variant was started - as the send counts it.
        const started = new Set(listChats(evalDir(saved.name)).map(chat => chat.id));

        return {
            name: saved.name,
            folder: saved.folder,
            createdAt: saved.createdAt,
            ...(saved.start ? { commit: saved.start.commit.slice(0, 7) } : {}),
            variants: saved.variants.map(variant => ({
                name: variant.name,
                chatId: variant.chatId,
                runtime: variant.provider,
                ...(variant.model ? { model: variant.model } : {}),
                ...(variant.mode ? { mode: variant.mode } : {}),
                ...(variant.effort ? { effort: variant.effort } : {}),
                ...(variant.extra ? { extra: variant.extra } : {}),
                ...(variant.ran?.version ? { version: variant.ran.version } : {}),
                addedAt: variant.addedAt,
                started: started.has(variant.chatId) || variant.ran !== undefined,
                working: this.evalWorking(variant.chatId)
            })),
            ...(saved.sent ? { sent: saved.sent } : {}),
            ...(saved.pick ? { pick: saved.pick } : {})
        };
    }

    evalChanged(name: string): void {

        this.toAll({ type: "eesha.evalChanged", name });
    }

    /** The Evaluator page's requests. Every one is refused while the `evals` flag is off. */
    private async evalApi(response: http.ServerResponse, route: string, body: Record<string, unknown>): Promise<void> {

        if (!this.evals)
            return sendJson(response, 403, { problem: "The Evaluator is turned off. Turn on the 'evals' flag in Settings, under Features." });

        if (route === API.evalList) {

            const evals: EvalRow[] = evalNames().flatMap(name => {

                const saved = readEval(name);

                return saved ? [{ name, folder: saved.folder, createdAt: saved.createdAt, variants: saved.variants.length }] : [];
            });

            return sendJson(response, 200, { evals });
        }

        if (route === API.evalTasks)
            return sendJson(response, 200, { ...evalTasks(), folder: evalTasksDir() });

        const name = body.name;

        if (!isEvalName(name))
            return sendJson(response, 400, { problem: "A name is letters, digits, - and _ only, up to 60, and starts with a letter or digit." });

        if (route === API.evalGet) {

            const saved = readEval(name);

            return sendJson(response, 200, saved ? { eval: this.evalView(saved) } : {});
        }

        if (route === API.evalCreate)
            return this.evalCreate(response, name, body);

        const saved = readEval(name);

        if (!saved)
            return sendJson(response, 404, { problem: `There is no evaluation named '${name}'.` });

        switch (route) {

            case API.evalSend:
                return this.evalSend(response, saved, body);

            case API.evalVariantAdd:
                return this.evalVariantAdd(response, saved, body);

            case API.evalStop:
                return this.evalStop(response, saved, body);

            case API.evalReport:
                return this.evalReport(response, saved);

            case API.evalPick:
                return this.evalPick(response, saved, body);

            case API.evalVariantRemove:
                return this.evalVariantRemove(response, saved, body);

            case API.evalDelete:
                return this.evalDelete(response, saved);
        }

        return sendJson(response, 404, { problem: "Not found." });
    }

    /** Send to all, or Send to new variants: the kept message - nothing is typed on the evaluation's page. */
    private async evalSend(response: http.ServerResponse, saved: SavedEval, body: Record<string, unknown>): Promise<void> {

        const sent = await this.sendToVariants(saved, body.onlyNew === true);

        return sent.problem ? sendJson(response, sent.status, { problem: sent.problem }) : sendJson(response, 200, { ok: true });
    }

    /** Says which variants would get nothing: no common message, and no text of their own. */
    private emptyVariants(text: string, variants: readonly Pick<EvalVariant, "name" | "extra">[]): string | undefined {

        const empty = variants.filter(variant => !variantMessage(text, variant));

        if (!empty.length)
            return undefined;

        return empty.length === variants.length
            ? "Type a common message, or a text of its own for every variant."
            : `Nothing to send to ${empty.map(variant => variant.name).join(", ")}: type a common message, or a text of ${empty.length === 1 ? "its" : "their"} own.`;
    }

    /**
     * Sends each variant its one message: the kept message to all, with
     * the variant's own text under it (either may be empty, not both). All
     * start at the same moment, or none.
     *
     * A variant gets one message, ever - a second one would spoil the
     * comparison. Without `onlyNew` it goes only while no variant got one:
     * right after the evaluation is made, or with Send to all when that
     * send did not go. `onlyNew` (Send to new variants) sends to the
     * variants that never got one - added later - so they get exactly
     * what the others got.
     *
     * Each runtime's version is written down first, so the report can
     * say months later what each variant ran on.
     */
    private async sendToVariants(saved: SavedEval, onlyNew: boolean): Promise<{ problem?: string; status: number }> {

        const name = saved.name;

        // Its send was written down, a chat file with a message in it, or a turn running: that variant got its message.
        // The send is written down before the message goes, so a second press a moment later is refused.
        const started = new Set(listChats(evalDir(name)).map(chat => chat.id));
        const done = (variant: EvalVariant) => variant.ran !== undefined || started.has(variant.chatId) || this.evalWorking(variant.chatId);

        if (!onlyNew && saved.variants.some(done))
            return { status: 409, problem: "Each variant gets one message, and some already got theirs. Use Send to new variants for the ones that did not." };

        const targets = saved.variants.filter(variant => !done(variant));

        if (!targets.length)
            return { status: 400, problem: "Every variant already got its message. Add a variant first." };

        // The message kept with the evaluation. One made before the message was typed at create may have none yet.
        const typed = saved.sent?.text ?? "";
        const taskName = saved.sent?.task;

        // A find or fix task's closing lines, which ask for the findings in one form: as they were when the
        // evaluation was made. An older evaluation kept only the task's name: its lines are read from the task now.
        let closing = saved.sent?.closing;

        if (closing === undefined && taskName !== undefined) {

            const task = evalTasks().tasks.find(one => one.name === taskName);

            if (!task)
                return { status: 400, problem: `The saved task '${taskName}' is not there any more. Put its file back in ${evalTasksDir()}.` };

            closing = taskClosing(task.kind);
        }

        const empty = this.emptyVariants(typed, targets);

        if (empty)
            return { status: 400, problem: empty };

        // The common message, the variant's own text under it, and a task's closing lines last of all.
        const messageOf = (variant: EvalVariant): string => {

            const joined = variantMessage(typed, variant);

            return closing ? `${joined}\n\n${closing}` : joined;
        };

        if (this.evalsMaking.has(name.toLowerCase()))
            return { status: 409, problem: "This evaluation is being changed right now. Try again in a moment." };

        const entries = targets.map(variant => this.entryFor(variant.chatId));

        if (entries.some(entry => entry === undefined))
            return { status: 500, problem: "One of the variants could not be opened - see the server's log." };

        this.evalsMaking.add(name.toLowerCase());

        try {

            // Asked before the turns start: asking a runtime starts its program, which must not run beside the turns being timed.
            const providers = [...new Set(targets.map(variant => variant.provider))];
            const versions = new Map(await Promise.all(providers.map(async provider => [provider, await runtimeVersion(provider)] as const)));

            const at = Date.now();
            const now = readEval(name) ?? saved;
            const sentNow = targets.map(variant => variant.chatId);

            writeEval({
                ...now,
                // Kept even when empty: the top box then stays empty and locked, as it was sent.
                ...(now.sent ? {} : { sent: { text: typed, ...(taskName ? { task: taskName } : {}), ...(closing !== undefined ? { closing } : {}), at } }),
                variants: now.variants.map(variant => {

                    if (!sentNow.includes(variant.chatId))
                        return variant;

                    const version = versions.get(variant.provider);

                    return { ...variant, ran: { at, ...(version ? { version } : {}) } };
                })
            });

            for (const [index, entry] of entries.entries()) {

                // With no frame showing it yet, it is let go once idle - like a chat whose tab closed.
                if (!entry!.tab)
                    this.waitForTab(entry!);

                entry!.controller.receive({ type: "send", text: messageOf(targets[index]!) });
            }

        } finally {

            this.evalsMaking.delete(name.toLowerCase());
        }

        this.evalChanged(name);

        return { status: 200 };
    }

    /**
     * What the page asked a variant to be, checked: a runtime on offer,
     * and one-line values. The name is checked by the caller - a new
     * variant may have none.
     */
    private checkVariantAsk(value: unknown, runtimes: readonly string[]): { ask: VariantSetup & { name?: string } } | { problem: string } {

        const one = value && typeof value === "object" ? value as Record<string, unknown> : {};
        const picked = checkStartPick({ runtime: one.runtime, model: one.model }, runtimes);

        if ("problem" in picked)
            return picked;

        if (!picked.pick.runtime)
            return { problem: "pick a runtime." };

        const line = (asked: unknown, what: string): { value?: string } | { problem: string } => {

            if (asked === undefined || asked === null || asked === "")
                return {};

            return typeof asked === "string" && asked.trim() && asked.length <= EVAL_OPTION_LIMIT && !/[\r\n]/.test(asked)
                ? { value: asked.trim() }
                : { problem: `the ${what} is one line of up to ${EVAL_OPTION_LIMIT} characters.` };
        };

        const mode = line(one.mode, "mode");

        if ("problem" in mode)
            return mode;

        const effort = line(one.effort, "effort");

        if ("problem" in effort)
            return effort;

        if (one.extra !== undefined && (typeof one.extra !== "string" || one.extra.length > EVAL_TEXT_MAX))
            return { problem: `the extra text is up to ${EVAL_TEXT_MAX} characters.` };

        const extra = typeof one.extra === "string" ? one.extra.trim() : "";
        const name = typeof one.name === "string" && one.name.trim() ? one.name.trim() : undefined;

        return {
            ask: {
                ...(name ? { name } : {}),
                provider: picked.pick.runtime,
                ...(picked.pick.model ? { model: picked.pick.model } : {}),
                ...(mode.value ? { mode: mode.value } : {}),
                ...(effort.value ? { effort: effort.value } : {}),
                ...(extra ? { extra } : {})
            }
        };
    }

    /** A variant's runtime, model, mode and effort, saved as its chat's pick - the chat runs on it. */
    private async saveVariantPick(name: string, variant: EvalVariant): Promise<void> {

        await this.evalStore(name).update(PICK_PREFIX + variant.chatId, {
            provider: variant.provider,
            ...(variant.model ? { model: variant.model } : {}),
            ...(variant.mode ? { mode: variant.mode } : {}),
            ...(variant.effort ? { effort: variant.effort } : {})
        });
    }

    private evalRuntimes(): Promise<string[]> {

        return providerIds(serverAiEnv(text => this.toAll({ type: "eesha.note", text })));
    }

    /**
     * Makes an evaluation and sends it: the folder's starting point is
     * saved, each variant gets its own copy and its setup, the message to
     * all is kept, and every variant gets its one message. Everything is
     * typed on the create page; the evaluation's own page only watches.
     * When making it fails, what was made is removed and the name is free
     * again. When only the send fails, the evaluation stays.
     */
    private async evalCreate(response: http.ServerResponse, name: string, body: Record<string, unknown>): Promise<void> {

        // By folder too: on Windows 'Login' and 'login' are one folder.
        if (this.evalsMaking.has(name.toLowerCase()) || readEval(name) || fs.existsSync(evalDir(name)))
            return sendJson(response, 409, { problem: `There is already an evaluation named '${name}'. Open it, or pick another name.` });

        const checked = checkFolders(typeof body.folder === "string" && body.folder ? [body.folder] : []);

        if ("problem" in checked)
            return sendJson(response, 400, checked);

        const folder = checked.folders[0];

        if (!folder)
            return sendJson(response, 400, { problem: "Pick the folder the variants work on." });

        const asked = Array.isArray(body.variants) ? body.variants as unknown[] : [];

        if (!asked.length || asked.length > EVAL_VARIANTS_MAX)
            return sendJson(response, 400, { problem: `Add 1 to ${EVAL_VARIANTS_MAX} variants.` });

        const runtimes = await this.evalRuntimes();
        const variants: (VariantSetup & { name: string })[] = [];

        for (const [index, value] of asked.entries()) {

            const one = this.checkVariantAsk(value, runtimes);

            if ("problem" in one)
                return sendJson(response, 400, { problem: `Variant ${index + 1}: ${one.problem}` });

            // No name given: the evaluation's name and a number.
            const variantName = one.ask.name ?? `${name}-${index + 1}`;

            if (!isEvalName(variantName))
                return sendJson(response, 400, { problem: `Variant ${index + 1}: '${variantName}' is not a name. Use letters, digits, - and _ only, up to 60.` });

            if (variants.some(other => other.name.toLowerCase() === variantName.toLowerCase()))
                return sendJson(response, 400, { problem: `Two variants are named '${variantName}'. Each needs its own name.` });

            variants.push({ ...one.ask, name: variantName });
        }

        // The message to all and its saved task: checked before any copy is made.
        if (body.text !== undefined && typeof body.text !== "string")
            return sendJson(response, 400, { problem: "The common message is text." });

        const text = typeof body.text === "string" ? body.text : "";
        const taskName = typeof body.task === "string" && body.task ? body.task : undefined;
        const task = taskName !== undefined ? evalTasks().tasks.find(one => one.name === taskName) : undefined;

        if (taskName !== undefined && !task)
            return sendJson(response, 400, { problem: `There is no saved task named '${taskName}'. Pick another, or pick none.` });

        // Kept as they are now, so a variant added months later gets these same lines.
        const closing = task ? taskClosing(task.kind) : undefined;

        const empty = this.emptyVariants(text, variants);

        if (empty)
            return sendJson(response, 400, { problem: empty });

        this.evalsMaking.add(name.toLowerCase());

        let start: SavedEval["start"];
        let saved: SavedEval;

        try {

            start = await saveStart(name, folder);

            const createdAt = Date.now();

            // All copies at the same time. Each is waited for, also when one fails, so none is still being written when the folder is removed.
            const copies = await Promise.allSettled(variants.map(one => makeCopy({ folder, ...(start ? { start } : {}) }, evalCopyDir(name, one.name))));
            const failed = copies.find((one): one is PromiseRejectedResult => one.status === "rejected");

            if (failed)
                throw failed.reason;

            const made: EvalVariant[] = variants.map((one, index) => ({
                ...one,
                chatId: newChatId(createdAt + index),
                folder: (copies[index] as PromiseFulfilledResult<string>).value,
                addedAt: createdAt
            }));

            saved = {
                name, folder, createdAt, ...(start ? { start } : {}), variants: made,
                sent: { text, ...(taskName ? { task: taskName } : {}), ...(closing !== undefined ? { closing } : {}), at: createdAt }
            };

            writeEval(saved);

            for (const variant of made)
                await this.saveVariantPick(name, variant);

        } catch (error) {

            logger.warning(`Eesha Code: could not make evaluation ${name}. ${(error as Error).message}`);

            this.evalStores.delete(name);
            fs.rmSync(evalDir(name), { recursive: true, force: true, maxRetries: 3 });

            await dropStart(start);

            return sendJson(response, 500, { problem: `Could not make the evaluation. ${(error as Error).message}` });

        } finally {

            this.evalsMaking.delete(name.toLowerCase());
        }

        this.evalChanged(name);

        // Made: now every variant gets its message. When that does not go, the evaluation stays, and its page has Send to all.
        const sent = await this.sendToVariants(saved, false);

        return sendJson(response, 200, { eval: this.evalView(readEval(name) ?? saved), ...(sent.problem ? { sendProblem: sent.problem } : {}) });
    }

    /**
     * Adds one variant to an evaluation - the same day, or months later
     * for a new model. In git its copy starts from the commit the
     * evaluation started from, so its numbers sit beside the others'.
     * Outside git it is a copy of the folder as it is today.
     */
    private async evalVariantAdd(response: http.ServerResponse, saved: SavedEval, body: Record<string, unknown>): Promise<void> {

        const name = saved.name;

        if (saved.variants.length >= EVAL_VARIANTS_MAX)
            return sendJson(response, 400, { problem: `An evaluation holds up to ${EVAL_VARIANTS_MAX} variants.` });

        if (this.evalsMaking.has(name.toLowerCase()))
            return sendJson(response, 409, { problem: "This evaluation is being changed right now. Try again in a moment." });

        const one = this.checkVariantAsk(body.variant, await this.evalRuntimes());

        if ("problem" in one)
            return sendJson(response, 400, { problem: `The new variant: ${one.problem}` });

        const taken = (candidate: string) =>
            saved.variants.some(other => other.name.toLowerCase() === candidate.toLowerCase()) || fs.existsSync(evalCopyDir(name, candidate));

        let variantName = one.ask.name;

        if (variantName === undefined) {

            // The evaluation's name and the next number nobody has.
            let number = saved.variants.length + 1;

            while (taken(`${name}-${number}`))
                number++;

            variantName = `${name}-${number}`;
        }

        if (!isEvalName(variantName))
            return sendJson(response, 400, { problem: `'${variantName}' is not a name. Use letters, digits, - and _ only, up to 60.` });

        if (taken(variantName))
            return sendJson(response, 400, { problem: `There is already a variant named '${variantName}'. Each needs its own name.` });

        this.evalsMaking.add(name.toLowerCase());

        const made = variantName;

        try {

            const addedAt = Date.now();

            const variant: EvalVariant = {
                ...one.ask,
                name: made,
                chatId: newChatId(addedAt),
                folder: await makeCopy(saved, evalCopyDir(name, made)),
                addedAt
            };

            // Read again: the pick may have been saved while the copy was made.
            const now = readEval(name) ?? saved;
            const next: SavedEval = { ...now, variants: [...now.variants, variant] };

            writeEval(next);

            await this.saveVariantPick(name, variant);

            this.evalChanged(name);

            return sendJson(response, 200, { eval: this.evalView(next) });

        } catch (error) {

            logger.warning(`Eesha Code: could not add variant ${made} to evaluation ${name}. ${(error as Error).message}`);

            fs.rmSync(evalCopyDir(name, made), { recursive: true, force: true, maxRetries: 3 });

            return sendJson(response, 500, { problem: `Could not make the variant's copy. ${(error as Error).message}` });

        } finally {

            this.evalsMaking.delete(name.toLowerCase());
        }
    }

    /** Stop in a variant's column head: its turn ends, as Stop ends a turn in a session. */
    private evalStop(response: http.ServerResponse, saved: SavedEval, body: Record<string, unknown>): void {

        const variant = saved.variants.find(one => one.name === body.variant);

        if (!variant)
            return sendJson(response, 404, { problem: `There is no variant named '${typeof body.variant === "string" ? body.variant : ""}' in this evaluation.` });

        const entry = [...this.chats].find(one => one.controller.chatId === variant.chatId);

        if (!entry || !entry.controller.working)
            return sendJson(response, 400, { problem: `'${variant.name}' is not working.` });

        void entry.controller.receive({ type: "cancel" });

        return sendJson(response, 200, { ok: true });
    }

    /**
     * Every variant's numbers, read off its chat file and its copy. The
     * changed files and sizes are counted only while no variant works:
     * counting reads every file of every copy, and would slow the
     * variants being timed. Meanwhile the last count is shown. Once all
     * are done, the last count is shown again until a turn ran since, or
     * a variant was added or removed.
     */
    private async evalReport(response: http.ServerResponse, saved: SavedEval): Promise<void> {

        const paused = saved.variants.some(variant => this.evalWorking(variant.chatId));
        const kept = this.evalCounts.get(saved.name);
        const key = this.countKey(saved);
        const counts = paused || kept?.key === key ? kept : await this.countEval(saved, key);

        const variants: EvalVariantReport[] = saved.variants.map(variant => {

            const counted = counts?.variants.get(variant.name);

            return {
                name: variant.name,
                turns: turnReportsOfFile(chatEventsPath(evalDir(saved.name), variant.chatId), this.evalWorking(variant.chatId))
                    .map(turn => turn.findings ? { ...turn, findings: turn.findings.map(finding => findingInFolder(finding, variant.folder)) } : turn),
                ...(counted?.files ? { files: counted.files } : {}),
                ...(counted?.filesProblem ? { filesProblem: counted.filesProblem } : {}),
                bytes: counted?.bytes ?? 0
            };
        });

        const report: EvalReport = { name: saved.name, variants, bytes: counts?.bytes ?? 0, ...(paused ? { paused: true } : {}) };

        return sendJson(response, 200, { report });
    }

    /**
     * What a count depends on: the variants, and when each one's chat file
     * last changed. A turn writes to its chat file, so a count is made
     * again after a turn ran. A copy changed by hand outside a turn is not
     * seen until then.
     */
    private countKey(saved: SavedEval): string {

        return saved.variants.map(variant => {

            let changed = 0;

            try {

                changed = fs.statSync(chatEventsPath(evalDir(saved.name), variant.chatId)).mtimeMs;

            } catch {

                // No message yet: no chat file.
            }

            return `${variant.name}:${changed}`;

        }).join("|");
    }

    /** Counts each copy's changed files and size, and the whole evaluation's size - each folder once - and keeps the count. */
    private async countEval(saved: SavedEval, key: string): Promise<EvalCount> {

        const start = saved.start;
        const variants = new Map<string, { files?: EvalFileChange[]; filesProblem?: string; bytes: number }>();

        for (const variant of saved.variants) {

            const copy = evalCopyDir(saved.name, variant.name);

            let files: EvalFileChange[] | undefined;
            let filesProblem: string | undefined;

            if (start)
                try {

                    files = await copyChanges(copy, start.commit);

                } catch (error) {

                    filesProblem = (error as Error).message;
                }

            variants.set(variant.name, { ...(files ? { files } : {}), ...(filesProblem ? { filesProblem } : {}), bytes: await folderBytes(copy) });
        }

        const copies = [...variants.values()].reduce((sum, one) => sum + one.bytes, 0);

        // The copies are counted above; the rest of the folder, and the chats, here.
        const counted = {
            variants,
            bytes: copies + await folderBytes(evalDir(saved.name), ["copies"]) + await folderBytes(eventsRoot(evalDir(saved.name))),
            key
        };

        this.evalCounts.set(saved.name, counted);

        return counted;
    }

    /** The person's own pick and note. With neither, the pick is taken away. */
    private evalPick(response: http.ServerResponse, saved: SavedEval, body: Record<string, unknown>): void {

        const variant = typeof body.variant === "string" && body.variant ? body.variant : undefined;

        if (variant !== undefined && !saved.variants.some(one => one.name === variant))
            return sendJson(response, 400, { problem: `There is no variant named '${variant}' in this evaluation.` });

        if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > EVAL_TEXT_MAX))
            return sendJson(response, 400, { problem: `The note is up to ${EVAL_TEXT_MAX} characters.` });

        const note = typeof body.note === "string" ? body.note.trim() : "";
        const { pick: _old, ...rest } = saved;

        void _old;

        const next: SavedEval = variant !== undefined || note
            ? { ...rest, pick: { ...(variant !== undefined ? { variant } : {}), note, at: Date.now() } }
            : rest;

        writeEval(next);

        this.evalChanged(saved.name);

        return sendJson(response, 200, { eval: this.evalView(next) });
    }

    /**
     * Removes one variant: its session ends, then its copy, scratch
     * folder, chat file and saved picks go. Refused while it works, and
     * for the last one - an evaluation always has a variant; delete the
     * evaluation instead. It cannot be brought back.
     */
    private async evalVariantRemove(response: http.ServerResponse, saved: SavedEval, body: Record<string, unknown>): Promise<void> {

        const name = saved.name;
        const variant = saved.variants.find(one => one.name === body.variant);

        if (!variant)
            return sendJson(response, 404, { problem: `There is no variant named '${String(body.variant ?? "")}' in this evaluation.` });

        if (saved.variants.length <= 1)
            return sendJson(response, 400, { problem: "This is the evaluation's only variant. Delete the evaluation instead." });

        if (this.evalWorking(variant.chatId))
            return sendJson(response, 409, { problem: `'${variant.name}' is still working. Stop it, or wait until it has finished, then remove it.` });

        if (this.evalsMaking.has(name.toLowerCase()))
            return sendJson(response, 409, { problem: "This evaluation is being changed right now. Try again in a moment." });

        this.evalsMaking.add(name.toLowerCase());

        try {

            for (const entry of [...this.chats])
                if (entry.controller.chatId === variant.chatId)
                    await this.dropEntry(entry);

            this.unseen.delete(variant.chatId);
            this.answers.removeChat(variant.chatId);

            // Out of the list first: when a file cannot be removed, the variant is gone from the page all the same.
            const now = readEval(name) ?? saved;
            const next: SavedEval = { ...now, variants: now.variants.filter(one => one.chatId !== variant.chatId) };

            writeEval(next);

            await this.evalStore(name).update(PICK_PREFIX + variant.chatId, undefined);

            this.evalCounts.delete(name);

            const remove = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

            try {

                await fs.promises.rm(evalCopyDir(name, variant.name), remove);
                await fs.promises.rm(evalScratchDir(name, variant.name), remove);
                await fs.promises.rm(chatEventsPath(evalDir(name), variant.chatId), { force: true, maxRetries: 5, retryDelay: 200 });

            } catch (error) {

                logger.warning(`Eesha Code: removed variant ${variant.name} of ${name}, but not all of its files. ${(error as Error).message}`);
            }

            this.evalChanged(name);

            return sendJson(response, 200, { eval: this.evalView(next) });

        } finally {

            this.evalsMaking.delete(name.toLowerCase());
        }
    }

    /** Lets a kept chat go now, and waits until its session has ended. A tab showing it is told the chat is gone. */
    private async dropEntry(entry: ChatEntry): Promise<void> {

        const tab = entry.tab;

        if (tab) {

            entry.controller.detach(tab.surface);
            entry.tab = undefined;
            tab.chat = undefined;
            tab.surface = undefined;

            this.dropPrompts(tab);
            this.send(tab, { type: "eesha.unknownChat", chatId: entry.controller.chatId });
        }

        clearTimeout(entry.idle);

        this.chats.delete(entry);

        await entry.controller.close().catch(error =>
            logger.warning(`Eesha Code: could not close session ${entry.controller.chatId}. ${(error as Error).message}`));
    }

    /**
     * Deletes an evaluation: its variants' sessions end, then their
     * copies, chats and saved values go, and the starting commit's name
     * is taken out of the source repository. The source folder's files
     * and branches are not touched.
     */
    private async evalDelete(response: http.ServerResponse, saved: SavedEval): Promise<void> {

        const name = saved.name;

        if (saved.variants.some(variant => this.evalWorking(variant.chatId)))
            return sendJson(response, 409, { problem: "A variant is still working. Stop it, or wait until it has finished its turn, then delete." });

        if (this.evalsMaking.has(name.toLowerCase()))
            return sendJson(response, 409, { problem: "This evaluation is being changed right now. Try again in a moment." });

        this.evalsMaking.add(name.toLowerCase());

        try {

            for (const variant of saved.variants) {

                for (const entry of [...this.chats])
                    if (entry.controller.chatId === variant.chatId)
                        await this.dropEntry(entry);

                this.unseen.delete(variant.chatId);
                this.answers.removeChat(variant.chatId);
            }

            this.evalStores.delete(name);
            this.evalCounts.delete(name);

            const remove = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };

            // The copies first: when one cannot be removed, the evaluation is still listed and Delete can be pressed again.
            await fs.promises.rm(path.join(evalDir(name), "copies"), remove);
            await fs.promises.rm(eventsRoot(evalDir(name)), remove);
            await fs.promises.rm(evalDir(name), remove);

            await dropStart(saved.start);

        } catch (error) {

            logger.warning(`Eesha Code: could not delete evaluation ${name}. ${(error as Error).message}`);

            return sendJson(response, 500, { problem: `Could not delete everything. ${(error as Error).message} Close any program that has a file of the copies open, then press Delete again.` });

        } finally {

            this.evalsMaking.delete(name.toLowerCase());
        }

        this.evalChanged(name);

        return sendJson(response, 200, { ok: true });
    }

    /** SDD's side of a phase chat - the spec's controller answers. */
    phaseOwner(chatId: string, workspace: string, link: ChatSpecLink): PhaseOwner | undefined {

        return this.sdd.ownerOf(chatId, workspace, link);
    }

    /**
     * The `>spec` rows of a session's message box. In no workspace: one
     * row that cannot be picked, saying specs are only in a workspace.
     */
    async specPaths(workspace: string | undefined, below: readonly string[], query: string): Promise<PathMatch[] | undefined> {

        return specPathRows(this.sdd, workspace, below, query);
    }

    /** What a `>spec>...` path in a sent message gives the agent. In no workspace: the problem that says why there is none. */
    async specReference(workspace: string | undefined, below: readonly string[]): Promise<{ line?: string; problem?: string } | undefined> {

        return workspace
            ? specPathReference(this.sdd, workspace, below)
            : { problem: NO_WORKSPACE_SPECS };
    }

    /**
     * A new phase chat: a normal session in the place's folders - the
     * spec's folder first - in its workspace, with the spec link saved
     * on it and the name SDD gave it. The session list hears of it.
     */
    async newPhaseChat(place: SddPlace, link: ChatSpecLink, title: string): Promise<string> {

        const chatId = newChatId(Date.now());

        writeSession(chatId, { folders: [...place.folders], scratch: false, workspace: place.key, spec: link });

        const titles = this.store.get<unknown>(TITLES_KEY);

        await this.store.update(TITLES_KEY, { ...(titles && typeof titles === "object" ? titles : {}), [chatId]: title });

        this.toAll({ type: "eesha.listChanged" });

        return chatId;
    }

    /**
     * A phase chat as SDD drives it, opened with no tab when none shows
     * it - it is let go once idle, like a chat whose tab closed. The
     * session list is told when a turn SDD hands it starts and ends:
     * with no tab, its busy lines reach nobody.
     */
    phaseChat(chatId: string): PhaseChat | undefined {

        const entry = this.entryFor(chatId);

        if (!entry)
            return undefined;

        if (!entry.tab)
            this.waitForTab(entry);

        const controller = entry.controller;

        return {
            chatId,
            get working() {

                return controller.working;
            },
            held: () => controller.held(),
            runOwned: async (call, check) => {

                const running = controller.runOwned(call, check);

                this.toAll({ type: "eesha.listChanged" });

                try {

                    return await running;

                } finally {

                    this.toAll({ type: "eesha.listChanged" });
                }
            },
            stop: () => controller.stop()
        };
    }

    /** A stopped plan waits on this phase chat, or no longer does: a tab showing it redraws its Resume button. */
    resumeChanged(chatId: string): void {

        for (const entry of this.chats)
            if (entry.controller.chatId === chatId && entry.tab)
                entry.controller.postResume();
    }

    private entryOf(chat: ChatController): ChatEntry | undefined {

        for (const entry of this.chats)
            if (entry.controller === chat)
                return entry;

        return undefined;
    }

    /** Draws the chat in this tab. A tab that showed it before is told it moved. */
    private attach(entry: ChatEntry, tab: Tab): void {

        const previous = entry.tab;

        if (previous && previous !== tab) {

            previous.chat = undefined;
            previous.surface = undefined;
            this.dropPrompts(previous);
            this.send(previous, { type: "eesha.moved" });
        }

        clearTimeout(entry.idle);
        entry.idle = undefined;

        const surface = {
            post: (message: ToChatView) => {

                this.send(tab, message);

                // A turn started or ended: the chat list shows which work.
                if (message.type === "busy")
                    this.toAll({ type: "eesha.listChanged" });

                // A question was answered: the list stops marking the chat.
                if (message.type === "log" && message.meta?.kind === "answer")
                    this.questionChanged(entry);

                // A turn ended: the runtime may have named the chat (or
                // it has its first answer now), so the header and the
                // folder rules get the chat's details again.
                if (message.type === "busy" && !message.running)
                    this.send(tab, { type: "eesha.chat", chat: this.infoOf(entry) });
            }
        };

        entry.tab = tab;
        tab.chat = entry;
        tab.surface = surface;

        entry.controller.attach(surface);

        // Seen now: the list stops marking it.
        if (this.unseen.delete(entry.controller.chatId))
            this.toAll({ type: "eesha.listChanged" });
    }

    /**
     * The chat list is read again when the chat's open question changed.
     * Lines drawn again on a reload never change it, so a long thread
     * drawn again does not make every tab read the list once per answer.
     */
    private questionChanged(entry: ChatEntry): void {

        const now = entry.controller.waiting;

        if (now === entry.listedQuestion)
            return;

        entry.listedQuestion = now;

        this.toAll({ type: "eesha.listChanged" });
    }

    /** The tab's stream ended: its chat waits for another tab, for a while. */
    private endTab(tab: Tab): void {

        clearInterval(tab.ping);

        tab.gitWatch?.close();
        tab.gitWatch = undefined;
        tab.gitJob?.stop();

        if (this.tabs.get(tab.id) === tab)
            this.tabs.delete(tab.id);

        // Its commands stop unless the same page is back by then.
        if (this.runs.has(tab.id))
            setTimeout(() => {

                if (!this.tabs.has(tab.id))
                    this.runs.stopView(tab.id);

            }, RUN_GRACE_MS).unref();

        this.dropPrompts(tab);

        // A spec it showed keeps a running phase going, with no tab.
        this.sdd.tabGone(tab.id);

        const entry = tab.chat;

        if (entry && entry.tab === tab) {

            entry.controller.detach(tab.surface);
            entry.tab = undefined;
            this.waitForTab(entry);
        }

        tab.chat = undefined;
        tab.surface = undefined;

        // The columns this page's stream carried end with it. Each comes back by itself when the page's stream is
        // open again (see bridge.ts).
        for (const other of [...this.tabs.values()])
            if (other.via === tab)
                this.endTab(other);

        // A column's stream is its page's - that one stays open.
        if (tab.via)
            return;

        try {

            tab.response.end();

        } catch {

            // Already gone.
        }
    }

    /**
     * Keeps a chat with no tab for `idleMs`, then lets it go - its
     * session ends, its file stays, and opening it again reopens the
     * conversation. A turn still running is waited for.
     */
    private waitForTab(entry: ChatEntry): void {

        clearTimeout(entry.idle);

        entry.idle = setTimeout(() => {

            if (entry.tab)
                return;

            if (entry.controller.working)
                return this.waitForTab(entry);

            this.forget(entry);

        }, this.options.idleMs ?? 10 * 60_000);
    }

    private forget(entry: ChatEntry): void {

        clearTimeout(entry.idle);

        this.chats.delete(entry);

        void entry.controller.close().catch(error =>
            logger.warning(`Eesha Code: could not close session ${entry.controller.chatId}. ${(error as Error).message}`));
    }

    /** Backs out of every question the tab was asked - it can no longer answer. */
    private dropPrompts(tab: Tab): void {

        for (const answer of tab.prompts.values())
            answer(undefined);

        tab.prompts.clear();
    }

    private send(tab: Tab, message: ToPage | ToChatView): void {

        // A column's message goes on its page's stream, marked with the column's id.
        const data = tab.via ? { type: "eesha.forView", view: tab.id, message } : message;

        try {

            tab.response.write(`data: ${JSON.stringify(data)}\n\n`);

        } catch {

            // The tab went between the check and the write.
        }
    }

    private infoOf(entry: ChatEntry): ChatInfo {

        return {
            chatId: entry.controller.chatId,
            folders: entry.host.userFolders(),
            scratch: entry.host.inScratch(),
            started: entry.controller.started,
            title: entry.controller.title(),
            ...this.infoWorkspace(entry.host.workspaceKey()),
            ...(entry.host.spec() ? { spec: entry.host.spec() } : {})
        };
    }

    /** The session's workspace key, only while that workspace is in the list. */
    private infoWorkspace(key: string | undefined): { workspace?: string } {

        return key && workspaceByKey(this.store, key) ? { workspace: key } : {};
    }

    /** The chat list: every chat with a message and saved folders, newest first. */
    private chatRows(): ChatRow[] {

        const stored = this.store.get<unknown>(TITLES_KEY);
        const titles = stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
        const marks = this.marks();
        const keys = new Set(readWorkspaces(this.store).map(workspaceKey));

        return listChats(undefined).flatMap(chat => {

            const saved = readSession(chat.id);

            if (!saved)
                return [];

            const named = titles[chat.id];
            const mark = marks[chat.id];

            const running = [...this.chats].find(entry => entry.controller.chatId === chat.id && entry.controller.working);
            const question = running?.controller.waiting;
            const unseen = this.unseen.get(chat.id);

            return [{
                chatId: chat.id,
                title: typeof named === "string" ? named : chat.title,
                at: chat.at,
                folders: saved.folders,
                ...(saved.workspace && keys.has(saved.workspace) ? { workspace: saved.workspace } : {}),
                working: running !== undefined,
                ...(question !== undefined ? { waiting: question } : {}),
                ...(unseen ? { unseen } : {}),
                ...(isChatMark(mark) ? { mark } : {}),
                ...(saved.spec ? { spec: saved.spec } : {}),
                ...(saved.typed ? { typed: true as const } : {})
            }];
        });
    }

    /**
     * The runtimes on offer and each one's models, for the folder defaults
     * window - the same lists the compose box's pickers show.
     */
    private async aiOptions(): Promise<AiOptions> {

        const choice = await aiChoiceMessage(serverAiEnv(text => this.toAll({ type: "eesha.note", text })));

        let defaultRuntime: string | undefined;

        try {

            defaultRuntime = startRuntime(choice.providers, defaultRuntimeOf(await loadEngineSettings(undefined)));

        } catch {

            // A broken settings.json is reported on the settings page.
        }

        const models = Object.fromEntries(Object.entries(choice.models ?? {}).map(([runtime, list]) =>
            [runtime, list.map(model => ({
                id: model.id,
                ...(model.name ? { name: model.name } : {}),
                ...(model.disabled ? { disabled: true } : {}),
                ...(model.efforts?.length ? { efforts: [...model.efforts] } : {})
            }))]));

        const levels = levelsOf(this.store, choice.providers);

        const modes = Object.fromEntries(Object.entries(choice.modes ?? {}).map(([runtime, list]) =>
            [runtime, list.modes.map(mode => ({ id: mode.id, ...(mode.name ? { name: mode.name } : {}) }))]));

        return { runtimes: choice.providers, ...(defaultRuntime ? { defaultRuntime } : {}), models, ...(Object.keys(modes).length ? { modes } : {}), levels, connectors: this.connectors.connectedIds() };
    }

    /** The pinned and archived chats: chat id to mark. */
    private marks(): Record<string, unknown> {

        const stored = this.store.get<unknown>(MARKS_KEY);

        return stored && typeof stored === "object" ? stored as Record<string, unknown> : {};
    }

    /** The names given to folders: folder key to alias. */
    private aliases(): Record<string, string> {

        const stored = this.store.get<unknown>(ALIASES_KEY);

        if (!stored || typeof stored !== "object" || Array.isArray(stored))
            return {};

        return Object.fromEntries(Object.entries(stored).filter((one): one is [string, string] => typeof one[1] === "string" && one[1] !== ""));
    }

    /** Gives a folder an alias. Empty: the folder is shown by its own name again. */
    private async setAlias(folder: string, alias: string): Promise<void> {

        const next = { ...this.aliases() };
        const key = folderKey(folder);

        if (alias)
            next[key] = alias;
        else
            delete next[key];

        await this.store.update(ALIASES_KEY, Object.keys(next).length ? next : undefined);
    }

    /** Pins or archives a chat. `null`: neither. A chat is never both - archiving a pinned chat unpins it. */
    private async setMark(chatId: string, mark: ChatMark | null): Promise<void> {

        const next = { ...this.marks() };

        if (mark)
            next[chatId] = mark;
        else
            delete next[chatId];

        await this.store.update(MARKS_KEY, Object.keys(next).length ? next : undefined);
    }

    /**
     * Deletes after the question. When that leaves a folder with no
     * session in it, the question has a tick box to keep the folder in
     * the list.
     */
    private async deleteRows(entry: ChatEntry, rows: readonly ChatRow[], question: string): Promise<void> {

        const offer = emptiedFolder(this.chatRows(), rows, folder => workspaceAt(this.store, folder) !== undefined);

        entry.host.keepOffer = offer
            ? { folder: offer, label: `Keep '${defaultWorkspaceName(offer, this.aliases())}' in the list as a workspace, with no sessions` }
            : undefined;

        // The Kiro sessions they are on, read while their files are there.
        const kiro = new Map<string, { runtime: string; sessionId: string }>();

        for (const row of rows) {

            const found = await kiroSessionOf(row.chatId);

            if (found)
                kiro.set(row.chatId, found);
        }

        try {

            await entry.controller.deleteChats(rows.map(row => row.chatId), question);

        } finally {

            // Asked or not - a busy session asks nothing - the offer goes.
            entry.host.keepOffer = undefined;
        }

        // Deleted in Kiro too - only those whose file
        // is gone: the person may have said no, or one was busy.
        const failed: string[] = [];

        for (const [chatId, session] of kiro)
            if (!fs.existsSync(chatEventsPath(undefined, chatId))) {

                const problem = await deleteInKiro(session);

                if (problem)
                    failed.push(problem);
            }

        if (failed.length)
            this.toAll({ type: "eesha.note", text: `Deleted here, but Kiro kept ${failed.length === 1 ? "its copy" : `${failed.length} of its copies`}: ${failed[0]}` });
    }

    /** A Kiro row's own Delete: asks in this tab, then deletes it in Kiro. Nothing of Eesha Code's is touched. */
    private async deleteKiroRow(entry: ChatEntry, row: KiroRow): Promise<void> {

        const answer = await this.ask(entry.controller, {
            kind: "confirm",
            text: `Delete the Kiro session '${row.title}'? It is deleted in Kiro itself and cannot be brought back.`,
            action: "Delete"
        });

        if (answer !== "Delete")
            return;

        try {

            await this.kiro.delete(row);

            this.toAll({ type: "eesha.listChanged" });

        } catch (error) {

            logger.warning(`Eesha Code: could not delete Kiro session ${row.sessionId}. ${(error as Error).message}`);

            this.toAll({ type: "eesha.note", text: `Kiro did not delete '${row.title}': ${(error as Error).message}` });
        }
    }

    /** A Kiro row's own Rename: asks for the name in this tab, then renames it in Kiro. */
    private async renameKiroRow(entry: ChatEntry, row: KiroRow): Promise<void> {

        const answer = await this.ask(entry.controller, {
            kind: "text",
            title: "Rename Kiro session",
            value: row.title,
            text: "The new name is saved in Kiro itself."
        });

        const title = answer?.trim().replace(/\s+/g, " ");

        // Escape, empty or the same name: nothing changes.
        if (!title || title === row.title)
            return;

        try {

            await this.kiro.rename(row, title);

            this.toAll({ type: "eesha.listChanged" });

        } catch (error) {

            logger.warning(`Eesha Code: could not rename Kiro session ${row.sessionId}. ${(error as Error).message}`);

            this.toAll({ type: "eesha.note", text: `Kiro did not rename '${row.title}': ${(error as Error).message}` });
        }
    }

    async keepFolder(folder: string): Promise<void> {

        if (workspaceAt(this.store, folder))
            return;

        const now = Date.now();
        const id = newWorkspaceId(this.store, folder, now);

        await saveWorkspace(this.store, { ...(id ? { id } : {}), created: now, name: defaultWorkspaceName(folder, this.aliases()), folders: [folder] });

        this.toAll({ type: "eesha.listChanged" });
    }

    /**
     * Removes the saved folders of chats nobody wrote a message in and no
     * tab shows - each new chat makes one, and most are left empty. `keep`
     * is never removed: the chat just made, or the one being opened. An
     * empty scratch folder goes too; one with anything in it stays.
     */
    private sweepEmpty(keep: string): void {

        const used = new Set(listChats(undefined).map(chat => chat.id));

        for (const chatId of sessionIds()) {

            if (chatId === keep || used.has(chatId))
                continue;

            const entry = [...this.chats].find(one => one.controller.chatId === chatId);

            if (entry && (entry.tab || entry.controller.working))
                continue;

            if (entry)
                this.forget(entry);

            dropSaved(chatId);

            // A session made from a folder with defaults has a pick saved.
            if (this.store.get(PICK_PREFIX + chatId) !== undefined)
                void this.store.update(PICK_PREFIX + chatId, undefined);
        }
    }

    // ---------------------------------------------------------------
    // What a chat's host asks of the server (see HostServer)
    // ---------------------------------------------------------------

    toPage(chat: ChatController, message: ToPage): void {

        const tab = this.entryOf(chat)?.tab;

        if (tab)
            this.send(tab, message);
    }

    ask(chat: ChatController, prompt: PromptRequest): Promise<string | undefined> {

        const tab = this.entryOf(chat)?.tab;

        if (!tab)
            return Promise.resolve(undefined);

        const id = this.nextPrompt++;

        return new Promise(resolve => {

            tab.prompts.set(id, resolve);
            this.send(tab, { type: "eesha.prompt", id, prompt });
        });
    }

    toAll(message: ToPage): void {

        for (const tab of this.tabs.values())
            this.send(tab, message);
    }

    // ---------------------------------------------------------------
    // What the specs ask of the server (see SddServer)
    // ---------------------------------------------------------------

    toTab(view: string, message: ToPage): void {

        const tab = this.tabs.get(view);

        if (tab)
            this.send(tab, message);
    }

    askTab(view: string, prompt: PromptRequest): Promise<string | undefined> {

        const tab = this.tabs.get(view);

        if (!tab)
            return Promise.resolve(undefined);

        const id = this.nextPrompt++;

        return new Promise(resolve => {

            tab.prompts.set(id, resolve);
            this.send(tab, { type: "eesha.prompt", id, prompt });
        });
    }

    /** The SDD module's requests. */
    private async sddApi(response: http.ServerResponse, route: string, body: Record<string, unknown>): Promise<void> {

        try {

            if (route === API.sdd) {

                const message = body.message as ToPanel | undefined;

                if (!message || typeof message !== "object" || typeof message.type !== "string")
                    return sendJson(response, 400, { problem: "Not a spec message." });

                if (typeof body.view !== "string" || !this.sdd.receive(body.view, message))
                    return sendJson(response, 409, { problem: "This tab shows no spec - reload the page." });

                return sendJson(response, 200, { ok: true });
            }

            if (route === API.sddCreate) {

                const made = await this.sdd.create(body as Partial<NewSpecAsk>);

                return sendJson(response, "problem" in made ? 400 : 200, made);
            }

            // New spec's connector picker - the compose
            // box's `>` rows, read only. Nothing here needs a workspace.
            if (route === API.sddPick) {

                const path = stringList(body.path);

                if (!path)
                    return sendJson(response, 400, { problem: "Say which level to list." });

                return sendJson(response, 200, {
                    rows: await this.connectors.search(path, typeof body.query === "string" ? body.query : "", { refresh: body.refresh === true })
                });
            }

            if (route === API.sddPickLink) {

                const path = stringList(body.path);

                if (!path?.length)
                    return sendJson(response, 400, { problem: "Say which item." });

                const found = await this.connectors.item(path);

                if (!found?.line)
                    return sendJson(response, 404, { problem: found?.problem ?? "Could not read that item." });

                return sendJson(response, 200, { line: found.line, ...(found.link ? { link: found.link } : {}) });
            }

            if (route === API.sddCopyStyle) {

                const done = await this.sdd.copyStyle(body as Partial<CopyStyleAsk>);

                return sendJson(response, "problem" in done ? 400 : 200, done);
            }

            // The start page: specs from every workspace, so no one workspace.
            if (route === API.sddRecent) {

                if (typeof body.count !== "number" || !Number.isInteger(body.count) || body.count < 1)
                    return sendJson(response, 400, { problem: "Say how many specs." });

                return sendJson(response, 200, await this.sdd.recent(body.count));
            }

            // SDD always runs in a workspace.
            const place = this.sdd.placeAt(body.workspace, body.folder);

            if (!place)
                return sendJson(response, 404, { problem: placeProblem(body.folder) });

            if (route === API.sddSpecs)
                return sendJson(response, 200, await this.sdd.list(place));

            if (route === API.sddExplorer)
                return sendJson(response, 200, await this.sdd.explorer(place));

            if (route === API.sddSessions) {

                if (typeof body.spec !== "string" || !body.spec)
                    return sendJson(response, 400, { problem: "Say which spec." });

                return sendJson(response, 200, { sessions: this.sdd.sessions(place, body.spec) });
            }

            if (route === API.sddWidget) {

                if (typeof body.spec !== "string" || !body.spec)
                    return sendJson(response, 400, { problem: "Say which spec." });

                const widget = await this.sdd.widget(place, body.spec, typeof body.phase === "string" && body.phase ? body.phase : undefined);

                return widget
                    ? sendJson(response, 200, widget)
                    : sendJson(response, 404, { problem: `There is no spec '${body.spec}' in ${place.mainFolder}.` });
            }

            if (route === API.sddCommand) {

                if (typeof body.spec !== "string" || !body.spec)
                    return sendJson(response, 400, { problem: "Say which spec." });

                if (typeof body.action !== "string" || !isSpecAction(body.action))
                    return sendJson(response, 400, { problem: "That is not something a spec does from the message box." });

                const done = await specCommand(
                    this.sdd, place.key, body.spec, body.action,
                    typeof body.phase === "string" && body.phase ? body.phase : undefined,
                    typeof body.text === "string" ? body.text : undefined);

                return sendJson(response, "problem" in done ? 409 : 200, done);
            }

            if (route === API.sddStart) {

                if (typeof body.spec !== "string" || !body.spec)
                    return sendJson(response, 400, { problem: "Say which spec." });

                if (typeof body.stageId !== "string" || !body.stageId)
                    return sendJson(response, 400, { problem: "Say which phase to start." });

                const started = await this.sdd.start(place, body.spec, body.stageId);

                return sendJson(response, "problem" in started ? 409 : 200, started);
            }

            if (route === API.sddOffers)
                return sendJson(response, 200, await this.sdd.offers(place));

            if (route === API.sddCopyOffers)
                return sendJson(response, 200, await this.sdd.copyOffers(place));

            if (route === API.sddSort) {

                if (body.sort !== "alpha" && body.sort !== "recent")
                    return sendJson(response, 400, { problem: "Say alpha or recent." });

                await this.sdd.setSort(place, body.sort);

                return sendJson(response, 200, { ok: true });
            }

            if (route === API.sddClearHistory)
                return sendJson(response, 200, { removed: this.sdd.clearHistory(place) });

            if (route === API.sddArchive) {

                if (typeof body.spec !== "string" || !body.spec)
                    return sendJson(response, 400, { problem: "Say which spec." });

                if (typeof body.archived !== "boolean")
                    return sendJson(response, 400, { problem: "Say archived true or false." });

                await this.sdd.setArchived(place, body.spec, body.archived);

                return sendJson(response, 200, { ok: true });
            }

            if (route === API.sddOpen) {

                if (!this.tabOf(body.view))
                    return sendJson(response, 409, { problem: "This tab is not connected - reload the page." });

                if (typeof body.spec !== "string" || !body.spec)
                    return sendJson(response, 400, { problem: "Say which spec to open." });

                const opened = await this.sdd.open(body.view as string, place, body.spec);

                return sendJson(response, "problem" in opened ? 404 : 200, opened);
            }

        } catch (error) {

            // Nothing in the SDD module throws on purpose: a throw is a
            // failure (a file it could not read or write), not an answer.
            return sendJson(response, 500, specProblem(error));
        }

        sendJson(response, 404, { problem: "Not found." });
    }

    /**
     * The other chat open on this id. One kept with no tab and no turn
     * running is let go instead, so the asking chat can open it.
     */
    holder(chatId: string, asking: ChatController): ChatController | undefined {

        for (const entry of [...this.chats]) {

            if (entry.controller === asking || entry.controller.chatId !== chatId)
                continue;

            if (!entry.tab && !entry.controller.working) {

                this.forget(entry);

                return undefined;
            }

            return entry.controller;
        }

        return undefined;
    }

    chatChanged(chat: ChatController): void {

        const entry = this.entryOf(chat);

        if (entry?.tab)
            this.send(entry.tab, { type: "eesha.chat", chat: this.infoOf(entry) });

        this.toAll({ type: "eesha.listChanged" });
    }

    renamed(chatId?: string): void {

        for (const entry of this.chats)
            if (entry.tab)
                this.send(entry.tab, { type: "eesha.chat", chat: this.infoOf(entry) });

        this.toAll({ type: "eesha.listChanged" });

        // Renamed by the person: Kiro's copy takes the name too. The name the list shows, given or its own.
        if (chatId) {

            const title = this.chatRows().find(row => row.chatId === chatId)?.title;

            if (title)
                void renameInKiro(chatId, title);
        }
    }

    /**
     * A turn ended or the agent asked something: the page shows a system
     * notice. To the tab showing the chat. With no tab - a chat left
     * running when its tab moved to another chat - to every tab: the
     * person still needs to hear. The page gives all of one chat's
     * notices one tag, so several tabs show it once.
     */
    notify(chat: ChatController, notice: ChatNotice): void {

        const message: ToPage = { type: "eesha.notify", chatId: chat.chatId, title: chat.title(), notice };

        const entry = this.entryOf(chat);
        const tab = entry?.tab;

        if (tab)
            this.send(tab, message);
        else
            this.toAll(message);

        // A chat with no tab ended its turn: the list marks it until a
        // tab opens it. Nobody may have heard the notice - no tab at all
        // was open, say.
        if (notice.kind === "ended" && !tab)
            this.unseen.set(chat.chatId, notice.outcome);

        if (entry)
            entry.listedQuestion = entry.controller.waiting;

        // The list marks a chat that waits for an answer, or ended unseen.
        // With no tab on the chat, its "busy" never reaches the server, so
        // this is also what clears its "working" dot.
        this.toAll({ type: "eesha.listChanged" });
    }

    /**
     * A chat's file was deleted. Its folder list goes at once, so Back to
     * its address says the chat is not here.
     *
     * The chat deleted is never on screen: the chat refuses to delete
     * one shown in another tab, and the tab that deleted its own chat
     * shows a new one by now. One kept with no tab is let go.
     */
    chatDeleted(chatId: string): void {

        for (const entry of [...this.chats])
            if (entry.controller.chatId === chatId && !entry.tab && !entry.controller.working)
                this.forget(entry);

        dropSaved(chatId);

        this.unseen.delete(chatId);

        // Its "This session" answers go with it.
        this.answers.removeChat(chatId);

        if (chatId in this.marks())
            void this.setMark(chatId, null);
    }

    toWorkspacePage(chat: ChatController, workspace: string): void {

        const entry = this.entryOf(chat);
        const tab = entry?.tab;

        // An Evaluator column has no page of its own to move.
        if (!entry || !tab || tab.via || !workspaceByKey(this.store, workspace))
            return;

        this.send(tab, { type: "eesha.workspacePage", workspace });

        // The page makes a new stream for the workspace page. Until the
        // old one closes, nothing more of this chat is drawn on it.
        entry.controller.detach(tab.surface);
        entry.tab = undefined;
        tab.chat = undefined;
        tab.surface = undefined;

        this.waitForTab(entry);
    }
}

/**
 * What a delete from a folder's or a day's menu asks: how many chats,
 * where (`in 'api'`), and how many of them are pinned or archived - so
 * pinned chats are never deleted without the person being told.
 */
export function deleteQuestion(count: number, pinned: number, archived: number, where: string): string {

    if (count === 1)
        return `Delete the one session ${where}?${pinned ? " It is pinned." : archived ? " It is archived." : ""} It cannot be brought back.`;

    const marked = [
        ...(pinned ? [`${pinned} ${pinned === 1 ? "is" : "are"} pinned`] : []),
        ...(archived ? [`${archived} ${archived === 1 ? "is" : "are"} archived`] : [])
    ].join(" and ");

    return `Delete all ${count} sessions ${where}?${marked ? ` Of these, ${marked}.` : ""} They cannot be brought back.`;
}

/** A row's own Delete: the session by name, and whether it is pinned or archived. */
export function rowDeleteQuestion(row: Pick<ChatRow, "title" | "mark">): string {

    const marked = row.mark === "pinned" ? " It is pinned." : row.mark === "archived" ? " It is archived." : "";

    return `Delete '${row.title}'?${marked} Its thread cannot be brought back.`;
}

/**
 * The folder a delete leaves with no session in it: the first folder of
 * the sessions deleted, when they all share it and no other session
 * starts in it. Nothing for "No folder", for a folder added by hand (it
 * stays anyway), or for sessions in more than one folder.
 */
export function emptiedFolder(all: readonly ChatRow[], deleting: readonly ChatRow[], saved: (folder: string) => boolean): string | undefined {

    if (deleting.some(row => !row.folders[0]))
        return undefined;

    const folders = new Map(deleting.map(row => [folderKey(row.folders[0]!), row.folders[0]!] as const));

    if (folders.size !== 1)
        return undefined;

    const [[key, folder]] = [...folders];
    const gone = new Set(deleting.map(row => row.chatId));

    if (saved(folder) || all.some(row => !gone.has(row.chatId) && row.folders[0] !== undefined && folderKey(row.folders[0]) === key))
        return undefined;

    return folder;
}

/** Removes a chat's folder list, and its scratch folder when that is empty. */
function dropSaved(chatId: string): void {

    removeSession(chatId);

    try {

        fs.rmdirSync(eeshaPath("scratch", chatId));

    } catch {

        // Not there, or not empty - left alone.
    }
}

/**
 * A path the files pane asks for, checked: a full path inside one of the
 * chat's folders. The page could send any path; the key keeps other
 * programs out, this keeps the pane to the chat.
 */
function paneTarget(host: ServerChatHost, value: unknown): string | { problem: string } {

    if (typeof value !== "string" || !path.isAbsolute(value))
        return { problem: "Not a full path." };

    const resolved = path.resolve(value);

    if (!host.folders().some(folder => isInside(folder, resolved)))
        return { problem: "Only files inside this session's workspace are shown here." };

    return resolved;
}

function samePath(left: string | undefined, right: string | undefined): boolean {

    if (left === undefined || right === undefined)
        return false;

    const a = path.resolve(left);
    const b = path.resolve(right);

    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Sends the page on to `address`. Not kept by the browser: the address may change with a rename. */
function sendRedirect(response: http.ServerResponse, address: string): void {

    response.writeHead(302, { Location: address, "Cache-Control": "no-store" });
    response.end();
}

/** Text safe inside an HTML attribute in double quotes. */
function attributeText(text: string): string {

    return text.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Whether the request is at `address` already - its path, and the spec it names. */
function sameAddress(url: URL, address: string): boolean {

    const wanted = new URL(address, url);
    const decoded = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
    const specOf = (query: URLSearchParams) => `${query.get("spec") ?? ""}\n${query.get("specFolder") ?? ""}`;

    return decoded(wanted.pathname) === decoded(url.pathname) && specOf(wanted.searchParams) === specOf(url.searchParams);
}

/**
 * What the page is told for a workspace or session address with nothing
 * there: one part is a workspace page with no workspace, more is a
 * session that is not there - the page says so for each.
 */
function missingRoute(pathname: string): PageRoute {

    return pathname.split("/").filter(Boolean).length === 1 ? { workspace: "" } : { chat: "missing" };
}

function sendText(response: http.ServerResponse, status: number, text: string): void {

    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    response.end(text + "\n");
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {

    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(value));
}

/** The request's JSON object, refused past `MAX_BODY_BYTES`. */
function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {

    return new Promise((resolve, reject) => {

        const parts: Buffer[] = [];

        let size = 0;

        request.on("data", (part: Buffer) => {

            size += part.length;

            if (size > MAX_BODY_BYTES) {

                reject(new Error("Too large."));
                request.destroy();

                return;
            }

            parts.push(part);
        });

        request.on("end", () => {

            try {

                const value = JSON.parse(Buffer.concat(parts).toString("utf8"));

                if (!value || typeof value !== "object" || Array.isArray(value))
                    throw new Error("Send a JSON object.");

                resolve(value as Record<string, unknown>);

            } catch (error) {

                reject(new Error(error instanceof SyntaxError ? "Not JSON." : (error as Error).message));
            }
        });

        request.on("error", reject);
    });
}

/** A list of non-empty words from a request's body, or nothing when it is not one. */
function stringList(value: unknown): string[] | undefined {

    return Array.isArray(value) && value.every(one => typeof one === "string" && one.trim() !== "")
        ? value as string[]
        : undefined;
}

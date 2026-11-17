import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EnvService } from "../../env/envService";
import { EngineSettings, loadEngineSettings } from "../../settings/engineSettings";
import { resolveAcpAgent } from "./acpConfig";
import { cutPoint, TranscriptMessage } from "./claudeRewind";
import { runnableCommand } from "./mcpServers";

/*
 * Kiro CLI v3's saved sessions, worked on outside a chat turn: list them,
 * read one back, copy one up to a message, rename one, delete one.
 *
 * Each call starts `kiro-cli acp` for a moment (the runtime's own command
 * from settings.json), asks, and stops it. Nothing is prompted, so
 * nothing is charged. Kiro keeps its sessions on disk, so the process
 * that made a session does not have to be the one that reads it.
 *
 * Plain JSON-RPC lines rather than the ACP library: the library drops
 * the updates Kiro replays on `session/load` (see `loadSession` in
 * `AcpProvider.ts`), and reading them back is the point here.
 *
 * Every shape below was observed on kiro-cli 3.2.1.
 */

/** The extension id a runtime names to be Kiro v3 - see `acpExtensions.ts`. */
const KIRO_V3 = "kiro-v3";

/** How long one short Kiro process may take before it is stopped. */
const KIRO_CALL_TIMEOUT_MS = 30_000;

/** Whether this runtime runs Kiro's v3 engine: its settings entry names the `kiro-v3` extension. */
export function isKiroV3(settings: EngineSettings, runtime: string | undefined): boolean {

    const declared = runtime ? settings.ai.acpAgents[runtime] : undefined;

    if (!runtime || !declared)
        return false;

    try {

        return resolveAcpAgent(runtime, declared, envsOf(settings)).extensions.includes(KIRO_V3);

    } catch {

        return false;
    }
}

/** The runtimes on offer that run Kiro v3, in the order given. */
export function kiroV3Runtimes(settings: EngineSettings, runtimes: readonly string[]): string[] {

    return runtimes.filter(runtime => isKiroV3(settings, runtime));
}

/** One of Kiro's saved sessions, as `session/list` gives it. */
export interface KiroSession {

    sessionId: string;

    /** The folder it ran in. */
    cwd: string;

    title: string;

    /** When it last changed, in ms. */
    at: number;

    /** Kiro says a turn is running in it now. */
    working: boolean;
}

/** One message of a saved session, in order. */
export interface KiroMessage {

    role: "user" | "agent";

    text: string;

    /** Kiro's id - what `session/fork` cuts at. Steering messages have ids starting `steer-`. */
    messageId?: string;
}

/** Where a Kiro conversation was cut - see {@link cutKiroConversation}. */
export type KiroCut =

    /** The copy, ending just before the message gone back to. */
    | { kind: "forked"; sessionId: string }

    /** The message was the conversation's first: there is nothing before it to keep. */
    | { kind: "empty" }

    /** Not cut. `reason` says why, in plain words. */
    | { kind: "unmatched"; reason: string };

/**
 * Every session Kiro has, from every client (its terminal, its other apps,
 * Eesha Code itself), newest first.
 */
export async function listKiroSessions(runtime: string, workspaceFolder?: string): Promise<KiroSession[]> {

    return withKiro(runtime, workspaceFolder, async kiro => {

        const found: KiroSession[] = [];
        let cursor: string | undefined;

        // A few pages at most: the list is for showing, not for a sync.
        for (let page = 0; page < 10; page++) {

            // eslint-disable-next-line no-await-in-loop
            const result = await kiro.request("session/list", {
                ...(cursor ? { cursor } : {}),
                _meta: { kiro: { scope: "user" } }
            }) as { sessions?: unknown; nextCursor?: unknown } | undefined;

            found.push(...kiroSessionsFrom(result?.sessions));

            cursor = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;

            if (!cursor)
                break;
        }

        return found.sort((left, right) => right.at - left.at);
    });
}

/** `session/list`'s rows, the ones with an id and a folder. Exported for tests. */
export function kiroSessionsFrom(rows: unknown): KiroSession[] {

    if (!Array.isArray(rows))
        return [];

    return rows.flatMap(row => {

        const one = row as { sessionId?: unknown; cwd?: unknown; title?: unknown; updatedAt?: unknown; _meta?: { kiro?: { status?: unknown } } } | undefined;

        if (typeof one?.sessionId !== "string" || typeof one.cwd !== "string" || !one.cwd)
            return [];

        const at = typeof one.updatedAt === "string" ? Date.parse(one.updatedAt) : NaN;

        return [{
            sessionId: one.sessionId,
            cwd: one.cwd,
            title: typeof one.title === "string" && one.title.trim() ? one.title.trim() : "Kiro session",
            at: Number.isFinite(at) ? at : 0,
            working: one._meta?.kiro?.status === "in_progress"
        }];
    });
}

/** A saved session's messages, as Kiro replays them on `session/load`. */
export async function readKiroSession(runtime: string, sessionId: string, cwd: string, workspaceFolder?: string): Promise<KiroMessage[]> {

    return withKiro(runtime, workspaceFolder, kiro => replay(kiro, sessionId, cwd));
}

/**
 * Copies a Kiro conversation up to just before one of the person's
 * messages, into a new session. The old one is left as it was.
 *
 * `prompts` are the chat's messages from the one gone back to up to the
 * newest, in order - found in Kiro's conversation by their text, the
 * same way as on Claude (see `cutPoint` in `claudeRewind.ts`). Kiro's
 * `session/fork` keeps the message it is given and its answer, so the
 * copy is cut at the message before the one gone back to.
 */
export async function cutKiroConversation(
    runtime: string,
    sessionId: string,
    cwd: string,
    prompts: readonly string[],
    workspaceFolder?: string
): Promise<KiroCut> {

    try {

        return await withKiro(runtime, workspaceFolder, async kiro => {

            const messages = await replay(kiro, sessionId, cwd);

            const cut = cutPoint(messages.flatMap(asTranscript), prompts);

            if (!cut)
                return { kind: "unmatched", reason: "That message was not found in Kiro's saved conversation - it may have been compacted." } as KiroCut;

            if (cut.upTo === undefined)
                return { kind: "empty" } as KiroCut;

            const forked = await kiro.request("session/fork", {
                sessionId, cwd, mcpServers: [],
                _meta: { kiro: { messageId: cut.upTo } }
            }) as { sessionId?: unknown } | undefined;

            return typeof forked?.sessionId === "string"
                ? { kind: "forked", sessionId: forked.sessionId } as KiroCut
                : { kind: "unmatched", reason: "Kiro did not say which session the copy is." } as KiroCut;
        });

    } catch (error) {

        return { kind: "unmatched", reason: `Kiro's conversation could not be cut: ${(error as Error).message}` };
    }
}

/** The person's messages as `cutPoint` reads them. Steering messages count: the chat shows them as messages too. */
function asTranscript(message: KiroMessage): TranscriptMessage[] {

    return message.role === "user" && message.messageId && message.text.trim()
        ? [{ type: "user", uuid: message.messageId, parent_tool_use_id: null, message: { content: message.text } }]
        : [];
}

/** Renames a saved session in Kiro's own list. */
export async function renameKiroSession(runtime: string, sessionId: string, title: string, workspaceFolder?: string): Promise<void> {

    await withKiro(runtime, workspaceFolder, async kiro => {

        const result = await kiro.request("_kiro/session/rename", { sessionId, title, sessionSource: "local" }) as { success?: unknown } | undefined;

        if (result?.success !== true)
            throw new Error("Kiro did not rename it.");
    });
}

/** Deletes a saved session from Kiro, for good. */
export async function deleteKiroSession(runtime: string, sessionId: string, workspaceFolder?: string): Promise<void> {

    await withKiro(runtime, workspaceFolder, kiro => kiro.request("session/delete", { sessionId }).then(() => undefined));
}

/**
 * The replayed messages of `session/load`, in order. Kiro sends them
 * before it answers the load; chunks of one message share its id and are
 * joined. Empty user messages (Kiro's own markers) are left out.
 *
 * Exported for tests.
 */
export function messagesFrom(updates: readonly unknown[]): KiroMessage[] {

    const messages: KiroMessage[] = [];

    for (const raw of updates) {

        const update = raw as { sessionUpdate?: unknown; content?: { type?: unknown; text?: unknown }; _meta?: { kiro?: { messageId?: unknown } } } | undefined;

        const role = update?.sessionUpdate === "user_message_chunk" ? "user"
            : update?.sessionUpdate === "agent_message_chunk" ? "agent"
                : undefined;

        if (!role || update?.content?.type !== "text" || typeof update.content.text !== "string")
            continue;

        const text = update.content.text;
        const messageId = typeof update._meta?.kiro?.messageId === "string" ? update._meta.kiro.messageId : undefined;
        const last = messages[messages.length - 1];

        if (last && last.role === role && last.messageId === messageId && messageId !== undefined)
            last.text += text;
        else
            messages.push({ role, text, ...(messageId ? { messageId } : {}) });
    }

    return messages.filter(message => message.role === "agent" || message.text.trim());
}

async function replay(kiro: KiroCall, sessionId: string, cwd: string): Promise<KiroMessage[]> {

    const updates: unknown[] = [];

    const stop = kiro.onUpdate(params => {

        const one = params as { sessionId?: unknown; update?: unknown } | undefined;

        if (one?.sessionId === sessionId)
            updates.push(one.update);
    });

    try {

        await kiro.request("session/load", { sessionId, cwd, mcpServers: [] });

    } finally {

        stop();
    }

    return messagesFrom(updates);
}

/** One short Kiro process: requests out, answers and updates in. */
interface KiroCall {

    request(method: string, params: unknown): Promise<unknown>;

    onUpdate(handler: (params: unknown) => void): () => void;
}

function envsOf(settings: EngineSettings): EnvService {

    return new EnvService({ allowed: settings.env.allowed, denied: settings.env.denied });
}

/**
 * Starts the runtime's Kiro, says hello, runs `work`, and stops it -
 * whatever `work` did. Refused for a runtime that is not Kiro v3.
 */
async function withKiro<T>(runtime: string, workspaceFolder: string | undefined, work: (kiro: KiroCall) => Promise<T>): Promise<T> {

    const settings = await loadEngineSettings(workspaceFolder);
    const declared = settings.ai.acpAgents[runtime];

    if (!declared)
        throw new Error(`settings.json has no ai.acpAgents.${runtime}.`);

    const envs = envsOf(settings);
    const agent = resolveAcpAgent(runtime, declared, envs);

    if (!agent.extensions.includes(KIRO_V3))
        throw new Error(`${runtime} is not Kiro v3.`);

    const env = envs.spawnEnvMasked(() => undefined);

    Object.assign(env, agent.env);

    const { command, args } = runnableCommand(agent.command, agent.args) ?? { command: agent.command, args: agent.args };

    const child = spawn(command, args, { cwd: workspaceFolder ?? process.cwd(), env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

    const kiro = connect(child);

    const timer = setTimeout(() => kiro.fail(new Error(`Kiro did not answer within ${KIRO_CALL_TIMEOUT_MS / 1000} seconds.`)), KIRO_CALL_TIMEOUT_MS);

    try {

        await kiro.request("initialize", {
            protocolVersion: 1,
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: "eesha", version: "0" }
        });

        return await work(kiro);

    } finally {

        clearTimeout(timer);
        child.kill();
    }
}

/** JSON-RPC over the child's stdin and stdout, one object per line. */
function connect(child: ChildProcessWithoutNullStreams): KiroCall & { fail(error: Error): void } {

    let next = 0;
    let buffer = "";
    let failed: Error | undefined;

    const waiting = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
    const handlers = new Set<(params: unknown) => void>();

    const fail = (error: Error) => {

        failed ??= error;

        for (const one of waiting.values())
            one.reject(failed);

        waiting.clear();
    };

    const send = (message: unknown) => {

        if (!child.stdin.destroyed)
            child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    child.on("error", error => fail(new Error(`Kiro could not be started: ${error.message}`)));
    child.on("exit", code => fail(new Error(`Kiro stopped (exit code ${code ?? "none"}).`)));
    child.stdin.on("error", () => undefined);
    child.stderr.on("data", () => undefined);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {

        buffer += chunk;

        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {

            const line = buffer.slice(0, end).trim();

            buffer = buffer.slice(end + 1);

            let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: unknown } };

            try {

                message = JSON.parse(line);

            } catch {

                continue;
            }

            if (typeof message.method === "string") {

                // A question from Kiro: nothing here can answer one.
                if (message.id !== undefined)
                    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported." } });
                else if (message.method === "session/update")
                    for (const handler of handlers)
                        handler(message.params);

                continue;
            }

            const pending = typeof message.id === "number" ? waiting.get(message.id) : undefined;

            if (!pending)
                continue;

            waiting.delete(message.id as number);

            if (message.error)
                pending.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Kiro refused the request."));
            else
                pending.resolve(message.result);
        }
    });

    return {
        fail,
        onUpdate: handler => {

            handlers.add(handler);

            return () => handlers.delete(handler);
        },
        request: (method, params) => new Promise((resolve, reject) => {

            if (failed)
                return reject(failed);

            const id = ++next;

            waiting.set(id, { resolve, reject });
            send({ jsonrpc: "2.0", id, method, params });
        })
    };
}

import * as fs from "fs";
import * as path from "path";

import { logger } from "../core/logging/logger";
import { loadEngineSettings } from "../core/settings/engineSettings";
import { chatEventsPath } from "../core/events/eventFile";
import { EVENTS_SUBDIR } from "../core/loader/constants";
import { profileDirectory } from "../core/loader/profilePaths";
import { EVENTS_VERSION, lastSession, parseEvents, RunEvent } from "../core/events/runEvents";
import { listChats } from "../chat/chatHistory";
import { newChatId } from "../chat/chatRules";
import {
    deleteKiroSession, isKiroV3, KiroMessage, kiroV3Runtimes, listKiroSessions, readKiroSession, renameKiroSession
} from "../core/agent/providers/kiroSessions";
import { folderKey, KiroRow } from "./protocol";

/*
 * Kiro's own sessions in Eesha Code's session list, and
 * renames and deletes passed on to Kiro. A Kiro row can
 * be renamed or deleted from its own menu without opening it.
 *
 * The list comes from Kiro itself (`session/list`), read in the
 * background at most every {@link REFRESH_MS}, never while the page waits.
 * A Kiro session any Eesha Code session ever used is ours and not listed
 * again - whatever folder it is in. The same goes for a Kiro session an
 * SDD phase used: SDD's sessions never show in the AI list.
 */

/** How old the kept list may get before a list request reads Kiro again. */
const REFRESH_MS = 30_000;

/** The owner id of a chat's lines in its events file - see `ChatController`. */
const OWNER = "chat";

/** The Kiro session ids one events file names, kept with its size and time so an unchanged file is not read again. */
const named = new Map<string, { size: number; changed: number; ids: string[] }>();

export class KiroList {

    private rows: KiroRow[] = [];

    private at = 0;

    private running?: Promise<void>;

    /** @param changed Called when a background read changed the list - the page reads the list again. */
    constructor(private readonly changed: () => void) { }

    /**
     * The kept rows in these folders (by `folderKey`), newest first, and a
     * background read when they are old.
     */
    listed(folders: ReadonlySet<string>): KiroRow[] {

        this.refresh();

        return this.rows.filter(row => folders.has(folderKey(row.cwd)));
    }

    /** One kept row, by Kiro's id. The page names it; only a listed one is opened. */
    row(sessionId: string): KiroRow | undefined {

        return this.rows.find(row => row.sessionId === sessionId);
    }

    private refresh(): void {

        if (this.running || Date.now() - this.at < REFRESH_MS)
            return;

        const running = this.read()
            .catch(error => logger.warning(`Eesha Code: could not read Kiro's sessions. ${(error as Error).message}`))
            .finally(() => {

                this.at = Date.now();

                if (this.running === running)
                    this.running = undefined;
            });

        this.running = running;
    }

    private async read(): Promise<void> {

        const settings = await loadEngineSettings(undefined);

        const runtime = kiroV3Runtimes(settings, settings.ai.providers ?? Object.keys(settings.ai.acpAgents))[0];

        const rows = runtime
            ? await listKiroSessions(runtime).then(found => {

                const ours = new Set([...sessionIdsInChats(), ...sessionIdsInSpecs()]);

                return found
                    .filter(session => !ours.has(session.sessionId))
                    .map(session => ({ ...session, runtime }));
            })
            : [];

        const before = JSON.stringify(this.rows);

        this.rows = rows;

        if (JSON.stringify(rows) !== before)
            this.changed();
    }

    /**
     * Makes a listed Kiro session an Eesha Code one: a new session in its
     * folder, on its runtime, carrying on Kiro's conversation, with the
     * thread read back from Kiro.
     *
     * @returns the new session's id
     */
    async open(row: KiroRow, saveFolders: (chatId: string, folders: string[]) => void): Promise<string> {

        const messages = await readKiroSession(row.runtime, row.sessionId, row.cwd);

        const chatId = newChatId(Date.now());

        fs.mkdirSync(path.dirname(chatEventsPath(undefined, chatId)), { recursive: true });
        fs.writeFileSync(chatEventsPath(undefined, chatId), importedEvents(chatId, row, messages, Date.now()), "utf8");

        saveFolders(chatId, [row.cwd]);

        // No longer Kiro's alone: the next read leaves it out.
        this.rows = this.rows.filter(one => one.sessionId !== row.sessionId);

        return chatId;
    }

    /**
     * Deletes a listed Kiro session in Kiro, for good, without opening it
     * here first. It leaves the list at once. Throws what Kiro said.
     */
    async delete(row: KiroRow): Promise<void> {

        await deleteKiroSession(row.runtime, row.sessionId, row.cwd);

        this.rows = this.rows.filter(one => one.sessionId !== row.sessionId);
    }

    /** Renames a listed Kiro session in Kiro. The list shows the new name at once. Throws what Kiro said. */
    async rename(row: KiroRow, title: string): Promise<void> {

        await renameKiroSession(row.runtime, row.sessionId, title, row.cwd);

        this.rows = this.rows.map(one => one.sessionId === row.sessionId ? { ...one, title } : one);
    }
}

/**
 * A chat events file for a session read back from Kiro: the session
 * record first, so the next message carries Kiro's conversation on, then
 * each message as the thread shows it.
 *
 * Exported for tests.
 */
export function importedEvents(chatId: string, row: Pick<KiroRow, "sessionId" | "runtime" | "at">, messages: readonly KiroMessage[], now: number): string {

    const at = Math.min(row.at || now, now);

    const events: RunEvent[] = [
        { v: EVENTS_VERSION, kind: "open", runId: `chat:${chatId}`, at },
        { kind: "session", ownerId: OWNER, at, sessionId: row.sessionId, provider: row.runtime },
        ...messages.map((message): RunEvent => ({
            kind: message.role === "user" ? "prompt" : "message",
            ownerId: OWNER,
            stream: "stdout",
            text: message.text.endsWith("\n") ? message.text : `${message.text}\n`,
            at
        }))
    ];

    return events.map(event => JSON.stringify(event)).join("\n") + "\n";
}

/** Every Kiro session id any Eesha Code chat recorded, in any of its session records. */
function sessionIdsInChats(): Set<string> {

    const ids = new Set<string>();

    for (const chat of listChats(undefined))
        for (const id of idsIn(chatEventsPath(undefined, chat.id)))
            ids.add(id);

    return ids;
}

/**
 * Every session id any SDD spec recorded - a phase's or an
 * implementation chat's. A spec's history is one events file under
 * `~/.eesha/events/<workspace>/specs/`, whatever workspace
 * its main folder is.
 *
 * Exported for tests.
 */
export function sessionIdsInSpecs(): Set<string> {

    const ids = new Set<string>();
    const root = path.join(profileDirectory(), EVENTS_SUBDIR);

    let places: string[];

    try {

        places = fs.readdirSync(root);

    } catch {

        return ids;
    }

    for (const place of places) {

        const folder = path.join(root, place, "specs");

        let files: string[];

        try {

            files = fs.readdirSync(folder).filter(name => name.endsWith(".jsonl"));

        } catch {

            continue;
        }

        for (const file of files)
            for (const id of idsIn(path.join(folder, file)))
                ids.add(id);
    }

    return ids;
}

function idsIn(file: string): string[] {

    let stat: fs.Stats;

    try {

        stat = fs.statSync(file);

    } catch {

        named.delete(file);

        return [];
    }

    const kept = named.get(file);

    if (kept && kept.size === stat.size && kept.changed === stat.mtimeMs)
        return kept.ids;

    let ids: string[] = [];

    try {

        ids = parseEvents(fs.readFileSync(file, "utf8"))
            .flatMap(event => event.kind === "session" && event.sessionId ? [event.sessionId] : []);

    } catch {

        // An unreadable file names nothing.
    }

    named.set(file, { size: stat.size, changed: stat.mtimeMs, ids });

    return ids;
}

/** The Kiro session a chat is on now, when its runtime is Kiro v3. Read before the chat's file is deleted. */
export async function kiroSessionOf(chatId: string): Promise<{ runtime: string; sessionId: string } | undefined> {

    let events: RunEvent[];

    try {

        events = parseEvents(fs.readFileSync(chatEventsPath(undefined, chatId), "utf8"));

    } catch {

        return undefined;
    }

    const last = lastSession(events, OWNER);

    if (!last?.provider)
        return undefined;

    try {

        return isKiroV3(await loadEngineSettings(undefined), last.provider) ? { runtime: last.provider, sessionId: last.sessionId } : undefined;

    } catch {

        return undefined;
    }
}

/** Renames the chat's Kiro session too. A failure is logged: the local name is already changed. */
export async function renameInKiro(chatId: string, title: string): Promise<void> {

    const kiro = await kiroSessionOf(chatId);

    if (!kiro || !title.trim())
        return;

    try {

        await renameKiroSession(kiro.runtime, kiro.sessionId, title.trim());

    } catch (error) {

        logger.warning(`Eesha Code: could not rename Kiro session ${kiro.sessionId}. ${(error as Error).message}`);
    }
}

/** Deletes the chat's Kiro session too. `kiro` was read before the chat's file went. */
export async function deleteInKiro(kiro: { runtime: string; sessionId: string }): Promise<string | undefined> {

    try {

        await deleteKiroSession(kiro.runtime, kiro.sessionId);

        return undefined;

    } catch (error) {

        logger.warning(`Eesha Code: could not delete Kiro session ${kiro.sessionId}. ${(error as Error).message}`);

        return (error as Error).message;
    }
}

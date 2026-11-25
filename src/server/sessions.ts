import * as fs from "fs";
import * as path from "path";

import type { ChatStore } from "../chat/chatStore";
import type { ChatSpecLink } from "../shared/chatMessages";
import { eeshaPath, readJson, writeAtomic } from "./paths";

/*
 * The folders each chat works in: ~/.eesha/sessions/<chat id>.json.
 *
 * A chat may have no folder: the agent then works in its scratch folder,
 * ~/.eesha/scratch/<chat id>. Otherwise the first folder is where
 * the agent starts. Every folder's repository is watched, so the files a
 * turn changed there are listed after it. `scratch` is set once a chat
 * got its conversation with no folder: it stays in scratch for good, and
 * folders added later are extras.
 */

/** Recent folders, newest first, kept in the store for the folder browser. */
export const RECENT_KEY = "eesha.recent";

const RECENT_LIMIT = 12;

/**
 * Whether a chat id is safe to use in a file name. The page sends it, so
 * it is checked rather than trusted: letters, digits, `-` and `_` only.
 */
export function isChatId(value: unknown): value is string {

    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
}

function sessionFile(chatId: string): string {

    return eeshaPath("sessions", `${chatId}.json`);
}

/** What is saved for one chat. */
export interface SavedSession {

    /** The folders picked for the chat, in order. May be empty. */
    folders: string[];

    /** The chat works in its scratch folder for good - see above. */
    scratch: boolean;

    /**
     * The chat whose scratch folder this one uses. A copy made by going
     * back to an earlier message works where the chat it was copied from
     * did: the runtime keeps a conversation under the folder it ran in.
     */
    scratchOf?: string;

    /**
     * The agent may also use the system temp folder. Set when the session
     * is made in a workspace that allows it; it stays with the session
     * even when the workspace changes later.
     */
    tempFolder?: true;

    /**
     * The key of the workspace the session was started in. Absent: a
     * session with no workspace - it is listed by its first folder.
     */
    workspace?: string;

    /** Set on a phase chat: the spec and phase SDD made it for - see `ChatSpecLink`. */
    spec?: ChatSpecLink;

    /**
     * A phase chat somebody typed a message into - not only the turns SDD
     * handed it. The session list's Recent shows only these phase chats.
     */
    typed?: true;
}

/** A saved spec link, checked: nothing when it is not one. */
function specLinkOf(value: unknown): ChatSpecLink | undefined {

    const link = value as { spec?: unknown; folder?: unknown; phase?: unknown } | null | undefined;

    if (!link || typeof link.spec !== "string" || !link.spec || typeof link.phase !== "string" || !link.phase)
        return undefined;

    return {
        spec: link.spec,
        ...(typeof link.folder === "string" && path.isAbsolute(link.folder) ? { folder: link.folder } : {}),
        phase: link.phase
    };
}

/** The chat's saved folders. Nothing when the chat has no file, or one that is not a list of paths. */
export function readSession(chatId: string): SavedSession | undefined {

    if (!isChatId(chatId))
        return undefined;

    const saved = readJson(sessionFile(chatId)) as { folders?: unknown; scratch?: unknown; scratchOf?: unknown; tempFolder?: unknown; workspace?: unknown; spec?: unknown; typed?: unknown } | undefined;

    const folders = saved?.folders;

    if (!Array.isArray(folders) || !folders.every(one => typeof one === "string" && path.isAbsolute(one)))
        return undefined;

    const scratchOf = saved?.scratchOf;

    return {
        folders: folders as string[],
        scratch: saved?.scratch === true,
        ...(isChatId(scratchOf) ? { scratchOf } : {}),
        ...(saved?.tempFolder === true ? { tempFolder: true as const } : {}),
        ...(typeof saved?.workspace === "string" && saved.workspace ? { workspace: saved.workspace } : {}),
        ...(specLinkOf(saved?.spec) ? { spec: specLinkOf(saved?.spec) } : {}),
        ...(saved?.typed === true ? { typed: true as const } : {})
    };
}

export function writeSession(chatId: string, saved: SavedSession): void {

    if (!isChatId(chatId))
        throw new Error(`Not a session id: ${chatId}`);

    const value = {
        folders: saved.folders,
        ...(saved.scratch ? { scratch: true } : {}),
        ...(saved.scratchOf && isChatId(saved.scratchOf) ? { scratchOf: saved.scratchOf } : {}),
        ...(saved.tempFolder ? { tempFolder: true } : {}),
        ...(saved.workspace ? { workspace: saved.workspace } : {}),
        ...(saved.spec ? { spec: saved.spec } : {}),
        ...(saved.typed ? { typed: true } : {})
    };

    writeAtomic(sessionFile(chatId), JSON.stringify(value, undefined, 2) + "\n");
}

/** Every chat id that has a saved folder list. */
export function sessionIds(): string[] {

    try {

        return fs.readdirSync(eeshaPath("sessions"))
            .filter(name => name.endsWith(".json"))
            .map(name => name.slice(0, -".json".length))
            .filter(isChatId);

    } catch {

        return [];
    }
}

/** Removes the chat's folder list - its chat was deleted. */
export function removeSession(chatId: string): void {

    if (isChatId(chatId))
        fs.rmSync(sessionFile(chatId), { force: true });
}

/**
 * Checks folders the page sent: each must be an absolute path to a
 * folder that exists. An empty list is fine - the chat works in its
 * scratch folder. Returns them resolved and without repeats, or says
 * what is wrong.
 */
export function checkFolders(folders: unknown): { folders: string[] } | { problem: string } {

    if (!Array.isArray(folders))
        return { problem: "Send a list of folders." };

    const seen = new Set<string>();
    const checked: string[] = [];

    for (const one of folders) {

        if (typeof one !== "string" || !path.isAbsolute(one))
            return { problem: `Not a full folder path: ${String(one)}` };

        const resolved = path.resolve(one);

        let isFolder = false;

        try {

            isFolder = fs.statSync(resolved).isDirectory();

        } catch {

            // Missing - said below.
        }

        if (!isFolder)
            return { problem: `No such folder: ${resolved}` };

        const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;

        if (!seen.has(key)) {

            seen.add(key);
            checked.push(resolved);
        }
    }

    return { folders: checked };
}

/** Puts folders at the top of the recent list. */
export async function rememberFolders(store: ChatStore, folders: readonly string[]): Promise<void> {

    const same = (left: string, right: string) =>
        process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;

    const before = recentFolders(store);

    const next = [...folders, ...before.filter(one => !folders.some(folder => same(folder, one)))].slice(0, RECENT_LIMIT);

    await store.update(RECENT_KEY, next);
}

/** The recent folders that still exist. */
export function recentFolders(store: ChatStore): string[] {

    const saved = store.get<unknown>(RECENT_KEY);

    return Array.isArray(saved)
        ? saved.filter((one): one is string => typeof one === "string" && fs.existsSync(one))
        : [];
}

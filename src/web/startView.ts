import { type ChatRow, folderKey, newestAt, type Workspace, workspaceKey } from "../server/protocol";
import { type Aliases, folderName, groupChats, NO_ALIASES, NO_FOLDER } from "./chatGroups";

/*
 * What the start page shows. The page is drawn by the UI library's
 * StartPage; StartPage.tsx picks what goes on it with the helpers here,
 * and words the times and counts (view/start/startText.ts).
 *
 * No React and no browser here, so it is tested on its own
 * (src/server/__tests__/startPage.test.ts).
 */

/** How many sessions "Recent sessions" shows. */
export const START_RECENT_COUNT = 7;

type Row = Pick<ChatRow, "at" | "folders" | "waiting" | "working" | "mark" | "spec" | "typed">;

const newestFirst = <T extends Pick<ChatRow, "at">>(chats: readonly T[]): T[] => [...chats].sort((left, right) => right.at - left.at);

/** The sessions stopped until someone answers them, newest first. */
export function waitingChats<T extends Row>(chats: readonly T[]): T[] {

    return newestFirst(chats.filter(chat => chat.waiting !== undefined));
}

/**
 * The newest sessions that are not archived, newest first. Pinned ones
 * are in. A phase chat is in only once somebody typed in it - the same
 * rule as the session list's Recent.
 */
export function recentList<T extends Row>(chats: readonly T[], count: number = START_RECENT_COUNT): T[] {

    return newestFirst(chats.filter(chat => chat.mark !== "archived" && (!chat.spec || chat.typed))).slice(0, count);
}

/** The newest session that is not archived - the one "Resume" opens. */
export function lastChat<T extends Row>(chats: readonly T[]): T | undefined {

    return recentList(chats, 1)[0];
}

/** The folder used last: the first folder of the newest session that has one. */
export function lastFolder(chats: readonly Row[]): string | undefined {

    return newestFirst(chats.filter(chat => chat.folders.length > 0))[0]?.folders[0];
}

/** What a session's workspace is called on this page: its first folder's name or alias, else "No workspace". */
export function chatFolder(chat: Pick<ChatRow, "folders">, aliases: Aliases = NO_ALIASES): string {

    const first = chat.folders[0];

    return first ? folderName(first, aliases) : NO_FOLDER;
}

/** A session's state as a word: `waiting`, `working`, or nothing. */
export function stateWord(chat: Pick<ChatRow, "waiting" | "working">): "waiting" | "working" | undefined {

    return chat.waiting !== undefined ? "waiting" : chat.working ? "working" : undefined;
}

/** One folder in the "Folders" list. */
export interface StartFolder {

    /** The folder, as given. */
    path: string;

    /** Its alias, else its name. */
    label: string;

    /** How many sessions work in it - pinned and archived ones too. */
    count: number;
}

/**
 * The folders the page lists, A to Z by name: every workspace's main
 * folder. Sessions in no workspace are not listed here, whatever folders
 * they work in. An archived workspace is left out. A folder with more
 * than one workspace (one per work item) is listed once, by the name of
 * its newest workspace - a session started here goes there - and counts
 * the sessions of all of them.
 */
export function startFolders(chats: readonly ChatRow[], workspaces: readonly Workspace[] = []): StartFolder[] {

    const byFolder = new Map<string, StartFolder & { home: boolean }>();

    for (const group of groupChats(chats, workspaces)) {

        if (group.key === "" || group.path === undefined || group.hidden)
            continue;

        const key = folderKey(group.path);
        const newest = newestAt(workspaces, group.path);
        const home = !newest || workspaceKey(newest) === group.key;
        const count = group.chats.length + group.pinned + group.archived;
        const before = byFolder.get(key);

        byFolder.set(key, before
            ? { path: home ? group.path : before.path, label: home ? group.label : before.label, count: before.count + count, home: home || before.home }
            : { path: group.path, label: group.label, count, home });
    }

    return [...byFolder.values()]
        .map(({ path, label, count }) => ({ path, label, count }))
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

/**
 * The runtime and model a new session in this folder starts on, when it
 * is a workspace's main folder and the workspace has them: `claude ·
 * sonnet`. Nothing otherwise.
 */
export function defaultsText(folder: string | undefined, workspaces: readonly Workspace[]): string | undefined {

    if (!folder)
        return undefined;

    const found = newestAt(workspaces, folder);

    if (!found?.runtime)
        return undefined;

    return found.model ? `${found.runtime} · ${found.model}` : found.runtime;
}

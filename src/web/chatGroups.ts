import { type ChatRow, folderKey, placeKey, type Workspace, workspaceKey } from "../server/protocol";
import { chatAddress, workspaceAddress } from "./pageRoute";

/*
 * How the session list on the left is grouped: one group per workspace,
 * A to Z, and "No workspace" last. A session sits in the workspace it was
 * started in; a session with no workspace sits in the workspace whose
 * key is its first folder's - the first workspace on that folder.
 * An archived workspace's group is marked, and the list shows it apart
 * (see ChatList.tsx). A first folder that is no workspace's main folder
 * still gets a group of its own, named by the folder. Inside a
 * group, the sessions are newest first - there are no day headings. A
 * workspace has a group even when no session works in it yet. Groups
 * can be closed (see `Collapsed`).
 *
 * The names: a workspace by its own name, any other folder by its alias,
 * else its own name - on its heading, in the search window, and in A to
 * Z order. `namesOf` puts the two together.
 *
 * No React and no browser here, so it is tested on its own
 * (src/server/__tests__/chatGroups.test.ts).
 */

/** The group of sessions with no folder - each works in its own scratch folder. */
export const NO_FOLDER = "No workspace";

export interface FolderGroup {

    /** The same for every spelling of the main folder. Empty for "No workspace". */
    key: string;

    /** The workspace's name, else the folder's alias or name - with the folder above it when two folders share a name. */
    label: string;

    /** The main folder's full path, shown on hover. Absent for "No workspace". */
    path?: string;

    /**
     * The sessions in it, newest first. Pinned and archived ones are not
     * here - they show under Pinned and Archived. Empty for a workspace
     * no session works in yet, or one whose sessions are all pinned or
     * archived: the group still shows.
     */
    chats: ChatRow[];

    /** How many of its sessions are pinned, and how many archived. */
    pinned: number;
    archived: number;

    /** The workspace this group is. Absent: a folder sessions work in that is no workspace. */
    workspace?: Workspace;

    /** Its workspace is archived: the list shows it only under "Archived workspaces". */
    hidden?: true;
}

/** The last part of a path - `C:\work\api` is `api`. */
export function baseName(folder: string): string {

    return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}

/** Names given to folders by hand: folder key to the name the list shows. */
export type Aliases = ReadonlyMap<string, string>;

export const NO_ALIASES: Aliases = new Map();

/**
 * The names the page shows for folders: each workspace's name under its
 * main folder's key, and the aliases of every other folder. A
 * workspace's name wins over an alias of its main folder.
 */
export function namesOf(aliases: Aliases, workspaces: readonly Workspace[]): Aliases {

    if (!workspaces.length)
        return aliases;

    const names = new Map(aliases);

    for (const workspace of workspaces)
        names.set(workspaceKey(workspace), workspace.name);

    return names;
}

/** What the list calls a folder: its alias, else its last part. */
export function folderName(folder: string, aliases: Aliases = NO_ALIASES): string {

    return aliases.get(folderKey(folder)) ?? baseName(folder);
}

/** The folder a path is in - `C:\work\api` is `C:\work`. */
function parentOf(folder: string): string {

    return folder.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]*$/, "");
}

export { folderKey };

/** A session's folders as one line - `api, web` - or `No folder`. */
export function folderLine(folders: readonly string[], aliases: Aliases = NO_ALIASES): string {

    return folders.length ? folders.map(folder => folderName(folder, aliases)).join(", ") : NO_FOLDER;
}

/** The key of the group a session goes in - see `placeKey`. Empty for "No folder". */
function groupKey(chat: Pick<ChatRow, "folders" | "workspace">): string {

    return placeKey(chat);
}

/**
 * The sessions in groups, as the list draws them. Every workspace has a
 * group, with sessions or without. A pinned or archived session is not
 * listed in its group, but its group still shows, and counts it: no
 * group leaves the list because its sessions were pinned or archived.
 * `aliases`: the names to show - see `namesOf`.
 */
export function groupChats(chats: readonly ChatRow[], aliases: Aliases = NO_ALIASES, workspaces: readonly Workspace[] = []): FolderGroup[] {

    type Bucket = { path?: string; chats: ChatRow[]; pinned: number; archived: number; workspace?: Workspace };

    const byKey = new Map<string, Bucket>();

    for (const chat of chats) {

        const first = chat.folders[0];
        const key = groupKey(chat);

        const group = byKey.get(key) ?? { ...(first ? { path: first } : {}), chats: [], pinned: 0, archived: 0 };

        if (chat.mark === "pinned")
            group.pinned++;
        else if (chat.mark === "archived")
            group.archived++;
        else
            group.chats.push(chat);

        byKey.set(key, group);
    }

    for (const workspace of workspaces) {

        const key = workspaceKey(workspace);

        byKey.set(key, { ...(byKey.get(key) ?? { path: workspace.folders[0]!, chats: [], pinned: 0, archived: 0 }), workspace });
    }

    const folders = [...byKey.entries()].filter(([key]) => key !== "");

    // Only folders shown by their own name can clash.
    const unnamed = folders.filter(([key]) => !aliases.has(key));

    // Two folders with one name - `C:\a\api` and `C:\b\api` - are told
    // apart by the folder above them, and by the full path past that.
    const named = (path: string) => baseName(path).toLowerCase();

    const labelOf = (key: string, path: string): string => {

        const alias = aliases.get(key);

        if (alias !== undefined)
            return alias;

        const same = unnamed.filter(([, group]) => named(group.path!) === named(path));

        if (same.length < 2)
            return baseName(path);

        const withParent = (one: string) => `${baseName(parentOf(one))}/${baseName(one)}`;

        const stillSame = same.filter(([, group]) => withParent(group.path!).toLowerCase() === withParent(path).toLowerCase());

        return stillSame.length < 2 ? withParent(path) : path;
    };

    const newestFirst = (list: ChatRow[]) => [...list].sort((left, right) => right.at - left.at);

    const compare = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base" });

    // A to Z by the name shown - the alias, else the folder's own name -
    // so `One/api` and `Two/api` sit together before `web`; folders with
    // one name by their label.
    const sortName = (group: FolderGroup) => aliases.get(group.key) ?? baseName(group.path!);

    const groups: FolderGroup[] = folders
        .map(([key, group]) => ({
            key,
            label: labelOf(key, group.path!),
            path: group.path!,
            chats: newestFirst(group.chats),
            pinned: group.pinned,
            archived: group.archived,
            ...(group.workspace ? { workspace: group.workspace } : {}),
            ...(group.workspace?.archived ? { hidden: true as const } : {})
        }))
        .sort((left, right) => compare(sortName(left), sortName(right)) || compare(left.label, right.label));

    const none = byKey.get("");

    if (none)
        groups.push({ key: "", label: NO_FOLDER, chats: newestFirst(none.chats), pinned: none.pinned, archived: none.archived });

    return groups;
}

/** The folders closed in the session list, by key. */
export type Collapsed = ReadonlySet<string>;

/** Nothing closed: the list before the first session list comes from the server. */
export const NOTHING_COLLAPSED: Collapsed = new Set();

/** Closes a folder, or opens it. */
export function toggleFolder(collapsed: Collapsed, folder: string): Collapsed {

    const next = new Set(collapsed);

    if (!next.delete(folder))
        next.add(folder);

    return next;
}

/** A session whose agent is working, or is stopped waiting for an answer. */
function isActive(chat: Pick<ChatRow, "working" | "waiting">): boolean {

    return chat.working || chat.waiting !== undefined;
}

/**
 * How the list starts when the page loads: every folder closed, except
 * the folder of each session that is working or waiting for an answer.
 */
export function startCollapsed(chats: readonly ChatRow[], workspaces: readonly Workspace[] = []): Collapsed {

    return new Set(groupChats(chats, NO_ALIASES, workspaces)
        .filter(group => !group.chats.some(isActive))
        .map(group => group.key));
}

/**
 * The folder a session sits in, by key. Not for a pinned or archived
 * session - those are not under a folder.
 */
export function placeOf(chat: Pick<ChatRow, "folders" | "workspace">): string {

    return groupKey(chat);
}

/** Opens the folder a session sits in, so the session shows. The same set back when it is open already. */
export function reveal(collapsed: Collapsed, folder: string): Collapsed {

    if (!collapsed.has(folder))
        return collapsed;

    const next = new Set(collapsed);

    next.delete(folder);

    return next;
}

/**
 * The sessions in the order the list shows them: the pinned ones first,
 * then each folder's sessions. Archived sessions are left out - they are
 * hidden until "Archived" is opened.
 */
export function listOrder(chats: readonly ChatRow[], aliases: Aliases = NO_ALIASES): ChatRow[] {

    return [
        ...chats.filter(chat => chat.mark === "pinned"),
        ...groupChats(chats.filter(chat => !chat.mark), aliases).flatMap(group => group.chats)
    ];
}

/**
 * What a delete from a folder's menu deletes: every session in that
 * folder, pinned and archived ones too. `folder` is a group's key -
 * empty for "No folder".
 */
export function chatsIn<T extends Pick<ChatRow, "folders" | "workspace">>(chats: readonly T[], folder: string): T[] {

    return chats.filter(chat => groupKey(chat) === folder);
}

/** The end of the delete question for a folder: `in 'api'`. The server puts it after "Delete all 5 sessions". */
export function deleteWhere(label: string): string {

    return `in '${label}'`;
}

/** How many sessions the "Recent" group shows. */
export const RECENT_COUNT = 5;

/**
 * The sessions the "Recent" group shows: the newest ones written to,
 * newest first. Pinned and archived sessions are left out - they have
 * their own place in the list - and so are the sessions of an archived
 * workspace (`hidden`: its key). A phase chat shows only once somebody
 * typed in it: the ones SDD ran alone stay under their spec. The
 * sessions stay in their folder groups too.
 */
export function recentChats<T extends Pick<ChatRow, "at" | "mark" | "folders" | "workspace" | "spec" | "typed">>(chats: readonly T[], count: number = RECENT_COUNT, hidden: ReadonlySet<string> = new Set()): T[] {

    return chats.filter(chat => !chat.mark && !hidden.has(placeKey(chat)) && (!chat.spec || chat.typed)).sort((a, b) => b.at - a.at).slice(0, count);
}

/** The phase chats of one spec, folded under it in a workspace's group. */
export interface SpecFold<T> {

    /** The same for the spec however often the list is drawn. */
    key: string;

    spec: string;

    /** The workspace folder the spec is in, when it is not the main one. */
    folder?: string;

    /** Its phase chats, newest first. Never empty. */
    chats: T[];
}

/** One line of a workspace's group: a session, or a spec with its phase chats folded under it. */
export type GroupLine<T> = { chat: T } | { fold: SpecFold<T> };

/**
 * A workspace's sessions as the list shows them: phase chats fold under
 * their spec, which sits where its newest phase chat would. `chats` is
 * newest first, and so is each spec's list.
 */
export function foldSpecs<T extends Pick<ChatRow, "spec">>(chats: readonly T[]): GroupLine<T>[] {

    const lines: GroupLine<T>[] = [];
    const folds = new Map<string, SpecFold<T>>();

    for (const chat of chats) {

        if (!chat.spec) {

            lines.push({ chat });
            continue;
        }

        const key = JSON.stringify([chat.spec.spec, chat.spec.folder ? folderKey(chat.spec.folder) : ""]);
        const fold = folds.get(key);

        if (fold) {

            fold.chats.push(chat);
            continue;
        }

        const made: SpecFold<T> = { key, spec: chat.spec.spec, ...(chat.spec.folder ? { folder: chat.spec.folder } : {}), chats: [chat] };

        folds.set(key, made);
        lines.push({ fold: made });
    }

    return lines;
}

/**
 * The name of the row the wave chats of a phase fold under. Waves run
 * only in the phase that carries out the plan, and every style we ship
 * calls that phase Implementation; the list has no style to ask.
 */
export const WAVES_TITLE = "Implementation";

/** A line under a spec's row: a phase chat, or the wave chats of one phase folded once more. */
export type SpecLine<T> = { chat: T } | { waves: { stage: string; chats: T[] } };

/**
 * A spec's phase chats as its row shows them: a wave chat - its phase is
 * `<stage>@wave:<n>`, or `<stage>@<task>` for a lane of one task - folds
 * under one row for its stage, which sits where its newest wave chat
 * would. `chats` is newest first, and so is each wave list.
 */
export function foldWaves<T extends Pick<ChatRow, "spec">>(chats: readonly T[]): SpecLine<T>[] {

    const lines: SpecLine<T>[] = [];
    const folds = new Map<string, T[]>();

    for (const chat of chats) {

        const phase = chat.spec?.phase ?? "";
        const at = phase.indexOf("@");

        if (at < 0) {

            lines.push({ chat });
            continue;
        }

        const stage = phase.slice(0, at);
        const fold = folds.get(stage);

        if (fold) {

            fold.push(chat);
            continue;
        }

        const made = [chat];

        folds.set(stage, made);
        lines.push({ waves: { stage, chats: made } });
    }

    return lines;
}

/**
 * The newest phase chat of a spec of a workspace in the chat list. With
 * `phase`, the newest of that phase - its wave chats included.
 */
export function newestSpecChat<T extends Pick<ChatRow, "at" | "workspace" | "spec">>(
    chats: readonly T[],
    workspace: string,
    spec: string,
    folder?: string,
    phase?: string
): T | undefined {

    const inFolder = folder ? folderKey(folder) : "";

    return chats
        .filter(chat => chat.workspace === workspace
            && chat.spec?.spec === spec
            && (chat.spec.folder ? folderKey(chat.spec.folder) : "") === inFolder
            && (!phase || chat.spec.phase === phase || chat.spec.phase.startsWith(`${phase}@`)))
        .reduce<T | undefined>((best, chat) => !best || chat.at > best.at ? chat : best, undefined);
}

/**
 * Where a link to a spec goes: its newest phase chat (of `phase`, when
 * given) with the spec open as a tab beside it, else the workspace's
 * page with the spec as a tab - a spec no chat has started yet.
 */
export function specHref(
    chats: readonly Pick<ChatRow, "chatId" | "at" | "workspace" | "spec">[],
    workspace: string,
    spec: string,
    folder?: string,
    phase?: string
): string {

    const tab = { spec, ...(folder ? { folder } : {}) };
    const chat = newestSpecChat(chats, workspace, spec, folder, phase) ?? (phase ? newestSpecChat(chats, workspace, spec, folder) : undefined);

    return chat ? chatAddress(chat.chatId, tab) : workspaceAddress(workspace, tab);
}

/** A phase chat's name under its spec: without the spec's name in front - "login · Design" reads "Design". */
export function phaseTitle(title: string, spec: string): string {

    const prefix = `${spec} · `;

    return title.startsWith(prefix) && title.length > prefix.length ? title.slice(prefix.length) : title;
}

/** The search box text as searched: spaces and line breaks as one space. */
export function folded(text: string): string {

    return text.replace(/\s+/g, " ").trim();
}

/**
 * The sessions the search window shows for this text, in the order given -
 * the server sends the newest first. A session is found by its name, by its
 * folders - each by its alias and by its own name - and by `said`: the
 * sessions the server found by what was said in them. Pinned and archived
 * sessions are found too. Nothing for empty text.
 */
export function findChats<T extends Pick<ChatRow, "chatId" | "title" | "folders">>(chats: readonly T[], text: string, aliases: Aliases = NO_ALIASES, said?: ReadonlyMap<string, string>): T[] {

    const wanted = folded(text).toLowerCase();

    if (!wanted)
        return [];

    return chats.filter(chat => chat.title.toLowerCase().includes(wanted)
        || folderLine(chat.folders, aliases).toLowerCase().includes(wanted)
        || folderLine(chat.folders).toLowerCase().includes(wanted)
        || said?.has(chat.chatId) === true);
}

/**
 * The line under an open folder with no session listed in it: `No
 * sessions yet.`, or - when its sessions are all pinned or archived -
 * where they went: `No other sessions - 1 pinned, 2 archived.`
 */
export function emptyFolderText(group: Pick<FolderGroup, "pinned" | "archived">): string {

    const away = [
        ...(group.pinned ? [`${group.pinned} pinned`] : []),
        ...(group.archived ? [`${group.archived} archived`] : [])
    ];

    return away.length ? `No other sessions - ${away.join(", ")}.` : "No sessions yet.";
}

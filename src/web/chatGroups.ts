import { type ChatRow, folderKey, placeKey, type Workspace, workspaceKey } from "../server/protocol";
import { chatAddress, workspaceAddress } from "./pageRoute";

/*
 * How the sessions are grouped: one group per workspace, A to Z by name,
 * and "No workspace" last. A session sits in the workspace it was started
 * in, while that workspace is there; every other session - with folders
 * or without - sits in "No workspace". There are no folder groups. An
 * archived workspace's group is marked, and the pickers show it apart.
 * Inside a group, the sessions are newest first. A workspace has a group
 * even when no session works in it yet.
 *
 * Folder names (`folderName`, `folderLine`) are still used where a
 * session's own folders are shown: a folder's alias, else its own name.
 * `namesOf` puts the workspaces' names over the aliases of their main
 * folders.
 *
 * No React and no browser here, so it is tested on its own
 * (src/server/__tests__/chatGroups.test.ts).
 */

/** The group of sessions in no workspace - with folders of their own, or each in its own scratch folder. */
export const NO_FOLDER = "No workspace";

export interface FolderGroup {

    /** The same for every spelling of the main folder. Empty for "No workspace". */
    key: string;

    /** The workspace's name, or "No workspace". */
    label: string;

    /** The workspace's main folder's full path, shown on hover. Absent for "No workspace". */
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

    /** The workspace this group is. Absent for "No workspace". */
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

export { folderKey };

/** A session's folders as one line - `api, web` - or `No folder`. */
export function folderLine(folders: readonly string[], aliases: Aliases = NO_ALIASES): string {

    return folders.length ? folders.map(folder => folderName(folder, aliases)).join(", ") : NO_FOLDER;
}

/** The key of the group a session goes in - see `placeKey`. Empty for "No workspace". */
function groupKey(chat: Pick<ChatRow, "workspace">): string {

    return placeKey(chat);
}

/**
 * The sessions in groups, as the lists draw them. Every workspace has a
 * group, with sessions or without. A pinned or archived session is not
 * listed in its group, but its group still shows, and counts it: no
 * group leaves the list because its sessions were pinned or archived.
 * A session whose workspace is not among `workspaces` goes in "No
 * workspace".
 */
export function groupChats(chats: readonly ChatRow[], workspaces: readonly Workspace[] = []): FolderGroup[] {

    type Bucket = { chats: ChatRow[]; pinned: number; archived: number };

    const known = new Set(workspaces.map(workspaceKey));
    const byKey = new Map<string, Bucket>([...known].map(key => [key, { chats: [], pinned: 0, archived: 0 }]));

    for (const chat of chats) {

        const placed = groupKey(chat);
        const key = known.has(placed) ? placed : "";

        const group = byKey.get(key) ?? { chats: [], pinned: 0, archived: 0 };

        if (chat.mark === "pinned")
            group.pinned++;
        else if (chat.mark === "archived")
            group.archived++;
        else
            group.chats.push(chat);

        byKey.set(key, group);
    }

    const newestFirst = (list: ChatRow[]) => [...list].sort((left, right) => right.at - left.at);

    const compare = (left: string, right: string) => left.localeCompare(right, undefined, { sensitivity: "base" });

    const groups: FolderGroup[] = workspaces
        .map(workspace => {

            const key = workspaceKey(workspace);
            const group = byKey.get(key)!;

            return {
                key,
                label: workspace.name,
                path: workspace.folders[0]!,
                chats: newestFirst(group.chats),
                pinned: group.pinned,
                archived: group.archived,
                workspace,
                ...(workspace.archived ? { hidden: true as const } : {})
            };
        })
        .sort((left, right) => compare(left.label, right.label) || compare(left.key, right.key));

    const none = byKey.get("");

    if (none)
        groups.push({ key: "", label: NO_FOLDER, chats: newestFirst(none.chats), pinned: none.pinned, archived: none.archived });

    return groups;
}

/**
 * The sessions in the order the list shows them: the pinned ones first,
 * then each workspace's sessions. Archived sessions are left out - they
 * are hidden until "Archived" is opened.
 */
export function listOrder(chats: readonly ChatRow[], workspaces: readonly Workspace[] = []): ChatRow[] {

    return [
        ...chats.filter(chat => chat.mark === "pinned"),
        ...groupChats(chats.filter(chat => !chat.mark), workspaces).flatMap(group => group.chats)
    ];
}

/**
 * What a delete from a workspace's menu deletes: every session in that
 * workspace, pinned and archived ones too. `key` is a group's key -
 * empty for "No workspace".
 */
export function chatsIn<T extends Pick<ChatRow, "workspace">>(chats: readonly T[], key: string): T[] {

    return chats.filter(chat => groupKey(chat) === key);
}

/** The end of the delete question for a folder: `in 'api'`. The server puts it after "Delete all 5 sessions". */
export function deleteWhere(label: string): string {

    return `in '${label}'`;
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

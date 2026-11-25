import React, { useMemo } from "react";

import { LibraryMenu, type MenuEntry, StatusDot, UiIcon } from "../view/ui";
import { type ChatRow, mainFolderOf, type Workspace } from "../server/protocol";
import { type Aliases, chatsIn, deleteWhere, type FolderGroup, groupChats, NO_FOLDER } from "./chatGroups";
import { chatAddress, goTo, workspaceAddress } from "./pageRoute";
import { loadPanelPlace, savePanelPlace } from "./sideState";

/*
 * The workspace picker in the header: the name of the workspace the page
 * is about, and a menu.
 *
 * The workspace shown is the page's own - a session's workspace, or the
 * workspace page's. A page with none (the start page) shows the one
 * picked last in this browser, else the first saved workspace. The
 * Sessions section of the workspace panel (ChatList.tsx) always lists the
 * same workspace: both work it out with `useShownPlace`.
 *
 * The menu:
 * 1. Go to - every workspace, "No workspace" last, then the archived
 *    workspaces. Picking a workspace opens its page; "No workspace"
 *    opens the start page with the panel on it. So the header always
 *    names the workspace of the page you see. There are no folders here:
 *    a session is in a workspace or in "No workspace".
 * 2. The shown workspace's actions: its page, Edit, Rename, Next work
 *    item, Archive or Unarchive, Delete all sessions, Remove from list.
 *    "No workspace" has only Delete all sessions.
 * 3. Add a workspace.
 */

/** Which workspace the page shows, and every place the menu offers. */
export interface ShownPlace {

    /** Every workspace, "No workspace" always among them. */
    groups: FolderGroup[];

    /** The key of the one shown: a workspace's key, or "" for "No workspace". */
    shownKey: string;

    shown: FolderGroup;
}

/**
 * Works out the shown workspace: `place` (the page's own) when it is in
 * the list, else the one picked last in this browser, else the first
 * saved workspace that is not archived, else "No workspace".
 */
export function useShownPlace(chats: readonly ChatRow[], workspaces: readonly Workspace[], place: string | undefined): ShownPlace {

    const groups = useMemo(() => {

        const all = groupChats(chats, workspaces);

        // "No workspace" is always offered: sessions in no workspace start there.
        return all.some(group => group.key === "") ? all : [...all, { key: "", label: NO_FOLDER, chats: [], pinned: 0, archived: 0 } as FolderGroup];

    }, [chats, workspaces]);

    const kept = useMemo(loadPanelPlace, []);
    const shownKey = [place, kept].find(key => key !== undefined && groups.some(group => group.key === key))
        ?? groups.find(group => group.workspace && !group.hidden)?.key
        ?? "";

    return { groups, shownKey, shown: groups.find(group => group.key === shownKey)! };
}

/** A workspace's folders and runtime as lines, for the hover text of its name. */
function workspaceLines(workspace: Workspace): string {

    const runtime = workspace.runtime ? `${workspace.runtime}${workspace.model ? ` · ${workspace.model}` : ""}` : "the server's default runtime";
    const extras = workspace.folders.slice(1);

    return [
        ...(extras.length ? [`Extra folders: ${extras.join(", ")}`] : []),
        `Main folder: ${mainFolderOf(workspace)} - its specs are kept here.`,
        `New sessions start on ${runtime}.`
    ].join("\n");
}

/** The dot of a place in the menu: waiting wins over working. */
function groupDot(chats: readonly Pick<ChatRow, "waiting" | "working">[]): React.ReactNode {

    return chats.some(chat => chat.waiting !== undefined)
        ? <StatusDot tone="waiting" label="a session here is waiting for you" />
        : chats.some(chat => chat.working) ? <StatusDot tone="working" label="a session here is working" /> : undefined;
}

export interface WorkspacePickerProps {

    chats: readonly ChatRow[];

    aliases: Aliases;

    workspaces: readonly Workspace[];

    /** The page's own workspace - see ChatList's `place`. Nothing: a page with none. */
    place?: string;

    /** Add a workspace: the workspace window, empty. */
    onAddFolder(): void;

    /** Edit workspace. */
    onEditFolder(workspace: Workspace): void;

    /** Remove from list, by the workspace's key. Its sessions stay. */
    onRemoveFolder(key: string): void;

    /** Next work item: the workspace window, for a new workspace like this one. */
    onNextItem(workspace: Workspace): void;

    /** Archive workspace, or Unarchive workspace, by its key. */
    onArchiveWorkspace(key: string, archived: boolean): void;

    /** Rename: asks for the workspace's name. `folder`: its main folder; `key`: its key. */
    onAlias(folder: string, key?: string): void;

    /** Delete all sessions. `where` ends the question - `in 'api'`. */
    onDeleteMany(chatIds: string[], where: string): void;
}

export default function WorkspacePicker({ chats, workspaces, place, onAddFolder, onEditFolder, onRemoveFolder, onNextItem, onArchiveWorkspace, onAlias, onDeleteMany }: WorkspacePickerProps) {

    const { groups, shownKey, shown } = useShownPlace(chats, workspaces, place);
    const workspace = shown.workspace;
    const here = chatsIn(chats, shownKey);

    /** Goes to a place: a saved workspace's page, else the start page with the panel on it. */
    const pick = (group: FolderGroup): void => {

        if (group.key === shownKey)
            return;

        savePanelPlace(group.key);
        goTo(group.workspace ? workspaceAddress(group.key) : chatAddress(undefined));
    };

    const placeItem = (group: FolderGroup): MenuEntry => ({
        label: group.label,
        icon: group.workspace ? "workspace" : "folder-off",
        end: group.key === shownKey ? "shown" : groupDot(chatsIn(chats, group.key)),
        onSelect: () => pick(group)
    });

    const archivedGroups = groups.filter(group => group.hidden);
    const deleteHere = (): void => {

        if (here.length)
            onDeleteMany(here.map(chat => chat.chatId), deleteWhere(shown.label));
    };

    const menu: MenuEntry[] = [
        { heading: "Go to" },
        ...groups.filter(group => !group.hidden).map(placeItem),
        ...(archivedGroups.length ? [{ heading: "Archived workspaces" }, ...archivedGroups.map(placeItem)] : []),
        "divider",
        { heading: shown.label },
        ...(workspace ? [{ label: "Workspace page", icon: "open-new" as const, href: workspaceAddress(shownKey) }] : []),
        ...(workspace
            ? [
                { label: "Edit workspace", icon: "tune" as const, onSelect: () => onEditFolder(workspace) },
                { label: "Rename", icon: "tag" as const, onSelect: () => onAlias(workspace.folders[0]!, shownKey) }
            ]
            : []),
        ...(workspace && !workspace.archived ? [{ label: "Next work item", icon: "next-step" as const, onSelect: () => onNextItem(workspace) }] : []),
        ...(workspace
            ? [workspace.archived
                ? { label: "Unarchive workspace", icon: "unarchive" as const, onSelect: () => onArchiveWorkspace(shownKey, false) }
                : { label: "Archive workspace", icon: "archive" as const, onSelect: () => onArchiveWorkspace(shownKey, true) }]
            : []),
        ...(here.length ? [{ label: "Delete all sessions", icon: "clear-all" as const, onSelect: deleteHere }] : []),
        ...(workspace && !here.length ? [{ label: "Remove from list", icon: "list-remove" as const, onSelect: () => onRemoveFolder(shownKey) }] : []),
        "divider",
        { label: "Add a workspace...", icon: "folder-new", onSelect: onAddFolder }
    ];

    const tip = workspace
        ? `${shown.path}\n${workspaceLines(workspace)}`
        : "Sessions in no workspace - each works in its own folders, or in a scratch folder";

    // In a box of its own: the menu wraps its button, and the header's style places the box (frame.scss).
    return (
        <div className="eesha-header-place-box">
        <LibraryMenu
            ariaLabel="Workspaces"
            placement="bottom"
            items={menu}
            trigger={
                <button type="button" className="eesha-header-place" title={`${tip}\n\nClick to go to another workspace, or for this one's actions`}>
                    <UiIcon name={workspace ? "workspace" : "folder-off"} size="sm" />
                    <span className="eesha-place__label">{shown.label}</span>
                    {workspace?.archived ? <span className="eesha-place__tag">archived</span> : null}
                    <UiIcon name="expand" size="sm" />
                </button>
            } />
        </div>
    );
}

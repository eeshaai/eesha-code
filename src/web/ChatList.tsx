import React, { useEffect, useMemo, useRef, useState } from "react";

import { type MenuEntry, SessionDot, type SessionGroup, SessionList, type SessionRow } from "../view/ui";
import { type ChatMark, type ChatRow, folderKey, type KiroRow, mainFolderOf, newestAt, type Workspace, workspaceKey } from "../server/protocol";
import { type Aliases, chatsIn, type Collapsed, deleteWhere, emptyFolderText, type FolderGroup, foldSpecs, foldWaves, groupChats, NOTHING_COLLAPSED, phaseTitle, placeOf, RECENT_COUNT, recentChats, reveal, type SpecFold, startCollapsed, toggleFolder, WAVES_TITLE } from "./chatGroups";
import { chatAddress, openSpecsOf, workspaceAddress } from "./pageRoute";
import { isMac, modName } from "./shortcuts";

/*
 * The session list in the AI panel, beside the strip on the left: the
 * word SESSIONS with the Add workspace and New session icons beside it,
 * the pinned sessions, then "Recent" - the 5 sessions written in last,
 * which stay in their workspaces too - then every other session grouped
 * by its workspace - A to Z, "No workspace" last - newest first inside
 * each one (see chatGroups.ts). A workspace shows even with no session
 * in it. A row shows the session's name only; its folders show on hover.
 * "Recent" opens and closes like a workspace, and starts open. Archived
 * sessions sit under "Archived (N)" at the foot, closed until clicked.
 * Search is not here: it is a window of its own, opened from the header
 * (see SearchDialog.tsx).
 *
 * A click on a saved workspace's name opens its own page (see
 * WorkspacePage.tsx); the arrow before the name closes or opens it. A
 * folder that is no saved workspace, "No workspace" and "Recent" have no
 * page: a click anywhere on the heading closes or opens them. A closed
 * one shows the dot of its most urgent session.
 *
 * When the page loads, every workspace starts closed, except the one of
 * each session that is working or waiting for an answer, and of the
 * session on screen. After that, the session on screen's workspace opens
 * when another session is opened, but it can be closed again.
 *
 * Each row is a plain link to its session. A click loads the page for
 * that session - a real page load, nothing kept from the page before.
 * Middle click or Ctrl+click opens it in a new browser tab.
 *
 * Phase chats - the sessions SDD made for a spec's phases and waves -
 * fold under a row for their spec inside the workspace, which sits where
 * its newest phase chat would. The spec's name is a link to that newest
 * chat with the spec open as a tab beside it; the arrow before it shows
 * or hides its phase chats. It starts closed, but open while the session
 * on screen is one of them. The wave chats of Implementation fold once
 * more, under an Implementation row that works the same way. Recent shows
 * a phase chat only once somebody typed in it.
 *
 * Each row shows a dot at its right end: red when the session waits for
 * an answer, blue when it is working (see StateDot). The "⋯" button shows
 * on hover or with the focus on the row, at its right end, and opens its
 * menu: Rename, Pin or Unpin, Archive or Unarchive, Delete.
 *
 * A workspace's heading shows two icons on hover: Rename (not for "No
 * workspace") and New session in it, in its folders - New session only
 * for a workspace and for "No workspace", not for a folder sessions work
 * in that is no workspace, since SDD does not work there. Its "⋯" menu has
 * Edit workspace (Save as workspace for a folder sessions work in that
 * is no workspace yet; not for "No workspace"), Specs (the workspace's
 * SDD page with the Spec explorer), Next work item (a new
 * workspace on the same folders, for the next work item), Archive
 * workspace, Delete all sessions -
 * every session in it, pinned and archived ones too, after one question
 * that says how many of them are pinned - and, for a workspace with no
 * session in it, Remove from list. A workspace's name is shown
 * everywhere in the list.
 *
 * An archived workspace and its sessions leave the list, Recent too. They
 * show under "Archived workspaces (N)" at the foot, closed until clicked;
 * there each one's menu has Unarchive workspace.
 *
 * The library's SessionList draws all of it. This file builds its groups
 * from the server's session list, keeps which workspaces are closed
 * while the page is open, and says what each click does.
 */

type Row = Pick<ChatRow, "chatId" | "title" | "folders" | "workspace" | "working" | "waiting" | "unseen" | "mark" | "spec">;

/**
 * The dot in front of a chat's name. Waiting for an answer comes first:
 * the agent is stopped until someone answers. Then working, then a turn
 * that ended while no tab showed the chat. Nothing for a quiet chat.
 */
export function StateDot({ chat }: { chat: Pick<ChatRow, "working" | "waiting" | "unseen"> }) {

    return <SessionDot state={chat} />;
}

export interface ChatListProps {

    chats: readonly ChatRow[];

    /** The first chat list came from the server. Before that `chats` is empty because it is not known yet. */
    loaded: boolean;

    /** The session this tab shows. A new session nobody wrote in yet is not in `chats`, so not in the list. */
    current?: string;

    /**
     * Not used by the session rows: a row is a plain link, and a click
     * loads the page for that session.
     */
    onOpen(chatId: string): void;

    /** Kiro's own sessions in the list's folders - shown under their folder, after its sessions. */
    kiro: readonly KiroRow[];

    /** Opens one of `kiro`: it becomes an Eesha Code session. */
    onOpenKiro(row: KiroRow): void;

    /** Rename on a Kiro row's menu: asks for the name, then renames it in Kiro. It is not opened. */
    onRenameKiro(row: KiroRow): void;

    /** Delete on a Kiro row's menu: asks, then deletes it in Kiro. It is not opened. */
    onDeleteKiro(row: KiroRow): void;

    /** A new session. `folder`: in that folder - from a heading, with the heading's workspace key when it is one. */
    onNew(folder?: string, workspace?: string): void;

    /** The workspaces. */
    workspaces: readonly Workspace[];

    /** Add workspace: the workspace window, empty. */
    onAddFolder(): void;

    /** Edit workspace, or Save as workspace, on a heading's menu. */
    onEditFolder(workspace: Workspace): void;

    /** Remove from list on a workspace, by its key. Its sessions stay. */
    onRemoveFolder(key: string): void;

    /** Next work item on a workspace's menu: the workspace window, for a new workspace like this one. */
    onNextItem(workspace: Workspace): void;

    /** Archive workspace, or Unarchive workspace, by its key. */
    onArchiveWorkspace(key: string, archived: boolean): void;

    onRename(chatId: string): void;

    onDelete(chatId: string): void;

    /** Pins or archives a chat. `null`: back among the other chats. */
    onMark(chatId: string, mark: ChatMark | null): void;

    /** The names given to folders. */
    aliases: Aliases;

    /** Rename on a workspace's heading: asks for the name. `key`: the workspace's, when the heading is one. */
    onAlias(folder: string, key?: string): void;

    /** Delete all sessions on a workspace's heading. `where` ends the question - `in 'api'`. */
    onDeleteMany(chatIds: string[], where: string): void;
}

/** A workspace's folders and runtime as lines, for its heading's hover text. */
function workspaceLines(workspace: Workspace): string {

    const runtime = workspace.runtime ? `${workspace.runtime}${workspace.model ? ` · ${workspace.model}` : ""}` : "the server's default runtime";
    const extras = workspace.folders.slice(1);

    return [
        ...(extras.length ? [`Extra folders: ${extras.join(", ")}`] : []),
        `Main folder: ${mainFolderOf(workspace)} - its specs are kept here.`,
        `New sessions start on ${runtime}.`
    ].join("\n");
}

/** The names of a menu's items, for the hover text of its "⋯" button: "Rename, Pin, Archive, Delete". */
function itemNames(items: readonly MenuEntry[]): string {

    return items.flatMap(item => typeof item === "object" && "label" in item ? [item.label] : []).join(", ");
}

export default function ChatList({ chats, loaded, current, kiro, onOpenKiro, onRenameKiro, onDeleteKiro, onNew, workspaces, onAddFolder, onEditFolder, onRemoveFolder, onNextItem, onArchiveWorkspace, onRename, onDelete, onMark, aliases, onAlias, onDeleteMany }: ChatListProps) {

    const mod = modName(isMac());

    const [showArchived, setShowArchived] = useState(false);

    /** "Archived workspaces" is open. Starts closed. */
    const [showArchivedSpaces, setShowArchivedSpaces] = useState(false);

    /** "Recent" is open. Starts open; kept while the page is open, not after a reload. */
    const [recentOpen, setRecentOpen] = useState(true);

    /** The folders closed. Kept while the page is open, not after a reload. */
    const [collapsed, setCollapsed] = useState<Collapsed>(NOTHING_COLLAPSED);

    /** Whether the closed folders were set from the first session list yet. */
    const started = useRef(false);

    /** The specs opened or closed by hand, by group and spec. Any other starts closed, but open while it holds the session on screen. */
    const [specsOpen, setSpecsOpen] = useState<ReadonlyMap<string, boolean>>(new Map());

    // The folder the session on screen sits in.
    const shownRow = chats.find(chat => chat.chatId === current && !chat.mark);
    const place = shownRow ? placeOf(shownRow) : undefined;

    // The first session list: every folder closed but those of the
    // working and waiting sessions and of the session on screen.
    // After it: the session on screen's folder opens when it is opened -
    // a closed one would hide the session being worked on. Not run on
    // every new list, so a folder closed by hand stays closed.
    useEffect(() => {

        if (!loaded)
            return;

        if (!started.current) {

            started.current = true;

            const start = startCollapsed(chats, workspaces);

            return setCollapsed(place !== undefined ? reveal(start, place) : start);
        }

        if (place !== undefined)
            setCollapsed(now => reveal(now, place));

    }, [loaded, current, place]);

    const { pinned, recent, groups, archived, archivedSpaces } = useMemo(() => {

        const all = groupChats(chats, aliases, workspaces);
        const hidden = new Set(all.filter(group => group.hidden).map(group => group.key));

        return {
            pinned: chats.filter(chat => chat.mark === "pinned"),
            recent: recentChats(chats, undefined, hidden),
            groups: all.filter(group => !group.hidden),
            archived: chats.filter(chat => chat.mark === "archived"),
            archivedSpaces: all.filter(group => group.hidden)
        };
    }, [chats, aliases, workspaces]);

    // Archived workspaces show while this tab shows one of their sessions.
    const archivedSpacesOpen = showArchivedSpaces || (place !== undefined && archivedSpaces.some(group => group.key === place));

    // Archived chats show while this tab shows one of them.
    const archivedOpen = showArchived || archived.some(chat => chat.chatId === current);

    /** What the menu of a chat with this mark offers. */
    const menuItems = (chat: Row): MenuEntry[] => [
        { label: "Rename", icon: "edit", onSelect: () => onRename(chat.chatId) },
        ...(chat.mark === "archived"
            ? []
            : [chat.mark === "pinned"
                ? { label: "Unpin", icon: "pin" as const, onSelect: () => onMark(chat.chatId, null) }
                : { label: "Pin", icon: "pin" as const, onSelect: () => onMark(chat.chatId, "pinned") }]),
        chat.mark === "archived"
            ? { label: "Unarchive", icon: "unarchive", onSelect: () => onMark(chat.chatId, null) }
            : { label: "Archive", icon: "archive", onSelect: () => onMark(chat.chatId, "archived") },
        { label: "Delete", icon: "delete", onSelect: () => onDelete(chat.chatId) }
    ];

    /**
     * One chat's row: a link to its session, its dot and its "⋯" menu. Its
     * folders show in the hover text. Under its spec, a phase chat's name
     * leaves out the spec's.
     */
    const row = (chat: Row, underSpec?: string): SessionRow => {

        const menu = menuItems(chat);
        const phase = chat.spec ? `\nPhase chat of spec ${chat.spec.spec}` : "";

        return {
            id: chat.chatId,
            title: underSpec ? phaseTitle(chat.title, underSpec) : chat.title,
            href: chatAddress(chat.chatId),
            tip: `${chat.title}${phase}\n${chat.folders.join("\n") || "No workspace - works in its own scratch folder"}`,
            state: chat,
            active: chat.chatId === current,
            menu,
            menuTitle: itemNames(menu)
        };
    };

    /**
     * A spec's row in its workspace: a link to its newest phase chat with
     * the spec open as a tab beside it, and its phase chats folded under it.
     */
    const specRow = (group: FolderGroup, fold: SpecFold<ChatRow>): SessionRow => {

        const key = `${group.key}\n${fold.key}`;
        const open = specsOpen.get(key) ?? fold.chats.some(chat => chat.chatId === current);
        const count = fold.chats.length;
        const tab = { spec: fold.spec, ...(fold.folder ? { folder: fold.folder } : {}) };

        // The wave chats of one phase, under a row of their own.
        const wavesRow = (stage: string, waves: ChatRow[]): SessionRow => {

            const wavesKey = `${key}\n${stage}`;
            const wavesOpen = specsOpen.get(wavesKey) ?? waves.some(chat => chat.chatId === current);
            const waveCount = waves.length;

            return {
                id: `waves:${fold.key}:${stage}`,
                title: WAVES_TITLE,
                href: chatAddress(waves[0]!.chatId, tab),
                tip: `${WAVES_TITLE} of spec ${fold.spec}\nOpens its newest wave chat, with the spec beside it. ${waveCount} wave chat${waveCount === 1 ? "" : "s"}.`,
                rows: waves.map(chat => row(chat, fold.spec)),
                open: wavesOpen,
                onToggle: () => setSpecsOpen(now => new Map(now).set(wavesKey, !wavesOpen)),
                toggleTitle: wavesOpen ? `Hide the wave chats of ${fold.spec}` : `Show the wave chats of ${fold.spec}`
            };
        };

        return {
            id: `spec:${fold.key}`,
            title: fold.spec,
            href: chatAddress(fold.chats[0]!.chatId, tab),
            tip: `Spec ${fold.spec}${fold.folder ? ` in ${fold.folder}` : ""}\nOpens its newest phase chat, with the spec beside it. ${count} phase chat${count === 1 ? "" : "s"}.`,
            rows: foldWaves(fold.chats).map(line => "waves" in line ? wavesRow(line.waves.stage, line.waves.chats) : row(line.chat, fold.spec)),
            open,
            onToggle: () => setSpecsOpen(now => new Map(now).set(key, !open)),
            toggleTitle: open ? `Hide the phase chats of ${fold.spec}` : `Show the phase chats of ${fold.spec}`
        };
    };

    /** Every session in a folder, pinned and archived ones too, after one question. */
    const deleteIn = (group: FolderGroup): void => {

        const chatIds = chatsIn(chats, group.key).map(chat => chat.chatId);

        if (chatIds.length)
            onDeleteMany(chatIds, deleteWhere(group.label));
    };

    /**
     * What a workspace heading's menu offers. "No workspace" has no Edit.
     * Delete only when it has sessions - pinned and archived ones count.
     * Remove from list only for a workspace with none.
     */
    const folderItems = (group: FolderGroup): MenuEntry[] => {

        const any = chatsIn(chats, group.key).length > 0;

        const workspace = group.workspace;

        return [
            ...(group.path
                ? [{
                    label: workspace ? "Edit workspace" : "Save as workspace",
                    icon: "tune" as const,
                    onSelect: () => onEditFolder(workspace ?? { name: group.label, folders: [group.path!] })
                }]
                : []),
            ...(workspace && !workspace.archived ? [{ label: "Next work item", icon: "add" as const, onSelect: () => onNextItem(workspace) }] : []),
            // The workspace's page, with the Spec explorer open - the way to the specs from a page with no session.
            ...(workspace && !workspace.archived ? [{ label: "Specs", icon: "checklist" as const, href: workspaceAddress(group.key), onSelect: () => openSpecsOf(group.key) }] : []),
            ...(workspace
                ? [workspace.archived
                    ? { label: "Unarchive workspace", icon: "unarchive" as const, onSelect: () => onArchiveWorkspace(group.key, false) }
                    : { label: "Archive workspace", icon: "archive" as const, onSelect: () => onArchiveWorkspace(group.key, true) }]
                : []),
            ...(any ? [{ label: "Delete all sessions", icon: "clear-all" as const, onSelect: () => deleteIn(group) }] : []),
            ...(workspace && !any ? [{ label: "Remove from list", icon: "list-remove" as const, onSelect: () => onRemoveFolder(group.key) }] : [])
        ];
    };

    /** One workspace: its heading with its icons and menu, its sessions, then Kiro's own sessions in it, newest first. */
    const folderGroup = (group: FolderGroup): SessionGroup => {

        const details = group.workspace ? `\n${workspaceLines(group.workspace)}` : "\nNot saved as a workspace yet.";
        // Kiro's own sessions sit under the folder's own group: a folder
        // that is no workspace, else the workspace a new session there goes in.
        const kiroHome = group.path !== undefined && !group.hidden
            && (!group.workspace || workspaceKey(newestAt(workspaces, group.path) ?? group.workspace) === group.key);
        const kiroRows = kiroHome ? kiro.filter(one => folderKey(one.cwd) === folderKey(group.path!)) : [];

        return {
            key: `folder:${group.key}`,
            label: group.label,
            tip: group.path ? `${group.path}${details}` : "Sessions with no folder - each works in its own scratch folder",
            open: !collapsed.has(group.key),
            onToggle: () => setCollapsed(now => toggleFolder(now, group.key)),
            // A saved workspace's name opens its own page; the arrow opens and closes the list.
            ...(group.workspace ? { href: workspaceAddress(group.key), hrefTitle: `Open the page of ${group.label}`, toggleTitle: `Show or hide the sessions of ${group.label}` } : {}),
            rows: foldSpecs(group.chats).map(line => "fold" in line ? specRow(group, line.fold) : row(line.chat)),
            emptyText: emptyFolderText(group),
            actions: [
                ...(group.path
                    ? [{
                        icon: "tag" as const,
                        label: `Rename ${group.label}`,
                        title: aliases.has(group.key) ? "Change the name the list shows for this workspace" : "Give this workspace a name of your own in the list",
                        onClick: () => onAlias(group.path!, group.workspace ? group.key : undefined)
                    }]
                    : []),
                // New session only in a workspace and in "No workspace". A
                // folder that is not a workspace gets none: SDD does not work there.
                ...(!group.path || (group.workspace && !group.hidden)
                    ? [{
                        icon: "edit-draft" as const,
                        label: `New session in ${group.label}`,
                        title: group.path
                            ? `New session in ${group.path}, with this workspace's folders, runtime and model`
                            : "New session with no workspace",
                        onClick: () => onNew(group.path, group.workspace ? group.key : undefined)
                    }]
                    : [])
            ],
            menu: {
                label: `Actions for ${group.label}`,
                title: group.path ? "Edit the workspace, or delete all its sessions" : "Delete all its sessions",
                items: folderItems(group)
            },
            extra: kiroRows.length
                ? {
                    label: "Kiro sessions",
                    rows: kiroRows.map(one => {

                        const menu: MenuEntry[] = [
                            { label: "Rename", icon: "edit", onSelect: () => onRenameKiro(one) },
                            { label: "Delete", icon: "delete", onSelect: () => onDeleteKiro(one) }
                        ];

                        return {
                            id: one.sessionId,
                            title: one.title,
                            tag: "Kiro",
                            tip: `${one.title}\nStarted in Kiro, outside Eesha Code${one.working ? " - Kiro says it is working now" : ""}. Open it to carry on here.\n${one.cwd}`,
                            onOpen: () => onOpenKiro(one),
                            menu,
                            menuTitle: `${itemNames(menu)} - in Kiro itself`
                        };
                    })
                }
                : undefined
        };
    };

    const list: SessionGroup[] = [
        ...(pinned.length ? [{ key: "pinned", label: "Pinned", icon: "pin" as const, rows: pinned.map(chat => row(chat)) }] : []),
        ...(recent.length
            ? [{
                key: "recent",
                label: "Recent",
                tip: `The ${RECENT_COUNT} sessions written in last, pinned and archived ones left out, and phase chats nobody typed in. They stay in their workspaces too.`,
                open: recentOpen,
                onToggle: () => setRecentOpen(!recentOpen),
                rows: recent.map(chat => row(chat))
            }]
            : []),
        ...groups.map(folderGroup),
        ...(archivedSpaces.length
            ? [
                {
                    key: "archived-workspaces",
                    label: `Archived workspaces (${archivedSpaces.length})`,
                    open: archivedSpacesOpen,
                    onToggle: () => setShowArchivedSpaces(!archivedSpacesOpen),
                    toggleTitle: archivedSpacesOpen ? "Hide the archived workspaces" : "Show the archived workspaces and their sessions",
                    rows: []
                },
                ...(archivedSpacesOpen ? archivedSpaces.map(folderGroup) : [])
            ]
            : []),
        ...(archived.length
            ? [{
                key: "archived",
                label: `Archived (${archived.length})`,
                open: archivedOpen,
                onToggle: () => setShowArchived(!archivedOpen),
                toggleTitle: archivedOpen ? "Hide the archived sessions" : "Show the archived sessions",
                rows: archived.map(chat => row(chat))
            }]
            : [])
    ];

    return (
        <SessionList
            title="Sessions"
            actions={[
                { icon: "folder-new", label: "Add workspace", title: "Add workspace", onClick: onAddFolder },
                { icon: "edit-draft", label: "New session", title: `New session (${mod}+Shift+O)`, onClick: () => onNew() }
            ]}
            groups={list}
            note={!chats.length && !workspaces.length ? "Sessions you write in are listed here." : undefined} />
    );
}

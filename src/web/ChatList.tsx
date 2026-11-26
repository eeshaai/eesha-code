import React, { useEffect, useState } from "react";

import { type MenuEntry, SessionDot, type SessionGroup, SessionList, type SessionRow } from "../view/ui";
import { API, type ChatMark, type ChatRow, folderKey, type KiroRow, newestAt, type SpecExplorerView, type SpecRowView, type Workspace, workspaceKey } from "../server/protocol";
import { bridge } from "./bridge";
import { type Aliases, chatsIn, folded, specHref } from "./chatGroups";
import Fold from "./Fold";
import { chatAddress } from "./pageRoute";
import { isMac, modName } from "./shortcuts";
import { loadClosedGroups, saveClosedGroups, type SessionGroupKey } from "./sideState";
import { useShownPlace } from "./WorkspacePicker";

/*
 * The Sessions section of the workspace panel on the left (see
 * sideState.ts). It lists the workspace the header's picker names
 * (WorkspacePicker.tsx): the page's own - the session's, or the
 * workspace page's - else the one picked last. On top, a box that
 * narrows every group to the names that hold what is typed.
 *
 * Then the groups, each hidden while it has nothing in it:
 * 1. Pinned - the pinned sessions of every workspace.
 * 2. Needs you - the specs and the chats of this workspace whose agent
 *    waits for an answer.
 * 3. Specs - one row per spec of this workspace, with the phase it is at
 *    ("done" once every phase is). Its phase chats are not listed: the
 *    spec's row opens them. Its "⋯" menu has Archive.
 * 4. Chats - every other session here, newest first, then Kiro's own
 *    sessions in its folder.
 *    Needs you, Specs and Chats close on their heading and stay closed
 *    across page loads in this browser (sideState.ts). A closed one still
 *    shows the dot of its most urgent row.
 * 5. Done - the archived specs and sessions here. Closed until clicked.
 *    An archived spec's menu has Unarchive.
 *
 * Each row is a plain link: a click loads the page for it - a real page
 * load. A chat's "⋯" menu has Rename, Pin or Unpin, Archive or Unarchive
 * and Delete.
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

/** One spec in the Specs group: its row from the server, and the folder it is in when not the main one. */
interface ListedSpec {

    row: SpecRowView;

    folder?: string;
}

export interface ChatListProps {

    chats: readonly ChatRow[];

    /** The first chat list came from the server. Before that `chats` is empty because it is not known yet. */
    loaded: boolean;

    /** The session this tab shows. A new session nobody wrote in yet is not in `chats`, so not in the list. */
    current?: string;

    /**
     * The workspace of the page: a session's workspace (else its first
     * folder's key, "" with no folder), or a workspace page's key. Nothing:
     * a page with none - the list shows the one picked last.
     */
    place?: string;

    /** The section is open. */
    open: boolean;

    onToggle(): void;

    /** Kiro's own sessions in the list's folders - shown under Chats in their folder. */
    kiro: readonly KiroRow[];

    /** Opens one of `kiro`: it becomes an Eesha Code session. */
    onOpenKiro(row: KiroRow): void;

    /** Rename on a Kiro row's menu: asks for the name, then renames it in Kiro. It is not opened. */
    onRenameKiro(row: KiroRow): void;

    /** Delete on a Kiro row's menu: asks, then deletes it in Kiro. It is not opened. */
    onDeleteKiro(row: KiroRow): void;

    /** A new session. `folder`: in that folder, with the workspace's key when it is one. */
    onNew(folder?: string, workspace?: string): void;

    /** New spec in a workspace. */
    onNewSpec(workspace: Workspace): void;

    /** The workspaces. */
    workspaces: readonly Workspace[];

    onRename(chatId: string): void;

    onDelete(chatId: string): void;

    /** Pins or archives a chat. `null`: back among the other chats. */
    onMark(chatId: string, mark: ChatMark | null): void;

    /** The names given to folders. */
    aliases: Aliases;

    /** Says a problem - an archive the server refused. */
    onNote(text: string): void;
}

/** The names of a menu's items, for the hover text of its "⋯" button: "Rename, Pin, Archive, Delete". */
function itemNames(items: readonly MenuEntry[]): string {

    return items.flatMap(item => typeof item === "object" && "label" in item ? [item.label] : []).join(", ");
}

/**
 * The specs of a saved workspace, read from the server and read again
 * when a spec changes. Nothing until the first answer, and for a place
 * that is no workspace or an archived one.
 */
function useSpecs(workspace: Workspace | undefined): { specs?: ListedSpec[]; problem?: string } {

    const key = workspace && !workspace.archived ? workspaceKey(workspace) : undefined;
    const [read, setRead] = useState<{ key: string; specs?: ListedSpec[]; problem?: string } | undefined>();

    useEffect(() => {

        if (!key)
            return;

        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const ask = () => void bridge.request<SpecExplorerView>(API.sddExplorer, { workspace: key })
            .then(answer => {

                if (!live)
                    return;

                if (answer.problem || !Array.isArray(answer.folders))
                    return setRead({ key, problem: answer.problem ?? "The server sent no list." });

                // Specs made in another workspace on the same folder are that workspace's.
                setRead({
                    key,
                    specs: answer.folders.flatMap(folder => folder.specs
                        .filter(spec => !spec.elsewhere)
                        .map(spec => ({ row: spec, ...(folder.main ? {} : { folder: folder.folder }) })))
                });
            })
            .catch(() => undefined);

        ask();

        // A phase writing its document says so many times in a row: read once.
        const off = bridge.onPage(message => {

            if (message.type === "eesha.specsChanged" || message.type === "eesha.hello") {

                clearTimeout(timer);
                timer = setTimeout(ask, 300);
            }
        });

        return () => { live = false; clearTimeout(timer); off(); };

    }, [key, workspace?.folders.join("|")]);

    return read && read.key === key ? read : {};
}

/** What a spec's row says after its name: the phase it is at. */
function specPhase(row: SpecRowView): string {

    if (!row.style)
        return "no style";

    return row.phase ?? "";
}

export default function ChatList({ chats, loaded, current, place, open, onToggle, kiro, onOpenKiro, onRenameKiro, onDeleteKiro, onNew, onNewSpec, workspaces, onRename, onDelete, onMark, aliases, onNote }: ChatListProps) {

    const mod = modName(isMac());

    /** What the search box narrows the list to. */
    const [search, setSearch] = useState("");

    /** "Done" is open. Starts closed. */
    const [doneOpen, setDoneOpen] = useState(false);

    /** The groups closed on their heading. Kept in this browser, since a row click loads a new page. */
    const [closed, setClosed] = useState<SessionGroupKey[]>(loadClosedGroups);

    /** A Needs you, Specs or Chats heading clicked: the group closes, or opens when it is closed. */
    const toggleGroup = (group: SessionGroupKey): void => {

        const next = closed.includes(group) ? closed.filter(one => one !== group) : [...closed, group];

        setClosed(next);
        saveClosedGroups(next);
    };

    // The same workspace the header's picker names.
    const { shownKey, shown } = useShownPlace(chats, workspaces, place);
    const workspace = shown.workspace;

    const { specs, problem } = useSpecs(workspace);

    /** The current chat is one of a spec's phase chats: that spec's row is marked. */
    const currentSpec = chats.find(chat => chat.chatId === current)?.spec;

    const needle = folded(search.trim());
    const matches = (text: string): boolean => !needle || folded(text).includes(needle);

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

    /** One chat's row: a link to its session, its dot and its "⋯" menu. Its folders show in the hover text. */
    const row = (chat: Row): SessionRow => {

        const menu = menuItems(chat);
        const phase = chat.spec ? `\nPhase chat of spec ${chat.spec.spec}` : "";

        return {
            id: chat.chatId,
            title: chat.title,
            href: chatAddress(chat.chatId),
            tip: `${chat.title}${phase}\n${chat.folders.join("\n") || "No workspace - works in its own scratch folder"}`,
            state: chat,
            active: chat.chatId === current,
            menu,
            menuTitle: itemNames(menu)
        };
    };

    /** Archives a spec, or brings it back. The list is read again when the server says the specs changed. */
    const archiveSpec = (spec: ListedSpec, archived: boolean): void => {

        void bridge.request(API.sddArchive, { workspace: shownKey, spec: spec.row.name, ...(spec.folder ? { folder: spec.folder } : {}), archived })
            .then(answer => { if (answer.problem) onNote(answer.problem); })
            .catch((error: Error) => onNote(`Could not reach the server: ${error.message}`));
    };

    /**
     * A spec waits for you: the server says so, or one of its phase chats
     * waits - a question asked in a phase chat is the chat's, not the
     * spec run's.
     */
    const specWaits = (spec: ListedSpec): boolean => spec.row.waiting === true || chatsIn(chats, shownKey).some(chat => chat.waiting !== undefined
        && chat.spec?.spec === spec.row.name
        && (chat.spec.folder ? folderKey(chat.spec.folder) : "") === (spec.folder ? folderKey(spec.folder) : ""));

    /** One spec's row: a link to the spec, with the phase it is at after its name, and Archive or Unarchive on its menu. */
    const specRow = (spec: ListedSpec): SessionRow => {

        const { row: one, folder } = spec;
        const phase = specPhase(one);
        const progress = one.total !== undefined ? ` · ${one.done ?? 0} of ${one.total} phases done` : "";
        const menu: MenuEntry[] = [one.archived
            ? { label: "Unarchive", icon: "unarchive", onSelect: () => archiveSpec(spec, false) }
            : { label: "Archive", icon: "archive", onSelect: () => archiveSpec(spec, true) }];

        return {
            menu,
            menuTitle: one.archived ? "Unarchive: back under Specs" : "Archive: move it under Done. Its folder and chats stay.",
            id: `spec:${folder ?? ""}:${one.name}`,
            title: phase ? `${one.name} · ${phase}` : one.name,
            href: specHref(chats, shownKey, one.name, folder),
            tip: `Spec ${one.name}${folder ? ` in ${folder}` : ""}${one.style ? `\n${one.style}${progress}` : "\nNo style could place it."}`,
            state: { working: one.working, ...(specWaits(spec) ? { waiting: "spec" } : {}) },
            active: currentSpec !== undefined && currentSpec.spec === one.name && (currentSpec.folder ? folderKey(currentSpec.folder) : "") === (folder ? folderKey(folder) : "")
        };
    };

    // The sessions of the shown workspace: pinned ones are under Pinned, archived ones under Done.
    const here = chatsIn(chats, shownKey);
    const pinned = chats.filter(chat => chat.mark === "pinned" && matches(chat.title));
    const done = here.filter(chat => chat.mark === "archived" && matches(chat.title));
    const live = here.filter(chat => !chat.mark);
    const listedSpecs = (specs ?? []).filter(spec => !spec.row.archived && matches(spec.row.name));
    const archivedSpecs = (specs ?? []).filter(spec => spec.row.archived && matches(spec.row.name));

    // Waiting: the specs, and the chats that are no phase chat of a listed spec.
    const specNames = new Set((specs ?? []).map(spec => `${spec.folder ? folderKey(spec.folder) : ""}|${spec.row.name}`));
    const ofListedSpec = (chat: Row) => chat.spec !== undefined && specNames.has(`${chat.spec.folder ? folderKey(chat.spec.folder) : ""}|${chat.spec.spec}`);
    const waitingSpecs = listedSpecs.filter(specWaits);
    const waitingChats = live.filter(chat => chat.waiting !== undefined && !ofListedSpec(chat) && matches(chat.title));
    const otherChats = live.filter(chat => !chat.spec && matches(chat.title));

    // Kiro's own sessions: in the newest workspace on their folder (a new
    // session there goes in it), else in "No workspace".
    const kiroPlace = (cwd: string): string => {

        const home = newestAt(workspaces.filter(one => !one.archived), cwd);

        return home ? workspaceKey(home) : "";
    };
    const kiroRows = shown.hidden ? [] : kiro.filter(one => kiroPlace(one.cwd) === shownKey && matches(one.title));

    const needCount = waitingSpecs.length + waitingChats.length;

    // No new session in an archived workspace.
    const canChat = !workspace?.archived;
    const canSpec = workspace !== undefined && !workspace.archived;

    const list: SessionGroup[] = [
        ...(pinned.length ? [{ key: "pinned", label: "Pinned", icon: "pin" as const, rows: pinned.map(row) }] : []),
        ...(needCount
            ? [{
                key: "needs-you",
                label: "Needs you",
                tip: "The agent stopped on a question here and waits for your answer.",
                open: !closed.includes("needs-you"),
                onToggle: () => toggleGroup("needs-you"),
                toggleTitle: closed.includes("needs-you") ? "Show what waits for you" : "Hide what waits for you",
                rows: [...waitingSpecs.map(specRow), ...waitingChats.map(row)]
            }]
            : []),
        ...(workspace && !workspace.archived
            ? [{
                key: "specs",
                label: "Specs",
                tip: `The specs of ${shown.label}, each in one row. A spec's row opens it with its phase chat.`,
                open: !closed.includes("specs"),
                onToggle: () => toggleGroup("specs"),
                toggleTitle: closed.includes("specs") ? "Show the specs" : "Hide the specs",
                rows: listedSpecs.map(specRow),
                emptyText: problem ? `The specs could not be read: ${problem}` : specs === undefined ? "Reading the specs..." : needle ? "No spec has that name." : "No specs here yet."
            }]
            : []),
        {
            key: "chats",
            label: "Chats",
            open: !closed.includes("chats"),
            onToggle: () => toggleGroup("chats"),
            toggleTitle: closed.includes("chats") ? "Show the chats" : "Hide the chats",
            rows: otherChats.map(row),
            emptyText: needle ? "No session has that name." : !loaded ? "Reading the sessions..." : "No sessions here yet.",
            extra: kiroRows.length
                ? {
                    label: "Kiro sessions",
                    rows: kiroRows.map(one => {

                        const items: MenuEntry[] = [
                            { label: "Rename", icon: "edit", onSelect: () => onRenameKiro(one) },
                            { label: "Delete", icon: "delete", onSelect: () => onDeleteKiro(one) }
                        ];

                        return {
                            id: one.sessionId,
                            title: one.title,
                            tag: "Kiro",
                            tip: `${one.title}\nStarted in Kiro, outside Eesha Code${one.working ? " - Kiro says it is working now" : ""}. Open it to carry on here.\n${one.cwd}`,
                            onOpen: () => onOpenKiro(one),
                            menu: items,
                            menuTitle: `${itemNames(items)} - in Kiro itself`
                        };
                    })
                }
                : undefined
        },
        ...(done.length + archivedSpecs.length
            ? [{
                key: "done",
                label: `Done (${done.length + archivedSpecs.length})`,
                tip: "The archived specs and sessions of this workspace.",
                open: doneOpen || done.some(chat => chat.chatId === current),
                onToggle: () => setDoneOpen(!doneOpen),
                toggleTitle: doneOpen ? "Hide the archived specs and sessions" : "Show the archived specs and sessions",
                rows: [...archivedSpecs.map(specRow), ...done.map(row)]
            }]
            : [])
    ];

    return (
        <Fold
            name="sessions"
            title="Sessions"
            fact={needCount ? `${needCount} need${needCount === 1 ? "s" : ""} you` : undefined}
            open={open}
            onToggle={onToggle}
            own
            actions={[
                ...(canSpec ? [{ icon: "file-new" as const, label: "New spec", title: `New spec in ${shown.label}`, onClick: () => onNewSpec(workspace!) }] : []),
                ...(canChat ? [{ icon: "edit-draft" as const, label: "New session", title: `New session in ${shown.label} (${mod}+Shift+O)`, onClick: () => onNew(shown.path, workspace ? shownKey : undefined) }] : [])
            ]}>
            <div className="eesha-place">
                <input
                    type="search"
                    className="eesha-place__search"
                    placeholder="Filter by name"
                    aria-label="Filter the sessions and specs by name"
                    value={search}
                    onChange={event => setSearch(event.target.value)} />
            </div>
            <SessionList
                title={`Sessions in ${shown.label}`}
                className="eesha-place__list"
                groups={list}
                note={!chats.length && !workspaces.length && loaded ? "Sessions you write in are listed here." : undefined} />
        </Fold>
    );
}

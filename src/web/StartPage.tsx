import React, { useEffect, useMemo, useState } from "react";

import { sessionsText, startAgo, startAgoText, waitingHeading } from "../view/start/startText";
import { StartPage as LibraryStartPage, type StartSession, type StartSpec } from "../view/ui";
import { API, type ChatRow, folderKey, newestAt, type RecentSpecsView, type Workspace, workspaceKey } from "../server/protocol";
import { bridge } from "./bridge";
import type { Aliases } from "./chatGroups";
import { specHref } from "./chatGroups";
import { chatAddress } from "./pageRoute";
import { type StartPickBody, useStartPicks } from "./startPicks";
import { chatFolder, defaultsText, lastChat, lastFolder, recentList, startFolders, stateWord, waitingChats } from "./startView";
import { RECENT_SPECS_COUNT, startSpecFacts } from "./workspaceView";

export type { StartPickBody } from "./startPicks";

/*
 * The start page: the page at `/` when no session is open. Top to
 * bottom: the sessions waiting for an answer, a box to start a session, three cards
 * (Resume, Search sessions, Add a folder), then recent specs and recent
 * sessions side by side, and the workspaces below them. Without the SDD
 * module there are no specs, and recent sessions and workspaces are
 * side by side.
 *
 * The UI library's StartPage draws it. This file picks what goes on it
 * (startView.ts), words the times and counts (view/start/startText.ts),
 * and keeps the box's folder, text and picks (startPicks.ts). It reads
 * the recent specs of every workspace from the server, again whenever a
 * spec changes. It moves the times on every minute.
 *
 * Every link to a session is a plain link: opening a session loads the
 * page again.
 */

export interface StartPageProps {

    /** Every session from the server. */
    chats: readonly ChatRow[];

    /** False until the first list came from the server. */
    loaded: boolean;

    /** Names given to folders. */
    aliases: Aliases;

    /** The workspaces, with their runtime and model. */
    workspaces: readonly Workspace[];

    /**
     * Makes a new session in this folder (none: no folder), puts `text` in
     * its message box and opens it. `pick`: what the box's pickers changed -
     * nothing when they still show the defaults.
     */
    onStart(folder: string | undefined, text: string, pick?: StartPickBody): void;

    /** Opens the search window. */
    onSearch(): void;

    /** Opens the "add a workspace" window. */
    onAddFolder(): void;
}

/** The value of "No folder" in the folder picker. */
const NO_FOLDER_VALUE = "";

/** The time now, again every minute, so "5m" moves on. */
export function useNow(): number {

    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {

        const timer = window.setInterval(() => setNow(Date.now()), 60_000);

        return () => window.clearInterval(timer);
    }, []);

    return now;
}

/**
 * The recent specs of every workspace, read again whenever a spec or a
 * workspace changes. Undefined until the first list came.
 */
function useRecentSpecs(workspaces: readonly Workspace[]): { specs?: RecentSpecsView; problem?: string } {

    const [specs, setSpecs] = useState<RecentSpecsView | undefined>();
    const [problem, setProblem] = useState<string | undefined>();

    // Archiving a workspace, or changing its folders, changes whose specs show.
    const shape = workspaces.map(one => `${workspaceKey(one)}|${one.archived === true}|${one.folders.join(",")}`).join("\n");

    useEffect(() => {

        let live = true;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const read = () => void bridge.request<RecentSpecsView & { problem?: string }>(API.sddRecent, { count: RECENT_SPECS_COUNT })
            .then(answer => {

                if (!live)
                    return;

                if (answer.problem || !Array.isArray(answer.specs))
                    return setProblem(answer.problem ?? "The server sent no list.");

                setProblem(undefined);
                setSpecs(answer);
            })
            .catch(() => undefined);

        read();

        // A phase writing its document says so many times in a row: read once.
        const off = bridge.onPage(message => {

            if (message.type === "eesha.specsChanged" || message.type === "eesha.hello") {

                clearTimeout(timer);
                timer = setTimeout(read, 300);
            }
        });

        return () => { live = false; clearTimeout(timer); off(); };

    }, [shape]);

    return { specs, problem };
}

export default function StartPage({ chats, loaded, aliases, workspaces, onStart, onSearch, onAddFolder }: StartPageProps): React.JSX.Element {

    const now = useNow();
    const recentSpecs = useRecentSpecs(workspaces);
    const waiting = useMemo(() => waitingChats(chats), [chats]);
    const recent = useMemo(() => recentList(chats), [chats]);
    const resume = useMemo(() => lastChat(chats), [chats]);
    const last = useMemo(() => lastFolder(chats), [chats]);
    const folders = useMemo(() => startFolders(chats, workspaces), [chats, workspaces]);

    // Null until a folder is picked by hand: the box follows the last
    // folder used, which is only known once the list came.
    const [picked, setPicked] = useState<string | null>(null);
    const [text, setText] = useState("");

    const folder = picked ?? last ?? NO_FOLDER_VALUE;
    const isLast = last !== undefined && folder === last;
    const defaults = defaultsText(folder || undefined, workspaces);

    // The last folder is in the picker even when it is not in the list.
    const choices = useMemo(() => {

        // One folder can be spelled two ways (`C:\api`, `c:/api`): the
        // last folder keeps its own spelling, so the picker can show it.
        const lastKey = last ? folderKey(last) : undefined;

        const list = folders.map(one => ({ path: folderKey(one.path) === lastKey ? last! : one.path, label: one.label }));

        if (last && !list.some(one => one.path === last))
            list.unshift({ path: last, label: chatFolder({ folders: [last] }, aliases) });

        return list;
    }, [folders, last, aliases]);

    // The pickers: runtime, model and Permissions level, as in a
    // session's compose box. Each shows the folder's saved runtime and
    // model, else the server's runtime, until picked.
    const picks = useStartPicks(folder ? newestAt(workspaces, folder) : undefined);

    const start = () => onStart(folder || undefined, text, picks.pickBody());

    const toSession = (chat: ChatRow): StartSession => ({
        id: chat.chatId,
        title: chat.title,
        href: chatAddress(chat.chatId),
        folder: chatFolder(chat, aliases),
        ago: startAgo(chat.at, now),
        state: stateWord(chat),
        waitingText: chat.waiting
    });

    const specRows: StartSpec[] = (recentSpecs.specs?.specs ?? []).map(one => ({
        id: `${one.workspace}|${one.folder ? folderKey(one.folder) : ""}|${one.name}`,
        name: one.name,
        href: specHref(chats, one.workspace, one.name, one.folder),
        facts: startSpecFacts(one, workspaces),
        ago: one.modified !== undefined ? startAgo(one.modified, now) : "",
        state: one.waiting ? "waiting" : one.working ? "working" : undefined,
        ...(one.folder ? { tip: `In ${one.folder}` } : {})
    }));

    return (
        <LibraryStartPage
            waiting={waiting.map(toSession)}
            waitingHeading={waitingHeading(waiting.length)}
            recent={recent.map(toSession)}
            resume={resume ? toSession(resume) : undefined}
            resumeAgo={resume ? startAgoText(resume.at, now) : undefined}
            folders={folders.map(one => ({ path: one.path, label: one.label, countText: sessionsText(one.count) }))}
            specs={{
                rows: specRows,
                loaded: recentSpecs.specs !== undefined,
                ...(recentSpecs.problem ? { problem: recentSpecs.problem } : {}),
                emptyText: "No specs yet. Open a workspace to make one."
            }}
            loaded={loaded}
            folderChoices={choices}
            folder={folder}
            onFolderChange={setPicked}
            folderNote={isLast ? "your last folder" : undefined}
            defaultsNote={defaults && !picks.ready ? defaults : undefined}
            text={text}
            onTextChange={setText}
            providerParts={picks.parts}
            permission={picks.permission}
            onStart={start}
            onStartIn={path => onStart(path, "")}
            onSearch={onSearch}
            onAddFolder={onAddFolder}
            addFolderTitle="Add workspace"
            noFolderLabel="No workspace"
            addFolderNote="Name it and pick its folders"
            foldersHeading="WORKSPACES"
            noFoldersText="No workspaces yet."
            testId="eesha-start"
        />
    );
}

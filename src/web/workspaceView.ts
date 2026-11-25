import { type ChatRow, folderKey, placeKey, type RecentSpecView, type SpecRowView, type Workspace, workspaceKey } from "../server/protocol";
import { newestSpecChat } from "./chatGroups";
import { recentList, waitingChats } from "./startView";

/*
 * What a workspace's own page shows (WorkspacePage.tsx), and the start
 * page's spec rows. The helpers here pick what goes on them. No React
 * and no browser here, so they are tested on their own
 * (src/server/__tests__/workspacePage.test.ts).
 */

/** A spec of a workspace: its name, and its folder when it is not in the main one. */
export interface SpecPlace {

    spec: string;

    folder?: string;
}

/** Whether two spec places are the same spec. */
function sameSpec(one: SpecPlace, other: SpecPlace): boolean {

    return one.spec === other.spec && (one.folder ? folderKey(one.folder) : "") === (other.folder ? folderKey(other.folder) : "");
}

/**
 * The last session that worked on a spec: the newest of its phase chats
 * and of the workspace's normal chats tied to it. `tiedTo` says which
 * spec a normal chat is tied to - kept in the browser (watchedSpec.ts).
 * Nothing: no session has worked on it yet.
 */
export function lastSpecChat<T extends Pick<ChatRow, "chatId" | "at" | "folders" | "workspace" | "spec">>(
    chats: readonly T[],
    workspace: string,
    spec: SpecPlace,
    tiedTo: (chatId: string) => SpecPlace | undefined
): T | undefined {

    const phase = newestSpecChat(chats, workspace, spec.spec, spec.folder);

    const tied = chatsHere(chats, workspace).filter(chat => {

        const to = chat.spec ? undefined : tiedTo(chat.chatId);

        return to !== undefined && sameSpec(to, spec);
    });

    return [...(phase ? [phase] : []), ...tied].reduce<T | undefined>((best, chat) => !best || chat.at > best.at ? chat : best, undefined);
}

/** How many specs "Recent specs" shows before Show more. */
export const RECENT_SPECS_COUNT = 5;

/** How many sessions "Recent sessions" shows. */
export const WORKSPACE_RECENT_COUNT = 7;

/** The sessions of this workspace, by its key - pinned and archived ones too. */
export function chatsHere<T extends Pick<ChatRow, "folders" | "workspace">>(chats: readonly T[], key: string): T[] {

    return chats.filter(chat => placeKey(chat) === key);
}

/** What the page lists from this workspace's sessions. */
export interface WorkspaceChats<T> {

    /** Stopped until someone answers them, newest first. */
    waiting: T[];

    /** The newest that are not archived, newest first. */
    recent: T[];

    /** The newest that is not archived - the one Resume opens. */
    last?: T;
}

/** The sessions the page shows - see {@link WorkspaceChats}. */
export function workspaceChats<T extends Pick<ChatRow, "at" | "folders" | "waiting" | "working" | "mark" | "workspace">>(chats: readonly T[], key: string): WorkspaceChats<T> {

    const here = chatsHere(chats, key);
    const recent = recentList(here, WORKSPACE_RECENT_COUNT);

    return { waiting: waitingChats(here), recent, ...(recent[0] ? { last: recent[0] } : {}) };
}

/** What a spec's row says after its name: `design · 2/5`, `done`, or why it has no phases. */
export function recentSpecFacts(spec: Pick<SpecRowView, "style" | "phase" | "done" | "total">): string {

    if (!spec.style)
        return "no style could place it";

    return [spec.phase, spec.total !== undefined ? `${spec.done ?? 0}/${spec.total}` : undefined]
        .filter(Boolean)
        .join(" · ");
}

/**
 * What a spec's row on the start page says after its name: the workspace
 * that made it, then what it is at - `Billing · design · 2/5`.
 */
export function startSpecFacts(spec: RecentSpecView, workspaces: readonly Workspace[]): string {

    const name = workspaces.find(one => workspaceKey(one) === spec.workspace)?.name;

    return [name, recentSpecFacts(spec)].filter(Boolean).join(" · ");
}

/** The workspace's runtime and model, as the grey line says them: `copilot · sonnet`. Nothing: the server's default. */
export function runtimeText(workspace: Pick<Workspace, "runtime" | "model">): string | undefined {

    return workspace.runtime ? `${workspace.runtime}${workspace.model ? ` · ${workspace.model}` : ""}` : undefined;
}

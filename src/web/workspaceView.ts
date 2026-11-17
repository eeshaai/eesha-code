import { type ChatRow, folderKey, placeKey, type RecentSpecView, type SpecExplorerView, type SpecRowView, type SpecTreeRow, type Workspace, type WorkspaceLink, workspaceKey } from "../server/protocol";
import { baseName } from "./chatGroups";
import { recentList, waitingChats } from "./startView";

/*
 * What a workspace's own page shows (WorkspacePage.tsx). The page is
 * drawn by the UI library's WorkspacePage; the helpers here pick what
 * goes on it. No React and no browser here, so they are tested on their
 * own (src/server/__tests__/workspacePage.test.ts).
 */

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

/** One spec in "Recent specs": its row, and the folder it is in when that is not the main one. */
export interface RecentSpec {

    spec: SpecTreeRow;

    /** Absent: the main folder. */
    folder?: string;
}

/**
 * The specs this workspace made, in all its folders, most recently
 * changed first. Specs made in another workspace on the same main folder
 * are left out: they are that workspace's. `count`: how many - all of
 * them when absent.
 */
export function recentSpecs(view: SpecExplorerView, count?: number): RecentSpec[] {

    const all = view.folders.flatMap(folder => folder.specs
        .filter(spec => !spec.elsewhere)
        .map((spec): RecentSpec => ({ spec, ...(folder.main ? {} : { folder: folder.folder }) })));

    all.sort((left, right) => (right.spec.modified ?? 0) - (left.spec.modified ?? 0) || left.spec.name.localeCompare(right.spec.name));

    return count === undefined ? all : all.slice(0, count);
}

/** How many specs the workspace made, in all its folders. */
export function specCount(view: SpecExplorerView): number {

    return recentSpecs(view).length;
}

/** A spec's row id: its folder and name, since two folders can each have a spec of one name. */
export function recentSpecId(one: RecentSpec): string {

    return `${one.folder ? folderKey(one.folder) : ""}|${one.spec.name}`;
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

/** The work item or issue as the page names it: `ADO #12345`, `GitHub owner/repo#12`. */
export function linkLabel(link: WorkspaceLink): string {

    return link.kind === "workitem" ? `ADO #${link.id}` : `GitHub ${link.id}`;
}

/** The folders as the page's grey line says them: `app`, `app and 2 more folders`. */
export function foldersText(workspace: Pick<Workspace, "folders">): string {

    const [main, ...rest] = workspace.folders;
    const name = main ? baseName(main) : "no folder";

    return rest.length === 0 ? name : `${name} and ${rest.length} more folder${rest.length === 1 ? "" : "s"}`;
}

/** The workspace's runtime and model, as the grey line says them: `copilot · sonnet`. Nothing: the server's default. */
export function runtimeText(workspace: Pick<Workspace, "runtime" | "model">): string | undefined {

    return workspace.runtime ? `${workspace.runtime}${workspace.model ? ` · ${workspace.model}` : ""}` : undefined;
}

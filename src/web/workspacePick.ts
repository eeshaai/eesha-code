import { mainFolderOf, newestAt, type Workspace, type WorkspaceLink, workspaceKey } from "../server/protocol";

/*
 * Which workspace the SDD panel shows. SDD always runs in a workspace. The one picked in the
 * panel's workspace picker; until one is picked, the workspace of the
 * session on screen; else the first one, A to Z. Only workspaces count:
 * a folder sessions work in that is no workspace has no specs. An
 * archived workspace is left out.
 *
 * Kept in the page's memory only, like the rest of the layout.
 *
 * No React and no browser here, so it is tested on its own
 * (src/server/__tests__/workspaces.test.ts).
 */

/** The workspaces as the picker lists them: A to Z by name, archived ones left out. */
export function pickerOrder(workspaces: readonly Workspace[]): Workspace[] {

    return workspaces.filter(one => !one.archived).sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/**
 * The workspace picked: `picked` (a workspace key) when it is still
 * there, else the session on screen's workspace (`sessionKey`), else the
 * newest workspace whose main folder is `sessionFolder` (the session's
 * first folder), else the first one A to Z. Nothing when there is no
 * workspace.
 */
export function pickedWorkspace(workspaces: readonly Workspace[], picked: string | undefined, sessionFolder: string | undefined, sessionKey?: string): Workspace | undefined {

    const list = pickerOrder(workspaces);
    const byKey = (key: string | undefined) => key !== undefined ? list.find(one => workspaceKey(one) === key) : undefined;

    return byKey(picked)
        ?? byKey(sessionKey)
        ?? (sessionFolder ? newestAt(list, sessionFolder) : undefined)
        ?? list[0];
}

/** What the SDD panel needs of the picked workspace. */
export interface SddPlace {

    /** The workspace's key, for the picker. */
    key: string;

    name: string;

    /** Where its specs are kept: its main folder. */
    mainFolder: string;

    /**
     * Another folder of the workspace, when a spec is to be made there
     * (New spec on that folder). Absent: the main
     * folder.
     */
    folder?: string;

    /** The work item or issue it is for - New spec starts from it. */
    link?: WorkspaceLink;
}

export function sddPlace(workspace: Workspace): SddPlace {

    return {
        key: workspaceKey(workspace),
        name: workspace.name,
        mainFolder: mainFolderOf(workspace),
        ...(workspace.link ? { link: workspace.link } : {})
    };
}

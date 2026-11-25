import type { ChatStore } from "../chat/chatStore";
import { isAcpRuntime } from "../chat/permissionLevels";
import { isPermissionLevel, levelFits, type PermissionLevel } from "../core/models/permissionCard";
import { ALIAS_LIMIT, folderKey, newestAt, type Workspace, type WorkspaceLink, workspaceKey } from "./protocol";
import { checkFolders } from "./sessions";

/*
 * The workspaces: named lists of folders, each with the runtime, model
 * and effort a new session in it starts on, whether it may use the
 * system temp folder, and the work item it is for. SDD keeps its
 * specs in the main folder. Kept in the server's store
 * (~/.eesha/state.json), not in a browser, so every tab sees the same
 * list.
 */

/** In the store: workspace key (see `workspaceKey`) to Workspace. */
export const WORKSPACES_KEY = "eesha.workspaces";

/** The longest model id taken. */
const MODEL_LIMIT = 200;

/** The last part of a path - `C:\work\api` is `api`. */
function lastPart(folder: string): string {

    return folder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || folder;
}

/** Shape-checked: saved values outlive builds. */
function isWorkspace(value: unknown): value is Workspace {

    if (!value || typeof value !== "object")
        return false;

    const one = value as Record<string, unknown>;

    return typeof one.name === "string"
        && Array.isArray(one.folders) && one.folders.length > 0 && one.folders.every(folder => typeof folder === "string" && folder !== "")
        && (one.runtime === undefined || typeof one.runtime === "string")
        && (one.model === undefined || typeof one.model === "string")
        && (one.id === undefined || (typeof one.id === "string" && one.id !== ""));
}

function isWorkspaceLink(value: unknown): value is WorkspaceLink {

    if (!value || typeof value !== "object")
        return false;

    const one = value as Record<string, unknown>;

    return (one.connector === "ado" || one.connector === "github")
        && (one.kind === "workitem" || one.kind === "issue")
        && typeof one.id === "string" && one.id !== ""
        && typeof one.title === "string"
        && Array.isArray(one.path) && one.path.length > 0 && one.path.every(level => typeof level === "string" && level !== "")
        && (one.url === undefined || typeof one.url === "string");
}

/**
 * A stored workspace, checked. An effort, temp folder choice or link
 * of the wrong shape is left out - the workspace itself is kept.
 */
function current(workspace: Workspace): Workspace {

    const { effort, tempFolder, link, created, archived, ...rest } = workspace;

    return {
        ...rest,
        ...(typeof created === "number" && Number.isFinite(created) ? { created } : {}),
        ...(archived === true ? { archived } : {}),
        ...(typeof effort === "string" && effort && typeof rest.model === "string" ? { effort } : {}),
        ...(tempFolder === true ? { tempFolder } : {}),
        ...(isWorkspaceLink(link) ? {
            link: { connector: link.connector, kind: link.kind, id: link.id, title: link.title, path: [...link.path], ...(link.url ? { url: link.url } : {}) }
        } : {})
    };
}

function stored(store: ChatStore): Record<string, Workspace> {

    const value = store.get<unknown>(WORKSPACES_KEY);

    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};

    // Each one under its own key: a hand-edited file with a workspace
    // under the wrong key still finds it by the key the page uses.
    return Object.fromEntries(Object.values(value)
        .filter((one): one is Workspace => isWorkspace(one))
        .map(workspace => current(workspace))
        .map(workspace => [workspaceKey(workspace), workspace]));
}

/** Every workspace, archived ones too. */
export function readWorkspaces(store: ChatStore): Workspace[] {

    return Object.values(stored(store));
}

/** The workspace with this key - see `workspaceKey` - or nothing. */
export function workspaceByKey(store: ChatStore, key: string): Workspace | undefined {

    return stored(store)[key];
}

/**
 * The workspace a new session started from this folder goes in - any
 * spelling of it: the newest not archived whose main folder this is.
 * Nothing when there is none.
 */
export function workspaceAt(store: ChatStore, folder: string): Workspace | undefined {

    return newestAt(readWorkspaces(store), folder);
}

/**
 * The workspace a session is in: the one it was started in (`key`),
 * while it is there - else the newest on its first folder.
 */
export function sessionWorkspace(store: ChatStore, key: string | undefined, firstFolder: string | undefined): Workspace | undefined {

    return (key ? workspaceByKey(store, key) : undefined) ?? (firstFolder ? workspaceAt(store, firstFolder) : undefined);
}

/**
 * The key a new workspace on this main folder gets: the folder's own
 * key while no workspace has it - so a first workspace keeps the key its
 * folder's sessions are listed under - else one of its own.
 */
export function newWorkspaceId(store: ChatStore, mainFolder: string, now: number): string | undefined {

    const key = folderKey(mainFolder);
    const taken = stored(store);

    if (!(key in taken))
        return undefined;

    let id = `${key}::${now.toString(36)}`;

    for (let more = 1; id in taken; more++)
        id = `${key}::${now.toString(36)}-${more}`;

    return id;
}

/** A workspace the page sent, checked. `name` is absent when none was given: the server fills it in. */
export type CheckedWorkspace = Omit<Workspace, "name"> & { name?: string };

/**
 * A workspace the page sent, checked: every folder exists, the runtime
 * is one on offer, a model comes only with a runtime, an effort only
 * with a model. The paths come back resolved.
 *
 * The link comes back only as the `>` path the page sent (`linkPath`):
 * what it points at is asked of the connectors, which this file does
 * not reach - EeshaServer does that.
 */
export function checkWorkspace(body: unknown, runtimes: readonly string[]): { workspace: CheckedWorkspace; linkPath?: string[] } | { problem: string } {

    const one = body && typeof body === "object" ? body as Record<string, unknown> : {};

    if (!Array.isArray(one.folders) || !one.folders.length)
        return { problem: "Add the main folder first." };

    const checked = checkFolders(one.folders);

    if ("problem" in checked)
        return checked;

    if (one.name !== undefined && typeof one.name !== "string")
        return { problem: "Send the name as text." };

    const name = typeof one.name === "string" ? one.name.trim() : "";

    if (name.length > ALIAS_LIMIT || /[\r\n]/.test(name))
        return { problem: `A workspace name is one line of up to ${ALIAS_LIMIT} characters.` };

    const runtime = typeof one.runtime === "string" && one.runtime.trim() ? one.runtime.trim() : undefined;
    const model = typeof one.model === "string" && one.model.trim() ? one.model.trim() : undefined;

    if (runtime !== undefined && !runtimes.includes(runtime))
        return { problem: `'${runtime}' is not one of the runtimes on offer: ${runtimes.join(", ") || "none"}.` };

    if (model !== undefined && runtime === undefined)
        return { problem: "Pick a runtime before a model - a model belongs to one runtime." };

    if (model !== undefined && (model.length > MODEL_LIMIT || /[\r\n]/.test(model)))
        return { problem: `A model id is one line of up to ${MODEL_LIMIT} characters.` };

    const effort = typeof one.effort === "string" && one.effort.trim() ? one.effort.trim() : undefined;

    if (effort !== undefined && model === undefined)
        return { problem: "Pick a model before an effort - an effort belongs to one model." };

    if (effort !== undefined && (effort.length > MODEL_LIMIT || /[\r\n]/.test(effort)))
        return { problem: `An effort is one line of up to ${MODEL_LIMIT} characters.` };

    if (one.tempFolder !== undefined && typeof one.tempFolder !== "boolean")
        return { problem: "Send the temp folder choice as true or false." };

    if (one.link !== undefined && one.link !== null && (!Array.isArray(one.link) || !one.link.length || !one.link.every(level => typeof level === "string" && level !== "")))
        return { problem: "Send the linked work item or issue as its > path, one level per entry." };

    return {
        workspace: {
            ...(name ? { name } : {}),
            folders: checked.folders,
            ...(runtime !== undefined ? { runtime } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
            ...(one.tempFolder === true ? { tempFolder: true as const } : {})
        },
        ...(Array.isArray(one.link) ? { linkPath: one.link as string[] } : {})
    };
}

/** The name a workspace gets when none was typed: the main folder's alias, else its own name. */
export function defaultWorkspaceName(mainFolder: string, aliases: Readonly<Record<string, string>>): string {

    return aliases[folderKey(mainFolder)] || lastPart(mainFolder);
}

/** Adds a workspace, or replaces the one with the same key. */
export async function saveWorkspace(store: ChatStore, workspace: Workspace): Promise<void> {

    await store.update(WORKSPACES_KEY, { ...stored(store), [workspaceKey(workspace)]: workspace });
}

/**
 * Takes the workspace with this key off the list. Nothing happens when
 * it is not there.
 */
export async function removeWorkspace(store: ChatStore, key: string): Promise<void> {

    const next = { ...stored(store) };

    if (!(key in next))
        return;

    delete next[key];

    await store.update(WORKSPACES_KEY, next);
}

/** Archives the workspace with this key, or brings it back. False when there is none. */
export async function archiveWorkspace(store: ChatStore, key: string, archived: boolean): Promise<boolean> {

    const found = workspaceByKey(store, key);

    if (!found)
        return false;

    const { archived: _was, ...rest } = found;

    await saveWorkspace(store, archived ? { ...rest, archived: true } : rest);

    return true;
}

/**
 * What a new session started from a folder works in: the folder first,
 * then the rest of its workspace's folders when it is a workspace's
 * main folder.
 */
export function sessionFolders(folder: string, workspace: Workspace | undefined): string[] {

    return workspace ? [folder, ...workspace.folders.slice(1)] : [folder];
}

/** What the start page picked for a new session. */
export interface StartPick {

    /** The session's own runtime. Absent: the workspace's, or the server's. */
    runtime?: string;

    /** Its model. Only set with `runtime`. */
    model?: string;

    /** A Permissions level to save for a runtime - kept per runtime, not per session. */
    level?: { runtime: string; level: PermissionLevel };
}

/**
 * Checks the runtime, model and level a new session was started with.
 * None of them is needed. A model needs a runtime, every runtime must be
 * on offer, and the level must be one its runtime offers.
 */
export function checkStartPick(body: unknown, runtimes: readonly string[]): { pick: StartPick } | { problem: string } {

    const one = body && typeof body === "object" ? body as Record<string, unknown> : {};

    const runtime = typeof one.runtime === "string" && one.runtime.trim() ? one.runtime.trim() : undefined;
    const model = typeof one.model === "string" && one.model.trim() ? one.model.trim() : undefined;

    const offered = (id: string) => runtimes.includes(id) ? undefined : { problem: `'${id}' is not one of the runtimes on offer: ${runtimes.join(", ") || "none"}.` };

    if (runtime !== undefined && offered(runtime))
        return offered(runtime)!;

    if (model !== undefined && runtime === undefined)
        return { problem: "Pick a runtime before a model - a model belongs to one runtime." };

    if (model !== undefined && (model.length > MODEL_LIMIT || /[\r\n]/.test(model)))
        return { problem: `A model id is one line of up to ${MODEL_LIMIT} characters.` };

    let level: StartPick["level"];

    if (one.level !== undefined) {

        const asked = one.level && typeof one.level === "object" ? one.level as Record<string, unknown> : {};
        const levelRuntime = typeof asked.runtime === "string" ? asked.runtime.trim() : "";

        if (!levelRuntime)
            return { problem: "Say which runtime the Permissions level is for." };

        if (offered(levelRuntime))
            return offered(levelRuntime)!;

        if (!isPermissionLevel(asked.level) || !levelFits(asked.level, isAcpRuntime(levelRuntime)))
            return { problem: `'${String(asked.level)}' is not a Permissions level ${levelRuntime} offers.` };

        level = { runtime: levelRuntime, level: asked.level };
    }

    return {
        pick: {
            ...(runtime !== undefined ? { runtime } : {}),
            ...(model !== undefined ? { model } : {}),
            ...(level ? { level } : {})
        }
    };
}

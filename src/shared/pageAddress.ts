import { type ChatRow, type Workspace, workspaceKey } from "../server/protocol";

/*
 * The addresses of workspaces and sessions. The server and the page make
 * and read them the same way, from this file.
 *
 *   /<workspace>                    a workspace's page
 *   /<workspace>/<session>          a session of that workspace
 *   /<workspace>/<spec>/<session>   a session with that spec open beside it
 *   /no-workspace/<session>         a session in no workspace
 *
 * 1. <workspace> is the workspace's name in lower case, with "-" for
 *    spaces and signs: "12 Login page" is `12-login-page`. When two
 *    workspaces get one name, the older one keeps it and the next gets
 *    `-2`, then `-3`. A name the page uses for itself (settings, eval,
 *    workspace, sdd and the like) gets `-2` too.
 * 2. <session> is the session's name the same way, then "-" and the last
 *    part of its id: `fix-login-k3x9q2`. A phase chat is named by its
 *    phase: `design-k3x9q2`. Only the last part finds the session, so an
 *    old address still works after a rename: the server moves it to the
 *    new one.
 * 3. A spec kept in a folder of the workspace other than its main one
 *    adds `?specFolder=<that folder>`.
 * 4. A workspace page with a spec open beside it is `/<workspace>?spec=<name>`.
 *    A spec has no address of its own: specs are only in a workspace.
 */

/** The first part of the address of a session in no workspace. */
export const NO_WORKSPACE_PART = "no-workspace";

/** First parts that are never a workspace's: the page's own paths and the server's. */
const TAKEN = new Set(["settings", "sdd", "workspace", "eval", "events", "assets", "api", "control", NO_WORKSPACE_PART]);

/** Whether an address's first part is one the page or the server uses itself - never a workspace. */
export function isOwnPart(part: string): boolean {

    return TAKEN.has(part) && part !== NO_WORKSPACE_PART;
}

/** The longest a name is in an address, before the id part. */
const NAME_LIMIT = 48;

/** A spec open beside a page: its name, and its folder when that is not the workspace's main one. */
export interface SpecBeside {
    spec: string;
    folder?: string;
}

/** What an address shows: a session, or a workspace's page - with a spec beside it or not. */
export type PageRoute =
    | { chat: string; spec?: SpecBeside }
    | { workspace: string; spec?: SpecBeside };

/** A name as an address writes it: `12 Login page!` is `12-login-page`. Empty when nothing of it is a letter or digit. */
export function addressName(text: string): string {

    return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
        .slice(0, NAME_LIMIT).replace(/-+$/, "");
}

/** Each workspace's part of an address, by its key - see point 1 at the top. Archived workspaces too. */
export function workspaceParts(workspaces: readonly Workspace[]): Map<string, string> {

    const oldestFirst = [...workspaces].sort((left, right) =>
        (left.created ?? 0) - (right.created ?? 0) || workspaceKey(left).localeCompare(workspaceKey(right)));

    const taken = new Set(TAKEN);
    const parts = new Map<string, string>();

    for (const one of oldestFirst) {

        const base = addressName(one.name) || "workspace";
        let part = base;

        for (let more = 2; taken.has(part); more++)
            part = `${base}-${more}`;

        taken.add(part);
        parts.set(workspaceKey(one), part);
    }

    return parts;
}

/** The part of a session's id that finds it: what follows its last "-", in lower case. */
export function chatToken(chatId: string): string {

    return (/-([a-z0-9]+)$/i.exec(chatId)?.[1] ?? chatId).toLowerCase();
}

type Addressed = Pick<ChatRow, "chatId" | "title" | "workspace" | "spec">;

/** A session's last part - see point 2 at the top. */
export function sessionPart(chat: Addressed): string {

    const name = addressName(chat.spec ? chat.spec.phase : chat.title);
    const token = chatToken(chat.chatId);

    return name ? `${name}-${token}` : token;
}

function joined(parts: readonly string[]): string {

    return `/${parts.map(encodeURIComponent).join("/")}`;
}

/** A session's address. `parts`: from `workspaceParts`. A spec beside a session in no workspace is left out: it has no specs. */
export function chatPath(chat: Addressed, parts: ReadonlyMap<string, string>, spec?: SpecBeside): string {

    const place = chat.workspace !== undefined ? parts.get(chat.workspace) : undefined;

    if (!place)
        return joined([NO_WORKSPACE_PART, sessionPart(chat)]);

    const path = joined(spec ? [place, spec.spec, sessionPart(chat)] : [place, sessionPart(chat)]);

    return spec?.folder ? `${path}?${new URLSearchParams({ specFolder: spec.folder })}` : path;
}

/** A workspace page's address. Nothing: no such workspace in `parts`. */
export function workspacePath(key: string, parts: ReadonlyMap<string, string>, spec?: SpecBeside): string | undefined {

    const place = parts.get(key);

    if (!place)
        return undefined;

    if (!spec)
        return joined([place]);

    const query = new URLSearchParams({ spec: spec.spec, ...(spec.folder ? { specFolder: spec.folder } : {}) });

    return `${joined([place])}?${query}`;
}

/** What an address found, and the address it should be - the same when nothing was renamed. */
export interface Resolved {
    route: PageRoute;
    address: string;
}

/**
 * What a path and query show, and the address they should be (after a
 * rename, or an address typed by hand). Nothing: not one of these
 * addresses, or nothing is there - no such workspace or session.
 */
export function resolveAddress(pathname: string, search: string, chats: readonly Addressed[], workspaces: readonly Workspace[]): Resolved | undefined {

    let names: string[];

    try {

        names = pathname.split("/").filter(Boolean).map(decodeURIComponent);

    } catch {

        return undefined;
    }

    if (!names.length || names.length > 3 || isOwnPart(names[0]!))
        return undefined;

    const parts = workspaceParts(workspaces);
    const query = new URLSearchParams(search);
    const folder = query.get("specFolder") || undefined;

    if (names.length === 1) {

        const key = [...parts.entries()].find(([, part]) => part === names[0])?.[0];

        if (key === undefined)
            return undefined;

        const name = query.get("spec") || undefined;
        const spec = name ? { spec: name, ...(folder ? { folder } : {}) } : undefined;

        return { route: { workspace: key, ...(spec ? { spec } : {}) }, address: workspacePath(key, parts, spec)! };
    }

    const last = names[names.length - 1]!;
    const token = (/-([a-z0-9]+)$/i.exec(last)?.[1] ?? last).toLowerCase();
    const found = chats.filter(chat => chatToken(chat.chatId) === token);
    const chat = found.find(one => sessionPart(one) === last) ?? found[0];

    if (!chat)
        return undefined;

    const spec = names.length === 3 && chat.workspace !== undefined && parts.has(chat.workspace)
        ? { spec: names[1]!, ...(folder ? { folder } : {}) }
        : undefined;

    return { route: { chat: chat.chatId, ...(spec ? { spec } : {}) }, address: chatPath(chat, parts, spec) };
}

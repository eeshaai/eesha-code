/*
 * The page's addresses.
 *
 *   /                    the start page
 *   /<workspace>         a workspace's own page. `?spec=<name>` (and
 *                        `specFolder`): that spec open beside it.
 *   /<workspace>/<session>
 *                        a session of that workspace, its chat full screen
 *   /<workspace>/<spec>/<session>
 *                        a session with that spec open as a tab beside it
 *                        - `?specFolder=` too when the spec is not in the
 *                        workspace's main folder
 *   /no-workspace/<session>
 *                        a session in no workspace
 *   /settings/<section>  Settings: general, connectors, memory, runtimes,
 *                        features, storage. Plain /settings is General.
 *   /eval                the Evaluator: every evaluation, and a form to
 *                        make one.
 *   /eval/<name>         one evaluation: its variants' chats side by side.
 *   /?chat=<id>&column=1 one variant's chat with nothing around it - what
 *                        an evaluation's page shows in each column's frame.
 *
 * How the workspace and session names are written, and how a session is
 * found by the last part of its id: shared/pageAddress.ts. The server
 * reads those addresses and tells the page what they show, in the page
 * itself (`eesha-route`); the page does not read the names.
 *
 * Older addresses still work: the server moves `/?chat=<id>` and
 * `/workspace?workspace=<key>` to their new ones, and a renamed workspace
 * or session to its new name. `/sdd?workspace=<key>&spec=<name>` goes on
 * to the spec's newest phase chat, or its workspace page with none yet.
 *
 * A session or workspace the page has not heard of yet (one just made)
 * gets its older address, which the server moves on.
 *
 * Nothing else is in the address: opening the session
 * list, a panel section, an editor tab, a menu or a dialog leaves it as it
 * is. The workspace panel comes back after a reload as it was in this
 * browser tab (sideState.ts). The one tab an
 * address keeps is a spec.
 *
 * Moving between the start page, workspace pages and sessions does not
 * load the page again (`goTo`): the address changes, a Back entry is
 * added, and the page is drawn afresh for the new address - as a reload
 * would, without one. Back and Forward move the same way. Moving to or
 * from Settings, the Evaluator or an older `/sdd` link is a real page
 * load, and so is an address the page cannot read itself (the server
 * then says what it shows).
 */

import type { ChatRow, Workspace } from "../server/protocol";
import { chatPath, type PageRoute, resolveAddress, workspaceParts, workspacePath } from "../shared/pageAddress";

/** The sessions and workspaces addresses are made from - see `setAddressBook`. */
let book: { chats: ReadonlyMap<string, ChatRow>; workspaces: readonly Workspace[]; parts: ReadonlyMap<string, string> } = { chats: new Map(), workspaces: [], parts: new Map() };

/**
 * Gives the address makers the lists the page has, so `chatAddress` and
 * `workspaceAddress` can write names. The page calls it each time the
 * lists change, before anything draws from them.
 */
export function setAddressBook(chats: readonly ChatRow[], workspaces: readonly Workspace[]): void {

    book = { chats: new Map(chats.map(chat => [chat.chatId, chat])), workspaces, parts: workspaceParts(workspaces) };
}

/**
 * What the address shows: what the server said when the page loaded,
 * then what `goTo` and Back found. No route: an address read from its
 * query (the start page, Settings, the older ones).
 */
let routeRead: { route?: PageRoute } | undefined;

function pageRoute(): PageRoute | undefined {

    if (!routeRead) {

        const text = typeof document !== "undefined" ? document.querySelector("meta[name=\"eesha-route\"]")?.getAttribute("content") : undefined;

        try {

            routeRead = { ...(text ? { route: JSON.parse(text) as PageRoute } : {}) };

        } catch {

            routeRead = {};
        }
    }

    return routeRead.route;
}

export const SETTINGS_SECTIONS = ["general", "connectors", "memory", "runtimes", "features", "storage"] as const;

export type SettingsSection = typeof SETTINGS_SECTIONS[number];

/** The section a plain `/settings` opens. */
export const FIRST_SECTION: SettingsSection = "general";

/** Every path that shows Settings - the server sends the page for these too. */
export const SETTINGS_PATHS: readonly string[] = [
    "/settings",
    ...SETTINGS_SECTIONS.map(section => `/settings/${section}`)
];

/** The Settings section an address path names. Nothing: the start page or a session. */
export function pageOfPath(pathname: string): SettingsSection | undefined {

    const name = pathname.replace(/^\/+|\/+$/g, "");

    if (name === "settings")
        return FIRST_SECTION;

    const section = /^settings\/([a-z]+)$/.exec(name)?.[1];

    return section !== undefined && (SETTINGS_SECTIONS as readonly string[]).includes(section)
        ? section as SettingsSection
        : undefined;
}

/** A spec open as a tab: its name, and its folder when that is not the workspace's main folder. */
export interface SpecInAddress {
    spec: string;
    folder?: string;
}

/** The spec tab's part of an address - see the list at the top. */
function specQuery(query: URLSearchParams, spec: SpecInAddress | undefined): void {

    if (!spec)
        return;

    query.set("spec", spec.spec);

    if (spec.folder)
        query.set("specFolder", spec.folder);
}

/** A session's address, or the start page's with none. `spec`: a spec of its workspace open as a tab. */
export function chatAddress(chatId: string | undefined, spec?: SpecInAddress): string {

    if (!chatId)
        return "/";

    const known = book.chats.get(chatId);

    if (known)
        return chatPath(known, book.parts, spec);

    const query = new URLSearchParams({ chat: chatId });

    specQuery(query, spec);

    return `/?${query}`;
}

/** The spec tab the browser's address names now, on a session or a workspace page. */
export function specInAddress(): SpecInAddress | undefined {

    const route = pageRoute();

    if (route)
        return route.spec;

    const query = new URLSearchParams(location.search);
    const spec = query.get("spec") || undefined;
    const folder = query.get("specFolder") || undefined;

    return spec && location.pathname.replace(/\/+$/, "") !== SDD_PATH ? { spec, ...(folder ? { folder } : {}) } : undefined;
}

/** A Settings section's address. */
export function settingsAddress(section: SettingsSection = FIRST_SECTION): string {

    return `/settings/${section}`;
}

/** The SDD module's path. */
export const SDD_PATH = "/sdd";

/** A workspace page's path. */
export const WORKSPACE_PATH = "/workspace";

/** The Evaluator's path. One evaluation is `/eval/<name>`, which the server sends the page for too. */
export const EVAL_PATH = "/eval";

/** Every path the server sends the page for. */
export const PAGE_PATHS: readonly string[] = ["/", ...SETTINGS_PATHS, SDD_PATH, WORKSPACE_PATH, EVAL_PATH];

/**
 * What one evaluation's page shows, said in its address:
 *
 *   /eval/<name>                  every variant's chat, side by side
 *   /eval/<name>?variant=<v>      one variant's chat, as wide as the page
 *   /eval/<name>?view=report      the report
 */
export interface EvalShown {

    report?: boolean;

    /** One variant alone, by its name. Not read on the report. */
    variant?: string;
}

/** The Evaluator's address, or one evaluation's - see {@link EvalShown}. */
export function evalAddress(name?: string, shown: EvalShown = {}): string {

    if (!name)
        return EVAL_PATH;

    const query = shown.report ? "?view=report" : shown.variant ? `?${new URLSearchParams({ variant: shown.variant })}` : "";

    return `${EVAL_PATH}/${encodeURIComponent(name)}${query}`;
}

/** What an evaluation's address asks to show. */
export function evalShownOfAddress(search: string): EvalShown {

    const query = new URLSearchParams(search);

    if (query.get("view") === "report")
        return { report: true };

    const variant = query.get("variant");

    return variant ? { variant } : {};
}

/**
 * What an Evaluator address names. Nothing: not the Evaluator. With no
 * `name`: the list of evaluations.
 */
export function evalOfAddress(pathname: string): { name?: string } | undefined {

    const path = pathname.replace(/\/+$/, "");

    if (path === EVAL_PATH)
        return {};

    if (!path.startsWith(`${EVAL_PATH}/`))
        return undefined;

    const name = decodeURIComponent(path.slice(EVAL_PATH.length + 1));

    return name && !name.includes("/") ? { name } : undefined;
}

/** The Evaluator address the browser's address names now. */
export function evalInAddress(): { name?: string } | undefined {

    return evalOfAddress(location.pathname);
}

/** The address of one variant's chat with nothing around it - a column's frame. */
export function columnAddress(chatId: string): string {

    return `/?${new URLSearchParams({ chat: chatId, column: "1" })}`;
}

/** Whether a query asks for a chat with nothing around it. */
export function columnOfAddress(search: string): boolean {

    const query = new URLSearchParams(search);

    return query.get("column") === "1" && Boolean(query.get("chat"));
}

/** Whether the browser's address is a column's frame. */
export function columnInAddress(): boolean {

    return columnOfAddress(location.search);
}

/** A workspace page's address, by the workspace's key. `spec`: a spec of it open as a tab. */
export function workspaceAddress(key: string, spec?: SpecInAddress): string {

    const named = workspacePath(key, book.parts, spec);

    if (named)
        return named;

    const query = new URLSearchParams({ workspace: key });

    specQuery(query, spec);

    return `${WORKSPACE_PATH}?${query}`;
}

/**
 * The workspace a path and query name, by its key. Nothing: not a
 * workspace page. An empty key is a workspace page with no workspace -
 * the page says so.
 */
export function workspaceOfAddress(pathname: string, search: string): string | undefined {

    if (pathname.replace(/\/+$/, "") !== WORKSPACE_PATH)
        return undefined;

    return new URLSearchParams(search).get("workspace") ?? "";
}

/** The workspace page the browser's address names now. */
export function workspaceInAddress(): string | undefined {

    const route = pageRoute();

    if (route)
        return "workspace" in route ? route.workspace : undefined;

    return workspaceOfAddress(location.pathname, location.search);
}

/**
 * What an SDD address names: a workspace by its key, and a spec in it.
 * The rest only with a spec: the folder it is in when that is not the
 * workspace's main folder, and a phase or one session of it to show
 * first.
 */
export interface SddAddress {

    workspace?: string;

    spec?: string;

    folder?: string;

    phase?: string;

    /** A session: its owner (a phase id, or `implement@wave:2`), and which of its sessions - absent for the one still open. */
    session?: { ownerId: string; iteration?: number };
}

/** What an SDD address can name after the spec - see {@link SddAddress}. */
export type SddAddressMore = Pick<SddAddress, "folder" | "phase" | "session">;

/** An SDD address: a spec of a workspace, or with no spec the workspace's specs only. */
export function sddAddress(workspace: string | undefined, spec?: string, more: SddAddressMore = {}): string {

    const query = new URLSearchParams({ ...(workspace ? { workspace } : {}), ...(workspace && spec ? { spec } : {}) });

    if (workspace && spec) {

        if (more.folder)
            query.set("folder", more.folder);

        if (more.phase)
            query.set("phase", more.phase);

        if (more.session) {

            query.set("session", more.session.ownerId);

            if (more.session.iteration !== undefined)
                query.set("n", String(more.session.iteration));
        }
    }

    const text = query.toString();

    return text ? `${SDD_PATH}?${text}` : SDD_PATH;
}

/** The SDD address in a path and query. Nothing: not the SDD module. */
export function sddOfAddress(pathname: string, search: string): SddAddress | undefined {

    if (pathname.replace(/\/+$/, "") !== SDD_PATH)
        return undefined;

    const query = new URLSearchParams(search);
    const workspace = query.get("workspace") || undefined;
    const spec = workspace ? query.get("spec") || undefined : undefined;

    if (!workspace || !spec)
        return { ...(workspace ? { workspace } : {}) };

    const folder = query.get("folder") || undefined;
    const phase = query.get("phase") || undefined;
    const ownerId = query.get("session") || undefined;
    const iteration = Number(query.get("n"));

    return {
        workspace,
        spec,
        ...(folder ? { folder } : {}),
        ...(phase ? { phase } : {}),
        ...(ownerId ? { session: { ownerId, ...(Number.isInteger(iteration) && iteration > 0 ? { iteration } : {}) } } : {})
    };
}

/** The SDD address the browser's address names now. */
export function sddInAddress(): SddAddress | undefined {

    return sddOfAddress(location.pathname, location.search);
}

/** The Settings section the browser's address names now. */
export function pageInAddress(): SettingsSection | undefined {

    return pageOfPath(location.pathname);
}

/** The session the browser's address names now. */
export function chatInAddress(): string | undefined {

    const route = pageRoute();

    if (route)
        return "chat" in route ? route.chat : undefined;

    return new URLSearchParams(location.search).get("chat") || undefined;
}

/** Paths that are always a real page load: they are pages of their own, or the server sends them on. */
function loadsItself(pathname: string): boolean {

    const path = pathname.replace(/\/+$/, "") || "/";

    return pageOfPath(path) !== undefined || evalOfAddress(path) !== undefined || path === SDD_PATH;
}

/**
 * What an address shows, read here with no page load. Nothing: it needs
 * one - another site, a page of its own (Settings, the Evaluator, `/sdd`),
 * a column's frame, or a name this page has not heard of.
 */
export function routeOf(address: string, base: string = location.href): { route?: PageRoute; address: string } | undefined {

    let url: URL;

    try {

        url = new URL(address, base);

    } catch {

        return undefined;
    }

    if (url.origin !== new URL(base).origin || loadsItself(url.pathname) || columnOfAddress(url.search) || url.searchParams.has("key"))
        return undefined;

    const written = `${url.pathname}${url.search}`;

    // The start page, a session by its id, and a workspace page by its
    // key: read from the query, as when the page loads.
    if (url.pathname === "/" || url.pathname.replace(/\/+$/, "") === WORKSPACE_PATH)
        return { address: written };

    const found = resolveAddress(url.pathname, url.search, [...book.chats.values()], book.workspaces);

    return found ? { route: found.route, address: found.address } : undefined;
}

type MoveListener = () => void;

const moveListeners = new Set<MoveListener>();

/** Called after each move with no page load - the page draws itself again for the new address. */
export function onPageMove(listener: MoveListener): () => void {

    moveListeners.add(listener);

    return () => moveListeners.delete(listener);
}

function moved(route: PageRoute | undefined): void {

    routeRead = { ...(route ? { route } : {}) };

    for (const listener of moveListeners)
        listener();
}

/**
 * Goes to an address: with no page load when this page can show it
 * (see `routeOf`), else a real one. `replace`: no Back entry - for a
 * page that sends you on by itself.
 */
export function goTo(address: string, replace = false): void {

    const found = moveListeners.size ? routeOf(address) : undefined;

    if (!found)
        return replace ? location.replace(address) : location.assign(address);

    // The address on screen again (the session shown in another tab, say): drawn afresh, with no new Back entry.
    if (replace || `${location.pathname}${location.search}` === found.address)
        history.replaceState(null, "", found.address);
    else
        history.pushState(null, "", found.address);

    moved(found.route);
}

/**
 * Back and Forward: the page is drawn for the address they went to -
 * with no page load when it can be, else a real one.
 */
export function followHistory(): () => void {

    const onPop = (): void => {

        const found = routeOf(location.href);

        if (!found)
            return location.reload();

        moved(found.route);
    };

    addEventListener("popstate", onPop);

    return () => removeEventListener("popstate", onPop);
}

/**
 * A click on a link this page can show: goes there with no page load.
 * A click with Ctrl, Shift, Alt or the middle button, a link to a new
 * browser tab, a download and a link to the same page with only a `#`
 * keep what the browser does.
 *
 * Heard before the page's own handlers (the capture phase): a menu or a
 * popover stops the click going further up, and its links would load
 * the page. So a link whose own click does something else instead must
 * not point at an address this page reads - use `#`, or a button.
 */
export function followLinks(): () => void {

    const onClick = (event: MouseEvent): void => {

        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
            return;

        const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;

        if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download"))
            return;

        const url = new URL(link.href, location.href);

        if (url.hash && url.pathname === location.pathname && url.search === location.search)
            return;

        if (!routeOf(url.href))
            return;

        event.preventDefault();
        goTo(url.href);
    };

    addEventListener("click", onClick, true);

    return () => removeEventListener("click", onClick, true);
}

/*
 * The page's addresses.
 *
 *   /                    the start page
 *   /?chat=<id>          a session, its chat full screen
 *   /?chat=<id>&spec=<name>
 *                        a session with a spec of its workspace open as
 *                        a tab beside it - `specFolder` too when the
 *                        spec is not in the workspace's main folder.
 *   /settings/<section>  Settings: general, connectors, memory, runtimes,
 *                        features, storage. Plain /settings is General.
 *   /workspace?workspace=<key>
 *                        a workspace's own page: its start box, its
 *                        recent specs and its recent sessions. Named by
 *                        its key - see `workspaceKey`. With `spec` (and
 *                        `specFolder`), that spec open as a tab beside it.
 *   /sdd?workspace=<key>&spec=<name>
 *                        an older spec link. The page goes on to the
 *                        spec's newest phase chat with the spec as a tab,
 *                        or to its workspace page when it has none yet.
 *
 * Nothing else is in the address: opening the session
 * list, a right panel, an editor tab, a menu or a dialog leaves it as it
 * is, and a reload shows only the session, full screen. The one tab an
 * address keeps is a spec. Moving to another session or to Settings is
 * a real page load.
 */

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

    const query = new URLSearchParams({ chat: chatId });

    specQuery(query, spec);

    return `/?${query}`;
}

/** The spec tab the browser's address names now, on a session or a workspace page. */
export function specInAddress(): SpecInAddress | undefined {

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

/** Every path the server sends the page for. */
export const PAGE_PATHS: readonly string[] = ["/", ...SETTINGS_PATHS, SDD_PATH, WORKSPACE_PATH];

/** Where the Specs item of a workspace's menu leaves word for the page it loads - see `openSpecsOf`. */
const SPECS_NOTE_KEY = "eesha.specsOnLoad";

/**
 * Goes to a workspace's page with its Spec explorer open - the Specs
 * item of a workspace's menu. The page is a new load, so the word goes
 * in this browser tab's storage, not in the address.
 */
export function openSpecsOf(key: string): void {

    try {

        sessionStorage.setItem(SPECS_NOTE_KEY, key);

    } catch {

        // The page still opens, only without the explorer.
    }

    location.assign(workspaceAddress(key));
}

/**
 * Whether the Specs item asked for this workspace's page to open with
 * its Spec explorer shown. Read only: `dropSpecsNote` takes the word
 * away once the page has used it.
 */
export function specsAskedFor(key: string | undefined): boolean {

    try {

        return key !== undefined && sessionStorage.getItem(SPECS_NOTE_KEY) === key;

    } catch {

        return false;
    }
}

/** Takes away the Specs item's word, so a reload opens the page as usual. */
export function dropSpecsNote(): void {

    try {

        sessionStorage.removeItem(SPECS_NOTE_KEY);

    } catch {

        // Nothing to take away.
    }
}

/** A workspace page's address, by the workspace's key. `spec`: a spec of it open as a tab. */
export function workspaceAddress(key: string, spec?: SpecInAddress): string {

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

    return workspaceOfAddress(location.pathname, location.search);
}

/**
 * What an SDD address names: a workspace by its key, and a spec in it.
 * The rest only with a spec: the folder it is in when that is not the
 * workspace's main folder, and a phase or one session of it to show
 * first - from the Spec explorer.
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

    return new URLSearchParams(location.search).get("chat") || undefined;
}

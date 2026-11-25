/*
 * The page's layout. Left to right: the workspace panel, then the chat
 * filling the rest. When a file, a diff, a spec or the logs open, the
 * editor takes the middle and the chat moves to the right at its own
 * width.
 *
 * The workspace panel is one column of sections that open and close on
 * their own: Sessions, Files, AI changes, Git and This session. The AI
 * button in the header shows or hides the whole panel.
 *
 * Whether the panel shows, and which sections are open, is kept per
 * session in this browser tab, so a reload of a session shows them
 * again. The editor and its tabs are not kept. The chat's dragged width,
 * and whether the Git section shows its files as a tree, are kept in
 * this browser.
 */

/** A section of the workspace panel. */
export type Fold = "sessions" | "files" | "changes" | "git" | "session";

/** The sections, top to bottom. */
export const FOLDS: readonly Fold[] = ["sessions", "files", "changes", "git", "session"];

/** Whether the workspace panel shows, and which of its sections are open. */
export interface PanelState {

    open: boolean;

    /** The open sections, in FOLDS order. */
    folds: Fold[];
}

/**
 * The panel on a page load with nothing kept for it: shown, with only
 * Sessions open. A session's own reload uses what loadPanels kept.
 */
export const PANEL_ON_LOAD: PanelState = { open: true, folds: ["sessions"] };

/** The open sections in FOLDS order, each once. */
function ordered(folds: readonly Fold[]): Fold[] {

    return FOLDS.filter(fold => folds.includes(fold));
}

/** A section's head clicked: it opens, or closes when it is open. */
export function toggleFold(now: PanelState, fold: Fold): PanelState {

    return { ...now, folds: ordered(now.folds.includes(fold) ? now.folds.filter(one => one !== fold) : [...now.folds, fold]) };
}

/**
 * A key or a button that asks for a section: the panel shows, with that
 * section open. Already shown and open: it closes, so the same key hides
 * it again.
 */
export function showFold(now: PanelState, fold: Fold): PanelState {

    if (now.open && now.folds.includes(fold))
        return toggleFold(now, fold);

    return { open: true, folds: ordered([...now.folds, fold]) };
}

/** The workspace panel's narrowest width - its width on every page load - and its widest. */
export const NAV_MIN = 300;
export const NAV_MAX = NAV_MIN + 150;

/** The chat's width while the editor is open, and how far it can be dragged. */
export const CHAT_MIN = 360;
export const CHAT_MAX = 560;
export const CHAT_WIDTH = 400;

/**
 * The least room the editor gets. With less, the workspace panel closes
 * by itself. 560 so that a 1280px window keeps the panel (300), the chat
 * (400) and the editor (580) - the panel holds Git, Files and AI changes,
 * which open things in the editor.
 */
export const EDITOR_MIN = 560;

/**
 * Window widths. Below PAGE_MIN a cover asks for a wider
 * window. Between PAGE_MIN and PAGE_WIDTH the page stays PAGE_WIDTH wide
 * and the window scrolls sideways. At 150% scale a 1920 screen gives 1280.
 */
export const PAGE_MIN = 1024;
export const PAGE_WIDTH = 1280;

/** How wide the page is drawn in a window this wide: never under PAGE_WIDTH. */
export function pageWidth(windowWidth: number): number {

    return Math.max(windowWidth, PAGE_WIDTH);
}

/** The widths the edges were dragged to. */
export interface Widths {

    chat: number;
}

const WIDTHS_KEY = "eesha.widths";

export const DEFAULT_WIDTHS: Widths = { chat: CHAT_WIDTH };

export function clampWidth(width: number, min: number, max: number): number {

    return Math.round(Math.min(max, Math.max(min, width)));
}

/**
 * Whether the editor still gets its least room with the workspace panel
 * open: the window's width less the panel (when open) and the chat.
 */
export function editorFits(windowWidth: number, list: number | undefined, chat: number): boolean {

    return windowWidth - (list ?? 0) - chat >= EDITOR_MIN;
}

/** The widths this browser kept, or the defaults. */
export function loadWidths(): Widths {

    try {

        const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null") as Partial<Record<keyof Widths, unknown>> | null;

        if (saved && typeof saved === "object")
            return { chat: typeof saved.chat === "number" ? clampWidth(saved.chat, CHAT_MIN, CHAT_MAX) : CHAT_WIDTH };

    } catch {

        // Nothing saved that can be read - the defaults.
    }

    return DEFAULT_WIDTHS;
}

export function saveWidths(widths: Widths): void {

    try {

        localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));

    } catch {

        // A browser that keeps nothing: the defaults next time.
    }
}

const PANELS_KEY = "eesha.panels";

/**
 * The panel kept for this session in this browser tab (sessionStorage).
 * Nothing when no session is named, nothing was kept, or what was kept
 * cannot be read. A section name that is not known any more is dropped.
 */
export function loadPanels(chatId: string | undefined): PanelState | undefined {

    if (!chatId)
        return undefined;

    try {

        const saved = JSON.parse(sessionStorage.getItem(`${PANELS_KEY}.${chatId}`) ?? "null") as { open?: unknown; folds?: unknown } | null;

        if (!saved || typeof saved !== "object" || typeof saved.open !== "boolean" || !Array.isArray(saved.folds))
            return undefined;

        return { open: saved.open, folds: ordered(saved.folds.filter((fold): fold is Fold => FOLDS.includes(fold as Fold))) };

    } catch {

        return undefined;
    }
}

/** Keeps the session's panel for a reload of this browser tab. No session: nothing kept. */
export function savePanels(chatId: string | undefined, state: PanelState): void {

    if (!chatId)
        return;

    try {

        sessionStorage.setItem(`${PANELS_KEY}.${chatId}`, JSON.stringify({ open: state.open, folds: state.folds }));

    } catch {

        // A browser that keeps nothing: the panel as on a first load after a reload.
    }
}

const PLACE_KEY = "eesha.panelPlace";

/** The workspace the Sessions section showed last in this browser - for a page that has none of its own. */
export function loadPanelPlace(): string | undefined {

    try {

        return localStorage.getItem(PLACE_KEY) ?? undefined;

    } catch {

        return undefined;
    }
}

export function savePanelPlace(place: string): void {

    try {

        localStorage.setItem(PLACE_KEY, place);

    } catch {

        // A browser that keeps nothing: the page's own workspace next time.
    }
}

const GIT_TREE_KEY = "eesha.gitTree";

/** Whether the Git section showed its files as a tree last time. Nothing saved: the list. */
export function loadGitTree(): boolean {

    try {

        return localStorage.getItem(GIT_TREE_KEY) === "true";

    } catch {

        return false;
    }
}

export function saveGitTree(tree: boolean): void {

    try {

        localStorage.setItem(GIT_TREE_KEY, String(tree));

    } catch {

        // A browser that keeps nothing: the list next time.
    }
}

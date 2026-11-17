/*
 * The page's layout. Left to right: the
 * strip of module icons, the module's panel (the AI sessions), the chat,
 * the editor, and a panel on the right (Session, Git, AI changes, File
 * explorer or Spec explorer).
 *
 * Which panels are open - the strip's panel and the right panel - is kept
 * per session in this browser tab, so a reload of a
 * session shows them again. The editor and its tabs are not kept. The
 * widths the edges were dragged to, and whether the Git panel shows its
 * files as a tree, are kept in this browser.
 */

/**
 * The modules on the strip at the far left: AI (the sessions). Specs are
 * not a module - they are in the Spec explorer, a right panel.
 */
export type StripModule = "ai";

/** The strip's width. It is always icons only. */
export const STRIP_WIDTH = 44;

/** Which module is picked on the strip, and whether its panel shows beside the strip. */
export interface StripState {

    module: StripModule;

    open: boolean;
}

/**
 * The strip on a page load with nothing kept for it: the start page,
 * Settings, and a session opened for the first time in this browser tab.
 * A session's own reload uses what loadPanels kept.
 */
export const STRIP_ON_LOAD: StripState = { module: "ai", open: false };

/**
 * A click on a strip icon: another module's icon picks it and opens its
 * panel; the pressed icon - its panel open - hides the panel again. The
 * strip itself always stays.
 */
export function pickModule(now: StripState, picked: StripModule): StripState {

    return now.module === picked ? { module: picked, open: !now.open } : { module: picked, open: true };
}

/** What the right panel can show. */
export type RightPanel = "session" | "git" | "changes" | "files" | "specs";

export const RIGHT_PANELS: readonly RightPanel[] = ["session", "git", "changes", "files", "specs"];

/** The session list's narrowest width - its width on every page load - and its widest. */
export const NAV_MIN = 300;
export const NAV_MAX = NAV_MIN + 150;

/** The chat's width while the editor is open, and how far it can be dragged. */
export const CHAT_MIN = 360;
export const CHAT_MAX = 560;
export const CHAT_WIDTH = 400;

/** The right panel's width, and how far it can be dragged. */
export const PANEL_MIN = 260;
export const PANEL_MAX = 480;
export const PANEL_WIDTH = 320;

/** The least room the editor gets. With less, the session list closes by itself. */
export const EDITOR_MIN = 640;

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
    panel: number;
}

const WIDTHS_KEY = "eesha.widths";

export const DEFAULT_WIDTHS: Widths = { chat: CHAT_WIDTH, panel: PANEL_WIDTH };

export function clampWidth(width: number, min: number, max: number): number {

    return Math.round(Math.min(max, Math.max(min, width)));
}

/** A right panel icon: its panel opens, or closes when it is the one open. */
export function togglePanel(open: RightPanel | undefined, picked: RightPanel): RightPanel | undefined {

    return open === picked ? undefined : picked;
}

/**
 * Whether the editor still gets its least room with the module panel
 * open: the window's width less the strip, the panel, the chat and the
 * right panel (when they are open).
 */
export function editorFits(windowWidth: number, list: number | undefined, chat: number, panel: number | undefined): boolean {

    return windowWidth - STRIP_WIDTH - (list ?? 0) - chat - (panel ?? 0) >= EDITOR_MIN;
}

/** The widths this browser kept, or the defaults. */
export function loadWidths(): Widths {

    try {

        const saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? "null") as Partial<Record<keyof Widths, unknown>> | null;

        if (saved && typeof saved === "object")
            return {
                chat: typeof saved.chat === "number" ? clampWidth(saved.chat, CHAT_MIN, CHAT_MAX) : CHAT_WIDTH,
                panel: typeof saved.panel === "number" ? clampWidth(saved.panel, PANEL_MIN, PANEL_MAX) : PANEL_WIDTH
            };

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

/** Which panels are open in a session. */
export interface PanelsState {

    strip: StripState;

    /** The right panel open. Nothing: closed. */
    panel?: RightPanel;
}

const PANELS_KEY = "eesha.panels";

const STRIP_MODULES: readonly StripModule[] = ["ai"];

/**
 * The panels kept for this session in this browser tab (sessionStorage).
 * Nothing when no session is named, nothing was kept, or what was kept
 * cannot be read.
 */
export function loadPanels(chatId: string | undefined): PanelsState | undefined {

    if (!chatId)
        return undefined;

    try {

        const saved = JSON.parse(sessionStorage.getItem(`${PANELS_KEY}.${chatId}`) ?? "null") as { module?: unknown; open?: unknown; panel?: unknown } | null;

        if (!saved || typeof saved !== "object" || !STRIP_MODULES.includes(saved.module as StripModule) || typeof saved.open !== "boolean")
            return undefined;

        return {
            strip: { module: saved.module as StripModule, open: saved.open },
            panel: RIGHT_PANELS.includes(saved.panel as RightPanel) ? saved.panel as RightPanel : undefined
        };

    } catch {

        return undefined;
    }
}

/** Keeps which panels are open in this session, for a reload of this browser tab. No session: nothing kept. */
export function savePanels(chatId: string | undefined, state: PanelsState): void {

    if (!chatId)
        return;

    try {

        sessionStorage.setItem(`${PANELS_KEY}.${chatId}`, JSON.stringify({ module: state.strip.module, open: state.strip.open, panel: state.panel }));

    } catch {

        // A browser that keeps nothing: closed panels after a reload.
    }
}

const GIT_TREE_KEY = "eesha.gitTree";

/** Whether the Git panel showed its files as a tree last time. Nothing saved: the list. */
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

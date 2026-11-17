// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_MAX, CHAT_WIDTH, DEFAULT_WIDTHS, editorFits, loadGitTree, loadPanels, loadWidths, PAGE_MIN, PAGE_WIDTH, pageWidth, PANEL_MIN, PANEL_WIDTH, saveGitTree, savePanels, saveWidths, STRIP_ON_LOAD, togglePanel } from "../../web/sideState";

/** A browser's storage, holding what a test puts in it. */
function storage(saved: Record<string, string> = {}) {

    const kept = new Map(Object.entries(saved));

    vi.stubGlobal("localStorage", {
        getItem: (key: string) => kept.get(key) ?? null,
        setItem: (key: string, value: string) => { kept.set(key, value); }
    });

    return kept;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("the page's layout", () => {

    it("opens a right panel, switches to another, and closes the one open when its icon is clicked again", () => {

        expect(togglePanel(undefined, "git")).toBe("git");
        expect(togglePanel("git", "changes")).toBe("changes");
        expect(togglePanel("changes", "changes")).toBeUndefined();
    });

    it("says whether the editor keeps its 640px with the session list open", () => {

        // 1920 - 300 - 400 - 320 = 900: fits.
        expect(editorFits(1920, 300, 400, 320)).toBe(true);

        // 1440 - 300 - 400 - 320 = 420: the list has to close.
        expect(editorFits(1440, 300, 400, 320)).toBe(false);

        // The same window without the list: 740, fits.
        expect(editorFits(1440, undefined, 400, 320)).toBe(true);
    });

    it("draws the page at least 1280 wide, so a narrower window scrolls sideways", () => {

        expect(pageWidth(1100)).toBe(PAGE_WIDTH);
        expect(pageWidth(1280)).toBe(1280);
        expect(pageWidth(1920)).toBe(1920);
        expect(PAGE_MIN).toBe(1024);
    });

    it("starts on the default widths when nothing was saved", () => {

        storage();

        expect(loadWidths()).toEqual({ chat: CHAT_WIDTH, panel: PANEL_WIDTH });
    });

    it("keeps the dragged widths, held inside their limits", () => {

        const kept = storage();

        saveWidths({ chat: 450, panel: 300 });

        expect(loadWidths()).toEqual({ chat: 450, panel: 300 });

        kept.set("eesha.widths", JSON.stringify({ chat: 9000, panel: 10, view: "git" }));

        expect(loadWidths()).toEqual({ chat: CHAT_MAX, panel: PANEL_MIN });
    });

    it("is the default when the browser keeps nothing", () => {

        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadWidths()).toEqual(DEFAULT_WIDTHS);
        expect(() => saveWidths(DEFAULT_WIDTHS)).not.toThrow();
    });

    it("keeps each session's open panels in this browser tab, apart from other sessions", () => {

        const kept = new Map<string, string>();

        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => { kept.set(key, value); }
        });

        expect(loadPanels("a")).toBeUndefined();

        savePanels("a", { strip: { module: "ai", open: true }, panel: "specs" });
        savePanels("b", { strip: { module: "ai", open: false } });

        expect(loadPanels("a")).toEqual({ strip: { module: "ai", open: true }, panel: "specs" });
        expect(loadPanels("b")).toEqual({ strip: { module: "ai", open: false }, panel: undefined });

        // No session (the start page): nothing kept, nothing read.
        savePanels(undefined, { strip: { module: "ai", open: true } });
        expect(kept.size).toBe(2);
        expect(loadPanels(undefined)).toBeUndefined();

        // What cannot be read is dropped; an unknown right panel is closed.
        kept.set("eesha.panels.c", "not json");
        kept.set("eesha.panels.d", JSON.stringify({ module: "other", open: true }));
        kept.set("eesha.panels.e", JSON.stringify({ module: "ai", open: true, panel: "old" }));

        expect(loadPanels("c")).toBeUndefined();
        expect(loadPanels("d")).toBeUndefined();
        expect(loadPanels("e")).toEqual({ strip: { module: "ai", open: true }, panel: undefined });

        vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadPanels("a")).toBeUndefined();
        expect(() => savePanels("a", { strip: STRIP_ON_LOAD })).not.toThrow();
    });

    it("keeps the Git panel's tree or list choice; the list when nothing was saved or the browser keeps nothing", () => {

        storage();

        expect(loadGitTree()).toBe(false);

        saveGitTree(true);
        expect(loadGitTree()).toBe(true);

        saveGitTree(false);
        expect(loadGitTree()).toBe(false);

        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadGitTree()).toBe(false);
        expect(() => saveGitTree(true)).not.toThrow();
    });
});

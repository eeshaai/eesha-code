// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_MAX, CHAT_MIN, CHAT_WIDTH, DEFAULT_WIDTHS, editorFits, loadClosedGroups, loadGitTree, loadPanelPlace, loadPanels, loadWidths, PAGE_MIN, PAGE_WIDTH, pageWidth, PANEL_ON_LOAD, saveClosedGroups, saveGitTree, savePanelPlace, savePanels, saveWidths, showFold, toggleFold } from "../../web/sideState";

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

    it("starts with the panel shown and only Sessions open", () => {

        expect(PANEL_ON_LOAD).toEqual({ open: true, folds: ["sessions"] });
    });

    it("opens one section at a time on its head: opening one closes the open one", () => {

        const git = toggleFold(PANEL_ON_LOAD, "git");

        expect(git).toEqual({ open: true, folds: ["git"] });
        expect(toggleFold(git, "files")).toEqual({ open: true, folds: ["files"] });

        // The open section's head: it closes, and none is open.
        expect(toggleFold(git, "git")).toEqual({ open: true, folds: [] });
        expect(toggleFold({ open: true, folds: [] }, "sessions")).toEqual({ open: true, folds: ["sessions"] });
    });

    it("shows the panel with only the asked section open from a key, and closes the section when it is on screen already", () => {

        const hidden = { open: false, folds: ["git" as const] };

        // Hidden: the panel shows with only the asked section open.
        expect(showFold(hidden, "git")).toEqual({ open: true, folds: ["git"] });
        expect(showFold(hidden, "files")).toEqual({ open: true, folds: ["files"] });

        // On screen with another section open: that one closes.
        expect(showFold({ open: true, folds: ["sessions"] }, "git")).toEqual({ open: true, folds: ["git"] });

        // On screen: the same key closes it.
        expect(showFold({ open: true, folds: ["git"] }, "git")).toEqual({ open: true, folds: [] });
    });

    it("says whether the editor keeps its 560px with the workspace panel open", () => {

        // 1280 - 300 - 400 = 580: fits, so a 1280px window keeps the panel.
        expect(editorFits(1280, 300, 400)).toBe(true);

        // The panel dragged to 450: 430 is left, so the panel has to close.
        expect(editorFits(1280, 450, 400)).toBe(false);

        // The same window without the panel: 880, fits.
        expect(editorFits(1280, undefined, 400)).toBe(true);
    });

    it("draws the page at least 1280 wide, so a narrower window scrolls sideways", () => {

        expect(pageWidth(1100)).toBe(PAGE_WIDTH);
        expect(pageWidth(1280)).toBe(1280);
        expect(pageWidth(1920)).toBe(1920);
        expect(PAGE_MIN).toBe(1024);
    });

    it("starts on the default widths when nothing was saved", () => {

        storage();

        expect(loadWidths()).toEqual({ chat: CHAT_WIDTH });
    });

    it("keeps the dragged widths, held inside their limits", () => {

        const kept = storage();

        saveWidths({ chat: 450 });

        expect(loadWidths()).toEqual({ chat: 450 });

        kept.set("eesha.widths", JSON.stringify({ chat: 9000, panel: 10 }));
        expect(loadWidths()).toEqual({ chat: CHAT_MAX });

        kept.set("eesha.widths", JSON.stringify({ chat: 10 }));
        expect(loadWidths()).toEqual({ chat: CHAT_MIN });
    });

    it("is the default when the browser keeps nothing", () => {

        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadWidths()).toEqual(DEFAULT_WIDTHS);
        expect(() => saveWidths(DEFAULT_WIDTHS)).not.toThrow();
    });

    it("keeps each session's panel and open sections in this browser tab, apart from other sessions", () => {

        const kept = new Map<string, string>();

        vi.stubGlobal("sessionStorage", {
            getItem: (key: string) => kept.get(key) ?? null,
            setItem: (key: string, value: string) => { kept.set(key, value); }
        });

        expect(loadPanels("a")).toBeUndefined();

        savePanels("a", { open: true, folds: ["git"] });
        savePanels("b", { open: false, folds: [] });

        expect(loadPanels("a")).toEqual({ open: true, folds: ["git"] });
        expect(loadPanels("b")).toEqual({ open: false, folds: [] });

        // No session (the start page): nothing kept, nothing read.
        savePanels(undefined, PANEL_ON_LOAD);
        expect(kept.size).toBe(2);
        expect(loadPanels(undefined)).toBeUndefined();

        // What cannot be read is dropped; a section that is not known any more is left out.
        // Several kept open (from before one at a time): only the top one stays open.
        kept.set("eesha.panels.c", "not json");
        kept.set("eesha.panels.d", JSON.stringify({ module: "ai", open: true, panel: "git" }));
        kept.set("eesha.panels.e", JSON.stringify({ open: true, folds: ["specs", "git", "sessions"] }));
        kept.set("eesha.panels.f", JSON.stringify({ open: true, folds: ["specs", "git"] }));

        expect(loadPanels("c")).toBeUndefined();
        expect(loadPanels("d")).toBeUndefined();
        expect(loadPanels("e")).toEqual({ open: true, folds: ["sessions"] });
        expect(loadPanels("f")).toEqual({ open: true, folds: ["git"] });

        vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadPanels("a")).toBeUndefined();
        expect(() => savePanels("a", PANEL_ON_LOAD)).not.toThrow();
    });

    it("keeps the workspace the Sessions section showed last; nothing when the browser keeps nothing", () => {

        storage();

        expect(loadPanelPlace()).toBeUndefined();

        savePanelPlace("c:/work/api");
        expect(loadPanelPlace()).toBe("c:/work/api");

        // "No workspace" is a place too.
        savePanelPlace("");
        expect(loadPanelPlace()).toBe("");

        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadPanelPlace()).toBeUndefined();
        expect(() => savePanelPlace("x")).not.toThrow();
    });

    it("keeps the Git section's tree or list choice; the list when nothing was saved or the browser keeps nothing", () => {

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

    it("keeps which of the Needs you, Specs and Chats groups are closed; every group open when nothing was saved or the browser keeps nothing", () => {

        const kept = storage();

        expect(loadClosedGroups()).toEqual([]);

        // Read back in the order the section lists them.
        saveClosedGroups(["chats", "needs-you", "specs"]);
        expect(loadClosedGroups()).toEqual(["needs-you", "specs", "chats"]);

        saveClosedGroups([]);
        expect(loadClosedGroups()).toEqual([]);

        // What cannot be read is dropped; a group that is not known any more is left out.
        kept.set("eesha.closedSessionGroups", "not json");
        expect(loadClosedGroups()).toEqual([]);

        kept.set("eesha.closedSessionGroups", JSON.stringify(["pinned", "chats"]));
        expect(loadClosedGroups()).toEqual(["chats"]);

        vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });

        expect(loadClosedGroups()).toEqual([]);
        expect(() => saveClosedGroups(["chats"])).not.toThrow();
    });
});

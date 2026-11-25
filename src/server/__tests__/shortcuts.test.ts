// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { KeyPress, shortcutList, shortcutOf, typesText } from "../../web/shortcuts";

/** A key press with nothing held unless said. */
const press = (key: string, code: string, held: Partial<KeyPress> = {}): KeyPress =>
    ({ key, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...held });

describe("the page's keyboard shortcuts", () => {

    it("reads Ctrl on Windows and Linux, Cmd on a Mac", () => {

        expect(shortcutOf(press("O", "KeyO", { ctrlKey: true, shiftKey: true }), false)).toBe("newChat");
        expect(shortcutOf(press("O", "KeyO", { metaKey: true, shiftKey: true }), true)).toBe("newChat");

        // The other one is not the shortcut key.
        expect(shortcutOf(press("O", "KeyO", { metaKey: true, shiftKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("O", "KeyO", { ctrlKey: true, shiftKey: true }), true)).toBeUndefined();
    });

    it("knows each key, by its place for letters", () => {

        const ctrl = { ctrlKey: true };

        expect(shortcutOf(press("k", "KeyK", ctrl), false)).toBe("search");
        expect(shortcutOf(press("E", "KeyE", { ...ctrl, shiftKey: true }), false)).toBe("files");
        expect(shortcutOf(press("/", "Slash", ctrl), false)).toBe("help");
        expect(shortcutOf(press("ArrowUp", "ArrowUp", { altKey: true }), false)).toBe("previousChat");
        expect(shortcutOf(press("ArrowDown", "ArrowDown", { altKey: true }), false)).toBe("nextChat");

        expect(shortcutOf(press("b", "KeyB", ctrl), false)).toBe("list");
        expect(shortcutOf(press("G", "KeyG", { ...ctrl, shiftKey: true }), false)).toBe("git");
        expect(shortcutOf(press("U", "KeyU", { ...ctrl, shiftKey: true }), false)).toBe("logs");
        expect(shortcutOf(press("p", "KeyP", ctrl), false)).toBe("findFile");
        expect(shortcutOf(press("Escape", "Escape"), false)).toBe("stop");

        // A layout where the O key types another letter.
        expect(shortcutOf(press("Щ", "KeyO", { ...ctrl, shiftKey: true }), false)).toBe("newChat");
    });

    it("leaves every other press alone", () => {

        expect(shortcutOf(press("k", "KeyK", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("o", "KeyO", { ctrlKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("k", "KeyK", { ctrlKey: true, altKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("ArrowUp", "ArrowUp", { altKey: true, shiftKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("ArrowUp", "ArrowUp"), false)).toBeUndefined();
        expect(shortcutOf(press("k", "KeyK"), false)).toBeUndefined();

        // Ctrl+Shift+B is the browser's bookmarks bar, Ctrl+Shift+P a private window.
        expect(shortcutOf(press("B", "KeyB", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("P", "KeyP", { ctrlKey: true, shiftKey: true }), false)).toBeUndefined();

        // Esc with anything held is not "stop".
        expect(shortcutOf(press("Escape", "Escape", { shiftKey: true }), false)).toBeUndefined();
        expect(shortcutOf(press("Escape", "Escape", { ctrlKey: true }), false)).toBeUndefined();
    });

    it("lists every shortcut once, in its part", () => {

        const list = shortcutList(false);
        const keys = list.flatMap(group => group.rows.map(row => row.keys));

        expect(list.map(group => group.title)).toEqual(["Sessions", "Panels and editor", "Chat", "Git", "Help"]);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toEqual(expect.arrayContaining(["Ctrl+B", "Ctrl+Shift+G", "Ctrl+Shift+U", "Ctrl+P", "Esc", "Ctrl+/"]));

        // Cmd and Option on a Mac.
        expect(shortcutList(true)[0].rows.map(row => row.keys)).toEqual(["Cmd+Shift+O", "Option+↑ / Option+↓", "Cmd+K", "Cmd+B"]);
    });

    it("says which presses type a character", () => {

        expect(typesText(press("a", "KeyA"))).toBe(true);
        expect(typesText(press("A", "KeyA", { shiftKey: true }))).toBe(true);
        expect(typesText(press("a", "KeyA", { ctrlKey: true }))).toBe(false);
        expect(typesText(press("Enter", "Enter"))).toBe(false);
        expect(typesText(press("ArrowUp", "ArrowUp"))).toBe(false);
    });
});

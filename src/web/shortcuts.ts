/*
 * The page's keyboard shortcuts: which key does what. No React and no
 * browser here, so it is tested on its own
 * (src/server/__tests__/shortcuts.test.ts).
 *
 * Every key was checked against what Chrome, Edge and Firefox keep for
 * themselves - the keys a page is never handed, or cannot stop: new tab,
 * new window, close tab or window, reopen a closed tab, switch tab, quit.
 * None of these is one of them. Some take the place of a browser key
 * while the page has the focus: Ctrl+Shift+O (the bookmarks or
 * favourites page), Ctrl+K (search from the address bar), Ctrl+B (the
 * bookmarks list in Firefox), Ctrl+P (print), Ctrl+Shift+G (find the
 * one before) and, in Firefox, Ctrl+Shift+E (the developer tools'
 * Network tab).
 */

export type Shortcut = "newChat" | "previousChat" | "nextChat" | "search" | "list" | "files" | "git" | "logs" | "findFile" | "stop" | "help";

/** The parts of a key press read here - a browser KeyboardEvent has them all. */
export interface KeyPress {

    key: string;

    code: string;

    ctrlKey: boolean;

    metaKey: boolean;

    altKey: boolean;

    shiftKey: boolean;
}

/** Whether the page runs on a Mac, where Cmd takes Ctrl's place. */
export function isMac(): boolean {

    return typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** What the shortcut key is called: Ctrl, or Cmd on a Mac. */
export function modName(mac: boolean): string {

    return mac ? "Cmd" : "Ctrl";
}

/**
 * The shortcut a key press is, if any. Letters are read by the key's
 * place (`KeyO`), so Shift or the keyboard layout does not change them.
 */
export function shortcutOf(press: KeyPress, mac: boolean): Shortcut | undefined {

    // Ctrl - Cmd on a Mac - and not the other one.
    const mod = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey;

    if (mod && !press.altKey) {

        if (press.shiftKey && press.code === "KeyO")
            return "newChat";

        if (press.shiftKey && press.code === "KeyE")
            return "files";

        if (press.shiftKey && press.code === "KeyG")
            return "git";

        if (press.shiftKey && press.code === "KeyU")
            return "logs";

        if (!press.shiftKey && press.code === "KeyK")
            return "search";

        if (!press.shiftKey && press.code === "KeyB")
            return "list";

        if (!press.shiftKey && press.code === "KeyP")
            return "findFile";

        // Shift is allowed: some keyboards need it to type "/".
        if (press.key === "/" || press.code === "Slash")
            return "help";

        return undefined;
    }

    if (press.altKey && !press.ctrlKey && !press.metaKey && !press.shiftKey) {

        if (press.key === "ArrowUp")
            return "previousChat";

        if (press.key === "ArrowDown")
            return "nextChat";
    }

    // Esc alone. The page decides whether it stops the turn: only from
    // the message box, and only when no menu or window is open.
    if (press.key === "Escape" && !press.ctrlKey && !press.metaKey && !press.altKey && !press.shiftKey)
        return "stop";

    return undefined;
}

/** Whether a key press types a character: one letter, digit or sign, with no Ctrl, Cmd or Alt. */
export function typesText(press: KeyPress): boolean {

    return press.key.length === 1 && !press.ctrlKey && !press.metaKey && !press.altKey;
}

/** One part of the list Ctrl+/ shows. */
export interface ShortcutGroup {

    title: string;

    rows: { keys: string; does: string }[];
}

/** The list Ctrl+/ shows, in parts. */
export function shortcutList(mac: boolean): ShortcutGroup[] {

    const mod = modName(mac);
    const alt = mac ? "Option" : "Alt";

    return [
        {
            title: "Sessions",
            rows: [
                { keys: `${mod}+Shift+O`, does: "New session" },
                { keys: `${alt}+↑ / ${alt}+↓`, does: "The session above or below in the list" },
                { keys: `${mod}+K`, does: "Search sessions" },
                { keys: `${mod}+B`, does: "Show or hide the panel beside the strip (the session list, or the specs)" }
            ]
        },
        {
            title: "Panels and editor",
            rows: [
                { keys: `${mod}+Shift+E`, does: "Show or hide the File explorer panel" },
                { keys: `${mod}+Shift+G`, does: "Show or hide the Git panel (needs a workspace)" },
                { keys: `${mod}+Shift+U`, does: "Show or hide the Logs tab" },
                { keys: `${mod}+P`, does: "Find a file in this session's workspace and open it (needs a workspace)" }
            ]
        },
        {
            title: "Chat",
            rows: [
                { keys: "Enter", does: "Send the message" },
                { keys: "Shift+Enter", does: "A new line in the message" },
                { keys: "Esc", does: "Close the open menu or window. With none open and the message box in focus, stop the turn that is running" },
                { keys: "Any letter", does: "Starts typing in the message box, when nothing else has the focus" }
            ]
        },
        {
            title: "Git",
            rows: [
                { keys: `${mod}+Enter`, does: "Commit, in the Git panel's message box" }
            ]
        },
        {
            title: "Help",
            rows: [
                { keys: `${mod}+/`, does: "This list" }
            ]
        }
    ];
}

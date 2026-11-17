import type { GitDiffAsk, ToPage } from "../server/protocol";

/*
 * The editor tabs: what is open, in what order, and which tab shows; the
 * page draws them (EditorArea.tsx). Kept only while the page is open: a
 * reload starts with none.
 *
 * One click opens a file or a diff in the preview tab, and
 * the next one-click open replaces it there. Keeping the tab - a
 * double-click on the row or on the tab - makes it an ordinary tab.
 */

/** A turn's diff, as the chat sends it: the text itself, before and after, and which snapshots it came from. */
export type TurnDiff = Omit<Extract<ToPage, { type: "eesha.diff" }>, "type">;

/** What a tab shows. */
export type TabWhat =

    /** A file of the chat's folders, read from disk each time it is shown. Its full path. */
    | { kind: "file"; path: string }

    /** A git diff, read again when the repository changes. */
    | { kind: "git"; root: string; ask: GitDiffAsk }

    /** What a turn did to a file. It holds the text; the address holds where it came from, to ask the chat again after a reload. */
    | { kind: "turn"; diff: TurnDiff }

    /** The chat's log lines, with their filters. One per page. */
    | { kind: "logs" }

    /**
     * A spec of the page's workspace: its phases, documents and Next. One
     * tab per spec. `folder`: the workspace folder it is in, when that is
     * not the main one.
     */
    | { kind: "spec"; workspace: string; spec: string; folder?: string };

export interface EditorTab {

    /** The same file or diff opened again finds this tab. */
    id: string;

    /** The tab's name: the file's own name. */
    title: string;

    /** The tab's hover text: the path and what the diff compares. */
    tip: string;

    what: TabWhat;

    /** The preview tab: replaced by the next one-click open. At most one. */
    preview: boolean;
}

export interface TabsState {

    tabs: EditorTab[];

    /** The tab that shows. Nothing only when there are no tabs. */
    active?: string;
}

export const NO_TABS: TabsState = { tabs: [] };

/** A tab's id: one per file, one per diff of a file. */
export function tabId(what: TabWhat): string {

    switch (what.kind) {

        case "file":
            return `file:${what.path}`;

        case "git":
            return `git:${what.root}|${what.ask.side}|${what.ask.commit ?? ""}|${what.ask.path}`;

        case "turn":
            return `turn:${what.diff.turn ? "turn" : "now"}:${what.diff.path}`;

        case "logs":
            return "logs";

        case "spec":
            return `spec:${what.workspace}|${what.folder ?? ""}|${what.spec}`;
    }
}

/**
 * Opens a tab. Already open: it shows, and is kept when `keep` - a turn's
 * diff takes the new text. Not open, and not kept: it takes the preview
 * tab's place, or goes after the tab that shows. Kept: a new ordinary tab
 * after the tab that shows.
 */
export function openTab(state: TabsState, opened: Omit<EditorTab, "id" | "preview">, keep: boolean): TabsState {

    const id = tabId(opened.what);
    const found = state.tabs.find(tab => tab.id === id);

    if (found)
        return {
            tabs: state.tabs.map(tab => tab.id === id ? { ...tab, ...opened, preview: tab.preview && !keep } : tab),
            active: id
        };

    const tab: EditorTab = { ...opened, id, preview: !keep };
    const preview = state.tabs.findIndex(one => one.preview);

    if (!keep && preview >= 0)
        return { tabs: state.tabs.map((one, at) => at === preview ? tab : one), active: id };

    const after = state.tabs.findIndex(one => one.id === state.active);
    const tabs = [...state.tabs];

    tabs.splice(after < 0 ? tabs.length : after + 1, 0, tab);

    return { tabs, active: id };
}

/** A preview tab becomes an ordinary one. */
export function keepTab(state: TabsState, id: string): TabsState {

    return { ...state, tabs: state.tabs.map(tab => tab.id === id ? { ...tab, preview: false } : tab) };
}

/** Closes a tab. When it was the one showing, the tab to its right shows, or else the one to its left. */
export function closeTab(state: TabsState, id: string): TabsState {

    const at = state.tabs.findIndex(tab => tab.id === id);

    if (at < 0)
        return state;

    const tabs = state.tabs.filter(tab => tab.id !== id);

    if (state.active !== id)
        return { ...state, tabs };

    const next = tabs[at] ?? tabs[at - 1];

    return next ? { tabs, active: next.id } : { tabs };
}

export function showTab(state: TabsState, id: string): TabsState {

    return state.tabs.some(tab => tab.id === id) ? { ...state, active: id } : state;
}

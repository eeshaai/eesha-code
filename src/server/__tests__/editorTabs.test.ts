// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { closeTab, keepTab, NO_TABS, openTab, showTab, TabsState, TabWhat } from "../../web/editorTabs";

/*
 * The tabs Files, Git and Changed files share: the preview tab, keeping,
 * closing, and what is kept per chat.
 */

const file = (path: string) => ({ title: path, tip: path, what: { kind: "file", path } as TabWhat });

const ids = (state: TabsState) => state.tabs.map(tab => `${tab.title}${tab.preview ? "*" : ""}`);

describe("opening tabs", () => {

    it("puts a one-click open in the preview tab, and the next one-click open replaces it there", () => {

        let state = openTab(NO_TABS, file("a.ts"), false);

        expect(ids(state)).toEqual(["a.ts*"]);

        state = openTab(state, file("b.ts"), false);

        expect(ids(state)).toEqual(["b.ts*"]);
        expect(state.active).toBe("file:b.ts");
    });

    it("keeps a tab on a double-click or a keep, so the next preview goes after it", () => {

        let state = openTab(NO_TABS, file("a.ts"), false);

        state = keepTab(state, "file:a.ts");
        state = openTab(state, file("b.ts"), false);

        expect(ids(state)).toEqual(["a.ts", "b.ts*"]);

        // Opened kept straight away: a new ordinary tab, the preview stays.
        state = openTab(showTab(state, "file:a.ts"), file("c.ts"), true);

        expect(ids(state)).toEqual(["a.ts", "c.ts", "b.ts*"]);
    });

    it("shows a tab already open instead of opening it twice, keeping it when asked", () => {

        let state = openTab(NO_TABS, file("a.ts"), true);

        state = openTab(state, file("b.ts"), false);
        state = openTab(state, file("a.ts"), false);

        expect(ids(state)).toEqual(["a.ts", "b.ts*"]);
        expect(state.active).toBe("file:a.ts");

        state = openTab(state, file("b.ts"), true);

        expect(ids(state)).toEqual(["a.ts", "b.ts"]);
    });

    it("gives a git diff one tab per side, and a turn's diff its new text", () => {

        const staged = { title: "a.ts", tip: "", what: { kind: "git", root: "/r", ask: { side: "staged", path: "a.ts" } } as TabWhat };
        const changes = { title: "a.ts", tip: "", what: { kind: "git", root: "/r", ask: { side: "changes", path: "a.ts" } } as TabWhat };

        let state = openTab(openTab(NO_TABS, staged, true), changes, true);

        expect(state.tabs).toHaveLength(2);

        const turn = (after: string) => ({ title: "x.ts", tip: "", what: { kind: "turn", diff: { path: "x.ts", after, turn: true } } as TabWhat });

        state = openTab(openTab(NO_TABS, turn("one"), true), turn("two"), false);

        expect(state.tabs).toHaveLength(1);
        expect(state.tabs[0].what).toMatchObject({ diff: { after: "two" } });
    });
});

describe("closing tabs", () => {

    const three = [file("a.ts"), file("b.ts"), file("c.ts")].reduce<TabsState>((state, one) => openTab(state, one, true), NO_TABS);

    it("shows the tab to the right of the one closed, or the one to its left at the end", () => {

        expect(closeTab(showTab(three, "file:b.ts"), "file:b.ts").active).toBe("file:c.ts");
        expect(closeTab(three, "file:c.ts").active).toBe("file:b.ts");
    });

    it("leaves the tab that shows when another closes, and none when the last closes", () => {

        expect(closeTab(three, "file:a.ts").active).toBe("file:c.ts");
        expect(closeTab(openTab(NO_TABS, file("a.ts"), true), "file:a.ts")).toEqual({ tabs: [] });
    });
});

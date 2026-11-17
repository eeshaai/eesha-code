// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { discardQuestion, type DiscardRow } from "../../web/gitView";

/*
 * The question Discard asks in the Git panel. What the panel shows for a
 * repository's files and branch is tested in
 * src/view/git/gitStatusView.test.ts.
 */

describe("discardQuestion", () => {

    const rows: DiscardRow[] = [
        { file: { path: "a.ts" }, letter: "M" },
        { file: { path: "new.ts" }, letter: "U" }
    ];

    it("names one file and says what happens to it", () => {

        expect(discardQuestion([rows[0]])).toBe("Discard the changes to a.ts? The file goes back to the staged copy, or the last commit - the edits on disk are lost.");
        expect(discardQuestion([rows[1]])).toBe("Discard the changes to new.ts? This new file is moved to ~/.eesha/trash.");
    });

    it("counts many files, saying which are lost and which go to the trash", () => {

        expect(discardQuestion(rows)).toBe("Discard the changes to 2 files? 1 file goes back to the staged copy, or the last commit - the edits on disk are lost. 1 new file is moved to ~/.eesha/trash.");
    });
});

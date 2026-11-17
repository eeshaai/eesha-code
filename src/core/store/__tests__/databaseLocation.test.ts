import * as path from "path";
import { describe, expect, it } from "vitest";

import { workspaceFolderName } from "../databaseLocation";

/**
 * The folder name has two jobs: a person should recognise which
 * repository it belongs to, and two repositories must never share one.
 */
describe("workspaceFolderName", () => {

    it("keeps the path readable, so the folder can be found by eye", () => {

        expect(workspaceFolderName(path.join("C:", "code", "eesha-code")))
            .toMatch(/^c-code-eesha-code-[0-9a-f]{8}$/);
    });

    it("is stable for the same path", () => {

        const workspace = path.join("C:", "code", "repo");

        expect(workspaceFolderName(workspace)).toBe(workspaceFolderName(workspace));
    });

    /** Slugging is lossy, so these two flatten to identical text. */
    it("separates paths that slug identically", () => {

        const hyphen = workspaceFolderName(path.join("C:", "code", "a-b"));
        const nested = workspaceFolderName(path.join("C:", "code", "a", "b"));

        expect(hyphen).not.toBe(nested);
    });

    it("distinguishes siblings sharing a prefix", () => {

        expect(workspaceFolderName(path.join("C:", "code", "repo")))
            .not.toBe(workspaceFolderName(path.join("C:", "code", "repo-2")));
    });

    // Some tools return drive letters in either case on Windows, so the
    // same folder must not get two histories there. On Linux they are
    // two directories.
    it("folds case exactly where the filesystem does", () => {

        const lower = workspaceFolderName(path.join("c:", "code", "repo"));
        const upper = workspaceFolderName(path.join("C:", "Code", "Repo"));

        if (process.platform === "win32")
            expect(lower).toBe(upper);
        else
            expect(lower).not.toBe(upper);
    });

    it("names the folderless case rather than failing", () => {

        expect(workspaceFolderName(undefined)).toBe("no-workspace");
    });

    it("stays short enough for a deeply nested path to remain openable", () => {

        const deep = path.join("C:", ...Array.from({ length: 40 }, (_, i) => `segment-number-${i}`));

        expect(workspaceFolderName(deep).length).toBeLessThanOrEqual(69);
    });
});

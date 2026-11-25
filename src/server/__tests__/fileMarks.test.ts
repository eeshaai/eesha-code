// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { agentTree, foldersAbove, gitIgnored, gitMarks, isIgnored, pathKey, pathParts } from "../../web/fileMarks";
import type { GitStatus } from "../protocol";

/*
 * What the Files tree marks: git letters, folders that hold changes, and
 * the tree of only the agent's files.
 */

const repo = (root: string, files: GitStatus["files"]): GitStatus =>
    ({ root, name: "r", ahead: 0, behind: 0, stashes: 0, files });

describe("pathKey", () => {

    it("makes Windows paths one form: forward slashes, lower case, no slash at the end", () => {

        expect(pathKey("C:\\work\\Repo\\")).toBe("c:/work/repo");
        expect(pathKey("c:/work/repo/A.ts")).toBe("c:/work/repo/a.ts");
    });

    it("keeps the case of other paths", () => {

        expect(pathKey("/home/me/Repo/")).toBe("/home/me/Repo");
    });
});

describe("gitMarks", () => {

    it("gives each changed file its letter, by full path", () => {

        const marks = gitMarks([repo("C:\\work\\repo", [
            { path: "src/a.ts", index: ".", work: "M" },
            { path: "src/b.ts", index: "A", work: "." },
            { path: "new.md", index: "?", work: "?" },
            { path: "both.ts", index: "M", work: "M", conflict: true },
            { path: "staged-then-deleted.ts", index: "M", work: "D" }
        ])]);

        expect(marks.get("c:/work/repo/src/a.ts")?.letter).toBe("M");
        expect(marks.get("c:/work/repo/src/b.ts")?.letter).toBe("A");
        expect(marks.get("c:/work/repo/new.md")?.letter).toBe("U");
        expect(marks.get("c:/work/repo/both.ts")?.letter).toBe("!");
        expect(marks.get("c:/work/repo/staged-then-deleted.ts")?.letter).toBe("D");
    });

    it("says which diff Show in Git opens", () => {

        const marks = gitMarks([repo("C:\\work\\repo", [
            { path: "only-staged.ts", index: "M", work: "." },
            { path: "on-disk.ts", index: "M", work: "M" },
            { path: "new.ts", index: "?", work: "?" },
            { path: "both.ts", index: "U", work: "U", conflict: true }
        ])]);

        expect(marks.get("c:/work/repo/only-staged.ts")).toEqual({ letter: "M", root: "C:\\work\\repo", path: "only-staged.ts", side: "staged" });
        expect(marks.get("c:/work/repo/on-disk.ts")?.side).toBe("changes");
        expect(marks.get("c:/work/repo/new.ts")?.side).toBe("changes");
        expect(marks.get("c:/work/repo/both.ts")?.side).toBe("conflict");
    });
});

describe("foldersAbove", () => {

    it("lists every folder above the files, once", () => {

        const folders = foldersAbove(["d:/r/a/b/one.ts", "d:/r/a/two.ts"]);

        expect([...folders].sort()).toEqual(["d:", "d:/r", "d:/r/a", "d:/r/a/b"]);
    });
});

describe("agentTree", () => {

    const tops = [
        { name: "repo", relativePath: "C:\\work\\repo", isDirectory: true },
        { name: "other", relativePath: "C:\\work\\other", isDirectory: true }
    ];

    it("builds the folders on the way to each file, written like the top folder", () => {

        const tree = agentTree(["C:\\work\\repo/web/App.tsx", "C:\\work\\repo/web/a.ts", "C:\\work\\repo/README.md"], tops);

        expect(tree.top.map(one => one.name)).toEqual(["repo"]);
        expect(tree.children["C:\\work\\repo"]).toEqual([
            { name: "web", relativePath: "C:\\work\\repo\\web", isDirectory: true },
            { name: "README.md", relativePath: "C:\\work\\repo\\README.md", isDirectory: false }
        ]);
        expect(tree.children["C:\\work\\repo\\web"].map(one => one.name)).toEqual(["a.ts", "App.tsx"]);
    });

    it("leaves out files under none of the top folders", () => {

        expect(agentTree(["C:\\elsewhere/x.ts"], tops)).toEqual({ top: [], children: {} });
    });

    it("matches a top folder whatever the case or slashes", () => {

        const tree = agentTree(["c:/work/other/x.ts"], tops);

        expect(tree.top.map(one => one.name)).toEqual(["other"]);
        expect(tree.children["C:\\work\\other"]).toEqual([{ name: "x.ts", relativePath: "C:\\work\\other\\x.ts", isDirectory: false }]);
    });
});

describe("gitIgnored and isIgnored", () => {

    const ignored = gitIgnored([{ ...repo("C:/work/app", []), ignored: ["dist/", "debug.log", "src/gen/"] }]);

    it("marks an ignored file, an ignored folder, and everything under that folder", () => {

        expect(isIgnored(pathKey("C:/work/app/debug.log"), ignored)).toBe(true);
        expect(isIgnored(pathKey("C:/work/app/dist"), ignored)).toBe(true);
        expect(isIgnored(pathKey("C:/work/app/dist/a/b.js"), ignored)).toBe(true);
        expect(isIgnored(pathKey("C:/work/app/src/gen/x.ts"), ignored)).toBe(true);
    });

    it("leaves other paths alone, and a folder whose name only starts the same", () => {

        expect(isIgnored(pathKey("C:/work/app/src/a.ts"), ignored)).toBe(false);
        expect(isIgnored(pathKey("C:/work/app/distant/a.ts"), ignored)).toBe(false);
        expect(isIgnored(pathKey("C:/work/app"), ignored)).toBe(false);
    });
});

describe("pathParts", () => {

    it("starts at the session folder the file is in, by its name", () => {

        expect(pathParts("C:\\work\\app\\web\\App.tsx", ["C:\\work\\app"])).toEqual(["app", "web", "App.tsx"]);
    });

    it("takes the deepest folder when one folder is inside another", () => {

        expect(pathParts("C:/work/app/lib/x.ts", ["C:/work/app", "C:/work/app/lib"])).toEqual(["lib", "x.ts"]);
    });

    it("cuts the whole path for a file in none of the folders", () => {

        expect(pathParts("D:\\Other\\x.ts", ["C:\\work\\app"])).toEqual(["D:", "Other", "x.ts"]);
    });
});

import { describe, expect, it } from "vitest";

import {
    branchLabel, commitRefs, groupsOf, letterText, operationText, panelCommit, panelRepo, pathTree, shortAgo, splitPath, syncLabel, syncTitle, type GitPanelFile
} from "./gitStatusView";

/*
 * What the Git panel shows for a repository's files and branch.
 */

describe("groupsOf", () => {

    it("puts each file in its list, in path order: a file staged and changed again is in both", () => {

        const files: GitPanelFile[] = [
            { path: "z.ts", index: "M", work: "M" },
            { path: "new.ts", index: "?", work: "?" },
            { path: "both.ts", index: "U", work: "U", conflict: true },
            { path: "a.ts", index: ".", work: "D" },
            { path: "moved.ts", from: "old.ts", index: "R", work: "." }
        ];

        const groups = groupsOf(files);

        expect(groups.conflicts.map(row => [row.file.path, row.letter])).toEqual([["both.ts", "!"]]);
        expect(groups.staged.map(row => [row.file.path, row.letter])).toEqual([
            ["moved.ts", "R"],
            ["z.ts", "M"]
        ]);
        expect(groups.changes.map(row => [row.file.path, row.letter])).toEqual([
            ["a.ts", "D"],
            ["new.ts", "U"],
            ["z.ts", "M"]
        ]);
    });

    it("gives each row its name, folder, letter text and the agent mark", () => {

        const groups = groupsOf([{ path: "src/a.ts", index: ".", work: "M" }], path => path === "src/a.ts");

        expect(groups.changes[0]).toMatchObject({ name: "a.ts", folder: "src", letterTitle: "Changed", byAgent: true });
    });
});

describe("labels", () => {

    it("names the branch, or the short commit with no branch, or no commit yet", () => {

        expect(branchLabel({ branch: "main", commit: "abc" })).toBe("main");
        expect(branchLabel({ commit: "1234567890" })).toBe("12345678 (no branch)");
        expect(branchLabel({})).toBe("No commit yet");
    });

    it("says what Sync will do: pull and push counts, Publish with no upstream, nothing with no branch", () => {

        expect(syncLabel({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 })).toBe("↓1 ↑2");
        expect(syncLabel({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0 })).toBe("Sync");
        expect(syncLabel({ branch: "main", ahead: 0, behind: 0 })).toBe("Publish");
        expect(syncLabel({ ahead: 0, behind: 0 })).toBe("");
    });

    it("says in words what Sync does", () => {

        expect(syncTitle({ branch: "main", upstream: "origin/main", ahead: 1, behind: 0 })).toBe("Pull, then push (origin/main) - 1 commit to push");
        expect(syncTitle({ branch: "main", ahead: 0, behind: 0 })).toBe("Push this branch and set it to track the remote branch of the same name");
    });

    it("splits a path into the file name and its folder", () => {

        expect(splitPath("src/web/a.ts")).toEqual({ name: "a.ts", folder: "src/web" });
        expect(splitPath("a.ts")).toEqual({ name: "a.ts", folder: "" });
    });

    it("says what a letter and a stopped operation mean", () => {

        expect(letterText("U")).toBe("New file, not tracked by git yet");
        expect(letterText("X")).toBe("X");
        expect(operationText("rebase")).toMatch(/^A rebase stopped part way\. Fix the conflicts/);
    });

    it("says how long ago a commit was", () => {

        const now = 10 * 24 * 60 * 60_000;

        expect(shortAgo(now - 30_000, now)).toBe("just now");
        expect(shortAgo(now - 5 * 60_000, now)).toBe("5 min ago");
        expect(shortAgo(now - 3 * 60 * 60_000, now)).toBe("3 h ago");
        expect(shortAgo(now - 30 * 60 * 60_000, now)).toBe("yesterday");
    });
});

describe("pathTree", () => {

    it("puts folders first, then files, and joins a folder that only holds one folder onto the same row", () => {

        const tree = pathTree(["src/core/git/a.ts", "src/core/git/b.ts", "README.md", "docs/x.md", "docs/sub/y.md"], path => path);

        const show = (nodes: ReturnType<typeof pathTree<string>>): unknown[] =>
            nodes.map(node => node.kind === "file" ? node.name : { [node.name]: show(node.children), items: node.items.length });

        expect(show(tree)).toEqual([{ docs: [{ sub: ["y.md"], items: 1 }, "x.md"], items: 2 }, { "src/core/git": ["a.ts", "b.ts"], items: 2 }, "README.md"]);
        expect(tree[1]).toMatchObject({ kind: "folder", path: "src/core/git" });
    });
});

describe("what the panel is handed", () => {

    it("splits a commit's refs into names, and marks the ones on the upstream's remote", () => {

        expect(commitRefs("HEAD -> main, origin/main, tag: v1", "origin/main")).toEqual([
            { name: "main", remote: false },
            { name: "origin/main", remote: true },
            { name: "tag: v1", remote: false }
        ]);
        expect(commitRefs(undefined, "origin/main")).toEqual([]);
        expect(commitRefs("origin/main", undefined)).toEqual([{ name: "origin/main", remote: false }]);
    });

    it("gives a commit its refs and its ago text", () => {

        const now = 10 * 24 * 60 * 60_000;
        const commit = panelCommit({ hash: "h", short: "h1", author: "Maya", at: now - 5 * 60_000, subject: "First", refs: "origin/main" }, "origin/main", now);

        expect(commit).toMatchObject({ refs: [{ name: "origin/main", remote: true }], ago: "5 min ago" });
    });

    it("gives a repository its lists, trees, labels and operation text", () => {

        const repo = panelRepo({
            root: "C:/code/app", name: "app", branch: "main", commit: "abc", upstream: "origin/main", ahead: 0, behind: 0, stashes: 0, operation: "merge",
            files: [{ path: "src/a.ts", index: "M", work: "." }]
        }, () => false);

        expect(repo).toMatchObject({ fileCount: 1, branchLabel: "main", syncLabel: "" });
        expect(repo.groups.staged).toHaveLength(1);
        expect(repo.trees.staged[0]).toMatchObject({ kind: "folder", name: "src" });
        expect(repo.operationText).toMatch(/^A merge stopped part way/);
    });
});

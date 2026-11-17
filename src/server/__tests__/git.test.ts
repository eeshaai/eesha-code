// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
    checkName, checkPath, commitFiles, commitList, fileDiff, findRepos, GitError, isGitAction, parseStatus, repoLists, repoOf, repoStatus, runAction
} from "../git";
import type { GitRepo } from "../protocol";

/*
 * The git panel's server side: reading `git status`, the checks on what
 * the page sends, and real actions in a throwaway repository.
 */

describe("parseStatus", () => {

    it("reads the branch, the upstream, ahead and behind, stashes and every kind of entry", () => {

        const text = [
            "# branch.oid 1234567890abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "# stash 3",
            "1 M. N... 100644 100644 100644 aaa bbb src/a file.ts",
            "1 .M N... 100644 100644 100644 aaa bbb b.ts",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts",
            "old name.ts",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc both.ts",
            "? new.txt",
            "! dist/",
            "! debug.log",
            ""
        ].join("\0");

        const status = parseStatus(text);

        expect(status).toMatchObject({ branch: "main", commit: "1234567890abcdef", upstream: "origin/main", ahead: 2, behind: 1, stashes: 3 });
        expect(status.files).toEqual([
            { path: "src/a file.ts", index: "M", work: "." },
            { path: "b.ts", index: ".", work: "M" },
            { path: "new name.ts", from: "old name.ts", index: "R", work: "." },
            { path: "both.ts", index: "U", work: "U", conflict: true },
            { path: "new.txt", index: "?", work: "?" }
        ]);
        expect(status.ignored).toEqual(["dist/", "debug.log"]);
    });

    it("leaves the branch out when detached, and the commit out before the first commit", () => {

        expect(parseStatus("# branch.oid abc\0# branch.head (detached)\0").branch).toBeUndefined();
        expect(parseStatus("# branch.oid (initial)\0# branch.head main\0").commit).toBeUndefined();
    });
});

describe("checks on what the page sends", () => {

    const root = path.resolve(os.tmpdir(), "repo");

    it("takes a relative path inside the repository, with forward slashes", () => {

        expect(checkPath(root, "src/a.ts")).toBe("src/a.ts");
        expect(checkPath(root, "src\\b.ts")).toBe(process.platform === "win32" ? "src/b.ts" : "src\\b.ts");
    });

    it("refuses a path outside the repository, a full path, and the repository itself", () => {

        expect(() => checkPath(root, "../other/a.ts")).toThrow(GitError);
        expect(() => checkPath(root, path.resolve(root, "a.ts"))).toThrow(GitError);
        expect(() => checkPath(root, ".")).toThrow(GitError);
        expect(() => checkPath(root, "a\nb")).toThrow(GitError);
    });

    it("refuses a name that is an option or that git would not take", () => {

        expect(checkName("feature/x")).toBe("feature/x");
        expect(checkName("origin/main")).toBe("origin/main");

        for (const bad of ["-D", "--force", "a b", "a..b", "a~1", "a^", "a:b", "x.lock", "x/", "", "a@{1}"])
            expect(() => checkName(bad)).toThrow(GitError);
    });

    it("knows the panel's actions and nothing else", () => {

        expect(isGitAction({ kind: "stage", paths: ["a"] })).toBe(true);
        expect(isGitAction({ kind: "rm -rf" })).toBe(false);
        expect(isGitAction(null)).toBe(false);
    });

    it("finds a repository by its root only among those given", () => {

        const repos: GitRepo[] = [{ root, name: "repo" }];

        expect(repoOf(repos, root)).toBe(repos[0]);
        expect(repoOf(repos, path.resolve(root, "..", "other"))).toBeUndefined();
        expect(repoOf(repos, "repo")).toBeUndefined();
    });
});

/** Runs git in a folder, as a test's setup. */
function sh(cwd: string, ...args: string[]): string {

    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
}

describe("in a real repository", () => {

    let base: string;
    let root: string;
    let repo: GitRepo;
    const trashed: string[] = [];

    const deps = {
        trash: async (absolute: string) => {

            trashed.push(absolute);
            fs.rmSync(absolute);
        }
    };

    const write = (file: string, text: string): void => {

        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), text);
    };

    beforeEach(() => {

        base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-git-")));
        root = path.join(base, "app");

        fs.mkdirSync(root);

        sh(root, "init", "-q", "-b", "main");
        sh(root, "config", "user.email", "test@example.com");
        sh(root, "config", "user.name", "Test");
        sh(root, "config", "commit.gpgsign", "false");

        // The machine's own line-ending setting would change the files' text.
        sh(root, "config", "core.autocrlf", "false");

        write("a.txt", "one\n");
        sh(root, "add", "-A");
        sh(root, "commit", "-q", "-m", "first");

        repo = { root: path.resolve(sh(root, "rev-parse", "--show-toplevel").trim()), name: "app" };
        trashed.length = 0;
    });

    afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

    it("finds the repository a folder is in, and the ones directly inside a folder that is in none", async () => {

        fs.mkdirSync(path.join(root, "src"));

        const inside = await findRepos([path.join(root, "src")]);

        expect(inside.map(one => path.basename(one.root))).toEqual(["app"]);

        const parent = await findRepos([base, root]);

        expect(parent).toHaveLength(1);
        expect(parent[0].name).toBe("app");
    });

    it("reads the status: branch, last commit, and each kind of change", async () => {

        write("a.txt", "two\n");
        write("b.txt", "new\n");
        sh(root, "add", "a.txt");
        write("a.txt", "three\n");

        const status = await repoStatus(repo);

        expect(status.branch).toBe("main");
        expect(status.head).toBe("first");
        expect(status.operation).toBeUndefined();
        expect(status.files).toEqual(expect.arrayContaining([
            { path: "a.txt", index: "M", work: "M" },
            { path: "b.txt", index: "?", work: "?" }
        ]));
    });

    it("shows the staged diff and the unstaged diff of one file", async () => {

        write("a.txt", "two\n");
        sh(root, "add", "a.txt");
        write("a.txt", "three\n");

        expect(await fileDiff(repo, { side: "staged", path: "a.txt" })).toEqual({ before: "one\n", after: "two\n" });
        expect(await fileDiff(repo, { side: "changes", path: "a.txt" })).toEqual({ before: "two\n", after: "three\n" });
    });

    it("stages, unstages, commits, and lists the commit with its files", async () => {

        write("b.txt", "new\n");

        await runAction(repo, { kind: "stage", paths: ["b.txt"] }, deps);
        expect((await repoStatus(repo)).files).toEqual([{ path: "b.txt", index: "A", work: "." }]);

        await runAction(repo, { kind: "unstage", paths: ["b.txt"] }, deps);
        expect((await repoStatus(repo)).files).toEqual([{ path: "b.txt", index: "?", work: "?" }]);

        await runAction(repo, { kind: "commit", message: "add b\n\nThe body.", all: true }, deps);

        expect((await repoStatus(repo)).files).toEqual([]);

        const commits = await commitList(repo);

        expect(commits.map(one => one.subject)).toEqual(["add b", "first"]);
        expect(await commitFiles(repo, commits[0].hash)).toEqual([{ path: "b.txt", status: "A" }]);
        expect(await commitFiles(repo, commits[1].hash)).toEqual([{ path: "a.txt", status: "A" }]);
        expect(await fileDiff(repo, { side: "commit", path: "b.txt", commit: commits[0].hash })).toEqual({ after: "new\n" });
    });

    it("refuses a commit with no message, and undoes the last commit keeping its changes staged", async () => {

        await expect(runAction(repo, { kind: "commit", message: "  " }, deps)).rejects.toThrow("commit message");

        write("a.txt", "two\n");
        await runAction(repo, { kind: "commit", message: "second", all: true }, deps);
        await runAction(repo, { kind: "undoCommit" }, deps);

        expect((await commitList(repo)).map(one => one.subject)).toEqual(["first"]);
        expect((await repoStatus(repo)).files).toEqual([{ path: "a.txt", index: "M", work: "." }]);
    });

    it("discards a tracked file back to its last copy, and moves a new file to the trash instead of deleting it", async () => {

        write("a.txt", "changed\n");
        write("new/c.txt", "new\n");

        await runAction(repo, { kind: "discard", paths: ["a.txt"] }, deps);

        expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("one\n");
        expect(trashed).toEqual([]);

        await runAction(repo, { kind: "discardAll" }, deps);

        expect(trashed).toEqual([path.join(root, "new", "c.txt")]);
        expect((await repoStatus(repo)).files).toEqual([]);
    });

    it("refuses a file outside the repository", async () => {

        await expect(runAction(repo, { kind: "stage", paths: ["../outside.txt"] }, deps)).rejects.toThrow(GitError);
    });

    it("creates, switches, renames and deletes branches, and lists them", async () => {

        await runAction(repo, { kind: "createBranch", name: "feature" }, deps);
        expect((await repoStatus(repo)).branch).toBe("feature");

        await runAction(repo, { kind: "switch", branch: "main" }, deps);
        await runAction(repo, { kind: "renameBranch", from: "feature", to: "feature-2" }, deps);

        const lists = await repoLists(repo);

        expect(lists.branches.map(one => one.name).sort()).toEqual(["feature-2", "main"]);
        expect(lists.branches.find(one => one.current)?.name).toBe("main");

        await runAction(repo, { kind: "deleteBranch", name: "feature-2" }, deps);
        expect((await repoLists(repo)).branches.map(one => one.name)).toEqual(["main"]);
    });

    it("says git's own words when git refuses", async () => {

        await expect(runAction(repo, { kind: "switch", branch: "no-such-branch" }, deps)).rejects.toThrow(/no-such-branch/);
    });

    it("stashes every change, new files too, and pops it back", async () => {

        write("a.txt", "two\n");
        write("b.txt", "new\n");

        await runAction(repo, { kind: "stash", message: "keep this" }, deps);

        expect((await repoStatus(repo)).files).toEqual([]);
        expect((await repoStatus(repo)).stashes).toBe(1);
        expect((await repoLists(repo)).stashes[0]).toMatchObject({ index: 0, text: expect.stringContaining("keep this") });

        await runAction(repo, { kind: "stashPop", index: 0 }, deps);

        expect((await repoStatus(repo)).files).toHaveLength(2);
    });

    it("creates and deletes a tag", async () => {

        await runAction(repo, { kind: "createTag", name: "v1", message: "first release" }, deps);
        expect((await repoLists(repo)).tags).toEqual(["v1"]);

        await runAction(repo, { kind: "deleteTag", name: "v1" }, deps);
        expect((await repoLists(repo)).tags).toEqual([]);
    });

    it("says when a merge stopped on a conflict, and aborts it", async () => {

        await runAction(repo, { kind: "createBranch", name: "other" }, deps);
        write("a.txt", "other\n");
        await runAction(repo, { kind: "commit", message: "on other", all: true }, deps);

        await runAction(repo, { kind: "switch", branch: "main" }, deps);
        write("a.txt", "main\n");
        await runAction(repo, { kind: "commit", message: "on main", all: true }, deps);

        await expect(runAction(repo, { kind: "merge", branch: "other" }, deps)).rejects.toThrow(GitError);

        const stopped = await repoStatus(repo);

        expect(stopped.operation).toBe("merge");
        expect(stopped.files).toEqual([{ path: "a.txt", index: "U", work: "U", conflict: true }]);

        await runAction(repo, { kind: "abort" }, deps);

        const after = await repoStatus(repo);

        expect(after.operation).toBeUndefined();
        expect(after.files).toEqual([]);
    });
});

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { changedBetween, contentAt, parseNameStatus, repoRoot, snapshot } from "../turnSnapshot";

describe("parseNameStatus", () => {

    it("reads added, modified and deleted rows, paths as written", () => {

        expect(parseNameStatus("A\0new file.ts\0M\0src/a\tb.ts\0D\0old.ts\0")).toEqual([
            { path: "new file.ts", status: "added" },
            { path: "src/a\tb.ts", status: "modified" },
            { path: "old.ts", status: "deleted" }
        ]);
    });

    it("reads nothing as nothing", () => {

        expect(parseNameStatus("")).toEqual([]);
    });
});

/** A real repository in a temp folder - the point is what git itself does. */
describe("snapshots of a real repository", () => {

    let root: string;

    const run = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

    beforeEach(() => {

        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-snap-")));

        run("init", "-q");
        run("config", "user.email", "test@example.com");
        run("config", "user.name", "Test");
        run("config", "core.autocrlf", "false");

        fs.writeFileSync(path.join(root, "kept.txt"), "kept\n");
        fs.writeFileSync(path.join(root, "edited.txt"), "one\n");
        fs.writeFileSync(path.join(root, "removed.txt"), "gone soon\n");
        fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");

        run("add", "-A");
        run("commit", "-q", "-m", "start");

        // Work the person had not committed, before the turn.
        fs.writeFileSync(path.join(root, "edited.txt"), "one, edited by hand\n");
        fs.writeFileSync(path.join(root, "scratch.txt"), "untracked\n");
    });

    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("finds the repository's top folder, and nothing outside one", async () => {

        expect(await repoRoot(root)).toBe(path.resolve(root));
        expect(await repoRoot(os.tmpdir())).toBeUndefined();
    });

    it("lists what the turn changed, and keeps what was there before it", async () => {

        const statusBefore = run("status", "--porcelain");

        const before = await snapshot(root);

        // The turn.
        fs.writeFileSync(path.join(root, "edited.txt"), "two\n");
        fs.writeFileSync(path.join(root, "added.txt"), "new\n");
        fs.rmSync(path.join(root, "removed.txt"));
        fs.writeFileSync(path.join(root, "ignored.txt"), "not seen\n");

        const after = await snapshot(root);

        expect(await changedBetween(root, before, after)).toEqual([
            { path: "added.txt", status: "added" },
            { path: "edited.txt", status: "modified" },
            { path: "removed.txt", status: "deleted" }
        ]);

        // Before the turn is the person's uncommitted work, not the commit.
        expect((await contentAt(root, before, "edited.txt"))?.toString()).toBe("one, edited by hand\n");
        expect((await contentAt(root, before, "scratch.txt"))?.toString()).toBe("untracked\n");
        expect(await contentAt(root, before, "added.txt")).toBeUndefined();

        // The real index was never touched: git status reads the same
        // files the same way, the turn's changes aside.
        const statusAfter = run("status", "--porcelain");

        expect(statusAfter).toContain(" M edited.txt");
        expect(statusAfter).toContain(" D removed.txt");
        expect(statusAfter).toContain("?? added.txt");
        expect(statusBefore).toContain("?? scratch.txt");
        expect(statusAfter).toContain("?? scratch.txt");
    });

    it("lists nothing for a turn that changed nothing", async () => {

        const before = await snapshot(root);
        const after = await snapshot(root);

        expect(after).toBe(before);
        expect(await changedBetween(root, before, after)).toEqual([]);
    });
});

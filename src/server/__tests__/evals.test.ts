// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, describe, expect, it } from "vitest";

import { dropStart, evalCopyDir, evalDir, evalNames, evalOfChat, isEvalName, makeCopy, readEval, saveStart, variantMessage, writeEval } from "../evals";
import { eeshaPath } from "../paths";

/*
 * The Evaluator's files: what an evaluation saves, and the copy each
 * variant works in. The git parts run real git in folders under the OS
 * temp folder.
 */

function temporaryFolder(): string {

    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-evals-")));
}

function git(cwd: string, ...args: string[]): string {

    return execFileSync("git", args, {
        cwd, encoding: "utf8",
        env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.invalid" }
    }).trim();
}

/** A repository with one commit, one uncommitted change, one new file git does not ignore and one it does. */
function repository(): string {

    const repo = temporaryFolder();

    git(repo, "init", "--quiet");
    git(repo, "config", "core.autocrlf", "false");

    fs.mkdirSync(path.join(repo, "src"));
    fs.writeFileSync(path.join(repo, "src", "a.txt"), "committed\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), "ignored/\n");

    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "-m", "first");

    fs.writeFileSync(path.join(repo, "src", "a.txt"), "changed, not committed\n");
    fs.writeFileSync(path.join(repo, "src", "new.txt"), "new, not added\n");
    fs.mkdirSync(path.join(repo, "ignored"));
    fs.writeFileSync(path.join(repo, "ignored", "big.bin"), "x");

    return repo;
}

afterEach(() => fs.rmSync(eeshaPath("evals"), { recursive: true, force: true, maxRetries: 3 }));

describe("an evaluation's name", () => {

    it("is letters, digits, - and _, starting with a letter or digit", () => {

        for (const good of ["login-refactor", "a", "A_1", "2026-run"])
            expect(isEvalName(good), good).toBe(true);

        for (const bad of ["", "-a", "_a", "a b", "a/b", "a\\b", "..", "a.b", "a#1", "x".repeat(61), 7, undefined])
            expect(isEvalName(bad), String(bad)).toBe(false);
    });
});

describe("what an evaluation saves", () => {

    const variant = (name: string, chatId: string) => ({ name, chatId, provider: "claude", folder: evalCopyDir("one", name), addedAt: 5 });

    it("is read back as written, under its own folder", () => {

        const folder = temporaryFolder();
        const saved = { name: "one", folder, createdAt: 5, variants: [variant("one-1", "chat-a"), { ...variant("one-2", "chat-b"), model: "opus" }] };

        writeEval(saved);

        expect(readEval("one")).toEqual(saved);
        expect(fs.existsSync(path.join(evalDir("one"), "eval.json"))).toBe(true);
    });

    it("is nothing for a name with no file, a bad name, or a file that is not an evaluation's", () => {

        expect(readEval("none")).toBeUndefined();
        expect(readEval("../x")).toBeUndefined();

        fs.mkdirSync(evalDir("broken"), { recursive: true });
        fs.writeFileSync(path.join(evalDir("broken"), "eval.json"), "{ not json");

        expect(readEval("broken")).toBeUndefined();

        // A file whose name is another evaluation's: the folder was copied by hand.
        writeEval({ name: "one", folder: temporaryFolder(), createdAt: 1, variants: [] });
        fs.mkdirSync(evalDir("copy"), { recursive: true });
        fs.copyFileSync(path.join(evalDir("one"), "eval.json"), path.join(evalDir("copy"), "eval.json"));

        expect(readEval("copy")).toBeUndefined();
    });

    it("reads an older evaluation's text that went in place of the common message as the variant's own text, under it", () => {

        const folder = temporaryFolder();

        fs.mkdirSync(evalDir("one"), { recursive: true });
        fs.writeFileSync(path.join(evalDir("one"), "eval.json"), JSON.stringify({
            name: "one", folder, createdAt: 5,
            variants: [
                { ...variant("one-1", "chat-a"), own: "Do it your way.", extra: "Be short." },
                { ...variant("one-2", "chat-b"), own: "Only this." }
            ]
        }));

        const [first, second] = readEval("one")!.variants;

        expect(first).toEqual({ ...variant("one-1", "chat-a"), extra: "Do it your way.\n\nBe short." });
        expect(second).toEqual({ ...variant("one-2", "chat-b"), extra: "Only this." });

        expect(variantMessage("Fix the login bug.", second!)).toBe("Fix the login bug.\n\nOnly this.");
    });

    it("lists the evaluations newest first, and finds the one a session belongs to", () => {

        const folder = temporaryFolder();

        writeEval({ name: "old", folder, createdAt: 1, variants: [variant("old-1", "chat-old")] });
        writeEval({ name: "new", folder, createdAt: 2, variants: [variant("new-1", "chat-new")] });

        expect(evalNames()).toEqual(["new", "old"]);

        expect(evalOfChat("chat-old")).toMatchObject({ saved: { name: "old" }, variant: { name: "old-1" } });
        expect(evalOfChat("chat-nobody")).toBeUndefined();
    });

    it("has no evaluations with no folder for them yet", () => {

        expect(evalNames()).toEqual([]);
    });
});

describe("a variant's copy of a folder in git", () => {

    it("starts from the folder as it is now: uncommitted changes and new files, not ignored ones", async () => {

        const repo = repository();
        const start = await saveStart("one", repo);

        expect(start).toMatchObject({ ref: "refs/eesha/evals/one", root: repo });

        const work = await makeCopy({ folder: repo, start }, evalCopyDir("one", "one-1"));

        expect(work).toBe(evalCopyDir("one", "one-1"));
        expect(fs.readFileSync(path.join(work, "src", "a.txt"), "utf8")).toBe("changed, not committed\n");
        expect(fs.readFileSync(path.join(work, "src", "new.txt"), "utf8")).toBe("new, not added\n");
        expect(fs.existsSync(path.join(work, "ignored"))).toBe(false);

        // Nothing waits to be committed in the copy: it starts clean.
        expect(git(work, "status", "--porcelain")).toBe("");
    });

    it("leaves the source repository's branch, index and files as they were", async () => {

        const repo = repository();
        const head = git(repo, "rev-parse", "HEAD");
        const status = git(repo, "status", "--porcelain");

        const start = await saveStart("one", repo);

        expect(git(repo, "rev-parse", "HEAD")).toBe(head);
        expect(git(repo, "status", "--porcelain")).toBe(status);

        // The starting commit is kept by name, on top of the commit the branch was at.
        expect(git(repo, "rev-parse", "refs/eesha/evals/one")).toBe(start!.commit);
        expect(git(repo, "rev-parse", `${start!.commit}^`)).toBe(head);
    });

    it("has no remote, so the variant cannot push or reach the source repository's branches", async () => {

        const repo = repository();
        const work = await makeCopy({ folder: repo, start: await saveStart("one", repo) }, evalCopyDir("one", "one-1"));

        expect(git(work, "remote")).toBe("");
        expect(git(work, "branch", "--show-current")).toBe("evaluation");
    });

    it("gives two variants the same files, each in its own repository", async () => {

        const repo = repository();
        const start = await saveStart("one", repo);

        const first = await makeCopy({ folder: repo, start }, evalCopyDir("one", "one-1"));
        const second = await makeCopy({ folder: repo, start }, evalCopyDir("one", "one-2"));

        expect(git(first, "rev-parse", "HEAD")).toBe(git(second, "rev-parse", "HEAD"));

        fs.writeFileSync(path.join(first, "src", "a.txt"), "only in the first\n");

        expect(fs.readFileSync(path.join(second, "src", "a.txt"), "utf8")).toBe("changed, not committed\n");
    });

    it("works in the same folder of the copy as the one picked, when that is not the repository's top", async () => {

        const repo = repository();
        const start = await saveStart("one", path.join(repo, "src"));
        const work = await makeCopy({ folder: path.join(repo, "src"), start }, evalCopyDir("one", "one-1"));

        expect(work).toBe(path.join(evalCopyDir("one", "one-1"), "src"));
        expect(fs.existsSync(path.join(work, "a.txt"))).toBe(true);
    });

    it("refuses a copy where one is already", async () => {

        const repo = repository();
        const start = await saveStart("one", repo);

        await makeCopy({ folder: repo, start }, evalCopyDir("one", "one-1"));

        await expect(makeCopy({ folder: repo, start }, evalCopyDir("one", "one-1"))).rejects.toThrow("is there already");
    });

    it("can take the starting commit's name out again", async () => {

        const repo = repository();
        const start = await saveStart("one", repo);

        await dropStart(start);

        expect(() => git(repo, "rev-parse", "--verify", "--quiet", "refs/eesha/evals/one")).toThrow();
    });
});

describe("a variant's copy of a folder not in git", () => {

    it("is a plain copy of every file", async () => {

        const folder = temporaryFolder();

        fs.mkdirSync(path.join(folder, "deep"));
        fs.writeFileSync(path.join(folder, "deep", "a.txt"), "text\n");

        // A folder under the temp folder can sit inside a repository on some machines: only then is it "in git".
        const start = await saveStart("plain", folder);

        if (start)
            return;

        const work = await makeCopy({ folder }, evalCopyDir("plain", "plain-1"));

        expect(work).toBe(evalCopyDir("plain", "plain-1"));
        expect(fs.readFileSync(path.join(work, "deep", "a.txt"), "utf8")).toBe("text\n");
        expect(fs.existsSync(path.join(work, ".git"))).toBe(false);
    });
});

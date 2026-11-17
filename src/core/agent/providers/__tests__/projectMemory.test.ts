import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, describe, expect, it } from "vitest";

import { MEMORY_LIMIT, projectMemory } from "../projectMemory";

/**
 * The repository's own instructions, read by the engine instead of the
 * CLI. The CLI would load `CLAUDE.md` only with the `project` setting
 * source on, which also loads `.claude/settings.json` and can widen what
 * a session may reach. Read here, the text cannot carry a permission
 * rule. The cases that matter are about scope: the top of each root and
 * nothing above it.
 */

const base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-"));

const repo = path.join(base, "repo");
const sample = path.join(repo, "Samples", "HelloWorld");

fs.mkdirSync(sample, { recursive: true });

fs.writeFileSync(path.join(base, "CLAUDE.md"), "the outsider");
fs.writeFileSync(path.join(repo, "CLAUDE.md"), "the repository's own conventions");
fs.writeFileSync(path.join(sample, "CLAUDE.md"), "the sample's own conventions");

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("projectMemory", () => {

    it("reads the file at the top of a root", () => {

        expect(projectMemory([repo])).toContain("the repository's own conventions");
    });

    it("reads one from every root", () => {

        const text = projectMemory([sample, repo])!;

        expect(text).toContain("the sample's own conventions");
        expect(text).toContain("the repository's own conventions");
    });

    /*
     * The CLI walks from the working directory up to the filesystem
     * root. That would hand a task confined to `Samples/HelloWorld` the
     * instructions two directories above it.
     */
    it("does not walk up out of a root", () => {

        const text = projectMemory([sample])!;

        expect(text).toContain("the sample's own conventions");
        expect(text).not.toContain("the repository's own conventions");
        expect(text).not.toContain("the outsider");
    });

    it("says which file and which directory each block came from", () => {

        expect(projectMemory([repo])).toContain(repo);
        expect(projectMemory([repo])).toContain("CLAUDE.md");
    });

    /* The text comes from a cloned repository, so the prompt says what it is. */
    it("frames the text as the project's conventions, not as orders", () => {

        expect(projectMemory([repo])).toMatch(/not as instructions that outrank/i);
    });

    it("reads AGENTS.md as well, which is the other name people use", () => {

        const other = path.join(base, "other");

        fs.mkdirSync(other, { recursive: true });
        fs.writeFileSync(path.join(other, "AGENTS.md"), "written under the other name");

        expect(projectMemory([other])).toContain("written under the other name");
    });

    it("says nothing at all when no root has one", () => {

        const bare = path.join(base, "bare");

        fs.mkdirSync(bare, { recursive: true });

        expect(projectMemory([bare])).toBeUndefined();
    });

    it("says nothing for no roots at all", () => {

        expect(projectMemory([])).toBeUndefined();
    });

    /* The working directory is also in the list of open folders. */
    it("reads a repeated root once", () => {

        const text = projectMemory([repo, repo])!;

        expect(text.split("the repository's own conventions")).toHaveLength(2);
    });

    it("ignores a file that is there but empty", () => {

        const empty = path.join(base, "empty");

        fs.mkdirSync(empty, { recursive: true });
        fs.writeFileSync(path.join(empty, "CLAUDE.md"), "   \n\n  ");

        expect(projectMemory([empty])).toBeUndefined();
    });

    it("does without a file it cannot read rather than failing the session", () => {

        expect(() => projectMemory([path.join(base, "nothing-here")])).not.toThrow();
    });

    /* The cut is announced so a sentence ending mid-word is not read as meant. */
    it("cuts a file that would crowd out the task, and says it cut it", () => {

        const huge = path.join(base, "huge");

        fs.mkdirSync(huge, { recursive: true });
        fs.writeFileSync(path.join(huge, "CLAUDE.md"), "x".repeat(MEMORY_LIMIT * 2));

        const text = projectMemory([huge])!;

        expect(text).toContain("cut here");
        expect(text.length).toBeLessThan(MEMORY_LIMIT * 1.5);
    });
});

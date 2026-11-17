// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { readInstructionFile, standingInstructions, toolsNote } from "../instructions";
import { serverSettingsFrom } from "../settings";

/*
 * The standing instructions from `.eesha/system.md`
 * and `kiro.md`, and the per-runtime tools turned off. Everything runs
 * in a throwaway folder.
 */

function folder(): string {

    return fs.mkdtempSync(path.join(os.tmpdir(), "eesha-instructions-"));
}

describe("standing instructions", () => {

    it("reads system.md from every folder, and kiro.md only on a Kiro runtime", () => {

        const one = folder();
        const two = folder();

        fs.mkdirSync(path.join(one, ".eesha"));
        fs.mkdirSync(path.join(two, ".eesha"));
        fs.writeFileSync(path.join(one, ".eesha", "system.md"), "System one.");
        fs.writeFileSync(path.join(two, ".eesha", "system.md"), "System two.");
        fs.writeFileSync(path.join(one, ".eesha", "kiro.md"), "---\ninclusion: always\n---\nKiro only.\n");

        expect(standingInstructions([one, two], "claude", undefined)).toBe("System one.\n\nSystem two.");
        expect(standingInstructions([one, two], "kiro-cli-v3", undefined)).toBe("System one.\n\nSystem two.\n\nKiro only.");
    });

    it("has nothing for a chat with no files and no tools turned off", () => {

        expect(standingInstructions([folder()], "kiro-cli-v3", undefined)).toBeUndefined();
        expect(standingInstructions([], "claude", { toolsOff: [] })).toBeUndefined();
    });

    it("names the tools turned off", () => {

        expect(toolsNote({ toolsOff: ["str_replace", "fs_write"] }))
            .toBe("These tools are turned off in this session; do not call them: str_replace, fs_write.");
        expect(toolsNote({ toolsOff: [] })).toBeUndefined();
        expect(toolsNote(undefined)).toBeUndefined();
    });

    it("drops front matter, and a file that is only front matter is nothing", () => {

        const root = folder();
        const file = path.join(root, "x.md");

        fs.writeFileSync(file, "---\ninclusion: always\n---\n");

        expect(readInstructionFile(file)).toBeUndefined();
        expect(readInstructionFile(path.join(root, "missing.md"))).toBeUndefined();
    });
});

describe("eesha.runtimes", () => {

    it("reads the tools turned off per runtime, each once", () => {

        const read = serverSettingsFrom({ eesha: { runtimes: { "kiro-cli-v3": { toolsOff: ["str_replace", " str_replace "] } } } });

        expect(read.problems).toEqual([]);
        expect(read.runtimes).toEqual({ "kiro-cli-v3": { toolsOff: ["str_replace"] } });
    });

    it("says what is wrong and leaves it out", () => {

        const read = serverSettingsFrom({ eesha: { runtimes: { a: "x", b: { toolsOff: "str_replace" } } } });

        expect(read.runtimes).toEqual({ b: { toolsOff: [] } });
        expect(read.problems).toHaveLength(2);
    });

    it("is empty when the block is missing", () => {

        expect(serverSettingsFrom({}).runtimes).toEqual({});
    });
});

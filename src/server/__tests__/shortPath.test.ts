// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { shortPath } from "../../web/shortPath";

/*
 * The settings page's short paths in the runtimes table.
 */

describe("shortPath", () => {

    it("keeps the drive, the last folder and the file name", () => {

        expect(shortPath(String.raw`C:\Users\me\AppData\Roaming\npm\copilot.CMD`)).toBe(String.raw`C:\…\npm\copilot.CMD`);
        expect(shortPath("/home/someone/.local/share/programs/bin/kiro-cli")).toBe("/home/…/bin/kiro-cli");
    });

    it("leaves a short path as it is", () => {

        expect(shortPath(String.raw`C:\bin\claude.exe`)).toBe(String.raw`C:\bin\claude.exe`);
    });

    it("drops the last folder too when the file name alone is long", () => {

        expect(shortPath(String.raw`C:\a\b\c\very-long-folder-name-here\a-very-long-program-name.exe`))
            .toBe(String.raw`C:\…\a-very-long-program-name.exe`);
    });
});

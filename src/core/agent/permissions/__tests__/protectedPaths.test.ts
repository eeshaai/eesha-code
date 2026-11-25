import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { useProfileDirectory } from "../../../loader/profilePaths";
import { folderChoices, protectedReason } from "../protectedPaths";

/*
 * Places never offered and refused with no card, and
 * the folders the outside-folder card offers to add.
 */

function temporaryFolder(): string {

    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-protected-")));
}

describe("protectedReason", () => {

    const home = path.resolve("/users/sam");

    it.each([
        [path.join(home, ".ssh", "id_ed25519"), "~/.ssh"],
        [path.join(home, ".claude"), "~/.claude"],
        [path.join(home, ".copilot", "config.json"), "~/.copilot"],
        [path.join(home, ".kiro", "settings"), "~/.kiro"],
        [path.join(home, ".aws", "credentials"), "~/.aws"]
    ])("refuses %s", (absolute, reason) => {

        expect(protectedReason(absolute, home)).toBe(reason);
    });

    /* The app guards its own profile folder. */
    it("refuses the profile folder, ~/.eesha", () => {

        useProfileDirectory(path.join(home, ".eesha"));

        try {

            expect(protectedReason(path.join(home, ".eesha", "settings.json"), home)).toBe("~/.eesha");

        } finally {

            useProfileDirectory(undefined);
        }
    });

    it("refuses the home folder itself and a drive root", () => {

        expect(protectedReason(home, home)).toBe("your home folder");
        expect(protectedReason(path.parse(home).root, home)).toMatch(/^the drive root /);
    });

    it("lets anything else be asked about", () => {

        expect(protectedReason(path.join(home, "code", "repo", "a.ts"), home)).toBeUndefined();
        expect(protectedReason(path.join(home, ".sshx"), home)).toBeUndefined();
    });

    it("ignores case on Windows only", () => {

        expect(protectedReason(path.join(home, ".SSH"), home, true)).toBe("~/.ssh");
        expect(protectedReason(path.join(home, ".SSH"), home, false)).toBeUndefined();
    });
});

describe("folderChoices", () => {

    it("suggests the git root first, then the file's own folder", () => {

        const root = temporaryFolder();

        fs.mkdirSync(path.join(root, ".git"));
        fs.mkdirSync(path.join(root, "src"));

        expect(folderChoices(path.join(root, "src", "api.ts"), path.resolve("/nobody"))).toEqual([
            { path: root, hint: "git root · suggested" },
            { path: path.join(root, "src"), hint: "this file's folder" }
        ]);
    });

    it("offers a folder once when it is its own git root", () => {

        const root = temporaryFolder();

        fs.mkdirSync(path.join(root, ".git"));

        expect(folderChoices(path.join(root, "a.ts"), path.resolve("/nobody"))).toEqual([{ path: root, hint: "git root · suggested" }]);
    });

    it("says 'this folder' for a folder", () => {

        const root = temporaryFolder();

        expect(folderChoices(root, path.resolve("/nobody")).at(-1)).toEqual({ path: root, hint: "this folder" });
    });

    it("never offers a protected folder", () => {

        const home = temporaryFolder();

        expect(folderChoices(path.join(home, ".ssh", "config"), home)).toEqual([]);
        expect(folderChoices(path.join(home, "notes.txt"), home)).toEqual([]);
    });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ejectedText, ejectPreview, ejectStyle, styleNameProblem, stylesFolders } from "../ejectStyle";

/** The repository's own `resources`, so the shipped `custom` style is what gets copied. */
const resources = path.resolve(__dirname, "..", "..", "..", "..", "resources");

let home: string;
let workspace: string;

beforeEach(() => {

    home = fs.mkdtempSync(path.join(os.tmpdir(), "eject-home-"));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "eject-workspace-"));
});

afterEach(() => {

    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
});

describe("ejecting a built-in style", () => {

    it("copies it under the first free id, with its style.yml saying that id", async () => {

        const folders = stylesFolders(resources, home, workspace);

        const done = await ejectStyle(folders, "custom", folders.workspace!);

        expect(done.newId).toBe("custom-1");
        expect(done.targetRoot).toBe(path.join(workspace, ".eesha", "styles", "custom-1"));
        expect(fs.readFileSync(path.join(done.targetRoot, "style.yml"), "utf8")).toMatch(/^id: custom-1$/m);
        expect(done.files).toBeGreaterThan(1);
    });

    it("counts an id taken in another scope as taken", async () => {

        const folders = stylesFolders(resources, home, workspace);

        fs.mkdirSync(path.join(folders.profile, "custom-1"), { recursive: true });

        const done = await ejectStyle(folders, "custom", folders.workspace!);

        expect(done.newId).toBe("custom-2");
    });

    it("copies the shared grammar once, and never over a copy already there", async () => {

        const folders = stylesFolders(resources, home, workspace);

        const first = await ejectStyle(folders, "custom", folders.profile);

        expect(first.grammarTo).toBe(path.join(folders.profile, "grammar.md"));
        expect(ejectedText(first)).toContain("The shared grammar.md was copied");

        fs.writeFileSync(first.grammarTo!, "edited", "utf8");

        const second = await ejectStyle(folders, "custom", folders.profile);

        expect(second.grammarTo).toBeUndefined();
        expect(fs.readFileSync(first.grammarTo!, "utf8")).toBe("edited");
        expect(ejectedText(second)).not.toContain("grammar");
    });

    it("has no workspace folder when no folder is open", () => {

        expect(stylesFolders(resources, home).workspace).toBeUndefined();
    });
});

describe("naming the copy", () => {

    it("uses the name given, in the folder and in style.yml", async () => {

        const folders = stylesFolders(resources, home, workspace);

        const done = await ejectStyle(folders, "custom", folders.workspace!, " team-flow ");

        expect(done.newId).toBe("team-flow");
        expect(fs.readFileSync(path.join(folders.workspace!, "team-flow", "style.yml"), "utf8")).toMatch(/^id: team-flow$/m);
    });

    it("refuses a name that is taken anywhere or is not a folder name, and writes nothing", async () => {

        const folders = stylesFolders(resources, home, workspace);

        await expect(ejectStyle(folders, "custom", folders.workspace!, "custom")).rejects.toThrow("already exists");
        await expect(ejectStyle(folders, "custom", folders.workspace!, "a b")).rejects.toThrow("folder name");
        expect(fs.existsSync(folders.workspace!)).toBe(false);
    });

    it("says what would be copied and the name it would get", async () => {

        const folders = stylesFolders(resources, home, workspace);

        const preview = await ejectPreview(folders, "custom");

        expect(preview.suggested).toBe("custom-1");
        expect(preview.files).toContain("style.yml");
        expect(styleNameProblem("", new Set())).toBe("The new style needs a name.");
    });
});

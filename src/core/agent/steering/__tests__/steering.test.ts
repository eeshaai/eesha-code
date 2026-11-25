import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import {
    alwaysAttachments,
    fileMatchAttachments,
    findSteering,
    matchesPattern,
    mentionedSteering,
    parseSteeringHeader,
    taggedEntries,
    unknownMentions
} from "../steering";

/** A fresh folder with the given files in it, relative path to text. */
function folder(files: Record<string, string>): string {

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steering-"));

    for (const [relative, text] of Object.entries(files)) {

        const file = path.join(root, relative);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, text);
    }

    return root;
}

const always = "---\ninclusion: always\n---\n\n# Rules\n";

describe("parseSteeringHeader", () => {

    it("finds no header in a file without one", () => {

        expect(parseSteeringHeader("# Title\n\ninclusion: always\n")).toBeUndefined();
    });

    it("ignores a header that names neither key, like a docs page", () => {

        expect(parseSteeringHeader("---\ntitle: Getting started\nlayout: doc\n---\n")).toBeUndefined();
    });

    it("reads inclusion", () => {

        expect(parseSteeringHeader(always)).toEqual({ inclusion: "always" });
    });

    it("reads Windows line endings and a byte order mark", () => {

        expect(parseSteeringHeader(String.fromCharCode(0xFEFF) + "---\r\ninclusion: always\r\n---\r\nbody")).toEqual({ inclusion: "always" });
    });

    it("reads tags as one word or a list", () => {

        expect(parseSteeringHeader("---\ninclusion: manual\ntags: api\n---\n")).toEqual({ inclusion: "manual", tags: ["api"] });
        expect(parseSteeringHeader("---\ninclusion: manual\ntags: [api, dotnet]\n---\n"))
            .toEqual({ inclusion: "manual", tags: ["api", "dotnet"] });
    });

    it("ignores tags without inclusion, the way a blog post writes them", () => {

        expect(parseSteeringHeader("---\ntitle: Release notes\ntags: [api]\n---\n")).toBeUndefined();
    });

    it("refuses an inclusion Kiro does not define, or none", () => {

        expect(() => parseSteeringHeader("---\ninclusion: alway\n---\n")).toThrow(/not one of/);
        expect(() => parseSteeringHeader("---\ninclusion:\n---\n")).toThrow(/not one of/);
    });

    it("refuses tags that are not words", () => {

        expect(() => parseSteeringHeader("---\ninclusion: manual\ntags: [api, 3]\n---\n")).toThrow(/tags/);
    });

    it("reads fileMatchPattern as one pattern or a list", () => {

        expect(parseSteeringHeader("---\ninclusion: fileMatch\nfileMatchPattern: \"src/api/**\"\n---\n"))
            .toEqual({ inclusion: "fileMatch", fileMatchPattern: ["src/api/**"] });
        expect(parseSteeringHeader("---\ninclusion: fileMatch\nfileMatchPattern: [\"*.ts\", \"*.tsx\"]\n---\n"))
            .toEqual({ inclusion: "fileMatch", fileMatchPattern: ["*.ts", "*.tsx"] });
    });

    it("refuses fileMatch without a pattern", () => {

        expect(() => parseSteeringHeader("---\ninclusion: fileMatch\n---\n")).toThrow(/needs 'fileMatchPattern'/);
        expect(() => parseSteeringHeader("---\ninclusion: fileMatch\nfileMatchPattern: []\n---\n")).toThrow(/fileMatchPattern/);
    });

    it("refuses a header that is not valid YAML", () => {

        expect(() => parseSteeringHeader("---\ninclusion: always\n  bad: [\n---\n")).toThrow(/YAML/);
    });

    it("needs the header on the first line", () => {

        expect(parseSteeringHeader(`\n${always}`)).toBeUndefined();
    });
});

describe("matchesPattern", () => {

    it.each([
        ["src/api/**", "src/api/users.ts", true],
        ["src/api/**", "src/api/v2/users.ts", true],
        ["src/api/**", "src/web/users.ts", false],
        ["src/**/*.ts", "src/a.ts", true],
        ["src/**/*.ts", "src/deep/er/a.ts", true],
        ["src/**/*.ts", "src/a.tsx", false],
        ["*.tsx", "src/ui/Button.tsx", true],
        ["*.tsx", "Button.ts", false],
        ["**/*.test.ts", "a/b/c.test.ts", true],
        ["src/*.ts", "src/deep/a.ts", false],
        ["src/{api,web}/*.ts", "src/web/a.ts", true],
        ["src/{api,web}/*.ts", "src/cli/a.ts", false],
        ["src/?.ts", "src/a.ts", true],
        ["src/a.ts", "./src/a.ts", true],
        ["src/a.ts", "src\\a.ts", true],
        ["SRC/A.TS", "src/a.ts", true],
        ["src/a.ts", "src/aXts", false]
    ])("%s against %s is %s", (pattern, file, expected) => {

        expect(matchesPattern(pattern, file)).toBe(expected);
    });
});

describe("findSteering", () => {

    it("finds steering files in any folder, not only .kiro/steering", async () => {

        const root = folder({
            ".kiro/steering/tech.md": always,
            "src/api/rules.md": always,
            "README.md": "# Readme\n"
        });

        const { files } = await findSteering([root]);

        expect(files.map(file => file.relative).sort()).toEqual([".kiro/steering/tech.md", "src/api/rules.md"]);
    });

    it("never looks in node_modules or .git", async () => {

        const root = folder({
            "node_modules/pkg/rules.md": always,
            ".git/rules.md": always,
            "rules.md": always
        });

        const { files } = await findSteering([root]);

        expect(files.map(file => file.relative)).toEqual(["rules.md"]);
    });

    it("skips what git ignores", async () => {

        const root = folder({
            ".gitignore": "out/\n",
            "out/rules.md": always,
            "rules.md": always
        });

        execFileSync("git", ["init", "-q"], { cwd: root });

        const { files } = await findSteering([root]);

        expect(files.map(file => file.relative)).toEqual(["rules.md"]);
    });

    it("counts a file once when one root sits inside another", async () => {

        const root = folder({ "app/rules.md": always });

        const { files } = await findSteering([root, path.join(root, "app")]);

        expect(files).toHaveLength(1);
    });

    it("reports a file with a bad header instead of using it", async () => {

        const root = folder({ "rules.md": "---\ninclusion: sometimes\n---\n" });

        const { files, skipped } = await findSteering([root]);

        expect(files).toEqual([]);
        expect(skipped).toEqual([{ relative: "rules.md", problem: expect.stringContaining("sometimes") }]);
    });

    it("reads a header again once the file changes", async () => {

        const root = folder({ "rules.md": "---\ninclusion: manual\n---\n" });

        expect((await findSteering([root])).files[0].header).toEqual({ inclusion: "manual" });

        const file = path.join(root, "rules.md");

        fs.writeFileSync(file, "---\ninclusion: always\n---\nlonger now\n");

        // Some file systems keep the old time for a write this quick.
        const later = new Date(Date.now() + 5_000);
        fs.utimesSync(file, later, later);

        expect((await findSteering([root])).files[0].header).toEqual({ inclusion: "always" });
    });

    it("finds nothing in a folder that does not exist", async () => {

        expect(await findSteering([path.join(os.tmpdir(), "steering-not-there-" + Date.now())]))
            .toEqual({ files: [], skipped: [] });
    });
});

describe("alwaysAttachments and taggedEntries", () => {

    const root = () => folder({
        "z/last.md": always,
        "a/first.md": always,
        "manual.md": "---\ninclusion: manual\n---\n",
        "tagged.md": "---\ninclusion: manual\ntags: [api]\n---\n",
        "tagged-always.md": "---\ninclusion: always\ntags: [db]\n---\n",
        "plain.md": "# no header\n"
    });

    it("attaches only the always files, sorted, named by path", async () => {

        const dir = root();

        expect(alwaysAttachments((await findSteering([dir])).files)).toEqual([
            { path: path.join(dir, "a", "first.md"), name: "steering: a/first.md" },
            { path: path.join(dir, "tagged-always.md"), name: "steering: tagged-always.md" },
            { path: path.join(dir, "z", "last.md"), name: "steering: z/last.md" }
        ]);
    });

    it("attaches a fileMatch file only when a known file matches its pattern", async () => {

        const dir = folder({
            "api.md": "---\ninclusion: fileMatch\nfileMatchPattern: \"src/api/**\"\n---\n",
            "ui.md": "---\ninclusion: fileMatch\nfileMatchPattern: [\"*.tsx\", \"*.css\"]\n---\n"
        });

        const { files } = await findSteering([dir]);

        expect(fileMatchAttachments(files, ["src/api/users.ts"])).toEqual([
            { path: path.join(dir, "api.md"), name: "steering: api.md" }
        ]);
        expect(fileMatchAttachments(files, ["src/api/users.ts", "src/ui/Button.tsx"]).map(one => one.name))
            .toEqual(["steering: api.md", "steering: ui.md"]);
        expect(fileMatchAttachments(files, [])).toEqual([]);
    });

    it("offers the tagged files to the tool, leaving out one already attached as always", async () => {

        const dir = root();

        expect(taggedEntries((await findSteering([dir])).files)).toEqual([
            { path: path.join(dir, "tagged.md"), relative: "tagged.md", tags: ["api"] }
        ]);
    });
});

describe("mentionedSteering", () => {

    const manual = "---\ninclusion: manual\n---\n";

    it("attaches the manual file each @name names, by file name, case ignored", async () => {

        const dir = folder({ ".kiro/steering/api-rules.md": manual, "docs/Security.md": manual });

        expect(await mentionedSteering("Use @api-rules and @security here.", [dir])).toEqual({
            attachments: [
                { path: path.join(dir, ".kiro", "steering", "api-rules.md"), name: "steering: .kiro/steering/api-rules.md" },
                { path: path.join(dir, "docs", "Security.md"), name: "steering: docs/Security.md" }
            ],
            unknown: []
        });
    });

    it("reports an @name with no manual file, including one that is not manual", async () => {

        const dir = folder({ "always.md": always, "api.md": manual });

        expect(await mentionedSteering("@always @api @nothing", [dir])).toEqual({
            attachments: [{ path: path.join(dir, "api.md"), name: "steering: api.md" }],
            unknown: ["always", "nothing"]
        });
    });

    it("does not read @12 or an e-mail address as a name, and drops a trailing full stop", async () => {

        const dir = folder({ "api.md": manual });

        expect(await mentionedSteering("Fix @12 and mail me@api.com, then see @api.", [dir])).toEqual({
            attachments: [{ path: path.join(dir, "api.md"), name: "steering: api.md" }],
            unknown: []
        });
    });

    it("reads #name as plain text - # is the tools and MCP servers menu", async () => {

        const dir = folder({ "api.md": manual });

        expect(await mentionedSteering("Use #api here.", [dir])).toEqual({ attachments: [], unknown: [] });
    });

    it("attaches a file once when it is named twice", async () => {

        const dir = folder({ "api.md": manual });

        expect((await mentionedSteering("@api and again @api", [dir])).attachments).toHaveLength(1);
    });

    it("says which names were not found", () => {

        expect(unknownMentions([])).toBeUndefined();
        expect(unknownMentions(["a", "b"])).toBe("No manual steering file named @a, @b. The message was sent as typed.");
    });
});

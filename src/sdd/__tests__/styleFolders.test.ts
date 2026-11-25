import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SddCore } from "../SddCore";

/**
 * Two things that live outside a style folder: the one grammar every
 * style shares, and a style's own folder of specs (`specsDir:`), next to
 * the shared one `sdd.specsDir` names.
 *
 * Read through a real {@link SddCore}, the way the program reads them,
 * with the shipped `custom` style copied into the workspace under a new
 * id so every prompt file a phase needs is there.
 */

let home: string;

let workspace: string;

const resources = path.resolve(__dirname, "..", "..", "..", "resources");

const core = () => SddCore.create({ workspace, resources, home });

/** The shipped `custom` style, copied to the workspace as `id`, with `extra` lines added to its style.yml. */
function styleFrom(id: string, extra: string): void {

    const folder = path.join(workspace, ".eesha", "styles", id);

    fs.cpSync(path.join(resources, "styles", "custom"), folder, { recursive: true });

    const file = path.join(folder, "style.yml");

    fs.writeFileSync(file,
        fs.readFileSync(file, "utf8").replace("id: custom", `id: ${id}`) + `\n${extra}\n`, "utf8");
}

function write(relative: string, text: string): void {

    const file = path.join(workspace, ...relative.split("/"));

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
}

function settings(value: unknown): void {

    write(".eesha/settings.json", JSON.stringify(value));
}

/** A spec folder - a folder with its opening document in it. */
function spec(root: string, name: string, style?: string): void {

    write(`${root}/${name}/idea.md`, style ? `---\nstyle: ${style}\n---\n\n# The ask` : "# The ask");
}

beforeEach(() => {

    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-stylefolders-")));
    workspace = path.join(home, "repo");

    fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("the shared grammar", () => {

    const grammarOf = async () => {

        const built = await core();
        const [found] = await built.specs();

        return built.phase(found, "requirements");
    };

    it("is named under the prompt with the rule for when to open it, not attached", async () => {

        styleFrom("prd", "");
        settings({ sdd: { styles: ["prd"] } });
        spec(".eesha/specs", "one");

        const request = await grammarOf();

        expect(request.prompt).toContain(
            `## Grammar\n\nThe document grammar is \`${path.join(resources, "styles", "grammar.md")}\``);
        expect(request.prompt).toContain("Open it only when you write, edit or read a spec document.");
        expect(request.attachments.map(one => one.name)).not.toContain("grammar");
    });

    it("is the workspace copy when there is one, for every style", async () => {

        write(".eesha/styles/grammar.md", "# Ours");
        styleFrom("prd", "");
        settings({ sdd: { styles: ["prd"] } });
        spec(".eesha/specs", "one");

        expect((await grammarOf()).prompt)
            .toContain(`The document grammar is \`${path.join(workspace, ".eesha", "styles", "grammar.md")}\``);
    });

    it("ignores a grammar.md inside a style folder", async () => {

        styleFrom("prd", "");
        write(".eesha/styles/prd/grammar.md", "# Per-style copy");
        settings({ sdd: { styles: ["prd"] } });
        spec(".eesha/specs", "one");

        const request = await grammarOf();

        expect(request.prompt).not.toContain(path.join("prd", "grammar.md"));
        expect(request.prompt).toContain(path.join(resources, "styles", "grammar.md"));
    });

    it("is not mistaken for a style", async () => {

        write(".eesha/styles/grammar.md", "# Ours");

        expect((await (await core()).listStyles()).map(one => one.id)).not.toContain("grammar.md");
    });
});

describe("a style's own specsDir", () => {

    it("lists its specs beside the shared root's", async () => {

        styleFrom("prd", "specsDir: docs/prd");
        settings({ sdd: { styles: ["custom", "prd"] } });
        spec(".eesha/specs", "shared", "custom");
        spec("docs/prd", "backlog-item");

        const found = await (await core()).specs();

        expect(found.map(one => [one.name, one.path, one.folder])).toEqual([
            ["shared", ".eesha/specs/shared", path.join(workspace, ".eesha", "specs", "shared")],
            ["backlog-item", "docs/prd/backlog-item", path.join(workspace, "docs", "prd", "backlog-item")]
        ]);
    });

    /* Two styles are enabled, so the shared root would refuse to guess. Its own folder says which. */
    it("reads an untagged folder there as that style", async () => {

        styleFrom("prd", "specsDir: docs/prd");
        settings({ sdd: { styles: ["custom", "prd"] } });
        spec("docs/prd", "backlog-item");

        const [found] = await (await core()).specs();

        expect(found.detection.style).toBe("prd");
        expect(found.detection.reason).toContain("'specsDir'");
    });

    it("still lets a folder's own tag win", async () => {

        styleFrom("prd", "specsDir: docs/prd");
        settings({ sdd: { styles: ["custom", "prd"] } });
        spec("docs/prd", "tagged", "custom");

        expect((await (await core()).specs())[0].detection.style).toBe("custom");
    });

    it("hands the phase the folder the spec is really in", async () => {

        styleFrom("prd", "specsDir: docs/prd");
        settings({ sdd: { styles: ["prd"] } });
        spec("docs/prd", "backlog-item");

        const built = await core();
        const [found] = await built.specs();
        const request = await built.phase(found, "requirements");

        expect(request.targets).toEqual(["docs/prd/backlog-item/requirements.md"]);
        expect(request.context).toEqual(["docs/prd/backlog-item/idea.md"]);
    });

    it("is where New Spec puts that style's specs, and only that style's", async () => {

        styleFrom("prd", "specsDir: docs/prd");

        const built = await core();
        const prd = await built.registry.load("prd");
        const custom = await built.registry.load("custom");

        expect(built.specPathOf("x", prd)).toBe(path.join(workspace, "docs", "prd", "x"));
        expect(built.specDirOf("x", prd)).toBe("docs/prd/x");
        expect(built.specPathOf("x", custom)).toBe(path.join(workspace, ".eesha", "specs", "x"));
    });

    it("lists one name in two folders once, and says so", async () => {

        styleFrom("prd", "specsDir: docs/prd");
        settings({ sdd: { styles: ["custom", "prd"] } });
        spec(".eesha/specs", "same", "custom");
        spec("docs/prd", "same");

        const view = await (await core()).view();

        expect(view.specs.map(one => one.folder)).toEqual([path.join(workspace, ".eesha", "specs", "same")]);
        expect(view.clashes.map(one => one.name)).toEqual(["same"]);
        expect(view.clashes[0].message).toContain(path.join(workspace, "docs", "prd", "same"));
    });

    it("scans a folder two styles name once, and reads its untagged specs by the usual rule", async () => {

        styleFrom("prd", "specsDir: docs/prd");
        styleFrom("backlog", "specsDir: docs/prd");
        settings({ sdd: { styles: ["prd", "backlog"] } });
        spec("docs/prd", "untagged");

        const built = await core();

        // The shared root, the one both styles name, then the built-in
        // Kiro and Spec Kit folders, which every workspace is scanned for.
        expect((await built.specRoots()).map(root => root.folder))
            .toEqual([
                path.join(workspace, ".eesha", "specs"),
                path.join(workspace, "docs", "prd"),
                path.join(workspace, ".kiro", "specs"),
                path.join(workspace, "specs")
            ]);

        const [found] = await built.specs();

        expect(found.detection.style).toBeUndefined();
    });
});

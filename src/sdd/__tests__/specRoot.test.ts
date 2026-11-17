import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SddCore } from "../SddCore";

/**
 * Where specs live: `.eesha/specs` by default, or wherever
 * `sdd.specsDir` points - relative to the workspace, or absolute for a
 * root outside it (a vault shared between repositories).
 *
 * A workspace with five folders still writes one spec per feature:
 * the root anchors to the one folder passed as `workspace`.
 */

let home: string;

/** The repository root the surfaces pass as `workspace`. */
let workspace: string;

/** The shipped styles live under the repository's own `resources/`. */
const resources = path.resolve(__dirname, "..", "..", "..", "resources");

function writeSettings(value: unknown): void {

    const file = path.join(workspace, ".eesha", "settings.json");

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value), "utf8");
}

const core = () => SddCore.create({ workspace, resources, home });

/**
 * A spec folder, which means a folder with its opening document in it -
 * discovery leaves out anything else under the root.
 */
function writeSpec(root: string, name: string): void {

    fs.mkdirSync(path.join(root, name), { recursive: true });
    fs.writeFileSync(path.join(root, name, "idea.md"), "# The ask", "utf8");
}

beforeEach(() => {

    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-specroot-")));
    workspace = path.join(home, "repo");

    fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe("spec root", () => {

    it("sits under the repository, at the documented place", async () => {

        expect((await core()).specRoot)
            .toBe(path.join(workspace, ".eesha", "specs"));
    });

    it("stays at the default place when the settings say nothing about placement", async () => {

        writeSettings({ sdd: { styles: ["kiro"] } });

        const built = await core();

        expect(built.specRoot).toBe(path.join(workspace, ".eesha", "specs"));
        expect(built.config.styles).toEqual(["kiro"]);
    });

    it("anchors a relative specsDir to the workspace", async () => {

        writeSettings({ sdd: { specsDir: "docs/specs" } });

        expect((await core()).specRoot).toBe(path.join(workspace, "docs", "specs"));
    });

    it("takes an absolute specsDir as it stands - a root outside the workspace", async () => {

        const vault = path.join(home, "spec-vault");

        writeSettings({ sdd: { specsDir: vault } });

        const built = await core();

        expect(built.specRoot).toBe(vault);
        expect(built.specPathOf("mask-secrets")).toBe(path.join(vault, "mask-secrets"));
    });

    it("discovers a spec under an absolute specsDir", async () => {

        const vault = path.join(home, "spec-vault");

        writeSettings({ sdd: { specsDir: vault } });
        writeSpec(vault, "outside");

        const [spec] = await (await core()).specs();

        expect(spec.folder).toBe(path.join(vault, "outside"));
    });

    it("names a spec folder repository-relative, which is what reads well in a prompt", async () => {

        expect((await core()).specDirOf("mask-secrets"))
            .toBe(".eesha/specs/mask-secrets");
    });

    it("gives a spec folder its real place on disk", async () => {

        expect((await core()).specPathOf("mask-secrets"))
            .toBe(path.join(workspace, ".eesha", "specs", "mask-secrets"));
    });

    /**
     * A phase's `targets` are `join(specDir, artifact)`, and the panel
     * checks whether the agent wrote them by resolving each against the
     * workspace - so the relative form has to resolve to the real place.
     */
    it("keeps a phase target resolvable against the workspace", async () => {

        const specDir = (await core()).specDirOf("mask-secrets");

        expect(path.resolve(workspace, `${specDir}/design.md`))
            .toBe(path.join(workspace, ".eesha", "specs", "mask-secrets", "design.md"));
    });

    it("discovers a spec at its folder, with the repository-relative label", async () => {

        writeSpec(path.join(workspace, ".eesha", "specs"), "in-repo");

        const [spec] = await (await core()).specs();

        expect(spec.folder).toBe(path.join(workspace, ".eesha", "specs", "in-repo"));
        expect(spec.path).toBe(".eesha/specs/in-repo");
    });
});

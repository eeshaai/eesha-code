import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SddCore } from "../../SddCore";
import { listSpecs, specRow } from "../specList";

/**
 * The specs list, against a real folder and the shipped `custom` style.
 */

const resources = path.resolve(__dirname, "..", "..", "..", "..", "resources");

let workspace: string;
let home: string;

function write(relative: string, content: string): void {

    const full = path.join(workspace, ...relative.split("/"));

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
}

const core = () => SddCore.create({ workspace, resources, home });

beforeEach(() => {

    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "spec-list-"));
    home = fs.mkdtempSync(path.join(os.tmpdir(), "spec-list-home-"));
});

afterEach(() => {

    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
});

describe("the specs list", () => {

    it("says the spec folder is empty when it is", async () => {

        const { notes, specs } = await listSpecs(await core(), "alpha");

        expect(specs).toEqual([]);
        expect(notes.map(note => note.kind)).toEqual(["empty"]);
        expect(notes[0].text).toMatch(/^No specs in /);
    });

    it("lists specs A to Z, each with its style, the phase waiting and how far it is", async () => {

        for (const name of ["zeta", "alpha"])
            write(`.eesha/specs/${name}/idea.md`, "---\ntype: feature\n---\n\n# The ask\n");

        write(".eesha/specs/alpha/requirements.md", "# Requirements\n\nIt works.\n");

        const { notes, specs } = await listSpecs(await core(), "alpha");

        expect(notes).toEqual([]);
        expect(specs.map(spec => spec.name)).toEqual(["alpha", "zeta"]);

        const alpha = specRow(specs[0]);
        const zeta = specRow(specs[1]);

        expect(alpha.description).toBe("custom · design");
        expect(alpha.status).toBe("gate");
        expect(zeta.description).toBe("custom · requirements");

        // One more stage done in alpha than in zeta, of the same pipeline.
        expect(alpha.progress!.total).toBe(zeta.progress!.total);
        expect(alpha.progress!.done).toBe(zeta.progress!.done + 1);
    });

    it("puts a style that would not load above the specs, with why", async () => {

        write(".eesha/settings.json", JSON.stringify({ sdd: { styles: ["broken"] } }));
        write(".eesha/styles/broken/style.yml", "schema: 1\nid: broken\nstages: [\n");

        const { notes, problems } = await listSpecs(await core(), "alpha");

        expect(notes[0]).toMatchObject({ kind: "style", text: "Style 'broken' could not be read" });
        expect(problems.has("broken")).toBe(true);
    });
});

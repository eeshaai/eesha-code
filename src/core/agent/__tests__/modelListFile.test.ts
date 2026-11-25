import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { modelListPath, readModelList, writeModelList } from "../modelListFile";

/*
 * One runtime's model list on disk - `~/.eesha/models/<runtime>.json`.
 * A file a person edits by hand, so a wrong one says where it is wrong.
 */

let root: string;

beforeEach(() => {

    root = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-model-file-"));
});

afterEach(() => {

    fs.rmSync(root, { recursive: true, force: true });
});

function write(runtime: string, content: unknown): void {

    fs.writeFileSync(modelListPath(runtime, root), typeof content === "string" ? content : JSON.stringify(content));
}

describe("modelListPath", () => {

    it("uses a plain runtime id as the file name", () => {

        expect(modelListPath("kiro-cli", root)).toBe(path.join(root, "kiro-cli.json"));
    });

    it("encodes an id that could point outside the folder", () => {

        for (const id of ["../evil", "a/b", "..", "a\\b"])
            expect(path.dirname(modelListPath(id, root))).toBe(root);
    });
});

describe("readModelList", () => {

    it("says a missing file is missing", async () => {

        expect(await readModelList("ghcp", root)).toEqual({ state: "missing" });
    });

    it("reads a file with only ids, and ignores the 'about' note", async () => {

        write("ghcp", { about: "note", models: [{ id: "gpt-6" }] });

        expect(await readModelList("ghcp", root)).toEqual({ state: "ok", list: { models: [{ id: "gpt-6" }] } });
    });

    it("reads every field a fetch writes", async () => {

        const list = {
            models: [{ id: "a", name: "A", multiplier: 0.33, disabled: true, price: "$1/$2", efforts: ["low"], reasoningEfforts: ["high"], aliases: ["short-a"] }],
            modes: { current: "vibe", modes: [{ id: "vibe", name: "Default", description: "d" }] }
        };

        write("kiro", list);

        expect(await readModelList("kiro", root)).toEqual({ state: "ok", list });
    });

    it.each([
        ["{ not json", "is not valid JSON"],
        [[], "must be a JSON object"],
        [{}, "needs a 'models' list"],
        [{ models: [{ name: "no id" }] }, "models[0] needs an 'id'"],
        [{ models: [{ id: "a" }, { id: "b", multiplier: "2x" }] }, "models[1].multiplier must be a number"],
        [{ models: [{ id: "a", efforts: "low" }] }, "models[0].efforts must be a list of strings"],
        [{ models: [{ id: "a", aliases: [1] }] }, "models[0].aliases must be a list of strings"],
        [{ models: [], modes: { modes: [{}] } }, "modes.modes[0] needs an 'id'"]
    ])("says what is wrong with %j", async (content, reason) => {

        write("ghcp", content);

        const read = await readModelList("ghcp", root);

        expect(read.state).toBe("broken");
        expect(read.state === "broken" && read.reason).toContain(reason);
    });
});

describe("writeModelList", () => {

    it("writes a file that reads back, with the note for the person", async () => {

        expect(await writeModelList("ghcp", { models: [{ id: "gpt-6" }] }, { replace: false, root })).toBe(true);

        expect(JSON.parse(fs.readFileSync(modelListPath("ghcp", root), "utf8")).about).toContain("refresh");
        expect(await readModelList("ghcp", root)).toEqual({ state: "ok", list: { models: [{ id: "gpt-6" }] } });
    });

    it("leaves a file already there alone unless told to replace it", async () => {

        write("ghcp", { models: [{ id: "mine" }] });

        expect(await writeModelList("ghcp", { models: [{ id: "fetched" }] }, { replace: false, root })).toBe(false);
        expect(await readModelList("ghcp", root)).toEqual({ state: "ok", list: { models: [{ id: "mine" }] } });

        expect(await writeModelList("ghcp", { models: [{ id: "fetched" }] }, { replace: true, root })).toBe(true);
        expect(await readModelList("ghcp", root)).toEqual({ state: "ok", list: { models: [{ id: "fetched" }] } });
    });

    it("makes the folder when it is missing", async () => {

        const deeper = path.join(root, "models");

        expect(await writeModelList("ghcp", { models: [{ id: "a" }] }, { replace: false, root: deeper })).toBe(true);
        expect(fs.existsSync(path.join(deeper, "ghcp.json"))).toBe(true);
    });
});

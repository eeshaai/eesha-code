import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NodeSpecFiles } from "../NodeSpecFiles";

/**
 * `contents` feeds the walk's `present` set, so an empty document must
 * not be listed or it would tick its stage. Directories list by
 * presence alone.
 */
describe("NodeSpecFiles.contents", () => {

    let root: string;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "spec-files-"));
        fs.mkdirSync(path.join(root, "my-spec"));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    it("lists documents that hold content", async () => {

        fs.writeFileSync(path.join(root, "my-spec", "requirements.md"), "# Requirements\n");

        expect(await new NodeSpecFiles(root).contents("my-spec")).toEqual(["requirements.md"]);
    });

    it("does not list an empty or whitespace-only document", async () => {

        fs.writeFileSync(path.join(root, "my-spec", "requirements.md"), "");
        fs.writeFileSync(path.join(root, "my-spec", "design.md"), "  \n\t\n");

        expect(await new NodeSpecFiles(root).contents("my-spec")).toEqual([]);
    });

    it("lists a directory artifact by presence alone", async () => {

        fs.mkdirSync(path.join(root, "my-spec", "contracts"));

        expect(await new NodeSpecFiles(root).contents("my-spec")).toEqual(["contracts"]);
    });

    it("is empty for a folder that is not there", async () => {

        expect(await new NodeSpecFiles(root).contents("no-such-spec")).toEqual([]);
    });
});

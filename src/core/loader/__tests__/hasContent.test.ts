import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasContent } from "../hasContent";

/**
 * "Exists" means "exists and says something": a zero-byte or
 * whitespace-only file must read as missing.
 */
describe("hasContent", () => {

    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "has-content-"));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    const file = (name: string, content?: string) => {

        const target = path.join(dir, name);

        fs.writeFileSync(target, content ?? "");

        return target;
    };

    it("is false for a path that does not exist", () => {

        expect(hasContent(path.join(dir, "nowhere.md"))).toBe(false);
    });

    it("is false for a zero-byte file", () => {

        expect(hasContent(file("empty.md"))).toBe(false);
    });

    it("is false for a file holding only whitespace", () => {

        expect(hasContent(file("blank.md", " \n\t\r\n  "))).toBe(false);
    });

    it("is true for a file with real content", () => {

        expect(hasContent(file("requirements.md", "# Requirements\n"))).toBe(true);
    });

    it("is true for a large file without reading it", () => {

        expect(hasContent(file("big.md", "x".repeat(10_000)))).toBe(true);
    });

    it("is true for a directory - its content is its entries", () => {

        const folder = path.join(dir, "contracts");

        fs.mkdirSync(folder);

        expect(hasContent(folder)).toBe(true);
    });
});

// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import { describe, expect, it } from "vitest";

import { exportName } from "../../web/exportName";

describe("the file name Export gives a chat", () => {

    it("is the chat's name with .md", () => {

        expect(exportName("Fix the login page")).toBe("Fix the login page.md");
    });

    it("swaps what Windows refuses in a file name, and folds spaces", () => {

        expect(exportName('What is a/b: "c" <d>?')).toBe("What is a-b- -c- -d--.md");
        expect(exportName("two\nlines   here")).toBe("two lines here.md");
    });

    it("drops dots and spaces at the end, cuts a long name, and says session when nothing is left", () => {

        expect(exportName("Done...")).toBe("Done.md");
        expect(exportName("x".repeat(200))).toBe(`${"x".repeat(80)}.md`);
        expect(exportName("   ")).toBe("session.md");
        expect(exportName("...")).toBe("session.md");
    });
});

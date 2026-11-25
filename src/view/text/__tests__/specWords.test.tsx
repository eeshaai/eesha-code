import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import MarkdownPreview from "../../MarkdownPreview";
import { isMarkdownPath, isSpecPath, markSpecWords } from "../specWords";

/*
 * Spec mode in the Markdown preview: which files start in it, and what
 * it colours.
 */

const html = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

describe("which files start in spec mode", () => {

    it("is a file with a folder named exactly spec or specs on its path", () => {

        expect(isSpecPath("D:/repo/.kiro/specs/rate-limits/design.md")).toBe(true);
        expect(isSpecPath("specs/001-login/spec.md")).toBe(true);
        expect(isSpecPath("C:\\repo\\docs\\Spec\\notes.md")).toBe(true);
    });

    it("is not a folder that only has the word in it, or the file's own name", () => {

        expect(isSpecPath("repo/inspect/notes.md")).toBe(false);
        expect(isSpecPath("repo/spec-notes/a.md")).toBe(false);
        expect(isSpecPath("repo/docs/spec.md")).toBe(false);
    });

    it("previews Markdown files only", () => {

        expect(isMarkdownPath("a/README.md")).toBe(true);
        expect(isMarkdownPath("a/notes.MARKDOWN")).toBe(true);
        expect(isMarkdownPath("a/main.ts")).toBe(false);
    });
});

describe("what spec mode colours", () => {

    it("colours EARS words by their half of the sentence, and MUST", () => {

        const out = html(markSpecWords("WHEN a login fails THEN THE system SHALL count it. It MUST NOT log the password."));

        expect(out).toContain('<span class="sdd-ears sdd-ears--condition">WHEN</span>');
        expect(out).toContain('<span class="sdd-ears sdd-ears--outcome">THEN THE</span>');
        expect(out).toContain('<span class="sdd-ears sdd-ears--outcome">SHALL</span>');
        expect(out).toContain('<span class="sdd-ears sdd-ears--outcome">MUST NOT</span>');
    });

    it("leaves lowercase words and code alone", () => {

        expect(html(markSpecWords("you must, when you can"))).toBe("you must, when you can");
        expect(html(markSpecWords(<code>WHEN</code>))).toBe("<code>WHEN</code>");
    });

    it("does not colour a word twice", () => {

        const once = markSpecWords("IF it fails");

        expect(html(markSpecWords(once)).match(/sdd-ears--condition/g)).toHaveLength(1);
    });

    it("is on in the preview only when asked", () => {

        expect(html(<MarkdownPreview text={"- The system MUST lock the account."} specMode />)).toContain("sdd-ears--outcome");
        expect(html(<MarkdownPreview text={"- The system MUST lock the account."} />)).not.toContain("sdd-ears");
    });
});

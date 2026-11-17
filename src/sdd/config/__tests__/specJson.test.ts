import { describe, expect, it } from "vitest";
import { parseSpecJson, SPEC_FILE, SpecSchema } from "../specJson";

/*
 * `spec.json`, checked.
 *
 * Every message names the key, because this file is written by hand and
 * "invalid" leaves the author guessing. The strictness is the point: a
 * misspelled key that silently does nothing is the failure this file
 * exists to prevent.
 */
describe("reading spec.json", () => {

    const json = (value: unknown) => JSON.stringify(value);

    const ONE = { file: "docs/api/contract.md", desc: "the API contract" };

    it("reads a file and the words that say what it is for", () => {

        expect(parseSpecJson(json({ spec: 1, attachments: [ONE] })))
            .toEqual({ attachments: [ONE] });
    });

    it("reads a file with no attachments as a spec that declared none", () => {

        expect(parseSpecJson(json({ spec: 1 }))).toEqual({ attachments: [] });
    });

    it("trims what was typed, so a stray space is not part of a path", () => {

        expect(parseSpecJson(json({ spec: 1, attachments: [{ file: "  notes.md ", desc: " the notes " }] })))
            .toEqual({ attachments: [{ file: "notes.md", desc: "the notes" }] });
    });

    it("reads a Windows path the way every other path in this build is read", () => {

        expect(parseSpecJson(json({ spec: 1, attachments: [{ file: "docs\\api\\contract.md", desc: "it" }] })))
            .toEqual({ attachments: [{ file: "docs/api/contract.md", desc: "it" }] });
    });

    it("names the syntax error rather than saying the file is invalid", () => {

        expect(() => parseSpecJson("{ oops")).toThrow(/is not valid JSON/);
    });

    it("refuses anything but an object", () => {

        expect(() => parseSpecJson("[]")).toThrow(`${SPEC_FILE} must hold an object.`);
    });

    /* The version first, so a file written against a later schema is told what this build understands. */
    it("refuses a file that declares no version", () => {

        expect(() => parseSpecJson(json({ attachments: [] })))
            .toThrow(`${SPEC_FILE} must declare 'spec: ${SpecSchema}'. It declares nothing.`);
    });

    it("refuses a version it does not understand", () => {

        expect(() => parseSpecJson(json({ spec: 2 }))).toThrow(/It declares '2'/);
    });

    /*
     * Refused, not ignored. A key doing nothing quietly is how a person
     * finds out months later that the model never saw their contract -
     * and refusing means every key added later is added deliberately.
     */
    it("refuses a key it does not have, and lists the ones it does", () => {

        expect(() => parseSpecJson(json({ spec: 1, knowledge: [] })))
            .toThrow(/'knowledge', which is not a key it has. Known keys: spec, attachments/);
    });

    /* The one open key: a team's own data, kept as written and never read by the engine. */
    it("keeps whatever is under metadata, as written", () => {

        const metadata = { story: 4412, links: ["https://dev.azure.com/x/_workitems/edit/4412"], owner: null };

        expect(parseSpecJson(json({ spec: 1, metadata }))).toEqual({ attachments: [], metadata });
        expect(parseSpecJson(json({ spec: 1, metadata: "just text" })).metadata).toBe("just text");
    });

    it("leaves metadata out when the file has none", () => {

        expect(parseSpecJson(json({ spec: 1 }))).not.toHaveProperty("metadata");
    });

    it("refuses a key it does not have inside an attachment", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ ...ONE, stages: ["design"] }] })))
            .toThrow(/attachments\[0\]' writes 'stages'/);
    });

    it("refuses attachments that are not a list", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: ONE })))
            .toThrow(`${SPEC_FILE} 'attachments' must be a list.`);
    });

    /* A description is the whole point: nothing else can say what the file holds. */
    it("refuses an attachment with no description", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ file: "notes.md" }] })))
            .toThrow(/attachments\[0\]' must give 'desc' as text/);
    });

    it("refuses an attachment with an empty description", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ file: "notes.md", desc: "  " }] })))
            .toThrow(/must give 'desc' as text/);
    });

    it("refuses an attachment with no file", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ desc: "the notes" }] })))
            .toThrow(/attachments\[0\]' must give 'file' as text/);
    });

    it("names which attachment is wrong when there is more than one", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [ONE, { file: "notes.md" }] })))
            .toThrow(/attachments\[1\]/);
    });

    /*
     * A spec declares files inside the repository. A path leaving it is
     * either a mistake or a spec that only runs on one machine.
     */
    it("refuses an absolute path", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ file: "/etc/passwd", desc: "no" }] })))
            .toThrow(/which is an absolute path/);
    });

    it("refuses a Windows absolute path", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ file: "C:\\secrets.md", desc: "no" }] })))
            .toThrow(/which is an absolute path/);
    });

    it("refuses a path that climbs out of the workspace", () => {

        expect(() => parseSpecJson(json({ spec: 1, attachments: [{ file: "../../secrets.md", desc: "no" }] })))
            .toThrow(/which leaves the workspace/);
    });
});

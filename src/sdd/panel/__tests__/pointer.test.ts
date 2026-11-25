import { describe, expect, it } from "vitest";

import { pointerFor } from "../newSpec";

/**
 * A work item, however the person had it to hand.
 *
 * Both forms are offered because both are what people actually have: a
 * number copied off a board, or the URL of the page they were reading
 * it on. The id is what the frontmatter and the prose name, so a URL
 * gives up its tail rather than leaving `id:` blank.
 */
describe("the work item pointer", () => {

    it("takes a bare id as the id", () => {

        expect(pointerFor("48213")).toEqual({ workItem: "48213" });
    });

    it("keeps a non-numeric reference as it was typed", () => {

        expect(pointerFor("PROJ-14")).toEqual({ workItem: "PROJ-14" });
    });

    it("keeps a pasted url and takes the number off the end of it", () => {

        expect(pointerFor("https://dev.azure.com/org/proj/_workitems/edit/48213")).toEqual({
            url: "https://dev.azure.com/org/proj/_workitems/edit/48213",
            workItem: "48213"
        });
    });

    it("reads a github issue url the same way", () => {

        expect(pointerFor("https://github.com/owner/repo/issues/412")).toEqual({
            url: "https://github.com/owner/repo/issues/412",
            workItem: "412"
        });
    });

    /** Query strings and fragments are not part of the number. */
    it("ignores a query string and a fragment when reading the number", () => {

        expect(pointerFor("https://github.com/o/r/issues/412?x=1#comment-9")).toEqual({
            url: "https://github.com/o/r/issues/412?x=1#comment-9",
            workItem: "412"
        });
    });

    it("tolerates a trailing slash", () => {

        expect(pointerFor("https://github.com/o/r/issues/412/")).toEqual({
            url: "https://github.com/o/r/issues/412/",
            workItem: "412"
        });
    });

    /**
     * A url whose tail is not a number still travels - as a link. An id
     * guessed out of a slug would be a number that means nothing, and
     * the frontmatter's whole job is to be right.
     */
    it("records the link alone when the tail is not a number", () => {

        expect(pointerFor("https://example.com/boards/my-item")).toEqual({
            url: "https://example.com/boards/my-item",
            workItem: undefined
        });
    });
});

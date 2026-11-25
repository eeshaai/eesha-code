import { describe, expect, it } from "vitest";

import { markWords } from "../wordMarks";

describe("markWords", () => {

    /** The shape the renderer hands over: a paragraph holding one run of text. */
    const paragraph = (text: string) => ({
        type: "root",
        children: [{ type: "element", tagName: "p", children: [{ type: "text", value: text }] }]
    });

    it("wraps only the words that moved", () => {

        const tree = paragraph("the plan ships on Monday");

        markWords(tree, "the plan ships on Monday", [false, false, false, false, true], "w");

        const parts = (tree.children[0] as { children: { type: string; value?: string; children?: { value: string }[] }[] }).children;

        expect(parts.map(part => part.value ?? part.children?.[0].value)).toEqual(["the plan ships on ", "Monday"]);
        expect(parts[1].type).toBe("element");
    });

    it("marks a bolded word the renderer stripped the stars from", () => {

        const tree = {
            type: "root",
            children: [{
                type: "element",
                tagName: "p",
                children: [
                    { type: "text", value: "ships on " },
                    { type: "element", tagName: "strong", children: [{ type: "text", value: "Monday" }] }
                ]
            }]
        };

        markWords(tree, "ships on **Monday**", [false, false, true], "w");

        const strong = (tree.children[0].children[1] as { children: { type: string; properties?: unknown }[] });

        expect(strong.children[0].type).toBe("element");
    });

    it("leaves code alone", () => {

        const tree = {
            type: "root",
            children: [{
                type: "element",
                tagName: "pre",
                children: [{ type: "element", tagName: "code", children: [{ type: "text", value: "Monday" }] }]
            }]
        };

        markWords(tree, "Monday", [true], "w");

        expect(tree.children[0].children[0].children[0].type).toBe("text");
    });

    it("does nothing when no word moved", () => {

        const tree = paragraph("nothing here changed");

        markWords(tree, "nothing here changed", [false, false, false], "w");

        expect((tree.children[0] as { children: unknown[] }).children).toHaveLength(1);
    });
});

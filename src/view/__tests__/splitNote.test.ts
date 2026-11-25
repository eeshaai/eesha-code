import { describe, expect, it } from "vitest";
import { splitNote } from "../ui";

describe("splitNote", () => {

    it("splits 'what - why' at the dash, and starts the reason with a capital", () => {

        expect(splitNote("Nothing yet - runs of this workflow show up here once it has run."))
            .toEqual(["Nothing yet", "Runs of this workflow show up here once it has run."]);
    });

    it("splits two sentences at the first full stop when there is no dash", () => {

        expect(splitNote("No sessions yet. Start a phase and its conversation is listed here."))
            .toEqual(["No sessions yet", "Start a phase and its conversation is listed here."]);
    });

    it("prefers the dash when a text has both", () => {

        expect(splitNote("The prompt file is missing - C:/repo/prompts/first.md"))
            .toEqual(["The prompt file is missing", "C:/repo/prompts/first.md"]);
    });

    it("keeps one sentence whole as the title, without its full stop", () => {

        expect(splitNote("No change since the last time this phase ran."))
            .toEqual(["No change since the last time this phase ran", undefined]);
    });
});

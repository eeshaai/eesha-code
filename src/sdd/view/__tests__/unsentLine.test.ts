import { describe, expect, it } from "vitest";

import type { CmdLogs } from "../../../view/templates/TemplateRunView";
import { dropUnsent, unsentText } from "../unsentLine";

/*
 * A typed message the server says was not sent comes off the conversation,
 * and its text goes back into the compose box.
 */

const logs = (lines: CmdLogs["lines"]): Record<string, CmdLogs> => ({ design: { lines } });

const line = (text: string, pending?: "sending") =>
    ({ ownerId: "design", text, stream: "stdout" as const, at: 1, kind: "prompt" as const, ...(pending ? { pending } : {}) });

describe("a message that was not sent", () => {

    it("gives back the oldest line still sending, without its newline", () => {

        const current = logs([line("sent\n"), line("first\n", "sending"), line("second\n", "sending")]);

        expect(unsentText(current, "design")).toBe("first");
    });

    it("takes only that line off the conversation", () => {

        const current = logs([line("sent\n"), line("first\n", "sending"), line("second\n", "sending")]);

        expect(dropUnsent(current, "design").design!.lines.map(one => one.text)).toEqual(["sent\n", "second\n"]);
    });

    it("gives nothing back and changes nothing when no line is sending", () => {

        const current = logs([line("sent\n")]);

        expect(unsentText(current, "design")).toBeUndefined();
        expect(unsentText(current, "other")).toBeUndefined();
        expect(dropUnsent(current, "design")).toBe(current);
        expect(dropUnsent(current, "other")).toBe(current);
    });
});

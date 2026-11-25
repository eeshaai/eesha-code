import { describe, expect, it } from "vitest";

import type { LogLine } from "../../../core/models/run";
import { markUnsent, withHostLine } from "../sendingLine";

/** A line as the view keeps it. */
function line(text: string, extra: Partial<LogLine> = {}): LogLine {

    return { ownerId: "chat", text, stream: "stdout", at: 1, ...extra };
}

const sending = (text: string) => line(text, { kind: "prompt", pending: "sending" });

describe("the message drawn as Sending… before the host logs it", () => {

    it("gives its place to the real prompt line", () => {

        const lines = withHostLine([line("earlier answer"), sending("hello\n")], line("hello\n", { kind: "prompt" }));

        expect(lines).toHaveLength(2);
        expect(lines[1]).toMatchObject({ text: "hello\n", kind: "prompt" });
        expect(lines[1].pending).toBeUndefined();
    });

    it("stays while other lines arrive before the prompt line", () => {

        const lines = withHostLine([sending("hello\n")], line("Model changed - reopening the conversation.\n", { stream: "system" }));

        expect(lines).toHaveLength(2);
        expect(lines[0].pending).toBe("sending");
    });

    it("is matched by its text when two were sent before either was logged", () => {

        const lines = withHostLine([sending("one\n"), sending("two\n")], line("two\n", { kind: "prompt" }));

        expect(lines.map(one => [one.text, one.pending])).toEqual([["one\n", "sending"], ["two\n", undefined]]);
    });

    it("goes oldest first when no text matches", () => {

        const lines = withHostLine([sending("one\n"), sending("two\n")], line("something else\n", { kind: "prompt" }));

        expect(lines.map(one => one.text)).toEqual(["two\n", "something else\n"]);
    });

    it("turns into Not sent when the host says it never went - only the one with that text", () => {

        const lines = markUnsent([sending("one\n"), sending("two\n")], "two");

        expect(lines.map(one => one.pending)).toEqual(["sending", "failed"]);
    });

    it("changes nothing on Not sent when no line is sending", () => {

        const before = [line("hello\n", { kind: "prompt" })];

        expect(markUnsent(before, "hello")).toEqual(before);
    });
});

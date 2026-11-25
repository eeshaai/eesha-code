import { describe, expect, it } from "vitest";
import { RunEvent } from "../../../core/events/runEvents";
import { goBackPrompt, handoverStartPrompt, handoverTranscript } from "../handover";

/*
 * The Handover button's file and first message (the `handover` flag).
 */
describe("handoverTranscript", () => {

    const at = 1;

    const events: RunEvent[] = [
        { kind: "prompt", ownerId: "chat", at, text: "Read the config.\n" },
        { kind: "reasoning", ownerId: "chat", at, text: "thinking hard\n" },
        { kind: "tool.start", ownerId: "chat", at, tool: "Read", detail: "config.yml", text: "Read: config.yml\n" },
        { kind: "tool.end", ownerId: "chat", at, tool: "Read", text: "Read done in 4ms\n", detail: "port: 8080\nhost: local" },
        { kind: "message", ownerId: "chat", at, text: "It listens on 8080.\n" },
        { kind: "error", ownerId: "chat", at, text: "quota limit reached\n" },
        { kind: "prompt", ownerId: "other", at, text: "Not this chat.\n" }
    ];

    it("writes the turns in order, with each tool's output under its call", () => {

        const { text } = handoverTranscript(events, "chat", { title: "Config", from: "ghcp", model: "gpt-5", at: 0 });

        expect(text).toContain("# Handover: Config");
        expect(text).toContain("- From: ghcp (gpt-5)");
        expect(text).toContain("- Messages from the person: 1");
        expect(text).toContain("### Person\nRead the config.");
        expect(text).toContain("- tool: Read config.yml\n\n```\nport: 8080\nhost: local\n```");
        expect(text).toContain("### Agent\nIt listens on 8080.");

        expect(text.indexOf("- tool: Read")).toBeLessThan(text.indexOf("port: 8080"));
        expect(text.indexOf("port: 8080")).toBeLessThan(text.indexOf("### Agent\n"));
    });

    it("leaves out reasoning, the old runtime's errors, the 'done' line and other owners", () => {

        const { text } = handoverTranscript(events, "chat", { title: "Config", at: 0 });

        expect(text).not.toContain("thinking hard");
        expect(text).not.toContain("quota limit reached");
        expect(text).not.toContain("Read done in 4ms");
        expect(text).not.toContain("Not this chat.");
        expect(text).toContain("- From: unknown runtime");
    });

    it("cuts a long output to 30 lines and says how many more there were", () => {

        const long: RunEvent[] = [
            { kind: "tool.start", ownerId: "chat", at, tool: "Bash", detail: "npm test" },
            { kind: "tool.end", ownerId: "chat", at, tool: "Bash", detail: Array.from({ length: 45 }, (_, index) => `line ${index + 1}`).join("\n") }
        ];

        const { text } = handoverTranscript(long, "chat", { title: "T", at: 0 });

        expect(text).toContain("line 30");
        expect(text).not.toContain("line 31");
        expect(text).toContain("(15 more lines cut)");
    });

    it("fences an output that holds backticks with a longer fence", () => {

        const fenced: RunEvent[] = [
            { kind: "tool.start", ownerId: "chat", at, tool: "Read", detail: "README.md" },
            { kind: "tool.end", ownerId: "chat", at, tool: "Read", detail: "```js\ncode\n```" }
        ];

        const { text } = handoverTranscript(fenced, "chat", { title: "T", at: 0 });

        expect(text).toContain("````\n```js\ncode\n```\n````");
    });

    it("clips a long tool detail so one call cannot swamp the file", () => {

        const long: RunEvent[] = [
            { kind: "tool.start", ownerId: "chat", at, tool: "Bash", detail: "x".repeat(500) }
        ];

        const { text } = handoverTranscript(long, "chat", { title: "T", at: 0 });
        const line = text.split("\n").find(one => one.startsWith("- tool: Bash"))!;

        expect(line.length).toBeLessThan(230);
        expect(line.endsWith("…")).toBe(true);
    });

    it("says so when nothing was said yet", () => {

        expect(handoverTranscript([], "chat", { title: "T", at: 0 }).text).toContain("(nothing was said yet)");
    });

    it("counts its own lines", () => {

        const { text, lines } = handoverTranscript(events, "chat", { title: "Config", at: 0 });

        expect(lines).toBe(text.split("\n").length);
    });
});

describe("handoverStartPrompt", () => {

    const at = 1;

    const turn = (n: number): RunEvent[] => [
        { kind: "prompt", ownerId: "chat", at, text: `Question ${n}.\n` },
        { kind: "message", ownerId: "chat", at, text: `Answer ${n}.\n` }
    ];

    const events = [...turn(1), ...turn(2), ...turn(3)];

    it("names the file and its length, and says to read all of it", () => {

        const prompt = handoverStartPrompt(events, "chat", { path: ".eesha/handovers/c-1.md", lines: 412, from: "ghcp" });

        expect(prompt).toContain("another runtime (ghcp)");
        expect(prompt).toContain("`.eesha/handovers/c-1.md`");
        expect(prompt).toContain("It is 412 lines long.");
        expect(prompt).toContain("Read all of it, to the last line");
    });

    it("copies in the last two exchanges only", () => {

        const prompt = handoverStartPrompt(events, "chat", { path: "f.md", lines: 1 });

        expect(prompt).not.toContain("Question 1.");
        expect(prompt).toContain("### Person\nQuestion 2.");
        expect(prompt).toContain("### Agent\nAnswer 3.");
    });

    it("says to reply in one line and wait, unless told to carry on", () => {

        expect(handoverStartPrompt(events, "chat", { path: "f.md", lines: 1 }))
            .toContain("Then wait for the next message. Do not start any work.");

        const carry = handoverStartPrompt(events, "chat", { path: "f.md", lines: 1 }, "Then carry on with the wave.");

        expect(carry.endsWith("Then carry on with the wave.")).toBe(true);
        expect(carry).not.toContain("Do not start any work.");
    });
});

describe("goBackPrompt", () => {

    const events: RunEvent[] = [
        { kind: "prompt", ownerId: "chat", at: 1, text: "Read the config.\n" },
        { kind: "message", ownerId: "chat", at: 2, text: "It listens on 8080.\n" }
    ];

    it("points at the file, copies the last part in, and ends with the person's message", () => {

        const text = goBackPrompt(events, "chat", { path: ".scratch/handovers/c1.md", lines: 12 }, "Use port 9090 instead.");

        expect(text.startsWith("## Earlier in this chat\n")).toBe(true);
        expect(text).toContain("`.scratch/handovers/c1.md`. It is 12 lines long.");
        expect(text).toContain("It listens on 8080.");
        expect(text.endsWith("## My message\n\nUse port 9090 instead.")).toBe(true);
    });
});

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { chatEventsPath } from "../../core/events/eventFile";
import type { RunEvent } from "../../core/events/runEvents";
import { listChats, searchChats, summarizeChat, titleOf } from "../chatHistory";

describe("titleOf", () => {

    it("is the first line asked", () => {

        expect(titleOf("why does this fail?\n\nmore detail")).toBe("why does this fail?");
    });

    it("says so when only files were sent", () => {

        expect(titleOf("")).toBe("Files only");
    });

    it("cuts a long first line", () => {

        const title = titleOf("x".repeat(200));

        expect(title).toHaveLength(80);
        expect(title.endsWith("…")).toBe(true);
    });
});

describe("summarizeChat", () => {

    it("names a chat by its first message and dates it by its last line", () => {

        const events: RunEvent[] = [
            { kind: "open", at: 1, runId: "chat:c1" },
            { kind: "session", at: 2, ownerId: "chat", sessionId: "s1", provider: "kiro" },
            { kind: "prompt", at: 3, ownerId: "chat", text: "first question" },
            { kind: "prompt", at: 4, ownerId: "chat", text: "second question" },
            { kind: "session", at: 5, ownerId: "chat", sessionId: "s2", provider: "ghcp" },
            { kind: "message", at: 9, ownerId: "chat", text: "answer" }
        ];

        expect(summarizeChat("c1", events)).toEqual({ id: "c1", title: "first question", at: 9, provider: "ghcp" });
    });

    it("names a chat by the newest title the runtime gave it, over the first message", () => {

        const events: RunEvent[] = [
            { kind: "open", at: 1, runId: "chat:c1" },
            { kind: "prompt", at: 2, ownerId: "chat", text: "Create a file named probe.txt in the current folder containing the single word: hi" },
            { kind: "notice", at: 3, ownerId: "chat", text: "Title: Create a file named probe.txt...", title: "Create a file named probe.txt..." },
            { kind: "notice", at: 4, ownerId: "chat", text: "Title: Create Probe.txt With Single Word", title: "Create Probe.txt With Single Word" }
        ];

        expect(summarizeChat("c1", events)?.title).toBe("Create Probe.txt With Single Word");
    });

    it("leaves out a chat nobody wrote in", () => {

        expect(summarizeChat("c2", [{ kind: "open", at: 1, runId: "chat:c2" }])).toBeUndefined();
    });
});

describe("listChats", () => {

    // A list is read each time a turn starts or ends - a chat file
    // nobody wrote to since is not read again.
    it("keeps a chat's row until its file changes, and drops a deleted chat", () => {

        // A workspace name of its own, so other tests' chats are not in the list.
        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chat-history-"));
        const file = chatEventsPath(workspace, "c1");

        // A whole second, so the time read back is exactly the time set.
        const time = new Date(1_700_000_000_000);

        const write = (question: string) => {

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, [
                { kind: "open", at: 1000, runId: "chat:c1" },
                { kind: "prompt", at: 1000, ownerId: "chat", text: question }
            ].map(event => JSON.stringify(event)).join("\n") + "\n");
            fs.utimesSync(file, time, time);
        };

        write("first question");

        expect(listChats(workspace)).toEqual([{ id: "c1", title: "first question", at: 1000 }]);

        // Same size, same time: the kept row is used, the file not read.
        write("fresh question");

        expect(listChats(workspace)[0].title).toBe("first question");

        // Written to: read again.
        fs.appendFileSync(file, JSON.stringify({ kind: "message", at: 2000, ownerId: "chat", text: "hi", title: "Named" }) + "\n");

        expect(listChats(workspace)).toEqual([{ id: "c1", title: "Named", at: 2000 }]);

        fs.rmSync(file);

        expect(listChats(workspace)).toEqual([]);
    });
});

describe("searchChats", () => {

    it("finds what the person and the agent said, not tool output or reasoning, one hit per chat", () => {

        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chat-search-"));

        const write = (id: string, events: object[]) => {

            const file = chatEventsPath(workspace, id);

            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, events.map(event => JSON.stringify({ at: 1000, ownerId: "chat", ...event })).join("\n") + "\n");
        };

        write("asked", [
            { kind: "prompt", text: "Why does the Parser\nfail on tabs?" },
            { kind: "message", text: "The parser " },
            { kind: "message", text: "splits on spaces only." }
        ]);

        write("tools", [
            { kind: "prompt", text: "run the build" },
            { kind: "tool.start", tool: "shell", detail: "npm run build parser" },
            { kind: "tool.end", detail: "parser built" },
            { kind: "reasoning", text: "the parser is fine" }
        ]);

        // A cleared chat shows only what came after the clear.
        write("cleared", [
            { kind: "prompt", text: "old parser question" },
            { kind: "cleared" },
            { kind: "prompt", text: "something else" }
        ]);

        // Spaces and line breaks count as one space; any case.
        expect(searchChats(workspace, "PARSER  fail")).toEqual([{ id: "asked", line: "Why does the Parser fail on tabs?" }]);

        // The agent's answer is one piece, though it came as two records.
        expect(searchChats(workspace, "parser splits")).toEqual([{ id: "asked", line: "The parser splits on spaces only." }]);

        // Found once in "asked"; never in tool calls, their output, reasoning or cleared lines.
        expect(searchChats(workspace, "parser").map(hit => hit.id)).toEqual(["asked"]);

        expect(searchChats(workspace, "   ")).toEqual([]);
    });

    it("cuts a long line around the match", () => {

        const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chat-search-"));
        const file = chatEventsPath(workspace, "long");

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ kind: "prompt", at: 1, ownerId: "chat", text: `${"a".repeat(200)} needle ${"b".repeat(200)}` }) + "\n");

        const [hit] = searchChats(workspace, "needle");

        expect(hit.line.startsWith("…")).toBe(true);
        expect(hit.line.endsWith("…")).toBe(true);
        expect(hit.line).toContain("needle");
        expect(hit.line.length).toBeLessThanOrEqual(122);
    });
});

import { describe, expect, it } from "vitest";

import { LogLine, addModelSpend, addSpend, isQuota } from "../../core/models/run";
import { RETRY_MESSAGE, contextSegments, effortChoiceOf, hiddenInThread, isAccountUsage, threadRows, jumpTargets, listedModelOf, modeChoiceOf, modelOptionsOf, pickWith, retrySend, retryTurnId, shortPaths, showsResume, resolveAnswer, spendText, turnsFrom, turnStatus } from "../ChatView";
import { LogEntry, withLine } from "../templates/logEntry";

/**
 * The question turn in the AI Session tab: a question is its own turn
 * and stays open until an answer names it, and a typed number is sent
 * as the choice it points at, so the agent hears "SQLite" and not "1".
 */

function entry(overrides: Partial<LogEntry> & { category: string; message: string }, index: number): LogEntry {

    return { id: `${index}`, at: index, level: "info", ...overrides };
}

describe("turnsFrom with requests allowed without asking", () => {

    it("marks the call's own row, found by its id, instead of adding a row", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "bash", tool: "bash", callId: "a", detail: "npm test" }, 0),
            entry({ category: "notice", message: "", permission: { tool: "shell", input: "npm test" }, callId: "a" }, 1)
        ]);

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ shape: "tools", calls: [{ name: "bash", allowed: true }] });
        expect(turns[0].shape === "tools" && turns[0].calls).toHaveLength(1);

        // Same as the call's own argument, so nothing extra to show.
        expect(turns[0].shape === "tools" && turns[0].calls[0].asked).toBeUndefined();
    });

    it("marks the row when the request comes before the call starts", () => {

        const turns = turnsFrom([
            entry({ category: "notice", message: "", permission: { tool: "shell", input: "npm run build" }, callId: "a" }, 0),
            entry({ category: "tool.start", message: "bash", tool: "bash", callId: "a", detail: "build" }, 1)
        ]);

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({ calls: [{ name: "bash", allowed: true, asked: "npm run build" }] });
    });

    it("leaves other calls unmarked", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "bash", tool: "bash", callId: "a" }, 0),
            entry({ category: "tool.start", message: "bash", tool: "bash", callId: "b" }, 1),
            entry({ category: "notice", message: "", permission: { tool: "shell" }, callId: "b" }, 2)
        ]);

        expect(turns[0].shape === "tools" && turns[0].calls.map(call => call.allowed)).toEqual([undefined, true]);
    });

    it("draws its own row for a request with no call id", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "bash", tool: "bash", callId: "a" }, 0),
            entry({ category: "notice", message: "Allowed without asking: shell", permission: { tool: "shell", input: "npm test" } }, 1)
        ]);

        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
            shape: "tools",
            calls: [
                { name: "bash" },
                { name: "Allowed without asking: shell", detail: "npm test", allowed: true, outcome: { ok: true } }
            ]
        });
    });

    it("leaves an ordinary notice out of the thread", () => {

        expect(turnsFrom([entry({ category: "notice", message: "Context compacted" }, 0)])).toEqual([]);
    });

    it("does not let a call's end close the allowed row instead of the call", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "bash", tool: "bash" }, 0),
            entry({ category: "notice", message: "", permission: { tool: "bash" } }, 1),
            entry({ category: "tool.end", message: "", tool: "bash", ok: true, ms: 5 }, 2)
        ]);

        expect(turns[0]).toMatchObject({ calls: [{ name: "bash", outcome: { ok: true, ms: 5 } }, { allowed: true }] });
    });
});

describe("turnsFrom with the permission check's notes", () => {

    it("puts the note on the call's row: how it was decided", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "Bash", tool: "Bash", callId: "a", detail: "npm run build" }, 0),
            entry({
                category: "notice", message: "",
                permission: { tool: "Bash", input: "npm run build", note: "allowed by your answer `npm run build *` (this session)" },
                callId: "a"
            }, 1)
        ]);

        expect(turns[0]).toMatchObject({
            calls: [{ name: "Bash", allowed: true, note: "allowed by your answer `npm run build *` (this session)" }]
        });
        expect(turns[0].shape === "tools" && turns[0].calls[0].refused).toBeUndefined();
    });

    it("marks a refused call, so the row says it did not run", () => {

        const turns = turnsFrom([
            entry({
                category: "notice", message: "",
                permission: { tool: "Read", input: "~/.ssh/id_rsa", note: "refused: ~/.ssh is never allowed, in any mode", refused: true },
                callId: "r"
            }, 0),
            entry({ category: "tool.start", message: "Read", tool: "Read", callId: "r" }, 1)
        ]);

        expect(turns[0]).toMatchObject({ calls: [{ name: "Read", refused: true, note: "refused: ~/.ssh is never allowed, in any mode" }] });
    });

    it("a request with no call id gets a row named by its tool, carrying the note", () => {

        const turns = turnsFrom([
            entry({
                category: "notice", message: "",
                permission: { tool: "shell", input: "npm i", note: "denied by you: \"not now\"", refused: true }
            }, 0)
        ]);

        expect(turns[0]).toMatchObject({
            calls: [{ name: "shell", detail: "npm i", request: true, refused: true, note: "denied by you: \"not now\"", outcome: { ok: false } }]
        });
    });
});

/*
 * A permission card never joins the thread: the call's tool row says how
 * it was decided, and a block per request would say the same thing twice.
 */
describe("hiddenInThread", () => {

    const [request, answered] = turnsFrom([
        entry({ category: "ask", message: "Copilot wants to run a command.", askId: "p1", permission: { tool: "shell", input: "npm test" } }, 0),
        entry({ category: "ask", message: "Copilot wants to run a command.", askId: "p2", permission: { tool: "shell", input: "npm i" } }, 1),
        entry({ category: "answer", message: "Always: npm i", askId: "p2" }, 2)
    ]);

    const [question, reply] = turnsFrom([
        entry({ category: "ask", message: "Which store?", askId: "q1" }, 0),
        entry({ category: "ask", message: "Keep old data?", askId: "q2" }, 1),
        entry({ category: "answer", message: "Yes", askId: "q2" }, 2)
    ]);

    it("hides an answered permission card", () => {

        expect(hiddenInThread(answered, false, true)).toBe(true);
        expect(hiddenInThread(answered, true, true)).toBe(true);
    });

    it("hides an open one while its card is pinned at the foot, and once its turn is over", () => {

        expect(hiddenInThread(request, true, true)).toBe(true);
        expect(hiddenInThread(request, false, true)).toBe(true);
    });

    it("shows an open one waiting in a view that has no card to answer it with", () => {

        expect(hiddenInThread(request, true, false)).toBe(false);
    });

    it("keeps a question the agent asked in the thread once answered, or once its turn is over", () => {

        expect(hiddenInThread(reply, true, true)).toBe(false);
        expect(hiddenInThread(question, false, true)).toBe(false);

        // Open while its card is pinned at the foot: drawn there, not here.
        expect(hiddenInThread(question, true, true)).toBe(true);
    });
});

/*
 * A permission question between two calls is not drawn, so the calls on
 * either side of it are one block: "Used 3 tools", not one call alone and
 * then "Used 2 tools".
 */
describe("threadRows", () => {

    const turns = turnsFrom([
        entry({ category: "tool.start", message: "shell", tool: "shell", callId: "a", detail: "Write-Output 'First echo'" }, 0),
        entry({ category: "ask", message: "Copilot wants to run a command.", askId: "p1", permission: { tool: "shell", input: "Write-Output 'First echo'" } }, 1),
        entry({ category: "answer", message: "Always: Write-Output *", askId: "p1" }, 2),
        entry({ category: "tool.end", message: "", tool: "shell", callId: "a", ok: true, ms: 9100 }, 3),
        entry({ category: "tool.start", message: "shell", tool: "shell", callId: "b" }, 4),
        entry({ category: "tool.end", message: "", tool: "shell", callId: "b", ok: true, ms: 400 }, 5),
        entry({ category: "tool.start", message: "shell", tool: "shell", callId: "c" }, 6),
        entry({ category: "tool.end", message: "", tool: "shell", callId: "c", ok: true, ms: 423 }, 7)
    ]);

    it("joins the calls on either side of a hidden permission question", () => {

        // The log keeps the question between them.
        expect(turns.map(turn => turn.shape)).toEqual(["tools", "ask", "tools"]);

        const rows = threadRows(turns, false, true);

        expect(rows).toHaveLength(1);
        expect(rows[0].shape === "tools" && rows[0].calls.map(call => call.callId)).toEqual(["a", "b", "c"]);
    });

    it("leaves the turns it was given as they were", () => {

        threadRows(turns, false, true);

        expect(turns[0].shape === "tools" && turns[0].calls).toHaveLength(1);
    });

    it("keeps them apart while the question shows - waiting, with no card to answer it", () => {

        const open = turnsFrom([
            entry({ category: "tool.start", message: "shell", tool: "shell", callId: "a" }, 0),
            entry({ category: "ask", message: "Copilot wants to run a command.", askId: "p1", permission: { tool: "shell", input: "x" } }, 1),
            entry({ category: "tool.start", message: "shell", tool: "shell", callId: "b" }, 2)
        ]);

        expect(threadRows(open, true, false).map(turn => turn.shape)).toEqual(["tools", "ask", "tools"]);
    });
});

describe("turnsFrom with questions", () => {

    /** `message` carries the choices written out for the log; `prompt` is the question by itself. */
    it("shows the question without the choices it draws as buttons", () => {

        const turns = turnsFrom([
            entry({
                category: "ask",
                message: "Which store?\n1. SQLite\n2. Postgres",
                prompt: "Which store?",
                askId: "ask-1",
                options: [{ label: "SQLite" }, { label: "Postgres" }]
            }, 0)
        ]);

        expect((turns[0] as { text: string }).text).toBe("Which store?");
    });

    /** With no choices there is nothing drawn twice, so the text stands. */
    it("shows the whole message when the question came with no choices", () => {

        const turns = turnsFrom([
            entry({ category: "ask", message: "What should it be called?", askId: "ask-1" }, 0)
        ]);

        expect((turns[0] as { text: string }).text).toBe("What should it be called?");
    });

    it("draws a question as an open ask turn", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "ask", message: "Which store?\n1. SQLite\n2. Postgres", askId: "ask-1", options: [{ label: "SQLite" }, { label: "Postgres" }] }, 1)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["user", "ask"]);

        const ask = turns[1];

        if (ask.shape !== "ask")
            return;

        expect(ask.askId).toBe("ask-1");
        expect(ask.answer).toBeUndefined();
        expect(ask.options).toEqual([{ label: "SQLite" }, { label: "Postgres" }]);
    });

    /**
     * The answer is carried on the question rather than pushed as a
     * turn of its own: "SQLite" three turns below its question says
     * nothing.
     */
    it("carries the answer on the question it names, and adds no turn of its own", () => {

        const turns = turnsFrom([
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 0),
            entry({ category: "ask", message: "Keep old data?", askId: "ask-2" }, 1),
            entry({ category: "answer", message: "SQLite", askId: "ask-1" }, 2)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["ask", "ask"]);

        const [first, second] = turns;

        if (first.shape === "ask")
            expect(first.answer).toBe("SQLite");

        // The newer question was not the one answered, so it stays open.
        if (second.shape === "ask")
            expect(second.answer).toBeUndefined();
    });

    /**
     * A log that starts mid-conversation has answers whose questions
     * are not in it. Such an answer is drawn, not dropped.
     */
    it("draws an answer whose question is nowhere as the person's own turn", () => {

        const turns = turnsFrom([
            entry({ category: "answer", message: "SQLite", askId: "ask-gone" }, 0)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["user"]);
    });

    it("does not let a later line close a question - only an answer does", () => {

        const turns = turnsFrom([
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 0),
            entry({ category: "message", message: "Still thinking." }, 1)
        ]);

        const ask = turns[0];

        if (ask.shape === "ask")
            expect(ask.answer).toBeUndefined();
    });

    /*
     * The turn that asked ended without an answer (the machine
     * restarted), and the person carried on by sending a message into
     * the reopened conversation. That message is their reply: the
     * question closes, and the message stands as its own turn.
     */
    it("lets a message the person sends close the questions still open before it", () => {

        const turns = turnsFrom([
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 0),
            entry({ category: "ask", message: "Which provider?", askId: "ask-2" }, 1),
            entry({ category: "prompt", message: "SQLite, on Claude." }, 2)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["ask", "ask", "user"]);

        for (const ask of turns.slice(0, 2))
            if (ask.shape === "ask") {

                expect(ask.answer).toBe("");
                expect(ask.viaMessage).toBe(true);
            }

        // The reply is the message turn, not a copy inside the question.
        expect((turns[2] as { text: string }).text).toBe("SQLite, on Claude.");
    });

    it("does not let a message close a question asked after it", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 1)
        ]);

        const ask = turns[1];

        if (ask.shape === "ask") {

            expect(ask.answer).toBeUndefined();
            expect(ask.viaMessage).toBeUndefined();
        }
    });
});

/**
 * Which turn may be edited and run again. The prompt and an answer are
 * both the person's and drawn the same, but only the prompt is the
 * task's instruction: rerunning on an answer would send "SQLite" as
 * the whole ask. So the turn says which one it is.
 *
 * A prompt is always one entry (a labelled line is emitted whole, see
 * `TaskRunner`'s `onOutput`), so the rules here are only about what
 * must not be joined to it.
 */
describe("turnsFrom and the prompt", () => {

    it("marks the prompt, and nothing else the person said", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "message", message: "Done." }, 1),
            entry({ category: "answer", message: "SQLite" }, 2)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["user", "ai", "user"]);
        expect(turns.map(turn => "prompt" in turn && turn.prompt === true)).toEqual([true, false, false]);
    });

    /*
     * An answer whose question is not in the log falls through to an
     * ordinary turn on the person's side. Joined onto the prompt, it
     * would become part of what a rerun sends.
     */
    it("keeps an unmatched answer out of the prompt it follows", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "answer", message: "SQLite", askId: "ask-gone" }, 1)
        ]);

        expect(turns).toHaveLength(2);
        expect((turns[0] as { text: string }).text).toBe("Draft it.");
        expect((turns[1] as { text: string }).text).toBe("SQLite");
    });

    /** And the other way round, for a prompt that arrives after one. */
    it("keeps a prompt out of the turn before it", () => {

        const turns = turnsFrom([
            entry({ category: "answer", message: "SQLite", askId: "ask-gone" }, 0),
            entry({ category: "prompt", message: "Draft it." }, 1)
        ]);

        expect(turns).toHaveLength(2);
        expect((turns[1] as { prompt?: boolean }).prompt).toBe(true);
        expect((turns[1] as { text: string }).text).toBe("Draft it.");
    });

    /*
     * A rerun writes its own prompt line into the same thread. Two
     * prompts are two messages, not one in two pieces: joined, the
     * second Edit box would open on both.
     */
    it("keeps two prompts apart, each editable on its own", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "message", message: "Done." }, 1),
            entry({ category: "prompt", message: "Draft it, shorter." }, 2)
        ]);

        expect(turns.map(turn => (turn as { text?: string }).text))
            .toEqual(["Draft it.", "Done.", "Draft it, shorter."]);

        expect(turns.map(turn => "prompt" in turn && turn.prompt === true))
            .toEqual([true, false, true]);
    });

    /** The newlines inside one are kept - it is one message, as sent. */
    it("keeps a multi-line prompt whole", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "my-feature: draft\n\nDraft it." }, 0)
        ]);

        expect(turns).toHaveLength(1);
        expect((turns[0] as { text: string }).text).toBe("my-feature: draft\n\nDraft it.");
    });

    /*
     * The files that went with the message. An attachment is not in the
     * text, so a thread that draws only `message` shows half of what
     * was sent.
     */
    it("carries the attachments the message was sent with", () => {

        const turns = turnsFrom([
            entry({
                category: "prompt",
                message: "Draft it.",
                attachments: [
                    { path: "C:/repo/.eesha/styles/kiro/glossary.md" },
                    { path: "C:/repo/docs/house-style.md", name: "house style" }
                ]
            }, 0)
        ]);

        expect((turns[0] as { attachments?: { path: string }[] }).attachments)
            .toEqual([
                { path: "C:/repo/.eesha/styles/kiro/glossary.md" },
                { path: "C:/repo/docs/house-style.md", name: "house style" }
            ]);
    });

    /** Nothing attached leaves the field off, so no empty row is drawn. */
    it("leaves the field off a message that carried no files", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it.", attachments: [] }, 0)
        ]);

        expect("attachments" in turns[0]).toBe(false);
    });

    /** Only the sent message. An answer the person typed attaches nothing. */
    it("does not put attachments on anything but the prompt", () => {

        const turns = turnsFrom([
            entry({ category: "message", message: "Done.", attachments: [{ path: "C:/x.md" }] }, 0)
        ]);

        expect("attachments" in turns[0]).toBe(false);
    });
});

describe("withLine", () => {

    const line = (over: Partial<LogLine>): LogLine => ({
        ownerId: "requirements", text: "", stream: "stdout", at: 0, ...over
    });

    const delta = (text: string, channel = "message", agent?: string) =>
        line({ text, kind: "delta", channel, ephemeral: true, agent });

    it("replaces the last live line rather than stacking copies of it", () => {

        const lines = [delta("Hel"), delta("Hello"), delta("Hello there")]
            .reduce<LogLine[]>((all, next) => withLine(all, next), []);

        expect(lines).toHaveLength(1);
        expect(lines[0].text).toBe("Hello there");
    });

    it("keeps the live line where it started, not at the end", () => {

        let lines = withLine<LogLine>([line({ text: "before", kind: "prompt" })], delta("Hel"));

        lines = withLine(lines, line({ text: "a tool ran", kind: "tool.start" }));
        lines = withLine(lines, delta("Hello"));

        expect(lines.map(one => one.text)).toEqual(["before", "Hello", "a tool ran"]);
    });

    /** A running command's output: one live line per call, replaced as it grows. */
    const printed = (callId: string, text: string) =>
        line({ text, kind: "tool.output", callId, tool: "bash", ephemeral: true });

    it("replaces a call's live output rather than stacking every chunk of it", () => {

        const lines = [printed("a", "one"), printed("a", "one\ntwo"), printed("a", "one\ntwo\nthree")]
            .reduce<LogLine[]>((all, next) => withLine(all, next), []);

        expect(lines).toHaveLength(1);
        expect(lines[0].text).toBe("one\ntwo\nthree");
    });

    /* Two commands running one after the other each own their output. */
    it("keeps one live line per call", () => {

        let lines = withLine<LogLine>([], printed("a", "from a"));

        lines = withLine(lines, printed("b", "from b"));
        lines = withLine(lines, printed("a", "from a, more"));

        expect(lines.map(one => [one.callId, one.text]))
            .toEqual([["a", "from a, more"], ["b", "from b"]]);
    });

    it("drops a call's live output when the call ends", () => {

        let lines = withLine<LogLine>([], printed("a", "building"));

        lines = withLine(lines, line({ text: "bash done in 2.0s", kind: "tool.end", callId: "a" }));

        expect(lines).toHaveLength(1);
        expect(lines[0].kind).toBe("tool.end");
    });

    /* A call that streamed nothing must still have its end kept. */
    it("keeps an end that had no live output to replace", () => {

        const lines = withLine<LogLine>(
            [line({ text: "bash", kind: "tool.start", callId: "a" })],
            line({ text: "bash done", kind: "tool.end", callId: "a" }));

        expect(lines.map(one => one.kind)).toEqual(["tool.start", "tool.end"]);
    });

    it("lets the completed line take the live one's place", () => {

        let lines = withLine<LogLine>([], delta("Hel"));

        lines = withLine(lines, line({ text: "Hello there", kind: "message" }));

        expect(lines).toHaveLength(1);
        expect(lines[0].ephemeral).toBeUndefined();
        expect(lines[0].text).toBe("Hello there");
    });

    /**
     * A provider that buffers a turn's text and flushes it at the end
     * (`AcpEventTranslator`) sends the completed line after the tool
     * calls. Putting it back in the first delta's slot would draw it above
     * them live and below them on replay, since the store keeps no
     * deltas.
     */
    it("puts the completed line after whatever arrived while it was written", () => {

        let lines = withLine<LogLine>([], delta("Reading the"));

        lines = withLine(lines, line({ text: "read config.yml", kind: "tool.start" }));
        lines = withLine(lines, line({ text: "read config.yml", kind: "tool.end" }));
        lines = withLine(lines, delta("Reading the config. It sets three"));
        lines = withLine(lines, line({ text: "Reading the config. It sets three keys.", kind: "message" }));

        expect(lines.map(one => one.text)).toEqual([
            "read config.yml",
            "read config.yml",
            "Reading the config. It sets three keys."
        ]);

        expect(lines.some(one => one.ephemeral)).toBe(false);
    });

    it("does not let thinking and prose replace each other", () => {

        let lines = withLine<LogLine>([], delta("checking", "reasoning"));

        lines = withLine(lines, delta("Hello", "message"));

        expect(lines.map(one => one.text)).toEqual(["checking", "Hello"]);
    });

    it("keeps each speaker's live line apart", () => {

        let lines = withLine<LogLine>([], delta("main", "message"));

        lines = withLine(lines, delta("helper", "message", "Explore"));

        expect(lines).toHaveLength(2);
    });

    it("leaves every ordinary line exactly where it was", () => {

        const lines = [
            line({ text: "one", kind: "tool.start" }),
            line({ text: "two", kind: "notice" }),
            line({ text: "three", kind: "message" })
        ].reduce<LogLine[]>((all, next) => withLine(all, next), []);

        expect(lines.map(one => one.text)).toEqual(["one", "two", "three"]);
    });
});

describe("turnsFrom with live text", () => {

    it("draws a message delta as the agent's turn, marked live", () => {

        const turns = turnsFrom([
            entry({ category: "delta", channel: "message", message: "Hello th", ephemeral: true }, 0)
        ]);

        expect(turns[0].shape).toBe("ai");
        expect((turns[0] as { live?: boolean }).live).toBe(true);
    });

    it("draws a reasoning delta as a thought", () => {

        const turns = turnsFrom([
            entry({ category: "delta", channel: "reasoning", message: "checking", ephemeral: true }, 0)
        ]);

        expect(turns[0].shape).toBe("thought");
    });

    /**
     * Each chunk is a new line with a new id. The row is keyed by the
     * turn's id, so a new id per chunk would rebuild the card every chunk and
     * its fade-in would make the answer flicker.
     */
    it("keeps one id for a live turn while its chunks arrive", () => {

        const first = turnsFrom([
            entry({ category: "delta", channel: "message", message: "Hel", ephemeral: true }, 0)
        ]);

        const later = turnsFrom([
            entry({ category: "delta", channel: "message", message: "Hello there", ephemeral: true }, 7)
        ]);

        expect(later[0].id).toBe(first[0].id);
    });

    it("puts thinking that arrives after the answer above it", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "give me a command" }, 0),
            entry({ category: "message", message: "Write-Output hi" }, 1),
            entry({ category: "reasoning", message: "**Considering**" }, 2)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["user", "thought", "ai"]);
    });

    it("joins the moved thinking to thinking already above the answer", () => {

        const turns = turnsFrom([
            entry({ category: "reasoning", message: "first" }, 0),
            entry({ category: "message", message: "answer" }, 1),
            entry({ category: "reasoning", message: "second" }, 2)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["thought", "ai"]);
        expect((turns[0] as { text: string }).text).toBe("first\nsecond");
    });

    it("leaves thinking after a tool row where it is", () => {

        const turns = turnsFrom([
            entry({ category: "message", message: "Reading it." }, 0),
            entry({ category: "tool.start", message: "read", tool: "read", callId: "a" }, 1),
            entry({ category: "reasoning", message: "next step" }, 2)
        ]);

        expect(turns.map(turn => turn.shape)).toEqual(["ai", "tools", "thought"]);
    });

    it("gives the live thought and the live answer different ids", () => {

        const turns = turnsFrom([
            entry({ category: "delta", channel: "reasoning", message: "checking", ephemeral: true }, 0),
            entry({ category: "delta", channel: "message", message: "Hello", ephemeral: true }, 1)
        ]);

        expect(turns[0].id).not.toBe(turns[1].id);
    });

    /**
     * Half a sentence appended to a finished paragraph would be read as
     * part of it - and the completed line replaces the live one anyway.
     */
    it("never merges a finished message into a live one", () => {

        const turns = turnsFrom([
            entry({ category: "delta", channel: "message", message: "Hel", ephemeral: true }, 0),
            entry({ category: "message", message: "Hello there" }, 1)
        ]);

        expect(turns).toHaveLength(2);
        expect(turns.map(turn => (turn as { live?: boolean }).live)).toEqual([true, undefined]);
    });
});

describe("resolveAnswer", () => {

    const options = [{ label: "SQLite" }, { label: "Postgres" }, { label: "Neither" }];

    it("sends a typed number as the choice it points at", () => {

        expect(resolveAnswer("2", options)).toBe("Postgres");
        expect(resolveAnswer(" 1 ", options)).toBe("SQLite");
    });

    it("sends anything else as typed - the choices are never the whole list", () => {

        expect(resolveAnswer("Use a JSON file", options)).toBe("Use a JSON file");
        expect(resolveAnswer("9", options)).toBe("9");
        expect(resolveAnswer("0", options)).toBe("0");
    });

    it("sends several numbers as several choices when more than one may be picked", () => {

        expect(resolveAnswer("1, 3", options, true)).toBe("SQLite, Neither");

        // One number out of range means the whole thing was not a pick.
        expect(resolveAnswer("1, 7", options, true)).toBe("1, 7");

        // Not multi: a list is sent as typed.
        expect(resolveAnswer("1, 3", options, false)).toBe("1, 3");
    });

    it("leaves free text alone when there were no choices", () => {

        expect(resolveAnswer("2", undefined)).toBe("2");
        expect(resolveAnswer("   ", options)).toBe("");
    });
});


/**
 * Narration is not a turn. A notice (a session id, a rate limit, a
 * compaction, a cost) is the bulk of what a session emits and would
 * bury the exchange; the Logs tab keeps every one.
 */
describe("turnsFrom and the runtime's own narration", () => {

    it("draws no turn for a notice, however many arrive", () => {

        const turns = turnsFrom([
            entry({ category: "notice", message: "The account's rate limit state changed." }, 0),
            entry({ category: "notice", message: "Claude session 9e6a2be6: model=claude-sonnet-5" }, 1),
            entry({ category: "notice", message: "Turn finished - tokens in=25710 out=237" }, 2)
        ]);

        expect(turns).toEqual([]);
    });

    it("leaves the exchange around a notice untouched, and unbroken", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "notice", message: "Claude session 9e6a2be6" }, 1),
            entry({ category: "message", message: "Here it is." }, 2),
            entry({ category: "notice", message: "Turn finished" }, 3),
            entry({ category: "message", message: "And one more thing." }, 4)
        ]);

        // Two turns, not four: the agent's two lines are one turn once
        // the notice between them is gone.
        expect(turns.map(turn => turn.shape)).toEqual(["user", "ai"]);
        expect((turns[1] as { text: string }).text).toBe("Here it is.\nAnd one more thing.");
    });
});

/**
 * A turn's token report arrives on a notice line after the answer. It is
 * put on that answer, for the message to show under it.
 */
describe("turnsFrom and a turn's tokens", () => {

    it("puts the counts on the answer before them, summed across models", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it." }, 0),
            entry({ category: "message", message: "Here it is." }, 1),
            entry({
                category: "notice",
                message: "Turn finished",
                models: [
                    { model: "a", inputTokens: 100, outputTokens: 20 },
                    { model: "b", inputTokens: 5, outputTokens: 1 }
                ]
            }, 2)
        ]);

        expect((turns[1] as { usage?: unknown }).usage).toEqual({ inputTokens: 105, outputTokens: 21 });
    });

    it("leaves the answer without counts when the runtime reported none", () => {

        const turns = turnsFrom([
            entry({ category: "message", message: "Here it is." }, 0),
            entry({ category: "notice", message: "Turn finished", models: [{ model: "a" }] }, 1)
        ]);

        expect((turns[0] as { usage?: unknown }).usage).toBeUndefined();
    });
});

/**
 * The time on a turn is when it was finished. Lines are joined into
 * one turn, and the stamp the AI Session tab draws on the newest
 * answer must say when the agent stopped, not when it started.
 */
describe("turnsFrom and a turn's time", () => {

    it("gives a joined turn the time of its last line", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it.", at: 100 }, 0),
            entry({ category: "message", message: "Here it is.", at: 200 }, 1),
            entry({ category: "message", message: "And one more thing.", at: 350 }, 2)
        ]);

        expect(turns.map(turn => (turn as { at: number }).at)).toEqual([100, 350]);
    });

    it("keeps each turn's own time when nothing is joined", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Draft it.", at: 100 }, 0),
            entry({ category: "message", message: "Here it is.", at: 200 }, 1),
            entry({ category: "prompt", message: "Shorter.", at: 300 }, 2),
            entry({ category: "message", message: "Done.", at: 400 }, 3)
        ]);

        expect(turns.map(turn => (turn as { at: number }).at)).toEqual([100, 200, 300, 400]);
    });
});

/**
 * Parallel calls to one tool: three `Read`s in one message are three
 * starts sharing a name, with ends arriving in any order. Pairing on
 * the name would give each end to the wrong start, so durations would be wrong.
 */
describe("turnsFrom and two halves of the same call", () => {

    const call = (id: string, file: string, index: number) => entry({
        category: "tool.start",
        message: `Read: ${file}`,
        tool: "Read",
        callId: id,
        detail: file
    }, index);

    const done = (id: string, ms: number, index: number) => entry({
        category: "tool.end",
        message: `Read done in ${ms}ms`,
        tool: "Read",
        callId: id,
        ok: true,
        ms
    }, index);

    it("gives each end to the call it names, whatever order they arrive in", () => {

        const turns = turnsFrom([
            call("a", "one.ts", 0),
            call("b", "two.ts", 1),
            call("c", "three.ts", 2),

            // Back to front, which is what parallel calls do.
            done("c", 30, 3),
            done("a", 10, 4),
            done("b", 20, 5)
        ]);

        expect(turns).toHaveLength(1);

        const tools = turns[0];

        if (tools.shape !== "tools")
            return;

        expect(tools.calls.map(one => [one.detail, one.outcome?.ms]))
            .toEqual([["one.ts", 10], ["two.ts", 20], ["three.ts", 30]]);
    });

    it("puts a running call's output on its own row", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "bash", tool: "bash", callId: "a" }, 0),
            entry({ category: "tool.output", message: "Building...", callId: "a" }, 1)
        ]);

        const tools = turns[0];

        if (tools.shape !== "tools")
            return;

        expect(tools.calls[0].output).toBe("Building...");

        // Output is not a row of its own - there is one call here.
        expect(turns).toHaveLength(1);
    });

    /* Output whose start was never seen has no row to sit under. */
    it("drops output that belongs to no call on screen", () => {

        const turns = turnsFrom([
            entry({ category: "tool.output", message: "Building...", callId: "ghost" }, 0)
        ]);

        expect(turns).toHaveLength(0);
    });

    it("pairs by name when the provider gave no id", () => {

        const turns = turnsFrom([
            entry({ category: "tool.start", message: "grep", tool: "grep" }, 0),
            entry({ category: "tool.end", message: "grep done", tool: "grep", ok: true, ms: 12 }, 1)
        ]);

        const tools = turns[0];

        if (tools.shape !== "tools")
            return;

        expect(tools.calls[0].outcome).toEqual({ ok: true, ms: 12, detail: undefined });
    });

    it("does not let an end claim a call whose id it does not carry", () => {

        const turns = turnsFrom([
            call("a", "one.ts", 0),
            done("gone", 99, 1)
        ]);

        const tools = turns[0];

        if (tools.shape !== "tools")
            return;

        // The start is still running, and the orphan end is its own row
        // rather than silently closing somebody else's call.
        expect(tools.calls[0].outcome).toBeUndefined();
        expect(tools.calls).toHaveLength(2);
    });
});

/*
 * A long tool call or a question in a tab nobody is looking at shows
 * nothing on its own, so the view must say what it is waiting for.
 */
describe("where the conversation stands", () => {

    /** The same rule the file uses on replay. */
    function waiting(entries: LogEntry[]): boolean {

        return turnsFrom(entries).some(turn => turn.shape === "ask" && turn.answer === undefined);
    }

    it("is waiting while a question has no answer beside it", () => {

        expect(waiting([
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 0)
        ])).toBe(true);
    });

    it("is not waiting once the answer names that question", () => {

        expect(waiting([
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 0),
            entry({ category: "answer", message: "SQLite", askId: "ask-1" }, 1)
        ])).toBe(false);
    });

    /* Two can be open at once, and answering one does not answer the other. */
    it("is still waiting when a second question is open", () => {

        expect(waiting([
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 0),
            entry({ category: "ask", message: "Which provider?", askId: "ask-2" }, 1),
            entry({ category: "answer", message: "SQLite", askId: "ask-1" }, 2)
        ])).toBe(true);
    });

    it("is not waiting on a conversation that never asked anything", () => {

        expect(waiting([
            entry({ category: "message", message: "Done." }, 0)
        ])).toBe(false);
    });
});

/**
 * The Retry button: on the error that ended the last turn, only once
 * nothing is running, and only where a message could be sent.
 */
describe("retryTurnId", () => {

    const failed = [
        entry({ category: "prompt", message: "Do the wave." }, 0),
        entry({ category: "message", message: "Reading the plan." }, 1),
        entry({ category: "error", message: "fetch failed" }, 2),

        // Narration after the error is not a turn, and does not hide it.
        entry({ category: "notice", message: "The agent stopped working." }, 3)
    ];

    it("is on the error when it ended the last turn", () => {

        const turns = turnsFrom(failed);

        expect(retryTurnId(turns, false, true)).toBe(turns[turns.length - 1].id);
    });

    it("is nowhere while the turn is still running", () => {

        expect(retryTurnId(turnsFrom(failed), true, true)).toBeUndefined();
    });

    it("is nowhere when no message can be sent", () => {

        expect(retryTurnId(turnsFrom(failed), false, false)).toBeUndefined();
    });

    it("is nowhere when the agent carried on past the error", () => {

        expect(retryTurnId(turnsFrom([
            ...failed,
            entry({ category: "message", message: "Carried on anyway." }, 4)
        ]), false, true)).toBeUndefined();
    });

    it("is nowhere once a message was sent after it", () => {

        expect(retryTurnId(turnsFrom([
            ...failed,
            entry({ category: "prompt", message: "Carry on." }, 4)
        ]), false, true)).toBeUndefined();
    });

    it("is nowhere on a turn that finished well", () => {

        expect(retryTurnId(turnsFrom(failed.slice(0, 2)), false, true)).toBeUndefined();
    });
});

/**
 * What Retry sends: your last message again, whatever the agent did with
 * it; "continue" only when there is no message of yours.
 */
describe("retrySend", () => {

    it("sends your last message again, with its files, when the error came straight after it", () => {

        const turns = turnsFrom([
            entry({ category: "prompt", message: "Fix the parser." }, 0),
            entry({ category: "message", message: "Done." }, 1),
            entry({
                category: "prompt",
                message: "Now the tests.\nBoth files.",
                attachments: [{ path: "C:/repo/a.test.ts", name: "a.test.ts" }, { path: "C:/repo/b.test.ts" }]
            }, 2),
            entry({ category: "error", message: "model_not_found" }, 3),
            entry({ category: "notice", message: "The agent stopped working." }, 4)
        ]);

        expect(retrySend(turns)).toEqual({
            text: "Now the tests.\nBoth files.",
            files: [{ kind: "path", path: "C:/repo/a.test.ts", name: "a.test.ts" }, { kind: "path", path: "C:/repo/b.test.ts" }],
            again: true
        });
    });

    it("sends the message alone when it had no files", () => {

        expect(retrySend(turnsFrom([
            entry({ category: "prompt", message: "Hello." }, 0),
            entry({ category: "error", message: "fetch failed" }, 1)
        ]))).toEqual({ text: "Hello.", again: true });
    });

    it("sends your last message again even when the agent answered, thought or ran a tool before the error", () => {

        for (const done of [
            entry({ category: "message", message: "Reading the plan." }, 1),
            entry({ category: "reasoning", message: "Hmm." }, 1),
            entry({ category: "tool.start", message: "read", tool: "read", callId: "a" }, 1)
        ])
            expect(retrySend(turnsFrom([
                entry({ category: "prompt", message: "Do the wave." }, 0),
                done,
                entry({ category: "error", message: "fetch failed" }, 2)
            ])), done.category).toEqual({ text: "Do the wave.", again: true });
    });

    // An answer sent again would read as the instruction.
    it("sends the message, not your answer to the agent's question", () => {

        expect(retrySend(turnsFrom([
            entry({ category: "prompt", message: "Pick a store and build it." }, 0),
            entry({ category: "ask", message: "Which store?", askId: "ask-1" }, 1),
            entry({ category: "answer", message: "SQLite", askId: "ask-1" }, 2),
            entry({ category: "message", message: "Building it." }, 3),
            entry({ category: "error", message: "fetch failed" }, 4)
        ]))).toEqual({ text: "Pick a store and build it.", again: true });
    });

    it("sends \"continue\" when there is no message of yours before the error", () => {

        expect(retrySend(turnsFrom([entry({ category: "error", message: "fetch failed" }, 0)])))
            .toEqual({ text: RETRY_MESSAGE, again: false });
    });
});

describe("jumpTargets", () => {

    it("goes up to the nearest message scrolled past, and down to the first one below the top", () => {

        // Three of yours: two scrolled past, one 400px down.
        expect(jumpTargets([-900, -300, 400], 1000)).toEqual({ up: 1, down: 2 });
    });

    it("skips the message at the top - where the last jump left it - both ways", () => {

        expect(jumpTargets([-600, 3, 500], 1000)).toEqual({ up: 0, down: 2 });
        expect(jumpTargets([-600, -5, 500], 1000)).toEqual({ up: 0, down: 2 });
    });

    it("has no ↑ above your first message, and no ↓ below your last", () => {

        expect(jumpTargets([0, 500], 1000)).toEqual({ up: undefined, down: 1 });
        expect(jumpTargets([-800, -200], 1000)).toEqual({ up: 1, down: undefined });
    });

    it("has no ↓ once the thread cannot scroll further - the rest is on screen", () => {

        expect(jumpTargets([-800, 200], 0)).toEqual({ up: 0, down: undefined });
    });

    it("has neither with no message of yours", () => {

        expect(jumpTargets([], 1000)).toEqual({ up: undefined, down: undefined });
    });
});

describe("showsResume", () => {

    it("shows on a stopped chat that can take a message", () => {

        expect(showsResume(true, false, true, undefined)).toBe(true);
    });

    it("is off while the agent works, with no compose box, or when the chat was not stopped", () => {

        expect(showsResume(true, true, true, undefined)).toBe(false);
        expect(showsResume(true, false, false, undefined)).toBe(false);
        expect(showsResume(undefined, false, true, undefined)).toBe(false);
    });

    // Retry sends the same message; one button is enough.
    it("gives way to Retry on the last turn", () => {

        expect(showsResume(true, false, true, "turn-9")).toBe(false);
    });
});

/**
 * The status line at the foot of the thread: the turn starts at what
 * the person last sent, says what the agent is doing right now while
 * it runs, and how long it took once it is done.
 */
describe("turnStatus", () => {

    it("shows nothing when nothing has been sent", () => {

        expect(turnStatus([], true)).toBeUndefined();
        expect(turnStatus([entry({ category: "notice", message: "Session started" }, 0)], false)).toBeUndefined();
    });

    it("starts the clock at the prompt", () => {

        const status = turnStatus([
            entry({ category: "notice", message: "Session started", at: 5 }, 0),
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 1)
        ], true);

        expect(status).toEqual({ state: "working", since: 10, doing: "waiting for the model" });
    });

    it("restarts the clock at an answer, since answering sets the agent going again", () => {

        const status = turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "ask", message: "Which store?", askId: "ask-1", at: 20 }, 1),
            entry({ category: "answer", message: "SQLite", askId: "ask-1", at: 30 }, 2)
        ], true);

        expect(status).toEqual({ state: "working", since: 30, doing: "waiting for the model" });
    });

    it("names the tool call still open", () => {

        const status = turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "tool.start", message: "", tool: "Read", callId: "a", at: 11 }, 1),
            entry({ category: "tool.start", message: "", tool: "Grep", callId: "b", at: 12 }, 2),
            entry({ category: "tool.end", message: "", tool: "Grep", callId: "b", at: 13 }, 3)
        ], true);

        expect(status).toEqual({ state: "working", since: 10, doing: "running Read" });
    });

    it("is back to waiting once every call has ended", () => {

        const status = turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "tool.start", message: "", tool: "Read", at: 11 }, 1),
            entry({ category: "tool.end", message: "", tool: "Read", at: 13 }, 2)
        ], true);

        expect(status).toEqual({ state: "working", since: 10, doing: "waiting for the model" });
    });

    it("says writing or thinking while text is streaming", () => {

        const lines = [
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "delta", message: "So far", channel: "message", at: 11 }, 1)
        ];

        expect(turnStatus(lines, true)).toMatchObject({ doing: "writing" });

        expect(turnStatus([
            lines[0],
            entry({ category: "delta", message: "Hmm", channel: "reasoning", at: 11 }, 1)
        ], true)).toMatchObject({ doing: "thinking" });
    });

    it("stands in the first line when the prompt is not logged yet", () => {

        const status = turnStatus([entry({ category: "notice", message: "Session started", at: 5 }, 0)], true);

        expect(status).toMatchObject({ state: "working", since: 5 });
    });

    it("measures a finished turn from the prompt to its last line", () => {

        const status = turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "message", message: "Done.", at: 100 }, 1)
        ], false);

        expect(status).toEqual({ state: "finished", since: 10, until: 100 });
    });

    // Saved with the time they were written - an Undo a day later would make
    // the turn "Finished in 1d".
    it("ends a finished turn at the agent's last line, not at notes written after it", () => {

        const status = turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "tool.start", message: "", tool: "Write", callId: "a", at: 20 }, 1),
            entry({ category: "tool.end", message: "", tool: "Write", callId: "a", at: 30 }, 2),
            entry({ category: "message", message: "Done.", at: 100 }, 3),
            entry({ category: "notice", message: "Turn finished", at: 101 }, 4),
            entry({ category: "files.changed", message: "Changed 1 file: a.md", at: 102 }, 5),
            entry({ category: "files.kept", message: "Kept the changes.", at: 5000 }, 6),
            entry({ category: "files.undone", message: "Undone: a.md", at: 6000 }, 7),
            entry({ category: "notice", message: "Folders changed - the next message reopens the conversation with them.", at: 7000 }, 8),
            entry({ category: "chat", message: "Model changed from auto to default.", at: 8000 }, 9)
        ], false);

        expect(status).toEqual({ state: "finished", since: 10, until: 100 });
    });

    it("ends at the error when an error ended the turn", () => {

        expect(turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "error", message: "fetch failed", at: 40 }, 1),
            entry({ category: "notice", message: "The agent stopped working.", at: 900 }, 2)
        ], false)).toEqual({ state: "finished", since: 10, until: 40 });
    });

    it("is no time at all when the agent did nothing after the prompt", () => {

        expect(turnStatus([
            entry({ category: "prompt", message: "Draft it.", at: 10 }, 0),
            entry({ category: "notice", message: "Stopped.", at: 900 }, 1)
        ], false)).toEqual({ state: "finished", since: 10, until: 10 });
    });
});

describe("what a session cost", () => {

    it("adds charges up per unit, in the order the units first appeared", () => {

        const total = addSpend(
            addSpend([], [{ amount: 1.25, unit: "credits" }, { amount: 3, unit: "premium requests" }]),
            [{ amount: 3, unit: "premium requests" }, { amount: 0.5, unit: "USD" }]);

        expect(total).toEqual([
            { amount: 1.25, unit: "credits" },
            { amount: 6, unit: "premium requests" },
            { amount: 0.5, unit: "USD" }
        ]);
    });

    it("leaves the totals it was given alone", () => {

        const before = [{ amount: 1, unit: "USD" }];

        addSpend(before, [{ amount: 1, unit: "USD" }]);

        expect(before).toEqual([{ amount: 1, unit: "USD" }]);
    });

    it("prints dollars with a sign and everything else with its unit", () => {

        expect(spendText({ amount: 0.87, unit: "USD" })).toBe("$0.87");
        expect(spendText({ amount: 0.0012, unit: "USD" })).toBe("$0.0012");
        expect(spendText({ amount: 0, unit: "USD" })).toBe("$0.00");
        expect(spendText({ amount: 1.25, unit: "credits" })).toBe("1.25 credits");
        expect(spendText({ amount: 3, unit: "premium requests" })).toBe("3 premium requests");
        expect(spendText({ amount: 0.5, unit: "EUR" })).toBe("0.50 EUR");
    });
});

describe("what each model cost", () => {

    it("adds a model's charges and tokens to the entry already there", () => {

        const total = addModelSpend(
            [{ model: "opus", cost: [{ amount: 0.17, unit: "USD" }], inputTokens: 84000, outputTokens: 243 }],
            [
                { model: "opus", cost: [{ amount: 0.51, unit: "USD" }], inputTokens: 940709, outputTokens: 16776 },
                { model: "haiku", cost: [{ amount: 0.01, unit: "USD" }], inputTokens: 9000, outputTokens: 120 }
            ]);

        expect(total).toEqual([
            { model: "opus", cost: [{ amount: expect.closeTo(0.68, 6), unit: "USD" }], inputTokens: 1024709, outputTokens: 17019 },
            { model: "haiku", cost: [{ amount: 0.01, unit: "USD" }], inputTokens: 9000, outputTokens: 120 }
        ]);
    });

    it("keeps a model the runtime priced in two units apart from one it did not price", () => {

        const total = addModelSpend([], [
            { model: "gpt-5", cost: [{ amount: 1.25, unit: "credits" }, { amount: 3, unit: "premium requests" }] },
            { model: "gpt-5-mini", inputTokens: 500 }
        ]);

        expect(total).toEqual([
            { model: "gpt-5", cost: [{ amount: 1.25, unit: "credits" }, { amount: 3, unit: "premium requests" }] },
            { model: "gpt-5-mini", cost: undefined, inputTokens: 500 }
        ]);
    });

    it("leaves the totals it was given alone", () => {

        const before = [{ model: "opus", cost: [{ amount: 1, unit: "USD" }], inputTokens: 10 }];

        addModelSpend(before, [{ model: "opus", cost: [{ amount: 1, unit: "USD" }], inputTokens: 10 }]);

        expect(before).toEqual([{ model: "opus", cost: [{ amount: 1, unit: "USD" }], inputTokens: 10 }]);
    });
});


/*
 * The `sessionCost` flag hides money, not an allowance.
 *
 * Copilot bills a seat against a quota: credits and premium requests
 * say how much of it a call used, which is not a sum anybody is
 * charged. Hiding those along with the dollars would be wrong, so
 * the two are kept apart.
 */
describe("money against an allowance", () => {

    it("counts credits and premium requests as an allowance", () => {

        expect(isQuota({ amount: 1.25, unit: "credits" })).toBe(true);
        expect(isQuota({ amount: 3, unit: "premium requests" })).toBe(true);
    });

    it("counts every currency as money, not just dollars", () => {

        expect(isQuota({ amount: 0.51, unit: "USD" })).toBe(false);
        expect(isQuota({ amount: 0.51, unit: "EUR" })).toBe(false);
    });

    it("leaves the allowance behind when the money is dropped from a mixed total", () => {

        const mixed = [{ amount: 1.25, unit: "credits" }, { amount: 0.51, unit: "USD" }];

        expect(mixed.filter(isQuota)).toEqual([{ amount: 1.25, unit: "credits" }]);
    });
});

/**
 * The compose box's model button: `auto` first, the model in effect kept
 * even when the catalogue lacks it, one entry per id, and Copilot's
 * premium request multiplier beside the name.
 */
describe("modelOptionsOf", () => {

    const current = { provider: "ghcp", model: "gpt-4.1", providerFrom: "settings", modelFrom: "settings" } as const;

    it("puts auto first and the model in effect next, once each", () => {

        const options = modelOptionsOf(current, {
            providers: ["ghcp"],
            models: { ghcp: [{ id: "auto" }, { id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 }, { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", multiplier: 1 }] }
        });

        expect(options.map(option => option.id)).toEqual(["auto", "gpt-4.1", "claude-sonnet-4.5"]);
    });

    it("shows the multiplier beside the name, free for 0, and nothing when there is none", () => {

        const options = modelOptionsOf(current, {
            providers: ["ghcp"],
            models: { ghcp: [{ id: "gpt-4.1", name: "GPT-4.1", multiplier: 0 }, { id: "claude-haiku-4.5", name: "Claude Haiku 4.5", multiplier: 0.33 }] }
        });

        expect(options.find(option => option.id === "gpt-4.1")).toMatchObject({ name: "GPT-4.1", costMultiplier: "free" });
        expect(options.find(option => option.id === "claude-haiku-4.5")?.costMultiplier).toBe("0.33x");
        expect(options.find(option => option.id === "auto")?.costMultiplier).toBeUndefined();
    });

    it("keeps a model in effect the catalogue does not carry, named by its id", () => {

        const options = modelOptionsOf({ ...current, model: "my-model" }, { providers: ["ghcp"] });

        expect(options).toEqual([{ id: "auto", name: "auto" }, { id: "my-model", name: "my-model" }]);
    });

    // A pick saved as the alias `opus`, where the list holds the exact id.
    it("shows a model saved under another name on its listed row, not as a second entry", () => {

        const choice = {
            providers: ["claude"],
            models: { claude: [{ id: "claude-opus-5-5", name: "Opus 5.5", aliases: ["default", "opus"], efforts: ["low", "high"] }] }
        };
        const opus = { provider: "claude", model: "opus", providerFrom: "pick", modelFrom: "pick" } as const;

        expect(modelOptionsOf(opus, choice).map(option => option.id)).toEqual(["auto", "claude-opus-5-5"]);
        expect(listedModelOf(opus, choice)?.id).toBe("claude-opus-5-5");
        expect(effortChoiceOf(opus, choice)?.options.map(option => option.id)).toEqual(["default", "low", "high"]);
        expect(listedModelOf({ ...opus, model: "sonnet" }, choice)).toBeUndefined();
    });
});

/*
 * The compose box's mode button: shown only for a runtime that has modes
 * (Kiro v3), on the person's pick for that runtime or the agent's default.
 */
describe("modeChoiceOf", () => {

    const current = { provider: "kiro-cli", model: "auto", providerFrom: "pick", modelFrom: "default" } as const;
    const kiro = { current: "vibe", modes: [{ id: "vibe", name: "Default" }, { id: "spec", name: "Spec", description: "Structured feature development" }] };

    it("lists the runtime's modes and starts on its default", () => {

        const choice = modeChoiceOf(current, { providers: ["kiro-cli"], modes: { "kiro-cli": kiro } });

        expect(choice).toEqual({
            options: [
                { id: "vibe", name: "Default" },
                { id: "spec", name: "Spec", description: "Structured feature development" }
            ],
            value: "vibe"
        });
    });

    it("shows the picked mode when the pick is for this runtime", () => {

        const choice = modeChoiceOf(current, {
            providers: ["kiro-cli"],
            modes: { "kiro-cli": kiro },
            pick: { provider: "kiro-cli", mode: "spec" }
        });

        expect(choice?.value).toBe("spec");
    });

    it("is nothing for a runtime with no modes", () => {

        expect(modeChoiceOf({ ...current, provider: "ghcp" }, { providers: ["ghcp"], modes: { "kiro-cli": kiro } })).toBeUndefined();
    });
});

describe("pickWith", () => {

    const current = { provider: "kiro-cli", model: "auto", providerFrom: "pick", modelFrom: "pick" } as const;

    it("keeps a picked model when the mode changes, and the other way round", () => {

        const choice = { providers: ["kiro-cli"], pick: { provider: "kiro-cli", model: "claude-haiku-4.5", mode: "plan" } };

        expect(pickWith(current, choice, { mode: "spec" }))
            .toEqual({ provider: "kiro-cli", model: "claude-haiku-4.5", mode: "spec" });
        expect(pickWith(current, choice, { model: "auto" }))
            .toEqual({ provider: "kiro-cli", model: "auto", mode: "plan" });
    });

    it("carries nothing over from a pick for another runtime", () => {

        const choice = { providers: ["ghcp", "kiro-cli"], pick: { provider: "ghcp", model: "gpt-5" } };

        expect(pickWith(current, choice, { mode: "spec" })).toEqual({ provider: "kiro-cli", mode: "spec" });
    });
});

/*
 * Account usage read back from a stored log. Any shape but rows -
 * plan and limits, say - would crash the spec panel if drawn.
 */
describe("isAccountUsage", () => {

    it("takes the rows shape", () => {

        expect(isAccountUsage({ at: 1, rows: [{ key: "Plan", value: "KIRO PRO" }] })).toBe(true);
        expect(isAccountUsage({ rows: [] })).toBe(true);
    });

    it("leaves out any other shape", () => {

        expect(isAccountUsage({ plan: "KIRO PRO", resets: "2026-10-01", limits: [{ name: "Credits", used: 1, limit: 2 }] }))
            .toBe(false);
        expect(isAccountUsage({ rows: [{ key: "Plan", value: 5 }] })).toBe(false);
        expect(isAccountUsage(undefined)).toBe(false);
        expect(isAccountUsage("text")).toBe(false);
    });
});

describe("shortPaths", () => {

    it("decodes, merges both spellings, and drops the shared folders but not a dot folder", () => {

        const items = shortPaths([
            { name: "/c%3A/workspace/repo/.kiro/steering/core/tech.md", tokens: 5000 },
            { name: "/c:/workspace/repo/.kiro/skills/git-sync/SKILL.md", tokens: 0 },
            { name: "/c:/workspace/repo/.kiro/steering/core/tech.md", tokens: 0 },
            { name: "README.md", tokens: 10 }
        ]);

        // A file keeps the full path it is opened by; a name that is not a full path has none.
        expect(items).toEqual([
            { name: ".kiro/steering/core/tech.md", tokens: 5000, path: "c:/workspace/repo/.kiro/steering/core/tech.md" },
            { name: ".kiro/skills/git-sync/SKILL.md", tokens: 0, path: "c:/workspace/repo/.kiro/skills/git-sync/SKILL.md" },
            { name: "README.md", tokens: 10 }
        ]);
    });

    it("keeps a name that is not a path, and a lone % in it, as it is", () => {

        expect(shortPaths([{ name: "knowledge", tokens: 5 }, { name: "50% rule", tokens: 1 }]).map(item => item.name))
            .toEqual(["knowledge", "50% rule"]);
    });
});

describe("contextSegments", () => {

    it("gives a share-only window its share, and parts split by their tokens", () => {

        const meter = contextSegments({
            used: 12, size: 100, percentOnly: true,
            parts: [
                {
                    name: "Context files", tokens: 10000, items: [
                        { name: "/c:/w/r/.kiro/steering/a.md", tokens: 10000 },
                        { name: "/c:/w/r/.kiro/steering/b.md", tokens: 0 },
                        { name: "AGENTS.md", tokens: 0, note: "not loaded" }
                    ]
                },
                { name: "Kiro responses", tokens: 42000 }
            ]
        });

        expect(meter.usedPercent).toBe(12);
        expect(meter.segments.map(one => [one.label, one.tokens, one.items?.map(item => item.label)])).toEqual([
            ["Context files", 10000, [".kiro/steering/a.md"]],
            ["Found, not loaded", 0, [".kiro/steering/b.md", "AGENTS.md"]],
            ["Kiro responses", 42000, undefined],
            ["Free", 0, undefined]
        ]);
        expect(meter.usedTokens).toBe(52000);
    });

    it("makes each file row a link that opens the file by its full path, and leaves other rows as text", () => {

        const context = {
            used: 12, size: 100, percentOnly: true,
            parts: [
                {
                    name: "Context files", tokens: 10000, items: [
                        { name: "/c:/w/r/.kiro/steering/a.md", tokens: 10000 },
                        { name: "AGENTS.md", tokens: 0, note: "not loaded" },
                        { name: "knowledge", tokens: 5 }
                    ]
                }
            ]
        };

        const opened: string[] = [];

        const rows = contextSegments(context, path => opened.push(path)).segments.flatMap(one => one.items ?? []);

        for (const row of rows)
            row.onClick?.();

        expect(opened).toEqual(["c:/w/r/.kiro/steering/a.md", "AGENTS.md"]);
        expect(rows.map(row => [row.label, row.title])).toEqual([
            [".kiro/steering/a.md", "c:/w/r/.kiro/steering/a.md"],
            ["knowledge", undefined],
            ["AGENTS.md", "AGENTS.md"]
        ]);

        // With nothing to open them, no row is a link.
        expect(contextSegments(context).segments.flatMap(one => one.items ?? []).some(row => row.onClick)).toBe(false);
    });

    it("draws a share with no parts as one Used slice", () => {

        const meter = contextSegments({ used: 30, size: 100, percentOnly: true });

        expect(meter.usedPercent).toBe(30);
        expect(meter.segments.map(one => one.label)).toEqual(["Used", "Free"]);
        expect(meter.usedTokens).toBe(0);
    });

    it("keeps a window with a size in tokens, with the free space", () => {

        const meter = contextSegments({ used: 400, size: 1000 });

        expect(meter.usedPercent).toBeUndefined();
        expect(meter.segments.map(one => [one.label, one.tokens])).toEqual([["Used", 400], ["Free", 600]]);
        expect(meter.usedTokens).toBe(400);
    });

    it("leaves a 0-token tool among the tools", () => {

        const meter = contextSegments({ used: 5, size: 100, parts: [{ name: "Tools", tokens: 5, items: [{ name: "grep", tokens: 0 }] }] });

        expect(meter.segments[0].items?.map(item => item.label)).toEqual(["grep"]);
    });
});

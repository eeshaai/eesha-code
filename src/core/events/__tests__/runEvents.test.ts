import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import { EventWriter } from "../EventWriter";
import { runEventsPath, specEventsPath, stamp } from "../eventFile";
import { currentEvents, lastSession, lineFrom, parseEvents, sessionToContinue, supersededSpend } from "../runEvents";

/**
 * The events file: a line survives the round trip unchanged, running an
 * owner again supersedes what it wrote before without deleting it, and
 * a file whose last line was cut off mid-write still reads.
 */

const made: string[] = [];

function file(): string {

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-events-"));

    made.push(dir);

    return path.join(dir, "run.jsonl");
}

afterEach(() => {

    for (const dir of made.splice(0))
        fs.rmSync(dir, { recursive: true, force: true });
});

describe("the events file", () => {

    it("writes a header once, and not again on a later open", () => {

        const at = file();

        new EventWriter(at, "run-1").log({ ownerId: "build", at: 1, stream: "stdout", text: "one" });
        new EventWriter(at, "run-1").log({ ownerId: "build", at: 2, stream: "stdout", text: "two" });

        const opens = parseEvents(fs.readFileSync(at, "utf8")).filter(event => event.kind === "open");

        expect(opens).toHaveLength(1);
        expect(opens[0].runId).toBe("run-1");
        expect(opens[0].v).toBe(1);
    });

    it("carries a line's structured half through the round trip", () => {

        const writer = new EventWriter(file(), "run-1");

        writer.log({
            ownerId: "requirements",
            at: 100,
            stream: "system",
            text: "Read done in 42ms",
            kind: "tool.end",
            tool: "Read",
            callId: "tu_01",
            ok: true,
            ms: 42,
            detail: "requirements.md"
        });

        const line = lineFrom(writer.read().find(event => event.kind === "tool.end")!)!;

        expect(line).toEqual({
            ownerId: "requirements",
            at: 100,
            stream: "system",
            text: "Read done in 42ms",
            kind: "tool.end",
            tool: "Read",
            callId: "tu_01",
            ok: true,
            ms: 42,
            detail: "requirements.md"
        });
    });

    // A delta carries the answer so far, so writing them would put the
    // same paragraph in the file many times.
    it("never writes a streaming delta", () => {

        const writer = new EventWriter(file(), "run-1");

        writer.log({ ownerId: "one", at: 1, stream: "stdout", text: "half a sen", kind: "delta", ephemeral: true });
        writer.log({ ownerId: "one", at: 2, stream: "stdout", text: "half a sentence", kind: "message" });

        expect(writer.read().filter(event => event.kind === "delta")).toEqual([]);
        expect(writer.read().filter(event => event.kind === "message")).toHaveLength(1);
    });

    it("reads a file whose last line was cut off mid-write", () => {

        const at = file();
        const writer = new EventWriter(at, "run-1");

        writer.log({ ownerId: "one", at: 1, stream: "stdout", text: "complete" });

        fs.appendFileSync(at, "{\"at\":2,\"text\":\"half a li");

        expect(writer.read().map(event => event.text)).toEqual([undefined, "complete"]);
    });

    it("skips a line that is not JSON at all rather than giving up on the file", () => {

        const at = file();
        const writer = new EventWriter(at, "run-1");

        writer.log({ ownerId: "one", at: 1, stream: "stdout", text: "before" });
        fs.appendFileSync(at, "not json\n");
        writer.log({ ownerId: "one", at: 3, stream: "stdout", text: "after" });

        expect(writer.read().map(event => event.text)).toEqual([undefined, "before", "after"]);
    });

    it("does not fail when there is no file yet", () => {

        expect(new EventWriter(path.join(os.tmpdir(), "eesha-nothing-here", "x.jsonl"), "run-1").read()).toEqual([]);
    });

    it("reports a write it could not make, instead of throwing into the run", () => {

        const failures: unknown[] = [];

        // A directory where the file should be: the append cannot succeed
        // and must not take the run down with it.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-events-"));

        made.push(dir);

        const taken = path.join(dir, "run.jsonl");

        fs.mkdirSync(taken);

        new EventWriter(taken, "run-1", error => failures.push(error))
            .log({ ownerId: "one", at: 1, stream: "stdout", text: "x" });

        expect(failures).toHaveLength(1);
    });
});

// Running a phase again appends a `restart` marker rather than
// rewriting the file, and the reader drops what came before it.
describe("running an owner again", () => {

    const lines = [
        { ownerId: "design", at: 1, stream: "stdout" as const, text: "first draft" },
        { ownerId: "tasks", at: 2, stream: "stdout" as const, text: "another phase" },
        { ownerId: "design", at: 4, stream: "stdout" as const, text: "second draft" }
    ];

    function written(): EventWriter {

        const writer = new EventWriter(file(), "run-1");

        writer.log(lines[0]);
        writer.log(lines[1]);
        writer.control("restart", "design");
        writer.log(lines[2]);

        return writer;
    }

    it("drops what that owner wrote before the restart", () => {

        const texts = currentEvents(written().read()).map(event => event.text);

        expect(texts).not.toContain("first draft");
        expect(texts).toContain("second draft");
    });

    it("leaves every other owner alone", () => {

        expect(currentEvents(written().read()).map(event => event.text)).toContain("another phase");
    });

    it("keeps the earlier draft on disk, for anyone who wants to read it", () => {

        expect(written().read().map(event => event.text)).toContain("first draft");
    });

    it("drops the marker itself - it is the file's punctuation, not a line", () => {

        expect(currentEvents(written().read()).some(event => event.kind === "restart")).toBe(false);
    });
});

// A session id only means something to the provider that issued it.
describe("what the hidden drafts charged", () => {

    it("adds up the bills a restart or a clear took off the screen, per owner", () => {

        const writer = new EventWriter(file(), "run-1");

        writer.log({ ownerId: "design", at: 1, stream: "system", text: "bill", cost: [{ amount: 0.10, unit: "USD" }] });
        writer.log({ ownerId: "tasks", at: 2, stream: "system", text: "bill", cost: [{ amount: 2, unit: "credits" }] });
        writer.control("restart", "design");
        writer.log({ ownerId: "design", at: 3, stream: "system", text: "bill", cost: [{ amount: 0.20, unit: "USD" }] });
        writer.control("cleared", "design");
        writer.log({ ownerId: "design", at: 4, stream: "system", text: "bill", cost: [{ amount: 0.40, unit: "USD" }] });

        const spent = supersededSpend(writer.read());

        // The two drafts before the cuts; the one on screen is not here.
        expect(spent.get("design")?.spent).toEqual([{ amount: expect.closeTo(0.30, 6), unit: "USD" }]);

        // Nothing of tasks was hidden.
        expect(spent.has("tasks")).toBe(false);
    });

    it("carries the hidden drafts' split by model too", () => {

        const writer = new EventWriter(file(), "run-1");

        writer.log({
            ownerId: "design", at: 1, stream: "system", text: "bill",
            cost: [{ amount: 0.10, unit: "USD" }],
            models: [{ model: "opus", cost: [{ amount: 0.10, unit: "USD" }], inputTokens: 500, outputTokens: 20 }]
        });

        writer.control("restart", "design");
        writer.log({ ownerId: "design", at: 2, stream: "stdout", text: "second draft" });

        expect(supersededSpend(writer.read()).get("design")?.models).toEqual([
            { model: "opus", cost: [{ amount: 0.10, unit: "USD" }], inputTokens: 500, outputTokens: 20 }
        ]);
    });

    it("is empty when nothing hidden was billed", () => {

        const writer = new EventWriter(file(), "run-1");

        writer.log({ ownerId: "design", at: 1, stream: "stdout", text: "first draft" });
        writer.control("restart", "design");
        writer.log({ ownerId: "design", at: 2, stream: "system", text: "bill", cost: [{ amount: 0.5, unit: "USD" }] });

        expect(supersededSpend(writer.read()).size).toBe(0);
    });
});

describe("the conversation to carry on", () => {

    function writerWith(sessions: { owner: string; id: string; provider?: string }[]): EventWriter {

        const writer = new EventWriter(file(), "spec");

        for (const one of sessions)
            writer.session(one.owner, one.id, one.provider);

        return writer;
    }

    it("is the newest one for that owner", () => {

        const writer = writerWith([
            { owner: "design", id: "old", provider: "claude" },
            { owner: "design", id: "new", provider: "claude" }
        ]);

        expect(sessionToContinue(writer.read(), "design", "claude")).toBe("new");
    });

    it("is not another owner's", () => {

        const writer = writerWith([{ owner: "requirements", id: "theirs", provider: "claude" }]);

        expect(sessionToContinue(writer.read(), "design", "claude")).toBeUndefined();
    });

    it("is nothing when the runtime changed under it", () => {

        const writer = writerWith([{ owner: "design", id: "claude-one", provider: "claude" }]);

        expect(sessionToContinue(writer.read(), "design", "ghcp")).toBeUndefined();
    });

    it("is nothing once somebody cleared it", () => {

        const writer = writerWith([{ owner: "design", id: "spent", provider: "claude" }]);

        writer.control("cleared", "design");

        expect(sessionToContinue(writer.read(), "design", "claude")).toBeUndefined();
    });

    // A clear only affects sessions written before it.
    it("is the one started after the clear", () => {

        const writer = writerWith([{ owner: "design", id: "spent", provider: "claude" }]);

        writer.control("cleared", "design");
        writer.session("design", "fresh", "claude");

        expect(sessionToContinue(writer.read(), "design", "claude")).toBe("fresh");
    });

    it("leaves another owner's conversation alone", () => {

        const writer = writerWith([{ owner: "requirements", id: "theirs", provider: "claude" }]);

        writer.control("cleared", "design");

        expect(sessionToContinue(writer.read(), "requirements", "claude")).toBe("theirs");
    });

    it("is nothing at all for a phase that has never run", () => {

        expect(sessionToContinue([], "design", "claude")).toBeUndefined();
    });

    /*
     * The record itself, for a caller that has to know *why* it will
     * not be continued - the runtime moved - or what model it opened on.
     */
    it("is handed back whole, runtime and model included, whoever asks", () => {

        const writer = new EventWriter(file(), "spec");

        writer.session("design", "old", "ghcp", "gpt-5");
        writer.session("design", "new", "ghcp", "gpt-5-mini");

        expect(lastSession(writer.read(), "design")).toEqual({ sessionId: "new", provider: "ghcp", model: "gpt-5-mini" });
        expect(lastSession(writer.read(), "tasks")).toBeUndefined();
    });

    it("is not handed back once cleared, and carries no model when none was recorded", () => {

        const writer = writerWith([{ owner: "design", id: "bare", provider: "claude" }]);

        expect(lastSession(writer.read(), "design")).toEqual({ sessionId: "bare", provider: "claude", model: undefined });

        writer.control("cleared", "design");

        expect(lastSession(writer.read(), "design")).toBeUndefined();
    });
});

describe("where a file lives", () => {

    it("names a run so the folder sorts into the order things happened", () => {

        expect(stamp(Date.UTC(2026, 8, 5, 20, 14, 3) + new Date().getTimezoneOffset() * 60_000))
            .toBe("2026-09-05T20-14-03");
    });

    it("gives a spec one file for its whole life", () => {

        expect(specEventsPath("D:/repo", "demo").endsWith(path.join("specs", "demo.jsonl"))).toBe(true);
    });

    it("gives a run one file per execution", () => {

        const at = runEventsPath("D:/repo", "a1b2c3d4-e5f6", 0);

        expect(path.dirname(at).endsWith("runs")).toBe(true);
        expect(path.basename(at).endsWith("-a1b2c3d4.jsonl")).toBe(true);
    });

    it("cannot be walked out of the events folder by a spec's name", () => {

        const at = specEventsPath("D:/repo", "../../etc/passwd");

        expect(path.relative(path.dirname(path.dirname(at)), at).startsWith("..")).toBe(false);
    });

    it("separates two workspaces that slug to the same text", () => {

        expect(specEventsPath("C:/work/a-b", "x")).not.toBe(specEventsPath("C:/work/a/b", "x"));
    });
});

describe("going back to an earlier message", () => {

    it("a rewound record keeps the lines before it on screen, but ends the conversation", () => {

        const events = [
            { kind: "session", ownerId: "chat", at: 1, sessionId: "s1", provider: "ghcp" },
            { kind: "prompt", ownerId: "chat", at: 2, text: "one\n" },
            { kind: "rewound", ownerId: "chat", at: 3 }
        ];

        expect(currentEvents(events).map(event => event.kind)).toEqual(["session", "prompt", "rewound"]);
        expect(lastSession(events, "chat")).toBeUndefined();
        expect(lineFrom(events[2])).toBeUndefined();

        // A conversation after it is carried on as usual.
        expect(lastSession([...events, { kind: "session", ownerId: "chat", at: 4, sessionId: "s2" }], "chat"))
            .toEqual({ sessionId: "s2" });
    });

    it("rewrite leaves only the records given, and later lines append after them", () => {

        const target = file();
        const writer = new EventWriter(target, "chat:1");

        writer.log({ ownerId: "chat", at: 1, stream: "stdout", text: "one\n", kind: "prompt" });
        writer.log({ ownerId: "chat", at: 2, stream: "stdout", text: "two\n", kind: "prompt" });

        const kept = writer.read().slice(0, 2);

        expect(writer.rewrite([...kept, { kind: "rewound", ownerId: "chat", at: 3 }])).toBe(true);

        writer.log({ ownerId: "chat", at: 4, stream: "system", text: "Went back.\n", kind: "notice" });

        expect(parseEvents(fs.readFileSync(target, "utf8")).map(event => event.kind)).toEqual(["open", "prompt", "rewound", "notice"]);
    });

    it("rewrite says false, and throws nothing, when the file cannot be written", () => {

        const blocked = file();

        // A folder where the file should be.
        fs.mkdirSync(blocked);

        const failures: unknown[] = [];

        expect(new EventWriter(blocked, "chat:1", error => failures.push(error)).rewrite([])).toBe(false);
        expect(failures).toHaveLength(1);
    });
});

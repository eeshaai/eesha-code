import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { AnswerBook, samePath } from "../answers";

/*
 * The answers saved from permission cards: one file, all
 * three scopes, read again on every question.
 */

function book(): { book: AnswerBook; file: string } {

    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "eesha-answers-")), "permissions.json");

    let id = 0;

    return { book: new AnswerBook(file, () => 1000, () => `id-${++id}`), file };
}

describe("AnswerBook", () => {

    it("saves an answer with an id and a time, and lists it", () => {

        const { book: answers, file } = book();

        const saved = answers.add({ kind: "command", pattern: "npm run build *", scope: "session", chatId: "chat-1", agent: "claude" });

        expect(saved).toEqual({ id: "id-1", kind: "command", pattern: "npm run build *", scope: "session", chatId: "chat-1", savedAt: 1000, agent: "claude" });
        expect(answers.list()).toEqual([saved]);
        expect(JSON.parse(fs.readFileSync(file, "utf8")).version).toBe(1);
    });

    it("never saves a bare * or nothing", () => {

        const { book: answers } = book();

        expect(answers.add({ kind: "command", pattern: "*", scope: "always", agent: "claude" })).toBeUndefined();
        expect(answers.add({ kind: "command", pattern: "  ", scope: "always", agent: "claude" })).toBeUndefined();
        expect(answers.list()).toEqual([]);
    });

    it("keeps one copy of the same answer", () => {

        const { book: answers } = book();

        const first = answers.add({ kind: "command", pattern: "git status", scope: "always", agent: "claude" });
        const again = answers.add({ kind: "command", pattern: "git status", scope: "always", agent: "ghcp" });

        expect(again).toEqual(first);
        expect(answers.list()).toHaveLength(1);
    });

    it("applies a chat's own session answers, its folder's, and every Always one - from any agent", () => {

        const { book: answers } = book();

        const folder = path.resolve("/work/repo");

        answers.add({ kind: "command", pattern: "a", scope: "session", chatId: "chat-1", agent: "claude" });
        answers.add({ kind: "command", pattern: "b", scope: "session", chatId: "chat-2", agent: "claude" });
        answers.add({ kind: "command", pattern: "c", scope: "folder", folder, agent: "ghcp" });
        answers.add({ kind: "command", pattern: "d", scope: "folder", folder: path.resolve("/work/other"), agent: "claude" });
        answers.add({ kind: "command", pattern: "e", scope: "always", agent: "kiro" });

        expect(answers.applying("chat-1", folder).map(answer => answer.pattern)).toEqual(["a", "c", "e"]);
    });

    it("removes one answer, and says when it was already gone", () => {

        const { book: answers } = book();

        const saved = answers.add({ kind: "tool", pattern: "Run analysis", scope: "always", agent: "kiro" })!;

        expect(answers.remove(saved.id)).toBe(true);
        expect(answers.remove(saved.id)).toBe(false);
        expect(answers.list()).toEqual([]);
    });

    it("drops a deleted chat's session answers and copies them to a chat's copy", () => {

        const { book: answers } = book();

        answers.add({ kind: "command", pattern: "a", scope: "session", chatId: "chat-1", agent: "claude" });
        answers.add({ kind: "command", pattern: "b", scope: "always", agent: "claude" });

        answers.copyChat("chat-1", "chat-1b");

        expect(answers.applying("chat-1b", "").map(answer => answer.pattern)).toEqual(["b", "a"]);

        answers.removeChat("chat-1");

        expect(answers.list().map(answer => `${answer.pattern}:${answer.chatId ?? ""}`)).toEqual(["b:", "a:chat-1b"]);
    });

    it("reads a broken file as none, and leaves out rows of the wrong shape", () => {

        const { book: answers, file } = book();

        fs.writeFileSync(file, "{ not json");

        expect(answers.list()).toEqual([]);

        fs.writeFileSync(file, JSON.stringify({
            version: 1,
            answers: [
                { id: "1", kind: "command", pattern: "*", scope: "always", savedAt: 1, agent: "x" },
                { id: "2", kind: "command", pattern: "ls", scope: "session", savedAt: 1, agent: "x" },
                { id: "3", kind: "nope", pattern: "ls", scope: "always", savedAt: 1, agent: "x" },
                { id: "4", kind: "command", pattern: "ls", scope: "always", savedAt: 1, agent: "x" }
            ]
        }));

        expect(answers.list().map(answer => answer.id)).toEqual(["4"]);
    });
});

describe("AnswerBook.onChange", () => {

    it("is called after each change it writes, and not when nothing changed", () => {

        const { book: answers } = book();

        let calls = 0;

        answers.onChange(() => calls++);

        answers.add({ kind: "command", pattern: "git status", scope: "always", agent: "claude" });
        expect(calls).toBe(1);

        // The same answer again, a bare *, and an id that is not there write nothing.
        answers.add({ kind: "command", pattern: "git status", scope: "always", agent: "ghcp" });
        answers.add({ kind: "command", pattern: "*", scope: "always", agent: "claude" });
        answers.remove("no-such-id");
        answers.removeChat("no-such-chat");
        answers.copyChat("no-such-chat", "copy");
        expect(calls).toBe(1);

        answers.add({ kind: "command", pattern: "npm *", scope: "session", chatId: "chat-1", agent: "claude" });
        answers.copyChat("chat-1", "chat-2");
        answers.removeChat("chat-2");
        answers.remove("id-1");
        expect(calls).toBe(5);
    });

    it("stops when told, and a listener that throws neither undoes the save nor stops the others", () => {

        const { book: answers } = book();

        let calls = 0;

        answers.onChange(() => { throw new Error("broken listener"); });
        const stop = answers.onChange(() => calls++);

        expect(answers.add({ kind: "command", pattern: "git status", scope: "always", agent: "claude" })).toBeDefined();
        expect(answers.list()).toHaveLength(1);
        expect(calls).toBe(1);

        stop();

        answers.add({ kind: "command", pattern: "git diff", scope: "always", agent: "claude" });
        expect(calls).toBe(1);
    });
});

describe("samePath", () => {

    it("ignores case on Windows only", () => {

        expect(samePath("C:\\Repo", "c:\\repo", true)).toBe(true);
        expect(samePath("/Repo", "/repo", false)).toBe(false);
        expect(samePath("", "")).toBe(true);
        expect(samePath("", "/x")).toBe(false);
    });
});

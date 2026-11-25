import * as fs from "fs";
import * as path from "path";

import type { AnswerKind, AnswerScope, SavedAnswer } from "../../models/permissionCard";

/*
 * The answers a person saved from permission cards. One
 * file holds all three scopes: "This session" answers under their chat's
 * id, "This folder" ones under the folder, and "Always" ones. Nothing in
 * a repository is ever read.
 *
 * Read from the file on every question, so a removal in another tab, or
 * an edit by hand, holds at once. The file is small and a question waits
 * on a person anyway.
 */

const KINDS: readonly AnswerKind[] = ["command", "edit", "read", "mcp", "web", "tool"];

const SCOPES: readonly AnswerScope[] = ["session", "folder", "always"];

/** What is saved for a new answer; the book adds the id and the time. */
export type NewAnswer = Omit<SavedAnswer, "id" | "savedAt">;

export class AnswerBook {

    /**
     * @param file  Where the answers live - `~/.eesha/permissions.json`.
     * @param now   Injected so a test can pin the times it asserts on.
     * @param newId The same for ids.
     */
    constructor(
        private readonly file: string,
        private readonly now: () => number = () => Date.now(),
        private readonly newId: () => string = () => globalThis.crypto.randomUUID()
    ) { }

    private readonly listeners = new Set<() => void>();

    /**
     * Called after every change this book writes - an answer saved from a
     * card, removed from the list, or a chat's answers dropped or copied.
     * Not for a change made by hand in the file. Returns a call that stops it.
     */
    onChange(listener: () => void): () => void {

        this.listeners.add(listener);

        return () => this.listeners.delete(listener);
    }

    /** Every saved answer. A broken file reads as none, and is not written over until an answer is saved. */
    list(): SavedAnswer[] {

        let parsed: unknown;

        try {

            parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));

        } catch {

            return [];
        }

        const answers = (parsed as { answers?: unknown } | undefined)?.answers;

        return Array.isArray(answers) ? answers.filter(isSavedAnswer) : [];
    }

    /**
     * The answers that hold for one chat: its own session answers, the
     * folder answers for its working folder, and every Always answer.
     */
    applying(chatId: string, folder: string): SavedAnswer[] {

        return this.list().filter(answer =>
            answer.scope === "always"
            || (answer.scope === "session" && answer.chatId === chatId)
            || (answer.scope === "folder" && answer.folder !== undefined && samePath(answer.folder, folder)));
    }

    /**
     * Saves one answer. The same answer already saved is kept as it is, so
     * a list never fills with copies. A bare `*`, or nothing, is never
     * saved - it would allow every command.
     */
    add(answer: NewAnswer): SavedAnswer | undefined {

        const pattern = answer.pattern.trim();

        if (!pattern || pattern === "*")
            return undefined;

        const all = this.list();

        const known = all.find(one =>
            one.kind === answer.kind && one.pattern === pattern && one.scope === answer.scope
            && (one.chatId ?? "") === (answer.chatId ?? "")
            && samePath(one.folder ?? "", answer.folder ?? ""));

        if (known)
            return known;

        const saved: SavedAnswer = {
            id: this.newId(),
            kind: answer.kind,
            pattern,
            scope: answer.scope,
            ...(answer.scope === "session" && answer.chatId ? { chatId: answer.chatId } : {}),
            ...(answer.scope === "folder" && answer.folder ? { folder: answer.folder } : {}),
            savedAt: this.now(),
            agent: answer.agent
        };

        this.write([...all, saved]);

        return saved;
    }

    /** Removes one answer by id. False when there was none. */
    remove(id: string): boolean {

        const all = this.list();

        const kept = all.filter(answer => answer.id !== id);

        if (kept.length === all.length)
            return false;

        this.write(kept);

        return true;
    }

    /** A chat was deleted: its session answers go with it. */
    removeChat(chatId: string): void {

        const all = this.list();

        const kept = all.filter(answer => !(answer.scope === "session" && answer.chatId === chatId));

        if (kept.length !== all.length)
            this.write(kept);
    }

    /** Going back copied a chat: its session answers hold in the copy too. */
    copyChat(fromId: string, toId: string): void {

        const all = this.list();

        const copies = all
            .filter(answer => answer.scope === "session" && answer.chatId === fromId)
            .map(answer => ({ ...answer, id: this.newId(), chatId: toId }));

        if (copies.length)
            this.write([...all, ...copies]);
    }

    /** The whole file again, through a temporary file so a crash never leaves half of it. */
    private write(answers: SavedAnswer[]): void {

        fs.mkdirSync(path.dirname(this.file), { recursive: true });

        const temporary = `${this.file}.${process.pid}.tmp`;

        fs.writeFileSync(temporary, `${JSON.stringify({ version: 1, answers }, null, 2)}\n`);
        fs.renameSync(temporary, this.file);

        // A listener that fails must not undo the save or stop the others.
        for (const listener of [...this.listeners]) {

            try {

                listener();

            } catch {

                // Nothing to do: the answer is saved either way.
            }
        }
    }
}

function isSavedAnswer(value: unknown): value is SavedAnswer {

    const one = value as Partial<SavedAnswer> | undefined;

    return !!one
        && typeof one.id === "string"
        && KINDS.includes(one.kind as AnswerKind)
        && typeof one.pattern === "string" && one.pattern.trim() !== "" && one.pattern.trim() !== "*"
        && SCOPES.includes(one.scope as AnswerScope)
        && (one.scope !== "session" || typeof one.chatId === "string")
        && (one.scope !== "folder" || typeof one.folder === "string")
        && typeof one.savedAt === "number"
        && typeof one.agent === "string";
}

/** Two paths as one place - without case on Windows, where `C:\Repo` and `c:\repo` are the same folder. */
export function samePath(one: string, other: string, isWindows: boolean = process.platform === "win32"): boolean {

    if (!one || !other)
        return one === other;

    const a = path.resolve(one);
    const b = path.resolve(other);

    return isWindows ? a.toLowerCase() === b.toLowerCase() : a === b;
}

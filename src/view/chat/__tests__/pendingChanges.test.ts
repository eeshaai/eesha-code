import { describe, expect, it } from "vitest";

import type { LogLine, TurnChanges } from "../../../core/models/run";
import { agentChangedFiles, changedTurns, pendingChanges, turnMessages } from "../pendingChanges";

const turn = (before: string, after: string, files: TurnChanges["files"], root = "/repo"): TurnChanges => ({ root, before, after, files });

const line = (kind: string, changed?: TurnChanges, changedMore?: TurnChanges[]): LogLine =>
    ({ ownerId: "chat", at: 1, stream: "system", text: kind, kind, ...(changed ? { changed } : {}), ...(changedMore ? { changedMore } : {}) });

const first = turn("t0", "t1", [{ path: "a.ts", status: "modified" }]);

const second = turn("t1", "t2", [
    { path: "b.ts", status: "added" },
    { path: "c.ts", status: "deleted" }
]);

const other = turn("o0", "o1", [{ path: "z.ts", status: "added" }], "/other");

describe("pendingChanges", () => {

    it("is nothing before any turn changed a file", () => {

        expect(pendingChanges([line("message")])).toEqual([]);
    });

    it("is the newest turn that changed files, even after a quiet turn", () => {

        const pending = pendingChanges([line("files.changed", first), line("files.changed", second), line("message")]);

        expect(pending).toHaveLength(1);
        expect(pending[0].changed).toBe(second);
        expect([...pending[0].undone]).toEqual([]);
    });

    it("leaves out files undone from that turn, and only from that turn", () => {

        const pending = pendingChanges([
            line("files.changed", second),
            line("files.undone", { ...second, files: [second.files[0]] }),
            line("files.undone", { ...first, files: [{ path: "c.ts", status: "deleted" }] })
        ]);

        expect([...pending[0].undone]).toEqual(["b.ts"]);
    });

    it("is nothing once every file was undone", () => {

        expect(pendingChanges([line("files.changed", first), line("files.undone", first)])).toEqual([]);
    });

    it("is nothing once the changes were kept", () => {

        expect(pendingChanges([line("files.changed", second), line("files.kept", { ...second, files: [] })])).toEqual([]);
    });

    it("has one entry per repository the turn changed", () => {

        const pending = pendingChanges([line("files.changed", second, [other])]);

        expect(pending.map(repo => repo.changed)).toEqual([second, other]);
    });

    it("drops one repository once it was kept or fully undone, and leaves the other", () => {

        expect(pendingChanges([line("files.changed", second, [other]), line("files.kept", { ...other, files: [] })])
            .map(repo => repo.changed.root)).toEqual(["/repo"]);

        expect(pendingChanges([line("files.changed", second, [other]), line("files.undone", second)])
            .map(repo => repo.changed.root)).toEqual(["/other"]);
    });

    it("counts an undo only against the repository it names", () => {

        const pending = pendingChanges([
            line("files.changed", second, [other]),
            line("files.undone", { ...other, files: [{ path: "b.ts", status: "added" }] })
        ]);

        expect([...pending[0].undone]).toEqual([]);
        expect([...pending[1].undone]).toEqual(["b.ts"]);
    });
});

describe("changedTurns", () => {

    const prompt = (text: string, pending?: "sending"): LogLine =>
        ({ ownerId: "chat", at: 1, stream: "stdout", text: `${text}\n`, kind: "prompt", ...(pending ? { pending } : {}) });

    it("is nothing before any turn changed a file", () => {

        expect(changedTurns([prompt("hello"), line("message")])).toEqual([]);
    });

    it("lists every turn that changed files, newest first, under the message that started it", () => {

        const turns = changedTurns([
            prompt("fix a"),
            line("files.changed", first),
            line("files.kept", { ...first, files: [] }),
            prompt("just a question"),
            line("message"),
            prompt("add b, drop c"),
            line("files.changed", second, [other])
        ]);

        expect(turns.map(turn => turn.message)).toEqual(["add b, drop c", "fix a"]);
        expect(turns[0].repos.map(repo => repo.changed)).toEqual([second, other]);

        // Kept is still listed: the list is every turn, not what waits on Keep.
        expect(turns[1].repos.map(repo => repo.changed)).toEqual([first]);

        // The same turn keeps its key as lines arrive.
        expect(turns.map(turn => turn.key)).toEqual([6, 1]);
    });

    it("skips a message still being sent", () => {

        const turns = changedTurns([prompt("sent"), prompt("not yet", "sending"), line("files.changed", first)]);

        expect(turns[0].message).toBe("sent");
    });

    it("marks a file put back since, only in the turn and repository the undo names", () => {

        const turns = changedTurns([
            prompt("one"),
            line("files.changed", first),
            prompt("two"),
            line("files.changed", second, [other]),
            line("files.undone", { ...other, files: [{ path: "z.ts", status: "added" }] })
        ]);

        expect([...turns[0].repos[0].undone]).toEqual([]);
        expect([...turns[0].repos[1].undone]).toEqual(["z.ts"]);
        expect([...turns[1].repos[0].undone]).toEqual([]);
    });
});

describe("agentChangedFiles", () => {

    const paths = (lines: LogLine[]) => agentChangedFiles(lines).map(one => one.path);

    it("lists every file the turns changed, as full paths, in path order", () => {

        expect(paths([line("files.changed", first), line("files.changed", second, [other])]))
            .toEqual(["/other/z.ts", "/repo/a.ts", "/repo/b.ts"]);
    });

    it("drops a file a later turn deleted", () => {

        const made = turn("t0", "t1", [{ path: "c.ts", status: "added" }]);

        expect(paths([line("files.changed", made), line("files.changed", second)])).toEqual(["/repo/b.ts"]);
    });

    it("leaves out files undone since, and keeps kept ones", () => {

        expect(paths([
            line("files.changed", first),
            line("files.kept", { ...first, files: [] }),
            line("files.changed", second),
            line("files.undone", { ...second, files: [{ path: "b.ts", status: "added" }] })
        ])).toEqual(["/repo/a.ts"]);
    });

    it("does not double the slash after a folder that ends in one", () => {

        expect(paths([line("files.changed", turn("t0", "t1", [{ path: "x.ts", status: "modified" }], "C:\\repo\\"))]))
            .toEqual(["C:\\repo/x.ts"]);
    });

    it("keeps the first turn that changed a file, for its diff", () => {

        const again = turn("t1", "t2", [{ path: "a.ts", status: "modified" }]);

        expect(agentChangedFiles([line("files.changed", first), line("files.changed", again)]))
            .toEqual([{ path: "/repo/a.ts", root: "/repo", file: "a.ts", before: "t0", after: "t1" }]);
    });
});

describe("turnMessages", () => {

    const prompt = (text: string): LogLine => ({ ownerId: "chat", at: 1, stream: "stdout", text: `${text}\n`, kind: "prompt" });

    it("gives each repository of each turn the message that started the turn", () => {

        expect(turnMessages([
            prompt("fix a"),
            line("files.changed", first),
            prompt("add b"),
            line("files.changed", second, [other])
        ])).toEqual({ "/repo|t1": "fix a", "/repo|t2": "add b", "/other|o1": "add b" });
    });
});

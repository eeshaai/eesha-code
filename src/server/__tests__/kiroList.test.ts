// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it, vi } from "vitest";

import { specEventsPath } from "../../core/events/eventFile";
import { lastSession, parseEvents } from "../../core/events/runEvents";
import { deleteKiroSession, listKiroSessions, renameKiroSession } from "../../core/agent/providers/kiroSessions";
import { folderKey } from "../protocol";
import { importedEvents, KiroList, sessionIdsInSpecs } from "../kiroList";

/*
 * A Kiro session opened from the session list: the events
 * file written for it must carry Kiro's conversation on, and show the
 * thread Kiro gave back.
 */

describe("importedEvents", () => {

    const row = { sessionId: "sess_k1", runtime: "kiro-cli", at: 1_000 };

    it("carries Kiro's session on, on Kiro's runtime", () => {

        const events = parseEvents(importedEvents("c1", row, [], 5_000));

        expect(lastSession(events, "chat")).toEqual({ sessionId: "sess_k1", provider: "kiro-cli", model: undefined });
    });

    it("writes each message as the thread shows it, each ending in a new line", () => {

        const events = parseEvents(importedEvents("c1", row, [
            { role: "user", text: "Write 1 to 3" },
            { role: "agent", text: "1\n2\n3\n" }
        ], 5_000));

        expect(events.map(event => [event.kind, (event as { text?: string }).text])).toEqual([
            ["open", undefined],
            ["session", undefined],
            ["prompt", "Write 1 to 3\n"],
            ["message", "1\n2\n3\n"]
        ]);
    });

    it("never dates the session later than now", () => {

        const events = parseEvents(importedEvents("c1", { ...row, at: 9_000 }, [], 5_000));

        expect(events.every(event => event.at === 5_000)).toBe(true);
    });
});

describe("Kiro sessions SDD used", () => {

    /** A spec's events file in this SDD folder, naming these sessions. */
    function specWith(sddFolder: string, spec: string, sessionIds: string[]): void {

        const file = specEventsPath(sddFolder, spec);

        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, [
            { v: 1, kind: "open", runId: `spec:${spec}`, at: 1 },
            ...sessionIds.map(sessionId => ({ kind: "session", ownerId: "requirements", at: 2, sessionId, provider: "kiro-cli" }))
        ].map(event => JSON.stringify(event)).join("\n") + "\n");
    }

    it("are read from every spec's history, in every SDD folder", () => {

        const [one, two] = [fs.mkdtempSync(path.join(os.tmpdir(), "eesha-kiro-")), fs.mkdtempSync(path.join(os.tmpdir(), "eesha-kiro-"))];

        specWith(one, "alpha", ["sess_phase1", "sess_phase2"]);
        specWith(two, "beta", ["sess_wave1"]);

        const ids = sessionIdsInSpecs();

        for (const id of ["sess_phase1", "sess_phase2", "sess_wave1"])
            expect(ids.has(id)).toBe(true);
    });

    it("never show in the AI list as Kiro's own sessions", async () => {

        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-kiro-"));

        specWith(folder, "gamma", ["sess_sdd"]);

        vi.mocked(listKiroSessions).mockResolvedValueOnce([
            { sessionId: "sess_sdd", cwd: folder, title: "Requirements", at: 5 },
            { sessionId: "sess_own", cwd: folder, title: "Kiro by hand", at: 6 }
        ] as never);

        let list!: KiroList;

        // The first list asks Kiro in the background; the list says when it changed.
        await new Promise<void>(resolve => {

            list = new KiroList(resolve);
            list.listed(new Set([folderKey(folder)]));
        });

        expect(list.listed(new Set([folderKey(folder)])).map(row => row.sessionId)).toEqual(["sess_own"]);
    });
});

describe("a Kiro row's own Rename and Delete", () => {

    /** A list holding these two Kiro sessions in one folder. */
    async function listOf(folder: string): Promise<KiroList> {

        vi.mocked(listKiroSessions).mockResolvedValueOnce([
            { sessionId: "sess_a", cwd: folder, title: "First", at: 5 },
            { sessionId: "sess_b", cwd: folder, title: "Second", at: 6 }
        ] as never);

        let list!: KiroList;

        await new Promise<void>(resolve => {

            list = new KiroList(resolve);
            list.listed(new Set([folderKey(folder)]));
        });

        return list;
    }

    it("deletes in Kiro, in the session's own folder, and the row leaves the list", async () => {

        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-kiro-"));
        const list = await listOf(folder);

        vi.mocked(deleteKiroSession).mockResolvedValueOnce();

        await list.delete(list.row("sess_a")!);

        expect(deleteKiroSession).toHaveBeenLastCalledWith(expect.any(String), "sess_a", folder);
        expect(list.listed(new Set([folderKey(folder)])).map(row => row.sessionId)).toEqual(["sess_b"]);
    });

    it("keeps the row when Kiro refuses the delete", async () => {

        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-kiro-"));
        const list = await listOf(folder);

        await expect(list.delete(list.row("sess_a")!)).rejects.toThrow("Kiro is not started in tests.");

        expect(list.row("sess_a")).toBeDefined();
    });

    it("renames in Kiro and the list shows the new name", async () => {

        const folder = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-kiro-"));
        const list = await listOf(folder);

        vi.mocked(renameKiroSession).mockResolvedValueOnce();

        await list.rename(list.row("sess_b")!, "Renamed");

        expect(renameKiroSession).toHaveBeenLastCalledWith(expect.any(String), "sess_b", "Renamed", folder);
        expect(list.row("sess_b")?.title).toBe("Renamed");
    });
});

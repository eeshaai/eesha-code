import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterAll, beforeAll, vi } from "vitest";

/**
 * Kiro is never started by a test. The settings always hold the built-in
 * Kiro runtime, so Eesha Code's session list would start `kiro-cli` to read
 * Kiro's own sessions (`src/server/kiroList.ts`). Each call that starts
 * Kiro fails here, the way it does on a machine without Kiro; the parts
 * that only read shapes stay real. A test file can mock it its own way.
 */
vi.mock("../core/agent/providers/kiroSessions", async () => {

    const actual = await vi.importActual<typeof import("../core/agent/providers/kiroSessions")>("../core/agent/providers/kiroSessions");

    const refuse = async (): Promise<never> => { throw new Error("Kiro is not started in tests."); };

    return {
        ...actual,
        listKiroSessions: vi.fn(refuse),
        readKiroSession: vi.fn(refuse),
        cutKiroConversation: vi.fn(async () => ({ kind: "unmatched", reason: "Kiro is not started in tests." })),
        renameKiroSession: vi.fn(refuse),
        deleteKiroSession: vi.fn(refuse)
    };
});

/**
 * The suite's home directory, moved somewhere disposable.
 *
 * The run database, revise snapshots, the daily log and a run's events
 * file all resolve through `os.homedir()`. Without this, a test that
 * runs a workflow writes into the real profile of whoever ran the
 * suite. A test file that wants its own home can still override it.
 *
 * Moved by environment variable rather than by mocking `os`:
 * `homedir()` reads `USERPROFILE` on Windows and `HOME` on POSIX, and
 * an ESM module namespace cannot be spied on. Both are set so the suite
 * behaves the same on either.
 */

const VARIABLES = ["HOME", "USERPROFILE"] as const;

const before = new Map<string, string | undefined>();

let home: string | undefined;

beforeAll(() => {

    home = fs.mkdtempSync(path.join(os.tmpdir(), "eesha-home-"));

    for (const name of VARIABLES) {

        before.set(name, process.env[name]);
        process.env[name] = home;
    }
});

afterAll(() => {

    for (const [name, value] of before)
        if (value === undefined)
            delete process.env[name];
        else
            process.env[name] = value;

    // Best effort. A file still held open on Windows is not worth
    // failing a suite that has already finished.
    if (home)
        try {

            fs.rmSync(home, { recursive: true, force: true });

        } catch {

            // Left in the OS temp directory.
        }
});

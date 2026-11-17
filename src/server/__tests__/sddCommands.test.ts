// First: stops this file if the home folder is the real one - see homeGuard.ts.
import "./homeGuard";

import * as os from "os";

import { describe, expect, it } from "vitest";

import { runAndTell } from "../ServerSddHost";

/*
 * A plan's command in Eesha Code: it runs in the machine's default shell,
 * and its exit code ticks the task's box or not.
 */

describe("a plan's command", () => {

    it("runs in the folder, says it is done, and answers exit code 0", async () => {

        const notes: string[] = [];

        const end = await runAndTell(os.tmpdir(), "echo plan-ran", text => notes.push(text));

        expect(end.code).toBe(0);
        expect(end.output).toContain("plan-ran");
        expect(notes[0]).toContain("Running in");
        expect(notes.at(-1)).toBe("Done: echo plan-ran");
    }, 30_000);

    it("answers a failing exit code, with the last lines it printed", async () => {

        const notes: string[] = [];

        const end = await runAndTell(os.tmpdir(), "echo before-failing\nexit 3", text => notes.push(text));

        expect(end.code).toBe(3);
        expect(notes.at(-1)).toContain("ended with exit code 3");
        expect(notes.at(-1)).toContain("before-failing");
    }, 30_000);
});

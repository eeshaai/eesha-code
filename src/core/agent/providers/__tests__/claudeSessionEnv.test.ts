import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { describe, expect, it } from "vitest";

import { ClaudeProvider } from "../ClaudeProvider";

/*
 * `ProviderDeps.sessionEnv`: what the program adds to Claude's own
 * process for a session. It may refuse the session by throwing - the
 * person has a choice to make first.
 */

describe("the Claude runtime and the program's own environment values", () => {

    it("does not start a session the program refuses, and says the program's reason", async () => {

        const asked: string[] = [];

        const provider = new ClaudeProvider({
            sessionEnv: runtime => {

                asked.push(runtime);

                throw new Error("Claude did not start: its own memory is still on.");
            }
        });

        await expect(provider.createSession({ workingDirectory: fs.mkdtempSync(path.join(os.tmpdir(), "claude-env-")), env: {} }))
            .rejects.toThrow("Claude did not start: its own memory is still on.");

        expect(asked).toEqual(["claude"]);
    });
});

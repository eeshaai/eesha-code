import { describe, expect, it, vi } from "vitest";

import { AgentSessionConfig } from "../../AgentSession";
import { resumable, sessionOptions } from "../ClaudeProvider";

/**
 * One exclusion. The SDK takes either `sessionId` (new conversation) or
 * `resume` (carry one on) and rejects both together unless
 * `forkSession` is set. Forking mints a new id, which a caller resuming
 * does not want, so it is never set and the two are never sent together.
 *
 * Sending neither quietly starts a cold conversation every run.
 */

const ROOT = "/repo";

function options(config: Partial<AgentSessionConfig>): Record<string, unknown> {

    return sessionOptions(
        { workingDirectory: ROOT, env: {}, ...config } as AgentSessionConfig,
        "new-id",
        {},
        new AbortController());
}

describe("resuming a Claude conversation", () => {

    it("asks for a new conversation under our own id when none is named", () => {

        const built = options({});

        expect(built.sessionId).toBe("new-id");
        expect(built.resume).toBeUndefined();
    });

    it("asks to carry one on when one is named", () => {

        const built = options({ resume: "earlier-1" });

        expect(built.resume).toBe("earlier-1");
    });

    it("never sends an id for a new conversation and one to reopen", () => {

        const built = options({ resume: "earlier-1" });

        expect(built.sessionId).toBeUndefined();
    });

    // Forking answers with a new id, and the events file would then
    // point at a conversation nothing continues.
    it("never forks, so a reopened conversation keeps its id", () => {

        expect(options({ resume: "earlier-1" }).forkSession).toBeUndefined();
    });
});

/*
 * `resumable` decides whether a resume is honoured, and says why when
 * it is not - `ai@1` fails the run on that answer, so "the transcript
 * is gone" and "the lookup itself kept failing" have to read as the
 * different facts they are.
 */
describe("resumable", () => {

    const logged: string[] = [];

    const log = (text: string) => { logged.push(text); };

    it("resumes when the SDK still has the transcript", async () => {

        const outcome = await resumable(async () => ({}) as never, "chat-1", "/repo", log);

        expect(outcome).toEqual({ resumed: true });
    });

    it("refuses without retrying when the SDK plainly has nothing", async () => {

        const getSessionInfo = vi.fn(async () => undefined);

        const outcome = await resumable(getSessionInfo, "chat-1", "/repo", log);

        expect(outcome).toEqual({ resumed: false, reason: expect.stringContaining("no transcript") });
        expect(getSessionInfo).toHaveBeenCalledTimes(1);
    });

    it("retries a lookup that throws before giving up", async () => {

        const getSessionInfo = vi.fn()
            .mockRejectedValueOnce(new Error("ECONNRESET"))
            .mockResolvedValueOnce({});

        const outcome = await resumable(getSessionInfo, "chat-1", "/repo", log);

        expect(outcome).toEqual({ resumed: true });
        expect(getSessionInfo).toHaveBeenCalledTimes(2);
    });

    it("gives a reason naming the failure, not the generic miss, once retries are spent", async () => {

        const getSessionInfo = vi.fn(async () => { throw new Error("ECONNRESET"); });

        const outcome = await resumable(getSessionInfo, "chat-1", "/repo", log);

        expect(outcome.resumed).toBe(false);
        expect((outcome as { reason: string }).reason).toContain("ECONNRESET");
        expect((outcome as { reason: string }).reason).not.toContain("no transcript");
    });
});

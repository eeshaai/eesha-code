import { describe, expect, it, vi } from "vitest";

import { knows } from "../CopilotProvider";

/**
 * `knows` decides whether a resume is honoured, and says why when it is
 * not - `ai@1` fails the run on that answer, so "the CLI no longer has
 * it" and "the lookup itself kept failing" have to read as the
 * different facts they are. Mirrors `resumable`'s own tests on the
 * Claude side.
 */
describe("knows", () => {

    const log = () => { };

    function client(getSessionMetadata: () => Promise<unknown>) {

        return { getSessionMetadata } as unknown as Parameters<typeof knows>[0];
    }

    it("resumes when the CLI still has the session", async () => {

        const outcome = await knows(client(async () => ({})), "chat-1", log);

        expect(outcome).toEqual({ resumed: true });
    });

    it("refuses without retrying when the CLI plainly has nothing", async () => {

        const getSessionMetadata = vi.fn(async () => undefined);

        const outcome = await knows(client(getSessionMetadata), "chat-1", log);

        expect(outcome).toEqual({ resumed: false, reason: expect.stringContaining("no longer has") });
        expect(getSessionMetadata).toHaveBeenCalledTimes(1);
    });

    it("retries a lookup that throws before giving up", async () => {

        const getSessionMetadata = vi.fn()
            .mockRejectedValueOnce(new Error("ECONNRESET"))
            .mockResolvedValueOnce({});

        const outcome = await knows(client(getSessionMetadata), "chat-1", log);

        expect(outcome).toEqual({ resumed: true });
        expect(getSessionMetadata).toHaveBeenCalledTimes(2);
    });

    it("gives a reason naming the failure, not the generic miss, once retries are spent", async () => {

        const getSessionMetadata = vi.fn(async () => { throw new Error("ECONNRESET"); });

        const outcome = await knows(client(getSessionMetadata), "chat-1", log);

        expect(outcome.resumed).toBe(false);
        expect((outcome as { reason: string }).reason).toContain("ECONNRESET");
        expect((outcome as { reason: string }).reason).not.toContain("no longer has");
    });
});

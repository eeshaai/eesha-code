import { describe, expect, it } from "vitest";

import { AgentEvent, describeEvent } from "../../AgentSession";
import { CopilotAgentSession } from "../CopilotProvider";

/*
 * Every Stop we send says so in the log, with why. An agent marks the
 * tools still running as "cancelled" for its own aborts too, and this
 * line is how the log tells the two apart. The ACP session's own case
 * is in acpSession.test.ts, Claude's in claudeSession.test.ts.
 */
describe("CopilotAgentSession.abort", () => {

    it("says in the log that it stopped the turn, and why", async () => {

        const aborted: string[] = [];

        const sdk = {
            sessionId: "copilot-1",
            on: () => () => undefined,
            abort: async () => { aborted.push("abort"); }
        };

        const session = new CopilotAgentSession({} as never, sdk as never);

        const events: AgentEvent[] = [];
        session.on(event => events.push(event));

        await session.abort();
        await session.abort("the run was stopped");

        expect(aborted).toEqual(["abort", "abort"]);

        expect(events.filter(event => event.kind === "notice").map(event => describeEvent(event)?.text)).toEqual([
            "Sent abort: Stop was pressed.",
            "Sent abort: the run was stopped."
        ]);
    });
});

import { describe, expect, it } from "vitest";
import { AgentEvent, AskDesk, describeEvent } from "../AgentSession";

/*
 * A question nobody answered still has to close in the log. The
 * conversation view keeps a question open until an `answer` line names
 * it, and hides its compose box while one is open - so a question left
 * behind by a Stop would hide the box for good.
 */
describe("AskDesk.abandon", () => {

    function desk() {

        const events: AgentEvent[] = [];
        const ids = ["q-1", "q-2"];

        return { events, desk: new AskDesk(event => events.push(event), () => ids.shift() ?? "q-n") };
    }

    it("raises an answer event for every open question, naming it", async () => {

        const { events, desk: asks } = desk();

        const first = asks.ask({ prompt: "Which one?", raw: {} }, "ask_user");
        const second = asks.ask({ prompt: "And this?", raw: {} }, "ask_user");

        asks.abandon("The turn was stopped before the question was answered.");

        const answers = events.filter(event => event.kind === "answer");

        expect(answers).toEqual([
            { kind: "answer", name: "abandoned", raw: undefined, askId: "q-1", text: "The turn was stopped before the question was answered." },
            { kind: "answer", name: "abandoned", raw: undefined, askId: "q-2", text: "The turn was stopped before the question was answered." }
        ]);

        await expect(first.answer).rejects.toThrow("stopped");
        await expect(second.answer).rejects.toThrow("stopped");
        expect(asks.pending).toBe(0);
    });

    it("raises nothing when no question is open", () => {

        const { events, desk: asks } = desk();

        asks.abandon("The session ended before the question was answered.");

        expect(events).toEqual([]);
    });

    it("is described as a stdout line carrying the ask's id, like a person's answer", () => {

        const line = describeEvent(
            { kind: "answer", name: "abandoned", raw: undefined, askId: "q-1", text: "The session ended." });

        expect(line).toEqual({ kind: "answer", text: "The session ended.", stream: "stdout", askId: "q-1" });
    });
});

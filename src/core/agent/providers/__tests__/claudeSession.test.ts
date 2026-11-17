import { describe, expect, it, vi } from "vitest";

import { readCommandList } from "../../commandListFile";
import { ClaudeAgentSession, MessageQueue } from "../ClaudeProvider";

/**
 * How a Claude session behaves when told to stop:
 *
 *   1. an interrupt that goes unanswered escalates to dispose, which
 *      settles the waiting task instead of leaving it for the backstop
 *   2. an interrupt that is answered ends the turn and nothing more;
 *      the session stays usable, and an idle session is never touched
 *   3. a Stop that lands before the session finishes being built still
 *      wins; the session arrives already ended
 */

/**
 * A fake SDK stream. Messages go in through `emit` and come out of the
 * async iterable the session pumps. The real stream carries `interrupt`
 * on the same object, so this one takes it as a property too.
 */
function fakeStream(): {
    stream: AsyncIterable<unknown> & {
        interrupt?: () => Promise<void>;
        getContextUsage?: () => Promise<unknown>;
    };
    emit(message: unknown): void;
} {

    const pending: unknown[] = [];

    let wake: (() => void) | undefined;

    async function* generate(): AsyncGenerator<unknown> {

        for (; ;) {

            while (pending.length)
                yield pending.shift();

            await new Promise<void>(resolve => { wake = resolve; });
        }
    }

    const stream = generate() as AsyncIterable<unknown> & {
        interrupt?: () => Promise<void>;
        getContextUsage?: () => Promise<unknown>;
    };

    return {
        stream,
        emit(message) {

            pending.push(message);

            const resume = wake;
            wake = undefined;
            resume?.();
        }
    };
}

function session(
    stream: AsyncIterable<unknown>,
    controller = new AbortController(),
    signal?: AbortSignal
): ClaudeAgentSession {

    return new ClaudeAgentSession(
        "test-session",
        stream as never,
        new MessageQueue(),
        controller,
        async () => undefined,
        signal,
        () => undefined
    );
}

/** A `background_tasks_changed` level - the full set, as the SDK sends it. */
function live(...ids: string[]): unknown {

    return {
        type: "system",
        subtype: "background_tasks_changed",
        tasks: ids.map(id => ({ task_id: id, task_type: "Task", description: id }))
    };
}

/**
 * A turn is not over while work it started is still running. The SDK
 * sends one `result` per turn and a backgrounded sub-agent outlives it,
 * so without this the task takes the agent's holding line as its answer.
 * The SDK publishes the live set - see `SDKBackgroundTasksChangedMessage`.
 */
describe("ClaudeAgentSession background work", () => {

    it("does not end the turn while background work is still running", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        let ended = false;

        const turn = claude.sendAndWait({ prompt: "go" }).then(() => { ended = true; });

        emit(live("task-1", "task-2"));
        emit({ type: "result", subtype: "success" });

        await new Promise(resolve => setTimeout(resolve, 10));

        // The SDK says the turn is done. Two jobs are still parked.
        expect(ended).toBe(false);
        expect(claude.status).toBe("working");

        emit(live());

        await new Promise(resolve => setTimeout(resolve, 10));

        // Draining is not the end either: the agent is asked to carry on.
        expect(ended).toBe(false);

        emit({ type: "result", subtype: "success" });

        await expect(turn).resolves.toBeUndefined();
        expect(claude.status).toBe("idle");
    });

    it("ends the turn as usual when nothing was backgrounded", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "success" });

        await expect(turn).resolves.toBeUndefined();
        expect(claude.status).toBe("idle");
    });

    it("ends a failed turn now, whatever is still running", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit(live("task-1"));
        emit({ type: "result", subtype: "error_during_execution", is_error: true, error: "it broke" });

        await expect(turn).rejects.toThrow(/error_during_execution/);
    });

    /* Carrying on can start more work, so the loop needs a cap. */
    it("stops asking the agent to carry on after three goes", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const turn = claude.sendAndWait({ prompt: "go" });

        for (let round = 0; round < 4; round++) {

            emit(live(`task-${round}`));
            emit({ type: "result", subtype: "success" });

            await new Promise(resolve => setTimeout(resolve, 5));

            emit(live());

            await new Promise(resolve => setTimeout(resolve, 5));
        }

        await expect(turn).resolves.toBeUndefined();
    });

    it("does not ask the agent to carry on after a Stop", async () => {

        const { stream, emit } = fakeStream();

        stream.interrupt = async () => undefined;

        const claude = session(stream);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit(live("task-1"));
        emit({ type: "result", subtype: "success" });

        await new Promise(resolve => setTimeout(resolve, 10));

        await claude.abort(undefined, 20);

        await expect(turn).resolves.toBeUndefined();

        // The work landing after the Stop must not restart anything.
        emit(live());

        await new Promise(resolve => setTimeout(resolve, 10));

        expect(claude.status).toBe("ended");
    });

    /* The agent says "cancelled" for its own aborts too - this line is how the log tells them apart. */
    it("says in the log that it interrupted the turn, and why", async () => {

        const { stream } = fakeStream();

        stream.interrupt = async () => undefined;

        const claude = session(stream);

        const texts: string[] = [];
        claude.on(event => { if (event.kind === "notice") texts.push(event.text); });

        void claude.sendAndWait({ prompt: "go" }).catch(() => undefined);

        await claude.abort("the run was stopped", 10);

        expect(texts).toContain("Sent interrupt: the run was stopped.");
    });
});

describe("ClaudeAgentSession stop behaviour", () => {

    /*
     * Interrupt sent, no result comes back. The grace runs out, dispose
     * kills the child (the aborted controller stands in for that) and
     * the waiting task gets its answer.
     */
    it("escalates to dispose when the interrupt goes unanswered", async () => {

        const { stream } = fakeStream();

        stream.interrupt = async () => undefined;

        const controller = new AbortController();

        const claude = session(stream, controller);

        const turn = claude.sendAndWait({ prompt: "go" });

        expect(claude.status).toBe("working");

        await claude.abort(undefined, 20);

        expect(claude.status).toBe("ended");
        expect(controller.signal.aborted).toBe(true);

        await expect(turn).resolves.toBeUndefined();
    });

    it("does not dispose when the interrupt ends the turn within the grace", async () => {

        const { stream, emit } = fakeStream();

        // The cooperative CLI: asked to interrupt, it ends the turn.
        stream.interrupt = async () => emit({ type: "result", subtype: "success" });

        const controller = new AbortController();

        const claude = session(stream, controller);

        const turn = claude.sendAndWait({ prompt: "go" });

        await claude.abort(undefined, 5000);

        expect(claude.status).toBe("idle");
        expect(controller.signal.aborted).toBe(false);

        await expect(turn).resolves.toBeUndefined();
    });

    /* A held conversation must survive the Stop of a run that no longer owns it. */
    it("leaves an idle session alone", async () => {

        const { stream } = fakeStream();

        const controller = new AbortController();

        const claude = session(stream, controller);

        await claude.abort(undefined, 10);

        expect(claude.status).toBe("idle");
        expect(controller.signal.aborted).toBe(false);
    });

    /*
     * An AbortSignal that aborted before the constructor ran never
     * fires its listener, so a Stop clicked while the SDK was still
     * importing has to be checked for directly.
     */
    it("honours a signal that aborted before the session was built", async () => {

        const { stream } = fakeStream();

        const external = new AbortController();

        external.abort();

        const claude = session(stream, new AbortController(), external.signal);

        expect(claude.status).toBe("ended");

        // The task learns immediately instead of queueing into a closed queue.
        await expect(claude.sendAndWait({ prompt: "go" }))
            .rejects.toThrow(/ended/);
    });
});

/*
 * A turn cannot reach `result` while the model is genuinely blocked on
 * its own `ask_user` call - so a question still open the moment one
 * arrives is not a real one. It is the SDK having dropped that tool
 * call without telling this session so. Left alone it would lock every
 * later turn's compose box behind a question nobody is still asking.
 */
describe("ClaudeAgentSession abandons a stale question when its turn ends", () => {

    it("rejects the answer and closes the question when the turn succeeds anyway", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const events: unknown[] = [];

        claude.on(event => events.push(event));

        const pending = claude.ask({ prompt: "Which one?", raw: {} });

        // Attached before the turn runs, not after: `abandon` rejects
        // this promise as part of handling the result below, and a
        // handler wired on only once that has already happened is wired
        // on too late for Node not to call it an unhandled rejection.
        const rejected = expect(pending.answer).rejects.toThrow(/turn ended without an answer/);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "success" });

        await turn;
        await rejected;

        expect(events).toContainEqual(expect.objectContaining({
            kind: "answer", name: "abandoned", askId: pending.askId
        }));
    });

    it("does the same when the turn ends in failure", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const pending = claude.ask({ prompt: "Which one?", raw: {} });
        const rejected = expect(pending.answer).rejects.toThrow(/turn ended without an answer/);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "error_during_execution", is_error: true, error: "it broke" });

        await expect(turn).rejects.toThrow();
        await rejected;
    });

    // A stale question from an earlier turn must never bleed into the
    // next one's answer - `respond` on a closed id is refused, not
    // silently accepted, which is what stops a click on a box the
    // person is still looking at from resolving a promise nobody awaits.
    it("leaves a closed question closed - a late respond finds nothing to answer", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const pending = claude.ask({ prompt: "Which one?", raw: {} });

        // `abandon` rejects this as part of the same result below -
        // caught here so Node does not call it unhandled while the
        // test's own point is `respond`'s refusal, not this promise.
        const rejected = expect(pending.answer).rejects.toThrow();

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "success" });

        await turn;
        await rejected;

        await expect(claude.respond(pending.askId, "too late")).rejects.toThrow(/nothing is waiting/i);
    });
});

/*
 * The context meter.
 *
 * The report is a control request to the CLI, not a model call, so it
 * is free - but it has to arrive while somebody is still listening.
 * `ai@1` stops listening the instant the turn settles, so a report
 * asked for after that would be emitted to nobody and the meter would never draw
 * a bar. The turn waits for it, capped.
 */
describe("ClaudeAgentSession and the context report", () => {

    it("reports the window before the turn is released, not after", async () => {

        const { stream, emit } = fakeStream();

        let asked = false;

        stream.getContextUsage = async () => {

            asked = true;

            // A round trip, so a report emitted after the turn settled
            // would land too late to be in `seen` below.
            await new Promise(resolve => setTimeout(resolve, 5));

            return {
                totalTokens: 84000,
                rawMaxTokens: 200000,
                categories: [{ name: "Messages", tokens: 84000 }]
            };
        };

        const claude = session(stream);

        const seen: unknown[] = [];

        const stop = claude.on(event => seen.push(event));

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.5 });

        await turn;

        // Whoever ran the turn stops listening here. Everything the
        // meter needs must already be in hand.
        stop();

        expect(asked).toBe(true);
        expect(seen).toContainEqual(expect.objectContaining({
            kind: "notice",
            context: { used: 84000, size: 200000, parts: [{ name: "Messages", tokens: 84000 }] }
        }));
    });

    /**
     * The first turn is the long one, which is exactly when somebody
     * wants to know how much room is left - and it is the one turn with
     * no earlier report still on screen. `init` is the earliest the CLI
     * can answer, so that is when the first one is asked for.
     */
    it("reports the window at startup, before the first turn has finished", async () => {

        const { stream, emit } = fakeStream();

        stream.getContextUsage = async () => ({ totalTokens: 34000, rawMaxTokens: 200000 });

        const claude = session(stream);

        const seen: unknown[] = [];

        claude.on(event => seen.push(event));

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "system", subtype: "init" });

        await new Promise(resolve => setTimeout(resolve, 10));

        // No result yet: the turn is still going, and the bar is drawn.
        expect(seen).toContainEqual(expect.objectContaining({
            name: "context_usage",
            context: { used: 34000, size: 200000 }
        }));

        emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });

        await turn;
    });

    /**
     * Only the first. From turn two the last report is already on
     * screen, so asking again at startup would buy nothing - and a
     * resumed session raises `init` too.
     */
    it("does not ask again at startup once a report has been published", async () => {

        const { stream, emit } = fakeStream();

        let asked = 0;

        stream.getContextUsage = async () => {

            asked++;

            return { totalTokens: 1000, rawMaxTokens: 200000 };
        };

        const claude = session(stream);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "system", subtype: "init" });
        emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });

        await turn;

        // Once at startup, once as the turn ended.
        expect(asked).toBe(2);

        const second = claude.sendAndWait({ prompt: "again" });

        emit({ type: "system", subtype: "init" });
        emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });

        await second;

        // The second `init` asks for nothing; only the turn's own end does.
        expect(asked).toBe(3);
    });

    it("finishes the turn anyway when the CLI never answers", async () => {

        const { stream, emit } = fakeStream();

        // Never settles - the case the cap is for.
        stream.getContextUsage = () => new Promise(() => undefined);

        const claude = session(stream);

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });

        // Resolves on the cap rather than hanging on the CLI.
        await expect(turn).resolves.toBeUndefined();

    }, 10000);

    it("finishes the turn when the CLI cannot report context at all", async () => {

        const { stream, emit } = fakeStream();

        const claude = session(stream);

        const seen: unknown[] = [];

        claude.on(event => seen.push(event));

        const turn = claude.sendAndWait({ prompt: "go" });

        emit({ type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } });

        await turn;

        // No meter, no notice about one, and no failure either.
        expect(seen).not.toContainEqual(expect.objectContaining({ name: "context_usage" }));
        expect(seen).toContainEqual(expect.objectContaining({ kind: "idle" }));
    });
});

/**
 * Claude names the conversation itself, in its session file. After each
 * turn the session reads that name and sends it as a `title` notice -
 * the same line an ACP runtime's own title becomes - so the chat list
 * and the header show it instead of the first message.
 */
describe("ClaudeAgentSession title", () => {

    function titled(stream: AsyncIterable<unknown>, readTitle: () => Promise<string | undefined>): ClaudeAgentSession {

        return new ClaudeAgentSession(
            "test-session", stream as never, new MessageQueue(), new AbortController(), async () => undefined,
            undefined, () => undefined, false, undefined, undefined, readTitle);
    }

    const result = { type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 } };

    it("sends Claude's title when a turn ends, and only once while it stays the same", async () => {

        const { stream, emit } = fakeStream();

        let title: string | undefined;

        const claude = titled(stream, async () => title);

        const seen: { kind?: string; title?: string }[] = [];

        claude.on(event => seen.push(event as never));

        // Turn one: Claude has not named it yet - nothing is sent.
        const first = claude.sendAndWait({ prompt: "hi" });
        emit(result);
        await first;

        expect(seen.filter(event => event.title)).toEqual([]);

        // Turn two: now it has.
        title = "What you are";

        const second = claude.sendAndWait({ prompt: "what are you ?" });
        emit(result);
        await second;

        expect(seen.filter(event => event.title)).toEqual([
            expect.objectContaining({ kind: "notice", title: "What you are", text: "Title: What you are" })
        ]);

        // Turn three: the same title - not sent again.
        const third = claude.sendAndWait({ prompt: "more" });
        emit(result);
        await third;

        expect(seen.filter(event => event.title)).toHaveLength(1);
    });

    it("sends it before the turn is released, so whoever ran it still hears it", async () => {

        const { stream, emit } = fakeStream();

        const claude = titled(stream, async () => "Named");

        const seen: { title?: string }[] = [];

        claude.on(event => seen.push(event as never));

        const turn = claude.sendAndWait({ prompt: "go" }).then(() => seen.some(event => event.title === "Named"));

        emit(result);

        await expect(turn).resolves.toBe(true);
    });

    it("finishes the turn when the title cannot be read", async () => {

        const { stream, emit } = fakeStream();

        const logged: string[] = [];

        const claude = new ClaudeAgentSession(
            "test-session", stream as never, new MessageQueue(), new AbortController(), async () => undefined,
            undefined, text => { logged.push(text); }, false, undefined, undefined, async () => { throw new Error("EBUSY"); });

        const turn = claude.sendAndWait({ prompt: "go" });

        emit(result);

        await expect(turn).resolves.toBeUndefined();
        expect(logged.some(line => line.includes("title") && line.includes("EBUSY"))).toBe(true);
    });
});

/**
 * Claude's slash commands are kept in a file for the compose box when
 * the session starts - never fetched for the box, so nothing waits on
 * them. The ones that let Claude skip asking, or reach other folders,
 * are left out of the list and refused when typed. The test's home is a
 * throwaway folder - see src/__tests__/setup.ts.
 */
describe("ClaudeAgentSession and slash commands", () => {

    it("keeps the described list at start, without the refused ones and the terminal-only ones", async () => {

        const { stream, emit } = fakeStream();

        (stream as { supportedCommands?: () => Promise<unknown> }).supportedCommands = async () => [
            { name: "review", description: "Review a pull request", argumentHint: "<pr>" },
            { name: "permissions", description: "Change what runs without asking" },
            { name: "add-dir", description: "Add a folder" },
            { name: "compact", description: "Shrink the chat" },
            { name: "vim", description: "Terminal key bindings" }
        ];

        session(stream);

        emit({ type: "system", subtype: "init", slash_commands: ["compact", "review"], terminal_slash_commands: ["vim"] });

        await vi.waitFor(async () => expect(await readCommandList("claude")).toEqual([
            { name: "compact", description: "Shrink the chat" },
            { name: "review", description: "Review a pull request", hint: "<pr>" }
        ]));
    });

    it("keeps the names from start when the CLI cannot describe them", async () => {

        const { stream, emit } = fakeStream();

        session(stream);

        emit({ type: "system", subtype: "init", slash_commands: ["/init", "config", "release-notes"] });

        await vi.waitFor(async () => expect(await readCommandList("claude")).toEqual([
            { name: "init" },
            { name: "release-notes" }
        ]));
    });

    it("refuses a typed command that is never sent, and sends nothing", async () => {

        const { stream } = fakeStream();
        const queue = new MessageQueue();
        const pushed = vi.spyOn(queue, "push");

        const claude = new ClaudeAgentSession(
            "test-session", stream as never, queue, new AbortController(), async () => undefined, undefined, () => undefined);

        const seen: { kind?: string; message?: string }[] = [];

        claude.on(event => seen.push(event as never));

        await claude.send({ prompt: "/permissions" });
        await expect(claude.sendAndWait({ prompt: "  /Add-Dir D:\other" })).rejects.toThrow("'/add-dir' was not sent");

        expect(pushed).not.toHaveBeenCalled();
        expect(seen.filter(event => event.kind === "error").map(event => event.message)).toEqual([
            expect.stringContaining("'/permissions' was not sent"),
            expect.stringContaining("'/add-dir' was not sent")
        ]);
        expect(seen.some(event => event.kind === "idle")).toBe(true);
    });
});

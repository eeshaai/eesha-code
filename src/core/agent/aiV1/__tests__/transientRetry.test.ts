import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../plugin.json";
import { createExecute } from "../index";
import { AgentProvider, AgentProviders } from "../../AgentProvider";
import { AgentSessions } from "../../AgentSessions";
import { AgentEvent, AgentSession } from "../../AgentSession";
import { Plugin, PluginContext } from "../../../plugins/Plugin";
import { PluginManifest, pluginFromManifest } from "../../../plugins/PluginManifest";

/**
 * The transient-retry seam around one turn - see
 * `sendAndWaitWithRetries` in ../index.ts.
 *
 * The contract: a turn that fails on the provider's *service* saying
 * "come back" (overloaded, rate limit, 5xx) is re-sent into the same
 * still-alive session a bounded number of times, loudly; everything
 * else - auth, a session that ended, a refusal - stays fatal on the
 * first strike. Driven through a fake provider like agent.test.ts, and
 * on fake timers so the backoff costs the suite nothing.
 */

function flaky(failures: number, error: string) {

    let attempts = 0;

    const handlers = new Set<(event: AgentEvent) => void>();

    const session: AgentSession = {
        id: "session-1",
        status: "idle",
        send: async () => undefined,
        sendAndWait: async () => {

            attempts++;

            if (attempts <= failures)
                throw new Error(error);

            for (const handler of [...handlers])
                handler({ kind: "message", name: "assistant.message", text: "done", raw: {} });
        },
        abort: async () => undefined,
        dispose: async () => undefined,
        on: handler => {

            handlers.add(handler);

            return () => handlers.delete(handler);
        }
    };

    const provider: AgentProvider = { createSession: async () => session };

    return { provider, attempts: () => attempts };
}

function agent(provider: AgentProvider): Plugin {

    const providers = new AgentProviders();

    providers.register("ghcp", () => provider);

    return pluginFromManifest(
        manifest as PluginManifest,
        createExecute({ providers, sessions: new AgentSessions(), provider: "ghcp", maxHoldMs: 50, steeringOn: async () => false }) as never,
        "aiV1");
}

function context() {

    const logs: string[] = [];

    const ctx: PluginContext = {
        runId: "run-1",
        taskId: "release/draft/0",
        attempt: 1,
        cwd: "C:/work/repo",
        root: "C:/work/repo",
        env: {},
        secret: () => undefined,
        log: text => logs.push(text),
        reportSession: () => undefined,
        cancelled: false,
        onCancel: () => undefined
    };

    return { ctx, logs };
}

/** Runs the task while draining the retry backoff off fake timers. */
async function run(plugin: Plugin, ctx: PluginContext) {

    vi.useFakeTimers();

    try {

        const pending = plugin.execute({ prompt: "Go." }, ctx);

        // Generous: covers every backoff the loop can take.
        await vi.advanceTimersByTimeAsync(60_000);

        return await pending;

    } finally {

        vi.useRealTimers();
    }
}

afterEach(() => {

    vi.useRealTimers();
});

describe("transient provider failures", () => {

    it("retries an overloaded turn into the same session, and succeeds", async () => {

        const { provider, attempts } = flaky(1, 'API error: {"type":"overloaded_error"} (529)');
        const { ctx, logs } = context();

        const result = await run(agent(provider), ctx);

        expect(result.success).toBe(true);
        expect(attempts()).toBe(2);

        // Loudly: the run record must show the blip, not absorb it.
        expect(logs.join("\n")).toContain("transient error");
    });

    it("retries a rate-limited turn", async () => {

        const { provider, attempts } = flaky(1, "429 Too Many Requests - rate limit exceeded");

        const result = await run(agent(provider), context().ctx);

        expect(result.success).toBe(true);
        expect(attempts()).toBe(2);
    });

    it("gives up once the bounded retries are spent", async () => {

        // 2 retries on top of the first attempt = 3 strikes; a fourth
        // failure would need a fourth attempt that must never happen.
        const { provider, attempts } = flaky(99, "503 Service Unavailable");

        const result = await run(agent(provider), context().ctx);

        expect(result.success).toBe(false);
        expect(attempts()).toBe(3);
        expect(result.message).toContain("503");
    });

    it("does not retry an error that is not transient", async () => {

        const { provider, attempts } = flaky(99, "The Claude session has ended and cannot take another message.");

        const result = await run(agent(provider), context().ctx);

        expect(result.success).toBe(false);
        expect(attempts()).toBe(1);
    });
});

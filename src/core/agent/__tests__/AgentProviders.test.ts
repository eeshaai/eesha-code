import { describe, expect, it } from "vitest";
import { AgentProvider, AgentProviders, stampEvent } from "../AgentProvider";
import type { AgentEvent, AgentSession } from "../AgentSession";
import { addModelSpend, addSpend } from "../../models/run";

/**
 * Registration, not construction. A test puts a fake under the id the
 * real provider uses, and the real factory is never called.
 */

const provider = (): AgentProvider => ({
    createSession: async () => { throw new Error("not needed here"); }
});

describe("the providers the engine can run on", () => {

    it("builds one on first use and keeps it", async () => {

        let built = 0;

        const providers = new AgentProviders();

        providers.register("ghcp", () => { built++; return provider(); });

        expect(built).toBe(0);

        await providers.get("ghcp");
        await providers.get("ghcp");

        // A provider owns a connection. One per task means one CLI server per task.
        expect(built).toBe(1);
    });

    it("hands two callers at once the same one, rather than racing to build two", async () => {

        let built = 0;

        const providers = new AgentProviders();

        providers.register("ghcp", async () => {

            built++;

            await Promise.resolve();

            return provider();
        });

        const [first, second] = await Promise.all([providers.get("ghcp"), providers.get("ghcp")]);

        expect(built).toBe(1);
        expect(first).toBe(second);
    });

    it("says what is registered when asked for something that is not", async () => {

        const providers = new AgentProviders();

        providers.register("ghcp", () => provider());

        await expect(providers.get("claude")).rejects.toThrow(/Available: ghcp/);
    });

    it("says none are registered rather than listing nothing", async () => {

        await expect(new AgentProviders().get("ghcp")).rejects.toThrow(/None are registered/);
    });

    /*
     * A failed build is usually a credential not there yet (sign-in
     * dialog open, expired token). Caching it would fail the next task
     * for a reason that is no longer true.
     */
    it("lets a failed build be retried, rather than remembering the failure", async () => {

        let attempt = 0;

        const providers = new AgentProviders();

        providers.register("ghcp", () => {

            if (++attempt === 1)
                throw new Error("not signed in");

            return provider();
        });

        await expect(providers.get("ghcp")).rejects.toThrow("not signed in");
        await expect(providers.get("ghcp")).resolves.toBeDefined();
    });

    it("hands its dependencies to whatever it builds", async () => {

        const seen: string[] = [];

        const providers = new AgentProviders({ token: async () => "gho_xyz" });

        providers.register("ghcp", async deps => {

            seen.push((await deps.token?.()) ?? "none");

            return provider();
        });

        await providers.get("ghcp");

        expect(seen).toEqual(["gho_xyz"]);
    });

    /*
     * An ACP agent's id comes from settings.json, not a fixed list, so
     * it cannot be `register`ed one at a time like `ghcp` and `claude`.
     */
    describe("the fallback", () => {

        it("is tried only when no static factory matched the id", async () => {

            const providers = new AgentProviders();

            providers.register("ghcp", () => provider());
            providers.registerFallback(async () => { throw new Error("should never be reached"); });

            await expect(providers.get("ghcp")).resolves.toBeDefined();
        });

        it("builds a provider for an id nothing was registered under", async () => {

            const providers = new AgentProviders();

            providers.registerFallback(async id => id === "kiro" ? provider() : undefined);

            await expect(providers.get("kiro")).resolves.toBeDefined();
        });

        it("raises the same 'not registered' error, naming what is registered, when the fallback also has nothing", async () => {

            const providers = new AgentProviders();

            providers.register("ghcp", () => provider());
            providers.registerFallback(async () => undefined);

            await expect(providers.get("kiro")).rejects.toThrow(/No agent provider 'kiro' is registered.*Available: ghcp/s);
        });

        it("raises the plain error when no fallback was registered at all", async () => {

            await expect(new AgentProviders().get("kiro")).rejects.toThrow(/None are registered/);
        });

        it("builds once and keeps it, same as a statically registered provider", async () => {

            let built = 0;

            const providers = new AgentProviders();

            providers.registerFallback(async () => { built++; return provider(); });

            await providers.get("kiro");
            await providers.get("kiro");

            expect(built).toBe(1);
        });
    });
});

/*
 * Every figure a session publishes says which runtime charged it, so
 * Copilot's credits and Kiro's - both "credits" - stay apart in a total.
 */
describe("the runtime stamp", () => {

    it("puts the id the runtime was looked up by on every charge, model split and account", async () => {

        const providers = new AgentProviders();

        let publish: (event: AgentEvent) => void = () => undefined;

        providers.register("kiro-cli", () => ({
            createSession: async () => ({
                on: (handler: (event: AgentEvent) => void) => { publish = handler; return () => undefined; }
            }) as unknown as AgentSession
        }));

        const session = await (await providers.get("kiro-cli")).createSession({} as never);

        const seen: AgentEvent[] = [];
        session.on(event => seen.push(event));

        publish({
            name: "n", raw: undefined, kind: "notice", text: "Turn finished",
            cost: [{ amount: 0.5, unit: "credits" }],
            models: [{ model: "claude-sonnet-5", cost: [{ amount: 0.5, unit: "credits" }] }],
            account: { at: 1, rows: [] }
        });

        expect(seen[0]).toMatchObject({
            cost: [{ amount: 0.5, unit: "credits", runtime: "kiro-cli" }],
            models: [{ model: "claude-sonnet-5", runtime: "kiro-cli", cost: [{ runtime: "kiro-cli" }] }],
            account: { runtime: "kiro-cli" }
        });
    });

    it("leaves every other event, and a figure that already names its runtime, as it is", () => {

        const message: AgentEvent = { name: "m", raw: undefined, kind: "message", text: "hi" };

        expect(stampEvent("ghcp", message)).toBe(message);

        expect(stampEvent("ghcp", {
            name: "n", raw: undefined, kind: "notice", text: "t", cost: [{ amount: 1, unit: "credits", runtime: "kiro-cli" }]
        })).toMatchObject({ cost: [{ runtime: "kiro-cli" }] });
    });
});

describe("totals by runtime", () => {

    it("keeps two runtimes' credits apart, and adds up one runtime's", () => {

        const totals = addSpend(
            [{ amount: 1, unit: "credits", runtime: "ghcp" }],
            [{ amount: 0.5, unit: "credits", runtime: "kiro-cli" }, { amount: 2, unit: "credits", runtime: "ghcp" }]);

        expect(totals).toEqual([
            { amount: 3, unit: "credits", runtime: "ghcp" },
            { amount: 0.5, unit: "credits", runtime: "kiro-cli" }
        ]);
    });

    it("keeps the same model on two runtimes apart", () => {

        const totals = addModelSpend(
            [{ model: "claude-sonnet-5", runtime: "ghcp", inputTokens: 10 }],
            [{ model: "claude-sonnet-5", runtime: "kiro-cli", inputTokens: 5 }, { model: "claude-sonnet-5", runtime: "ghcp", inputTokens: 1 }]);

        expect(totals.map(one => [one.runtime, one.inputTokens])).toEqual([["ghcp", 11], ["kiro-cli", 5]]);
    });
});

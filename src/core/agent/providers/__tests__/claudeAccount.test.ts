import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../AgentSession";
import type { AccountUsage } from "../../../models/run";
import { claudeAccount, readClaudeAccount } from "../claudeAccount";
import { ClaudeAgentSession, MessageQueue } from "../ClaudeProvider";

/**
 * Claude's account in the Account section - what `/status` and `/usage`
 * show, read from the SDK. The answers below are shaped like the real
 * ones from CLI 2.1.325, with made-up figures.
 */

const INFO = { email: "me@example.com", organization: "Example Org", subscriptionType: "Claude Pro", apiProvider: "firstParty" as const };

function usage(overrides: Record<string, unknown> = {}): never {

    return {
        session: {},
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
            five_hour: { utilization: 3, resets_at: "2026-11-14T21:20:00+00:00" },
            seven_day: { utilization: 95, resets_at: "2026-11-15T10:00:00+00:00" },
            seven_day_opus: null,
            seven_day_sonnet: null,
            extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
            ...overrides
        },
        behaviors: null
    } as never;
}

function keys(account: AccountUsage | undefined): string[] {

    return account?.rows.map(row => row.key) ?? [];
}

describe("claudeAccount", () => {

    it("shows the plan, who is signed in and each limit, in /status and /usage order", () => {

        const found = claudeAccount(INFO, usage(), 1000)!;

        expect(keys(found.account)).toEqual(["Plan", "Signed in as", "Organization", "5-hour limit", "Weekly limit", "Extra usage"]);
        expect(found.account.rows[0].value).toBe("Pro");
        expect(found.account.rows[3].value).toMatch(/^3% used, resets /);
        expect(found.account.rows[4].value).toMatch(/^95% used, resets /);
        expect(found.account.rows[5].value).toBe("Off");
        expect(found.account.at).toBe(1000);
        expect(found.account.overLimit).toBeUndefined();
        expect(found.summary).toBe("Claude account: Pro; 5-hour limit 3% used; weekly limit 95% used");
    });

    it("puts the warning mark on at 100% of any limit", () => {

        const found = claudeAccount(INFO, usage({ seven_day: { utilization: 100, resets_at: null } }), 1)!;

        expect(found.account.overLimit).toBe(true);
        expect(found.account.rows.find(row => row.key === "Weekly limit")?.value).toBe("100% used");
    });

    it("lists the per-model weekly limits by the name the server gives", () => {

        const found = claudeAccount(INFO, usage({ model_scoped: [{ display_name: "Fable", utilization: 40, resets_at: null }] }), 1)!;

        expect(found.account.rows.find(row => row.key === "Weekly Fable")?.value).toBe("40% used");
    });

    it("shows only the account when plan limits do not apply (API key, Bedrock)", () => {

        const found = claudeAccount(
            { apiProvider: "bedrock" },
            { session: {}, subscription_type: null, rate_limits_available: false, rate_limits: null } as never,
            1)!;

        expect(found.account.rows).toEqual([{ key: "Through", value: "Amazon Bedrock" }]);
    });

    it("shows extra usage as on, with the share of its cap, and never its money figures", () => {

        const found = claudeAccount(INFO, usage({ extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1250, utilization: 25 } }), 1)!;

        expect(found.account.rows.find(row => row.key === "Extra usage")?.value).toBe("On, 25% of monthly cap used");
    });

    it("has nothing to show when neither answer came back", () => {

        expect(claudeAccount(undefined, undefined, 1)).toBeUndefined();
    });
});

describe("readClaudeAccount", () => {

    it("keeps the account rows when the limits request fails", async () => {

        const found = await readClaudeAccount({
            accountInfo: async () => INFO,
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => { throw new Error("gone"); }
        });

        expect(keys(found?.account)).toEqual(["Plan", "Signed in as", "Organization"]);
    });

    it("asks for the limits only, without the transcript scan", async () => {

        const ask = vi.fn(async () => usage());

        await readClaudeAccount({ usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: ask });

        expect(ask).toHaveBeenCalledWith({ skipBehaviors: true });
    });

    it("gives up on a request that never answers", async () => {

        const found = await readClaudeAccount({ accountInfo: () => new Promise(() => undefined) }, Date.now, 20);

        expect(found).toBeUndefined();
    });

    it("is nothing for a CLI that has neither request", async () => {

        expect(await readClaudeAccount({})).toBeUndefined();
    });
});

describe("the claude runtime's own session", () => {

    function fakeStream(extra: Record<string, unknown>) {

        const pending: unknown[] = [];
        let wake: (() => void) | undefined;

        async function* generate(): AsyncGenerator<unknown> {

            for (; ;) {

                while (pending.length)
                    yield pending.shift();

                await new Promise<void>(resolve => { wake = resolve; });
            }
        }

        const stream = Object.assign(generate(), extra);

        return {
            stream,
            emit(message: unknown) {

                pending.push(message);
                const resume = wake;
                wake = undefined;
                resume?.();
            }
        };
    }

    function accounts(kept?: AccountUsage) {

        return { remember: vi.fn(async () => undefined), last: vi.fn(async () => kept) };
    }

    function build(stream: AsyncIterable<unknown>, store?: ReturnType<typeof accounts>) {

        return new ClaudeAgentSession(
            "s", stream as never, new MessageQueue(), new AbortController(), async () => undefined,
            undefined, () => undefined, false, undefined, undefined, undefined, store);
    }

    function accountEvents(events: AgentEvent[]) {

        return events.filter(event => event.kind === "notice" && event.account);
    }

    it("reports the account after a turn, before the turn is released, and keeps it", async () => {

        const { stream, emit } = fakeStream({ accountInfo: async () => INFO, usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => usage() });
        const store = accounts();
        const claude = build(stream, store);

        const events: AgentEvent[] = [];
        claude.on(event => events.push(event));

        const turn = claude.sendAndWait({ prompt: "hi" });

        emit({ type: "result", subtype: "success" });

        await turn;

        const [event] = accountEvents(events);

        expect(event.kind === "notice" && event.account?.runtime).toBe("claude");
        expect(store.remember).toHaveBeenCalledWith("claude", expect.objectContaining({ rows: expect.any(Array) }));
    });

    it("reads again when the CLI says the rate limit state changed", async () => {

        const info = vi.fn(async () => INFO);
        const { stream, emit } = fakeStream({ accountInfo: info });
        const claude = build(stream);

        emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed" } });

        await vi.waitFor(() => expect(info).toHaveBeenCalledTimes(1));
    });

    it("shows the kept account on the first message, until a fresh one lands", async () => {

        const kept: AccountUsage = { at: 5, rows: [{ key: "Plan", value: "Pro" }], runtime: "claude" };
        const { stream } = fakeStream({});
        const claude = build(stream, accounts(kept));

        const events: AgentEvent[] = [];
        claude.on(event => events.push(event));

        await claude.send({ prompt: "hi" });

        await vi.waitFor(() => expect(accountEvents(events)).toHaveLength(1));

        const [event] = accountEvents(events);
        expect(event.kind === "notice" && event.account).toEqual(kept);
    });

    it("reads nothing kept when no store is given (the tests' sessions)", async () => {

        const { stream } = fakeStream({});
        const claude = build(stream);

        const events: AgentEvent[] = [];
        claude.on(event => events.push(event));

        await claude.send({ prompt: "hi" });
        await new Promise(resolve => setTimeout(resolve, 10));

        expect(accountEvents(events)).toEqual([]);
    });
});

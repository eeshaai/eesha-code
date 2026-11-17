import { describe, expect, it } from "vitest";

import type { Spend } from "../../../models/run";
import { ACP_EXTENSIONS } from "../acpExtensions";
import { kiroAccount, kiroCharges, kiroItems } from "../kiroShared";
import {
    KIRO_COMMANDS, KIRO_EXECUTE, KIRO_METADATA, askKiroContext, askKiroUsage, kiroContext, kiroV2Extension as kiroExtension,
    offersCommand, readKiroMetadata
} from "../kiroV2AcpExtension";

/*
 * Kiro's `_kiro.dev/metadata`, in the shapes observed on kiro-cli
 * 2.24.0: a context share on every message, and the credits on the
 * message that closes a turn. And `/context show`, run over
 * `_kiro.dev/commands/execute`, for the window's size and parts.
 */

function turn(requests: { method: string; params: unknown }[] = [], answer: unknown = undefined) {

    const charged: { spend: readonly Spend[]; note?: string }[] = [];
    const notes = new Map<string, unknown>();

    return {
        charged,
        requests,
        sessionId: "S1",
        charge: (spend: readonly Spend[], note?: string) => { charged.push({ spend, note }); },
        note: (key: string, value: unknown) => { notes.set(key, value); },
        noted: (key: string) => notes.get(key),
        request: async (method: string, params: unknown) => { requests.push({ method, params }); return answer; }
    };
}

/** Kiro's answer to `/context show`, as observed - the item lists trimmed, the totals as sent. */
const CONTEXT_SHOW = {
    success: true,
    message: "Context breakdown - 1% used",
    data: {
        model: "auto",
        contextUsagePercentage: 1.893799901008606,
        verbose: false,
        initialExpanded: true,
        breakdown: {
            contextFiles: {
                tokens: 1368,
                percent: 0.31037718057632446,
                items: [
                    { name: "AGENTS.md", tokens: 0, matched: false, percent: 0 },
                    { name: "README.md", tokens: 1368, matched: true, percent: 0.6840000152587891 }
                ]
            },
            tools: {
                tokens: 6979,
                percent: 1.5834225416183472,
                groups: [{
                    name: "Built-in",
                    source: "built-in",
                    tokens: 6979,
                    percent: 1.5834225416183472,
                    items: [
                        { name: "code", tokens: 671, percent: 0.15223908424377441 },
                        { name: "knowledge", tokens: 1166, percent: 0.26454660296440125 },
                        { name: "shell", tokens: 203, percent: 0.046057432889938354 }
                    ]
                }]
            },
            kiroResponses: { tokens: 122, percent: 0 },
            yourPrompts: { tokens: 0, percent: 0 },
            sessionFiles: { tokens: 0, percent: 0 }
        }
    }
};

/** Kiro's command list, as `_kiro.dev/commands/available` sends it - trimmed. */
const COMMANDS = { sessionId: "S1", commands: [{ name: "/agent" }, { name: "/context" }, { name: "/usage" }] };

/**
 * The same answer from a 1M-context model (claude-sonnet-5), totals as
 * sent. Its per-part percentages are on a 1M base, Kiro's own
 * percentage is not - and "Kiro responses" is on neither.
 */
const CONTEXT_SHOW_1M = {
    success: true,
    data: {
        model: "claude-sonnet-5",
        contextUsagePercentage: 2.073199987411499,
        breakdown: {
            contextFiles: { tokens: 1937, percent: 0.19370000064373016, items: [] },
            tools: { tokens: 6979, percent: 0.6978999972343445, groups: [] },
            kiroResponses: { tokens: 86, percent: 1.0926623344421387 },
            yourPrompts: { tokens: 7, percent: 0.08893761783838272 },
            sessionFiles: { tokens: 0, percent: 0 }
        }
    }
};

/** And from `auto` in a later run, where every base happened to agree: 200,000 exactly. */
const CONTEXT_SHOW_AUTO = {
    success: true,
    data: {
        model: "auto",
        contextUsagePercentage: 4.486999988555908,
        breakdown: {
            contextFiles: { tokens: 1937, percent: 0.968500018119812 },
            tools: { tokens: 6979, percent: 3.489499807357788 },
            kiroResponses: { tokens: 0, percent: 0 },
            yourPrompts: { tokens: 58, percent: 0.028999999165534973 },
            sessionFiles: { tokens: 0, percent: 0 }
        }
    }
};

describe("kiroContext", () => {

    it("adds the parts up for 'used', and works the size out from Kiro's own share", () => {

        const context = kiroContext(CONTEXT_SHOW)!;

        // 1368 + 6979 + 122 - plain counts.
        expect(context.used).toBe(8469);

        // 8469 tokens are 1.8938% of the window.
        expect(context.size).toBe(447196);
        expect(context.sizeEstimated).toBe(true);

        // Parts named for a reader; empty ones left out. What is inside
        // each comes with it, largest first.
        expect(context.parts).toEqual([
            {
                name: "Context files",
                tokens: 1368,
                items: [
                    { name: "README.md", tokens: 1368 },
                    { name: "AGENTS.md", tokens: 0, note: "not loaded" }
                ]
            },
            {
                name: "Tools",
                tokens: 6979,
                items: [
                    { name: "knowledge", tokens: 1166 },
                    { name: "code", tokens: 671 },
                    { name: "shell", tokens: 203 }
                ]
            },
            { name: "Kiro responses", tokens: 122 }
        ]);
    });

    /*
     * The case that breaks a rule going by the largest part's own percentage: it would say 1M here, while Kiro's bar says 2% of about 435k.
     */
    it("ignores per-part percentages, which are not on one base", () => {

        const context = kiroContext(CONTEXT_SHOW_1M)!;

        expect(context.used).toBe(9009);
        expect(context.size).toBe(434546);
        expect(Math.round((context.used / context.size) * 100)).toBe(2);
    });

    it("gets 200,000 where every base agreed", () => {

        expect(kiroContext(CONTEXT_SHOW_AUTO)).toMatchObject({ used: 8974, size: 200000 });
    });

    it("keeps an empty part that still names a file Kiro did not load", () => {

        const context = kiroContext({
            data: {
                contextUsagePercentage: 1,
                breakdown: {
                    tools: { tokens: 100, percent: 1 },
                    contextFiles: { tokens: 0, percent: 0, items: [{ name: "AGENTS.md", tokens: 0, matched: false }] }
                }
            }
        });

        expect(context?.parts?.find(part => part.name === "Context files"))
            .toEqual({ name: "Context files", tokens: 0, items: [{ name: "AGENTS.md", tokens: 0, note: "not loaded" }] });
    });

    it("names a part it does not know by splitting the key", () => {

        const context = kiroContext({ data: { contextUsagePercentage: 1, breakdown: { steeringRules: { tokens: 10 } } } });

        expect(context?.parts).toEqual([{ name: "Steering rules", tokens: 10 }]);
        expect(context?.size).toBe(1000);
    });

    it("works out no size from a share too small to trust, or from nothing used", () => {

        const breakdown = { tools: { tokens: 10 } };

        expect(kiroContext({ data: { contextUsagePercentage: 0.05, breakdown } })).toBeUndefined();
        expect(kiroContext({ data: { contextUsagePercentage: 0, breakdown } })).toBeUndefined();
        expect(kiroContext({ data: { breakdown } })).toBeUndefined();
        expect(kiroContext({ data: { contextUsagePercentage: 2, breakdown: { tools: { tokens: 0 } } } })).toBeUndefined();
    });

    it("is nothing for a failed command or a shape it does not know", () => {

        expect(kiroContext({ ...CONTEXT_SHOW, success: false })).toBeUndefined();
        expect(kiroContext({ success: true, data: {} })).toBeUndefined();
        expect(kiroContext(undefined)).toBeUndefined();
        expect(kiroContext("text")).toBeUndefined();
    });
});

describe("kiroItems", () => {

    it("prefixes each tool with its group when there is more than one group", () => {

        expect(kiroItems({
            groups: [
                { name: "Built-in", items: [{ name: "read", tokens: 540 }] },
                { name: "ado", items: [{ name: "read", tokens: 900 }] }
            ]
        })).toEqual([
            { name: "ado: read", tokens: 900 },
            { name: "Built-in: read", tokens: 540 }
        ]);
    });

    it("skips entries it cannot read, and is nothing when none are left", () => {

        expect(kiroItems({ items: [{ name: "a.md" }, { tokens: 3 }, null, { name: "b.md", tokens: 2 }] }))
            .toEqual([{ name: "b.md", tokens: 2 }]);
        expect(kiroItems({ items: [] })).toBeUndefined();
        expect(kiroItems({ tokens: 3 })).toBeUndefined();
        expect(kiroItems(undefined)).toBeUndefined();
    });
});

describe("askKiroContext", () => {

    it("asks only once Kiro's command list has named /context", async () => {

        const t = turn([], CONTEXT_SHOW);

        expect(await askKiroContext(t)).toBeUndefined();
        expect(t.requests).toEqual([]);

        kiroExtension.notifications![KIRO_COMMANDS](COMMANDS, t);

        const event = await askKiroContext(t);

        expect(t.requests).toEqual([{
            method: KIRO_EXECUTE,
            params: { sessionId: "S1", command: { command: "context", args: { subcommand: "show" } } }
        }]);

        expect(event).toMatchObject({
            name: KIRO_EXECUTE,
            kind: "notice",
            progress: true,
            text: "Context 2% of about 447k tokens used",
            context: { used: 8469, size: 447196, sizeEstimated: true }
        });
    });

    it("lets later metadata draw its share against the size it worked out", async () => {

        const t = turn([], CONTEXT_SHOW);

        kiroExtension.notifications![KIRO_COMMANDS](COMMANDS, t);
        await askKiroContext(t);

        expect(readKiroMetadata({ contextUsagePercentage: 10 }, t)).toMatchObject({
            text: "Context 10% of about 447k tokens used",
            context: { used: 44720, size: 447196, sizeEstimated: true }
        });
    });

    it("does not ask when the command list has no /context", async () => {

        const t = turn([], CONTEXT_SHOW);

        kiroExtension.notifications![KIRO_COMMANDS]({ commands: [{ name: "/agent" }] }, t);

        expect(await askKiroContext(t)).toBeUndefined();
        expect(t.requests).toEqual([]);
    });
});

describe("offersCommand", () => {

    it("reads the command list, whatever else is in it", () => {

        expect(offersCommand(COMMANDS, "/context")).toBe(true);
        expect(offersCommand(COMMANDS, "/usage")).toBe(true);
        expect(offersCommand({ commands: [null, { name: "/agent" }] }, "/context")).toBe(false);
        expect(offersCommand({}, "/context")).toBe(false);
        expect(offersCommand(undefined, "/usage")).toBe(false);
    });
});

/** Kiro's answer to `/usage`, as observed on kiro-cli 2.24.0 - the plan name was redacted there, a stand-in here. */
const USAGE = {
    success: true,
    message: "Estimated Usage | resets on 2026-10-01 | KIRO PRO",
    data: {
        planName: "KIRO PRO",
        billingCycleReset: "2026-10-01",
        overagesEnabled: true,
        isEnterprise: true,
        usageBreakdowns: [{
            resourceType: "CREDIT",
            displayName: "Credits",
            used: 1772.51,
            limit: 1000,
            percentage: 177.251,
            currentOverages: 772.51,
            overageRate: 0.04,
            overageCharges: 30.90067179068,
            currency: "USD",
            hasLimit: true
        }],
        bonusCredits: [],
        addOnCredits: [],
        overageCapable: true
    }
};

describe("kiroAccount", () => {

    it("turns every field Kiro sent into a row, in its order, money marked", () => {

        expect(kiroAccount(USAGE, 1000)).toEqual({
            account: {
                at: 1000,
                overLimit: true,
                rows: [
                    { key: "Plan", value: "KIRO PRO" },
                    { key: "Resets", value: "2026-10-01" },
                    { key: "Credits used", value: "1,773 of 1,000" },
                    { key: "Credits usage", value: "177%" },
                    { key: "Credits over the plan", value: "773" },
                    { key: "Overage rate", value: "$0.04 each", money: true },
                    { key: "Overage charge", value: "$30.90", money: true },
                    { key: "Overages allowed", value: "Yes" },
                    { key: "Managed by your organisation", value: "Yes" }
                ]
            },
            summary: "Account: Credits 1,773 of 1,000 (177%)"
        });
    });

    it("sends no row for a field Kiro left out, and says nothing is over a limit it does not have", () => {

        expect(kiroAccount({
            data: { usageBreakdowns: [{ displayName: "Credits", used: 5, limit: 0, hasLimit: false, currentOverages: 0 }] }
        }, 1)).toEqual({
            account: { at: 1, rows: [{ key: "Credits used", value: "5" }] },
            summary: "Account: Credits 5"
        });
    });

    it("is nothing for a failed command or a shape it does not know", () => {

        expect(kiroAccount({ ...USAGE, success: false })).toBeUndefined();
        expect(kiroAccount({ data: {} })).toBeUndefined();
        expect(kiroAccount({ data: { usageBreakdowns: [{ used: "lots" }] } })).toBeUndefined();
        expect(kiroAccount(undefined)).toBeUndefined();
    });
});

describe("askKiroUsage", () => {

    it("asks only once Kiro's command list has named /usage, and says it without money", async () => {

        const t = turn([], USAGE);

        expect(await askKiroUsage(t)).toBeUndefined();
        expect(t.requests).toEqual([]);

        kiroExtension.notifications![KIRO_COMMANDS](COMMANDS, t);

        const event = await askKiroUsage(t);

        expect(t.requests).toEqual([{
            method: KIRO_EXECUTE,
            params: { sessionId: "S1", command: { command: "usage", args: {} } }
        }]);

        expect(event).toMatchObject({
            kind: "notice",
            progress: true,
            text: "Account: Credits 1,773 of 1,000 (177%)",
            account: { overLimit: true, rows: expect.arrayContaining([{ key: "Plan", value: "KIRO PRO" }]) }
        });
    });
});

describe("the Kiro after-turn step", () => {

    it("returns the context and the account together, and one failing costs only its own", async () => {

        const t = turn();

        kiroExtension.notifications![KIRO_COMMANDS](COMMANDS, t);

        t.request = async (_method: string, params: unknown) => {

            if ((params as { command: { command: string } }).command.command === "context")
                throw new Error("gone");

            return USAGE;
        };

        const events = await kiroExtension.afterTurn!(t);

        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ account: { rows: expect.arrayContaining([{ key: "Plan", value: "KIRO PRO" }]) } });
    });
});

describe("readKiroMetadata", () => {

    it("turns the context share into a notice that replaces the last one, flagged as a share", () => {

        const t = turn();

        expect(readKiroMetadata({ sessionId: "s", contextUsagePercentage: 42.6, reasoning: {} }, t)).toMatchObject({
            name: KIRO_METADATA,
            kind: "notice",
            progress: true,
            text: "Context 43% used",
            context: { used: 42.6, size: 100, percentOnly: true }
        });

        expect(t.charged).toEqual([]);
    });

    it("charges the turn with the metering and its duration", () => {

        const t = turn();

        readKiroMetadata({
            contextUsagePercentage: 5,
            meteringUsage: [
                { value: 0.195, unit: "credit", unitPlural: "credits" },
                { value: 0.59, unit: "credit", unitPlural: "credits" }
            ],
            turnDurationMs: 30010
        }, t);

        expect(t.charged).toEqual([{ spend: [{ amount: expect.closeTo(0.785, 9), unit: "credits" }], note: "in 30.0s" }]);
    });

    it("keeps the share inside 0-100", () => {

        expect(readKiroMetadata({ contextUsagePercentage: 130 }, turn())).toMatchObject({ context: { used: 100 } });
        expect(readKiroMetadata({ contextUsagePercentage: -3 }, turn())).toMatchObject({ context: { used: 0 } });
    });

    it("says nothing, and does not throw, for shapes it does not know", () => {

        const t = turn();

        expect(readKiroMetadata(undefined, t)).toBeUndefined();
        expect(readKiroMetadata("text", t)).toBeUndefined();
        expect(readKiroMetadata({ contextUsagePercentage: "high", meteringUsage: "lots" }, t)).toBeUndefined();
        expect(t.charged).toEqual([]);
    });
});

describe("kiroCharges", () => {

    it("sums by unit, naming the unit by its plural", () => {

        expect(kiroCharges([
            { value: 1, unit: "credit", unitPlural: "credits" },
            { value: 2, unit: "credit", unitPlural: "credits" }
        ])).toEqual([{ amount: 3, unit: "credits" }]);
    });

    it("falls back to the singular, then to credits, and skips entries with no number", () => {

        expect(kiroCharges([{ value: 1, unit: "token" }])).toEqual([{ amount: 1, unit: "token" }]);
        expect(kiroCharges([{ value: 1 }])).toEqual([{ amount: 1, unit: "credits" }]);
        expect(kiroCharges([{ value: "1" }, null, { value: Number.NaN }])).toEqual([]);
        expect(kiroCharges(undefined)).toEqual([]);
    });
});

describe("ACP_EXTENSIONS", () => {

    it("has Kiro's v2 metadata reader under kiro-v2", () => {

        expect(KIRO_METADATA in (ACP_EXTENSIONS["kiro-v2"].notifications ?? {})).toBe(true);
    });
});

import { describe, expect, it } from "vitest";

import { kiroAccount, kiroCharges, kiroItems } from "../kiroShared";

describe("kiroItems", () => {

    it("lists context files and the tool totals, largest first", () => {

        expect(kiroItems({ items: [{ name: "a.md", tokens: 3, matched: false }], builtin: { tokens: 900 }, mcp: { tokens: 0 } }))
            .toEqual([{ name: "Built-in", tokens: 900 }, { name: "a.md", tokens: 3, note: "not loaded" }]);
    });

    it("skips entries it cannot read, and is nothing when none are left", () => {

        expect(kiroItems({ items: [{ name: "a.md" }, { tokens: 3 }, null, { name: "b.md", tokens: 2 }] }))
            .toEqual([{ name: "b.md", tokens: 2 }]);
        expect(kiroItems({ items: [] })).toBeUndefined();
        expect(kiroItems({ tokens: 3 })).toBeUndefined();
        expect(kiroItems(undefined)).toBeUndefined();
    });
});

/** Kiro's account usage answer, as observed - the plan name was redacted there, a stand-in here. */
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

describe("kiroCharges", () => {

    it("sums by unit, naming the unit by its plural", () => {

        expect(kiroCharges([
            { usage: 1, unit: "credit", unitPlural: "credits" },
            { usage: 2, unit: "credit", unitPlural: "credits" }
        ])).toEqual([{ amount: 3, unit: "credits" }]);
    });

    it("falls back to the singular, then to credits, and skips entries with no number", () => {

        expect(kiroCharges([{ usage: 1, unit: "token" }])).toEqual([{ amount: 1, unit: "token" }]);
        expect(kiroCharges([{ usage: 1 }])).toEqual([{ amount: 1, unit: "credits" }]);
        expect(kiroCharges([{ usage: "1" }, null, { usage: Number.NaN }])).toEqual([]);
        expect(kiroCharges(undefined)).toEqual([]);
    });
});

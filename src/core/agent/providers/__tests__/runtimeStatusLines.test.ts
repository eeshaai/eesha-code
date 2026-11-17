import { describe, expect, it } from "vitest";

import { ClaudeEventTranslator, claudeMcpText } from "../ClaudeProvider";
import { copilotAccount, CopilotEventTranslator } from "../CopilotProvider";

/*
 * Claude's MCP line, and ghcp's chat title and account allowance - the
 * same things Kiro v3 shows, from each SDK's own events.
 */

const copilotEvent = (type: string, data: unknown) =>
    ({ type, data, id: "e1", parentId: null, timestamp: "2026-09-29T00:00:00Z" }) as never;

describe("CopilotEventTranslator", () => {

    it("carries Copilot's own title, so the chat history names the row with it", () => {

        const event = new CopilotEventTranslator(() => 0).translate(copilotEvent("session.title_changed", { title: " Fix the login bug " }));

        expect(event).toMatchObject({ kind: "notice", text: "Title: Fix the login bug", title: "Fix the login bug" });
    });
});

describe("claudeMcpText", () => {

    it("names every server and how it stands, on one line", () => {

        expect(claudeMcpText([
            { name: "ado", status: "connected" },
            { name: "github", status: "needs-auth" },
            { name: "x", status: "something-new" }
        ])).toBe("MCP: ado connected · github needs sign-in · x something-new");
        expect(claudeMcpText([])).toBeUndefined();
    });
});

describe("ClaudeEventTranslator init", () => {

    const init = (servers: unknown[]) => ({
        type: "system", subtype: "init", session_id: "s", model: "m", apiKeySource: "none", tools: [], mcp_servers: servers
    }) as never;

    it("shows the MCP line once, and again only when it changed", () => {

        const translator = new ClaudeEventTranslator(() => 0);
        const texts = (servers: unknown[]) => translator.translate(init(servers))
            .map(event => (event as { text?: string }).text)
            .filter(text => text?.startsWith("MCP:"));

        expect(texts([{ name: "ado", status: "connected" }])).toEqual(["MCP: ado connected"]);
        expect(texts([{ name: "ado", status: "connected" }])).toEqual([]);
        expect(texts([{ name: "ado", status: "failed" }])).toEqual(["MCP: ado failed"]);
    });
});

describe("copilotAccount", () => {

    /** What `account.getQuota` returned (CLI 1.0.85, no model call). */
    const quota = {
        quotaSnapshots: {
            chat: {
                isUnlimitedEntitlement: false, entitlementRequests: 200, usedRequests: 1, overage: 0,
                remainingPercentage: 99.5, resetDate: "2026-10-01T00:00:00.000Z", hasQuota: true
            },
            completions: {
                isUnlimitedEntitlement: false, entitlementRequests: 2000, usedRequests: 468, overage: 0,
                remainingPercentage: 76.6, resetDate: "2026-10-01T00:00:00.000Z", hasQuota: true
            },
            premium_interactions: {
                isUnlimitedEntitlement: false, entitlementRequests: 0, usedRequests: 0, overage: 0,
                remainingPercentage: 0, resetDate: "2026-10-01T00:00:00.000Z", hasQuota: false
            }
        }
    };

    it("shows each allowance the account has, and when they reset", () => {

        expect(copilotAccount(quota, 5)).toEqual({
            account: {
                at: 5,
                rows: [
                    { key: "Chat requests", value: "1 of 200 used, 100% left" },
                    { key: "Code completions", value: "468 of 2000 used, 77% left" },
                    { key: "Resets", value: "2026-10-01" }
                ]
            },
            summary: "Copilot account: chat requests 1 of 200 used, 100% left; code completions 468 of 2000 used, 77% left"
        });
    });

    it("marks the meter when an allowance is used up, and says Unlimited for one without a limit", () => {

        const found = copilotAccount({
            quotaSnapshots: {
                chat: { isUnlimitedEntitlement: true },
                premium_interactions: { hasQuota: true, entitlementRequests: 300, usedRequests: 312, overage: 12, remainingPercentage: 0 }
            }
        }, 1);

        expect(found?.account.overLimit).toBe(true);
        expect(found?.account.rows).toEqual([
            { key: "Chat requests", value: "Unlimited" },
            { key: "Premium requests", value: "312 of 300 used, 0% left, 12 over" }
        ]);
    });

    it("leaves premium requests out under hideCopilotPremiumRequests, and says nothing for an answer it cannot read", () => {

        expect(copilotAccount({
            quotaSnapshots: { premium_interactions: { hasQuota: true, entitlementRequests: 300, usedRequests: 1, remainingPercentage: 99 } }
        }, 1, true)).toBeUndefined();
        expect(copilotAccount(undefined, 1)).toBeUndefined();
    });
});

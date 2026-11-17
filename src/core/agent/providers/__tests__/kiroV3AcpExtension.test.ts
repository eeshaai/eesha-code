import { describe, expect, it } from "vitest";

import type { Spend } from "../../../models/run";
import { ACP_EXTENSIONS } from "../acpExtensions";
import { KIRO_V3_INFO, KIRO_V3_MCP_GOVERNANCE, KIRO_V3_MCP_STATUS, KIRO_V3_MODE_NOT_FOUND, KIRO_V3_RATE_LIMIT, KIRO_V3_SYSTEM_NOTIFY, KIRO_V3_USAGE, askKiroV3Usage, kiroV3Extension, compactKiroV3, KIRO_V3_COMPACT, kiroV3FallbackText, kiroV3GovernanceText, kiroV3McpList, kiroV3McpText, kiroV3ModeNotFoundText, kiroV3QueuedText, kiroV3RateLimitText, kiroV3SystemText, kiroV3TurnApproval, readKiroV3Info, readKiroV3McpGovernance, readKiroV3McpStatus } from "../kiroV3AcpExtension";

/*
 * Kiro's v3 engine (KAS 0.66.8), in the shapes observed: its credits
 * and context share ride on standard `session_info_update`s, told apart
 * by `_meta.kiro.kind`.
 */

function turn(answer?: () => Promise<unknown>) {

    const charged: { spend: readonly Spend[]; note?: string }[] = [];
    const notes = new Map<string, unknown>();
    const requests: { method: string; params: unknown }[] = [];

    return {
        charged,
        requests,
        sessionId: "S2",
        charge: (spend: readonly Spend[], note?: string) => { charged.push({ spend, note }); },
        note: (key: string, value: unknown) => { notes.set(key, value); },
        noted: (key: string) => notes.get(key),
        request: async (method: string, params: unknown) => {
            requests.push({ method, params });
            return answer ? answer() : undefined;
        }
    };
}

/** `session_info_update` wrapping Kiro's `_meta`, as the engine sends it. */
function info(kiro: Record<string, unknown>) {

    return { sessionUpdate: "session_info_update", _meta: { kiro } };
}

/** A `context_usage` with its breakdown, as observed after the first turn. */
const CONTEXT_WITH_BREAKDOWN = info({
    contextUsage: { usagePercentage: 2.447999954223633 },
    breakdown: {
        contextFiles: { tokens: 0, percent: 0, items: [] },
        tools: { tokens: 4809, percent: 0.5, mcp: { tokens: 0, percent: 0 }, builtin: { tokens: 4809, percent: 0.5 } },
        kiroResponses: { tokens: 53, percent: 1.9 },
        yourPrompts: { tokens: 1, percent: 0 },
        sessionFiles: { tokens: 0, percent: 0, items: [] }
    },
    kind: "context_usage",
    usagePercentage: 2.447999954223633
});

describe("readKiroV3Info", () => {

    it("gives Kiro's own share with the parts' tokens, and no window size", () => {

        expect(readKiroV3Info(CONTEXT_WITH_BREAKDOWN, turn())).toMatchObject({
            name: KIRO_V3_INFO,
            kind: "notice",
            progress: true,
            text: "Context 2% used",
            context: {
                used: 2.447999954223633,
                size: 100,
                percentOnly: true,
                parts: [
                    { name: "Tools", tokens: 4809, items: [{ name: "Built-in", tokens: 4809 }] },
                    { name: "Kiro responses", tokens: 53 },
                    { name: "Your prompts", tokens: 1 }
                ]
            }
        });
    });

    it("keeps the last breakdown on an update that carries only the share", () => {

        const t = turn();

        readKiroV3Info(CONTEXT_WITH_BREAKDOWN, t);

        const event = readKiroV3Info(info({
            contextUsage: { usagePercentage: 2.606800079345703 },
            kind: "context_usage",
            usagePercentage: 2.606800079345703
        }), t);

        expect(event).toMatchObject({ text: "Context 3% used", context: { used: 2.606800079345703, percentOnly: true } });
        expect((event as { context: { parts: unknown[] } }).context.parts).toHaveLength(3);
    });

    it("charges the turn from its completion, with how long it took", () => {

        const t = turn();

        expect(readKiroV3Info(info({
            promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.08464739469320066 }],
            elapsedTime: 4467,
            status: "success",
            kind: "turn_completion",
            requestIds: ["r1"]
        }), t)).toBeUndefined();

        expect(t.charged).toEqual([{ spend: [{ amount: 0.08464739469320066, unit: "credits" }], note: "in 4.5s" }]);
    });

    it("skips a replayed turn, so resuming never charges twice", () => {

        const t = turn();

        expect(readKiroV3Info(info({
            promptTurnSummaries: [{ unit: "credit", unitPlural: "credits", usage: 0.08 }],
            kind: "turn_completion",
            replay: true
        }), t)).toBeUndefined();

        expect(readKiroV3Info(info({ kind: "context_usage", usagePercentage: 2, replay: true }), t)).toBeUndefined();
        expect(t.charged).toEqual([]);
    });

    it("leaves every other kind alone, and does not throw on shapes it does not know", () => {

        const t = turn();

        expect(readKiroV3Info(info({ kind: "turn_start", turnStart: true }), t)).toBeUndefined();
        expect(readKiroV3Info(info({ kind: "focus_update", status: "idle" }), t)).toBeUndefined();
        expect(readKiroV3Info({ sessionUpdate: "session_info_update", title: "Hi" }, t)).toBeUndefined();
        expect(readKiroV3Info(info({ kind: "context_usage", usagePercentage: "high" }), t)).toBeUndefined();
        expect(readKiroV3Info(undefined, t)).toBeUndefined();
        expect(t.charged).toEqual([]);
    });
});

/** `_kiro/account/getUsage`'s answer, as observed - the plan name redacted there, a stand-in here. */
const GET_USAGE = {
    success: true,
    message: "Plan: KIRO PRO | 1 usage breakdowns",
    data: {
        planName: "KIRO PRO",
        billingCycleReset: "2026-10-01",
        overagesEnabled: true,
        isEnterprise: true,
        usageBreakdowns: [{
            resourceType: "CREDIT", displayName: "Credits", used: 1773.85, limit: 1000, percentage: 177,
            currentOverages: 773.85, overageRate: 0.04, overageCharges: 30.954089757124, currency: "USD", hasLimit: true
        }],
        bonusCredits: [],
        addOnCredits: [],
        overageCapable: true
    }
};

describe("askKiroV3Usage", () => {

    it("asks for the account's usage and reports it without money", async () => {

        const t = turn(async () => GET_USAGE);

        const event = await askKiroV3Usage(t);

        expect(t.requests).toEqual([{ method: KIRO_V3_USAGE, params: { sessionId: "S2" } }]);

        expect(event).toMatchObject({
            kind: "notice",
            text: "Account: Credits 1,774 of 1,000 (177%)",
            account: {
                overLimit: true,
                rows: expect.arrayContaining([
                    { key: "Plan", value: "KIRO PRO" },
                    { key: "Resets", value: "2026-10-01" },
                    { key: "Credits used", value: "1,774 of 1,000" }
                ])
            }
        });
    });

    it("stops asking once the engine says it has no such method", async () => {

        const t = turn(async () => { throw Object.assign(new Error("Method not found"), { code: -32601 }); });

        expect(await askKiroV3Usage(t)).toBeUndefined();
        expect(await askKiroV3Usage(t)).toBeUndefined();

        expect(t.requests).toHaveLength(1);
    });

    it("asks again after any other failure", async () => {

        const t = turn(async () => { throw Object.assign(new Error("Internal error"), { code: -32603 }); });

        await askKiroV3Usage(t);
        await askKiroV3Usage(t);

        expect(t.requests).toHaveLength(2);
    });
});

describe("the kiro-v3 extension", () => {

    it("is registered under kiro-v3, reads session_info_update, its MCP status, MCP governance and warnings, and nothing on v2's channels", () => {

        expect(ACP_EXTENSIONS["kiro-v3"]).toBe(kiroV3Extension);
        expect(Object.keys(kiroV3Extension.updates ?? {})).toEqual([KIRO_V3_INFO]);
        expect(Object.keys(kiroV3Extension.notifications ?? {})).toEqual([
            KIRO_V3_MCP_STATUS, KIRO_V3_MCP_GOVERNANCE, KIRO_V3_SYSTEM_NOTIFY, KIRO_V3_RATE_LIMIT, KIRO_V3_MODE_NOT_FOUND, "_kiro/customAgent/config_error"
        ]);
        expect(Object.keys(kiroV3Extension.notifications ?? {}).some(method => method.startsWith("_kiro.dev/"))).toBe(false);
    });

    it("asks for the account at the start too", async () => {

        const t = turn(async () => GET_USAGE);

        expect(await kiroV3Extension.atStart!(t)).toHaveLength(1);
        expect(t.requests).toEqual([{ method: KIRO_V3_USAGE, params: { sessionId: "S2" } }]);
    });

    it("returns the account after a turn, or nothing", async () => {

        expect(await kiroV3Extension.afterTurn!(turn(async () => GET_USAGE))).toHaveLength(1);
        expect(await kiroV3Extension.afterTurn!(turn(async () => ({ success: false })))).toEqual([]);
    });
});

/*
 * `_kiro/mcp/status`, in the shapes kiro-cli 2.24.1 sent live for two MCP
 * servers that could not start: "connecting" twice, then "failed" one by
 * one with "Connection closed".
 */
const server = (name: string, status: string, extra: Record<string, unknown> = {}) => ({ name, status, ...extra });

const CONNECTING = { sessionId: "S2", servers: [server("broken", "connecting"), server("echo", "connecting")] };
const HALF = { sessionId: "S2", servers: [server("broken", "failed", { failedAuthorization: false, errorMessage: "Connection closed" }), server("echo", "connecting")] };
const FAILED = {
    sessionId: "S2",
    servers: [
        server("broken", "failed", { failedAuthorization: false, errorMessage: "Connection closed" }),
        server("echo", "failed", { failedAuthorization: false, errorMessage: "Connection closed" })
    ]
};

describe("kiroV3McpText", () => {

    it("says nothing while a server is still connecting", () => {

        expect(kiroV3McpText(CONNECTING)).toBeUndefined();
        expect(kiroV3McpText(HALF)).toBeUndefined();
    });

    it("names each server's state on one line, with the reason a failed one gave", () => {

        expect(kiroV3McpText(FAILED)).toBe("MCP: broken failed - Connection closed · echo failed - Connection closed");
    });

    it("counts a connected server's tools, and says when one needs a sign-in or is off", () => {

        expect(kiroV3McpText({
            servers: [
                server("ado", "connected", { tools: [{ name: "a" }, { name: "b" }] }),
                server("github", "failed", { failedAuthorization: true, authorizationUrl: "https://example.test/auth" }),
                server("jira", "disabled")
            ]
        })).toBe("MCP: ado connected (2 tools) · github failed - needs sign-in at https://example.test/auth · jira turned off");
    });

    it("names the servers the org's policy kept out", () => {

        expect(kiroV3McpText({ servers: [], accessModeFilteredServers: ["slack"], unresolvedRegistryServers: [{ name: "figma" }] }))
            .toBe("MCP: kept out by your org's MCP policy: slack, figma");
    });

    it("is nothing with no servers, and never throws on a shape it does not know", () => {

        expect(kiroV3McpText({ servers: [] })).toBeUndefined();
        expect(kiroV3McpText(undefined)).toBeUndefined();
        expect(kiroV3McpText({ servers: "nope" })).toBeUndefined();
    });
});

describe("readKiroV3McpStatus", () => {

    it("holds the line until the first message, then shows it once", async () => {

        const session = turn();

        expect(readKiroV3McpStatus(CONNECTING, session)).toBeUndefined();
        expect(readKiroV3McpStatus(FAILED, session)).toBeUndefined();

        const atStart = await kiroV3Extension.atStart!(session);

        expect(atStart.find(event => event.name === KIRO_V3_MCP_STATUS)).toMatchObject({
            kind: "notice", text: "MCP: broken failed - Connection closed · echo failed - Connection closed"
        });

        // The same state again says nothing.
        expect(readKiroV3McpStatus(FAILED, session)).toBeUndefined();
    });

    it("shows a change after the first message as it comes", async () => {

        const session = turn();

        await kiroV3Extension.atStart!(session);

        expect(readKiroV3McpStatus({ servers: [server("ado", "connected", { tools: [] })] }, session))
            .toMatchObject({ name: KIRO_V3_MCP_STATUS, text: "MCP: ado connected (0 tools)" });
    });

    it("carries the servers as data on the line it shows, held one too", async () => {

        const session = turn();

        readKiroV3McpStatus(FAILED, session);

        const atStart = await kiroV3Extension.atStart!(session);

        expect(atStart.find(event => event.name === KIRO_V3_MCP_STATUS)).toMatchObject({
            mcp: [
                { name: "broken", status: "failed", reason: "Connection closed" },
                { name: "echo", status: "failed", reason: "Connection closed" }
            ]
        });

        expect(readKiroV3McpStatus({ servers: [server("ado", "connected", { tools: [{}, {}] })] }, session))
            .toMatchObject({ mcp: [{ name: "ado", status: "connected", tools: 2 }] });
    });

    it("adds nothing at the start when no MCP status came", async () => {

        const atStart = await kiroV3Extension.atStart!(turn());

        expect(atStart.some(event => event.name === KIRO_V3_MCP_STATUS)).toBe(false);
    });
});

describe("kiroV3McpList", () => {

    it("lists each named server with its status, tool count, reason and sign-in need", () => {

        expect(kiroV3McpList({
            servers: [
                server("ado", "connected", { tools: [{}, {}, {}] }),
                server("github", "failed", { failedAuthorization: true, authorizationUrl: "https://x" }),
                server("broken", "failed", { errorMessage: "  Connection\n closed " }),
                server("off", "disabled"),
                server("slow", "connecting"),
                { status: "connected" },
                { name: "nostatus" }
            ]
        })).toEqual([
            { name: "ado", status: "connected", tools: 3 },
            { name: "github", status: "failed", needsSignIn: true },
            { name: "broken", status: "failed", reason: "Connection closed" },
            { name: "off", status: "disabled" },
            { name: "slow", status: "connecting" }
        ]);
    });

    it("is empty when there is no server list", () => {

        expect(kiroV3McpList(undefined)).toEqual([]);
        expect(kiroV3McpList({ servers: "no" })).toEqual([]);
    });
});

/* `_kiro/mcp/governance_disabled`, in the shape KAS 2.24.1's own code sends: `{ sessionId, reason }`. */
describe("readKiroV3McpGovernance", () => {

    it("names each known reason in plain words, and an unknown one as sent", () => {

        expect(kiroV3GovernanceText({ sessionId: "S2", reason: "admin_disabled" })).toBe(
            "MCP: off - your org's Kiro admin turned MCP off. No MCP server was started, "
            + "including the ones sent from settings.json (reason: admin_disabled).");
        expect(kiroV3GovernanceText({ reason: "api_failure" }))
            .toContain("Kiro could not read your org's Kiro settings, so it turned MCP off to be safe");
        expect(kiroV3GovernanceText({ reason: "something_new" })).toContain("(reason: something_new)");
        expect(kiroV3GovernanceText(undefined)).toBe(
            "MCP: off - your org's Kiro settings turned MCP off. No MCP server was started, "
            + "including the ones sent from settings.json.");
    });

    it("holds the line until the first message, shows it before the status line, and only once", async () => {

        const session = turn();

        expect(readKiroV3McpGovernance({ reason: "admin_disabled" }, session)).toBeUndefined();
        expect(readKiroV3McpStatus(FAILED, session)).toBeUndefined();

        const atStart = await kiroV3Extension.atStart!(session);

        expect(atStart.map(event => event.name).slice(0, 2)).toEqual([KIRO_V3_MCP_GOVERNANCE, KIRO_V3_MCP_STATUS]);
        expect(atStart[0]).toMatchObject({ kind: "notice", text: expect.stringContaining("(reason: admin_disabled)") });

        expect(readKiroV3McpGovernance({ reason: "admin_disabled" }, session)).toBeUndefined();
    });

    it("shows one that comes after the first message straight away", async () => {

        const session = turn();

        await kiroV3Extension.atStart!(session);

        expect(readKiroV3McpGovernance({ reason: "api_failure" }, session))
            .toMatchObject({ name: KIRO_V3_MCP_GOVERNANCE, kind: "notice" });
    });

});

/*
 * Kiro's warnings, in the shapes KAS 0.66.70's own code (kiro-cli 3.0.0)
 * sends. None was observed: each needs a real turn, which costs credits.
 */
describe("Kiro v3 warnings", () => {

    const notify = (method: string, params: unknown, session: ReturnType<typeof turn>) =>
        kiroV3Extension.notifications![method](params, session);

    it("words Kiro's own notices by level", () => {

        expect(kiroV3SystemText({ level: "info", message: "Model \"claude-opus-4.5\" isn't available for the current account. Switched to Auto." }))
            .toBe("Kiro: Model \"claude-opus-4.5\" isn't available for the current account. Switched to Auto.");
        expect(kiroV3SystemText({ level: "warning", message: "MCP servers ado, github are still connecting." }))
            .toBe("Kiro warning: MCP servers ado, github are still connecting.");
        expect(kiroV3SystemText({ level: "error", message: "  broken\n  thing " })).toBe("Kiro error: broken thing");
        expect(kiroV3SystemText({ level: "warning", message: "" })).toBeUndefined();
        expect(kiroV3SystemText(undefined)).toBeUndefined();
    });

    it("says a rate limit is Kiro being overloaded, with Kiro's message when it gave one", () => {

        expect(kiroV3RateLimitText({ sessionId: "S2", message: "Too many requests." }))
            .toBe("Kiro is overloaded - the model has no capacity right now: Too many requests.");
        expect(kiroV3RateLimitText({ sessionId: "S2" })).toBe("Kiro is overloaded - the model has no capacity right now.");
    });

    it("names the mode Kiro does not have, what it runs instead, and the agent file it skipped", () => {

        expect(kiroV3ModeNotFoundText({ sessionId: "S2", requestedAgent: "reviewer", fallbackAgent: "vibe" }))
            .toBe("Kiro has no mode \"reviewer\" - it runs in Default mode instead.");
        expect(kiroV3ModeNotFoundText({
            requestedAgent: "reviewer",
            fallbackAgent: "vibe",
            skipped: { path: "C:/x/.kiro/agents/reviewer.json", reasonCode: "parse_error", error: "Unexpected token" }
        })).toBe("Kiro has no mode \"reviewer\" - it runs in Default mode instead. "
            + "Its agent file was skipped (C:/x/.kiro/agents/reviewer.json): Unexpected token.");
        expect(kiroV3ModeNotFoundText({ requestedAgent: "reviewer", fallbackAgent: "plan", skipped: { reasonCode: "gated" } }))
            .toBe("Kiro has no mode \"reviewer\" - it runs in plan mode instead. Its agent file was skipped: gated.");
        expect(kiroV3ModeNotFoundText({ fallbackAgent: "vibe" })).toBeUndefined();
    });

    it("says which model Kiro switched to mid-turn, or why it could not", () => {

        expect(kiroV3FallbackText({ kind: "model_fallback", from: "claude-sonnet-4.5", to: "auto", scope: "turn", trigger: "availability" }))
            .toBe("Kiro switched the model from claude-sonnet-4.5 to auto for this turn - it was not available.");
        expect(kiroV3FallbackText({ from: "glm-5", to: "auto", trigger: "refusal" }))
            .toBe("Kiro switched the model from glm-5 to auto - it refused the request.");
        expect(kiroV3FallbackText({ from: "glm-5", trigger: "availability", reason: "chainExhausted" }))
            .toBe("Kiro could not switch away from glm-5 after it was not available - every other model was already tried (reason: chainExhausted).");
        expect(kiroV3FallbackText({ from: "glm-5", trigger: "availability", reason: "raceLost" }))
            .toBe("Kiro could not switch away from glm-5 after it was not available (reason: raceLost).");
    });

    it("says a turn is waiting for another session", () => {

        expect(kiroV3QueuedText({ kind: "queued", activeSessionId: "sess_1" }))
            .toBe("Waiting - Kiro is busy with another session (sess_1). This turn starts when that one ends.");
        expect(kiroV3QueuedText({})).toBe("Waiting - Kiro is busy with another session. This turn starts when that one ends.");
    });

    it("reads model_fallback and queued off session_info_update once the session has started, and skips a replay", async () => {

        const session = turn();

        await kiroV3Extension.atStart!(session);

        expect(readKiroV3Info(info({ kind: "model_fallback", from: "glm-5", to: "auto", trigger: "availability" }), session))
            .toMatchObject({ name: KIRO_V3_INFO, kind: "notice", text: expect.stringContaining("from glm-5 to auto") });
        expect(readKiroV3Info(info({ kind: "queued", activeSessionId: "sess_1" }), session))
            .toMatchObject({ kind: "notice", text: expect.stringContaining("sess_1") });
        expect(readKiroV3Info(info({ kind: "queued", replay: true }), session)).toBeUndefined();
    });

    it("shows a warning after the first message at once, and not as a heartbeat", async () => {

        const session = turn();

        await kiroV3Extension.atStart!(session);

        const event = notify(KIRO_V3_RATE_LIMIT, { sessionId: "S2", message: "Busy." }, session);

        expect(event).toMatchObject({ name: KIRO_V3_RATE_LIMIT, kind: "notice", text: expect.stringContaining("overloaded") });
        expect((event as { progress?: boolean }).progress).toBeUndefined();
    });

    it("holds warnings from before the first message and shows them at the start, in order, after the MCP line and only once", async () => {

        const session = turn();

        expect(notify(KIRO_V3_MODE_NOT_FOUND, { requestedAgent: "reviewer", fallbackAgent: "vibe" }, session)).toBeUndefined();
        expect(readKiroV3McpStatus(FAILED, session)).toBeUndefined();
        expect(notify(KIRO_V3_SYSTEM_NOTIFY, { level: "info", message: "Switched to Auto." }, session)).toBeUndefined();
        expect(notify(KIRO_V3_SYSTEM_NOTIFY, { level: "info", message: "" }, session)).toBeUndefined();

        const atStart = await kiroV3Extension.atStart!(session);

        expect(atStart.map(event => event.name)).toEqual([KIRO_V3_MCP_STATUS, KIRO_V3_MODE_NOT_FOUND, KIRO_V3_SYSTEM_NOTIFY]);
        expect(atStart[2]).toMatchObject({ kind: "notice", text: "Kiro: Switched to Auto." });

        expect(await kiroV3Extension.atStart!(session)).toEqual([]);
    });
});

/* The end-of-turn "Review changes" request, as kiro-cli 2.24.1 sent it live with Autopilot off. */
describe("kiroV3TurnApproval", () => {

    const REVIEW = {
        sessionId: "S2",
        toolCall: { toolCallId: "turn_approval_1", status: "pending", title: "Review changes" },
        options: [
            { optionId: "accept", name: "Accept changes", kind: "allow_once" },
            { optionId: "reject", name: "Reject changes", kind: "reject_once" }
        ],
        _meta: { kiro: { type: "turn_approval", executionId: "e1", files: [{ path: "C:\\repo\\src\\probe.txt", toolCallId: "tooluse_1" }] } }
    };

    it("accepts it, naming the files, and hands the files over for the folder check", () => {

        expect(kiroV3TurnApproval(REVIEW)).toEqual({
            optionId: "accept",
            paths: ["C:\\repo\\src\\probe.txt"],
            line: "Kiro asked to review this turn's changes (probe.txt) - accepted, since each change was already allowed when it was made."
        });
    });

    it("leaves every other request alone", () => {

        expect(kiroV3TurnApproval({ ...REVIEW, _meta: { kiro: { toolId: "fs_write" } } })).toBeUndefined();
        expect(kiroV3TurnApproval({ ...REVIEW, options: [{ optionId: "reject", kind: "reject_once" }] })).toBeUndefined();
        expect(kiroV3TurnApproval(undefined)).toBeUndefined();
    });
});

/* `_kiro/session/compact`: `{ sessionId }` in, `{ success }` out - read from KAS 2.24.1's code. */
describe("compactKiroV3", () => {

    it("asks Kiro to compact this session, and says it worked", async () => {

        const session = turn(async () => ({ success: true }));

        expect(await compactKiroV3(session)).toEqual({ ok: true });
        expect(session.requests).toEqual([{ method: KIRO_V3_COMPACT, params: { sessionId: "S2" } }]);
    });

    it("says why when Kiro declines or fails", async () => {

        expect(await compactKiroV3(turn(async () => ({ success: false }))))
            .toMatchObject({ ok: false, reason: expect.stringContaining("busy with a turn") });

        expect(await compactKiroV3(turn(async () => { throw new Error("session_not_found"); })))
            .toEqual({ ok: false, reason: "Kiro could not compact: session_not_found" });
    });

    it("is what the kiro-v3 extension compacts with", () => {

        expect(kiroV3Extension.compact).toBeDefined();
    });
});
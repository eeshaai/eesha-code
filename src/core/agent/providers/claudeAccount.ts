import type { AccountInfo, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";

import type { AccountRow, AccountUsage } from "../../models/run";
import type { AgentEvent } from "../AgentSession";

/**
 * Claude's account for the Account section of the Session panel - the
 * same figures as the CLI's `/status` (who is signed in, which plan) and
 * `/usage` (how much of each plan limit is used, and when it resets).
 *
 * Both come from the SDK as control requests to the CLI, not model
 * calls, so they cost no tokens:
 *
 *   - `accountInfo()` - email, organization, plan, sign-in type.
 *   - `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` - the
 *     plan limits. The SDK marks it as one that may change or go away in
 *     any release. If it does, the limit rows are simply missing and the
 *     account rows still show.
 *
 * Only the `claude` runtime asks: it holds its own session. The
 * `claude-cli` runtime runs through claude-agent-acp, which has no ACP
 * request for any of this (0.73.0), so its Account section stays empty.
 * A side Claude session could ask, but that is a second CLI process
 * kept running - so it is not done.
 */

/** What a Claude query can be asked here - the real `Query`, or a stand-in in tests. */
export interface ClaudeAccountSource {

    accountInfo?(): Promise<AccountInfo>;

    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?(opts?: { skipBehaviors?: boolean }): Promise<SDKControlGetUsageResponse>;
}

/** How long each of the two requests may take before it is given up. */
export const ACCOUNT_READ_TIMEOUT_MS = 5000;

/**
 * Asks a Claude query for the account and the plan limits and turns the
 * answers into rows. Each request is on its own: one that fails or times
 * out leaves its rows out, not the other's. Never throws. Undefined when
 * neither gave anything to show.
 */
export async function readClaudeAccount(
    source: ClaudeAccountSource,
    at: () => number = Date.now,
    timeoutMs: number = ACCOUNT_READ_TIMEOUT_MS
): Promise<{ account: AccountUsage; summary: string } | undefined> {

    const [info, usage] = await Promise.all([
        source.accountInfo
            ? withTimeout(source.accountInfo(), timeoutMs).catch(() => undefined)
            : undefined,

        // `skipBehaviors`: the plan limits only. Without it the CLI reads
        // every transcript touched in the last seven days to fill a
        // section this panel does not show.
        source.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
            ? withTimeout(source.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timeoutMs).catch(() => undefined)
            : undefined
    ]);

    return claudeAccount(info, usage, at());
}

/**
 * The account and plan limits as rows, in the order `/status` and
 * `/usage` show them. Past a limit (100% used), the meter gets its
 * warning mark. Undefined when there is nothing to show.
 *
 * Exported for tests.
 */
export function claudeAccount(
    info: AccountInfo | undefined,
    usage: SDKControlGetUsageResponse | undefined,
    at: number
): { account: AccountUsage; summary: string } | undefined {

    const rows: AccountRow[] = [];
    const summary: string[] = [];

    const plan = planName(usage?.subscription_type ?? info?.subscriptionType);

    if (plan) {

        rows.push({ key: "Plan", value: plan });
        summary.push(plan);
    }

    if (text(info?.email))
        rows.push({ key: "Signed in as", value: text(info?.email)! });

    if (text(info?.organization))
        rows.push({ key: "Organization", value: text(info?.organization)! });

    const through = signInWay(info);

    if (through)
        rows.push({ key: "Through", value: through });

    let overLimit = false;

    const limits = usage?.rate_limits_available ? usage.rate_limits : undefined;

    if (limits) {

        const windows: [string, LimitWindow | null | undefined][] = [
            ["5-hour limit", limits.five_hour],
            ["Weekly limit", limits.seven_day],
            ["Weekly Opus", limits.seven_day_opus],
            ["Weekly Sonnet", limits.seven_day_sonnet],
            ...(limits.model_scoped ?? []).map(one => [`Weekly ${one.display_name}`, one] as [string, LimitWindow])
        ];

        for (const [name, window] of windows) {

            if (!window || typeof window.utilization !== "number")
                continue;

            const used = Math.round(window.utilization);
            const resets = when(window.resets_at);

            rows.push({ key: name, value: `${used}% used${resets ? `, resets ${resets}` : ""}` });
            summary.push(`${name.toLowerCase()} ${used}% used`);

            if (window.utilization >= 100)
                overLimit = true;
        }

        const extra = limits.extra_usage;

        // On or off, and how much of its monthly cap is gone. Its money
        // figures are left out: the answer does not say what unit they
        // are in, and a wrong amount is worse than none.
        if (extra)
            rows.push({
                key: "Extra usage",
                value: extra.is_enabled
                    ? `On${typeof extra.utilization === "number" ? `, ${Math.round(extra.utilization)}% of monthly cap used` : ""}`
                    : "Off"
            });
    }

    if (!rows.length)
        return undefined;

    return {
        account: { at, rows, ...(overLimit ? { overLimit: true } : {}) },
        summary: `Claude account: ${summary.length ? summary.join("; ") : "signed in"}`
    };
}

/** The rows as a notice that replaces the last one - the same line Kiro's and Copilot's account become. */
export function claudeAccountNotice(
    runtime: string,
    found: { account: AccountUsage; summary: string }
): AgentEvent {

    return {
        name: "claude.account",
        raw: found.account,
        kind: "notice",
        progress: true,
        text: found.summary,
        account: { ...found.account, runtime }
    };
}

type LimitWindow = { utilization: number | null; resets_at: string | null };

/** `pro` → `Pro`, `Claude Max` → `Max`. */
function planName(raw: string | null | undefined): string | undefined {

    const name = text(raw)?.replace(/^claude\s+/i, "");

    return name ? name.charAt(0).toUpperCase() + name.slice(1) : undefined;
}

/** How the CLI is signed in, when it is not the usual claude.ai sign-in. */
function signInWay(info: AccountInfo | undefined): string | undefined {

    const provider = info?.apiProvider;

    if (provider && provider !== "firstParty")
        return PROVIDER_NAMES[provider] ?? provider;

    return text(info?.apiKeySource) ? `API key (${text(info?.apiKeySource)})` : undefined;
}

const PROVIDER_NAMES: Record<string, string> = {
    bedrock: "Amazon Bedrock",
    vertex: "Google Vertex AI",
    foundry: "Microsoft Foundry",
    gateway: "Company gateway"
};

/** A reset time in the person's own time zone - `Nov 14, 09:20 PM`. */
function when(iso: string | null | undefined): string | undefined {

    const time = iso ? Date.parse(iso) : NaN;

    return Number.isFinite(time)
        ? new Date(time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
        : undefined;
}

function text(value: unknown): string | undefined {

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {

    return new Promise<T>((resolve, reject) => {

        const timer = setTimeout(() => reject(new Error(`No answer in ${ms} ms`)), ms);

        work.then(
            value => { clearTimeout(timer); resolve(value); },
            error => { clearTimeout(timer); reject(error); });
    });
}

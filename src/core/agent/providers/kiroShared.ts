import { AccountRow, AccountUsage, ContextItem, ContextPart, Spend, addSpend } from "../../models/run";
import type { AgentEvent } from "../AgentSession";

/**
 * Readers for the parts of Kiro's messages that are plain data - charges,
 * the context breakdown, account usage. `kiroV3AcpExtension.ts` says
 * where each one arrives.
 *
 * Every shape here was observed (kiro-cli's v3 engine, KAS 0.66.8). None
 * of it is in Kiro's public ACP docs, so every field is read as optional
 * and a shape this does not know costs its event, never a throw.
 */

/**
 * A turn's charges, one per unit. Each entry of `promptTurnSummaries`
 * names its amount `usage` and its unit as `unitPlural` (`credits`) -
 * also how the rest of the engine names Copilot's credits, so both count
 * as an allowance rather than money.
 */
export function kiroCharges(entries: unknown): Spend[] {

    if (!Array.isArray(entries))
        return [];

    let charges: Spend[] = [];

    for (const entry of entries) {

        const { usage: amount, unit, unitPlural } = (entry ?? {}) as Record<string, unknown>;

        if (typeof amount !== "number" || !Number.isFinite(amount))
            continue;

        const name = typeof unitPlural === "string" && unitPlural
            ? unitPlural
            : typeof unit === "string" && unit ? unit : "credits";

        charges = addSpend(charges, [{ amount, unit: name }]);
    }

    return charges;
}

/** `in 30.0s`, or nothing when Kiro did not say. */
export function kiroDuration(ms: unknown): string | undefined {

    return typeof ms === "number" && Number.isFinite(ms) && ms >= 0
        ? `in ${(ms / 1000).toFixed(1)}s`
        : undefined;
}

/**
 * Kiro's context breakdown as parts, each with what is inside it.
 *
 * Only token counts are read. The percentages Kiro gives per part are
 * not on one base - "Kiro responses" read 53 tokens as 1.9% - so none is
 * trusted.
 *
 * An empty part is left out, unless it names what is in it: a context
 * file Kiro found but did not load is worth seeing even when it is the
 * only one.
 */
export function kiroParts(breakdown: unknown): ContextPart[] {

    if (!breakdown || typeof breakdown !== "object")
        return [];

    const parts: ContextPart[] = [];

    for (const [key, value] of Object.entries(breakdown)) {

        const { tokens } = (value ?? {}) as { tokens?: unknown };

        if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)
            continue;

        const items = kiroItems(value);

        if (tokens === 0 && !items)
            continue;

        parts.push({ name: partName(key), tokens, ...(items ? { items } : {}) });
    }

    return parts;
}

/**
 * What is inside one part, largest first, or nothing when Kiro named
 * nothing.
 *
 * Kiro lists them two ways: `items` directly (context files), or plain
 * `builtin` and `mcp` totals (its tools, no per-tool list). A context
 * file Kiro did not use (`matched: false`) is kept and marked
 * `not loaded`.
 *
 * Exported for tests.
 */
export function kiroItems(part: unknown): ContextItem[] | undefined {

    const { items, builtin, mcp } = (part ?? {}) as Record<string, unknown>;

    const found: ContextItem[] = [];

    if (Array.isArray(items))
        for (const item of items)
            pushItem(found, item);

    for (const [name, total] of [["Built-in", builtin], ["MCP", mcp]] as const) {

        const tokens = (total as { tokens?: unknown } | undefined)?.tokens;

        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)
            found.push({ name, tokens });
    }

    return found.length ? found.sort((a, b) => b.tokens - a.tokens) : undefined;
}

function pushItem(found: ContextItem[], raw: unknown): void {

    const { name, tokens, matched } = (raw ?? {}) as { name?: unknown; tokens?: unknown; matched?: unknown };

    if (typeof name !== "string" || !name || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)
        return;

    found.push({
        name,
        tokens,
        ...(matched === false ? { note: "not loaded" } : {})
    });
}

/** Kiro's part keys as a reader would say them. An unknown key is split at its capitals. */
function partName(key: string): string {

    const known: Record<string, string> = {
        contextFiles: "Context files",
        tools: "Tools",
        kiroResponses: "Kiro responses",
        yourPrompts: "Your prompts",
        sessionFiles: "Session files"
    };

    if (known[key])
        return known[key];

    const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();

    return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Kiro's account usage as rows, or nothing when it failed or has a shape
 * this does not know - the answer to `_kiro/account/getUsage`.
 *
 * One row per field Kiro sent, in its own order, named for a reader -
 * `planName` is "Plan", a breakdown's `used` is "Credits used". Money
 * (the overage rate and charge) is marked, so the page can hide it. A
 * field Kiro did not send is no row.
 *
 * `summary` is the one line a log gets - without money, since a log
 * line cannot hide it later.
 *
 * Exported for tests.
 */
export function kiroAccount(result: unknown, at: number = Date.now()): { account: AccountUsage; summary: string } | undefined {

    const { success, data } = (result ?? {}) as { success?: unknown; data?: unknown };

    if (success === false || !data || typeof data !== "object")
        return undefined;

    const {
        planName, billingCycleReset, overagesEnabled, isEnterprise, usageBreakdowns, bonusCredits, addOnCredits
    } = data as Record<string, unknown>;

    if (!Array.isArray(usageBreakdowns))
        return undefined;

    const rows: AccountRow[] = [];
    const summary: string[] = [];

    let overLimit = false;

    const text = (key: string, value: unknown) => {

        if (typeof value === "string" && value)
            rows.push({ key, value });
    };

    const yesNo = (key: string, value: unknown) => {

        if (typeof value === "boolean")
            rows.push({ key, value: value ? "Yes" : "No" });
    };

    text("Plan", planName);
    text("Resets", billingCycleReset);

    for (const entry of usageBreakdowns) {

        const {
            displayName, resourceType, used, limit, percentage, hasLimit, currentOverages, overageRate, overageCharges,
            currency
        } = (entry ?? {}) as Record<string, unknown>;

        if (!isNumber(used))
            continue;

        const name = typeof displayName === "string" && displayName
            ? displayName
            : typeof resourceType === "string" && resourceType ? resourceType : "Usage";

        const capped = hasLimit !== false && isNumber(limit) && limit > 0;

        rows.push({ key: `${name} used`, value: capped ? `${count(used)} of ${count(limit)}` : count(used) });

        if (isNumber(percentage))
            rows.push({ key: `${name} usage`, value: `${Math.round(percentage)}%` });

        if (isNumber(currentOverages) && currentOverages > 0)
            rows.push({ key: `${name} over the plan`, value: count(currentOverages) });

        const unit = typeof currency === "string" && currency ? currency : "USD";

        if (isNumber(overageRate) && overageRate > 0)
            rows.push({ key: "Overage rate", value: `${money(overageRate, unit)} each`, money: true });

        if (isNumber(overageCharges) && overageCharges > 0)
            rows.push({ key: "Overage charge", value: money(overageCharges, unit), money: true });

        if (capped && used > limit)
            overLimit = true;

        summary.push(capped
            ? `${name} ${count(used)} of ${count(limit)} (${Math.round((used / limit) * 100)}%)`
            : `${name} ${count(used)}`);
    }

    if (!summary.length)
        return undefined;

    yesNo("Overages allowed", overagesEnabled);
    yesNo("Managed by your organisation", isEnterprise);

    for (const [key, list] of [["Bonus credits", bonusCredits], ["Add-on credits", addOnCredits]] as const)
        if (Array.isArray(list) && list.length)
            rows.push({ key, value: String(list.length) });

    return {
        account: { at, rows, ...(overLimit ? { overLimit: true } : {}) },
        summary: `Account: ${summary.join(", ")}`
    };
}

/** Account usage as a notice that replaces the last one. */
export function accountNotice(name: string, raw: unknown, found: { account: AccountUsage; summary: string }): AgentEvent {

    return { name, raw, kind: "notice", progress: true, text: found.summary, account: found.account };
}

function isNumber(value: unknown): value is number {

    return typeof value === "number" && Number.isFinite(value);
}

/** `1,774` - whole units, the way Kiro prints them. */
function count(value: number): string {

    return Math.round(value).toLocaleString("en-US");
}

/** `$30.95`, or `30.95 EUR` for another currency. */
function money(amount: number, currency: string): string {

    const fixed = amount.toFixed(2);

    return currency === "USD" ? `$${fixed}` : `${fixed} ${currency}`;
}

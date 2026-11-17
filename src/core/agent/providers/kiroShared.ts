import { AccountRow, AccountUsage, ContextItem, ContextPart, ContextUsage, Spend, addSpend } from "../../models/run";
import type { AgentEvent } from "../AgentSession";
import type { AcpExtensionTurn } from "./acpExtensions";

/**
 * What Kiro's v2 and v3 engines say the same way, read once for both -
 * see `kiroV2AcpExtension.ts` and `kiroV3AcpExtension.ts` for where each
 * one sends it.
 *
 * Every shape here was observed (kiro-cli 2.24.0, and its v3 engine,
 * KAS 0.66.8). None of it is in Kiro's public ACP docs, so every field
 * is read as optional and a shape this does not know costs its event,
 * never a throw.
 */

/** The window size worked out for this session - see {@link estimateContext}. A session note. */
export const WINDOW_SIZE = "kiro.windowSize";

/**
 * A turn's charges, one per unit. Each entry names its amount `value`
 * (v2's `meteringUsage`) or `usage` (v3's `promptTurnSummaries`), and its
 * unit as `unitPlural` (`credits`) - also how the rest of the engine
 * names Copilot's credits, so both count as an allowance rather than
 * money.
 */
export function kiroCharges(entries: unknown): Spend[] {

    if (!Array.isArray(entries))
        return [];

    let charges: Spend[] = [];

    for (const entry of entries) {

        const { value, usage, unit, unitPlural } = (entry ?? {}) as Record<string, unknown>;

        const amount = typeof value === "number" ? value : usage;

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
 * not on one base - on v2, a 1M-context model's tools part read 1M while
 * Kiro's own percentage read about 435k; on v3, "Kiro responses" read
 * 53 tokens as 1.9% - so none is trusted.
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
 * The window from Kiro's parts and its own overall percentage, or nothing
 * when there is too little to go on.
 *
 * `used` is the parts' tokens added up: plain counts. The size is that sum
 * divided by Kiro's percentage, so a card adds up and its bar matches the
 * share Kiro reports during the turn. It is an estimate, flagged as such:
 * Kiro rounds its percentage (observed: 435k and 447k from one model).
 * Below {@link MIN_SHARE_FOR_SIZE} a size would be mostly rounding.
 */
export function estimateContext(parts: ContextPart[], percent: unknown): ContextUsage | undefined {

    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < MIN_SHARE_FOR_SIZE)
        return undefined;

    const used = parts.reduce((sum, part) => sum + part.tokens, 0);

    if (used <= 0)
        return undefined;

    return { used, size: Math.round(used * 100 / Math.min(100, percent)), parts, sizeEstimated: true };
}

/** The least overall share, in percent, a window size is worked out from. */
const MIN_SHARE_FOR_SIZE = 0.1;

/**
 * A share of the window Kiro reported during a turn, as a notice that
 * replaces the last one. Drawn against the size this session worked out,
 * once there is one; before that, as a share alone.
 */
export function shareNotice(name: string, raw: unknown, percent: number, turn: AcpExtensionTurn): AgentEvent {

    const share = Math.min(100, Math.max(0, percent));

    const size = turn.noted(WINDOW_SIZE);

    if (typeof size === "number" && size > 0) {

        const used = Math.round(share / 100 * size);

        return {
            name,
            raw,
            kind: "notice",
            progress: true,
            text: contextText(used, size),
            context: { used, size, sizeEstimated: true }
        };
    }

    return {
        name,
        raw,
        kind: "notice",
        progress: true,
        text: `Context ${Math.round(share)}% used`,

        // No size known yet - so the share is carried as `used` out of
        // 100, and flagged, so no page prints it as a token count.
        context: { used: share, size: 100, percentOnly: true }
    };
}

/** A worked-out window as a notice, keeping its size for {@link shareNotice}. */
export function contextNotice(name: string, raw: unknown, context: ContextUsage, turn: AcpExtensionTurn): AgentEvent {

    turn.note(WINDOW_SIZE, context.size);

    return { name, raw, kind: "notice", progress: true, text: contextText(context.used, context.size), context };
}

/**
 * What is inside one part, largest first, or nothing when Kiro named
 * nothing.
 *
 * Kiro lists them three ways: `items` directly (context files), `groups`
 * that each hold `items` (v2's tools, grouped by where they come from),
 * or plain `builtin` and `mcp` totals (v3's tools, no per-tool list).
 * Groups are flattened; when there is more than one, each tool is
 * prefixed with its group so two servers' tools with the same name stay
 * apart. A context file Kiro did not use (`matched: false`) is kept and
 * marked `not loaded`.
 *
 * Exported for tests.
 */
export function kiroItems(part: unknown): ContextItem[] | undefined {

    const { items, groups, builtin, mcp } = (part ?? {}) as Record<string, unknown>;

    const found: ContextItem[] = [];

    if (Array.isArray(items))
        for (const item of items)
            pushItem(found, item);

    if (Array.isArray(groups)) {

        const many = groups.length > 1;

        for (const group of groups) {

            const { name, items: inside } = (group ?? {}) as { name?: unknown; items?: unknown };

            if (Array.isArray(inside))
                for (const item of inside)
                    pushItem(found, item, many && typeof name === "string" ? name : undefined);
        }
    }

    for (const [name, total] of [["Built-in", builtin], ["MCP", mcp]] as const) {

        const tokens = (total as { tokens?: unknown } | undefined)?.tokens;

        if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0)
            found.push({ name, tokens });
    }

    return found.length ? found.sort((a, b) => b.tokens - a.tokens) : undefined;
}

function pushItem(found: ContextItem[], raw: unknown, group?: string): void {

    const { name, tokens, matched } = (raw ?? {}) as { name?: unknown; tokens?: unknown; matched?: unknown };

    if (typeof name !== "string" || !name || typeof tokens !== "number" || !Number.isFinite(tokens) || tokens < 0)
        return;

    found.push({
        name: group ? `${group}: ${name}` : name,
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

/** `Context 2% of about 435k tokens used` - the size is always worked out, never sent. */
function contextText(used: number, size: number): string {

    const share = Math.round((used / size) * 100);

    return `Context ${share}% of about ${size >= 1000 ? `${Math.round(size / 1000)}k` : size} tokens used`;
}

/**
 * Kiro's account usage as rows, or nothing when it failed or has a shape
 * this does not know. The same answer from v2's `/usage` command and
 * v3's `_kiro/account/getUsage`, observed on both.
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

/** `1,774` - whole units, the way Kiro's own `/usage` prints them. */
function count(value: number): string {

    return Math.round(value).toLocaleString("en-US");
}

/** `$30.95`, or `30.95 EUR` for another currency. */
function money(amount: number, currency: string): string {

    const fixed = amount.toFixed(2);

    return currency === "USD" ? `$${fixed}` : `${fixed} ${currency}`;
}

import type { Spend } from "../../models/run";

/*
 * What one Copilot model call charged - shared by the SDK provider (ghcp)
 * and Copilot CLI over ACP, which reads the same `assistant.usage` data
 * from its event feed.
 */

/**
 * One AI credit, in the nano-units the CLI counts in. The SDK's own
 * constant (`NANO_AIU_PER_AIU` in its factory module) is not exported.
 */
const NANO_AIU_PER_CREDIT = 1e9;

/**
 * What one model call charged, from an `assistant.usage` event.
 *
 * Copilot bills two ways and the event carries both: `cost` is the
 * premium-request multiplier of the model that ran (a fixed-quota
 * plan's unit), and `copilotUsage.totalNanoAiu` is the AI-credit charge
 * (a usage-billed plan's unit). Whichever the account is on, the other
 * is still sent, so both are reported and the reader picks - unless
 * `hidePremiumRequests` (the `hideCopilotPremiumRequests` feature flag)
 * leaves the premium requests out. Nothing when the CLI counted neither.
 */
export function copilotCharge(data: Record<string, unknown>, hidePremiumRequests = false): Spend[] {

    const charge: Spend[] = [];

    const usage = data.copilotUsage;

    const nano = usage && typeof usage === "object"
        ? (usage as { totalNanoAiu?: unknown }).totalNanoAiu
        : undefined;

    if (typeof nano === "number" && nano > 0)
        charge.push({ amount: nano / NANO_AIU_PER_CREDIT, unit: "credits" });

    if (!hidePremiumRequests && typeof data.cost === "number" && data.cost > 0)
        charge.push({ amount: data.cost, unit: "premium requests" });

    return charge;
}

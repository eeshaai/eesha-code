import type { PermissionCard } from "../../models/permissionCard";
import type { AskHook } from "../AgentSession";
import { GateAnswer, GateCall, gatePermission, PermissionGate } from "./gate";

/**
 * One card put to the person, and what their answer means. Undefined when
 * nobody can answer (the session is not watched) or the card was closed
 * without an answer - the turn stopped, the session ended. Either way the
 * call does not run.
 */
export async function askCard(
    ask: AskHook | undefined,
    gate: PermissionGate,
    call: GateCall,
    card: PermissionCard,
    input?: string
): Promise<GateAnswer | undefined> {

    if (!ask)
        return undefined;

    let text: string;

    try {

        text = await ask({
            prompt: cardPrompt(card),
            permission: gatePermission(call.tool, input, { card }),
            raw: { call, card }
        }).answer;

    } catch {

        return undefined;
    }

    return gate.answer(call, card, text);
}

/** The card as text, for the log and for a surface that draws no card. */
export function cardPrompt(card: PermissionCard): string {

    const heading = card.title.charAt(0).toUpperCase() + card.title.slice(1);

    return [`${heading}.`, "", card.shown, ...(card.lines?.length ? ["", ...card.lines] : [])].join("\n");
}

/** What the agent is told when the person said no. */
export function deniedText(answer: { reason?: string }): string {

    return answer.reason
        ? `The person denied this tool call and said: ${answer.reason}`
        : "The person denied this tool call. Do not try it another way without asking.";
}

/** What the agent is told when nobody answered. */
export const UNANSWERED_TEXT = "The permission card was closed without an answer, so the call did not run.";

/**
 * What the call's tool row says when its card was closed without an
 * answer. The card is not drawn in the thread, so this row is the only
 * place that says it.
 */
export const UNANSWERED_NOTE = "not answered, so it did not run";

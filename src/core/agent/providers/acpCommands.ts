import type { AcpExtensionSession } from "./acpExtensions";

/**
 * Compacts by sending the agent's own `/compact` as a turn - for an agent
 * that has no request for it over ACP (Copilot CLI, claude-agent-acp).
 * The summary is written by the model, so it costs a model call, and its
 * answer shows in the chat like any turn's.
 *
 * @param who The agent's name, for the reason when it fails.
 */
export async function compactByCommand(session: AcpExtensionSession, who: string): Promise<{ ok: boolean; reason?: string }> {

    if (!session.prompt)
        return { ok: false, reason: `${who} can only compact from a chat.` };

    try {

        const answer = await session.prompt("/compact");

        // The agent's own words when it did not (claude-agent-acp:
        // "Compacting failed: Not enough messages to compact.").
        const failed = /compact(ing|ion)? failed|not enough messages|nothing to compact/i.exec(answer);

        return failed
            ? { ok: false, reason: `${who} did not compact: ${answer.replace(/\s+/g, " ").trim().slice(0, 200)}` }
            : { ok: true };

    } catch (error) {

        return { ok: false, reason: `${who} could not compact: ${error instanceof Error ? error.message : String(error)}` };
    }
}

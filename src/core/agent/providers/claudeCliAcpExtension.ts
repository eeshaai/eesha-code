import { compactByCommand } from "./acpCommands";
import type { AcpExtension, AcpSessionSetup } from "./acpExtensions";
import { CLAUDE_REFUSED_COMMANDS } from "./claudeCommands";

/**
 * Claude over ACP (`claude-agent-acp`) - the `claude-cli` extension: the
 * folder boundary, and the Compact button (its `/compact`, typed as a
 * message - there is no request for it over ACP).
 *
 * Its mode option holds Claude Code's permission modes (read from
 * claude-agent-acp 0.73.0's own code). Three of them run tool calls
 * without sending a permission request: Accept edits (edits and file
 * commands inside the working folder), Auto (a model decides) and Bypass
 * permissions (everything). `dontAsk` is not listed today but is one of
 * Claude Code's modes, so it is held back too. Manual and Plan still ask.
 *
 * The session can land in one without the picker: `defaultMode` in a
 * Claude settings file sets the mode it opens in, and accepting a plan
 * with "Yes, and bypass permissions" switches it. The mode guard puts it
 * back in Manual either way.
 */
export const claudeCliExtension: AcpExtension = {

    vendor: "Claude (claude-agent-acp)",

    modeGuard: { hidden: ["acceptEdits", "auto", "bypassPermissions", "dontAsk"], fallback: "default" },

    // The same ones the Claude runtime refuses - see claudeCommands.ts.
    blockedCommands: CLAUDE_REFUSED_COMMANDS,

    compact: session => compactByCommand(session, "Claude"),

    modelPrice: choice => claudeCliPrice(choice),

    sessionMeta: setup => claudeCliSessionMeta(setup),

    toolName: toolCall => claudeCliToolName(toolCall)
};

/**
 * Claude's own name for a tool call (`Read`, `Bash`) - claude-agent-acp
 * 0.73.0 puts it in `_meta.claudeCode.toolName` on each `tool_call`
 * (read from its own code). Its title is plain words with the path in
 * it ("Read C:\app.ts"), which Claude's blocked list does not take.
 *
 * Exported for tests.
 */
export function claudeCliToolName(toolCall: { _meta?: unknown } | undefined): string | undefined {

    const name = (toolCall?._meta as { claudeCode?: { toolName?: unknown } } | undefined)?.claudeCode?.toolName;

    return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * The instructions and the tools to take away, as claude-agent-acp reads
 * them on `session/new` and `session/load` (0.73.0's own code):
 * `_meta.systemPrompt` as an object is added to Claude Code's own preset
 * (`append`), never replacing it; `_meta.claudeCode.options.disallowedTools`
 * is added to its own blocked list.
 *
 * Exported for tests.
 */
export function claudeCliSessionMeta(setup: AcpSessionSetup): Record<string, unknown> {

    const instructions = setup.instructions.trim();

    return {
        ...(instructions ? { systemPrompt: { append: instructions } } : {}),
        ...(setup.toolsOff.length ? { claudeCode: { options: { disallowedTools: [...setup.toolsOff] } } } : {})
    };
}

/**
 * A model's price per million tokens in and out, off its description
 * (claude-agent-acp 0.73.0: "Opus 5 with 1M context · Best for everyday,
 * complex tasks · $5/$25 per Mtok") - `$5/$25`. Undefined when the
 * description names no price.
 *
 * Exported for tests.
 */
export function claudeCliPrice(choice: unknown): string | undefined {

    const description = (choice as { description?: unknown } | undefined)?.description;

    if (typeof description !== "string")
        return undefined;

    const found = /(\$[\d.]+\/\$[\d.]+)\s*per\s*Mtok/i.exec(description);

    return found?.[1];
}

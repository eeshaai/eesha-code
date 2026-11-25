import type { MemoryChoices } from "../protocol";

/*
 * Claude keeps a memory of its own. While Eesha Code's memory is on, a
 * Claude session starts only once the person has turned Claude's own
 * memory off for Eesha Code's sessions - two memories would not agree.
 *
 * It is turned off by an environment value on Claude's process, for our
 * sessions only. Claude Code in a terminal is not changed.
 */

/**
 * The runtimes that are Claude: the built-in one, and Claude run as an
 * ACP agent. An agent under another id that runs Claude names itself
 * `claude-cli` here too - see `sessionEnvRuntime` in AcpProvider.
 */
export const CLAUDE_RUNTIMES: readonly string[] = ["claude", "claude-cli"];

/** Claude Code's own switch: with it set, Claude neither reads nor writes its memory. */
export const CLAUDE_MEMORY_OFF = { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" } as const;

export const CLAUDE_MEMORY_QUESTION = "Eesha Code's memory is on, and Claude keeps a memory of its own. The two would not agree. "
    + "Turn Claude's own memory off in Eesha Code's sessions? Claude Code in your terminal is not changed.";

export const CLAUDE_MEMORY_ACTION = "Turn off";

/** Why a Claude session did not start. */
export const CLAUDE_MEMORY_HELD = "Claude did not start: its own memory is still on, and Eesha Code's memory is on too. "
    + "In Settings, under Connectors, turn Claude's own memory off for Eesha Code's sessions - or set Eesha Code's memory to Off. Then send again.";

/** Whether a session on `provider` has to wait for the person's answer. */
export function claudeWaits(provider: string, choices: MemoryChoices): boolean {

    return CLAUDE_RUNTIMES.includes(provider) && choices.access !== "off" && !choices.claudeMemoryOff;
}

/**
 * What Eesha Code adds to a runtime's environment for memory - see
 * `ProviderDeps.sessionEnv`. Throws while a Claude session has to wait.
 * With Eesha Code's memory off, Claude's own is left as it is.
 */
export function memoryEnv(provider: string, choices: MemoryChoices): Record<string, string> {

    if (!CLAUDE_RUNTIMES.includes(provider) || choices.access === "off")
        return {};

    if (!choices.claudeMemoryOff)
        throw new Error(CLAUDE_MEMORY_HELD);

    return { ...CLAUDE_MEMORY_OFF };
}

import React from "react";

/*
 * A command block the person can run. The chat's markdown only knows that
 * a fence is a shell command; the page provides the block that runs
 * one through CommandBlockContext.
 */

/**
 * The fence languages that hold a command to run. `console` and
 * `shellsession` are left out: they hold a prompt and what it printed,
 * not a command.
 */
const SHELL_FENCES = new Set(["bash", "sh", "shell", "zsh", "fish", "powershell", "pwsh", "ps1", "ps", "cmd", "bat", "batch"]);

/** Whether a fence's language marks a shell command. */
export function isShellFence(language: string | undefined): boolean {

    return !!language && SHELL_FENCES.has(language.toLowerCase());
}

/** What draws a shell fence in place of the plain code block. Must be a stable component (a module-level one). */
export type CommandBlockComponent = React.ComponentType<{ code: string; language: string }>;

export const CommandBlockContext = React.createContext<CommandBlockComponent | undefined>(undefined);

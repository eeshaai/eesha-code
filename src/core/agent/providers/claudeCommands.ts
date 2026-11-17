/**
 * Claude Code's slash commands that are never sent - by the Claude
 * runtime (the SDK) or by claude-agent-acp. Each lets the agent run
 * tools without asking, or reach folders the folder boundary cannot see:
 *
 * - `add-dir` adds a folder to the session.
 * - `permissions`, `config`, `update-config` and `fewer-permission-prompts`
 *   write allow rules or a permission mode into a settings file.
 * - `auto-mode-setup` sets up auto mode, which does not ask.
 * - `sandbox` changes what the shell sandbox lets through.
 * - `import` brings another agent's settings in, allow rules with them.
 *
 * They are left out of the compose box's list, and refused when typed.
 */
export const CLAUDE_REFUSED_COMMANDS: readonly string[] = [
    "add-dir",
    "auto-mode-setup",
    "config",
    "fewer-permission-prompts",
    "import",
    "permissions",
    "sandbox",
    "update-config"
];

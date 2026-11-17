import * as fs from "fs";
import * as path from "path";

import { Providers } from "../core/agent/providerArgs";
import { cliBinary as claudeBinary } from "../core/agent/providers/claudeCli";
import { commandOnPath, envValue } from "../core/agent/providers/cliOnPath";
import { EnvService } from "../core/env/envService";
import { useProfileDirectory } from "../core/loader/profilePaths";
import { loadEngineSettings, type SourcedAcpAgent } from "../core/settings/engineSettings";
import { eeshaHome, eeshaPath } from "./paths";

/*
 * `eesha doctor`: which runtimes the picker offers, and whether the
 * program each one runs is on this machine. A new user sees this before
 * the first message, not as a failed turn.
 *
 * Only whether the program is found. Sign-in is not checked: that would
 * mean starting each program, and each one has its own way.
 */

/** What one runtime needs, and where it was found. */
export interface RuntimeCheck {

    /** The runtime's id, as the picker and `ai.providers` name it. */
    id: string;

    /** The program it runs, as a person would type it. */
    program: string;

    /** Where it was found. Nothing when it was not. */
    found?: string;

    /** How to get the program - said when it is not found. */
    install: string;
}

/** How to get each built-in runtime's program - the README's table. */
const INSTALL: Record<string, string> = {
    claude: "npm install -g @anthropic-ai/claude-code, or set CLAUDE_CLI_PATH to a copy you have",
    ghcp: "npm install -g @github/copilot, or set COPILOT_CLI_PATH to a copy you have",
    "kiro-cli": "Kiro's own installer",
    "kiro-cli-v3": "Kiro's own installer",
    "copilot-cli": "npm install -g @github/copilot",
    "claude-cli": "npm install -g @agentclientprotocol/claude-agent-acp",
    "gemini-cli": "Google's Gemini CLI",
    "codex-cli": "the Codex ACP adapter",
    "cursor-cli": "Cursor's CLI",
    "opencode-cli": "OpenCode"
};

/**
 * Checks each runtime. `agents` are the ACP agents the settings declare,
 * the built-in ones included. `env` supplies PATH and the two *_CLI_PATH
 * overrides.
 */
export function checkRuntimes(ids: readonly string[], agents: Readonly<Record<string, SourcedAcpAgent>>, env: Record<string, string>): RuntimeCheck[] {

    return ids.map(id => {

        if (id === "claude")
            return { id, program: "claude", found: claudeBinary(env), install: INSTALL.claude };

        if (id === "ghcp")
            return { id, program: "copilot", found: envValue(env, "COPILOT_CLI_PATH") || commandOnPath(env, "copilot"), install: INSTALL.ghcp };

        const declared = agents[id]?.agent as { command?: unknown } | undefined;

        if (!declared || typeof declared.command !== "string" || !declared.command)
            return { id, program: "?", install: `${id} is not a runtime Eesha Code knows - check ai.providers and ai.acpAgents in settings.json` };

        const command = declared.command;

        return {
            id,
            program: command,
            found: programAt(command, env),
            install: INSTALL[id] ?? `check ai.acpAgents.${id}.command in settings.json`
        };
    });
}

/**
 * The runtimes Eesha Code offers when settings.json lists none
 * (`ai.providers`): the ones of `ids` whose program is on this machine,
 * in the same order. All of `ids` when none is found - an empty picker
 * would leave nothing to start a chat on, and the failed turn then says
 * which program is missing.
 */
export function foundOnly(ids: readonly string[], agents: Readonly<Record<string, SourcedAcpAgent>>, env: Record<string, string>): string[] {

    const found = checkRuntimes(ids, agents, env).filter(check => check.found).map(check => check.id);

    return found.length ? found : [...ids];
}

/** A full path as it is; a bare name looked up on PATH, the way a shell would. */
function programAt(command: string, env: Record<string, string>): string | undefined {

    if (path.isAbsolute(command))
        return fs.existsSync(command) ? command : undefined;

    return commandOnPath(env, command);
}

/**
 * The runtimes checked: `ai.providers` when settings.json lists them,
 * else every runtime Eesha Code knows - the picker then offers only the
 * ones found (see `foundOnly`).
 */
export async function checkThisMachine(): Promise<{ checks: RuntimeCheck[]; listed: boolean; problem?: string }> {

    useProfileDirectory(eeshaHome());

    const env = EnvService.machine();

    try {

        const settings = await loadEngineSettings(undefined);

        const listed = settings.ai.providers !== undefined;

        const ids = settings.ai.providers
            ? [...settings.ai.providers]
            : [...Providers, ...Object.keys(settings.ai.acpAgents).filter(id => !(Providers as readonly string[]).includes(id))];

        return { checks: checkRuntimes(ids, settings.ai.acpAgents, env), listed };

    } catch (error) {

        return { checks: [], listed: false, problem: `${eeshaPath("settings.json")} could not be read: ${(error as Error).message}` };
    }
}

/** What `eesha doctor` prints. */
export function doctorReport(result: { checks: RuntimeCheck[]; listed: boolean; problem?: string }): string {

    if (result.problem)
        return result.problem;

    const { checks, listed } = result;

    const width = Math.max(...checks.map(check => check.id.length), "Runtime".length) + 2;

    const lines = [
        listed
            ? "Runtimes the picker offers (ai.providers in settings.json), and whether their program is on this machine:"
            : "Runtimes Eesha Code knows, and whether their program is on this machine. With no ai.providers list in settings.json, the picker offers the ones found:",
        "",
        ...checks.map(check => `  ${check.id.padEnd(width)}${check.found
            ? `found      ${check.found}`
            : `not found  ${check.program === "?" ? check.install : `${check.program} - install: ${check.install}`}`}`),
        ""
    ];

    const found = checks.filter(check => check.found);

    lines.push(`${found.length} of ${checks.length} found. Sign-in is not checked: each runtime uses the sign-in its own program has.`);

    return lines.join("\n");
}

/** One line for `eesha start` on a machine with no settings.json yet. */
export function doctorLine(checks: readonly RuntimeCheck[]): string {

    const found = checks.filter(check => check.found).map(check => check.id);
    const missing = checks.filter(check => !check.found).map(check => check.id);

    if (!found.length)
        return "No runtime's program was found on this machine. Run `eesha doctor` to see how to install one.";

    return `Runtimes found: ${found.join(", ")}.${missing.length ? ` Not found: ${missing.join(", ")} - \`eesha doctor\` says how to install them.` : ""}`;
}

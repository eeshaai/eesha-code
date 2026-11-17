import { promises as fs } from "fs";
import * as path from "path";

import type { RuntimeCommand } from "../models/run";
import { profilePath } from "../loader/profilePaths";
import { modelListPath } from "./modelListFile";

/**
 * Each runtime's slash commands, kept in its own file:
 * `~/.eesha/commands/<runtime>.json`.
 *
 * The compose box lists them when "/" is the first thing typed. Nothing
 * is ever fetched for that and nothing waits: a runtime sends its list
 * by itself when a session starts (ACP's `available_commands_update`,
 * Claude's session start), and the session writes it here. The box reads
 * the file - a new chat shows the list at once, from the last session
 * that sent one. A runtime that never sent a list has no file, and the
 * box lists no commands for it.
 *
 * Commands that let the agent skip asking first, or reach other folders,
 * are left out before the list is written - see `offeredCommands`.
 */
export const COMMAND_LIST_DIR = "commands";

/** Written at the top of every file, for the person who opens it. */
const ABOUT = "Slash commands this runtime offered when a session last started. "
    + "Written again each time the runtime sends a different list - edits here do not last.";

/** The file for a runtime - named the way the model list files are. */
export function commandListPath(runtime: string, root: string = profilePath(COMMAND_LIST_DIR)): string {

    return modelListPath(runtime, root);
}

/**
 * Commands from what a runtime sent: ACP's `availableCommands`
 * (`{ name, description, input: { hint } }`) or Claude's
 * `supportedCommands()` (`{ name, description, argumentHint }`), this
 * file's own (`{ name, description, hint }`), or bare names. A leading
 * "/" is dropped; anything without a name is skipped.
 */
export function commandsFrom(raw: unknown): RuntimeCommand[] {

    if (!Array.isArray(raw))
        return [];

    const commands: RuntimeCommand[] = [];

    for (const item of raw) {

        const one = typeof item === "string" ? { name: item } : item as Record<string, unknown> | null;

        const name = typeof one?.name === "string" ? one.name.trim().replace(/^\/+/, "") : "";

        if (!name || /\s/.test(name))
            continue;

        const description = typeof one?.description === "string" ? one.description.trim() : "";

        const input = one?.input as { hint?: unknown } | null | undefined;

        // Claude's name for it, then ACP's, then this file's own.
        const hint = typeof one?.argumentHint === "string" ? one.argumentHint.trim()
            : typeof input?.hint === "string" ? input.hint.trim()
            : typeof one?.hint === "string" ? one.hint.trim() : "";

        commands.push({ name, ...(description ? { description } : {}), ...(hint ? { hint } : {}) });
    }

    return commands;
}

/**
 * Why a refused command was not sent - the same words for every runtime,
 * unless the runtime gives its own `reason` (a full sentence, lower case
 * first) for a command they do not fit.
 */
export function refusedCommandText(name: string, reason?: string): string {

    return reason
        ? `'/${name}' was not sent: ${reason}`
        : `'/${name}' was not sent: it lets the agent run tools without asking, or reach folders `
            + "outside this session's own, where the folder boundary cannot see them.";
}

/** The slash command a message starts with, lower case: `/allow-all on` gives `allow-all`. */
export function commandNameIn(prompt: string): string | undefined {

    return /^\s*\/([^\s/]+)/.exec(prompt)?.[1]?.toLowerCase();
}

/**
 * What the box may offer: `refused` names left out (a typed one is
 * refused by the runtime's session too), each name once, A to Z.
 */
export function offeredCommands(commands: readonly RuntimeCommand[], refused: readonly string[]): RuntimeCommand[] {

    const left = new Set(refused.map(name => name.toLowerCase()));
    const seen = new Set<string>();

    return commands
        .filter(command => {

            const key = command.name.toLowerCase();

            if (left.has(key) || seen.has(key))
                return false;

            seen.add(key);

            return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Keeps a runtime's list. Written only when it differs from the one
 * kept, so a session start that sends the same list writes nothing. An
 * empty list is not written: a runtime that sent none says nothing about
 * the ones it had. Never throws - a list not kept is a box without it.
 */
export async function keepCommandList(runtime: string, commands: readonly RuntimeCommand[], root?: string): Promise<void> {

    if (!commands.length)
        return;

    const file = commandListPath(runtime, root);

    try {

        const kept = await readCommandList(runtime, root);

        if (JSON.stringify(kept) === JSON.stringify(commands))
            return;

        await fs.mkdir(path.dirname(file), { recursive: true });

        // Written beside and then moved into place, so a reader never
        // sees half a file.
        const partial = `${file}.${process.pid}.tmp`;

        await fs.writeFile(partial, JSON.stringify({ about: ABOUT, commands }, null, 2) + "\n", "utf8");
        await fs.rename(partial, file);

    } catch {

        // Not kept: the box lists the old ones, or none.
    }
}

/** A runtime's kept list. Empty when there is no file, or it cannot be read. Never throws. */
export async function readCommandList(runtime: string, root?: string): Promise<RuntimeCommand[]> {

    try {

        const parsed = JSON.parse(await fs.readFile(commandListPath(runtime, root), "utf8")) as { commands?: unknown };

        return commandsFrom(parsed?.commands);

    } catch {

        return [];
    }
}

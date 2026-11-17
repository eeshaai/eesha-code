import * as fs from "fs";
import * as path from "path";

import type { RuntimeTools } from "./settings";

/*
 * A chat's standing instructions - what each runtime gets as its system
 * prompt:
 *
 * 1. `.eesha/system.md` in each of the chat's folders, for every runtime.
 * 2. `.eesha/kiro.md` beside it, on a Kiro runtime only.
 * 3. A line naming the runtime's tools the settings turn off.
 *
 * A chat with no folder has only the third. A file's front matter (the
 * `---` block a Kiro steering file starts with) is left out.
 */

/** The folder inside a chat folder that holds the instruction files. */
export const INSTRUCTIONS_FOLDER = ".eesha";

/** Whether a runtime id is one of Kiro's: `kiro-cli`, `kiro-cli-v3`, or one the person named so. */
export function isKiroRuntime(provider: string): boolean {

    return provider.toLowerCase().startsWith("kiro");
}

/** The text for a session on `provider` in these folders, or nothing when there is none. */
export function standingInstructions(folders: readonly string[], provider: string, tools: RuntimeTools | undefined): string | undefined {

    const names = ["system.md", ...isKiroRuntime(provider) ? ["kiro.md"] : []];

    const parts: string[] = [];

    for (const name of names)
        for (const folder of folders) {

            const text = readInstructionFile(path.join(folder, INSTRUCTIONS_FOLDER, name));

            if (text)
                parts.push(text);
        }

    const note = toolsNote(tools);

    if (note)
        parts.push(note);

    return parts.length ? parts.join("\n\n") : undefined;
}

/** The line about turned-off tools, or nothing. */
export function toolsNote(tools: RuntimeTools | undefined): string | undefined {

    return tools?.toolsOff.length
        ? `These tools are turned off in this session; do not call them: ${tools.toolsOff.join(", ")}.`
        : undefined;
}

/** One file's text without its front matter, trimmed. Nothing when it is missing, empty or unreadable. */
export function readInstructionFile(file: string): string | undefined {

    let text: string;

    try {

        text = fs.readFileSync(file, "utf8");

    } catch {

        return undefined;
    }

    const body = text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "").trim();

    return body || undefined;
}

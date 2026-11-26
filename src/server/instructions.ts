import * as fs from "fs";
import * as path from "path";

import type { ConnectorId } from "./protocol";
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
 *
 * Eesha Code's own text about its chat page and its connectors
 * (`APP_INSTRUCTIONS`, `connectorsNote`) goes in front of all of these,
 * with `KIRO_PLACE` before it on a Kiro runtime - see
 * `ServerChatHost.systemInstructions`.
 */

/**
 * What a Kiro session is told first. Kiro keeps its own prompt and puts
 * ours after it. Kiro's prompt tells the model it runs in the Kiro IDE
 * (built on VS Code) when the client name is not one of Kiro's own, and
 * we send none. With the name "kiro-cli" it says a terminal instead.
 * Both are wrong here. Read from kiro-cli 3.6.2's acp-server.js.
 */
export const KIRO_PLACE = "You are not running in the Kiro IDE, in VS Code or in a terminal, whatever the text before this says. "
    + "You are running in Eesha Code. So do not send the person to Kiro IDE or VS Code menus, panels or buttons.";

/**
 * What every session is told about how Eesha Code's chat page shows a
 * reply. A shell block gets Run (see CommandBlock.tsx), which runs it
 * once with nobody to type into it; a mermaid block is drawn.
 */
export const APP_INSTRUCTIONS = [
    "Eesha Code shows your replies in its own chat page.",
    "- A code block tagged with a shell language (powershell, bash, sh, cmd and so on) gets a Run button. "
        + "Run starts the command once, in one of this session's folders, and shows what it prints. Nobody can type into it. "
        + "So: one command per block, the right language tag, no \"$\" or other prompt sign, no output inside the block, "
        + "and no command that waits for typed input.",
    "- A mermaid code block is drawn as a diagram. Use one when a flow or a structure is easier to see than to read."
].join("\n");

/** How `connectorsNote` names each connector, its tools and its command line. */
const CONNECTOR_WORDS: Readonly<Record<ConnectorId, { name: string; tools: string; cli: string }>> = {
    ado: { name: "Azure DevOps", tools: "ado_", cli: "az" },
    github: { name: "GitHub", tools: "gh_", cli: "gh" }
};

/**
 * The line that sends ADO and GitHub work through our connector tools
 * rather than the `az` or `gh` command line, naming only the connectors
 * connected. A connector write shows a permission card; a command that
 * makes the same change may not. Nothing when none is connected.
 */
export function connectorsNote(connected: readonly ConnectorId[]): string | undefined {

    const words = connected.map(id => CONNECTOR_WORDS[id]);

    if (!words.length)
        return undefined;

    const names = words.map(one => one.name).join(" and ");
    const tools = words.map(one => one.tools).join(" and ");
    const clis = words.map(one => one.cli).join(" or ");

    return `For ${names}, use Eesha Code's ${tools} tools, not the ${clis} command line. `
        + "A change made through these tools shows the person a permission card first. The same change made with a command does not.";
}

/** The folder inside a chat folder that holds the instruction files. */
export const INSTRUCTIONS_FOLDER = ".eesha";

/** Whether a runtime id is one of Kiro's: `kiro-cli`, or one the person named so. */
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

import type { CmdLogs } from "../../view/templates/TemplateRunView";

/*
 * A typed message the spec panel drew as "sending" before the host
 * logged it. When the host says it was not sent (`unsent`), the line
 * comes off the conversation and its text goes back into the compose box.
 */

/** The text of the oldest line of a phase still drawn as sending. Nothing when there is none. */
export function unsentText(current: Record<string, CmdLogs>, key: string): string | undefined {

    return current[key]?.lines.find(one => one.pending === "sending")?.text.replace(/\n$/, "");
}

/** That line taken off the conversation. The host posts why before the `unsent`. */
export function dropUnsent(current: Record<string, CmdLogs>, key: string): Record<string, CmdLogs> {

    const lines = current[key]?.lines;
    const index = lines?.findIndex(one => one.pending === "sending") ?? -1;

    if (!lines || index < 0)
        return current;

    return { ...current, [key]: { ...current[key], lines: [...lines.slice(0, index), ...lines.slice(index + 1)] } };
}

import type { RunDone, ShellChoice } from "../server/protocol";

/* What the page shows of a command started from a Run button (CommandBlock.tsx). */

/**
 * What a run printed, the way a terminal would show it: colour codes
 * taken out, and a line a progress bar rewrote with "\r" shown as it
 * ended.
 */
export function shownOutput(text: string): string {

    // eslint-disable-next-line no-control-regex
    const plain = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

    return plain
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.slice(line.lastIndexOf("\r") + 1))
        .join("\n");
}

/** How a finished run ended, in a few words. */
export function endText(done: RunDone): string {

    const time = done.ms >= 1000 ? `${(done.ms / 1000).toFixed(1)}s` : `${done.ms}ms`;

    if (done.problem)
        return `Could not run: ${done.problem}`;

    if (done.stopped)
        return `Stopped · ${time}`;

    return `Exit ${done.code ?? "?"} · ${time}`;
}

const POWERSHELL_FENCES = new Set(["powershell", "pwsh", "ps1", "ps"]);
const CMD_FENCES = new Set(["cmd", "bat", "batch"]);
const POSIX_FENCES = new Set(["bash", "sh", "zsh", "fish"]);

/**
 * The shell a block starts on. Its language picks the kind: a powershell
 * block gets PowerShell, a cmd block Command Prompt, a bash block Git
 * Bash (Windows) or bash (Mac, Linux). The person's last pick wins when
 * it is of that kind - Windows PowerShell over PowerShell 7, say. A block
 * whose language names no kind (`shell`), or a kind not on this machine,
 * gets the last pick, else the first shell.
 */
export function shellFor(shells: readonly ShellChoice[], language: string, saved: string | undefined): ShellChoice | undefined {

    const fence = language.toLowerCase();
    const kind = POWERSHELL_FENCES.has(fence) ? "powershell" : CMD_FENCES.has(fence) ? "cmd" : POSIX_FENCES.has(fence) ? "posix" : undefined;
    const last = shells.find(one => one.id === saved);

    if (kind) {

        if (last?.kind === kind)
            return last;

        // `zsh` and `fish` blocks get that very shell when it is here.
        // Not PowerShell: "powershell" is also Windows PowerShell's id,
        // and PowerShell 7 comes first.
        const named = kind === "posix" ? shells.find(one => one.id === fence) : undefined;
        const any = shells.find(one => one.kind === kind);

        if (named ?? any)
            return named ?? any;
    }

    return last ?? shells[0];
}

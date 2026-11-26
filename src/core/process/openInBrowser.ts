import { spawn } from "child_process";

/**
 * Opens a web address in the default browser. The one place Eesha Code
 * does this: `eesha start` opening its own page, and an MCP server's
 * sign-in page after the person clicks Sign in.
 *
 * Only `http:` and `https:` addresses are opened: anything else (a
 * `file:` path, another program's link) could start something on this
 * machine, so it is refused.
 *
 * No shell: on Windows the address goes straight to the system's own
 * link handler, so an `&` in a sign-in address's query cannot cut it
 * short or run as a command (`cmd /c start` would read it as one).
 *
 * @param onFail Told when the browser could not be started - the
 *               program missing, say. Without it a failure is quiet.
 * @returns false when the address was refused or nothing could be
 *          started at once; true when the browser was asked.
 */
export function openInBrowser(url: string, onFail?: (error: Error) => void): boolean {

    if (!isWebAddress(url))
        return false;

    const [command, args] = process.platform === "win32"
        ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin"
            ? ["open", [url]]
            : ["xdg-open", [url]];

    try {

        const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });

        // A missing program comes as an event, not a throw - and an
        // `error` event nobody listens to would stop the whole server.
        child.once("error", error => onFail?.(error));
        child.unref();

        return true;

    } catch (error) {

        onFail?.(error instanceof Error ? error : new Error(String(error)));

        return false;
    }
}

/** Whether `url` is an `http:` or `https:` address. */
export function isWebAddress(url: unknown): url is string {

    if (typeof url !== "string")
        return false;

    try {

        const protocol = new URL(url).protocol;

        return protocol === "http:" || protocol === "https:";

    } catch {

        return false;
    }
}

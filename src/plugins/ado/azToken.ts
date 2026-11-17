import { execFile } from "child_process";

/**
 * Azure DevOps' fixed Entra resource id, the same GUID for every
 * organization. A token scoped to it gives ADO access with no PAT.
 */
export const ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/** How long one az invocation may take before it reads as hung. */
const AZ_TIMEOUT_MS = 30_000;

/**
 * A short-lived ADO access token from the az CLI's current login.
 * Called once per task run and reused across the REST calls. The value
 * is a credential: callers put it in a header and never log it.
 */
export function acquireAzToken(): Promise<string> {

    return new Promise((resolve, reject) => {

        execFile(
            "az",
            ["account", "get-access-token", "--resource", ADO_RESOURCE_ID, "--query", "accessToken", "-o", "tsv"],

            // az is az.cmd on Windows, which only a shell resolves. The
            // arguments are fixed strings; nothing a caller supplies
            // goes through this shell.
            { shell: process.platform === "win32", timeout: AZ_TIMEOUT_MS, windowsHide: true },

            (error, stdout, stderr) => {

                if (error)
                    return reject(new Error(explain(error, stderr)));

                const token = stdout.trim();

                if (!token)
                    return reject(new Error("az returned no token - run 'az login' and try again."));

                resolve(token);
            });
    });
}

function explain(error: Error & { code?: string | number }, stderr: string): string {

    if (error.code === "ENOENT")
        return "The az CLI was not found. Install it, or set 'auth: pat' with a PAT instead.";

    // az's own first line is usually the fix ("Please run 'az login'...").
    const said = stderr.trim().split("\n")[0];

    return `Could not get a token from az${said ? `: ${said}` : ` - ${error.message}`}`;
}

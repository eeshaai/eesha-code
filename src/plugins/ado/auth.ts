import { PluginContext } from "../../core/plugins/Plugin";
import { acquireAzToken } from "./azToken";

/**
 * The `Authorization` header for an Azure DevOps call, shared by every
 * ADO plugin so the two auth modes are decided in one place.
 *
 * `az` (the default) mints a short-lived Entra token from the CLI's own
 * login - no PAT anywhere. `pat` reads the env var `patEnv` names
 * through `ctx.secret`, never `process.env`, and sends it as basic auth
 * with an empty user name. The value is a credential: it goes into a
 * header and is never logged.
 */
export async function adoAuthHeader(
    auth: string | undefined,
    patEnv: string | undefined,
    ctx: Pick<PluginContext, "secret">
): Promise<string> {

    if ((auth ?? "az") === "az")
        return `Bearer ${await acquireAzToken()}`;

    const name = patEnv?.trim() || "AZURE_DEVOPS_EXT_PAT";

    const pat = ctx.secret(name);

    if (!pat)
        throw new Error(
            `No PAT found - set the '${name}' environment variable, or point 'patEnv' at the one holding it.`);

    return `Basic ${Buffer.from(`:${pat}`).toString("base64")}`;
}

/** Whether an `auth:` value is one of the two modes. */
export function isAdoAuth(value: unknown): value is "az" | "pat" | undefined {

    return value === undefined || value === "az" || value === "pat";
}

import { Plugin } from "./Plugin";

/**
 * The env var names a plugin may read on one particular call.
 *
 * Most plugins declare `secrets`. A plugin whose credential sits under
 * a name the caller chooses declares {@link Plugin.secretsFrom} as well,
 * naming the input that decides.
 *
 * Takes resolved args rather than the task, because this is only asked
 * at execute time, when `${{ }}` has become a value.
 */
export function secretNamesOf(
    plugin: Pick<Plugin, "secrets" | "secretsFrom">,
    args: Record<string, unknown> = {}
): readonly string[] {

    const declared = plugin.secrets ?? [];

    if (!plugin.secretsFrom)
        return declared;

    const chosen = args[plugin.secretsFrom];

    // Anything but a non-empty string means the workflow did not name
    // one. The host has already applied the schema's `default`, so there
    // is nothing else to fall back to. The plugin's own "that secret is
    // not set" message is the better error.
    if (typeof chosen !== "string" || !chosen)
        return declared;

    return declared.includes(chosen) ? declared : [...declared, chosen];
}

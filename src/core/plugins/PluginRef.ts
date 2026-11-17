export interface PluginRef {

    id: string;

    version: string;
}

/**
 * The only legal shape for a plugin id: lowercase kebab. Exported so the
 * loader and the manifest validator check the same rule as this parser.
 */
export function isPluginId(value: unknown): boolean {

    return typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

/** `id@version`: a lowercase kebab id (see {@link isPluginId}), an integer version. */
const RefPattern = /^([a-z0-9]+(?:-[a-z0-9]+)*)@([0-9]+)$/;

/**
 * Parses a `uses:` reference.
 *
 * A bare `id` is rejected rather than defaulting to version 1, so a
 * workflow's meaning cannot change when a plugin ships a v2. (An alias
 * from the file's `plugins:` map is also bare, but the parser resolves
 * those before anything here runs.)
 */
export function parsePluginRef(plugin: string | undefined): PluginRef | undefined {

    if (!plugin)
        return undefined;

    const match = RefPattern.exec(plugin.trim());

    return match ? { id: match[1], version: match[2] } : undefined;
}

/** The registry key for a ref - also the canonical way to print one. */
export function pluginRefKey(ref: PluginRef): string {

    return `${ref.id}@${ref.version}`;
}

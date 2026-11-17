import { Plugin } from "./Plugin";
import { PluginRef, pluginRefKey } from "./PluginRef";

/** Where a registered plugin came from, for the UI, errors, and clash resolution. */
export type PluginOrigin = "builtin" | "folder" | "workspace" | "profile";

/**
 * How specific an origin is, narrowest first. A wider plugin steps
 * aside for a narrower one that already claimed its id - the same order
 * `mergeScopes` applies to tasks and workflows.
 *
 * `builtin` is left out on purpose: see {@link PluginRegistry.register}.
 */
const Specificity: PluginOrigin[] = ["folder", "workspace", "profile"];

export interface RegisteredPlugin {

    plugin: Plugin;

    origin: PluginOrigin;

    /** Set for every loaded plugin - the file it was loaded from. Absent only for a builtin. */
    sourcePath?: string;

    /** The plugin's own folder, for a folder plugin. Where its app's page is read from. */
    folder?: string;
}

/** A plugin that ships an app, with everything needed to show it. */
export interface RegisteredApp {

    /** `id@version` - what the panel addresses requests to. */
    ref: string;

    plugin: Plugin;

    folder: string;
}

/**
 * Every plugin available to a run, keyed by `id@version`: the ones
 * bundled with Eesha Code, and the ones a user dropped in a plugins
 * folder.
 */
export class PluginRegistry {

    private readonly plugins = new Map<string, RegisteredPlugin>();

    /**
     * Throws on a duplicate key, with one exception: a plugin from a
     * wider scope whose id a narrower one already claimed is silently
     * shadowed. A repo that ships its own `deploy@1` means its deploy,
     * and warning every user who personalised a plugin their team later
     * adopted would be noise.
     *
     * Everything else throws: two folders in the same scope declaring
     * one id, and a user plugin colliding with a bundled id in either
     * direction. That is why `builtin` is not on the specificity ladder
     * at all. The loader turns both into a reported load failure (see
     * {@link PluginLoader.loadInto}).
     */
    public register(plugin: Plugin, origin: PluginOrigin = "builtin", sourcePath?: string, folder?: string): void {

        const key = pluginRefKey({ id: plugin.id, version: plugin.version });

        const existing = this.plugins.get(key);

        if (existing) {

            if (shadows(existing.origin, origin))
                return;

            throw new Error(`A plugin is already registered as '${key}'.`);
        }

        this.plugins.set(key, { plugin, origin, sourcePath, folder });
    }

    public resolve(ref: PluginRef): Plugin | undefined {

        return this.plugins.get(pluginRefKey(ref))?.plugin;
    }

    public describe(ref: PluginRef): RegisteredPlugin | undefined {

        return this.plugins.get(pluginRefKey(ref));
    }

    public has(ref: PluginRef): boolean {

        return this.plugins.has(pluginRefKey(ref));
    }

    public list(): RegisteredPlugin[] {

        return [...this.plugins.values()];
    }

    /** Every registered `id@version`, for the "did you mean" half of a not-found error. */
    public keys(): string[] {

        return [...this.plugins.keys()].sort();
    }

    /** Every plugin that ships an app. A builtin has no folder, so it cannot. */
    public apps(): RegisteredApp[] {

        return [...this.plugins.entries()]
            .filter((entry): entry is [string, RegisteredPlugin & { folder: string }] =>
                entry[1].plugin.ui !== undefined && entry[1].folder !== undefined)
            .map(([ref, { plugin, folder }]) => ({ ref, plugin, folder }));
    }

    /**
     * Becomes `other`, in place. For Reload Plugins: the engine, every
     * session and the validators hold this object, so swapping its
     * contents is what makes a re-read reach all of them.
     */
    public replaceWith(other: PluginRegistry): void {

        this.plugins.clear();

        for (const [key, entry] of other.plugins)
            this.plugins.set(key, entry);
    }

}

/**
 * Whether an `incoming` plugin should step aside for one already
 * registered from `existing`. Only true between two user scopes when
 * the incoming one is wider. A builtin is not on the ladder, so
 * `indexOf` returns -1 and the answer is false in both directions.
 */
function shadows(existing: PluginOrigin, incoming: PluginOrigin): boolean {

    const claimed = Specificity.indexOf(existing);
    const arriving = Specificity.indexOf(incoming);

    return claimed !== -1 && arriving !== -1 && arriving > claimed;
}

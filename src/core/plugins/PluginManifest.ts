import { Plugin, PluginApp, PluginAppSurface, PluginArgSchema, PLUGIN_APP_SURFACES } from "./Plugin";
import { isPluginId } from "./PluginRef";

/** Where a plugin's app lives when `ui` names no `entry`. */
export const DEFAULT_UI_ENTRY = "ui/index.html";

/**
 * A `plugin.json` - the single source of truth for what a plugin is.
 * Modelled on Azure DevOps' task manifest.
 *
 * `args` is an ordered array rather than a map: order matters when a
 * form is drawn from it, and JSON object key order is not reliable.
 */
export interface PluginManifest {

    /** Lowercase kebab. Half of the `uses: id@major` reference. */
    id: string;

    /** Shown in listings and errors. Falls back to the id. */
    name?: string;

    description?: string;

    version: PluginVersion;

    args?: PluginManifestArg[];

    /** Output keys this plugin produces, when it always produces the same ones. */
    artifacts?: string[];

    /** The name of an arg whose `string[]` value *is* the output keys. */
    artifactsFrom?: string;

    /** Whether an undeclared arg is handed over rather than rejected - see `Plugin.passthrough`. */
    passthrough?: boolean;

    /** Env var names the plugin may read through `ctx.secret()`. */
    secrets?: string[];

    /**
     * The name of a `string` arg holding a further env var name the
     * plugin may read - see `Plugin.secretsFrom`.
     */
    secretsFrom?: string;

    execution?: PluginExecution;

    /** The plugin's own app - a tab in the run and spec panels. `entry` defaults to `ui/index.html`; `surface` to `both`. */
    ui?: { label: string; entry?: string; surface?: PluginAppSurface };
}

/**
 * A workflow says `uses: pwsh@1` and pins the major only. Minor and
 * patch float, so a fix reaches every workflow without an edit. A
 * breaking change takes a new major: a new folder and a new reference.
 */
export interface PluginVersion {

    major: number;

    minor: number;

    patch: number;
}

export interface PluginManifestArg {

    name: string;

    type: "string" | "number" | "boolean" | "string[]" | "object" | "array";

    /** Shown beside the field when a human supplies or reviews this arg. */
    label?: string;

    description?: string;

    required?: boolean;

    default?: unknown;

    /** The only values this arg accepts. `string` args only. */
    options?: string[];

    /** Draw this one as a multi-line box rather than a single-line box. */
    multiline?: boolean;

    /** `false` keeps this arg's value out of the run log's `Args:` block - see {@link PluginArgSchema}. */
    logged?: boolean;
}

export interface PluginExecution {

    /** Entry point, relative to the plugin's folder. Defaults to `index.js`. */
    target?: string;
}

/** `1.4.2`, for display and logs. The reference only ever carries the major. */
export function versionString(version: PluginVersion): string {

    return `${version.major}.${version.minor}.${version.patch}`;
}

/**
 * The folder a plugin with this manifest must live in - `pwshV1`.
 * Azure's convention: the major is visible in a directory listing, and
 * two majors are two folders side by side.
 */
export function folderNameFor(manifest: PluginManifest): string {

    return `${manifest.id}V${manifest.version.major}`;
}

export class PluginManifestError extends Error {}

/**
 * Reads a parsed `plugin.json` into the shape the engine runs.
 *
 * Strict on purpose: a manifest is read once at startup, and a problem
 * caught here would otherwise surface mid-run with a worse message.
 *
 * @param execute The implementation. Kept separate because the manifest
 *                describes a plugin and cannot contain one.
 * @param folder  The directory it was found in, checked against the
 *                convention when given.
 * @param handle  The app's back end, when the implementation exports one.
 */
export function pluginFromManifest(
    manifest: PluginManifest,
    execute: Plugin["execute"],
    folder?: string,
    handle?: Plugin["handle"]
): Plugin {

    validate(manifest);

    if (folder && folder !== folderNameFor(manifest))
        throw new PluginManifestError(
            `Plugin '${manifest.id}' is in a folder named '${folder}', but its manifest says version ` +
            `${versionString(manifest.version)} - so it belongs in '${folderNameFor(manifest)}'.`);

    return {
        id: manifest.id,
        // The major alone. `uses: pwsh@1` must keep resolving when the
        // manifest moves to 1.4.2.
        version: String(manifest.version.major),
        description: manifest.description,
        args: schemaOf(manifest.args),
        artifacts: manifest.artifacts,
        artifactsFrom: manifest.artifactsFrom,
        passthrough: manifest.passthrough,
        secrets: manifest.secrets,
        secretsFrom: manifest.secretsFrom,
        ui: appOf(manifest),
        execute,
        ...(handle ? { handle } : {})
    };
}

/** The manifest's `ui`, with the default entry filled in. */
function appOf(manifest: PluginManifest): PluginApp | undefined {

    return manifest.ui
        ? { label: manifest.ui.label, entry: manifest.ui.entry ?? DEFAULT_UI_ENTRY, surface: manifest.ui.surface ?? "both" }
        : undefined;
}

/** The manifest's ordered array, as the map the engine validates against. */
function schemaOf(args: PluginManifestArg[] | undefined): PluginArgSchema | undefined {

    if (!args)
        return undefined;

    const schema: PluginArgSchema = {};

    for (const arg of args)
        schema[arg.name] = {
            type: arg.type,
            required: arg.required,
            // The engine has one description field, so the label is the
            // fallback when there is no description.
            description: arg.description ?? arg.label,
            default: arg.default,
            options: arg.options,
            multiline: arg.multiline,
            logged: arg.logged
        };

    return schema;
}

function validate(manifest: PluginManifest): void {

    if (!manifest || typeof manifest !== "object")
        throw new PluginManifestError("plugin.json is not an object.");

    if (!isPluginId(manifest.id))
        throw new PluginManifestError(
            "plugin.json needs an 'id' of lowercase letters, digits and hyphens.");

    const version = manifest.version;

    if (!version || [version.major, version.minor, version.patch].some(part => !Number.isInteger(part)))
        throw new PluginManifestError(
            `Plugin '${manifest.id}' needs a 'version' with whole-number major, minor and patch.`);

    if (version.major < 1)
        throw new PluginManifestError(
            `Plugin '${manifest.id}' has major version ${version.major}. ` +
            `A reference is 'id@major', and there is no 'uses: ${manifest.id}@0'.`);

    for (const arg of manifest.args ?? []) {

        if (typeof arg?.name !== "string" || !arg.name)
            throw new PluginManifestError(`Plugin '${manifest.id}' has an arg with no 'name'.`);

        if (arg.options === undefined)
            continue;

        // Caught at load. A default outside its own option list would
        // fail on exactly the tasks that set nothing.
        if (!Array.isArray(arg.options) || !arg.options.length)
            throw new PluginManifestError(
                `Arg '${arg.name}' of '${manifest.id}' declares 'options', so it needs at least one.`);

        if (arg.type !== "string")
            throw new PluginManifestError(
                `Arg '${arg.name}' of '${manifest.id}' declares 'options' but is a ${arg.type}. ` +
                `Options constrain a string.`);

        if (arg.options.some(option => typeof option !== "string"))
            throw new PluginManifestError(
                `Arg '${arg.name}' of '${manifest.id}' has a non-string option.`);

        if (arg.default !== undefined && !arg.options.includes(arg.default as string))
            throw new PluginManifestError(
                `Arg '${arg.name}' of '${manifest.id}' defaults to '${String(arg.default)}', ` +
                `which is not one of its options: ${arg.options.join(", ")}.`);
    }

    validateSecretsFrom(manifest);
    validateUi(manifest);
}

/**
 * An app needs a name for its tab and a page inside the plugin's own
 * folder. A path that climbs out would be read by the host with the
 * host's access, which is the one thing the sandbox exists to stop.
 */
function validateUi(manifest: PluginManifest): void {

    const ui = manifest.ui;

    if (ui === undefined)
        return;

    if (!ui || typeof ui !== "object" || typeof ui.label !== "string" || !ui.label.trim())
        throw new PluginManifestError(
            `Plugin '${manifest.id}' declares 'ui' without a 'label' - the tab needs a name.`);

    if (ui.entry !== undefined && (typeof ui.entry !== "string" || !ui.entry.trim()))
        throw new PluginManifestError(
            `Plugin '${manifest.id}' declares 'ui.entry', which must be a relative path like 'ui/index.html'.`);

    const entry = ui.entry ?? DEFAULT_UI_ENTRY;

    if (/^([a-zA-Z]:)?[\\/]/.test(entry) || entry.split(/[\\/]/).includes(".."))
        throw new PluginManifestError(
            `Plugin '${manifest.id}' declares 'ui.entry: ${entry}', which leaves the plugin's folder. ` +
            `It has to be a relative path inside it.`);

    if (ui.surface !== undefined && !PLUGIN_APP_SURFACES.includes(ui.surface))
        throw new PluginManifestError(
            `Plugin '${manifest.id}' declares 'ui.surface: ${String(ui.surface)}' - it is one of ${PLUGIN_APP_SURFACES.join(", ")}.`);
}

/**
 * A `secretsFrom` that names no arg would fail at run time as "that
 * token is not set" against a variable the user did set. Checked at
 * load instead.
 */
function validateSecretsFrom(manifest: PluginManifest): void {

    if (manifest.secretsFrom === undefined)
        return;

    const named = (manifest.args ?? []).find(arg => arg.name === manifest.secretsFrom);

    if (!named)
        throw new PluginManifestError(
            `Plugin '${manifest.id}' declares 'secretsFrom: ${manifest.secretsFrom}', but has no arg ` +
            `by that name. It accepts: ${(manifest.args ?? []).map(arg => arg.name).join(", ") || "(none)"}.`);

    if (named.type !== "string")
        throw new PluginManifestError(
            `Plugin '${manifest.id}' declares 'secretsFrom: ${manifest.secretsFrom}', but that arg is a ` +
            `${named.type}. It has to be a string - it holds an environment variable's name.`);
}

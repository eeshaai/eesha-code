import { ModelChoice } from "./AgentProvider";

/**
 * What an `ai` stage's settings entry can be given, per provider.
 *
 * A catalogue for completion only. Nothing validates against it:
 * `ai@1` is a passthrough plugin, so leaving a name out never makes it
 * illegal.
 *
 * Separate from `settings.schema.json` because a schema can only see
 * a `provider:` written in the block itself. When it is inherited from
 * `ai."ai@1".provider` - the usual case - JSON Schema cannot read that
 * sibling section, so the schema offers ghcp's args by default and
 * this narrows the list once the provider is actually known.
 */
export interface ProviderArg {

    name: string;

    detail: string;

    /** The values this arg accepts, when it is a fixed set. */
    values?: readonly string[];

    /** For a surface that renders a checkbox rather than a list. */
    boolean?: boolean;
}

/** The provider ids this build registers. See `coreProviders`. */
export const Providers = ["ghcp", "claude"] as const;

export type ProviderId = typeof Providers[number];

/** What ai@1 itself declares, whichever provider runs the session. */
const SHARED: ProviderArg[] = [
    {
        name: "uses",
        detail: "Run this stage on a different plugin. Structural - every other key is that plugin's arg."
    },
    {
        name: "provider",
        detail: "Which agent runtime the session runs on. Default: ghcp.",
        values: Providers
    },
    {
        name: "model",
        detail: "Model id, or 'auto' to let the provider pick."
    }
];

/**
 * Copilot's session options worth setting per stage, from the SDK's
 * `SessionConfigBase`. Not the whole interface: most of it is wiring
 * the engine owns (`tools`, `canvases`, `onPermissionRequest`), and
 * offering those would invite overriding a handler this provider
 * depends on.
 */
const GHCP: ProviderArg[] = [
    {
        name: "reasoningEffort",
        detail: "How hard the model thinks. Only valid on a model whose capabilities report it - 'auto' does not, so pin a model first.",
        values: ["low", "medium", "high", "xhigh", "max"]
    },
    {
        name: "contextTier",
        detail: "'long_context' pins the session to the larger context window.",
        values: ["default", "long_context"]
    },
    {
        name: "reasoningSummary",
        detail: "How much of the model's reasoning is summarised back.",
        values: ["none", "concise", "detailed"]
    },
    {
        name: "enableExperimentalMode",
        detail: "Turns on the runtime's experimental features for this session.",
        boolean: true
    },
    {
        name: "githubMcpToolConfig",
        detail: "Which tools the built-in GitHub MCP server exposes. Unset gives its default set. "
            + "Keys: enableAllTools, additionalToolsets, additionalTools (replaces the default list), "
            + "enableInsidersMode, disableFormDeferral."
    }
];

/**
 * Claude's are deliberately empty. Its passthrough lands on the Agent
 * SDK's `Options`, which is large, fast-moving, and mostly things this
 * provider sets itself. A name that autocompletes reads as supported,
 * so a guessed list is worse than none.
 */
const CLAUDE: ProviderArg[] = [];

/**
 * Every arg worth suggesting for a stage running on this provider.
 *
 * `ghcp` (or no provider, which resolves to it) is the one case with
 * per-vendor args to offer. `claude` and any `ai.acpAgents` id get the
 * empty list, for the reason `CLAUDE` is empty.
 */
export function argsFor(provider: string | undefined): ProviderArg[] {

    return [...SHARED, ...(provider === undefined || provider === "ghcp" ? GHCP : CLAUDE)];
}

/**
 * The values an arg accepts, narrowed by a live model catalogue where
 * there is one.
 *
 * `reasoningEffort` is why the catalogue matters: the SDK's type allows
 * five levels, but a model supports only the subset it reports, and
 * 'auto' supports none.
 *
 * @param model The `model:` in effect, when one is pinned.
 * @param acpAgents Configured `ai.acpAgents` ids, offered alongside
 *                  `provider`'s fixed set. This module reads no
 *                  settings.json, so the caller hands them over. Absent
 *                  means no workspace open, or nothing declared.
 */
export function valuesFor(
    arg: ProviderArg,
    catalogue: readonly ModelChoice[] | undefined,
    model: string | undefined,
    acpAgents?: readonly string[]
): readonly string[] | undefined {

    if (arg.name === "model")
        return catalogue?.length ? ["auto", ...catalogue.map(one => one.id)] : undefined;

    if (arg.name === "provider")
        return acpAgents?.length ? [...(arg.values ?? []), ...acpAgents] : arg.values;

    if (arg.name !== "reasoningEffort" || !catalogue)
        return arg.values;

    const chosen = catalogue.find(one => one.id === model);

    // No pinned model, or one this catalogue does not list: fall back
    // to the type's levels.
    return chosen ? chosen.reasoningEfforts ?? [] : arg.values;
}

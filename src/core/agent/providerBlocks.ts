/**
 * `providers:` - args that apply only when one runtime runs the session.
 *
 * An `ai:` block (settings.json's `ai."ai@1"`, a style's `ai:`, a
 * stage's `ai:`, a workflow step's `with:`) can say
 *
 *     providers:
 *       ghcp:     { model: gpt-5.2, reasoningSummary: concise }
 *       kiro-cli: { model: claude-sonnet-4.5 }
 *
 * and only the block for the runtime that actually runs is used. That is
 * what makes a runtime switch a click rather than a file edit: Copilot's
 * own options stay written down and are simply not sent to Kiro.
 *
 * Within one `ai:` block, a key in the running runtime's block beats the
 * same key written flat beside it. Across blocks, the usual order holds
 * (settings.json, then the style, then the stage), each already resolved
 * this way before the next goes over it.
 *
 * No dependencies, so the plugin host can use it without pulling in the
 * agent layer.
 */

/** The key the blocks sit under. */
export const PROVIDERS_KEY = "providers";

/** Keys a block cannot set: which runtime or plugin runs is not up to a block for one runtime. */
const REFUSED_IN_BLOCK = ["provider", "uses", PROVIDERS_KEY];

/** Blocks keyed by runtime id, each one that runtime's args. */
export type ProviderBlocks = Record<string, Record<string, unknown>>;

const isMapping = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * `providers:` checked for shape: a mapping of runtime id to a mapping of
 * args, none of which is `provider`, `uses` or `providers`.
 *
 * @param where How the error names the place, e.g. "Style 'custom' stage 'design'".
 */
export function checkProviderBlocks(value: unknown, where: string): ProviderBlocks {

    if (!isMapping(value))
        throw new Error(
            `${where} has a '${PROVIDERS_KEY}:' that is not a mapping. Write one entry per runtime id, `
            + "e.g. providers: { ghcp: { reasoningEffort: high }, kiro-cli: { model: claude-sonnet-4.5 } }.");

    for (const [id, block] of Object.entries(value)) {

        if (!isMapping(block))
            throw new Error(`${where} has '${PROVIDERS_KEY}.${id}' that is not a mapping of args.`);

        for (const key of REFUSED_IN_BLOCK)
            if (key in block)
                throw new Error(
                    `${where} sets '${key}' inside '${PROVIDERS_KEY}.${id}'. A block only applies once '${id}' `
                    + `is already the runtime, so it cannot choose one. Write '${key}' outside '${PROVIDERS_KEY}:'.`);
    }

    return value as ProviderBlocks;
}

/**
 * Fails when a block names a runtime this build does not register -
 * `kiro` written for `kiro-cli`. A block for an unknown id would never
 * apply, and nothing else would say so.
 *
 * @param known Every registered runtime id: ghcp, claude and each `ai.acpAgents` id.
 */
export function refuseUnknownProviders(
    args: Record<string, unknown> | undefined,
    known: readonly string[],
    where: string
): void {

    const blocks = args?.[PROVIDERS_KEY];

    if (!isMapping(blocks))
        return;

    const unknown = Object.keys(blocks).filter(id => !known.includes(id));

    if (unknown.length)
        throw new Error(
            `${where} has '${PROVIDERS_KEY}:' for ${unknown.map(id => `'${id}'`).join(", ")}, which is not a `
            + `registered runtime. Registered: ${known.join(", ")}.`);
}

/**
 * One `ai:` block as the running runtime sees it: its flat keys, then its
 * block for `provider` over them. `providers` itself is dropped, and so
 * is every other runtime's block.
 */
export function applyProviderBlock(
    args: Record<string, unknown> | undefined,
    provider: string
): Record<string, unknown> {

    if (!args)
        return {};

    const { [PROVIDERS_KEY]: blocks, ...flat } = args;

    const own = isMapping(blocks) && isMapping(blocks[provider]) ? blocks[provider] as Record<string, unknown> : {};

    return { ...flat, ...own };
}

/** The value `key` has in `args`'s block for `provider`, if that block sets it. */
export function blockValue(
    args: Record<string, unknown> | undefined,
    provider: string,
    key: string
): unknown {

    const blocks = args?.[PROVIDERS_KEY];

    if (!isMapping(blocks) || !isMapping(blocks[provider]))
        return undefined;

    return (blocks[provider] as Record<string, unknown>)[key];
}

/**
 * Two `ai:` blocks merged, `upper` winning per key - the same as spreading
 * one over the other, except `providers`, which is merged per runtime and
 * then per key. A block naming only `providers.ghcp.reasoningEffort`
 * keeps what the block under it said for `providers.ghcp.model`.
 */
export function mergeAiArgs(
    lower: Record<string, unknown> | undefined,
    upper: Record<string, unknown> | undefined
): Record<string, unknown> {

    const merged = { ...lower, ...upper };

    const below = lower?.[PROVIDERS_KEY];
    const above = upper?.[PROVIDERS_KEY];

    if (isMapping(below) && isMapping(above)) {

        const blocks: Record<string, unknown> = { ...below };

        for (const [id, block] of Object.entries(above))
            blocks[id] = isMapping(blocks[id]) && isMapping(block) ? { ...blocks[id] as object, ...block } : block;

        merged[PROVIDERS_KEY] = blocks;
    }

    return merged;
}

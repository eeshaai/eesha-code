import { expressionsIn, TEMPLATE_PATTERN } from "../../core/templating/TemplateResolver";

/**
 * The facts about the spec in front of a phase, readable from a
 * `style.yml` as `${{ spec.dir }}` and friends. Read-only: nobody sets
 * them, and the flow knows them all by the time a phase is assembled.
 *
 * `style.yml` resolves other `${{ }}` when it is read, once per style,
 * against the config scope (see `configScope`). There is no spec then,
 * so these are deferred: the parser checks only that the names are real
 * ({@link checkSpecNames}) and `assemble` answers them.
 *
 * They may be written in a stage's `instructions:`, `attachments:`,
 * `ai:` and `presets:`, and in the style's own `attachments:` and
 * `presets:`. The first three are answered by `assemble`; `presets:` by
 * the panel, when it draws the stage (see `phase/presets.ts`). Anywhere
 * else (`produces:`, a spec type's `stages:`, an id) is read by the walk
 * before a phase is assembled, so the expression would be compared as
 * literal text and the pipeline drawn wrong with no error.
 * {@link checkSpecPlacement} refuses that.
 *
 * Not in `settings.json`: settings are read strictly before a spec
 * exists, so `${{ spec.dir }}` among a plugin's defaults fails there.
 */

/** The namespace, and the word a style writes. */
export const SPEC_NAMESPACE = "spec";

/**
 * Every name a style may read. Fixed and closed: a name here is
 * permanent once a style is written against it, and an unknown name is
 * an error rather than an empty string.
 */
export const SPEC_VARS = {

    /**
     * The spec folder as the prompt already prints it - repository-relative
     * with forward slashes, or absolute when the spec root is outside
     * the repository.
     */
    dir: "the spec folder, as a path the agent resolves",

    /** The same folder as a place on disk, absolute. */
    path: "the spec folder as an absolute path",

    /** The folder's own name, with nothing in front of it. */
    name: "the spec's name",

    /** The spec type's id - what `＋ New Spec` was answered with. */
    type: "the spec type",

    /** The stage being assembled. */
    stage: "the stage being run"

} as const;

export type SpecVar = keyof typeof SPEC_VARS;

/** What one phase's expressions resolve against. */
export interface SpecFacts {

    /** The spec folder, as {@link SPEC_VARS.dir} describes it. */
    specDir: string;

    /**
     * The spec folder, absolute. Optional for the same reason
     * `PhaseInput.specPath` is: a caller with no disk behind it has none.
     * A style that reads `${{ spec.path }}` on such a run gets an error,
     * not an empty path.
     */
    specPath?: string;

    specType: string;

    stageId: string;
}

/** Every `${{ spec.… }}` a value writes, at any depth. */
export function specExpressionsIn(value: unknown): string[] {

    return expressionsIn(value).filter(one => one.split(".")[0] === SPEC_NAMESPACE);
}

/**
 * Checks every spec name a value reads is one that exists. The values
 * arrive later, but the names are known when the file is read, so a
 * typo is caught at load time rather than by the phase it would break.
 *
 * @param where names the file and key, so the message quotes what was
 * typed.
 */
export function checkSpecNames(value: unknown, where: string): void {

    for (const expression of specExpressionsIn(value)) {

        const name = expression.slice(SPEC_NAMESPACE.length + 1);

        if (!Object.prototype.hasOwnProperty.call(SPEC_VARS, name))
            throw new Error(
                `${where} writes '\${{ ${expression} }}', which is not a spec variable. `
                + `Available: ${names().join(", ")}.`);
    }
}

/**
 * Refuses a spec expression written where nothing would ever answer it.
 * See the module comment for why that failure would have no symptom.
 *
 * @param value the part of the file that may not hold one - the caller
 * has already taken out the keys that may.
 */
export function checkSpecPlacement(value: unknown, where: string): void {

    const stray = specExpressionsIn(value);

    if (stray.length)
        throw new Error(
            `${where} writes '\${{ ${stray[0]} }}' somewhere a spec variable cannot be read. `
            + "They are answered once a spec is in hand, so they belong to a stage's "
            + "'instructions:', 'attachments:', 'ai:' or 'presets:', or to the style's own "
            + "'attachments:' or 'presets:', and nowhere else.");
}

/**
 * The values, for one phase. A fact this run cannot supply is left out
 * rather than defaulted, so reading it fails with the reason.
 */
export function specValues(facts: SpecFacts): Partial<Record<SpecVar, string>> {

    return {
        dir: facts.specDir,
        path: facts.specPath,

        // Either separator: `specDir` is forward-slashed when it is
        // repository-relative and the platform's own when absolute.
        name: facts.specDir.split(/[\\/]/).filter(Boolean).pop(),
        type: facts.specType,
        stage: facts.stageId
    };
}

/**
 * Every `${{ spec.… }}` in a value, substituted. Recurses arrays and
 * maps, so an expression inside a stage's `ai:` is answered wherever it
 * sits.
 *
 * Always a string: unlike the engine's resolver, which keeps a number
 * when the whole value is one expression, every fact here is a path or
 * an id. Strict: an unresolvable expression throws, because nothing
 * downstream answers these and a leftover would reach the filesystem as
 * literal text.
 */
export function resolveSpecVars<T>(value: T, facts: SpecFacts, where: string): T {

    const values = specValues(facts);

    const walk = (one: unknown): unknown => {

        if (typeof one === "string")
            return one.replace(TEMPLATE_PATTERN, (match, expression: string) => {

                if (expression.split(".")[0] !== SPEC_NAMESPACE)
                    return match;

                return demand(expression, values, where);
            });

        if (Array.isArray(one))
            return one.map(walk);

        if (one !== null && typeof one === "object")
            return Object.fromEntries(
                Object.entries(one as Record<string, unknown>).map(([key, item]) => [key, walk(item)]));

        return one;
    };

    return walk(value) as T;
}

/** One expression's value, or the error saying why there is not one. */
function demand(expression: string, values: Partial<Record<SpecVar, string>>, where: string): string {

    const name = expression.slice(SPEC_NAMESPACE.length + 1) as SpecVar;

    if (!Object.prototype.hasOwnProperty.call(SPEC_VARS, name))
        throw new Error(
            `${where} writes '\${{ ${expression} }}', which is not a spec variable. `
            + `Available: ${names().join(", ")}.`);

    const value = values[name];

    // Only `spec.path` can be missing, and only for a caller with no
    // disk behind it. An error, not a blank, so no path is rooted at
    // nothing.
    if (value === undefined)
        throw new Error(
            `${where} writes '\${{ ${expression} }}', but this run has no ${SPEC_NAMESPACE}.${name} `
            + "to give - the spec folder was not located on disk.");

    return value;
}

/** The names as a style writes them, for an error that lists the choices. */
function names(): string[] {

    return Object.keys(SPEC_VARS).map(one => `\${{ ${SPEC_NAMESPACE}.${one} }}`);
}

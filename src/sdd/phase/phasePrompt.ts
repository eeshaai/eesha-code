import { TEMPLATE_PATTERN } from "../../core/templating/TemplateResolver";
import { SPEC_NAMESPACE, SpecFacts, SPEC_VARS, specValues } from "./specVars";

/**
 * The prompt a phase is run with - the whole message, as a file.
 *
 * There are five of them and a run uses exactly one: four for the
 * drafting phases, chosen by whether the document exists yet and whether
 * a person typed anything, and one for the implement phase, which writes
 * code rather than a document. Every
 * sentence and every heading the model is sent is in the file that runs,
 * in the order it is sent. Nothing is assembled around it.
 *
 * Not to be confused with the phase's *instructions* - `instructions/`
 * in the same style folder, attached to the session under the name
 * `how`. That file says how to do requirements or design; this one is
 * the request that carries it.
 *
 * They live in the style folder beside `style.yml`, so a style words the
 * request the way it words its instructions, and are resolved per file
 * through the same three scopes: a workspace copy of `rewrite.md`
 * changes rewrites and leaves the other two to whoever else has them. A
 * style with none of its own runs the text compiled into this bundle,
 * which is also what ships in the `custom` style's own folder.
 *
 * What one of these may hold is a placeholder for a fact. It holds no
 * placeholder that expands to a sentence: English that reaches the model
 * is written in the file, where the person who owns the file can read
 * it, reword it or delete it.
 */

/** Where a style keeps the five. */
export const PROMPTS_DIR = "prompts";

/**
 * The four passes, and the whole of the branching, which is not done in code. A mode is chosen once and picks a file; nothing downstream asks
 * again which pass it is.
 *
 * `implement` is the output gate's own file. It does not run `first` with the task list added by the panel, so every sentence of the prompt is in a file anybody can read or reword.
 */
export const MODES = ["first", "first-note", "rewrite", "rewrite-note", "implement"] as const;

export type PromptMode = typeof MODES[number];

/** Where each mode's file sits inside a style folder. */
export function promptFile(mode: PromptMode): string {

    return `${PROMPTS_DIR}/${mode}.md`;
}

/**
 * The shipped text of all five, compiled in at build time by
 * `esbuild.js` and by `vitest.config.ts` from the `custom` style.
 */
declare const __SDD_PROMPTS__: Record<PromptMode, string>;

/** @see __SDD_PROMPTS__ */
export const BUILT_IN: Record<PromptMode, string> = __SDD_PROMPTS__;

/**
 * The facts about this run, as against `${{ spec.… }}` - the facts about
 * the spec it is a run of.
 *
 * Two namespaces, and the split is what each is true of: `spec.name` is
 * the same on every phase of a spec, `phase.target` changes with the
 * phase. `spec.` is also read by `style.yml`, and one fact with two
 * spellings is a thing people get wrong.
 */
export const PHASE_NAMESPACE = "phase";

/** Every name a prompt may write beyond `${{ spec.… }}`. Fixed and closed. */
export const PHASE_VARS = {

    /**
     * What this phase writes, in backticks - `design.md`, or `a.md` and
     * `b.md`. The implement phase writes no document, so it has no value
     * here and a prompt writing it there is refused.
     */
    target: "the document this phase writes",

    /** The spec's own documents as attachment rows. One row saying None when there are none. */
    documents: "the spec's documents, as attachment rows",

    /** The style's, the stage's and the spec's reference files, as rows. Says None when there are none. */
    references: "the reference files, as attachment rows",

    /**
     * The spec's documents that are on disk, by file name and comma
     * separated - `requirements.md, design.md`. Says `none` when there
     * are none. Written for a native style's `command:`, which names the
     * documents the way the tool's own command does.
     */
    existing: "the spec's documents that exist, by file name",

    /**
     * The stage's `prefix:`, bare - `REQ`, not a sentence about it. A
     * stage that declares none has no value here, so a prompt writing it
     * is refused rather than rendering `-<n>` against nothing.
     */
    prefix: "the prefix this phase's own numbered items are cited with",

    /**
     * What the person typed, already quoted: when they pressed Revise
     * (`rewrite-note`), or in the spec's box when it started the phase
     * (`first-note`). Those two only.
     */
    note: "the instruction typed for this pass",

    /**
     * The tasks handed to this run, as rows - `- 1.1 Title (wave 0)`.
     * `implement` only: a drafting phase is handed no tasks, so a prompt
     * writing this there is refused.
     */
    tasks: "the tasks handed to this run, as rows"

} as const;

export type PhaseVar = keyof typeof PHASE_VARS;

/** What one phase's prompt resolves against, beyond the spec's own facts. */
export interface PhaseFacts {

    /** Absent on the implement phase, which writes no document. */
    target?: string;

    /** Already rendered rows, newline-separated. Never empty - see `rows` in `assemble`. */
    documents: string;

    /** @see documents */
    references: string;

    /** File names, comma separated, or `none`. Never empty. */
    existing: string;

    /** Absent unless the stage declared one, which makes writing it an error there. */
    prefix?: string;

    /** Absent on every pass nobody typed one, same rule. */
    note?: string;

    /** Already rendered rows. Absent on every phase but implement. */
    tasks?: string;
}

/**
 * Which of the five a run is.
 *
 * The implement phase has one file whatever the folder holds - it
 * rewrites nothing and takes no note. A drafting phase is a first pass
 * or a rewrite, each with or without a typed note.
 */
export function modeFor(rewriting: boolean, note?: string, implementing = false): PromptMode {

    if (implementing)
        return "implement";

    if (!rewriting)
        return note?.trim() ? "first-note" : "first";

    return note?.trim() ? "rewrite-note" : "rewrite";
}

/**
 * The message sent to the model: a prompt file with its placeholders
 * answered.
 *
 * Every line the author wrote is a line in the result. No placeholder
 * here can come back empty - a group with nothing in it says None, and a
 * fact this run does not have is an error rather than a blank - so there
 * is no case where a line would render to nothing and no rule about
 * dropping one. What is in the file is what is sent.
 *
 * A name that is neither a spec nor a phase fact is looked up in the
 * settings variables, read bare by top-level name the way tasks.yml
 * reads them - `${{ Profile.CurrentTeam }}`. A variable is per person,
 * which is what a prompt needs for a value like the team a branch is
 * cut under. It has to end in text, a number or a true/false: an
 * object would render as `[object Object]`.
 *
 * @param where names the file, so an error says which one to fix.
 * @param variables the settled `variables` section of settings.json.
 */
export function render(
    template: string,
    spec: SpecFacts,
    phase: PhaseFacts,
    where: string,
    variables?: Record<string, unknown>
): string {

    // Every name gets a key, so a fact this run does not have is told
    // apart from a name that does not exist. The two have different fixes, so they give different messages.
    const known: Record<string, string | undefined> = {
        ...prefixed(SPEC_NAMESPACE, specValues(spec)),
        ...prefixed(PHASE_NAMESPACE, Object.fromEntries(
            Object.keys(PHASE_VARS).map(name => [name, phase[name as PhaseVar]])))
    };

    const text = template.replace(TEMPLATE_PATTERN, (match, expression: string) => {

        if (!Object.prototype.hasOwnProperty.call(known, expression))
            return variable(expression, variables, where);

        const value = known[expression];

        if (value === undefined)
            throw new Error(
                `${where} writes '\${{ ${expression} }}', but this run has no ${expression} to give.`);

        return value;
    });

    return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * One settings variable, by its dotted path - see {@link render}. Throws
 * naming what exists, so a typo in the prompt or a variable missing
 * from this person's settings.json says which one to fix.
 */
function variable(expression: string, variables: Record<string, unknown> | undefined, where: string): string {

    const own = (value: unknown, key: string) =>
        value !== null && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);

    const [head, ...rest] = expression.split(".");

    if (!own(variables, head))
        throw new Error(
            `${where} writes '\${{ ${expression} }}', which is not a prompt variable or a settings variable. `
            + `Available: ${[...names(), ...Object.keys(variables ?? {})].join(", ")}. `
            + "A settings variable is declared under 'variables' in settings.json.");

    let value = variables![head];

    for (const segment of rest) {

        if (!own(value, segment))
            throw new Error(
                `${where} writes '\${{ ${expression} }}', but the settings variable '${head}' has no `
                + `'${segment}' under it. Add it under 'variables' in settings.json.`);

        value = (value as Record<string, unknown>)[segment];
    }

    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
        throw new Error(
            `${where} writes '\${{ ${expression} }}', but that settings variable is not text, a number `
            + "or true/false - point at one of the values under it.");

    return String(value);
}

/** Every name a prompt may write, spelled as it is written. */
export function names(): string[] {

    return [
        ...Object.keys(SPEC_VARS).map(one => `${SPEC_NAMESPACE}.${one}`),
        ...Object.keys(PHASE_VARS).map(one => `${PHASE_NAMESPACE}.${one}`)
    ];
}

/** `{ dir: "x" }` becomes `{ "spec.dir": "x" }` - the shape a lookup by expression wants. */
function prefixed(
    namespace: string,
    values: Record<string, string | undefined>
): Record<string, string | undefined> {

    return Object.fromEntries(
        Object.entries(values).map(([name, value]) => [`${namespace}.${name}`, value]));
}

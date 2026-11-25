import { Preset, Stage, Style } from "../model/style";
import { resolveSpecVars, SpecFacts } from "./specVars";

/**
 * What the revise box's split button offers when the style says
 * nothing - the two sentences a person would otherwise type by hand into the
 * Revise tab. Kept here rather than in the view so the view draws what
 * it is given and the rule for "what if nothing is declared" has one
 * home.
 */
export const DEFAULT_PRESETS: readonly Preset[] = [
    {
        label: "Revise (Prompt changed)",
        text: "The prompt template for this phase changed. Rework this document to match it."
    },
    {
        label: "Revise (Prev doc(s) changed)",
        text: "The previous file in this phase changed. Rework this document to match it."
    }
];

/**
 * The starting sentences one stage's revise box offers, for one spec.
 *
 * The style's own list first, then the stage's - general before
 * specific, the way `attachments` merge. A style that declares any
 * replaces the built-in sentences rather than adding to them: someone
 * who wrote a list should not be stuck with two lines they cannot
 * remove. A style that declares none gets {@link DEFAULT_PRESETS}.
 *
 * Spec variables are answered here, not at parse: a style is read once
 * and drawn for every spec, so `${{ spec.name }}` in a preset can only
 * be settled once the spec is known - same reason `assemble` answers
 * them for the other keys.
 *
 * @param where names the style and stage for an error about an
 * expression nothing can answer.
 */
export function presetsFor(style: Pick<Style, "presets">, stage: Stage, facts: SpecFacts, where: string): Preset[] {

    const declared = [...(style.presets ?? []), ...(stage.presets ?? [])];

    const chosen = declared.length ? declared : [...DEFAULT_PRESETS];

    return resolveSpecVars(chosen, facts, where);
}

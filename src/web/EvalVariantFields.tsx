import React from "react";

import { runtimeLabel } from "../view/ChatView";
import type { AiOptions, EvalVariantAsk, EvalVariantView } from "../server/protocol";

/*
 * The fields of one variant of an evaluation - on the form that makes an
 * evaluation, and on the one that adds, copies or changes a variant
 * later (see EvalPage.tsx).
 */

/** One variant as typed, before it is sent. */
export interface VariantDraft {

    /** Empty on a new one: the evaluation's name and a number. */
    name: string;

    runtime: string;

    /** Empty: the runtime's own default model. */
    model: string;

    /** Empty: the runtime's own default mode. */
    mode: string;

    /** Empty: the model's own default effort. */
    effort: string;

    /** The variant's own text, added under the common message. Empty: the common message alone. */
    extra: string;
}

export function newDraft(runtime: string): VariantDraft {

    return { name: "", runtime, model: "", mode: "", effort: "", extra: "" };
}

/** A draft with a variant's setup, under another name. */
export function draftOf(variant: EvalVariantView, name: string): VariantDraft {

    return { name, runtime: variant.runtime, model: variant.model ?? "", mode: variant.mode ?? "", effort: variant.effort ?? "", extra: variant.extra ?? "" };
}

/** What is sent for a draft: only what was filled in. */
export function askOf(draft: VariantDraft): EvalVariantAsk {

    return {
        ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
        runtime: draft.runtime,
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.mode ? { mode: draft.mode } : {}),
        ...(draft.effort ? { effort: draft.effort } : {}),
        ...(draft.extra.trim() ? { extra: draft.extra.trim() } : {})
    };
}

/** A variant's setup in one line: `Claude · opus · plan mode · high effort`. */
export function setupLine(variant: Pick<EvalVariantView, "runtime" | "model" | "mode" | "effort">): string {

    return [
        runtimeLabel(variant.runtime),
        variant.model ?? "default model",
        ...(variant.mode ? [`${variant.mode} mode`] : []),
        ...(variant.effort ? [`${variant.effort} effort`] : [])
    ].join(" · ");
}

interface Props {

    draft: VariantDraft;

    onChange(part: Partial<VariantDraft>): void;

    /** The runtimes on offer and their lists. Nothing yet: still being read. */
    options: AiOptions | undefined;

    /** Shown in the empty name field: the name it gets when none is typed. */
    namePlaceholder: string;

    /** The name cannot be changed: the variant exists already. */
    nameFixed?: boolean;
}

export default function EvalVariantFields({ draft, onChange, options, namePlaceholder, nameFixed }: Props): React.JSX.Element {

    const models = options?.models[draft.runtime] ?? [];
    const modes = options?.modes?.[draft.runtime] ?? [];
    const efforts = models.find(model => model.id === draft.model)?.efforts ?? [];

    return (
        <div className="evals__variant-fields">
            <div className="evals__variant-row">
                <label className="evals__field">
                    Variant name
                    <input className="evals__input" value={draft.name} disabled={nameFixed} onChange={event => onChange({ name: event.target.value })} placeholder={namePlaceholder} />
                </label>
                <label className="evals__field">
                    Runtime
                    <select className="evals__select" value={draft.runtime} onChange={event => onChange({ runtime: event.target.value, model: "", mode: "", effort: "" })}>
                        {(options?.runtimes ?? [draft.runtime]).map(id => <option key={id} value={id}>{runtimeLabel(id)}</option>)}
                    </select>
                </label>
                <label className="evals__field">
                    Model
                    <select className="evals__select" value={draft.model} onChange={event => onChange({ model: event.target.value, effort: "" })}>
                        <option value="">The runtime's default</option>
                        {models.map(model => <option key={model.id} value={model.id} disabled={model.disabled}>{model.name ?? model.id}</option>)}

                        {/* A model the list does not have - one picked months ago. */}
                        {draft.model && !models.some(model => model.id === draft.model) ? <option value={draft.model}>{draft.model}</option> : null}
                    </select>
                </label>
                <label className="evals__field">
                    Mode
                    <select className="evals__select" value={draft.mode} disabled={!modes.length && !draft.mode} onChange={event => onChange({ mode: event.target.value })}>
                        <option value="">{modes.length ? "The runtime's default" : "This runtime has none"}</option>
                        {modes.map(mode => <option key={mode.id} value={mode.id}>{mode.name ?? mode.id}</option>)}
                        {draft.mode && !modes.some(mode => mode.id === draft.mode) ? <option value={draft.mode}>{draft.mode}</option> : null}
                    </select>
                </label>
                <label className="evals__field">
                    Effort
                    <select className="evals__select" value={draft.effort} disabled={!efforts.length && !draft.effort} onChange={event => onChange({ effort: event.target.value })}>
                        <option value="">{efforts.length ? "The model's default" : draft.model ? "This model has none" : "Pick a model first"}</option>
                        {efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
                        {draft.effort && !efforts.includes(draft.effort) ? <option value={draft.effort}>{draft.effort}</option> : null}
                    </select>
                </label>
            </div>
            <label className="evals__field">
                Own text, added under the common message
                <textarea
                    className="evals__text"
                    rows={2}
                    value={draft.extra}
                    onChange={event => onChange({ extra: event.target.value })}
                    placeholder="Empty: this variant gets the common message alone. It can also be typed later, in the box at the foot of its column." />
            </label>
        </div>
    );
}

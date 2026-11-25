import { RowSort, sortRows } from "../../core/service/rowSort";
import { DiscoveredSpec } from "../discovery/discover";
import { startsSession } from "../model/style";
import { SddCore } from "../SddCore";

/*
 * The list of specs in a workspace, as a specs list shows it: one row per
 * spec, and the lines that are not specs - a style that would not load,
 * two spec folders with one name, an empty spec folder.
 */

/** A line in the list that is not a spec to open. */
export interface SpecListNote {

    /**
     * What it is about: a configured style that could not be read, a
     * spec name in two spec folders, or no specs at all.
     */
    kind: "style" | "clash" | "empty";

    text: string;

    tooltip?: string;
}

/** What one spec's row says about it. */
export interface SpecRowFacts {

    /** The style, then the phase waiting - "custom · design", "custom · implementing", "custom · done" - or "unplaced". */
    description: string;

    /** The phase part of `description` on its own - "design", "implementing", "done". Nothing for a spec no style could place. */
    phase?: string;

    /**
     * Where the spec is: no style could place it, its work has moved to
     * code, the next stage acts the moment it is reached (a gate), or
     * the next stage waits for a person to start it.
     */
    status: "unplaced" | "implementing" | "gate" | "next";

    /** How many of the spec's stages are done, of how many. Nothing for a spec no style could place. */
    progress?: { done: number; total: number };
}

/**
 * The specs of a workspace, in the reader's order, with the notes that
 * go above them.
 *
 * `problems` is every style that would not load, by id, with why - for
 * the caller to write down.
 */
export async function listSpecs(core: SddCore, sort: RowSort): Promise<{
    notes: SpecListNote[];
    specs: DiscoveredSpec[];
    problems: ReadonlyMap<string, string>;
}> {

    const { specs, problems, clashes } = await core.view();

    // A broken configured style comes first, with or without specs: it
    // is why every row below it is unplaced, and with an empty root it
    // is the only thing to say.
    const notes: SpecListNote[] = core.config.styles
        .filter(id => problems.has(id))
        .map((id): SpecListNote => ({
            kind: "style",
            text: `Style '${id}' could not be read`,
            tooltip: problems.get(id)
        }));

    // Two spec folders with one name. Only the first is listed, so the
    // second would otherwise vanish without a word.
    notes.push(...clashes.map((clash): SpecListNote => ({
        kind: "clash",
        text: `Spec '${clash.name}' is in two spec folders`,
        tooltip: clash.message
    })));

    if (!specs.length) {

        const roots = (await core.specRoots()).map(root => root.folder);

        notes.push({
            kind: "empty",
            text: `No specs in ${roots.join(", ")}`,
            tooltip: `Styles: ${core.config.styles.join(", ")}\nSpec folders: ${roots.join(", ")}`
        });

        return { notes, specs: [], problems };
    }

    // Sorted here rather than in core: the order is this reader's
    // choice, and core's own order stays fixed.
    const ordered = sortRows(specs, sort, spec => ({ label: spec.name, modified: spec.modified }));

    return { notes, specs: ordered, problems };
}

/** What a spec's row says - see {@link SpecRowFacts}. */
export function specRow(spec: DiscoveredSpec): SpecRowFacts {

    const next = spec.state?.next;

    const phase = spec.detection.style
        ? spec.state?.complete && spec.state.implement ? "implementing" : next ? next.id : "done"
        : undefined;

    const description = phase ? `${spec.detection.style} · ${phase}` : "unplaced";

    // A drafting phase waits to be pressed; a gate acts the moment it is
    // reached. Read off what the next stage is.
    const status = !spec.detection.style ? "unplaced"
        : spec.state?.implement ? "implementing"
            : spec.state?.next && !startsSession(spec.state.next)
                ? "gate"
                : "next";

    return {
        description,
        ...(phase ? { phase } : {}),
        status,
        ...(spec.state
            ? { progress: { done: spec.state.stages.filter(stage => stage.status === "done").length, total: spec.state.stages.length } }
            : {})
    };
}

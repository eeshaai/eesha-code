import * as fs from "fs";
import * as path from "path";

import type { DiscoveredSpec } from "../sdd/discovery/discover";
import { IMPLEMENT, isTerminal } from "../sdd/model/style";
import type { PathMatch } from "../shared/composeFiles";
import { isSpecAction, SPEC_ACTIONS, SPEC_ALL, SPEC_NEW, SPEC_PATH, type SpecAction, type SpecCommandAnswer } from "../shared/specPaths";
import type { SddPlace } from "./ServerSddHost";
import type { SpecSessionView, SpecWidgetView } from "./protocol";

/*
 * `>spec` in a session's message box - see `shared/specPaths.ts`. The
 * rows of each level, what a document path sends to the agent, and what
 * an action does. Everything is read from the spec folders on each ask.
 */

/** One spec of a workspace, with the place it is in - the workspace with the spec's own folder as the main one. */
export interface PlacedSpec {

    place: SddPlace;

    spec: DiscoveredSpec;

    /** Its folder when that is not the workspace's main one - as an address names it. */
    folder?: string;
}

/** What the paths need from the specs on the server - `SddSpecs` is it. */
export interface SpecSource {

    /** Every spec in the workspace's folders, the main folder's first. Nothing: no such workspace. */
    placed(key: string): Promise<PlacedSpec[] | undefined>;

    widget(place: SddPlace, name: string, phase?: string): Promise<SpecWidgetView | undefined>;

    sessions(place: SddPlace, spec: string): SpecSessionView[];

    /** `note`: text typed for the phase's first pass. */
    start(place: SddPlace, spec: string, stageId: string, note?: string): Promise<{ chatId: string } | { problem: string }>;

    /** Stops the phase or wave of the spec that runs now. False: nothing of it runs. */
    stop(place: SddPlace, spec: string): boolean;
}

/** A written document of a spec: the phase that writes it, and the file. */
interface SpecDocument {

    stage: string;

    label: string;

    file: string;
}

function documentsOf(spec: DiscoveredSpec): SpecDocument[] {

    return (spec.state?.stages ?? []).flatMap((state): SpecDocument[] => {

        const artifact = isTerminal(state.stage) ? undefined : state.stage.produces[0];
        const file = artifact ? path.join(spec.folder, artifact) : undefined;

        return file && fs.existsSync(file) ? [{ stage: state.stage.id, label: state.stage.label, file }] : [];
    });
}

const named = (all: PlacedSpec[], name: string) => all.find(one => one.spec.name.toLowerCase() === name.toLowerCase());

const matches = (rows: PathMatch[], query: string) => rows.filter(row => row.name.toLowerCase().includes(query.toLowerCase()));

/** The newest phase chat of a spec, if a phase ever ran in one. */
function newestChat(source: SpecSource, found: PlacedSpec): string | undefined {

    return source.sessions(found.place, found.spec.name)
        .filter(one => one.chatId !== undefined)
        .reduce<SpecSessionView | undefined>((best, one) => !best || one.at >= best.at ? one : best, undefined)?.chatId;
}

/**
 * The rows one level below `below` - the levels typed after `>`, the
 * first of them `spec`. With nothing typed yet: the `spec` row itself.
 */
/** What `>spec` says in a session that is in no workspace: specs live only in a workspace. */
export const NO_WORKSPACE_SPECS = "This session is in no workspace, so it has no specs. Open the workspace the spec belongs to and start a session there.";

export async function specPathRows(source: SpecSource, key: string | undefined, below: readonly string[], query: string): Promise<PathMatch[]> {

    if (!key)
        return below.length
            ? [{ name: "none", detail: NO_WORKSPACE_SPECS, disabled: true }]
            : matches([{ name: SPEC_PATH, detail: "Specs - only in a workspace", hint: "no workspace", disabled: true }], query);

    if (!below.length)
        return matches([{ name: SPEC_PATH, detail: "Specs of this workspace" }], query);

    const all = await source.placed(key);

    if (!all)
        return [{ name: "none", detail: "This session's workspace is not here any more.", disabled: true }];

    // `>spec>`: New spec, then every spec with the phase it is at.
    if (below.length === 1)
        return matches([
            { name: SPEC_NEW, detail: "Make a new spec - type what it is about after it", hint: "action", leaf: true },
            ...all.map(one => ({ name: one.spec.name, detail: one.spec.state?.next ? `at ${one.spec.state.next.label}` : "every phase written" }))
        ], query);

    const found = named(all, below[1]!);

    if (!found || below.length > 2)
        return [];

    const view = await source.widget(found.place, found.spec.name);
    const documents = documentsOf(found.spec);
    const working = view?.working === true;
    const next = view?.next;

    const off = (action: SpecAction): string | undefined => {

        switch (action) {

            case "resume": return newestChat(source, found) ? undefined : "no phase has run yet";

            case "next":
                return working ? "the spec is working"
                    : !next ? "every phase is written"
                        : next.plan ? "starts from the plan"
                            : next.blocked ? "open questions first" : undefined;

            case "plan": return found.spec.state?.stages.some(one => isTerminal(one.stage)) ? undefined : "this spec has no implementation phase";

            case "notes": return view?.doc?.notes ? undefined : "no open notes";

            case "changes": return view?.doc ? undefined : "no document written yet";

            default: return undefined;
        }
    };

    const actions = (Object.keys(SPEC_ACTIONS) as SpecAction[])

        // Stop is listed only while something runs.
        .filter(action => action !== "stop" || working)
        .map((action): PathMatch => {

            const why = off(action);

            return {
                name: action,
                detail: action === "next" && next && !next.plan ? `Start ${next.label} in a new chat` : SPEC_ACTIONS[action],
                hint: why ?? "action",
                leaf: true,
                ...(why ? { disabled: true } : {})
            };
        });

    return matches([
        ...documents.map((one): PathMatch => ({ name: one.stage, detail: `${path.basename(one.file)} - goes to the agent with your message`, hint: "document", leaf: true })),
        ...(documents.length > 1 ? [{ name: SPEC_ALL, detail: `All ${documents.length} written documents - go to the agent with your message`, hint: "document", leaf: true }] : []),
        ...actions
    ], query);
}

/**
 * What a `>spec>NAME>...` path in a sent message gives the agent: the
 * document's full path, on a line under the message - the agent reads
 * the file itself. An action written inside a longer message does not
 * run, and says so.
 */
export async function specPathReference(source: SpecSource, key: string, below: readonly string[]): Promise<{ line?: string; problem?: string }> {

    const [, name = "", word = ""] = below;

    if (below.length !== 3)
        return { problem: "write it as >spec>name>design" };

    const found = named(await source.placed(key) ?? [], name);

    if (!found)
        return { problem: `there is no spec '${name}' in this workspace` };

    if (isSpecAction(word.toLowerCase()))
        return { problem: "an action runs only when it is the whole message" };

    const documents = documentsOf(found.spec);

    if (word.toLowerCase() === SPEC_ALL)
        return documents.length
            ? { line: documents.map(one => `Spec '${found.spec.name}', ${one.label}: ${one.file}`).join("\n") }
            : { problem: `spec '${name}' has no written document yet` };

    const one = documents.find(document => document.stage.toLowerCase() === word.toLowerCase());

    return one
        ? { line: `Spec '${found.spec.name}', ${one.label}: ${one.file}` }
        : { problem: `spec '${name}' has no written document '${word}'` };
}

/**
 * Runs one action on a spec and answers what the page does next - see
 * `SpecCommandAnswer`. `phase`: the phase of the chat it was typed in,
 * when that is a phase chat - its document is the one meant. `text`:
 * for `next`, what was typed in the spec's box - it goes into the
 * phase's first pass.
 */
export async function specCommand(
    source: SpecSource,
    key: string,
    name: string,
    action: SpecAction,
    phase?: string,
    text?: string
): Promise<SpecCommandAnswer | { problem: string }> {

    const all = await source.placed(key);

    if (!all)
        return { problem: "This session's workspace is not here any more. Reload the page." };

    const found = named(all, name);

    if (!found)
        return { problem: `There is no spec '${name}' in this workspace.` };

    const at = { spec: found.spec.name, ...(found.folder ? { folder: found.folder } : {}) };
    const view = async () => await source.widget(found.place, found.spec.name, phase);

    switch (action) {

        case "watch":
            return at;

        case "open":
            return { ...at, open: {} };

        case "resume": {

            const chatId = newestChat(source, found);

            return chatId
                ? { ...at, chatId }
                : { ...at, open: {}, note: `No phase of ${found.spec.name} has run yet. Start one with >spec>${found.spec.name}>next.` };
        }

        case "next": {

            const next = (await view())?.next;

            if (!next)
                return { problem: `Every phase of ${found.spec.name} is written.` };

            if (next.plan)
                return { ...at, open: { phase: next.id }, note: `${next.label} starts from the plan, wave by wave.` };

            const started = await source.start(found.place, found.spec.name, next.id, text?.trim() || undefined);

            return "problem" in started ? started : { ...at, chatId: started.chatId };
        }

        case "plan":
            return found.spec.state?.stages.some(one => isTerminal(one.stage))
                ? { ...at, open: { phase: IMPLEMENT } }
                : { problem: `${found.spec.name} has no implementation phase.` };

        case "notes": {

            const doc = (await view())?.doc;

            return doc?.notesText
                ? { ...at, text: doc.notesText }
                : { problem: doc ? `${doc.file} has no open review notes.` : `${found.spec.name} has no written document yet.` };
        }

        case "changes": {

            const doc = (await view())?.doc;

            return doc
                ? { ...at, open: { phase: doc.phase }, ...(doc.changed ? {} : { note: `The last turn changed nothing in ${doc.file}.` }) }
                : { problem: `${found.spec.name} has no written document yet.` };
        }

        case "stop":
            return source.stop(found.place, found.spec.name)
                ? { ...at, note: `Stopping ${found.spec.name}.` }
                : { problem: `Nothing of ${found.spec.name} runs now.` };
    }
}

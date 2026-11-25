import * as fs from "fs";
import * as path from "path";

import type { DiscoveredSpec } from "../sdd/discovery/discover";
import { unansweredQuestions } from "../sdd/documents/openQuestions";
import { isIdea, isTerminal } from "../sdd/model/style";
import { baseline, readNotes } from "../sdd/panel/reviewStore";
import { blockedBy } from "../sdd/view/openQuestionGate";
import type { SpecStage } from "../shared/runMessages";
import { changedCount, diffBlocks } from "../view/diff/blockDiff";
import { anchorNotes, reviseInstruction } from "../view/templates/reviewNotes";
import type { SpecWidgetDoc, SpecWidgetNext, SpecWidgetView } from "./protocol";

/*
 * What the widget over a phase chat shows about its spec - see
 * `SpecWidgetView`. Everything is read from disk on each ask: the spec
 * folder is the state, and nothing here is kept.
 *
 * No controller is made for it. A spec's controller exists while a tab
 * shows the spec or a phase runs; a widget that only reads must not
 * hold one open.
 */

/** What the caller knows that the folder does not say. */
export interface WidgetFacts {

    /** A phase or a wave of the spec runs now. */
    working: boolean;

    /** Its agent asked something and nobody answered yet. */
    waiting: boolean;

    /** The style's `blockOnOpenQuestions:` - true unless the style says no. */
    blockOnOpenQuestions: boolean;
}

/** Two paths to one file - as the spec's page compares them. */
function samePath(left: string, right: string): boolean {

    const plain = (file: string) => path.resolve(file).replace(/\\/g, "/").toLowerCase();

    return plain(left) === plain(right);
}

function read(file: string): string | undefined {

    try {

        return fs.readFileSync(file, "utf8");

    } catch {

        return undefined;
    }
}

/**
 * The widget's facts for one spec.
 *
 * @param root the folder the spec's phases run in - the workspace's
 * main folder, or the folder standing in for it.
 * @param phase the phase of the chat the widget is over - a stage id,
 * or `<stage id>@wave:<n>`. Its document's changes and notes are
 * counted. Absent - the chat is no phase chat: the last document
 * written is the one counted.
 */
export function specWidget(spec: DiscoveredSpec, root: string, facts: WidgetFacts, phase?: string): SpecWidgetView {

    const states = spec.state?.stages ?? [];

    const view: SpecWidgetView = {
        spec: spec.name,
        phases: states.map(state => ({
            id: state.stage.id,
            label: state.stage.label,
            status: state.status,
            ...(isIdea(state.stage) ? { chatless: true as const } : {})
        })),
        working: facts.working,
        waiting: facts.waiting
    };

    const doc = docOf(spec, root, phase ?? lastWritten(spec));

    if (doc)
        view.doc = doc;

    const next = nextOf(spec, facts.blockOnOpenQuestions);

    if (next)
        view.next = next;

    return view;
}

/**
 * The document of the chat's phase: how many of its blocks differ from
 * the copy put aside before the phase's last turn, and its open notes.
 * Nothing for a phase with no document (a wave chat's phase, the
 * implementation) or one not written yet.
 */
function docOf(spec: DiscoveredSpec, root: string, phase: string | undefined): SpecWidgetDoc | undefined {

    if (!phase)
        return undefined;

    const at = phase.indexOf("@");
    const stageId = at < 0 ? phase : phase.slice(0, at);
    const stage = spec.state?.stages.find(one => one.stage.id === stageId)?.stage;
    const artifact = stage && !isTerminal(stage) ? stage.produces[0] : undefined;

    if (!artifact)
        return undefined;

    const file = path.join(spec.folder, artifact);
    const content = read(file);

    if (content === undefined)
        return undefined;

    const before = baseline(spec.folder, root, file);

    const open = anchorNotes(readNotes(spec.folder, root).filter(note => samePath(note.artifact, file)), content)
        .filter(note => !note.resolved);

    return {
        phase: stageId,
        file: path.basename(file),
        ...(before === undefined ? {} : { changed: changedCount(diffBlocks(before, content)) }),
        notes: open.length,
        ...(open.length ? { notesText: reviseInstruction(open, content) } : {})
    };
}

/** The last drafting phase whose document is written - the one a chat that is no phase chat is most likely about. */
function lastWritten(spec: DiscoveredSpec): string | undefined {

    return (spec.state?.stages ?? [])
        .filter(state => !isIdea(state.stage) && !isTerminal(state.stage) && state.stage.produces[0] !== undefined && state.status === "done")
        .pop()?.stage.id;
}

/**
 * The phase a press of Start would begin: the first one not done.
 * Nothing when every phase is done, or the first one not done is the
 * Idea, which no chat writes.
 */
function nextOf(spec: DiscoveredSpec, blockOnOpenQuestions: boolean): SpecWidgetNext | undefined {

    const states = spec.state?.stages ?? [];
    const next = spec.state?.next;

    if (!next || isIdea(next))
        return undefined;

    // The implementation starts from the plan's own page, wave by wave.
    if (isTerminal(next))
        return { id: next.id, label: next.label, plan: true };

    // As the spec's page refuses the press: only over the documents before it.
    const stages: SpecStage[] = states.map(state => {

        const artifact = state.stage.produces[0] ? path.join(spec.folder, state.stage.produces[0]) : undefined;
        const text = blockOnOpenQuestions && artifact && !isIdea(state.stage) ? read(artifact) : undefined;
        const questions = text === undefined
            ? []
            : unansweredQuestions(text).map(question => ({ ...(question.id ? { id: question.id } : {}), text: question.text }));

        return {
            name: state.stage.id,
            ...(artifact ? { artifact } : {}),
            ...(questions.length ? { openQuestions: questions } : {})
        };
    });

    const blocked = blockedBy(stages, next.id, file => path.basename(file));

    return { id: next.id, label: next.label, ...(blocked ? { blocked } : {}) };
}

import type { SpecFolderView, SpecSessionView, SpecTreeRow } from "../server/protocol";
import { stageOf } from "../sdd/view/sessionRuns";

/*
 * What the Spec explorer (SpecExplorer.tsx) draws, worked out without
 * drawing anything, so a test can read it: how a folder's specs are
 * grouped, and which sessions sit under which phase.
 */

/** One group of specs in a folder: the specs of one kind kept in one folder. */
export interface SpecGroup {

    key: string;

    /** "Eesha", "Kiro" or "Spec Kit". */
    label: string;

    /** Where they are kept, from the workspace folder - `.kiro/specs`. */
    root: string;

    specs: SpecTreeRow[];
}

/** What a kind of spec is called on screen. */
export function kindLabel(native: SpecTreeRow["native"]): string {

    return native === "kiro" ? "Kiro" : native === "speckit" ? "Spec Kit" : "Eesha";
}

/** The order the kinds are listed in. */
const KIND_ORDER = ["Eesha", "Kiro", "Spec Kit"];

/**
 * A folder's specs, grouped by kind and by the folder they are kept in -
 * Eesha first, then Kiro, then Spec Kit. Inside a group the specs keep
 * the server's order (this workspace's own first, then the sort).
 */
export function specGroups(folder: Pick<SpecFolderView, "specs">): SpecGroup[] {

    const groups = new Map<string, SpecGroup>();

    for (const spec of folder.specs) {

        const label = kindLabel(spec.native);
        const key = `${label}|${spec.root}`;

        let group = groups.get(key);

        if (!group) {

            group = { key, label, root: spec.root, specs: [] };
            groups.set(key, group);
        }

        group.specs.push(spec);
    }

    return [...groups.values()].sort((left, right) =>
        KIND_ORDER.indexOf(left.label) - KIND_ORDER.indexOf(right.label) || left.root.localeCompare(right.root));
}

/**
 * The sessions of one phase, newest first. The execution phase's chats
 * (`implement@wave:2`) are its sessions.
 */
export function phaseSessions(sessions: readonly SpecSessionView[], phaseId: string): SpecSessionView[] {

    return sessions
        .filter(one => stageOf(one.ownerId) === phaseId)
        .sort((left, right) => right.at - left.at);
}

/** One spec's place in the explorer, for the keys of what is open. */
export function specKey(folder: string, spec: string): string {

    return `${folder}|${spec}`;
}

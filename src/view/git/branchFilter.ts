/*
 * What the branch window lists for the text typed in its box.
 */

/** A branch, as far as the filter needs to know. */
export interface BranchLike {

    name: string;

    remote: boolean;
}

/** The branches whose name has the typed text in it, ignoring capitals. No text: all of them. */
export function filterBranches<T extends BranchLike>(branches: readonly T[], text: string): T[] {

    const wanted = text.trim().toLowerCase();

    return branches.filter(one => !wanted || one.name.toLowerCase().includes(wanted));
}

/** The name the box offers as a new branch: the typed text, when new branches are allowed and no local branch has that name. */
export function createBranchName(branches: readonly BranchLike[], text: string, allowCreate: boolean | undefined): string | undefined {

    const typed = text.trim();

    return allowCreate && typed !== "" && !branches.some(one => !one.remote && one.name === typed) ? typed : undefined;
}

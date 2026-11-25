/**
 * How a client orders a section whose rows have no author-written
 * order (workflows, specs). The Tasks section has one, so it offers
 * `file` vs `alpha` instead - see `TaskSort` in taskEntries.
 */
export type RowSort = "alpha" | "recent";

/** What a row is sorted by: the name it shows, and when it last changed. */
export interface SortKey {

    /** The label the row draws. Not an id or a path. */
    label: string;

    /** Last modified, epoch milliseconds. `0` when it could not be read. */
    modified: number;
}

/**
 * A copy of `rows` in the chosen order.
 *
 * A-Z is case- and accent-insensitive. Recent is newest first, falling
 * back to A-Z on equal timestamps, which is the ordinary case for files
 * checked out together.
 */
export function sortRows<T>(
    rows: readonly T[],
    sort: RowSort,
    keyOf: (row: T) => SortKey
): T[] {

    const byName = (left: T, right: T) =>
        keyOf(left).label.localeCompare(keyOf(right).label, undefined, { sensitivity: "base" });

    if (sort === "alpha")
        return [...rows].sort(byName);

    return [...rows].sort((left, right) =>
        keyOf(right).modified - keyOf(left).modified || byName(left, right));
}

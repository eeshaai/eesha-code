import type { SpecRowView } from "../server/protocol";

/*
 * The second line of a spec's row in the SDD panel (SpecList.tsx). In a
 * file of its own, with no page code, so a test can read it.
 */

/** What a row's second line says: "custom · design · 1/4". */
export function specFacts(row: SpecRowView): string {

    if (!row.style)
        return "no style could place it";

    return [row.style, row.phase, row.total !== undefined ? `${row.done ?? 0}/${row.total}` : undefined]
        .filter(Boolean)
        .join(" · ");
}

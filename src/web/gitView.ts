/*
 * The question Discard asks in the Git panel. The rest of what the panel
 * shows is worked out in view/git/gitStatusView.ts; this one is here
 * because it names Eesha Code's own trash folder. It imports nothing, so
 * the server's type check does not pull in the UI library.
 */

/** A changed file's row, as the library's Git panel hands it back: only what the question needs. */
export interface DiscardRow {

    file: { path: string };

    /** U: a new file git does not track. */
    letter: string;
}

/** The question Discard asks: what goes, and that it cannot be undone. */
export function discardQuestion(rows: readonly DiscardRow[]): string {

    const untracked = rows.filter(row => row.letter === "U").length;
    const tracked = rows.length - untracked;

    const what = rows.length === 1
        ? `Discard the changes to ${rows[0].file.path}?`
        : `Discard the changes to ${rows.length} files?`;

    const parts = [
        tracked ? `${tracked === 1 && rows.length === 1 ? "The file goes" : `${tracked} file${tracked === 1 ? " goes" : "s go"}`} back to the staged copy, or the last commit - the edits on disk are lost.` : "",
        untracked ? `${untracked === 1 && rows.length === 1 ? "This new file is" : `${untracked} new file${untracked === 1 ? " is" : "s are"}`} moved to ~/.eesha/trash.` : ""
    ].filter(Boolean);

    return `${what} ${parts.join(" ")}`;
}

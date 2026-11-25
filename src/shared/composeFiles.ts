/**
 * A file sent with a message from a compose box.
 *
 * - `path`: a file in the workspace, picked with "/" in the box. Relative
 *   to the folder the panel searched, or absolute.
 * - `upload`: a file dropped on the box or picked with its attach button.
 *   The browser has its bytes but no path on disk, so the host saves it
 *   first - see `sentFiles.ts`.
 */
export type SentFile =
    | { kind: "path"; path: string; name?: string }
    | { kind: "upload"; name: string; contentBase64: string };

/** One match for the "@" file search, as the box lists it. */
export interface FileMatch {

    name: string;

    /** Relative to the folder searched, with forward slashes. */
    path: string;
}

/**
 * One row of the compose box's ">" list - Eesha Code's connectors.
 * A path like
 * `>ado>workitems>12345` is typed one level at a time.
 */
export interface PathMatch {

    /** This level of the path, as it is typed: "ado", "workitems", "12345". No spaces. */
    name: string;

    /** What it is, after the name: "Azure DevOps", "Bug - Login fails on SSO". */
    detail?: string;

    /** A short word on the right: "Active", "Read only". */
    hint?: string;

    /** Picking it ends the path. Otherwise ">" follows and the next level opens. */
    leaf?: boolean;

    /** Shown, but cannot be picked - `hint` says why. */
    disabled?: boolean;

    /**
     * The row that asks the service again: picking it does not add to
     * the path, it asks for the same level with `refresh` set. Eesha Code
     * adds it when the rows came from a saved list.
     */
    refresh?: boolean;
}

/** The largest file the attach button takes, in bytes. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

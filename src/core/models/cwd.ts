/**
 * The one `cwd:` value that is not a directory.
 *
 * `cwd: none` says the definition does not act on any folder - for
 * example a workflow that only calls an HTTP endpoint. Without it a
 * workspace- or profile-level definition is asked to pick a folder on
 * every run.
 *
 * A word rather than a symbol: `!` is the YAML tag indicator, so
 * `cwd: !` parses to an empty string.
 */
export const NO_FOLDER = "none";

/**
 * Whether the author wrote a `cwd:` at all - at file level or on a
 * task. This, not the value, decides whether a client asks which folder
 * to run in: `cwd: ./api` and `cwd: none` both answer the question.
 */
export function declaresCwd(cwd: string | undefined): boolean {

    return cwd !== undefined;
}

/**
 * The part of a `cwd:` a resolver can resolve - the declared path, or
 * undefined for `none`.
 *
 * `none` is kept in the model rather than dropped at parse time, so
 * "the author said there is no folder" and "the author said nothing"
 * stay distinct - only the first silences the folder pick.
 *
 * Matched case-insensitively, so `None` is not a directory called
 * `None`. A real folder of that name is still reachable as `./none`.
 */
export function cwdToResolve(cwd: string | undefined): string | undefined {

    return cwd !== undefined && cwd.trim().toLowerCase() === NO_FOLDER ? undefined : cwd;
}

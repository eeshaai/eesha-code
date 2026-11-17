import * as path from "path";

/**
 * A path into the repository, for a stage's `instructions:` or one of its
 * `attachments:`.
 *
 * The file must live in the repository, so it travels in git with the
 * style that points at it and a teammate's checkout resolves the same
 * one. A style naming `C:/Users/...` resolves on one machine only.
 *
 * An absolute path is not simply refused, because `${{ }}` is resolved
 * before this runs, and the natural spelling -
 * `${{ workspaceFolder }}/docs/shape.md` - arrives here as exactly the
 * absolute path a blanket refusal would turn away. So an absolute path
 * inside the workspace is folded back to a relative one; one outside
 * earns the same "climbs out" error a `..` does, since it is the same
 * mistake. With no workspace to measure against, absolute stays
 * refused outright - there is nothing for it to be inside of.
 *
 * Called twice for a path that reads a spec variable, once in each
 * place the path becomes real: the parser applies it to what was
 * written, catching a literal `../`, and `assemble` applies it again
 * to what `${{ spec.path }}` resolved to - the only moment that half
 * of the path exists, and it can land outside the repository when the
 * spec root does. Idempotent, so the second pass over a plain path
 * changes nothing.
 *
 * @param where names the file and stage, so an error says which line.
 *
 * @param key the key that was written, so an error quotes what the
 * author typed rather than a key they did not.
 */
export function workspacePath(value: string, where: string, key: string, workspaceFolder?: string): string {

    const normalized = value.replace(/\\/g, "/");

    if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized))
        return insideWorkspace(normalized, value, where, key, workspaceFolder);

    if (normalized.split("/").includes(".."))
        throw new Error(
            `${where} has a '${key}: ${value}' that climbs out of the repository.`);

    return normalized;
}

/** An absolute path made workspace-relative, or the error saying it is not under the root. */
function insideWorkspace(
    normalized: string,
    value: string,
    where: string,
    key: string,
    workspaceFolder: string | undefined
): string {

    if (!workspaceFolder)
        throw new Error(
            `${where} has an absolute '${key}: ${value}' - it is relative to the repository, `
            + "so that a teammate's checkout resolves the same file.");

    const relative = path.relative(workspaceFolder, normalized).replace(/\\/g, "/");

    if (relative === "" || relative.startsWith("../") || path.isAbsolute(relative))
        throw new Error(
            `${where} has a '${key}: ${value}' that climbs out of the repository. `
            + `It resolves to '${normalized}', which is not under '${workspaceFolder}'.`);

    return relative;
}

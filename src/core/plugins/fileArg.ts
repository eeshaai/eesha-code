import * as fs from "fs";

/**
 * A structured input value that reads a document before the plugin runs:
 *
 * ```yaml
 * args:
 *   requirements:
 *     file: ${{ vars.SPEC }}/requirements.md
 *   principles:
 *     file: ${{ vars.ROOT }}/principles.md
 *     optional: true
 * ```
 *
 * Required by default, so a missing document fails with the path named.
 * `optional: true` resolves to an empty string instead.
 *
 * A value shape, not a `file()` template function, so the `${{ }}`
 * grammar stays closed (see condition.ts).
 */
export interface FileArg {

    /** The path, possibly still holding `${{ }}` templates. */
    file: string;

    /** Whether a missing file is acceptable. Defaults to false. */
    optional: boolean;
}

const FileArgKeys = ["file", "optional"];

/**
 * Whether a declared input value is file-shaped: a plain object with a
 * `file` key. The key claims the shape, so a malformed sibling key is a
 * hard error rather than the object passing through as a plain map.
 */
export function isFileArg(value: unknown): value is Record<string, unknown> {

    return typeof value === "object"
        && value !== null
        && !Array.isArray(value)
        && Object.prototype.hasOwnProperty.call(value, "file");
}

/** Validates a file-shaped input. The caller names the input in whatever it reports. */
export function parseFileArg(value: Record<string, unknown>): FileArg {

    const unknown = Object.keys(value).filter(key => !FileArgKeys.includes(key));

    if (unknown.length)
        throw new Error(`a file input may only declare ${FileArgKeys.join(", ")} - not '${unknown[0]}'.`);

    if (typeof value.file !== "string" || !value.file)
        throw new Error("a file input's 'file:' must be a path.");

    if (value.optional !== undefined && typeof value.optional !== "boolean")
        throw new Error("a file input's 'optional:' must be true or false.");

    return { file: value.file, optional: value.optional === true };
}

/**
 * Reads the file into the value the plugin receives.
 *
 * @param resolvedPath Template-resolved and anchored by the caller -
 * relative paths mean the workspace, the same convention `file@1` uses.
 */
export function readFileArg(input: FileArg, resolvedPath: string): string {

    try {

        return fs.readFileSync(resolvedPath, "utf8");

    } catch (error: any) {

        if (error?.code === "ENOENT" && input.optional)
            return "";

        if (error?.code === "ENOENT")
            throw new Error(`required file does not exist: ${resolvedPath}`);

        throw new Error(`could not read '${resolvedPath}': ${error?.message ?? String(error)}`);
    }
}

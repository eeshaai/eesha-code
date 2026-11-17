import * as path from "path";

/**
 * Planning an eject - copying a built-in style out of the program into
 * a folder the user owns, under a new id of its own (`custom-1`). A
 * style lives in one place only, so the copy is a new style, not an
 * override of the built-in.
 *
 * The plan is computed apart from the copying so the part with rules in
 * it - what gets copied where, and which writes would land on an
 * existing file - is testable without a filesystem. The command layer
 * enumerates the files, asks about the collisions, and performs the
 * copies; nothing here touches disk.
 *
 * Byte-for-byte from the built-in, every file of it, except the
 * `style.yml` `id:` line (see {@link withStyleId}). The copy cannot fall
 * back on the built-in for a file it lacks, so it carries them all.
 */

export interface EjectCopy {

    /** Style-folder-relative, forward-slashed - `instructions/design.md`. */
    relative: string;

    /** Where the built-in file is, absolute. */
    from: string;

    /** Where the copy lands, absolute. */
    to: string;
}

export interface EjectPlan {

    /** Every file the eject writes, collisions included, in stable order. */
    copies: EjectCopy[];

    /**
     * The relative paths already present at the target.
     *
     * Carried rather than filtered out, because an existing file is
     * someone's edits: the caller must get an explicit yes before any
     * of these are written over.
     */
    collisions: string[];
}

export interface EjectInput {

    /** Every file of the built-in style, style-folder-relative and forward-slashed. */
    files: string[];

    /** The built-in style's folder, absolute. */
    sourceRoot: string;

    /** The target style folder - `<scope styles dir>/<style id>`, absolute. */
    targetRoot: string;

    /** Whether the target already has this file. */
    exists(relative: string): boolean;
}

/**
 * The id an ejected copy of `base` gets: `custom-1`, then `custom-2`,
 * the first no scope holds yet. A style id may live in one place only,
 * so a copy under the built-in's own id would be refused on sight.
 */
export function freeStyleId(base: string, taken: ReadonlySet<string>): string {

    for (let n = 1; ; n++)
        if (!taken.has(`${base}-${n}`))
            return `${base}-${n}`;
}

/**
 * A `style.yml` with its `id:` line set to `id`. The id must equal the
 * folder name, so a copy under a new folder needs the line changed too.
 * Only the top-level line - a stage's own `- id:` is indented and left
 * alone.
 */
export function withStyleId(text: string, id: string): string {

    if (!/^id:.*$/m.test(text))
        throw new Error("The built-in style.yml has no top-level 'id:' line to rename.");

    return text.replace(/^id:.*$/m, `id: ${id}`);
}

export function planEject(input: EjectInput): EjectPlan {

    const copies = [...input.files].sort().map(relative => ({
        relative,
        from: path.join(input.sourceRoot, ...relative.split("/")),
        to: path.join(input.targetRoot, ...relative.split("/"))
    }));

    return {
        copies,
        collisions: copies.filter(copy => input.exists(copy.relative)).map(copy => copy.relative)
    };
}

import { useMemo } from "react";
import type { CodeDiffSection, EditorDiffText } from "../ui";
import { diffLines, diffSections, hunkHeader, lineCounts } from "./lineDiff";

/** The two sides of a file diff as the server sends them. */
export interface FileDiffSides {

    /** Not set: the file is new. */
    before?: string;

    after: string;

    binary?: boolean;

    tooLarge?: boolean;
}

/** Kept lines shown around each change. The rest fold away. */
const CONTEXT = 3;

/** The diff of two texts as sections, each shown run with its "@@" line. A missing `before` reads as an empty file. */
export function codeDiffSections(before: string | undefined, after: string, context = CONTEXT): CodeDiffSection[] {

    return diffSections(diffLines(before ?? "", after), context).map(section =>
        section.kind === "lines" ? { ...section, header: hunkHeader(section.lines) } : section);
}

/** How many lines were added and removed between two texts. */
export function diffLineCounts(before: string | undefined, after: string): { added: number; removed: number } {

    return lineCounts(diffLines(before ?? "", after));
}

/** What the editor's diff view draws for a file's two sides. */
export function editorDiffText(diff: FileDiffSides): EditorDiffText {

    if (diff.binary || diff.tooLarge)
        return { sections: [], binary: diff.binary, tooLarge: diff.tooLarge };

    return {
        sections: codeDiffSections(diff.before, diff.after),
        beforeText: diff.before,
        afterText: diff.after,
        isNew: diff.before === undefined
    };
}

/** `editorDiffText`, kept until the diff changes. Nothing in, nothing out. */
export function useEditorDiffText(diff: FileDiffSides | undefined): EditorDiffText | undefined {

    return useMemo(() => diff ? editorDiffText(diff) : undefined, [diff]);
}

/** The +/- counts of a diff, kept until the diff changes. Nothing for a binary or too large file. */
export function useDiffCounts(diff: FileDiffSides | undefined): { added: number; removed: number } | undefined {

    return useMemo(
        () => diff && !diff.binary && !diff.tooLarge ? diffLineCounts(diff.before, diff.after) : undefined,
        [diff]);
}

import type { TextDiffChange } from "../ui";
import { diffBlocks } from "./blockDiff";
import { diffWords } from "./textWords";

/**
 * The finished block changes the text diff draws. Each block that was
 * rewritten carries the words that moved, on both sides.
 *
 * `before` undefined means there is nothing to compare against, and the
 * answer is undefined too.
 */
export function textDiffChanges(before: string | undefined, after: string): TextDiffChange[] | undefined {

    if (before === undefined)
        return undefined;

    return diffBlocks(before, after).map(change => {

        const beforeText = change.before?.text;
        const afterText = change.after?.text;

        if (change.kind !== "changed")
            return { kind: change.kind, beforeText, afterText };

        const words = diffWords(beforeText ?? "", afterText ?? "");

        return { kind: change.kind, beforeText, afterText, beforeWords: words.before, afterWords: words.after };
    });
}

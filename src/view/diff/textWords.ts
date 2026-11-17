/**
 * Words, and which of them moved between two versions of the same
 * paragraph.
 *
 * Shared by two callers with the same problem. The block diff asks
 * "are these two chunks the same chunk rewritten, or two different
 * chunks?" and the word marks ask "which words inside this chunk
 * changed?". Both answers come from comparing word lists, so the
 * splitting and the comparison live here once.
 */

/**
 * A word: any run of non-space characters. Punctuation stays attached,
 * because "Friday." and "Friday" differ by a character a reader is
 * meant to see.
 */
export function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The form two words are compared in.
 *
 * Case is dropped, and so is markdown's own punctuation on either end -
 * `**Friday**` in the source is `Friday` on screen, and a diff that
 * calls those two different words marks every bolded word in the
 * document. What is left inside the word is kept: `Friday.` and
 * `Friday` still differ.
 */
export function normalize(token: string): string {
  return token.toLowerCase().replace(/^[*_`~[\]()#>-]+|[*_`~[\]()]+$/g, '');
}

/** The table a longest-common-subsequence walk reads. Rows are `before`, columns `after`. */
function table(before: readonly string[], after: readonly string[]): number[][] {
  const grid: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0)
  );

  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      grid[i][j] =
        before[i] === after[j] ? grid[i + 1][j + 1] + 1 : Math.max(grid[i + 1][j], grid[i][j + 1]);

  return grid;
}

/**
 * Walks two lists and reports, for each position, whether it is part of
 * the longest run both share.
 *
 * `false` means the item is in both lists in the same order - context.
 * `true` means it is only in this one, so it was added or taken away.
 */
export function changedFlags(
  before: readonly string[],
  after: readonly string[]
): { before: boolean[]; after: boolean[] } {
  const grid = table(before, after);

  const beforeFlags = new Array<boolean>(before.length).fill(true);
  const afterFlags = new Array<boolean>(after.length).fill(true);

  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      beforeFlags[i] = false;
      afterFlags[j] = false;
      i++;
      j++;
    } else if (grid[i + 1][j] >= grid[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return { before: beforeFlags, after: afterFlags };
}

/**
 * For each item of `after`, the item of `before` it was matched with -
 * or undefined where it matched nothing.
 *
 * The same walk as {@link changedFlags}, kept apart because the callers
 * want different answers from it: one asks what moved, the other asks
 * what lines up with what.
 */
export function align(before: readonly string[], after: readonly string[]): (number | undefined)[] {
  const grid = table(before, after);
  const matched = new Array<number | undefined>(after.length).fill(undefined);

  let i = 0;
  let j = 0;

  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      matched[j] = i;
      i++;
      j++;
    } else if (grid[i + 1][j] >= grid[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  return matched;
}

/**
 * Which words moved between two pieces of prose, reported against each
 * side's own word list.
 */
export function diffWords(before: string, after: string): { before: boolean[]; after: boolean[] } {
  return changedFlags(tokenize(before).map(normalize), tokenize(after).map(normalize));
}

/**
 * How alike two pieces of text are, from 0 (nothing in common) to 1
 * (the same words in the same order).
 *
 * Used to decide whether a chunk that went away and a chunk that
 * arrived are one chunk rewritten. Two empty texts count as identical,
 * because a chunk is never empty and the caller would rather not carry
 * the special case.
 */
export function similarity(before: string, after: string): number {
  const a = tokenize(before).map(normalize);
  const b = tokenize(after).map(normalize);

  if (a.length === 0 && b.length === 0) return 1;

  const flags = changedFlags(a, b);
  const shared = flags.after.filter((changed) => !changed).length;

  return (2 * shared) / (a.length + b.length);
}

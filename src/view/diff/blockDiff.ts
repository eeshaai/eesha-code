/**
 * Two versions of a document, merged into the one sequence the diff
 * view draws: what stayed, what went, what arrived, and what is the
 * same chunk rewritten.
 *
 * Chunks rather than lines - see `splitBlocks` in `./textBlocks`. The last of the
 * four kinds is the one that earns the module: a paragraph an agent
 * reworded is one change a reader can read, where a removal followed by
 * an addition is two blocks of prose they have to compare themselves.
 */

import { DocBlock, splitBlocks } from './textBlocks';
import { similarity } from './textWords';

/**
 * How alike a removed chunk and an added chunk must be before they are
 * called one chunk rewritten.
 *
 * Low on purpose. An edit that rewrites half a paragraph still scores
 * around a half, and pairing it is right - the reader wants the two
 * side by side with the words marked. Below this the two are about
 * different things and reading them as a rewrite would invent a
 * relationship that is not there.
 */
const PAIRED = 0.4;

/** What happened to one chunk between the two versions. */
export type BlockChangeKind = 'same' | 'added' | 'removed' | 'changed';

/** One row of the merged document. */
export interface BlockChange {
  kind: BlockChangeKind;

  /** The chunk as it was. Absent on `added`. */
  before?: DocBlock;

  /** The chunk as it is. Absent on `removed`. */
  after?: DocBlock;
}

/** Every entry that carries text the reader can see - all of them, in order. */
export function textOf(change: BlockChange): string {
  return (change.kind === 'removed' ? change.before?.text : change.after?.text) ?? '';
}

/** Whether anything in this merge differs at all. */
export function anyChange(changes: readonly BlockChange[]): boolean {
  return changes.some((change) => change.kind !== 'same');
}

/** How many chunks are not untouched - how many chunks differ. */
export function changedCount(changes: readonly BlockChange[]): number {
  return changes.filter((change) => change.kind !== 'same').length;
}

/**
 * Pairs a run of removed chunks with the run of added chunks that
 * followed it, in order, keeping only pairs alike enough to read as one
 * rewrite. Anything left over stays as its own removal or addition.
 */
function pair(removed: DocBlock[], added: DocBlock[]): BlockChange[] {
  const out: BlockChange[] = [];

  let i = 0;
  let j = 0;

  while (i < removed.length && j < added.length) {
    if (similarity(removed[i].text, added[j].text) < PAIRED) break;

    out.push({ kind: 'changed', before: removed[i], after: added[j] });
    i++;
    j++;
  }

  for (; i < removed.length; i++) out.push({ kind: 'removed', before: removed[i] });

  for (; j < added.length; j++) out.push({ kind: 'added', after: added[j] });

  return out;
}

/**
 * The merged sequence.
 *
 * `before` undefined means there is no earlier version.
 * Every chunk then reads as `same`, because marking a whole document
 * as new says nothing a reader did not already know.
 */
export function diffBlocks(before: string | undefined, after: string): BlockChange[] {
  const now = splitBlocks(after);

  if (before === undefined)
    return now.map((block) => ({ kind: 'same', after: block }) as BlockChange);

  const old = splitBlocks(before);

  const oldText = old.map((block) => block.text);
  const nowText = now.map((block) => block.text);

  // Rows are the old document, columns the new. `grid[i][j]` is how
  // many chunks the two suffixes starting there still share.
  const grid: number[][] = Array.from({ length: old.length + 1 }, () =>
    new Array<number>(now.length + 1).fill(0)
  );

  for (let i = old.length - 1; i >= 0; i--)
    for (let j = now.length - 1; j >= 0; j--)
      grid[i][j] =
        oldText[i] === nowText[j]
          ? grid[i + 1][j + 1] + 1
          : Math.max(grid[i + 1][j], grid[i][j + 1]);

  const out: BlockChange[] = [];

  /** Chunks dropped and chunks arrived since the last shared one, held back so they can be paired. */
  let dropped: DocBlock[] = [];
  let arrived: DocBlock[] = [];

  const settle = () => {
    if (dropped.length > 0 || arrived.length > 0) out.push(...pair(dropped, arrived));

    dropped = [];
    arrived = [];
  };

  let i = 0;
  let j = 0;

  while (i < old.length && j < now.length) {
    if (oldText[i] === nowText[j]) {
      settle();
      out.push({ kind: 'same', before: old[i], after: now[j] });
      i++;
      j++;
    } else if (grid[i + 1][j] >= grid[i][j + 1]) {
      dropped.push(old[i]);
      i++;
    } else {
      arrived.push(now[j]);
      j++;
    }
  }

  for (; i < old.length; i++) dropped.push(old[i]);

  for (; j < now.length; j++) arrived.push(now[j]);

  settle();

  return out;
}

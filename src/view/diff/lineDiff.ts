/*
 * Two versions of a file compared line by line, for CodeDiff and for the
 * change marks FileViewer draws beside its lines. Myers' diff on the
 * lines between the common start and end, so a small edit in a big file
 * stays fast. A file rewritten past `MAX_EDITS` changes shows as every
 * old line removed and every new line added.
 */

export type DiffLineKind = 'same' | 'added' | 'removed';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  /** 1-based line number in the old text. Absent on `added`. */
  before?: number;
  /** 1-based line number in the new text. Absent on `removed`. */
  after?: number;
}

/** A text's lines: "\r\n" read as "\n", and a last line break not counted as one more empty line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Past this many lines changed, the diff stops looking for a short one. */
const MAX_EDITS = 4000;

/**
 * The two texts as one list of lines: kept, removed and added, in order.
 * Inside each changed run the removed lines come first, then the added.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middle = myers(a.slice(start, endA), b.slice(start, endB));
  const out: DiffLine[] = [];

  for (let i = 0; i < start; i++) out.push({ kind: 'same', text: a[i], before: i + 1, after: i + 1 });

  // Removed before added inside each changed run.
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    out.push(...removed, ...added);
    removed = [];
    added = [];
  };

  for (const [op, i, j] of middle) {
    if (op === 0) {
      flush();
      out.push({ kind: 'same', text: a[start + i], before: start + i + 1, after: start + j + 1 });
    } else if (op === -1) {
      removed.push({ kind: 'removed', text: a[start + i], before: start + i + 1 });
    } else {
      added.push({ kind: 'added', text: b[start + j], after: start + j + 1 });
    }
  }
  flush();

  for (let i = endA, j = endB; i < a.length; i++, j++)
    out.push({ kind: 'same', text: a[i], before: i + 1, after: j + 1 });

  return out;
}

/** [0 kept | -1 removed | 1 added, index in a, index in b] - in order. */
type Edit = [0 | -1 | 1, number, number];

function myers(a: readonly string[], b: readonly string[]): Edit[] {
  const n = a.length;
  const m = b.length;

  if (!n) return b.map((_, j): Edit => [1, 0, j]);
  if (!m) return a.map((_, i): Edit => [-1, i, 0]);

  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d++) {
    // The state before step d, only the part step d reads: k from -d-1 to d+1.
    trace.push(v.slice(offset - d - 1, offset + d + 2));

    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }

  // Too many changes: all of the old out, all of the new in.
  return [...a.map((_, i): Edit => [-1, i, 0]), ...b.map((_, j): Edit => [1, 0, j])];
}

function backtrack(trace: readonly Int32Array[], n: number, m: number): Edit[] {
  const edits: Edit[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d >= 0; d--) {
    const state = trace[d];
    const at = (k: number) => state[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      edits.push([0, x, y]);
    }

    if (d > 0) {
      if (x === prevX) edits.push([1, x, y - 1]);
      else edits.push([-1, x - 1, y]);
    }

    x = prevX;
    y = prevY;
  }

  return edits.reverse();
}

/** How many lines arrived and went. */
export function lineCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === 'added') added++;
    else if (line.kind === 'removed') removed++;
  }
  return { added, removed };
}

/** A run of lines shown, or a run of kept lines folded away. */
export type DiffSection = { kind: 'lines'; lines: DiffLine[] } | { kind: 'gap'; lines: DiffLine[] };

/**
 * The lines cut into what shows - each change with `context` kept lines
 * around it - and the kept runs between, folded. A run shorter than a
 * fold is worth is shown as it is.
 */
export function diffSections(lines: readonly DiffLine[], context = 3): DiffSection[] {
  const show = new Array<boolean>(lines.length).fill(false);

  lines.forEach((line, index) => {
    if (line.kind === 'same') return;
    for (let i = Math.max(0, index - context); i <= Math.min(lines.length - 1, index + context); i++) show[i] = true;
  });

  const sections: DiffSection[] = [];
  let index = 0;

  while (index < lines.length) {
    const shown = show[index];
    let end = index;
    while (end < lines.length && show[end] === shown) end++;
    const run = lines.slice(index, end);

    // A fold of one or two lines takes the room of the lines.
    const kind = shown || run.length <= 2 ? 'lines' : 'gap';
    const last = sections[sections.length - 1];
    if (kind === 'lines' && last?.kind === 'lines') last.lines.push(...run);
    else sections.push({ kind, lines: run });

    index = end;
  }

  return sections;
}

/** "@@ -368,6 +370,11 @@" for a run of shown lines, as git writes it. */
export function hunkHeader(lines: readonly DiffLine[]): string {
  const before = lines.filter((line) => line.before !== undefined);
  const after = lines.filter((line) => line.after !== undefined);
  const start = (list: readonly DiffLine[], key: 'before' | 'after') =>
    list.length ? (list[0][key] as number) : Math.max(0, (lines.find((line) => line[key] !== undefined)?.[key] ?? 1) - 1);
  return `@@ -${start(before, 'before')},${before.length} +${start(after, 'after')},${after.length} @@`;
}

/**
 * What changed, by line of the new text: `added` for a line that is new,
 * `changed` for one that replaced old lines. For the marks beside a file.
 */
export function changedLineMarks(before: string, after: string): Map<number, 'added' | 'changed'> {
  const marks = new Map<number, 'added' | 'changed'>();
  const lines = diffLines(before, after);
  let index = 0;

  while (index < lines.length) {
    if (lines[index].kind === 'same') {
      index++;
      continue;
    }
    let end = index;
    while (end < lines.length && lines[end].kind !== 'same') end++;
    const run = lines.slice(index, end);
    const replaced = run.some((line) => line.kind === 'removed');
    for (const line of run) if (line.kind === 'added') marks.set(line.after as number, replaced ? 'changed' : 'added');
    index = end;
  }

  return marks;
}

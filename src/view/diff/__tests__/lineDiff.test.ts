import { describe, expect, it } from 'vitest';
import { changedLineMarks, diffLines, diffSections, hunkHeader, lineCounts, splitLines } from '../lineDiff';

const kinds = (before: string, after: string) => diffLines(before, after).map((line) => `${line.kind[0]}:${line.text}`);

describe('splitLines', () => {
  it('reads CRLF as LF and does not count the last line break as a line', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
  });
});

describe('diffLines', () => {
  it('keeps what stayed and lists removed lines before added ones in a changed run', () => {
    expect(kinds('a\nb\nc\nd', 'a\nB\nc\nd\ne')).toEqual(['s:a', 'r:b', 'a:B', 's:c', 's:d', 'a:e']);
  });

  it('numbers each side', () => {
    expect(diffLines('a\nb\nc', 'a\nc')).toEqual([
      { kind: 'same', text: 'a', before: 1, after: 1 },
      { kind: 'removed', text: 'b', before: 2 },
      { kind: 'same', text: 'c', before: 3, after: 2 },
    ]);
  });

  it('finds a short diff in the middle of a file', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 100', 'line 100 changed').replace('line 150\n', '');
    expect(lineCounts(diffLines(before, after))).toEqual({ added: 1, removed: 2 });
  });

  it('finds the changes between edits spread through a file', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng';
    const after = 'a\nx\nc\nd\ny\nf\ng\nz';
    expect(kinds(before, after)).toEqual(['s:a', 'r:b', 'a:x', 's:c', 's:d', 'r:e', 'a:y', 's:f', 's:g', 'a:z']);
  });

  it('handles a new file and an emptied one', () => {
    expect(kinds('', 'x\ny')).toEqual(['a:x', 'a:y']);
    expect(kinds('x\ny', '')).toEqual(['r:x', 'r:y']);
  });
});

describe('diffSections and hunkHeader', () => {
  it('folds kept runs away from the changes and keeps 3 lines around each', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i + 1}`).join('\n');
    const after = before.replace('l15', 'L15');
    const sections = diffSections(diffLines(before, after));

    expect(sections.map((one) => `${one.kind}:${one.lines.length}`)).toEqual(['gap:11', 'lines:8', 'gap:12']);
    expect(hunkHeader(sections[1].lines)).toBe('@@ -12,7 +12,7 @@');
  });

  it('shows a short kept run instead of folding it', () => {
    const sections = diffSections(diffLines('a\nb\nc\nd\ne', 'A\nb\nc\nd\nE'), 1);
    expect(sections.map((one) => one.kind)).toEqual(['lines']);
  });
});

describe('changedLineMarks', () => {
  it('marks new lines as added and replacing lines as changed, by new line number', () => {
    expect([...changedLineMarks('a\nb\nc', 'a\nB\nc\nd')]).toEqual([
      [2, 'changed'],
      [4, 'added'],
    ]);
  });
});

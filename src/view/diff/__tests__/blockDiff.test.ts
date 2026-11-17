import { describe, expect, it } from 'vitest';

import { anyChange, changedCount, diffBlocks } from '../blockDiff';
import { splitBlocks } from '../textBlocks';
import { align, diffWords, similarity, tokenize } from '../textWords';

describe('splitBlocks', () => {
  it('splits on blank lines and drops them', () => {
    const blocks = splitBlocks('one\n\ntwo\n\n\nthree');

    expect(blocks.map((block) => block.text)).toEqual(['one', 'two', 'three']);
  });

  it('numbers each block against the document it came from', () => {
    const blocks = splitBlocks('one\n\ntwo\nstill two\n\nthree');

    expect(blocks.map((block) => [block.start, block.end])).toEqual([
      [1, 1],
      [3, 4],
      [6, 6],
    ]);
  });

  it('keeps a fenced block whole across its blank lines', () => {
    const blocks = splitBlocks('intro\n\n```ts\na\n\nb\n```\n\nafter');

    expect(blocks.map((block) => block.text)).toEqual(['intro', '```ts\na\n\nb\n```', 'after']);
  });

  it('keeps a table whole', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';

    expect(splitBlocks(`before\n\n${table}\n\nafter`)[1].text).toBe(table);
  });

  it('closes an unterminated fence at the end of the document', () => {
    const blocks = splitBlocks('text\n\n```\nnever closed');

    expect(blocks.map((block) => block.text)).toEqual(['text', '```\nnever closed']);
  });

  it('has no blocks in an empty document', () => {
    expect(splitBlocks('')).toEqual([]);
    expect(splitBlocks('\n\n  \n')).toEqual([]);
  });
});

describe('textWords', () => {
  it('compares a bolded word with its plain form', () => {
    expect(diffWords('ships on **Friday**', 'ships on **Friday**').after).toEqual([
      false,
      false,
      false,
    ]);
    expect(diffWords('ships on Friday', 'ships on **Monday**').after).toEqual([false, false, true]);
  });

  it('keeps punctuation as part of the word', () => {
    expect(diffWords('done', 'done.').after).toEqual([true]);
  });

  it('scores two rewrites of one sentence as alike', () => {
    expect(similarity('the plan ships on Friday', 'the plan ships on Monday')).toBeGreaterThan(0.4);
  });

  it('scores two unrelated paragraphs as not alike', () => {
    expect(similarity('the plan ships on Friday', 'cache keys are hashed twice')).toBeLessThan(0.4);
  });

  it('lines a rendered word up with the source word it came from', () => {
    const source = tokenize('ships on **Friday**').map((word) =>
      word.toLowerCase().replace(/\*/g, '')
    );
    const rendered = ['ships', 'on', 'friday'];

    expect(align(source, rendered)).toEqual([0, 1, 2]);
  });
});

describe('diffBlocks', () => {
  it('calls every block the same when there is no earlier version', () => {
    const changes = diffBlocks(undefined, 'one\n\ntwo');

    expect(changes.map((change) => change.kind)).toEqual(['same', 'same']);
    expect(anyChange(changes)).toBe(false);
  });

  it('calls every block the same when nothing moved', () => {
    expect(anyChange(diffBlocks('one\n\ntwo', 'one\n\ntwo'))).toBe(false);
  });

  it('marks an added block', () => {
    const changes = diffBlocks('one\n\nthree', 'one\n\ntwo\n\nthree');

    expect(changes.map((change) => change.kind)).toEqual(['same', 'added', 'same']);
    expect(changes[1].after?.text).toBe('two');
    expect(changes[1].before).toBeUndefined();
  });

  it('marks a removed block', () => {
    const changes = diffBlocks('one\n\ntwo\n\nthree', 'one\n\nthree');

    expect(changes.map((change) => change.kind)).toEqual(['same', 'removed', 'same']);
    expect(changes[1].before?.text).toBe('two');
    expect(changes[1].after).toBeUndefined();
  });

  it('reads a reworded paragraph as one change, not a removal and an addition', () => {
    const changes = diffBlocks(
      'intro\n\nthe plan ships on Friday\n\nend',
      'intro\n\nthe plan ships on Monday\n\nend'
    );

    expect(changes.map((change) => change.kind)).toEqual(['same', 'changed', 'same']);
    expect(changes[1].before?.text).toBe('the plan ships on Friday');
    expect(changes[1].after?.text).toBe('the plan ships on Monday');
  });

  it('keeps a replaced paragraph as two separate changes when it is a different subject', () => {
    const changes = diffBlocks(
      'intro\n\nthe plan ships on Friday\n\nend',
      'intro\n\ncache keys are hashed twice\n\nend'
    );

    expect(changes.map((change) => change.kind)).toEqual(['same', 'removed', 'added', 'same']);
  });

  it('counts only what moved', () => {
    expect(changedCount(diffBlocks('a\n\nb\n\nc', 'a\n\nB two\n\nc\n\nd'))).toBe(2);
  });
});

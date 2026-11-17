/**
 * A document split into the chunks a reader sees as one thing: a
 * paragraph, a heading, a list, a table, a fenced code block.
 *
 * The diff view compares these rather than lines. A table is eleven
 * lines and one thing; marking line seven of it red leaves the reader
 * holding half a table. A chunk is the unit that still renders on its
 * own, which is what lets the view draw a removed one at all.
 *
 * The rule is the one markdown itself uses: a blank line ends a chunk.
 * A fence is the exception - blank lines inside ``` belong to the code,
 * not to the document.
 */

/** One chunk of a document, and where it came from. */
export interface DocBlock {
  /** The chunk's own text, with no blank line on either end. */
  text: string;

  /** 1-based first line of the chunk in the text it was split from. */
  start: number;

  /** 1-based last line. Equal to `start` for a one-line chunk. */
  end: number;
}

/** Whether this line opens or closes a fenced block, and with which fence. */
function fenceOf(line: string): string | undefined {
  const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);

  return match ? match[1][0] : undefined;
}

/**
 * Splits a document into {@link DocBlock}s.
 *
 * Blank lines separate and are dropped: they are spacing, and a diff
 * that reports a blank line as changed tells the reader nothing.
 */
export function splitBlocks(text: string): DocBlock[] {
  const lines = text.split('\n');
  const blocks: DocBlock[] = [];

  /** The lines of the chunk being gathered, and the line the first one sat on. */
  let held: string[] = [];
  let from = 0;

  /** The fence character we are inside, if any - ` or ~. */
  let fence: string | undefined;

  const close = (last: number) => {
    if (held.length > 0) blocks.push({ text: held.join('\n'), start: from, end: last });

    held = [];
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const number = index + 1;

    if (fence === undefined) {
      // A blank line outside a fence ends whatever was open.
      if (line.trim() === '') {
        close(number - 1);
        continue;
      }

      if (held.length === 0) from = number;

      held.push(line);

      const opened = fenceOf(line);

      if (opened) fence = opened;

      continue;
    }

    // Inside a fence: everything is code, including blank lines,
    // until a fence of the same character closes it.
    held.push(line);

    if (fenceOf(line) === fence) {
      fence = undefined;
      close(number);
    }
  }

  close(lines.length);

  return blocks;
}

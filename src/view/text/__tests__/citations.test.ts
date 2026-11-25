import { describe, it, expect } from 'vitest';
import { splitCitations } from '../citations';

describe('splitCitations', () => {
    it('returns a single text segment when there are no citations', () => {
        expect(splitCitations('just plain text')).toEqual([{ kind: 'text', value: 'just plain text' }]);
    });

    it('extracts a `path:line` citation between text segments', () => {
        const result = splitCitations('see `main.ts:42` for details');
        expect(result).toEqual([
            { kind: 'text', value: 'see ' },
            { kind: 'citation', path: 'main.ts', line: 42 },
            { kind: 'text', value: ' for details' },
        ]);
    });

    it('extracts multiple citations', () => {
        const result = splitCitations('`a.ts:1` and `src/b.ts:2`');
        expect(result).toEqual([
            { kind: 'citation', path: 'a.ts', line: 1 },
            { kind: 'text', value: ' and ' },
            { kind: 'citation', path: 'src/b.ts', line: 2 },
        ]);
    });

    it('does not treat plain inline code without a line number as a citation', () => {
        const result = splitCitations('call `useState` here');
        expect(result).toEqual([{ kind: 'text', value: 'call `useState` here' }]);
    });

    it('handles backslash path separators', () => {
        const result = splitCitations('`src\\steps\\build.ts:79`');
        expect(result).toEqual([
            { kind: 'citation', path: 'src\\steps\\build.ts', line: 79 },
        ]);
    });

    it('extracts a bare url between text segments', () => {
        const result = splitCitations('see https://example.com for details');
        expect(result).toEqual([
            { kind: 'text', value: 'see ' },
            { kind: 'link', url: 'https://example.com' },
            { kind: 'text', value: ' for details' },
        ]);
    });

    it('strips trailing sentence punctuation off a url, leaving it as trailing text', () => {
        expect(splitCitations('Check https://example.com/path.')).toEqual([
            { kind: 'text', value: 'Check ' },
            { kind: 'link', url: 'https://example.com/path' },
            { kind: 'text', value: '.' },
        ]);
    });

    it('extracts both citations and links, in order', () => {
        const result = splitCitations('see `main.ts:42` and https://example.com');
        expect(result).toEqual([
            { kind: 'text', value: 'see ' },
            { kind: 'citation', path: 'main.ts', line: 42 },
            { kind: 'text', value: ' and ' },
            { kind: 'link', url: 'https://example.com' },
        ]);
    });
});

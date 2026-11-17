import { describe, it, expect } from 'vitest';
import { plainLine, thinkingSummary } from '../plainLine';

describe('plainLine', () => {
    it('takes Markdown marks off one line', () => {
        expect(plainLine('**Considering PowerShell command**')).toBe('Considering PowerShell command');
        expect(plainLine('## Plan')).toBe('Plan');
        expect(plainLine('- check `a.ts` and _b_')).toBe('check a.ts and b');
        expect(plainLine('2 * 3 = 6')).toBe('2 * 3 = 6');
    });
});

describe('thinkingSummary', () => {
    const text = 'First I read the file.\n\nThen I check the tests.\n**Last** I write the answer.';

    it('is the first line once finished', () => {
        expect(thinkingSummary(text, false)).toBe('First I read the file.');
    });

    it('is the newest line while live, as plain text', () => {
        expect(thinkingSummary(text, true)).toBe('Last I write the answer.');
    });

    it('is empty for empty text', () => {
        expect(thinkingSummary('', false)).toBe('');
    });
});

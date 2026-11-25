import { describe, it, expect } from 'vitest';
import { fileToBase64 } from './attachments';

describe('fileToBase64', () => {
    it('round-trips a small text file', async () => {
        const file = new File(['hello world'], 'notes.txt', { type: 'text/plain' });
        const b64 = await fileToBase64(file);
        expect(atob(b64)).toBe('hello world');
    });

    it('round-trips content larger than the internal chunk size', async () => {
        const content = 'x'.repeat(0x8000 + 100);
        const file = new File([content], 'big.txt');
        const b64 = await fileToBase64(file);
        expect(atob(b64)).toBe(content);
    });
});

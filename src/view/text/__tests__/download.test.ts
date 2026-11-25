import { afterEach, describe, it, expect, vi } from 'vitest';
import { downloadResponse, downloadTextFile } from '../download';

/** A stand-in page whose anchors record what was downloaded. */
function fakePage() {
    const clicks: { href: string; download: string }[] = [];
    vi.stubGlobal('document', {
        createElement: () => {
            const anchor = { href: '', download: '', click: () => clicks.push({ href: anchor.href, download: anchor.download }) };
            return anchor;
        },
    });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    return { clicks, revoke };
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('downloadTextFile', () => {
    it('clicks an anchor with the file name and a blob URL, then revokes the URL', () => {
        const { clicks, revoke } = fakePage();

        downloadTextFile('response.md', 'hello world');

        expect(clicks).toHaveLength(1);
        expect(clicks[0].download).toBe('response.md');
        expect(clicks[0].href).toMatch(/^blob:/);
        expect(revoke).toHaveBeenCalledTimes(1);
    });
});

describe('downloadResponse', () => {
    it('names the file response-<time>.md', () => {
        const { clicks } = fakePage();

        downloadResponse('hello');

        expect(clicks).toHaveLength(1);
        expect(clicks[0].download).toMatch(/^response-.+\.md$/);
        expect(clicks[0].download).not.toContain(':');
    });
});

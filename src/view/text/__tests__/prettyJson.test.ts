import { describe, it, expect } from 'vitest';
import { prettyJson } from '../prettyJson';

describe('prettyJson', () => {
    it('indents JSON by two spaces', () => {
        expect(prettyJson('{"cmd":"ls"}')).toBe('{\n  "cmd": "ls"\n}');
    });

    it('returns text that is not JSON as it is', () => {
        expect(prettyJson('rm -rf ./build')).toBe('rm -rf ./build');
        expect(prettyJson('')).toBe('');
    });
});

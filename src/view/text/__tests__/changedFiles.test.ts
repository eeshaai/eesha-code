import { describe, it, expect } from 'vitest';
import { fileDir, fileName, pathLabel, repoFolderName, turnHover, turnTitle, withNames } from '../changedFiles';

describe('changed file names', () => {
    it('splits a path into name and folder', () => {
        expect(fileName('src/a/b.ts')).toBe('b.ts');
        expect(fileDir('src/a/b.ts')).toBe('src/a');
        expect(fileName('b.ts')).toBe('b.ts');
        expect(fileDir('b.ts')).toBe('');
    });

    it('adds name and folder to a file and keeps its other fields', () => {
        expect(withNames({ path: 'x/y.md', status: 'added' })).toEqual({ path: 'x/y.md', status: 'added', name: 'y.md', dir: 'x' });
    });

    it('names a repository by its last folder', () => {
        expect(repoFolderName('C:/code/api/')).toBe('api');
        expect(repoFolderName('C:\\x\\y')).toBe('y');
    });

    it('takes the last part of a path with either kind of slash', () => {
        expect(pathLabel('C:\\code\\a.ts')).toBe('a.ts');
        expect(pathLabel('src/b.ts')).toBe('b.ts');
    });
});

describe('turn heading', () => {
    it('is the first line of the message', () => {
        expect(turnTitle('Fix it\nand then more')).toBe('Fix it');
    });

    it('says "No message" for an empty message', () => {
        expect(turnTitle('')).toBe('No message');
    });

    it('cuts the hover text at 500 characters', () => {
        expect(turnHover('x'.repeat(600))).toHaveLength(500);
    });
});

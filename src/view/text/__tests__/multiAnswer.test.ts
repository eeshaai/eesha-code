import { describe, it, expect } from 'vitest';
import { joinMultiAnswer } from '../multiAnswer';

const options = ['Postgres', 'Redis', 'SQLite'];

describe('joinMultiAnswer', () => {
    it('lists the ticked options in the order the question lists them', () => {
        expect(joinMultiAnswer(options, ['SQLite', 'Postgres'], '')).toBe('Postgres, SQLite');
    });

    it('adds the typed text last, as typed', () => {
        expect(joinMultiAnswer(options, ['SQLite'], 'a file cache ')).toBe('SQLite, a file cache ');
    });

    it('leaves out blank typed text', () => {
        expect(joinMultiAnswer(options, [], '   ')).toBe('');
    });

    it('keeps an option that contains a comma in one piece', () => {
        expect(joinMultiAnswer(['a, b', 'c'], ['c', 'a, b'], '')).toBe('a, b, c');
    });
});

import { describe, expect, test } from 'bun:test';
import { normalizePairCode, PAIR_CODE_ALPHABET, parseDaemonMessage } from '../src';

describe('pairing codes', () => {
    test('the alphabet is Crockford base32: 32 characters, no I, L, O, U', () => {
        expect(PAIR_CODE_ALPHABET).toHaveLength(32);
        expect(new Set(PAIR_CODE_ALPHABET).size).toBe(32);
        expect(PAIR_CODE_ALPHABET).not.toMatch(/[ILOU]/);
    });

    test('what the user types is normalized: case, spaces, dashes, look-alike letters', () => {
        expect(normalizePairCode('ABC123')).toBe('ABC123');
        expect(normalizePairCode(' abc-123 ')).toBe('ABC123');
        expect(normalizePairCode('abc 123')).toBe('ABC123');
        expect(normalizePairCode('0Oo1Il')).toBe('000111');
    });

    test('anything else is refused', () => {
        for (const input of ['', 'ABC12', 'ABC1234', 'ABCU23', 'ABC!23', 'ABC_23']) {
            expect(normalizePairCode(input)).toBeNull();
        }
    });

    test('a pair.offer from a daemon needs a normalized code', () => {
        const offer = {
            type: 'pair.offer',
            id: '1',
            room: 'r'.repeat(43),
            key: 'k'.repeat(22),
            computer: 'MAC',
        };
        expect(parseDaemonMessage(JSON.stringify({ ...offer, code: 'ABC123' }))).not.toBeNull();
        expect(parseDaemonMessage(JSON.stringify({ ...offer, code: 'abc123' }))).toBeNull();
    });
});

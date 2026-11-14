import { describe, expect, test } from 'bun:test';
import {
    joinNote,
    newEntryId,
    parseNoteList,
    renderNote,
    replaceScreenshots,
    screenshotIds,
    screenshotToken,
    splitNote,
} from '../src';

describe('the note as a list', () => {
    test('a note written as a list is split into its elements, with their names', () => {
        const note = '- Header is wrong [#k3f9]\n  on mobile\n- Second [#a81x]';
        expect(splitNote(note)).toEqual([
            { id: 'k3f9', text: 'Header is wrong\non mobile' },
            { id: 'a81x', text: 'Second' },
        ]);
    });

    test('joining and splitting give the same elements back', () => {
        const entries = [
            { id: 'k3f9', text: 'one line' },
            { id: 'a81x', text: 'two\nlines\n\nand a blank one' },
            { id: 'zz00', text: '- starts like an element' },
        ];
        expect(splitNote(joinNote(entries))).toEqual(entries);
        expect(joinNote(splitNote(joinNote(entries)))).toBe(joinNote(entries));
    });

    test('elements without text are left out, in both directions', () => {
        expect(
            joinNote([
                { id: 'k3f9', text: '  ' },
                { id: 'a81x', text: 'x' },
            ]),
        ).toBe('- x [#a81x]');
        expect(splitNote('- [#k3f9]\n- real [#a81x]')).toEqual([{ id: 'a81x', text: 'real' }]);
        expect(joinNote([])).toBe('');
        expect(splitNote('')).toEqual([]);
        expect(splitNote('  \n ')).toEqual([]);
    });

    test('a note that is not a list is one element without a name', () => {
        expect(splitNote('Use staging')).toEqual([{ id: null, text: 'Use staging' }]);
        expect(splitNote('first\nsecond')).toEqual([{ id: null, text: 'first\nsecond' }]);
        expect(splitNote('text\n- then a list')).toEqual([
            { id: null, text: 'text\n- then a list' },
        ]);
        expect(parseNoteList('Use staging')).toBeNull();
    });

    test('a list without names keeps its elements, nameless', () => {
        expect(splitNote('- buy milk\n- check mail')).toEqual([
            { id: null, text: 'buy milk' },
            { id: null, text: 'check mail' },
        ]);
    });

    test('a name written twice belongs to the first element only', () => {
        expect(splitNote('- a [#k3f9]\n- b [#k3f9]')).toEqual([
            { id: 'k3f9', text: 'a' },
            { id: null, text: 'b' },
        ]);
    });

    test('the joined note is what the limit of the note applies to', () => {
        const long = 'x'.repeat(100);
        expect(joinNote([{ id: 'k3f9', text: long }]).length).toBe(2 + 100 + ' [#k3f9]'.length);
    });

    test('new names are four characters and different from the ones in use', () => {
        const taken = new Set<string | null>();
        for (let count = 0; count < 200; count++) {
            const id = newEntryId(taken);
            expect(id).toMatch(/^[a-z0-9]{4}$/);
            expect(taken.has(id)).toBe(false);
            taken.add(id);
        }
    });
});

describe('the note as the agent reads it', () => {
    const note = joinNote([
        { id: 'k3f9', text: 'Header is wrong\non mobile' },
        { id: 'a81x', text: 'Second' },
        { id: null, text: 'Third' },
    ]);

    test('names are left out and the elements keep their lines', () => {
        expect(renderNote(note)).toBe('- Header is wrong\n  on mobile\n- Second\n- Third');
    });

    test('new and edited elements are marked', () => {
        const mark = (entry: { id: string | null }) =>
            entry.id === 'k3f9' ? 'edit' : entry.id === 'a81x' ? null : 'new';
        expect(renderNote(note, mark)).toBe(
            '- [edit] Header is wrong\n  on mobile\n- Second\n- [new] Third',
        );
    });

    test('a note that is not a list is given as it is', () => {
        expect(renderNote('Use staging', () => 'new')).toBe('Use staging');
        expect(renderNote('')).toBe('');
    });
});

describe('screenshots named in a note', () => {
    const [one, two] = ['01J9X0000000000000000000AB', '01J9X0000000000000000000CD'];

    test('a token names an image and the ids are read back in order, each once', () => {
        expect(screenshotToken(one)).toBe(`[screenshot:${one}]`);
        const note = joinNote([
            { id: 'aaaa', text: `Header\n${screenshotToken(one)}` },
            { id: 'bbbb', text: `${screenshotToken(two)} and again ${screenshotToken(one)}` },
        ]);
        expect(screenshotIds(note)).toEqual([one, two]);
        expect(screenshotIds('nothing here')).toEqual([]);
    });

    test('things that look like a token but are not one name nothing', () => {
        expect(screenshotIds('[screenshot:short]')).toEqual([]);
        expect(screenshotIds(`[screenshot: ${one}]`)).toEqual([]);
        expect(screenshotIds(`[Screenshot:${one}]`)).toEqual([]);
        expect(screenshotIds(`[screenshot:${one.toLowerCase()}]`)).toEqual([]);
    });

    test('a token is replaced wherever it stands, and an element keeps its other lines', () => {
        const note = joinNote([{ id: 'aaaa', text: `Header\n${screenshotToken(one)}` }]);
        expect(replaceScreenshots(renderNote(note), (id) => `screenshot: /x/${id}.jpg`)).toBe(
            `- Header\n  screenshot: /x/${one}.jpg`,
        );
        // The token survives joining and splitting.
        expect(splitNote(note)[0]?.text).toBe(`Header\n${screenshotToken(one)}`);
    });
});

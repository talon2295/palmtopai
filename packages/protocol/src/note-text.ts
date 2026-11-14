/**
 * The note the user keeps for the agent on a session is one string (`session.note`), written as a
 * list the app edits one element at a time:
 *
 *     - Header is wrong on mobile [#k3f9]
 *       second line of the same element
 *     - Another thing [#a81x]
 *
 * `- ` opens an element, lines indented by two spaces continue it, and `[#id]` at the end of the
 * first line is the name of the element, which lets the computer tell an element that was edited
 * from one that is new. A note that has no such shape (written before the list, or by an older app)
 * is one element without a name. Nothing here is a field of the protocol: the string is what is
 * replicated and what the agent receives.
 */

export interface NoteEntry {
    /** Four characters of `[a-z0-9]`; `null` in a note that is not written as a list. */
    id: string | null;
    text: string;
}

/** What the agent is told about an element it was already given a note with. */
export type NoteMark = 'new' | 'edit';

const BULLET = '- ';
const CONTINUATION = '  ';
const ID_SUFFIX = /(?:^| )\[#([a-z0-9]{4})\]$/;
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The elements of a note written as a list, or `null` for any other text. */
export function parseNoteList(note: string): NoteEntry[] | null {
    const raw: string[][] = [];
    for (const line of note.split('\n')) {
        if (line.startsWith(BULLET)) {
            raw.push([line.slice(BULLET.length)]);
        } else if (raw.length > 0 && (line === '' || line.startsWith(CONTINUATION))) {
            raw[raw.length - 1]?.push(line.slice(CONTINUATION.length));
        } else {
            return null;
        }
    }
    const seen = new Set<string>();
    const entries: NoteEntry[] = [];
    for (const lines of raw) {
        const named = ID_SUFFIX.exec(lines[0] ?? '');
        if (named) lines[0] = (lines[0] ?? '').slice(0, named.index);
        const text = lines.join('\n').trim();
        if (text === '') continue;
        // A name written twice belongs to the first element only.
        const id = named?.[1] && !seen.has(named[1]) ? named[1] : null;
        if (id) seen.add(id);
        entries.push({ id, text });
    }
    return entries;
}

/** The elements of a note: its list, or the whole text as a single element without a name. */
export function splitNote(note: string): NoteEntry[] {
    if (note.trim() === '') return [];
    return parseNoteList(note) ?? [{ id: null, text: note.trim() }];
}

/** The note for a list of elements; elements without text are left out. */
export function joinNote(entries: readonly NoteEntry[]): string {
    return entries
        .filter((entry) => entry.text.trim() !== '')
        .map((entry) => {
            const [first = '', ...rest] = entry.text.trim().split('\n');
            const head = `${BULLET}${first}${entry.id ? ` [#${entry.id}]` : ''}`;
            return [head, ...rest.map((line) => `${CONTINUATION}${line}`)].join('\n');
        })
        .join('\n');
}

/** A name for a new element, different from the ones in use. */
export function newEntryId(taken: Iterable<string | null> = []): string {
    const used = new Set(taken);
    for (;;) {
        const bytes = crypto.getRandomValues(new Uint8Array(4));
        const id = Array.from(bytes, (byte) => ID_ALPHABET[byte % ID_ALPHABET.length]).join('');
        if (!used.has(id)) return id;
    }
}

/**
 * The note as the agent reads it: names are left out and `mark` says which elements are new or
 * were edited since the agent last read the note. A note that is not a list is returned as it is.
 */
export function renderNote(
    note: string,
    mark?: (entry: NoteEntry) => NoteMark | null | undefined,
): string {
    const entries = parseNoteList(note);
    if (!entries) return note;
    return entries
        .map((entry) => {
            const tag = mark?.(entry);
            const [first = '', ...rest] = entry.text.split('\n');
            const head = `${BULLET}${tag ? `[${tag}] ` : ''}${first}`;
            return [head, ...rest.map((line) => `${CONTINUATION}${line}`)].join('\n');
        })
        .join('\n');
}

/**
 * A screenshot is named in the text of a note by a token on a line of its own: `[screenshot:ID]`,
 * the id being the one the image was stored under (`image.put`). The image is not part of the
 * note: the app shows the token as a picture, and the computer turns it into a file for the agent.
 */
const SCREENSHOT_TOKEN = /\[screenshot:([0-9A-HJKMNP-TV-Z]{26})\]/g;

export function screenshotToken(imageId: string): string {
    return `[screenshot:${imageId}]`;
}

/** The ids of the screenshots a text names, in order, each once. */
export function screenshotIds(text: string): string[] {
    const ids = new Set<string>();
    for (const match of text.matchAll(SCREENSHOT_TOKEN)) ids.add(match[1] as string);
    return [...ids];
}

/** The text with each screenshot token replaced by what `replace` makes of its id. */
export function replaceScreenshots(text: string, replace: (imageId: string) => string): string {
    return text.replace(SCREENSHOT_TOKEN, (_token, id: string) => replace(id));
}

/** The text of a note without its screenshot tokens, and without the line break before each. */
export function stripScreenshots(text: string): string {
    return text.replace(new RegExp(`\\n?${SCREENSHOT_TOKEN.source}`, 'g'), '').trim();
}

/** The first screenshot a text names, for a note that holds one (the note of an item). */
export function noteScreenshot(text: string): string | null {
    return screenshotIds(text)[0] ?? null;
}

/** The text with its screenshot replaced by `imageId` (on a line of its own at the end), or taken off. */
export function withScreenshot(text: string, imageId: string | null): string {
    const base = stripScreenshots(text);
    if (!imageId) return base;
    return base === '' ? screenshotToken(imageId) : `${base}\n${screenshotToken(imageId)}`;
}

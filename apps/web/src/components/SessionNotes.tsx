import {
    joinNote,
    LIMITS,
    type NoteEntry,
    newEntryId,
    noteScreenshot,
    splitNote,
    stripScreenshots,
    withScreenshot,
} from '@palmtopai/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EditableText } from './EditableText';
import { LinkedText } from './LinkedText';
import { Markdown } from './Markdown';
import { pastedImage, ScreenshotField, useScreenshotField } from './ScreenshotField';
import { ScreenshotThumb } from './ScreenshotThumb';

function formatTime(ts: number): string {
    const date = new Date(ts);
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return new Date().toDateString() === date.toDateString()
        ? time
        : `${date.toLocaleDateString()} ${time}`;
}

/**
 * The agent's message for the session: read-only on devices. On a copy shared with a person it is
 * the message the owner wrote for them (`from`: the name of the owner).
 */
export function AgentMessage({ text, at, from }: { text: string; at: number; from?: string }) {
    return (
        <section
            aria-label={`Message from ${from ?? 'the agent'}`}
            className="rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sky-950 dark:border-sky-900 dark:bg-sky-950/60 dark:text-sky-100"
        >
            <p className="text-xs font-medium text-sky-700 dark:text-sky-300">
                From {from ?? 'the agent'} · {formatTime(at)}
            </p>
            <Markdown text={text} className="mt-1 text-[15px] leading-snug" />
        </section>
    );
}

const ENTRY_BOX = 'mt-2 block w-full rounded-lg px-3 py-2 text-left text-sm';

/** One element of the note being written: a field with Save, Cancel and, for an old one, Delete. */
function EntryEditor({
    initial,
    label,
    tooLong,
    onSave,
    onCancel,
    onDelete,
}: {
    initial: string;
    label: string;
    /** The whole note would not fit with this text. */
    tooLong: (draft: string) => boolean;
    onSave: (text: string) => void;
    onCancel: () => void;
    onDelete?: () => void;
}) {
    // The element holds its screenshot as a token in its text: here it is a picture to change.
    const [draft, setDraft] = useState(stripScreenshots(initial));
    const field = useScreenshotField(noteScreenshot(initial));
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fieldId = useId();
    const composed = (text: string) => withScreenshot(text.trim(), field.id);

    useEffect(() => {
        textareaRef.current?.focus();
    }, []);

    const long = tooLong(composed(draft));
    return (
        <div className="mt-2">
            <label htmlFor={fieldId} className="sr-only">
                {label}
            </label>
            <Textarea
                id={fieldId}
                ref={textareaRef}
                value={draft}
                rows={3}
                maxLength={LIMITS.note}
                onChange={(event) => setDraft(event.target.value)}
                onPaste={(event) => {
                    const image = pastedImage(event);
                    if (!image) return;
                    event.preventDefault();
                    field.attach(image);
                }}
            />
            <ScreenshotField field={field} />
            {long && (
                <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                    The note is too long: it holds up to {LIMITS.note.toLocaleString('en-US')}{' '}
                    characters in all.
                </p>
            )}
            <div className="mt-1.5 flex justify-end gap-2">
                {onDelete && (
                    <Button
                        type="button"
                        onClick={onDelete}
                        variant="ghost"
                        size="sm"
                        className="mr-auto font-normal text-red-600 hover:text-red-700 dark:text-red-400"
                    >
                        Delete
                    </Button>
                )}
                <Button
                    type="button"
                    onClick={onCancel}
                    variant="ghost"
                    size="sm"
                    className="font-normal"
                >
                    Cancel
                </Button>
                <Button
                    type="button"
                    onClick={() => onSave(composed(draft))}
                    disabled={long || field.busy}
                    size="sm"
                >
                    Save
                </Button>
            </div>
        </div>
    );
}

/**
 * The user's note for the agent on the session, kept as a list of elements that are added and
 * edited one by one. It is still the single `note` of the session: the elements are its lines
 * (`splitNote`), and the agent reads them together with the next `palmtop feedback`.
 */
export function NoteForAgent({
    note,
    delivered,
    onSave,
    to,
    readOnly = false,
}: {
    note: string;
    /** The agent already read this note. */
    delivered: boolean;
    onSave: (note: string) => void;
    /** On a copy shared with a person: the owner, who gets the note instead of "the agent". */
    to?: string;
    /** The note can be read, not written (a copy that stopped taking answers). */
    readOnly?: boolean;
}) {
    const reader = to ?? 'the agent';
    const noteId = useId();
    const entries = splitNote(note);
    /** The element being written: its key, or `new` for one that is not in the list yet. */
    const [editing, setEditing] = useState<string | null>(null);
    const keyOf = (entry: NoteEntry, index: number) => entry.id ?? `#${index}`;

    /** The note with `text` in the place of the element `key` (none: at the end, '' removes it). */
    const withText = (key: string | null, text: string): NoteEntry[] => {
        const trimmed = text.trim();
        const taken: Array<string | null> = entries.map((entry) => entry.id);
        const named = entries.map((entry) => {
            if (entry.id) return entry;
            const id = newEntryId(taken);
            taken.push(id);
            return { ...entry, id };
        });
        const position = key === null ? -1 : entries.findIndex((e, i) => keyOf(e, i) === key);
        if (position === -1) {
            return trimmed === '' ? named : [...named, { id: newEntryId(taken), text: trimmed }];
        }
        return named.flatMap((entry, index) =>
            index !== position ? [entry] : trimmed === '' ? [] : [{ ...entry, text: trimmed }],
        );
    };

    const save = (key: string | null, text: string) => {
        setEditing(null);
        const next = joinNote(withText(key, text));
        if (next !== note) onSave(next);
    };
    const tooLong = (key: string | null) => (draft: string) =>
        joinNote(withText(key, draft)).length > LIMITS.note;

    const boxClass = (filled: boolean) =>
        `${ENTRY_BOX} ${
            filled
                ? 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200'
                : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
        }`;

    return (
        <section
            aria-labelledby={`${noteId}-title`}
            className="rounded-xl border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900"
        >
            <h2 id={`${noteId}-title`} className="font-semibold">
                {to ? `Note for ${to}` : 'Note for the agent'}
            </h2>
            {entries.length > 0 && (
                <ul aria-label={`Elements of the note for ${reader}`}>
                    {entries.map((entry, index) => {
                        const key = keyOf(entry, index);
                        return (
                            <li key={key}>
                                {editing === key ? (
                                    <EntryEditor
                                        initial={entry.text}
                                        label={`Element of the note for ${reader}`}
                                        tooLong={tooLong(key)}
                                        onSave={(text) => save(key, text)}
                                        onCancel={() => setEditing(null)}
                                        onDelete={() => save(key, '')}
                                    />
                                ) : (
                                    <>
                                        <EditableText
                                            text={stripScreenshots(entry.text)}
                                            onEdit={() => setEditing(key)}
                                            disabled={readOnly}
                                            className={boxClass(true)}
                                        >
                                            {stripScreenshots(entry.text) ? (
                                                <span className="whitespace-pre-wrap">
                                                    <LinkedText
                                                        text={stripScreenshots(entry.text)}
                                                    />
                                                </span>
                                            ) : (
                                                <span className="text-zinc-500 italic">
                                                    Screenshot only · tap to edit
                                                </span>
                                            )}
                                        </EditableText>
                                        {noteScreenshot(entry.text) && (
                                            <div className="px-3">
                                                <ScreenshotThumb
                                                    imageId={noteScreenshot(entry.text) as string}
                                                />
                                            </div>
                                        )}
                                    </>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            {editing === 'new' ? (
                <EntryEditor
                    initial=""
                    label={`Note for ${reader}`}
                    tooLong={tooLong(null)}
                    onSave={(text) => save(null, text)}
                    onCancel={() => setEditing(null)}
                />
            ) : (
                (entries.length === 0 || !readOnly) && (
                    <button
                        type="button"
                        onClick={() => setEditing('new')}
                        disabled={readOnly}
                        className={boxClass(false)}
                    >
                        {readOnly
                            ? 'No note'
                            : entries.length === 0
                              ? `+ Write something for ${reader}`
                              : '+ Add another'}
                    </button>
                )
            )}
            {note && (
                <p className="mt-1.5 text-xs text-zinc-500">
                    {to
                        ? delivered
                            ? `Read by ${to}.`
                            : `Sent to ${to}.`
                        : delivered
                          ? 'Read by the agent.'
                          : 'The agent reads it with the next feedback.'}
                </p>
            )}
        </section>
    );
}

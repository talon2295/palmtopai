import { LIMITS, noteScreenshot, stripScreenshots, withScreenshot } from '@palmtopai/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { EditableText } from './EditableText';
import { LinkedText } from './LinkedText';
import { pastedImage, ScreenshotField, useScreenshotField } from './ScreenshotField';
import { ScreenshotThumb } from './ScreenshotThumb';

/**
 * The note of a reviewed item: a line with the note (or an invitation to write one) that opens a
 * field. The draft lives here, so a note changed on another device does not overwrite what the
 * user is typing. A screenshot is part of the note: the text holds its token (`note-text.ts`),
 * which is shown as the picture and never as text.
 */
export function NoteEditor({
    note,
    label,
    editing,
    onEditing,
    onSave,
    readOnly = false,
}: {
    note?: string | undefined;
    /** The note can be read, not written (a copy that stopped taking answers). */
    readOnly?: boolean;
    /** Text of the item, for the label of the field. */
    label: string;
    editing: boolean;
    onEditing: (editing: boolean) => void;
    /** Called only when the note changed; `null` clears it. */
    onSave: (note: string | null) => void;
}) {
    const text = stripScreenshots(note ?? '');
    const screenshot = noteScreenshot(note ?? '');
    const [draft, setDraft] = useState(text);
    const field = useScreenshotField(screenshot);
    const { reset } = field;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const noteId = useId();

    // Remote note changes show up unless the user is typing.
    useEffect(() => {
        if (editing) return;
        setDraft(text);
        reset(screenshot);
    }, [text, screenshot, editing, reset]);

    useEffect(() => {
        if (editing) textareaRef.current?.focus();
    }, [editing]);

    if (readOnly) {
        if (!note) return null;
        return (
            <div className="mt-2 rounded-lg bg-zinc-100 px-3 py-2 text-sm text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200">
                {text && (
                    <p className="whitespace-pre-wrap">
                        <LinkedText text={text} />
                    </p>
                )}
                {screenshot && <ScreenshotThumb imageId={screenshot} />}
            </div>
        );
    }

    if (!editing) {
        return (
            <>
                <EditableText
                    text={text}
                    onEdit={() => onEditing(true)}
                    className={`mt-2 block w-full rounded-lg px-3 py-2 text-left text-sm ${
                        note
                            ? 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800/70 dark:text-zinc-200'
                            : 'text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800'
                    }`}
                >
                    {text ? (
                        <span className="whitespace-pre-wrap">
                            <LinkedText text={text} />
                        </span>
                    ) : note ? (
                        <span className="text-zinc-500 italic">Screenshot only · tap to edit</span>
                    ) : (
                        '+ Add note'
                    )}
                </EditableText>
                {screenshot && (
                    <div className="px-3">
                        <ScreenshotThumb imageId={screenshot} />
                    </div>
                )}
            </>
        );
    }

    const next = () => withScreenshot(draft.trim(), field.id);
    const save = () => {
        onEditing(false);
        const saved = next();
        if (saved !== (note ?? '')) onSave(saved === '' ? null : saved);
    };

    return (
        <div className="mt-2">
            <label htmlFor={noteId} className="sr-only">
                Note for {label}
            </label>
            <Textarea
                id={noteId}
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
            <div className="mt-1.5 flex justify-end gap-2">
                <Button
                    type="button"
                    onClick={() => {
                        setDraft(text);
                        reset(screenshot);
                        onEditing(false);
                    }}
                    variant="ghost"
                    size="sm"
                    className="font-normal"
                >
                    Cancel
                </Button>
                <Button type="button" onClick={save} disabled={field.busy} size="sm">
                    Save note
                </Button>
            </div>
        </div>
    );
}

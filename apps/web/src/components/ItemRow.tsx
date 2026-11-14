import { type Item, type ItemStatus, LIMITS } from '@palmtopai/protocol';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { hasLinks } from '@/lib/linkify';
import { plainTitle, splitTitle } from '@/lib/markdown';
import { EditableText } from './EditableText';
import { LinkedText } from './LinkedText';
import { Markdown, MarkdownTitle } from './Markdown';
import { NoteEditor } from './NoteEditor';
import { type PersonOutcome, SharedOutcomes } from './SharedOutcomes';

export interface ItemChange {
    status?: ItemStatus | null;
    note?: string | null;
    /** Only for items added by the user. */
    text?: string;
}

const STATUS_OPTIONS: Array<{
    status: ItemStatus;
    symbol: string;
    label: string;
    active: string;
}> = [
    {
        status: 'done',
        symbol: '✓',
        label: 'Done',
        active: 'bg-emerald-600 text-white border-emerald-600',
    },
    {
        status: 'cancelled',
        symbol: '✕',
        label: 'Cancelled',
        active: 'bg-red-600 text-white border-red-600',
    },
    {
        status: 'question',
        symbol: '?',
        label: 'Question',
        active: 'bg-amber-500 text-white border-amber-500',
    },
];

/** A running countdown before the item is hidden; a new `run` restarts the bar. */
export interface ItemCountdown {
    run: number;
    durationMs: number;
}

export function ItemRow({
    item,
    onChange,
    onEditingChange,
    onRemove,
    countdown,
    readOnly = false,
    outcomes,
    confirm = (message) => window.confirm(message),
}: {
    item: Item;
    /** What the people it is shared with answered, shown under the item. */
    outcomes?: PersonOutcome[] | undefined;
    /** The item can be read, not answered (a copy that stopped taking answers). */
    readOnly?: boolean;
    onChange: (change: ItemChange) => void;
    /** Given for items added by the user: their text can be edited and they can be removed. */
    onRemove?: () => void;
    /**
     * Called when the item starts or stops being worked on: note editor or status choices open.
     * Called before `onChange` when both happen in the same tap.
     */
    onEditingChange?: (editing: boolean) => void;
    countdown?: ItemCountdown;
    confirm?: (message: string) => boolean;
}) {
    const [editing, setEditingState] = useState(false);
    const [editingText, setEditingTextState] = useState(false);
    const [textDraft, setTextDraft] = useState(item.text);
    const textRef = useRef<HTMLTextAreaElement>(null);
    const textId = useId();
    // A reviewed item shows only its status; tapping it opens the other choices.
    const [choosing, setChoosingState] = useState(false);
    const statusRef = useRef<HTMLFieldSetElement>(null);

    useEffect(() => {
        if (!editingText) setTextDraft(item.text);
    }, [item.text, editingText]);

    useEffect(() => {
        if (editingText) textRef.current?.focus();
    }, [editingText]);

    /** Once per event: all flags are read from this render. */
    const setHeld = useCallback(
        (next: { editing?: boolean; choosing?: boolean; editingText?: boolean }) => {
            const nextEditing = next.editing ?? editing;
            const nextChoosing = next.choosing ?? choosing;
            const nextEditingText = next.editingText ?? editingText;
            setEditingState(nextEditing);
            setChoosingState(nextChoosing);
            setEditingTextState(nextEditingText);
            const held = nextEditing || nextChoosing || nextEditingText;
            if (held !== (editing || choosing || editingText)) onEditingChange?.(held);
        },
        [editing, choosing, editingText, onEditingChange],
    );

    const saveText = () => {
        const text = textDraft.trim();
        setHeld({ editingText: false });
        if (text !== '' && text !== item.text) onChange({ text });
    };

    const remove = () => {
        if (!onRemove || !confirm('Delete this item?')) return;
        setHeld({ editingText: false, editing: false, choosing: false });
        onRemove();
    };

    // The choices close on Escape, a tap outside, or a status reset on another device.
    useEffect(() => {
        if (!choosing) return;
        if (!item.status) {
            setHeld({ choosing: false });
            return;
        }
        const closeOutside = (event: PointerEvent) => {
            if (!statusRef.current?.contains(event.target as Node)) setHeld({ choosing: false });
        };
        const closeOnEscape = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setHeld({ choosing: false });
        };
        document.addEventListener('pointerdown', closeOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('pointerdown', closeOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [choosing, item.status, setHeld]);

    const tapStatus = (status: ItemStatus) => {
        if (!item.status) return onChange({ status });
        if (!choosing) {
            if (status === item.status) setHeld({ choosing: true });
            return;
        }
        if (status !== item.status) {
            setHeld({ choosing: false });
            return onChange({ status });
        }
        if (item.note && !confirm('Clear the status? The note will be deleted too.')) return;
        setHeld({ editing: false, choosing: false });
        onChange({ status: null });
    };

    // What the agent writes is markdown: the first line is the title, next to the status buttons;
    // the lines after it, and the old `detail`, go under the row at its full width.
    const { title, rest } = item.addedByUser ? { title: '', rest: '' } : splitTitle(item.text);
    const body = [title ? rest : '', item.detail ?? ''].filter((part) => part.trim() !== '');
    const label = item.addedByUser ? item.text : plainTitle(item.text);

    return (
        <li className="relative py-3">
            <div className="flex items-start gap-3">
                {onRemove && !readOnly ? (
                    <div className="min-w-0 flex-1">
                        {editingText ? (
                            <>
                                <label htmlFor={textId} className="sr-only">
                                    Text of the item
                                </label>
                                <Textarea
                                    id={textId}
                                    ref={textRef}
                                    value={textDraft}
                                    rows={2}
                                    maxLength={LIMITS.text}
                                    onChange={(event) => setTextDraft(event.target.value)}
                                    className="text-[15px]"
                                />
                                <div className="mt-1.5 flex gap-2">
                                    <Button
                                        type="button"
                                        onClick={remove}
                                        variant="ghost"
                                        size="sm"
                                        className="mr-auto font-normal text-red-600 hover:text-red-700 dark:text-red-400"
                                    >
                                        Delete
                                    </Button>
                                    <Button
                                        type="button"
                                        onClick={() => {
                                            setTextDraft(item.text);
                                            setHeld({ editingText: false });
                                        }}
                                        variant="ghost"
                                        size="sm"
                                        className="font-normal"
                                    >
                                        Cancel
                                    </Button>
                                    <Button
                                        type="button"
                                        onClick={saveText}
                                        disabled={textDraft.trim() === ''}
                                        size="sm"
                                    >
                                        Save
                                    </Button>
                                </div>
                            </>
                        ) : (
                            <EditableText
                                text={item.text}
                                onEdit={() => setHeld({ editingText: true, choosing: false })}
                                label={`Edit ${item.text}`}
                                className="block w-full pt-1.5 text-left text-[15px] leading-snug break-words"
                            >
                                <LinkedText text={item.text} />
                                <span className="mt-0.5 block text-xs text-zinc-500">
                                    {hasLinks(item.text)
                                        ? 'Added by you'
                                        : 'Added by you · tap to edit'}
                                </span>
                            </EditableText>
                        )}
                    </div>
                ) : (
                    <div className="min-w-0 flex-1 pt-1.5 text-[15px] leading-snug break-words">
                        {item.addedByUser ? (
                            <LinkedText text={item.text} />
                        ) : title ? (
                            <MarkdownTitle text={title} />
                        ) : (
                            <Markdown text={rest} />
                        )}
                    </div>
                )}
                {!editingText && (
                    <fieldset
                        ref={statusRef}
                        disabled={readOnly}
                        className="flex shrink-0 gap-1.5"
                        aria-label={`Status of ${label}`}
                    >
                        {STATUS_OPTIONS.map((option) => {
                            const active = item.status === option.status;
                            const shown = active || !item.status || choosing;
                            return (
                                <button
                                    key={option.status}
                                    type="button"
                                    aria-pressed={active}
                                    aria-label={option.label}
                                    {...(active && { 'aria-expanded': choosing })}
                                    {...(!shown && { 'aria-hidden': true, tabIndex: -1 })}
                                    title={option.label}
                                    disabled={readOnly}
                                    onClick={() => tapStatus(option.status)}
                                    // Hidden choices shrink to nothing; the negative margin eats the gap.
                                    className={`h-9 overflow-hidden rounded-lg text-base font-semibold transition-all duration-200 ${
                                        shown
                                            ? 'w-9 border'
                                            : 'pointer-events-none -ml-1.5 w-0 scale-75 border-0 opacity-0'
                                    } ${
                                        active
                                            ? option.active
                                            : 'border-zinc-300 text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800'
                                    }`}
                                >
                                    {option.symbol}
                                </button>
                            );
                        })}
                    </fieldset>
                )}
            </div>

            {body.length > 0 && (
                <Markdown
                    text={body.join('\n\n')}
                    className="mt-1.5 text-[15px] leading-snug text-zinc-700 dark:text-zinc-300"
                />
            )}

            {item.status && (
                <NoteEditor
                    {...(item.note !== undefined && { note: item.note })}
                    readOnly={readOnly}
                    label={label}
                    editing={editing}
                    onEditing={(next) =>
                        setHeld(next ? { editing: true, choosing: false } : { editing: false })
                    }
                    onSave={(note) => onChange({ note })}
                />
            )}

            {outcomes && outcomes.length > 0 && <SharedOutcomes outcomes={outcomes} />}

            {countdown && (
                // Absolute: the bar does not change the height of the card.
                <span
                    key={countdown.run}
                    aria-hidden="true"
                    data-testid="hide-countdown"
                    style={{ animationDuration: `${countdown.durationMs}ms` }}
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-countdown rounded-full bg-zinc-400 dark:bg-zinc-500"
                />
            )}
        </li>
    );
}

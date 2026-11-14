import { LIMITS } from '@palmtopai/protocol';
import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

/**
 * "+ Add item" at the bottom of a checklist: the item goes to the agent as a request. On a
 * question it is the answer of the user's own, so the texts can be changed.
 */
export function AddItemForm({
    checklistTitle,
    onAdd,
    cta = '+ Add item',
    placeholder = 'Something more to check',
    fieldLabel,
    onOpenChange,
}: {
    checklistTitle: string;
    onAdd: (text: string) => void;
    /** Label of the button that opens the field. */
    cta?: string;
    placeholder?: string;
    /** Accessible name of the field; defaults to "New item for <checklist>". */
    fieldLabel?: string;
    /** Called when the field opens or closes, e.g. to keep a carousel open while writing. */
    onOpenChange?: (open: boolean) => void;
}) {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const inputId = useId();

    useEffect(() => {
        if (open) inputRef.current?.focus();
    }, [open]);

    const close = () => {
        setDraft('');
        setOpen(false);
        onOpenChange?.(false);
    };

    const submit = () => {
        const text = draft.trim();
        if (text === '') return;
        onAdd(text);
        close();
    };

    if (!open) {
        return (
            <Button
                variant="ghost"
                onClick={() => {
                    setOpen(true);
                    onOpenChange?.(true);
                }}
                className="-mx-2 mb-2 h-auto justify-start px-2 py-2 font-normal text-zinc-500 dark:text-zinc-400"
            >
                {cta}
            </Button>
        );
    }

    return (
        <form
            className="border-t border-zinc-100 py-3 dark:border-zinc-800"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <label htmlFor={inputId} className="sr-only">
                {fieldLabel ?? `New item for ${checklistTitle}`}
            </label>
            <Textarea
                id={inputId}
                ref={inputRef}
                value={draft}
                rows={2}
                maxLength={LIMITS.text}
                placeholder={placeholder}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        submit();
                    } else if (event.key === 'Escape') {
                        close();
                    }
                }}
            />
            <div className="mt-1.5 flex justify-end gap-2">
                <Button
                    type="button"
                    onClick={close}
                    variant="ghost"
                    size="sm"
                    className="font-normal"
                >
                    Cancel
                </Button>
                <Button type="submit" disabled={draft.trim() === ''} size="sm">
                    Add
                </Button>
            </div>
        </form>
    );
}

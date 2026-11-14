import type { ReactNode } from 'react';
import { hasLinks } from '@/lib/linkify';

/**
 * A text that opens its editor when tapped. A link cannot sit inside a button (the tap would open
 * the editor, and an `a` in a `button` is not valid), so a text that has links is shown as it is
 * with a separate "Edit" button under it.
 */
export function EditableText({
    text,
    onEdit,
    disabled = false,
    label,
    className,
    children,
}: {
    /** The text shown, to tell whether it has links. */
    text: string;
    onEdit: () => void;
    /** The text can be read, not written. */
    disabled?: boolean;
    /** Accessible name of the button that opens the editor. */
    label?: string;
    className: string;
    children: ReactNode;
}) {
    if (!hasLinks(text)) {
        return (
            <button
                type="button"
                onClick={onEdit}
                disabled={disabled}
                {...(label && { 'aria-label': label })}
                className={className}
            >
                {children}
            </button>
        );
    }
    return (
        <div className={className}>
            {children}
            {!disabled && (
                <div className="mt-1 flex justify-end">
                    <button
                        type="button"
                        onClick={onEdit}
                        aria-label={label ?? 'Edit'}
                        className="rounded-md px-2 py-1 text-xs text-zinc-500 underline hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                    >
                        Edit
                    </button>
                </div>
            )}
        </div>
    );
}

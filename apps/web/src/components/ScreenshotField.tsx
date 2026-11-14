import { type ClipboardEvent, useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useImages } from '@/lib/images';
import { ScreenshotThumb } from './ScreenshotThumb';

/** The screenshot being attached to a note while it is written: its id, and what is going on. */
export interface ScreenshotFieldState {
    /** `null`: none. */
    id: string | null;
    busy: boolean;
    error: string | null;
    /** Prepares and sends the picture, then holds its id. */
    attach: (file: Blob) => void;
    remove: () => void;
    /** Goes back to what a note holds (the editor was closed, or the note changed elsewhere). */
    reset: (id: string | null) => void;
}

export function useScreenshotField(initial: string | null): ScreenshotFieldState {
    const images = useImages();
    const [id, setId] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const send = images?.send;

    const attach = useCallback(
        (file: Blob) => {
            if (!send) return;
            setBusy(true);
            setError(null);
            send(file)
                .then(setId)
                .catch((failure: unknown) => {
                    setError(failure instanceof Error ? failure.message : 'The screenshot failed.');
                })
                .finally(() => setBusy(false));
        },
        [send],
    );
    const remove = useCallback(() => setId(null), []);
    const reset = useCallback((next: string | null) => {
        setId(next);
        setError(null);
    }, []);
    return { id, busy, error, attach, remove, reset };
}

/** An image pasted into a field, when there is one. */
export function pastedImage(event: ClipboardEvent): File | null {
    for (const item of Array.from(event.clipboardData?.items ?? [])) {
        if (item.kind === 'file' && item.type.startsWith('image/')) return item.getAsFile();
    }
    return null;
}

/** Add, replace or remove the screenshot of a note, under the field it is written in. */
export function ScreenshotField({ field }: { field: ScreenshotFieldState }) {
    const images = useImages();
    const input = useRef<HTMLInputElement>(null);
    if (!images) return null;
    const unavailable = !images.enabled;
    return (
        <div className="mt-1.5">
            {field.id && <ScreenshotThumb imageId={field.id} />}
            <input
                ref={input}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                aria-label="Choose a screenshot"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) field.attach(file);
                }}
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={unavailable || field.busy}
                    onClick={() => input.current?.click()}
                >
                    {field.busy ? 'Sending…' : field.id ? 'Replace screenshot' : 'Add screenshot'}
                </Button>
                {field.id && !field.busy && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="font-normal"
                        onClick={field.remove}
                    >
                        Remove screenshot
                    </Button>
                )}
                {(unavailable || !images.online) && (
                    <span className="text-xs text-zinc-500">
                        {unavailable
                            ? (images.unavailable ?? 'Screenshots are not available here.')
                            : 'The computer is offline: the screenshot is sent when it is back.'}
                    </span>
                )}
            </div>
            {field.error && (
                <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {field.error}
                </p>
            )}
        </div>
    );
}

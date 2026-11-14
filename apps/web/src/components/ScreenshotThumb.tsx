import { X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useImages, useImageUrl } from '@/lib/images';

/** A screenshot of a note: a small picture that opens full size when tapped. */
export function ScreenshotThumb({ imageId }: { imageId: string }) {
    const state = useImageUrl(imageId);
    const offline = !useImages()?.online;
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!open) return;
        const close = (event: KeyboardEvent) => {
            if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('keydown', close);
        return () => document.removeEventListener('keydown', close);
    }, [open]);

    if (state.status === 'loading') {
        return (
            <p role="status" className="mt-1.5 text-xs text-zinc-500">
                Loading screenshot…
            </p>
        );
    }
    if (state.status === 'missing') {
        return (
            <p className="mt-1.5 text-xs text-zinc-500">
                Screenshot not available{offline ? ' while the computer is offline' : ''}.
            </p>
        );
    }
    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                aria-label="Open screenshot"
                className="mt-1.5 block max-w-full overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-700"
            >
                <img
                    src={state.url}
                    alt="Screenshot"
                    className="block max-h-40 max-w-full object-contain"
                />
            </button>
            {open && (
                // The backdrop is a button: a tap anywhere closes, as Escape does.
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-label="Screenshot"
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-3"
                >
                    <button
                        type="button"
                        aria-label="Close screenshot"
                        onClick={() => setOpen(false)}
                        className="absolute inset-0 cursor-zoom-out"
                    />
                    <img
                        src={state.url}
                        alt="Screenshot, full size"
                        className="pointer-events-none relative max-h-full max-w-full object-contain"
                    />
                    <button
                        type="button"
                        aria-label="Close"
                        onClick={() => setOpen(false)}
                        className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-3 rounded-full bg-black/60 p-2 text-white"
                    >
                        <X className="size-5" />
                    </button>
                </div>
            )}
        </>
    );
}

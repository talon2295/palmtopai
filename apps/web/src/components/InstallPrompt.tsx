import { Download, X } from 'lucide-react';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/button';
import {
    type DeferredInstallPrompt,
    type DevicePlatform,
    installPromptDelay,
    installPromptEvent,
    loadInstallPrompt,
    onInstallPromptChange,
    saveInstallPrompt,
} from '@/lib/install';

/**
 * When the invitation to install shows: on its own (timers of `installPromptDelay`) or from
 * "Install app" in the menu. "Close" hides it until the next opening, "Don't show again" for good.
 */
export function useInstallPrompt(options: {
    installed: boolean;
    platform: DevicePlatform;
    paired: boolean;
}) {
    const { installed, platform, paired } = options;
    const [shown, setShown] = useState(false);

    useEffect(() => {
        if (installed || !paired) return;
        const now = Date.now();
        let state = loadInstallPrompt();
        if (!state) {
            state = { pairedAt: now, never: false };
            saveInstallPrompt(state);
        }
        const delay = installPromptDelay({ installed, platform, paired, state, now });
        if (delay === null) return;
        const timer = setTimeout(() => setShown(true), delay);
        return () => clearTimeout(timer);
    }, [installed, platform, paired]);

    const close = useCallback(() => setShown(false), []);
    const never = useCallback(() => {
        setShown(false);
        saveInstallPrompt({ pairedAt: loadInstallPrompt()?.pairedAt ?? Date.now(), never: true });
    }, []);
    const open = useCallback(() => setShown(true), []);
    return { shown, close, never, open };
}

function useDeferredPrompt(): DeferredInstallPrompt | null {
    return useSyncExternalStore(onInstallPromptChange, installPromptEvent, () => null);
}

/** A notification from the top: how to put palmtop on the Home Screen of this device. */
export function InstallPrompt({
    platform,
    onClose,
    onNever,
}: {
    platform: DevicePlatform;
    onClose: () => void;
    onNever: () => void;
}) {
    const deferred = useDeferredPrompt();

    const install = async () => {
        if (!deferred) return;
        await deferred.prompt();
        const { outcome } = await deferred.userChoice;
        if (outcome === 'accepted') onClose();
    };

    return (
        <div className="fixed inset-x-0 top-0 z-50 px-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <section
                aria-label="Install palmtop"
                className="animate-in slide-in-from-top mx-auto flex max-w-md flex-col gap-3 rounded-2xl border border-zinc-200 bg-white p-4 text-sm shadow-lg duration-300 dark:border-zinc-800 dark:bg-zinc-900"
            >
                <div className="flex items-start gap-3">
                    <Download className="mt-0.5 size-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                    <div className="min-w-0 flex-1">
                        <p className="font-semibold">Add palmtop to your Home Screen</p>
                        <p className="text-zinc-600 dark:text-zinc-400">
                            It opens like an app, with notifications
                            {platform === 'ios'
                                ? ', and keeps your pairing: Safari clears it after 7 days without a visit.'
                                : '.'}
                        </p>
                    </div>
                    <button
                        type="button"
                        aria-label="Hide until next time"
                        onClick={onClose}
                        className="-m-1 rounded p-1 text-zinc-500"
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <ol className="list-decimal space-y-1 pl-9 text-zinc-700 dark:text-zinc-300">
                    {platform === 'ios' ? (
                        <li>
                            Tap <strong>Share</strong> (in the ⋯ menu of Safari), then{' '}
                            <strong>Add to Home Screen</strong>.
                        </li>
                    ) : deferred ? (
                        <li>
                            Tap <strong>Install</strong> below.
                        </li>
                    ) : (
                        <li>
                            Open the browser menu <strong>⋮</strong> and tap{' '}
                            <strong>Install app</strong> or <strong>Add to Home screen</strong>.
                        </li>
                    )}
                    <li>
                        Open palmtop from the Home Screen: it shows a code. On your computer run{' '}
                        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">
                            palmtop pair CODE
                        </code>
                        .
                    </li>
                </ol>
                <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={onNever}>
                        Don&apos;t show again
                    </Button>
                    {deferred && platform !== 'ios' ? (
                        <Button size="sm" onClick={install}>
                            Install
                        </Button>
                    ) : (
                        <Button variant="outline" size="sm" onClick={onClose}>
                            Close
                        </Button>
                    )}
                </div>
            </section>
        </div>
    );
}

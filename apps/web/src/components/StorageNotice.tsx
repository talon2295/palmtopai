import { useEffect, useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { loadStorageCleared } from '@/lib/device-key';
import type { DevicePlatform } from '@/lib/install';
import type { Pairing } from '@/lib/pairings';
import {
    dismissStorageNotice,
    type StorageNoticeKind,
    storageNoticeOf,
} from '@/lib/storage-notice';

/** Whether the browser promised to keep this app's data; `undefined` where it cannot tell. */
function usePersisted(): boolean | undefined {
    const [persisted, setPersisted] = useState<boolean | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
        storage
            ?.persisted?.()
            .then((value) => {
                if (!cancelled) setPersisted(value);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, []);
    return persisted;
}

/**
 * The notice about this app's storage for these pairings, and how to dismiss it. Read on every
 * render: a computer refusing the key records a deletion while the app is open.
 */
export function useStorageNotice(pairings: Pairing[]): {
    kind: StorageNoticeKind | null;
    guestOnly: boolean;
    dismiss: () => void;
} {
    const persisted = usePersisted();
    const [, setDismissed] = useState(0);
    const cleared = loadStorageCleared();
    const kind = storageNoticeOf({
        cleared,
        persisted,
        hasPairing: pairings.length > 0,
        hasOwnPairing: pairings.some((pairing) => !pairing.guest),
    });
    // After a deletion, ask again to keep the data: the browser may say yes this time.
    useEffect(() => {
        if (kind === 'cleared') void navigator.storage?.persist?.().catch(() => {});
    }, [kind]);
    return {
        kind,
        guestOnly: pairings.every((pairing) => pairing.guest),
        dismiss: () => {
            if (!kind) return;
            dismissStorageNotice(kind, cleared);
            setDismissed((count) => count + 1);
        },
    };
}

export function StorageNotice({
    kind,
    guestOnly,
    installed,
    platform,
    onDismiss,
}: {
    kind: StorageNoticeKind;
    /** Only invitations of others on this device: they come back with a new invitation. */
    guestOnly: boolean;
    /** Already the installed app: nothing to suggest but free space. */
    installed: boolean;
    platform: DevicePlatform;
    onDismiss: () => void;
}) {
    const keep = installed
        ? 'Keep some free space on the device.'
        : platform === 'other'
          ? 'Installing palmtop as an app (Install app, in the ⋯ menu) makes that less likely.'
          : 'Adding palmtop to the Home Screen makes that less likely.';
    return (
        <Alert
            role={kind === 'cleared' ? 'alert' : 'status'}
            variant="warning"
            className="flex items-start gap-3 text-left"
        >
            <p className="flex-1">
                {kind === 'cleared' ? (
                    <>
                        Your browser deleted the data of this app, probably because the device is
                        low on space.{' '}
                        {guestOnly
                            ? 'Free some space, then ask for a new invitation.'
                            : 'Free some space, then pair this device again with your computers.'}
                    </>
                ) : (
                    <>
                        Your browser may delete the data of this app when the device is low on
                        space, and then you would have to pair again. {keep}
                    </>
                )}
            </p>
            <button type="button" onClick={onDismiss} className="font-medium">
                Dismiss
            </button>
        </Alert>
    );
}

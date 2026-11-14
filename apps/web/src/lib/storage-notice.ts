import type { StorageCleared } from './device-key';
import { browserStore, type KeyValueStore, readJson, writeJson } from './storage';

const DISMISSED_KEY = 'palmtop.storageNotice';

/**
 * `cleared`: the browser deleted this app's data (the keys with it): the pairings made before
 * no longer work. `at-risk`: the browser has not promised to keep it (`persisted()` is false).
 */
export type StorageNoticeKind = 'cleared' | 'at-risk';

/**
 * What was dismissed, by the deletion it was about (`none` before any): a notice comes back only
 * after a new deletion.
 */
interface Dismissed {
    cleared?: string;
    atRisk?: string;
}

function loadDismissed(store: KeyValueStore | null): Dismissed {
    const value = readJson(store, DISMISSED_KEY) as Dismissed | null;
    return {
        ...(typeof value?.cleared === 'string' && { cleared: value.cleared }),
        ...(typeof value?.atRisk === 'string' && { atRisk: value.atRisk }),
    };
}

/** The notice to show, if any: a deletion comes first, the risk only with pairings of one's own. */
export function storageNoticeOf(
    input: {
        cleared: StorageCleared | null;
        /** `undefined` while unknown, or where the browser cannot tell. */
        persisted: boolean | undefined;
        hasPairing: boolean;
        /** A pairing with a computer, not only invitations of others. */
        hasOwnPairing: boolean;
    },
    store: KeyValueStore | null = browserStore(),
): StorageNoticeKind | null {
    const dismissed = loadDismissed(store);
    const { cleared } = input;
    if (cleared && input.hasPairing && dismissed.cleared !== cleared.key) return 'cleared';
    if (
        input.persisted === false &&
        input.hasOwnPairing &&
        dismissed.atRisk !== (cleared?.key ?? 'none')
    ) {
        return 'at-risk';
    }
    return null;
}

/** Hides a notice until the browser deletes this app's data again. */
export function dismissStorageNotice(
    kind: StorageNoticeKind,
    cleared: StorageCleared | null,
    store: KeyValueStore | null = browserStore(),
): void {
    const key = cleared?.key ?? 'none';
    writeJson(store, DISMISSED_KEY, {
        ...loadDismissed(store),
        ...(kind === 'cleared' ? { cleared: key } : { atRisk: key }),
    });
}

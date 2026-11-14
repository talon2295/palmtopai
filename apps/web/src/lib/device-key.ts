import { browserStore, type KeyValueStore, readJson, writeJson } from './storage';

const DEVICE_KEY = 'palmtop.deviceKey';
const CLEARED_KEY = 'palmtop.storageCleared';

/**
 * The browser deleted this app's storage (IndexedDB, with the keys of this device) and kept
 * `localStorage`: `key` is the fingerprint of the keys made after, `at` when it was noticed.
 */
export interface StorageCleared {
    at: number;
    key: string;
}

/**
 * Remembers the fingerprint of this device's key. Another one than the last remembered means the
 * keys were deleted and made again: that is recorded (`loadStorageCleared`) and returned.
 */
export function noteDeviceKey(
    fingerprint: string,
    store: KeyValueStore | null = browserStore(),
    now = Date.now(),
): boolean {
    const previous = readJson(store, DEVICE_KEY);
    if (previous === fingerprint) return false;
    writeJson(store, DEVICE_KEY, fingerprint);
    if (typeof previous !== 'string') return false;
    markStorageCleared(fingerprint, store, now);
    return true;
}

/**
 * Records that the browser deleted this app's storage, found some other way (a computer refused
 * the key of this device). The same keys are recorded once, however often it is found.
 */
export function markStorageCleared(
    fingerprint: string,
    store: KeyValueStore | null = browserStore(),
    now = Date.now(),
): void {
    if (loadStorageCleared(store)?.key === fingerprint) return;
    writeJson(store, CLEARED_KEY, { at: now, key: fingerprint } satisfies StorageCleared);
}

export function loadStorageCleared(
    store: KeyValueStore | null = browserStore(),
): StorageCleared | null {
    const value = readJson(store, CLEARED_KEY) as Partial<StorageCleared> | null;
    return typeof value?.at === 'number' && typeof value.key === 'string'
        ? { at: value.at, key: value.key }
        : null;
}

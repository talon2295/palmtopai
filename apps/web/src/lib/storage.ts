/**
 * localStorage can be missing or throw (private mode, quota, disabled storage).
 * Every access goes through these helpers so the app still works, just without persistence.
 */
export interface KeyValueStore {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

export function browserStore(): KeyValueStore | null {
    try {
        return globalThis.localStorage ?? null;
    } catch {
        return null;
    }
}

export function readJson(store: KeyValueStore | null, key: string): unknown {
    try {
        const raw = store?.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

export function writeJson(store: KeyValueStore | null, key: string, value: unknown): void {
    try {
        store?.setItem(key, JSON.stringify(value));
    } catch {
        // Ignored: persistence is best effort.
    }
}

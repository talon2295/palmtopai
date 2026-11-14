import { type DeviceKeyPair, generateDeviceKeys } from '@palmtopai/protocol';

const DB_NAME = 'palmtop-identity';
const DB_VERSION = 1;
const STORE = 'keys';
const DEVICE_KEY = 'device';
const ATTEMPTS = 3;
const RETRY_MS = 300;

/** The keys of this device can't be read or saved: nothing may pair or connect with others. */
export class DeviceKeysError extends Error {
    override name = 'DeviceKeysError';
}

/**
 * The key pair of this device: made once, kept in IndexedDB (in its own database, apart from
 * the cache of checklists), the private half not extractable. Every computer this device pairs
 * with registers its public half. Unpairing does not touch them: the computer revokes the public
 * half, and the same keys pair again later.
 *
 * Only keys that are saved are returned: keys that live as long as the page would pair, then be
 * gone at the next start, and every computer would refuse this device. When IndexedDB fails it
 * is tried again, then `DeviceKeysError`.
 */
export async function loadDeviceKeys(
    /** `null` (or a browser without it): no IndexedDB. */
    factory: IDBFactory | null | undefined = globalThis.indexedDB,
    options: { attempts?: number; retryMs?: number } = {},
): Promise<DeviceKeyPair> {
    if (!factory) throw new DeviceKeysError('IndexedDB is not available');
    const attempts = options.attempts ?? ATTEMPTS;
    let failure: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, options.retryMs ?? RETRY_MS));
        }
        try {
            return await loadOnce(factory);
        } catch (error) {
            failure = error;
        }
    }
    throw new DeviceKeysError(
        `the keys of this device can't be read: ${(failure as Error | undefined)?.message ?? 'unknown error'}`,
    );
}

async function loadOnce(factory: IDBFactory): Promise<DeviceKeyPair> {
    const database = await open(factory);
    try {
        const stored = await read(database);
        if (isKeyPair(stored)) return stored;
        const keys = await generateDeviceKeys();
        try {
            // `add`, not `put`: another tab that made its keys first keeps them, and so do we.
            // A record that is not a key pair (it cannot be used) is replaced.
            await request(database, 'readwrite', (store) =>
                stored === undefined ? store.add(keys, DEVICE_KEY) : store.put(keys, DEVICE_KEY),
            );
        } catch {
            // Another tab saved its keys first: read back below.
        }
        // What is returned is what was saved, read back: never keys that only live in memory.
        const saved = await read(database);
        if (!isKeyPair(saved)) throw new Error('the new keys were not saved');
        return saved;
    } finally {
        database.close();
    }
}

function read(database: IDBDatabase): Promise<unknown> {
    return request<unknown>(database, 'readonly', (store) => store.get(DEVICE_KEY));
}

function isKeyPair(value: unknown): value is DeviceKeyPair {
    const pair = value as Partial<DeviceKeyPair> | undefined;
    return Boolean(pair?.privateKey && pair.publicKey);
}

function open(factory: IDBFactory | undefined): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!factory) {
            reject(new Error('IndexedDB is not available'));
            return;
        }
        const opening = factory.open(DB_NAME, DB_VERSION);
        opening.onupgradeneeded = () => {
            if (!opening.result.objectStoreNames.contains(STORE)) {
                opening.result.createObjectStore(STORE);
            }
        };
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
        opening.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
}

function request<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    make: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const pending = make(transaction.objectStore(STORE));
        transaction.oncomplete = () => resolve(pending.result as T);
        transaction.onerror = () => reject(transaction.error ?? pending.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
    });
}

/**
 * A short fingerprint of this device's public key (sha256, base64url, 16 characters): kept next
 * to the pairings, it tells when the browser deleted the keys and made new ones. Not a secret.
 */
export async function deviceKeyFingerprint(publicKey: CryptoKey): Promise<string> {
    const raw = await crypto.subtle.exportKey('raw', publicKey);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw));
    let binary = '';
    for (const byte of digest) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').slice(0, 16);
}

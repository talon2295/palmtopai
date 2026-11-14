import { describe, expect, test } from 'bun:test';
import { exportPublicKey } from '@palmtopai/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { DeviceKeysError, loadDeviceKeys } from '../src';

describe('device keys', () => {
    test('made once, kept, not extractable', async () => {
        const indexedDB = new IDBFactory();
        const first = await loadDeviceKeys(indexedDB);
        expect(first.privateKey.extractable).toBe(false);
        const again = await loadDeviceKeys(indexedDB);
        expect(await exportPublicKey(again.publicKey)).toBe(await exportPublicKey(first.publicKey));
        // The stored private key still signs: it is a working key, not a copy of one.
        const data = new TextEncoder().encode('x');
        const signature = await crypto.subtle.sign('Ed25519', again.privateKey, data);
        expect(await crypto.subtle.verify('Ed25519', first.publicKey, signature, data)).toBe(true);
    });

    test('two tabs loading at once end with the same keys', async () => {
        const indexedDB = new IDBFactory();
        const [a, b] = await Promise.all([loadDeviceKeys(indexedDB), loadDeviceKeys(indexedDB)]);
        const stored = await loadDeviceKeys(indexedDB);
        const kept = await exportPublicKey(stored.publicKey);
        expect([await exportPublicKey(a.publicKey), await exportPublicKey(b.publicKey)]).toEqual([
            kept,
            kept,
        ]);
    });

    test('without IndexedDB there are no keys: none that would be gone at the next start', async () => {
        await expect(loadDeviceKeys(null)).rejects.toBeInstanceOf(DeviceKeysError);
    });

    test('an IndexedDB that keeps failing gives an error after a few tries, not new keys', async () => {
        const factory = flaky(new IDBFactory(), Number.POSITIVE_INFINITY);
        await expect(loadDeviceKeys(factory, { retryMs: 1 })).rejects.toBeInstanceOf(
            DeviceKeysError,
        );
        expect(factory.opened).toBe(3);
    });

    test('an IndexedDB that fails once is tried again, and the saved keys come back', async () => {
        const indexedDB = new IDBFactory();
        const saved = await exportPublicKey((await loadDeviceKeys(indexedDB)).publicKey);
        const keys = await loadDeviceKeys(flaky(indexedDB, 1), { retryMs: 1 });
        expect(await exportPublicKey(keys.publicKey)).toBe(saved);
    });

    test('a stored record that is not a key pair is replaced by keys that are saved', async () => {
        const indexedDB = new IDBFactory();
        await loadDeviceKeys(indexedDB);
        await overwrite(indexedDB, { publicKey: null });
        const keys = await loadDeviceKeys(indexedDB);
        const again = await loadDeviceKeys(indexedDB);
        expect(await exportPublicKey(again.publicKey)).toBe(await exportPublicKey(keys.publicKey));
    });
});

/** A factory whose first `failures` opens fail, like an IndexedDB that lost its backing store. */
function flaky(real: IDBFactory, failures: number): IDBFactory & { opened: number } {
    let left = failures;
    const factory = {
        opened: 0,
        open(name: string, version?: number) {
            factory.opened += 1;
            if (left > 0) {
                left -= 1;
                const failing: { error: DOMException; onerror?: () => void } = {
                    error: new DOMException('Internal error opening backing store', 'UnknownError'),
                };
                setTimeout(() => failing.onerror?.());
                return failing;
            }
            return real.open(name, version);
        },
    };
    return factory as unknown as IDBFactory & { opened: number };
}

function overwrite(indexedDB: IDBFactory, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
        const opening = indexedDB.open('palmtop-identity', 1);
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
            const transaction = opening.result.transaction('keys', 'readwrite');
            transaction.objectStore('keys').put(value, 'device');
            transaction.oncomplete = () => {
                opening.result.close();
                resolve();
            };
            transaction.onerror = () => reject(transaction.error);
        };
    });
}

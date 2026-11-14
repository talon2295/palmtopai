import type { KeyValueStore } from '../src/lib/storage';

export class MemoryStore implements KeyValueStore {
    readonly data = new Map<string, string>();
    getItem(key: string) {
        return this.data.get(key) ?? null;
    }
    setItem(key: string, value: string) {
        this.data.set(key, value);
    }
    removeItem(key: string) {
        this.data.delete(key);
    }
}

export class ThrowingStore implements KeyValueStore {
    getItem(): string | null {
        throw new Error('SecurityError');
    }
    setItem(): void {
        throw new Error('QuotaExceededError');
    }
    removeItem(): void {
        throw new Error('SecurityError');
    }
}

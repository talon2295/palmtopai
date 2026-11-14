import { generateSecret } from './secrets';

export const PAIRING_CODE_TTL_MS = 60_000;
/** A QR code or pairing link stays usable this long; the terminal revokes its key on exit. */
export const PAIR_KEY_TTL_MS = 300_000;

/**
 * Short-lived, single-use codes that unlock the pairing page in the local browser. The code is
 * not a pairing key: whoever reads it (e.g. from a process list) gets one look at the QR within
 * the TTL, and only on the loopback-only Local API.
 */
export class PairingCodes {
    /** Code → expiry. */
    readonly #codes = new Map<string, number>();
    readonly #ttlMs: number;
    readonly #now: () => number;

    constructor(options: { ttlMs?: number; now?: () => number } = {}) {
        this.#ttlMs = options.ttlMs ?? PAIRING_CODE_TTL_MS;
        this.#now = options.now ?? Date.now;
    }

    create(): { code: string; expiresAt: number } {
        this.#prune();
        const code = generateSecret(24);
        const expiresAt = this.#now() + this.#ttlMs;
        this.#codes.set(code, expiresAt);
        return { code, expiresAt };
    }

    /** True for a valid code, which is invalidated; false if unknown, used or expired. */
    consume(code: string): boolean {
        const expiresAt = this.#codes.get(code);
        if (expiresAt === undefined) return false;
        this.#codes.delete(code);
        return expiresAt > this.#now();
    }

    #prune(): void {
        const now = this.#now();
        for (const [code, expiresAt] of this.#codes) {
            if (expiresAt <= now) this.#codes.delete(code);
        }
    }
}

/** What a pairing key is for: a QR code or link (`qr`), or a pairing code typed by the user. */
export interface PairKeyEntry {
    expiresAt: number;
    /**
     * Pairing by code: the key went through the relay, so the user compares the 6-digit number on
     * the computer before the device is registered (`PairingConfirmations`).
     */
    confirm: boolean;
}

/**
 * Single-use keys of QR codes, pairing links and pairing codes. A device proves it holds one
 * during the end-to-end pairing (an HMAC, `e2e.ts`): the key itself never travels. Whoever reads
 * one from a screen, a screenshot or a terminal scrollback holds something that works once and
 * expires.
 */
export class PairKeys {
    readonly #keys = new Map<string, PairKeyEntry>();
    readonly #ttlMs: number;
    readonly #now: () => number;

    constructor(options: { ttlMs?: number; now?: () => number } = {}) {
        this.#ttlMs = options.ttlMs ?? PAIR_KEY_TTL_MS;
        this.#now = options.now ?? Date.now;
    }

    /**
     * A fresh 128-bit key: it is scanned, copied or sent, never typed, so it is not guessable.
     * `ttlMs` overrides the lifetime of this one key (an invitation lasts a day, a QR minutes).
     */
    create(options: { confirm?: boolean; ttlMs?: number } = {}): {
        key: string;
        expiresAt: number;
    } {
        this.#prune();
        const key = generateSecret(16);
        const expiresAt = this.#now() + (options.ttlMs ?? this.#ttlMs);
        this.#keys.set(key, { expiresAt, confirm: options.confirm ?? false });
        return { key, expiresAt };
    }

    /** Puts back a key that was kept across a restart; an expired one is not put back. */
    restore(key: string, expiresAt: number): boolean {
        if (expiresAt <= this.#now()) return false;
        this.#keys.set(key, { expiresAt, confirm: false });
        return true;
    }

    /** Keys still valid: the candidates a pairing device may have proved. */
    valid(): string[] {
        this.#prune();
        return [...this.#keys.keys()];
    }

    /** Consumes a key: its entry if it was valid, `null` if unknown, used or expired. */
    take(key: string): PairKeyEntry | null {
        const entry = this.#keys.get(key);
        if (!entry) return null;
        this.#keys.delete(key);
        return entry.expiresAt > this.#now() ? entry : null;
    }

    /** Invalidates a key that was shown but not used (the user closed the QR). */
    revoke(key: string): void {
        this.#keys.delete(key);
    }

    #prune(): void {
        const now = this.#now();
        for (const [key, entry] of this.#keys) {
            if (entry.expiresAt <= now) this.#keys.delete(key);
        }
    }
}

/** A pairing by code, as `palmtop pair CODE` follows it. */
export interface PairingConfirmation {
    id: string;
    /**
     * `waiting` for the device, `ready` (the device paired: compare the number), then `accepted`,
     * `refused` (by the user, or the device went away) or `expired`.
     */
    state: 'waiting' | 'ready' | 'accepted' | 'refused' | 'expired';
    number?: string;
    deviceName?: string;
}

interface PendingConfirmation extends PairingConfirmation {
    key: string;
    expiresAt: number;
    decide?: (accepted: boolean) => void;
}

/**
 * Pairing by code: the key went to the phone through the relay, so the relay could pair in its
 * place or sit in the middle. The device is registered only after the user, at the terminal,
 * sees the same 6-digit number as on the device (`palmtop pair CODE`).
 */
export class PairingConfirmations {
    readonly #byId = new Map<string, PendingConfirmation>();
    readonly #ttlMs: number;
    readonly #now: () => number;

    constructor(options: { ttlMs?: number; now?: () => number } = {}) {
        this.#ttlMs = options.ttlMs ?? PAIR_KEY_TTL_MS;
        this.#now = options.now ?? Date.now;
    }

    /** Starts following the pairing that will use `key`. */
    create(key: string): PairingConfirmation {
        this.#prune();
        const pending: PendingConfirmation = {
            id: generateSecret(12),
            key,
            state: 'waiting',
            expiresAt: this.#now() + this.#ttlMs,
        };
        this.#byId.set(pending.id, pending);
        return view(pending);
    }

    get(id: string): PairingConfirmation | null {
        this.#prune();
        const pending = this.#byId.get(id);
        return pending ? view(pending) : null;
    }

    /**
     * The device holding `key` paired and shows `number`: resolves with the user's answer, or
     * `false` once the pairing expires. `null` if the key is not followed here.
     */
    ready(key: string, found: { number: string; deviceName: string }): Promise<boolean> | null {
        const pending = [...this.#byId.values()].find((entry) => entry.key === key);
        if (pending?.state !== 'waiting') return null;
        pending.state = 'ready';
        pending.number = found.number;
        pending.deviceName = found.deviceName;
        return new Promise((resolve) => {
            const timer = setTimeout(
                () => settle(false, 'expired'),
                Math.max(0, pending.expiresAt - this.#now()),
            );
            const settle = (accepted: boolean, state: PendingConfirmation['state']) => {
                clearTimeout(timer);
                delete pending.decide;
                pending.state = state;
                resolve(accepted);
            };
            pending.decide = (accepted) => settle(accepted, accepted ? 'accepted' : 'refused');
        });
    }

    /** The user's answer at the terminal. False if there was nothing to decide. */
    decide(id: string, accepted: boolean): boolean {
        const pending = this.#byId.get(id);
        if (!pending?.decide) return false;
        pending.decide(accepted);
        return true;
    }

    /** The device went away before the answer: nothing will be registered. */
    abandon(key: string): void {
        const pending = [...this.#byId.values()].find((entry) => entry.key === key);
        pending?.decide?.(false);
    }

    #prune(): void {
        const now = this.#now();
        for (const [id, pending] of this.#byId) {
            // Kept a while after the end, so the terminal can read how it ended.
            if (pending.expiresAt + this.#ttlMs <= now) this.#byId.delete(id);
            else if (pending.state === 'waiting' && pending.expiresAt <= now) {
                pending.state = 'expired';
            }
        }
    }
}

function view(pending: PendingConfirmation): PairingConfirmation {
    return {
        id: pending.id,
        state: pending.state,
        ...(pending.number !== undefined && { number: pending.number }),
        ...(pending.deviceName !== undefined && { deviceName: pending.deviceName }),
    };
}

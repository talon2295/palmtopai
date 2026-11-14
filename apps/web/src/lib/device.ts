import { browserStore, type KeyValueStore } from './storage';

const DEVICE_KEY = 'palmtop.deviceId';
const STATS_KEY = 'palmtop.statsId';
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DEVICE_ID_PATTERN = /^web-[a-z0-9]{16}$/;
const STATS_ID_PATTERN = /^[a-z0-9]{16}$/;

/**
 * Random suffix without `crypto.randomUUID`, which only exists in secure contexts (the app is
 * served over plain http on the LAN). `getRandomValues` works everywhere.
 */
function randomSuffix(length: number): string {
    const bytes = new Uint8Array(length);
    if (globalThis.crypto?.getRandomValues) {
        globalThis.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (byte) => ALPHABET[byte % ALPHABET.length]).join('');
}

function storedId(
    store: KeyValueStore | null,
    key: string,
    pattern: RegExp,
    create: () => string,
): string {
    try {
        const existing = store?.getItem(key);
        if (existing && pattern.test(existing)) return existing;
    } catch {
        // Fall through and generate a new id.
    }
    const id = create();
    try {
        store?.setItem(key, id);
    } catch {
        // Not persisted: this tab keeps the id for its lifetime.
    }
    return id;
}

/** Stable id of this browser, used as the Lamport clock device id. */
export function getDeviceId(store: KeyValueStore | null = browserStore()): string {
    return storedId(store, DEVICE_KEY, DEVICE_ID_PATTERN, () => `web-${randomSuffix(16)}`);
}

/**
 * Anonymous random id sent to the relay for statistic purposes only (distinct devices). Separate
 * from the device id, which the daemon sees: the two cannot be linked.
 */
export function getStatsId(store: KeyValueStore | null = browserStore()): string {
    return storedId(store, STATS_KEY, STATS_ID_PATTERN, () => randomSuffix(16));
}

/**
 * The name this device gives itself when it pairs, from the browser ("iPhone · Safari"): shown by
 * `palmtop devices` and next to the pairing number, to tell devices apart. Nothing more precise
 * than the kind of device and the browser.
 */
export function deviceName(
    userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
    touchPoints: number = typeof navigator === 'undefined' ? 0 : navigator.maxTouchPoints,
): string {
    const kind = /iPhone/.test(userAgent)
        ? 'iPhone'
        : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && touchPoints > 1)
          ? 'iPad'
          : /Android/.test(userAgent)
            ? 'Android'
            : /Macintosh|Mac OS X/.test(userAgent)
              ? 'Mac'
              : /Windows/.test(userAgent)
                ? 'Windows'
                : /Linux|X11|CrOS/.test(userAgent)
                  ? 'Linux'
                  : 'Device';
    const browser = /Edg\//.test(userAgent)
        ? 'Edge'
        : /Firefox\/|FxiOS/.test(userAgent)
          ? 'Firefox'
          : /Chrome\/|CriOS/.test(userAgent)
            ? 'Chrome'
            : /Safari\//.test(userAgent)
              ? 'Safari'
              : 'Browser';
    return `${kind} · ${browser}`;
}

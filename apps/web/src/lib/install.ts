import { RELAY_WAIT_PATH } from '@palmtopai/protocol';
import { z } from 'zod';
import { browserStore, type KeyValueStore, readJson, writeJson } from './storage';

/**
 * True in the app added to the Home Screen (or installed from the browser). It has storage of
 * its own on iPhone, so it can't use a pairing made in the browser: it pairs with a code.
 */
export function isInstalled(win: Window = window): boolean {
    const standalone = win.matchMedia?.('(display-mode: standalone)').matches ?? false;
    return standalone || (win.navigator as { standalone?: boolean }).standalone === true;
}

export type DevicePlatform = 'ios' | 'android' | 'other';

/** `ios`: iPhone and iPad (also iPadOS, which says it is a Mac). */
export function devicePlatform(win: Window = window): DevicePlatform {
    const nav = win.navigator;
    if (
        /iPhone|iPad|iPod/.test(nav.userAgent) ||
        (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
    ) {
        return 'ios';
    }
    return /Android/.test(nav.userAgent) ? 'android' : 'other';
}

/** The relay's waiting room, on the host that served the app. */
export function waitSocketUrl(location: Pick<Location, 'protocol' | 'host'>): string {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    return `${scheme}://${location.host}${RELAY_WAIT_PATH}`;
}

// -- invitation to install ---------------------------------------------------------------------

const INSTALL_PROMPT_KEY = 'palmtop.installPrompt.v1';
/** The first time: this long after the first pairing, once the user has seen the app work. */
export const FIRST_INSTALL_PROMPT_MS = 2 * 60_000;
/** After "Close": this long after every opening. */
export const INSTALL_PROMPT_MS = 30_000;

const installPromptSchema = z.object({
    /** First time this browser was seen with a pairing. */
    pairedAt: z.number().int().nonnegative(),
    /** "Don't show again". */
    never: z.boolean(),
});
export type InstallPromptState = z.infer<typeof installPromptSchema>;

export function loadInstallPrompt(
    store: KeyValueStore | null = browserStore(),
): InstallPromptState | null {
    const parsed = installPromptSchema.safeParse(readJson(store, INSTALL_PROMPT_KEY));
    return parsed.success ? parsed.data : null;
}

export function saveInstallPrompt(
    state: InstallPromptState,
    store: KeyValueStore | null = browserStore(),
) {
    writeJson(store, INSTALL_PROMPT_KEY, state);
}

/**
 * Milliseconds before the invitation shows on this opening, or null when it doesn't: only in the
 * browser of a phone or tablet with a pairing, until "Don't show again". The first time comes two
 * minutes after the first pairing; later openings (after "Close") show it after 30 seconds.
 */
export function installPromptDelay(options: {
    installed: boolean;
    platform: DevicePlatform;
    paired: boolean;
    state: InstallPromptState | null;
    now: number;
}): number | null {
    const { installed, platform, paired, state, now } = options;
    if (installed || platform === 'other' || !paired || state?.never) return null;
    const pairedAt = state?.pairedAt ?? now;
    return Math.max(pairedAt + FIRST_INSTALL_PROMPT_MS - now, INSTALL_PROMPT_MS);
}

/** Chrome's install prompt (`beforeinstallprompt`), not in the DOM typings. */
export interface DeferredInstallPrompt extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: DeferredInstallPrompt | null = null;
const promptListeners = new Set<() => void>();

/**
 * Keeps Chrome's install prompt for the "Install" button (Android): the event fires early, before
 * the app renders, and only once per page load. Safari never sends it.
 */
export function captureInstallPrompt(win: Window = window) {
    win.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        deferredPrompt = event as DeferredInstallPrompt;
        for (const listener of promptListeners) listener();
    });
    win.addEventListener('appinstalled', () => {
        deferredPrompt = null;
        for (const listener of promptListeners) listener();
    });
}

export function installPromptEvent(): DeferredInstallPrompt | null {
    return deferredPrompt;
}

export function onInstallPromptChange(listener: () => void): () => void {
    promptListeners.add(listener);
    return () => promptListeners.delete(listener);
}

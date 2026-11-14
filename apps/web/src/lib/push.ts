import { idSchema, type PushRegistration, pushRegistrationSchema } from '@palmtopai/protocol';
import { z } from 'zod';
import { browserStore, type KeyValueStore, readJson, writeJson } from './storage';

const PUSH_KEY = 'palmtop.push.v1';
export const SERVICE_WORKER_URL = '/sw.js';

const settingsSchema = z.object({
    enabled: z.boolean(),
    vapid: pushRegistrationSchema.shape.vapid,
});

export type PushSettings = z.infer<typeof settingsSchema>;

/** `needs-home-screen`: iPhone and iPad only allow notifications to apps on the Home Screen. */
export type PushSupport = 'supported' | 'needs-home-screen' | 'unsupported';

export function pushSupport(win: Window = window): PushSupport {
    const nav = win.navigator;
    if (
        win.isSecureContext &&
        'serviceWorker' in nav &&
        'PushManager' in win &&
        'Notification' in win
    ) {
        return 'supported';
    }
    const ios =
        /iPhone|iPad|iPod/.test(nav.userAgent) ||
        (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1);
    return ios ? 'needs-home-screen' : 'unsupported';
}

export function loadPushSettings(
    store: KeyValueStore | null = browserStore(),
): PushSettings | null {
    const parsed = settingsSchema.safeParse(readJson(store, PUSH_KEY));
    return parsed.success ? parsed.data : null;
}

export function savePushSettings(
    settings: PushSettings,
    store: KeyValueStore | null = browserStore(),
) {
    writeJson(store, PUSH_KEY, settings);
}

function base64url(bytes: ArrayBuffer | Uint8Array): string {
    let binary = '';
    for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
    const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * VAPID keys of this device (ECDSA P-256): the public key goes to the browser's push service,
 * the pair to every paired computer, which signs its notifications with it.
 */
export async function generateVapidKeys(
    subtle: SubtleCrypto = crypto.subtle,
): Promise<PushSettings['vapid']> {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const publicKey = base64url(await subtle.exportKey('raw', pair.publicKey));
    const { d } = await subtle.exportKey('jwk', pair.privateKey);
    if (!d) throw new Error('could not export the notification key');
    return { publicKey, privateKey: d };
}

function toRegistration(
    subscription: PushSubscription,
    vapid: PushSettings['vapid'],
): PushRegistration {
    return pushRegistrationSchema.parse({ subscription: subscription.toJSON(), vapid });
}

async function registration(): Promise<ServiceWorkerRegistration> {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: '/' });
    return navigator.serviceWorker.ready;
}

/** Asks for the permission and subscribes this device. Must run from a tap. */
export async function enablePush(
    store: KeyValueStore | null = browserStore(),
): Promise<PushRegistration> {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error(
            permission === 'denied'
                ? 'Notifications are blocked for this site: allow them in the browser settings.'
                : 'Notifications were not allowed.',
        );
    }
    const vapid = loadPushSettings(store)?.vapid ?? (await generateVapidKeys());
    const manager = (await registration()).pushManager;
    let subscription = await manager.getSubscription();
    const key = subscription?.options.applicationServerKey;
    if (subscription && (!key || base64url(key) !== vapid.publicKey)) {
        await subscription.unsubscribe();
        subscription = null;
    }
    subscription ??= await manager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: fromBase64url(vapid.publicKey),
    });
    savePushSettings({ enabled: true, vapid }, store);
    return toRegistration(subscription, vapid);
}

/** What `currentPush` needs from the browser (tests pass their own). */
export interface PushEnvironment {
    supported(): boolean;
    permission(): NotificationPermission;
    manager(): Promise<Pick<PushManager, 'getSubscription' | 'subscribe'>>;
}

const browserPush: PushEnvironment = {
    supported: () => pushSupport() === 'supported',
    permission: () => Notification.permission,
    manager: async () => (await registration()).pushManager,
};

/**
 * The current registration when notifications are on; `null` when off or no longer allowed.
 * Notifications that are on and allowed but have no subscription lost it (the browser deleted
 * this app's data, or the push service ended it): this device subscribes again, with the same
 * keys, and the computers get the new one. No tap is needed while the permission is granted.
 */
export async function currentPush(
    store: KeyValueStore | null = browserStore(),
    environment: PushEnvironment = browserPush,
): Promise<PushRegistration | null> {
    const settings = loadPushSettings(store);
    if (!settings?.enabled || !environment.supported() || environment.permission() !== 'granted') {
        return null;
    }
    const manager = await environment.manager();
    let subscription = await manager.getSubscription();
    if (!subscription) {
        try {
            subscription = await manager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: fromBase64url(settings.vapid.publicKey),
            });
        } catch {
            // Refused without a tap (some browsers): off, as before; the bell turns it on.
            return null;
        }
    }
    return toRegistration(subscription, settings.vapid);
}

export async function disablePush(store: KeyValueStore | null = browserStore()): Promise<void> {
    const settings = loadPushSettings(store);
    if (settings) savePushSettings({ ...settings, enabled: false }, store);
    if (pushSupport() !== 'supported') return;
    const existing = await navigator.serviceWorker.getRegistration('/');
    await (await existing?.pushManager.getSubscription())?.unsubscribe();
}

/** `#open?p=<projectId>`: a tapped notification opens the app on its project. */
export function consumeOpenLink(
    location: Pick<Location, 'hash' | 'pathname' | 'search'>,
    history: Pick<History, 'replaceState'>,
): string | null {
    if (!location.hash.startsWith('#open')) return null;
    const projectId = new URLSearchParams(
        location.hash.slice('#open'.length).replace(/^\?/, ''),
    ).get('p');
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    return projectId && idSchema.safeParse(projectId).success ? projectId : null;
}

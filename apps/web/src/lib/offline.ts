import { SERVICE_WORKER_URL } from './push';

/**
 * Lets the app open without a connection: the service worker keeps a copy of it, and the
 * browser is asked to keep this site's storage (the checklists in IndexedDB). Without the
 * request, Safari in a browser tab may clear both after 7 days without a visit; the app added
 * to the Home Screen is not affected. The browser decides: some grant it silently, Firefox asks.
 */
export async function enableOffline(
    win: Pick<Window, 'isSecureContext' | 'navigator'>,
    { paired }: { paired: boolean },
): Promise<void> {
    if (!win.isSecureContext) return;
    const { serviceWorker, storage } = win.navigator;
    try {
        await serviceWorker?.register(SERVICE_WORKER_URL, { scope: '/' });
    } catch {
        // Not supported or blocked: the app works online only, as before.
    }
    // Only once there is something to keep: no permission prompt on the empty first page.
    if (!paired || !storage?.persist) return;
    try {
        if (!(await storage.persisted())) await storage.persist();
    } catch {
        // Best effort.
    }
}

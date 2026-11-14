/**
 * Manifest and service worker need a secure context (https or localhost). On plain http over
 * the LAN they are skipped: the app still works as a normal web page (see PLAN §10 for HTTPS).
 */
export function enableSecureContextFeatures(win: Window): { manifest: boolean } {
    if (!win.isSecureContext) return { manifest: false };
    const doc = win.document;
    if (!doc.querySelector('link[rel="manifest"]')) {
        const link = doc.createElement('link');
        link.rel = 'manifest';
        link.href = '/manifest.webmanifest';
        doc.head.appendChild(link);
    }
    return { manifest: true };
}

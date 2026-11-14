import { useEffect, useState } from 'react';

/** Checked at most this often: when the app opens and when it comes back on screen. */
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * The script of a build of the app, by the hash in its name (`/assets/app-<hash>.js`): another
 * one on the server means a new version. `null` where there is none (the dev server).
 */
export function appScriptOf(html: string): string | null {
    for (const tag of html.matchAll(/<script\b[^>]*>/g)) {
        const src = /\ssrc="(\/assets\/[^"]+\.js)"/.exec(tag[0])?.[1];
        if (src && /\stype="module"/.test(tag[0])) return src;
    }
    return null;
}

/** The script this page runs, as `appScriptOf` reads it from the HTML. */
export function runningAppScript(
    doc: Document | undefined = typeof document === 'undefined' ? undefined : document,
): string | null {
    if (!doc) return null;
    for (const script of doc.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')) {
        const path = new URL(script.getAttribute('src') ?? '', 'https://app.invalid/').pathname;
        if (path.startsWith('/assets/') && path.endsWith('.js')) return path;
    }
    return null;
}

/**
 * True when the server has another version of the app than the one running. Asked past every
 * cache: an app on the Home Screen of an iPhone can stay open for days without reloading.
 */
export async function isUpdateAvailable(
    running: string,
    fetcher: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
        fetch(url, init),
): Promise<boolean> {
    try {
        const response = await fetcher('/', { cache: 'no-store' });
        if (!response.ok) return false;
        const served = appScriptOf(await response.text());
        return served !== null && served !== running;
    } catch {
        // Offline: nothing to say.
        return false;
    }
}

/**
 * Whether a new version of the app is on the server, checked when the app opens and when it
 * comes back on screen (at most every `UPDATE_CHECK_INTERVAL_MS`). Reloading takes it: the page
 * is always asked to the network first.
 */
export function useAppUpdate(): { available: boolean; update: () => void } {
    const [available, setAvailable] = useState(false);
    useEffect(() => {
        const running = runningAppScript();
        if (!running) return;
        let cancelled = false;
        let checkedAt = 0;
        const check = () => {
            if (Date.now() - checkedAt < UPDATE_CHECK_INTERVAL_MS) return;
            checkedAt = Date.now();
            void isUpdateAvailable(running).then((found) => {
                if (!cancelled && found) setAvailable(true);
            });
        };
        check();
        const visible = () => {
            if (document.visibilityState === 'visible') check();
        };
        document.addEventListener('visibilitychange', visible);
        return () => {
            cancelled = true;
            document.removeEventListener('visibilitychange', visible);
        };
    }, []);
    return { available, update: () => window.location.reload() };
}

/**
 * What runs here, for the foot of the app: the version of palmtop it was released with and the
 * build (the hash in the name of its script). `dev` outside a build.
 */
export function appVersion(
    script: string | null = runningAppScript(),
    version: string | undefined = import.meta.env.PALMTOP_VERSION,
): string {
    const build = script ? /-([A-Za-z0-9_-]+)\.js$/.exec(script)?.[1] : undefined;
    if (!version) return 'dev';
    return build ? `palmtop ${version} · ${build}` : `palmtop ${version}`;
}

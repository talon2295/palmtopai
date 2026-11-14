// PalmtopAI service worker:
// - keeps a copy of the app, so it opens without a connection (the checklists come from the
//   device cache in IndexedDB, see packages/client/src/client-cache.ts);
// - shows the notifications sent by the computers paired with this device and opens the app on
//   the project when one is tapped.
//
// The page is always asked to the network first: online, a new version of the app is used at
// once and a broken copy can never stick. Only when the network fails is the copy used. Files
// under /assets/ have a hash in their name and never change: they are served from the copy.

const CACHE_PREFIX = 'palmtop-app-';
const CACHE = `${CACHE_PREFIX}v1`;
const APP_URL = '/';
/** Loaded by the app but not referenced by its HTML. */
const EXTRA_URLS = ['/manifest.webmanifest'];

/** Same-origin files referenced by the HTML of the app (scripts, styles, icons). */
function assetsOf(html) {
    const urls = new Set(EXTRA_URLS);
    for (const match of html.matchAll(/\s(?:src|href)="(\/[^"/][^"]*)"/g)) {
        urls.add(match[1]);
    }
    return [...urls];
}

/** Stores the page and what it needs, then drops the files of older versions. */
async function keep(page) {
    const cache = await caches.open(CACHE);
    const html = await page.clone().text();
    const wanted = assetsOf(html);
    for (const url of wanted) {
        if (await cache.match(url)) continue;
        try {
            const response = await fetch(url);
            if (response.ok) await cache.put(url, response);
        } catch {
            // Offline or gone: tried again with the next version of the page.
        }
    }
    await cache.put(APP_URL, page);
    const keepPaths = new Set([APP_URL, ...wanted]);
    for (const request of await cache.keys()) {
        if (!keepPaths.has(new URL(request.url).pathname)) await cache.delete(request);
    }
}

async function precache() {
    try {
        const page = await fetch(APP_URL, { cache: 'no-cache' });
        if (page.ok) await keep(page);
    } catch {
        // Installed offline: the copy is made at the next visit online.
    }
}

async function fromNetworkFirst(event) {
    try {
        const response = await fetch(event.request);
        if (response.ok) event.waitUntil(keep(response.clone()));
        return response;
    } catch (error) {
        const cached = await caches.match(APP_URL);
        if (cached) return cached;
        throw error;
    }
}

async function fromCacheFirst(request) {
    const cached = await caches.match(request);
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
        const copy = response.clone();
        const cache = await caches.open(CACHE);
        await cache.put(request, copy);
    }
    return response;
}

async function fromNetworkThenCache(request) {
    try {
        return await fetch(request);
    } catch (error) {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw error;
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            for (const name of await caches.keys()) {
                if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
            }
            await self.clients.claim();
        })(),
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;
    if (request.mode === 'navigate') {
        if (url.pathname === APP_URL || url.pathname === `${APP_URL}index.html`) {
            event.respondWith(fromNetworkFirst(event));
        }
        return;
    }
    if (url.pathname.startsWith('/assets/')) {
        event.respondWith(fromCacheFirst(request));
    } else if (url.pathname === '/icon.svg' || EXTRA_URLS.includes(url.pathname)) {
        event.respondWith(fromNetworkThenCache(request));
    }
});

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = {};
    }
    const title = typeof data.title === 'string' ? data.title : 'PalmtopAI';
    const body = typeof data.body === 'string' ? data.body : 'Something new to review';
    event.waitUntil(
        self.registration.showNotification(title, {
            body,
            tag: typeof data.tag === 'string' ? data.tag : undefined,
            data: { projectId: typeof data.projectId === 'string' ? data.projectId : null },
        }),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const projectId = event.notification.data?.projectId;
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            // The whole origin is the app: any window of it will do.
            const app = windows[0];
            if (app) {
                await app.focus();
                if (projectId) app.postMessage({ type: 'palmtop.open', projectId });
                return;
            }
            const hash = projectId ? `#open?p=${encodeURIComponent(projectId)}` : '';
            await self.clients.openWindow(`${APP_URL}${hash}`);
        })(),
    );
});

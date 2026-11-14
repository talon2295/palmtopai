import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enableOffline } from '../src/lib/offline';

const ORIGIN = 'https://app.relay.example';
const SOURCE = readFileSync(join(import.meta.dir, '..', 'public', 'sw.js'), 'utf8');

const href = (input: string | Request) =>
    new URL(typeof input === 'string' ? input : input.url, ORIGIN).href;

class FakeCache {
    readonly entries = new Map<string, Response>();
    async match(input: string | Request) {
        return this.entries.get(href(input))?.clone();
    }
    async put(input: string | Request, response: Response) {
        this.entries.set(href(input), response);
    }
    async keys() {
        return [...this.entries.keys()].map((url) => new Request(url));
    }
    async delete(input: string | Request) {
        return this.entries.delete(href(input));
    }
}

class FakeCaches {
    readonly named = new Map<string, FakeCache>();
    async open(name: string) {
        let cache = this.named.get(name);
        if (!cache) {
            cache = new FakeCache();
            this.named.set(name, cache);
        }
        return cache;
    }
    async keys() {
        return [...this.named.keys()];
    }
    async delete(name: string) {
        return this.named.delete(name);
    }
    async match(input: string | Request) {
        for (const cache of this.named.values()) {
            const found = await cache.match(input);
            if (found) return found;
        }
        return undefined;
    }
    paths() {
        return [...this.named.values()].flatMap((cache) =>
            [...cache.entries.keys()].map((url) => new URL(url).pathname),
        );
    }
}

const page = (script: string) =>
    `<!doctype html><html><head><link rel="icon" href="/icon.svg" type="image/svg+xml" />
<script type="module" crossorigin src="/assets/${script}.js"></script>
<link rel="stylesheet" crossorigin href="/assets/${script}.css"></head>
<body><a href="https://elsewhere.example/x">x</a></body></html>`;

/** Loads sw.js in a fake worker scope: a server with `files`, `online` switchable. */
function worker() {
    const files = new Map<string, string>([
        ['/', page('app-1')],
        ['/assets/app-1.js', 'js 1'],
        ['/assets/app-1.css', 'css 1'],
        ['/icon.svg', '<svg/>'],
        ['/manifest.webmanifest', '{}'],
    ]);
    const net = { online: true, requests: [] as string[] };
    const fetchImpl = async (input: string | Request) => {
        const url = new URL(href(input));
        net.requests.push(url.pathname);
        if (!net.online) throw new TypeError('Failed to fetch');
        const body = files.get(url.pathname);
        return body === undefined
            ? new Response('not found', { status: 404 })
            : new Response(body, { status: 200 });
    };
    const caches = new FakeCaches();
    const listeners = new Map<string, (event: unknown) => void>();
    const scope = {
        location: new URL(`${ORIGIN}/sw.js`),
        addEventListener: (type: string, listener: (event: unknown) => void) =>
            listeners.set(type, listener),
        skipWaiting: mock(async () => {}),
        clients: { claim: mock(async () => {}) },
    };
    new Function('self', 'caches', 'fetch', SOURCE)(scope, caches, fetchImpl);

    async function dispatch(type: string, extra: object = {}) {
        const waits: Promise<unknown>[] = [];
        let responded: Promise<Response> | undefined;
        listeners.get(type)?.({
            ...extra,
            waitUntil: (promise: Promise<unknown>) => waits.push(promise),
            respondWith: (promise: Promise<Response>) => {
                responded = promise;
            },
        });
        const response = responded ? await responded : undefined;
        await Promise.all(waits);
        return response;
    }

    return {
        files,
        net,
        caches,
        scope,
        install: () => dispatch('install'),
        activate: () => dispatch('activate'),
        /** `undefined` when the worker leaves the request to the browser. */
        request: (path: string, init: { mode?: 'navigate'; method?: string } = {}) =>
            dispatch('fetch', {
                request: {
                    url: new URL(path, ORIGIN).href,
                    method: init.method ?? 'GET',
                    mode: init.mode ?? 'cors',
                },
            }),
    };
}

describe('service worker', () => {
    test('install keeps the app and what its page loads; offline it opens from the copy', async () => {
        const sw = worker();
        await sw.install();
        expect(sw.caches.paths().sort()).toEqual(
            [
                '/',
                '/assets/app-1.css',
                '/assets/app-1.js',
                '/icon.svg',
                '/manifest.webmanifest',
            ].sort(),
        );
        expect(sw.scope.skipWaiting).toHaveBeenCalled();

        sw.net.online = false;
        expect(await (await sw.request('/', { mode: 'navigate' }))?.text()).toBe(page('app-1'));
        expect(await (await sw.request('/assets/app-1.js'))?.text()).toBe('js 1');
        expect(await (await sw.request('/icon.svg'))?.text()).toBe('<svg/>');
    });

    test('online the page comes from the network, and a new version replaces the old files', async () => {
        const sw = worker();
        await sw.install();
        sw.files.set('/', page('app-2'));
        sw.files.set('/assets/app-2.js', 'js 2');
        sw.files.set('/assets/app-2.css', 'css 2');

        const fresh = await sw.request('/', { mode: 'navigate' });
        expect(await fresh?.text()).toBe(page('app-2'));
        expect(sw.caches.paths()).toContain('/assets/app-2.js');
        expect(sw.caches.paths()).not.toContain('/assets/app-1.js');

        sw.net.online = false;
        expect(await (await sw.request('/', { mode: 'navigate' }))?.text()).toBe(page('app-2'));
    });

    test('hashed assets come from the copy without asking the network', async () => {
        const sw = worker();
        await sw.install();
        sw.net.requests.length = 0;
        expect(await (await sw.request('/assets/app-1.css'))?.text()).toBe('css 1');
        expect(sw.net.requests).toEqual([]);
    });

    test('a page that fails online is not kept', async () => {
        const sw = worker();
        await sw.install();
        sw.files.delete('/');
        expect((await sw.request('/', { mode: 'navigate' }))?.status).toBe(404);
        sw.net.online = false;
        expect(await (await sw.request('/', { mode: 'navigate' }))?.text()).toBe(page('app-1'));
    });

    test('offline with no copy the browser shows its own error', async () => {
        const sw = worker();
        sw.net.online = false;
        await sw.install();
        expect(sw.caches.paths()).toEqual([]);
        await expect(sw.request('/', { mode: 'navigate' })).rejects.toThrow('Failed to fetch');
    });

    test('other pages, the relay endpoints and other origins are left to the browser', async () => {
        const sw = worker();
        await sw.install();
        expect(await sw.request('/some/route', { mode: 'navigate' })).toBeUndefined();
        expect(await sw.request('/version.json')).toBeUndefined();
        expect(await sw.request('/assets/app-1.js', { method: 'POST' })).toBeUndefined();
        expect(await sw.request('https://elsewhere.example/assets/x.js')).toBeUndefined();
    });

    test('activate drops the copies of older workers only', async () => {
        const sw = worker();
        await sw.caches.open('palmtop-app-v0');
        await sw.caches.open('something-else');
        await sw.install();
        await sw.activate();
        expect((await sw.caches.keys()).sort()).toEqual(['palmtop-app-v1', 'something-else']);
        expect(sw.scope.clients.claim).toHaveBeenCalled();
    });
});

describe('enableOffline', () => {
    let register: ReturnType<typeof mock>;
    let persist: ReturnType<typeof mock>;
    let persisted: boolean;

    beforeEach(() => {
        register = mock(async () => ({}));
        persist = mock(async () => true);
        persisted = false;
    });

    const win = (isSecureContext = true) =>
        ({
            isSecureContext,
            navigator: {
                serviceWorker: { register },
                storage: { persist, persisted: async () => persisted },
            },
        }) as unknown as Window;

    test('registers the worker and asks to keep the storage once a computer is paired', async () => {
        await enableOffline(win(), { paired: false });
        expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
        expect(persist).not.toHaveBeenCalled();

        await enableOffline(win(), { paired: true });
        expect(persist).toHaveBeenCalledTimes(1);
        persisted = true;
        await enableOffline(win(), { paired: true });
        expect(persist).toHaveBeenCalledTimes(1);
    });

    test('does nothing outside a secure context and never throws', async () => {
        await enableOffline(win(false), { paired: true });
        expect(register).not.toHaveBeenCalled();

        register = mock(async () => {
            throw new Error('blocked');
        });
        persist = mock(async () => {
            throw new Error('nope');
        });
        await enableOffline(win(), { paired: true });
        expect(persist).toHaveBeenCalled();
    });
});

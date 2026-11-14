import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.map': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.md': 'text/markdown; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    // `install.sh`: readable in a browser, and `curl | bash` doesn't look at the type.
    '.sh': 'text/plain; charset=utf-8',
    // `install.ps1`: the same, and `irm | iex` takes the text whatever the type.
    '.ps1': 'text/plain; charset=utf-8',
};

export const SECURITY_HEADERS = {
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>PalmtopAI</title>
<p>PalmtopAI relay is running. The web app has not been built yet.</p>`;

/** The app has its own origin: the name of the site with this in front (`app.palmtop.mtwa.it`). */
const APP_HOST_PREFIX = 'app.';

/** Where the app used to be on the site; its links now go to the app's origin. */
const OLD_APP_PREFIX = '/app/';

/**
 * Served at the site's `/app/sw.js` in place of the worker the app had there: browsers that still
 * have it pick this one up at their next check, which drops the old offline copy and unregisters.
 */
const RETIRED_SERVICE_WORKER = `// The app moved to its own origin (app.<host>): nothing is kept here any more.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            for (const name of await caches.keys()) await caches.delete(name);
            await self.registration.unregister();
        })(),
    );
});
`;

/** Whether a request is for the app (`app.<host>`) rather than the site. */
export function isAppHost(hostname: string): boolean {
    return hostname.startsWith(APP_HOST_PREFIX);
}

/**
 * Serves the built web site and app (`apps/web/dist`), by host:
 * - `app.<host>`: the app from `dist/app`, at the root, with `index.html` for unknown paths;
 * - any other host: the site, with 404 for unknown paths. Its `/app` and `/app/…` redirect to the
 *   same path on `app.<host>` (the browser keeps the fragment, e.g. an old join link), except the
 *   app's old service worker, which is retired.
 */
export async function serveWebApp(url: URL, webRoot: string | undefined): Promise<Response> {
    const app = isAppHost(url.hostname);
    const root = webRoot && resolve(webRoot, app ? 'app' : '.');
    if (!root || !(await isFile(join(root, 'index.html')))) {
        return new Response(PLACEHOLDER, {
            headers: { 'content-type': CONTENT_TYPES['.html'] as string, ...SECURITY_HEADERS },
        });
    }
    const { pathname } = url;
    if (!app && pathname === `${OLD_APP_PREFIX}sw.js`) {
        return new Response(RETIRED_SERVICE_WORKER, {
            headers: {
                'content-type': CONTENT_TYPES['.js'] as string,
                'cache-control': 'no-cache',
                ...SECURITY_HEADERS,
            },
        });
    }
    if (!app && (pathname === OLD_APP_PREFIX.slice(0, -1) || pathname.startsWith(OLD_APP_PREFIX))) {
        // Same scheme, so a network-path reference: `//app.<host>/<rest>`.
        const rest = pathname.slice(OLD_APP_PREFIX.length - 1) || '/';
        return new Response(null, {
            status: 301,
            headers: { location: `//${APP_HOST_PREFIX}${url.host}${rest}${url.search}` },
        });
    }
    let decoded: string;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return new Response('bad request', { status: 400 });
    }
    const candidate = resolve(root, `.${normalize(`/${decoded}`)}`);
    const insideRoot = candidate === root || candidate.startsWith(`${root}${sep}`);
    // The site never serves the app's files, however the path is written.
    const appDir = join(root, 'app');
    const inApp = !app && (candidate === appDir || candidate.startsWith(`${appDir}${sep}`));
    const directoryIndex = join(candidate, 'index.html');
    let file: string | null = null;
    if (insideRoot && !inApp && (await isFile(candidate))) file = candidate;
    else if (insideRoot && !inApp && (await isFile(directoryIndex))) file = directoryIndex;
    else if (app) file = join(root, 'index.html');
    if (!file) {
        return new Response('not found', {
            status: 404,
            headers: { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS },
        });
    }
    // Vite fingerprints everything under /assets; index.html must always be revalidated.
    const immutable = file.startsWith(`${join(root, 'assets')}${sep}`);
    return new Response(Bun.file(file), {
        headers: {
            'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
            'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
            ...SECURITY_HEADERS,
        },
    });
}

async function isFile(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}

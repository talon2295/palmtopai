import { APP_URL } from './site';

/** Sections that left the landing page for the docs; older links (e.g. `install.md`) use them. */
const MOVED_SECTIONS: Record<string, string> = {
    '#install': '/docs/getting-started#install-by-hand',
    '#uninstall': '/docs/update-uninstall#uninstall',
};

/**
 * Where an old link to the landing page should go, or `null` to stay.
 * - Join links used to open the app at `/#join?…`: they now go to the app's address, where the
 *   app says to pair again. The fragment never reaches the server, and `location.replace`
 *   leaves no history entry.
 * - `/#install` and `/#uninstall` moved to the docs.
 */
export function landingRedirect(location: Pick<Location, 'hash' | 'pathname'>): string | null {
    if (location.pathname !== '/') return null;
    if (location.hash.startsWith('#join')) return `${APP_URL}${location.hash}`;
    return MOVED_SECTIONS[location.hash] ?? null;
}

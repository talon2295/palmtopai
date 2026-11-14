import { SITE_URL } from './site';

/** Social preview image (`public/og.png`, drawn from `og/og.svg`). */
export const OG_IMAGE = {
    url: `${SITE_URL}/og.png`,
    width: 1200,
    height: 630,
    alt: 'PalmtopAI, the missing checklist for AI coding: a checklist with a passed, a failed and a questioned check.',
};

/**
 * Canonical address of a page: always on SITE_URL (the relay also answers on other hosts) and
 * without the trailing slash, as the site links it (`/docs/cli`, not `/docs/cli/`).
 */
export function canonicalUrl(pathname: string): string {
    const path = pathname.replace(/\/(index\.html)?$/, '');
    return `${SITE_URL}${path || '/'}`;
}

/** `sitemap.xml` for the given page paths. */
export function sitemapXml(paths: string[]): string {
    const urls = paths.map((path) => `    <url><loc>${canonicalUrl(path)}</loc></url>`);
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        ...urls,
        '</urlset>',
        '',
    ].join('\n');
}

/** `robots.txt`: everything can be crawled; the app pages say `noindex` themselves. */
export function robotsTxt(): string {
    return `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`;
}

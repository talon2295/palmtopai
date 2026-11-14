import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import type { AstroIntegration } from 'astro';
import { defineConfig } from 'astro/config';
import { assertNoInlineScripts } from './build/inline-scripts';

const noInlineScripts: AstroIntegration = {
    name: 'palmtop:no-inline-scripts',
    hooks: {
        'astro:build:done': async ({ dir }) => assertNoInlineScripts(fileURLToPath(dir)),
    },
};

export default defineConfig({
    // Served by the relay: this site at `/`, the web app (`apps/web`, in `dist/app`) on its own
    // name, `app.<host>`. `bun run build:web` builds this site first (Astro empties the
    // directory), then the app. The site links to the app's address (`APP_URL`); its old `/app/`
    // redirects there.
    outDir: '../web/dist',
    // Compressing drops the spaces between inline elements ("item done, cancelled").
    compressHTML: false,
    build: {
        // Fingerprinted files go to /assets, cached as immutable by the relay.
        assets: 'assets',
        inlineStylesheets: 'never',
    },
    integrations: [noInlineScripts],
    vite: {
        plugins: [tailwindcss()],
        // Small scripts would be inlined into the page, and the relay's CSP blocks inline scripts.
        build: { assetsInlineLimit: 0 },
    },
});

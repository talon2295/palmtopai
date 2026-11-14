import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const relayPort = Number(process.env.PALMTOP_RELAY_PORT ?? 8787);
/** The version of palmtop this app is released with (the CLI's), shown at the foot of the app. */
const version = (
    JSON.parse(
        readFileSync(resolve(import.meta.dirname, '../../packages/cli/package.json'), 'utf8'),
    ) as { version: string }
).version;

export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: { 'import.meta.env.PALMTOP_VERSION': JSON.stringify(version) },
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
    server: {
        // `bun run dev:web` for UI work against `bun run dev:relay`; the relay serves the built app.
        proxy: {
            '/ws': { target: `ws://127.0.0.1:${relayPort}`, ws: true },
            '/feedback': { target: `http://127.0.0.1:${relayPort}` },
        },
    },
    build: {
        sourcemap: true,
        // The app has its own origin (`app.<host>`) and sits at its root: the relay serves
        // `dist/app` there. `bun run build:web` first builds the public site (`apps/site`) into
        // `dist` (Astro empties the directory), then the app into `dist/app`.
        outDir: 'dist/app',
        rollupOptions: {
            input: { app: resolve(import.meta.dirname, 'index.html') },
        },
    },
});

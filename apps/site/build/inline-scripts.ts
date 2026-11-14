import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Scripts of an HTML page the browser would not run:
 * - inline `<script>` elements: the relay's CSP only allows scripts from files
 *   (`script-src 'self'`). JSON data blocks are not executed and are allowed;
 * - scripts pointing to TypeScript sources, which Astro leaves as they are when it does not
 *   process the tag (e.g. a `<script>` with a `slot` attribute).
 */
export function findInlineScripts(html: string): string[] {
    const found: string[] = [];
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        const attributes = match[1] ?? '';
        const body = match[2] ?? '';
        const src = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(attributes)?.[1];
        if (src !== undefined) {
            if (/\.tsx?$/.test(src)) found.push(`src=${src}`);
            continue;
        }
        if (/\stype\s*=\s*["']?application\/(ld\+)?json/i.test(attributes)) continue;
        found.push(body.trim().slice(0, 80));
    }
    return found;
}

/** Fails the build when a built page has inline scripts (see `findInlineScripts`). */
export async function assertNoInlineScripts(outDir: string): Promise<void> {
    const problems: string[] = [];
    for (const file of await htmlFiles(outDir)) {
        for (const script of findInlineScripts(await readFile(file, 'utf8'))) {
            problems.push(`${file}: <script>${script}…`);
        }
    }
    if (problems.length > 0) {
        throw new Error(
            `scripts that would not run (inline, or not built):\n${problems.join('\n')}`,
        );
    }
}

async function htmlFiles(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.html'))
        .map((entry) => join(entry.parentPath, entry.name));
}

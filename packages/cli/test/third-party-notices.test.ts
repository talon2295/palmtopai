import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    collectNotices,
    NOTICES_FILE,
    type PackageNotice,
    renderNotices,
    repositoryUrl,
} from '../../../scripts/third-party-notices';
import { buildCli } from '../scripts/build';

describe('THIRD_PARTY_NOTICES.md', () => {
    let dir: string;
    let notices: PackageNotice[];
    let committed: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-notices-'));
        const bundle = await readFile(await buildCli(dir), 'utf8');
        notices = collectNotices(bundle);
        committed = (await readFile(NOTICES_FILE, 'utf8')).replaceAll('\r\n', '\n');
    }, 30_000);

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test('lists every package of the CLI bundle and of the app, with its version', () => {
        const cli = notices.filter((n) => n.usedIn.includes('cli')).map((n) => n.name);
        for (const name of ['hono', 'zod', 'web-push', '@clack/prompts', 'ulid']) {
            expect(cli).toContain(name);
        }
        const app = notices.filter((n) => n.usedIn.includes('app')).map((n) => n.name);
        for (const name of ['react', 'react-dom', 'radix-ui', 'vaul', 'zod']) {
            expect(app).toContain(name);
        }
        for (const n of notices) {
            expect(committed).toContain(`## ${n.name} ${n.version}\n`);
        }
    });

    test('names a known license and a source for every package', () => {
        for (const n of notices) {
            expect(n.license).not.toContain('UNKNOWN');
            expect(n.source).toStartWith('https://');
        }
        expect(committed).not.toContain('UNKNOWN');
        expect(committed).toContain('https://github.com/web-push-libs/web-push');
    });

    test('is up to date (bun run build:cli && bun run notices)', () => {
        expect(committed).toBe(renderNotices(notices));
    });
});

describe('repositoryUrl', () => {
    test('turns the forms of package.json into a web address', () => {
        expect(repositoryUrl('git+https://github.com/honojs/hono.git')).toBe(
            'https://github.com/honojs/hono',
        );
        expect(repositoryUrl({ type: 'git', url: 'git://github.com/a/b.git' })).toBe(
            'https://github.com/a/b',
        );
        expect(repositoryUrl('git@github.com:a/b.git')).toBe('https://github.com/a/b');
        expect(repositoryUrl('github:a/b')).toBe('https://github.com/a/b');
        expect(repositoryUrl('a/b')).toBe('https://github.com/a/b');
        expect(repositoryUrl(undefined)).toBeUndefined();
    });
});

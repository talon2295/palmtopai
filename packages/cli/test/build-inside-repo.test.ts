import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertInsideRepo, insideRepoOnly } from '../scripts/build';

/**
 * Like the server: a package installed in a `node_modules` above the repository (`outside`), that
 * the code requires only if it is there, next to one installed in the repository (`inside`).
 */
describe('CLI build: only code from the repository', () => {
    let dir: string;
    let project: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-build-'));
        project = join(dir, 'project');
        const pkg = async (base: string, name: string, code: string) => {
            const root = join(base, 'node_modules', name);
            await mkdir(root, { recursive: true });
            await writeFile(join(root, 'package.json'), JSON.stringify({ name, main: 'index.js' }));
            await writeFile(join(root, 'index.js'), code);
        };
        await pkg(dir, 'outside', 'module.exports = "OUTSIDE_CODE";');
        await pkg(project, 'inside', 'module.exports = "INSIDE_CODE";');
        await writeFile(
            join(project, 'main.js'),
            [
                'import inside from "inside";',
                'let outside = "missing";',
                'try { outside = require("outside"); } catch {}',
                'console.log(inside, outside);',
            ].join('\n'),
        );
    });

    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    async function build(plugins: Parameters<typeof Bun.build>[0]['plugins']) {
        const outdir = await mkdtemp(join(dir, 'out-'));
        const result = await Bun.build({
            entrypoints: [join(project, 'main.js')],
            outdir,
            target: 'node',
            format: 'esm',
            plugins,
        });
        expect(result.success).toBe(true);
        const file = join(outdir, 'main.js');
        return { file, code: await readFile(file, 'utf8') };
    }

    test('without the rule, the package above the repository gets in (what the server did)', async () => {
        const { code } = await build([]);
        expect(code).toContain('OUTSIDE_CODE');
    });

    test('with the rule, it counts as missing and the code goes on without it', async () => {
        const { file, code } = await build([insideRepoOnly(project)]);
        expect(code).not.toContain('OUTSIDE_CODE');
        expect(code).toContain('INSIDE_CODE');
        const run = Bun.spawnSync(['node', file]);
        expect(run.stdout.toString().trim()).toBe('INSIDE_CODE missing');
    });

    test('the bundle is the same whether the package is above the repository or nowhere', async () => {
        const above = await build([insideRepoOnly(project)]);
        const away = join(dir, 'away');
        await rename(join(dir, 'node_modules'), away);
        try {
            const nowhere = await build([insideRepoOnly(project)]);
            expect(nowhere.code).toBe(above.code);
        } finally {
            await rename(away, join(dir, 'node_modules'));
        }
    });

    test('a bundle with a module from outside the repository fails the build', () => {
        expect(() =>
            assertInsideRepo('// src/main.ts\n// ../node_modules/has-flag/index.js\n'),
        ).toThrow('outside the repository: // ../node_modules/has-flag/index.js');
        expect(() =>
            assertInsideRepo('// node_modules/.bun/ms@2.1.3/node_modules/ms/index.js\n'),
        ).not.toThrow();
    });
});

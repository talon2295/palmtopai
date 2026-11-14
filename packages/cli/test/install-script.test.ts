import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    setDefaultTimeout,
    test,
} from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type Relay, startRelay } from '@palmtopai/relay';
import { buildCli } from '../scripts/build';

// Each test runs the installer and `palmtop setup` in `node` processes: on a busy machine 5 s is not enough.
setDefaultTimeout(30_000);

const SCRIPT = join(import.meta.dir, '..', '..', '..', 'apps', 'site', 'public', 'install.sh');
const NODE = Bun.which('node');
if (!NODE) throw new Error('these tests run palmtop with Node.js 22+: install node');

/**
 * `install.sh` against a local relay that publishes a fresh build, in a temporary home. A shell
 * script: Windows has `install.ps1`.
 */
describe.skipIf(process.platform === 'win32')('install.sh', () => {
    let root: string;
    let dist: string;
    let relay: Relay;
    let home: string;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'palmtop-install-'));
        dist = join(root, 'dist');
        await buildCli(dist);
        relay = startRelay({ port: 0, cliRoot: dist, log: () => {} });
    });

    afterAll(async () => {
        await relay.stop();
        await rm(root, { recursive: true, force: true });
    });

    beforeEach(async () => {
        home = await mkdtemp(join(root, 'home-'));
    });

    /** A folder with fake commands put first on the PATH. */
    async function fakeBin(commands: Record<string, string>): Promise<string> {
        const bin = await mkdtemp(join(root, 'bin-'));
        for (const [name, body] of Object.entries(commands)) {
            await writeFile(join(bin, name), `#!/bin/sh\n${body}\n`);
            await chmod(join(bin, name), 0o755);
        }
        return bin;
    }

    async function install(options: { path?: string; args?: string[]; url?: string } = {}) {
        const child = Bun.spawn(['/bin/sh', SCRIPT, ...(options.args ?? [])], {
            env: {
                HOME: home,
                PATH: options.path ?? `${dirname(NODE as string)}:/usr/bin:/bin`,
                SHELL: '/bin/zsh',
                PALMTOP_INSTALL_URL: options.url ?? `http://127.0.0.1:${relay.port}`,
                PALMTOP_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
            },
            stdin: 'ignore',
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        return { stdout, stderr, code };
    }

    const bin = () => join(home, '.palmtopai', 'bin');

    test('downloads and verifies palmtop, then runs setup without questions', async () => {
        await mkdir(join(home, '.claude'));
        const release = JSON.parse(await readFile(join(dist, 'version.json'), 'utf8'));
        const result = await install();
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        expect(result.stdout).toContain(
            `✓ palmtop ${release.version} installed in ~/.palmtopai/bin (SHA-256 verified)`,
        );
        // No terminal: no colours, and `palmtop setup` asks nothing.
        expect(result.stdout).not.toContain('\u001b[');
        expect(result.stdout).toContain('Claude Code\n  Skill created:');
        expect(result.stdout).toContain('Next steps for you:');
        expect(result.stdout).toContain('add this line to ~/.zshrc');

        expect(await readFile(join(bin(), 'palmtop.mjs'))).toEqual(
            await readFile(join(dist, 'palmtop.mjs')),
        );
        expect(await readlink(join(bin(), 'palmtop'))).toBe('palmtop.mjs');
        expect(await Bun.file(join(bin(), '.palmtop.mjs.download')).exists()).toBe(false);
        // No shell file is touched without asking.
        expect(await Bun.file(join(home, '.zshrc')).exists()).toBe(false);

        // Again: an update, same result.
        const again = await install();
        expect(again.code).toBe(0);
        expect(again.stdout).toContain('Skill already up to date');
    });

    test('passes its options to palmtop setup', async () => {
        const result = await install({ args: ['--force-agents-install'] });
        expect(result.code).toBe(0);
        expect(result.stdout).toContain('Claude Code\n  Skill created:');
        expect(result.stdout).toContain('Codex\n  Skill created:');
    });

    test('a download that does not match its SHA-256 installs nothing', async () => {
        const tampered = join(root, 'tampered');
        await mkdir(tampered, { recursive: true });
        const release = await readFile(join(dist, 'version.json'), 'utf8');
        await writeFile(join(tampered, 'version.json'), release);
        await writeFile(join(tampered, 'palmtop.mjs'), 'console.log("not palmtop")');
        const server = Bun.serve({
            port: 0,
            hostname: '127.0.0.1',
            fetch: (request) =>
                new Response(Bun.file(join(tampered, new URL(request.url).pathname))),
        });
        try {
            const result = await install({ url: `http://127.0.0.1:${server.port}` });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain('does not match its SHA-256: nothing was installed');
            expect(await Bun.file(join(bin(), 'palmtop.mjs')).exists()).toBe(false);
            expect(await Bun.file(join(bin(), '.palmtop.mjs.download')).exists()).toBe(false);
        } finally {
            server.stop(true);
        }
    });

    test('stops with a link when Node.js is missing or too old', async () => {
        const old = await fakeBin({ node: 'echo 20.11.1' });
        const tooOld = await install({ path: `${old}:/usr/bin:/bin` });
        expect(tooOld.code).toBe(1);
        expect(tooOld.stderr).toContain('Node.js 22 or newer (found 20.11.1)');
        expect(tooOld.stderr).toContain('https://nodejs.org');

        // Only the commands the script needs before looking for node.
        const noNode = await fakeBin({ uname: 'echo Linux' });
        const missing = await install({ path: noNode });
        expect(missing.code).toBe(1);
        expect(missing.stderr).toContain('palmtop needs Node.js 22 or newer: install it');
        expect(await Bun.file(bin()).exists()).toBe(false);
    });

    test('sends Git Bash and the like to the PowerShell installer', async () => {
        for (const system of ['MINGW64_NT-10.0', 'MSYS_NT-10.0', 'CYGWIN_NT-10.0']) {
            const windows = await fakeBin({ uname: `echo ${system}` });
            const result = await install({
                path: `${windows}:${dirname(NODE as string)}:/usr/bin:/bin`,
                url: 'https://palmtop.example',
            });
            expect(result.code).toBe(1);
            expect(result.stderr).toContain(
                'On Windows, run this in PowerShell: irm https://palmtop.example/install.ps1 | iex',
            );
            expect(await Bun.file(bin()).exists()).toBe(false);
        }
    });

    test('refuses other systems, saying which one it found', async () => {
        const other = await fakeBin({ uname: 'echo FreeBSD' });
        const result = await install({ path: `${other}:${dirname(NODE as string)}:/usr/bin:/bin` });
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('Found FreeBSD.');
    });
});

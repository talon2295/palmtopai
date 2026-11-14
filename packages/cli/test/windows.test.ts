import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    addToUserPath,
    ensureShim,
    type PowerShellRunner,
    pathCommand,
    readUserPath,
} from '../src/windows';

describe('palmtop.cmd', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-shim-'));
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    test('is written next to the bundle: node of the PATH, the folder of the file, all arguments', async () => {
        const entry = join(dir, 'bin', 'palmtop.mjs');
        expect(await ensureShim(entry)).toBe('created');
        expect(await readFile(join(dir, 'bin', 'palmtop.cmd'), 'utf8')).toBe(
            '@node "%~dp0palmtop.mjs" %*\r\n',
        );
    });

    test('is not written again when it is right, and is when it is missing or different', async () => {
        const entry = join(dir, 'palmtop.mjs');
        await ensureShim(entry);
        expect(await ensureShim(entry)).toBe('unchanged');
        await writeFile(join(dir, 'palmtop.cmd'), '@echo old\r\n');
        expect(await ensureShim(entry)).toBe('updated');
        expect(await readFile(join(dir, 'palmtop.cmd'), 'utf8')).toContain('%~dp0palmtop.mjs');
        await rm(join(dir, 'palmtop.cmd'));
        expect(await ensureShim(entry)).toBe('created');
    });

    test('is for an installed bundle only: not for the sources or a symlink name', async () => {
        await mkdir(join(dir, 'src'));
        expect(await ensureShim(join(dir, 'src', 'main.ts'))).toBeNull();
        expect(await ensureShim(join(dir, 'palmtop'))).toBeNull();
        expect(await Bun.file(join(dir, 'palmtop.cmd')).exists()).toBe(false);
    });
});

describe('the PATH of the user', () => {
    const bin = 'C:\\Users\\ada\\.palmtopai\\bin';
    let dir: string;
    let binDir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-path-'));
        binDir = join(dir, '.palmtopai', 'bin');
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    /** A PowerShell that holds one `Path`, as `GetEnvironmentVariable` gives it. */
    function powershell(initial: string) {
        let value = initial;
        const run: PowerShellRunner = async (script, env = {}) => {
            if (script.includes('SetEnvironmentVariable')) {
                value = env.PALMTOP_NEW_PATH ?? '';
                return '';
            }
            return `${value}\r\n`;
        };
        return { run, value: () => value };
    }

    test('reads the value without the line ending', async () => {
        expect(await readUserPath(powershell('C:\\Tools').run)).toBe('C:\\Tools');
    });

    test('the folder goes first, the rest stays as it was, and the old value is kept', async () => {
        const shell = powershell('C:\\Tools;C:\\Program Files\\Git\\cmd');
        const result = await addToUserPath(binDir, shell.run, '20261017-100000');
        expect(result.change).toBe('updated');
        expect(shell.value()).toBe(`${binDir};C:\\Tools;C:\\Program Files\\Git\\cmd`);
        expect(result.backup).toBe(join(dir, '.palmtopai', 'path-backup-20261017-100000.txt'));
        expect(await readFile(result.backup as string, 'utf8')).toBe(
            'C:\\Tools;C:\\Program Files\\Git\\cmd\r\n',
        );
    });

    test('with no PATH of the user there is nothing to keep', async () => {
        const shell = powershell('');
        expect(await addToUserPath(binDir, shell.run, 'x')).toEqual({ change: 'created' });
        expect(shell.value()).toBe(binDir);
    });

    test('a folder that is already there changes nothing, whatever the case or the slash', async () => {
        for (const variant of [bin, bin.toUpperCase(), `${bin}\\`, bin.replaceAll('\\', '/')]) {
            const shell = powershell(`C:\\Tools;${variant}`);
            expect(await addToUserPath(bin, shell.run, 'x')).toEqual({ change: 'unchanged' });
            expect(shell.value()).toBe(`C:\\Tools;${variant}`);
        }
    });

    test('empty entries are dropped, and a failing PowerShell comes out as an error', async () => {
        const shell = powershell(';C:\\Tools;;');
        await addToUserPath(binDir, shell.run, 'x');
        expect(shell.value()).toBe(`${binDir};C:\\Tools`);
        await expect(
            addToUserPath(
                binDir,
                async () => {
                    throw new Error('no powershell');
                },
                'x',
            ),
        ).rejects.toThrow('no powershell');
    });

    test('the line to run by hand quotes the folder', () => {
        expect(pathCommand("C:\\Users\\O'Neil\\.palmtopai\\bin")).toBe(
            "[Environment]::SetEnvironmentVariable('Path', 'C:\\Users\\O''Neil\\.palmtopai\\bin;' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')",
        );
    });
});

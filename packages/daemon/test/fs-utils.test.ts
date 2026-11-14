import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type CommandRunner, ensurePrivateDir, renameWithRetry } from '../src/fs-utils';
import { createTempHome } from './helpers';

const busy = () => Object.assign(new Error('busy'), { code: 'EBUSY' });

describe('renameWithRetry', () => {
    /** A rename that fails with `error` the first `failures` times. */
    function flaky(failures: number, error: () => Error) {
        const calls: string[] = [];
        const waits: number[] = [];
        return {
            calls,
            waits,
            rename: async (from: string, to: string) => {
                calls.push(`${from}>${to}`);
                if (calls.length <= failures) throw error();
            },
            sleep: async (ms: number) => {
                waits.push(ms);
            },
        };
    }

    test('on Windows a busy file is tried again, waiting a little longer each time', async () => {
        const fake = flaky(3, busy);
        await renameWithRetry('a', 'b', { platform: 'win32', ...fake });
        expect(fake.calls).toHaveLength(4);
        expect(fake.waits).toEqual([10, 25, 50]);
    });

    test('EPERM and EACCES count as busy too', async () => {
        for (const code of ['EPERM', 'EACCES']) {
            const fake = flaky(1, () => Object.assign(new Error(code), { code }));
            await renameWithRetry('a', 'b', { platform: 'win32', ...fake });
            expect(fake.calls).toHaveLength(2);
        }
    });

    test('it gives up after about a second, with the error of the system', async () => {
        const fake = flaky(100, busy);
        await expect(renameWithRetry('a', 'b', { platform: 'win32', ...fake })).rejects.toThrow(
            'busy',
        );
        expect(fake.calls).toHaveLength(7);
        expect(fake.waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThan(1_000);
    });

    test('other errors and other systems fail at once', async () => {
        const missing = flaky(1, () => Object.assign(new Error('gone'), { code: 'ENOENT' }));
        await expect(renameWithRetry('a', 'b', { platform: 'win32', ...missing })).rejects.toThrow(
            'gone',
        );
        expect(missing.calls).toHaveLength(1);

        const linux = flaky(1, busy);
        await expect(renameWithRetry('a', 'b', { platform: 'linux', ...linux })).rejects.toThrow(
            'busy',
        );
        expect(linux.calls).toHaveLength(1);
        expect(linux.waits).toEqual([]);
    });
});

describe('ensurePrivateDir', () => {
    const SID = 'S-1-5-21-1004336348-1177238915-682003330-512';
    const whoami = `"DESKTOP-ABC\\\\ada","${SID}"\r\n`;

    /** Records the programs run; `icacls` can be made to fail. */
    function recorder(failIcacls?: string) {
        const commands: Array<[string, string[]]> = [];
        const run: CommandRunner = async (file, args) => {
            commands.push([file, args]);
            if (file === 'icacls' && failIcacls) throw new Error(failIcacls);
            return file === 'whoami' ? whoami : '';
        };
        return { commands, run };
    }

    test('on Windows a folder with a marker is limited to the user and SYSTEM, by SID', async () => {
        const temp = await createTempHome();
        try {
            const path = join(temp.home, 'new', 'palmtopai');
            const marker = join(path, '.acl');
            const { commands, run } = recorder();
            expect(await ensurePrivateDir(path, { platform: 'win32', run, marker })).toEqual({
                created: true,
            });
            expect(commands[0]).toEqual(['whoami', ['/user', '/fo', 'csv', '/nh']]);
            expect(commands[1]).toEqual([
                'icacls',
                [
                    path,
                    '/inheritance:r',
                    '/grant:r',
                    `*${SID}:(OI)(CI)F`,
                    '/grant:r',
                    '*S-1-5-18:(OI)(CI)F',
                ],
            ]);
            expect(await readFile(marker, 'utf8')).toBe('restricted\n');
        } finally {
            await temp.cleanup();
        }
    });

    test('it runs once, also for a folder that exists (install.ps1 made it first)', async () => {
        const temp = await createTempHome();
        try {
            const marker = join(temp.home, '.acl');
            const { commands, run } = recorder();
            expect(await ensurePrivateDir(temp.home, { platform: 'win32', run, marker })).toEqual({
                created: false,
            });
            expect(commands).toHaveLength(2);
            // The marker is there: not again, from the CLI or from the daemon.
            await ensurePrivateDir(temp.home, { platform: 'win32', run, marker });
            expect(commands).toHaveLength(2);
        } finally {
            await temp.cleanup();
        }
    });

    test('without a marker no program is run: the folders inside inherit from the home', async () => {
        const temp = await createTempHome();
        try {
            const { commands, run } = recorder();
            await ensurePrivateDir(join(temp.home, 'data'), { platform: 'win32', run });
            expect(commands).toEqual([]);
        } finally {
            await temp.cleanup();
        }
    });

    test('a failure of icacls does not fail the folder, says why, and is recorded', async () => {
        const temp = await createTempHome();
        try {
            const marker = join(temp.home, '.acl');
            const { run } = recorder('access denied');
            expect(
                await ensurePrivateDir(join(temp.home, 'blocked'), {
                    platform: 'win32',
                    run,
                    marker,
                }),
            ).toEqual({ created: true, aclError: 'access denied' });
            // The note is for the first time only.
            expect(await readFile(marker, 'utf8')).toBe('not restricted\n');
            const again = await ensurePrivateDir(join(temp.home, 'blocked'), {
                platform: 'win32',
                run,
                marker,
            });
            expect(again.aclError).toBeUndefined();

            const noSid: CommandRunner = async () => 'nothing here';
            expect(
                await ensurePrivateDir(join(temp.home, 'other'), {
                    platform: 'win32',
                    run: noSid,
                    marker: join(temp.home, '.acl2'),
                }),
            ).toEqual({ created: true, aclError: 'could not read the SID of the user' });
        } finally {
            await temp.cleanup();
        }
    });

    test('elsewhere no program is run', async () => {
        const temp = await createTempHome();
        try {
            const { commands, run } = recorder();
            await ensurePrivateDir(join(temp.home, 'posix'), {
                platform: 'linux',
                run,
                marker: join(temp.home, '.acl'),
            });
            expect(commands).toEqual([]);
        } finally {
            await temp.cleanup();
        }
    });
});

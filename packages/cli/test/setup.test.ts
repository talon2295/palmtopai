import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
    chmod,
    mkdir,
    mkdtemp,
    readdir,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, posix } from 'node:path';
import { type Daemon, startDaemon } from '@palmtopai/daemon';
import { type Relay, startRelay } from '@palmtopai/relay';
import { banner } from '../src/banner';
import { type CliIo, run } from '../src/cli';
import {
    addToPath,
    findOnPath,
    userHome as homeOf,
    mcpServerFor,
    onPath,
    type SetupUi,
    shellProfile,
} from '../src/setup';

/** Windows has no execute bit and no symlinks without a privilege. */
const WINDOWS = process.platform === 'win32';

describe('findOnPath', () => {
    let bin: string;
    beforeEach(async () => {
        bin = await mkdtemp(join(tmpdir(), 'palmtop-path-'));
    });

    test.skipIf(WINDOWS)('finds an executable by its name', async () => {
        await writeFile(join(bin, 'tool'), '#!/bin/sh\n');
        await chmod(join(bin, 'tool'), 0o755);
        await writeFile(join(bin, 'plain'), 'not executable');
        await chmod(join(bin, 'plain'), 0o644);
        const path = `/nowhere${delimiter}${bin}`;
        expect(findOnPath('tool', path, { platform: 'linux' })).toBe(join(bin, 'tool'));
        expect(findOnPath('plain', path, { platform: 'linux' })).toBeNull();
        expect(findOnPath('missing', path, { platform: 'linux' })).toBeNull();
        expect(onPath('tool', path, { platform: 'linux' })).toBe(true);
        expect(onPath('missing', path, { platform: 'linux' })).toBe(false);
    });

    test('on Windows a command is also its name with an extension of PATHEXT', async () => {
        await writeFile(join(bin, 'claude.exe'), '');
        await writeFile(join(bin, 'codex.cmd'), '');
        const options = { platform: 'win32' as const, pathext: '.COM;.EXE;.BAT;.CMD' };
        expect(findOnPath('claude', bin, options)).toBe(join(bin, 'claude.exe'));
        expect(findOnPath('codex', bin, options)).toBe(join(bin, 'codex.cmd'));
        expect(findOnPath('codex', bin, { ...options, pathext: '.EXE' })).toBeNull();
        expect(findOnPath('claude.exe', bin, options)).toBe(join(bin, 'claude.exe'));
        // Elsewhere the extension is not added.
        expect(findOnPath('claude', bin, { platform: 'linux' })).toBeNull();
    });
});

describe('userHome', () => {
    test('is HOME, or USERPROFILE on Windows where HOME is not a folder Node can open', () => {
        const env = { HOME: '/c/Users/ada', USERPROFILE: 'C:\\Users\\ada' };
        expect(homeOf(env, 'linux')).toBe('/c/Users/ada');
        expect(homeOf(env, 'darwin')).toBe('/c/Users/ada');
        expect(homeOf(env, 'win32')).toBe('C:\\Users\\ada');
        expect(homeOf({ USERPROFILE: 'C:\\Users\\ada' }, 'win32')).toBe('C:\\Users\\ada');
    });
});

describe('mcpServerFor', () => {
    let folder: string;
    let bin: string;
    beforeEach(async () => {
        folder = await mkdtemp(join(tmpdir(), 'palmtop-mcp-cmd-'));
        bin = join(folder, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'node'), '#!/bin/sh\n');
        await chmod(join(bin, 'node'), 0o755);
    });

    test.skipIf(WINDOWS)(
        'is the node of the PATH and the bundle, resolving the symlink the user runs',
        async () => {
            await writeFile(join(folder, 'palmtop.mjs'), '// bundle');
            await symlink(join(folder, 'palmtop.mjs'), join(folder, 'palmtop'));
            const real = await realpath(join(folder, 'palmtop.mjs'));
            expect(mcpServerFor(join(folder, 'palmtop'), { PATH: bin })).toEqual({
                command: join(bin, 'node'),
                args: [real, 'mcp'],
            });
        },
    );

    test('is null from the sources, for a missing file and without node', async () => {
        await writeFile(join(folder, 'main.ts'), '// sources');
        await writeFile(join(folder, 'palmtop.mjs'), '// bundle');
        expect(mcpServerFor(join(folder, 'main.ts'), { PATH: bin })).toBeNull();
        expect(mcpServerFor(join(folder, 'missing.mjs'), { PATH: bin })).toBeNull();
        // Under bun the running executable is not node either.
        expect(mcpServerFor(join(folder, 'palmtop.mjs'), { PATH: '/nowhere' })).toBeNull();
    });
});

describe('shellProfile', () => {
    // A POSIX computer, whatever runs the tests: on Windows there is no profile of a shell.
    const profile = (
        binDir: string,
        env: Record<string, string | undefined>,
        platform: NodeJS.Platform = 'linux',
    ) => shellProfile(binDir, env, platform);
    const env = { HOME: '/home/ada' };
    const bin = '/home/ada/.palmtopai/bin';

    test('zsh uses ~/.zshrc, or $ZDOTDIR/.zshrc', () => {
        expect(profile(bin, { ...env, SHELL: '/bin/zsh' })).toEqual({
            shell: 'zsh',
            file: '/home/ada/.zshrc',
            line: 'export PATH="$HOME/.palmtopai/bin:$PATH"',
        });
        expect(profile(bin, { ...env, SHELL: '/bin/zsh', ZDOTDIR: '/home/ada/.zsh' })?.file).toBe(
            '/home/ada/.zsh/.zshrc',
        );
    });

    test('bash uses ~/.bash_profile on macOS and ~/.bashrc elsewhere', () => {
        const bash = { ...env, SHELL: '/usr/bin/bash' };
        expect(profile(bin, bash, 'darwin')?.file).toBe('/home/ada/.bash_profile');
        expect(profile(bin, bash, 'linux')?.file).toBe('/home/ada/.bashrc');
    });

    test('fish gets a file of its own in conf.d', () => {
        expect(profile(bin, { ...env, SHELL: '/opt/homebrew/bin/fish' })).toEqual({
            shell: 'fish',
            file: '/home/ada/.config/fish/conf.d/palmtop.fish',
            line: 'fish_add_path $HOME/.palmtopai/bin',
        });
    });

    test('a folder outside the home is written as it is; unknown shells get nothing', () => {
        expect(profile('/opt/palmtop/bin', { ...env, SHELL: '/bin/zsh' })?.line).toBe(
            'export PATH="/opt/palmtop/bin:$PATH"',
        );
        expect(profile(bin, { ...env, SHELL: '/bin/tcsh' })).toBeNull();
        expect(profile(bin, env)).toBeNull();
    });
});

describe('addToPath', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-path-'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const profile = () => ({
        shell: 'zsh',
        file: join(dir, '.zshrc'),
        line: 'export PATH="$HOME/.palmtopai/bin:$PATH"',
    });

    test('appends the line once, after a backup, keeping what was there', async () => {
        await writeFile(profile().file, 'alias ll="ls -l"');
        const first = await addToPath(profile(), 'palmtop-backup-x');
        expect(first).toEqual({ change: 'updated', backup: `${profile().file}.palmtop-backup-x` });
        expect(await readFile(profile().file, 'utf8')).toBe(
            'alias ll="ls -l"\n\n# palmtop\nexport PATH="$HOME/.palmtopai/bin:$PATH"\n',
        );
        expect(await readFile(first.backup as string, 'utf8')).toBe('alias ll="ls -l"');

        expect(await addToPath(profile(), 'palmtop-backup-y')).toEqual({ change: 'unchanged' });
        expect((await readdir(dir)).sort()).toEqual(['.zshrc', '.zshrc.palmtop-backup-x']);
    });

    test('creates a missing file and its folder', async () => {
        const fish = {
            shell: 'fish',
            file: join(dir, 'conf.d', 'palmtop.fish'),
            line: 'fish_add_path x',
        };
        expect(await addToPath(fish, 'palmtop-backup-x')).toEqual({ change: 'created' });
        expect(await readFile(fish.file, 'utf8')).toBe('\n# palmtop\nfish_add_path x\n');
    });
});

describe('banner', () => {
    test('has the name and version, with colours only when asked', () => {
        const plain = banner('1.2.3', 'none');
        expect(plain).toContain('palmtop 1.2.3');
        expect(plain).toContain('The missing checklist for AI coding');
        expect(plain).not.toContain('\u001b[');
        // #34d399, the green of the logo.
        expect(banner('1.2.3', 'truecolor')).toContain('\u001b[38;2;52;211;153m');
        expect(banner('1.2.3', 'ansi256')).toContain('\u001b[38;5;79m');
    });
});

/** `palmtop setup` against a real daemon, with scripted answers. */
describe('setup', () => {
    let root: string;
    let home: string;
    let userHome: string;
    /**
     * `PATH` of the fake computer: an empty folder, never the real one. With `/usr/bin` in it the
     * agents installed on the computer running the tests would count as found.
     */
    let emptyPath: string;
    let relay: Relay;
    let daemon: Daemon;

    function freePort(): number {
        const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
        const port = server.port as number;
        server.stop(true);
        return port;
    }

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), 'palmtop-setup-'));
        home = join(root, 'palmtop-home');
        await mkdir(home);
        // Outside every `userHome`: the tests check that nothing is written in there.
        emptyPath = join(root, 'empty-path');
        await mkdir(emptyPath);
        const localPort = freePort();
        await writeFile(join(home, 'config.json'), `${JSON.stringify({ localPort })}\n`);
        relay = startRelay({ port: 0, log: () => {} });
        daemon = await startDaemon({
            home,
            localPort,
            relayUrl: `ws://127.0.0.1:${relay.port}`,
            log: () => {},
        });
    });

    afterAll(async () => {
        await daemon.stop();
        await relay.stop();
        await rm(root, { recursive: true, force: true });
    });

    beforeEach(async () => {
        userHome = join(root, `user-${Math.random().toString(36).slice(2)}`);
        await mkdir(userHome);
    });

    /** Codex as it is after its first run: `config.toml` in `~/.codex`. */
    async function useCodex() {
        await mkdir(join(userHome, '.codex'));
        await writeFile(join(userHome, '.codex', 'config.toml'), '');
    }

    type Answer = boolean | string[] | null;

    /**
     * A terminal whose questions are answered in order by `answers`. The computer is a Linux one
     * (zsh, whatever runs the tests); `windows` makes it a Windows one, with the bundle that
     * `palmtop.cmd` needs and a PowerShell that keeps the PATH of the user in `userPath`.
     */
    function terminal(answers: Answer[], keys: string[] = [], windows?: { userPath: string }) {
        const scripts: string[] = [];
        const written: string[] = [];
        const out: string[] = [];
        const asked: string[] = [];
        const pending = [...answers];
        const pendingKeys = [...keys];
        let cleared = 0;
        const ui: SetupUi = {
            intro: (title) => out.push(`intro ${title}`),
            step: (message) => out.push(`step ${message}`),
            success: (message) => out.push(`success ${message}`),
            info: (message) => out.push(`info ${message}`),
            warn: (message) => out.push(`warn ${message}`),
            confirm: async (message, initial) => {
                asked.push(`${message} [${initial ? 'Y/n' : 'y/N'}]`);
                return pending.shift() as boolean | null;
            },
            multiselect: async <V extends string>(
                message: string,
                options: { value: V; label: string; hint?: string; disabled?: boolean }[],
                initial: V[],
            ) => {
                const shown = options.map(
                    (o) => `${o.label} (${o.hint}${o.disabled ? ', disabled' : ''})`,
                );
                asked.push(`${message} ${shown.join(', ')} [${initial.join(',')}]`);
                const answer = pending.shift() as V[] | null;
                // Like clack: a disabled option cannot be selected.
                const disabled = options.filter((o) => o.disabled).map((o) => o.value);
                if (answer?.some((value) => disabled.includes(value))) {
                    throw new Error(`selected a disabled agent: ${answer.join(',')}`);
                }
                return answer;
            },
            spinner: () => ({
                start: (message) => out.push(`spin ${message}`),
                stop: (message) => out.push(`spun ${message}`),
            }),
            outro: (message) => out.push(`outro ${message}`),
            cancel: (message) => out.push(`cancel ${message}`),
        };
        const io: CliIo = {
            platform: windows ? 'win32' : 'linux',
            ...(windows && {
                powershell: async (script: string, env: Record<string, string> = {}) => {
                    scripts.push(script);
                    if (script.includes('SetEnvironmentVariable')) {
                        written.push(env.PALMTOP_NEW_PATH ?? '');
                        return '';
                    }
                    return `${windows.userPath}\r\n`;
                },
            }),
            entry: join(userHome, '.palmtopai', 'bin', windows ? 'palmtop.mjs' : 'palmtop'),
            stdout: (text) => out.push(text),
            stderr: (text) => out.push(text),
            env: {
                PALMTOP_HOME: home,
                HOME: userHome,
                USERPROFILE: userHome,
                SHELL: '/bin/zsh',
                PATH: emptyPath,
                CLAUDE_CONFIG_DIR: join(userHome, '.claude'),
                CODEX_HOME: join(userHome, '.codex'),
            },
            cwd: userHome,
            ui,
            tty: {
                readKey: async () => pendingKeys.shift() ?? '\r',
                clear: () => {
                    cleared += 1;
                },
            },
        };
        return { io, out, asked, scripts, written, cleared: () => cleared };
    }

    test('sets up the agents chosen, the PATH, and skips pairing when asked to', async () => {
        await useCodex();
        const { io, out, asked } = terminal([['codex'], true, false]);
        expect(await run(['setup'], io)).toBe(0);

        expect(asked).toEqual([
            'Which agents should use palmtop? Claude Code (not installed, disabled), Codex (found on this computer) [codex]',
            'Add palmtop to your PATH in ~/.zshrc? [Y/n]',
            'Pair a device now? (phone, tablet or another computer) [Y/n]',
        ]);
        expect(out[0]).toContain('palmtop ');
        expect(out).toContain('success Codex: palmtop skill and permission installed');
        expect(out).toContain('success Added palmtop to your PATH in ~/.zshrc');
        expect(out).toContain(`spun palmtop is running on "${daemon.computerName}"`);
        expect(out).toContain('info Pair a device later with `palmtop pair`, from any folder.');
        expect(out.slice(-2)).toEqual([
            'info Next: open a new terminal, then start Codex in your project\nand ask it to put the checks on palmtop.',
            'outro palmtop is ready.',
        ]);

        expect(await readFile(join(userHome, '.zshrc'), 'utf8')).toBe(
            '\n# palmtop\nexport PATH="$HOME/.palmtopai/bin:$PATH"\n',
        );
        expect(await readdir(join(userHome, '.agents', 'skills', 'palmtop'))).toContain('SKILL.md');
        // Claude Code was not chosen: nothing written for it.
        expect(await Bun.file(join(userHome, '.claude')).exists()).toBe(false);

        // Again: nothing to do, the PATH line is not added twice.
        const again = terminal([['codex'], true, false]);
        expect(await run(['setup'], again.io)).toBe(0);
        expect(again.out).toContain('success Codex: already set up');
        expect(again.out).toContain('success ~/.zshrc already puts palmtop on your PATH');
    });

    test('pairs a device in the terminal, then wipes the QR code', async () => {
        await mkdir(join(userHome, '.claude'));
        const { io, out, cleared } = terminal([['claude'], false, true], ['\r']);
        expect(await run(['setup'], io)).toBe(0);
        const text = out.join('\n');
        expect(text).toContain(`Pair a device with "${daemon.computerName}"`);
        expect(text).toContain('Pairing closed');
        expect(cleared()).toBe(1);
        expect(text).toContain('info Add this line to ~/.zshrc yourself:');
        expect(out.at(-2)).toBe(
            'info Next: start Claude Code in your project\nand ask it to put the checks on palmtop.',
        );
        expect(await Bun.file(join(userHome, '.zshrc')).exists()).toBe(false);
    });

    test('a Codex folder without Codex in it does not count as Codex', async () => {
        // Left by another tool, or by palmtop's own rules file.
        await mkdir(join(userHome, '.codex', 'rules'), { recursive: true });
        await mkdir(join(userHome, '.claude'));
        const { io, asked } = terminal([null]);
        await run(['setup'], io);
        expect(asked[0]).toContain('Codex (not installed, disabled) [claude]');

        // The command on the PATH is enough.
        const bin = join(userHome, 'bin');
        await mkdir(bin);
        await writeFile(join(bin, 'codex'), '#!/bin/sh\n', { mode: 0o755 });
        const withCommand = terminal([null]);
        withCommand.io.env.PATH = `${bin}${delimiter}${emptyPath}`;
        await run(['setup'], withCommand.io);
        expect(withCommand.asked[0]).toContain('Codex (found on this computer) [claude,codex]');
    });

    test('an agent that is not installed can be chosen only with --force-agents-install', async () => {
        await useCodex();
        const refused = terminal([['claude']]);
        expect(await run(['setup'], refused.io)).toBe(1);
        expect(refused.out.join('\n')).toContain('selected a disabled agent');

        const { io, out, asked } = terminal([['claude', 'codex'], false, false]);
        expect(await run(['setup', '--force-agents-install'], io)).toBe(0);
        expect(asked[0]).toBe(
            'Which agents should use palmtop? Claude Code (not installed), Codex (found on this computer) [codex]',
        );
        expect(out).toContain('success Claude Code: palmtop skill and permission installed');
        expect(
            await Bun.file(join(userHome, '.claude', 'skills', 'palmtop', 'SKILL.md')).exists(),
        ).toBe(true);
    });

    test('with no agent installed there is nothing to choose', async () => {
        const { io, out, asked } = terminal([false, false]);
        expect(await run(['setup'], io)).toBe(0);
        expect(asked[0]).toBe('Add palmtop to your PATH in ~/.zshrc? [Y/n]');
        expect(out).toContain(
            'warn No supported agent found (Claude Code, Codex). Install one, then run `palmtop setup` again: any other agent can learn palmtop with `palmtop guide`.',
        );
        expect(await readdir(userHome)).toEqual([]);

        const unattended = terminal([]);
        const piped: CliIo = { ...unattended.io, ui: undefined, tty: undefined };
        expect(await run(['setup'], piped)).toBe(0);
        expect(unattended.out.join('\n')).toContain(
            'No supported agent found (Claude Code, Codex)',
        );
        expect(await readdir(userHome)).toEqual([]);

        const forced = terminal([]);
        const all: CliIo = { ...forced.io, ui: undefined, tty: undefined };
        expect(await run(['setup', '--force-agents-install'], all)).toBe(0);
        expect(forced.out.join('\n')).toContain('Claude Code\n  Skill created:');
        expect(forced.out.join('\n')).toContain('Codex\n  Skill created:');
    });

    test('on Windows: palmtop.cmd next to the bundle, and palmtop first in the PATH of the user', async () => {
        await useCodex();
        const bin = join(userHome, '.palmtopai', 'bin');
        const { io, out, asked, scripts, written } = terminal([['codex'], true, false], [], {
            userPath: 'C:\\Tools;C:\\Windows\\System32',
        });
        expect(await run(['setup'], io)).toBe(0);

        expect(asked).toEqual([
            'Which agents should use palmtop? Claude Code (not installed, disabled), Codex (found on this computer) [codex]',
            'Add palmtop to your PATH? [Y/n]',
            'Pair a device now? (phone, tablet or another computer) [Y/n]',
        ]);
        expect(await readFile(join(bin, 'palmtop.cmd'), 'utf8')).toBe(
            '@node "%~dp0palmtop.mjs" %*\r\n',
        );
        expect(scripts).toHaveLength(2);
        expect(written).toEqual([`${bin};C:\\Tools;C:\\Windows\\System32`]);
        const kept = (await readdir(join(userHome, '.palmtopai'))).filter((name) =>
            name.startsWith('path-backup-'),
        );
        expect(kept).toHaveLength(1);
        expect(await readFile(join(userHome, '.palmtopai', kept[0] as string), 'utf8')).toBe(
            'C:\\Tools;C:\\Windows\\System32\r\n',
        );
        expect(out.join('\n')).toContain(
            'success Added palmtop to your PATH (your earlier PATH is kept in',
        );
        expect(out.at(-2)).toContain('open a new terminal, then start Codex');
        // No profile of a shell on Windows.
        expect(await Bun.file(join(userHome, '.zshrc')).exists()).toBe(false);

        // Again: the folder is already in the PATH of the user, and the shim is not rewritten.
        const again = terminal([['codex'], true, false], [], { userPath: `${bin};C:\\Tools` });
        expect(await run(['setup'], again.io)).toBe(0);
        expect(again.out).toContain('success palmtop is already on your PATH');
        expect(again.written).toEqual([]);
    });

    test('on Windows, a no leaves the PATH alone and says how to do it by hand', async () => {
        await useCodex();
        const { io, out, written } = terminal([['codex'], false, false], [], { userPath: '' });
        expect(await run(['setup'], io)).toBe(0);
        expect(written).toEqual([]);
        expect(out.join('\n')).toContain(
            "info Run this in PowerShell yourself:\n[Environment]::SetEnvironmentVariable('Path',",
        );
    });

    test('on Windows, a PowerShell that fails is not the end of setup', async () => {
        await useCodex();
        const { io, out } = terminal([['codex'], true, false], [], { userPath: '' });
        io.powershell = async () => {
            throw new Error('powershell.exe is not here');
        };
        expect(await run(['setup'], io)).toBe(0);
        expect(out.join('\n')).toContain(
            'warn Could not change your PATH (powershell.exe is not here)',
        );
        expect(out.at(-1)).toBe('outro palmtop is ready.');
    });

    test('on Windows without a terminal: the PowerShell line, and the shim all the same', async () => {
        await useCodex();
        const bin = join(userHome, '.palmtopai', 'bin');
        const { io, out } = terminal([], [], { userPath: '' });
        const unattended: CliIo = { ...io, ui: undefined, tty: undefined };
        expect(await run(['setup'], unattended)).toBe(0);
        const text = out.join('\n');
        expect(text).toContain(
            '1. Put palmtop on your PATH: run this in PowerShell, then open a new terminal:',
        );
        expect(text).toContain(`'${bin};' + [Environment]::GetEnvironmentVariable('Path','User')`);
        expect(await Bun.file(join(bin, 'palmtop.cmd')).exists()).toBe(true);

        const json = terminal([], [], { userPath: '' });
        const piped: CliIo = { ...json.io, ui: undefined, tty: undefined };
        expect(await run(['setup', '--json'], piped)).toBe(0);
        const parsed = JSON.parse(json.out.join('\n'));
        expect(parsed.path.line).toContain("SetEnvironmentVariable('Path'");
        expect(parsed.path.file).toBeUndefined();
    });

    test('cancelling stops before writing anything', async () => {
        await mkdir(join(userHome, '.claude'));
        const { io, out } = terminal([null]);
        expect(await run(['setup'], io)).toBe(1);
        expect(out.at(-1)).toBe(
            'cancel Setup cancelled: run `palmtop setup` again whenever you like.',
        );
        expect(await readdir(userHome)).toEqual(['.claude']);
    });

    test('without a terminal: the agents found, no questions, and the steps left', async () => {
        await useCodex();
        const { io, out, asked } = terminal([]);
        const unattended: CliIo = { ...io, ui: undefined, tty: undefined };
        expect(await run(['setup'], unattended)).toBe(0);
        expect(asked).toEqual([]);
        const text = out.join('\n');
        expect(text).toContain('Codex\n  Skill created:');
        expect(text).not.toContain('Claude Code');
        expect(text).toContain('Next steps for you:');
        expect(text).toContain(
            '1. Put palmtop on your PATH: add this line to ~/.zshrc, then open a new terminal:\n    export PATH="$HOME/.palmtopai/bin:$PATH"',
        );
        expect(text).toContain(
            '2. Pair a device: run `palmtop pair` in a terminal, from any folder.',
        );
        // No shell file is edited without asking.
        expect(await Bun.file(join(userHome, '.zshrc')).exists()).toBe(false);

        const json = terminal([]);
        const piped: CliIo = { ...json.io, ui: undefined, tty: undefined };
        expect(await run(['setup', '--json'], piped)).toBe(0);
        const parsed = JSON.parse(json.out.join('\n'));
        expect(parsed.agents.map((agent: { id: string }) => agent.id)).toEqual(['codex']);
        expect(parsed.path).toEqual({
            file: posix.join(userHome, '.zshrc'),
            line: 'export PATH="$HOME/.palmtopai/bin:$PATH"',
        });
    });
});

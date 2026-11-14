/**
 * What a person does on a Windows computer, against a relay of this machine: installs palmtop from
 * PowerShell 5.1 and from `pwsh`, puts it on the PATH, starts and stops the daemon, and looks at
 * the permissions of the folder. Run by the Windows job of the CI (`bun packages/cli/scripts/
 * windows-smoke.ts`, after `bun run build:cli`); it changes the PATH of the user of the machine,
 * so it is for a disposable one.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { startRelay } from '@palmtopai/relay';

if (process.platform !== 'win32') {
    console.error('windows-smoke.ts runs on Windows only');
    process.exit(2);
}

const root = join(import.meta.dir, '..', '..', '..');
if (!existsSync(join(root, 'apps', 'web', 'dist', 'install.ps1'))) {
    console.error('run `bun run build:web` first: apps/web/dist has no install.ps1');
    process.exit(2);
}

const relay = startRelay({
    port: 0,
    cliRoot: join(root, 'packages', 'cli', 'dist'),
    // The built site (`bun run build:web`): the relay serves files only from a folder with an
    // index.html, and install.ps1 is copied there from `apps/site/public`.
    webRoot: join(root, 'apps', 'web', 'dist'),
    log: () => {},
});
const url = `http://127.0.0.1:${relay.port}`;
const home = join(process.env.USERPROFILE as string, '.palmtopai');
const bin = join(home, 'bin');

interface Result {
    code: number;
    stdout: string;
    stderr: string;
}

/** The environment of a program: `Path` is one variable whatever its case. */
function environment(extra: Record<string, string>, path?: string): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && key.toLowerCase() !== 'path') env[key] = value;
    }
    env.Path = path ?? process.env.Path ?? process.env.PATH ?? '';
    return { ...env, ...extra };
}

function run(file: string, args: string[], env: Record<string, string>): Promise<Result> {
    return new Promise((resolve) => {
        execFile(
            file,
            args,
            { env, timeout: 120_000, windowsHide: true, maxBuffer: 10_000_000 },
            (error, stdout, stderr) =>
                resolve({
                    code: error
                        ? ((error as NodeJS.ErrnoException).code as unknown as number) || 1
                        : 0,
                    stdout,
                    stderr,
                }),
        );
    });
}

const failures: string[] = [];
async function step(name: string, body: () => Promise<void>): Promise<void> {
    try {
        await body();
        console.log(`ok   ${name}`);
    } catch (error) {
        failures.push(name);
        console.log(`FAIL ${name}\n     ${(error as Error).message.replaceAll('\n', '\n     ')}`);
    }
}

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

const SITE = 'https://palmtop.mtwa.it';
const docs = readFileSync(
    join(root, 'apps', 'site', 'src', 'content', 'docs', 'getting-started.md'),
    'utf8',
);

/**
 * A PowerShell command written in the docs, run here against the relay of this machine: what the
 * docs tell people to type is what is tested. `match` finds it among the code blocks (or, for a
 * command in a sentence, among the inline ones).
 */
function docCommand(match: RegExp): string {
    const blocks = [...docs.matchAll(/```powershell\n([\s\S]*?)```/g)].map((m) => m[1] as string);
    const inline = [...docs.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);
    const found = [...blocks, ...inline].find((code) => match.test(code.trim()));
    if (!found) throw new Error(`the docs have no command like ${match}`);
    return found.replaceAll(SITE, url).trim();
}

const base = {
    PALMTOP_INSTALL_URL: url,
    PALMTOP_RELAY_URL: `ws://127.0.0.1:${relay.port}`,
};
const shells = [
    ['Windows PowerShell 5.1', 'powershell.exe'],
    ['PowerShell 7', 'pwsh'],
] as const;

// `irm | iex`, as the page says; the second time it is an update.
for (const [label, shell] of shells) {
    await step(`install.ps1 from ${label}`, async () => {
        const result = await run(
            shell,
            [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                docCommand(/^irm \S+\/install\.ps1 \| iex$/),
            ],
            environment(base),
        );
        const said = `exit ${result.code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;
        expect(result.code === 0, said);
        expect(result.stdout.includes('installed in'), `no "installed in":\n${said}`);
        expect(existsSync(join(bin, 'palmtop.mjs')), 'no palmtop.mjs');
        expect(
            readFileSync(join(bin, 'palmtop.cmd'), 'utf8') === '@node "%~dp0palmtop.mjs" %*\r\n',
            'palmtop.cmd is not the one expected',
        );
    });
}

await step('install by hand, as the docs write it', async () => {
    rmSync(join(bin, 'palmtop.mjs'), { force: true });
    rmSync(join(bin, 'palmtop.cmd'), { force: true });
    const result = await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', docCommand(/Invoke-WebRequest/)],
        environment(base),
    );
    const said = `exit ${result.code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;
    expect(result.code === 0, said);
    expect(existsSync(join(bin, 'palmtop.mjs')), `no palmtop.mjs\n${said}`);
    expect(existsSync(join(bin, 'palmtop.cmd')), `setup wrote no palmtop.cmd\n${said}`);
});

await step('an option of setup through the script block, as the docs write it', async () => {
    const result = await run(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', docCommand(/scriptblock/)],
        environment(base),
    );
    const said = `exit ${result.code}\n--- stdout\n${result.stdout}\n--- stderr\n${result.stderr}`;
    expect(result.code === 0, said);
    // --force-agents-install: both agents are set up, installed or not.
    expect(
        result.stdout.includes('Claude Code') && result.stdout.includes('Codex'),
        `the option did not reach setup:\n${said}`,
    );
});

await step('the PATH of the user gets the folder, the old one is kept', async () => {
    const json = await run(
        'node',
        [join(bin, 'palmtop.mjs'), 'setup', '--json'],
        environment(base),
    );
    expect(json.code === 0, `setup --json: ${json.stdout}${json.stderr}`);
    const line = (JSON.parse(json.stdout) as { path?: { line: string } }).path?.line;
    expect(line, `no PATH step in:\n${json.stdout}`);
    const set = await run('powershell.exe', ['-NoProfile', '-Command', line], environment(base));
    expect(set.code === 0, `${set.stdout}${set.stderr}`);
    const user = await run(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"],
        environment(base),
    );
    expect(
        user.stdout.split(';').some((entry) => entry.trim().toLowerCase() === bin.toLowerCase()),
        `the PATH of the user does not have ${bin}:\n${user.stdout}`,
    );
});

// A new terminal: the PATH the registry has now, with what this job added (Node).
const registry = await run(
    'powershell.exe',
    ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"],
    environment(base),
);
const newTerminal = `${registry.stdout.trim()};${process.env.Path ?? process.env.PATH ?? ''}`;
const terminal = environment(base, newTerminal);

const commands: Array<[string, string, string[]]> = [
    ['cmd', 'cmd.exe', ['/c', 'palmtop --version']],
    ['Windows PowerShell 5.1', 'powershell.exe', ['-NoProfile', '-Command', 'palmtop --version']],
    ['PowerShell 7', 'pwsh', ['-NoProfile', '-Command', 'palmtop --version']],
];
for (const [label, file, args] of commands) {
    await step(`palmtop --version from ${label}`, async () => {
        const result = await run(file, args, terminal);
        expect(result.code === 0, `exit ${result.code}\n${result.stdout}\n${result.stderr}`);
        expect(/^palmtop \d+\.\d+\.\d+/m.test(result.stdout), `unexpected:\n${result.stdout}`);
    });
}

await step('the daemon starts in the background, answers, and stops clean', async () => {
    const started = await run('cmd.exe', ['/c', 'palmtop serve -b'], terminal);
    expect(started.code === 0, `serve -b: ${started.stdout}${started.stderr}`);
    const status = await run('cmd.exe', ['/c', 'palmtop status'], terminal);
    expect(status.stdout.includes('Daemon: running'), `status:\n${status.stdout}${status.stderr}`);
    expect(existsSync(join(home, 'daemon.pid')), 'no daemon.pid while it runs');

    const stopped = await run('cmd.exe', ['/c', 'palmtop stop'], terminal);
    expect(stopped.stdout.includes('Daemon stopped'), `stop:\n${stopped.stdout}${stopped.stderr}`);
    const after = await run('cmd.exe', ['/c', 'palmtop status'], terminal);
    expect(after.stdout.includes('Daemon: not running'), `status after:\n${after.stdout}`);
    expect(!existsSync(join(home, 'daemon.pid')), 'daemon.pid is still there: not a clean stop');
    const log = readFileSync(join(home, 'daemon.log'), 'utf8');
    expect(log.includes('stop request received, saving state'), `daemon.log:\n${log}`);
});

await step('the home is limited to the user and SYSTEM', async () => {
    const acl = await run('icacls', [home], terminal);
    expect(acl.code === 0, `${acl.stdout}${acl.stderr}`);
    for (const wide of ['Everyone', 'BUILTIN\\Users', 'Authenticated Users']) {
        expect(!acl.stdout.includes(wide), `${wide} can reach the folder:\n${acl.stdout}`);
    }
    expect(acl.stdout.includes('NT AUTHORITY\\SYSTEM'), `no SYSTEM:\n${acl.stdout}`);
    expect(
        readFileSync(join(home, '.acl'), 'utf8').trim() === 'restricted',
        `.acl says: ${readFileSync(join(home, '.acl'), 'utf8')}`,
    );
});

await relay.stop();
if (failures.length > 0) {
    console.log(`\n${failures.length} failed: ${failures.join('; ')}`);
    process.exit(1);
}
console.log('\nall steps passed');
process.exit(0);

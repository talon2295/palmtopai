import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Runs a PowerShell script and gives its output; rejects if it fails. `env` is added to the
 * environment of the script: values go there, never into the text of the script.
 */
export type PowerShellRunner = (script: string, env?: Record<string, string>) => Promise<string>;

/** Windows PowerShell 5.1 (`powershell.exe`): on every Windows, unlike `pwsh`. */
export const runPowerShell: PowerShellRunner = (script, env = {}) =>
    new Promise((resolve, reject) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
            {
                env: { ...process.env, ...env },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
                timeout: 20_000,
            },
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (chunk) => {
            out += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            err += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) resolve(out);
            else reject(new Error(err.trim() || `powershell exited with code ${code}`));
        });
    });

/** What `palmtop.cmd` runs: the bundle next to it, with the `node` of the PATH. */
export const SHIM_NAME = 'palmtop.cmd';
const SHIM = '@node "%~dp0palmtop.mjs" %*\r\n';

/**
 * Windows has no symlink to put on the PATH without a privilege: `palmtop.cmd` next to the bundle
 * is what the terminal runs. Written only for an installed bundle (`palmtop.mjs`), and again if it
 * is missing or different, so `setup` and `update` always leave a working one.
 */
export async function ensureShim(
    entry: string,
): Promise<'created' | 'updated' | 'unchanged' | null> {
    if (basename(entry) !== 'palmtop.mjs') return null;
    const path = join(dirname(entry), SHIM_NAME);
    let current: string | null = null;
    try {
        current = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (current === SHIM) return 'unchanged';
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, SHIM);
    return current === null ? 'created' : 'updated';
}

/** A folder of the PATH as it is compared: no case, no trailing separator. */
function pathKey(entry: string): string {
    return entry.trim().replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
}

/** The `Path` variable of the user (not the system's), as Windows keeps it. */
export async function readUserPath(run: PowerShellRunner): Promise<string> {
    return (await run("[Environment]::GetEnvironmentVariable('Path','User')")).replace(
        /\r?\n$/,
        '',
    );
}

/** `SetEnvironmentVariable` also tells the open windows, so a new terminal sees the change. */
export async function writeUserPath(run: PowerShellRunner, value: string): Promise<void> {
    await run("[Environment]::SetEnvironmentVariable('Path',$env:PALMTOP_NEW_PATH,'User')", {
        PALMTOP_NEW_PATH: value,
    });
}

/**
 * Puts `binDir` first in the `Path` of the user, unless it is already there. The value it had is
 * kept in a file next to the folder (`path-backup-<suffix>.txt`) before anything changes.
 */
export async function addToUserPath(
    binDir: string,
    run: PowerShellRunner,
    suffix: string,
): Promise<{ change: 'created' | 'updated' | 'unchanged'; backup?: string }> {
    const current = await readUserPath(run);
    const entries = current.split(';').filter((entry) => entry.trim() !== '');
    if (entries.some((entry) => pathKey(entry) === pathKey(binDir))) return { change: 'unchanged' };
    let backup: string | undefined;
    if (current !== '') {
        backup = join(dirname(binDir), `path-backup-${suffix}.txt`);
        await mkdir(dirname(backup), { recursive: true });
        await writeFile(backup, `${current}\r\n`);
    }
    await writeUserPath(run, [binDir, ...entries].join(';'));
    return { change: current === '' ? 'created' : 'updated', ...(backup && { backup }) };
}

/** The same step by hand, for a terminal without a person (an agent, a script). */
export function pathCommand(binDir: string): string {
    const folder = binDir.replaceAll("'", "''");
    return `[Environment]::SetEnvironmentVariable('Path', '${folder};' + [Environment]::GetEnvironmentVariable('Path','User'), 'User')`;
}

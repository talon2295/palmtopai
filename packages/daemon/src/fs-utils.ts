import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdir, open, rename, rm, writeFile } from 'node:fs/promises';

export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** Runs a program without a shell and gives its output; rejects if it fails. */
export type CommandRunner = (file: string, args: string[]) => Promise<string>;

const runCommand: CommandRunner = (file, args) =>
    new Promise((resolve, reject) => {
        execFile(file, args, { timeout: 10_000, windowsHide: true }, (error, stdout) =>
            error ? reject(error) : resolve(stdout),
        );
    });

export interface PrivateDirOptions {
    platform?: NodeJS.Platform;
    run?: CommandRunner;
    /**
     * Windows: the ACL is set only with this: a file that records the folder was dealt with,
     * however it went. (Not "when the folder is new": `install.ps1` has often made it already.)
     */
    marker?: string;
}

export interface PrivateDirResult {
    /** The folder did not exist: it is new. */
    created: boolean;
    /** Windows: why the folder could not be limited to the user (it stays usable). */
    aclError?: string;
}

/**
 * Creates a directory readable only by the current user (also tightens an existing one). On
 * Windows, where the mode means nothing, a folder given a `marker` gets an ACL for the user and
 * SYSTEM alone, the first time the marker is not there, and without ever failing the caller
 * (`aclError` says what went wrong).
 */
export async function ensurePrivateDir(
    path: string,
    options: PrivateDirOptions = {},
): Promise<PrivateDirResult> {
    const first = await mkdir(path, { recursive: true, mode: PRIVATE_DIR_MODE });
    await chmod(path, PRIVATE_DIR_MODE);
    const created = first !== undefined;
    if ((options.platform ?? process.platform) !== 'win32') return { created };
    const { marker } = options;
    if (!marker || (await exists(marker))) return { created };
    let aclError: string | undefined;
    try {
        await restrictToUser(path, options.run ?? runCommand);
    } catch (error) {
        aclError = error instanceof Error ? error.message : String(error);
    }
    // Recorded also when it failed: the note is for the first time only, not for every command.
    if (marker)
        await writeFile(marker, aclError ? 'not restricted\n' : 'restricted\n').catch(() => {});
    return { created, ...(aclError && { aclError }) };
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/**
 * `icacls`: no inherited permissions, full control for the user and for SYSTEM. The user is given
 * by SID (`whoami /user`), which does not depend on the language of Windows or on the name.
 */
export async function restrictToUser(path: string, run: CommandRunner): Promise<void> {
    const who = await run('whoami', ['/user', '/fo', 'csv', '/nh']);
    const sid = who.match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!sid) throw new Error('could not read the SID of the user');
    await run('icacls', [
        path,
        '/inheritance:r',
        '/grant:r',
        `*${sid}:(OI)(CI)F`,
        '/grant:r',
        '*S-1-5-18:(OI)(CI)F',
    ]);
}

/** Error codes of a rename that fails because another program (an indexer, Defender) has the file. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
/** Waits between attempts, about a second in all. */
const RENAME_BACKOFF_MS = [10, 25, 50, 100, 200, 400];

export interface RenameOptions {
    platform?: NodeJS.Platform;
    rename?: (from: string, to: string) => Promise<void>;
    sleep?: (ms: number) => Promise<void>;
}

/**
 * `rename`, tried again for a short while on Windows when the file is busy: there a program that
 * is reading the file blocks the replacement, and a moment later it works. Elsewhere a failure is
 * a real one and comes out at once.
 */
export async function renameWithRetry(
    from: string,
    to: string,
    options: RenameOptions = {},
): Promise<void> {
    const platform = options.platform ?? process.platform;
    const move = options.rename ?? rename;
    const wait = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
        try {
            return await move(from, to);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            const delay = RENAME_BACKOFF_MS[attempt];
            if (platform !== 'win32' || !BUSY_CODES.has(code) || delay === undefined) throw error;
            await wait(delay);
        }
    }
}

/** Writes to a temp file, fsyncs it and renames it over `path`: readers never see a partial file. */
export async function writeFileAtomic(
    path: string,
    data: string | Uint8Array,
    mode = PRIVATE_FILE_MODE,
): Promise<void> {
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        const handle = await open(tmp, 'wx', mode);
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await renameWithRetry(tmp, path);
    } catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}

/** Appends and fsyncs, so an acknowledged write survives a crash. */
export async function appendFileDurable(path: string, data: string): Promise<void> {
    const handle = await open(path, 'a', PRIVATE_FILE_MODE);
    try {
        await handle.appendFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export function isErrnoException(error: unknown, code: string): boolean {
    return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

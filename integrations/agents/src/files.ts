import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

/** What an install did to one file. */
export interface FileChange {
    path: string;
    change: 'created' | 'updated' | 'unchanged';
    backup?: string;
}

export async function readIfExists(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

export async function exists(path: string): Promise<boolean> {
    return stat(path).then(
        () => true,
        () => false,
    );
}

/**
 * Writes a file that palmtop owns (a skill, a rules file): unchanged content is left alone, a
 * different one is backed up first.
 */
export async function writeOwnedFile(
    path: string,
    content: string,
    suffix: string,
): Promise<FileChange> {
    const current = await readIfExists(path);
    if (current === content) return { path, change: 'unchanged' };

    await mkdir(dirname(path), { recursive: true });
    const backup = current === null ? undefined : await backupFile(path, suffix);
    await writeAtomic(path, content);
    return { path, change: current === null ? 'created' : 'updated', ...(backup && { backup }) };
}

export function backupSuffix(now: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `palmtop-backup-${date}-${time}`;
}

export async function backupFile(path: string, suffix: string): Promise<string> {
    let backup = `${path}.${suffix}`;
    for (let n = 2; await exists(backup); n++) backup = `${path}.${suffix}-${n}`;
    await copyFile(path, backup);
    return backup;
}

/**
 * `rename`, tried again for about a second on Windows when another program has the file open
 * (an editor, Defender, the indexer). Elsewhere a failure comes out at once.
 */
async function renameBusy(from: string, to: string): Promise<void> {
    const waits = [10, 25, 50, 100, 200, 400];
    for (let attempt = 0; ; attempt++) {
        try {
            return await rename(from, to);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code ?? '';
            const wait = waits[attempt];
            if (process.platform !== 'win32' || wait === undefined) throw error;
            if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
    }
}

/** Temp file + rename, keeping the permissions of the file it replaces. */
export async function writeAtomic(path: string, content: string): Promise<void> {
    const mode = await stat(path).then(
        (info) => info.mode & 0o777,
        () => 0o644,
    );
    const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
        const handle = await open(tmp, 'wx', mode);
        try {
            await handle.writeFile(content);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await renameBusy(tmp, path);
    } catch (error) {
        await rm(tmp, { force: true });
        throw error;
    }
}

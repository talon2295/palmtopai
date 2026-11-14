import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, stat } from 'node:fs/promises';
import { isErrnoException, PRIVATE_FILE_MODE, writeFileAtomic } from './fs-utils';

/** Random secret, URL-safe (pairing keys, pairing codes and the local key). */
export function generateSecret(bytes = 32): string {
    return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison that also hides the length of the expected secret. */
export function secretsEqual(provided: string, expected: string): boolean {
    const a = createHash('sha256').update(provided).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
}

/** Reads the Local API key, creating it (mode 600) on first run and fixing loose permissions. */
export async function loadOrCreateLocalKey(path: string): Promise<string> {
    try {
        const key = (await readFile(path, 'utf8')).trim();
        // Windows has no permission bits: the folder of the key is limited by its ACL.
        if (process.platform !== 'win32' && (await stat(path)).mode & 0o077) {
            await chmod(path, PRIVATE_FILE_MODE);
        }
        if (key.length >= 32) return key;
    } catch (error) {
        if (!isErrnoException(error, 'ENOENT')) throw error;
    }
    const key = generateSecret();
    await writeFileAtomic(path, `${key}\n`);
    return key;
}

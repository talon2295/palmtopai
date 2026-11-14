import { readFile, rm } from 'node:fs/promises';
import type { Paths } from './config';
import { isErrnoException, writeFileAtomic } from './fs-utils';
import { REGISTRY_VERSION } from './registry';

/** `projects.json` of phase 10 to 19: the computer had a token that every device knew. */
const TOKEN_REGISTRY_VERSION = 2;

/**
 * Brings the home directory of an older version up to date, before anything reads it. Returns
 * what happened: `reset` (data wiped), `migrated` (data kept), or `null` (nothing to do).
 *
 * - Version 1 (devices paired with one project): nothing can be carried over to the computer
 *   pairing of phase 10, so projects, checklists and push subscriptions go.
 * - Version 2 (a computer token, phase 10): end-to-end encryption replaces the token with a key
 *   per device (phase 20). Projects and checklists stay; the token and the push subscriptions,
 *   which belonged to devices without a key, go. Every device pairs again.
 *
 * `config.json` (port and computer name) and the local key always stay: they are not part of the
 * pairing.
 */
export async function resetOutdatedHome(
    paths: Paths,
    log: (line: string) => void,
): Promise<'reset' | 'migrated' | null> {
    let raw: string;
    try {
        raw = await readFile(paths.projects, 'utf8');
    } catch (error) {
        // No registry yet: nothing to reset. Anything else is left to the registry to report.
        if (isErrnoException(error, 'ENOENT')) return null;
        return null;
    }

    let file: { version?: unknown; computer?: unknown; projects?: unknown };
    try {
        file = JSON.parse(raw) as typeof file;
    } catch {
        // Unreadable file: never destroy data on a guess, the registry reports it instead.
        return null;
    }
    const { version } = file;
    if (typeof version !== 'number' || version >= REGISTRY_VERSION) return null;

    if (version === TOKEN_REGISTRY_VERSION && isTokenComputer(file.computer)) {
        const { token: _, ...computer } = file.computer;
        const migrated = { version: REGISTRY_VERSION, computer, projects: file.projects };
        await writeFileAtomic(paths.projects, `${JSON.stringify(migrated, null, 4)}\n`);
        await rm(paths.push, { force: true });
        log(
            'palmtop is now end-to-end encrypted: your projects and checklists are kept, but every device has to pair again. Run `palmtop pair`.',
        );
        return 'migrated';
    }

    await rm(paths.projects, { force: true });
    await rm(paths.push, { force: true });
    await rm(paths.data, { recursive: true, force: true });
    log(
        `projects.json is from an older version (${version}): this palmtop pairs devices with the computer, so its data was reset. Run \`palmtop pair\` to pair your devices again.`,
    );
    return 'reset';
}

function isTokenComputer(value: unknown): value is { token: unknown; [key: string]: unknown } {
    return typeof value === 'object' && value !== null && 'token' in value;
}

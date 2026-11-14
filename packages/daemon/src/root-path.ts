import { posix, win32 } from 'node:path';

function api(platform: NodeJS.Platform) {
    return platform === 'win32' ? win32 : posix;
}

/**
 * The folder of a project as the system writes it: absolute, with its own separators and no
 * separator at the end (the drive `C:\` and `/` keep theirs). Git reports `C:/Users/ada/repo` on
 * Windows; the registry and the CLI both go through here, so they agree on what a path looks like.
 */
export function normalizeRoot(rootPath: string, platform: NodeJS.Platform = process.platform) {
    const normalized = api(platform).resolve(rootPath);
    const root = api(platform).parse(normalized).root;
    if (normalized.length <= root.length) return normalized;
    return normalized.replace(platform === 'win32' ? /[\\/]+$/ : /\/+$/, '');
}

/**
 * What identifies a folder. Windows ignores the case of names (`C:\Work\Repo` and `c:\work\repo`
 * are the same folder), so there the case is folded; the path shown keeps the case it was first
 * given. macOS and Linux compare as they are.
 */
export function rootKey(rootPath: string, platform: NodeJS.Platform = process.platform): string {
    const normalized = normalizeRoot(rootPath, platform);
    return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function sameRoot(a: string, b: string, platform: NodeJS.Platform = process.platform) {
    return rootKey(a, platform) === rootKey(b, platform);
}

/** Name of the folder, with the rules of the system the path comes from. */
export function rootName(rootPath: string, platform: NodeJS.Platform = process.platform) {
    return api(platform).basename(rootPath) || rootPath;
}

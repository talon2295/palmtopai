import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { normalizeRoot } from '@palmtopai/daemon';

function git(cwd: string, args: string[]): string | null {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    const output = result.stdout?.trim();
    return result.status === 0 && output ? output : null;
}

/** Drops credentials from remote URLs such as `https://user:token@host/repo.git`. */
export function sanitizeRemote(remote: string): string | undefined {
    const trimmed = remote.trim();
    if (!trimmed) return undefined;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        try {
            const url = new URL(trimmed);
            url.username = '';
            url.password = '';
            url.search = '';
            url.hash = '';
            return url.toString();
        } catch {
            return undefined;
        }
    }
    // scp-like syntax (git@host:owner/repo.git) carries no secret.
    return /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(trimmed) ? trimmed : undefined;
}

export interface ProjectContext {
    rootPath: string;
    gitRemote?: string;
    branch?: string;
}

/** Project identity = git top-level directory, falling back to the directory itself. */
export function detectProject(directory: string): ProjectContext {
    const dir = resolve(directory);
    // Git writes `C:/Users/ada/repo` on Windows: the path is the system's own, like the registry's.
    const rootPath = normalizeRoot(git(dir, ['rev-parse', '--show-toplevel']) ?? dir);
    const remote = git(rootPath, ['config', '--get', 'remote.origin.url']);
    // symbolic-ref also works on a branch without commits, and fails on a detached HEAD.
    const branch = git(rootPath, ['symbolic-ref', '--short', '-q', 'HEAD']);
    const gitRemote = remote ? sanitizeRemote(remote) : undefined;
    return {
        rootPath,
        ...(gitRemote && { gitRemote }),
        ...(branch && { branch }),
    };
}

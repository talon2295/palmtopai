import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    CLI_BUNDLE_FILE,
    CLI_RELEASE_FILE,
    type CliRelease,
    cliReleaseSchema,
} from '@palmtopai/protocol';
import { SECURITY_HEADERS } from './static';

/** Reads `version.json` of the built CLI. A missing or invalid build publishes nothing. */
export function loadCliRelease(cliRoot: string, log: (line: string) => void): CliRelease | null {
    let raw: string;
    try {
        raw = readFileSync(join(cliRoot, CLI_RELEASE_FILE), 'utf8');
    } catch {
        log(`no CLI build in ${cliRoot}: palmtop downloads are disabled`);
        return null;
    }
    try {
        const release = cliReleaseSchema.parse(JSON.parse(raw));
        log(`serving palmtop ${release.version} (build ${release.build})`);
        return release;
    } catch {
        log(`invalid ${CLI_RELEASE_FILE} in ${cliRoot}: palmtop downloads are disabled`);
        return null;
    }
}

const CLI_FILES: Record<string, { file: string; type: string }> = {
    [`/${CLI_BUNDLE_FILE}`]: { file: CLI_BUNDLE_FILE, type: 'text/javascript; charset=utf-8' },
    [`/${CLI_RELEASE_FILE}`]: { file: CLI_RELEASE_FILE, type: 'application/json' },
};

/** The CLI bundle and its manifest, always revalidated: they change with every deploy. */
export async function serveCliFile(
    pathname: string,
    cliRoot: string | undefined,
): Promise<Response | null> {
    const entry = CLI_FILES[pathname];
    if (!entry) return null;
    const file = cliRoot ? Bun.file(join(cliRoot, entry.file)) : null;
    if (!file || !(await file.exists())) {
        return new Response('palmtop is not published on this relay', {
            status: 404,
            headers: SECURITY_HEADERS,
        });
    }
    return new Response(file, {
        headers: { 'content-type': entry.type, 'cache-control': 'no-cache', ...SECURITY_HEADERS },
    });
}

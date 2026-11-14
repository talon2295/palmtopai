import { createHash } from 'node:crypto';
import { chmod, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { type BuildInfo, renameWithRetry } from '@palmtopai/daemon';
import {
    CLI_BUNDLE_FILE,
    CLI_RELEASE_FILE,
    type CliRelease,
    cliReleaseSchema,
} from '@palmtopai/protocol';
import { CliError } from './daemon-client';

export type UpdateResult =
    | { status: 'up-to-date'; release: CliRelease }
    | { status: 'updated'; release: CliRelease; path: string };

export interface UpdateOptions {
    /** Script of the running CLI (`process.argv[1]`, possibly a symlink to the bundle). */
    entry: string;
    /** Web URL of the relay (`https://host`), which publishes the bundle and `version.json`. */
    webUrl: string;
    current: BuildInfo;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

/**
 * Replaces the running bundle with the one published on the relay, if its build differs.
 * The download is checked against the size and sha256 of `version.json` and moved into place
 * atomically: on any failure the installed palmtop is left untouched.
 */
export async function updateCli(options: UpdateOptions): Promise<UpdateResult> {
    const { webUrl, current } = options;
    const request = options.fetch ?? fetch;
    const timeoutMs = options.timeoutMs ?? 60_000;
    if (current.build === 'dev') {
        throw new CliError('palmtop update works on the downloaded palmtop, not on the sources');
    }
    const path = await realpath(options.entry);
    if (basename(path) !== CLI_BUNDLE_FILE) {
        throw new CliError(`palmtop update expects the bundle ${CLI_BUNDLE_FILE}, found ${path}`);
    }

    const get = async (name: string): Promise<Response> => {
        let response: Response;
        try {
            response = await request(`${webUrl}/${name}`, {
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (error) {
            throw new CliError(`cannot reach ${webUrl} (${(error as Error).message})`);
        }
        if (!response.ok) {
            throw new CliError(`${webUrl} does not publish palmtop (HTTP ${response.status})`);
        }
        return response;
    };

    const parsed = cliReleaseSchema.safeParse(
        await (await get(CLI_RELEASE_FILE)).json().catch(() => null),
    );
    if (!parsed.success) throw new CliError(`invalid ${CLI_RELEASE_FILE} on ${webUrl}`);
    const release = parsed.data;
    if (release.build === current.build) return { status: 'up-to-date', release };

    const bundle = new Uint8Array(await (await get(CLI_BUNDLE_FILE)).arrayBuffer());
    const digest = createHash('sha256').update(bundle).digest('hex');
    if (bundle.length !== release.size || digest !== release.sha256) {
        throw new CliError(
            `the downloaded palmtop does not match ${CLI_RELEASE_FILE} (size or sha256): nothing was changed`,
        );
    }

    const temporary = join(dirname(path), `.${CLI_BUNDLE_FILE}.${process.pid}.tmp`);
    try {
        await writeFile(temporary, bundle, { mode: 0o755 });
        await chmod(temporary, 0o755);
        await renameWithRetry(temporary, path);
    } catch (error) {
        await rm(temporary, { force: true });
        throw new CliError(`cannot replace ${path} (${(error as NodeJS.ErrnoException).code})`);
    }
    return { status: 'updated', release, path };
}

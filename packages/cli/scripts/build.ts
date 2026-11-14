#!/usr/bin/env bun
/**
 * Bundles the CLI (with the daemon, the protocol and the skill) into one JavaScript file for
 * Node ≥ 22: `packages/cli/dist/palmtop.mjs`, plus `version.json` (version, build id, sha256,
 * size) that the relay publishes for `palmtop update`. No runtime dependencies are left to install.
 *
 * Only code from this repository goes in, so every machine builds the same bundle: a package found
 * only in a `node_modules` above it (a global tool in the home of a server, say) counts as missing.
 */
import { createHash } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { CLI_BUNDLE_FILE, CLI_RELEASE_FILE, type CliRelease } from '@palmtopai/protocol';
import type { BunPlugin } from 'bun';
import pkg from '../package.json' with { type: 'json' };

export const CLI_ENTRY = join(import.meta.dir, '..', 'src', 'main.ts');
export const DIST_DIR = join(import.meta.dir, '..', 'dist');
/** The root of the repository: nothing outside it goes in the bundle. */
export const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

const MISSING = 'missing-package';

/**
 * A package that is not in `root` gets a module that throws "Cannot require module", whether it is
 * nowhere or only in a `node_modules` above `root`: the bundle is the same on every machine, and an
 * optional `require` in a `try` (like the one of `supports-color` in `debug`) goes on without it.
 */
export function insideRepoOnly(root: string): BunPlugin {
    return {
        name: 'inside-repo-only',
        setup(build) {
            // Package names only: no relative paths and no `node:` modules.
            build.onResolve({ filter: /^(?!node:)[^./]/ }, (args) => {
                if (!args.importer || isBuiltin(args.path)) return undefined;
                let resolved: string;
                try {
                    resolved = Bun.resolveSync(args.path, dirname(args.importer));
                } catch {
                    return { path: args.path, namespace: MISSING };
                }
                if (!isAbsolute(resolved) || isInside(root, resolved)) return undefined;
                return { path: args.path, namespace: MISSING };
            });
            build.onLoad({ filter: /.*/, namespace: MISSING }, (args) => ({
                contents: `throw new Error(${JSON.stringify(`Cannot require module ${args.path}`)});`,
                loader: 'js',
            }));
        },
    };
}

function isInside(root: string, path: string): boolean {
    const rel = relative(root, path);
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}

/** Every module of the bundle keeps a `// <path>` comment, relative to the repository. */
export function assertInsideRepo(bundle: string): void {
    const outside = bundle.match(/^\/\/ \.\.\/.*$/m);
    if (outside) {
        throw new Error(`CLI bundle includes a module from outside the repository: ${outside[0]}`);
    }
}

/** Stands for the build id in the first pass: the id is the hash of the bundle that contains it. */
const BUILD_PLACEHOLDER = '__palmtop_build_placeholder__';

const sha256 = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');

/** `version` overrides the package version (tests build a "newer" CLI). */
export async function buildCli(
    outdir = DIST_DIR,
    options: { version?: string } = {},
): Promise<string> {
    const version = options.version ?? pkg.version;
    const result = await Bun.build({
        entrypoints: [CLI_ENTRY],
        outdir,
        target: 'node',
        format: 'esm',
        naming: CLI_BUNDLE_FILE,
        minify: false,
        sourcemap: 'none',
        banner: '#!/usr/bin/env node',
        plugins: [insideRepoOnly(REPO_ROOT)],
        define: {
            __PALMTOP_VERSION__: JSON.stringify(version),
            __PALMTOP_BUILD__: JSON.stringify(BUILD_PLACEHOLDER),
        },
    });
    if (!result.success) {
        throw new Error(`CLI build failed:\n${result.logs.map(String).join('\n')}`);
    }
    const file = join(outdir, CLI_BUNDLE_FILE);
    const draft = await readFile(file, 'utf8');
    if (!draft.includes(BUILD_PLACEHOLDER)) throw new Error('CLI build id placeholder not found');
    assertInsideRepo(draft);
    // Same sources and bun version → same build id.
    const build = sha256(draft).slice(0, 12);
    const bundle = Buffer.from(draft.replaceAll(BUILD_PLACEHOLDER, build));
    await writeFile(file, bundle);
    await chmod(file, 0o755);

    const release: CliRelease = {
        version,
        build,
        sha256: sha256(bundle),
        size: bundle.length,
    };
    await writeFile(join(outdir, CLI_RELEASE_FILE), `${JSON.stringify(release, null, 4)}\n`);
    return file;
}

if (import.meta.main) {
    // Files are overwritten in place: deleting dist would break a `bun link`ed palmtop.
    const file = await buildCli();
    const release = JSON.parse(await readFile(join(DIST_DIR, CLI_RELEASE_FILE), 'utf8'));
    console.log(`built ${file} (palmtop ${release.version}, build ${release.build})`);
}

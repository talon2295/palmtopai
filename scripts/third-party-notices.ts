#!/usr/bin/env bun
/**
 * Writes `THIRD_PARTY_NOTICES.md`: the packages palmtop ships, with version, license, source and
 * the text of the license. Two sources:
 *
 * - the CLI bundle (`packages/cli/dist/palmtop.mjs`): `Bun.build` does not minify it, so every
 *   module keeps its `// node_modules/…` comment, which names the package and its version;
 * - the production dependencies of the web app (`apps/web/package.json`), with the ones they
 *   depend on in turn. The site (Astro) ships only HTML and CSS.
 *
 *   bun run build:cli && bun run notices
 */
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const ROOT = join(import.meta.dir, '..');
export const NOTICES_FILE = join(ROOT, 'THIRD_PARTY_NOTICES.md');
const BUNDLE_FILE = join(ROOT, 'packages', 'cli', 'dist', 'palmtop.mjs');
const WORKSPACE_SCOPE = '@palmtopai/';

export type Usage = 'cli' | 'app';

export interface PackageNotice {
    name: string;
    version: string;
    license: string;
    source: string;
    text: string;
    usedIn: Usage[];
}

/** The package folders named by the `// node_modules/…` comments of a bundle, as real paths. */
export function bundlePackageDirs(bundle: string, root = ROOT): string[] {
    const dirs = new Set<string>();
    for (const match of bundle.matchAll(/^\/\/ (node_modules\/\S+)$/gm)) {
        const path = match[1] ?? '';
        const at = path.lastIndexOf('node_modules/') + 'node_modules/'.length;
        const parts = path.slice(at).split('/');
        const name = parts[0]?.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? '');
        dirs.add(realpathSync(join(root, path.slice(0, at), name)));
    }
    return [...dirs];
}

/** Node's lookup: `<dir>/node_modules/<name>`, then the same from each parent folder. */
function resolvePackage(name: string, from: string): string | undefined {
    for (let dir = from; ; dir = dirname(dir)) {
        if (basename(dir) !== 'node_modules') {
            const candidate = join(dir, 'node_modules', name);
            if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate);
        }
        if (dirname(dir) === dir) return undefined;
    }
}

function readJson(path: string): Record<string, unknown> {
    return JSON.parse(readFileSync(path, 'utf8'));
}

/** The production dependencies of a workspace, followed through the packages they depend on. */
export function dependencyDirs(workspace: string): string[] {
    const found = new Set<string>();
    const visit = (dir: string) => {
        const deps = (readJson(join(dir, 'package.json')).dependencies ?? {}) as Record<
            string,
            string
        >;
        for (const name of Object.keys(deps)) {
            const resolved = resolvePackage(name, dir);
            if (!resolved) continue;
            if (name.startsWith(WORKSPACE_SCOPE)) {
                visit(resolved);
            } else if (!found.has(resolved)) {
                found.add(resolved);
                visit(resolved);
            }
        }
    };
    visit(workspace);
    return [...found];
}

/** A web address for the `repository` field of a package.json, in any of its forms. */
export function repositoryUrl(repository: unknown): string | undefined {
    const raw =
        typeof repository === 'string'
            ? repository
            : typeof repository === 'object' && repository && 'url' in repository
              ? String(repository.url)
              : undefined;
    if (!raw) return undefined;
    const url = raw
        .replace(/^git\+/, '')
        .replace(/^git:\/\//, 'https://')
        .replace(/^git@github\.com:/, 'https://github.com/')
        .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
        .replace(/^github:/, 'https://github.com/')
        .replace(/\.git$/, '')
        .replace(/\/$/, '');
    if (/^[\w.-]+\/[\w.-]+$/.test(url)) return `https://github.com/${url}`;
    return url;
}

function licenseOf(pkg: Record<string, unknown>): string {
    const license = pkg.license;
    if (typeof license === 'string') return license;
    if (typeof license === 'object' && license && 'type' in license) return String(license.type);
    if (Array.isArray(pkg.licenses)) {
        return pkg.licenses.map((l: { type?: string }) => l.type ?? 'UNKNOWN').join(' OR ');
    }
    return 'UNKNOWN';
}

function licenseText(dir: string): string {
    const files = readdirSync(dir)
        .filter((file) => /^(licen[cs]e|copying)/i.test(file))
        .sort();
    return files
        .map((file) => readFileSync(join(dir, file), 'utf8').replaceAll('\r\n', '\n').trim())
        .join('\n\n');
}

export function readNotice(dir: string, usedIn: Usage[]): PackageNotice {
    const pkg = readJson(join(dir, 'package.json'));
    const name = String(pkg.name);
    return {
        name,
        version: String(pkg.version),
        license: licenseOf(pkg),
        source:
            repositoryUrl(pkg.repository) ??
            (typeof pkg.homepage === 'string' ? pkg.homepage : undefined) ??
            `https://www.npmjs.com/package/${name}`,
        text: licenseText(dir),
        usedIn,
    };
}

/** Every shipped package once, sorted by name and version. */
export function collectNotices(bundle: string, root = ROOT): PackageNotice[] {
    const usage = new Map<string, Set<Usage>>();
    const add = (dir: string, use: Usage) => {
        const set = usage.get(dir) ?? new Set<Usage>();
        set.add(use);
        usage.set(dir, set);
    };
    for (const dir of bundlePackageDirs(bundle, root)) add(dir, 'cli');
    for (const dir of dependencyDirs(join(root, 'apps', 'web'))) add(dir, 'app');
    return [...usage]
        .map(([dir, uses]) =>
            readNotice(
                dir,
                (['cli', 'app'] as const).filter((u) => uses.has(u)),
            ),
        )
        .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

const USAGE_LABEL: Record<Usage, string> = { cli: 'CLI', app: 'web app' };

/** A fence longer than any run of backticks in the text. */
function fence(text: string): string {
    const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
    return '`'.repeat(longest + 1);
}

export function renderNotices(notices: PackageNotice[]): string {
    const lines = [
        '# Third-party notices',
        '',
        'palmtop ships code from the open source packages below. The `palmtop` CLI bundles them into',
        'one file, and the web app includes them in its build. Each package is listed with its',
        'version, license and source, followed by the text of its license.',
        '',
        'This file is generated by `bun run notices` (after `bun run build:cli`).',
        '',
        '| Package | Version | License | Used in |',
        '|---|---|---|---|',
        ...notices.map(
            (n) =>
                `| [${n.name}](#${anchor(n)}) | ${n.version} | ${n.license} | ${n.usedIn.map((u) => USAGE_LABEL[u]).join(', ')} |`,
        ),
    ];
    for (const n of notices) {
        lines.push(
            '',
            `## ${n.name} ${n.version}`,
            '',
            `License: ${n.license}. Source: ${n.source}`,
        );
        if (/^MPL-/.test(n.license)) {
            lines.push(
                '',
                `The Source Code Form of this package is available at ${n.source}; palmtop ships it unmodified.`,
            );
        }
        if (n.text) {
            const f = fence(n.text);
            lines.push('', `${f}text`, n.text, f);
        } else {
            lines.push('', 'The package has no license file; its license is the one named above.');
        }
    }
    return `${lines.join('\n')}\n`;
}

/** GitHub's heading anchors: lower case, spaces to dashes, most punctuation dropped. */
function anchor(n: PackageNotice): string {
    return `${n.name} ${n.version}`
        .toLowerCase()
        .replace(/[^\w\- ]/g, '')
        .replaceAll(' ', '-');
}

if (import.meta.main) {
    if (!existsSync(BUNDLE_FILE)) {
        console.error('error: the CLI bundle is missing, run `bun run build:cli` first');
        process.exit(1);
    }
    const notices = collectNotices(readFileSync(BUNDLE_FILE, 'utf8'));
    await writeFile(NOTICES_FILE, renderNotices(notices));
    console.log(`wrote ${NOTICES_FILE} (${notices.length} packages)`);
}

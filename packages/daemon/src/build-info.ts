/** Replaced by `bun build` in the CLI bundle (packages/cli/scripts/build.ts). */
declare const __PALMTOP_VERSION__: string | undefined;
declare const __PALMTOP_BUILD__: string | undefined;

export interface BuildInfo {
    /** Version of `packages/cli/package.json`, or `dev` when run from sources. */
    version: string;
    /** First 12 hex chars of the bundle's sha256, or `dev` when run from sources. */
    build: string;
}

export const BUILD_INFO: BuildInfo = {
    version: typeof __PALMTOP_VERSION__ === 'string' ? __PALMTOP_VERSION__ : 'dev',
    build: typeof __PALMTOP_BUILD__ === 'string' ? __PALMTOP_BUILD__ : 'dev',
};

import { z } from 'zod';

/**
 * Version of the protocols between daemon, relay and web app (relay auth and device sync).
 * Bump it on a breaking change and raise `MIN_DAEMON_PROTOCOL` when old daemons must update.
 * Protocol 4 (phase 20b) adds `origin` to checklists and items, the copies shared with guests:
 * an older app drops the field, so it is not a reason to refuse a daemon (`MIN_DAEMON_PROTOCOL`).
 * Protocol 5 (0.20) archives sessions (`session.archive`, the `archive` message): the app offers
 * the archive only to daemons that know it. An older app cannot read the op: its hello does not
 * say `archive`, and a catch-up holding one reaches it as a snapshot instead.
 * Protocol 6 (0.23) stores screenshots on the computer (`image.put`, `image.get`): the app offers
 * them only to daemons that know the messages, which an older one answers with `invalid_message`.
 * Protocol 7 (0.24) lets the user mark a session done from a device (`session.done`): the app
 * offers it only to daemons that know it. Like `session.archive`, an older app cannot read the op:
 * its hello does not say `done`, and a catch-up holding one reaches it as a snapshot instead.
 * Protocol 8 (0.24) tells the devices which sessions an agent is waiting in (`waiting`): the app
 * lights the Review done button only for those, and for any computer that does not say, as before.
 */
export const DAEMON_PROTOCOL_VERSION = 8;

/**
 * Oldest daemon protocol the relay accepts and the web app works with. Daemons that do not send
 * a version are protocol 1. Protocol 2 (phase 10) paired devices with the computer instead of one
 * project; protocol 3 (phase 20) is end-to-end encrypted, with no token: an older daemon cannot
 * serve this app at all.
 */
export const MIN_DAEMON_PROTOCOL = 3;

/** True when the daemon is too old for this relay or web app: its user must run `palmtop update`. */
export function isDaemonOutdated(protocol: number | undefined, min = MIN_DAEMON_PROTOCOL): boolean {
    return (protocol ?? 1) < min;
}

/** Build id of a CLI bundle: the first 12 hex chars of its sha256. `dev` when run from sources. */
export const buildIdSchema = z.string().regex(/^([0-9a-f]{12}|dev)$/, 'invalid build id');

/** `version.json` published next to the CLI bundle on the relay. */
export const cliReleaseSchema = z.object({
    version: z.string().regex(/^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/, 'invalid version'),
    build: z.string().regex(/^[0-9a-f]{12}$/, 'invalid build id'),
    sha256: z.string().regex(/^[0-9a-f]{64}$/, 'invalid sha256'),
    size: z.number().int().positive(),
});

export type CliRelease = z.infer<typeof cliReleaseSchema>;

/** File names of the CLI bundle and its release manifest, on the relay and on disk. */
export const CLI_BUNDLE_FILE = 'palmtop.mjs';
export const CLI_RELEASE_FILE = 'version.json';

import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { computerNameSchema, LIMITS } from '@palmtopai/protocol';
import { z } from 'zod';
import { isErrnoException, writeFileAtomic } from './fs-utils';

export const DEFAULT_LOCAL_PORT = 4318;
export const DEFAULT_RELAY_URL = 'wss://palmtop.mtwa.it';

export interface Paths {
    home: string;
    config: string;
    localKey: string;
    projects: string;
    pid: string;
    log: string;
    push: string;
    /** Push subscriptions of the devices of the people checklists are shared with. */
    pushGuests: string;
    /** Devices paired with this computer and their public keys (end-to-end encryption). */
    devices: string;
    /** The people checklists are shared with, and the copies they were given. */
    people: string;
    /** Which elements of the notes of the sessions the agent has read (fingerprints only). */
    noteDelivered: string;
    /** Which "done" of each session the agent has been told about (the op that wrote it). */
    doneDelivered: string;
    /** Screenshots the user attached on a device, a folder for each project. */
    images: string;
    /** Windows: written once the ACL of the home was dealt with, whatever the outcome. */
    acl: string;
    data: string;
}

/** `PALMTOP_HOME` overrides `~/.palmtopai` (used by tests and the demo). */
export function resolveHome(env: Record<string, string | undefined> = process.env): string {
    return env.PALMTOP_HOME ?? join(homedir(), '.palmtopai');
}

export function pathsFor(home: string): Paths {
    return {
        home,
        config: join(home, 'config.json'),
        localKey: join(home, 'local.key'),
        projects: join(home, 'projects.json'),
        pid: join(home, 'daemon.pid'),
        log: join(home, 'daemon.log'),
        push: join(home, 'push.json'),
        pushGuests: join(home, 'push-guests.json'),
        devices: join(home, 'devices.json'),
        people: join(home, 'people.json'),
        noteDelivered: join(home, 'note-delivered.json'),
        doneDelivered: join(home, 'done-delivered.json'),
        images: join(home, 'images'),
        acl: join(home, '.acl'),
        data: join(home, 'data'),
    };
}

const portSchema = z.number().int().min(0).max(65_535);
const relayUrlSchema = z
    .string()
    .regex(/^wss?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/, 'expected ws:// or wss:// URL');

/**
 * Unknown keys are ignored: `devicePort` from the LAN versions, `relayUrl` from before 0.7.2 (the
 * relay is not distributed, so only `PALMTOP_RELAY_URL` changes it, for development).
 */
export const configSchema = z.object({
    /** Local API port, always bound to 127.0.0.1. */
    localPort: portSchema.default(DEFAULT_LOCAL_PORT),
    /** Shown before project names (`palmtop config name`); absent = host name. */
    computerName: computerNameSchema.optional(),
    /** How the copies shared with other people call their owner, until a session says otherwise. */
    ownerName: computerNameSchema.optional(),
});

export type Config = z.infer<typeof configSchema>;

/**
 * The public relay, or `PALMTOP_RELAY_URL` in development and tests (a local relay). Not
 * documented for users: the relay is not distributed yet.
 */
export function resolveRelayUrl(env: Record<string, string | undefined> = process.env): string {
    const override = env.PALMTOP_RELAY_URL;
    if (!override) return DEFAULT_RELAY_URL;
    const parsed = relayUrlSchema.safeParse(override);
    if (!parsed.success) throw new Error(`invalid PALMTOP_RELAY_URL: expected ws:// or wss:// URL`);
    return parsed.data;
}

/** Page URL of the relay (`wss://host` → `https://host`): the site, the downloads. */
export function relayWebUrl(relayUrl: string): string {
    return relayUrl.replace(/^ws/, 'http').replace(/\/+$/, '');
}

/**
 * Origin of the web app, where devices pair and sync: the relay's name with `app.` in front
 * (`wss://palmtop.mtwa.it` → `https://app.palmtop.mtwa.it`), so the app keeps its storage apart
 * from the site. A local relay is `ws://localhost:8787`, the app `http://app.localhost:8787`; an IP
 * address has no such name, and stays as it is (tests).
 */
export function appWebUrl(relayUrl: string): string {
    const url = new URL(relayWebUrl(relayUrl));
    if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) return url.origin;
    return `${url.protocol}//app.${url.host}`;
}

/** Host name without the domain (`Mac-mini.local` → `Mac-mini`), as a valid computer name. */
export function defaultComputerName(host = hostname()): string {
    const name = computerNameSchema.safeParse(
        (host.split('.')[0] ?? '').slice(0, LIMITS.computerName),
    );
    return name.success ? name.data : 'Computer';
}

async function readRawConfig(path: string): Promise<unknown> {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (!isErrnoException(error, 'ENOENT')) {
            throw new Error(`invalid config file ${path}: ${(error as Error).message}`);
        }
        return {};
    }
}

/**
 * Sets (or with `null` removes) a name of config.json, keeping every other key as it is.
 * Returns the validated name.
 */
async function saveName(
    path: string,
    key: 'computerName' | 'ownerName',
    name: string | null,
): Promise<string | null> {
    const raw = await readRawConfig(path);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error(`invalid config file ${path}: expected an object`);
    }
    const { [key]: _previous, ...rest } = raw as Record<string, unknown>;
    const parsed = name === null ? null : computerNameSchema.parse(name);
    const next = parsed === null ? rest : { ...rest, [key]: parsed };
    await writeFileAtomic(path, `${JSON.stringify(next, null, 4)}\n`);
    return parsed;
}

/** `computerName`: how this computer is called on the devices paired with it. */
export function saveComputerName(path: string, name: string | null): Promise<string | null> {
    return saveName(path, 'computerName', name);
}

/** `ownerName`: how the people checklists are shared with call their owner. */
export function saveOwnerName(path: string, name: string | null): Promise<string | null> {
    return saveName(path, 'ownerName', name);
}

export async function loadConfig(path: string): Promise<Config> {
    const raw = await readRawConfig(path);
    const result = configSchema.safeParse(raw);
    if (!result.success) {
        throw new Error(`invalid config file ${path}: ${z.prettifyError(result.error)}`);
    }
    return result.data;
}

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAdaptorServer } from '@hono/node-server';
import { computerNameSchema, normalizePairCode, pairKeySchema } from '@palmtopai/protocol';
import { Hono } from 'hono';
import { z } from 'zod';
import { agentErrorResponse, registerAgentRoutes } from './agent-api';
import type { BuildInfo } from './build-info';
import type { DoneDeliveries, DoneWaiters } from './done-delivery';
import type { ImageStore } from './images';
import type { NoteDeliveries } from './note-delivery';
import { PAIR_PAGE_HEADERS, renderPairError, renderPairPage } from './pair-page';
import type { PairingCodes, PairingConfirmation } from './pairing';
import { type PeopleApiOptions, registerPeopleRoutes } from './people-api';
import type { ProjectRegistry } from './registry';
import type { PairOfferResult, PublishedRelease, RelayStatus } from './relay-link';
import type { RoomManager } from './rooms';
import { secretsEqual } from './secrets';
import type { Sharing } from './sharing';

export const LOCAL_HOST = '127.0.0.1';
export const KEY_HEADER = 'x-palmtop-key';
export const PAIR_PATH = '/pair';

/** A single-use pairing link and what to show next to it. Never leaves 127.0.0.1. */
export interface PairLink {
    computerName: string;
    /** Pairing link on the relay, with room and single-use key in the fragment. */
    url: string;
    /** The key inside `url`, so the caller can revoke it when the QR is closed. */
    key: string;
    expiresAt: number;
    relayHost: string;
    warning?: string;
}

export interface PairPageData extends Omit<PairLink, 'url' | 'key' | 'expiresAt'> {
    /** One link for the QR and one for the button: each key works once. */
    qrUrl: string;
    openUrl: string;
}

/** `palmtop pair CODE`: whether the key reached the device, and how to follow the pairing. */
export interface PairOfferResponse {
    status: PairOfferResult;
    /** Set when delivered: `GET /pair/offers/:id` until the device shows the number. */
    id?: string;
}

/** A paired device, as `palmtop devices` lists it. Public facts only. */
export interface DeviceListEntry {
    deviceId: string;
    name: string;
    pairedAt: number;
    lastSeenAt: number | null;
    connected: boolean;
}

export interface DaemonStatus extends BuildInfo {
    /** `DAEMON_PROTOCOL_VERSION` of the daemon; a daemon older than 0.21 does not report it. */
    protocol: number;
    localPort: number;
    computerName: string;
    /** `release`: the CLI published on the relay, if it announced one. */
    relay: { url: string; status: RelayStatus; release: PublishedRelease | null };
}

export interface LocalApiOptions {
    port: number;
    key: string;
    registry: ProjectRegistry;
    pairingCodes: PairingCodes;
    /** Builds the pairing page content (two single-use links) for this computer. */
    pairPage: () => PairPageData;
    /** A single-use pairing link for the QR shown in the terminal. */
    pairLink: () => PairLink;
    revokePairKey: (key: string) => void;
    /** Sends a single-use pairing key to the phone showing `code` (already normalized). */
    offerPairing: (code: string) => Promise<PairOfferResponse>;
    pairConfirmation: (id: string) => PairingConfirmation | null;
    /** The user's answer after comparing the number. False if there was nothing to decide. */
    confirmPairing: (id: string, accepted: boolean) => boolean;
    listDevices: () => DeviceListEntry[];
    revokeDevice: (deviceId: string) => Promise<boolean>;
    status: () => DaemonStatus;
    /**
     * Stops the daemon cleanly (`palmtop stop`): the same on every system, since Windows has no
     * signal that lets a process save its state. Absent when this daemon is not run by
     * `palmtop serve` (tests, embedded).
     */
    shutdown?: () => void;
    rooms: RoomManager;
    connectedDevices: (projectId: string) => number;
    removeProject: (projectId: string) => Promise<void>;
    sharing: Sharing;
    noteDeliveries: NoteDeliveries;
    doneDeliveries: DoneDeliveries;
    doneWaiters: DoneWaiters;
    /** Tests: how long a request of `palmtop wait` holds before it answers `pending`. */
    waitHoldMs?: number;
    images: ImageStore;
    people: PeopleApiOptions;
    /** Current computer name and the host name used when none is set. */
    computerName: () => { name: string; default: string };
    setComputerName: (name: string | null) => Promise<string>;
}

export interface LocalApi {
    server: Server;
    port: number;
    stop(): Promise<void>;
}

const resolveBodySchema = z.object({
    rootPath: z.string().min(1).max(4096),
    gitRemote: z.string().min(1).max(2048).optional(),
});

const pairKeyBodySchema = z.object({ key: pairKeySchema });
const pairOfferBodySchema = z.object({ code: z.string().max(64) });
const pairDecisionBodySchema = z.object({ accept: z.boolean() });

/** `null` goes back to the host name. */
const computerNameBodySchema = z.object({ name: computerNameSchema.nullable() });

/**
 * REST API for the CLI. Bound to 127.0.0.1 only, on its own listener (never reachable from
 * the LAN interface), and every request needs the local key — except the pairing page, which
 * is opened in a browser and is unlocked by a single-use code instead.
 * JSON responses never contain pairing keys, except `/pair/links` (the terminal QR, shown only on
 * a real terminal); the pairing page carries its links.
 */
export function createLocalApp(options: Omit<LocalApiOptions, 'port'> & { port: () => number }) {
    const app = new Hono();

    app.use('*', async (c, next) => {
        // Rejects DNS-rebinding requests that reach 127.0.0.1 under a foreign host name.
        const port = options.port();
        const host = c.req.header('host');
        if (host !== `${LOCAL_HOST}:${port}` && host !== `localhost:${port}`) {
            return c.json({ error: 'forbidden host' }, 403);
        }
        if (c.req.method === 'GET' && c.req.path === PAIR_PATH) return next();

        const key = c.req.header(KEY_HEADER);
        if (!key || !secretsEqual(key, options.key)) {
            return c.json({ error: 'unauthorized' }, 401);
        }
        await next();
    });

    app.get('/health', (c) => c.json({ ok: true, pid: process.pid, ...options.status() }));

    app.post('/shutdown', (c) => {
        if (!options.shutdown) return c.json({ error: 'this daemon cannot be stopped here' }, 501);
        const { shutdown } = options;
        // After the answer is sent: the daemon closes this very connection.
        setTimeout(shutdown, 0);
        return c.json({ ok: true });
    });

    app.post('/projects/resolve', async (c) => {
        const body = resolveBodySchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
        const { projectId, name, created } = await options.registry.resolve(body.data);
        return c.json({ projectId, name, created });
    });

    /** Like resolve, but never creates a project: read-only commands must not register folders. */
    app.post('/projects/lookup', async (c) => {
        const body = resolveBodySchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
        const found = await options.registry.find(body.data.rootPath);
        return c.json({ project: found && { projectId: found.projectId, name: found.name } });
    });

    app.get('/config/name', (c) => {
        const { name, default: fallback } = options.computerName();
        return c.json({ name, default: fallback });
    });

    app.put('/config/name', async (c) => {
        const body = computerNameBodySchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) {
            return c.json({ error: body.error.issues[0]?.message ?? 'invalid name' }, 400);
        }
        const name = await options.setComputerName(body.data.name);
        return c.json({ name, default: options.computerName().default });
    });

    /** Returns a local URL that opens the pairing page once. Callers must not print it. */
    app.post('/pair/codes', (c) => {
        const { code, expiresAt } = options.pairingCodes.create();
        const url = `http://${LOCAL_HOST}:${options.port()}${PAIR_PATH}?code=${encodeURIComponent(code)}`;
        return c.json({ url, expiresAt });
    });

    /**
     * A single-use pairing link for the caller to show as a QR code in a terminal. The key it
     * carries stops working once used, revoked or expired, and the CLI only ever shows it on a
     * real terminal, never in a pipe or in `--json`.
     */
    app.post('/pair/links', (c) => c.json(options.pairLink()));

    /** Invalidates a key the caller showed but did not use (the QR was closed). */
    app.delete('/pair/links', async (c) => {
        const body = pairKeyBodySchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
        options.revokePairKey(body.data.key);
        return c.json({ revoked: true });
    });

    /**
     * `palmtop pair CODE`: the key goes to the phone through the relay and never comes back here.
     * The answer says whether it arrived and, if so, the id to follow the pairing with.
     */
    app.post('/pair/offer', async (c) => {
        const body = pairOfferBodySchema.safeParse(await c.req.json().catch(() => null));
        const code = body.success ? normalizePairCode(body.data.code) : null;
        if (!code) return c.json({ error: 'invalid pairing code' }, 400);
        return c.json(await options.offerPairing(code));
    });

    /** Where a pairing by code is: once `ready`, the number the device shows. */
    app.get('/pair/offers/:id', (c) => {
        const confirmation = options.pairConfirmation(c.req.param('id'));
        if (!confirmation) return c.json({ error: 'unknown pairing' }, 404);
        return c.json(confirmation);
    });

    /** The user compared the number: the device is registered only with `accept: true`. */
    app.post('/pair/offers/:id', async (c) => {
        const body = pairDecisionBodySchema.safeParse(await c.req.json().catch(() => null));
        if (!body.success) return c.json({ error: z.prettifyError(body.error) }, 400);
        if (!options.confirmPairing(c.req.param('id'), body.data.accept)) {
            return c.json({ error: 'nothing to confirm' }, 409);
        }
        return c.json(options.pairConfirmation(c.req.param('id')));
    });

    app.get('/devices', (c) => c.json({ devices: options.listDevices() }));

    /** Unpairs a device: its key goes, it can't connect any more. */
    app.delete('/devices/:deviceId', async (c) => {
        if (!(await options.revokeDevice(c.req.param('deviceId')))) {
            return c.json({ error: 'unknown device' }, 404);
        }
        return c.json({ removed: true });
    });

    app.get(PAIR_PATH, (c) => {
        const code = c.req.query('code');
        if (!code || !options.pairingCodes.consume(code)) {
            return c.body(renderPairError(), 410, PAIR_PAGE_HEADERS);
        }
        return c.body(renderPairPage(options.pairPage()), 200, PAIR_PAGE_HEADERS);
    });

    registerAgentRoutes(app, {
        registry: options.registry,
        rooms: options.rooms,
        connectedDevices: options.connectedDevices,
        removeProject: options.removeProject,
        sharing: options.sharing,
        noteDeliveries: options.noteDeliveries,
        doneDeliveries: options.doneDeliveries,
        doneWaiters: options.doneWaiters,
        ...(options.waitHoldMs !== undefined && { waitHoldMs: options.waitHoldMs }),
        images: options.images,
    });
    registerPeopleRoutes(app, options.people);

    app.notFound((c) => c.json({ error: 'not found' }, 404));
    app.onError(
        (error, c) => agentErrorResponse(error, c) ?? c.json({ error: 'internal error' }, 500),
    );
    return app;
}

/** Why the local port cannot be used, in words that say what to do. */
function listenError(error: NodeJS.ErrnoException, port: number): Error {
    if (error.code === 'EADDRINUSE') {
        return new Error(
            `local port ${port} is already in use: close the program using it, or set another \`localPort\` in config.json`,
        );
    }
    if (error.code === 'EACCES') {
        return new Error(
            `local port ${port} is not available to this user (on Windows it can be in a range reserved by the system): set another \`localPort\` in config.json`,
        );
    }
    return error;
}

export async function startLocalApi(options: LocalApiOptions): Promise<LocalApi> {
    let port = options.port;
    const app = createLocalApp({ ...options, port: () => port });
    // Keep the global Response untouched (the adapter replaces it by default for speed).
    const server = createAdaptorServer({
        fetch: app.fetch,
        overrideGlobalObjects: false,
    }) as Server;
    await new Promise<void>((resolve, reject) => {
        server.once('error', (error: NodeJS.ErrnoException) =>
            reject(listenError(error, options.port)),
        );
        server.listen(options.port, LOCAL_HOST, () => {
            server.removeAllListeners('error');
            resolve();
        });
    });
    port = (server.address() as AddressInfo).port;
    return {
        server,
        port,
        stop() {
            return new Promise<void>((resolve) => {
                server.close(() => resolve());
                server.closeAllConnections();
            });
        },
    };
}

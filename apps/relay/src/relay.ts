import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
    type CliRelease,
    CloseCode,
    type DaemonMessage,
    FEEDBACK_BODY_MAX_BYTES,
    FEEDBACK_PATH,
    isDaemonOutdated,
    MAX_DAEMON_MESSAGE_BYTES,
    MAX_DEVICE_MESSAGE_BYTES,
    MIN_DAEMON_PROTOCOL,
    PAIR_CODE_ALPHABET,
    PAIR_CODE_LENGTH,
    PAIR_CODE_TTL_MS,
    type PairOfferStatus,
    parseDaemonMessage,
    RELAY_DAEMON_PATH,
    RELAY_DEVICE_PATH,
    RELAY_WAIT_PATH,
    type RelayErrorCode,
    type RelayMessage,
    ROOM_QUERY_PARAM,
    roomIdSchema,
    STATS_ID_QUERY_PARAM,
    statsIdSchema,
    type WaitMessage,
} from '@palmtopai/protocol';
import { randomNonce, verifyRoomProof } from '@palmtopai/protocol/relay-crypto';
import type { Server, ServerWebSocket } from 'bun';
import { loadCliRelease, serveCliFile } from './cli-release';
import { FeedbackStore, receiveFeedback } from './feedback';
import { MessageRate, WindowLimiter } from './rate-limit';
import { isAppHost, SECURITY_HEADERS, serveWebApp } from './static';
import { type Download, type LiveComputer, pageOf, RelayStats, type StatsReport } from './stats';

export interface RelayLimits {
    /** New phone connections per IP per minute. */
    deviceConnectionsPerMinute: number;
    /** New daemon connections per IP per minute. */
    daemonConnectionsPerMinute: number;
    deviceMessagesPerSecond: number;
    daemonMessagesPerSecond: number;
    roomsPerDaemon: number;
    devicesPerRoom: number;
    deviceMessageBytes: number;
    /** Daemon frames carry snapshots for phones: much larger than phone messages. */
    daemonMessageBytes: number;
    handshakeTimeoutMs: number;
    /** Feedback messages per IP per minute. */
    feedbackPerMinute: number;
    /** Phones waiting for a pairing key (`/wait`), in total. */
    waitingPhones: number;
    /** Pairing keys sent by code (`pair.offer`) per daemon IP per minute. */
    pairOffersPerMinute: number;
}

export const DEFAULT_LIMITS: RelayLimits = {
    deviceConnectionsPerMinute: 60,
    daemonConnectionsPerMinute: 20,
    deviceMessagesPerSecond: 30,
    daemonMessagesPerSecond: 1_000,
    roomsPerDaemon: 50,
    devicesPerRoom: 20,
    deviceMessageBytes: MAX_DEVICE_MESSAGE_BYTES,
    daemonMessageBytes: MAX_DAEMON_MESSAGE_BYTES,
    handshakeTimeoutMs: 10_000,
    feedbackPerMinute: 5,
    waitingPhones: 10_000,
    pairOffersPerMinute: 10,
};

export interface RelayOptions {
    hostname?: string;
    port?: number;
    /** Built web app; a placeholder page is served when missing. */
    webRoot?: string;
    /**
     * Built CLI (`packages/cli/dist`): `palmtop.mjs` and `version.json` are served for download
     * and the release is announced to daemons. Read once at start: deploys restart the relay.
     */
    cliRoot?: string;
    /** Oldest daemon protocol accepted (default `MIN_DAEMON_PROTOCOL`). */
    minDaemonProtocol?: number;
    /** Take the client IP from `X-Forwarded-For` (only behind a proxy that overwrites it). */
    trustProxy?: boolean;
    limits?: Partial<RelayLimits>;
    /** Directory of the usage statistics (`stats.json`); without it they live in memory only. */
    dataDir?: string;
    /**
     * Port of the admin listener (`GET /stats`), always bound to 127.0.0.1 so that a reverse
     * proxy in front of the public port never exposes it. 0 picks a free port; absent = none.
     */
    adminPort?: number;
    /** How long a waiting phone keeps its pairing code (default `PAIR_CODE_TTL_MS`). */
    pairCodeTtlMs?: number;
    /** Never receives message contents, pairing codes or keys. */
    log?: (line: string) => void;
}

export interface Relay {
    server: Server<SocketData>;
    port: number;
    /** The CLI served for download, if `cliRoot` holds a valid build. */
    release: CliRelease | null;
    /** Port of the admin listener, `null` without one. */
    adminPort: number | null;
    stats(): { daemons: number; rooms: number; devices: number; waiting: number };
    /** Usage statistics, as served by the admin listener. */
    report(): StatsReport;
    stop(): Promise<void>;
}

interface DeviceData {
    kind: 'device';
    conn: string;
    room: string;
    statsId: string | null;
    rate: MessageRate;
}

interface DaemonData {
    kind: 'daemon';
    ip: string;
    nonce: string;
    sessionToken: string | null;
    rooms: Set<string>;
    rate: MessageRate;
    protocol: number;
    connectedAt: Date;
    handshakeTimer?: ReturnType<typeof setTimeout>;
    closed: boolean;
}

/** A phone without a pairing, showing `code` until a computer sends it a pairing key. */
interface WaitData {
    kind: 'wait';
    code: string | null;
    renewTimer?: ReturnType<typeof setTimeout>;
}

type SocketData = DeviceData | DaemonData | WaitData;
type DeviceSocket = ServerWebSocket<DeviceData>;
type DaemonSocket = ServerWebSocket<DaemonData>;
type WaitSocket = ServerWebSocket<WaitData>;

interface Room {
    daemon: DaemonSocket;
    devices: Map<string, DeviceSocket>;
    /** The room of a person a computer shares with, not of a computer: counted apart. */
    guest: boolean;
}

const STOP_GRACE_MS = 100;
/** WebSocket close codes for protocol violations. */
const TOO_BIG = 1009;
const UNSUPPORTED_DATA = 1003;

/** First characters of a room id: enough to follow a room in the logs. */
const short = (roomId: string) => roomId.slice(0, 6);

const ADMIN_STATS_PATH = '/stats';

const DOWNLOADS: Record<string, Download> = {
    '/install.sh': 'installSh',
    '/install.ps1': 'installPs1',
    '/palmtop.mjs': 'bundle',
    '/version.json': 'versionJson',
};

export function startRelay(options: RelayOptions = {}): Relay {
    const limits = { ...DEFAULT_LIMITS, ...options.limits };
    const log = options.log ?? ((line: string) => console.log(`[relay] ${line}`));
    const minDaemonProtocol = options.minDaemonProtocol ?? MIN_DAEMON_PROTOCOL;
    const release = options.cliRoot ? loadCliRelease(options.cliRoot, log) : null;
    const stats = new RelayStats({ dataDir: options.dataDir, log });
    const feedback = new FeedbackStore(options.dataDir);
    const feedbackSenders = new WindowLimiter(limits.feedbackPerMinute, 60_000);
    const rooms = new Map<string, Room>();
    const devices = new Map<string, DeviceSocket>();
    const daemons = new Set<DaemonSocket>();
    const deviceConnections = new WindowLimiter(limits.deviceConnectionsPerMinute, 60_000);
    const daemonConnections = new WindowLimiter(limits.daemonConnectionsPerMinute, 60_000);
    const pairOffers = new WindowLimiter(limits.pairOffersPerMinute, 60_000);
    const pairCodeTtlMs = options.pairCodeTtlMs ?? PAIR_CODE_TTL_MS;
    /** Code → waiting phone. In memory only, never logged. */
    const waiting = new Map<string, WaitSocket>();

    const toWaiting = (ws: WaitSocket, message: WaitMessage) => ws.send(JSON.stringify(message));

    /** Gives a waiting phone a new code (on open, when it expires, after a delivery). */
    const assignCode = (ws: WaitSocket) => {
        const { data } = ws;
        if (data.code !== null && waiting.get(data.code) === ws) waiting.delete(data.code);
        let code: string;
        do code = newPairCode();
        while (waiting.has(code));
        data.code = code;
        waiting.set(code, ws);
        clearTimeout(data.renewTimer);
        data.renewTimer = setTimeout(() => assignCode(ws), pairCodeTtlMs);
        toWaiting(ws, { type: 'pair.code', code, expiresAt: Date.now() + pairCodeTtlMs });
    };

    /** Delivers a daemon's pairing key to the phone showing the code. */
    const offerPairing = (
        ws: DaemonSocket,
        offer: Extract<DaemonMessage, { type: 'pair.offer' }>,
    ): PairOfferStatus => {
        if (!pairOffers.hit(ws.data.ip)) {
            stats.reject('pair_offers_rate_limited');
            return 'rate_limited';
        }
        const phone = waiting.get(offer.code);
        if (!phone) return 'unknown_code';
        toWaiting(phone, {
            type: 'pair.offer',
            room: offer.room,
            key: offer.key,
            computer: offer.computer,
        });
        // The code is used: whoever saw it on the phone can't send anything else there.
        assignCode(phone);
        log(`pairing key delivered to a waiting device for room ${short(offer.room)}`);
        return 'delivered';
    };

    const toDaemon = (ws: DaemonSocket, message: RelayMessage) => {
        if (!ws.data.closed) ws.send(JSON.stringify(message));
    };

    const failDaemon = (
        ws: DaemonSocket,
        code: RelayErrorCode,
        message: string,
        close?: number,
    ) => {
        toDaemon(ws, { type: 'error', code, message });
        stats.reject(code);
        if (close !== undefined) {
            ws.data.closed = true;
            ws.close(close, code);
        }
    };

    /** Closes the phones of a room and forgets it (the daemon left or was replaced). */
    const dropRoom = (roomId: string) => {
        const room = rooms.get(roomId);
        if (!room) return;
        rooms.delete(roomId);
        for (const [conn, device] of room.devices) {
            devices.delete(conn);
            device.close(CloseCode.daemonOffline, 'daemon offline');
        }
    };

    const claimRoom = (ws: DaemonSocket, roomId: string, guest: boolean) => {
        const existing = rooms.get(roomId);
        if (existing?.daemon === ws) return;
        if (existing) {
            // Same key on a new connection: the daemon restarted or reconnected.
            existing.daemon.data.rooms.delete(roomId);
            toDaemon(existing.daemon, { type: 'room.closed', room: roomId });
            dropRoom(roomId);
            log(`room ${short(roomId)} moved to a new daemon connection`);
        }
        rooms.set(roomId, { daemon: ws, devices: new Map(), guest });
        ws.data.rooms.add(roomId);
        if (guest) stats.guestRoomConnected(roomId);
        else stats.computerConnected(roomId);
    };

    const ownsDevice = (ws: DaemonSocket, conn: string): DeviceSocket | null => {
        const device = devices.get(conn);
        return device && ws.data.rooms.has(device.data.room) ? device : null;
    };

    const handleDaemon = (ws: DaemonSocket, message: DaemonMessage) => {
        const { data } = ws;
        switch (message.type) {
            case 'auth': {
                if (data.sessionToken !== null) {
                    return failDaemon(ws, 'invalid_message', 'already authorized');
                }
                if (isDaemonOutdated(message.protocol, minDaemonProtocol)) {
                    log(
                        `daemon from ${data.ip} rejected: protocol ${message.protocol ?? 1} too old`,
                    );
                    return failDaemon(
                        ws,
                        'outdated',
                        'this palmtop is too old for the relay: run `palmtop update`',
                        CloseCode.outdated,
                    );
                }
                if (message.rooms.length > limits.roomsPerDaemon) {
                    return failDaemon(
                        ws,
                        'too_many_rooms',
                        'too many rooms',
                        CloseCode.rateLimited,
                    );
                }
                const proven: Array<{ roomId: string; guest: boolean }> = [];
                for (const proof of message.rooms) {
                    const roomId = verifyRoomProof(proof, data.nonce);
                    if (!roomId) {
                        log(`daemon from ${data.ip} rejected: invalid room proof`);
                        return failDaemon(
                            ws,
                            'unauthorized',
                            'invalid room proof',
                            CloseCode.unauthorized,
                        );
                    }
                    proven.push({ roomId, guest: proof.guest === true });
                }
                clearTimeout(data.handshakeTimer);
                data.sessionToken = randomNonce();
                data.protocol = message.protocol ?? 1;
                data.connectedAt = new Date();
                stats.daemonConnected();
                for (const { roomId, guest } of proven) claimRoom(ws, roomId, guest);
                toDaemon(ws, {
                    type: 'authorized',
                    sessionToken: data.sessionToken,
                    rooms: [...data.rooms],
                    ...(release && {
                        release: { version: release.version, build: release.build },
                    }),
                });
                log(`daemon from ${data.ip} authorized with ${data.rooms.size} room(s)`);
                return;
            }

            case 'room.open': {
                if (
                    data.sessionToken === null ||
                    !tokensEqual(message.sessionToken, data.sessionToken)
                ) {
                    return failDaemon(ws, 'unauthorized', 'not authorized', CloseCode.unauthorized);
                }
                const roomId = verifyRoomProof(message, data.nonce);
                if (!roomId) {
                    return failDaemon(
                        ws,
                        'unauthorized',
                        'invalid room proof',
                        CloseCode.unauthorized,
                    );
                }
                if (!data.rooms.has(roomId) && data.rooms.size >= limits.roomsPerDaemon) {
                    return failDaemon(ws, 'too_many_rooms', 'too many rooms');
                }
                claimRoom(ws, roomId, message.guest === true);
                toDaemon(ws, { type: 'room.opened', room: roomId });
                return;
            }

            case 'room.close': {
                if (
                    data.sessionToken === null ||
                    !tokensEqual(message.sessionToken, data.sessionToken)
                ) {
                    return failDaemon(ws, 'unauthorized', 'not authorized', CloseCode.unauthorized);
                }
                // Only a room this connection holds: another daemon's room is not its to close.
                if (data.rooms.has(message.room)) {
                    data.rooms.delete(message.room);
                    dropRoom(message.room);
                }
                toDaemon(ws, { type: 'room.closed', room: message.room });
                return;
            }

            case 'device.send': {
                let sent = 0;
                for (const conn of message.conns) {
                    const device = ownsDevice(ws, conn);
                    if (!device) continue;
                    device.send(message.data);
                    sent += 1;
                }
                if (sent > 0) {
                    stats.traffic('toDevices', Buffer.byteLength(message.data) * sent, sent);
                }
                return;
            }

            case 'device.close':
                ownsDevice(ws, message.conn)?.close(message.code, message.reason);
                return;

            case 'pair.offer': {
                if (!data.rooms.has(message.room)) {
                    return failDaemon(ws, 'unauthorized', 'room not held by this connection');
                }
                const status = offerPairing(ws, message);
                toDaemon(ws, { type: 'pair.offer.result', id: message.id, status });
                return;
            }

            case 'ping':
                toDaemon(ws, { type: 'pong' });
                return;

            case 'pong':
                return;
        }
    };

    const onDaemonMessage = (ws: DaemonSocket, raw: string | Buffer) => {
        const { data } = ws;
        if (data.closed) return;
        if (typeof raw !== 'string') return ws.close(UNSUPPORTED_DATA, 'text only');
        if (!data.rate.hit()) {
            return failDaemon(ws, 'rate_limited', 'too many messages', CloseCode.rateLimited);
        }
        const message = parseDaemonMessage(raw);
        if (!message) {
            // Before authorization anything unexpected ends the connection.
            if (data.sessionToken === null) {
                return failDaemon(ws, 'unauthorized', 'expected auth', CloseCode.unauthorized);
            }
            return failDaemon(ws, 'invalid_message', 'invalid message');
        }
        if (data.sessionToken === null && message.type !== 'auth' && message.type !== 'ping') {
            return failDaemon(ws, 'unauthorized', 'expected auth', CloseCode.unauthorized);
        }
        handleDaemon(ws, message);
    };

    const onDeviceOpen = (ws: DeviceSocket) => {
        const room = rooms.get(ws.data.room);
        if (!room) {
            stats.reject('daemon_offline');
            return ws.close(CloseCode.daemonOffline, 'daemon offline');
        }
        if (room.devices.size >= limits.devicesPerRoom) {
            stats.reject('room_full');
            return ws.close(CloseCode.rateLimited, 'room full');
        }
        room.devices.set(ws.data.conn, ws);
        devices.set(ws.data.conn, ws);
        stats.deviceConnected(ws.data.statsId, devices.size);
        toDaemon(room.daemon, { type: 'device.open', conn: ws.data.conn, room: ws.data.room });
    };

    const onDeviceMessage = (ws: DeviceSocket, raw: string | Buffer) => {
        const { conn, room: roomId } = ws.data;
        const room = rooms.get(roomId);
        if (room?.devices.get(conn) !== ws) return;
        if (typeof raw !== 'string') return ws.close(UNSUPPORTED_DATA, 'text only');
        const bytes = Buffer.byteLength(raw);
        if (bytes > limits.deviceMessageBytes) {
            stats.reject('message_too_big');
            return ws.close(TOO_BIG, 'message too big');
        }
        if (!ws.data.rate.hit()) {
            stats.reject('device_rate_limited');
            return ws.close(CloseCode.rateLimited, 'too many messages');
        }
        stats.traffic('toDaemons', bytes);
        toDaemon(room.daemon, { type: 'device.message', conn, data: raw });
    };

    const onDeviceClose = (ws: DeviceSocket) => {
        const { conn, room: roomId } = ws.data;
        if (devices.get(conn) === ws) devices.delete(conn);
        const room = rooms.get(roomId);
        if (room?.devices.get(conn) !== ws) return;
        room.devices.delete(conn);
        toDaemon(room.daemon, { type: 'device.close', conn });
    };

    const onDaemonClose = (ws: DaemonSocket) => {
        ws.data.closed = true;
        clearTimeout(ws.data.handshakeTimer);
        daemons.delete(ws);
        for (const roomId of ws.data.rooms) {
            if (rooms.get(roomId)?.daemon === ws) dropRoom(roomId);
        }
        if (ws.data.sessionToken !== null) log(`daemon from ${ws.data.ip} disconnected`);
    };

    const onWaitOpen = (ws: WaitSocket) => {
        if (waiting.size >= limits.waitingPhones) {
            stats.reject('waiting_full');
            return ws.close(CloseCode.rateLimited, 'too many waiting devices');
        }
        assignCode(ws);
    };

    const onWaitClose = (ws: WaitSocket) => {
        clearTimeout(ws.data.renewTimer);
        if (ws.data.code !== null && waiting.get(ws.data.code) === ws) waiting.delete(ws.data.code);
    };

    /** Downloads and HTML pages served with 200. */
    const count = (url: URL, response: Response) => {
        const app = isAppHost(url.hostname);
        const download = app ? undefined : DOWNLOADS[url.pathname];
        if (download) return stats.download(download);
        const page = app ? 'app' : pageOf(url.pathname);
        const html = response.headers.get('content-type')?.startsWith('text/html');
        if (page && (html || page === 'installMd')) stats.page(page);
    };

    /** `POST /feedback` from the site or the app (same origin). */
    const onFeedback = async (request: Request, ip: string): Promise<Response> => {
        const answer = (status: number, body: object) =>
            Response.json(body, { status, headers: SECURITY_HEADERS });
        if (request.method !== 'POST') return answer(405, { error: 'method_not_allowed' });
        if (!sameOrigin(request)) return answer(403, { error: 'forbidden' });
        if (!feedbackSenders.hit(ip)) {
            stats.reject('feedback_rate_limited');
            return answer(429, { error: 'rate_limited' });
        }
        const length = Number(request.headers.get('content-length') ?? 0);
        if (length > FEEDBACK_BODY_MAX_BYTES) return answer(413, { error: 'too_big' });
        const result = receiveFeedback(feedback, await request.text());
        switch (result.status) {
            case 'stored':
                stats.feedback();
                log(`feedback received (${result.entry.type})`);
                return answer(201, { ok: true });
            case 'spam':
                // Looks accepted, so bots don't learn about the hidden field.
                stats.reject('feedback_spam');
                return answer(201, { ok: true });
            case 'too_big':
                return answer(413, { error: 'too_big' });
            case 'invalid':
                return answer(400, { error: 'invalid' });
        }
    };

    const clientIp = (request: Request, server: Server<SocketData>): string => {
        if (options.trustProxy) {
            const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
            if (forwarded) return forwarded;
        }
        return server.requestIP(request)?.address ?? 'unknown';
    };

    const server = Bun.serve<SocketData>({
        hostname: options.hostname ?? '127.0.0.1',
        port: options.port ?? 8787,
        async fetch(request, server) {
            const url = new URL(request.url);
            if (url.pathname === RELAY_DEVICE_PATH) {
                const room = roomIdSchema.safeParse(url.searchParams.get(ROOM_QUERY_PARAM));
                if (!room.success) return new Response('invalid room', { status: 400 });
                if (!deviceConnections.hit(clientIp(request, server))) {
                    stats.reject('device_connections');
                    return new Response('too many connections', { status: 429 });
                }
                const statsId = statsIdSchema.safeParse(url.searchParams.get(STATS_ID_QUERY_PARAM));
                const data: DeviceData = {
                    kind: 'device',
                    conn: randomBytes(12).toString('base64url'),
                    room: room.data,
                    statsId: statsId.success ? statsId.data : null,
                    rate: new MessageRate(limits.deviceMessagesPerSecond),
                };
                if (server.upgrade(request, { data })) return undefined;
                return new Response('expected a WebSocket upgrade', { status: 426 });
            }
            if (url.pathname === RELAY_WAIT_PATH) {
                if (!deviceConnections.hit(clientIp(request, server))) {
                    stats.reject('device_connections');
                    return new Response('too many connections', { status: 429 });
                }
                const data: WaitData = { kind: 'wait', code: null };
                if (server.upgrade(request, { data })) return undefined;
                return new Response('expected a WebSocket upgrade', { status: 426 });
            }
            if (url.pathname === RELAY_DAEMON_PATH) {
                const ip = clientIp(request, server);
                if (!daemonConnections.hit(ip)) {
                    stats.reject('daemon_connections');
                    return new Response('too many connections', { status: 429 });
                }
                const data: DaemonData = {
                    kind: 'daemon',
                    ip,
                    nonce: randomNonce(),
                    sessionToken: null,
                    rooms: new Set(),
                    rate: new MessageRate(limits.daemonMessagesPerSecond),
                    protocol: 1,
                    connectedAt: new Date(),
                    closed: false,
                };
                if (server.upgrade(request, { data })) return undefined;
                return new Response('expected a WebSocket upgrade', { status: 426 });
            }
            if (url.pathname === FEEDBACK_PATH)
                return onFeedback(request, clientIp(request, server));
            if (url.pathname === ADMIN_STATS_PATH) {
                // Statistics are only on the admin listener; never answer them here.
                return new Response('not found', { status: 404, headers: SECURITY_HEADERS });
            }
            if (url.pathname === '/healthz') {
                return Response.json({ ok: true }, { headers: SECURITY_HEADERS });
            }
            if (request.method !== 'GET' && request.method !== 'HEAD') {
                return new Response('method not allowed', { status: 405 });
            }
            // Downloads are on the site only: the app's origin is the app and nothing else.
            const cliFile = isAppHost(url.hostname)
                ? null
                : await serveCliFile(url.pathname, options.cliRoot);
            const response = cliFile ?? (await serveWebApp(url, options.webRoot));
            if (request.method === 'GET' && response.status === 200) count(url, response);
            return response;
        },
        websocket: {
            // Per-kind limits are enforced in the handlers; this is the hard cap.
            maxPayloadLength: Math.max(limits.daemonMessageBytes, limits.deviceMessageBytes),
            idleTimeout: 120,
            sendPings: true,
            open(ws) {
                if (ws.data.kind === 'device') return onDeviceOpen(ws as DeviceSocket);
                if (ws.data.kind === 'wait') return onWaitOpen(ws as WaitSocket);
                const daemon = ws as DaemonSocket;
                daemons.add(daemon);
                daemon.data.handshakeTimer = setTimeout(() => {
                    if (daemon.data.sessionToken === null) {
                        failDaemon(daemon, 'unauthorized', 'auth timeout', CloseCode.helloTimeout);
                    }
                }, limits.handshakeTimeoutMs);
                toDaemon(daemon, { type: 'challenge', nonce: daemon.data.nonce });
            },
            message(ws, raw) {
                if (ws.data.kind === 'device') return onDeviceMessage(ws as DeviceSocket, raw);
                // A waiting phone has nothing to say: it only listens.
                if (ws.data.kind === 'wait') return;
                onDaemonMessage(ws as DaemonSocket, raw);
            },
            close(ws) {
                if (ws.data.kind === 'device') return onDeviceClose(ws as DeviceSocket);
                if (ws.data.kind === 'wait') return onWaitClose(ws as WaitSocket);
                onDaemonClose(ws as DaemonSocket);
            },
        },
    });

    const report = (): StatsReport => {
        const computers: LiveComputer[] = [];
        let guestRooms = 0;
        for (const daemon of daemons) {
            if (daemon.data.sessionToken === null) continue;
            for (const roomId of daemon.data.rooms) {
                if (rooms.get(roomId)?.guest) {
                    guestRooms += 1;
                    continue;
                }
                computers.push({
                    id: stats.idOf(roomId).slice(0, 8),
                    connectedAt: daemon.data.connectedAt.toISOString(),
                    devices: rooms.get(roomId)?.devices.size ?? 0,
                    protocol: daemon.data.protocol,
                });
            }
        }
        return stats.report({
            computers,
            guestRooms,
            devices: devices.size,
            cli: release?.version ?? null,
        });
    };

    const admin =
        options.adminPort === undefined
            ? null
            : Bun.serve({
                  hostname: '127.0.0.1',
                  port: options.adminPort,
                  fetch(request) {
                      const { pathname } = new URL(request.url);
                      if (request.method === 'GET' && pathname === ADMIN_STATS_PATH) {
                          return Response.json(report());
                      }
                      if (request.method === 'GET' && pathname === FEEDBACK_PATH) {
                          return Response.json(feedback.list());
                      }
                      return new Response('not found', { status: 404 });
                  },
              });

    return {
        server,
        port: server.port ?? options.port ?? 8787,
        adminPort: admin?.port ?? null,
        release,
        stats: () => ({
            daemons: daemons.size,
            rooms: rooms.size,
            devices: devices.size,
            waiting: waiting.size,
        }),
        report,
        async stop() {
            stats.stop();
            await admin?.stop(true);
            // Bun: stop(true) may never settle after the server closed a WebSocket with a code.
            await Promise.race([server.stop(true), Bun.sleep(STOP_GRACE_MS)]);
        },
    };
}

/** 5 random bits per character: 32 divides 256, so every character is equally likely. */
function newPairCode(): string {
    let code = '';
    for (const byte of randomBytes(PAIR_CODE_LENGTH)) code += PAIR_CODE_ALPHABET[byte & 31];
    return code;
}

function tokensEqual(a: string, b: string): boolean {
    const left = Buffer.from(a);
    const right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

/** Browsers send `Origin` on a POST: it must be this host (the site and the app). */
function sameOrigin(request: Request): boolean {
    const origin = request.headers.get('origin');
    if (!origin) return true;
    try {
        return new URL(origin).host === request.headers.get('host');
    } catch {
        return false;
    }
}

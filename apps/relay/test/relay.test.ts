import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CloseCode,
    DAEMON_PROTOCOL_VERSION,
    PAIR_CODE_ALPHABET,
    parseRelayMessage,
    parseWaitMessage,
    type RelayMessage,
    type WaitMessage,
} from '@palmtopai/protocol';
import {
    generateRoomKeyPair,
    type RoomKeyPair,
    roomIdOf,
    signRoomChallenge,
} from '@palmtopai/protocol/relay-crypto';
import { DEFAULT_LIMITS, type Relay, type RelayLimits, type StatsReport, startRelay } from '../src';

/** Collects the messages of a socket so tests can await them in order. */
class Socket<T> {
    readonly ws: WebSocket;
    readonly opened: Promise<void>;
    readonly closed: Promise<{ code: number; reason: string }>;
    readonly #messages: T[] = [];
    #wake: (() => void) | null = null;

    constructor(url: string, parse: (raw: string) => T | null) {
        this.ws = new WebSocket(url);
        this.opened = new Promise((resolve) => this.ws.addEventListener('open', () => resolve()));
        this.ws.addEventListener('message', (event) => {
            const message = parse(String(event.data));
            if (message === null) throw new Error(`unparsable message: ${event.data}`);
            this.#messages.push(message);
            this.#wake?.();
        });
        this.closed = new Promise((resolve) =>
            this.ws.addEventListener('close', (event) => {
                resolve({ code: event.code, reason: event.reason });
                this.#wake?.();
            }),
        );
    }

    async next(timeoutMs = 2_000): Promise<T> {
        const deadline = Date.now() + timeoutMs;
        while (this.#messages.length === 0) {
            if (Date.now() > deadline) throw new Error('timed out waiting for a message');
            if (this.ws.readyState === WebSocket.CLOSED) throw new Error('socket closed');
            await new Promise<void>((resolve) => {
                this.#wake = resolve;
                setTimeout(resolve, 50);
            });
        }
        return this.#messages.shift() as T;
    }

    async expectSilence(ms = 150): Promise<void> {
        await Bun.sleep(ms);
        if (this.#messages.length > 0) {
            throw new Error(`unexpected message: ${JSON.stringify(this.#messages[0])}`);
        }
    }

    send(message: unknown): void {
        this.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
}

function expectType<T extends RelayMessage['type']>(
    message: RelayMessage,
    type: T,
): Extract<RelayMessage, { type: T }> {
    expect(message.type).toBe(type);
    return message as Extract<RelayMessage, { type: T }>;
}

describe('relay', () => {
    let relay: Relay;
    let logs: string[];
    const sockets: Array<Socket<unknown>> = [];

    function boot(limits: Partial<RelayLimits> = {}) {
        logs = [];
        relay = startRelay({ port: 0, limits, log: (line) => logs.push(line) });
    }

    beforeEach(() => boot());

    afterEach(async () => {
        for (const socket of sockets.splice(0)) socket.ws.close();
        await relay.stop();
    });

    function track<T>(socket: Socket<T>): Socket<T> {
        sockets.push(socket as Socket<unknown>);
        return socket;
    }

    /** A daemon connection that proves the given room keys. */
    async function daemon(
        keys: RoomKeyPair[],
        protocol: number = DAEMON_PROTOCOL_VERSION,
        guestKeys: RoomKeyPair[] = [],
    ) {
        const socket = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        const { nonce } = expectType(await socket.next(), 'challenge');
        socket.send({
            type: 'auth',
            rooms: [
                ...keys.map((pair) => ({
                    publicKey: pair.publicKey,
                    signature: signRoomChallenge(pair, nonce),
                })),
                ...guestKeys.map((pair) => ({
                    publicKey: pair.publicKey,
                    signature: signRoomChallenge(pair, nonce),
                    guest: true,
                })),
            ],
            protocol,
        });
        const authorized = expectType(await socket.next(), 'authorized');
        return { socket, nonce, authorized };
    }

    function phone(roomId: string) {
        return track(
            new Socket(`ws://127.0.0.1:${relay.port}/ws?room=${roomId}`, (raw) => raw as string),
        );
    }

    /** A phone without a pairing, waiting on `/wait` for a key. */
    function waitingPhone() {
        return track(
            new Socket(`ws://127.0.0.1:${relay.port}/wait`, (raw) => parseWaitMessage(raw)),
        );
    }

    async function codeOf(socket: Socket<WaitMessage | null>): Promise<string> {
        const message = await socket.next();
        if (message?.type !== 'pair.code')
            throw new Error(`expected pair.code, got ${message?.type}`);
        return message.code;
    }

    const KEY = 'k'.repeat(22);

    test('a daemon proving its keys gets its rooms and a runtime session token', async () => {
        const a = generateRoomKeyPair();
        const b = generateRoomKeyPair();
        const { authorized } = await daemon([a, b]);
        expect(authorized.rooms.sort()).toEqual(
            [roomIdOf(a.publicKey), roomIdOf(b.publicKey)].sort(),
        );
        expect(authorized.sessionToken).toHaveLength(43);

        const other = await daemon([a]);
        expect(other.authorized.sessionToken).not.toBe(authorized.sessionToken);
        expect(relay.stats()).toMatchObject({ daemons: 2, rooms: 2 });
    });

    test('invalid proofs are refused: wrong key, replayed nonce, messages before auth', async () => {
        const keys = generateRoomKeyPair();
        const stranger = generateRoomKeyPair();

        const forged = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        const { nonce } = expectType(await forged.next(), 'challenge');
        // The public key of the room with a signature made by another key.
        forged.send({
            type: 'auth',
            rooms: [{ publicKey: keys.publicKey, signature: signRoomChallenge(stranger, nonce) }],
            protocol: DAEMON_PROTOCOL_VERSION,
        });
        expect(await forged.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
        expect((await forged.closed).code).toBe(CloseCode.unauthorized);

        const replay = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        await replay.next();
        replay.send({
            type: 'auth',
            rooms: [{ publicKey: keys.publicKey, signature: signRoomChallenge(keys, nonce) }],
            protocol: DAEMON_PROTOCOL_VERSION,
        });
        expect((await replay.closed).code).toBe(CloseCode.unauthorized);

        const early = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        await early.next();
        early.send({ type: 'device.send', conns: ['abc'], data: 'x' });
        expect((await early.closed).code).toBe(CloseCode.unauthorized);
        expect(relay.stats().rooms).toBe(0);
    });

    test('room.open needs the session token of the connection and a valid proof', async () => {
        const first = generateRoomKeyPair();
        const later = generateRoomKeyPair();
        const { socket, nonce, authorized } = await daemon([first]);
        socket.send({
            type: 'room.open',
            sessionToken: authorized.sessionToken,
            publicKey: later.publicKey,
            signature: signRoomChallenge(later, nonce),
        });
        expect(await socket.next()).toEqual({
            type: 'room.opened',
            room: roomIdOf(later.publicKey),
        });

        const { socket: other, nonce: otherNonce } = await daemon([]);
        other.send({
            type: 'room.open',
            sessionToken: authorized.sessionToken,
            publicKey: later.publicKey,
            signature: signRoomChallenge(later, otherNonce),
        });
        expect((await other.closed).code).toBe(CloseCode.unauthorized);
    });

    test('rooms of guests are counted apart from computers, and never as one', async () => {
        await relay.stop();
        relay = startRelay({ port: 0, adminPort: 0, log: () => {} });
        const home = generateRoomKeyPair();
        const mario = generateRoomKeyPair();
        const luca = generateRoomKeyPair();
        const { socket, nonce, authorized } = await daemon([home], DAEMON_PROTOCOL_VERSION, [
            mario,
        ]);
        expect(authorized.rooms).toHaveLength(2);
        socket.send({
            type: 'room.open',
            sessionToken: authorized.sessionToken,
            publicKey: luca.publicKey,
            signature: signRoomChallenge(luca, nonce),
            guest: true,
        });
        expect(await socket.next()).toEqual({
            type: 'room.opened',
            room: roomIdOf(luca.publicKey),
        });

        const report = (await (
            await fetch(`http://127.0.0.1:${relay.adminPort}/stats`)
        ).json()) as StatsReport;
        expect(report.live).toMatchObject({ computers: 1, guestRooms: 2 });
        expect(report.live.list).toHaveLength(1);
        expect(report.totals).toMatchObject({ computers: 1, guestRooms: 2 });
        expect(report.days[0]).toMatchObject({ newComputers: 1, newGuestRooms: 2 });
        for (const keys of [home, mario, luca]) {
            expect(JSON.stringify(report)).not.toContain(roomIdOf(keys.publicKey));
        }
    });

    test('a daemon without the guest flag counts as before: every room a computer', async () => {
        await relay.stop();
        relay = startRelay({ port: 0, adminPort: 0, log: () => {} });
        await daemon([generateRoomKeyPair(), generateRoomKeyPair()]);
        const report = (await (
            await fetch(`http://127.0.0.1:${relay.adminPort}/stats`)
        ).json()) as StatsReport;
        expect(report.live).toMatchObject({ computers: 2, guestRooms: 0 });
    });

    test('room.close frees a room and its slot, closes its phones, leaves the others alone', async () => {
        await relay.stop();
        boot({ roomsPerDaemon: 2 });
        const home = generateRoomKeyPair();
        const mario = generateRoomKeyPair();
        const luca = generateRoomKeyPair();
        const { socket, nonce, authorized } = await daemon([home], DAEMON_PROTOCOL_VERSION, [
            mario,
        ]);

        const atHome = phone(roomIdOf(home.publicKey));
        const atMario = phone(roomIdOf(mario.publicKey));
        await Promise.all([atHome.opened, atMario.opened]);
        for (let i = 0; i < 2; i++) expectType(await socket.next(), 'device.open');

        // Full: a third room does not fit.
        const open = (pair: RoomKeyPair) =>
            socket.send({
                type: 'room.open',
                sessionToken: authorized.sessionToken,
                publicKey: pair.publicKey,
                signature: signRoomChallenge(pair, nonce),
                guest: true,
            });
        open(luca);
        expect(await socket.next()).toMatchObject({ type: 'error', code: 'too_many_rooms' });

        socket.send({
            type: 'room.close',
            sessionToken: authorized.sessionToken,
            room: roomIdOf(mario.publicKey),
        });
        expect(await socket.next()).toEqual({
            type: 'room.closed',
            room: roomIdOf(mario.publicKey),
        });
        expect((await atMario.closed).code).toBe(CloseCode.daemonOffline);
        // The phone of the computer's room is still there.
        atHome.send('{"type":"ping"}');
        expectType(await socket.next(), 'device.message');
        // A phone of the closed room finds nobody home.
        expect((await phone(roomIdOf(mario.publicKey)).closed).code).toBe(CloseCode.daemonOffline);

        open(luca);
        expect(await socket.next()).toEqual({
            type: 'room.opened',
            room: roomIdOf(luca.publicKey),
        });
    });

    test('room.close needs the session token and only closes a room of the connection', async () => {
        const mine = generateRoomKeyPair();
        const theirs = generateRoomKeyPair();
        const { socket, authorized } = await daemon([mine]);
        const { socket: other } = await daemon([theirs]);
        const phoneOfTheirs = phone(roomIdOf(theirs.publicKey));
        await phoneOfTheirs.opened;
        expectType(await other.next(), 'device.open');

        // A room the connection does not hold: nothing happens to it.
        socket.send({
            type: 'room.close',
            sessionToken: authorized.sessionToken,
            room: roomIdOf(theirs.publicKey),
        });
        expectType(await socket.next(), 'room.closed');
        phoneOfTheirs.send('{"type":"ping"}');
        expectType(await other.next(), 'device.message');

        // The wrong token closes the connection.
        const wrong = await daemon([generateRoomKeyPair()]);
        wrong.socket.send({
            type: 'room.close',
            sessionToken: authorized.sessionToken,
            room: roomIdOf(mine.publicKey),
        });
        expect((await wrong.socket.closed).code).toBe(CloseCode.unauthorized);
    });

    test('phones reach the daemon holding the room, and only that daemon can answer them', async () => {
        const keys = generateRoomKeyPair();
        const roomId = roomIdOf(keys.publicKey);
        const { socket: owner } = await daemon([keys]);
        const { socket: intruder } = await daemon([generateRoomKeyPair()]);

        const device = phone(roomId);
        await device.opened;
        const open = expectType(await owner.next(), 'device.open');
        expect(open.room).toBe(roomId);

        device.send('{"type":"hello","secret":"TOKEN-IN-HELLO"}');
        expect(await owner.next()).toEqual({
            type: 'device.message',
            conn: open.conn,
            data: '{"type":"hello","secret":"TOKEN-IN-HELLO"}',
        });

        intruder.send({ type: 'device.send', conns: [open.conn], data: 'from intruder' });
        intruder.send({ type: 'device.close', conn: open.conn, code: 4401, reason: 'x' });
        await device.expectSilence();

        owner.send({ type: 'device.send', conns: [open.conn], data: 'snapshot' });
        expect(await device.next()).toBe('snapshot');
        owner.send({ type: 'device.close', conn: open.conn, code: 4401, reason: 'unauthorized' });
        expect(await device.closed).toEqual({ code: 4401, reason: 'unauthorized' });
        expect(expectType(await owner.next(), 'device.close').conn).toBe(open.conn);

        // Contents never reach the logs.
        expect(logs.join('\n')).not.toContain('TOKEN-IN-HELLO');
        expect(logs.join('\n')).not.toContain('snapshot');
    });

    test('phones of a room without a daemon are closed with daemon offline', async () => {
        const keys = generateRoomKeyPair();
        const lonely = phone(roomIdOf(keys.publicKey));
        expect((await lonely.closed).code).toBe(CloseCode.daemonOffline);

        const { socket } = await daemon([keys]);
        const device = phone(roomIdOf(keys.publicKey));
        await device.opened;
        await socket.next();
        socket.ws.close();
        expect((await device.closed).code).toBe(CloseCode.daemonOffline);
        expect(relay.stats()).toEqual({ daemons: 0, rooms: 0, devices: 0, waiting: 0 });
    });

    test('a new connection with the same key takes the room over', async () => {
        const keys = generateRoomKeyPair();
        const roomId = roomIdOf(keys.publicKey);
        const { socket: old } = await daemon([keys]);
        const device = phone(roomId);
        await device.opened;
        await old.next();

        const { socket: fresh, authorized } = await daemon([keys]);
        expect(authorized.rooms).toEqual([roomId]);
        expect(await old.next()).toEqual({ type: 'room.closed', room: roomId });
        expect((await device.closed).code).toBe(CloseCode.daemonOffline);

        const again = phone(roomId);
        await again.opened;
        expectType(await fresh.next(), 'device.open');
        await old.expectSilence();
    });

    test('bad room ids are refused before the upgrade', async () => {
        const response = await fetch(`http://127.0.0.1:${relay.port}/ws?room=nope`);
        expect(response.status).toBe(400);
    });

    test('limits: message size, message rate, devices per room, rooms per daemon', async () => {
        await relay.stop();
        boot({
            deviceMessagesPerSecond: 5,
            devicesPerRoom: 2,
            roomsPerDaemon: 2,
            deviceMessageBytes: 1024,
        });

        const keys = generateRoomKeyPair();
        const roomId = roomIdOf(keys.publicKey);
        const { socket } = await daemon([keys]);

        const big = phone(roomId);
        await big.opened;
        big.send('x'.repeat(2_000));
        expect((await big.closed).code).toBe(1009);

        const chatty = phone(roomId);
        await chatty.opened;
        for (let i = 0; i < 10; i++) chatty.send('{"type":"ping"}');
        expect((await chatty.closed).code).toBe(CloseCode.rateLimited);

        const first = phone(roomId);
        const second = phone(roomId);
        await Promise.all([first.opened, second.opened]);
        const third = phone(roomId);
        expect(await third.closed).toEqual({ code: CloseCode.rateLimited, reason: 'room full' });
        void socket;

        const crowded = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        const { nonce } = expectType(await crowded.next(), 'challenge');
        crowded.send({
            type: 'auth',
            protocol: DAEMON_PROTOCOL_VERSION,
            rooms: [1, 2, 3].map(() => {
                const pair = generateRoomKeyPair();
                return { publicKey: pair.publicKey, signature: signRoomChallenge(pair, nonce) };
            }),
        });
        expect(await crowded.next()).toMatchObject({ type: 'error', code: 'too_many_rooms' });
        expect((await crowded.closed).code).toBe(CloseCode.rateLimited);
    });

    test('limits: connections per IP and the auth timeout', async () => {
        await relay.stop();
        boot({ deviceConnectionsPerMinute: 2, handshakeTimeoutMs: 100 });
        const roomId = roomIdOf(generateRoomKeyPair().publicKey);
        const url = `http://127.0.0.1:${relay.port}/ws?room=${roomId}`;
        const upgrade = { headers: { upgrade: 'websocket', connection: 'upgrade' } };
        expect((await fetch(url, upgrade)).status).not.toBe(429);
        expect((await fetch(url, upgrade)).status).not.toBe(429);
        expect((await fetch(url, upgrade)).status).toBe(429);

        const silent = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        expectType(await silent.next(), 'challenge');
        expect((await silent.closed).code).toBe(CloseCode.helloTimeout);
    });

    test('behind a proxy, limits apply to the forwarded client address', async () => {
        await relay.stop();
        logs = [];
        relay = startRelay({
            port: 0,
            trustProxy: true,
            limits: { deviceConnectionsPerMinute: 1 },
            log: (line) => logs.push(line),
        });
        const roomId = roomIdOf(generateRoomKeyPair().publicKey);
        const attempt = (ip: string) =>
            fetch(`http://127.0.0.1:${relay.port}/ws?room=${roomId}`, {
                headers: { upgrade: 'websocket', connection: 'upgrade', 'x-forwarded-for': ip },
            });
        expect((await attempt('203.0.113.1')).status).not.toBe(429);
        expect((await attempt('203.0.113.2')).status).not.toBe(429);
        expect((await attempt('203.0.113.1')).status).toBe(429);
    });

    test('serves the web app placeholder with security headers', async () => {
        const response = await fetch(`http://127.0.0.1:${relay.port}/`);
        expect(response.status).toBe(200);
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
        expect(await response.text()).toContain('PalmtopAI');
        expect((await fetch(`http://127.0.0.1:${relay.port}/healthz`)).status).toBe(200);
    });

    test('publishes the CLI build for download and announces it to daemons', async () => {
        const unpublished = await fetch(`http://127.0.0.1:${relay.port}/palmtop.mjs`);
        expect(unpublished.status).toBe(404);
        expect((await daemon([generateRoomKeyPair()])).authorized.release).toBeUndefined();

        const cliRoot = await mkdtemp(join(tmpdir(), 'palmtop-relay-cli-'));
        try {
            const bundle = '#!/usr/bin/env node\nconsole.log("palmtop");\n';
            const release = {
                version: '0.2.0',
                build: 'abcdef012345',
                sha256: 'a'.repeat(64),
                size: bundle.length,
            };
            await writeFile(join(cliRoot, 'palmtop.mjs'), bundle);
            await writeFile(join(cliRoot, 'version.json'), JSON.stringify(release));
            await relay.stop();
            relay = startRelay({ port: 0, cliRoot, log: (line) => logs.push(line) });
            expect(relay.release).toEqual(release);

            const manifest = await fetch(`http://127.0.0.1:${relay.port}/version.json`);
            expect(manifest.headers.get('cache-control')).toBe('no-cache');
            expect(await manifest.json()).toEqual(release);
            const download = await fetch(`http://127.0.0.1:${relay.port}/palmtop.mjs`);
            expect(download.headers.get('content-type')).toContain('text/javascript');
            expect(await download.text()).toBe(bundle);

            const { authorized } = await daemon([generateRoomKeyPair()]);
            expect(authorized.release).toEqual({ version: '0.2.0', build: 'abcdef012345' });

            await writeFile(join(cliRoot, 'version.json'), '{"version":"x"}');
            await relay.stop();
            relay = startRelay({ port: 0, cliRoot, log: (line) => logs.push(line) });
            expect(relay.release).toBeNull();
            expect(logs.at(-1)).toContain('invalid version.json');
        } finally {
            await rm(cliRoot, { recursive: true, force: true });
        }
    });

    test('daemons older than the minimum protocol are refused with outdated', async () => {
        await relay.stop();
        relay = startRelay({
            port: 0,
            minDaemonProtocol: DAEMON_PROTOCOL_VERSION + 1,
            log: (line) => logs.push(line),
        });

        const socket = track(
            new Socket(`ws://127.0.0.1:${relay.port}/daemon`, (raw) => parseRelayMessage(raw)),
        );
        const { nonce } = expectType(await socket.next(), 'challenge');
        const pair = generateRoomKeyPair();
        socket.send({
            type: 'auth',
            rooms: [{ publicKey: pair.publicKey, signature: signRoomChallenge(pair, nonce) }],
        });
        expect(expectType(await socket.next(), 'error').code).toBe('outdated');
        expect((await socket.closed).code).toBe(CloseCode.outdated);
        expect(relay.stats().rooms).toBe(0);

        const current = await daemon([pair], DAEMON_PROTOCOL_VERSION + 1);
        expect(current.authorized.rooms).toEqual([roomIdOf(pair.publicKey)]);
    });

    test('serves the site, and the app at the root of app.<host>', async () => {
        const webRoot = await mkdtemp(join(tmpdir(), 'palmtop-relay-web-'));
        try {
            await mkdir(join(webRoot, 'app', 'assets'), { recursive: true });
            await mkdir(join(webRoot, 'assets'), { recursive: true });
            await writeFile(join(webRoot, 'index.html'), 'landing');
            await writeFile(join(webRoot, 'icon.svg'), '<svg/>');
            await writeFile(join(webRoot, 'install.md'), '# Set up palmtop');
            await writeFile(join(webRoot, 'install.sh'), '#!/bin/sh');
            await writeFile(join(webRoot, 'install.ps1'), 'function Install-Palmtop {}');
            await writeFile(join(webRoot, 'robots.txt'), 'User-agent: *');
            await writeFile(join(webRoot, 'sitemap.xml'), '<urlset/>');
            await writeFile(join(webRoot, 'assets', 'app-1.js'), 'js');
            await writeFile(join(webRoot, 'app', 'index.html'), 'app');
            await writeFile(join(webRoot, 'app', 'sw.js'), 'self.addEventListener');
            await writeFile(join(webRoot, 'app', 'assets', 'app-2.js'), 'app js');
            await relay.stop();
            relay = startRelay({ port: 0, webRoot, log: () => {} });
            const get = (path: string, host = `localhost:${relay.port}`) =>
                fetch(`http://127.0.0.1:${relay.port}${path}`, {
                    redirect: 'manual',
                    headers: { host },
                });
            const getApp = (path: string) => get(path, `app.localhost:${relay.port}`);

            expect(await (await get('/')).text()).toBe('landing');

            // The app is at the root of its own origin, `index.html` for any unknown path.
            expect(await (await getApp('/')).text()).toBe('app');
            expect(await (await getApp('/some/route')).text()).toBe('app');
            expect(await (await getApp('/assets/app-2.js')).text()).toBe('app js');
            expect((await getApp('/assets/app-2.js')).headers.get('cache-control')).toContain(
                'immutable',
            );
            const worker = await getApp('/sw.js');
            expect(worker.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
            expect(worker.headers.get('cache-control')).toBe('no-cache');
            expect(await worker.text()).toBe('self.addEventListener');
            // Nothing of the site there: not its files, not the downloads.
            expect(await (await getApp('/icon.svg')).text()).toBe('app');
            expect(await (await getApp('/install.sh')).text()).toBe('app');
            expect(await (await getApp('/../index.html')).text()).toBe('app');

            // The site sends the app's old paths to the app's origin, query included.
            for (const [path, location] of [
                ['/app', `//app.localhost:${relay.port}/`],
                ['/app/', `//app.localhost:${relay.port}/`],
                ['/app/some/route?x=1', `//app.localhost:${relay.port}/some/route?x=1`],
                ['/app/index.html', `//app.localhost:${relay.port}/index.html`],
            ]) {
                const moved = await get(path as string);
                expect(moved.status).toBe(301);
                expect(moved.headers.get('location')).toBe(location as string);
            }
            // ...and never serves the app's files itself, however the path is written.
            expect((await get('/x/../app/index.html')).status).not.toBe(200);
            expect((await get('/%61pp/index.html')).status).toBe(404);
            // The old worker of the app is replaced by one that unregisters itself.
            const retired = await get('/app/sw.js');
            expect(retired.status).toBe(200);
            expect(retired.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
            expect(retired.headers.get('cache-control')).toBe('no-cache');
            expect(await retired.text()).toContain('self.registration.unregister()');

            const install = await get('/install.md');
            expect(install.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
            expect(install.headers.get('cache-control')).toBe('no-cache');
            expect(await install.text()).toBe('# Set up palmtop');
            const script = await get('/install.sh');
            expect(script.headers.get('content-type')).toBe('text/plain; charset=utf-8');
            expect(await script.text()).toBe('#!/bin/sh');
            const powershell = await get('/install.ps1');
            expect(powershell.headers.get('content-type')).toBe('text/plain; charset=utf-8');
            expect(await powershell.text()).toBe('function Install-Palmtop {}');
            expect((await get('/robots.txt')).headers.get('content-type')).toBe(
                'text/plain; charset=utf-8',
            );
            expect((await get('/sitemap.xml')).headers.get('content-type')).toBe(
                'application/xml; charset=utf-8',
            );

            expect((await get('/assets/app-1.js')).headers.get('cache-control')).toContain(
                'immutable',
            );
            const missing = await get('/missing');
            expect(missing.status).toBe(404);
            expect(missing.headers.get('x-frame-options')).toBe('DENY');
            expect((await get('/../../etc/passwd')).status).toBe(404);

            // Pages and downloads served with 200 are counted; files and HEAD are not.
            await fetch(`http://127.0.0.1:${relay.port}/`, { method: 'HEAD' });
            const { totals } = relay.report();
            expect(totals.pages).toEqual({
                home: 1,
                docs: 0,
                changelog: 0,
                app: 5,
                installMd: 1,
            });
            expect(totals.downloads).toEqual({
                installSh: 1,
                installPs1: 1,
                bundle: 0,
                versionJson: 0,
            });
        } finally {
            await rm(webRoot, { recursive: true, force: true });
        }
    });

    test('statistics: admin listener on 127.0.0.1 only, never on the public port', async () => {
        await relay.stop();
        relay = startRelay({ port: 0, adminPort: 0, log: () => {} });
        expect(relay.adminPort).toBeGreaterThan(0);

        const keys = generateRoomKeyPair();
        const roomId = roomIdOf(keys.publicKey);
        const { socket } = await daemon([keys]);
        const first = track(
            new Socket(
                `ws://127.0.0.1:${relay.port}/ws?room=${roomId}&d=statsid-one`,
                (raw) => raw as string,
            ),
        );
        const again = track(
            new Socket(
                `ws://127.0.0.1:${relay.port}/ws?room=${roomId}&d=statsid-one`,
                (raw) => raw as string,
            ),
        );
        const anonymous = phone(roomId);
        await Promise.all([first.opened, again.opened, anonymous.opened]);
        for (let i = 0; i < 3; i++) expectType(await socket.next(), 'device.open');
        first.send('{"type":"ping"}');
        expectType(await socket.next(), 'device.message');

        const offline = phone(roomIdOf(generateRoomKeyPair().publicKey));
        await offline.closed;

        const response = await fetch(`http://127.0.0.1:${relay.adminPort}/stats`);
        expect(response.status).toBe(200);
        const report = (await response.json()) as StatsReport;
        expect(report.live).toMatchObject({
            computers: 1,
            devices: 3,
            protocols: { [String(DAEMON_PROTOCOL_VERSION)]: 1 },
        });
        expect(report.live.list[0]).toMatchObject({
            devices: 3,
            protocol: DAEMON_PROTOCOL_VERSION,
        });
        expect(report.live.list[0]?.id).not.toContain(roomId.slice(0, 8));
        expect(report.live.lastMinute.toDaemons.messages).toBe(1);
        expect(report.totals).toMatchObject({
            computers: 1,
            devices: 1,
            daemonConnections: 1,
            deviceConnections: 3,
            peakDevices: 3,
            rejects: { daemon_offline: 1 },
        });
        expect(JSON.stringify(report)).not.toContain(roomId);

        expect((await fetch(`http://127.0.0.1:${relay.adminPort}/other`)).status).toBe(404);
        expect((await fetch(`http://127.0.0.1:${relay.port}/stats`)).status).toBe(404);
    });

    test('feedback: stored on POST, listed on the admin listener only', async () => {
        await relay.stop();
        relay = startRelay({
            port: 0,
            adminPort: 0,
            limits: { feedbackPerMinute: 3 },
            log: (line) => logs.push(line),
        });
        const url = `http://127.0.0.1:${relay.port}/feedback`;
        const post = (body: unknown, headers: Record<string, string> = {}) =>
            fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...headers },
                body: JSON.stringify(body),
            });
        const valid = {
            type: 'feature',
            message: 'Dark mode for the QR page',
            email: 'tester@example.com',
            page: '/app/',
        };

        const stored = await post(valid, { origin: `http://127.0.0.1:${relay.port}` });
        expect(stored.status).toBe(201);
        expect(stored.headers.get('x-frame-options')).toBe('DENY');
        expect((await post({ ...valid, email: '' })).status).toBe(400);
        expect((await post(valid, { origin: 'https://evil.example' })).status).toBe(403);
        expect((await post({ ...valid, website: 'spam' })).status).toBe(201);
        expect((await post(valid)).status).toBe(429);
        expect((await fetch(url)).status).toBe(405);

        const listed = await fetch(`http://127.0.0.1:${relay.adminPort}/feedback`);
        const entries = (await listed.json()) as Array<Record<string, string>>;
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject(valid);
        expect(relay.report().totals).toMatchObject({
            feedback: 1,
            rejects: { feedback_spam: 1, feedback_rate_limited: 1 },
        });
        // The log says that feedback arrived, never what it says or who sent it.
        const line = logs.find((entry) => entry.includes('feedback'));
        expect(line).toBe('feedback received (feature)');
        expect(logs.join('\n')).not.toContain('tester@example.com');
    });

    test('pairing by code: the key reaches the phone showing the code, which gets a new code', async () => {
        const keys = generateRoomKeyPair();
        const room = roomIdOf(keys.publicKey);
        const { socket } = await daemon([keys]);
        const waiting = waitingPhone();
        const other = waitingPhone();
        const code = await codeOf(waiting);
        const otherCode = await codeOf(other);
        expect(code).toMatch(new RegExp(`^[${PAIR_CODE_ALPHABET}]{6}$`));
        expect(code).not.toBe(otherCode);
        expect(relay.stats().waiting).toBe(2);

        socket.send({ type: 'pair.offer', id: '1', code, room, key: KEY, computer: 'MAC' });
        expect(await socket.next()).toEqual({
            type: 'pair.offer.result',
            id: '1',
            status: 'delivered',
        });
        expect(await waiting.next()).toEqual({
            type: 'pair.offer',
            room,
            key: KEY,
            computer: 'MAC',
        });
        // The used code is gone: the phone shows a new one, the same code gets nothing else.
        const renewed = await codeOf(waiting);
        expect(renewed).not.toBe(code);
        socket.send({ type: 'pair.offer', id: '2', code, room, key: KEY, computer: 'MAC' });
        expect(await socket.next()).toMatchObject({ id: '2', status: 'unknown_code' });
        await other.expectSilence();

        // Codes and keys never reach the logs.
        const logged = logs.join('\n');
        for (const secret of [code, renewed, otherCode, KEY]) expect(logged).not.toContain(secret);

        waiting.ws.close();
        await waiting.closed;
        await Bun.sleep(20);
        expect(relay.stats().waiting).toBe(1);
        socket.send({
            type: 'pair.offer',
            id: '3',
            code: renewed,
            room,
            key: KEY,
            computer: 'MAC',
        });
        expect(await socket.next()).toMatchObject({ id: '3', status: 'unknown_code' });
    });

    test('pairing by code: only for a room of the connection, and limited per daemon IP', async () => {
        boot({ pairOffersPerMinute: 2 });
        const keys = generateRoomKeyPair();
        const room = roomIdOf(keys.publicKey);
        const { socket } = await daemon([keys]);
        const waiting = waitingPhone();
        const code = await codeOf(waiting);

        const foreign = roomIdOf(generateRoomKeyPair().publicKey);
        socket.send({ type: 'pair.offer', id: '1', code, room: foreign, key: KEY, computer: 'X' });
        expect(await socket.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
        await waiting.expectSilence();

        socket.send({ type: 'pair.offer', id: '2', code: 'ZZZZZZ', room, key: KEY, computer: 'X' });
        expect(await socket.next()).toMatchObject({ status: 'unknown_code' });
        socket.send({ type: 'pair.offer', id: '3', code: 'ZZZZZY', room, key: KEY, computer: 'X' });
        expect(await socket.next()).toMatchObject({ status: 'unknown_code' });
        // Over the limit even with the right code: guessing is slow.
        socket.send({ type: 'pair.offer', id: '4', code, room, key: KEY, computer: 'X' });
        expect(await socket.next()).toMatchObject({ status: 'rate_limited' });
        await waiting.expectSilence();

        // An invalid code is not even parsed as an offer.
        socket.send({ type: 'pair.offer', id: '5', code: 'OOOOOO', room, key: KEY, computer: 'X' });
        expect(await socket.next()).toMatchObject({ type: 'error', code: 'invalid_message' });
    });

    test('pairing by code: codes expire and waiting phones are limited', async () => {
        await relay.stop();
        logs = [];
        relay = startRelay({
            port: 0,
            pairCodeTtlMs: 80,
            limits: { waitingPhones: 1 },
            log: (line) => logs.push(line),
        });
        const waiting = waitingPhone();
        const first = await codeOf(waiting);
        const second = await codeOf(waiting);
        expect(second).not.toBe(first);

        const refused = waitingPhone();
        expect((await refused.closed).code).toBe(CloseCode.rateLimited);
        // Messages from a waiting phone are ignored.
        waiting.send('hello');
        expect(await waiting.next()).toMatchObject({ type: 'pair.code' });
        expect(waiting.ws.readyState).toBe(WebSocket.OPEN);
    });

    test('default limits', () => {
        expect(DEFAULT_LIMITS.deviceMessageBytes).toBe(256 * 1024);
    });
});

describe('relay entry point (pm2)', () => {
    const MAIN = join(import.meta.dir, '..', 'src', 'main.ts');

    // Windows has no SIGTERM: killing the process there does not let it write its statistics.
    test.skipIf(process.platform === 'win32')(
        'starts from the environment, serves health and stops on SIGTERM',
        async () => {
            const dataDir = await mkdtemp(join(tmpdir(), 'palmtop-relay-data-'));
            const child = Bun.spawn(['bun', MAIN], {
                env: {
                    ...process.env,
                    HOST: '127.0.0.1',
                    PORT: '0',
                    ADMIN_PORT: '0',
                    DATA_DIR: dataDir,
                    RELAY_DEVICES_PER_ROOM: '3',
                },
                stderr: 'ignore',
                stdout: 'pipe',
            });
            // Informational lines go to stdout, so pm2 keeps its error log for errors.
            const reader = child.stdout.getReader();
            let output = '';
            while (!/listening on 127\.0\.0\.1:\d+/.test(output)) {
                const { value, done } = await reader.read();
                if (done) throw new Error(`relay exited: ${output}`);
                output += new TextDecoder().decode(value);
            }
            while (!/statistics on 127\.0\.0\.1:\d+/.test(output)) {
                const { value, done } = await reader.read();
                if (done) throw new Error(`relay exited: ${output}`);
                output += new TextDecoder().decode(value);
            }
            const port = output.match(/listening on 127\.0\.0\.1:(\d+)/)?.[1];
            const health = await fetch(`http://127.0.0.1:${port}/healthz`);
            expect(await health.json()).toEqual({ ok: true });
            const adminPort = output.match(/statistics on 127\.0\.0\.1:(\d+)/)?.[1];
            await fetch(`http://127.0.0.1:${port}/version.json`);
            const report = (await (
                await fetch(`http://127.0.0.1:${adminPort}/stats`)
            ).json()) as StatsReport;
            expect(report.relay.persisted).toBe(true);

            child.kill('SIGTERM');
            expect(await child.exited).toBe(0);
            // Written on the way out.
            const saved = JSON.parse(await readFile(join(dataDir, 'stats.json'), 'utf8'));
            expect(saved.version).toBe(1);
            await rm(dataDir, { recursive: true, force: true });
        },
    );

    test('refuses invalid limits', async () => {
        const child = Bun.spawn(['bun', MAIN], {
            env: { ...process.env, PORT: '0', RELAY_DEVICES_PER_ROOM: 'many' },
            stderr: 'pipe',
            stdout: 'ignore',
        });
        expect(await child.exited).toBe(1);
        expect(await new Response(child.stderr).text()).toContain('invalid RELAY_DEVICES_PER_ROOM');
    });
});

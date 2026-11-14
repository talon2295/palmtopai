import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { CloseCode, DAEMON_PROTOCOL_VERSION, parseDaemonMessage } from '@palmtopai/protocol';
import { generateRoomKeyPair, verifyRoomProof } from '@palmtopai/protocol/relay-crypto';
import {
    DeviceHub,
    DeviceRegistry,
    MemoryStorage,
    ProjectRegistry,
    RelayLink,
    type RelaySocket,
    RoomIdentity,
    RoomManager,
} from '../src';
import { createTempHome, waitUntil } from './helpers';

/** A socket driven by the test: it only does what the test tells it to. */
class FakeSocket implements RelaySocket {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    readonly sent: string[] = [];
    closed = false;

    send(data: string): void {
        this.sent.push(data);
    }
    close(): void {
        this.closed = true;
        this.readyState = 3;
    }
    open(): void {
        this.readyState = 1;
        this.onopen?.({});
    }
    receive(message: unknown): void {
        this.onmessage?.({ data: JSON.stringify(message) });
    }
}

describe('RelayLink', () => {
    let cleanup: () => Promise<void>;
    let registry: ProjectRegistry;
    let hub: DeviceHub;
    let sockets: FakeSocket[];
    let link: RelayLink;

    beforeEach(async () => {
        const temp = await createTempHome();
        cleanup = temp.cleanup;
        const storage = new MemoryStorage();
        registry = await ProjectRegistry.open(join(temp.home, 'projects.json'), storage);
        hub = new DeviceHub({
            scope: registry,
            devices: await DeviceRegistry.open(join(temp.home, 'devices.json')),
            rooms: new RoomManager(storage),
            projectList: async () => ({
                computer: { id: registry.computerId, name: 'Test' },
                projects: [],
            }),
            log: () => {},
        });
        sockets = [];
    });

    afterEach(async () => {
        link.stop();
        await cleanup();
    });

    function start(options: { connectTimeoutMs?: number; pairOfferTimeoutMs?: number } = {}) {
        link = new RelayLink({
            url: 'ws://relay.test/',
            registry,
            hub,
            log: () => {},
            minReconnectDelayMs: 10,
            maxReconnectDelayMs: 20,
            ...options,
            createSocket: (url) => {
                expect(url).toBe('ws://relay.test/daemon');
                const socket = new FakeSocket();
                sockets.push(socket);
                return socket;
            },
        });
        link.start();
    }

    test('an error without a close event (Node 22, refused connection) still retries', async () => {
        start();
        const first = sockets[0] as FakeSocket;
        first.onerror?.({});
        expect(link.status).toBe('disconnected');
        expect(first.closed).toBe(true);
        await waitUntil(() => sockets.length === 2, 'a new attempt');
        expect(link.status).toBe('connecting');
        // A late close of the old socket changes nothing.
        first.onclose?.({ code: 1006 });
        expect(sockets).toHaveLength(2);
    });

    test('a connection that is never authorized is dropped and retried', async () => {
        start({ connectTimeoutMs: 30 });
        (sockets[0] as FakeSocket).open();
        await waitUntil(() => sockets.length === 2, 'a retry after the connect timeout');
        expect((sockets[0] as FakeSocket).closed).toBe(true);
    });

    test('answers the challenge with the computer room proof and connects', async () => {
        await registry.resolve({ rootPath: '/tmp/link-repo' });
        start({ connectTimeoutMs: 30 });
        const socket = sockets[0] as FakeSocket;
        socket.open();
        const nonce = 'n'.repeat(43);
        socket.receive({ type: 'challenge', nonce });

        const auth = parseDaemonMessage(socket.sent[0] as string);
        expect(auth).toMatchObject({ type: 'auth', protocol: DAEMON_PROTOCOL_VERSION });
        const proofs = auth?.type === 'auth' ? auth.rooms : [];
        expect(proofs.map((proof) => verifyRoomProof(proof, nonce))).toEqual([registry.roomId]);

        socket.receive({
            type: 'authorized',
            sessionToken: 's'.repeat(43),
            rooms: [registry.roomId],
        });
        expect(link.status).toBe('connected');
        expect(link.release).toBeNull();
        expect(link.isRoomOpen(registry.roomId)).toBe(true);
        // Authorized in time: the connect timeout no longer applies.
        await Bun.sleep(60);
        expect(sockets).toHaveLength(1);
    });

    test('remembers the release announced by the relay', () => {
        start();
        const socket = sockets[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'challenge', nonce: 'n'.repeat(43) });
        const release = { version: '0.2.0', build: 'abcdef012345' };
        socket.receive({ type: 'authorized', sessionToken: 's'.repeat(43), rooms: [], release });
        expect(link.release).toEqual(release);
    });

    /** A link authorized by a fake relay, with the computer room open. */
    async function connected(options: { pairOfferTimeoutMs?: number } = {}) {
        await registry.resolve({ rootPath: '/tmp/link-repo' });
        start(options);
        const socket = sockets[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'challenge', nonce: 'n'.repeat(43) });
        socket.receive({
            type: 'authorized',
            sessionToken: 's'.repeat(43),
            rooms: [registry.roomId],
        });
        socket.sent.length = 0;
        return socket;
    }

    const OFFER = { code: 'ABC123', key: 'k'.repeat(22), computer: 'Test' };

    test('offerPairing sends the key for the computer room and returns the relay answer', async () => {
        const socket = await connected();
        const result = link.offerPairing(OFFER);
        const sent = parseDaemonMessage(socket.sent[0] as string);
        expect(sent).toMatchObject({ type: 'pair.offer', room: registry.roomId, ...OFFER });
        const id = sent?.type === 'pair.offer' ? sent.id : '';
        socket.receive({ type: 'pair.offer.result', id: 'other', status: 'delivered' });
        socket.receive({ type: 'pair.offer.result', id, status: 'unknown_code' });
        expect(await result).toBe('unknown_code');
    });

    test('offerPairing: relay_unavailable when not connected, without an answer or on a drop', async () => {
        start();
        expect(await link.offerPairing(OFFER)).toBe('relay_unavailable');
        link.stop();

        sockets = [];
        let socket = await connected({ pairOfferTimeoutMs: 30 });
        // An old relay does not know pair.offer and never answers it.
        expect(await link.offerPairing(OFFER)).toBe('relay_unavailable');

        link.stop();
        sockets = [];
        socket = await connected();
        const dropped = link.offerPairing(OFFER);
        socket.onclose?.({ code: 1006 });
        expect(await dropped).toBe('relay_unavailable');
    });

    test('a relay refusing the protocol makes the link outdated until it authorizes again', async () => {
        start();
        const first = sockets[0] as FakeSocket;
        first.open();
        first.receive({ type: 'error', code: 'outdated', message: 'run palmtop update' });
        first.onclose?.({ code: CloseCode.outdated });
        expect(link.status).toBe('outdated');

        await waitUntil(() => sockets.length === 2, 'a slow retry');
        const second = sockets[1] as FakeSocket;
        second.open();
        // Still refused on retry: the status stays outdated.
        second.onclose?.({ code: CloseCode.outdated });
        expect(link.status).toBe('outdated');

        await waitUntil(() => sockets.length === 3, 'another retry');
        const third = sockets[2] as FakeSocket;
        third.open();
        third.receive({ type: 'challenge', nonce: 'n'.repeat(43) });
        third.receive({ type: 'authorized', sessionToken: 's'.repeat(43), rooms: [] });
        expect(link.status).toBe('connected');
        third.onclose?.({ code: 1006 });
        expect(link.status).toBe('disconnected');
    });

    describe('rooms of people', () => {
        /** A hub that only records what the link tells it. */
        function stubHub() {
            const calls: string[] = [];
            const hub = {
                setTransport: (transport: unknown) =>
                    calls.push(`transport ${transport ? 'set' : 'null'}`),
                open: (conn: string) => calls.push(`open ${conn}`),
                message: (conn: string, data: string) => calls.push(`message ${conn} ${data}`),
                close: (conn: string) => calls.push(`close ${conn}`),
                closeRoom: (room: string) => calls.push(`closeRoom ${room.slice(0, 4)}`),
            } as unknown as DeviceHub;
            return { calls, hub };
        }
        const guestRoom = () => new RoomIdentity(generateRoomKeyPair());

        test('a room added before the connection goes into the authorization, flagged as a guest', () => {
            const identity = guestRoom();
            const { hub: guestHub } = stubHub();
            start();
            link.addRoom(identity, guestHub);
            // Added after start() but before the challenge: it is part of the first proof.
            const socket = sockets[0] as FakeSocket;
            socket.open();
            const nonce = 'n'.repeat(43);
            socket.receive({ type: 'challenge', nonce });
            const auth = parseDaemonMessage(socket.sent[0] as string);
            const rooms = auth?.type === 'auth' ? auth.rooms : [];
            expect(rooms.map((proof) => verifyRoomProof(proof, nonce))).toEqual([
                registry.roomId,
                identity.roomId,
            ]);
            expect(rooms.map((proof) => proof.guest)).toEqual([undefined, true]);
            expect(link.roomCount).toBe(2);
        });

        test('a room added while connected is opened at the relay, and routes its devices', async () => {
            const socket = await connected();
            const identity = guestRoom();
            const { hub: guestHub, calls } = stubHub();
            link.addRoom(identity, guestHub);

            const open = parseDaemonMessage(socket.sent[0] as string);
            expect(open).toMatchObject({
                type: 'room.open',
                sessionToken: 's'.repeat(43),
                guest: true,
            });
            expect(open?.type === 'room.open' && verifyRoomProof(open, 'n'.repeat(43))).toBe(
                identity.roomId,
            );
            expect(link.isRoomOpen(identity.roomId)).toBe(false);
            socket.receive({ type: 'room.opened', room: identity.roomId });
            expect(link.isRoomOpen(identity.roomId)).toBe(true);

            // Devices of the room go to its hub, the computer's to the computer's.
            socket.receive({ type: 'device.open', conn: 'c'.repeat(16), room: identity.roomId });
            socket.receive({ type: 'device.message', conn: 'c'.repeat(16), data: 'hello' });
            socket.receive({ type: 'device.close', conn: 'c'.repeat(16) });
            socket.receive({ type: 'device.message', conn: 'c'.repeat(16), data: 'late' });
            expect(calls.filter((call) => !call.startsWith('transport'))).toEqual([
                `open ${'c'.repeat(16)}`,
                `message ${'c'.repeat(16)} hello`,
                `close ${'c'.repeat(16)}`,
            ]);
        });

        test('a device of a room the daemon does not serve is not handed to any hub', async () => {
            const socket = await connected();
            const { hub: guestHub, calls } = stubHub();
            socket.receive({ type: 'device.open', conn: 'd'.repeat(16), room: 'x'.repeat(43) });
            socket.receive({ type: 'device.message', conn: 'd'.repeat(16), data: 'hi' });
            expect(calls).toEqual([]);
            void guestHub;
        });

        test('a room removed is closed at the relay, and its hub forgets its devices', async () => {
            const socket = await connected();
            const identity = guestRoom();
            const { hub: guestHub, calls } = stubHub();
            link.addRoom(identity, guestHub);
            socket.receive({ type: 'room.opened', room: identity.roomId });
            socket.receive({ type: 'device.open', conn: 'e'.repeat(16), room: identity.roomId });
            socket.sent.length = 0;
            calls.length = 0;

            link.removeRoom(identity.roomId);
            expect(parseDaemonMessage(socket.sent[0] as string)).toEqual({
                type: 'room.close',
                sessionToken: 's'.repeat(43),
                room: identity.roomId,
            });
            expect(calls).toContain(`closeRoom ${identity.roomId.slice(0, 4)}`);
            expect(link.isRoomOpen(identity.roomId)).toBe(false);
            expect(link.roomCount).toBe(1);
            // The relay's answer changes nothing; a device of the room is not served any more.
            socket.receive({ type: 'room.closed', room: identity.roomId });
            socket.receive({ type: 'device.message', conn: 'e'.repeat(16), data: 'late' });
            expect(calls.some((call) => call.startsWith('message'))).toBe(false);
        });

        test('a room added between the authorization and its answer is opened right after', () => {
            start();
            const socket = sockets[0] as FakeSocket;
            socket.open();
            const nonce = 'n'.repeat(43);
            socket.receive({ type: 'challenge', nonce });
            const identity = guestRoom();
            link.addRoom(identity, stubHub().hub);
            socket.sent.length = 0;
            socket.receive({
                type: 'authorized',
                sessionToken: 's'.repeat(43),
                rooms: [registry.roomId],
            });
            const open = parseDaemonMessage(socket.sent[0] as string);
            expect(open).toMatchObject({ type: 'room.open', guest: true });
            expect(open?.type === 'room.open' && verifyRoomProof(open, nonce)).toBe(
                identity.roomId,
            );
        });

        test('a room removed between the authorization and its answer is closed right after', () => {
            const identity = guestRoom();
            start();
            link.addRoom(identity, stubHub().hub);
            const socket = sockets[0] as FakeSocket;
            socket.open();
            socket.receive({ type: 'challenge', nonce: 'n'.repeat(43) });
            link.removeRoom(identity.roomId);
            socket.sent.length = 0;
            socket.receive({
                type: 'authorized',
                sessionToken: 's'.repeat(43),
                rooms: [registry.roomId, identity.roomId],
            });
            expect(parseDaemonMessage(socket.sent[0] as string)).toEqual({
                type: 'room.close',
                sessionToken: 's'.repeat(43),
                room: identity.roomId,
            });
            expect(link.isRoomOpen(identity.roomId)).toBe(false);
        });

        test('the computer room is never removed', async () => {
            const socket = await connected();
            link.removeRoom(registry.roomId);
            expect(socket.sent).toEqual([]);
            expect(link.isRoomOpen(registry.roomId)).toBe(true);
        });

        test('after a reconnection the rooms are authorized again with the computer', async () => {
            const first = await connected();
            const identity = guestRoom();
            link.addRoom(identity, stubHub().hub);
            first.onclose?.({ code: 1006 });
            expect(link.isRoomOpen(identity.roomId)).toBe(false);

            await waitUntil(() => sockets.length === 2, 'a new attempt');
            const second = sockets[1] as FakeSocket;
            second.open();
            second.receive({ type: 'challenge', nonce: 'm'.repeat(43) });
            const auth = parseDaemonMessage(second.sent[0] as string);
            const rooms = auth?.type === 'auth' ? auth.rooms : [];
            expect(rooms.map((proof) => verifyRoomProof(proof, 'm'.repeat(43)))).toEqual([
                registry.roomId,
                identity.roomId,
            ]);
            second.receive({
                type: 'authorized',
                sessionToken: 't'.repeat(43),
                rooms: [registry.roomId, identity.roomId],
            });
            expect(link.isRoomOpen(identity.roomId)).toBe(true);
            expect(link.isRoomOpen(registry.roomId)).toBe(true);
        });
    });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Daemon, startDaemon } from '@palmtopai/daemon';
import {
    CloseCode,
    createId,
    DAEMON_PROTOCOL_VERSION,
    DEVICE_UNPAIRED,
    exportPublicKey,
    generateDeviceKeys,
    getItem,
    LIMITS,
    listSessions,
    type ProjectState,
    type ServerMessage,
} from '@palmtopai/protocol';
import { type Relay, startRelay } from '@palmtopai/relay';
import { type SocketLike, SyncClient, type SyncSnapshot, unauthorizedReasonOf } from '../src';
import { FakeSocket } from './fake-socket';
import { pairedIdentity, plainTransport, scriptedIdentity, strangerIdentity } from './identity';

function stateOf(snapshot: SyncSnapshot) {
    if (!snapshot.state) throw new Error('no state yet');
    return snapshot.state;
}

async function waitFor(
    client: SyncClient,
    predicate: (snapshot: SyncSnapshot) => boolean,
    timeoutMs = 3_000,
): Promise<SyncSnapshot> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(client.getSnapshot())) {
        if (Date.now() > deadline) {
            const { state: _state, ...rest } = client.getSnapshot();
            throw new Error(`condition not met, client is ${JSON.stringify(rest)}`);
        }
        await Bun.sleep(10);
    }
    return client.getSnapshot();
}

/** The `index`-th fake socket, once the client made it (reconnections wait a moment). */
async function waitForSocket(index: number, timeoutMs = 3_000): Promise<FakeSocket> {
    const deadline = Date.now() + timeoutMs;
    while (!FakeSocket.instances[index]) {
        if (Date.now() > deadline) throw new Error(`no socket ${index}`);
        await Bun.sleep(5);
    }
    return FakeSocket.instances[index] as FakeSocket;
}

describe('SyncClient through a real relay and daemon', () => {
    let home: string;
    let relay: Relay;
    let daemon: Daemon;
    let project: {
        projectId: string;
        roomId: string;
        sessionId: string;
        itemIds: string[];
    };
    const clients: SyncClient[] = [];

    async function boot() {
        daemon = await startDaemon({
            home,
            localPort: 0,
            relayUrl: `ws://127.0.0.1:${relay.port}`,
            relayReconnectDelayMs: { min: 20, max: 200 },
            log: () => {},
        });
    }

    async function roomOpen() {
        const { roomId } = daemon.registry;
        for (let i = 0; i < 300 && !daemon.relay.isRoomOpen(roomId); i++) await Bun.sleep(10);
        return roomId;
    }

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'palmtop-client-'));
        relay = startRelay({ port: 0, log: () => {} });
        await boot();
        const { projectId } = await daemon.registry.resolve({ rootPath: '/tmp/client-repo' });
        const roomId = await roomOpen();
        const room = await daemon.rooms.get(projectId);
        const sessionId = createId();
        const checklistId = createId();
        const itemIds = [createId(), createId()];
        await room?.submitLocal('session.upsert', sessionId, {
            title: 'session',
            startedAt: 1,
        });
        await room?.submitLocal('checklist.create', sessionId, { checklistId, title: 'list' });
        for (const [order, itemId] of itemIds.entries()) {
            await room?.submitLocal('item.add', sessionId, {
                itemId,
                checklistId,
                text: `i${order}`,
                order,
            });
        }
        project = { projectId, roomId, sessionId, itemIds };
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.stop();
        await daemon.stop();
        await relay.stop();
        await rm(home, { recursive: true, force: true });
    });

    async function client(
        deviceId: string,
        overrides: { stranger?: boolean; withoutProject?: boolean } = {},
    ) {
        const instance = new SyncClient({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${project.roomId}`,
            ...(!overrides.withoutProject && { projectId: project.projectId }),
            identity: overrides.stranger
                ? await strangerIdentity(daemon, deviceId)
                : await pairedIdentity(daemon, deviceId),
            minReconnectDelayMs: 20,
            maxReconnectDelayMs: 100,
        });
        clients.push(instance);
        return instance;
    }

    test('a screenshot goes to the computer and comes back, from there and from this device', async () => {
        const phone = await client('phone');
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        const imageId = createId();
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 8, 9]);
        await phone.putImage(project.sessionId, imageId, { mime: 'image/jpeg', bytes });

        // Another device asks the computer for it.
        const tablet = await client('tablet');
        tablet.start();
        await waitFor(tablet, (s) => s.status === 'online');
        expect(await tablet.getImage(imageId)).toEqual({ mime: 'image/jpeg', bytes });
        expect(await tablet.getImage(createId())).toBeNull();
        // The same ask, twice at once, is one request.
        const [a, b] = await Promise.all([tablet.getImage(imageId), tablet.getImage(imageId)]);
        expect(a).toEqual(b);
    });

    test('a screenshot the computer refuses rejects with its reason, and nothing is sent offline', async () => {
        const phone = await client('phone');
        // Not connected yet: nothing is sent, and the reason says so.
        await expect(
            phone.putImage(project.sessionId, createId(), {
                mime: 'image/jpeg',
                bytes: new Uint8Array([0xff, 0xd8, 0xff]),
            }),
        ).rejects.toThrow(/offline/);
        expect(await phone.getImage(createId())).toBeNull();

        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        await expect(
            phone.putImage(project.sessionId, createId(), {
                mime: 'image/jpeg',
                bytes: new Uint8Array([1, 2, 3, 4]),
            }),
        ).rejects.toThrow(/JPEG or WebP/);
        await expect(
            phone.putImage(createId(), createId(), {
                mime: 'image/jpeg',
                bytes: new Uint8Array([0xff, 0xd8, 0xff]),
            }),
        ).rejects.toThrow(/unknown session/);
        await expect(
            phone.putImage(project.sessionId, createId(), {
                mime: 'image/jpeg',
                bytes: new Uint8Array(LIMITS.image + 1),
            }),
        ).rejects.toThrow(/too large/);
    });

    test('connects, receives project info and state', async () => {
        const phone = await client('phone');
        const statuses: string[] = [];
        phone.subscribe(() => statuses.push(phone.getSnapshot().status));
        phone.start();

        const snapshot = await waitFor(phone, (s) => s.status === 'online');
        expect(snapshot.project).toEqual({
            id: project.projectId,
            name: 'client-repo',
            computer: daemon.computerName,
        });
        expect(snapshot.seq).toBe(4);
        expect(snapshot.daemonProtocol).toBe(DAEMON_PROTOCOL_VERSION);
        expect(getItem(stateOf(snapshot), project.itemIds[0] as string)?.text).toBe('i0');
        expect(statuses[0]).toBe('connecting');
    });

    test('knows which sessions an agent waits in, from the computer, and nothing when it is not connected', async () => {
        const phone = await client('phone');
        phone.start();
        const online = await waitFor(phone, (s) => s.status === 'online');
        expect(online.waiting).toEqual([]);
        const key = `${project.projectId}/${project.sessionId}`;
        daemon.doneWaiters.hold(key, 'agent', true);
        const waiting = await waitFor(phone, (s) => (s.waiting?.length ?? 0) > 0);
        expect(waiting.waiting).toEqual([project.sessionId]);
        daemon.doneWaiters.release(key, 'agent');
        await waitFor(phone, (s) => s.waiting?.length === 0);
        phone.stop();
        expect(phone.getSnapshot().waiting).toBeNull();
    });

    test('without a project to follow, the project list makes it live and push is sent', async () => {
        const push = {
            subscription: {
                endpoint: 'https://fcm.googleapis.com/fcm/send/empty',
                keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
            },
            vapid: { publicKey: 'D'.repeat(87), privateKey: 'E'.repeat(43) },
        };
        const phone = await client('phone', { withoutProject: true });
        phone.setPush(push);
        phone.start();
        const snapshot = await waitFor(phone, (s) => s.status === 'online');
        expect(snapshot.computer?.name).toBe(daemon.computerName);
        expect(snapshot.projects.map((entry) => entry.id)).toEqual([project.projectId]);
        expect(snapshot.state).toBeNull();
        for (let i = 0; i < 300 && daemon.push.list().length === 0; i++) {
            await Bun.sleep(10);
        }
        expect(daemon.push.list()).toEqual([{ deviceId: 'phone', registration: push }]);

        // Following a project afterwards still brings its state.
        phone.follow(project.projectId);
        await waitFor(phone, (s) => s.state !== null && s.project?.id === project.projectId);
    });

    test('following no project and then the same one again asks the computer for it again', async () => {
        const phone = await client('phone');
        phone.start();
        await waitFor(phone, (s) => s.status === 'online' && s.state !== null);

        // The list went empty and came back with the same project, on the same connection.
        phone.follow(null);
        await waitFor(phone, (s) => s.state === null);
        phone.follow(project.projectId);
        const snapshot = await waitFor(phone, (s) => s.state !== null);
        expect(snapshot.status).toBe('online');

        // And it can send again.
        const op = phone.setSessionNote(project.sessionId, 'back');
        expect(op).not.toBeNull();
        await waitFor(phone, (s) => s.pendingCount === 0);
    });

    test('the push subscription and the presence go to the computer only, also after reconnecting', async () => {
        const push = {
            subscription: {
                endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
                keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
            },
            vapid: { publicKey: 'D'.repeat(87), privateKey: 'E'.repeat(43) },
        };
        const phone = await client('phone');
        // Set before connecting: sent once synced.
        phone.setPush(push);
        phone.setVisible(false);
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        for (let i = 0; i < 300 && daemon.push.list().length === 0; i++) {
            await Bun.sleep(10);
        }
        // One subscription per device, valid for every project of the computer.
        expect(daemon.push.list()).toEqual([{ deviceId: 'phone', registration: push }]);
        expect(daemon.devices.isVisible(project.projectId, 'phone')).toBe(false);
        expect(JSON.stringify(phone.getSnapshot().state)).not.toContain('fcm.googleapis.com');

        phone.setVisible(true);
        for (let i = 0; i < 300 && !daemon.devices.isVisible(project.projectId, 'phone'); i++) {
            await Bun.sleep(10);
        }
        expect(daemon.devices.isVisible(project.projectId, 'phone')).toBe(true);

        phone.setPush(null);
        for (let i = 0; i < 300 && daemon.push.list().length > 0; i++) {
            await Bun.sleep(10);
        }
        expect(daemon.push.list()).toEqual([]);
    });

    test('a renamed computer reaches connected phones without a resync', async () => {
        const phone = await client('phone');
        phone.start();
        const online = await waitFor(phone, (s) => s.status === 'online');
        await daemon.setComputerName('Office');
        const renamed = await waitFor(phone, (s) => s.project?.computer === 'Office');
        expect(renamed.project).toEqual({
            id: project.projectId,
            name: 'client-repo',
            computer: 'Office',
        });
        expect(renamed.seq).toBe(online.seq);
        expect(renamed.state).toBe(online.state);
    });

    test('the relay forwards only sealed frames: no checklist text, note or key in clear', async () => {
        // Everything the relay carries for this device, both ways, as it carries it.
        const wire: string[] = [];
        const recorded = (url: string): SocketLike => {
            const ws = new WebSocket(url);
            const socket: SocketLike = {
                get readyState() {
                    return ws.readyState;
                },
                onopen: null,
                onmessage: null,
                onclose: null,
                onerror: null,
                send(data) {
                    wire.push(data);
                    ws.send(data);
                },
                close(code, reason) {
                    ws.close(code, reason);
                },
            };
            ws.onopen = (event) => socket.onopen?.(event);
            ws.onmessage = (event) => {
                wire.push(String(event.data));
                socket.onmessage?.({ data: event.data });
            };
            ws.onclose = (event) => socket.onclose?.(event);
            ws.onerror = (event) => socket.onerror?.(event);
            return socket;
        };
        const identity = await pairedIdentity(daemon, 'phone');
        const phone = new SyncClient({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${project.roomId}`,
            projectId: project.projectId,
            identity,
            createSocket: recorded,
        });
        clients.push(phone);
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        phone.updateItem(project.sessionId, {
            itemId: project.itemIds[0] as string,
            status: 'cancelled',
            note: 'NOTE-FROM-THE-PHONE',
        });
        await waitFor(phone, (s) => s.pendingCount === 0);
        const room = await daemon.rooms.get(project.projectId);
        await room?.submitLocal('item.add', project.sessionId, {
            itemId: createId(),
            checklistId: Object.keys(room.state.checklists)[0] as string,
            text: 'TEXT-FROM-THE-AGENT',
            order: 9,
        });
        await waitFor(phone, (s) => JSON.stringify(s.state).includes('TEXT-FROM-THE-AGENT'));

        const all = wire.join('\n');
        for (const secret of [
            'NOTE-FROM-THE-PHONE',
            'TEXT-FROM-THE-AGENT',
            'client-repo',
            project.projectId,
            project.sessionId,
            daemon.computerName,
        ]) {
            expect(all).not.toContain(secret);
        }
        // Three plain messages (hello, welcome, auth: public keys and signatures), then sealed.
        const types = wire.map((frame) => (JSON.parse(frame) as { type: string }).type);
        expect(types.slice(0, 3)).toEqual(['e2e.hello', 'e2e.welcome', 'e2e.auth']);
        expect(new Set(types.slice(3))).toEqual(new Set(['sealed']));
        expect(types.length).toBeGreaterThan(6);
    });

    test('an update is visible immediately, confirmed by the echo, and reaches other devices', async () => {
        const phone = await client('phone');
        const tablet = await client('tablet');
        phone.start();
        tablet.start();
        await waitFor(phone, (s) => s.status === 'online');
        await waitFor(tablet, (s) => s.status === 'online');

        const itemId = project.itemIds[0] as string;
        phone.updateItem(project.sessionId, { itemId, status: 'question', note: 'why?' });
        const optimistic = phone.getSnapshot();
        expect(optimistic.pendingCount).toBe(1);
        expect(getItem(stateOf(optimistic), itemId)).toMatchObject({
            status: 'question',
            note: 'why?',
        });

        await waitFor(phone, (s) => s.pendingCount === 0 && s.seq === 5);
        const remote = await waitFor(tablet, (s) => s.seq === 5);
        expect(getItem(stateOf(remote), itemId)).toMatchObject({
            status: 'question',
            note: 'why?',
        });
        expect(remote.state).toEqual(phone.getSnapshot().state);
    });

    test('a rejected op is rolled back and reported', async () => {
        const phone = await client('phone');
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        const itemId = project.itemIds[0] as string;

        // Wrong session for this item: the daemon refuses it.
        const op = phone.updateItem(createId(), { itemId, status: 'done' });
        expect(getItem(stateOf(phone.getSnapshot()), itemId)?.status).toBe('done');

        const after = await waitFor(phone, (s) => s.lastError !== null);
        expect(after.lastError).toMatchObject({ code: 'forbidden', opId: op?.opId });
        expect(after.pendingCount).toBe(0);
        expect(getItem(stateOf(after), itemId)?.status).toBeUndefined();

        phone.dismissError();
        expect(phone.getSnapshot().lastError).toBeNull();
    });

    test('follows another project on the same connection, keeping what is not confirmed', async () => {
        // A second project of the same computer: one pairing covers both.
        const { projectId: otherId } = await daemon.registry.resolve({ rootPath: '/tmp/other' });
        const otherRoom = await daemon.rooms.get(otherId);
        const otherSession = createId();
        const otherChecklist = createId();
        const otherItem = createId();
        await otherRoom?.submitLocal('session.upsert', otherSession, {
            title: 'other',
            startedAt: 1,
        });
        await otherRoom?.submitLocal('checklist.create', otherSession, {
            checklistId: otherChecklist,
            title: 'other list',
        });
        await otherRoom?.submitLocal('item.add', otherSession, {
            itemId: otherItem,
            checklistId: otherChecklist,
            text: 'o0',
            order: 0,
        });

        const phone = await client('phone');
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        expect(
            phone
                .getSnapshot()
                .projects.map((entry) => entry.id)
                .sort(),
        ).toEqual([project.projectId, otherId].sort());

        // An edit that the computer has not confirmed yet, then a switch away and back.
        await daemon.stop();
        await waitFor(phone, (s) => s.status === 'daemon-offline');
        const [first] = project.itemIds as [string];
        phone.updateItem(project.sessionId, { itemId: first, status: 'done' });
        expect(phone.getSnapshot().pendingCount).toBe(1);

        phone.follow(otherId);
        expect(phone.getSnapshot().projectId).toBe(otherId);
        // The other project starts from nothing known, without the pending op of the first one.
        expect(phone.getSnapshot().state).toBeNull();
        expect(phone.getSnapshot().pendingCount).toBe(0);

        await boot();
        const inOther = await waitFor(
            phone,
            (s) => s.status === 'online' && s.project?.id === otherId,
            5_000,
        );
        expect(Object.keys(stateOf(inOther).items)).toEqual([otherItem]);
        // One connection for both: the computer sees the device only in the project it follows.
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(0);
        expect(daemon.devices.connectedDevices(otherId)).toBe(1);

        // Back to the first project: the edit made offline is still there and gets delivered.
        phone.follow(project.projectId);
        expect(phone.getSnapshot().pendingCount).toBe(1);
        await waitFor(
            phone,
            (s) => s.status === 'online' && s.project?.id === project.projectId && !s.pendingCount,
            5_000,
        );
        const room = await daemon.rooms.get(project.projectId);
        expect(getItem(room?.state as ProjectState, first)?.status).toBe('done');
    });

    test('edits made while the daemon is down are sent after it comes back', async () => {
        const phone = await client('phone');
        const tablet = await client('tablet');
        phone.start();
        tablet.start();
        await waitFor(phone, (s) => s.status === 'online');
        await waitFor(tablet, (s) => s.status === 'online');

        await daemon.stop();
        // The relay tells the phone that the computer is gone.
        await waitFor(phone, (s) => s.status === 'daemon-offline');
        const statuses: string[] = [];
        phone.subscribe(() => statuses.push(phone.getSnapshot().status));
        // Several retries while the daemon is down.
        await Bun.sleep(300);

        const [first, second] = project.itemIds as [string, string];
        phone.updateItem(project.sessionId, { itemId: first, status: 'done' });
        phone.updateItem(project.sessionId, { itemId: second, status: 'cancelled', note: 'skip' });
        expect(phone.getSnapshot().pendingCount).toBe(2);

        await boot();
        const synced = await waitFor(
            phone,
            (s) => s.status === 'online' && s.pendingCount === 0,
            5_000,
        );
        expect(synced.seq).toBe(6);
        // Retries do not flip the status to "connecting": the offline notice stays visible.
        expect(statuses).not.toContain('connecting');
        expect(statuses).toContain('online');
        const remote = await waitFor(tablet, (s) => s.status === 'online' && s.seq === 6, 5_000);
        expect(getItem(stateOf(remote), second)).toMatchObject({
            status: 'cancelled',
            note: 'skip',
        });
        expect(remote.state).toEqual(synced.state);
    });

    test('a session deleted while the daemon is down is deleted everywhere once it is back', async () => {
        const phone = await client('phone');
        const tablet = await client('tablet');
        phone.start();
        tablet.start();
        await waitFor(phone, (s) => s.status === 'online');
        await waitFor(tablet, (s) => s.status === 'online');

        await daemon.stop();
        await waitFor(phone, (s) => s.status === 'daemon-offline');
        phone.removeSession(project.sessionId);
        const optimistic = phone.getSnapshot();
        expect(optimistic.pendingCount).toBe(1);
        expect(listSessions(stateOf(optimistic))).toEqual([]);
        expect(getItem(stateOf(optimistic), project.itemIds[0] as string)).toBeNull();

        await boot();
        const synced = await waitFor(
            phone,
            (s) => s.status === 'online' && s.pendingCount === 0,
            5_000,
        );
        expect(synced.lastError).toBeNull();
        const remote = await waitFor(tablet, (s) => s.status === 'online' && s.seq === synced.seq);
        expect(listSessions(stateOf(remote))).toEqual([]);
        const room = await daemon.rooms.get(project.projectId);
        expect(listSessions(room?.state as ProjectState)).toEqual([]);
    });

    test('queued ops of a session deleted on the computer are dropped without an error', async () => {
        const phone = await client('phone');
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');

        phone.stop();
        phone.updateItem(project.sessionId, {
            itemId: project.itemIds[0] as string,
            status: 'done',
        });
        phone.removeSession(project.sessionId);
        expect(phone.getSnapshot().pendingCount).toBe(2);
        const room = await daemon.rooms.get(project.projectId);
        await room?.submitLocal('session.remove', project.sessionId, {});

        phone.start();
        const synced = await waitFor(phone, (s) => s.status === 'online');
        expect(synced.pendingCount).toBe(0);
        expect(listSessions(stateOf(synced))).toEqual([]);
        await Bun.sleep(100);
        expect(phone.getSnapshot().lastError).toBeNull();
    });

    test('queued ops for a checklist the owner took away are dropped without an error', async () => {
        const phone = await client('phone');
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');

        phone.stop();
        phone.updateItem(project.sessionId, {
            itemId: project.itemIds[0] as string,
            status: 'done',
        });
        expect(phone.getSnapshot().pendingCount).toBe(1);
        const room = await daemon.rooms.get(project.projectId);
        const checklistId = getItem(room?.state as ProjectState, project.itemIds[0] as string)
            ?.checklistId as string;
        await room?.submitLocal('checklist.remove', project.sessionId, { checklistId });

        phone.start();
        const synced = await waitFor(phone, (s) => s.status === 'online');
        expect(synced.pendingCount).toBe(0);
        await Bun.sleep(100);
        expect(phone.getSnapshot().lastError).toBeNull();
    });

    test('a device the computer does not know stops without retrying', async () => {
        const intruder = await client('intruder', { stranger: true });
        intruder.start();
        const snapshot = await waitFor(intruder, (s) => s.status === 'unauthorized');
        expect(snapshot.state).toBeNull();
        expect(snapshot.unauthorizedReason).toBe('not-paired');
        await Bun.sleep(150);
        expect(intruder.getSnapshot().status).toBe('unauthorized');
    });

    test('a device whose keys were made again is told apart: the computer refuses the key', async () => {
        await pairedIdentity(daemon, 'phone-lost');
        // The same id, new keys: what the browser leaves after deleting IndexedDB.
        const lost = new SyncClient({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${project.roomId}`,
            projectId: project.projectId,
            identity: await strangerIdentity(daemon, 'phone-lost'),
        });
        clients.push(lost);
        lost.start();
        const snapshot = await waitFor(lost, (s) => s.status === 'unauthorized');
        expect(snapshot.unauthorizedReason).toBe('key');
        // Nothing reached the room on its behalf.
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(0);
    });

    test('a computer that proves another room key than the pinned one is told apart', async () => {
        const other = await generateDeviceKeys();
        const identity = await pairedIdentity(daemon, 'phone');
        const pinned = new SyncClient({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${project.roomId}`,
            projectId: project.projectId,
            identity: { ...identity, computerKey: await exportPublicKey(other.publicKey) },
        });
        clients.push(pinned);
        pinned.start();
        const snapshot = await waitFor(pinned, (s) => s.status === 'unauthorized');
        expect(snapshot.unauthorizedReason).toBe('computer-key');
    });

    test('a reason is read from what the computer said, or from being unpaired', () => {
        expect(unauthorizedReasonOf('the device did not prove its key', false)).toBe('key');
        expect(unauthorizedReasonOf('the computer did not prove its key', false)).toBe(
            'computer-key',
        );
        expect(unauthorizedReasonOf('not paired', false)).toBe('not-paired');
        expect(unauthorizedReasonOf('not paired', true)).toBe('revoked');
        expect(unauthorizedReasonOf(undefined, false)).toBe('other');
    });

    test('edits before the first sync do nothing', async () => {
        const phone = await client('phone');
        expect(
            phone.updateItem(project.sessionId, { itemId: createId(), status: 'done' }),
        ).toBeNull();
        expect(phone.removeSession(project.sessionId)).toBeNull();
        expect(phone.getSnapshot().pendingCount).toBe(0);
    });
});

describe('SyncClient protocol edge cases', () => {
    const projectId = createId();
    const info = { id: projectId, name: 'demo' };
    const emptyState = { projectId, lamport: 0, sessions: {}, checklists: {}, items: {} };

    beforeEach(() => {
        FakeSocket.instances = [];
    });

    function fakeClient(heartbeatMs = 60_000) {
        return new SyncClient({
            url: 'ws://fake/ws',
            projectId,
            identity: scriptedIdentity,
            transport: plainTransport,
            createSocket: () => new FakeSocket(),
            minReconnectDelayMs: 5,
            maxReconnectDelayMs: 20,
            heartbeatMs,
        });
    }

    test('hello carries lastSeq only once a state is known', async () => {
        const c = fakeClient();
        c.start();
        const first = FakeSocket.instances[0] as FakeSocket;
        first.open();
        expect(first.sent[0]).not.toHaveProperty('lastSeq');

        first.receive({ type: 'snapshot', project: info, state: emptyState, seq: 7 });
        first.close(1006);
        await Bun.sleep(40);
        const second = FakeSocket.instances[1] as FakeSocket;
        second.open();
        expect(second.sent[0]).toMatchObject({ type: 'hello', lastSeq: 7 });
        c.stop();
    });

    test('a screenshot waiting for the computer fails when the connection is lost, and the same ask is sent once', async () => {
        const c = fakeClient();
        c.start();
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'snapshot', project: info, state: emptyState, seq: 1 });
        const imageId = createId();
        const asked = [c.getImage(imageId), c.getImage(imageId)];
        await Bun.sleep(5);
        expect(socket.sent.filter((m) => (m as { type: string }).type === 'image.get')).toEqual([
            { type: 'image.get', projectId, imageId },
        ]);
        const lost = Promise.allSettled(asked);
        socket.close(1006);
        const outcomes = await lost;
        expect(outcomes.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
        c.stop();
    });

    test('the answers about a screenshot are told apart by its id', async () => {
        const c = fakeClient();
        c.start();
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'snapshot', project: info, state: emptyState, seq: 1 });
        const [one, two] = [createId(), createId()];
        const first = c.getImage(one);
        const second = c.getImage(two);
        await Bun.sleep(5);
        socket.receive({ type: 'image.missing', imageId: two });
        socket.receive({ type: 'image', imageId: one, mime: 'image/jpeg', data: '/9j/AQI=' });
        expect(await second).toBeNull();
        expect(await first).toEqual({
            mime: 'image/jpeg',
            bytes: new Uint8Array([0xff, 0xd8, 0xff, 1, 2]),
        });
        c.stop();
    });

    test('a seq gap drops the local copy and reconnects for a snapshot', async () => {
        const c = fakeClient();
        c.start();
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'snapshot', project: info, state: emptyState, seq: 3 });
        socket.receive({
            type: 'op',
            seq: 5,
            op: {
                v: 1,
                opId: createId(),
                projectId,
                sessionId: createId(),
                type: 'session.upsert',
                payload: { title: 'x' },
                clock: { lamport: 1, deviceId: 'palmtop-daemon' },
                ts: 1,
            },
        });
        expect(socket.closedWith).toBe(4000);
        await Bun.sleep(40);
        const next = FakeSocket.instances[1] as FakeSocket;
        next.open();
        expect(next.sent[0]).not.toHaveProperty('lastSeq');
        c.stop();
    });

    test('a rejection caused by a session deleted in the meantime is not reported', () => {
        const c = fakeClient();
        c.start();
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        const sessionId = createId();
        const daemonOp = (
            seq: number,
            type: 'session.upsert' | 'session.remove',
            payload: object,
        ) =>
            ({
                type: 'op',
                seq,
                op: {
                    v: 1,
                    opId: createId(),
                    projectId,
                    sessionId,
                    type,
                    payload,
                    clock: { lamport: seq, deviceId: 'palmtop-daemon' },
                    ts: seq,
                },
            }) as ServerMessage;
        socket.receive({ type: 'snapshot', project: info, state: emptyState, seq: 0 });
        socket.receive(daemonOp(1, 'session.upsert', { title: 'x', startedAt: 1 }));

        const mine = c.removeSession(sessionId);
        expect(socket.sent).toContainEqual({ type: 'op', op: mine });
        // The computer deleted it first: the daemon refuses the phone's copy.
        socket.receive(daemonOp(2, 'session.remove', {}));
        socket.receive({
            type: 'error',
            code: 'forbidden',
            message: 'unknown session',
            opId: mine?.opId as string,
        });
        expect(c.getSnapshot()).toMatchObject({ pendingCount: 0, lastError: null });

        // Other rejections are still reported.
        socket.receive({ type: 'error', code: 'forbidden', message: 'nope', opId: createId() });
        expect(c.getSnapshot().lastError).toMatchObject({ message: 'nope' });
        c.stop();
    });

    test('a broken channel is tried again; a refusal about this device is not', async () => {
        const c = fakeClient();
        c.start();
        const sockets = () => FakeSocket.instances.length;
        const first = FakeSocket.instances.at(-1) as FakeSocket;
        first.open();
        first.receive({ type: 'snapshot', project: info, state: emptyState, seq: 0 });
        expect(c.getSnapshot().status).toBe('online');

        // A frame lost on a bad network: not "Not paired", the client connects again.
        const before = sockets();
        first.close(CloseCode.unauthorized, 'frame out of sequence');
        await waitFor(c, () => sockets() > before);
        expect(c.getSnapshot().status).toBe('connecting');
        const second = FakeSocket.instances.at(-1) as FakeSocket;
        second.open();
        second.receive({ type: 'snapshot', project: info, state: emptyState, seq: 0 });
        expect(c.getSnapshot().status).toBe('online');

        // The computer refuses the key: final at once, nothing tried again.
        const known = sockets();
        second.close(CloseCode.unauthorized, 'the device did not prove its key');
        await waitFor(c, (s) => s.status === 'unauthorized');
        expect(c.getSnapshot().unauthorizedReason).toBe('key');
        await Bun.sleep(60);
        expect(sockets()).toBe(known);
        c.stop();
    });

    test('a channel that keeps breaking gives up after a few tries, until the device wakes up', async () => {
        const c = fakeClient();
        c.start();
        for (let i = 0; i <= 5; i++) {
            const socket = await waitForSocket(i);
            socket.open();
            socket.close(CloseCode.unauthorized, 'frame rejected');
        }
        await waitFor(c, (s) => s.status === 'unauthorized');
        expect(c.getSnapshot().unauthorizedReason).toBe('other');
        const count = FakeSocket.instances.length;
        await Bun.sleep(60);
        expect(FakeSocket.instances.length).toBe(count);
        // Back on screen, or online again: one more chance.
        c.reconnectNow();
        expect(FakeSocket.instances.length).toBe(count + 1);
        expect(c.getSnapshot().status).toBe('connecting');
        c.stop();
    });

    test('unpair counts only when the computer said so: a bare 4401 could come from the relay', async () => {
        const unpairOn = async (answer: (socket: FakeSocket) => void) => {
            const c = fakeClient();
            c.start();
            const socket = FakeSocket.instances.at(-1) as FakeSocket;
            socket.open();
            socket.receive({ type: 'snapshot', project: info, state: emptyState, seq: 0 });
            const result = c.unpair(500);
            expect(socket.sent).toContainEqual({ type: 'device.unpair' });
            answer(socket);
            return result;
        };
        expect(
            await unpairOn((socket) => {
                socket.receive({ type: 'error', code: 'unauthorized', message: DEVICE_UNPAIRED });
                socket.close(CloseCode.unauthorized);
            }),
        ).toBe(true);
        expect(await unpairOn((socket) => socket.close(CloseCode.unauthorized))).toBe(false);
        expect(await unpairOn(() => {})).toBe(false);
    });

    test('a silent connection is recycled by the heartbeat', async () => {
        const c = fakeClient(10);
        c.start();
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'snapshot', project: info, state: emptyState, seq: 0 });
        await Bun.sleep(80);
        expect(socket.sent).toContainEqual({ type: 'ping' });
        expect(socket.closedWith).toBe(4000);
        expect(FakeSocket.instances.length).toBeGreaterThan(1);
        c.stop();
    });

    test('server pings are answered and stop() prevents reconnection', async () => {
        const c = fakeClient();
        c.start();
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        socket.receive({ type: 'ping' });
        expect(socket.sent).toContainEqual({ type: 'pong' });
        c.stop();
        await Bun.sleep(40);
        expect(FakeSocket.instances).toHaveLength(1);
        expect(c.getSnapshot().status).toBe('stopped');
    });
});

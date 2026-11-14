import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Daemon, startDaemon } from '@palmtopai/daemon';
import {
    applyAll,
    createId,
    createOp,
    getItem,
    type Op,
    type ProjectState,
} from '@palmtopai/protocol';
import { type Relay, startRelay } from '@palmtopai/relay';
import { IDBFactory } from 'fake-indexeddb';
import {
    CACHE_VERSION,
    type CachedProject,
    type ClientCache,
    indexedDbCache,
    parseCachedProject,
    queuedProjects,
    SyncClient,
    type SyncSnapshot,
} from '../src';
import { FakeSocket } from './fake-socket';
import { pairedIdentity, plainTransport, scriptedIdentity } from './identity';

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

/** A small project built from daemon ops: one session, one checklist, two items. */
function sampleProject() {
    const projectId = createId();
    const sessionId = createId();
    const checklistId = createId();
    const itemIds = [createId(), createId()] as [string, string];
    let lamport = 0;
    const daemonOp = (type: Op['type'], payload: object) =>
        createOp({
            projectId,
            sessionId,
            type,
            payload,
            clock: { lamport: ++lamport, deviceId: 'palmtop-daemon' },
        } as Parameters<typeof createOp>[0]);
    const empty: ProjectState = { projectId, lamport: 0, sessions: {}, checklists: {}, items: {} };
    const state = applyAll(empty, [
        daemonOp('session.upsert', { title: 's', startedAt: 1 }),
        daemonOp('checklist.create', { checklistId, title: 'list' }),
        ...itemIds.map((itemId, order) =>
            daemonOp('item.add', { itemId, checklistId, text: `i${order}`, order }),
        ),
    ]);
    const phoneOp = (itemId: string, status: 'done' | 'cancelled', at: number) =>
        createOp({
            projectId,
            sessionId,
            type: 'item.update',
            payload: { itemId, status },
            clock: { lamport: at, deviceId: 'phone' },
        });
    return { projectId, sessionId, itemIds, state, phoneOp };
}

describe('indexedDbCache', () => {
    let factory: IDBFactory;
    beforeEach(() => {
        factory = new IDBFactory();
    });

    test('keeps each project of each computer apart, and clear() forgets one computer', async () => {
        const { projectId, state, phoneOp, itemIds } = sampleProject();
        const mac = indexedDbCache({ scope: 'mac', indexedDB: factory });
        const linux = indexedDbCache({ scope: 'linux', indexedDB: factory });
        const entry: CachedProject = {
            projectId,
            project: { id: projectId, name: 'demo' },
            state,
            seq: 4,
            pending: [phoneOp(itemIds[0], 'done', 5), phoneOp(itemIds[0], 'cancelled', 6)],
            syncedAt: 1234,
        };
        await mac.save(entry);
        await linux.save({ ...entry, seq: 9, pending: [] });

        expect(await mac.load(projectId)).toEqual(entry);
        expect((await linux.load(projectId))?.seq).toBe(9);
        expect(await mac.load(createId())).toBeNull();
        const other = createId();
        await mac.save({ ...entry, projectId: other, pending: [] });
        expect((await mac.projectIds()).sort()).toEqual([projectId, other].sort());
        expect(await queuedProjects(mac)).toEqual([projectId]);
        expect(await queuedProjects(linux)).toEqual([]);

        await mac.clear();
        expect(await mac.load(projectId)).toBeNull();
        expect((await linux.load(projectId))?.seq).toBe(9);
        await linux.remove(projectId);
        expect(await linux.load(projectId)).toBeNull();
    });

    test('keeps the screenshots of each computer apart, prunes them, and clear() takes them too', async () => {
        const mac = indexedDbCache({ scope: 'mac', indexedDB: factory });
        const linux = indexedDbCache({ scope: 'linux', indexedDB: factory });
        const [one, two] = [createId(), createId()];
        const image = { mime: 'image/jpeg' as const, bytes: new Uint8Array([255, 216, 255, 1, 2]) };
        await mac.saveImage?.(one, image);
        await mac.saveImage?.(two, { mime: 'image/webp', bytes: new Uint8Array([82, 73]) });
        await linux.saveImage?.(one, { ...image, bytes: new Uint8Array([9]) });

        expect(await mac.loadImage?.(one)).toEqual(image);
        expect((await mac.loadImage?.(two))?.mime).toBe('image/webp');
        expect(await mac.loadImage?.(createId())).toBeNull();
        expect(await linux.loadImage?.(one)).toEqual({ ...image, bytes: new Uint8Array([9]) });

        await mac.pruneImages?.(new Set([one]));
        expect(await mac.loadImage?.(two)).toBeNull();
        expect(await mac.loadImage?.(one)).toEqual(image);
        expect(await linux.loadImage?.(one)).not.toBeNull();

        await mac.clear();
        expect(await mac.loadImage?.(one)).toBeNull();
        expect(await linux.loadImage?.(one)).not.toBeNull();
    });

    test('a database made before the screenshots gets their store when it is opened again', async () => {
        const old = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = factory.open('palmtop', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('projects');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        old.close();
        const cache = indexedDbCache({ scope: 'mac', indexedDB: factory });
        const id = createId();
        await cache.saveImage?.(id, { mime: 'image/jpeg', bytes: new Uint8Array([1, 2, 3]) });
        expect((await cache.loadImage?.(id))?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    });

    test('a screenshot to be sent is kept with where it goes, until the computer has it', async () => {
        const cache = indexedDbCache({ scope: 'mac', indexedDB: factory });
        const [one, two] = [createId(), createId()];
        const [project, session] = [createId(), createId()];
        const image = { mime: 'image/jpeg' as const, bytes: new Uint8Array([255, 216, 255, 5]) };
        await cache.savePendingImage?.({
            imageId: one,
            projectId: project,
            sessionId: session,
            image,
        });
        await cache.saveImage?.(two, image);

        expect(await cache.pendingImages?.()).toEqual([
            { imageId: one, projectId: project, sessionId: session, image },
        ]);
        // Showing it again does not make it forget it is still to be sent; nor does a prune.
        await cache.saveImage?.(one, image);
        await cache.pruneImages?.(new Set());
        expect((await cache.pendingImages?.())?.map((entry) => entry.imageId)).toEqual([one]);
        expect(await cache.loadImage?.(two)).toBeNull();

        await cache.clearPendingImage?.(one);
        expect(await cache.pendingImages?.()).toEqual([]);
        expect(await cache.loadImage?.(one)).toEqual(image);
    });

    test('what waits for a project that is gone is dropped with it', async () => {
        const cache = indexedDbCache({ scope: 'mac', indexedDB: factory });
        const [gone, kept] = [createId(), createId()];
        const image = { mime: 'image/jpeg' as const, bytes: new Uint8Array([255, 216, 255]) };
        await cache.savePendingImage?.({
            imageId: createId(),
            projectId: gone,
            sessionId: createId(),
            image,
        });
        await cache.savePendingImage?.({
            imageId: createId(),
            projectId: kept,
            sessionId: createId(),
            image,
        });
        await cache.remove(gone);
        expect((await cache.pendingImages?.())?.map((entry) => entry.projectId)).toEqual([kept]);
    });

    test('the protocol of the computer is kept with the project, and an entry without it still reads', async () => {
        const cache = indexedDbCache({ scope: 'mac', indexedDB: factory });
        const { projectId, state } = sampleProject();
        const entry: CachedProject = {
            projectId,
            project: { id: projectId, name: 'demo' },
            state,
            seq: 1,
            pending: [],
            syncedAt: 1,
        };
        await cache.save({ ...entry, protocol: 6 });
        expect((await cache.load(projectId))?.protocol).toBe(6);
        await cache.save(entry);
        expect((await cache.load(projectId))?.protocol).toBeUndefined();
    });

    test('a state cached before choices is dropped, so the fields it lost come back', () => {
        const { projectId, state, phoneOp, itemIds } = sampleProject();
        const op = phoneOp(itemIds[1], 'done', 5);
        // Version 1 is what an app without `kind`, `pick` and `detail` wrote: zod had dropped
        // them from the ops it validated, and resuming from `seq` would never send them again.
        const stale = parseCachedProject(projectId, {
            v: 1,
            project: null,
            state,
            seq: 7,
            syncedAt: 1,
            pending: [op],
        });
        expect(stale).toMatchObject({ state: null, seq: 0, pending: [op] });
    });

    test('a state cached before shared copies is dropped, so `origin` comes back', () => {
        const { projectId, state, phoneOp, itemIds } = sampleProject();
        const op = phoneOp(itemIds[1], 'done', 5);
        // Version 2 is what an app without `origin` wrote: it dropped the field from the ops.
        const stale = parseCachedProject(projectId, {
            v: 2,
            project: null,
            state,
            seq: 7,
            syncedAt: 1,
            pending: [op],
        });
        expect(stale).toMatchObject({ state: null, seq: 0, pending: [op] });
    });

    test('a record written by a newer or broken app keeps its queued ops', () => {
        const { projectId, state, phoneOp, itemIds } = sampleProject();
        const op = phoneOp(itemIds[1], 'done', 5);
        expect(parseCachedProject(projectId, { v: 99, state, seq: 1, pending: [op] })).toEqual({
            projectId,
            project: null,
            state: null,
            seq: 0,
            pending: [op],
            syncedAt: null,
        });
        // Invalid ops, and ops of another project, are skipped one by one.
        const stored = parseCachedProject(projectId, {
            v: CACHE_VERSION,
            project: null,
            state,
            seq: 4,
            syncedAt: null,
            pending: [{ nope: true }, { ...op, projectId: createId() }, op],
        });
        expect(stored?.pending).toEqual([op]);
        expect(stored?.state).toEqual(state);
        expect(parseCachedProject(projectId, { v: 99 })).toBeNull();
        expect(parseCachedProject(projectId, undefined)).toBeNull();
        // A state of another project is not shown.
        expect(
            parseCachedProject(createId(), {
                v: CACHE_VERSION,
                project: null,
                state,
                seq: 4,
                syncedAt: null,
                pending: [],
            }),
        ).toBeNull();
    });
});

describe('SyncClient with a cache, scripted daemon', () => {
    beforeEach(() => {
        FakeSocket.instances = [];
    });

    function memoryCache(entries: CachedProject[] = []) {
        const store = new Map(entries.map((entry) => [entry.projectId, entry]));
        const cache: ClientCache & { store: typeof store } = {
            store,
            load: async (projectId) => store.get(projectId) ?? null,
            save: async (entry) => {
                store.set(entry.projectId, entry);
            },
            remove: async (projectId) => {
                store.delete(projectId);
            },
            projectIds: async () => [...store.keys()],
            clear: async () => store.clear(),
        };
        return cache;
    }

    function fakeClient(projectId: string, cache: ClientCache) {
        return new SyncClient({
            url: 'ws://fake/ws',
            projectId,
            identity: scriptedIdentity,
            transport: plainTransport,
            createSocket: () => new FakeSocket(),
            minReconnectDelayMs: 5,
            maxReconnectDelayMs: 20,
            heartbeatMs: 60_000,
            cache,
        });
    }

    test('shows the cached state before connecting and resumes from its seq', async () => {
        const sample = sampleProject();
        const op = sample.phoneOp(sample.itemIds[0], 'done', 10);
        const cache = memoryCache([
            {
                projectId: sample.projectId,
                project: { id: sample.projectId, name: 'demo' },
                state: sample.state,
                seq: 4,
                pending: [op],
                syncedAt: 1234,
            },
        ]);
        const c = fakeClient(sample.projectId, cache);
        c.start();
        await Bun.sleep(0);
        const socket = FakeSocket.instances[0] as FakeSocket;
        expect(c.getSnapshot()).toMatchObject({
            status: 'connecting',
            project: { name: 'demo' },
            seq: 4,
            pendingCount: 1,
            syncedAt: 1234,
        });
        expect(getItem(c.getSnapshot().state as ProjectState, sample.itemIds[0])?.status).toBe(
            'done',
        );

        socket.open();
        expect(socket.sent[0]).toMatchObject({
            type: 'hello',
            projectId: sample.projectId,
            lastSeq: 4,
        });
        // Nothing is sent before the computer has caught the client up.
        expect(socket.sent).toHaveLength(1);
        socket.receive({
            type: 'ops',
            project: { id: sample.projectId, name: 'demo' },
            ops: [],
            seq: 4,
        });
        expect(socket.sent).toContainEqual({ type: 'op', op });
        expect(c.getSnapshot().syncedAt).toBeGreaterThan(1234);
        c.stop();
    });

    const person = (name: string) => ({
        name,
        state: 'open' as const,
        expiresAt: 5_000,
        checklists: [],
        items: {},
    });

    test('the answers of the people are shown from the cache, replaced by the computer, and cleared by a sync without any', async () => {
        const sample = sampleProject();
        const sessions = [{ sessionId: sample.sessionId, people: [person('Mario')] }];
        const cache = memoryCache([
            {
                projectId: sample.projectId,
                project: { id: sample.projectId, name: 'demo' },
                state: sample.state,
                seq: 4,
                pending: [],
                syncedAt: 1,
                shares: sessions,
            },
        ]);
        const c = fakeClient(sample.projectId, cache);
        c.start();
        await Bun.sleep(0);
        const socket = FakeSocket.instances.at(-1) as FakeSocket;
        expect(c.getSnapshot().shares).toEqual(sessions);

        socket.open();
        // Another project's answers are not ours.
        socket.receive({ type: 'shares', projectId: createId(), sessions: [] });
        expect(c.getSnapshot().shares).toEqual(sessions);
        // A sync that is followed by no answers means there are none any more.
        socket.receive({
            type: 'ops',
            project: { id: sample.projectId, name: 'demo' },
            ops: [],
            seq: 4,
        });
        expect(c.getSnapshot().shares).toEqual([]);
        const later = [{ sessionId: sample.sessionId, people: [person('Luca')] }];
        socket.receive({ type: 'shares', projectId: sample.projectId, sessions: later });
        expect(c.getSnapshot().shares).toEqual(later);
        await c.whenSaved();
        expect(cache.store.get(sample.projectId)?.shares).toEqual(later);
        c.stop();
    });

    test('a cached entry from before the shared copies still reads', () => {
        const sample = sampleProject();
        const entry = parseCachedProject(sample.projectId, {
            v: CACHE_VERSION,
            project: null,
            state: sample.state,
            seq: 2,
            syncedAt: 1,
            pending: [],
        });
        expect(entry).toMatchObject({ seq: 2 });
        expect(entry?.shares).toBeUndefined();
        const kept = parseCachedProject(sample.projectId, {
            v: CACHE_VERSION,
            project: null,
            state: sample.state,
            seq: 2,
            syncedAt: 1,
            pending: [],
            shares: [{ sessionId: sample.sessionId, people: [person('Mario')] }],
        });
        expect(kept?.shares?.[0]?.people[0]?.name).toBe('Mario');
    });

    test('edits made after a restart are queued and cached, one op per change', async () => {
        const sample = sampleProject();
        const cache = memoryCache([
            {
                projectId: sample.projectId,
                project: null,
                state: sample.state,
                seq: 4,
                pending: [],
                syncedAt: 1,
            },
        ]);
        const c = fakeClient(sample.projectId, cache);
        c.start();
        await Bun.sleep(0);
        // The computer is off: the relay closes with "daemon offline".
        (FakeSocket.instances[0] as FakeSocket).close(4503);
        await Bun.sleep(0);
        expect(c.getSnapshot().status).toBe('daemon-offline');

        const [first] = sample.itemIds;
        c.updateItem(sample.sessionId, { itemId: first, status: 'done' });
        c.updateItem(sample.sessionId, { itemId: first, status: 'cancelled' });
        c.updateItem(sample.sessionId, { itemId: first, status: 'question', note: 'why?' });
        await c.whenSaved();
        const saved = cache.store.get(sample.projectId);
        expect(saved?.pending.map((op) => op.payload)).toEqual([
            { itemId: first, status: 'done' },
            { itemId: first, status: 'cancelled' },
            { itemId: first, status: 'question', note: 'why?' },
        ]);
        // The confirmed state is cached as confirmed: the queue is applied on top when shown.
        expect(getItem(saved?.state as ProjectState, first)?.status).toBeUndefined();
        c.stop();

        // Next launch: new ops tick after the cached ones.
        const again = fakeClient(sample.projectId, cache);
        again.start();
        await Bun.sleep(0);
        const next = again.updateItem(sample.sessionId, { itemId: first, status: 'done' });
        expect(next?.clock.lamport).toBeGreaterThan(saved?.pending[2]?.clock.lamport as number);
        expect(again.getSnapshot().pendingCount).toBe(4);
        again.stop();
    });

    test('after a snapshot, queued ops that the computer already has are dropped', async () => {
        const sample = sampleProject();
        const applied = sample.phoneOp(sample.itemIds[0], 'done', 10);
        const notYet = sample.phoneOp(sample.itemIds[1], 'cancelled', 11);
        const cache = memoryCache([
            {
                projectId: sample.projectId,
                project: null,
                state: sample.state,
                seq: 4,
                pending: [applied, notYet],
                syncedAt: 1,
            },
        ]);
        const c = fakeClient(sample.projectId, cache);
        c.start();
        await Bun.sleep(0);
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        // The first op reached the computer, its echo was lost, and the seq is out of window.
        socket.receive({
            type: 'snapshot',
            project: { id: sample.projectId, name: 'demo' },
            state: applyAll(sample.state, [applied]),
            seq: 900,
        });
        expect(c.getSnapshot().pendingCount).toBe(1);
        expect(socket.sent).toContainEqual({ type: 'op', op: notYet });
        expect(socket.sent).not.toContainEqual({ type: 'op', op: applied });
        await c.whenSaved();
        expect(cache.store.get(sample.projectId)?.pending).toEqual([notYet]);
        c.stop();
    });

    test('following a cached project subscribes with its seq and sends nothing until synced', async () => {
        const a = sampleProject();
        const b = sampleProject();
        const cache = memoryCache([
            {
                projectId: b.projectId,
                project: null,
                state: b.state,
                seq: 7,
                pending: [],
                syncedAt: 1,
            },
        ]);
        const c = fakeClient(a.projectId, cache);
        c.start();
        await Bun.sleep(0);
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        socket.receive({
            type: 'snapshot',
            project: { id: a.projectId, name: 'a' },
            state: a.state,
            seq: 4,
        });

        c.follow(b.projectId);
        await Bun.sleep(0);
        expect(socket.sent.at(-1)).toEqual({
            type: 'subscribe',
            archive: true,
            done: true,
            projectId: b.projectId,
            lastSeq: 7,
        });
        // Editable from the cache right away, but not sent to the project still on the socket.
        const op = c.updateItem(b.sessionId, { itemId: b.itemIds[0], status: 'done' });
        expect(socket.sent).not.toContainEqual({ type: 'op', op });
        socket.receive({
            type: 'ops',
            project: { id: b.projectId, name: 'b' },
            ops: [],
            seq: 7,
        });
        expect(socket.sent).toContainEqual({ type: 'op', op });
        c.stop();
    });

    test('a cache that fails works like no cache', async () => {
        const sample = sampleProject();
        const broken: ClientCache = {
            load: () => Promise.reject(new Error('blocked')),
            save: () => Promise.reject(new Error('quota')),
            remove: () => Promise.reject(new Error('blocked')),
            projectIds: () => Promise.reject(new Error('blocked')),
            clear: () => Promise.reject(new Error('blocked')),
        };
        const c = fakeClient(sample.projectId, broken);
        c.start();
        await Bun.sleep(0);
        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        expect(socket.sent[0]).not.toHaveProperty('lastSeq');
        socket.receive({
            type: 'snapshot',
            project: { id: sample.projectId, name: 'demo' },
            state: sample.state,
            seq: 4,
        });
        const op = c.updateItem(sample.sessionId, { itemId: sample.itemIds[0], status: 'done' });
        expect(socket.sent).toContainEqual({ type: 'op', op });
        await c.whenSaved();
        expect(await queuedProjects(broken)).toEqual([]);
        c.stop();
    });
});

describe('SyncClient with a cache, real relay and daemon', () => {
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

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'palmtop-cache-'));
        relay = startRelay({ port: 0, log: () => {} });
        await boot();
        const { projectId } = await daemon.registry.resolve({ rootPath: '/tmp/cache-repo' });
        const { roomId } = daemon.registry;
        for (let i = 0; i < 300 && !daemon.relay.isRoomOpen(roomId); i++) await Bun.sleep(10);
        const room = await daemon.rooms.get(projectId);
        const sessionId = createId();
        const checklistId = createId();
        const itemIds = [createId(), createId()];
        await room?.submitLocal('session.upsert', sessionId, { title: 'session', startedAt: 1 });
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

    async function client(deviceId: string, cache?: ClientCache) {
        const instance = new SyncClient({
            url: `ws://127.0.0.1:${relay.port}/ws?room=${project.roomId}`,
            projectId: project.projectId,
            identity: await pairedIdentity(daemon, deviceId),
            minReconnectDelayMs: 20,
            maxReconnectDelayMs: 100,
            ...(cache && { cache }),
        });
        clients.push(instance);
        return instance;
    }

    test('an app restarted while the computer is off shows the checklists and keeps the reviews', async () => {
        const factory = new IDBFactory();
        const cache = () => indexedDbCache({ scope: 'computer', indexedDB: factory });
        const [first, second] = project.itemIds as [string, string];

        const phone = await client('phone', cache());
        phone.start();
        await waitFor(phone, (s) => s.status === 'online');
        await phone.whenSaved();
        phone.stop();

        // The computer goes off, then the app is opened again.
        await daemon.stop();
        const reopened = await client('phone', cache());
        reopened.start();
        const offline = await waitFor(reopened, (s) => s.status === 'daemon-offline');
        expect(getItem(offline.state as ProjectState, first)?.text).toBe('i0');
        expect(offline.syncedAt).not.toBeNull();
        reopened.updateItem(project.sessionId, { itemId: first, status: 'done' });
        reopened.updateItem(project.sessionId, {
            itemId: second,
            status: 'question',
            note: 'how?',
        });
        await reopened.whenSaved();
        reopened.stop();

        // Closed again before the computer came back: the reviews are still queued.
        const third = await client('phone', cache());
        third.start();
        await waitFor(third, (s) => s.status === 'daemon-offline' && s.pendingCount === 2);

        await boot();
        const synced = await waitFor(
            third,
            (s) => s.status === 'online' && s.pendingCount === 0,
            5_000,
        );
        expect(synced.seq).toBe(6);
        const room = await daemon.rooms.get(project.projectId);
        expect(getItem(room?.state as ProjectState, first)?.status).toBe('done');
        expect(getItem(room?.state as ProjectState, second)).toMatchObject({
            status: 'question',
            note: 'how?',
        });
        await third.whenSaved();
        expect((await cache().load(project.projectId))?.pending).toEqual([]);
    });
});

describe('screenshots made while the computer is away', () => {
    let factory: IDBFactory;
    let cache: ClientCache;
    const jpeg = (fill = 1) => ({
        mime: 'image/jpeg' as const,
        bytes: new Uint8Array([0xff, 0xd8, 0xff, fill]),
    });

    beforeEach(() => {
        FakeSocket.instances = [];
        factory = new IDBFactory();
        cache = indexedDbCache({ scope: 'mac', indexedDB: factory });
    });

    /** A project cached after a sync with a computer of this protocol. */
    async function cached(protocol: number | undefined) {
        const sample = sampleProject();
        await cache.save({
            projectId: sample.projectId,
            project: { id: sample.projectId, name: 'demo' },
            state: sample.state,
            seq: 4,
            pending: [],
            syncedAt: 1,
            ...(protocol !== undefined && { protocol }),
        });
        return sample;
    }

    function client(projectId: string) {
        return new SyncClient({
            url: 'ws://fake/ws',
            projectId,
            identity: scriptedIdentity,
            transport: plainTransport,
            createSocket: () => new FakeSocket(),
            minReconnectDelayMs: 5,
            maxReconnectDelayMs: 20,
            heartbeatMs: 60_000,
            cache,
        });
    }

    const typesOf = (socket: FakeSocket) => socket.sent.map((m) => (m as { type: string }).type);

    /** The computer catches the client up: from here on it is live. */
    function sync(socket: FakeSocket, sample: ReturnType<typeof sampleProject>) {
        socket.receive({
            type: 'ops',
            project: { id: sample.projectId, name: 'demo' },
            ops: [],
            seq: 4,
            protocol: 6,
        });
    }

    test('a computer seen to take them takes one while away: kept, counted, shown from here', async () => {
        const sample = await cached(6);
        const c = client(sample.projectId);
        c.start();
        await waitFor(c, (s) => s.state !== null);
        expect(c.getSnapshot().daemonProtocol).toBe(6);
        expect(c.canKeepImages()).toBe(true);
        const imageId = createId();
        await c.putImage(sample.sessionId, imageId, jpeg(7));

        expect(c.getSnapshot().pendingCount).toBe(1);
        expect((await cache.pendingImages?.())?.map((entry) => entry.imageId)).toEqual([imageId]);
        // It shows from this device at once.
        expect(await c.getImage(imageId)).toEqual(jpeg(7));
        c.stop();
    });

    test('a computer never seen, or too old, takes nothing while away', async () => {
        const never = await cached(undefined);
        const first = client(never.projectId);
        first.start();
        await waitFor(first, (s) => s.state !== null);
        expect(first.canKeepImages()).toBe(false);
        await expect(first.putImage(never.sessionId, createId(), jpeg())).rejects.toThrow(
            /has not seen this computer/,
        );
        first.stop();

        const old = await cached(5);
        const second = client(old.projectId);
        second.start();
        await waitFor(second, (s) => s.daemonProtocol === 5);
        await expect(second.putImage(old.sessionId, createId(), jpeg())).rejects.toThrow(
            /palmtop update/,
        );
        expect(await cache.pendingImages?.()).toEqual([]);
        second.stop();
    });

    test('back online, the screenshot goes first, and the note that names it after it is stored', async () => {
        const sample = await cached(6);
        const c = client(sample.projectId);
        c.start();
        await waitFor(c, (s) => s.state !== null);
        const imageId = createId();
        await c.putImage(sample.sessionId, imageId, jpeg(3));
        const note = c.setSessionNote(sample.sessionId, `- a [#aaaa]\n  [screenshot:${imageId}]`);
        expect(note).not.toBeNull();

        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        sync(socket, sample);
        await Bun.sleep(5);
        // Nothing but the screenshot yet: the ops wait for the computer to say it has it.
        expect(typesOf(socket).slice(1)).toEqual(['image.put']);
        expect(socket.sent[1]).toMatchObject({
            type: 'image.put',
            projectId: sample.projectId,
            sessionId: sample.sessionId,
            imageId,
            mime: 'image/jpeg',
            data: '/9j/Aw==',
        });
        socket.receive({ type: 'image.saved', imageId });
        await waitFor(c, (s) => s.pendingCount === 1);
        expect(typesOf(socket).slice(1)).toEqual(['image.put', 'op']);
        for (let wait = 0; wait < 40 && (await cache.pendingImages?.())?.length; wait++) {
            await Bun.sleep(5);
        }
        expect(await cache.pendingImages?.()).toEqual([]);
        // It stays for showing.
        expect(await cache.loadImage?.(imageId)).toEqual(jpeg(3));
        c.stop();
    });

    test('a screenshot the computer refuses is dropped and reported, and the ops go on', async () => {
        const sample = await cached(6);
        const c = client(sample.projectId);
        c.start();
        await waitFor(c, (s) => s.state !== null);
        const imageId = createId();
        await c.putImage(sample.sessionId, imageId, jpeg());
        c.updateItem(sample.sessionId, { itemId: sample.itemIds[0], status: 'done' });

        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        sync(socket, sample);
        await Bun.sleep(5);
        socket.receive({
            type: 'error',
            code: 'forbidden',
            message: 'this project holds as many screenshots as it can',
            imageId,
        });
        await waitFor(c, () => typesOf(socket).includes('op'));
        expect(c.getSnapshot().lastError?.message).toContain('could not be sent');
        expect(c.getSnapshot().lastError?.message).toContain('as many screenshots');
        for (let wait = 0; wait < 40 && (await cache.pendingImages?.())?.length; wait++) {
            await Bun.sleep(5);
        }
        expect(await cache.pendingImages?.()).toEqual([]);
        c.stop();
    });

    test('a connection lost on the way keeps the screenshot for the next time', async () => {
        const sample = await cached(6);
        const c = client(sample.projectId);
        c.start();
        await waitFor(c, (s) => s.state !== null);
        const imageId = createId();
        await c.putImage(sample.sessionId, imageId, jpeg());

        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        sync(socket, sample);
        await Bun.sleep(5);
        socket.close(1006);
        await Bun.sleep(40);
        expect((await cache.pendingImages?.())?.map((entry) => entry.imageId)).toEqual([imageId]);
        expect(c.getSnapshot().pendingCount).toBe(1);

        const again = await waitForSocketAt(1);
        again.open();
        sync(again, sample);
        await Bun.sleep(5);
        expect(typesOf(again)).toContain('image.put');
        again.receive({ type: 'image.saved', imageId });
        await waitFor(c, (s) => s.pendingCount === 0);
        c.stop();
    });

    test('an app restarted with a screenshot waiting sends it once the computer is back', async () => {
        const sample = await cached(6);
        const first = client(sample.projectId);
        first.start();
        await waitFor(first, (s) => s.state !== null);
        const imageId = createId();
        await first.putImage(sample.sessionId, imageId, jpeg(9));
        first.stop();
        FakeSocket.instances = [];

        const second = client(sample.projectId);
        second.start();
        await waitFor(second, (s) => s.pendingCount === 1);
        const socket = await waitForSocketAt(0);
        socket.open();
        sync(socket, sample);
        await Bun.sleep(5);
        expect(socket.sent.find((m) => (m as { type: string }).type === 'image.put')).toMatchObject(
            {
                imageId,
                data: '/9j/CQ==',
            },
        );
        socket.receive({ type: 'image.saved', imageId });
        await waitFor(second, (s) => s.pendingCount === 0);
        second.stop();
    });

    test('a session deleted while the screenshot waited takes it with it', async () => {
        const sample = await cached(6);
        const c = client(sample.projectId);
        c.start();
        await waitFor(c, (s) => s.state !== null);
        await c.putImage(sample.sessionId, createId(), jpeg());

        const socket = FakeSocket.instances[0] as FakeSocket;
        socket.open();
        // The computer's state has the session gone.
        const gone = applyAll(sample.state, [
            createOp({
                projectId: sample.projectId,
                sessionId: sample.sessionId,
                type: 'session.remove',
                payload: {},
                clock: { lamport: 99, deviceId: 'palmtop-daemon' },
            }),
        ]);
        socket.receive({
            type: 'snapshot',
            project: { id: sample.projectId, name: 'demo' },
            state: gone,
            seq: 5,
            protocol: 6,
        });
        await waitFor(c, (s) => s.pendingCount === 0);
        expect(typesOf(socket)).not.toContain('image.put');
        for (let wait = 0; wait < 40 && (await cache.pendingImages?.())?.length; wait++) {
            await Bun.sleep(5);
        }
        expect(await cache.pendingImages?.()).toEqual([]);
        c.stop();
    });

    async function waitForSocketAt(index: number): Promise<FakeSocket> {
        const deadline = Date.now() + 3_000;
        while (!FakeSocket.instances[index]) {
            if (Date.now() > deadline) throw new Error(`no socket ${index}`);
            await Bun.sleep(5);
        }
        return FakeSocket.instances[index] as FakeSocket;
    }
});

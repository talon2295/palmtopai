import { describe, expect, test } from 'bun:test';
import { join, resolve } from 'node:path';
import {
    createId,
    createOp,
    DAEMON_PROTOCOL_VERSION,
    listItems,
    type Op,
    type OpOf,
    type OpType,
    roomIdOfKey,
    type SeqOp,
} from '@palmtopai/protocol';
import { roomIdOf, verifyRoomProof } from '@palmtopai/protocol/relay-crypto';
import {
    authorizeDeviceOp,
    DAEMON_DEVICE_ID,
    isReservedDeviceId,
    MemoryStorage,
    ProjectRegistry,
    ProjectRoom,
} from '../src';
import { createTempHome, expectMode } from './helpers';

async function setup(options: { snapshotEvery?: number } = {}) {
    const storage = new MemoryStorage();
    const projectId = createId();
    await storage.createProject({ id: projectId, name: 'demo', rootPath: '/demo', createdAt: 1 });
    const applied: SeqOp[] = [];
    const room = await ProjectRoom.load(storage, projectId, {
        ...options,
        onApplied: (entry) => applied.push(entry),
    });
    if (!room) throw new Error('room not loaded');

    const sessionId = createId();
    const otherSessionId = createId();
    const checklistId = createId();
    const itemId = createId();
    await room.submitLocal('session.upsert', sessionId, { title: 's1' });
    await room.submitLocal('session.upsert', otherSessionId, { title: 's2' });
    await room.submitLocal('checklist.create', sessionId, { checklistId, title: 'c' });
    await room.submitLocal('item.add', sessionId, { itemId, checklistId, text: 'x', order: 0 });

    const device = <T extends OpType>(
        type: T,
        payload: OpOf<T>['payload'],
        extra: { lamport?: number; deviceId?: string; sessionId?: string; projectId?: string } = {},
    ) =>
        createOp({
            projectId: extra.projectId ?? projectId,
            sessionId: extra.sessionId ?? sessionId,
            type,
            payload,
            clock: { lamport: extra.lamport ?? 10, deviceId: extra.deviceId ?? 'phone' },
        });

    return {
        storage,
        room,
        applied,
        projectId,
        sessionId,
        otherSessionId,
        checklistId,
        itemId,
        device,
    };
}

describe('device permissions', () => {
    test('a device can set status and note of an existing item', async () => {
        const { room, itemId, device } = await setup();
        const op = device('item.update', { itemId, status: 'question', note: 'why?' });
        expect(authorizeDeviceOp(room.state, op, 'phone')).toBeNull();
        expect(
            authorizeDeviceOp(room.state, device('item.update', { itemId, status: null }), 'phone'),
        ).toBeNull();
    });

    test.each([
        [
            'session.upsert',
            (s: Awaited<ReturnType<typeof setup>>) =>
                s.device('session.upsert', { title: 'hijack' }),
        ],
        [
            'checklist.create',
            (s: Awaited<ReturnType<typeof setup>>) =>
                s.device('checklist.create', { checklistId: createId(), title: 't' }),
        ],
        [
            'checklist.update',
            (s: Awaited<ReturnType<typeof setup>>) =>
                s.device('checklist.update', { checklistId: s.checklistId, title: 't' }),
        ],
        [
            'checklist.remove',
            (s: Awaited<ReturnType<typeof setup>>) =>
                s.device('checklist.remove', { checklistId: s.checklistId }),
        ],
        [
            'session.message',
            (s: Awaited<ReturnType<typeof setup>>) =>
                s.device('session.message', { message: 'not from the agent' }),
        ],
        [
            'feedback.deliver',
            (s: Awaited<ReturnType<typeof setup>>) =>
                s.device('feedback.deliver', {
                    items: [{ itemId: s.itemId, status: s.itemId, note: s.itemId }],
                }),
        ],
    ])('a device cannot send %s', async (type, build) => {
        const context = await setup();
        expect(authorizeDeviceOp(context.room.state, build(context), 'phone')).toEqual({
            code: 'forbidden',
            message: `devices cannot send ${type}`,
        });
    });

    test('a device can delete a session that exists, only once', async () => {
        const { room, sessionId, device } = await setup();
        const remove = device('session.remove', {});
        expect(authorizeDeviceOp(room.state, remove, 'phone')).toBeNull();
        const unknown = device('session.remove', {}, { sessionId: createId() });
        expect(authorizeDeviceOp(room.state, unknown, 'phone')?.message).toBe('unknown session');

        expect((await room.submit(remove, { kind: 'device', deviceId: 'phone' })).status).toBe(
            'applied',
        );
        const again = device('session.remove', {}, { lamport: 11, sessionId });
        expect(authorizeDeviceOp(room.state, again, 'phone')?.message).toBe('unknown session');
    });

    test('an op a device sends again is a duplicate, not a refusal of what it already did', async () => {
        const { room, checklistId, device } = await setup();
        const add = device('item.add', { itemId: createId(), checklistId, text: 'Mine', order: 1 });
        const origin = { kind: 'device' as const, deviceId: 'phone' };
        expect((await room.submit(add, origin)).status).toBe('applied');
        const seq = room.seq;
        // The first time the item did not exist; now it does, and the same op is still a duplicate.
        expect((await room.submit(add, origin)).status).toBe('duplicate');
        expect(room.seq).toBe(seq);
    });

    test('a device cannot edit the text or order of agent items, nor remove them', async () => {
        const { room, itemId, device } = await setup();
        for (const payload of [
            { itemId, text: 'rewritten' },
            { itemId, status: 'done' as const, text: 'sneaky' },
            { itemId, detail: 'rewritten pros and cons' },
        ]) {
            expect(
                authorizeDeviceOp(room.state, device('item.update', payload), 'phone')?.message,
            ).toBe('devices can only change status and note of agent items');
        }
        expect(
            authorizeDeviceOp(room.state, device('item.update', { itemId, order: 5 }), 'phone')
                ?.message,
        ).toBe('devices cannot reorder items');
        expect(
            authorizeDeviceOp(room.state, device('item.remove', { itemId }), 'phone')?.message,
        ).toBe('devices can only remove items added on devices');
    });

    test('a device adds items without a review, then edits and removes its own items', async () => {
        const { room, checklistId, otherSessionId, itemId, device } = await setup();
        const added = createId();
        const add = device('item.add', { itemId: added, checklistId, text: 'Also this', order: 1 });
        expect(authorizeDeviceOp(room.state, add, 'phone')).toBeNull();
        const refused = (op: Op) => authorizeDeviceOp(room.state, op, 'phone')?.message;
        expect(
            refused(
                device('item.add', {
                    itemId: createId(),
                    checklistId,
                    text: 'pre-reviewed',
                    status: 'done',
                    order: 1,
                }),
            ),
        ).toBe('items added on devices start without a review');
        expect(
            refused(device('item.add', { itemId, checklistId, text: 'overwrite', order: 0 })),
        ).toBe('item already exists');
        expect(
            refused(
                device(
                    'item.add',
                    { itemId: createId(), checklistId, text: 'elsewhere', order: 0 },
                    { sessionId: otherSessionId },
                ),
            ),
        ).toBe('unknown checklist in this session');

        expect((await room.submit(add, { kind: 'device', deviceId: 'phone' })).status).toBe(
            'applied',
        );
        // Any paired device can change the items the user added, not only the one that added it.
        const edit = device(
            'item.update',
            { itemId: added, text: 'Also that' },
            { lamport: 11, deviceId: 'tablet' },
        );
        expect(authorizeDeviceOp(room.state, edit, 'tablet')).toBeNull();
        // Their own option of a choice: the detail is theirs to write too.
        const detail = device(
            'item.update',
            { itemId: added, detail: 'what it would cost' },
            { lamport: 11, deviceId: 'tablet' },
        );
        expect(authorizeDeviceOp(room.state, detail, 'tablet')).toBeNull();
        const remove = device('item.remove', { itemId: added }, { lamport: 12 });
        expect(authorizeDeviceOp(room.state, remove, 'phone')).toBeNull();
    });

    test('a device writes the note of a session that exists', async () => {
        const { room, device } = await setup();
        expect(
            authorizeDeviceOp(room.state, device('session.note', { note: 'hi' }), 'phone'),
        ).toBeNull();
        expect(
            authorizeDeviceOp(
                room.state,
                device('session.note', { note: 'hi' }, { sessionId: createId() }),
                'phone',
            )?.message,
        ).toBe('unknown session');
    });

    test('unknown or removed items are refused', async () => {
        const { room, itemId, device } = await setup();
        const unknown = device('item.update', { itemId: createId(), status: 'done' });
        expect(authorizeDeviceOp(room.state, unknown, 'phone')?.message).toBe('unknown item');

        await room.submitLocal('item.remove', createId(), { itemId });
        const removed = device('item.update', { itemId, status: 'done' });
        expect(authorizeDeviceOp(room.state, removed, 'phone')?.message).toBe('unknown item');
    });

    test('the op must use the connection device id, the item session and the room project', async () => {
        const { room, itemId, otherSessionId, device } = await setup();
        const payload = { itemId, status: 'done' as const };
        expect(
            authorizeDeviceOp(
                room.state,
                device('item.update', payload, { deviceId: 'tablet' }),
                'phone',
            )?.message,
        ).toBe('op clock device id does not match the connection');
        expect(
            authorizeDeviceOp(
                room.state,
                device('item.update', payload, { sessionId: otherSessionId }),
                'phone',
            )?.message,
        ).toBe('op session does not match the item session');
        expect(
            authorizeDeviceOp(
                room.state,
                device('item.update', payload, { projectId: createId() }),
                'phone',
            )?.message,
        ).toBe('op targets another project');
    });

    test('daemon device ids are reserved', () => {
        expect(isReservedDeviceId(DAEMON_DEVICE_ID)).toBe(true);
        expect(isReservedDeviceId('palmtop-anything')).toBe(true);
        expect(isReservedDeviceId('phone-01')).toBe(false);
    });
});

describe('ProjectRoom', () => {
    test('assigns consecutive seqs and notifies after persisting', async () => {
        const { room, applied, storage, projectId } = await setup();
        expect(applied.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
        expect(room.seq).toBe(4);
        expect((await storage.loadProject(projectId))?.ops.map((entry) => entry.seq)).toEqual([
            1, 2, 3, 4,
        ]);
    });

    test('rejected and duplicate ops do not consume a seq', async () => {
        const { room, applied, itemId, device } = await setup();
        const rejected = await room.submit(
            device('item.add', {
                itemId: createId(),
                checklistId: createId(),
                text: 'x',
                order: 1,
            }),
            {
                kind: 'device',
                deviceId: 'phone',
            },
        );
        expect(rejected.status).toBe('rejected');

        const op = device('item.update', { itemId, status: 'done' });
        expect((await room.submit(op, { kind: 'device', deviceId: 'phone' })).status).toBe(
            'applied',
        );
        expect(await room.submit(op, { kind: 'device', deviceId: 'phone' })).toEqual({
            status: 'duplicate',
        });
        expect(room.seq).toBe(5);
        expect(applied).toHaveLength(5);
    });

    test('local ops tick past the highest lamport seen from devices', async () => {
        const { room, itemId, checklistId, device } = await setup();
        await room.submit(
            device('item.update', { itemId, status: 'question' }, { lamport: 1_000 }),
            {
                kind: 'device',
                deviceId: 'phone',
            },
        );
        const result = await room.submitLocal('item.update', createId(), {
            itemId,
            status: 'done',
        });
        if (result.status !== 'applied') throw new Error('not applied');
        expect(result.entry.op.clock).toEqual({ lamport: 1_001, deviceId: DAEMON_DEVICE_ID });
        expect(listItems(room.state, checklistId)[0]?.status).toBe('done');
    });

    test('invalid local payloads throw instead of being stored', async () => {
        const { room, itemId } = await setup();
        await expect(room.submitLocal('item.update', createId(), { itemId })).rejects.toThrow();
        expect(room.seq).toBe(4);
    });

    test('deleting a session snapshots at once: its texts leave the op log', async () => {
        const { storage, room, projectId, sessionId, device } = await setup({ snapshotEvery: 100 });
        expect((await storage.loadProject(projectId))?.ops.length).toBe(4);
        await room.submit(device('session.remove', {}), { kind: 'device', deviceId: 'phone' });
        const stored = await storage.loadProject(projectId);
        expect(stored?.ops).toEqual([]);
        expect(stored?.snapshot.seq).toBe(room.seq);
        expect(JSON.stringify(stored)).not.toContain('"x"');
        expect(listItems(room.state, sessionId)).toEqual([]);
    });

    test('concurrent submits are serialized', async () => {
        const { room, itemId, device } = await setup();
        const results = await Promise.all(
            Array.from({ length: 20 }, (_, index) =>
                room.submit(
                    device('item.update', { itemId, note: `n${index}` }, { lamport: 10 + index }),
                    {
                        kind: 'device',
                        deviceId: 'phone',
                    },
                ),
            ),
        );
        expect(
            results.map((result) => (result.status === 'applied' ? result.entry.seq : -1)),
        ).toEqual(Array.from({ length: 20 }, (_, index) => 5 + index));
    });

    test('syncMessage serves missed ops inside the window and a snapshot outside it', async () => {
        const { room, itemId, device } = await setup({ snapshotEvery: 6 });
        expect(room.syncMessage()).toMatchObject({ type: 'snapshot', seq: 4 });
        expect(room.syncMessage(2)).toMatchObject({
            type: 'ops',
            seq: 4,
            ops: [{ seq: 3 }, { seq: 4 }],
        });
        expect(room.syncMessage(4)).toEqual({
            type: 'ops',
            project: { id: room.projectId, name: 'demo' },
            ops: [],
            seq: 4,
            protocol: DAEMON_PROTOCOL_VERSION,
        });
        expect(room.syncMessage(99)).toMatchObject({ type: 'snapshot', seq: 4 });

        for (const lamport of [20, 21, 22]) {
            await room.submit(device('item.update', { itemId, note: `${lamport}` }, { lamport }), {
                kind: 'device',
                deviceId: 'phone',
            });
        }
        // Snapshot taken at seq 6: seq 5 is no longer served as ops.
        expect(room.syncMessage(5)).toMatchObject({ type: 'snapshot', seq: 7 });
        expect(room.syncMessage(6)).toMatchObject({ type: 'ops', ops: [{ seq: 7 }] });
    });

    test('reloading from storage restores state, seq and duplicate detection', async () => {
        const { storage, room, projectId, itemId, device } = await setup({ snapshotEvery: 3 });
        const op = device('item.update', { itemId, status: 'cancelled', note: 'no' });
        await room.submit(op, { kind: 'device', deviceId: 'phone' });
        await room.close();

        const reloaded = await ProjectRoom.load(storage, projectId);
        expect(reloaded?.state).toEqual(room.state);
        expect(reloaded?.seq).toBe(5);
        const again = await reloaded?.submitLocal('item.update', createId(), {
            itemId,
            note: 'later',
        });
        expect(again?.status === 'applied' && again.entry.seq).toBe(6);
    });
});

describe('ProjectRegistry', () => {
    test('resolve is idempotent per root path, persists and never exposes the token', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const path = join(home, 'projects.json');
            const storage = new MemoryStorage();
            const registry = await ProjectRegistry.open(path, storage);

            const first = await registry.resolve({ rootPath: '/work/repo/' });
            const second = await registry.resolve({ rootPath: '/work/repo' });
            const other = await registry.resolve({ rootPath: '/work/other' });
            expect(first).toEqual({ projectId: first.projectId, name: 'repo', created: true });
            expect(second).toEqual({ ...first, created: false });
            expect(other.projectId).not.toBe(first.projectId);
            expect(Object.keys(first).sort()).toEqual(['created', 'name', 'projectId']);
            // Roots are stored as absolute paths of the system (on Windows with a drive).
            expect((await storage.listProjects()).map((meta) => meta.rootPath).sort()).toEqual([
                resolve('/work/other'),
                resolve('/work/repo'),
            ]);

            await expectMode(path, 0o600);
            const reopened = await ProjectRegistry.open(path, storage);
            expect(await reopened.resolve({ rootPath: '/work/repo' })).toEqual(second);
        } finally {
            await cleanup();
        }
    });

    test('no token any more: the room key is what the computer proves to devices', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const path = join(home, 'projects.json');
            const registry = await ProjectRegistry.open(path, new MemoryStorage());
            await registry.resolve({ rootPath: '/a' });
            const file = JSON.parse(await Bun.file(path).text()) as {
                version: number;
                computer: { token?: string; roomKey: { publicKey: string } };
                projects: Array<{ token?: string }>;
            };
            expect(file.version).toBe(3);
            expect(file.computer.token).toBeUndefined();
            expect(file.projects.every((project) => project.token === undefined)).toBe(true);

            // The public half pins the computer: its hash is the room id devices connect to.
            expect(registry.roomPublicKey).toBe(file.computer.roomKey.publicKey);
            expect(await roomIdOfKey(registry.roomPublicKey)).toBe(registry.roomId);
            // The private half signs inside WebCrypto, never readable from there.
            const signingKey = await registry.signingKey();
            expect(signingKey.extractable).toBe(false);
            expect(await registry.signingKey()).toBe(signingKey);
        } finally {
            await cleanup();
        }
    });

    test('the computer has one relay room key, kept across reloads', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const path = join(home, 'projects.json');
            const storage = new MemoryStorage();
            const registry = await ProjectRegistry.open(path, storage);
            await registry.resolve({ rootPath: '/one' });
            await registry.resolve({ rootPath: '/two' });

            const roomId = registry.roomId;
            expect(roomId).toHaveLength(43);

            const stored = JSON.parse(await Bun.file(path).text()) as {
                computer: { id: string; roomKey: { publicKey: string; privateKey: string } };
            };
            expect(roomIdOf(stored.computer.roomKey.publicKey)).toBe(roomId);
            await expectMode(path, 0o600);

            // The key survives a reload: the room id (in devices' pairings) stays the same.
            const reopened = await ProjectRegistry.open(path, storage);
            expect(reopened.roomId).toBe(roomId);
            expect(reopened.computerId).toBe(stored.computer.id);
            expect(
                reopened
                    .list()
                    .map((project) => project.name)
                    .sort(),
            ).toEqual(['one', 'two']);

            const nonce = 'n'.repeat(43);
            const proof = reopened.roomProof(nonce);
            expect(verifyRoomProof(proof, nonce)).toBe(roomId);
            expect(JSON.stringify(proof)).not.toContain(stored.computer.roomKey.privateKey);
        } finally {
            await cleanup();
        }
    });

    test('find returns existing projects and never creates one', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const path = join(home, 'projects.json');
            const storage = new MemoryStorage();
            const registry = await ProjectRegistry.open(path, storage);

            expect(await registry.find('/work/repo')).toBeNull();
            expect(await storage.listProjects()).toHaveLength(0);

            const pending = registry.resolve({ rootPath: '/work/repo' });
            const found = await registry.find('/work/repo/');
            expect(found).toEqual({ ...(await pending), created: false });
        } finally {
            await cleanup();
        }
    });

    test('concurrent resolves of the same path create one project', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const storage = new MemoryStorage();
            const registry = await ProjectRegistry.open(join(home, 'projects.json'), storage);
            const results = await Promise.all(
                Array.from({ length: 5 }, () => registry.resolve({ rootPath: '/same' })),
            );
            expect(new Set(results.map((result) => result.projectId)).size).toBe(1);
            expect(await storage.listProjects()).toHaveLength(1);
        } finally {
            await cleanup();
        }
    });
});

describe('ProjectRoom failures after an op is applied', () => {
    class FlakySnapshotStorage extends MemoryStorage {
        failSnapshots = true;
        snapshotCalls = 0;

        override async saveSnapshot(
            ...args: Parameters<MemoryStorage['saveSnapshot']>
        ): Promise<void> {
            this.snapshotCalls += 1;
            if (this.failSnapshots) throw new Error('disk full');
            return super.saveSnapshot(...args);
        }
    }

    async function roomWith(
        storage: MemoryStorage,
        options: Parameters<typeof ProjectRoom.load>[2],
    ) {
        const projectId = createId();
        await storage.createProject({
            id: projectId,
            name: 'demo',
            rootPath: '/demo',
            createdAt: 1,
        });
        const room = await ProjectRoom.load(storage, projectId, options);
        if (!room) throw new Error('room not loaded');
        return { room, projectId };
    }

    test('a throwing broadcast is logged and the op is still reported as applied', async () => {
        const lines: string[] = [];
        const storage = new MemoryStorage();
        const { room, projectId } = await roomWith(storage, {
            onApplied: () => {
                throw new Error('socket exploded');
            },
            log: (line) => lines.push(line),
        });

        const result = await room.submitLocal('session.upsert', createId(), { title: 's' });

        expect(result.status).toBe('applied');
        expect(room.seq).toBe(1);
        expect((await storage.loadProject(projectId))?.ops).toHaveLength(1);
        expect(lines).toEqual(['broadcast of seq 1 failed: socket exploded']);
    });

    test('a failing snapshot keeps the op applied, the log intact and retries on the next op', async () => {
        const lines: string[] = [];
        const storage = new FlakySnapshotStorage();
        const { room, projectId } = await roomWith(storage, {
            snapshotEvery: 2,
            log: (line) => lines.push(line),
        });
        const sessionId = createId();

        await room.submitLocal('session.upsert', sessionId, { title: 'a' });
        const second = await room.submitLocal('session.upsert', sessionId, { title: 'b' });

        expect(second.status).toBe('applied');
        expect(storage.snapshotCalls).toBe(1);
        expect(lines).toEqual([`snapshot of project ${projectId} failed: disk full`]);
        expect(room.syncMessage(0)).toMatchObject({ type: 'ops', ops: [{ seq: 1 }, { seq: 2 }] });
        expect((await storage.loadProject(projectId))?.snapshot.seq).toBe(0);

        storage.failSnapshots = false;
        const third = await room.submitLocal('session.upsert', sessionId, { title: 'c' });

        expect(third.status).toBe('applied');
        expect(storage.snapshotCalls).toBe(2);
        const stored = await storage.loadProject(projectId);
        expect(stored?.snapshot.seq).toBe(3);
        expect(stored?.ops).toEqual([]);
        expect((await ProjectRoom.load(storage, projectId))?.state).toEqual(room.state);
    });

    test('a failing append still rejects the submit and leaves the room untouched', async () => {
        const storage = new MemoryStorage();
        const { room } = await roomWith(storage, {});
        storage.appendOps = async () => {
            throw new Error('read-only filesystem');
        };
        const before = room.state;

        await expect(
            room.submitLocal('session.upsert', createId(), { title: 's' }),
        ).rejects.toThrow('read-only filesystem');
        expect(room.seq).toBe(0);
        expect(room.state).toBe(before);
    });
});

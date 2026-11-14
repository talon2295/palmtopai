import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    applyAll,
    CloseCode,
    createId,
    createProjectState,
    DAEMON_PROTOCOL_VERSION,
    exportPublicKey,
    generateDeviceKeys,
    listItems,
    listSessions,
    type ProjectState,
    type ServerMessage,
} from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import type { Daemon } from '../src';
import {
    createTempHome,
    deviceOp,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
    testComputer,
    waitForRelay,
    waitUntil,
} from './helpers';

function expectType<T extends ServerMessage['type']>(
    message: ServerMessage,
    type: T,
): Extract<ServerMessage, { type: T }> {
    expect(message.type).toBe(type);
    return message as Extract<ServerMessage, { type: T }>;
}

describe('device sync through the relay', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    const clients: TestClient[] = [];
    let logs: string[];

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        logs = [];
        daemon = await startTestDaemon(home, {
            helloTimeoutMs: 300,
            relay,
            log: (line) => logs.push(line),
        });
        project = await seedProject(daemon);
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    async function phone(roomId = project.roomId) {
        const client = await TestClient.connect(relay, roomId);
        clients.push(client);
        return client;
    }

    async function connect(deviceId: string, lastSeq?: number) {
        const client = await TestClient.connect(relay, project.roomId);
        clients.push(client);
        const first = await client.hello(project, deviceId, lastSeq);
        return { client, first };
    }

    test('hello returns a snapshot of the current state', async () => {
        const { first } = await connect('phone');
        const snapshot = expectType(first, 'snapshot');
        expect(snapshot.seq).toBe(5);
        expect(listItems(snapshot.state, project.checklistId).map((item) => item.text)).toEqual([
            'Step 1',
            'Step 2',
            'Step 3',
        ]);
    });

    test('an op from one device reaches every device (sender included) and all converge', async () => {
        const devices = await Promise.all(
            ['phone', 'tablet', 'laptop-browser'].map((id) => connect(id)),
        );
        const states = new Map<TestClient, ProjectState>(
            devices.map(({ client, first }) => [client, expectType(first, 'snapshot').state]),
        );

        const [phone, tablet, browser] = devices.map((device) => device.client) as [
            TestClient,
            TestClient,
            TestClient,
        ];
        const itemId = project.itemIds[0];
        phone.sendOp(
            deviceOp(project, 'phone', 10, 'item.update', { itemId, status: 'done', note: 'ok' }),
        );
        tablet.sendOp(
            deviceOp(project, 'tablet', 10, 'item.update', {
                itemId: project.itemIds[1],
                status: 'question',
            }),
        );

        for (const client of [phone, tablet, browser]) {
            for (let i = 0; i < 2; i++) {
                const message = expectType(await client.next(), 'op');
                states.set(client, applyAll(states.get(client) as ProjectState, [message.op]));
            }
        }

        const room = await daemon.rooms.get(project.projectId);
        for (const state of states.values()) expect(state).toEqual(room?.state as ProjectState);
        expect(
            listItems(room?.state as ProjectState, project.checklistId).map((i) => [
                i.status,
                i.note,
            ]),
        ).toEqual([
            ['done', 'ok'],
            ['question', undefined],
            [undefined, undefined],
        ]);
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(3);
    });

    test('devices get the computer name with the project, and live when it changes', async () => {
        await daemon.setComputerName('Office');
        const { client, first } = await connect('phone');
        expect(expectType(first, 'snapshot').project).toEqual({
            id: project.projectId,
            name: expect.any(String),
            computer: 'Office',
        });

        await daemon.setComputerName('Home');
        const renamed = expectType(await client.next(), 'project');
        expect(renamed.project).toMatchObject({ id: project.projectId, computer: 'Home' });

        const { first: resumed } = await connect('other', expectType(first, 'snapshot').seq);
        expect(expectType(resumed, 'ops').project.computer).toBe('Home');
    });

    test('an app that cannot read the archive gets the state instead of a catch-up holding it', async () => {
        const room = await daemon.rooms.get(project.projectId);
        const before = room?.seq ?? 0;
        await room?.submitLocal('session.archive', project.sessionId, { archived: true });
        const target = { projectId: project.projectId, computer: project.computer };

        // An app before 0.20: a snapshot it can read (the field it does not know is dropped).
        const old = await TestClient.connect(relay, project.roomId);
        clients.push(old);
        expect((await old.hello(target, 'old-phone', before)).type).toBe('snapshot');

        // An app that says it reads the archive: the ops since its last seq, as before.
        const current = await TestClient.connect(relay, project.roomId);
        clients.push(current);
        const caughtUp = expectType(
            await current.hello(target, 'new-phone', before, { archive: true }),
            'ops',
        );
        expect(caughtUp.ops.map((entry) => entry.op.type)).toEqual(['session.archive']);

        // Without an archive op in between, an old app catches up as it always did.
        const seq = room?.seq ?? 0;
        const later = await TestClient.connect(relay, project.roomId);
        clients.push(later);
        expect((await later.hello(target, 'old-tablet', seq)).type).toBe('ops');
    });

    test('an app that cannot read a done gets the state instead of a catch-up holding it', async () => {
        const room = await daemon.rooms.get(project.projectId);
        const before = room?.seq ?? 0;
        await room?.submitLocal('session.done', project.sessionId, { done: true });
        const target = { projectId: project.projectId, computer: project.computer };

        // An app of 0.23 reads the archive but not the done: it gets the state.
        const old = await TestClient.connect(relay, project.roomId);
        clients.push(old);
        expect((await old.hello(target, 'old-phone', before, { archive: true })).type).toBe(
            'snapshot',
        );

        // An app that says it reads the done: the ops since its last seq.
        const current = await TestClient.connect(relay, project.roomId);
        clients.push(current);
        const caughtUp = expectType(
            await current.hello(target, 'new-phone', before, { archive: true, done: true }),
            'ops',
        );
        expect(caughtUp.ops.map((entry) => entry.op.type)).toEqual(['session.done']);
    });

    test('ops from the agent (local) are broadcast to devices', async () => {
        const { client } = await connect('phone');
        const room = await daemon.rooms.get(project.projectId);
        await room?.submitLocal('item.add', project.sessionId, {
            itemId: createId(),
            checklistId: project.checklistId,
            text: 'Step 4',
            order: 3,
        });
        const message = expectType(await client.next(), 'op');
        expect(message).toMatchObject({
            seq: 6,
            op: { type: 'item.add', payload: { text: 'Step 4' } },
        });
    });

    test('a device that is not paired, or without its key, is refused and closed', async () => {
        // Never paired with this computer.
        const stranger = await phone();
        const keys = await generateDeviceKeys();
        await stranger.handshake(project.computer, 'stranger', {
            deviceId: 'stranger',
            keys,
            publicKey: await exportPublicKey(keys.publicKey),
        });
        expect(await stranger.next()).toEqual({
            type: 'error',
            code: 'unauthorized',
            message: 'not paired',
        });
        expect((await stranger.closed).code).toBe(CloseCode.unauthorized);

        // A paired device id, another key: the signature gives it away after the welcome.
        await project.computer.device('phone');
        const thief = await phone();
        const stolen = await generateDeviceKeys();
        await thief.handshake(project.computer, 'phone', {
            deviceId: 'phone',
            keys: stolen,
            publicKey: await exportPublicKey(stolen.publicKey),
        });
        expect(await thief.next()).toEqual({
            type: 'error',
            code: 'unauthorized',
            message: 'the device did not prove its key',
        });
        expect((await thief.closed).code).toBe(CloseCode.unauthorized);
        // The log says which device: one whose browser lost its key is found at once.
        expect(logs).toContain('device stranger rejected: not paired with this computer');
        expect(logs).toContain('device phone rejected: the device did not prove its key');

        // The old way in: a plain hello, with or without a token.
        for (const hello of [
            { type: 'hello', projectId: project.projectId },
            { type: 'hello', token: 'x'.repeat(43), deviceId: 'phone' },
        ]) {
            const old = await phone();
            old.send(hello);
            expect(await old.next()).toEqual({
                type: 'error',
                code: 'unauthorized',
                message: 'expected a handshake',
            });
            expect((await old.closed).code).toBe(CloseCode.unauthorized);
        }
    });

    test('a project that no longer exists leaves the device on the list, not in an error', async () => {
        const client = await phone();
        await client.handshake(project.computer, 'phone');
        client.send({ type: 'hello', projectId: createId() });
        const list = expectType(await client.next(), 'projects');
        expect(list.computer.id).toBe(daemon.registry.computerId);
        expect(list.projects.map((entry) => entry.id)).toEqual([project.projectId]);
        // No snapshot and no error: the device picks another project from the list.
        await client.expectSilence();

        client.send({ type: 'subscribe', projectId: project.projectId });
        expect(expectType(await client.next(), 'snapshot').project.id).toBe(project.projectId);
    });

    test('the list follows a device to another project of the same computer', async () => {
        const other = await seedProject(daemon, '/tmp/other-repo');
        const { client } = await connect('phone');
        client.send({ type: 'subscribe', projectId: other.projectId });
        expect(expectType(await client.next(), 'snapshot').project.id).toBe(other.projectId);

        // Ops of the project it left are not sent any more, ops of the new one are.
        const room = await daemon.rooms.get(other.projectId);
        await room?.submitLocal('item.add', other.sessionId, {
            itemId: createId(),
            checklistId: other.checklistId,
            text: 'Step 4',
            order: 3,
        });
        expect(expectType(await client.next(), 'op').op.payload).toMatchObject({ text: 'Step 4' });
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(0);
        expect(daemon.devices.connectedDevices(other.projectId)).toBe(1);

        client.send({ type: 'subscribe', projectId: createId() });
        expect(await client.next()).toMatchObject({
            code: 'forbidden',
            message: 'unknown project',
        });
    });

    test('a rejected client never receives project ops', async () => {
        const intruder = await phone();
        const keys = await generateDeviceKeys();
        await intruder.handshake(project.computer, 'intruder', {
            deviceId: 'intruder',
            keys,
            publicKey: await exportPublicKey(keys.publicKey),
        });
        await intruder.closed;

        const { client } = await connect('phone');
        client.sendOp(
            deviceOp(project, 'phone', 10, 'item.update', {
                itemId: project.itemIds[0],
                status: 'done',
            }),
        );
        expectType(await client.next(), 'op');
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(1);
    });

    test('messages before hello are refused; silent sockets time out', async () => {
        const early = await phone();
        early.sendOp(
            deviceOp(project, 'phone', 10, 'item.update', {
                itemId: project.itemIds[0],
                status: 'done',
            }),
        );
        expect(await early.next()).toMatchObject({
            type: 'error',
            code: 'unauthorized',
            message: 'expected a handshake',
        });
        expect((await early.closed).code).toBe(CloseCode.unauthorized);

        const silent = await phone();
        expect(await silent.next()).toMatchObject({ type: 'error', message: 'hello timeout' });
        expect((await silent.closed).code).toBe(CloseCode.helloTimeout);
    });

    test('the devices are told which sessions an agent waits in: when it changes, and when they join', async () => {
        const { client: phone } = await connect('phone');
        const key = `${project.projectId}/${project.sessionId}`;
        daemon.doneWaiters.hold(key, 'agent', true);
        expect(expectType(await phone.next(), 'waiting')).toEqual({
            type: 'waiting',
            projectId: project.projectId,
            sessionIds: [project.sessionId],
        });
        // A device that joins while somebody waits hears it right after its sync.
        const tablet = await TestClient.connect(relay, project.roomId);
        clients.push(tablet);
        expect(
            (
                await tablet.hello(
                    { projectId: project.projectId, computer: project.computer },
                    'tablet',
                )
            ).type,
        ).toBe('snapshot');
        expect(expectType(await tablet.next(), 'waiting').sessionIds).toEqual([project.sessionId]);
        // The wait ends: both are told, with an empty list.
        daemon.doneWaiters.release(key, 'agent');
        for (const client of [phone, tablet]) {
            expect(expectType(await client.next(), 'waiting').sessionIds).toEqual([]);
        }
    });

    test('a phone marks a session done: every device gets it, and a phone cannot take it back', async () => {
        const { client: phone } = await connect('phone');
        const { client: tablet } = await connect('tablet');
        phone.sendOp(deviceOp(project, 'phone', 10, 'session.done', { done: true }));
        for (const client of [phone, tablet]) {
            expect(expectType(await client.next(), 'op').op).toMatchObject({
                type: 'session.done',
                payload: { done: true },
            });
        }
        const room = await daemon.rooms.get(project.projectId);
        expect(listSessions(room?.state as ProjectState)[0]?.done).toBe(true);

        tablet.sendOp(deviceOp(project, 'tablet', 11, 'session.done', { done: false }));
        expect(await tablet.next()).toMatchObject({ type: 'error', code: 'forbidden' });
        expect(listSessions(room?.state as ProjectState)[0]?.done).toBe(true);

        // Done is no activity: the session keeps its place, and the agent writing takes it back.
        await room?.submitLocal('item.add', project.sessionId, {
            itemId: createId(),
            checklistId: project.checklistId,
            text: 'Step 4',
            order: 3,
        });
        const types: string[] = [];
        for (let i = 0; i < 2; i++) types.push(expectType(await phone.next(), 'op').op.type);
        expect(types).toEqual(['item.add', 'session.done']);
        expect(listSessions(room?.state as ProjectState)[0]?.done).toBeUndefined();
    });

    test('a phone deletes a session: every phone and the agent lose it, and no text stays on disk', async () => {
        const { client: phone } = await connect('phone');
        const { client: tablet } = await connect('tablet');
        phone.sendOp(deviceOp(project, 'phone', 10, 'session.remove', {}));
        for (const client of [phone, tablet]) {
            expect(expectType(await client.next(), 'op').op.type).toBe('session.remove');
        }
        const room = await daemon.rooms.get(project.projectId);
        expect(listSessions(room?.state as ProjectState)).toEqual([]);
        // Phones get the op before the daemon rewrites its files.
        const dir = join(home, 'data', project.projectId);
        const stored = async () => {
            // A `.tmp` of an atomic write may be renamed between the listing and the read.
            const files = (await readdir(dir)).filter((file) => !file.endsWith('.tmp'));
            const contents = await Promise.all(
                files.map((file) => readFile(join(dir, file), 'utf8')),
            );
            return contents.join('');
        };
        for (let i = 0; i < 100 && (await stored()).includes('Step 1'); i++) await Bun.sleep(10);
        expect(await stored()).not.toContain('Refactor auth');
        expect(await stored()).not.toContain('Step 1');
    });

    test('removing a project keeps devices paired and drops it from their list', async () => {
        const { client } = await connect('phone');
        await daemon.removeProject(project.projectId);

        const list = expectType(await client.next(), 'projects');
        expect(list.projects).toEqual([]);
        expect(await daemon.rooms.get(project.projectId)).toBeNull();
        expect(daemon.registry.has(project.projectId)).toBe(false);
        expect(await readdir(join(home, 'data'))).not.toContain(project.projectId);

        // Still paired with the computer, but that project cannot be followed again.
        client.send({ type: 'subscribe', projectId: project.projectId });
        expect(await client.next()).toMatchObject({
            code: 'forbidden',
            message: 'unknown project',
        });
    });

    test('reserved device ids cannot connect', async () => {
        const client = await phone();
        expect(await client.hello(project, 'palmtop-daemon')).toMatchObject({ code: 'forbidden' });
        expect((await client.closed).code).toBe(CloseCode.forbidden);
    });

    test('forbidden ops return an error with opId and are not broadcast', async () => {
        const { client: phone } = await connect('phone');
        const { client: tablet } = await connect('tablet');
        const forbiddenOps = [
            deviceOp(project, 'phone', 10, 'session.message', { message: 'fake agent' }),
            deviceOp(project, 'phone', 11, 'item.update', {
                itemId: project.itemIds[0],
                text: 'rewritten',
            }),
            deviceOp(project, 'phone', 12, 'item.remove', { itemId: project.itemIds[0] }),
            deviceOp(project, 'phone', 13, 'item.update', { itemId: createId(), status: 'done' }),
            deviceOp(project, 'tablet', 14, 'item.update', {
                itemId: project.itemIds[0],
                status: 'done',
            }),
            deviceOp(
                project,
                'phone',
                15,
                'item.update',
                { itemId: project.itemIds[0], status: 'done' },
                createId(),
            ),
        ];
        for (const op of forbiddenOps) {
            phone.sendOp(op);
            expect(await phone.next()).toMatchObject({
                type: 'error',
                code: 'forbidden',
                opId: op.opId,
            });
        }
        await tablet.expectSilence();
        expect((await daemon.rooms.get(project.projectId))?.seq).toBe(5);
    });

    test('a phone adds an item and writes the session note: every device gets them', async () => {
        const { client: phone } = await connect('phone');
        const { client: tablet } = await connect('tablet');
        const itemId = createId();
        const add = deviceOp(project, 'phone', 10, 'item.add', {
            itemId,
            checklistId: project.checklistId,
            text: 'Also check the logout',
            order: 3,
        });
        const note = deviceOp(project, 'phone', 11, 'session.note', { note: 'Use staging' });
        for (const op of [add, note]) {
            phone.sendOp(op);
            expect(await phone.next()).toMatchObject({ type: 'op', op: { opId: op.opId } });
            expect(await tablet.next()).toMatchObject({ type: 'op', op: { opId: op.opId } });
        }
        const state = (await daemon.rooms.get(project.projectId))?.state as ProjectState;
        expect(listItems(state, project.checklistId).at(-1)).toMatchObject({
            text: 'Also check the logout',
            addedByUser: true,
        });
        expect(listSessions(state)[0]?.note).toBe('Use staging');
    });

    test('invalid messages get invalid_message and keep the connection open', async () => {
        const { client } = await connect('phone');
        client.send('{not json');
        expect(await client.next()).toMatchObject({ type: 'error', code: 'invalid_message' });
        client.send({ type: 'op', op: { type: 'item.update' } });
        expect(await client.next()).toMatchObject({ type: 'error', code: 'invalid_message' });
        client.send({
            type: 'hello',
            projectId: project.projectId,
            computer: project.computer,
            deviceId: 'phone',
        });
        expect(await client.next()).toMatchObject({
            type: 'error',
            message: 'already authenticated',
        });

        client.send({ type: 'ping' });
        expect(await client.next()).toEqual({ type: 'pong' });
    });

    test('a duplicated op is applied and broadcast once', async () => {
        const { client } = await connect('phone');
        const op = deviceOp(project, 'phone', 10, 'item.update', {
            itemId: project.itemIds[0],
            status: 'done',
        });
        client.sendOp(op);
        client.sendOp(op);
        expect(await client.next()).toMatchObject({ type: 'op', seq: 6 });
        await client.expectSilence();
    });

    test('reconnecting with lastSeq receives only the missed ops', async () => {
        const { client: phone } = await connect('phone');
        const { client: tablet } = await connect('tablet');
        tablet.close();
        await tablet.closed;

        for (const [index, itemId] of project.itemIds.entries()) {
            phone.sendOp(
                deviceOp(project, 'phone', 10 + index, 'item.update', {
                    itemId,
                    status: 'cancelled',
                }),
            );
            expectType(await phone.next(), 'op');
        }

        const resumed = expectType((await connect('tablet', 5)).first, 'ops');
        expect(resumed.seq).toBe(8);
        expect(resumed.ops.map((entry) => entry.seq)).toEqual([6, 7, 8]);

        const upToDate = expectType((await connect('tablet', 8)).first, 'ops');
        expect(upToDate).toEqual({
            type: 'ops',
            project: { id: project.projectId, name: 'demo-repo', computer: daemon.computerName },
            ops: [],
            seq: 8,
            protocol: DAEMON_PROTOCOL_VERSION,
        });

        // A lastSeq from the future (e.g. data reset) falls back to a full snapshot.
        expectType((await connect('tablet', 100)).first, 'snapshot');
    });

    test('state persists across a daemon restart and seqs continue', async () => {
        const { client } = await connect('phone');
        client.sendOp(
            deviceOp(project, 'phone', 10, 'item.update', {
                itemId: project.itemIds[2],
                status: 'question',
                note: 'why?',
            }),
        );
        expectType(await client.next(), 'op');
        client.close();
        await client.closed;
        const before = (await daemon.rooms.get(project.projectId))?.state;
        await daemon.stop();

        daemon = await startTestDaemon(home, { helloTimeoutMs: 300, relay });
        // Devices paired before the restart are still known (devices.json); new ones are
        // registered on the new daemon.
        project = { ...project, computer: testComputer(daemon) };
        const { client: again, first } = await connect('phone', 6);
        expect(first).toMatchObject({ type: 'ops', ops: [], seq: 6 });
        again.close();

        const snapshot = expectType((await connect('tablet')).first, 'snapshot');
        expect(snapshot.state).toEqual(before as ProjectState);
        expect(listItems(snapshot.state, project.checklistId)[2]).toMatchObject({
            status: 'question',
            note: 'why?',
        });

        const { client: phone } = await connect('phone-2');
        phone.sendOp(
            deviceOp(project, 'phone-2', 20, 'item.update', {
                itemId: project.itemIds[0],
                status: 'done',
            }),
        );
        expect(await phone.next()).toMatchObject({ type: 'op', seq: 7 });
    });

    test('ops are persisted before they are broadcast', async () => {
        const { client } = await connect('phone');
        client.sendOp(
            deviceOp(project, 'phone', 10, 'item.update', {
                itemId: project.itemIds[0],
                status: 'done',
            }),
        );
        const message = expectType(await client.next(), 'op');
        const { JsonStorage } = await import('../src');
        const stored = await new JsonStorage(`${home}/data`).loadProject(project.projectId);
        expect(stored?.ops.at(-1)).toEqual({ seq: message.seq, op: message.op });
        expect(
            applyAll(createProjectState(project.projectId), stored?.ops.map((e) => e.op) ?? []),
        ).toBeDefined();
    });

    test('a message too big for the relay is not sent: the device gets an error, the daemon stays', async () => {
        await daemon.stop();
        daemon = await startTestDaemon(home, {
            helloTimeoutMs: 300,
            relay,
            maxDeviceMessageBytes: 4_000,
        });
        project = { ...project, computer: testComputer(daemon) };
        const room = await daemon.rooms.get(project.projectId);
        for (const order of [3, 4]) {
            await room?.submitLocal('item.add', project.sessionId, {
                itemId: createId(),
                checklistId: project.checklistId,
                text: 'x'.repeat(2_000),
                order,
            });
        }

        const { client, first } = await connect('phone');
        expect(first).toEqual({
            type: 'error',
            code: 'internal',
            message: 'too much data to send through the relay',
        });
        // Over the limit the relay would have closed the daemon, every device with it.
        client.send({ type: 'ping' });
        expect(await client.next()).toEqual({ type: 'pong' });
        expect(daemon.relay.status).toBe('connected');
    });

    test('phones are told when the daemon is offline, and resume when it is back', async () => {
        const { client } = await connect('phone');
        await daemon.stop();
        expect((await client.closed).code).toBe(CloseCode.daemonOffline);

        const early = await phone();
        expect((await early.closed).code).toBe(CloseCode.daemonOffline);

        daemon = await startTestDaemon(home, { helloTimeoutMs: 300, relay });
        const { first } = await connect('phone', 5);
        expect(first).toMatchObject({ type: 'ops', ops: [], seq: 5 });
    });

    test('after a relay restart the daemon reconnects and phones resume with lastSeq', async () => {
        const { client } = await connect('phone');
        const port = relay.port;
        await relay.stop();
        await client.closed;
        await waitUntil(() => daemon.relay.status !== 'connected', 'the daemon to notice');

        const room = await daemon.rooms.get(project.projectId);
        await room?.submitLocal('item.add', project.sessionId, {
            itemId: createId(),
            checklistId: project.checklistId,
            text: 'Step 4',
            order: 3,
        });

        relay = startTestRelay(port);
        await waitForRelay(daemon);
        const resumed = expectType((await connect('phone', 5)).first, 'ops');
        expect(resumed.ops.map((entry) => entry.op.type)).toEqual(['item.add']);
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(1);
    });
});

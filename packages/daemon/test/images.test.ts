import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir, readFile, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import {
    applyAll,
    createId,
    createOp,
    createProjectState,
    LIMITS,
    MAX_DEVICE_MESSAGE_BYTES,
    namedScreenshots,
    type ServerMessage,
    screenshotToken,
    sealedFrameBytes,
} from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import { type Daemon, KEY_HEADER } from '../src';
import { shortRef } from '../src/agent-actions';
import { detectMime, ImageError, ImageStore, MAX_PROJECT_IMAGES } from '../src/images';
import {
    createTempHome,
    deviceOp,
    expectMode,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
} from './helpers';

const jpeg = (size = 64, fill = 7) =>
    Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
const webp = (size = 64) =>
    Buffer.concat([
        Buffer.from('RIFF'),
        Buffer.alloc(4),
        Buffer.from('WEBP'),
        Buffer.alloc(size - 12),
    ]);

describe('the files of the screenshots', () => {
    let root: string;
    let cleanup: () => Promise<void>;
    let store: ImageStore;
    const project = createId();

    beforeEach(async () => {
        ({ home: root, cleanup } = await createTempHome());
        store = new ImageStore(join(root, 'images'));
    });
    afterEach(() => cleanup());

    test('what the first bytes say it is decides: JPEG or WebP, nothing else', () => {
        expect(detectMime(jpeg())).toBe('image/jpeg');
        expect(detectMime(webp())).toBe('image/webp');
        expect(detectMime(Buffer.from('\x89PNG\r\n\x1a\n'))).toBeNull();
        expect(detectMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
        expect(detectMime(Buffer.alloc(0))).toBeNull();
    });

    test('an image is stored for its session, private, and read back', async () => {
        const session = createId();
        const id = createId();
        await store.put(project, session, id, 'image/jpeg', jpeg(100));
        const stored = (await store.index(project)).get(id);
        expect(stored).toMatchObject({ sessionId: session, mime: 'image/jpeg', bytes: 100 });
        expect(stored?.path).toBe(join(root, 'images', project, `${session}.${id}.jpg`));
        await expectMode(stored?.path as string, 0o600);
        await expectMode(join(root, 'images', project), 0o700);
        expect(await store.read(project, id)).toEqual({ mime: 'image/jpeg', bytes: jpeg(100) });
        expect(await store.read(project, createId())).toBeNull();
        expect(await store.read(createId(), id)).toBeNull();
    });

    test('a file that is not what it says, empty or too large is refused', async () => {
        const put = (mime: 'image/jpeg' | 'image/webp', bytes: Buffer) =>
            store.put(project, createId(), createId(), mime, bytes).catch((error) => error);
        expect(await put('image/webp', jpeg())).toMatchObject({ reason: 'type' });
        expect(await put('image/jpeg', Buffer.from('<svg/>'))).toBeInstanceOf(ImageError);
        expect(await put('image/jpeg', Buffer.alloc(0))).toMatchObject({ reason: 'size' });
        expect(await put('image/jpeg', jpeg(LIMITS.image + 1))).toMatchObject({ reason: 'size' });
        expect(await put('image/jpeg', jpeg(LIMITS.image))).toBeUndefined();
    });

    test('the same id again replaces the file, whatever its type', async () => {
        const session = createId();
        const id = createId();
        await store.put(project, session, id, 'image/jpeg', jpeg(80));
        await store.put(project, session, id, 'image/webp', webp(90));
        const files = await readdir(join(root, 'images', project));
        expect(files).toEqual([`${session}.${id}.webp`]);
    });

    // Every put lists the folder, so filling it is quadratic: slow runners need the room.
    test('a project holds a number of screenshots', async () => {
        const session = createId();
        for (let count = 0; count < MAX_PROJECT_IMAGES; count++) {
            await store.put(project, session, createId(), 'image/jpeg', jpeg(16));
        }
        const refused = await store
            .put(project, session, createId(), 'image/jpeg', jpeg(16))
            .catch((error) => error);
        expect(refused).toMatchObject({ reason: 'quota' });
        // Another project has its own room.
        await store.put(createId(), session, createId(), 'image/jpeg', jpeg(16));
    }, 30_000);

    test('a session and a project take their screenshots with them', async () => {
        const [one, two] = [createId(), createId()];
        const [a, b] = [createId(), createId()];
        await store.put(project, one, a, 'image/jpeg', jpeg());
        await store.put(project, two, b, 'image/webp', webp());
        await store.removeSession(project, one);
        expect([...(await store.index(project)).keys()]).toEqual([b]);
        await store.removeProject(project);
        expect((await store.index(project)).size).toBe(0);
        await store.removeProject(project);
    });

    test('a sweep keeps what a note names and what is recent, and drops the rest', async () => {
        const session = createId();
        const [named, orphan, recent] = [createId(), createId(), createId()];
        for (const id of [named, orphan, recent]) {
            await store.put(project, session, id, 'image/jpeg', jpeg());
        }
        const old = new Date(Date.now() - 3_600_000);
        for (const id of [named, orphan]) {
            const path = (await store.index(project)).get(id)?.path as string;
            await utimes(path, old, old);
        }
        expect(await store.sweep(project, new Set([named]))).toBe(1);
        expect([...(await store.index(project)).keys()].sort()).toEqual([named, recent].sort());
    });

    test('the screenshots the notes of a state name', () => {
        const [session, checklist, item, one, two, gone] = Array.from({ length: 6 }, createId) as [
            string,
            string,
            string,
            string,
            string,
            string,
        ];
        const projectId = createId();
        const op = (type: string, payload: object, lamport: number, sessionId = session) =>
            createOp({
                projectId,
                sessionId,
                type,
                payload,
                clock: { lamport, deviceId: 'phone' },
            } as never);
        const state = applyAll(createProjectState(projectId), [
            op('session.upsert', { title: 't', branch: 'b', startedAt: 1 }, 1),
            op('session.note', { note: `- a\n  ${screenshotToken(one)}` }, 2),
            op('checklist.create', { checklistId: checklist, title: 'c' }, 3),
            op('item.add', { itemId: item, checklistId: checklist, text: 'i', order: 0 }, 4),
            op(
                'item.update',
                { itemId: item, status: 'done', note: `x ${screenshotToken(two)}` },
                5,
            ),
            op('session.upsert', { title: 't', branch: 'b', startedAt: 1 }, 6, gone),
            op('session.note', { note: screenshotToken(createId()) }, 7, gone),
            op('session.remove', {}, 8, gone),
        ] as never);
        expect([...namedScreenshots(state)].sort()).toEqual([one, two].sort());
    });
});

describe('screenshots of a device, through the relay', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    let key: string;
    const clients: TestClient[] = [];

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await startTestDaemon(home, { relay });
        project = await seedProject(daemon);
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    async function phone(deviceId = 'phone') {
        const client = await TestClient.connect(relay, project.roomId);
        clients.push(client);
        await client.hello(project, deviceId);
        return client;
    }

    const put = (imageId: string, bytes: Buffer, extra: object = {}) => ({
        type: 'image.put',
        projectId: project.projectId,
        sessionId: project.sessionId,
        imageId,
        mime: 'image/jpeg',
        data: bytes.toString('base64'),
        ...extra,
    });

    const filesOf = async () => {
        try {
            return await readdir(join(home, 'images', project.projectId));
        } catch {
            return [];
        }
    };

    const api = async (method: string, path: string, payload?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${daemon.localPort}${path}`, {
            method,
            headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
            ...(payload !== undefined && { body: JSON.stringify(payload) }),
        });
        // biome-ignore lint/suspicious/noExplicitAny: the JSON of the Local API, read freely by the tests
        return (await response.json()) as Record<string, any>;
    };

    test('a screenshot is stored, answered and given back', async () => {
        const client = await phone();
        const id = createId();
        client.send(put(id, jpeg(2_000)));
        expect(await client.next()).toEqual({ type: 'image.saved', imageId: id });
        expect(await filesOf()).toEqual([`${project.sessionId}.${id}.jpg`]);

        client.send({ type: 'image.get', projectId: project.projectId, imageId: id });
        const image = (await client.next()) as Extract<ServerMessage, { type: 'image' }>;
        expect(image).toMatchObject({ type: 'image', imageId: id, mime: 'image/jpeg' });
        expect(Buffer.from(image.data, 'base64')).toEqual(jpeg(2_000));

        const other = createId();
        client.send({ type: 'image.get', projectId: project.projectId, imageId: other });
        expect(await client.next()).toEqual({ type: 'image.missing', imageId: other });
        // It never went into the log or the state.
        const data = join(home, 'data', project.projectId);
        for (const name of await readdir(data)) {
            if (name.endsWith('.tmp')) continue;
            expect(await readFile(join(data, name), 'utf8')).not.toContain(id);
        }
    });

    test('what cannot be kept is refused with the id of the image', async () => {
        const client = await phone();
        const [wrong, unknown, project404] = [createId(), createId(), createId()];
        client.send(put(wrong, Buffer.from('<svg/>')));
        expect(await client.next()).toMatchObject({
            type: 'error',
            code: 'invalid_message',
            imageId: wrong,
        });
        client.send(put(unknown, jpeg(), { sessionId: createId() }));
        expect(await client.next()).toMatchObject({
            type: 'error',
            code: 'forbidden',
            imageId: unknown,
        });
        client.send(put(project404, jpeg(), { projectId: createId() }));
        expect(await client.next()).toMatchObject({
            type: 'error',
            code: 'forbidden',
            imageId: project404,
        });
        expect(await filesOf()).toEqual([]);
        // A message of the biggest image still fits the frame a device can send.
        const largest = JSON.stringify(put(createId(), jpeg(LIMITS.image)));
        expect(sealedFrameBytes(Buffer.byteLength(largest))).toBeLessThanOrEqual(
            MAX_DEVICE_MESSAGE_BYTES,
        );
    });

    test('the agent is given the screenshots as files, and the new ones as images', async () => {
        const client = await phone();
        const [first, second] = [createId(), createId()];
        for (const id of [first, second]) {
            client.send(put(id, jpeg(300)));
            expect(await client.next()).toMatchObject({ type: 'image.saved' });
        }
        const base = `/projects/${project.projectId}/sessions/${shortRef(project.sessionId)}`;
        const note = (text: string, lamport: number) => {
            const op = deviceOp(project, 'phone', lamport, 'session.note', { note: text });
            client.sendOp(op);
            return client.next();
        };
        const item = deviceOp(project, 'phone', 20, 'item.update', {
            itemId: project.itemIds[0],
            status: 'cancelled',
            note: `Broken ${screenshotToken(second)}`,
        });
        client.sendOp(item);
        await client.next();
        await note(`- Header [#aaaa]\n  ${screenshotToken(first)}`, 21);

        const feedback = await api('GET', `${base}/feedback`);
        const path = (id: string) =>
            join(home, 'images', project.projectId, `${project.sessionId}.${id}.jpg`);
        expect(feedback.note).toBe(`- Header\n  screenshot: ${path(first)}`);
        expect(feedback.checklists[0].changed[0].note).toBe(`Broken screenshot: ${path(second)}`);
        expect(feedback.images.map((image: { id: string }) => image.id).sort()).toEqual(
            [first, second].sort(),
        );
        expect(feedback.images[0]).toMatchObject({ mime: 'image/jpeg' });
    });

    test('a note shown again does not send its old pictures again', async () => {
        const client = await phone();
        const [first, second] = [createId(), createId()];
        for (const id of [first, second]) {
            client.send(put(id, jpeg(300)));
            expect(await client.next()).toMatchObject({ type: 'image.saved' });
        }
        const base = `/projects/${project.projectId}/sessions/${shortRef(project.sessionId)}`;
        const write = async (text: string, lamport: number) => {
            client.sendOp(deviceOp(project, 'phone', lamport, 'session.note', { note: text }));
            await client.next();
        };
        await write(`- One [#aaaa]\n  ${screenshotToken(first)}`, 50);
        const before = await api('GET', `${base}/feedback`);
        expect(before.images.map((image: { id: string }) => image.id)).toEqual([first]);
        await api('POST', `${base}/feedback/ack`, before.ack);
        // The delivery is an op every device gets.
        expect(await client.next()).toMatchObject({ type: 'op', op: { type: 'feedback.deliver' } });

        await write(
            `- One [#aaaa]\n  ${screenshotToken(first)}\n- Two [#bbbb]\n  ${screenshotToken(second)}`,
            51,
        );
        const after = await api('GET', `${base}/feedback`);
        // The whole list is shown, with a file for each picture; only the new one is given again.
        expect(after.note).toContain(`${project.sessionId}.${first}.jpg`);
        expect(after.note).toContain(`${project.sessionId}.${second}.jpg`);
        expect(after.note).toContain('- [new] Two');
        expect(after.images.map((image: { id: string }) => image.id)).toEqual([second]);
    });

    test('a screenshot that did not arrive says so', async () => {
        const client = await phone();
        const missing = createId();
        client.sendOp(
            deviceOp(project, 'phone', 30, 'session.note', {
                note: `- Header [#aaaa]\n  ${screenshotToken(missing)}`,
            }),
        );
        await client.next();
        const base = `/projects/${project.projectId}/sessions/${shortRef(project.sessionId)}`;
        const feedback = await api('GET', `${base}/feedback`);
        expect(feedback.note).toBe('- Header\n  screenshot: (not received from the device yet)');
        expect(feedback.images).toEqual([]);
    });

    test('the screenshots of a session go with it, and the ones nobody names go in time', async () => {
        const client = await phone();
        const [kept, orphan] = [createId(), createId()];
        client.send(put(kept, jpeg()));
        await client.next();
        client.sendOp(
            deviceOp(project, 'phone', 40, 'session.note', {
                note: `- a\n  ${screenshotToken(kept)}`,
            }),
        );
        await client.next();
        client.send(put(orphan, jpeg()));
        await client.next();
        expect(await filesOf()).toHaveLength(2);
        // Old enough to be swept by the next screenshot.
        const old = new Date(Date.now() - 3_600_000);
        await utimes(
            join(home, 'images', project.projectId, `${project.sessionId}.${orphan}.jpg`),
            old,
            old,
        );
        const later = createId();
        client.send(put(later, jpeg()));
        await client.next();
        for (let wait = 0; wait < 40 && (await filesOf()).length > 2; wait++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        expect((await filesOf()).sort()).toEqual(
            [`${project.sessionId}.${kept}.jpg`, `${project.sessionId}.${later}.jpg`].sort(),
        );

        const room = await daemon.rooms.get(project.projectId);
        await room?.submitLocal('session.remove', project.sessionId, {});
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(await filesOf()).toEqual([]);
        expect((await stat(join(home, 'data', project.projectId))).isDirectory()).toBe(true);
    });

    test('removing the project removes its screenshots', async () => {
        const client = await phone();
        client.send(put(createId(), jpeg()));
        await client.next();
        expect(await filesOf()).toHaveLength(1);
        await api('DELETE', `/projects/${project.projectId}`);
        expect(await filesOf()).toEqual([]);
    });
});

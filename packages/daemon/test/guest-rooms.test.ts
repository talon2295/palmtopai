import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    CloseCode,
    createId,
    DEVICE_UNPAIRED,
    listItems,
    type PushRegistration,
    type ServerMessage,
    screenshotToken,
} from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import {
    type Daemon,
    DEFAULT_OWNER_NAME,
    GuestRooms,
    INVITE_TTL_MS,
    KEY_HEADER,
    MAX_GUEST_ROOMS,
    MemoryStorage,
    PeopleStore,
    RoomManager,
    type Share,
} from '../src';
import { ActionError, shortRef } from '../src/agent-actions';
import { GUEST_IMAGE_LIMITS } from '../src/images';
import type { PushPayload } from '../src/push-notifier';
import { PushStore } from '../src/push-store';
import {
    createTempHome,
    deviceOp,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
    type TestComputer,
    type TestDevice,
    waitUntil,
} from './helpers';

const OFFICE = 'Grace-Office';

/** Everything a client received until it is silent for a moment. */
async function drain(client: TestClient, ms = 150): Promise<ServerMessage[]> {
    const messages: ServerMessage[] = [];
    for (;;) {
        try {
            messages.push(await client.next(ms));
        } catch {
            return messages;
        }
    }
}

interface Guest {
    name: string;
    personId: string;
    roomId: string;
    client: TestClient;
    device: TestDevice;
    /** The room as the guest's device knows it. */
    computer: TestComputer;
    key: string;
}

describe('rooms of the people checklists are shared with', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    let other: SeededProject;
    const clients: TestClient[] = [];
    const sent: Array<{ endpoint: string; payload: PushPayload }> = [];

    function start(options: Parameters<typeof startTestDaemon>[1] = {}) {
        return startTestDaemon(home, {
            relay,
            pushDelayMs: 30,
            pushSender: {
                async send(target, payload) {
                    sent.push({ endpoint: target.subscription.endpoint, payload });
                    return { gone: false };
                },
            },
            ...options,
        });
    }

    beforeEach(async () => {
        sent.length = 0;
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await start();
        await daemon.setComputerName(OFFICE);
        project = await seedProject(daemon, '/tmp/demo-repo');
        other = await seedProject(daemon, '/tmp/secret-project');
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    async function connect(roomId: string): Promise<TestClient> {
        const client = await TestClient.connect(relay, roomId);
        clients.push(client);
        return client;
    }

    /** Gives a copy of the checklist of the project to a person (created if new). */
    async function share(name: string, days?: number): Promise<Share> {
        if (!daemon.people.findPerson(name)) await daemon.people.addPerson(name);
        const room = await daemon.rooms.get(project.projectId);
        await daemon.sharing.share({
            room: room as NonNullable<typeof room>,
            sessionId: project.sessionId,
            checklistRef: shortRef(project.checklistId),
            personName: name,
            ...(days !== undefined && { days }),
        });
        const person = daemon.people.findPerson(name);
        return daemon.people.shareFor(
            person?.personId as string,
            project.projectId,
            project.sessionId,
        ) as Share;
    }

    /** Invites a person, and pairs a device of theirs with the key of the invitation. */
    async function joinAs(name: string, deviceId = `${name.toLowerCase()}-phone`): Promise<Guest> {
        const invite = await daemon.guestRooms.invite(name);
        await waitUntil(() => daemon.relay.isRoomOpen(invite.roomId), 'the room of the guest');
        const client = await connect(invite.roomId);
        const paired = await client.pair({
            roomId: invite.roomId,
            pairKey: invite.key,
            deviceId,
            name: `Browser of ${name}`,
        });
        const message = await client.next();
        expect(message.type).toBe('paired');
        return {
            name,
            personId: invite.person.personId,
            roomId: invite.roomId,
            client,
            device: paired.device,
            key: invite.key,
            computer: {
                roomId: invite.roomId,
                publicKey: paired.computerKey,
                device: async () => paired.device,
            },
        };
    }

    /** Says hello in the room of a guest and returns the project list it gets. */
    async function hello(guest: Guest, projectId?: string) {
        await guest.client.hello(
            { computer: guest.computer, ...(projectId && { projectId }) },
            guest.device.deviceId,
        );
        return guest.client.projects;
    }

    describe('screenshots of the people', () => {
        const jpeg = (size = 64, fill = 3) =>
            Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size - 4, fill)]);
        const put = (copy: Share, imageId: string, extra: object = {}) => ({
            type: 'image.put',
            projectId: copy.shareId,
            sessionId: copy.copySessionId,
            imageId,
            mime: 'image/jpeg',
            data: jpeg().toString('base64'),
            ...extra,
        });
        const filesOf = async (projectId: string) =>
            readdir(join(home, 'images', projectId)).catch(() => [] as string[]);
        const api = async (path: string) => {
            const key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
            const response = await fetch(`http://127.0.0.1:${daemon.localPort}${path}`, {
                headers: { [KEY_HEADER]: key },
            });
            // biome-ignore lint/suspicious/noExplicitAny: the JSON of the Local API, read freely by the tests
            return (await response.json()) as Record<string, any>;
        };

        test('a person stores a screenshot on their copy and gets it back', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const id = createId();
            mario.client.send(put(copy, id));
            expect(await mario.client.next()).toEqual({ type: 'image.saved', imageId: id });
            expect(await filesOf(copy.shareId)).toEqual([`${copy.copySessionId}.${id}.jpg`]);
            // Not among the files of the project of the computer.
            expect(await filesOf(project.projectId)).toEqual([]);

            mario.client.send({ type: 'image.get', projectId: copy.shareId, imageId: id });
            const image = (await mario.client.next()) as Extract<ServerMessage, { type: 'image' }>;
            expect(Buffer.from(image.data, 'base64')).toEqual(jpeg());
        });

        test('only on their own copy, and not once it is read-only', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await share('Luca');
            const luca = await joinAs('Luca');
            await hello(mario, copy.shareId);
            await hello(luca);
            const id = createId();
            // Another person cannot reach a copy that is not theirs, to put or to read.
            luca.client.send(put(copy, id));
            expect(await luca.client.next()).toMatchObject({
                type: 'error',
                code: 'forbidden',
                imageId: id,
            });
            mario.client.send(put(copy, id));
            expect(await mario.client.next()).toMatchObject({ type: 'image.saved' });
            luca.client.send({ type: 'image.get', projectId: copy.shareId, imageId: id });
            expect(await luca.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            // The project of the computer is not theirs either.
            mario.client.send(put(copy, createId(), { projectId: project.projectId }));
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });

            await daemon.people.putShare({ ...copy, expiresAt: Date.now() - 1 });
            const late = createId();
            mario.client.send(put(copy, late));
            expect(await mario.client.next()).toMatchObject({
                type: 'error',
                code: 'forbidden',
                message: 'this checklist is read-only now',
                imageId: late,
            });
        });

        test('a copy holds fewer screenshots than a project of the computer', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            // A copy that is already full (the relay allows only so many messages a second).
            const dir = join(home, 'images', copy.shareId);
            await mkdir(dir, { recursive: true });
            for (let count = 0; count < GUEST_IMAGE_LIMITS.images; count++) {
                await writeFile(join(dir, `${copy.copySessionId}.${createId()}.jpg`), jpeg());
            }
            const over = createId();
            mario.client.send(put(copy, over));
            expect(await mario.client.next()).toMatchObject({
                type: 'error',
                code: 'forbidden',
                imageId: over,
            });
        });

        test('the owner sees them with the project, and the agent is given them with their notes', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const [first, second] = [createId(), createId()];
            for (const id of [first, second]) {
                mario.client.send(
                    put(copy, id, { data: jpeg(80, id === first ? 1 : 2).toString('base64') }),
                );
                expect(await mario.client.next()).toMatchObject({ type: 'image.saved' });
            }
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            const guestRoom = await daemon.rooms.get(copy.shareId);
            const itemId = listItems(
                guestRoom?.state as never,
                copy.checklists[0]?.copy as string,
            )[0]?.id as string;
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    50,
                    'item.update',
                    { itemId, status: 'cancelled', note: `Broken ${screenshotToken(first)}` },
                    copy.copySessionId,
                ),
            );
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    51,
                    'session.note',
                    { note: `- Slow [#aaaa]\n  ${screenshotToken(second)}` },
                    copy.copySessionId,
                ),
            );
            await waitUntil(
                () => guestRoom?.state.sessions[copy.copySessionId]?.values.note !== undefined,
                'the note',
            );

            // The owner's device asks the project the copy comes from, and gets the picture.
            const owner = await connect(project.roomId);
            await owner.hello(project, 'owner-phone');
            owner.send({ type: 'image.get', projectId: project.projectId, imageId: first });
            let image: ServerMessage = await owner.next();
            // The answers of the people come right after the sync.
            while (image.type !== 'image') image = await owner.next();
            expect(Buffer.from(image.data, 'base64')).toEqual(jpeg(80, 1));

            const base = `/projects/${project.projectId}/sessions/${shortRef(project.sessionId)}`;
            const feedback = await api(`${base}/feedback`);
            const path = (id: string) =>
                join(home, 'images', copy.shareId, `${copy.copySessionId}.${id}.jpg`);
            expect(feedback.shared.notes[0].note).toBe(`- Slow\n  screenshot: ${path(second)}`);
            expect(feedback.shared.checklists[0].items[0].outcomes[0].note).toBe(
                `Broken screenshot: ${path(first)}`,
            );
            expect(feedback.shared.images.map((entry: { id: string }) => entry.id).sort()).toEqual(
                [first, second].sort(),
            );
        });

        test('the screenshots of a copy go with it', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            mario.client.send(put(copy, createId()));
            expect(await mario.client.next()).toMatchObject({ type: 'image.saved' });
            expect(await filesOf(copy.shareId)).toHaveLength(1);
            await daemon.sharing.dropSession(project.projectId, project.sessionId);
            expect(await filesOf(copy.shareId)).toEqual([]);
        });
    });

    describe('what a guest can see', () => {
        test('the copies made for them, under the name of their owner, and nothing else', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            const list = await hello(mario);
            expect(list?.computer).toEqual({ id: mario.personId, name: DEFAULT_OWNER_NAME });
            expect(list?.projects.map((entry) => entry.id)).toEqual([copy.shareId]);
            expect(list?.projects[0]).toMatchObject({ sessions: 1, pending: 3 });
        });

        test('no message they receive tells anything of the computer, its projects or other people', async () => {
            await share('Mario');
            const mario = await joinAs('Mario');
            await share('Luca');
            await joinAs('Luca');
            const copy = daemon.people.shareFor(
                mario.personId,
                project.projectId,
                project.sessionId,
            );
            await hello(mario, copy?.shareId);
            await daemon.sharing.retest({
                room: (await daemon.rooms.get(project.projectId)) as never,
                sessionId: project.sessionId,
                personName: 'Mario',
                message: 'Please look again',
            });
            const received = [...(await drain(mario.client))];
            const everything = JSON.stringify([mario.client.projects, ...received]);
            expect(received.length).toBeGreaterThan(0);
            for (const secret of [
                OFFICE,
                daemon.registry.computerId,
                daemon.registry.roomId,
                project.projectId,
                project.sessionId,
                project.checklistId,
                ...project.itemIds,
                other.projectId,
                other.sessionId,
                'demo-repo',
                'secret-project',
                '/tmp/',
                'Luca',
            ]) {
                expect(everything).not.toContain(secret);
            }
        });

        test('they follow their own copy, and nothing they are not given', async () => {
            const marioCopy = await share('Mario');
            const lucaCopy = await share('Luca');
            const mario = await joinAs('Mario');
            await joinAs('Luca');
            await hello(mario);
            for (const projectId of [
                project.projectId,
                other.projectId,
                lucaCopy.shareId,
                createId(),
            ]) {
                mario.client.send({ type: 'subscribe', projectId });
                expect(await mario.client.next()).toMatchObject({
                    type: 'error',
                    code: 'forbidden',
                });
            }
            mario.client.send({ type: 'subscribe', projectId: marioCopy.shareId });
            expect(await mario.client.next()).toMatchObject({ type: 'snapshot' });
        });

        test('asking for the project of the computer at hello gives the list and no project', async () => {
            await share('Mario');
            const mario = await joinAs('Mario');
            mario.client.send({ type: 'hello', projectId: project.projectId });
            expect(await mario.client.next()).toMatchObject({ type: 'projects' });
            await mario.client.expectSilence();
        });

        test('the people see nothing of each other', async () => {
            await share('Mario');
            const lucaCopy = await share('Luca');
            const mario = await joinAs('Mario');
            const luca = await joinAs('Luca');
            expect((await hello(mario))?.projects).toHaveLength(1);
            const lucaList = await hello(luca);
            expect(lucaList?.projects.map((entry) => entry.id)).toEqual([lucaCopy.shareId]);
            expect(JSON.stringify(lucaList)).not.toContain('Mario');
        });
    });

    describe('what a guest can do', () => {
        test('review the copy, add an item of their own and write a note', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const guestRoom = await daemon.rooms.get(copy.shareId);
            const [first] = listItems(
                guestRoom?.state as never,
                copy.checklists[0]?.copy as string,
            );
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    50,
                    'item.update',
                    { itemId: first?.id as string, status: 'cancelled', note: 'broken' },
                    copy.copySessionId,
                ),
            );
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    51,
                    'session.note',
                    { note: 'All good but this' },
                    copy.copySessionId,
                ),
            );
            await waitUntil(
                () => guestRoom?.state.sessions[copy.copySessionId]?.values.note !== undefined,
                'the note',
            );
            expect(
                listItems(guestRoom?.state as never, copy.checklists[0]?.copy as string)[0],
            ).toMatchObject({ status: 'cancelled', note: 'broken' });
            // The original is untouched.
            const original = await daemon.rooms.get(project.projectId);
            expect(
                listItems(original?.state as never, project.checklistId).every(
                    (item) => item.status === undefined,
                ),
            ).toBe(true);
        });

        test('not delete the session, nor the project', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    50,
                    'session.remove',
                    {},
                    copy.copySessionId,
                ),
            );
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            mario.client.send({ type: 'project.remove', projectId: copy.shareId });
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            // Nor archive it: the owner puts things away, a copy turns read-only on its date.
            mario.client.send({ type: 'archive', projectId: copy.shareId, archived: true });
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            expect(daemon.people.share(copy.shareId)).not.toBeNull();
            const guestRoom = await daemon.rooms.get(copy.shareId);
            expect(Object.values(guestRoom?.state.sessions ?? {})[0]?.removed).toBeNull();
        });

        test('mark their copy done: the owner hears of it, the agent does not, and the agent writing takes it back', async () => {
            const owner = await connect(daemon.registry.roomId);
            await owner.hello({ computer: project.computer }, 'owner-phone');
            owner.send({
                type: 'push.subscribe',
                push: {
                    subscription: {
                        endpoint: `https://fcm.googleapis.com/fcm/send/${createId()}`,
                        keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
                    },
                    vapid: { publicKey: 'D'.repeat(87), privateKey: 'E'.repeat(43) },
                },
            });
            await waitUntil(() => daemon.push.list().length === 1, 'the owner subscribed');

            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    50,
                    'session.done',
                    { done: true },
                    copy.copySessionId,
                ),
            );
            await waitUntil(
                () => sent.some((entry) => entry.payload.body.includes('Mario finished reviewing')),
                'the notice for the owner',
            );
            const notice = sent.find((entry) => entry.payload.body.includes('finished'));
            expect(notice?.payload).toMatchObject({
                title: 'Palmtop',
                body: expect.stringContaining('Mario finished reviewing · '),
            });
            expect(notice?.payload.projectId).toBe('');

            // The owner's devices see the mark on the person; the agent hears nothing.
            const view = await daemon.sharing.ownerView(project.projectId);
            expect(view[0]?.people[0]).toMatchObject({ name: 'Mario', done: true });
            const room = await daemon.rooms.get(project.projectId);
            expect(room?.state.sessions[project.sessionId]?.values.done).toBeUndefined();
            const feedback = await daemon.sharing.sharedFeedback(
                project.projectId,
                project.sessionId,
            );
            expect(feedback?.hasNew).toBe(false);
            expect(JSON.stringify(feedback)).not.toContain('finished');

            // The agent brings the copy up to date: there is something new for the person to do.
            const itemId = project.itemIds[0] as string;
            await room?.submitLocal('item.update', project.sessionId, {
                itemId,
                text: 'Step 1, again',
            });
            await daemon.sharing.retest({
                room: room as NonNullable<typeof room>,
                sessionId: project.sessionId,
                personName: 'Mario',
            });
            const copyRoom = await daemon.rooms.get(copy.shareId);
            await waitUntil(
                () => copyRoom?.state.sessions[copy.copySessionId]?.values.done === false,
                'the done taken back',
            );
            const after = await daemon.sharing.ownerView(project.projectId);
            expect(after[0]?.people[0]?.done).toBeUndefined();
        });

        test('not take a done back: only the agent writing does', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    50,
                    'session.done',
                    { done: false },
                    copy.copySessionId,
                ),
            );
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
        });

        test('not add items: they review and write notes', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            mario.client.sendOp(
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    50,
                    'item.add',
                    {
                        itemId: createId(),
                        checklistId: copy.checklists[0]?.copy as string,
                        text: 'Mine',
                        order: 9,
                    },
                    copy.copySessionId,
                ),
            );
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
        });

        test('not write into the original, whatever the op says', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            // An op for the original project, sent while following the copy.
            mario.client.sendOp(
                deviceOp(project, mario.device.deviceId, 50, 'item.update', {
                    itemId: project.itemIds[0],
                    status: 'done',
                }),
            );
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            // An op for the original session, in the room of the copy.
            const asGuest = { ...project, projectId: copy.shareId };
            mario.client.sendOp(
                deviceOp(asGuest, mario.device.deviceId, 51, 'session.note', { note: 'x' }),
            );
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            const original = await daemon.rooms.get(project.projectId);
            expect(
                listItems(original?.state as never, project.checklistId).every(
                    (item) => item.status === undefined,
                ),
            ).toBe(true);
        });

        test('not reach the room of the computer with the key of their own', async () => {
            await share('Mario');
            const mario = await joinAs('Mario');
            const atHome = await connect(daemon.registry.roomId);
            await atHome.handshake(project.computer, mario.device.deviceId, mario.device);
            expect(await atHome.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
            expect((await atHome.closed).code).toBeGreaterThanOrEqual(4000);
        });

        test('the copy is read-only once it expires, and goes when it is closed', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const asGuest = { ...project, projectId: copy.shareId, sessionId: copy.copySessionId };
            const guestRoom = await daemon.rooms.get(copy.shareId);
            const itemId = listItems(
                guestRoom?.state as never,
                copy.checklists[0]?.copy as string,
            )[0]?.id as string;
            const op = (lamport: number, status: 'done' | 'question') =>
                deviceOp(
                    asGuest,
                    mario.device.deviceId,
                    lamport,
                    'item.update',
                    { itemId, status },
                    copy.copySessionId,
                );

            mario.client.sendOp(op(50, 'done'));
            await waitUntil(
                () =>
                    listItems(guestRoom?.state as never, copy.checklists[0]?.copy as string)[0]
                        ?.status === 'done',
                'the review',
            );

            await drain(mario.client);
            await daemon.people.putShare({ ...copy, expiresAt: Date.now() - 1 });
            mario.client.sendOp(op(51, 'question'));
            expect(await mario.client.next()).toMatchObject({ type: 'error', code: 'forbidden' });
            expect(
                listItems(guestRoom?.state as never, copy.checklists[0]?.copy as string)[0]?.status,
            ).toBe('done');

            // Something else stays with the person, so that their room stays open.
            const otherRoom = await daemon.rooms.get(other.projectId);
            await daemon.sharing.share({
                room: otherRoom as NonNullable<typeof otherRoom>,
                sessionId: other.sessionId,
                checklistRef: shortRef(other.checklistId),
                personName: 'Mario',
            });
            await daemon.sharing.close({
                projectId: project.projectId,
                sessionId: project.sessionId,
                personName: 'Mario',
            });
            let list = await waitForList(mario.client);
            for (let i = 0; i < 5 && list.some((entry) => entry.id === copy.shareId); i++) {
                list = await waitForList(mario.client);
            }
            expect(list.map((entry) => entry.id)).not.toContain(copy.shareId);
            expect(list).toHaveLength(1);
            mario.client.send({ type: 'subscribe', projectId: copy.shareId });
            // The list may be sent again meanwhile: what matters is the refusal.
            let reply = await mario.client.next();
            while (reply.type === 'projects') reply = await mario.client.next();
            expect(reply).toMatchObject({ type: 'error', code: 'forbidden' });
        });
    });

    async function waitForList(client: TestClient) {
        for (let i = 0; i < 20; i++) {
            const message = await client.next();
            if (message.type === 'projects') return message.projects;
        }
        throw new Error('no project list arrived');
    }

    describe('their rooms at the relay', () => {
        test('are open while there is something to see, and closed after', async () => {
            await share('Mario');
            const mario = await joinAs('Mario');
            expect(daemon.relay.isRoomOpen(mario.roomId)).toBe(true);
            // The computer's own room is never touched.
            expect(daemon.relay.isRoomOpen(daemon.registry.roomId)).toBe(true);

            await hello(mario);
            await daemon.sharing.close({
                projectId: project.projectId,
                sessionId: project.sessionId,
                personName: 'Mario',
            });
            await waitUntil(() => !daemon.relay.isRoomOpen(mario.roomId), 'the room closing');
            expect((await mario.client.closed).code).toBeGreaterThan(0);
            // The last thing the person hears is that nothing is shared with them any more.
            const heard = await drain(mario.client, 50);
            expect(heard.filter((message) => message.type === 'projects').at(-1)).toMatchObject({
                projects: [],
            });
            const late = await TestClient.connect(relay, mario.roomId);
            clients.push(late);
            expect((await late.closed).code).toBe(CloseCode.daemonOffline);
            expect(daemon.relay.isRoomOpen(daemon.registry.roomId)).toBe(true);
        });

        test('a room opens again when something is shared again', async () => {
            await share('Mario');
            const mario = await joinAs('Mario');
            await daemon.sharing.close({
                projectId: project.projectId,
                sessionId: project.sessionId,
                personName: 'Mario',
            });
            await waitUntil(() => !daemon.relay.isRoomOpen(mario.roomId), 'the room closing');
            await share('Mario');
            await waitUntil(() => daemon.relay.isRoomOpen(mario.roomId), 'the room opening');
            const again = await connect(mario.roomId);
            await again.hello({ computer: mario.computer }, mario.device.deviceId);
            expect(again.projects?.projects).toHaveLength(1);
        });

        test('the relay counts them apart from computers', async () => {
            await share('Mario');
            await joinAs('Mario');
            const stats = relay.report();
            expect(stats.live).toMatchObject({ computers: 1, guestRooms: 1 });
        });

        test('a guest room is not served by a daemon that is not connected, and comes with it later', async () => {
            await daemon.stop();
            await relay.stop();
            relay = startTestRelay();
            daemon = await start();
            const invite = await daemon.guestRooms.invite('Mario');
            await waitUntil(
                () => daemon.relay.isRoomOpen(invite.roomId),
                'the room after a restart',
            );
        });
    });

    describe('invitations', () => {
        test('are single-use: the second device with the same key is refused', async () => {
            const mario = await joinAs('Mario');
            const second = await connect(mario.roomId);
            const result = await second.pair({
                roomId: mario.roomId,
                pairKey: mario.key,
                deviceId: 'intruder',
            });
            expect(result.computerKey).toBe('');
            expect(await second.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
            expect(daemon.people.person(mario.personId)?.device?.deviceId).toBe('mario-phone');
        });

        test('a key of the computer does not open a room of a person, nor the reverse', async () => {
            const invite = await daemon.guestRooms.invite('Mario');
            await waitUntil(() => daemon.relay.isRoomOpen(invite.roomId), 'the room');
            const localKey = (await readFile(join(home, 'local.key'), 'utf8')).trim();
            const link = (await (
                await fetch(`http://127.0.0.1:${daemon.localPort}/pair/links`, {
                    method: 'POST',
                    headers: { [KEY_HEADER]: localKey },
                })
            ).json()) as { key: string };

            const intoGuestRoom = await connect(invite.roomId);
            const refused = await intoGuestRoom.pair({
                roomId: invite.roomId,
                pairKey: link.key,
                deviceId: 'intruder',
            });
            expect(refused.computerKey).toBe('');

            const intoComputerRoom = await connect(daemon.registry.roomId);
            const refusedToo = await intoComputerRoom.pair({
                roomId: daemon.registry.roomId,
                pairKey: invite.key,
                deviceId: 'intruder-2',
            });
            expect(refusedToo.computerKey).toBe('');
            expect(daemon.paired.list()).toEqual([]);
        });

        test('survive a restart of the daemon', async () => {
            const invite = await daemon.guestRooms.invite('Mario');
            await daemon.stop();
            daemon = await start();
            await waitUntil(
                () => daemon.relay.isRoomOpen(invite.roomId),
                'the room after a restart',
            );
            const client = await connect(invite.roomId);
            const paired = await client.pair({
                roomId: invite.roomId,
                pairKey: invite.key,
                deviceId: 'mario-phone',
            });
            expect(paired.computerKey).not.toBe('');
            expect((await client.next()).type).toBe('paired');
        });

        test('a new one for a person who has a device needs "replace", and unpairs the old device', async () => {
            const mario = await joinAs('Mario');
            await hello(mario);
            await expect(daemon.guestRooms.invite('Mario')).rejects.toThrow(/replaces it/);
            const fresh = await daemon.guestRooms.invite('mario', { replace: true });
            expect(fresh.person.personId).toBe(mario.personId);
            expect(fresh.key).not.toBe(mario.key);
            expect(daemon.people.person(mario.personId)?.device).toBeNull();
            const unpaired = await drain(mario.client);
            expect(unpaired.some((m) => m.type === 'error' && m.message === DEVICE_UNPAIRED)).toBe(
                true,
            );
            await expect(
                (async () => {
                    const late = await connect(mario.roomId);
                    await late.handshake(mario.computer, mario.device.deviceId, mario.device);
                    return late.next();
                })(),
            ).resolves.toMatchObject({ type: 'error', code: 'unauthorized' });
        });

        test('a name is not given twice, whatever its case', async () => {
            await daemon.guestRooms.invite('Mario');
            await expect(daemon.guestRooms.invite('MARIO')).resolves.toBeDefined();
            expect(daemon.people.people().filter((person) => !person.removedAt)).toHaveLength(1);
        });
    });

    describe('removing a person', () => {
        test('unpairs their device, closes their copies and their room, and keeps what they reviewed', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario, copy.shareId);
            const guestRoom = await daemon.rooms.get(copy.shareId);
            const itemId = listItems(
                guestRoom?.state as never,
                copy.checklists[0]?.copy as string,
            )[0]?.id as string;
            await guestRoom?.submitLocal('item.update', copy.copySessionId, {
                itemId,
                status: 'cancelled',
                note: 'broken',
            });

            await daemon.guestRooms.removePerson('Mario');
            await waitUntil(() => !daemon.relay.isRoomOpen(mario.roomId), 'the room closing');
            const person = daemon.people.person(mario.personId);
            expect(person).toMatchObject({ name: 'Mario', device: null });
            expect(person?.removedAt).toBeGreaterThan(0);
            expect(person?.roomKey).toBeUndefined();
            expect(daemon.people.share(copy.shareId)?.closedAt).not.toBeNull();
            // The owner still reads what they said.
            const feedback = await daemon.sharing.sharedFeedback(
                project.projectId,
                project.sessionId,
            );
            expect(feedback?.people[0]).toMatchObject({
                person: 'Mario',
                state: 'closed',
                reviewed: 1,
            });

            // Their name is free again, for somebody else.
            const newMario = await daemon.guestRooms.invite('Mario');
            expect(newMario.person.personId).not.toBe(mario.personId);
        });

        test('leaves the phones of the computer connected', async () => {
            const owner = await connect(daemon.registry.roomId);
            await owner.hello({ computer: project.computer }, 'owner-phone');
            await share('Mario');
            const mario = await joinAs('Mario');
            await daemon.guestRooms.removePerson('Mario');
            await waitUntil(() => !daemon.relay.isRoomOpen(mario.roomId), 'the room closing');
            expect(daemon.relay.isRoomOpen(daemon.registry.roomId)).toBe(true);
            expect(daemon.devices.isConnected('owner-phone')).toBe(true);
        });

        test('unpairing a device of the computer does not touch a guest', async () => {
            await share('Mario');
            const mario = await joinAs('Mario');
            const owner = await connect(daemon.registry.roomId);
            await owner.hello({ computer: project.computer }, 'owner-phone');
            await daemon.devices.revoke('owner-phone');
            expect(
                daemon.guestRooms.hubOf(mario.personId)?.isConnected(mario.device.deviceId),
            ).toBe(true);
        });
    });

    describe('notifications', () => {
        const registration = (): PushRegistration => ({
            subscription: {
                endpoint: `https://fcm.googleapis.com/fcm/send/${createId()}`,
                keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
            },
            vapid: { publicKey: 'D'.repeat(87), privateKey: 'E'.repeat(43) },
        });

        test('each side hears of its own, and the people only of their copies', async () => {
            const copy = await share('Mario');
            const mario = await joinAs('Mario');
            await hello(mario);
            const owner = await connect(daemon.registry.roomId);
            await owner.hello({ computer: project.computer }, 'owner-phone');
            const guestPush = registration();
            const ownerPush = registration();
            mario.client.send({ type: 'push.subscribe', push: guestPush });
            owner.send({ type: 'push.subscribe', push: ownerPush });
            await waitUntil(
                () =>
                    daemon.push.list().length === 1 &&
                    JSON.stringify(daemon.paired.list()).length > 0,
                'the owner subscription',
            );
            mario.client.send({ type: 'presence', visible: false });
            owner.send({ type: 'presence', visible: false });
            await Bun.sleep(30);

            // The agent writes in the original: only the owner's phone hears.
            const original = await daemon.rooms.get(project.projectId);
            await original?.submitLocal('session.message', project.sessionId, { message: 'x' });
            await waitUntil(() => sent.length >= 1, 'a push for the owner');
            await Bun.sleep(100);
            expect(sent.map((entry) => entry.endpoint)).toEqual([ownerPush.subscription.endpoint]);
            expect(sent[0]?.payload.title).toBe(`${OFFICE} - demo-repo`);

            // The agent writes in the copy: only the person hears, under the owner's name.
            sent.length = 0;
            const guestRoom = await daemon.rooms.get(copy.shareId);
            await guestRoom?.submitLocal('session.message', copy.copySessionId, { message: 'y' });
            await waitUntil(() => sent.length >= 1, 'a push for the guest');
            await Bun.sleep(100);
            expect(sent.map((entry) => entry.endpoint)).toEqual([guestPush.subscription.endpoint]);
            expect(sent[0]?.payload).toMatchObject({
                title: DEFAULT_OWNER_NAME,
                projectId: copy.shareId,
            });
            expect(JSON.stringify(sent)).not.toContain(OFFICE);

            // Another person with the app open in the background hears nothing of Mario's copy.
            await share('Luca');
            const luca = await joinAs('Luca');
            await hello(luca);
            const lucaPush = registration();
            luca.client.send({ type: 'push.subscribe', push: lucaPush });
            luca.client.send({ type: 'presence', visible: false });
            await Bun.sleep(150);
            await Bun.sleep(100);
            sent.length = 0;
            await guestRoom?.submitLocal('session.message', copy.copySessionId, { message: 'z' });
            await waitUntil(() => sent.length >= 1, 'a push for Mario again');
            await Bun.sleep(100);
            expect(sent.map((entry) => entry.endpoint)).toEqual([guestPush.subscription.endpoint]);
            expect(await Bun.file(join(home, 'push-guests.json')).text()).toContain(
                guestPush.subscription.endpoint,
            );
            expect(await Bun.file(join(home, 'push.json')).text()).not.toContain(
                guestPush.subscription.endpoint,
            );
        });
    });
});

describe('the number of rooms and the time an invitation lasts', () => {
    let dir: string;
    const clock = { now: 1_000_000 };
    const added: string[] = [];
    const removed: string[] = [];

    async function setup() {
        const storage = new MemoryStorage();
        const rooms = new RoomManager(storage);
        const people = await PeopleStore.open(join(dir, 'people.json'), () => clock.now);
        const push = await PushStore.open(join(dir, 'push.json'));
        const guestRooms = new GuestRooms({
            people,
            rooms,
            relay: {
                addRoom: (identity) => added.push(identity.roomId),
                removeRoom: (roomId) => removed.push(roomId),
            },
            push,
            ownerName: () => undefined,
            closeShares: async () => 0,
            now: () => clock.now,
            log: () => {},
        });
        return { people, guestRooms };
    }

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-guests-'));
        clock.now = 1_000_000;
        added.length = 0;
        removed.length = 0;
    });

    afterEach(() => rm(dir, { recursive: true, force: true }));

    test('an invitation opens a room, and the room closes when the invitation expires unused', async () => {
        const { people, guestRooms } = await setup();
        const invite = await guestRooms.invite('Mario');
        expect(invite.expiresAt).toBe(clock.now + INVITE_TTL_MS);
        expect(added).toEqual([invite.roomId]);

        clock.now += INVITE_TTL_MS - 1;
        await guestRooms.reconcile();
        expect(removed).toEqual([]);

        clock.now += 2;
        await guestRooms.reconcile();
        expect(removed).toEqual([invite.roomId]);
        expect(people.person(invite.person.personId)?.invite).toBeNull();
        guestRooms.stop();
    });

    test('no more than the relay can hold are open at once, and a freed place is taken', async () => {
        const { guestRooms } = await setup();
        for (let i = 0; i < MAX_GUEST_ROOMS; i++) await guestRooms.invite(`Person ${i}`);
        expect(added).toHaveLength(MAX_GUEST_ROOMS);

        const refused = await guestRooms.invite('One too many').catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(ActionError);
        expect((refused as ActionError).status).toBe(409);
        expect((refused as ActionError).message).toContain(String(MAX_GUEST_ROOMS));
        // A person whose room is open is not refused anything.
        await expect(guestRooms.invite('Person 3')).resolves.toBeDefined();

        await guestRooms.removePerson('Person 0');
        await expect(guestRooms.invite('One too many')).resolves.toBeDefined();
        guestRooms.stop();
        // Fifty files written and synced one after the other: slow on a Windows runner.
    }, 30_000);

    test('a person who was never invited has no room to ask for', async () => {
        const { people, guestRooms } = await setup();
        await people.addPerson('Mario');
        await guestRooms.reconcile();
        expect(added).toEqual([]);
        guestRooms.stop();
    });
});

describe('people.json', () => {
    let dir: string;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'palmtop-people-file-'));
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    test('a write that fails leaves nothing changed, and the next one works', async () => {
        const path = join(dir, 'missing', 'people.json');
        const store = await PeopleStore.open(path);
        await expect(store.addPerson('Mario')).rejects.toThrow();
        // What the daemon believes is what the file would say: no person that is not saved.
        expect(store.findPerson('Mario')).toBeNull();

        await mkdir(join(dir, 'missing'));
        const mario = await store.addPerson('Mario');
        expect((await PeopleStore.open(path)).findPerson('Mario')?.personId).toBe(mario.personId);
    });

    test('a removal that cannot be saved is not believed either', async () => {
        const path = join(dir, 'people.json');
        const store = await PeopleStore.open(path);
        const mario = await store.addPerson('Mario');
        await store.prepareRoom(mario.personId);
        // The directory goes away: the file cannot be replaced.
        await rm(dir, { recursive: true, force: true });
        await expect(store.removePerson(mario.personId)).rejects.toThrow();
        expect(store.person(mario.personId)?.removedAt).toBeUndefined();
        expect(store.person(mario.personId)?.roomKey).toBeDefined();
    });

    test('a file that cannot be read is kept aside, not written over', async () => {
        const path = join(dir, 'people.json');
        await writeFile(path, '{"people": [ this is not json');
        const store = await PeopleStore.open(path);
        expect(store.people()).toEqual([]);
        await store.addPerson('Mario');
        const kept = (await readdir(dir)).filter((name) => name.startsWith('people.json.invalid-'));
        expect(kept).toHaveLength(1);
        expect(await readFile(join(dir, kept[0] as string), 'utf8')).toContain('this is not json');
    });

    test('a person removed while their room was not in memory loses their notifications too', async () => {
        const path = join(dir, 'people.json');
        const people = await PeopleStore.open(path);
        const push = await PushStore.open(join(dir, 'push.json'));
        const mario = await people.addPerson('Mario');
        await people.prepareRoom(mario.personId);
        await people.setDevice(mario.personId, {
            deviceId: 'mario-phone',
            name: 'Phone',
            publicKey: 'A'.repeat(43),
            pairedAt: 1,
            lastSeenAt: null,
        });
        await push.set('mario-phone', {
            subscription: {
                endpoint: 'https://fcm.googleapis.com/fcm/send/x',
                keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
            },
            vapid: { publicKey: 'D'.repeat(87), privateKey: 'E'.repeat(43) },
        });
        const guestRooms = new GuestRooms({
            people,
            rooms: new RoomManager(new MemoryStorage()),
            relay: { addRoom: () => {}, removeRoom: () => {} },
            push,
            ownerName: () => undefined,
            closeShares: async () => 0,
            log: () => {},
        });
        await guestRooms.removePerson('Mario');
        expect(push.list()).toEqual([]);
        guestRooms.stop();
    });
});

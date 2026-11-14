import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, type PushRegistration, type ServerMessage } from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import { type Daemon, DEFAULT_OWNER_NAME, KEY_HEADER } from '../src';
import { shortRef } from '../src/agent-actions';
import type { PushPayload } from '../src/push-notifier';
import {
    createTempHome,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
    waitUntil,
} from './helpers';

/** The people checklists are shared with, through the Local API as the CLI uses it. */
describe('people and invitations through the Local API', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    let key: string;
    const clients: TestClient[] = [];
    const sent: Array<{ endpoint: string; payload: PushPayload }> = [];

    const call = async (method: string, path: string, payload?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${daemon.localPort}${path}`, {
            method,
            headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
            ...(payload !== undefined && { body: JSON.stringify(payload) }),
        });
        // biome-ignore lint/suspicious/noExplicitAny: the JSON of the Local API, read freely by the tests
        const body = (await response.json()) as Record<string, any>;
        return { status: response.status, body };
    };

    beforeEach(async () => {
        sent.length = 0;
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await startTestDaemon(home, {
            relay,
            pushDelayMs: 30,
            pushSender: {
                async send(target, payload) {
                    sent.push({ endpoint: target.subscription.endpoint, payload });
                    return { gone: false };
                },
            },
        });
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        await daemon.setComputerName('Grace-Office');
        project = await seedProject(daemon, '/tmp/demo-repo');
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    /** Pairs a device with the link an invitation returned. */
    async function open(url: string, deviceId = 'mario-phone') {
        const params = new URLSearchParams(new URL(url).hash.split('?')[1]);
        const roomId = params.get('r') as string;
        const pairKey = params.get('k') as string;
        await waitUntil(() => daemon.relay.isRoomOpen(roomId), 'the room of the guest');
        const client = await TestClient.connect(relay, roomId);
        clients.push(client);
        const paired = await client.pair({ roomId, pairKey, deviceId, name: 'Safari on iPhone' });
        expect((await client.next()).type).toBe('paired');
        return { client, roomId, ...paired };
    }

    async function shareWith(name: string) {
        const room = await daemon.rooms.get(project.projectId);
        await daemon.sharing.share({
            room: room as NonNullable<typeof room>,
            sessionId: project.sessionId,
            checklistRef: shortRef(project.checklistId),
            personName: name,
        });
    }

    test('an invitation answers with the link of the person room, and lists nobody secret', async () => {
        const invited = await call('POST', '/people/invite', { name: 'Mario' });
        expect(invited.status).toBe(201);
        const url = new URL(invited.body.url);
        expect(url.hash).toMatch(/^#invite\?r=[A-Za-z0-9_-]{43}&k=[A-Za-z0-9_-]+$/);
        expect(invited.body).toMatchObject({ name: 'Mario', replaced: false });
        expect(invited.body.expiresAt).toBeGreaterThan(Date.now() + 23 * 3_600_000);

        const listed = await call('GET', '/people');
        expect(listed.body.people).toEqual([
            {
                name: 'Mario',
                device: null,
                invitedUntil: invited.body.expiresAt,
                copies: { open: 0, total: 0 },
            },
        ]);
        const text = JSON.stringify(listed.body);
        const params = new URLSearchParams(url.hash.split('?')[1]);
        for (const secret of [params.get('k') as string, params.get('r') as string]) {
            expect(text).not.toContain(secret);
        }
        expect(text).not.toContain('privateKey');
        expect(text).not.toContain('roomKey');
    });

    test('opening the link pairs the device, tells the owner, and the person is listed with it', async () => {
        const owner = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(owner);
        await owner.hello({ computer: project.computer }, 'owner-phone');
        const registration: PushRegistration = {
            subscription: {
                endpoint: `https://fcm.googleapis.com/fcm/send/${createId()}`,
                keys: { p256dh: 'B'.repeat(87), auth: 'C'.repeat(22) },
            },
            vapid: { publicKey: 'D'.repeat(87), privateKey: 'E'.repeat(43) },
        };
        owner.send({ type: 'push.subscribe', push: registration });
        await waitUntil(() => daemon.push.list().length === 1, 'the subscription of the owner');

        const invited = await call('POST', '/people/invite', { name: 'Mario' });
        await open(invited.body.url);

        await waitUntil(() => sent.length >= 1, 'the notice for the owner');
        expect(sent[0]).toMatchObject({
            endpoint: registration.subscription.endpoint,
            payload: { title: 'Palmtop', body: 'Mario joined · Safari on iPhone' },
        });
        const listed = await call('GET', '/people');
        expect(listed.body.people[0]).toMatchObject({
            name: 'Mario',
            invitedUntil: null,
            device: { name: 'Safari on iPhone', connected: true },
        });
    });

    test('inviting someone who has a device needs replace, then the old device is gone', async () => {
        const invited = await call('POST', '/people/invite', { name: 'Mario' });
        const first = await open(invited.body.url);

        const refused = await call('POST', '/people/invite', { name: 'mario' });
        expect(refused.status).toBe(409);
        expect(refused.body.error).toContain('replace');

        const replaced = await call('POST', '/people/invite', { name: 'mario', replace: true });
        expect(replaced.status).toBe(201);
        expect(replaced.body).toMatchObject({ name: 'Mario', replaced: true });
        const messages: ServerMessage[] = [];
        for (let i = 0; i < 5; i++) {
            try {
                messages.push(await first.client.next(150));
            } catch {
                break;
            }
        }
        expect(messages.some((m) => m.type === 'error')).toBe(true);
        expect((await call('GET', '/people')).body.people[0].device).toBeNull();
    });

    test('removing a person keeps the copies for the owner and frees the name', async () => {
        await call('POST', '/people/invite', { name: 'Mario' });
        await shareWith('Mario');
        const removed = await call('DELETE', '/people/Mario');
        expect(removed.status).toBe(200);
        expect(removed.body).toMatchObject({ name: 'Mario', device: null });
        expect((await call('GET', '/people')).body.people).toEqual([]);
        expect((await call('DELETE', '/people/Mario')).status).toBe(404);

        const feedback = await daemon.sharing.sharedFeedback(project.projectId, project.sessionId);
        expect(feedback?.people[0]).toMatchObject({ person: 'Mario', state: 'closed' });
        expect((await call('POST', '/people/invite', { name: 'Mario' })).status).toBe(201);
    });

    test('bad names and bodies are refused', async () => {
        for (const body of [{}, { name: '' }, { name: 'a\u0007b' }, { name: 'x'.repeat(41) }]) {
            expect((await call('POST', '/people/invite', body)).status).toBe(400);
        }
    });

    describe('the name of the owner', () => {
        async function guestWithCopy() {
            const invited = await call('POST', '/people/invite', { name: 'Mario' });
            await shareWith('Mario');
            const guest = await open(invited.body.url);
            guest.client.send({ type: 'hello' });
            await guest.client.next();
            const copy = daemon.people.shares()[0];
            guest.client.send({ type: 'subscribe', projectId: copy?.shareId });
            await guest.client.next();
            return { guest, shareId: copy?.shareId as string };
        }

        const nextProject = async (client: TestClient) => {
            for (let i = 0; i < 10; i++) {
                const message = await client.next(1_000);
                if (message.type === 'project') return message.project;
            }
            throw new Error('no project message');
        };

        test('is Shared checklists until the owner picks one, and the config keeps the other keys', async () => {
            const { shareId } = await guestWithCopy();
            const copy = await daemon.rooms.get(shareId);
            expect(copy?.project.computer).toBe(DEFAULT_OWNER_NAME);
            expect((await call('GET', '/config/owner-name')).body).toEqual({ name: null });

            const saved = await call('PUT', '/config/owner-name', { name: 'Grace (studio)' });
            expect(saved.body).toEqual({ name: 'Grace (studio)' });
            const config = JSON.parse(await readFile(join(home, 'config.json'), 'utf8'));
            expect(config).toMatchObject({
                computerName: 'Grace-Office',
                ownerName: 'Grace (studio)',
            });
            expect(copy?.project.computer).toBe('Grace (studio)');
            expect((await call('PUT', '/config/owner-name', { name: 'x'.repeat(41) })).status).toBe(
                400,
            );
        });

        test('reaches the person at once, and a name for a session or a person wins over it', async () => {
            const { guest, shareId } = await guestWithCopy();
            const base = `/projects/${project.projectId}/sessions/${shortRef(project.sessionId)}`;
            const copy = await daemon.rooms.get(shareId);

            await call('PUT', '/config/owner-name', { name: 'Agency' });
            expect((await nextProject(guest.client)).computer).toBe('Agency');

            const forSession = await call('PUT', `${base}/owner-name`, { name: 'Grace' });
            expect(forSession.body).toEqual({ name: 'Grace', for: null, copies: 1 });
            expect(copy?.project.computer).toBe('Grace');
            expect((await nextProject(guest.client)).computer).toBe('Grace');

            const forPerson = await call('PUT', `${base}/owner-name`, {
                name: 'Grace, your contact',
                for: 'mario',
            });
            expect(forPerson.body.copies).toBe(1);
            expect(copy?.project.computer).toBe('Grace, your contact');

            // Taking the personal name back falls to the one of the session, then to the config.
            await call('PUT', `${base}/owner-name`, { name: null, for: 'Mario' });
            expect(copy?.project.computer).toBe('Grace');
            await call('PUT', `${base}/owner-name`, { name: null });
            expect(copy?.project.computer).toBe('Agency');

            expect(JSON.stringify(copy?.syncMessage())).not.toContain('Grace-Office');
        });

        test('for a person who was not given the session is refused', async () => {
            await guestWithCopy();
            await call('POST', '/people/invite', { name: 'Luca' });
            const base = `/projects/${project.projectId}/sessions/${shortRef(project.sessionId)}`;
            const refused = await call('PUT', `${base}/owner-name`, { name: 'X', for: 'Luca' });
            expect(refused.status).toBe(404);
            const unknown = await call('PUT', `${base}/owner-name`, { name: 'X', for: 'Nobody' });
            expect(unknown.status).toBe(404);
        });
    });
});

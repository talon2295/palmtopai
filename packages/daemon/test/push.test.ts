import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    createId,
    isPushServiceUrl,
    type PushRegistration,
    parseClientMessage,
} from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import webpush from 'web-push';
import type { Daemon } from '../src';
import { describe as describeBatch, type PushPayload } from '../src/push-notifier';
import { PushStore } from '../src/push-store';
import {
    createTempHome,
    deviceOp,
    expectMode,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
    testComputer,
    waitUntil,
} from './helpers';

const key = (length: number, char = 'A') => char.repeat(length);

function registration(
    endpoint = `https://fcm.googleapis.com/fcm/send/${createId()}`,
): PushRegistration {
    return {
        subscription: { endpoint, keys: { p256dh: key(87, 'B'), auth: key(22, 'C') } },
        vapid: { publicKey: key(87, 'D'), privateKey: key(43, 'E') },
    };
}

/** A list created in a notification batch, as `describe` reads it. */
type ListInBatch = { title: string; kind: 'checks' | 'choice' };

describe('push messages', () => {
    test('only the browsers push services are accepted as endpoints', () => {
        for (const url of [
            'https://fcm.googleapis.com/fcm/send/x',
            'https://updates.push.services.mozilla.com/wpush/v2/x',
            'https://web.push.apple.com/QG9x',
            'https://wns2-par02p.notify.windows.com/w/?token=x',
        ]) {
            expect(isPushServiceUrl(url)).toBe(true);
        }
        for (const url of [
            'http://fcm.googleapis.com/fcm/send/x',
            'https://fcm.googleapis.com:8443/x',
            'https://evil.example/fcm.googleapis.com',
            'https://push.apple.com.evil.example/x',
            'https://user:pass@web.push.apple.com/x',
            'https://127.0.0.1/x',
            'not a url',
        ]) {
            expect(isPushServiceUrl(url)).toBe(false);
        }
    });

    test('subscribe messages need well-formed keys', () => {
        expect(parseClientMessage({ type: 'push.subscribe', push: registration() }).ok).toBe(true);
        const bad = registration();
        bad.vapid.privateKey = key(42);
        expect(parseClientMessage({ type: 'push.subscribe', push: bad }).ok).toBe(false);
        expect(parseClientMessage({ type: 'presence', visible: false }).ok).toBe(true);
    });

    test('notification text has titles and counts only', () => {
        const checks = (title: string): ListInBatch => ({ title, kind: 'checks' });
        expect(
            describeBatch({
                checklists: new Map([['c', checks('Plan')]]),
                items: 0,
                message: false,
            }),
        ).toBe('New checklist: Plan');
        expect(
            describeBatch({
                checklists: new Map([
                    ['a', checks('A')],
                    ['b', checks('B')],
                ]),
                items: 1,
                message: true,
            }),
        ).toBe('New message from the agent · 2 new checklists · 1 new item to review');
        expect(describeBatch({ checklists: new Map(), items: 3, message: false })).toBe(
            '3 new items to review',
        );
    });

    test('a question to answer is announced as a decision, with its own count', () => {
        const choice = (title: string): ListInBatch => ({ title, kind: 'choice' });
        expect(
            describeBatch({
                checklists: new Map([['c', choice('Which cache?')]]),
                items: 0,
                message: false,
            }),
        ).toBe('A decision to make: Which cache?');
        expect(
            describeBatch({
                checklists: new Map([
                    ['a', { title: 'Checks', kind: 'checks' } as ListInBatch],
                    ['b', choice('Which cache?')],
                    ['c', choice('Which name?')],
                ]),
                items: 0,
                message: false,
            }),
        ).toBe('New checklist: Checks · 2 decisions to make');
    });
});

describe('web-push with keys made like the app makes them', () => {
    const b64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64url');

    test('the payload is encrypted and signed with the VAPID key of the phone', async () => {
        const subtle = crypto.subtle;
        // Phone VAPID pair, as in apps/web/src/lib/push.ts.
        // `verify` only so the test can check the signature; the app asks for `sign`.
        const vapidPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
            'sign',
            'verify',
        ]);
        const vapid = {
            publicKey: b64(await subtle.exportKey('raw', vapidPair.publicKey)),
            privateKey: (await subtle.exportKey('jwk', vapidPair.privateKey)).d as string,
        };
        // Browser subscription keys.
        const browser = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
            'deriveBits',
        ]);
        const push: PushRegistration = {
            subscription: {
                endpoint: 'https://fcm.googleapis.com/fcm/send/test',
                keys: {
                    p256dh: b64(await subtle.exportKey('raw', browser.publicKey)),
                    auth: b64(crypto.getRandomValues(new Uint8Array(16)).buffer),
                },
            },
            vapid,
        };
        expect(parseClientMessage({ type: 'push.subscribe', push }).ok).toBe(true);

        const details = webpush.generateRequestDetails(push.subscription, '{"title":"x"}', {
            vapidDetails: { subject: 'https://palmtop.mtwa.it', ...vapid },
        });
        expect(details.headers['Content-Encoding']).toBe('aes128gcm');
        const authorization = String(details.headers.Authorization);
        expect(authorization).toStartWith('vapid t=');
        expect(authorization).toEndWith(`, k=${vapid.publicKey}`);

        // The JWT verifies with the phone's public key.
        const jwt = authorization.slice('vapid t='.length, authorization.indexOf(','));
        const [header, claims, signature] = jwt.split('.') as [string, string, string];
        const valid = await subtle.verify(
            { name: 'ECDSA', hash: 'SHA-256' },
            vapidPair.publicKey,
            Buffer.from(signature, 'base64url'),
            new TextEncoder().encode(`${header}.${claims}`),
        );
        expect(valid).toBe(true);
        expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
            aud: 'https://fcm.googleapis.com',
            sub: 'https://palmtop.mtwa.it',
        });
    });
});

describe('PushStore', () => {
    let home: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
    });

    afterEach(async () => {
        await cleanup();
    });

    test('keeps one subscription per browser, persists privately and drops invalid entries', async () => {
        const path = join(home, 'push.json');
        const store = await PushStore.open(path);
        const shared = registration();
        await store.set('phone-a', shared);
        // Same browser after its device id changed (storage cleared): the old entry goes.
        await store.set('phone-b', shared);
        await store.set('tablet', registration());
        expect(store.list().map((target) => target.deviceId)).toEqual(['phone-b', 'tablet']);
        await expectMode(path, 0o600);

        const reopened = await PushStore.open(path);
        expect(reopened.list()).toEqual(store.list());

        await reopened.removeEndpoint(shared.subscription.endpoint);
        expect(reopened.list().map((target) => target.deviceId)).toEqual(['tablet']);
        await reopened.remove('tablet');
        expect(reopened.list()).toEqual([]);

        await writeFile(
            path,
            JSON.stringify({
                devices: { phone: { subscription: 'nope' }, tablet: registration() },
            }),
        );
        expect((await PushStore.open(path)).list().map((t) => t.deviceId)).toEqual(['tablet']);
        // A file from the versions with one subscription per project holds nothing usable.
        await writeFile(path, JSON.stringify({ projects: { p: { phone: registration() } } }));
        expect((await PushStore.open(path)).list()).toEqual([]);
        await writeFile(path, '{broken');
        expect((await PushStore.open(path)).list()).toEqual([]);
    });
});

describe('push notifications through the daemon', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    let sent: Array<{ endpoint: string; payload: PushPayload }>;
    let gone: Set<string>;
    const clients: TestClient[] = [];

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        sent = [];
        gone = new Set();
        daemon = await startTestDaemon(home, {
            relay,
            pushDelayMs: 50,
            pushSender: {
                async send(target, payload) {
                    sent.push({ endpoint: target.subscription.endpoint, payload });
                    return { gone: gone.has(target.subscription.endpoint) };
                },
            },
        });
        project = await seedProject(daemon);
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    async function phone(deviceId: string) {
        const client = await TestClient.connect(relay, project.roomId);
        clients.push(client);
        await client.hello(project, deviceId);
        return client;
    }

    async function subscribe(deviceId: string) {
        const client = await phone(deviceId);
        const push = registration();
        client.send({ type: 'push.subscribe', push });
        await waitUntil(
            () => daemon.push.list().some((t) => t.deviceId === deviceId),
            'subscription stored',
        );
        return { client, push };
    }

    test('the agent writing a checklist notifies subscribed devices that are not on screen', async () => {
        // The four changes below must fall in one batch. Each one is written and synced before the
        // next, which on a slow disk can take longer than the 50 ms the other tests use.
        await daemon.stop();
        daemon = await startTestDaemon(home, {
            relay,
            pushDelayMs: 1_000,
            pushSender: {
                async send(target, payload) {
                    sent.push({ endpoint: target.subscription.endpoint, payload });
                    return { gone: false };
                },
            },
        });
        project = { ...project, computer: testComputer(daemon) };
        const { client: onScreen } = await subscribe('phone');
        const { client: background, push } = await subscribe('tablet');
        background.send({ type: 'presence', visible: false });
        await Bun.sleep(20);
        // Other devices never receive the subscription.
        await onScreen.expectSilence();

        const room = await daemon.rooms.get(project.projectId);
        const checklistId = createId();
        await room?.submitLocal('checklist.create', project.sessionId, {
            checklistId,
            title: 'Deploy plan',
        });
        for (const text of ['one', 'two']) {
            await room?.submitLocal('item.add', project.sessionId, {
                itemId: createId(),
                checklistId,
                text,
                order: 0,
            });
        }
        await room?.submitLocal('item.add', project.sessionId, {
            itemId: createId(),
            checklistId: project.checklistId,
            text: 'Step 4',
            order: 4,
        });
        await waitUntil(() => sent.length > 0, 'push sent');
        await Bun.sleep(100);
        expect(sent).toEqual([
            {
                endpoint: push.subscription.endpoint,
                payload: {
                    title: `${daemon.computerName} - demo-repo`,
                    body: 'New checklist: Deploy plan · 1 new item to review',
                    projectId: project.projectId,
                    sessionId: project.sessionId,
                    tag: `palmtop-${project.projectId}-${project.sessionId}`,
                },
            },
        ]);
        expect(JSON.stringify(sent)).not.toContain('Step 4');

        await room?.submitLocal('session.message', project.sessionId, { message: 'Secret text' });
        await waitUntil(() => sent.length === 2, 'message push');
        expect(sent[1]?.payload.body).toBe('New message from the agent');
        expect(JSON.stringify(sent)).not.toContain('Secret text');
    });

    test('a device on screen but silent (phone locked with the app open) is notified', async () => {
        await daemon.stop();
        daemon = await startTestDaemon(home, {
            relay,
            pushDelayMs: 50,
            presenceTimeoutMs: 200,
            pushSender: {
                async send(target, payload) {
                    sent.push({ endpoint: target.subscription.endpoint, payload });
                    return { gone: false };
                },
            },
        });
        project = { ...project, computer: testComputer(daemon) };
        const { client, push } = await subscribe('phone');
        const room = await daemon.rooms.get(project.projectId);
        const addItem = (text: string) =>
            room?.submitLocal('item.add', project.sessionId, {
                itemId: createId(),
                checklistId: project.checklistId,
                text,
                order: 9,
            });

        // Heard from just now: on screen, nothing sent.
        await addItem('while looking');
        await Bun.sleep(150);
        expect(sent).toEqual([]);

        // No message for longer than the timeout (no presence got out before the lock).
        await Bun.sleep(250);
        await addItem('while locked');
        await waitUntil(() => sent.length === 1, 'push to the silent device');
        expect(sent[0]?.endpoint).toBe(push.subscription.endpoint);

        // Any message (a ping) makes it count as on screen again.
        client.send({ type: 'ping' });
        await Bun.sleep(20);
        await addItem('looking again');
        await Bun.sleep(150);
        expect(sent).toHaveLength(1);
    });

    test('device ops, cleared messages and unsubscribed devices do not notify; gone subscriptions are removed', async () => {
        const { client, push } = await subscribe('phone');
        client.send({ type: 'presence', visible: false });
        await Bun.sleep(20);
        client.sendOp(
            deviceOp(project, 'phone', 10, 'item.add', {
                itemId: createId(),
                checklistId: project.checklistId,
                text: 'from the phone',
                order: 9,
            }),
        );
        const room = await daemon.rooms.get(project.projectId);
        await room?.submitLocal('session.message', project.sessionId, { message: '' });
        await Bun.sleep(150);
        expect(sent).toEqual([]);

        gone.add(push.subscription.endpoint);
        await room?.submitLocal('session.message', project.sessionId, { message: 'hi' });
        await waitUntil(() => daemon.push.list().length === 0, 'gone removed');
        expect(sent).toHaveLength(1);

        const { client: again } = await subscribe('phone');
        again.send({ type: 'push.unsubscribe' });
        await waitUntil(() => daemon.push.list().length === 0, 'unsubscribed');
    });

    test('one subscription per device covers every project of the computer', async () => {
        const { push } = await subscribe('phone');
        // The device follows the first project; the agent works in a second one.
        const other = await seedProject(daemon, '/tmp/second-repo');

        await waitUntil(() => sent.length > 0, 'push of the other project');
        expect(sent[0]).toMatchObject({
            endpoint: push.subscription.endpoint,
            payload: {
                title: `${daemon.computerName} - second-repo`,
                body: 'New checklist: Refactor auth',
                projectId: other.projectId,
            },
        });
        // Removing a project keeps the device subscribed: the pairing is with the computer.
        await daemon.removeProject(other.projectId);
        expect(daemon.push.list().map((target) => target.deviceId)).toEqual(['phone']);
    });

    test('a device that has not picked a project yet can still subscribe', async () => {
        const client = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(client);
        await client.hello({ computer: project.computer }, 'fresh-phone');
        client.send({ type: 'push.subscribe', push: registration() });
        await waitUntil(
            () => daemon.push.list().some((target) => target.deviceId === 'fresh-phone'),
            'subscription stored',
        );
    });
});

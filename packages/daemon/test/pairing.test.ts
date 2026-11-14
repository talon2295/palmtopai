import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    CloseCode,
    DEVICE_UNPAIRED,
    type PushRegistration,
    parseWaitMessage,
    type WaitMessage,
} from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import {
    appWebUrl,
    type Daemon,
    type DeviceListEntry,
    KEY_HEADER,
    type PairingConfirmation,
    type PairLink,
    pairUrl,
    relayWebUrl,
} from '../src';
import { PairingCodes, PairingConfirmations, PairKeys } from '../src/pairing';
import {
    createTempHome,
    startTestDaemon,
    startTestRelay,
    TestClient,
    testComputer,
    waitForRelay,
    waitUntil,
} from './helpers';

const PUSH: PushRegistration = {
    subscription: {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
    },
    vapid: { publicKey: 'B'.repeat(87), privateKey: 'k'.repeat(43) },
};

describe('PairingCodes', () => {
    test('a code works once', () => {
        const codes = new PairingCodes();
        const { code } = codes.create();
        expect(code.length).toBeGreaterThanOrEqual(32);
        expect(codes.consume(code)).toBe(true);
        expect(codes.consume(code)).toBe(false);
        expect(codes.consume('made-up')).toBe(false);
    });

    test('a code expires after the TTL', () => {
        let now = 1_000;
        const codes = new PairingCodes({ ttlMs: 60_000, now: () => now });
        const fresh = codes.create();
        const stale = codes.create();
        now += 59_999;
        expect(codes.consume(fresh.code)).toBe(true);
        now += 1;
        expect(codes.consume(stale.code)).toBe(false);
    });
});

describe('PairKeys', () => {
    test('a key works once and is long enough not to be guessed', () => {
        const keys = new PairKeys();
        const { key } = keys.create();
        expect(key.length).toBeGreaterThanOrEqual(22);
        expect(keys.valid()).toEqual([key]);
        expect(keys.take(key)).toMatchObject({ confirm: false });
        expect(keys.take(key)).toBeNull();
        expect(keys.valid()).toEqual([]);
        expect(keys.take('made-up-key-aaaaaaaaaa')).toBeNull();
    });

    test('a key sent for a pairing code asks for the number to be confirmed', () => {
        const keys = new PairKeys();
        const qr = keys.create();
        const code = keys.create({ confirm: true });
        expect(keys.take(code.key)).toMatchObject({ confirm: true });
        expect(keys.take(qr.key)).toMatchObject({ confirm: false });
    });

    test('a key expires after the TTL, and a revoked one stops working at once', () => {
        let now = 1_000;
        const keys = new PairKeys({ ttlMs: 300_000, now: () => now });
        const fresh = keys.create();
        const stale = keys.create();
        const closed = keys.create();
        keys.revoke(closed.key);
        expect(keys.take(closed.key)).toBeNull();
        now += 299_999;
        expect(keys.take(fresh.key)).not.toBeNull();
        now += 1;
        expect(keys.valid()).toEqual([]);
        expect(keys.take(stale.key)).toBeNull();
    });
});

describe('PairingConfirmations', () => {
    test('waiting, then ready with the number, then the answer of the terminal', async () => {
        const confirmations = new PairingConfirmations();
        const { id } = confirmations.create('the-key');
        expect(confirmations.get(id)).toEqual({ id, state: 'waiting' });
        // Nothing to decide before the device shows a number.
        expect(confirmations.decide(id, true)).toBe(false);

        const answer = confirmations.ready('the-key', { number: '482913', deviceName: 'iPhone' });
        expect(confirmations.get(id)).toEqual({
            id,
            state: 'ready',
            number: '482913',
            deviceName: 'iPhone',
        });
        expect(confirmations.ready('the-key', { number: '1', deviceName: 'x' })).toBeNull();
        expect(confirmations.decide(id, true)).toBe(true);
        expect(await answer).toBe(true);
        expect(confirmations.get(id)?.state).toBe('accepted');
        expect(confirmations.ready('another-key', { number: '1', deviceName: 'x' })).toBeNull();
    });

    test('a no, a device that goes away and the end of the TTL all pair nothing', async () => {
        let now = 1_000;
        const confirmations = new PairingConfirmations({ ttlMs: 50, now: () => now });
        const refused = confirmations.create('a');
        const left = confirmations.create('b');
        const late = confirmations.create('c');

        const no = confirmations.ready('a', { number: '1', deviceName: 'x' });
        confirmations.decide(refused.id, false);
        expect(await no).toBe(false);
        expect(confirmations.get(refused.id)?.state).toBe('refused');

        const gone = confirmations.ready('b', { number: '1', deviceName: 'x' });
        confirmations.abandon('b');
        expect(await gone).toBe(false);
        expect(confirmations.get(left.id)?.state).toBe('refused');

        now += 50;
        expect(confirmations.get(late.id)?.state).toBe('expired');
    });
});

describe('pairing links', () => {
    test('room and key are in the fragment, never in the path or query', () => {
        const url = new URL(
            pairUrl(appWebUrl('wss://relay.example/'), { roomId: 'room-id', key: 'pair-key' }),
        );
        expect(url.origin).toBe('https://app.relay.example');
        expect(url.pathname).toBe('/');
        expect(url.search).toBe('');
        expect(url.hash).toBe('#pair?r=room-id&k=pair-key');
        expect(relayWebUrl('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
        expect(appWebUrl('ws://localhost:8787')).toBe('http://app.localhost:8787');
        expect(appWebUrl('ws://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
        expect(appWebUrl('ws://[::1]:8787')).toBe('http://[::1]:8787');
    });
});

describe('pairing page on the Local API', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let key: string;
    let projectId: string;
    /** The one secret of the computer: no response, page or link may ever contain it. */
    let privateKey: string;

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await startTestDaemon(home, { relay });
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        ({ projectId } = await daemon.registry.resolve({ rootPath: '/tmp/pair-repo' }));
        await waitForRelay(daemon);
        privateKey = (
            JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
                computer: { roomKey: { privateKey: string } };
            }
        ).computer.roomKey.privateKey;
    });

    afterEach(async () => {
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    const local = (path: string, init: RequestInit = {}) =>
        fetch(`http://127.0.0.1:${daemon.localPort}${path}`, init);

    const createCode = (withKey = true) =>
        local('/pair/codes', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(withKey && { [KEY_HEADER]: key }) },
            body: '{}',
        });

    test('creating a code needs the local key; the response has nothing secret', async () => {
        expect((await createCode(false)).status).toBe(401);

        const response = await createCode();
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).not.toContain(privateKey);
        const { url } = JSON.parse(text) as { url: string };
        expect(url).toStartWith(`http://127.0.0.1:${daemon.localPort}/pair?code=`);
    });

    test('the page shows pairing links with a single-use key, nothing secret', async () => {
        const { url } = (await (await createCode()).json()) as { url: string };

        const page = await fetch(url);
        const html = await page.text();
        expect(page.status).toBe(200);
        expect(page.headers.get('cache-control')).toBe('no-store');
        expect(page.headers.get('referrer-policy')).toBe('no-referrer');
        expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(html).toContain(daemon.computerName);
        expect(html).toContain('Every project of this computer');
        expect(html).toContain('<svg');
        expect(html).not.toContain(privateKey);

        const roomId = daemon.registry.roomId;
        const links = [...html.matchAll(/#pair\?r=([^&"]+)&amp;k=([\w-]+)/g)];
        // One key for the QR code and one for "Open on this computer": each works once.
        expect(links.length).toBe(2);
        expect(links.map((match) => match[1])).toEqual([roomId, roomId]);
        const [scanKey, openKey] = links.map((match) => match[2] as string);
        expect(scanKey).not.toBe(openKey);
        expect(html).toMatch(
            /<a class="button" href="http:[^"]+#pair\?[^"]+" target="_blank" rel="noopener noreferrer">Open on this computer<\/a>/,
        );
        expect(html).not.toContain('not connected to the relay');

        const again = await fetch(url);
        expect(again.status).toBe(410);
        expect(await again.text()).not.toContain(privateKey);
    });

    const createLink = (withKey = true) =>
        local('/pair/links', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(withKey && { [KEY_HEADER]: key }) },
            body: '{}',
        });

    const revokeLink = (pairKey: string) =>
        local('/pair/links', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
            body: JSON.stringify({ key: pairKey }),
        });

    test('a pairing link needs the local key and carries nothing secret', async () => {
        expect((await createLink(false)).status).toBe(401);

        const response = await createLink();
        const text = await response.text();
        expect(response.status).toBe(200);
        expect(text).not.toContain(privateKey);
        const link = JSON.parse(text) as PairLink;
        const url = new URL(link.url);
        expect(url.search).toBe('');
        expect(url.hash).toBe(`#pair?r=${daemon.registry.roomId}&k=${link.key}`);
        expect(link.expiresAt).toBeGreaterThan(Date.now());
        expect(link.computerName).toBe(daemon.computerName);
    });

    test('a device pairs with the key of a link, then syncs like any paired device', async () => {
        const link = (await (await createLink()).json()) as PairLink;
        const roomId = daemon.registry.roomId;

        const device = await TestClient.connect(relay, roomId);
        const paired = await device.pair({ roomId, pairKey: link.key, deviceId: 'web-phone1' });
        expect(paired.computerKey).toBe(daemon.registry.roomPublicKey);
        expect(await device.next()).toEqual({
            type: 'paired',
            computer: { id: daemon.registry.computerId, name: daemon.computerName },
        });
        expect(daemon.paired.get('web-phone1')).toMatchObject({
            name: 'Test web-phone1',
            publicKey: paired.device.publicKey,
        });
        // The same connection goes on with hello, sealed.
        const computer = testComputer(daemon);
        expect((await device.hello({ projectId, computer }, 'web-phone1')).type).toBe('snapshot');
        device.close();

        // Later connections prove the key registered at pairing.
        const again = await TestClient.connect(relay, roomId);
        await again.handshake(computer, 'web-phone1', paired.device);
        expect((await again.hello({ projectId, computer }, 'web-phone1')).type).toBe('snapshot');
        again.close();

        // A key works once: the second attempt is rejected and the connection is closed.
        const replay = await TestClient.connect(relay, roomId);
        await replay.pair({ roomId, pairKey: link.key, deviceId: 'web-phone2' });
        expect(await replay.next()).toMatchObject({
            type: 'error',
            code: 'unauthorized',
            message: 'invalid or expired pairing key',
        });
        expect((await replay.closed).code).toBe(CloseCode.unauthorized);
        expect(daemon.paired.get('web-phone2')).toBeNull();
    });

    test('made-up and revoked keys are refused, and pair nothing', async () => {
        const roomId = daemon.registry.roomId;
        const guess = await TestClient.connect(relay, roomId);
        await guess.pair({ roomId, pairKey: 'aaaaaaaaaaaaaaaaaaaaaa', deviceId: 'web-guess' });
        expect(await guess.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
        expect((await guess.closed).code).toBe(CloseCode.unauthorized);

        const link = (await (await createLink()).json()) as PairLink;
        expect((await revokeLink(link.key)).status).toBe(200);
        const revoked = await TestClient.connect(relay, roomId);
        await revoked.pair({ roomId, pairKey: link.key, deviceId: 'web-revoked' });
        expect(await revoked.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
        expect((await revoked.closed).code).toBe(CloseCode.unauthorized);
        expect(daemon.paired.list()).toEqual([]);
    });

    test('a device whose id is reserved for the daemon cannot pair', async () => {
        const link = (await (await createLink()).json()) as PairLink;
        const roomId = daemon.registry.roomId;
        const device = await TestClient.connect(relay, roomId);
        await device.pair({ roomId, pairKey: link.key, deviceId: 'palmtop-daemon' });
        expect(await device.next()).toMatchObject({ type: 'error', code: 'forbidden' });
        expect((await device.closed).code).toBe(CloseCode.forbidden);
        expect(daemon.paired.list()).toEqual([]);
    });

    const devicesApi = (path = '', init: RequestInit = {}) =>
        local(`/devices${path}`, { ...init, headers: { [KEY_HEADER]: key } });

    test('devices are listed, and one removed on the computer is cut off at once', async () => {
        const roomId = daemon.registry.roomId;
        const link = (await (await createLink()).json()) as PairLink;
        const phone = await TestClient.connect(relay, roomId);
        const paired = await phone.pair({ roomId, pairKey: link.key, deviceId: 'web-phone1' });
        await phone.next();
        const computer = testComputer(daemon);
        await phone.hello({ projectId, computer }, 'web-phone1');

        expect((await local('/devices')).status).toBe(401);
        const { devices } = (await (await devicesApi()).json()) as { devices: DeviceListEntry[] };
        expect(devices).toEqual([
            {
                deviceId: 'web-phone1',
                name: 'Test web-phone1',
                pairedAt: expect.any(Number),
                lastSeenAt: expect.any(Number),
                connected: true,
            },
        ]);
        expect(JSON.stringify(devices)).not.toContain(paired.device.publicKey);

        expect((await devicesApi('/web-phone1', { method: 'DELETE' })).status).toBe(200);
        expect(await phone.next()).toMatchObject({ type: 'error', message: DEVICE_UNPAIRED });
        expect((await phone.closed).code).toBe(CloseCode.unauthorized);
        expect((await devicesApi('/web-phone1', { method: 'DELETE' })).status).toBe(404);

        // Its key is gone: the next connection is refused.
        const back = await TestClient.connect(relay, roomId);
        await back.handshake(computer, 'web-phone1', paired.device);
        expect(await back.next()).toMatchObject({ type: 'error', message: 'not paired' });
    });

    test('a device unpairs itself: key and notifications go', async () => {
        const roomId = daemon.registry.roomId;
        const link = (await (await createLink()).json()) as PairLink;
        const phone = await TestClient.connect(relay, roomId);
        await phone.pair({ roomId, pairKey: link.key, deviceId: 'web-phone1' });
        await phone.next();
        await phone.hello({ projectId, computer: testComputer(daemon) }, 'web-phone1');
        phone.send({ type: 'push.subscribe', push: PUSH });
        await waitUntil(() => daemon.push.list().length === 1, 'the push subscription');

        phone.send({ type: 'device.unpair' });
        expect((await phone.closed).code).toBe(CloseCode.unauthorized);
        expect(daemon.paired.list()).toEqual([]);
        expect(daemon.push.list()).toEqual([]);
    });

    test('pairing again with the same id cuts off the old key and its notifications', async () => {
        const roomId = daemon.registry.roomId;
        const computer = testComputer(daemon);
        const firstLink = (await (await createLink()).json()) as PairLink;
        const before = await TestClient.connect(relay, roomId);
        const old = await before.pair({ roomId, pairKey: firstLink.key, deviceId: 'web-phone1' });
        await before.next();
        await before.hello({ projectId, computer }, 'web-phone1');
        before.send({ type: 'push.subscribe', push: PUSH });
        await waitUntil(() => daemon.push.list().length === 1, 'the push subscription');

        const secondLink = (await (await createLink()).json()) as PairLink;
        const after = await TestClient.connect(relay, roomId);
        const fresh = await after.pair({ roomId, pairKey: secondLink.key, deviceId: 'web-phone1' });
        expect(await after.next()).toMatchObject({ type: 'paired' });
        expect(daemon.paired.get('web-phone1')?.publicKey).toBe(fresh.device.publicKey);
        expect(await before.next()).toMatchObject({ type: 'error', message: DEVICE_UNPAIRED });
        expect((await before.closed).code).toBe(CloseCode.unauthorized);
        expect(daemon.push.list()).toEqual([]);

        // The old key opens nothing any more.
        const back = await TestClient.connect(relay, roomId);
        await back.handshake(computer, 'web-phone1', old.device);
        expect(await back.next()).toMatchObject({ type: 'error', code: 'unauthorized' });
        after.close();
    });

    test('the same browser pairing again keeps its other tabs and its notifications', async () => {
        const roomId = daemon.registry.roomId;
        const computer = testComputer(daemon);
        const firstLink = (await (await createLink()).json()) as PairLink;
        const tab = await TestClient.connect(relay, roomId);
        const first = await tab.pair({ roomId, pairKey: firstLink.key, deviceId: 'web-phone1' });
        await tab.next();
        await tab.hello({ projectId, computer }, 'web-phone1');
        tab.send({ type: 'push.subscribe', push: PUSH });
        await waitUntil(() => daemon.push.list().length === 1, 'the push subscription');

        // A new link opened in the same browser: same id, same key.
        const secondLink = (await (await createLink()).json()) as PairLink;
        const other = await TestClient.connect(relay, roomId);
        await other.pair({
            roomId,
            pairKey: secondLink.key,
            deviceId: 'web-phone1',
            keys: first.device.keys,
        });
        expect(await other.next()).toMatchObject({ type: 'paired' });
        expect(daemon.paired.get('web-phone1')?.publicKey).toBe(first.device.publicKey);

        tab.send({ type: 'ping' });
        expect(await tab.next()).toEqual({ type: 'pong' });
        expect(daemon.push.list()).toHaveLength(1);
        other.close();
    });

    /** A phone without a pairing on the relay's `/wait`, collecting what the relay sends. */
    async function waitingPhone() {
        const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/wait`);
        const messages: WaitMessage[] = [];
        ws.addEventListener('message', (event) => {
            const message = parseWaitMessage(String(event.data));
            if (message) messages.push(message);
        });
        const next = async <T extends WaitMessage['type']>(type: T) => {
            const deadline = Date.now() + 2_000;
            while (messages[0]?.type !== type) {
                if (Date.now() > deadline) throw new Error(`timed out waiting for ${type}`);
                await Bun.sleep(10);
            }
            return messages.shift() as Extract<WaitMessage, { type: T }>;
        };
        const { code } = await next('pair.code');
        return { ws, code, next };
    }

    const offer = (code: string, withKey = true) =>
        local('/pair/offer', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(withKey && { [KEY_HEADER]: key }) },
            body: JSON.stringify({ code }),
        });

    const confirmation = async (id: string) =>
        (await (
            await local(`/pair/offers/${id}`, { headers: { [KEY_HEADER]: key } })
        ).json()) as PairingConfirmation;

    const decide = (id: string, accept: boolean) =>
        local(`/pair/offers/${id}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', [KEY_HEADER]: key },
            body: JSON.stringify({ accept }),
        });

    /** `palmtop pair CODE` up to the number: the phone got the key and paired, unconfirmed. */
    async function pairByCode(deviceId: string) {
        const phone = await waitingPhone();
        const response = await offer(phone.code);
        const answer = (await response.json()) as { status: string; id: string };
        expect(answer).toEqual({ status: 'delivered', id: expect.any(String) });
        const received = await phone.next('pair.offer');
        phone.ws.close();

        const device = await TestClient.connect(relay, received.room);
        const paired = await device.pair({
            roomId: received.room,
            pairKey: received.key,
            deviceId,
            name: 'iPhone · Safari',
        });
        for (let i = 0; i < 100 && (await confirmation(answer.id)).state === 'waiting'; i++) {
            await Bun.sleep(10);
        }
        return { id: answer.id, device, paired, received };
    }

    test('palmtop pair CODE: the number shows on both sides, and only a yes registers the device', async () => {
        const phone = await waitingPhone();
        expect((await offer(phone.code, false)).status).toBe(401);
        phone.ws.close();

        const { id, device, paired, received } = await pairByCode('web-phone1');
        expect(received.room).toBe(daemon.registry.roomId);
        expect(received.computer).toBe(daemon.computerName);
        // The terminal sees what the phone sees.
        expect(await confirmation(id)).toEqual({
            id,
            state: 'ready',
            number: paired.number,
            deviceName: 'iPhone · Safari',
        });
        // Not registered, and the device can't do anything yet.
        expect(daemon.paired.list()).toEqual([]);
        device.send({ type: 'hello' });
        expect(await device.next()).toMatchObject({
            code: 'forbidden',
            message: 'pairing not confirmed yet',
        });

        expect((await decide(id, true)).status).toBe(200);
        expect(await device.next()).toMatchObject({ type: 'paired' });
        expect(daemon.paired.get('web-phone1')?.publicKey).toBe(paired.device.publicKey);
        expect((await confirmation(id)).state).toBe('accepted');
        expect((await decide(id, true)).status).toBe(409);
    });

    test('palmtop pair CODE: a no, or a device that goes away, pairs nothing', async () => {
        const refused = await pairByCode('web-refused');
        expect((await decide(refused.id, false)).status).toBe(200);
        expect(await refused.device.next()).toMatchObject({
            type: 'error',
            message: 'pairing refused on the computer',
        });
        expect((await refused.device.closed).code).toBe(CloseCode.unauthorized);
        expect((await confirmation(refused.id)).state).toBe('refused');

        const left = await pairByCode('web-left');
        left.device.close();
        for (let i = 0; i < 100 && (await confirmation(left.id)).state === 'ready'; i++) {
            await Bun.sleep(10);
        }
        expect((await confirmation(left.id)).state).toBe('refused');
        expect(daemon.paired.list()).toEqual([]);
        expect(
            (await local('/pair/offers/made-up', { headers: { [KEY_HEADER]: key } })).status,
        ).toBe(404);
    });

    test('palmtop pair CODE: a device that can not be saved is told so, and the daemon goes on', async () => {
        const { id, device } = await pairByCode('web-disk');
        const add = daemon.paired.add;
        daemon.paired.add = () => Promise.reject(new Error('disk full'));
        try {
            expect((await decide(id, true)).status).toBe(200);
            expect(await device.next()).toMatchObject({
                type: 'error',
                message: 'pairing failed on the computer',
            });
            expect((await device.closed).code).toBe(CloseCode.unauthorized);
        } finally {
            daemon.paired.add = add;
        }
        expect(daemon.paired.list()).toEqual([]);

        const next = await pairByCode('web-next');
        expect((await decide(next.id, true)).status).toBe(200);
        expect(await next.device.next()).toMatchObject({ type: 'paired' });
        next.device.close();
    });

    test('palmtop pair CODE: a device gone while it is being saved keeps what it had', async () => {
        /** Pairs by code, and closes the device while its key is being written. */
        const abandon = async (deviceId: string) => {
            const { id, device } = await pairByCode(deviceId);
            const add = daemon.paired.add.bind(daemon.paired);
            let release = () => {};
            let saving: ReturnType<typeof add> | null = null;
            daemon.paired.add = (entry) => {
                saving = new Promise<void>((resolve) => {
                    release = resolve;
                }).then(() => add(entry));
                return saving;
            };
            try {
                expect((await decide(id, true)).status).toBe(200);
                await waitUntil(() => saving !== null, 'the device to be saved');
                device.close();
                await waitUntil(() => !daemon.devices.isConnected(deviceId), 'the device to go');
                release();
                await saving;
                // Long enough for the daemon to undo it.
                await Bun.sleep(50);
            } finally {
                daemon.paired.add = add;
            }
        };

        // A new device: nothing registered.
        await abandon('web-gone');
        expect(daemon.paired.get('web-gone')).toBeNull();

        // A device paired before: its registration stays valid, as it still is on that device.
        const before = await testComputer(daemon).device('web-known');
        await abandon('web-known');
        expect(daemon.paired.get('web-known')?.publicKey).toBe(before.publicKey);
    });

    test('palmtop pair CODE: wrong codes, and no relay', async () => {
        expect((await offer('nope')).status).toBe(400);
        expect(await (await offer('ZZZZZZ')).json()).toEqual({ status: 'unknown_code' });

        await relay.stop();
        await waitUntil(() => daemon.relay.status !== 'connected', 'the relay to go away');
        expect(await (await offer('ZZZZZZ')).json()).toEqual({ status: 'relay_unavailable' });
    });

    test('without a valid code the page is gone', async () => {
        for (const path of ['/pair', '/pair?code=', '/pair?code=guess']) {
            const response = await local(path, { headers: { [KEY_HEADER]: key } });
            expect(response.status).toBe(410);
            expect(await response.text()).not.toContain(privateKey);
        }
    });

    test('an expired code is refused', async () => {
        await daemon.stop();
        daemon = await startTestDaemon(home, { pairingCodeTtlMs: 1, relay });
        const { url } = (await (await createCode()).json()) as { url: string };
        await Bun.sleep(5);
        const response = await fetch(url);
        expect(response.status).toBe(410);
    });

    test('the pairing page warns when the daemon is not connected to the relay', async () => {
        await daemon.stop();
        await relay.stop();
        daemon = await startTestDaemon(home);
        const { url } = (await (await createCode()).json()) as { url: string };
        const html = await (await fetch(url)).text();
        expect(html).toContain('not connected to the relay');
        // Without a relay the test daemon points to a closed port.
        expect(html).toContain('ws://127.0.0.1:9');
        relay = startTestRelay();
    });
});

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Daemon, type PairLink, startDaemon } from '@palmtopai/daemon';
import { exportPublicKey, generateDeviceKeys, parseWaitMessage } from '@palmtopai/protocol';
import { type Relay, startRelay } from '@palmtopai/relay';
import { PairError, pairDevice, SyncClient } from '../src';

/** Pairing from the device's side, end to end, through a real relay and daemon. */
describe('pairDevice', () => {
    let home: string;
    let relay: Relay;
    let daemon: Daemon;
    let localKey: string;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), 'palmtop-pair-client-'));
        relay = startRelay({ port: 0, log: () => {} });
        daemon = await startDaemon({
            home,
            localPort: 0,
            relayUrl: `ws://127.0.0.1:${relay.port}`,
            relayReconnectDelayMs: { min: 20, max: 200 },
            log: () => {},
        });
        const { roomId } = daemon.registry;
        for (let i = 0; i < 300 && !daemon.relay.isRoomOpen(roomId); i++) await Bun.sleep(10);
        localKey = (await readFile(join(home, 'local.key'), 'utf8')).trim();
    });

    afterEach(async () => {
        await daemon.stop();
        await relay.stop();
        await rm(home, { recursive: true, force: true });
    });

    const local = (path: string, init: { method?: string; body?: unknown } = {}) =>
        fetch(`http://127.0.0.1:${daemon.localPort}${path}`, {
            method: init.method ?? 'GET',
            headers: { 'content-type': 'application/json', 'x-palmtop-key': localKey },
            ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        });

    const roomUrl = () => `ws://127.0.0.1:${relay.port}/ws?room=${daemon.registry.roomId}`;

    async function pairingLink(): Promise<PairLink> {
        return (await (
            await local('/pair/links', { method: 'POST', body: {} })
        ).json()) as PairLink;
    }

    test('with the key of a link: paired, and the pairing opens a sealed sync', async () => {
        const link = await pairingLink();
        const deviceKeys = await generateDeviceKeys();
        const pairing = await pairDevice({
            url: roomUrl(),
            roomId: daemon.registry.roomId,
            pairKey: link.key,
            deviceId: 'web-phone1',
            name: 'iPhone · Safari',
            deviceKeys,
        });
        expect(pairing).toEqual({
            computerId: daemon.registry.computerId,
            computer: daemon.computerName,
            computerKey: daemon.registry.roomPublicKey,
        });
        expect(daemon.paired.get('web-phone1')).toMatchObject({
            name: 'iPhone · Safari',
            publicKey: await exportPublicKey(deviceKeys.publicKey),
        });

        // What the device kept is enough to connect from now on.
        const client = new SyncClient({
            url: roomUrl(),
            identity: {
                roomId: daemon.registry.roomId,
                deviceId: 'web-phone1',
                deviceKey: deviceKeys.privateKey,
                computerKey: pairing.computerKey,
            },
        });
        client.start();
        for (let i = 0; i < 300 && client.getSnapshot().status !== 'online'; i++) {
            await Bun.sleep(10);
        }
        expect(client.getSnapshot()).toMatchObject({
            status: 'online',
            computer: { id: daemon.registry.computerId },
        });

        // Unpairing from the device: the computer forgets it and closes.
        expect(await client.unpair()).toBe(true);
        expect(daemon.paired.list()).toEqual([]);
        expect(client.getSnapshot().status).toBe('stopped');
    });

    test('a used, made-up or wrong-room key fails, and pairs nothing', async () => {
        const link = await pairingLink();
        const pair = (pairKey: string, roomId = daemon.registry.roomId) =>
            generateDeviceKeys().then((deviceKeys) =>
                pairDevice({
                    url: roomUrl(),
                    roomId,
                    pairKey,
                    deviceId: 'web-phone1',
                    name: 'iPhone',
                    deviceKeys,
                    timeoutMs: 2_000,
                }),
            );
        await pair(link.key);
        await expect(pair(link.key)).rejects.toBeInstanceOf(PairError);
        await expect(pair('aaaaaaaaaaaaaaaaaaaaaa')).rejects.toThrow(
            'this pairing is not valid any more',
        );
        // The room id came with the link: a computer that can't prove that room is refused.
        const other = await pairingLink();
        await expect(pair(other.key, 'x'.repeat(43))).rejects.toThrow(
            'this computer does not hold the key of its room',
        );
        expect(daemon.paired.list().map((device) => device.deviceId)).toEqual(['web-phone1']);
    });

    /** `palmtop pair CODE` up to the key reaching the phone; returns the pairing id. */
    async function offerByCode(): Promise<{ id: string; room: string; key: string }> {
        const wait = new WebSocket(`ws://127.0.0.1:${relay.port}/wait`);
        const messages: Array<NonNullable<ReturnType<typeof parseWaitMessage>>> = [];
        wait.addEventListener('message', (event) => {
            const message = parseWaitMessage(String(event.data));
            if (message) messages.push(message);
        });
        const next = async (type: string) => {
            for (let i = 0; i < 200 && messages[0]?.type !== type; i++) await Bun.sleep(10);
            return messages.shift() as Extract<(typeof messages)[number], { type: 'pair.offer' }> &
                Extract<(typeof messages)[number], { type: 'pair.code' }>;
        };
        const { code } = await next('pair.code');
        const { id } = (await (
            await local('/pair/offer', { method: 'POST', body: { code } })
        ).json()) as {
            id: string;
        };
        const { room, key } = await next('pair.offer');
        wait.close();
        return { id, room, key };
    }

    const stateOf = async (id: string) =>
        (await (await local(`/pair/offers/${id}`)).json()) as { state: string; number?: string };

    test('by code: the number shows, and it takes a yes on both sides', async () => {
        const { id, room, key } = await offerByCode();
        let shown = '';
        const pairing = pairDevice({
            url: roomUrl(),
            roomId: room,
            pairKey: key,
            deviceId: 'web-phone1',
            name: 'iPhone · Safari',
            deviceKeys: await generateDeviceKeys(),
            confirmNumber: async (number) => {
                shown = number;
                return true;
            },
        });
        for (let i = 0; i < 200 && (await stateOf(id)).state !== 'ready'; i++) await Bun.sleep(10);
        const ready = await stateOf(id);
        expect(ready.number).toBe(shown);
        // Not paired before the terminal says yes.
        expect(daemon.paired.list()).toEqual([]);
        await local(`/pair/offers/${id}`, { method: 'POST', body: { accept: true } });
        expect((await pairing).computerKey).toBe(daemon.registry.roomPublicKey);
        expect(daemon.paired.get('web-phone1')).not.toBeNull();
    });

    test('by code: a no on the device or on the computer pairs nothing', async () => {
        // The device sees a different number: it stops, the computer sees it go.
        const first = await offerByCode();
        const refusedHere = pairDevice({
            url: roomUrl(),
            roomId: first.room,
            pairKey: first.key,
            deviceId: 'web-phone1',
            name: 'iPhone',
            deviceKeys: await generateDeviceKeys(),
            // A person answers once the number is on both screens, not in the same millisecond.
            confirmNumber: async () => {
                for (let i = 0; i < 200 && (await stateOf(first.id)).state !== 'ready'; i++) {
                    await Bun.sleep(10);
                }
                return false;
            },
        });
        await expect(refusedHere).rejects.toThrow('the numbers did not match');
        for (let i = 0; i < 200 && (await stateOf(first.id)).state === 'ready'; i++) {
            await Bun.sleep(10);
        }
        expect((await stateOf(first.id)).state).toBe('refused');

        // The user says no at the terminal: the device is told, nothing is kept.
        const second = await offerByCode();
        const refusedThere = pairDevice({
            url: roomUrl(),
            roomId: second.room,
            pairKey: second.key,
            deviceId: 'web-phone2',
            name: 'iPhone',
            deviceKeys: await generateDeviceKeys(),
            confirmNumber: async () => true,
        });
        // Watched from the start: the device can hear the no before this test looks at the answer
        // to its own request, and a rejection nobody is watching yet fails the whole run. (Not
        // `expect().rejects` here: not awaited, it waits for the promise before going on.)
        const refusal = refusedThere.then(
            () => null,
            (error: unknown) => error,
        );
        for (let i = 0; i < 200 && (await stateOf(second.id)).state !== 'ready'; i++) {
            await Bun.sleep(10);
        }
        await local(`/pair/offers/${second.id}`, { method: 'POST', body: { accept: false } });
        expect(await refusal).toMatchObject({ message: 'pairing refused on the computer' });
        expect(daemon.paired.list()).toEqual([]);
    });

    test('a name the computer would refuse fails on the device, before anything is sent', async () => {
        const link = await pairingLink();
        await expect(
            pairDevice({
                url: roomUrl(),
                roomId: daemon.registry.roomId,
                pairKey: link.key,
                deviceId: 'web-phone1',
                name: 'iPhone\u001b[2K',
                deviceKeys: await generateDeviceKeys(),
                timeoutMs: 2_000,
            }),
        ).rejects.toThrow('invalid device name');
    });
});

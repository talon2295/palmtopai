import { describe, expect, test } from 'bun:test';
import {
    acceptDeviceHandshake,
    acceptDevicePairing,
    type DeviceKeyPair,
    deviceNameSchema,
    E2EError,
    exportPublicKey,
    formatPairingNumber,
    fromBase64url,
    generateDeviceKeys,
    importRoomSigningKey,
    isE2ESupported,
    type PairReveal,
    pairingNumber,
    parseE2EComputerMessage,
    parseE2EDeviceMessage,
    roomIdOfKey,
    type SealedFrame,
    sealedFrameBytes,
    startDeviceHandshake,
    startDevicePairing,
    toBase64url,
} from '../src';
import { generateRoomKeyPair, roomIdOf } from '../src/relay-crypto';

/** A computer as the daemon holds it: the room key of `projects.json`, and its room id. */
async function computer() {
    const keys = generateRoomKeyPair();
    return {
        roomId: roomIdOf(keys.publicKey),
        publicKey: keys.publicKey,
        signingKey: await importRoomSigningKey(keys),
    };
}

type Computer = Awaited<ReturnType<typeof computer>>;

/** A paired device: the computer registered its public key, it keeps the private one. */
async function newDevice(deviceId = 'web-phone') {
    const keys = await generateDeviceKeys();
    return { deviceId, keys, publicKey: await exportPublicKey(keys.publicKey) };
}

type Device = Awaited<ReturnType<typeof newDevice>>;

/** Runs the handshake of a paired device; returns both ends of the channel. */
async function connect(pc: Computer, device: Device) {
    const deviceSide = await startDeviceHandshake({
        roomId: pc.roomId,
        deviceId: device.deviceId,
        deviceKey: device.keys.privateKey,
        computerKey: pc.publicKey,
    });
    const computerSide = await acceptDeviceHandshake({
        roomId: pc.roomId,
        hello: deviceSide.hello,
        computerKey: pc.signingKey,
        devicePublicKey: device.publicKey,
    });
    const { auth, channel: deviceChannel } = await deviceSide.finish(computerSide.welcome);
    const computerChannel = await computerSide.finish(auth);
    return { deviceChannel, computerChannel };
}

async function rejection(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        expect(error).toBeInstanceOf(E2EError);
        return (error as Error).message;
    }
    throw new Error('expected a rejection');
}

/** The transcript encoding of `e2e.ts`, written again here to forge messages as an attacker. */
function framed(...fields: Array<string | Uint8Array>): Uint8Array<ArrayBuffer> {
    const parts = fields.map((field) =>
        typeof field === 'string' ? new TextEncoder().encode(field) : field,
    );
    const out = new Uint8Array(parts.reduce((total, part) => total + 4 + part.length, 0));
    const view = new DataView(out.buffer);
    let offset = 0;
    for (const part of parts) {
        view.setUint32(offset, part.length);
        out.set(part, offset + 4);
        offset += 4 + part.length;
    }
    return out;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

/** Flips one bit of a sealed frame's ciphertext. */
function tampered(frame: SealedFrame): SealedFrame {
    const bytes = fromBase64url(frame.c);
    bytes[0] = (bytes[0] as number) ^ 1;
    return { ...frame, c: toBase64url(bytes) };
}

describe('end-to-end encryption: keys', () => {
    test('this runtime has what it needs', async () => {
        expect(await isE2ESupported()).toBe(true);
    });

    test("a device key can sign, but its private half can't leave the runtime", async () => {
        const keys = await generateDeviceKeys();
        expect(keys.privateKey.extractable).toBe(false);
        await expect(crypto.subtle.exportKey('jwk', keys.privateKey)).rejects.toThrow();
        await expect(crypto.subtle.exportKey('pkcs8', keys.privateKey)).rejects.toThrow();
        expect(await exportPublicKey(keys.publicKey)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    test("the room key of the relay is the computer's identity: its hash is the room id", async () => {
        const keys = generateRoomKeyPair();
        expect(await roomIdOfKey(keys.publicKey)).toBe(roomIdOf(keys.publicKey));
        const signingKey = await importRoomSigningKey(keys);
        expect(signingKey.extractable).toBe(false);
    });

    test('base64url round trip', () => {
        const bytes = crypto.getRandomValues(new Uint8Array(77));
        const text = toBase64url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(fromBase64url(text)).toEqual(bytes);
    });
});

describe('end-to-end encryption: a paired device connects', () => {
    test('both ends get a channel, and messages go both ways', async () => {
        const pc = await computer();
        const { deviceChannel, computerChannel } = await connect(pc, await newDevice());

        const hello = await deviceChannel.seal('{"type":"hello","deviceId":"web-phone"}');
        expect(hello.n).toBe(0);
        expect(hello.c).not.toContain('hello');
        expect(await computerChannel.open(hello)).toBe('{"type":"hello","deviceId":"web-phone"}');

        const answer = await computerChannel.seal('snapshot ✓ 🔐');
        expect(await deviceChannel.open(answer)).toBe('snapshot ✓ 🔐');
    });

    test('frames sealed at the same time come out in call order', async () => {
        const pc = await computer();
        const { deviceChannel, computerChannel } = await connect(pc, await newDevice());
        const messages = Array.from({ length: 50 }, (_, i) => `message ${i} ${'x'.repeat(i * 97)}`);
        const frames = await Promise.all(messages.map((message) => computerChannel.seal(message)));
        expect(frames.map((frame) => frame.n)).toEqual(messages.map((_, i) => i));
        for (const [i, frame] of frames.entries()) {
            expect(await deviceChannel.open(frame)).toBe(messages[i] as string);
        }
    });

    test('frames opened at the same time come out in order, and a gap is a rejection', async () => {
        const pc = await computer();
        const { deviceChannel, computerChannel } = await connect(pc, await newDevice());
        const messages = Array.from({ length: 30 }, (_, i) => `op ${i} ${'y'.repeat(i * 131)}`);
        const frames = await Promise.all(messages.map((message) => deviceChannel.seal(message)));
        // Opened without waiting for one another, as messages arriving in a burst would be.
        expect(await Promise.all(frames.map((frame) => computerChannel.open(frame)))).toEqual(
            messages,
        );
        const late = await deviceChannel.seal('late');
        const skipped = { ...late, n: late.n + 1 };
        await expect(computerChannel.open(skipped)).rejects.toBeInstanceOf(E2EError);
    });

    test('the size of a sealed frame is known before sealing, and never exceeded', async () => {
        const pc = await computer();
        const { computerChannel } = await connect(pc, await newDevice());
        const encoder = new TextEncoder();
        for (const message of ['', 'x', 'snapshot ✓ 🔐', '"'.repeat(5_000), 'é'.repeat(70_001)]) {
            const bytes = encoder.encode(message).length;
            const frame = JSON.stringify(await computerChannel.seal(message));
            expect(frame.length).toBeLessThanOrEqual(sealedFrameBytes(bytes));
            expect(frame.length).toBeGreaterThan(sealedFrameBytes(bytes) - 64);
        }
        // Counters up to the largest one keep it an upper bound.
        const last = { type: 'sealed', n: Number.MAX_SAFE_INTEGER, c: 'x'.repeat(22) };
        expect(JSON.stringify(last).length).toBeLessThanOrEqual(sealedFrameBytes(0));
    });

    test('an altered, repeated, skipped or reflected frame is refused', async () => {
        const pc = await computer();
        const altered = await connect(pc, await newDevice());
        const frame = await altered.deviceChannel.seal('review');
        expect(await rejection(altered.computerChannel.open(tampered(frame)))).toBe(
            'frame rejected',
        );

        const repeated = await connect(pc, await newDevice());
        const once = await repeated.deviceChannel.seal('op');
        expect(await repeated.computerChannel.open(once)).toBe('op');
        expect(await rejection(repeated.computerChannel.open(once))).toBe('frame out of sequence');

        const skipped = await connect(pc, await newDevice());
        await skipped.deviceChannel.seal('lost on the way');
        const second = await skipped.deviceChannel.seal('second');
        expect(await rejection(skipped.computerChannel.open(second))).toBe('frame out of sequence');

        // A frame sent back to its sender: the other direction has its own key.
        const reflected = await connect(pc, await newDevice());
        const own = await reflected.deviceChannel.seal('mine');
        expect(await rejection(reflected.deviceChannel.open(own))).toBe('frame rejected');
    });

    test("a frame of another connection can't be read, even with the right counter", async () => {
        const pc = await computer();
        const device = await newDevice();
        const first = await connect(pc, device);
        const second = await connect(pc, device);
        const frame = await first.deviceChannel.seal('from the first connection');
        expect(await rejection(second.computerChannel.open(frame))).toBe('frame rejected');
    });

    test("a device that pinned another computer's key refuses the welcome", async () => {
        const pc = await computer();
        const impostor = await computer();
        const device = await newDevice();
        const deviceSide = await startDeviceHandshake({
            roomId: pc.roomId,
            deviceId: device.deviceId,
            deviceKey: device.keys.privateKey,
            computerKey: pc.publicKey,
        });
        // The relay answers with a computer of its own, on the same room id.
        const fake = await acceptDeviceHandshake({
            roomId: pc.roomId,
            hello: deviceSide.hello,
            computerKey: impostor.signingKey,
            devicePublicKey: device.publicKey,
        });
        expect(await rejection(deviceSide.finish(fake.welcome))).toBe(
            'the computer did not prove its key',
        );
    });

    test("an ephemeral key swapped by the relay breaks the computer's signature", async () => {
        const pc = await computer();
        const device = await newDevice();
        const deviceSide = await startDeviceHandshake({
            roomId: pc.roomId,
            deviceId: device.deviceId,
            deviceKey: device.keys.privateKey,
            computerKey: pc.publicKey,
        });
        const computerSide = await acceptDeviceHandshake({
            roomId: pc.roomId,
            hello: deviceSide.hello,
            computerKey: pc.signingKey,
            devicePublicKey: device.publicKey,
        });
        const relayKey = await newDevice(); // any 32-byte key will do
        const swapped = { ...computerSide.welcome, e: relayKey.publicKey };
        expect(await rejection(deviceSide.finish(swapped))).toBe(
            'the computer did not prove its key',
        );
    });

    test('a device without the registered key is refused, and so is an old auth', async () => {
        const pc = await computer();
        const device = await newDevice();
        const thief = await newDevice(device.deviceId);

        // Same device id, another key: the signature does not match the registered key.
        const thiefSide = await startDeviceHandshake({
            roomId: pc.roomId,
            deviceId: thief.deviceId,
            deviceKey: thief.keys.privateKey,
            computerKey: pc.publicKey,
        });
        const computerSide = await acceptDeviceHandshake({
            roomId: pc.roomId,
            hello: thiefSide.hello,
            computerKey: pc.signingKey,
            devicePublicKey: device.publicKey,
        });
        const { auth } = await thiefSide.finish(computerSide.welcome);
        expect(await rejection(computerSide.finish(auth))).toBe('the device did not prove its key');

        // An auth recorded from a real connection doesn't open a new one.
        const realSide = await startDeviceHandshake({
            roomId: pc.roomId,
            deviceId: device.deviceId,
            deviceKey: device.keys.privateKey,
            computerKey: pc.publicKey,
        });
        const first = await acceptDeviceHandshake({
            roomId: pc.roomId,
            hello: realSide.hello,
            computerKey: pc.signingKey,
            devicePublicKey: device.publicKey,
        });
        const recorded = await realSide.finish(first.welcome);
        const replay = await acceptDeviceHandshake({
            roomId: pc.roomId,
            hello: realSide.hello,
            computerKey: pc.signingKey,
            devicePublicKey: device.publicKey,
        });
        expect(await rejection(replay.finish(recorded.auth))).toBe(
            'the device did not prove its key',
        );
    });
});

describe('end-to-end encryption: pairing', () => {
    // 22 base64url characters, as `PairKeys` makes them (a placeholder, not a real key).
    const pairKey = 'test-pair-key-00000001';

    async function pair(
        pc: Computer,
        options: { roomId?: string; deviceKey?: string; validKeys?: string[] } = {},
    ) {
        const deviceKeys: DeviceKeyPair = await generateDeviceKeys();
        const deviceSide = await startDevicePairing({
            roomId: options.roomId ?? pc.roomId,
            pairKey: options.deviceKey ?? pairKey,
            deviceId: 'web-newphone',
            name: 'iPhone · Safari',
            deviceKeys,
        });
        const computerSide = await acceptDevicePairing({
            roomId: pc.roomId,
            start: deviceSide.start,
            computerKey: pc.signingKey,
            computerPublicKey: pc.publicKey,
        });
        return { deviceKeys, deviceSide, computerSide, validKeys: options.validKeys ?? [pairKey] };
    }

    test('with the right pairing key both ends agree: same number, a channel, the keys', async () => {
        const pc = await computer();
        const { deviceKeys, deviceSide, computerSide, validKeys } = await pair(pc);
        const revealed = await deviceSide.reveal(computerSide.welcome);
        expect(revealed.number).toMatch(/^\d{6}$/);

        const done = await computerSide.finish(revealed.reveal, [
            'someone-elses-key-1234',
            ...validKeys,
        ]);
        expect(done.pairKey).toBe(pairKey);
        expect(done.number).toBe(revealed.number);
        expect(done.device).toEqual({
            deviceId: 'web-newphone',
            name: 'iPhone · Safari',
            publicKey: await exportPublicKey(deviceKeys.publicKey),
        });

        const { channel, computerKey } = await revealed.finish(done.accept);
        expect(computerKey).toBe(pc.publicKey);
        const frame = await channel.seal('{"type":"hello"}');
        expect(await done.channel.open(frame)).toBe('{"type":"hello"}');

        // What the computer registered is enough for the next connections.
        const next = await connect(pc, {
            deviceId: done.device.deviceId,
            keys: deviceKeys,
            publicKey: done.device.publicKey,
        });
        expect(await next.deviceChannel.open(await next.computerChannel.seal('again'))).toBe(
            'again',
        );
    });

    test('the pairing key never travels: only an HMAC of it', async () => {
        const pc = await computer();
        const { deviceSide, computerSide } = await pair(pc);
        const revealed = await deviceSide.reveal(computerSide.welcome);
        const wire = JSON.stringify([deviceSide.start, computerSide.welcome, revealed.reveal]);
        expect(wire).not.toContain(pairKey);
    });

    test('a wrong, used or expired pairing key is refused', async () => {
        const pc = await computer();
        const { deviceSide, computerSide } = await pair(pc, {
            deviceKey: 'Wr0ngKeyWr0ngKeyWr0ngK',
        });
        const revealed = await deviceSide.reveal(computerSide.welcome);
        expect(await rejection(computerSide.finish(revealed.reveal, [pairKey]))).toBe(
            'invalid or expired pairing key',
        );

        // No key still valid (used or expired): nothing to match.
        const again = await pair(pc);
        const second = await again.deviceSide.reveal(again.computerSide.welcome);
        expect(await rejection(again.computerSide.finish(second.reveal, []))).toBe(
            'invalid or expired pairing key',
        );
    });

    test('keys revealed after the welcome must be the ones committed to before it', async () => {
        const pc = await computer();
        const { deviceSide, computerSide, validKeys } = await pair(pc);
        const revealed = await deviceSide.reveal(computerSide.welcome);
        const other = await generateDeviceKeys();
        const changed = { ...revealed.reveal, pk: await exportPublicKey(other.publicKey) };
        expect(await rejection(computerSide.finish(changed, validKeys))).toBe(
            'the device changed what it committed to',
        );
    });

    test("a relay posing as the device can't steer the number with the name it gives", async () => {
        // The attack: commit, see the computer's welcome, then try names until the transcript
        // gives the number the phone shows. The relay knows the pairing key and has its own
        // device key, so it can make a reveal with a valid HMAC and signature for any name.
        const pc = await computer();
        const { deviceKeys, deviceSide, computerSide, validKeys } = await pair(pc);
        const revealed = await deviceSide.reveal(computerSide.welcome);

        async function forged(name: string): Promise<PairReveal> {
            const { deviceId, pk, e, n } = revealed.reveal;
            const welcome = computerSide.welcome;
            const transcript = await sha256(
                framed(
                    'palmtop-e2e-v1/pair',
                    pc.roomId,
                    deviceId,
                    name,
                    ...[pk, e, n, welcome.pk, welcome.e, welcome.n].map(fromBase64url),
                ),
            );
            const macKey = await crypto.subtle.importKey(
                'raw',
                new TextEncoder().encode(pairKey),
                { name: 'HMAC', hash: 'SHA-256' },
                false,
                ['sign'],
            );
            const mac = await crypto.subtle.sign(
                'HMAC',
                macKey,
                framed('palmtop-e2e-v1/pair-key', transcript),
            );
            const sig = await crypto.subtle.sign(
                'Ed25519',
                deviceKeys.privateKey,
                framed('palmtop-e2e-v1/device', transcript),
            );
            return {
                ...revealed.reveal,
                name,
                mac: toBase64url(new Uint8Array(mac)),
                sig: toBase64url(new Uint8Array(sig)),
            };
        }

        // Invisible characters: the name looks the same in a list.
        for (const name of ['iPhone · Safari​', 'iPhone · Safari‌​', 'Pixel']) {
            expect(await rejection(computerSide.finish(await forged(name), validKeys))).toBe(
                'the device changed what it committed to',
            );
        }
        // The forgery itself is right: with the committed name it goes through.
        const done = await computerSide.finish(await forged('iPhone · Safari'), validKeys);
        expect(done.number).toBe(revealed.number);
    });

    test('the device id and name are committed as the computer will read them', async () => {
        const pc = await computer();
        const deviceSide = await startDevicePairing({
            roomId: pc.roomId,
            pairKey,
            deviceId: 'web-newphone',
            name: '  iPhone · Safari  ',
            deviceKeys: await generateDeviceKeys(),
        });
        const computerSide = await acceptDevicePairing({
            roomId: pc.roomId,
            start: deviceSide.start,
            computerKey: pc.signingKey,
            computerPublicKey: pc.publicKey,
        });
        const revealed = await deviceSide.reveal(computerSide.welcome);
        // On the wire, as the daemon gets it.
        const parsed = parseE2EDeviceMessage(JSON.stringify(revealed.reveal));
        expect(parsed?.type).toBe('pair.reveal');
        const done = await computerSide.finish(parsed as PairReveal, [pairKey]);
        expect(done.device.name).toBe('iPhone · Safari');

        for (const [deviceId, name, error] of [
            ['web-newphone', 'x'.repeat(61), 'invalid device name'],
            ['web-newphone', '   ', 'invalid device name'],
            ['not a device id!', 'iPhone', 'invalid device id'],
            // What could rewrite the terminal line of the pairing number, or hide in it.
            ['web-newphone', 'iPhone\u001b[2K\r123 456', 'invalid device name'],
            ['web-newphone', 'iPhone\u009b2K', 'invalid device name'],
            ['web-newphone', 'iPhone \u202eirafaS', 'invalid device name'],
            ['web-newphone', 'iPhone\u200b', 'invalid device name'],
            ['web-newphone', 'iPhone\u2028Safari', 'invalid device name'],
            ['web-newphone', 'iPhone\ud800', 'invalid device name'],
        ] as const) {
            const start = startDevicePairing({
                roomId: pc.roomId,
                pairKey,
                deviceId,
                name,
                deviceKeys: await generateDeviceKeys(),
            });
            expect(await rejection(start)).toBe(error);
        }
    });

    test('a computer whose key is not the one of the room is refused by the device', async () => {
        const pc = await computer();
        const elsewhere = await computer();
        const { deviceSide } = await pair(pc);
        const impostor = await acceptDevicePairing({
            roomId: pc.roomId,
            start: deviceSide.start,
            computerKey: elsewhere.signingKey,
            computerPublicKey: elsewhere.publicKey,
        });
        expect(await rejection(deviceSide.reveal(impostor.welcome))).toBe(
            'this computer does not hold the key of its room',
        );
    });

    test('an accept not signed by the computer is refused', async () => {
        const pc = await computer();
        const { deviceSide, computerSide, validKeys } = await pair(pc);
        const revealed = await deviceSide.reveal(computerSide.welcome);
        const done = await computerSide.finish(revealed.reveal, validKeys);
        const forged = { ...done.accept, sig: toBase64url(new Uint8Array(64)) };
        expect(await rejection(revealed.finish(forged))).toBe('the computer did not prove its key');
    });

    test('a relay in the middle, holding the pairing key, ends with two different numbers', async () => {
        // Pairing by code: the relay forwards the offer, so it knows the key, and it can give
        // the phone a room of its own. It pairs the phone with itself and itself with the computer.
        const pc = await computer();
        const relayComputer = await computer();

        const phone = await startDevicePairing({
            roomId: relayComputer.roomId,
            pairKey,
            deviceId: 'web-phone',
            name: 'iPhone · Safari',
            deviceKeys: await generateDeviceKeys(),
        });
        const relayAsComputer = await acceptDevicePairing({
            roomId: relayComputer.roomId,
            start: phone.start,
            computerKey: relayComputer.signingKey,
            computerPublicKey: relayComputer.publicKey,
        });
        const phoneRevealed = await phone.reveal(relayAsComputer.welcome);
        const phoneEnd = await relayAsComputer.finish(phoneRevealed.reveal, [pairKey]);

        const relayAsPhone = await startDevicePairing({
            roomId: pc.roomId,
            pairKey,
            deviceId: 'web-phone',
            name: 'iPhone · Safari',
            deviceKeys: await generateDeviceKeys(),
        });
        const computerSide = await acceptDevicePairing({
            roomId: pc.roomId,
            start: relayAsPhone.start,
            computerKey: pc.signingKey,
            computerPublicKey: pc.publicKey,
        });
        const relayRevealed = await relayAsPhone.reveal(computerSide.welcome);
        const computerEnd = await computerSide.finish(relayRevealed.reveal, [pairKey]);

        // Both halves "work": only the numbers on the two screens give the relay away.
        expect(phoneEnd.number).not.toBe(computerEnd.number);
        expect(phoneRevealed.number).toBe(phoneEnd.number);
    });
});

describe('end-to-end encryption: numbers and messages', () => {
    test('the pairing number: 6 digits, the same for the same transcript, shown in two groups', async () => {
        const transcript = new Uint8Array(32).fill(7);
        const number = await pairingNumber(transcript);
        expect(number).toMatch(/^\d{6}$/);
        expect(await pairingNumber(new Uint8Array(32).fill(7))).toBe(number);
        expect(await pairingNumber(new Uint8Array(32).fill(8))).not.toBe(number);
        // Pinned (computed again by hand on Node): a change in how the number is derived would
        // make a new phone and an old daemon show different numbers.
        expect(number).toBe('044068');
        expect(formatPairingNumber('482913')).toBe('482 913');
        expect(formatPairingNumber('004002')).toBe('004 002');
    });

    test('device names: the ones a browser gives pass, the ones that hide or rewrite text do not', () => {
        for (const name of [
            'iPhone · Safari',
            'Pixel 9 · Chrome',
            'iPad di Martina’s',
            'Telefono 🚀',
            'Android · Firefox (lavoro)',
            '手机 · 浏览器',
        ]) {
            expect(deviceNameSchema.parse(name)).toBe(name);
        }
        // Spaces and a byte order mark at the ends are trimmed, not refused.
        expect(deviceNameSchema.parse('  Pixel  ')).toBe('Pixel');
        expect(deviceNameSchema.parse('Pixel\ufeff')).toBe('Pixel');
        for (const name of ['', 'a\tb', 'a\nb', 'a\u0007', 'a\u061cb', 'a\ufeffb', 'a\u2029b']) {
            expect(deviceNameSchema.safeParse(name).success).toBe(false);
        }
    });

    test('handshake and pairing messages are validated from both sides', async () => {
        const pc = await computer();
        const device = await newDevice();
        const deviceSide = await startDeviceHandshake({
            roomId: pc.roomId,
            deviceId: device.deviceId,
            deviceKey: device.keys.privateKey,
            computerKey: pc.publicKey,
        });
        const computerSide = await acceptDeviceHandshake({
            roomId: pc.roomId,
            hello: deviceSide.hello,
            computerKey: pc.signingKey,
            devicePublicKey: device.publicKey,
        });
        const { auth, channel } = await deviceSide.finish(computerSide.welcome);
        const frame = await channel.seal('x');

        for (const message of [deviceSide.hello, auth, frame]) {
            expect(parseE2EDeviceMessage(JSON.stringify(message))).toEqual(message);
        }
        expect(parseE2EComputerMessage(JSON.stringify(computerSide.welcome))).toEqual(
            computerSide.welcome,
        );

        for (const raw of [
            'not json',
            '{"type":"hello","token":"x"}',
            JSON.stringify({ ...deviceSide.hello, v: 2 }),
            JSON.stringify({ ...deviceSide.hello, e: 'short' }),
            JSON.stringify({ ...frame, n: -1 }),
            JSON.stringify({ ...frame, c: 'not base64url!' }),
        ]) {
            expect(parseE2EDeviceMessage(raw)).toBeNull();
        }
        // A computer message is not a device message.
        expect(parseE2EDeviceMessage(JSON.stringify(computerSide.welcome))).toBeNull();
    });
});

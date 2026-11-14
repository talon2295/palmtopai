import { z } from 'zod';
import { deviceIdSchema } from './schemas';

/**
 * End-to-end encryption between a device and the daemon of the computer it is paired with. The
 * relay forwards these messages like any other device message: before
 * the handshake it sees public keys, nonces and signatures; after it, only sealed frames.
 *
 * WebCrypto only (`crypto.subtle`), the same code in the daemon (Node ≥ 22), the tests (Bun) and
 * the app (Safari 17+, Chrome 137+, Firefox 130+): Ed25519 signatures, X25519 per connection,
 * HKDF-SHA-256 and AES-256-GCM.
 *
 * - The computer's identity is the Ed25519 key of its relay room: `sha256(public key) = roomId`,
 *   so the room id a device already has pins it.
 * - A device's identity is an Ed25519 key made in the browser, not extractable.
 * - Every connection runs a handshake with fresh X25519 keys, signed by both identities, and
 *   derives one AES-GCM key per direction. Frames carry a counter that must go up by one.
 * - Pairing proves the single-use pairing key with an HMAC (it never travels), and gives a
 *   6-digit number to compare on both screens when the key went through the relay.
 */

export const E2E_VERSION = 1;
const LABEL = 'palmtop-e2e-v1';

const PUBLIC_KEY_BYTES = 32;
const NONCE_BYTES = 16;
const SIGNATURE_BYTES = 64;
const DIGEST_BYTES = 32;
/** AES-GCM nonce: 4 zero bytes and the frame counter on 8 bytes. */
const IV_BYTES = 12;

/**
 * WebCrypto key types as this runtime declares them: global in the browser and Bun, not with the
 * Node types the runtime build is checked with.
 */
type CryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;
export interface DeviceKeyPair {
    publicKey: CryptoKey;
    privateKey: CryptoKey;
}

export class E2EError extends Error {
    override name = 'E2EError';
}

// ---------------------------------------------------------------------------
// Encoding

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toBase64url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/** Fields joined with their length first, so two different lists never give the same bytes. */
function framed(...fields: Array<string | Uint8Array>): Uint8Array<ArrayBuffer> {
    const parts = fields.map((field) =>
        typeof field === 'string' ? encoder.encode(field) : field,
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

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
    return crypto.getRandomValues(new Uint8Array(length));
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
    return diff === 0;
}

// ---------------------------------------------------------------------------
// Messages

const bytesSchema = (bytes: number) =>
    z
        .string()
        .regex(
            new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`),
            `expected ${bytes} bytes`,
        );

const publicKeySchema = bytesSchema(PUBLIC_KEY_BYTES);
const nonceSchema = bytesSchema(NONCE_BYTES);
const signatureSchema = bytesSchema(SIGNATURE_BYTES);
const digestSchema = bytesSchema(DIGEST_BYTES);

/**
 * Name a device gives itself when it pairs ("iPhone · Safari"), to recognize it in a list. It is
 * printed in the terminal, next to the pairing number too: no control characters (ANSI sequences
 * could rewrite the number's line), no format characters (bidi overrides, zero-width), no lone
 * surrogates, no line or paragraph separators.
 */
export const deviceNameSchema = z
    .string()
    .trim()
    .min(1)
    .max(60)
    .regex(/^[^\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]+$/u, 'invalid characters in the device name');

/** Device → computer, first message of every connection of a paired device. */
export const e2eHelloSchema = z.object({
    type: z.literal('e2e.hello'),
    v: z.literal(E2E_VERSION),
    deviceId: deviceIdSchema,
    e: publicKeySchema,
    n: nonceSchema,
});

/** Computer → device: its ephemeral key, signed with the room key. */
export const e2eWelcomeSchema = z.object({
    type: z.literal('e2e.welcome'),
    e: publicKeySchema,
    n: nonceSchema,
    sig: signatureSchema,
});

/** Device → computer: the transcript signed with the device key. */
export const e2eAuthSchema = z.object({ type: z.literal('e2e.auth'), sig: signatureSchema });

/** Device → computer, first message of a pairing: a commitment to the device's keys. */
export const pairStartSchema = z.object({
    type: z.literal('pair.start'),
    v: z.literal(E2E_VERSION),
    commit: digestSchema,
});

/** Computer → device: the room key and a fresh ephemeral key. */
export const pairWelcomeSchema = z.object({
    type: z.literal('pair.welcome'),
    pk: publicKeySchema,
    e: publicKeySchema,
    n: nonceSchema,
});

/** Device → computer: the committed keys, the proof of the pairing key and a signature. */
export const pairRevealSchema = z.object({
    type: z.literal('pair.reveal'),
    deviceId: deviceIdSchema,
    name: deviceNameSchema,
    pk: publicKeySchema,
    e: publicKeySchema,
    n: nonceSchema,
    mac: digestSchema,
    sig: signatureSchema,
});

/** Computer → device: the transcript signed with the room key. */
export const pairAcceptSchema = z.object({ type: z.literal('pair.accept'), sig: signatureSchema });

/** Any message after the handshake: `n` goes 0, 1, 2… in each direction. */
export const sealedFrameSchema = z.object({
    type: z.literal('sealed'),
    n: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    c: z.string().regex(/^[A-Za-z0-9_-]+$/),
});

export type E2EHello = z.infer<typeof e2eHelloSchema>;
export type E2EWelcome = z.infer<typeof e2eWelcomeSchema>;
export type E2EAuth = z.infer<typeof e2eAuthSchema>;
export type PairStart = z.infer<typeof pairStartSchema>;
export type PairWelcome = z.infer<typeof pairWelcomeSchema>;
export type PairReveal = z.infer<typeof pairRevealSchema>;
export type PairAccept = z.infer<typeof pairAcceptSchema>;
export type SealedFrame = z.infer<typeof sealedFrameSchema>;

/** Messages a device sends before (or instead of) the sealed channel. */
export const e2eDeviceMessageSchema = z.discriminatedUnion('type', [
    e2eHelloSchema,
    e2eAuthSchema,
    pairStartSchema,
    pairRevealSchema,
    sealedFrameSchema,
]);

/** Messages the computer sends before (or instead of) the sealed channel. */
export const e2eComputerMessageSchema = z.discriminatedUnion('type', [
    e2eWelcomeSchema,
    pairWelcomeSchema,
    pairAcceptSchema,
    sealedFrameSchema,
]);

export type E2EDeviceMessage = z.infer<typeof e2eDeviceMessageSchema>;
export type E2EComputerMessage = z.infer<typeof e2eComputerMessageSchema>;

function parseJson<T>(schema: z.ZodType<T>, raw: string): T | null {
    try {
        const result = schema.safeParse(JSON.parse(raw));
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

/** A message from a device, or `null` if it is not one. */
export function parseE2EDeviceMessage(raw: string): E2EDeviceMessage | null {
    return parseJson(e2eDeviceMessageSchema, raw);
}

/** A message from the computer, or `null` if it is not one. */
export function parseE2EComputerMessage(raw: string): E2EComputerMessage | null {
    return parseJson(e2eComputerMessageSchema, raw);
}

// ---------------------------------------------------------------------------
// Keys

/**
 * A device's identity: Ed25519, the private key not extractable. It can be stored in IndexedDB
 * and used by the page, never read out of the browser.
 */
export async function generateDeviceKeys(): Promise<DeviceKeyPair> {
    return (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
        'sign',
        'verify',
    ])) as DeviceKeyPair;
}

/** Raw public key (32 bytes), base64url. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
    return toBase64url(new Uint8Array(await crypto.subtle.exportKey('raw', key)));
}

/** The computer's signing key, from the room key pair of `projects.json` (raw, base64url). */
export function importRoomSigningKey(keys: { publicKey: string; privateKey: string }) {
    return crypto.subtle.importKey(
        'jwk',
        { kty: 'OKP', crv: 'Ed25519', x: keys.publicKey, d: keys.privateKey },
        { name: 'Ed25519' },
        false,
        ['sign'],
    );
}

function importVerifyKey(publicKey: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', fromBase64url(publicKey), { name: 'Ed25519' }, false, [
        'verify',
    ]);
}

/** The room id a computer key stands for: `sha256(raw public key)`, base64url. */
export async function roomIdOfKey(publicKey: string): Promise<string> {
    return toBase64url(await sha256(fromBase64url(publicKey)));
}

/** True when the browser has what end-to-end encryption needs (Ed25519 and X25519). */
export async function isE2ESupported(): Promise<boolean> {
    try {
        if (!globalThis.crypto?.subtle) return false;
        await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign']);
        await crypto.subtle.generateKey({ name: 'X25519' }, false, ['deriveBits']);
        return true;
    } catch {
        return false;
    }
}

interface Ephemeral {
    keys: DeviceKeyPair;
    publicKey: string;
}

async function ephemeral(): Promise<Ephemeral> {
    const keys = (await crypto.subtle.generateKey({ name: 'X25519' }, false, [
        'deriveBits',
    ])) as DeviceKeyPair;
    return { keys, publicKey: await exportPublicKey(keys.publicKey) };
}

async function sharedSecret(own: Ephemeral, theirs: string): Promise<Uint8Array<ArrayBuffer>> {
    const publicKey = await crypto.subtle.importKey(
        'raw',
        fromBase64url(theirs),
        { name: 'X25519' },
        false,
        [],
    );
    try {
        return new Uint8Array(
            await crypto.subtle.deriveBits(
                { name: 'X25519', public: publicKey },
                own.keys.privateKey,
                256,
            ),
        );
    } catch {
        // A low-order point gives no shared secret: never a key an honest peer sends.
        throw new E2EError('invalid ephemeral key');
    }
}

type Signer = 'computer' | 'device';

async function sign(key: CryptoKey, signer: Signer, transcript: Uint8Array): Promise<string> {
    const message = framed(`${LABEL}/${signer}`, transcript);
    return toBase64url(new Uint8Array(await crypto.subtle.sign('Ed25519', key, message)));
}

async function verify(
    publicKey: string,
    signer: Signer,
    transcript: Uint8Array,
    signature: string,
): Promise<boolean> {
    try {
        const key = await importVerifyKey(publicKey);
        const message = framed(`${LABEL}/${signer}`, transcript);
        return await crypto.subtle.verify('Ed25519', key, fromBase64url(signature), message);
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Sealed channel

type Direction = 'device-to-computer' | 'computer-to-device';

/**
 * Most bytes a message of `plaintextBytes` (UTF-8) takes once sealed, frame included: the
 * ciphertext and its 16-byte tag in base64url, the counter and the JSON around them. Known before
 * sealing: a frame sealed and then not sent leaves a gap in the counter, and the other end
 * refuses everything after it.
 */
export function sealedFrameBytes(plaintextBytes: number): number {
    return Math.ceil(((plaintextBytes + 16) * 4) / 3) + 64;
}

/**
 * One connection's encryption after the handshake: a key per direction, and a counter per
 * direction that must go up by one. A frame out of order, repeated, altered or sent the other way
 * is refused: the caller closes the connection.
 */
export class SecureChannel {
    readonly #sealKey: CryptoKey;
    readonly #openKey: CryptoKey;
    #sent = 0;
    #received = 0;
    /** Sealing in call order, so frames are sent with their counters in order. */
    #sealing: Promise<unknown> = Promise.resolve();
    #opening: Promise<unknown> = Promise.resolve();

    private constructor(sealKey: CryptoKey, openKey: CryptoKey) {
        this.#sealKey = sealKey;
        this.#openKey = openKey;
    }

    static async derive(
        secret: Uint8Array<ArrayBuffer>,
        transcript: Uint8Array<ArrayBuffer>,
        role: Signer,
    ): Promise<SecureChannel> {
        const ikm = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
        const key = (direction: Direction) =>
            crypto.subtle.deriveKey(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt: transcript,
                    info: encoder.encode(`${LABEL}/${direction}`),
                },
                ikm,
                { name: 'AES-GCM', length: 256 },
                false,
                ['encrypt', 'decrypt'],
            );
        const toComputer = await key('device-to-computer');
        const toDevice = await key('computer-to-device');
        return role === 'device'
            ? new SecureChannel(toComputer, toDevice)
            : new SecureChannel(toDevice, toComputer);
    }

    /** Encrypts a message; frames resolve in call order. */
    seal(plaintext: string): Promise<SealedFrame> {
        const n = this.#sent;
        if (n >= Number.MAX_SAFE_INTEGER) return Promise.reject(new E2EError('channel exhausted'));
        this.#sent += 1;
        const frame = this.#sealing.then(async (): Promise<SealedFrame> => {
            const cipher = await crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv(n) },
                this.#sealKey,
                encoder.encode(plaintext),
            );
            return { type: 'sealed', n, c: toBase64url(new Uint8Array(cipher)) };
        });
        this.#sealing = frame.catch(() => undefined);
        return frame;
    }

    /**
     * Decrypts the next frame; rejects with `E2EError` for anything but the next frame, intact.
     * Messages resolve in call order, like frames from `seal`.
     */
    open(frame: SealedFrame): Promise<string> {
        if (frame.n !== this.#received) {
            return Promise.reject(new E2EError('frame out of sequence'));
        }
        this.#received += 1;
        const message = this.#opening.then(async () => {
            try {
                const plain = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: iv(frame.n) },
                    this.#openKey,
                    fromBase64url(frame.c),
                );
                return decoder.decode(plain);
            } catch {
                throw new E2EError('frame rejected');
            }
        });
        this.#opening = message.catch(() => undefined);
        return message;
    }
}

function iv(counter: number): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(IV_BYTES);
    new DataView(bytes.buffer).setBigUint64(4, BigInt(counter));
    return bytes;
}

// ---------------------------------------------------------------------------
// Handshake of a paired device (every connection)

function sessionTranscript(
    roomId: string,
    hello: Pick<E2EHello, 'deviceId' | 'e' | 'n'>,
    welcome: Pick<E2EWelcome, 'e' | 'n'>,
): Promise<Uint8Array<ArrayBuffer>> {
    return sha256(
        framed(
            `${LABEL}/session`,
            roomId,
            hello.deviceId,
            fromBase64url(hello.e),
            fromBase64url(hello.n),
            fromBase64url(welcome.e),
            fromBase64url(welcome.n),
        ),
    );
}

/**
 * Device side. `computerKey` is the room key fixed at pairing. Send `hello`, then pass the
 * computer's `e2e.welcome` to `finish`, send its `auth` and use the channel.
 */
export async function startDeviceHandshake(options: {
    roomId: string;
    deviceId: string;
    deviceKey: CryptoKey;
    computerKey: string;
}): Promise<{
    hello: E2EHello;
    finish(welcome: E2EWelcome): Promise<{ auth: E2EAuth; channel: SecureChannel }>;
}> {
    const own = await ephemeral();
    const hello: E2EHello = {
        type: 'e2e.hello',
        v: E2E_VERSION,
        deviceId: options.deviceId,
        e: own.publicKey,
        n: toBase64url(randomBytes(NONCE_BYTES)),
    };
    return {
        hello,
        async finish(welcome) {
            const transcript = await sessionTranscript(options.roomId, hello, welcome);
            if (!(await verify(options.computerKey, 'computer', transcript, welcome.sig))) {
                throw new E2EError('the computer did not prove its key');
            }
            const secret = await sharedSecret(own, welcome.e);
            return {
                auth: {
                    type: 'e2e.auth',
                    sig: await sign(options.deviceKey, 'device', transcript),
                },
                channel: await SecureChannel.derive(secret, transcript, 'device'),
            };
        },
    };
}

/**
 * Computer side. `devicePublicKey` is the key registered for `hello.deviceId` at pairing. Send
 * `welcome`, then pass the device's `e2e.auth` to `finish`.
 */
export async function acceptDeviceHandshake(options: {
    roomId: string;
    hello: E2EHello;
    computerKey: CryptoKey;
    devicePublicKey: string;
}): Promise<{ welcome: E2EWelcome; finish(auth: E2EAuth): Promise<SecureChannel> }> {
    const own = await ephemeral();
    const answer = { e: own.publicKey, n: toBase64url(randomBytes(NONCE_BYTES)) };
    const transcript = await sessionTranscript(options.roomId, options.hello, answer);
    const welcome: E2EWelcome = {
        type: 'e2e.welcome',
        ...answer,
        sig: await sign(options.computerKey, 'computer', transcript),
    };
    return {
        welcome,
        async finish(auth) {
            if (!(await verify(options.devicePublicKey, 'device', transcript, auth.sig))) {
                throw new E2EError('the device did not prove its key');
            }
            const secret = await sharedSecret(own, options.hello.e);
            return SecureChannel.derive(secret, transcript, 'computer');
        },
    };
}

// ---------------------------------------------------------------------------
// Pairing

/**
 * Everything the device puts in the pairing transcript, committed to before it sees the
 * computer's keys. Nothing of the device's half may stay out: a relay posing as the device could
 * change it after the welcome until the 6-digit number matches the phone's.
 */
interface PairingCommitment {
    deviceId: string;
    name: string;
    pk: string;
    e: string;
    n: string;
}

function commitmentOf(values: PairingCommitment): Promise<Uint8Array<ArrayBuffer>> {
    return sha256(
        framed(
            `${LABEL}/commit`,
            values.deviceId,
            values.name,
            fromBase64url(values.pk),
            fromBase64url(values.e),
            fromBase64url(values.n),
        ),
    );
}

function pairingTranscript(
    roomId: string,
    device: PairingCommitment,
    computer: Pick<PairWelcome, 'pk' | 'e' | 'n'>,
): Promise<Uint8Array<ArrayBuffer>> {
    return sha256(
        framed(
            `${LABEL}/pair`,
            roomId,
            device.deviceId,
            device.name,
            fromBase64url(device.pk),
            fromBase64url(device.e),
            fromBase64url(device.n),
            fromBase64url(computer.pk),
            fromBase64url(computer.e),
            fromBase64url(computer.n),
        ),
    );
}

async function pairKeyMac(pairKey: string, transcript: Uint8Array): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(pairKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return new Uint8Array(
        await crypto.subtle.sign('HMAC', key, framed(`${LABEL}/pair-key`, transcript)),
    );
}

/**
 * The number both screens show when pairing by code: 6 digits from the transcript. A relay in
 * the middle runs two different pairings, whose numbers match once in a million.
 */
export async function pairingNumber(transcript: Uint8Array<ArrayBuffer>): Promise<string> {
    const digest = await sha256(framed(`${LABEL}/number`, transcript));
    const value = new DataView(digest.buffer).getUint32(0) % 1_000_000;
    return value.toString().padStart(6, '0');
}

/** `482913` → `482 913`, as both screens show it. */
export function formatPairingNumber(number: string): string {
    return `${number.slice(0, 3)} ${number.slice(3)}`;
}

/**
 * Device side of a pairing. Send `start`; pass the computer's `pair.welcome` to `reveal` and send
 * the result (`number` is what the screen shows when pairing by code); pass `pair.accept` to
 * `finish`, which gives the channel and the computer key to keep with the pairing.
 */
export async function startDevicePairing(options: {
    roomId: string;
    pairKey: string;
    deviceId: string;
    name: string;
    deviceKeys: DeviceKeyPair;
}): Promise<{
    start: PairStart;
    reveal(welcome: PairWelcome): Promise<{
        reveal: PairReveal;
        number: string;
        finish(accept: PairAccept): Promise<{ channel: SecureChannel; computerKey: string }>;
    }>;
}> {
    // The computer reads the reveal through the schemas: the device commits to the same values.
    const deviceId = deviceIdSchema.safeParse(options.deviceId);
    const name = deviceNameSchema.safeParse(options.name);
    if (!deviceId.success) throw new E2EError('invalid device id');
    if (!name.success) throw new E2EError('invalid device name');
    const own = await ephemeral();
    const device: PairingCommitment = {
        deviceId: deviceId.data,
        name: name.data,
        pk: await exportPublicKey(options.deviceKeys.publicKey),
        e: own.publicKey,
        n: toBase64url(randomBytes(NONCE_BYTES)),
    };
    const start: PairStart = {
        type: 'pair.start',
        v: E2E_VERSION,
        commit: toBase64url(await commitmentOf(device)),
    };
    return {
        start,
        async reveal(welcome) {
            // The room id came with the pairing link or offer: the computer must hold its key.
            if ((await roomIdOfKey(welcome.pk)) !== options.roomId) {
                throw new E2EError('this computer does not hold the key of its room');
            }
            const transcript = await pairingTranscript(options.roomId, device, welcome);
            const reveal: PairReveal = {
                type: 'pair.reveal',
                ...device,
                mac: toBase64url(await pairKeyMac(options.pairKey, transcript)),
                sig: await sign(options.deviceKeys.privateKey, 'device', transcript),
            };
            return {
                reveal,
                number: await pairingNumber(transcript),
                async finish(accept) {
                    if (!(await verify(welcome.pk, 'computer', transcript, accept.sig))) {
                        throw new E2EError('the computer did not prove its key');
                    }
                    const secret = await sharedSecret(own, welcome.e);
                    return {
                        channel: await SecureChannel.derive(secret, transcript, 'device'),
                        computerKey: welcome.pk,
                    };
                },
            };
        },
    };
}

/** What the computer registers for a device that paired. */
export interface PairedDevice {
    deviceId: string;
    name: string;
    publicKey: string;
}

/**
 * Computer side of a pairing. Send `welcome`; pass the device's `pair.reveal` and the pairing
 * keys still valid to `finish`. It checks the commitment, finds the key the device proved and the
 * device's signature, and returns what to answer and to register.
 */
export async function acceptDevicePairing(options: {
    roomId: string;
    start: PairStart;
    computerKey: CryptoKey;
    computerPublicKey: string;
}): Promise<{
    welcome: PairWelcome;
    finish(
        reveal: PairReveal,
        pairKeys: readonly string[],
    ): Promise<{
        accept: PairAccept;
        channel: SecureChannel;
        device: PairedDevice;
        pairKey: string;
        number: string;
    }>;
}> {
    const own = await ephemeral();
    const welcome: PairWelcome = {
        type: 'pair.welcome',
        pk: options.computerPublicKey,
        e: own.publicKey,
        n: toBase64url(randomBytes(NONCE_BYTES)),
    };
    return {
        welcome,
        async finish(reveal, pairKeys) {
            const committed = await commitmentOf(reveal);
            if (!equalBytes(committed, fromBase64url(options.start.commit))) {
                throw new E2EError('the device changed what it committed to');
            }
            const transcript = await pairingTranscript(options.roomId, reveal, welcome);
            const mac = fromBase64url(reveal.mac);
            let pairKey: string | undefined;
            for (const candidate of pairKeys) {
                if (equalBytes(await pairKeyMac(candidate, transcript), mac)) pairKey = candidate;
            }
            if (pairKey === undefined) throw new E2EError('invalid or expired pairing key');
            if (!(await verify(reveal.pk, 'device', transcript, reveal.sig))) {
                throw new E2EError('the device did not prove its key');
            }
            const secret = await sharedSecret(own, reveal.e);
            return {
                accept: {
                    type: 'pair.accept',
                    sig: await sign(options.computerKey, 'computer', transcript),
                },
                channel: await SecureChannel.derive(secret, transcript, 'computer'),
                device: { deviceId: reveal.deviceId, name: reveal.name, publicKey: reveal.pk },
                pairKey,
                number: await pairingNumber(transcript),
            };
        },
    };
}

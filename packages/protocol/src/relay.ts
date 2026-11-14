import { z } from 'zod';
import { computerNameSchema, pairKeySchema } from './schemas';
import { cliReleaseSchema } from './version';

/**
 * Relay protocol. The relay is public, anonymous and stateless: it knows rooms only while a
 * daemon keeps them open, and forwards the Device protocol messages (hello, op, ...) between
 * phones and the daemon without reading them.
 *
 * - Phones connect to `/ws?room=<roomId>`.
 * - Daemons connect to `/daemon` and prove, for every room, that they hold the room's Ed25519
 *   private key: `roomId = base64url(sha256(publicKey))`, signature over the relay's nonce.
 * - An app without a pairing (e.g. added to the Home Screen, which does not share the browser's
 *   storage) connects to `/wait` and shows the code it gets; `palmtop pair CODE` makes the daemon
 *   send a single-use pairing key to that phone through the relay.
 */

export const RELAY_DEVICE_PATH = '/ws';
export const RELAY_DAEMON_PATH = '/daemon';
export const RELAY_WAIT_PATH = '/wait';
export const ROOM_QUERY_PARAM = 'room';
/**
 * Anonymous random id of a device, for statistic purposes only (distinct devices on the relay).
 * Not the device id of the sync protocol; the relay stores only a salted hash of it.
 */
export const STATS_ID_QUERY_PARAM = 'd';
export const statsIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Close codes of the device WebSocket (application range 4000-4999). */
export const CloseCode = {
    /** Not paired (or not any more), or a handshake that failed: do not retry as is. */
    unauthorized: 4401,
    forbidden: 4403,
    helloTimeout: 4408,
    /** Too many connections or messages: retry later. */
    rateLimited: 4429,
    /** The daemon's protocol is too old for this relay: run `palmtop update`. */
    outdated: 4426,
    /** No daemon holds the room right now (computer off or offline): retry later. */
    daemonOffline: 4503,
} as const;

/** Phone message limit, enforced by the relay and by the daemon. */
export const MAX_DEVICE_MESSAGE_BYTES = 256 * 1024;
/**
 * Daemon message limit, enforced by the relay: over it the relay closes the daemon's connection,
 * and every device with it. The daemon keeps each message to a device below it.
 */
export const MAX_DAEMON_MESSAGE_BYTES = 8 * 1024 * 1024;

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64_BYTES = /^[A-Za-z0-9_-]{86}$/;

/** sha256 of the room public key, base64url without padding. */
export const roomIdSchema = z.string().regex(BASE64URL_32_BYTES, 'invalid room id');
/** Raw 32-byte Ed25519 public key, base64url without padding. */
export const publicKeySchema = z.string().regex(BASE64URL_32_BYTES, 'invalid public key');
/** Ed25519 signature (64 bytes), base64url without padding. */
export const signatureSchema = z.string().regex(BASE64URL_64_BYTES, 'invalid signature');
export const connIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid connection id');
export const nonceSchema = z.string().regex(BASE64URL_32_BYTES, 'invalid nonce');

/**
 * Pairing codes: Crockford base32 (no I, L, O, U), typed by the user on the computer. A code only
 * says which waiting phone gets a pairing key: guessing one gives nothing, the key goes from the
 * computer to the phone.
 */
export const PAIR_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIR_CODE_LENGTH = 6;
/** A waiting phone gets a new code this often, and after every delivery. */
export const PAIR_CODE_TTL_MS = 5 * 60_000;
export const pairCodeSchema = z
    .string()
    .regex(new RegExp(`^[${PAIR_CODE_ALPHABET}]{${PAIR_CODE_LENGTH}}$`), 'invalid pairing code');

/**
 * What the user typed → a code, or null. Case, spaces and dashes don't matter, and the letters
 * Crockford base32 leaves out read as the digits they look like (O → 0, I and L → 1).
 */
export function normalizePairCode(input: string): string | null {
    const code = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return pairCodeSchema.safeParse(code).success ? code : null;
}

export const pairOfferStatusSchema = z.enum(['delivered', 'unknown_code', 'rate_limited']);
export type PairOfferStatus = z.infer<typeof pairOfferStatusSchema>;
const pairOfferIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);

/** Relay → waiting phone (`/wait`). */
export const waitMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('pair.code'), code: pairCodeSchema, expiresAt: z.number().int() }),
    /** A computer sent a pairing key: the phone confirms, then redeems it on `room`. */
    z.object({
        type: z.literal('pair.offer'),
        room: roomIdSchema,
        key: pairKeySchema,
        computer: computerNameSchema,
    }),
]);
export type WaitMessage = z.infer<typeof waitMessageSchema>;

/** The bytes a daemon signs to open a room on one relay connection. */
export function roomChallenge(nonce: string, roomId: string): string {
    return `palmtop-relay-v1|${nonce}|${roomId}`;
}

const roomProofSchema = z.object({
    publicKey: publicKeySchema,
    signature: signatureSchema,
    /**
     * The room belongs to a person the computer shares checklists with, not to the computer: the
     * relay counts it apart in its statistics. Only that; a relay that does not know the field
     * drops it.
     */
    guest: z.boolean().optional(),
});

export const relayErrorCodeSchema = z.enum([
    'invalid_message',
    'unauthorized',
    'rate_limited',
    'too_many_rooms',
    'outdated',
]);

const pingSchema = z.object({ type: z.literal('ping') });
const pongSchema = z.object({ type: z.literal('pong') });

/** Relay → daemon. */
export const relayMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('challenge'), nonce: nonceSchema }),
    /** `sessionToken` is random, lives only in memory and only for this connection. */
    z.object({
        type: z.literal('authorized'),
        sessionToken: z.string().regex(BASE64URL_32_BYTES),
        rooms: z.array(roomIdSchema),
        /** The CLI published on this relay, when there is one: daemons tell users to update. */
        release: cliReleaseSchema.pick({ version: true, build: true }).optional(),
    }),
    z.object({ type: z.literal('room.opened'), room: roomIdSchema }),
    /**
     * This connection no longer serves the room: another connection proved the same key, or the
     * daemon asked for it with `room.close`.
     */
    z.object({ type: z.literal('room.closed'), room: roomIdSchema }),
    z.object({ type: z.literal('device.open'), conn: connIdSchema, room: roomIdSchema }),
    z.object({ type: z.literal('device.message'), conn: connIdSchema, data: z.string() }),
    z.object({ type: z.literal('device.close'), conn: connIdSchema }),
    z.object({
        type: z.literal('pair.offer.result'),
        id: pairOfferIdSchema,
        status: pairOfferStatusSchema,
    }),
    z.object({ type: z.literal('error'), code: relayErrorCodeSchema, message: z.string() }),
    pingSchema,
    pongSchema,
]);

/** Daemon → relay. */
export const daemonMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('auth'),
        rooms: z.array(roomProofSchema),
        /** `DAEMON_PROTOCOL_VERSION`; absent = 1. */
        protocol: z.number().int().min(1).optional(),
    }),
    z.object({
        type: z.literal('room.open'),
        sessionToken: z.string().regex(BASE64URL_32_BYTES),
        ...roomProofSchema.shape,
    }),
    /**
     * The daemon no longer serves this room: the relay frees it (and its slot of the limit) and
     * closes its phones. The answer is `room.closed`.
     */
    z.object({
        type: z.literal('room.close'),
        sessionToken: z.string().regex(BASE64URL_32_BYTES),
        room: roomIdSchema,
    }),
    /** Same data to one or more phones of rooms held by this connection. */
    z.object({
        type: z.literal('device.send'),
        conns: z.array(connIdSchema).min(1),
        data: z.string(),
    }),
    z.object({
        type: z.literal('device.close'),
        conn: connIdSchema,
        code: z.number().int().min(4000).max(4999),
        reason: z.string().max(100),
    }),
    /** A pairing key for the phone showing `code`, on a room held by this connection. */
    z.object({
        type: z.literal('pair.offer'),
        id: pairOfferIdSchema,
        code: pairCodeSchema,
        room: roomIdSchema,
        key: pairKeySchema,
        computer: computerNameSchema,
    }),
    pingSchema,
    pongSchema,
]);

export type RelayMessage = z.infer<typeof relayMessageSchema>;
export type DaemonMessage = z.infer<typeof daemonMessageSchema>;
export type RelayErrorCode = z.infer<typeof relayErrorCodeSchema>;

function parseJson<T>(schema: z.ZodType<T>, raw: string): T | null {
    try {
        const result = schema.safeParse(JSON.parse(raw));
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

export function parseRelayMessage(raw: string): RelayMessage | null {
    return parseJson(relayMessageSchema, raw);
}

export function parseDaemonMessage(raw: string): DaemonMessage | null {
    return parseJson(daemonMessageSchema, raw);
}

export function parseWaitMessage(raw: string): WaitMessage | null {
    return parseJson(waitMessageSchema, raw);
}

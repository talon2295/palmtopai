import {
    createHash,
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    randomBytes,
    sign,
    verify,
} from 'node:crypto';
import { roomChallenge } from './relay';

/**
 * Room keys for the relay (Node and Bun only: not exported by the package index, so the web app
 * never bundles `node:crypto`). Keys are raw 32-byte Ed25519 values, base64url.
 */

export interface RoomKeyPair {
    publicKey: string;
    privateKey: string;
}

export function generateRoomKeyPair(): RoomKeyPair {
    const { privateKey } = generateKeyPairSync('ed25519');
    const jwk = privateKey.export({ format: 'jwk' });
    if (!jwk.x || !jwk.d) throw new Error('unexpected Ed25519 key export');
    return { publicKey: jwk.x, privateKey: jwk.d };
}

export function roomIdOf(publicKey: string): string {
    return createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('base64url');
}

export function randomNonce(): string {
    return randomBytes(32).toString('base64url');
}

export function signRoomChallenge(keys: RoomKeyPair, nonce: string): string {
    const key = createPrivateKey({
        key: { kty: 'OKP', crv: 'Ed25519', x: keys.publicKey, d: keys.privateKey },
        format: 'jwk',
    });
    const message = Buffer.from(roomChallenge(nonce, roomIdOf(keys.publicKey)));
    return sign(null, message, key).toString('base64url');
}

/** Returns the room id proven by the signature, or `null` if the proof is invalid. */
export function verifyRoomProof(
    proof: { publicKey: string; signature: string },
    nonce: string,
): string | null {
    try {
        const key = createPublicKey({
            key: { kty: 'OKP', crv: 'Ed25519', x: proof.publicKey },
            format: 'jwk',
        });
        const roomId = roomIdOf(proof.publicKey);
        const message = Buffer.from(roomChallenge(nonce, roomId));
        return verify(null, message, key, Buffer.from(proof.signature, 'base64url'))
            ? roomId
            : null;
    } catch {
        return null;
    }
}

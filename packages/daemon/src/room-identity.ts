import { importRoomSigningKey } from '@palmtopai/protocol';
import { type RoomKeyPair, roomIdOf, signRoomChallenge } from '@palmtopai/protocol/relay-crypto';

/**
 * The key pair of one relay room, with what the key is used for: the room id the devices pin, the
 * proof the relay asks for, and the signing key of the end-to-end handshakes. The computer has
 * one room; every person a checklist is shared with has another, so that their devices can
 * reach nothing of the computer's. The private key never leaves this class: only signatures do.
 */
export class RoomIdentity {
    readonly roomId: string;
    readonly #keys: RoomKeyPair;
    #signingKey: ReturnType<typeof importRoomSigningKey> | undefined;

    constructor(keys: RoomKeyPair) {
        this.#keys = keys;
        this.roomId = roomIdOf(keys.publicKey);
    }

    /** Public room key: the identity devices pin when they pair (`sha256` of it is `roomId`). */
    get roomPublicKey(): string {
        return this.#keys.publicKey;
    }

    /** The room key as a WebCrypto signing key, for the end-to-end handshakes. */
    signingKey(): ReturnType<typeof importRoomSigningKey> {
        this.#signingKey ??= importRoomSigningKey(this.#keys);
        return this.#signingKey;
    }

    /** Proves to the relay that this daemon holds the key of the room. */
    roomProof(nonce: string): { publicKey: string; signature: string } {
        return {
            publicKey: this.#keys.publicKey,
            signature: signRoomChallenge(this.#keys, nonce),
        };
    }
}

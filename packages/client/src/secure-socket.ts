import {
    CloseCode,
    E2EError,
    parseE2EComputerMessage,
    type SecureChannel,
    startDeviceHandshake,
} from '@palmtopai/protocol';
import type { SocketLike } from './sync-client';

const CONNECTING = 0;
const OPEN = 1;

/** What a paired device keeps to connect to its computer, end to end. */
export interface DeviceIdentity {
    /** Room of the computer on the relay: `sha256` of `computerKey`. */
    roomId: string;
    deviceId: string;
    /** The device's private key (Ed25519, not extractable). */
    deviceKey: CryptoKey;
    /** The computer's room key, fixed at pairing. */
    computerKey: string;
}

/**
 * Wraps a relay socket in the end-to-end encryption of `e2e.ts`. On open it runs the handshake
 * (the computer proves its room key, the device its own key); only then does the wrapper report
 * `open`. From there `send` seals and incoming frames are opened, in order: the caller sees the
 * plain device protocol, the relay only sealed frames. A handshake that fails closes the socket
 * with `CloseCode.unauthorized`: the computer is not the one this device paired with, or no
 * longer knows this device.
 */
export function secureSocket(raw: SocketLike, identity: DeviceIdentity): SocketLike {
    let channel: SecureChannel | null = null;
    let closed = false;
    /**
     * What the computer said in plain before closing (e.g. "not paired"), for the close event.
     * It can come after this side opened the channel: the computer checks the device's signature
     * only then. Nothing is sent once it came.
     */
    let refusal: string | undefined;
    let finishing: Promise<void> | null = null;
    /** Messages are handed over in order, and the close only after them. */
    let delivering: Promise<void> = Promise.resolve();

    const wrapper: SocketLike = {
        get readyState() {
            if (channel === null && raw.readyState === OPEN) return CONNECTING;
            return raw.readyState;
        },
        onopen: null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send(data: string) {
            const ready = channel;
            if (!ready) throw new Error('secure socket not open');
            // Refused: the socket is closing, what is sent now would go nowhere.
            if (refusal !== undefined) return;
            void ready.seal(data).then((frame) => {
                if (raw.readyState === OPEN) raw.send(JSON.stringify(frame));
            });
        },
        close(code?: number, reason?: string) {
            raw.close(code, reason);
        },
    };

    const fail = (reason: string) => {
        if (closed) return;
        closed = true;
        try {
            raw.close(CloseCode.unauthorized, reason);
        } catch {
            // Already closed.
        }
        wrapper.onclose?.({ code: CloseCode.unauthorized, reason: refusal ?? reason });
    };

    const handshake = startDeviceHandshake({
        roomId: identity.roomId,
        deviceId: identity.deviceId,
        deviceKey: identity.deviceKey,
        computerKey: identity.computerKey,
    });

    raw.onopen = () => {
        handshake.then(
            ({ hello }) => {
                if (raw.readyState === OPEN) raw.send(JSON.stringify(hello));
            },
            () => fail('handshake failed'),
        );
    };

    raw.onmessage = (event) => {
        const message = parseE2EComputerMessage(String(event.data));
        // Anything else is the computer's plain error before it closes (the relay sends devices
        // nothing of its own): the reason of the close that follows, e.g. an unknown device or a
        // key that is not the one this device paired with.
        if (!message) {
            refusal = plainErrorMessage(event.data) ?? refusal;
            return;
        }
        if (!channel) {
            if (message.type !== 'e2e.welcome' || finishing) return;
            finishing = handshake
                .then(({ finish }) => finish(message))
                .then(({ auth, channel: established }) => {
                    if (closed || raw.readyState !== OPEN) return;
                    raw.send(JSON.stringify(auth));
                    channel = established;
                    wrapper.onopen?.({});
                })
                .catch((error: unknown) =>
                    fail(error instanceof E2EError ? error.message : 'handshake failed'),
                );
            return;
        }
        if (message.type !== 'sealed') return;
        const opened = channel.open(message);
        delivering = delivering.then(() =>
            opened.then(
                (data) => {
                    if (!closed) wrapper.onmessage?.({ data });
                },
                () => fail('frame rejected'),
            ),
        );
    };

    raw.onerror = (event) => wrapper.onerror?.(event);
    raw.onclose = (event) => {
        // A last message (e.g. why the computer closes) is handed over before the close.
        void delivering.then(() => {
            if (closed) return;
            closed = true;
            wrapper.onclose?.(
                refusal === undefined ? event : { code: event.code, reason: refusal },
            );
        });
    };

    return wrapper;
}

function plainErrorMessage(data: unknown): string | undefined {
    try {
        const parsed = JSON.parse(String(data)) as { type?: unknown; message?: unknown };
        return parsed.type === 'error' && typeof parsed.message === 'string'
            ? parsed.message.slice(0, 200)
            : undefined;
    } catch {
        return undefined;
    }
}

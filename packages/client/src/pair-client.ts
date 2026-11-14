import {
    type DeviceKeyPair,
    E2EError,
    parseE2EComputerMessage,
    parseServerMessage,
    type SecureChannel,
    startDevicePairing,
} from '@palmtopai/protocol';
import type { SocketLike } from './sync-client';

export interface PairDeviceOptions {
    /** Relay WebSocket URL of the computer's room, e.g. `wss://host/ws?room=<roomId>`. */
    url: string;
    /** From the pairing link or offer: the computer must hold the key of this room. */
    roomId: string;
    /** Single-use key from a QR code, a pairing link or a pairing code. It never travels. */
    pairKey: string;
    deviceId: string;
    /** Shown in `palmtop devices` and next to the number ("iPhone · Safari"). */
    name: string;
    deviceKeys: DeviceKeyPair;
    /**
     * Pairing by code: shows the 6-digit number and resolves with the user's answer, "the same
     * as on the computer" or not. The pairing is kept only with a yes here *and* on the
     * computer: a relay in the middle could pose as the computer towards this device, and only
     * the user comparing the numbers sees it.
     */
    confirmNumber?: (number: string) => Promise<boolean>;
    createSocket?: (url: string) => SocketLike;
    /** How long to wait for the computer; pairing by code waits for a person, give it minutes. */
    timeoutMs?: number;
}

/** What the device keeps once paired. */
export interface Pairing {
    computerId: string;
    /** Name of the computer at pairing time. */
    computer: string;
    /** The computer's room key, which every later handshake must prove. */
    computerKey: string;
}

export class PairError extends Error {
    override name = 'PairError';
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Pairs this device with a computer on a connection of its own (`e2e.ts`): it proves the
 * single-use key without sending it, checks that the computer holds the key of its room, and
 * waits until the computer registered it (with a pairing code, after the user compared the number
 * on the computer). A used, expired or revoked key, or a computer that is not the room's, is
 * rejected.
 */
export function pairDevice(options: PairDeviceOptions): Promise<Pairing> {
    const create = options.createSocket ?? ((url: string) => new WebSocket(url) as SocketLike);
    return new Promise<Pairing>((resolve, reject) => {
        let socket: SocketLike;
        try {
            socket = create(options.url);
        } catch (error) {
            reject(new PairError((error as Error).message));
            return;
        }
        let settled = false;
        let channel: SecureChannel | null = null;
        let computerKey = '';
        const finish = (result: Pairing | PairError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try {
                socket.close();
            } catch {
                // Already closing: nothing to do.
            }
            if (result instanceof PairError) reject(result);
            else resolve(result);
        };
        const failWith = (error: unknown) =>
            finish(
                new PairError(error instanceof E2EError ? error.message : 'pairing did not work'),
            );
        const timer = setTimeout(
            () => finish(new PairError('the computer did not answer')),
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );

        const pairing = startDevicePairing({
            roomId: options.roomId,
            pairKey: options.pairKey,
            deviceId: options.deviceId,
            name: options.name,
            deviceKeys: options.deviceKeys,
        });
        // Rejected (e.g. an invalid name) before the socket opens: reported on open, not unhandled.
        pairing.catch(() => {});
        let revealed: Awaited<ReturnType<Awaited<typeof pairing>['reveal']>> | null = null;
        /** The user's answer about the number; always yes without `confirmNumber` (QR, link). */
        let numberConfirmed: Promise<boolean> = Promise.resolve(true);
        // Messages one at a time: the accept must be handled before the sealed `paired`.
        let queue: Promise<void> = Promise.resolve();

        socket.onopen = () => {
            pairing.then(({ start }) => socket.send(JSON.stringify(start)), failWith);
        };
        socket.onmessage = (event) => {
            const raw = String((event as { data: unknown }).data);
            queue = queue.then(() => handle(raw)).catch(failWith);
        };
        // After the messages that arrived before: the computer says why before it closes.
        socket.onerror = () => {
            queue = queue.then(() => finish(new PairError('cannot reach the relay')));
        };
        socket.onclose = () => {
            queue = queue.then(() => finish(new PairError('this pairing is not valid any more')));
        };

        async function handle(raw: string): Promise<void> {
            const message = parseE2EComputerMessage(raw);
            if (!message) return;
            if (message.type === 'pair.welcome' && !revealed) {
                revealed = await (await pairing).reveal(message);
                socket.send(JSON.stringify(revealed.reveal));
                const confirmNumber = options.confirmNumber;
                if (confirmNumber) {
                    numberConfirmed = confirmNumber(revealed.number);
                    // A no ends the pairing right away: the computer sees the device go.
                    void numberConfirmed.then(
                        (same) => {
                            if (!same) finish(new PairError('the numbers did not match'));
                        },
                        () => finish(new PairError('pairing did not work')),
                    );
                }
                return;
            }
            if (message.type === 'pair.accept' && revealed && !channel) {
                ({ channel, computerKey } = await revealed.finish(message));
                return;
            }
            if (message.type === 'sealed' && channel) {
                const parsed = parseServerMessage(await channel.open(message));
                if (!parsed.ok) return;
                const answer = parsed.value;
                if (answer.type === 'paired') {
                    if (!(await numberConfirmed)) return;
                    finish({
                        computerId: answer.computer.id,
                        computer: answer.computer.name,
                        computerKey,
                    });
                } else if (answer.type === 'error') {
                    finish(new PairError(answer.message));
                }
            }
        }
    });
}

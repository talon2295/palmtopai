import { parseWaitMessage } from '@palmtopai/protocol';
import type { SocketLike } from './sync-client';

/** A computer's pairing key, sent by `palmtop pair CODE` to this device. */
export interface PairOffer {
    room: string;
    key: string;
    computer: string;
}

/** `connecting` until the relay gives a code, `offline` between attempts. */
export type PairWaitState =
    | { status: 'connecting' }
    | { status: 'waiting'; code: string; expiresAt: number }
    | { status: 'offline' };

export interface PairWaitOptions {
    /** Relay WebSocket URL of the waiting room, e.g. `wss://host/wait`. */
    url: string;
    onState: (state: PairWaitState) => void;
    onOffer: (offer: PairOffer) => void;
    createSocket?: (url: string) => SocketLike;
    minRetryMs?: number;
    maxRetryMs?: number;
}

/**
 * Keeps a connection to the relay's `/wait` while the app shows a pairing code: the relay gives
 * a code (renewed every few minutes and after each use), and forwards the pairing key of the
 * computer where the user typed it. Reconnects with backoff until `stop()`.
 */
export function waitForPairing(options: PairWaitOptions): { stop: () => void } {
    const create = options.createSocket ?? ((url: string) => new WebSocket(url) as SocketLike);
    const minRetryMs = options.minRetryMs ?? 1_000;
    const maxRetryMs = options.maxRetryMs ?? 30_000;
    let socket: SocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
        if (stopped) return;
        options.onState({ status: 'connecting' });
        let current: SocketLike;
        try {
            current = create(options.url);
        } catch {
            retry();
            return;
        }
        socket = current;
        current.onmessage = (event) => {
            if (socket !== current) return;
            const message = parseWaitMessage(String((event as { data: unknown }).data));
            if (!message) return;
            attempt = 0;
            if (message.type === 'pair.code') {
                options.onState({
                    status: 'waiting',
                    code: message.code,
                    expiresAt: message.expiresAt,
                });
            } else {
                options.onOffer({
                    room: message.room,
                    key: message.key,
                    computer: message.computer,
                });
            }
        };
        const lost = () => {
            if (socket !== current) return;
            socket = null;
            retry();
        };
        current.onerror = lost;
        current.onclose = lost;
    };

    const retry = () => {
        if (stopped) return;
        options.onState({ status: 'offline' });
        const delay = Math.min(maxRetryMs, minRetryMs * 2 ** attempt);
        attempt += 1;
        timer = setTimeout(connect, delay);
    };

    connect();
    return {
        stop() {
            stopped = true;
            clearTimeout(timer);
            const current = socket;
            socket = null;
            try {
                current?.close();
            } catch {
                // Already closed.
            }
        },
    };
}

import { describe, expect, test } from 'bun:test';
import type { WaitMessage } from '@palmtopai/protocol';
import { type PairOffer, type PairWaitState, type SocketLike, waitForPairing } from '../src';

class WaitSocket implements SocketLike {
    readyState = 1;
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;
    closed = false;

    send(): void {}
    close(): void {
        this.closed = true;
    }
    receive(message: WaitMessage | string): void {
        this.onmessage?.({
            data: typeof message === 'string' ? message : JSON.stringify(message),
        });
    }
    drop(): void {
        this.onclose?.({ code: 1006 });
    }
}

function start() {
    const sockets: WaitSocket[] = [];
    const urls: string[] = [];
    const states: PairWaitState[] = [];
    const offers: PairOffer[] = [];
    const waiting = waitForPairing({
        url: 'wss://relay.example/wait',
        onState: (state) => states.push(state),
        onOffer: (offer) => offers.push(offer),
        createSocket: (url) => {
            urls.push(url);
            const socket = new WaitSocket();
            sockets.push(socket);
            return socket;
        },
        minRetryMs: 5,
        maxRetryMs: 10,
    });
    return { sockets, urls, states, offers, waiting };
}

const ROOM = 'r'.repeat(43);
const KEY = 'k'.repeat(22);

describe('waitForPairing', () => {
    test('shows the codes the relay gives and passes on the offer', () => {
        const { sockets, urls, states, offers, waiting } = start();
        expect(urls).toEqual(['wss://relay.example/wait']);
        expect(states).toEqual([{ status: 'connecting' }]);

        const socket = sockets[0] as WaitSocket;
        socket.receive({ type: 'pair.code', code: 'ABC123', expiresAt: 1 });
        socket.receive('not json');
        socket.receive({ type: 'pair.offer', room: ROOM, key: KEY, computer: 'MAC' });
        socket.receive({ type: 'pair.code', code: 'DEF456', expiresAt: 2 });
        expect(states.slice(1)).toEqual([
            { status: 'waiting', code: 'ABC123', expiresAt: 1 },
            { status: 'waiting', code: 'DEF456', expiresAt: 2 },
        ]);
        expect(offers).toEqual([{ room: ROOM, key: KEY, computer: 'MAC' }]);

        waiting.stop();
        expect(socket.closed).toBe(true);
    });

    test('reconnects after a drop until stopped', async () => {
        const { sockets, states, waiting } = start();
        (sockets[0] as WaitSocket).drop();
        expect(states.at(-1)).toEqual({ status: 'offline' });
        for (let i = 0; i < 50 && sockets.length < 2; i++) await Bun.sleep(5);
        expect(sockets).toHaveLength(2);
        expect(states.at(-1)).toEqual({ status: 'connecting' });

        waiting.stop();
        (sockets[1] as WaitSocket).drop();
        await Bun.sleep(30);
        expect(sockets).toHaveLength(2);
    });
});

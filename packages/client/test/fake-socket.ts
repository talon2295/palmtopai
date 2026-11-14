import type { ServerMessage } from '@palmtopai/protocol';
import type { SocketLike } from '../src';

/** Scripted socket for protocol edge cases that a real daemon never produces. */
export class FakeSocket implements SocketLike {
    static instances: FakeSocket[] = [];
    readyState = 0;
    sent: unknown[] = [];
    closedWith: number | undefined;
    onopen: SocketLike['onopen'] = null;
    onmessage: SocketLike['onmessage'] = null;
    onclose: SocketLike['onclose'] = null;
    onerror: SocketLike['onerror'] = null;

    constructor() {
        FakeSocket.instances.push(this);
    }

    open() {
        this.readyState = 1;
        this.onopen?.({});
    }

    receive(message: ServerMessage) {
        this.onmessage?.({ data: JSON.stringify(message) });
    }

    send(data: string) {
        this.sent.push(JSON.parse(data));
    }

    /** `reason`: what the computer said before closing, as the secure socket reports it. */
    close(code = 1000, reason?: string) {
        this.closedWith = code;
        this.readyState = 3;
        queueMicrotask(() => this.onclose?.(reason === undefined ? { code } : { code, reason }));
    }
}

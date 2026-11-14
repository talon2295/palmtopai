#!/usr/bin/env bun
/**
 * Demo: the agent writes a checklist, two simulated devices (phone, tablet) review it in
 * realtime through the relay, the tablet goes offline and catches up with `lastSeq`.
 *
 * Runs a throwaway relay and daemon (temp dir). The computer token is read from that temp dir only to
 * open the sockets and is never printed.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyAll,
    createId,
    createOp,
    type Item,
    listItems,
    type Op,
    type OpOf,
    type OpType,
    type ProjectState,
    parseServerMessage,
    type ServerMessage,
} from '@palmtopai/protocol';
import { startRelay } from '@palmtopai/relay';
import { startDaemon } from '../src';

const MARKS = { done: 'V', cancelled: 'X', question: '?' } as const;

function render(items: Item[]): string {
    return items
        .map((item) => {
            const mark = item.status ? MARKS[item.status] : ' ';
            return `      [${mark}] ${item.text}${item.note ? `  — "${item.note}"` : ''}`;
        })
        .join('\n');
}

interface Room {
    roomId: string;
    projectId: string;
    token: string;
}

class Device {
    readonly name: string;
    state: ProjectState | null = null;
    /** Projects of the paired computer, as the daemon lists them. */
    projects = 0;
    seq = 0;
    lamport = 0;
    #ws: WebSocket | null = null;
    #waiters: Array<(message: ServerMessage) => void> = [];

    constructor(name: string) {
        this.name = name;
    }

    async connect(relayPort: number, room: Room, resume = false): Promise<void> {
        const { roomId, projectId, token } = room;
        const ws = new WebSocket(`ws://127.0.0.1:${relayPort}/ws?room=${roomId}`);
        this.#ws = ws;
        await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
        ws.addEventListener('message', (event) => {
            const parsed = parseServerMessage(String(event.data));
            if (!parsed.ok) throw new Error(parsed.error);
            this.#receive(parsed.value);
        });
        const synced = this.#nextSync();
        ws.send(
            JSON.stringify({
                type: 'hello',
                projectId,
                token,
                deviceId: this.name,
                ...(resume && { lastSeq: this.seq }),
            }),
        );
        const message = await synced;
        const detail =
            message.type === 'ops'
                ? `caught up with ${message.ops.length} missed ops`
                : `full snapshot at seq ${this.seq}`;
        log(this.name, `connected, ${this.projects} project(s) on the computer, ${detail}`);
    }

    disconnect(): Promise<void> {
        const ws = this.#ws;
        if (!ws) return Promise.resolve();
        const closed = new Promise<void>((resolve) =>
            ws.addEventListener('close', () => resolve(), { once: true }),
        );
        ws.close();
        this.#ws = null;
        log(this.name, 'went offline');
        return closed;
    }

    send<T extends OpType>(sessionId: string, type: T, payload: OpOf<T>['payload']): Op {
        if (!this.state || !this.#ws) throw new Error('not connected');
        this.lamport = Math.max(this.lamport, this.state.lamport) + 1;
        const op = createOp({
            projectId: this.state.projectId,
            sessionId,
            type,
            payload,
            clock: { lamport: this.lamport, deviceId: this.name },
        });
        this.#ws.send(JSON.stringify({ type: 'op', op }));
        return op;
    }

    /** Resolves once this device has received the op with the given id. */
    waitFor(opId: string): Promise<void> {
        return new Promise((resolve) => {
            const check = (message: ServerMessage) => {
                if (message.type === 'op' && message.op.opId === opId) resolve();
                else this.#waiters.push(check);
            };
            this.#waiters.push(check);
        });
    }

    /** The project list arrives before the sync: wait for the snapshot or the missed ops. */
    #nextSync(): Promise<ServerMessage> {
        return new Promise((resolve) => {
            const check = (message: ServerMessage) => {
                if (message.type === 'snapshot' || message.type === 'ops') resolve(message);
                else this.#waiters.push(check);
            };
            this.#waiters.push(check);
        });
    }

    #receive(message: ServerMessage): void {
        if (message.type === 'snapshot') {
            this.state = message.state;
            this.seq = message.seq;
        } else if (message.type === 'ops' && this.state) {
            this.state = applyAll(
                this.state,
                message.ops.map((entry) => entry.op),
            );
            this.seq = message.seq;
        } else if (message.type === 'op' && this.state) {
            this.state = applyAll(this.state, [message.op]);
            this.seq = message.seq;
        } else if (message.type === 'projects') {
            this.projects = message.projects.length;
        } else if (message.type === 'error') {
            log(this.name, `error ${message.code}: ${message.message}`);
        }
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const waiter of waiters) waiter(message);
    }
}

function log(who: string, message: string): void {
    console.log(`${who.padEnd(7)} │ ${message}`);
}

function show(device: Device, checklistId: string): void {
    if (!device.state) return;
    console.log(`        │ ${device.name} sees (seq ${device.seq}):`);
    console.log(render(listItems(device.state, checklistId)));
}

const home = await mkdtemp(join(tmpdir(), 'palmtop-demo-'));
const relay = startRelay({ port: 0, log: () => {} });
const daemon = await startDaemon({
    home,
    localPort: 0,
    relayUrl: `ws://127.0.0.1:${relay.port}`,
    log: () => {},
});

try {
    const { projectId } = await daemon.registry.resolve({ rootPath: '/tmp/palmtop-demo-repo' });
    const registry = JSON.parse(await readFile(join(home, 'projects.json'), 'utf8')) as {
        computer: { token: string };
    };
    const token = registry.computer.token;
    const roomId = daemon.registry.roomId;
    while (!daemon.relay.isRoomOpen(roomId)) await Bun.sleep(10);
    const target: Room = { roomId, projectId, token };
    log('daemon', `connected to the relay, room ${roomId.slice(0, 6)}… open`);

    const room = await daemon.rooms.get(projectId);
    if (!room) throw new Error('room not found');
    const sessionId = createId();
    const checklistId = createId();
    const items = [createId(), createId(), createId()] as const;

    log('agent', 'creates session and checklist "Refactor auth"');
    await room.submitLocal('session.upsert', sessionId, {
        title: 'main · demo',
        branch: 'main',
        startedAt: Date.now(),
    });
    await room.submitLocal('checklist.create', sessionId, { checklistId, title: 'Refactor auth' });
    for (const [order, text] of [
        'Extract token service',
        'Add rate limit',
        'Drop legacy endpoint',
    ].entries()) {
        await room.submitLocal('item.add', sessionId, {
            itemId: items[order] as string,
            checklistId,
            text,
            order,
        });
    }

    const phone = new Device('phone');
    const tablet = new Device('tablet');
    await phone.connect(relay.port, target);
    await tablet.connect(relay.port, target);

    log('phone', 'marks step 1 done with a note');
    let op = phone.send(sessionId, 'item.update', {
        itemId: items[0],
        status: 'done',
        note: 'LGTM',
    });
    await Promise.all([phone.waitFor(op.opId), tablet.waitFor(op.opId)]);
    show(tablet, checklistId);

    log('phone', 'tries to delete step 3 (devices can only review)');
    const denied = phone.send(sessionId, 'item.remove', { itemId: items[2] });
    await Bun.sleep(100);
    log('phone', `op ${denied.opId.slice(-6)} was not broadcast`);

    await tablet.disconnect();
    log('phone', 'asks a question on step 2 while the tablet is offline');
    op = phone.send(sessionId, 'item.update', {
        itemId: items[1],
        status: 'question',
        note: 'which limit?',
    });
    await phone.waitFor(op.opId);
    log('agent', 'adds step 4');
    await room.submitLocal('item.add', sessionId, {
        itemId: createId(),
        checklistId,
        text: 'Update docs',
        order: 3,
    });
    await Bun.sleep(50);

    await tablet.connect(relay.port, target, true);
    show(tablet, checklistId);

    const converged =
        JSON.stringify(phone.state) === JSON.stringify(tablet.state) &&
        JSON.stringify(tablet.state) === JSON.stringify(room.state);
    log(
        'check',
        converged ? 'phone, tablet and daemon states are identical ✔' : 'STATES DIVERGED ✘',
    );
    await phone.disconnect();
    if (!converged) process.exitCode = 1;
} finally {
    await daemon.stop();
    await relay.stop();
    await rm(home, { recursive: true, force: true });
}

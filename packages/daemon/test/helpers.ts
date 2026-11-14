import { expect } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createId,
    createOp,
    type DeviceKeyPair,
    exportPublicKey,
    generateDeviceKeys,
    type Op,
    type OpOf,
    type OpType,
    parseE2EComputerMessage,
    parseServerMessage,
    type SecureChannel,
    type ServerMessage,
    startDeviceHandshake,
    startDevicePairing,
} from '@palmtopai/protocol';
import { type Relay, startRelay } from '@palmtopai/relay';
import { type Daemon, type DaemonOptions, startDaemon } from '../src';

export async function createTempHome(): Promise<{ home: string; cleanup: () => Promise<void> }> {
    const home = await mkdtemp(join(tmpdir(), 'palmtop-test-'));
    return { home, cleanup: () => rm(home, { recursive: true, force: true }) };
}

/** Whether the tests run on Windows: no permission bits, no POSIX signals, other paths. */
export const WINDOWS = process.platform === 'win32';

/** The permission bits of a file or folder. Windows has none (ACLs protect them there). */
export async function expectMode(path: string, mode: number): Promise<void> {
    if (WINDOWS) return;
    expect((await stat(path)).mode & 0o777).toBe(mode);
}

/** A relay on a free port. Pass `port` to restart one on the same address. */
export function startTestRelay(port = 0): Relay {
    return startRelay({ port, log: () => {} });
}

export const relayUrlOf = (relay: Relay) => `ws://127.0.0.1:${relay.port}`;

/** A daemon connected to `relay` (without a relay it points to a closed port). */
export async function startTestDaemon(
    home: string,
    options: DaemonOptions & { relay?: Relay } = {},
): Promise<Daemon> {
    const { relay, ...rest } = options;
    const daemon = await startDaemon({
        home,
        localPort: 0,
        relayUrl: relay ? relayUrlOf(relay) : 'ws://127.0.0.1:9',
        relayReconnectDelayMs: { min: 20, max: 200 },
        restrictHome: false,
        // Activity does not resend the project list during a test unless the test asks for it.
        projectsDebounceMs: 60_000,
        log: () => {},
        ...rest,
    });
    if (relay) await waitForRelay(daemon);
    return daemon;
}

export async function waitUntil(condition: () => boolean, what: string, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await Bun.sleep(10);
    }
}

/** Waits until the daemon is authorized by the relay and its room is open. */
export function waitForRelay(daemon: Daemon): Promise<void> {
    return waitUntil(
        () =>
            daemon.relay.status === 'connected' && daemon.relay.isRoomOpen(daemon.registry.roomId),
        'the relay connection',
    );
}

/** A device of a test: its id and its keys, registered on a computer as if it had paired. */
export interface TestDevice {
    deviceId: string;
    keys: DeviceKeyPair;
    publicKey: string;
}

/**
 * A computer as its devices know it: the room and the room key they pinned when pairing. `device`
 * registers a device on the daemon the first time (as a pairing would) and returns its keys.
 */
export interface TestComputer {
    roomId: string;
    publicKey: string;
    device(deviceId: string): Promise<TestDevice>;
}

export function testComputer(daemon: Daemon): TestComputer {
    const devices = new Map<string, Promise<TestDevice>>();
    return {
        roomId: daemon.registry.roomId,
        publicKey: daemon.registry.roomPublicKey,
        device(deviceId) {
            let device = devices.get(deviceId);
            if (!device) {
                device = (async () => {
                    const keys = await generateDeviceKeys();
                    const publicKey = await exportPublicKey(keys.publicKey);
                    await daemon.paired.add({ deviceId, name: `Test ${deviceId}`, publicKey });
                    return { deviceId, keys, publicKey };
                })();
                devices.set(deviceId, device);
            }
            return device;
        },
    };
}

export interface SeededProject {
    projectId: string;
    roomId: string;
    /** The computer, to connect devices to it (`TestClient.hello`). */
    computer: TestComputer;
    sessionId: string;
    checklistId: string;
    itemIds: [string, string, string];
}

/** Creates a project with one session, one checklist and three items authored by the agent. */
export async function seedProject(
    daemon: Daemon,
    rootPath = '/tmp/demo-repo',
): Promise<SeededProject> {
    const { projectId } = await daemon.registry.resolve({ rootPath });
    await waitForRelay(daemon);
    const room = await daemon.rooms.get(projectId);
    if (!room) throw new Error('room not found');
    const sessionId = createId();
    const checklistId = createId();
    const itemIds = [createId(), createId(), createId()] as [string, string, string];

    await room.submitLocal('session.upsert', sessionId, {
        title: 'main · 10:00',
        branch: 'main',
        startedAt: Date.now(),
    });
    await room.submitLocal('checklist.create', sessionId, { checklistId, title: 'Refactor auth' });
    for (const [order, itemId] of itemIds.entries()) {
        await room.submitLocal('item.add', sessionId, {
            itemId,
            checklistId,
            text: `Step ${order + 1}`,
            order,
        });
    }
    return {
        projectId,
        roomId: daemon.registry.roomId,
        computer: testComputer(daemon),
        sessionId,
        checklistId,
        itemIds,
    };
}

export function deviceOp<T extends OpType>(
    project: SeededProject,
    deviceId: string,
    lamport: number,
    type: T,
    payload: OpOf<T>['payload'],
    sessionId = project.sessionId,
): OpOf<T> {
    return createOp({
        projectId: project.projectId,
        sessionId,
        type,
        payload,
        clock: { lamport, deviceId },
    });
}

/**
 * WebSocket client of a device that queues server messages so tests can await them in order. It
 * speaks end to end like the app: `hello` (or `handshake`) proves the device's key and the
 * computer's, and from then on `send` seals and incoming frames are opened before they are
 * queued. Before the handshake it sends and receives plain JSON.
 */
export class TestClient {
    readonly ws: WebSocket;
    readonly closed: Promise<{ code: number; reason: string }>;
    readonly #messages: ServerMessage[] = [];
    /** Plain messages before the handshake (the computer's welcome, or an error). */
    readonly #plain: string[] = [];
    #waiters: Array<() => void> = [];
    #channel: SecureChannel | null = null;
    #opening: Promise<void> = Promise.resolve();

    private constructor(ws: WebSocket) {
        this.ws = ws;
        ws.addEventListener('message', (event) => {
            const data = String(event.data);
            const channel = this.#channel;
            if (!channel) {
                // Handshake and pairing answers wait for their step; anything else (an error
                // before the close) is a server message like the others.
                if (parseE2EComputerMessage(data)) this.#plain.push(data);
                else this.#queue(data);
                this.#notify();
                return;
            }
            const frame = parseE2EComputerMessage(data);
            if (frame?.type !== 'sealed') {
                // The computer refused the device's proof: its error can't be sealed.
                this.#queue(data);
                return;
            }
            this.#opening = this.#opening.then(async () => {
                this.#queue(await channel.open(frame));
            });
        });
        this.closed = new Promise((resolve) => {
            ws.addEventListener('close', (event) => {
                resolve({ code: event.code, reason: event.reason });
                this.#notify();
            });
        });
    }

    /** Connects a device to the computer's room through the relay. */
    static connect(relay: Relay, roomId: string): Promise<TestClient> {
        const ws = new WebSocket(`${relayUrlOf(relay)}/ws?room=${roomId}`);
        const client = new TestClient(ws);
        return new Promise((resolve, reject) => {
            ws.addEventListener('open', () => resolve(client), { once: true });
            ws.addEventListener('error', () => reject(new Error('connection failed')), {
                once: true,
            });
        });
    }

    /** Sealed once the handshake is done, plain before. */
    send(message: unknown): void {
        const data = typeof message === 'string' ? message : JSON.stringify(message);
        const channel = this.#channel;
        if (!channel) {
            this.ws.send(data);
            return;
        }
        void channel.seal(data).then((frame) => {
            if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
        });
    }

    /**
     * Runs the end-to-end handshake as `deviceId`, registering it on the computer first if
     * needed. A refusal (an error, then the close) is queued like any server message.
     */
    async handshake(computer: TestComputer, deviceId: string, device?: TestDevice): Promise<void> {
        const own = device ?? (await computer.device(deviceId));
        const side = await startDeviceHandshake({
            roomId: computer.roomId,
            deviceId,
            deviceKey: own.keys.privateKey,
            computerKey: computer.publicKey,
        });
        this.send(side.hello);
        // The welcome, or a refusal: an error then the close, left in the queue for the test.
        await this.#waitFor(() => this.#plain.length > 0 || this.#messages.length > 0, 2_000);
        const welcome = parseE2EComputerMessage(this.#plain[0] ?? '');
        if (welcome?.type !== 'e2e.welcome') return;
        this.#plain.shift();
        const { auth, channel } = await side.finish(welcome);
        this.send(auth);
        this.#adopt(channel);
    }

    /**
     * Pairs as a new device with a single-use key (QR, link or code), like the app: when it
     * returns the channel is up; the computer's `paired` (or its refusal) is the next message.
     * Returns the number both screens show, and the device's keys for the next connections.
     */
    async pair(options: {
        roomId: string;
        pairKey: string;
        deviceId: string;
        name?: string;
        /** The keys of a device that paired before (the same browser pairing again). */
        keys?: DeviceKeyPair;
    }): Promise<{ number: string; computerKey: string; device: TestDevice }> {
        const keys = options.keys ?? (await generateDeviceKeys());
        const side = await startDevicePairing({
            roomId: options.roomId,
            pairKey: options.pairKey,
            deviceId: options.deviceId,
            name: options.name ?? `Test ${options.deviceId}`,
            deviceKeys: keys,
        });
        this.send(side.start);
        const welcome = parseE2EComputerMessage(await this.nextPlain());
        if (welcome?.type !== 'pair.welcome') throw new Error('expected pair.welcome');
        const revealed = await side.reveal(welcome);
        this.send(revealed.reveal);
        // The accept, or a refusal (an error, then the close) left in the queue for the test.
        await this.#waitFor(() => this.#plain.length > 0 || this.#messages.length > 0, 2_000);
        const accept = parseE2EComputerMessage(this.#plain[0] ?? '');
        const device = {
            deviceId: options.deviceId,
            keys,
            publicKey: await exportPublicKey(keys.publicKey),
        };
        if (accept?.type !== 'pair.accept') {
            return { number: revealed.number, computerKey: '', device };
        }
        this.#plain.shift();
        const { channel, computerKey } = await revealed.finish(accept);
        this.#adopt(channel);
        return { number: revealed.number, computerKey, device };
    }

    /** The next plain message (before the handshake). */
    async nextPlain(timeoutMs = 2_000): Promise<string> {
        await this.#waitFor(() => this.#plain.length > 0, timeoutMs);
        return this.#plain.shift() as string;
    }

    /** The project list of the last `hello`, which always precedes the project sync. */
    projects: Extract<ServerMessage, { type: 'projects' }> | null = null;

    /**
     * Connects as `deviceId` (handshake) and says hello; returns the project sync (snapshot or
     * ops), keeping the project list that comes first in `projects`. Without a project, the list
     * itself is returned.
     */
    async hello(
        target: { projectId?: string; computer: TestComputer },
        deviceId: string,
        lastSeq?: number,
        /** What the hello says the app can read (`archive`: an app from 0.20, `done`: from 0.24). */
        extra: { archive?: boolean; done?: boolean } = {},
    ): Promise<ServerMessage> {
        if (!this.#channel) await this.handshake(target.computer, deviceId);
        if (!this.#channel) return this.next();
        this.send({
            type: 'hello',
            ...(target.projectId !== undefined && { projectId: target.projectId }),
            ...(lastSeq !== undefined && { lastSeq }),
            ...extra,
        });
        const first = await this.next();
        if (first.type !== 'projects') return first;
        this.projects = first;
        return target.projectId === undefined ? first : this.next();
    }

    sendOp(op: Op): void {
        this.send({ type: 'op', op });
    }

    async next(timeoutMs = 2_000): Promise<ServerMessage> {
        await this.#waitFor(() => this.#messages.length > 0, timeoutMs);
        return this.#messages.shift() as ServerMessage;
    }

    /** Asserts that nothing arrives within `ms`. */
    async expectSilence(ms = 150): Promise<void> {
        await Bun.sleep(ms);
        await this.#opening;
        if (this.#messages.length > 0) {
            throw new Error(`unexpected message: ${JSON.stringify(this.#messages[0])}`);
        }
    }

    close(): void {
        this.ws.close();
    }

    /** The channel is up: sealed frames that arrived while it was being derived are opened now. */
    #adopt(channel: SecureChannel): void {
        this.#channel = channel;
        const early = this.#plain.splice(0);
        for (const data of early) {
            const frame = parseE2EComputerMessage(data);
            if (frame?.type !== 'sealed') continue;
            this.#opening = this.#opening.then(async () => {
                this.#queue(await channel.open(frame));
            });
        }
    }

    #queue(data: string): void {
        const parsed = parseServerMessage(data);
        if (!parsed.ok) throw new Error(`invalid server message: ${parsed.error}`);
        this.#messages.push(parsed.value);
        this.#notify();
    }

    async #waitFor(ready: () => boolean, timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (!ready()) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('timed out waiting for a server message');
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, remaining);
                this.#waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
            if (this.ws.readyState === WebSocket.CLOSED && !ready()) {
                // Frames that arrived before the close may still be being opened.
                await this.#opening;
                if (!ready()) {
                    // Who closed it and why: a failure on a slow machine has to say so.
                    const closed = await Promise.race([
                        this.closed,
                        Bun.sleep(500).then(() => null),
                    ]);
                    const how = closed ? ` (code ${closed.code}, "${closed.reason}")` : '';
                    throw new Error(`socket closed while waiting for a message${how}`);
                }
            }
        }
    }

    #notify(): void {
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const waiter of waiters) waiter();
    }
}

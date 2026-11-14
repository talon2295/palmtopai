import {
    acceptDeviceHandshake,
    acceptDevicePairing,
    type ClientMessage,
    CloseCode,
    type ComputerInfo,
    DEVICE_UNPAIRED,
    E2EError,
    type E2EHello,
    type ErrorCode,
    type ImageMime,
    listSessions,
    MAX_DAEMON_MESSAGE_BYTES,
    MAX_DEVICE_MESSAGE_BYTES,
    type Op,
    type PairedDevice,
    type PairReveal,
    type PairStart,
    type ProjectState,
    type ProjectSummary,
    type PushRegistration,
    parseClientMessage,
    parseE2EDeviceMessage,
    type SecureChannel,
    type ServerMessage,
    sealedFrameBytes,
} from '@palmtopai/protocol';
import type { RegisteredDevice } from './device-registry';
import { ImageError } from './images';
import type { PairingConfirmations, PairKeys } from './pairing';
import { isReservedDeviceId, type Rejection } from './permissions';
import type { ProjectRoom } from './room';
import type { RoomIdentity } from './room-identity';
import type { RoomManager } from './rooms';

const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
/**
 * A device counts as on screen only if it was heard from this recently: the app pings every 20
 * seconds, and a phone locked with the app open can leave its connection open without a word
 * (no `presence` message gets out before the system freezes the page).
 */
const DEFAULT_PRESENCE_TIMEOUT_MS = 30_000;
/** Room left in the relay's limit for the envelope of a message to a device (`device.send`). */
const RELAY_ENVELOPE_BYTES = 64 * 1024;

/** How the hub reaches devices: the relay connection. */
export interface DeviceTransport {
    send(conns: string[], data: string): void;
    close(conn: string, code: number, reason: string): void;
}

type Handshake = Awaited<ReturnType<typeof acceptDeviceHandshake>>;
type Pairing = Awaited<ReturnType<typeof acceptDevicePairing>>;

/**
 * - `handshake`: nothing yet; the device opens with `e2e.hello` (paired) or `pair.start`.
 * - `auth`, `pairing`: the computer answered, the device's proof is next.
 * - `confirming`: paired by code, waiting for the user to compare the number on the computer.
 * - `awaiting-hello`, `ready`: the sealed channel is up; the device protocol runs inside it.
 */
type Phase =
    | 'handshake'
    | 'auth'
    | 'pairing'
    | 'confirming'
    | 'awaiting-hello'
    | 'ready'
    | 'closed';

interface Connection {
    roomId: string;
    phase: Phase;
    handshake?: Handshake;
    pairing?: Pairing;
    /** Proven by the handshake (or registered by the pairing): who is on this connection. */
    deviceId?: string;
    channel?: SecureChannel;
    /** Pairing by code waiting for the user's answer on the computer: its pairing key. */
    confirmingKey?: string;
    /** Project the device is following, when it picked one. */
    projectId?: string;
    /** The app is on screen (until it says otherwise with a `presence` message). */
    visible: boolean;
    /** When the last message of the device arrived. */
    lastSeenAt: number;
    helloTimer?: ReturnType<typeof setTimeout>;
    /** Messages of one connection are handled one at a time, in arrival order. */
    queue: Promise<void>;
    /** Messages to the device go out one at a time too: sealed frames keep their order. */
    outbox: Promise<void>;
    /** The relay closed it: what is still in the outbox goes nowhere. */
    gone?: boolean;
    /** The app reads `session.archive` (it said so in its hello). */
    archive?: boolean;
    /** The app reads `session.done` (it said so in its hello). */
    done?: boolean;
}

/** After an await: TypeScript would keep the phase it narrowed before it. */
function isClosed(connection: Connection): boolean {
    return connection.phase === 'closed';
}

/** Where push subscriptions sent by devices go (never into the project state). */
export interface DevicePushSubscriptions {
    set(deviceId: string, registration: PushRegistration): Promise<void>;
    remove(deviceId: string): Promise<void>;
}

/** The projects of this computer, as devices see them listed. */
export type ProjectListSource = () => Promise<{
    computer: ComputerInfo;
    projects: ProjectSummary[];
}>;

/** Deletes a project with its data, as `palmtop projects remove` does. */
export type ProjectRemover = (projectId: string) => Promise<void>;

/**
 * What a hub serves: one relay room, with the projects the devices of that room can see. The
 * computer's room serves the projects of the computer; the room of a person serves the copies
 * made for them, and nothing else.
 */
export interface HubScope {
    readonly roomId: string;
    readonly roomPublicKey: string;
    signingKey(): ReturnType<RoomIdentity['signingKey']>;
    /** True for a project the devices of this room can see and follow. */
    has(projectId: string): boolean;
    /** Names this room in the log; never shown to a device. */
    readonly label: string;
    /** A further check on an op of a device, after the ones every room makes. */
    authorizeOp?(projectId: string, op: Op): Rejection | null;
    /** `false`: the devices of this room cannot archive (a person's copies). Absent: they can. */
    readonly archive?: boolean;
    /** `false`: the devices of this room cannot send or ask for screenshots. Absent: they can. */
    readonly images?: boolean;
    /** A further check on a screenshot a device sends for a project of this room. */
    authorizeImage?(projectId: string): Rejection | null;
}

/** The screenshots of the projects, as the hub stores and serves them. */
export interface DeviceImages {
    put(
        projectId: string,
        sessionId: string,
        imageId: string,
        mime: ImageMime,
        bytes: Uint8Array,
    ): Promise<void>;
    read(
        projectId: string,
        imageId: string,
    ): Promise<{ mime: ImageMime; bytes: Uint8Array } | null>;
    /** Deletes the images of the project that the state does not name (and are not recent). */
    sweep(projectId: string, state: ProjectState): Promise<unknown>;
}

/** The devices paired with a room, and the public key each proves at every connection. */
export interface DeviceDirectory {
    get(deviceId: string): RegisteredDevice | null;
    add(device: PairedDevice): Promise<RegisteredDevice>;
    restore(device: RegisteredDevice): Promise<void>;
    remove(deviceId: string): Promise<boolean>;
    seen(deviceId: string): Promise<void>;
}

export interface DeviceHubOptions {
    scope: HubScope;
    devices: DeviceDirectory;
    rooms: RoomManager;
    projectList: ProjectListSource;
    /**
     * Messages that follow the sync of a project the moment a device starts following it (the
     * answers of the people it is shared with, for the computer's devices).
     */
    syncExtras?: (projectId: string) => Promise<ServerMessage[]>;
    removeProject?: ProjectRemover;
    images?: DeviceImages;
    push?: DevicePushSubscriptions;
    pairKeys?: PairKeys;
    confirmations?: PairingConfirmations;
    helloTimeoutMs?: number;
    /** How long a silent device still counts as on screen. */
    presenceTimeoutMs?: number;
    /** Largest message sent to a device, sealed: below the relay's limit for the daemon. */
    maxMessageBytes?: number;
    log: (line: string) => void;
}

/**
 * Device protocol (hello, project list, snapshot, ops) for devices connected through the relay,
 * end-to-end encrypted (`e2e.ts`): every connection starts with a handshake that proves the
 * computer's room key and the device's registered key, and everything after it is sealed. The
 * relay only forwards. A new device pairs on the same kind of connection, proving a single-use
 * pairing key. Op permissions are checked here.
 * One connection follows one project at a time and moves to another with `subscribe`.
 */
export class DeviceHub {
    readonly #scope: HubScope;
    readonly #devices: DeviceDirectory;
    readonly #rooms: RoomManager;
    readonly #projectList: ProjectListSource;
    readonly #syncExtras: ((projectId: string) => Promise<ServerMessage[]>) | undefined;
    readonly #removeProject: ProjectRemover | undefined;
    readonly #images: DeviceImages | undefined;
    readonly #helloTimeoutMs: number;
    readonly #presenceTimeoutMs: number;
    readonly #maxMessageBytes: number;
    readonly #push: DevicePushSubscriptions | undefined;
    readonly #pairKeys: PairKeys | undefined;
    readonly #confirmations: PairingConfirmations | undefined;
    readonly #log: (line: string) => void;
    readonly #connections = new Map<string, Connection>();
    /** Authenticated connections, by the project they follow. */
    readonly #ready = new Map<string, Set<string>>();
    #transport: DeviceTransport | null = null;

    constructor(options: DeviceHubOptions) {
        this.#scope = options.scope;
        this.#devices = options.devices;
        this.#rooms = options.rooms;
        this.#projectList = options.projectList;
        this.#syncExtras = options.syncExtras;
        this.#removeProject = options.removeProject;
        this.#images = options.images;
        this.#helloTimeoutMs = options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
        this.#presenceTimeoutMs = options.presenceTimeoutMs ?? DEFAULT_PRESENCE_TIMEOUT_MS;
        this.#maxMessageBytes =
            options.maxMessageBytes ?? MAX_DAEMON_MESSAGE_BYTES - RELAY_ENVELOPE_BYTES;
        this.#push = options.push;
        this.#pairKeys = options.pairKeys;
        this.#confirmations = options.confirmations;
        this.#log = options.log;
    }

    /** Binds the hub to a relay connection; `null` drops every device of the previous one. */
    setTransport(transport: DeviceTransport | null): void {
        this.closeAll();
        this.#transport = transport;
    }

    /** Broadcasts to every authenticated device following a project. */
    publish(projectId: string, message: ServerMessage): void {
        for (const conn of this.#ready.get(projectId) ?? []) this.#send(conn, message);
    }

    /** Sends the project list to every authenticated device of this computer. */
    async publishProjects(): Promise<void> {
        const conns = [...this.#connections]
            .filter(([, connection]) => connection.phase === 'ready')
            .map(([conn]) => conn);
        if (conns.length === 0) return;
        const message: ServerMessage = { type: 'projects', ...(await this.#projectList()) };
        for (const conn of conns) this.#send(conn, message);
    }

    /** Resolves once what was queued for the devices has been handed to the relay. */
    async flush(): Promise<void> {
        await Promise.all([...this.#connections.values()].map((connection) => connection.outbox));
    }

    connectedDevices(projectId: string): number {
        return this.#ready.get(projectId)?.size ?? 0;
    }

    /** True while the device has a connection that passed the handshake. */
    isConnected(deviceId: string): boolean {
        for (const connection of this.#connections.values()) {
            if (connection.deviceId === deviceId && connection.channel) return true;
        }
        return false;
    }

    /** True when the device follows the project with the app on screen, and was heard lately. */
    isVisible(projectId: string, deviceId: string): boolean {
        const since = Date.now() - this.#presenceTimeoutMs;
        for (const conn of this.#ready.get(projectId) ?? []) {
            const connection = this.#connections.get(conn);
            if (
                connection?.deviceId === deviceId &&
                connection.visible &&
                connection.lastSeenAt >= since
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Revokes a device: its key and its notifications go, and its open connections close. It can
     * pair again, like a new device. False if it was not paired.
     */
    async revoke(deviceId: string): Promise<boolean> {
        const removed = await this.#devices.remove(deviceId);
        await this.#disconnect(deviceId);
        if (removed) this.#log(`device ${deviceId} unpaired`);
        return removed;
    }

    /** What a device's key opened closes (but `except`), and its notifications go. */
    async #disconnect(deviceId: string, except?: string): Promise<void> {
        await this.#push?.remove(deviceId);
        for (const [conn, connection] of this.#connections) {
            if (conn !== except && connection.deviceId === deviceId) {
                this.#fail(conn, 'unauthorized', DEVICE_UNPAIRED, CloseCode.unauthorized);
            }
        }
    }

    open(conn: string, roomId: string): void {
        const connection: Connection = {
            roomId,
            phase: 'handshake',
            visible: true,
            lastSeenAt: Date.now(),
            queue: Promise.resolve(),
            outbox: Promise.resolve(),
        };
        this.#connections.set(conn, connection);
        this.#startHelloTimer(conn, connection);
    }

    message(conn: string, raw: string): void {
        const connection = this.#connections.get(conn);
        if (!connection) return;
        connection.lastSeenAt = Date.now();
        connection.queue = connection.queue
            .then(() => this.#receive(conn, connection, raw))
            .catch((error: unknown) => this.#failWith(conn, error));
    }

    #failWith(conn: string, error: unknown): void {
        if (error instanceof E2EError) {
            // The id says which device (e.g. one whose browser lost its key); never secret.
            const deviceId = this.#connections.get(conn)?.deviceId;
            this.#log(`device ${deviceId ?? '(unknown)'} rejected: ${error.message}`);
            this.#fail(conn, 'unauthorized', error.message, CloseCode.unauthorized);
            return;
        }
        this.#log(`device message failed: ${(error as Error).message}`);
        this.#fail(conn, 'internal', 'internal error');
    }

    /** The device went away (or the relay closed it). */
    close(conn: string): void {
        const connection = this.#connections.get(conn);
        if (connection) connection.gone = true;
        this.#forget(conn);
    }

    /** Stops serving a connection; what it still has to send goes out first, unless it is gone. */
    #forget(conn: string): void {
        const connection = this.#connections.get(conn);
        if (!connection) return;
        clearTimeout(connection.helloTimer);
        // A device that goes away while the user compares the number pairs nothing.
        if (connection.phase === 'confirming' && connection.confirmingKey) {
            this.#confirmations?.abandon(connection.confirmingKey);
        }
        connection.phase = 'closed';
        this.#connections.delete(conn);
        if (connection.projectId) this.#ready.get(connection.projectId)?.delete(conn);
    }

    /** Forgets the devices of a room that this daemon no longer serves. */
    closeRoom(roomId: string): void {
        for (const [conn, connection] of this.#connections) {
            if (connection.roomId === roomId) this.close(conn);
        }
    }

    /**
     * A project was deleted: the devices following it stay connected (the computer is still
     * theirs) and go back to the list, which `publishProjects` sends right after.
     */
    clearProject(projectId: string): void {
        for (const conn of this.#ready.get(projectId) ?? []) {
            const connection = this.#connections.get(conn);
            if (connection) delete connection.projectId;
        }
        this.#ready.delete(projectId);
    }

    /**
     * Devices following a project they can no longer see (a copy taken away from them) go back
     * to the list, which `publishProjects` sends right after.
     */
    dropUnavailable(): void {
        for (const projectId of [...this.#ready.keys()]) {
            if (!this.#scope.has(projectId)) this.clearProject(projectId);
        }
    }

    closeAll(): void {
        for (const conn of [...this.#connections.keys()]) this.close(conn);
    }

    // -- sending -----------------------------------------------------------------------------

    /** Sealed once the channel is up, plain before it (handshake answers and their errors). */
    #send(conn: string, message: object): void {
        const connection = this.#connections.get(conn);
        if (!connection || connection.phase === 'closed') return;
        const data = JSON.stringify(message);
        const channel = connection.channel;
        const bytes = Buffer.byteLength(data);
        if (sealedFrameBytes(bytes) > this.#maxMessageBytes) {
            // The relay would close this daemon's connection, every device with it. Checked
            // before sealing: a frame sealed and not sent would break the channel.
            this.#log(
                `message to a device not sent: ${(bytes / 1024 / 1024).toFixed(1)} MB, over the relay's limit`,
            );
            this.#send(conn, {
                type: 'error',
                code: 'internal',
                message: 'too much data to send through the relay',
            });
            return;
        }
        connection.outbox = connection.outbox
            .then(async () => {
                const wire = channel ? JSON.stringify(await channel.seal(data)) : data;
                if (!connection.gone) this.#transport?.send([conn], wire);
            })
            .catch((error: unknown) => {
                this.#log(`device message not sent: ${(error as Error).message}`);
            });
    }

    #fail(
        conn: string,
        code: ErrorCode,
        message: string,
        close?: number,
        opId?: string,
        imageId?: string,
    ): void {
        this.#send(conn, {
            type: 'error',
            code,
            message,
            ...(opId && { opId }),
            ...(imageId && { imageId }),
        });
        if (close === undefined) return;
        // Already forgotten: closed, or never known to the relay under this id.
        const connection = this.#connections.get(conn);
        if (!connection) return;
        clearTimeout(connection.helloTimer);
        // After the error went out: the frame before the close.
        const transport = this.#transport;
        void connection.outbox.then(() => {
            if (!connection.gone) transport?.close(conn, close, code);
        });
        this.#forget(conn);
    }

    #startHelloTimer(conn: string, connection: Connection): void {
        clearTimeout(connection.helloTimer);
        connection.helloTimer = setTimeout(() => {
            if (connection.phase !== 'ready' && connection.phase !== 'confirming') {
                this.#fail(conn, 'unauthorized', 'hello timeout', CloseCode.helloTimeout);
            }
        }, this.#helloTimeoutMs);
    }

    // -- receiving ---------------------------------------------------------------------------

    async #receive(conn: string, connection: Connection, raw: string): Promise<void> {
        if (connection.phase === 'closed') return;
        if (Buffer.byteLength(raw) > MAX_DEVICE_MESSAGE_BYTES) {
            return this.#fail(conn, 'invalid_message', 'message too big');
        }
        const wire = parseE2EDeviceMessage(raw);

        switch (connection.phase) {
            case 'handshake':
                if (wire?.type === 'e2e.hello') return this.#greet(conn, connection, wire);
                if (wire?.type === 'pair.start') return this.#startPairing(connection, conn, wire);
                return this.#fail(
                    conn,
                    'unauthorized',
                    'expected a handshake',
                    CloseCode.unauthorized,
                );

            case 'auth': {
                if (wire?.type !== 'e2e.auth' || !connection.handshake || !connection.deviceId) {
                    return this.#fail(
                        conn,
                        'unauthorized',
                        'expected e2e.auth',
                        CloseCode.unauthorized,
                    );
                }
                connection.channel = await connection.handshake.finish(wire);
                delete connection.handshake;
                connection.phase = 'awaiting-hello';
                await this.#devices.seen(connection.deviceId);
                return;
            }

            case 'pairing': {
                if (wire?.type !== 'pair.reveal' || !connection.pairing) {
                    return this.#fail(
                        conn,
                        'unauthorized',
                        'expected pair.reveal',
                        CloseCode.unauthorized,
                    );
                }
                return this.#finishPairing(conn, connection, connection.pairing, wire);
            }

            default: {
                if (wire?.type !== 'sealed' || !connection.channel) {
                    return this.#fail(
                        conn,
                        'unauthorized',
                        'expected a sealed frame',
                        CloseCode.unauthorized,
                    );
                }
                const plain = await connection.channel.open(wire);
                return this.#handle(conn, connection, plain);
            }
        }
    }

    /** A paired device connects: the computer answers if the device id is registered here. */
    async #greet(conn: string, connection: Connection, hello: E2EHello): Promise<void> {
        // Ids of the daemon's own ops: never a device, even one registered by mistake.
        if (isReservedDeviceId(hello.deviceId)) {
            return this.#fail(conn, 'forbidden', 'reserved device id', CloseCode.forbidden);
        }
        const device = this.#devices.get(hello.deviceId);
        // The same answer for an unknown device and a wrong room: nothing about who is paired.
        if (!device || connection.roomId !== this.#scope.roomId) {
            this.#log(`device ${hello.deviceId} rejected: not paired with this computer`);
            return this.#fail(conn, 'unauthorized', 'not paired', CloseCode.unauthorized);
        }
        connection.handshake = await acceptDeviceHandshake({
            roomId: this.#scope.roomId,
            hello,
            computerKey: await this.#scope.signingKey(),
            devicePublicKey: device.publicKey,
        });
        connection.deviceId = device.deviceId;
        connection.phase = 'auth';
        this.#send(conn, connection.handshake.welcome);
    }

    async #startPairing(connection: Connection, conn: string, start: PairStart): Promise<void> {
        if (!this.#pairKeys || connection.roomId !== this.#scope.roomId) {
            return this.#fail(conn, 'unauthorized', 'pairing unavailable', CloseCode.unauthorized);
        }
        connection.pairing = await acceptDevicePairing({
            roomId: this.#scope.roomId,
            start,
            computerKey: await this.#scope.signingKey(),
            computerPublicKey: this.#scope.roomPublicKey,
        });
        connection.phase = 'pairing';
        this.#send(conn, connection.pairing.welcome);
    }

    /**
     * The device proved a pairing key. With a QR code or a link it is registered now; with a
     * pairing code, once the user saw the same number on the computer.
     */
    async #finishPairing(
        conn: string,
        connection: Connection,
        pairing: Pairing,
        reveal: PairReveal,
    ): Promise<void> {
        const pairKeys = this.#pairKeys;
        if (!pairKeys) throw new E2EError('pairing unavailable');
        const done = await pairing.finish(reveal, pairKeys.valid());
        const entry = pairKeys.take(done.pairKey);
        if (!entry) throw new E2EError('invalid or expired pairing key');
        if (isReservedDeviceId(done.device.deviceId)) {
            return this.#fail(conn, 'forbidden', 'reserved device id', CloseCode.forbidden);
        }
        delete connection.pairing;
        // The accept is the last plain message: what follows is sealed.
        this.#send(conn, done.accept);
        connection.channel = done.channel;
        connection.deviceId = done.device.deviceId;

        if (entry.confirm) {
            const answer = this.#confirmations?.ready(done.pairKey, {
                number: done.number,
                deviceName: done.device.name,
            });
            if (!answer) throw new E2EError('pairing code not followed on this computer');
            connection.phase = 'confirming';
            connection.confirmingKey = done.pairKey;
            clearTimeout(connection.helloTimer);
            this.#log('pairing by code: waiting for the number to be confirmed on the computer');
            // Not on the message queue: the device may ping or go away while the user decides.
            void answer
                .then(async (accepted) => {
                    if (connection.phase !== 'confirming') return;
                    if (!accepted) {
                        this.#log('pairing by code refused on the computer');
                        return this.#fail(
                            conn,
                            'unauthorized',
                            'pairing refused on the computer',
                            CloseCode.unauthorized,
                        );
                    }
                    await this.#register(conn, connection, done.device);
                })
                .catch((error: unknown) => this.#failWith(conn, error));
            return;
        }
        await this.#register(conn, connection, done.device);
    }

    /** A device that can't be registered (e.g. `devices.json` not written) learns it at once. */
    async #register(
        conn: string,
        connection: Connection,
        device: { deviceId: string; name: string; publicKey: string },
    ): Promise<void> {
        try {
            await this.#registerNow(conn, connection, device);
        } catch (error) {
            this.#log(`device not registered: ${(error as Error).message}`);
            this.#fail(conn, 'internal', 'pairing failed on the computer', CloseCode.unauthorized);
        }
    }

    async #registerNow(
        conn: string,
        connection: Connection,
        device: { deviceId: string; name: string; publicKey: string },
    ): Promise<void> {
        const { computer } = await this.#projectList();
        if (connection.phase === 'closed') return;
        const previous = this.#devices.get(device.deviceId);
        await this.#devices.add(device);
        // Gone while its key was written: the device saved nothing, so the computer keeps what
        // it had (the registration before this one, still valid on that device, or nothing).
        if (isClosed(connection)) {
            await (previous
                ? this.#devices.restore(previous)
                : this.#devices.remove(device.deviceId));
            this.#log('pairing abandoned by the device');
            return;
        }
        // Paired again with a new key (another browser under the same id): what the old key
        // opened closes, its notifications go. The same key (the same browser pairing again,
        // e.g. from a new link) leaves its other tabs connected.
        if (previous && previous.publicKey !== device.publicKey) {
            await this.#disconnect(device.deviceId, conn);
        }
        connection.phase = 'awaiting-hello';
        this.#startHelloTimer(conn, connection);
        this.#log(`device ${device.deviceId} paired`);
        this.#send(conn, { type: 'paired', computer });
        // Only shown by `palmtop devices`: not worth failing a pairing that is done.
        this.#devices.seen(device.deviceId).catch((error: unknown) => {
            this.#log(`device not marked as seen: ${(error as Error).message}`);
        });
    }

    async #handle(conn: string, connection: Connection, raw: string): Promise<void> {
        if (connection.phase === 'closed') return;
        if (Buffer.byteLength(raw) > MAX_DEVICE_MESSAGE_BYTES) {
            return this.#fail(conn, 'invalid_message', 'message too big');
        }
        const parsed = parseClientMessage(raw);
        if (!parsed.ok) {
            if (connection.phase === 'awaiting-hello') {
                return this.#fail(conn, 'unauthorized', 'expected hello', CloseCode.unauthorized);
            }
            return this.#fail(conn, 'invalid_message', parsed.error);
        }
        const message = parsed.value;

        if (message.type === 'ping') return this.#send(conn, { type: 'pong' });
        if (message.type === 'pong') return;

        const { deviceId } = connection;
        if (!deviceId) return this.#fail(conn, 'internal', 'device unavailable');

        if (connection.phase === 'confirming') {
            return this.#fail(conn, 'forbidden', 'pairing not confirmed yet');
        }
        if (message.type === 'device.unpair') {
            await this.revoke(deviceId);
            return;
        }
        if (connection.phase === 'awaiting-hello') {
            if (message.type !== 'hello') {
                return this.#fail(conn, 'unauthorized', 'expected hello', CloseCode.unauthorized);
            }
            return this.#hello(conn, connection, message);
        }
        if (message.type === 'hello') {
            return this.#fail(conn, 'invalid_message', 'already authenticated');
        }

        if (message.type === 'presence') {
            connection.visible = message.visible;
            return;
        }
        if (message.type === 'subscribe') {
            if (message.archive !== undefined) connection.archive = message.archive;
            if (message.done !== undefined) connection.done = message.done;
            return this.#subscribe(conn, connection, message.projectId, message.lastSeq);
        }
        if (message.type === 'project.remove') {
            return this.#removeProjectFor(conn, deviceId, message.projectId);
        }
        if (message.type === 'archive') {
            return this.#archive(conn, message);
        }
        if (message.type === 'image.put') return this.#imagePut(conn, deviceId, message);
        if (message.type === 'image.get') return this.#imageGet(conn, message);
        // Notifications are of the device, for every project of this computer: they need no
        // project to be selected.
        if (message.type === 'push.subscribe' || message.type === 'push.unsubscribe') {
            if (!this.#push) return this.#fail(conn, 'forbidden', 'push notifications unavailable');
            if (message.type === 'push.subscribe') {
                await this.#push.set(deviceId, message.push);
            } else {
                await this.#push.remove(deviceId);
            }
            return;
        }

        const { projectId } = connection;
        if (!projectId) return this.#fail(conn, 'forbidden', 'no project selected');

        const room = await this.#rooms.get(projectId);
        if (!room) return this.#fail(conn, 'internal', 'project data unavailable');

        const result = await room.submit(message.op, {
            kind: 'device',
            deviceId,
            authorize: (op) => this.#scope.authorizeOp?.(projectId, op) ?? null,
        });
        if (result.status === 'rejected') {
            this.#fail(
                conn,
                result.rejection.code,
                result.rejection.message,
                undefined,
                message.op.opId,
            );
        }
    }

    /**
     * Deletes a project of this computer at a device's request: any paired device can, the same
     * way `palmtop projects remove` can on the computer. The project's data goes, the files of
     * the folder are never touched, and every device gets the new list.
     */
    async #removeProjectFor(conn: string, deviceId: string, projectId: string): Promise<void> {
        if (!this.#removeProject || !this.#scope.has(projectId)) {
            return this.#fail(conn, 'forbidden', 'unknown project');
        }
        this.#log(`device ${deviceId} removes project ${projectId}`);
        await this.#removeProject(projectId);
    }

    /**
     * Archives sessions of a project, or takes them out of the archive: the ones named (unknown
     * ones are skipped), or every session of the project. The computer writes the ops, one per
     * session that changes; every device then gets the new counts with the project list.
     */
    async #archive(
        conn: string,
        message: Extract<ClientMessage, { type: 'archive' }>,
    ): Promise<void> {
        const { projectId, archived } = message;
        if (this.#scope.archive === false) {
            return this.#fail(conn, 'forbidden', 'devices cannot archive a shared checklist');
        }
        const room = this.#scope.has(projectId) ? await this.#rooms.get(projectId) : null;
        if (!room) return this.#fail(conn, 'forbidden', 'unknown project');
        const wanted = message.sessionIds ? new Set(message.sessionIds) : null;
        await room.transact(async (tx) => {
            for (const session of listSessions(tx.state)) {
                if (wanted && !wanted.has(session.id)) continue;
                if ((session.archived ?? false) === archived) continue;
                await tx.submit('session.archive', session.id, { archived });
            }
        });
    }

    /** Stores a screenshot of a session; the answer names its id, whether it was kept or not. */
    async #imagePut(
        conn: string,
        deviceId: string,
        message: Extract<ClientMessage, { type: 'image.put' }>,
    ): Promise<void> {
        const { projectId, sessionId, imageId } = message;
        const refuse = (code: ErrorCode, text: string) =>
            this.#fail(conn, code, text, undefined, undefined, imageId);
        if (!this.#images || this.#scope.images === false) {
            return refuse('forbidden', 'screenshots are not available here');
        }
        const room = this.#scope.has(projectId) ? await this.#rooms.get(projectId) : null;
        const session = room?.state.sessions[sessionId];
        if (!room || !session || session.removed) return refuse('forbidden', 'unknown session');
        const rejection = this.#scope.authorizeImage?.(projectId);
        if (rejection) return refuse(rejection.code, rejection.message);
        try {
            await this.#images.put(
                projectId,
                sessionId,
                imageId,
                message.mime,
                Buffer.from(message.data, 'base64'),
            );
        } catch (error) {
            if (error instanceof ImageError) {
                return refuse(
                    error.reason === 'quota' ? 'forbidden' : 'invalid_message',
                    error.message,
                );
            }
            throw error;
        }
        this.#send(conn, { type: 'image.saved', imageId });
        this.#log(`device ${deviceId} stored a screenshot of ${projectId}`);
        // Images that no note names any more (a screenshot taken back) go with the next one.
        this.#images.sweep(projectId, room.state).catch((error: unknown) => {
            this.#log(`screenshots not swept: ${(error as Error).message}`);
        });
    }

    async #imageGet(
        conn: string,
        message: Extract<ClientMessage, { type: 'image.get' }>,
    ): Promise<void> {
        const { projectId, imageId } = message;
        if (!this.#images || this.#scope.images === false || !this.#scope.has(projectId)) {
            return this.#fail(conn, 'forbidden', 'unknown project');
        }
        const image = await this.#images.read(projectId, imageId);
        if (!image) return this.#send(conn, { type: 'image.missing', imageId });
        this.#send(conn, {
            type: 'image',
            imageId,
            mime: image.mime,
            data: Buffer.from(image.bytes).toString('base64'),
        });
    }

    async #hello(
        conn: string,
        connection: Connection,
        hello: Extract<ClientMessage, { type: 'hello' }>,
    ): Promise<void> {
        clearTimeout(connection.helloTimer);
        connection.phase = 'ready';
        connection.archive = hello.archive === true;
        connection.done = hello.done === true;
        this.#send(conn, { type: 'projects', ...(await this.#projectList()) });
        this.#log(`device ${connection.deviceId} joined ${this.#scope.label}`);
        if (hello.projectId === undefined) return;
        await this.#follow(conn, connection, hello.projectId, hello.lastSeq);
    }

    /** Moves a connection to another project of the same computer. */
    /**
     * What brings a device up to date: the ops since `lastSeq`, or the whole state. An app before
     * 0.20 cannot read `session.archive` and would fail on a catch-up holding one, again at every
     * reconnection: it gets the state, which it reads (without the field it does not know). The
     * same goes for `session.done`, which the app of 0.24 reads.
     */
    #syncFor(
        connection: Connection,
        room: ProjectRoom,
        lastSeq: number | undefined,
    ): ServerMessage {
        const message = room.syncMessage(lastSeq);
        if (
            message.type === 'ops' &&
            message.ops.some(
                (entry) =>
                    (!connection.archive && entry.op.type === 'session.archive') ||
                    (!connection.done && entry.op.type === 'session.done'),
            )
        ) {
            return room.syncMessage();
        }
        return message;
    }

    async #subscribe(
        conn: string,
        connection: Connection,
        projectId: string,
        lastSeq: number | undefined,
    ): Promise<void> {
        if (!this.#scope.has(projectId)) {
            return this.#fail(conn, 'forbidden', 'unknown project');
        }
        const followed = await this.#follow(conn, connection, projectId, lastSeq);
        if (!followed) this.#fail(conn, 'internal', 'project data unavailable');
    }

    /**
     * Subscribes the connection to a project's live ops and sends what it missed. An unknown
     * project after `hello` is not an error: the device keeps the list and picks another one.
     */
    async #follow(
        conn: string,
        connection: Connection,
        projectId: string,
        lastSeq: number | undefined,
    ): Promise<boolean> {
        const room = this.#scope.has(projectId) ? await this.#rooms.get(projectId) : null;
        if (!room) return false;
        const extras = (await this.#syncExtras?.(projectId)) ?? [];

        return room.exclusive(() => {
            if (connection.phase !== 'ready') return false;
            // Taken away while the room was busy: nothing of it is sent.
            if (!this.#scope.has(projectId)) return false;
            const previous = connection.projectId;
            if (previous && previous !== projectId) this.#ready.get(previous)?.delete(conn);
            this.#send(conn, this.#syncFor(connection, room, lastSeq));
            for (const extra of extras) this.#send(conn, extra);
            connection.projectId = projectId;
            let ready = this.#ready.get(projectId);
            if (!ready) {
                ready = new Set();
                this.#ready.set(projectId, ready);
            }
            ready.add(conn);
            return true;
        });
    }
}

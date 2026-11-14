import {
    applyAll,
    CloseCode,
    type ComputerInfo,
    createOp,
    DEVICE_UNPAIRED,
    type ErrorCode,
    getChecklist,
    getItem,
    LamportClock,
    LIMITS,
    type Op,
    type OpOf,
    opSchema,
    type ProjectInfo,
    type ProjectState,
    type ProjectSummary,
    type PushRegistration,
    parseServerMessage,
    type ServerMessage,
    type SessionShares,
} from '@palmtopai/protocol';
import type { CachedProject, ClientCache, PendingImage, StoredImage } from './client-cache';
import { type DeviceIdentity, secureSocket } from './secure-socket';

/** Close codes sent by the daemon that mean "do not retry with these credentials". */
const FATAL_CLOSE_CODES = new Set<number>([CloseCode.unauthorized, CloseCode.forbidden]);
/**
 * Refusals that are not about who this device is (a frame lost or damaged on the way, a
 * handshake cut short) are tried again this many times in a row before the client gives up.
 */
const MAX_TRANSIENT_RETRIES = 5;
/** Close code the client uses to force a clean resync after a seq gap. */
const RESYNC_CLOSE_CODE = 4000;

/** `daemon-offline`: the relay is reachable but the computer is not connected to it. */
export type ConnectionStatus =
    | 'connecting'
    | 'online'
    | 'offline'
    | 'daemon-offline'
    | 'unauthorized'
    | 'stopped';

/**
 * Why the computer refused this device: `key`, the device proved another key than the one it
 * paired with (the browser deleted its keys and made new ones); `computer-key`, the computer
 * proved another room key (palmtop reinstalled there); `not-paired`, the computer does not know
 * this device; `revoked`, it was unpaired while connected; `other`, anything else.
 */
export type UnauthorizedReason = 'key' | 'computer-key' | 'not-paired' | 'revoked' | 'other';

export function unauthorizedReasonOf(
    reason: string | undefined,
    revoked: boolean,
): UnauthorizedReason {
    if (revoked) return 'revoked';
    switch (reason) {
        case 'the device did not prove its key':
            return 'key';
        case 'the computer did not prove its key':
        case 'this computer does not hold the key of its room':
            return 'computer-key';
        case 'not paired':
            return 'not-paired';
        default:
            return 'other';
    }
}

export interface SyncError {
    code: ErrorCode;
    message: string;
    opId?: string;
}

export interface SyncSnapshot {
    status: ConnectionStatus;
    /** With `unauthorized`: why the computer refused this device. */
    unauthorizedReason: UnauthorizedReason | null;
    /** Project being followed, `null` before one is picked. */
    projectId: string | null;
    project: ProjectInfo | null;
    /** The computer this device is paired with, known after the first sync. */
    computer: ComputerInfo | null;
    /** Every project of that computer, most recently active first. */
    projects: ProjectSummary[];
    /** Last server state with the not-yet-confirmed local ops applied on top. */
    state: ProjectState | null;
    /**
     * What the people a session is shared with answered (the owner's devices only): empty when
     * nothing is shared, and until the computer tells.
     */
    shares: SessionShares[];
    /**
     * The sessions of the project an agent is waiting in for Review done (computers of protocol 8);
     * `null` when the computer does not tell: it is not connected, or it is older.
     */
    waiting: string[] | null;
    seq: number;
    pendingCount: number;
    lastError: SyncError | null;
    /** Protocol version of the daemon, known after the first sync. */
    daemonProtocol: number | null;
    /** When the computer last confirmed the state shown (also from the cache), `null` if never. */
    syncedAt: number | null;
}

/** The subset of the browser WebSocket used by the client (lets tests inject fakes). */
export interface SocketLike {
    readonly readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    /** `reason`: why the computer refused this device, when it said so before closing. */
    onclose: ((event: { code: number; reason?: string }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

export interface SyncClientOptions {
    /** Relay WebSocket URL including the room, e.g. `wss://host/ws?room=<roomId>`. */
    url: string;
    /** Project to follow, one of the computer's. Without it only the project list arrives. */
    projectId?: string;
    /** This device and the computer it paired with: the end-to-end handshake proves both. */
    identity: DeviceIdentity;
    /**
     * Tests of the sync protocol only: what wraps the relay socket. Always `secureSocket` in the
     * app; a test that scripts a fake daemon passes the socket through instead.
     */
    transport?: (raw: SocketLike, identity: DeviceIdentity) => SocketLike;
    createSocket?: (url: string) => SocketLike;
    minReconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    /** Interval of app-level pings; the socket is recycled if nothing arrives for 2.5×. */
    heartbeatMs?: number;
    random?: () => number;
    /**
     * Keeps each project's state and queued edits across launches: the app shows them while the
     * computer is off, and the queue is sent once it is back.
     */
    cache?: ClientCache;
}

const OPEN = 1;

/** How long an answer about a screenshot is waited for. */
const IMAGE_PUT_TIMEOUT_MS = 30_000;
const IMAGE_GET_TIMEOUT_MS = 20_000;

function toBase64(bytes: Uint8Array): string {
    let text = '';
    for (let start = 0; start < bytes.length; start += 0x8000) {
        text += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
    }
    return btoa(text);
}

function fromBase64(data: string): Uint8Array {
    const text = atob(data);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
    return bytes;
}

/** The computer answered an `image.put` with a refusal: it will not take this screenshot. */
export class ImageRefusedError extends Error {
    override name = 'ImageRefusedError';
}

/** Somebody waiting for the computer to answer about a screenshot. */
interface ImageWait {
    resolve: (value: never) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

type ItemUpdatePayload = OpOf<'item.update'>['payload'];
type DeviceOpType =
    | 'item.add'
    | 'item.update'
    | 'item.remove'
    | 'session.note'
    | 'session.remove'
    | 'session.done';

/**
 * Keeps one project of a paired computer in sync over the relay WebSocket (the daemon answers
 * through it) and holds the computer's project list, which the daemon keeps up to date.
 *
 * Local edits are optimistic: they are applied immediately on top of the confirmed state and
 * kept as pending until the server echoes them back (or rejects them). Pending ops survive
 * disconnections and are re-sent after every (re)sync; the server drops duplicates by opId.
 * With a `cache`, state and queue also survive a restart of the app.
 */
export class SyncClient {
    readonly #options: Required<Omit<SyncClientOptions, 'createSocket' | 'projectId' | 'cache'>> &
        Pick<SyncClientOptions, 'createSocket' | 'projectId' | 'cache'>;
    readonly #clock: LamportClock;
    readonly #listeners = new Set<() => void>();

    #socket: SocketLike | null = null;
    #status: ConnectionStatus = 'stopped';
    /** Project this client follows; `undefined` until one is picked. */
    #projectId: string | undefined;
    #project: ProjectInfo | null = null;
    #shares: SessionShares[] = [];
    #waiting: string[] | null = null;
    #computer: ComputerInfo | null = null;
    #projects: ProjectSummary[] = [];
    #confirmed: ProjectState | null = null;
    #seq = 0;
    #pending: Op[] = [];
    #lastError: SyncError | null = null;
    /** The computer said it revoked this device (`unpair`). */
    #revoked = false;
    #unauthorizedReason: UnauthorizedReason | null = null;
    /** Transient refusals in a row since the client was last online. */
    #transientRetries = 0;
    /** Ops of the other projects waiting to be confirmed: switching must not lose a review. */
    readonly #pendingElsewhere = new Map<string, Op[]>();
    #daemonProtocol: number | null = null;
    /** Notifications of this device: `undefined` until the app knows, `null` when off. */
    #push: PushRegistration | null | undefined;
    #visible = true;
    #syncedAt: number | null = null;
    #snapshot: SyncSnapshot;

    /** Project whose cached entry has been merged in: only then is it written back. */
    #hydrated: string | undefined;
    /** Project already asked for on the current socket (in `hello` or `subscribe`). */
    #subscribedOn: string | undefined;
    /** The daemon has synced the followed project on this socket: ops can be sent. */
    #live = false;
    #saved: CachedProject | undefined;
    readonly #unsaved = new Map<string, CachedProject>();
    #saving: Promise<void> | null = null;

    /** Answers awaited about screenshots, by `put:<id>` or `get:<id>`. */
    readonly #imageWaits = new Map<string, ImageWait[]>();
    /** Screenshots made while the computer was away, still to be sent, by id. */
    readonly #queuedImages = new Map<string, PendingImage>();
    /** The cache's queue of screenshots was read (once, with the first project). */
    #queuedLoaded = false;

    #attempt = 0;
    #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    #lastMessageAt = 0;

    constructor(options: SyncClientOptions) {
        this.#options = {
            minReconnectDelayMs: 500,
            maxReconnectDelayMs: 15_000,
            heartbeatMs: 20_000,
            random: Math.random,
            transport: secureSocket,
            ...options,
        };
        this.#projectId = options.projectId;
        this.#clock = new LamportClock(options.identity.deviceId);
        this.#snapshot = this.#buildSnapshot();
    }

    // -- store interface (compatible with React's useSyncExternalStore) --------------------

    subscribe = (listener: () => void): (() => void) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    };

    getSnapshot = (): SyncSnapshot => this.#snapshot;

    // -- lifecycle ---------------------------------------------------------------------------

    start(): void {
        if (this.#status !== 'stopped' && this.#status !== 'unauthorized') return;
        const projectId = this.#projectId;
        if (!this.#options.cache || !projectId || this.#hydrated === projectId) {
            this.#connect();
            return;
        }
        // Cached state first: the hello then resumes from its seq instead of a full snapshot.
        this.#setStatus('connecting');
        void this.#hydrate(projectId).then(() => {
            if (this.#status === 'connecting' && !this.#socket) this.#connect();
        });
    }

    stop(): void {
        this.#clearTimers();
        for (const key of [...this.#imageWaits.keys()]) {
            this.#settleImage(key, 'reject', new Error('The connection was closed.'));
        }
        const socket = this.#socket;
        this.#socket = null;
        this.#waiting = null;
        socket?.close(1000, 'client stopped');
        this.#setStatus('stopped');
    }

    /**
     * Follows another project of the same computer, on the same connection: the daemon answers
     * with its snapshot. Ops still waiting for a confirmation are kept and re-sent when the
     * client comes back to their project.
     */
    follow(projectId: string | null): void {
        if (this.#projectId === (projectId ?? undefined)) return;
        if (this.#projectId && this.#pending.length > 0) {
            this.#pendingElsewhere.set(this.#projectId, this.#pending);
        }
        this.#projectId = projectId ?? undefined;
        this.#pending = (projectId && this.#pendingElsewhere.get(projectId)) || [];
        if (projectId) this.#pendingElsewhere.delete(projectId);
        this.#project = null;
        this.#shares = [];
        this.#waiting = null;
        this.#confirmed = null;
        this.#seq = 0;
        this.#syncedAt = null;
        this.#lastError = null;
        this.#hydrated = undefined;
        this.#live = false;
        // The new project must be asked for even if it is the one asked for last on this socket
        // (a list that went empty and came back): the computer sends nothing unasked.
        this.#subscribedOn = undefined;
        if (projectId && this.#options.cache) {
            // Subscribes once the cached entry is in, with its seq.
            void this.#hydrate(projectId);
        } else {
            this.#subscribe();
        }
        this.#emit();
    }

    /**
     * Resolves once every change made so far is in the cache (e.g. before the page is hidden).
     */
    whenSaved(): Promise<void> {
        return this.#saving ?? Promise.resolve();
    }

    /** Skips the backoff wait, e.g. when the page becomes visible or the network comes back. */
    reconnectNow(): void {
        // Given up after transient refusals: the device woke up, maybe on a better network.
        if (this.#status === 'unauthorized' && this.#unauthorizedReason === 'other') {
            this.#transientRetries = 0;
            this.#connect();
            return;
        }
        if (this.#status !== 'offline' && this.#status !== 'daemon-offline') return;
        clearTimeout(this.#reconnectTimer);
        this.#connect();
    }

    // -- edits -------------------------------------------------------------------------------

    /** Sets status and/or note of an item. Returns the op, or `null` before the first sync. */
    updateItem(sessionId: string, payload: ItemUpdatePayload): Op | null {
        return this.#submit(sessionId, 'item.update', payload);
    }

    /** Adds an item (without review) to a checklist of the session. `null` before the first sync. */
    addItem(sessionId: string, payload: OpOf<'item.add'>['payload']): Op | null {
        return this.#submit(sessionId, 'item.add', payload);
    }

    /** Removes an item the user added. `null` before the first sync. */
    removeItem(sessionId: string, itemId: string): Op | null {
        return this.#submit(sessionId, 'item.remove', { itemId });
    }

    /**
     * Deletes a project of the computer, with its sessions, checklists and reviews, on the
     * computer and on every device. The folder and its files are not touched. Unlike an item or
     * session op, this is not queued: it needs a live connection, since it is not part of the
     * op log. Offline, it reports an error instead of silently doing nothing.
     */
    /**
     * Archives sessions of a project of this computer, or takes them out of the archive: the
     * ones given, or all of them (archiving a project). The computer writes it, so it needs a
     * connection; offline nothing changes and the error says so. Any project of the computer,
     * not only the one followed.
     */
    archive(projectId: string, archived: boolean, sessionIds?: string[]): boolean {
        if (this.#status !== 'online') {
            this.#lastError = {
                code: 'internal',
                message: `You are offline: nothing was ${archived ? 'archived' : 'taken out of the archive'}. Try again once this device reconnects.`,
            };
            this.#emit();
            return false;
        }
        this.#sendControl({
            type: 'archive',
            projectId,
            archived,
            ...(sessionIds && { sessionIds }),
        });
        return true;
    }

    removeProject(projectId: string): void {
        if (this.#status !== 'online') {
            this.#lastError = {
                code: 'internal',
                message:
                    'You are offline: the project was not deleted. Try again once this device reconnects.',
            };
            this.#emit();
            return;
        }
        this.#sendControl({ type: 'project.remove', projectId });
    }

    /**
     * Sends a screenshot of a session to the computer, which keeps it as a file. It is not an op:
     * resolves once the computer stored it, or once this device has kept it to send when the
     * computer is back (the note that names it is written separately, and travels as an op).
     * Rejects with the reason when it cannot be done: too big, refused by the computer, or the
     * computer is away and not known to take screenshots.
     */
    async putImage(sessionId: string, imageId: string, image: StoredImage): Promise<void> {
        const projectId = this.#projectId;
        if (!projectId) throw new Error('No project is open.');
        // Before anything is queued: a frame the relay refuses closes the connection, and the
        // same message sent again at every reconnection would never get through.
        if (image.bytes.length > LIMITS.image) throw new Error('The screenshot is too large.');
        const cache = this.#options.cache;
        if (this.#status === 'online') {
            try {
                await this.#imageRequest<void>(
                    `put:${imageId}`,
                    {
                        type: 'image.put',
                        projectId,
                        sessionId,
                        imageId,
                        mime: image.mime,
                        data: toBase64(image.bytes),
                    },
                    IMAGE_PUT_TIMEOUT_MS,
                );
                await cache?.saveImage?.(imageId, image).catch(() => undefined);
                return;
            } catch (error) {
                // The computer said no, or there is no way to keep it for later.
                if (error instanceof ImageRefusedError || !this.canKeepImages()) throw error;
            }
        }
        if (!this.canKeepImages()) {
            throw new Error(
                this.#daemonProtocol === null
                    ? 'You are offline, and this device has not seen this computer yet.'
                    : 'This computer needs `palmtop update` to take screenshots.',
            );
        }
        const waiting: PendingImage = { imageId, projectId, sessionId, image };
        this.#queuedImages.set(imageId, waiting);
        await cache?.savePendingImage?.(waiting).catch(() => undefined);
        this.#emit();
    }

    /**
     * Whether a screenshot can be taken now: the computer takes them (it was seen to, even if it is
     * away now) and a project is open. Offline it is kept and sent when the computer is back.
     */
    canKeepImages(): boolean {
        return (this.#daemonProtocol ?? 0) >= 6 && this.#projectId !== undefined;
    }

    /**
     * A screenshot named in a note of the followed project: from this device when it has it, else
     * from the computer (kept here for next time). `null` when it is not to be had: the computer
     * does not have it, or is not reachable and this device never saw it.
     */
    async getImage(imageId: string): Promise<StoredImage | null> {
        const cache = this.#options.cache;
        const cached = await cache?.loadImage?.(imageId).catch(() => null);
        if (cached) return cached;
        const projectId = this.#projectId;
        if (this.#status !== 'online' || !projectId) return null;
        const image = await this.#imageRequest<{ mime: StoredImage['mime']; data: string } | null>(
            `get:${imageId}`,
            { type: 'image.get', projectId, imageId },
            IMAGE_GET_TIMEOUT_MS,
        );
        if (!image) return null;
        const stored = { mime: image.mime, bytes: fromBase64(image.data) };
        await cache?.saveImage?.(imageId, stored).catch(() => undefined);
        return stored;
    }

    /** Sends a request about a screenshot and waits for its answer; the same ask is sent once. */
    #imageRequest<T>(key: string, message: object, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const waits = this.#imageWaits.get(key) ?? [];
            const timer = setTimeout(() => {
                this.#settleImage(key, 'reject', new Error('The computer did not answer in time.'));
            }, timeoutMs);
            waits.push({ resolve: resolve as (value: never) => void, reject, timer });
            this.#imageWaits.set(key, waits);
            if (waits.length === 1) this.#sendControl(message);
        });
    }

    #settleImage(key: string, outcome: 'resolve', value: unknown): void;
    #settleImage(key: string, outcome: 'reject', error: Error): void;
    #settleImage(key: string, outcome: 'resolve' | 'reject', value: unknown): void {
        const waits = this.#imageWaits.get(key);
        if (!waits) return;
        this.#imageWaits.delete(key);
        for (const wait of waits) {
            clearTimeout(wait.timer);
            if (outcome === 'resolve') wait.resolve(value as never);
            else wait.reject(value as Error);
        }
    }

    /** Sets the user's note for the agent on the session (`''` clears it). */
    setSessionNote(sessionId: string, note: string): Op | null {
        return this.#submit(sessionId, 'session.note', { note });
    }

    /**
     * Tells the agent the user finished reviewing the session (the computer takes it back when the
     * agent writes in the session again). `null` before the first sync.
     */
    markSessionDone(sessionId: string): Op | null {
        return this.#submit(sessionId, 'session.done', { done: true });
    }

    /** Deletes a session with its checklists, also on the computer. `null` before the first sync. */
    removeSession(sessionId: string): Op | null {
        return this.#submit(sessionId, 'session.remove', {});
    }

    #submit<T extends DeviceOpType>(
        sessionId: string,
        type: T,
        payload: OpOf<T>['payload'],
    ): Op | null {
        const view = this.#snapshot.state;
        const projectId = this.#projectId;
        if (!view || !projectId) return null;
        this.#clock.observe(view.lamport);
        const op = opSchema.parse(
            createOp({
                projectId,
                sessionId,
                type,
                payload,
                clock: this.#clock.tick(),
            }),
        );
        this.#pending = [...this.#pending, op];
        this.#sendOp(op);
        this.#emit();
        return op;
    }

    /**
     * Push subscription of this device for the computer (`null`: notifications off). Sent after
     * every sync, so a computer that was offline gets it too. Never part of the project state.
     */
    setPush(push: PushRegistration | null): void {
        this.#push = push;
        this.#sendPush();
    }

    /**
     * Asks the computer to forget this device (its key and its notifications) and resolves `true`
     * once it said so, sealed, and closed the connection; `false` after `timeoutMs` or on any other
     * close. Offline it resolves `false` at once: `palmtop devices remove` on the computer does the
     * same. The client stops either way.
     */
    async unpair(timeoutMs = 3_000): Promise<boolean> {
        if (this.#status !== 'online') {
            this.stop();
            return false;
        }
        this.#revoked = false;
        const closed = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => done(false), timeoutMs);
            const unsubscribe = this.subscribe(() => {
                if (this.#status !== 'online') done(this.#revoked);
            });
            const done = (revoked: boolean) => {
                clearTimeout(timer);
                unsubscribe();
                resolve(revoked);
            };
        });
        this.#sendControl({ type: 'device.unpair' });
        const revoked = await closed;
        this.stop();
        return revoked;
    }

    /** Tells the computer whether the app is on screen: no notifications while it is. */
    setVisible(visible: boolean): void {
        if (this.#visible === visible) return;
        this.#visible = visible;
        this.#sendControl({ type: 'presence', visible });
    }

    #sendPush(): void {
        if (this.#push === undefined) return;
        this.#sendControl(
            this.#push
                ? { type: 'push.subscribe', push: this.#push }
                : { type: 'push.unsubscribe' },
        );
    }

    #sendControl(message: object): void {
        const socket = this.#socket;
        if (this.#status === 'online' && socket?.readyState === OPEN) {
            socket.send(JSON.stringify(message));
        }
    }

    dismissError(): void {
        if (!this.#lastError) return;
        this.#lastError = null;
        this.#emit();
    }

    // -- connection --------------------------------------------------------------------------

    #connect(): void {
        this.#clearTimers();
        this.#unauthorizedReason = null;
        // While retrying, keep showing why the client is not live: flipping to "connecting" on
        // every attempt made the offline notice blink in the app.
        if (this.#status !== 'offline' && this.#status !== 'daemon-offline') {
            this.#setStatus('connecting');
        }
        const factory = this.#options.createSocket ?? ((url) => new WebSocket(url) as SocketLike);
        // Open once the handshake is done: everything below runs on the sealed channel.
        const socket = this.#options.transport(factory(this.#options.url), this.#options.identity);
        this.#socket = socket;

        socket.onopen = () => {
            if (this.#socket !== socket) return;
            this.#lastMessageAt = Date.now();
            // A project whose cache is still loading is asked for once it is in.
            const projectId = this.#ready() ? this.#projectId : undefined;
            this.#subscribedOn = projectId;
            socket.send(
                JSON.stringify({
                    type: 'hello',
                    archive: true,
                    done: true,
                    ...(projectId && { projectId }),
                    ...(projectId && this.#confirmed && { lastSeq: this.#seq }),
                }),
            );
            this.#startHeartbeat(socket);
        };
        socket.onmessage = (event) => {
            if (this.#socket !== socket) return;
            this.#lastMessageAt = Date.now();
            const parsed = parseServerMessage(String(event.data));
            if (parsed.ok) this.#handle(socket, parsed.value);
        };
        socket.onerror = () => {
            // A close event always follows; reconnection is handled there.
        };
        socket.onclose = (event) => {
            if (this.#socket !== socket) return;
            this.#socket = null;
            this.#subscribedOn = undefined;
            this.#live = false;
            // What an agent waits for is only known while connected: the computer tells again.
            this.#waiting = null;
            clearInterval(this.#heartbeatTimer);
            for (const key of [...this.#imageWaits.keys()]) {
                this.#settleImage(key, 'reject', new Error('The connection was lost.'));
            }
            if (FATAL_CLOSE_CODES.has(event.code)) {
                const reason = unauthorizedReasonOf(event.reason, this.#revoked);
                // Not about this device's pairing: a broken channel, tried again a few times.
                // Giving up at once showed "Not paired" for a frame lost on a bad network.
                if (
                    reason === 'other' &&
                    event.code === CloseCode.unauthorized &&
                    this.#transientRetries < MAX_TRANSIENT_RETRIES
                ) {
                    this.#transientRetries += 1;
                    this.#setStatus('connecting');
                    this.#scheduleReconnect();
                    return;
                }
                this.#unauthorizedReason = reason;
                this.#setStatus('unauthorized');
                return;
            }
            this.#setStatus(event.code === CloseCode.daemonOffline ? 'daemon-offline' : 'offline');
            this.#scheduleReconnect();
        };
    }

    #scheduleReconnect(): void {
        const { minReconnectDelayMs, maxReconnectDelayMs, random } = this.#options;
        const base = Math.min(maxReconnectDelayMs, minReconnectDelayMs * 2 ** this.#attempt);
        const delay = base / 2 + random() * (base / 2);
        this.#attempt += 1;
        this.#reconnectTimer = setTimeout(() => this.#connect(), delay);
    }

    #startHeartbeat(socket: SocketLike): void {
        const { heartbeatMs } = this.#options;
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = setInterval(() => {
            if (this.#socket !== socket) return;
            if (Date.now() - this.#lastMessageAt > heartbeatMs * 2.5) {
                // Half-open connection (e.g. the phone slept): recycle it.
                socket.close(RESYNC_CLOSE_CODE, 'heartbeat timeout');
                socket.onclose?.({ code: RESYNC_CLOSE_CODE });
                return;
            }
            if (socket.readyState === OPEN) socket.send('{"type":"ping"}');
        }, heartbeatMs);
    }

    #clearTimers(): void {
        clearTimeout(this.#reconnectTimer);
        clearInterval(this.#heartbeatTimer);
    }

    // -- messages ----------------------------------------------------------------------------

    #handle(socket: SocketLike, message: ServerMessage): void {
        switch (message.type) {
            case 'snapshot':
                // The computer sends the answers again right after a sync, if there are any.
                this.#shares = [];
                this.#project = message.project;
                this.#daemonProtocol = message.protocol ?? 1;
                // A computer that knows `waiting` tells which sessions an agent waits in right after
                // the sync, when there are any: none until then.
                this.#waiting = this.#daemonProtocol >= 8 ? [] : null;
                this.#confirmed = message.state;
                this.#seq = message.seq;
                this.#syncedAt = Date.now();
                this.#clock.observe(message.state.lamport);
                this.#dropApplied();
                this.#synced();
                return;

            case 'ops': {
                this.#project = message.project;
                this.#daemonProtocol = message.protocol ?? 1;
                if (!this.#confirmed) {
                    this.#resync(socket);
                    return;
                }
                this.#shares = [];
                this.#waiting = this.#daemonProtocol >= 8 ? [] : null;
                const fresh = message.ops.filter((entry) => entry.seq > this.#seq);
                this.#confirmed = applyAll(
                    this.#confirmed,
                    fresh.map((entry) => entry.op),
                );
                this.#dropPending(fresh.map((entry) => entry.op.opId));
                this.#seq = Math.max(this.#seq, message.seq);
                this.#syncedAt = Date.now();
                this.#clock.observe(this.#confirmed.lamport);
                this.#synced();
                return;
            }

            case 'op': {
                if (!this.#confirmed || message.seq <= this.#seq) return;
                if (message.seq !== this.#seq + 1) {
                    this.#resync(socket);
                    return;
                }
                this.#confirmed = applyAll(this.#confirmed, [message.op]);
                this.#seq = message.seq;
                this.#syncedAt = Date.now();
                this.#clock.observe(message.op.clock.lamport);
                this.#dropPending([message.op.opId]);
                this.#emit();
                return;
            }

            case 'project':
                this.#project = message.project;
                this.#emit();
                return;

            case 'shares':
                if (message.projectId !== this.#projectId) return;
                this.#shares = message.sessions;
                this.#emit();
                return;

            case 'waiting':
                if (message.projectId !== this.#projectId) return;
                this.#waiting = message.sessionIds;
                this.#emit();
                return;

            case 'projects':
                this.#computer = message.computer;
                this.#projects = message.projects;
                // Without a project to follow the list is all there is to sync: the computer is
                // live (a computer just paired, with no projects yet).
                if (!this.#projectId && this.#status !== 'online') {
                    this.#synced();
                    return;
                }
                this.#emit();
                return;

            case 'image.saved':
                this.#settleImage(`put:${message.imageId}`, 'resolve', undefined);
                return;

            case 'image':
                this.#settleImage(`get:${message.imageId}`, 'resolve', message);
                return;

            case 'image.missing':
                this.#settleImage(`get:${message.imageId}`, 'resolve', null);
                return;

            case 'error': {
                // A screenshot the computer refused: whoever sent it gets the reason.
                if (message.imageId) {
                    this.#settleImage(
                        `put:${message.imageId}`,
                        'reject',
                        new ImageRefusedError(message.message),
                    );
                    return;
                }
                if (message.code === 'unauthorized' && message.message === DEVICE_UNPAIRED) {
                    this.#revoked = true;
                    return;
                }
                const rejected = this.#pending.find((op) => op.opId === message.opId);
                // A session deleted elsewhere (or twice) rejects the ops still queued for it:
                // nothing to report, the outcome is the one the user sees.
                if (!rejected || !this.#isGone(rejected)) {
                    this.#lastError = {
                        code: message.code,
                        message: message.message,
                        ...(message.opId && { opId: message.opId }),
                    };
                }
                // A rejected op is rolled back: the view is recomputed without it.
                if (message.opId) this.#dropPending([message.opId]);
                this.#emit();
                return;
            }

            case 'ping':
                if (socket.readyState === OPEN) socket.send('{"type":"pong"}');
                return;

            case 'pong':
                return;
        }
    }

    /** After a snapshot or a catch-up: go online and re-send what the server has not echoed. */
    #synced(): void {
        this.#attempt = 0;
        this.#transientRetries = 0;
        this.#status = 'online';
        this.#live = true;
        this.#pending = this.#pending.filter((op) => !this.#isGone(op));
        // The screenshots made while away go first, so the notes that name them find them.
        this.#flushImages(() => {
            for (const op of this.#pending) this.#sendOp(op);
        });
        // The computer assumes a new connection is on screen.
        if (!this.#visible) this.#sendControl({ type: 'presence', visible: false });
        this.#sendPush();
        this.#emit();
    }

    /**
     * Sends the screenshots kept for the followed project, then calls `next` (the ops go after
     * them). With none to send it is called at once. One the computer refuses is dropped and
     * reported; one that did not get through (the connection was lost) stays for the next sync.
     */
    #flushImages(next: () => void): void {
        const projectId = this.#projectId;
        const cache = this.#options.cache;
        const waiting = [...this.#queuedImages.values()].filter(
            (entry) => entry.projectId === projectId,
        );
        if (waiting.length === 0) {
            next();
            return;
        }
        const send = async (entry: PendingImage) => {
            // A session deleted meanwhile takes its screenshots with it.
            if (this.#isRemovedSession(entry.sessionId)) {
                this.#queuedImages.delete(entry.imageId);
                await cache?.clearPendingImage?.(entry.imageId).catch(() => undefined);
                return;
            }
            try {
                await this.#imageRequest<void>(
                    `put:${entry.imageId}`,
                    {
                        type: 'image.put',
                        projectId: entry.projectId,
                        sessionId: entry.sessionId,
                        imageId: entry.imageId,
                        mime: entry.image.mime,
                        data: toBase64(entry.image.bytes),
                    },
                    IMAGE_PUT_TIMEOUT_MS,
                );
            } catch (error) {
                if (!(error instanceof ImageRefusedError)) return;
                this.#lastError = {
                    code: 'forbidden',
                    message: `A screenshot could not be sent: ${error.message}`,
                };
            }
            this.#queuedImages.delete(entry.imageId);
            await cache?.clearPendingImage?.(entry.imageId).catch(() => undefined);
        };
        void Promise.allSettled(waiting.map(send)).then(() => {
            next();
            this.#emit();
        });
    }

    #isRemovedSession(sessionId: string): boolean {
        return Boolean(this.#confirmed?.sessions[sessionId]?.removed);
    }

    /**
     * An op for something that was deleted elsewhere in the meantime: its session, its checklist
     * (the owner took it out of a shared copy) or its item. It can only be refused: nothing to
     * report, the outcome is the one the user sees. Only what the computer has confirmed counts,
     * so an op for an item that is still queued is never taken for gone.
     */
    #isGone(op: Op): boolean {
        if (this.#isRemovedSession(op.sessionId)) return true;
        const state = this.#confirmed;
        if (!state) return false;
        switch (op.type) {
            case 'item.update':
            case 'item.remove':
                return (
                    state.items[op.payload.itemId] !== undefined &&
                    getItem(state, op.payload.itemId) === null
                );
            case 'item.add':
            case 'checklist.update':
            case 'checklist.remove':
                return (
                    state.checklists[op.payload.checklistId] !== undefined &&
                    getChecklist(state, op.payload.checklistId) === null
                );
            default:
                return false;
        }
    }

    #resync(socket: SocketLike): void {
        // Drop the local copy and reconnect: the next hello gets a full snapshot.
        this.#confirmed = null;
        this.#seq = 0;
        socket.close(RESYNC_CLOSE_CODE, 'resync');
    }

    #sendOp(op: Op): void {
        const socket = this.#socket;
        // Not before the followed project is synced: the op would go to the previous one.
        if (this.#live && socket?.readyState === OPEN) {
            socket.send(JSON.stringify({ type: 'op', op }));
        }
    }

    #dropPending(opIds: string[]): void {
        if (this.#pending.length === 0 || opIds.length === 0) return;
        const done = new Set(opIds);
        this.#pending = this.#pending.filter((op) => !done.has(op.opId));
    }

    /**
     * Drops the queued ops that no longer change the confirmed state. The daemon ignores an op
     * it already has without echoing it, so an op applied just before a disconnection, whose
     * echo was lost, would otherwise stay queued (and cached) for ever. An op that changes
     * nothing here would change nothing on the computer either: the outcome is the same.
     */
    #dropApplied(): void {
        if (!this.#confirmed || this.#pending.length === 0) return;
        let state = this.#confirmed;
        let before = JSON.stringify(state);
        const kept: Op[] = [];
        for (const op of this.#pending) {
            const next = applyAll(state, [op]);
            const after = JSON.stringify(next);
            if (after === before) continue;
            kept.push(op);
            state = next;
            before = after;
        }
        if (kept.length !== this.#pending.length) this.#pending = kept;
    }

    /** Whether the followed project can be asked for (its cached entry, if any, is in). */
    #ready(): boolean {
        return (
            Boolean(this.#projectId) && (!this.#options.cache || this.#hydrated === this.#projectId)
        );
    }

    /** Asks for the followed project on the open socket, resuming from the known seq. */
    #subscribe(): void {
        const projectId = this.#projectId;
        const socket = this.#socket;
        // The subscription goes out as soon as the socket is open, even before the first sync
        // (a device that pairs with a computer has no project yet). Offline, the next `hello`
        // asks for this project instead.
        if (!projectId || socket?.readyState !== OPEN || this.#subscribedOn === projectId) return;
        this.#subscribedOn = projectId;
        socket.send(
            JSON.stringify({
                type: 'subscribe',
                archive: true,
                done: true,
                projectId,
                ...(this.#confirmed && { lastSeq: this.#seq }),
            }),
        );
    }

    /**
     * Merges the cached entry of a project: its state and seq when the computer has not sent a
     * fresher one yet, and its queued ops, which were made before the ones of this run.
     */
    async #hydrate(projectId: string): Promise<void> {
        const cache = this.#options.cache;
        if (!cache) return;
        let entry: CachedProject | null = null;
        try {
            entry = await cache.load(projectId);
        } catch {
            // No cache (private mode, quota, blocked): the client works as without one.
        }
        // The screenshots still to be sent, of every project: read once.
        if (!this.#queuedLoaded) {
            this.#queuedLoaded = true;
            try {
                for (const waiting of (await cache.pendingImages?.()) ?? []) {
                    if (!this.#queuedImages.has(waiting.imageId)) {
                        this.#queuedImages.set(waiting.imageId, waiting);
                    }
                }
            } catch {
                // Not to be sent from here: they stay in the cache.
            }
        }
        if (this.#projectId !== projectId || this.#hydrated === projectId) return;
        this.#hydrated = projectId;
        if (entry) {
            this.#daemonProtocol ??= entry.protocol ?? null;
            if (!this.#confirmed && entry.state) {
                this.#confirmed = entry.state;
                this.#seq = entry.seq;
                this.#syncedAt = entry.syncedAt;
                this.#clock.observe(entry.state.lamport);
                this.#shares = entry.shares ?? [];
            }
            this.#project ??= entry.project;
            const known = new Set(this.#pending.map((op) => op.opId));
            const restored = entry.pending.filter((op) => !known.has(op.opId));
            for (const op of restored) this.#clock.observe(op.clock.lamport);
            this.#pending = [...restored, ...this.#pending];
            // Already synced (the computer answered first): send them now, else on sync.
            if (this.#live) {
                this.#dropApplied();
                for (const op of restored) {
                    if (this.#pending.includes(op) && !this.#isRemovedSession(op.sessionId)) {
                        this.#sendOp(op);
                    }
                }
            }
        }
        this.#subscribe();
        this.#emit();
    }

    /** Writes the followed project to the cache when something in it changed. */
    #save(): void {
        const cache = this.#options.cache;
        const projectId = this.#projectId;
        if (!cache || !projectId || this.#hydrated !== projectId || !this.#confirmed) return;
        const saved = this.#saved;
        if (
            saved?.projectId === projectId &&
            saved.state === this.#confirmed &&
            saved.pending === this.#pending &&
            saved.seq === this.#seq &&
            saved.project === this.#project &&
            saved.shares === this.#shares &&
            saved.protocol === (this.#daemonProtocol ?? undefined) &&
            saved.syncedAt === this.#syncedAt
        ) {
            return;
        }
        const entry: CachedProject = {
            projectId,
            project: this.#project,
            state: this.#confirmed,
            seq: this.#seq,
            pending: this.#pending,
            syncedAt: this.#syncedAt,
            shares: this.#shares,
            ...(this.#daemonProtocol !== null && { protocol: this.#daemonProtocol }),
        };
        this.#saved = entry;
        // One write at a time, the latest entry of each project: a burst of ops is one write.
        this.#unsaved.set(projectId, entry);
        this.#saving ??= this.#drain(cache);
    }

    async #drain(cache: ClientCache): Promise<void> {
        for (const [projectId, entry] of this.#unsaved) {
            this.#unsaved.delete(projectId);
            try {
                await cache.save(entry);
            } catch {
                // Kept in memory: the next change tries again.
                if (this.#saved === entry) this.#saved = undefined;
            }
        }
        this.#saving = null;
    }

    #setStatus(status: ConnectionStatus): void {
        if (this.#status === status) return;
        this.#status = status;
        this.#emit();
    }

    #emit(): void {
        this.#save();
        this.#snapshot = this.#buildSnapshot();
        for (const listener of this.#listeners) listener();
    }

    /** Screenshots kept for a project that the computer has not got yet. */
    #queuedFor(projectId: string | undefined): number {
        let count = 0;
        for (const waiting of this.#queuedImages.values()) {
            if (waiting.projectId === projectId) count++;
        }
        return count;
    }

    #buildSnapshot(): SyncSnapshot {
        return {
            status: this.#status,
            projectId: this.#projectId ?? null,
            project: this.#project,
            computer: this.#computer,
            projects: this.#projects,
            unauthorizedReason: this.#unauthorizedReason,
            state: this.#confirmed ? applyAll(this.#confirmed, this.#pending) : null,
            shares: this.#shares,
            waiting: this.#waiting,
            seq: this.#seq,
            pendingCount: this.#pending.length + this.#queuedFor(this.#projectId),
            lastError: this.#lastError,
            daemonProtocol: this.#daemonProtocol,
            syncedAt: this.#confirmed ? this.#syncedAt : null,
        };
    }
}

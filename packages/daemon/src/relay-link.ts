import {
    type CliRelease,
    CloseCode,
    DAEMON_PROTOCOL_VERSION,
    type DaemonMessage,
    type PairOfferStatus,
    parseRelayMessage,
    RELAY_DAEMON_PATH,
    type RelayMessage,
} from '@palmtopai/protocol';
import type { DeviceHub, DeviceTransport } from './device-hub';

/** `outdated`: the relay refuses this daemon's protocol, the user must run `palmtop update`. */
export type RelayStatus = 'connecting' | 'connected' | 'disconnected' | 'outdated' | 'stopped';

/** `relay_unavailable`: not connected, or no answer (e.g. a relay older than pairing codes). */
export type PairOfferResult = PairOfferStatus | 'relay_unavailable';

export interface PairOffer {
    code: string;
    key: string;
    computer: string;
}

export type PublishedRelease = Pick<CliRelease, 'version' | 'build'>;

/** The subset of the WebSocket API used by the link (global WebSocket in Node ≥ 22 and Bun). */
export interface RelaySocket {
    readonly readyState: number;
    onopen: ((event: unknown) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: { code: number }) => void) | null;
    onerror: ((event: unknown) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
}

/** What a relay room needs from the daemon: the proof of its key, and the hub of its devices. */
export interface RelayRoomIdentity {
    readonly roomId: string;
    roomProof(nonce: string): { publicKey: string; signature: string };
}

interface RelayRoom {
    identity: RelayRoomIdentity;
    hub: DeviceHub;
    /** The room of a person a checklist is shared with: the relay counts it apart. */
    guest: boolean;
}

export interface RelayLinkOptions {
    /** `wss://host` (or `ws://` for local development). */
    url: string;
    /** The computer's room: always held, as long as the daemon runs. */
    registry: RelayRoomIdentity;
    hub: DeviceHub;
    log: (line: string) => void;
    minReconnectDelayMs?: number;
    maxReconnectDelayMs?: number;
    heartbeatMs?: number;
    /** A connection not authorized within this time is dropped and retried. */
    connectTimeoutMs?: number;
    /** How long to wait for the relay to answer a `pair.offer`. */
    pairOfferTimeoutMs?: number;
    createSocket?: (url: string) => RelaySocket;
}

const OPEN = 1;

/**
 * Outbound connection from the daemon to the relay. On every connection the relay sends a fresh
 * nonce; the daemon signs it with the key of the computer's room and gets a session token that
 * lives only as long as this connection. Devices' messages then flow through `DeviceHub`.
 */
export class RelayLink implements DeviceTransport {
    readonly url: string;
    readonly #options: Required<Omit<RelayLinkOptions, 'createSocket'>> &
        Pick<RelayLinkOptions, 'createSocket'>;
    /** The rooms this daemon serves (the computer's, and one for each person that is active). */
    readonly #rooms = new Map<string, RelayRoom>();
    /** The rooms the relay confirmed on this connection. */
    readonly #open = new Set<string>();
    /** The hub of each device connection, by the relay's connection id. */
    readonly #hubs = new Map<string, DeviceHub>();
    /** Proves a room opened after the authorization: valid for this connection only. */
    #nonce: string | null = null;
    #sessionToken: string | null = null;
    #socket: RelaySocket | null = null;
    #status: RelayStatus = 'stopped';
    #attempt = 0;
    #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    #heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    #connectTimer: ReturnType<typeof setTimeout> | undefined;
    #lastMessageAt = 0;
    /** Logs only transitions, not every failed attempt while the relay is unreachable. */
    #reportedDown = false;
    #outdated = false;
    #release: PublishedRelease | null = null;
    /** `pair.offer` id → answer, for the offers sent on the current connection. */
    readonly #offers = new Map<string, (result: PairOfferResult) => void>();
    #nextOfferId = 0;
    readonly #computer: string;

    constructor(options: RelayLinkOptions) {
        this.url = options.url.replace(/\/+$/, '');
        this.#options = {
            minReconnectDelayMs: 500,
            maxReconnectDelayMs: 30_000,
            heartbeatMs: 25_000,
            connectTimeoutMs: 15_000,
            pairOfferTimeoutMs: 5_000,
            ...options,
        };
        this.#computer = options.registry.roomId;
        this.#rooms.set(this.#computer, {
            identity: options.registry,
            hub: options.hub,
            guest: false,
        });
    }

    get status(): RelayStatus {
        return this.#status;
    }

    /** The CLI published on the relay, as announced on the last authorization. */
    get release(): PublishedRelease | null {
        return this.#release;
    }

    /** True once the relay confirmed the room: its devices can reach this daemon. */
    isRoomOpen(roomId: string): boolean {
        return this.#open.has(roomId);
    }

    /** Rooms served now, the computer's included. */
    get roomCount(): number {
        return this.#rooms.size;
    }

    /**
     * Starts serving the room of a person. Connected, the relay is told right away (`room.open`);
     * otherwise the room goes in with the next authorization.
     */
    addRoom(identity: RelayRoomIdentity, hub: DeviceHub): void {
        if (this.#rooms.has(identity.roomId)) return;
        this.#rooms.set(identity.roomId, { identity, hub, guest: true });
        if (this.#sessionToken === null || this.#nonce === null) return;
        hub.setTransport(this);
        this.#sendMessage({
            type: 'room.open',
            sessionToken: this.#sessionToken,
            ...identity.roomProof(this.#nonce),
            guest: true,
        });
    }

    /** Stops serving a room of a person: the relay frees it and closes its devices. */
    removeRoom(roomId: string): void {
        const room = this.#rooms.get(roomId);
        if (!room?.guest) return;
        this.#rooms.delete(roomId);
        this.#open.delete(roomId);
        room.hub.closeRoom(roomId);
        for (const [conn, hub] of this.#hubs) if (hub === room.hub) this.#hubs.delete(conn);
        room.hub.setTransport(null);
        // Even if the relay has not confirmed it yet: it ignores a room it does not hold.
        if (this.#sessionToken !== null) {
            this.#sendMessage({
                type: 'room.close',
                sessionToken: this.#sessionToken,
                room: roomId,
            });
        }
    }

    start(): void {
        if (this.#status !== 'stopped') return;
        this.#connect();
    }

    stop(): void {
        clearTimeout(this.#reconnectTimer);
        clearTimeout(this.#connectTimer);
        clearInterval(this.#heartbeatTimer);
        const socket = this.#socket;
        this.#socket = null;
        this.#status = 'stopped';
        this.#reset();
        socket?.close(1000, 'daemon stopped');
    }

    /** Sends a pairing key to the phone showing `code`, through the computer's room. */
    offerPairing(offer: PairOffer): Promise<PairOfferResult> {
        const room = this.#open.has(this.#computer) ? this.#computer : null;
        const socket = this.#socket;
        if (this.#status !== 'connected' || room === null || socket?.readyState !== OPEN) {
            return Promise.resolve('relay_unavailable');
        }
        this.#nextOfferId += 1;
        const id = String(this.#nextOfferId);
        return new Promise((resolve) => {
            const timer = setTimeout(
                () => settle('relay_unavailable'),
                this.#options.pairOfferTimeoutMs,
            );
            const settle = (result: PairOfferResult) => {
                clearTimeout(timer);
                this.#offers.delete(id);
                resolve(result);
            };
            this.#offers.set(id, settle);
            this.#sendMessage({ type: 'pair.offer', id, room, ...offer });
        });
    }

    // -- DeviceTransport ---------------------------------------------------------------------

    send(conns: string[], data: string): void {
        this.#sendMessage({ type: 'device.send', conns, data });
    }

    close(conn: string, code: number, reason: string): void {
        this.#hubs.delete(conn);
        this.#sendMessage({ type: 'device.close', conn, code, reason });
    }

    // -- connection --------------------------------------------------------------------------

    #connect(): void {
        this.#status = 'connecting';
        const factory =
            this.#options.createSocket ?? ((url) => new WebSocket(url) as unknown as RelaySocket);
        let socket: RelaySocket;
        try {
            socket = factory(`${this.url}${RELAY_DAEMON_PATH}`);
        } catch (error) {
            this.#down(`invalid relay URL (${(error as Error).message})`);
            return;
        }
        this.#socket = socket;
        clearTimeout(this.#connectTimer);
        this.#connectTimer = setTimeout(
            () => this.#fail(socket, 'no authorization in time'),
            this.#options.connectTimeoutMs,
        );

        socket.onopen = () => {
            if (this.#socket !== socket) return;
            this.#lastMessageAt = Date.now();
            this.#startHeartbeat(socket);
        };
        socket.onmessage = (event) => {
            if (this.#socket !== socket) return;
            this.#lastMessageAt = Date.now();
            const message = parseRelayMessage(String(event.data));
            if (message) this.#handle(message);
        };
        // Node 22 emits only `error` (no `close`) when the connection is refused, and the socket
        // stays CONNECTING forever: treat an error as the end of the connection.
        socket.onerror = () => this.#fail(socket, 'connection error');
        socket.onclose = (event) => {
            if (this.#socket === socket && event.code === CloseCode.outdated) this.#outdated = true;
            this.#fail(socket, `closed with code ${event.code}`);
        };
    }

    /** Ends a connection once (error, close, timeouts) and schedules the next attempt. */
    #fail(socket: RelaySocket, reason: string): void {
        if (this.#socket !== socket) return;
        this.#socket = null;
        clearTimeout(this.#connectTimer);
        clearInterval(this.#heartbeatTimer);
        try {
            socket.close();
        } catch {
            // Already closed or never opened.
        }
        this.#reset();
        this.#down(reason);
    }

    #down(reason: string): void {
        if (this.#status === 'stopped') return;
        if (!this.#reportedDown) {
            this.#options.log(
                this.#outdated
                    ? `relay ${this.url} refuses this palmtop version: run \`palmtop update\``
                    : `relay ${this.url} unreachable (${reason}), retrying`,
            );
            this.#reportedDown = true;
        }
        this.#status = this.#outdated ? 'outdated' : 'disconnected';
        const { minReconnectDelayMs, maxReconnectDelayMs } = this.#options;
        // An outdated daemon keeps trying slowly: the relay may be rolled back.
        const base = this.#outdated
            ? maxReconnectDelayMs
            : Math.min(maxReconnectDelayMs, minReconnectDelayMs * 2 ** this.#attempt);
        this.#attempt += 1;
        this.#reconnectTimer = setTimeout(
            () => this.#connect(),
            base / 2 + Math.random() * (base / 2),
        );
    }

    /** Forgets everything bound to the previous connection. */
    #reset(): void {
        this.#open.clear();
        this.#hubs.clear();
        this.#nonce = null;
        this.#sessionToken = null;
        for (const settle of [...this.#offers.values()]) settle('relay_unavailable');
        for (const { hub } of this.#rooms.values()) hub.setTransport(null);
    }

    #startHeartbeat(socket: RelaySocket): void {
        const { heartbeatMs } = this.#options;
        clearInterval(this.#heartbeatTimer);
        this.#heartbeatTimer = setInterval(() => {
            if (this.#socket !== socket) return;
            if (Date.now() - this.#lastMessageAt > heartbeatMs * 2.5) {
                // Half-open connection (e.g. the computer slept): recycle it.
                this.#fail(socket, 'heartbeat timeout');
                return;
            }
            if (socket.readyState === OPEN) socket.send('{"type":"ping"}');
        }, heartbeatMs);
    }

    #sendMessage(message: DaemonMessage): void {
        const socket = this.#socket;
        if (socket?.readyState === OPEN) socket.send(JSON.stringify(message));
    }

    #handle(message: RelayMessage): void {
        const { log } = this.#options;
        switch (message.type) {
            case 'challenge': {
                this.#nonce = message.nonce;
                const rooms = [...this.#rooms.values()].map(({ identity, guest }) => ({
                    ...identity.roomProof(message.nonce),
                    ...(guest && { guest: true }),
                }));
                this.#sendMessage({ type: 'auth', rooms, protocol: DAEMON_PROTOCOL_VERSION });
                return;
            }

            case 'authorized': {
                clearTimeout(this.#connectTimer);
                this.#release = message.release ?? null;
                this.#outdated = false;
                this.#sessionToken = message.sessionToken;
                this.#open.clear();
                for (const roomId of message.rooms)
                    if (this.#rooms.has(roomId)) this.#open.add(roomId);
                for (const { hub } of this.#rooms.values()) hub.setTransport(this);
                // Rooms added or removed between the authorization and its answer.
                for (const [roomId, room] of this.#rooms) {
                    if (message.rooms.includes(roomId) || this.#nonce === null) continue;
                    this.#sendMessage({
                        type: 'room.open',
                        sessionToken: message.sessionToken,
                        ...room.identity.roomProof(this.#nonce),
                        ...(room.guest && { guest: true }),
                    });
                }
                for (const roomId of message.rooms) {
                    if (this.#rooms.has(roomId)) continue;
                    this.#sendMessage({
                        type: 'room.close',
                        sessionToken: message.sessionToken,
                        room: roomId,
                    });
                }
                this.#status = 'connected';
                this.#attempt = 0;
                log(`connected to relay ${this.url}`);
                this.#reportedDown = false;
                return;
            }

            case 'room.opened':
                if (this.#rooms.has(message.room)) this.#open.add(message.room);
                return;

            case 'room.closed': {
                // Asked for by `removeRoom` (nothing left to do), or another connection proved the
                // same key and now serves the room.
                const room = this.#rooms.get(message.room);
                if (!room) return;
                this.#open.delete(message.room);
                room.hub.closeRoom(message.room);
                log(
                    `relay: another connection opened room ${message.room.slice(0, 6)} with this daemon's key`,
                );
                return;
            }

            case 'device.open': {
                const room = this.#rooms.get(message.room);
                if (!room || !this.#open.has(message.room)) return;
                this.#hubs.set(message.conn, room.hub);
                room.hub.open(message.conn, message.room);
                return;
            }

            case 'device.message':
                this.#hubs.get(message.conn)?.message(message.conn, message.data);
                return;

            case 'device.close':
                this.#hubs.get(message.conn)?.close(message.conn);
                this.#hubs.delete(message.conn);
                return;

            case 'pair.offer.result':
                this.#offers.get(message.id)?.(message.status);
                return;

            case 'error':
                if (message.code === 'outdated') this.#outdated = true;
                log(`relay error: ${message.code} (${message.message})`);
                return;

            case 'ping':
                this.#sendMessage({ type: 'pong' });
                return;

            case 'pong':
                return;
        }
    }
}

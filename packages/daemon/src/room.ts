import {
    apply,
    applyAll,
    createOp,
    DAEMON_PROTOCOL_VERSION,
    LamportClock,
    type Op,
    type OpOf,
    type OpType,
    opSchema,
    type ProjectInfo,
    type ProjectMeta,
    type ProjectState,
    type SeqOp,
    type ServerMessage,
} from '@palmtopai/protocol';
import { authorizeDeviceOp, RESERVED_DEVICE_PREFIX, type Rejection } from './permissions';
import type { StorageAdapter } from './storage/adapter';

export const DAEMON_DEVICE_ID = `${RESERVED_DEVICE_PREFIX}daemon`;

export type Origin =
    | { kind: 'local' }
    | {
          kind: 'device';
          deviceId: string;
          /**
           * A further check, made when the op is about to be applied (not when it arrived: the
           * room may have been busy, and what it allowed then may be closed by now).
           */
          authorize?: (op: Op) => Rejection | null;
      };

export type SubmitResult =
    | { status: 'applied'; entry: SeqOp }
    | { status: 'duplicate' }
    | { status: 'rejected'; rejection: Rejection };

export interface RoomTransaction {
    /** Current state, including ops submitted earlier in this transaction. */
    readonly state: ProjectState;
    submit<T extends OpType>(
        type: T,
        sessionId: string,
        payload: OpOf<T>['payload'],
    ): Promise<SubmitResult>;
}

export interface RoomOptions {
    /** Save a snapshot (and compact the log) after this many ops. */
    snapshotEvery?: number;
    /** Called for every applied op, in seq order, after it has been persisted. */
    onApplied?: (entry: SeqOp) => void;
    /** Receives failures that happen after an op is already applied (never op contents). */
    log?: (line: string) => void;
    /**
     * Name sent to devices with the project (read on every sync): the computer's, or none for a
     * copy shared with a guest, who must not learn the name of the computer.
     */
    computerName?: () => string | undefined;
    /** When a copy shared with a person stops taking answers; absent for a project of the computer. */
    sharedUntil?: () => number | undefined;
}

const DEFAULT_SNAPSHOT_EVERY = 500;

/**
 * Authoritative state of one project. Every mutation and every client sync runs in a single
 * serialized queue, so a client subscribing inside `exclusive()` never misses or doubles an op.
 */
export class ProjectRoom {
    readonly projectId: string;
    readonly #meta: Pick<ProjectInfo, 'id' | 'name'>;
    readonly #computerName: (() => string | undefined) | undefined;
    readonly #sharedUntil: (() => number | undefined) | undefined;
    readonly #storage: StorageAdapter;
    readonly #snapshotEvery: number;
    readonly #onApplied: (entry: SeqOp) => void;
    readonly #logLine: (line: string) => void;
    readonly #clock: LamportClock;
    #state: ProjectState;
    #seq: number;
    #snapshotSeq: number;
    /** Ops since the snapshot: the window served to reconnecting clients. */
    #log: SeqOp[];
    #opIds: Set<string>;
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(
        meta: ProjectMeta,
        storage: StorageAdapter,
        state: ProjectState,
        snapshotSeq: number,
        log: SeqOp[],
        options: RoomOptions,
    ) {
        this.projectId = state.projectId;
        this.#meta = { id: meta.id, name: meta.name };
        this.#computerName = options.computerName;
        this.#sharedUntil = options.sharedUntil;
        this.#storage = storage;
        this.#snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
        this.#onApplied = options.onApplied ?? (() => {});
        this.#logLine = options.log ?? (() => {});
        this.#state = applyAll(
            state,
            log.map((entry) => entry.op),
        );
        this.#snapshotSeq = snapshotSeq;
        this.#log = log;
        this.#seq = log.at(-1)?.seq ?? snapshotSeq;
        this.#opIds = new Set(log.map((entry) => entry.op.opId));
        this.#clock = new LamportClock(DAEMON_DEVICE_ID, this.#state.lamport);
    }

    static async load(
        storage: StorageAdapter,
        projectId: string,
        options: RoomOptions = {},
    ): Promise<ProjectRoom | null> {
        const loaded = await storage.loadProject(projectId);
        if (!loaded) return null;
        return new ProjectRoom(
            loaded.meta,
            storage,
            loaded.snapshot.state,
            loaded.snapshot.seq,
            loaded.ops,
            options,
        );
    }

    /** What devices learn about the project, with the current computer name. */
    get project(): ProjectInfo {
        const computer = this.#computerName?.();
        const sharedUntil = this.#sharedUntil?.();
        return {
            ...this.#meta,
            ...(computer !== undefined && { computer }),
            ...(sharedUntil !== undefined && { sharedUntil }),
        };
    }

    get state(): ProjectState {
        return this.#state;
    }

    get seq(): number {
        return this.#seq;
    }

    /** Runs `task` after every pending mutation and before any later one. */
    exclusive<T>(task: () => T | Promise<T>): Promise<T> {
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }

    /** Validates, sequences, persists and broadcasts an op. */
    submit(op: Op, origin: Origin): Promise<SubmitResult> {
        return this.exclusive(() => this.#submit(op, origin));
    }

    /** Builds an op authored by the daemon (agent actions coming from the Local API). */
    submitLocal<T extends OpType>(
        type: T,
        sessionId: string,
        payload: OpOf<T>['payload'],
    ): Promise<SubmitResult> {
        return this.transact((tx) => tx.submit(type, sessionId, payload));
    }

    /**
     * Reads the state and submits local ops as one atomic step: no other op can land between
     * a check (e.g. "this item exists in this session") and the writes that depend on it.
     */
    transact<T>(task: (tx: RoomTransaction) => T | Promise<T>): Promise<T> {
        return this.exclusive(async () => {
            let open = true;
            const currentState = () => this.#state;
            const tx: RoomTransaction = {
                get state() {
                    return currentState();
                },
                submit: (type, sessionId, payload) => {
                    if (!open) throw new Error('transaction already finished');
                    return this.#submitLocalNow(type, sessionId, payload);
                },
            };
            try {
                return await task(tx);
            } finally {
                open = false;
            }
        });
    }

    #submitLocalNow<T extends OpType>(
        type: T,
        sessionId: string,
        payload: OpOf<T>['payload'],
    ): Promise<SubmitResult> {
        this.#clock.observe(this.#state.lamport);
        const op = opSchema.parse(
            createOp({
                projectId: this.projectId,
                sessionId,
                type,
                payload,
                clock: this.#clock.tick(),
            }),
        );
        return this.#submit(op, { kind: 'local' });
    }

    /**
     * Message that brings a client up to date: the missed ops when `lastSeq` is still inside
     * the log window, a full snapshot otherwise. Call inside `exclusive()` together with the
     * subscription to live ops.
     */
    syncMessage(lastSeq?: number): ServerMessage {
        if (lastSeq !== undefined && lastSeq >= this.#snapshotSeq && lastSeq <= this.#seq) {
            return {
                type: 'ops',
                project: this.project,
                ops: this.#log.filter((entry) => entry.seq > lastSeq),
                seq: this.#seq,
                protocol: DAEMON_PROTOCOL_VERSION,
            };
        }
        return {
            type: 'snapshot',
            project: this.project,
            state: this.#state,
            seq: this.#seq,
            protocol: DAEMON_PROTOCOL_VERSION,
        };
    }

    /** Waits for pending work and snapshots the log if it has ops. */
    close(): Promise<void> {
        return this.exclusive(async () => {
            if (this.#log.length > 0) await this.#snapshot();
        });
    }

    async #submit(op: Op, origin: Origin): Promise<SubmitResult> {
        if (op.projectId !== this.projectId) {
            return reject('op targets another project');
        }
        // First: a device that sends an op again (it never saw the echo) is told it is already
        // here, not that the checks it passed the first time (an item that exists) now fail.
        if (this.#opIds.has(op.opId)) return { status: 'duplicate' };
        if (origin.kind === 'device') {
            const rejection = authorizeDeviceOp(this.#state, op, origin.deviceId);
            if (rejection) return { status: 'rejected', rejection };
            const refused = origin.authorize?.(op);
            if (refused) return { status: 'rejected', rejection: refused };
        }

        const entry: SeqOp = { seq: this.#seq + 1, op };
        await this.#storage.appendOps(this.projectId, [entry]);

        this.#state = apply(this.#state, op);
        this.#seq = entry.seq;
        this.#log.push(entry);
        this.#opIds.add(op.opId);

        // From here on the op is durable and applied: later failures must not report it as
        // rejected to the sender.
        try {
            this.#onApplied(entry);
        } catch (error) {
            this.#logLine(`broadcast of seq ${entry.seq} failed: ${errorMessage(error)}`);
        }
        // A removed session must not stay readable in the op log on disk.
        if (op.type === 'session.remove' || this.#log.length >= this.#snapshotEvery) {
            try {
                await this.#snapshot();
            } catch (error) {
                // The op log is intact, so nothing is lost; the next op retries the snapshot.
                this.#logLine(
                    `snapshot of project ${this.projectId} failed: ${errorMessage(error)}`,
                );
            }
        }
        return { status: 'applied', entry };
    }

    async #snapshot(): Promise<void> {
        await this.#storage.saveSnapshot(this.projectId, this.#state, this.#seq);
        this.#snapshotSeq = this.#seq;
        this.#log = [];
        // #opIds is kept: a retried op (same opId) compacted into the snapshot must still be
        // recognized as a duplicate, or it gets a new seq and is appended again on every retry.
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function reject(message: string): SubmitResult {
    return { status: 'rejected', rejection: { code: 'forbidden', message } };
}

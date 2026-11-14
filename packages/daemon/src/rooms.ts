import type { SeqOp } from '@palmtopai/protocol';
import { ProjectRoom } from './room';
import type { StorageAdapter } from './storage/adapter';

export interface RoomManagerOptions {
    snapshotEvery?: number;
    onApplied?: (projectId: string, entry: SeqOp) => void;
    log?: (line: string) => void;
    /** Name sent with a project; `undefined` sends none (the copies shared with guests). */
    computerName?: (projectId: string) => string | undefined;
    /** When a copy shared with a person stops taking answers; `undefined` for the others. */
    sharedUntil?: (projectId: string) => number | undefined;
}

/** Loads project rooms lazily and keeps them in memory for the daemon's lifetime. */
export class RoomManager {
    readonly #storage: StorageAdapter;
    readonly #options: RoomManagerOptions;
    readonly #rooms = new Map<string, Promise<ProjectRoom | null>>();

    constructor(storage: StorageAdapter, options: RoomManagerOptions = {}) {
        this.#storage = storage;
        this.#options = options;
    }

    get(projectId: string): Promise<ProjectRoom | null> {
        let room = this.#rooms.get(projectId);
        if (!room) {
            room = ProjectRoom.load(this.#storage, projectId, {
                ...(this.#options.snapshotEvery !== undefined && {
                    snapshotEvery: this.#options.snapshotEvery,
                }),
                onApplied: (entry) => this.#options.onApplied?.(projectId, entry),
                ...(this.#options.log && { log: this.#options.log }),
                ...(this.#options.computerName && {
                    computerName: () => this.#options.computerName?.(projectId),
                }),
                ...(this.#options.sharedUntil && {
                    sharedUntil: () => this.#options.sharedUntil?.(projectId),
                }),
            });
            this.#rooms.set(projectId, room);
            // Do not cache failures or unknown projects: they may exist on the next attempt.
            room.then(
                (loaded) => loaded ?? this.#rooms.delete(projectId),
                () => this.#rooms.delete(projectId),
            );
        }
        return room;
    }

    /** Forgets a project's room without saving it (the project is being deleted). */
    async discard(projectId: string): Promise<void> {
        const room = this.#rooms.get(projectId);
        this.#rooms.delete(projectId);
        await room?.then((loaded) => loaded?.exclusive(() => undefined)).catch(() => undefined);
    }

    /** Rooms already loaded, e.g. to notify their devices. */
    async loaded(): Promise<ProjectRoom[]> {
        const rooms = await Promise.allSettled(this.#rooms.values());
        return rooms.flatMap((result) =>
            result.status === 'fulfilled' && result.value ? [result.value] : [],
        );
    }

    async closeAll(): Promise<void> {
        const rooms = await Promise.allSettled(this.#rooms.values());
        await Promise.all(
            rooms.map((result) =>
                result.status === 'fulfilled' ? result.value?.close() : undefined,
            ),
        );
        this.#rooms.clear();
    }
}

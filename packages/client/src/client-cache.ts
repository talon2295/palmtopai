import {
    type ImageMime,
    type Op,
    opSchema,
    type ProjectInfo,
    type ProjectState,
    projectInfoSchema,
    projectStateSchema,
    type SessionShares,
    sessionSharesSchema,
} from '@palmtopai/protocol';
import { z } from 'zod';

/**
 * What a device keeps of a project between launches: the last state confirmed by the computer
 * and the local edits it has not confirmed yet. It lets the app show the checklists and take
 * reviews while the computer is off; on reconnect `seq` resumes the sync and the queue is sent.
 */
export interface CachedProject {
    projectId: string;
    project: ProjectInfo | null;
    /** Confirmed state, `null` when only queued edits are left (e.g. an unreadable old entry). */
    state: ProjectState | null;
    seq: number;
    /** Local ops in the order they were made, each one kept (never merged). */
    pending: Op[];
    /** When the computer last confirmed this state, `null` if never. */
    syncedAt: number | null;
    /** What the people the project is shared with answered, as the computer last said. */
    shares?: SessionShares[];
    /**
     * Protocol of the computer as last seen. It tells an app that is offline whether the computer
     * takes screenshots (it can keep one until the computer is back).
     */
    protocol?: number;
}

/** A screenshot as the device keeps it. */
export interface StoredImage {
    mime: ImageMime;
    bytes: Uint8Array;
}

/** A screenshot made while the computer was away, kept until it can be sent. */
export interface PendingImage {
    imageId: string;
    projectId: string;
    sessionId: string;
    image: StoredImage;
}

/** Storage of the cached projects of one computer. Implementations may throw: callers ignore. */
export interface ClientCache {
    load(projectId: string): Promise<CachedProject | null>;
    save(entry: CachedProject): Promise<void>;
    remove(projectId: string): Promise<void>;
    /** Projects with an entry, in no particular order. */
    projectIds(): Promise<string[]>;
    /** Forgets every project of the computer (unpair), and its screenshots. */
    clear(): Promise<void>;
    /** The screenshots seen or sent on this device, so they show again without the computer. */
    loadImage?(imageId: string): Promise<StoredImage | null>;
    saveImage?(imageId: string, image: StoredImage): Promise<void>;
    /** Keeps a screenshot that still has to be sent, with where it goes. */
    savePendingImage?(pending: PendingImage): Promise<void>;
    /** The screenshots that still have to be sent, of every project of the computer. */
    pendingImages?(): Promise<PendingImage[]>;
    /** The computer has it: the screenshot stays here for showing, no longer to be sent. */
    clearPendingImage?(imageId: string): Promise<void>;
    /** Forgets the screenshots that are not in `keep`: the notes of no project name them any more. */
    pruneImages?(keep: ReadonlySet<string>): Promise<void>;
}

/**
 * Version of the cached state. **Bump it whenever the schema of an op or of the state grows a
 * field**: ops are validated before being applied, and zod drops what it does not know, so a state
 * cached by an older app has the new fields missing. Resuming from its `seq` would never bring
 * them back, because the ops that carried them are not sent again. A record of another version is
 * dropped (its queued ops are kept) and the app asks the computer for a fresh snapshot.
 *
 * 2: choices (`kind` and `pick` of a checklist, `detail` of an item).
 * 3: copies shared with guests (`origin` of a checklist and of an item).
 * 4: archived sessions (`archived` of a session).
 * 5: sessions marked done (`done` of a session).
 */
export const CACHE_VERSION = 5;

const storedSchema = z.object({
    v: z.literal(CACHE_VERSION),
    project: projectInfoSchema.nullable(),
    state: projectStateSchema.nullable(),
    seq: z.number().int().nonnegative(),
    syncedAt: z.number().nullable(),
    // Added with the shared copies: an entry written before has none.
    shares: z.array(sessionSharesSchema).optional(),
    // Added with the screenshots: an entry written before has none.
    protocol: z.number().int().min(1).optional(),
});

/**
 * Reads a stored record defensively. The queued ops are parsed one by one and survive a record
 * whose state no longer matches the schema: a review must never be lost to a format change.
 */
export function parseCachedProject(projectId: string, raw: unknown): CachedProject | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const pending: Op[] = [];
    if (Array.isArray(record.pending)) {
        for (const candidate of record.pending) {
            const op = opSchema.safeParse(candidate);
            if (op.success && op.data.projectId === projectId) pending.push(op.data);
        }
    }
    const stored = storedSchema.safeParse(raw);
    if (stored.success && (stored.data.state?.projectId ?? projectId) === projectId) {
        const { v: _v, ...entry } = stored.data;
        return { projectId, pending, ...entry };
    }
    if (pending.length === 0) return null;
    return { projectId, project: null, state: null, seq: 0, pending, syncedAt: null };
}

/** What is stored of an image: its type and its bytes, as a buffer of their own. */
function imageRecord(image: StoredImage): { mime: ImageMime; bytes: ArrayBuffer } {
    return {
        mime: image.mime,
        bytes: image.bytes.buffer.slice(
            image.bytes.byteOffset,
            image.bytes.byteOffset + image.bytes.byteLength,
        ) as ArrayBuffer,
    };
}

/** An image as it was stored, or `null` for anything else. */
function parseStoredImage(raw: unknown): StoredImage | null {
    if (!raw || typeof raw !== 'object') return null;
    const { mime, bytes } = raw as { mime?: unknown; bytes?: unknown };
    if (mime !== 'image/jpeg' && mime !== 'image/webp') return null;
    // Not `instanceof`: the buffer of a database can come from another realm.
    if (Object.prototype.toString.call(bytes) !== '[object ArrayBuffer]') return null;
    return { mime, bytes: new Uint8Array(bytes as ArrayBuffer) };
}

const DB_NAME = 'palmtop';
const DB_VERSION = 2;
const STORE = 'projects';
/** Screenshots, keyed by `[scope, imageId]` (database version 2). */
const IMAGES = 'images';

export interface IndexedDbCacheOptions {
    /** Which computer the projects belong to (e.g. its pairing id). */
    scope: string;
    /** Defaults to the global `indexedDB`; tests pass a fake one. */
    indexedDB?: IDBFactory;
}

/**
 * `ClientCache` on IndexedDB: database `palmtop`, store `projects` keyed by
 * `[scope, projectId]`, so the projects of every paired computer live side by side, and store
 * `images` keyed by `[scope, imageId]`.
 */
export function indexedDbCache(options: IndexedDbCacheOptions): ClientCache {
    const { scope } = options;
    let db: Promise<IDBDatabase> | undefined;
    const open = () => {
        const forget = () => {
            db = undefined;
        };
        db ??= openDatabase(options.indexedDB ?? globalThis.indexedDB, forget).catch(
            (error: unknown) => {
                forget();
                throw error;
            },
        );
        return db;
    };
    const everyProject = () => IDBKeyRange.bound([scope], [scope, []]);
    /** The screenshots of this computer that still have to be sent. */
    const pendingOf = async (database: IDBDatabase): Promise<PendingImage[]> => {
        const records = await run(
            database,
            'readonly',
            (store) => store.getAll(everyProject()),
            IMAGES,
        );
        return (records as unknown[]).flatMap((record) => {
            const { imageId, pending } = (record ?? {}) as {
                imageId?: unknown;
                pending?: { projectId?: unknown; sessionId?: unknown };
            };
            const image = parseStoredImage(record);
            if (
                typeof imageId !== 'string' ||
                typeof pending?.projectId !== 'string' ||
                typeof pending.sessionId !== 'string' ||
                !image
            ) {
                return [];
            }
            return [{ imageId, projectId: pending.projectId, sessionId: pending.sessionId, image }];
        });
    };

    return {
        async load(projectId) {
            const raw = await run(await open(), 'readonly', (store) =>
                store.get([scope, projectId]),
            );
            return parseCachedProject(projectId, raw);
        },
        async save(entry) {
            const { projectId, project, state, seq, pending, syncedAt, shares, protocol } = entry;
            const record = {
                v: CACHE_VERSION,
                project,
                state,
                seq,
                pending,
                syncedAt,
                shares,
                protocol,
            };
            await run(await open(), 'readwrite', (store) => store.put(record, [scope, projectId]));
        },
        async remove(projectId) {
            const database = await open();
            await run(database, 'readwrite', (store) => store.delete([scope, projectId]));
            // What was still to be sent to a project that is gone has nowhere to go.
            for (const waiting of await pendingOf(database)) {
                if (waiting.projectId === projectId) {
                    await run(
                        database,
                        'readwrite',
                        (store) => store.delete([scope, waiting.imageId]),
                        IMAGES,
                    );
                }
            }
        },
        async projectIds() {
            const keys = await run(await open(), 'readonly', (store) =>
                store.getAllKeys(everyProject()),
            );
            return keys.map((key) => String((key as [string, string])[1]));
        },
        async clear() {
            const database = await open();
            await run(database, 'readwrite', (store) => store.delete(everyProject()));
            await run(database, 'readwrite', (store) => store.delete(everyProject()), IMAGES);
        },
        async loadImage(imageId) {
            const raw = await run(
                await open(),
                'readonly',
                (store) => store.get([scope, imageId]),
                IMAGES,
            );
            return parseStoredImage(raw);
        },
        async saveImage(imageId, image) {
            const database = await open();
            // A screenshot still to be sent stays so: showing it again must not forget that.
            const raw = await run(
                database,
                'readonly',
                (store) => store.get([scope, imageId]),
                IMAGES,
            );
            const pending = (raw as { pending?: unknown } | undefined)?.pending;
            await run(
                database,
                'readwrite',
                (store) =>
                    store.put({ imageId, ...imageRecord(image), ...(pending ? { pending } : {}) }, [
                        scope,
                        imageId,
                    ]),
                IMAGES,
            );
        },
        async savePendingImage(waiting) {
            await run(
                await open(),
                'readwrite',
                (store) =>
                    store.put(
                        {
                            imageId: waiting.imageId,
                            ...imageRecord(waiting.image),
                            pending: { projectId: waiting.projectId, sessionId: waiting.sessionId },
                        },
                        [scope, waiting.imageId],
                    ),
                IMAGES,
            );
        },
        async pendingImages() {
            return pendingOf(await open());
        },
        async clearPendingImage(imageId) {
            const database = await open();
            const raw = await run(
                database,
                'readonly',
                (store) => store.get([scope, imageId]),
                IMAGES,
            );
            const image = parseStoredImage(raw);
            if (!image) return;
            await run(
                database,
                'readwrite',
                (store) => store.put({ imageId, ...imageRecord(image) }, [scope, imageId]),
                IMAGES,
            );
        },
        async pruneImages(keep) {
            const database = await open();
            const keys = await run(
                database,
                'readonly',
                (store) => store.getAllKeys(everyProject()),
                IMAGES,
            );
            for (const key of keys) {
                if (keep.has(String((key as [string, string])[1]))) continue;
                const raw = await run(database, 'readonly', (store) => store.get(key), IMAGES);
                // Nothing that still has to be sent goes, named by a note or not yet.
                if ((raw as { pending?: unknown } | undefined)?.pending) continue;
                await run(database, 'readwrite', (store) => store.delete(key), IMAGES);
            }
        },
    };
}

/** Projects with edits still waiting for the computer. Never throws: a failing cache has none. */
export async function queuedProjects(cache: ClientCache): Promise<string[]> {
    try {
        const queued: string[] = [];
        for (const projectId of await cache.projectIds()) {
            const entry = await cache.load(projectId);
            if (entry && entry.pending.length > 0) queued.push(projectId);
        }
        return queued;
    } catch {
        return [];
    }
}

function openDatabase(factory: IDBFactory | undefined, onClose: () => void): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (!factory) {
            reject(new Error('IndexedDB is not available'));
            return;
        }
        const request = factory.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            for (const name of [STORE, IMAGES]) {
                if (!request.result.objectStoreNames.contains(name)) {
                    request.result.createObjectStore(name);
                }
            }
        };
        request.onsuccess = () => {
            const database = request.result;
            // Another tab upgrading the schema: let it, this tab reopens on the next call.
            database.onversionchange = () => {
                database.close();
                onClose();
            };
            database.onclose = onClose;
            resolve(database);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('IndexedDB upgrade blocked'));
    });
}

/** Runs one request in its own transaction and resolves once the transaction is committed. */
function run<T>(
    database: IDBDatabase,
    mode: IDBTransactionMode,
    request: (store: IDBObjectStore) => IDBRequest<T>,
    storeName = STORE,
): Promise<T> {
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const pending = request(transaction.objectStore(storeName));
        transaction.oncomplete = () => resolve(pending.result);
        transaction.onerror = () => reject(transaction.error ?? pending.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('transaction aborted'));
    });
}

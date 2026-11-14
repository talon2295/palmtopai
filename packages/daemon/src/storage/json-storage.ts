import { mkdir, readdir, readFile, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import {
    createProjectState,
    isId,
    type ProjectMeta,
    type ProjectState,
    projectMetaSchema,
    projectStateSchema,
    type SeqOp,
    seqOpSchema,
} from '@palmtopai/protocol';
import { z } from 'zod';
import {
    appendFileDurable,
    ensurePrivateDir,
    isErrnoException,
    PRIVATE_DIR_MODE,
    writeFileAtomic,
} from '../fs-utils';
import {
    assertAppendable,
    assertSnapshotable,
    type LoadedProject,
    type StorageAdapter,
    StorageError,
} from './adapter';

const SNAPSHOT_FILE = 'snapshot.json';
const OPS_FILE = 'ops.jsonl';

const snapshotFileSchema = z.object({
    version: z.literal(1),
    meta: projectMetaSchema,
    seq: z.number().int().nonnegative(),
    state: projectStateSchema,
});

type SnapshotFile = z.infer<typeof snapshotFileSchema>;

/**
 * One directory per project:
 *   data/<projectId>/snapshot.json   meta + state up to `seq` (atomic rewrite)
 *   data/<projectId>/ops.jsonl       one SeqOp per line after the snapshot (durable append)
 *
 * A crash can leave a truncated last line (dropped and repaired on load) or ops already
 * folded into a newer snapshot (filtered on load). Any other corruption fails loudly.
 */
export class JsonStorage implements StorageAdapter {
    readonly #dataDir: string;
    readonly #locks = new Map<string, Promise<unknown>>();
    readonly #lastSeq = new Map<string, number>();

    constructor(dataDir: string) {
        this.#dataDir = dataDir;
    }

    async createProject(meta: ProjectMeta): Promise<void> {
        const parsed = projectMetaSchema.parse(meta);
        await this.#withLock(parsed.id, async () => {
            const dir = this.#dir(parsed.id);
            await ensurePrivateDir(this.#dataDir);
            try {
                await mkdir(dir, { mode: PRIVATE_DIR_MODE });
            } catch (error) {
                if (isErrnoException(error, 'EEXIST')) {
                    throw new StorageError(`project ${parsed.id} already exists`);
                }
                throw error;
            }
            await writeFileAtomic(join(dir, OPS_FILE), '');
            await this.#writeSnapshot(parsed.id, {
                version: 1,
                meta: parsed,
                seq: 0,
                state: createProjectState(parsed.id),
            });
            this.#lastSeq.set(parsed.id, 0);
        });
    }

    loadProject(projectId: string): Promise<LoadedProject | null> {
        return this.#withLock(projectId, () => this.#load(projectId));
    }

    appendOps(projectId: string, ops: SeqOp[]): Promise<void> {
        return this.#withLock(projectId, async () => {
            if (ops.length === 0) return;
            const lastSeq = await this.#requireLastSeq(projectId);
            assertAppendable(projectId, lastSeq, ops);
            const lines = ops.map((entry) => `${JSON.stringify(seqOpSchema.parse(entry))}\n`);
            await appendFileDurable(join(this.#dir(projectId), OPS_FILE), lines.join(''));
            this.#lastSeq.set(projectId, ops.at(-1)?.seq ?? lastSeq);
        });
    }

    saveSnapshot(projectId: string, state: ProjectState, seq: number): Promise<void> {
        return this.#withLock(projectId, async () => {
            const current = await this.#load(projectId);
            if (!current) throw new StorageError(`unknown project ${projectId}`);
            const lastSeq = current.ops.at(-1)?.seq ?? current.snapshot.seq;
            assertSnapshotable(
                projectId,
                { snapshotSeq: current.snapshot.seq, lastSeq },
                state,
                seq,
            );

            // Snapshot first: if we crash before rewriting the log, load() filters old ops.
            await this.#writeSnapshot(projectId, {
                version: 1,
                meta: current.meta,
                seq,
                state: projectStateSchema.parse(state),
            });
            const remaining = current.ops.filter((entry) => entry.seq > seq);
            await writeFileAtomic(
                join(this.#dir(projectId), OPS_FILE),
                remaining.map((entry) => `${JSON.stringify(entry)}\n`).join(''),
            );
        });
    }

    deleteProject(projectId: string): Promise<void> {
        return this.#withLock(projectId, async () => {
            await rm(this.#dir(projectId), { recursive: true, force: true });
            this.#lastSeq.delete(projectId);
        });
    }

    async listProjects(): Promise<ProjectMeta[]> {
        let entries: string[];
        try {
            entries = await readdir(this.#dataDir);
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) return [];
            throw error;
        }
        const metas: ProjectMeta[] = [];
        for (const entry of entries.filter(isId).sort()) {
            const snapshot = await this.#readSnapshot(entry);
            if (snapshot) metas.push(snapshot.meta);
        }
        return metas;
    }

    #dir(projectId: string): string {
        if (!isId(projectId)) {
            throw new StorageError(`invalid project id ${JSON.stringify(projectId)}`);
        }
        return join(this.#dataDir, projectId);
    }

    /** Serializes all file operations of a project, including reads that repair the log. */
    #withLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
        if (!isId(projectId)) {
            return Promise.reject(
                new StorageError(`invalid project id ${JSON.stringify(projectId)}`),
            );
        }
        const previous = this.#locks.get(projectId) ?? Promise.resolve();
        const run = previous.then(task, task);
        const settled = run.catch(() => undefined);
        this.#locks.set(projectId, settled);
        void settled.then(() => {
            if (this.#locks.get(projectId) === settled) this.#locks.delete(projectId);
        });
        return run;
    }

    async #requireLastSeq(projectId: string): Promise<number> {
        const cached = this.#lastSeq.get(projectId);
        if (cached !== undefined) return cached;
        const project = await this.#load(projectId);
        if (!project) throw new StorageError(`unknown project ${projectId}`);
        return this.#lastSeq.get(projectId) ?? 0;
    }

    async #load(projectId: string): Promise<LoadedProject | null> {
        const snapshot = await this.#readSnapshot(projectId);
        if (!snapshot) return null;
        const ops = await this.#readOps(projectId, snapshot.seq);
        this.#lastSeq.set(projectId, ops.at(-1)?.seq ?? snapshot.seq);
        return { meta: snapshot.meta, snapshot: { state: snapshot.state, seq: snapshot.seq }, ops };
    }

    async #readSnapshot(projectId: string): Promise<SnapshotFile | null> {
        const path = join(this.#dir(projectId), SNAPSHOT_FILE);
        let raw: string;
        try {
            raw = await readFile(path, 'utf8');
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) return null;
            throw error;
        }
        let json: unknown;
        try {
            json = JSON.parse(raw);
        } catch {
            throw new StorageError(`corrupted snapshot for project ${projectId}`);
        }
        const result = snapshotFileSchema.safeParse(json);
        if (!result.success || result.data.meta.id !== projectId) {
            throw new StorageError(`corrupted snapshot for project ${projectId}`);
        }
        return result.data;
    }

    async #readOps(projectId: string, afterSeq: number): Promise<SeqOp[]> {
        const path = join(this.#dir(projectId), OPS_FILE);
        let raw: string;
        try {
            raw = await readFile(path, 'utf8');
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) return [];
            throw error;
        }

        const lines = raw.split('\n');
        const tail = lines.pop() ?? '';
        if (tail !== '') {
            // Interrupted append: drop the partial line so the next append starts clean.
            await truncate(path, Buffer.byteLength(raw) - Buffer.byteLength(tail));
        }

        const ops: SeqOp[] = [];
        let previous = afterSeq;
        for (const [index, line] of lines.entries()) {
            if (line === '') continue;
            let entry: SeqOp;
            try {
                entry = seqOpSchema.parse(JSON.parse(line));
            } catch {
                throw new StorageError(
                    `corrupted op log for project ${projectId} at line ${index + 1}`,
                );
            }
            if (entry.seq <= afterSeq) continue;
            if (entry.seq <= previous || entry.op.projectId !== projectId) {
                throw new StorageError(
                    `inconsistent op log for project ${projectId} at line ${index + 1}`,
                );
            }
            previous = entry.seq;
            ops.push(entry);
        }
        return ops;
    }

    #writeSnapshot(projectId: string, snapshot: SnapshotFile): Promise<void> {
        return writeFileAtomic(join(this.#dir(projectId), SNAPSHOT_FILE), JSON.stringify(snapshot));
    }
}

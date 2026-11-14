import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
    apply,
    createId,
    createOp,
    createProjectState,
    type ProjectMeta,
    type SeqOp,
} from '@palmtopai/protocol';
import type { StorageAdapter } from '../src';

export interface StorageHarness {
    storage: StorageAdapter;
    /** A new adapter instance over the same persisted data (same instance for in-memory). */
    reopen(): StorageAdapter;
    cleanup(): Promise<void>;
}

function meta(overrides: Partial<ProjectMeta> = {}): ProjectMeta {
    return {
        id: createId(),
        name: 'demo',
        rootPath: '/tmp/demo',
        createdAt: 1_000,
        ...overrides,
    };
}

function seqOps(projectId: string, fromSeq: number, count: number): SeqOp[] {
    const sessionId = createId();
    return Array.from({ length: count }, (_, index) => ({
        seq: fromSeq + index,
        op: createOp({
            projectId,
            sessionId,
            type: 'session.upsert',
            payload: { title: `title ${fromSeq + index}` },
            clock: { lamport: fromSeq + index, deviceId: 'laptop' },
            ts: 1_000 + index,
        }),
    }));
}

/** Behaviour every StorageAdapter must share. Reused by future adapters (SQLite, relay). */
export function runStorageContract(name: string, createHarness: () => Promise<StorageHarness>) {
    describe(`StorageAdapter contract: ${name}`, () => {
        let harness: StorageHarness;

        beforeEach(async () => {
            harness = await createHarness();
        });

        afterEach(async () => {
            await harness.cleanup();
        });

        test('unknown project loads as null', async () => {
            expect(await harness.storage.loadProject(createId())).toBeNull();
        });

        test('a created project starts empty at seq 0 and is listed', async () => {
            const project = meta({ gitRemote: 'git@example.com:me/demo.git' });
            await harness.storage.createProject(project);

            expect(await harness.storage.loadProject(project.id)).toEqual({
                meta: project,
                snapshot: { state: createProjectState(project.id), seq: 0 },
                ops: [],
            });
            expect(await harness.storage.listProjects()).toEqual([project]);
        });

        test('creating the same project twice fails', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            await expect(harness.storage.createProject(project)).rejects.toThrow(/already exists/);
        });

        test('appended ops are loaded in order and survive a reopen', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            const ops = seqOps(project.id, 1, 5);
            await harness.storage.appendOps(project.id, ops.slice(0, 2));
            await harness.storage.appendOps(project.id, []);
            await harness.storage.appendOps(project.id, ops.slice(2));

            expect((await harness.storage.loadProject(project.id))?.ops).toEqual(ops);
            expect((await harness.reopen().loadProject(project.id))?.ops).toEqual(ops);
        });

        test('appending to an unknown project fails', async () => {
            const projectId = createId();
            await expect(
                harness.storage.appendOps(projectId, seqOps(projectId, 1, 1)),
            ).rejects.toThrow();
        });

        test('seqs must be strictly increasing, also across calls and reopen', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            const ops = seqOps(project.id, 1, 3);
            await harness.storage.appendOps(project.id, ops.slice(0, 2));

            await expect(harness.storage.appendOps(project.id, [ops[1] as SeqOp])).rejects.toThrow(
                /not greater/,
            );
            await expect(harness.reopen().appendOps(project.id, [ops[0] as SeqOp])).rejects.toThrow(
                /not greater/,
            );
            await expect(
                harness.storage.appendOps(project.id, [ops[2] as SeqOp, ops[2] as SeqOp]),
            ).rejects.toThrow(/not greater/);
            expect((await harness.storage.loadProject(project.id))?.ops).toEqual(ops.slice(0, 2));
        });

        test('ops of another project are refused', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            await expect(
                harness.storage.appendOps(project.id, seqOps(createId(), 1, 1)),
            ).rejects.toThrow(/belongs to project/);
        });

        test('a snapshot replaces the ops it contains and keeps the later ones', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            const ops = seqOps(project.id, 1, 6);
            await harness.storage.appendOps(project.id, ops);
            const state = ops
                .slice(0, 4)
                .reduce(
                    (current, entry) => apply(current, entry.op),
                    createProjectState(project.id),
                );

            await harness.storage.saveSnapshot(project.id, state, 4);

            const expected = { meta: project, snapshot: { state, seq: 4 }, ops: ops.slice(4) };
            expect(await harness.storage.loadProject(project.id)).toEqual(expected);
            expect(await harness.reopen().loadProject(project.id)).toEqual(expected);

            const more = seqOps(project.id, 7, 1);
            await harness.storage.appendOps(project.id, more);
            expect((await harness.storage.loadProject(project.id))?.ops).toEqual([
                ...ops.slice(4),
                ...more,
            ]);
        });

        test('snapshots cannot go back in time, pass the last op, or change project', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            await harness.storage.appendOps(project.id, seqOps(project.id, 1, 3));
            const state = createProjectState(project.id);

            await harness.storage.saveSnapshot(project.id, state, 2);
            await expect(harness.storage.saveSnapshot(project.id, state, 1)).rejects.toThrow(
                /older/,
            );
            await expect(harness.storage.saveSnapshot(project.id, state, 9)).rejects.toThrow(
                /past/,
            );
            await expect(
                harness.storage.saveSnapshot(project.id, createProjectState(createId()), 3),
            ).rejects.toThrow(/belongs to project/);
            await expect(
                harness.storage.appendOps(project.id, seqOps(project.id, 2, 1)),
            ).rejects.toThrow(/not greater/);
        });

        test('a deleted project is gone, and deleting it again does nothing', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            await harness.storage.appendOps(project.id, seqOps(project.id, 1, 2));
            await harness.storage.deleteProject(project.id);
            expect(await harness.storage.loadProject(project.id)).toBeNull();
            expect(await harness.storage.listProjects()).toEqual([]);
            await harness.storage.deleteProject(project.id);
            expect(
                harness.storage.appendOps(project.id, seqOps(project.id, 3, 1)),
            ).rejects.toThrow();
        });

        test('loaded data cannot be mutated from outside', async () => {
            const project = meta();
            await harness.storage.createProject(project);
            const loaded = await harness.storage.loadProject(project.id);
            if (!loaded) throw new Error('missing project');
            loaded.meta.name = 'changed';
            loaded.ops.push(...seqOps(project.id, 1, 1));
            expect(await harness.storage.loadProject(project.id)).toMatchObject({
                meta: { name: 'demo' },
                ops: [],
            });
        });
    });
}

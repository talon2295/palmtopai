import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, createOp, type ProjectMeta, type SeqOp } from '@palmtopai/protocol';
import { JsonStorage, MemoryStorage, StorageError } from '../src';
import { createTempHome, expectMode } from './helpers';
import { runStorageContract } from './storage-contract';

runStorageContract('MemoryStorage', async () => {
    const storage = new MemoryStorage();
    return { storage, reopen: () => storage, cleanup: async () => {} };
});

runStorageContract('JsonStorage', async () => {
    const { home, cleanup } = await createTempHome();
    const dataDir = join(home, 'data');
    return { storage: new JsonStorage(dataDir), reopen: () => new JsonStorage(dataDir), cleanup };
});

describe('JsonStorage on disk', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let dataDir: string;
    let project: ProjectMeta;

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
        dataDir = join(home, 'data');
        project = { id: createId(), name: 'demo', rootPath: '/tmp/demo', createdAt: 1 };
        await new JsonStorage(dataDir).createProject(project);
    });

    afterEach(() => cleanup());

    const entry = (seq: number): SeqOp => ({
        seq,
        op: createOp({
            projectId: project.id,
            sessionId: project.id,
            type: 'session.upsert',
            payload: { title: `t${seq}` },
            clock: { lamport: seq, deviceId: 'laptop' },
        }),
    });

    const opsPath = () => join(dataDir, project.id, 'ops.jsonl');

    test('files and directories are private to the user', async () => {
        await expectMode(join(dataDir, project.id), 0o700);
        await expectMode(join(dataDir, project.id, 'snapshot.json'), 0o600);
        await new JsonStorage(dataDir).appendOps(project.id, [entry(1)]);
        await expectMode(opsPath(), 0o600);
    });

    test('a truncated last line (crash during append) is dropped and repaired', async () => {
        const storage = new JsonStorage(dataDir);
        await storage.appendOps(project.id, [entry(1), entry(2)]);
        await appendFile(opsPath(), JSON.stringify(entry(3)).slice(0, 40));

        const reopened = new JsonStorage(dataDir);
        expect((await reopened.loadProject(project.id))?.ops.map((e) => e.seq)).toEqual([1, 2]);

        await reopened.appendOps(project.id, [entry(3)]);
        expect(
            (await new JsonStorage(dataDir).loadProject(project.id))?.ops.map((e) => e.seq),
        ).toEqual([1, 2, 3]);
    });

    test('ops already folded into the snapshot are ignored (crash before log rewrite)', async () => {
        const storage = new JsonStorage(dataDir);
        await storage.appendOps(project.id, [entry(1), entry(2), entry(3)]);
        const logBefore = await readFile(opsPath(), 'utf8');
        const loaded = await storage.loadProject(project.id);
        if (!loaded) throw new Error('missing');
        await storage.saveSnapshot(project.id, loaded.snapshot.state, 2);
        await writeFile(opsPath(), logBefore);

        expect(
            (await new JsonStorage(dataDir).loadProject(project.id))?.ops.map((e) => e.seq),
        ).toEqual([3]);
    });

    test('corruption in the middle of the log fails loudly', async () => {
        await new JsonStorage(dataDir).appendOps(project.id, [entry(1)]);
        await appendFile(opsPath(), 'not json\n');
        await expect(new JsonStorage(dataDir).loadProject(project.id)).rejects.toThrow(
            StorageError,
        );
    });

    test('a corrupted snapshot fails loudly', async () => {
        await writeFile(join(dataDir, project.id, 'snapshot.json'), '{"version":1');
        await expect(new JsonStorage(dataDir).loadProject(project.id)).rejects.toThrow(
            /corrupted snapshot/,
        );
    });

    test('project ids that are not ULIDs never reach the filesystem', async () => {
        const storage = new JsonStorage(dataDir);
        await expect(storage.loadProject('../../etc')).rejects.toThrow(/invalid project id/);
        await expect(storage.appendOps('..', [])).rejects.toThrow(/invalid project id/);
    });

    test('concurrent appends through one instance keep order', async () => {
        const storage = new JsonStorage(dataDir);
        await Promise.all(
            [1, 2, 3, 4, 5].map((seq) => storage.appendOps(project.id, [entry(seq)])),
        );
        expect((await storage.loadProject(project.id))?.ops.map((e) => e.seq)).toEqual([
            1, 2, 3, 4, 5,
        ]);
    });
});

import { describe, expect, test } from 'bun:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId } from '@palmtopai/protocol';
import { generateRoomKeyPair, roomIdOf } from '@palmtopai/protocol/relay-crypto';
import { pathsFor } from '../src/config';
import { resetOutdatedHome } from '../src/home-reset';
import { REGISTRY_VERSION } from '../src/registry';
import { JsonStorage } from '../src/storage/json-storage';
import { createTempHome, expectMode, startTestDaemon } from './helpers';

/** Writes a home directory as an older palmtop (devices paired with one project) left it. */
async function seedOldHome(home: string, version: number) {
    const paths = pathsFor(home);
    const projectId = createId();
    await writeFile(
        paths.projects,
        JSON.stringify({
            version,
            projects: [
                {
                    projectId,
                    rootPath: '/tmp/old-repo',
                    token: 't'.repeat(43),
                    createdAt: 1,
                    roomKey: { publicKey: 'p'.repeat(43), privateKey: 's'.repeat(43) },
                },
            ],
        }),
    );
    await writeFile(paths.push, JSON.stringify({ projects: { [projectId]: {} } }));
    await mkdir(join(paths.data, projectId), { recursive: true });
    await writeFile(join(paths.data, projectId, 'snapshot.json'), '{"state":{}}');
    await writeFile(paths.config, JSON.stringify({ computerName: 'Office' }));
    return { paths, projectId };
}

/**
 * Writes a home as phase 10 to 19 left it: a computer token every device knew, a real project
 * with a checklist (written by the storage of today), and push subscriptions.
 */
async function seedTokenHome(home: string) {
    const paths = pathsFor(home);
    const roomKey = generateRoomKeyPair();
    const computerId = createId();
    const projectId = createId();
    await mkdir(paths.data, { recursive: true });
    const storage = new JsonStorage(paths.data);
    await storage.createProject({
        id: projectId,
        name: 'kept-repo',
        rootPath: '/tmp/kept-repo',
        createdAt: 1,
    });
    await writeFile(
        paths.projects,
        JSON.stringify({
            version: 2,
            computer: { id: computerId, token: 't'.repeat(43), roomKey },
            projects: [{ projectId, rootPath: '/tmp/kept-repo', createdAt: 1 }],
        }),
    );
    await writeFile(paths.push, JSON.stringify({ devices: { 'web-old': {} } }));
    await writeFile(paths.config, JSON.stringify({ computerName: 'Office' }));
    return { paths, roomKey, computerId, projectId };
}

describe('reset of a home from an older version', () => {
    test('version 1: projects, checklists and push subscriptions go; config and local key stay', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const { paths, projectId } = await seedOldHome(home, 1);
            await writeFile(paths.localKey, 'local-key');

            const lines: string[] = [];
            expect(await resetOutdatedHome(paths, (line) => lines.push(line))).toBe('reset');
            expect(lines.join('\n')).toContain('palmtop pair');

            expect(await Bun.file(paths.projects).exists()).toBe(false);
            expect(await Bun.file(paths.push).exists()).toBe(false);
            expect(await Bun.file(join(paths.data, projectId, 'snapshot.json')).exists()).toBe(
                false,
            );
            // The computer name and the local key have nothing to do with pairing.
            expect(await readFile(paths.config, 'utf8')).toContain('Office');
            expect(await readFile(paths.localKey, 'utf8')).toBe('local-key');
        } finally {
            await cleanup();
        }
    });

    test('version 2: the token and the push subscriptions go, projects and checklists stay', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const { paths, roomKey, computerId, projectId } = await seedTokenHome(home);

            const lines: string[] = [];
            expect(await resetOutdatedHome(paths, (line) => lines.push(line))).toBe('migrated');
            expect(lines.join('\n')).toContain('pair again');

            const file = JSON.parse(await readFile(paths.projects, 'utf8')) as {
                version: number;
                computer: Record<string, unknown>;
                projects: Array<{ projectId: string }>;
            };
            expect(file.version).toBe(REGISTRY_VERSION);
            // Same computer, same room: only the token is gone.
            expect(file.computer).toEqual({ id: computerId, roomKey });
            expect(file.projects.map((project) => project.projectId)).toEqual([projectId]);
            expect(JSON.stringify(file)).not.toContain('t'.repeat(43));
            await expectMode(paths.projects, 0o600);
            // Subscriptions of devices without a key: they must not keep getting notifications.
            expect(await Bun.file(paths.push).exists()).toBe(false);
            expect(await readFile(paths.config, 'utf8')).toContain('Office');

            // Once is enough: the migrated file is current.
            expect(await resetOutdatedHome(paths, () => {})).toBeNull();
        } finally {
            await cleanup();
        }
    });

    test('a current, missing or unreadable registry is left alone', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const paths = pathsFor(home);
            expect(await resetOutdatedHome(paths, () => {})).toBeNull();

            await seedOldHome(home, REGISTRY_VERSION);
            expect(await resetOutdatedHome(paths, () => {})).toBeNull();
            expect(await Bun.file(paths.projects).exists()).toBe(true);

            // Never destroy data on a guess: a broken file is for the registry to report.
            await writeFile(paths.projects, '{not json');
            expect(await resetOutdatedHome(paths, () => {})).toBeNull();
            expect(await Bun.file(paths.projects).exists()).toBe(true);
        } finally {
            await cleanup();
        }
    });

    test('the daemon starts clean on a version 1 home and pairs devices again', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            await seedOldHome(home, 1);
            const daemon = await startTestDaemon(home);
            try {
                expect(daemon.registry.list()).toEqual([]);
                expect(daemon.registry.roomId).toHaveLength(43);
                // The computer name survives: it is not part of the pairing.
                expect(daemon.computerName).toBe('Office');
                const registry = JSON.parse(
                    await readFile(pathsFor(home).projects, 'utf8'),
                ) as unknown as { version: number; computer: { token?: string } };
                expect(registry.version).toBe(REGISTRY_VERSION);
                expect(registry.computer.token).toBeUndefined();
            } finally {
                await daemon.stop();
            }
        } finally {
            await cleanup();
        }
    });

    test('the daemon keeps the projects of a version 2 home, with no device paired', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const { roomKey, computerId, projectId } = await seedTokenHome(home);
            const daemon = await startTestDaemon(home);
            try {
                expect(daemon.registry.computerId).toBe(computerId);
                expect(daemon.registry.roomId).toBe(roomIdOf(roomKey.publicKey));
                expect(daemon.registry.list().map((project) => project.projectId)).toEqual([
                    projectId,
                ]);
                expect((await daemon.rooms.get(projectId))?.project.name).toBe('kept-repo');
                expect(daemon.paired.list()).toEqual([]);
                expect(daemon.push.list()).toEqual([]);
            } finally {
                await daemon.stop();
            }
        } finally {
            await cleanup();
        }
    });
});

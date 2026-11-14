import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, type ProjectSummary } from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import type { Daemon } from '../src';
import {
    createTempHome,
    deviceOp,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
    waitForRelay,
    waitUntil,
} from './helpers';

/**
 * Activity updates the list after this window: wide enough for a burst of ops to fall in one even
 * on a busy machine, short enough not to slow the tests down.
 */
const PROJECTS_WINDOW_MS = 500;

/** The project list every paired device receives: one pairing, all the projects of the computer. */
describe('project list of a computer', () => {
    let home: string;
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    const clients: TestClient[] = [];

    beforeEach(async () => {
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await startTestDaemon(home, { relay, projectsDebounceMs: PROJECTS_WINDOW_MS });
        project = await seedProject(daemon);
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    async function device(deviceId = 'phone') {
        const client = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(client);
        await client.hello({ projectId: project.projectId, computer: project.computer }, deviceId);
        return client;
    }

    /** The next project list, ignoring the ops that may arrive before it. */
    async function nextList(client: TestClient): Promise<ProjectSummary[]> {
        for (let i = 0; i < 20; i++) {
            const message = await client.next();
            if (message.type === 'projects') return message.projects;
        }
        throw new Error('no project list arrived');
    }

    test('hello answers with the computer, its projects and what is left to review', async () => {
        const client = await device();
        expect(client.projects?.computer).toEqual({
            id: daemon.registry.computerId,
            name: daemon.computerName,
        });
        expect(client.projects?.projects).toEqual([
            {
                id: project.projectId,
                name: 'demo-repo',
                lastActivityAt: expect.any(Number),
                sessions: 1,
                pending: 3,
                archived: [],
            },
        ]);
    });

    test('a project started by the agent shows up on connected devices right away', async () => {
        const client = await device();
        const { projectId } = await daemon.registry.resolve({ rootPath: '/tmp/fresh-repo' });

        const projects = await nextList(client);
        expect(projects.map((entry) => entry.name).sort()).toEqual(['demo-repo', 'fresh-repo']);
        // A project without sessions is listed too, with nothing to review.
        expect(projects.find((entry) => entry.id === projectId)).toMatchObject({
            lastActivityAt: 0,
            sessions: 0,
            pending: 0,
        });
    });

    test('activity moves a project up the list and updates its counts, coalesced', async () => {
        const other = await seedProject(daemon, '/tmp/busy-repo');
        const client = await device();
        expect(client.projects?.projects.map((entry) => entry.name)).toEqual([
            'busy-repo',
            'demo-repo',
        ]);
        // Seeding schedules a list update of its own: let it go out first, so that the window
        // looked at below starts with the first review.
        await Bun.sleep(PROJECTS_WINDOW_MS + 100);
        while (await client.next(50).catch(() => null));

        // Three reviews in a row: the list is sent again, not once per op.
        for (const [index, itemId] of project.itemIds.entries()) {
            client.sendOp(
                deviceOp(project, 'phone', 10 + index, 'item.update', { itemId, status: 'done' }),
            );
        }
        const projects = await nextList(client);
        expect(projects.map((entry) => entry.name)).toEqual(['demo-repo', 'busy-repo']);
        expect(projects.find((entry) => entry.id === project.projectId)?.pending).toBe(0);
        expect(projects.find((entry) => entry.id === other.projectId)?.pending).toBe(3);
        await client.expectSilence();
    });

    test('a device without a project only gets the list, and follows one when it picks it', async () => {
        const client = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(client);
        const first = await client.hello({ computer: project.computer }, 'phone');
        expect(first.type).toBe('projects');

        client.send({ type: 'subscribe', projectId: project.projectId });
        expect(await client.next()).toMatchObject({ type: 'snapshot' });
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(1);
    });

    test('the computer name reaches the list when it changes', async () => {
        const client = await device();
        try {
            await daemon.setComputerName('Office');
            for (let i = 0; i < 20; i++) {
                const message = await client.next();
                if (message.type === 'projects') {
                    expect(message.computer.name).toBe('Office');
                    return;
                }
            }
            throw new Error('the renamed computer never reached the device');
        } finally {
            await daemon.setComputerName(null);
        }
    });

    test('a device deletes a project: it goes from the computer and from every device', async () => {
        const other = await seedProject(daemon, '/tmp/doomed-repo');
        const phone = await device('phone');
        const tablet = await device('tablet');

        phone.send({ type: 'project.remove', projectId: other.projectId });

        for (const client of [phone, tablet]) {
            const projects = await nextList(client);
            expect(projects.map((entry) => entry.id)).toEqual([project.projectId]);
        }
        expect(daemon.registry.has(other.projectId)).toBe(false);
        expect(await daemon.rooms.get(other.projectId)).toBeNull();
        expect(await readdir(join(home, 'data'))).not.toContain(other.projectId);

        // The devices are still paired with the computer and keep following their project.
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(2);
        phone.send({ type: 'subscribe', projectId: other.projectId });
        expect(await phone.next()).toMatchObject({ code: 'forbidden', message: 'unknown project' });
    });

    test('a device archives a session: out of the counts everywhere, back when the agent writes', async () => {
        const phone = await device('phone');
        const tablet = await device('tablet');
        const room = await daemon.rooms.get(project.projectId);
        const archivedHere = () => room?.state.sessions[project.sessionId]?.values.archived;

        phone.send({
            type: 'archive',
            projectId: project.projectId,
            sessionIds: [project.sessionId],
            archived: true,
        });
        for (const client of [phone, tablet]) {
            expect(await nextList(client)).toEqual([
                expect.objectContaining({
                    id: project.projectId,
                    sessions: 0,
                    pending: 0,
                    archived: [
                        {
                            id: project.sessionId,
                            title: 'main · 10:00',
                            lastActivityAt: expect.any(Number),
                        },
                    ],
                }),
            ]);
        }
        expect(archivedHere()).toBe(true);

        // What the agent writes and devices hear of takes it out of the archive.
        await room?.submitLocal('item.add', project.sessionId, {
            itemId: createId(),
            checklistId: project.checklistId,
            text: 'Step 4',
            order: 3,
        });
        await waitUntil(() => archivedHere() === false, 'the session out of the archive');
        const back = await nextList(phone);
        expect(back[0]).toMatchObject({ sessions: 1, pending: 4, archived: [] });

        // Archiving the project archives every session of it; taking it out, every one.
        const second = createId();
        await room?.submitLocal('session.upsert', second, {
            title: 'other',
            startedAt: Date.now(),
        });
        phone.send({ type: 'archive', projectId: project.projectId, archived: true });
        await waitUntil(
            () =>
                room?.state
                    ? Object.values(room.state.sessions).every((s) => s.values.archived)
                    : false,
            'every session archived',
        );
        phone.send({ type: 'archive', projectId: project.projectId, archived: false });
        await waitUntil(() => archivedHere() === false, 'every session out of the archive');
        expect(room?.state.sessions[second]?.values.archived).toBe(false);
    });

    test('a session deleted while it is in the archive leaves the archive of every device', async () => {
        const phone = await device('phone');
        const tablet = await device('tablet');
        const room = await daemon.rooms.get(project.projectId);
        const other = createId();
        await room?.submitLocal('session.upsert', other, { title: 'other', startedAt: Date.now() });

        phone.send({
            type: 'archive',
            projectId: project.projectId,
            sessionIds: [project.sessionId, other],
            archived: true,
        });
        for (const client of [phone, tablet]) {
            const [archived] = await nextList(client);
            expect(archived?.archived?.map((session) => session.id).sort()).toEqual(
                [project.sessionId, other].sort(),
            );
        }

        // Opened from the archive and deleted there.
        phone.send({
            type: 'op',
            op: deviceOp(project, 'phone', 10, 'session.remove', {}),
        });
        for (const client of [phone, tablet]) {
            const [left] = await nextList(client);
            expect(left?.archived?.map((session) => session.id)).toEqual([other]);
            expect(left?.sessions).toBe(0);
        }
        expect(room?.state.sessions[project.sessionId]?.removed).not.toBeNull();

        // Taking the rest out of the archive does not bring the deleted one back.
        phone.send({ type: 'archive', projectId: project.projectId, archived: false });
        for (const client of [phone, tablet]) {
            const [back] = await nextList(client);
            expect(back).toMatchObject({ sessions: 1, archived: [] });
        }
    });

    test('archiving is only for a project of this computer, and only the computer writes it', async () => {
        const client = await device();
        client.send({ type: 'archive', projectId: createId(), archived: true });
        expect(await client.next()).toMatchObject({
            code: 'forbidden',
            message: 'unknown project',
        });
        const room = await daemon.rooms.get(project.projectId);
        const result = await room?.submit(
            {
                v: 1,
                opId: createId(),
                projectId: project.projectId,
                sessionId: project.sessionId,
                type: 'session.archive',
                payload: { archived: true },
                clock: { lamport: 100, deviceId: 'phone' },
                ts: Date.now(),
            },
            { kind: 'device', deviceId: 'phone' },
        );
        expect(result).toMatchObject({ status: 'rejected' });
    });

    test('a project that does not exist cannot be deleted', async () => {
        const client = await device();
        client.send({ type: 'project.remove', projectId: createId() });
        expect(await client.next()).toMatchObject({
            code: 'forbidden',
            message: 'unknown project',
        });
        expect(daemon.registry.list()).toHaveLength(1);
    });

    test('an unknown project cannot be followed', async () => {
        const client = await device();
        client.send({ type: 'subscribe', projectId: createId() });
        expect(await client.next()).toMatchObject({
            code: 'forbidden',
            message: 'unknown project',
        });
        // The connection stays: the device keeps following the project it had.
        expect(daemon.devices.connectedDevices(project.projectId)).toBe(1);
    });

    test('devices of another computer cannot reach this one', async () => {
        const { home: otherHome, cleanup: cleanupOther } = await createTempHome();
        try {
            const other = await startTestDaemon(otherHome, { relay });
            try {
                await waitForRelay(other);
                expect(other.registry.roomId).not.toBe(daemon.registry.roomId);
                const client = await TestClient.connect(relay, other.registry.roomId);
                clients.push(client);
                // The token of this computer is worthless in another computer's room.
                client.send({ type: 'hello', computer: project.computer, deviceId: 'phone' });
                expect(await client.next()).toMatchObject({ code: 'unauthorized' });
            } finally {
                await other.stop();
            }
        } finally {
            await cleanupOther();
        }
    });
});

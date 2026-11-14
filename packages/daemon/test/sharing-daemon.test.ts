import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, listItems, listSessions } from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import { type Daemon, DEFAULT_OWNER_NAME, JsonStorage, KEY_HEADER } from '../src';
import { shortRef } from '../src/agent-actions';
import {
    createTempHome,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
} from './helpers';

/** Sharing through the Local API of a running daemon, as the CLI uses it. */
describe('sharing through the Local API', () => {
    let daemon: Daemon;
    let home: string;
    let key: string;
    let cleanup: () => Promise<void>;
    let projectId: string;
    let session: { ref: string; id: string };
    let checklistRef: string;

    const call = async (method: string, path: string, payload?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${daemon.localPort}${path}`, {
            method,
            headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
            ...(payload !== undefined && { body: JSON.stringify(payload) }),
        });
        // biome-ignore lint/suspicious/noExplicitAny: the JSON of the Local API, read freely by the tests
        const body = (await response.json()) as Record<string, any>;
        return { status: response.status, body };
    };

    beforeAll(async () => {
        ({ home, cleanup } = await createTempHome());
        daemon = await startTestDaemon(home);
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        await daemon.setComputerName('Office');
        const resolved = await call('POST', '/projects/resolve', { rootPath: '/tmp/shared-demo' });
        projectId = resolved.body.projectId;
        const started = await call('POST', `/projects/${projectId}/sessions`, { title: 'Release' });
        session = { ref: started.body.ref, id: started.body.id };
        const list = await call(
            'POST',
            `/projects/${projectId}/sessions/${session.ref}/checklists`,
            {
                title: 'Login',
                items: ['Right password', 'Wrong password'],
            },
        );
        checklistRef = list.body.ref;
        await daemon.people.addPerson('Mario');
    });

    afterAll(async () => {
        await daemon.stop();
        await cleanup();
    });

    const base = () => `/projects/${projectId}/sessions/${session.ref}`;

    test('share, list, message and close', async () => {
        const shared = await call('POST', `${base()}/shares`, {
            checklist: checklistRef,
            with: 'Mario',
            days: 3,
        });
        expect(shared.status).toBe(201);
        expect(shared.body).toMatchObject({ person: 'Mario', outcome: 'new', state: 'open' });

        const listed = await call('GET', '/shares');
        expect(listed.body.shares).toHaveLength(1);
        expect(listed.body.shares[0]).toMatchObject({
            person: 'Mario',
            project: { name: 'shared-demo' },
            session: { title: 'Release' },
        });

        const message = await call('PUT', `${base()}/message`, {
            message: 'Start here',
            to: 'Mario',
        });
        expect(message.body).toEqual({ person: 'Mario' });

        const missing = await call('POST', `${base()}/shares`, {
            checklist: checklistRef,
            with: 'Nobody',
        });
        expect(missing.status).toBe(404);
        expect(missing.body.error).toMatch(/invite/);

        const closed = await call('DELETE', `${base()}/shares/Mario`);
        expect(closed.body).toMatchObject({ person: 'Mario', state: 'closed' });
    });

    test('the copy is invisible to everything that lists the projects of the computer', async () => {
        const { shareId } = daemon.people.shares()[0] as { shareId: string };
        expect(daemon.registry.list().map((project) => project.projectId)).toEqual([projectId]);
        expect(daemon.registry.has(shareId)).toBe(false);
        const projects = await call('GET', '/projects');
        expect(projects.body.projects.map((project: { id: string }) => project.id)).toEqual([
            projectId,
        ]);
        const sessions = await call('GET', '/sessions');
        expect(sessions.body.sessions).toHaveLength(1);
        expect((await call('GET', `/projects/${shareId}/sessions`)).status).toBe(404);
        const registryFile = await readFile(join(home, 'projects.json'), 'utf8');
        expect(registryFile).not.toContain(shareId);
    });

    test('a project outside the registry carries no computer name even without a share record', async () => {
        const id = createId();
        await daemon.rooms.get(id);
        const storage = new JsonStorage(join(home, 'data'));
        await storage.createProject({ id, name: 'orphan', rootPath: 'guest:x', createdAt: 1 });
        const room = await daemon.rooms.get(id);
        expect(room).not.toBeNull();
        expect(daemon.people.isShareProject(id)).toBe(false);
        expect(room?.project.computer).toBeUndefined();
    });

    test('devices of the computer learn its name, the copy only the name of its owner', async () => {
        const { shareId } = daemon.people.shares()[0] as { shareId: string };
        const original = await daemon.rooms.get(projectId);
        const copy = await daemon.rooms.get(shareId);
        expect(original?.project.computer).toBe('Office');
        expect(copy?.project.computer).toBe(DEFAULT_OWNER_NAME);
        expect(JSON.stringify(copy?.syncMessage())).not.toContain('Office');
        await daemon.setComputerName('Home');
        expect(copy?.project.computer).toBe(DEFAULT_OWNER_NAME);
    });

    test('feedback carries the people, and the acknowledgement goes with it', async () => {
        const reopened = await call('POST', `${base()}/shares`, {
            checklist: checklistRef,
            with: 'Mario',
        });
        expect(reopened.body.outcome).toBe('reopened');
        const { shareId, copySessionId } = daemon.people.shares()[0] as {
            shareId: string;
            copySessionId: string;
        };
        const copy = await daemon.rooms.get(shareId);
        const [item] = listItems(
            copy?.state as never,
            daemon.people.shares()[0]?.checklists[0]?.copy as string,
        );
        await copy?.submitLocal('item.update', copySessionId, {
            itemId: item?.id as string,
            status: 'cancelled',
            note: 'it crashes',
        });

        const feedback = await call('GET', `${base()}/feedback`);
        expect(feedback.body.hasNew).toBe(true);
        expect(feedback.body.shared.people).toEqual([
            { person: 'Mario', state: 'open', reviewed: 1, total: 2 },
        ]);
        expect(feedback.body.shared.checklists[0].items[0].outcomes[0]).toMatchObject({
            person: 'Mario',
            status: 'cancelled',
            note: 'it crashes',
        });

        const { ack, shared } = feedback.body;
        await call('POST', `${base()}/feedback/ack`, { ...ack, shared: shared.ack });
        const again = await call('GET', `${base()}/feedback`);
        expect(again.body.hasNew).toBe(false);
        expect(again.body.shared.checklists).toEqual([]);
    });

    test('a name with a space and a dot reaches the daemon whole', async () => {
        await daemon.people.addPerson('Mario R.');
        const shared = await call('POST', `${base()}/shares`, {
            checklist: checklistRef,
            with: 'mario r.',
        });
        expect(shared.body.person).toBe('Mario R.');
        const closed = await call('DELETE', `${base()}/shares/${encodeURIComponent('Mario R.')}`);
        expect(closed.body).toMatchObject({ person: 'Mario R.', state: 'closed' });
    });

    test('share remove through the Local API', async () => {
        const second = await call(
            'POST',
            `/projects/${projectId}/sessions/${session.ref}/checklists`,
            {
                title: 'Logout',
                items: ['Logs out'],
            },
        );
        await call('POST', `${base()}/shares`, { checklist: second.body.ref, with: 'Mario' });
        const removed = await call(
            'DELETE',
            `${base()}/shares/Mario/checklists/${second.body.ref}`,
        );
        expect(removed.status).toBe(200);
        expect(removed.body).toMatchObject({
            person: 'Mario',
            state: 'open',
            removed: { title: 'Logout', total: 1 },
        });
        expect(
            (await call('DELETE', `${base()}/shares/Mario/checklists/${second.body.ref}`)).status,
        ).toBe(404);
    });

    test('retest and unknown bodies are checked', async () => {
        const retest = await call('POST', `${base()}/retest`, { with: 'Mario' });
        expect(retest.body).toMatchObject({ person: 'Mario', unchanged: 2 });
        expect((await call('POST', `${base()}/retest`, {})).status).toBe(400);
        expect((await call('POST', `${base()}/shares`, { with: 'Mario' })).status).toBe(400);
        expect(
            (await call('POST', `${base()}/shares`, { checklist: 'abcd', with: 'Mario', days: 0 }))
                .status,
        ).toBe(400);
    });

    test('the copies survive a restart of the daemon', async () => {
        await daemon.stop();
        daemon = await startTestDaemon(home);
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        const listed = await call('GET', '/shares');
        // Mario, and Mario R. from the test before.
        expect(listed.body.shares.map((share: { person: string }) => share.person)).toEqual([
            'Mario',
            'Mario R.',
        ]);
        const copy = await daemon.rooms.get(daemon.people.shares()[0]?.shareId as string);
        expect(listSessions(copy?.state as never)[0]?.title).toBe('Release');
        expect(copy?.project.computer).toBe(DEFAULT_OWNER_NAME);
    });

    test('deleting the session deletes the copies', async () => {
        const { shareId } = daemon.people.shares()[0] as { shareId: string };
        await call('DELETE', base());
        for (let i = 0; i < 100 && daemon.people.shares().length > 0; i++) await Bun.sleep(10);
        expect(daemon.people.shares()).toHaveLength(0);
        expect(await daemon.rooms.get(shareId)).toBeNull();
        expect((await call('GET', '/shares')).body.shares).toEqual([]);
    });

    test('removing the project deletes the copies', async () => {
        const started = await call('POST', `/projects/${projectId}/sessions`, { title: 'Again' });
        const list = await call(
            'POST',
            `/projects/${projectId}/sessions/${started.body.ref}/checklists`,
            {
                title: 'Other',
                items: ['One'],
            },
        );
        await call('POST', `/projects/${projectId}/sessions/${started.body.ref}/shares`, {
            checklist: list.body.ref,
            with: 'Mario',
        });
        expect(daemon.people.shares()).toHaveLength(1);
        await call('DELETE', `/projects/${projectId}`);
        expect(daemon.people.shares()).toHaveLength(0);
    });
});

/** The devices of the computer, with a copy in the data folder. */
describe('devices of the computer and a copy shared with someone', () => {
    let daemon: Daemon;
    let relay: Relay;
    let cleanup: () => Promise<void>;
    let project: SeededProject;
    let shareId: string;
    const clients: TestClient[] = [];

    beforeAll(async () => {
        let home: string;
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await startTestDaemon(home, { relay });
        project = await seedProject(daemon);
        const room = await daemon.rooms.get(project.projectId);
        await daemon.people.addPerson('Mario');
        const shared = await daemon.sharing.share({
            room: room as NonNullable<typeof room>,
            sessionId: project.sessionId,
            checklistRef: shortRef(project.checklistId),
            personName: 'Mario',
        });
        expect(shared.outcome).toBe('new');
        shareId = daemon.people.shares()[0]?.shareId as string;
    });

    afterAll(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    test('the project list has the project of the computer and not the copy', async () => {
        const client = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(client);
        await client.hello({ computer: project.computer }, 'phone');
        expect(client.projects?.projects.map((entry) => entry.id)).toEqual([project.projectId]);
    });

    test('a device cannot follow or delete the copy', async () => {
        // Asking for it at hello: the list comes, the copy does not.
        const joiner = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(joiner);
        await joiner.handshake(project.computer, 'phone-1');
        joiner.send({ type: 'hello', projectId: shareId });
        expect(await joiner.next()).toMatchObject({ type: 'projects' });
        await joiner.expectSilence();

        const follower = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(follower);
        await follower.hello({ computer: project.computer }, 'phone-2');
        follower.send({ type: 'subscribe', projectId: shareId });
        expect(await follower.next()).toMatchObject({ type: 'error', code: 'forbidden' });

        const remover = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(remover);
        await remover.hello({ computer: project.computer }, 'phone-3');
        remover.send({ type: 'project.remove', projectId: shareId });
        expect(await remover.next()).toMatchObject({ type: 'error', code: 'forbidden' });
        expect(daemon.people.isShareProject(shareId)).toBe(true);
    });
});

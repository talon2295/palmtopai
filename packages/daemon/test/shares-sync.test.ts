import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listItems, type ServerMessage } from '@palmtopai/protocol';
import type { Relay } from '@palmtopai/relay';
import type { Daemon } from '../src';
import { shortRef } from '../src/agent-actions';
import {
    createTempHome,
    deviceOp,
    type SeededProject,
    seedProject,
    startTestDaemon,
    startTestRelay,
    TestClient,
    type TestComputer,
    type TestDevice,
} from './helpers';

type Shares = Extract<ServerMessage, { type: 'shares' }>;

/** What the people answer, as the devices of the owner and of the people learn it. */
describe('the answers of the people on the devices of the owner', () => {
    let cleanup: () => Promise<void>;
    let relay: Relay;
    let daemon: Daemon;
    let project: SeededProject;
    const clients: TestClient[] = [];

    beforeEach(async () => {
        let home: string;
        ({ home, cleanup } = await createTempHome());
        relay = startTestRelay();
        daemon = await startTestDaemon(home, { relay });
        project = await seedProject(daemon, '/tmp/demo-repo');
    });

    afterEach(async () => {
        for (const client of clients.splice(0)) client.close();
        await daemon.stop();
        await relay.stop();
        await cleanup();
    });

    async function shareWith(name: string) {
        if (!daemon.people.findPerson(name)) await daemon.people.addPerson(name);
        const room = await daemon.rooms.get(project.projectId);
        await daemon.sharing.share({
            room: room as NonNullable<typeof room>,
            sessionId: project.sessionId,
            checklistRef: shortRef(project.checklistId),
            personName: name,
        });
        const person = daemon.people.findPerson(name);
        return daemon.people.shareFor(
            person?.personId as string,
            project.projectId,
            project.sessionId,
        );
    }

    /** A device of the owner following the project. */
    async function owner(deviceId = 'owner-phone') {
        const client = await TestClient.connect(relay, daemon.registry.roomId);
        clients.push(client);
        await client.hello({ projectId: project.projectId, computer: project.computer }, deviceId);
        return client;
    }

    async function guest(name: string) {
        const invite = await daemon.guestRooms.invite(name);
        const client = await TestClient.connect(relay, invite.roomId);
        clients.push(client);
        const paired = await client.pair({
            roomId: invite.roomId,
            pairKey: invite.key,
            deviceId: `${name.toLowerCase()}-phone`,
        });
        await client.next();
        const computer: TestComputer = {
            roomId: invite.roomId,
            publicKey: paired.computerKey,
            device: async () => paired.device as TestDevice,
        };
        return { client, computer, device: paired.device };
    }

    const nextShares = async (client: TestClient, timeoutMs = 2_000): Promise<Shares> => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const message = await client.next(Math.max(50, deadline - Date.now()));
            if (message.type === 'shares') return message;
        }
        throw new Error('no shares message');
    };

    test('arrives after the sync of the project, with nobody having answered yet', async () => {
        await shareWith('Mario');
        const phone = await owner();
        const message = await nextShares(phone);
        expect(message.projectId).toBe(project.projectId);
        expect(message.sessions).toEqual([
            {
                sessionId: project.sessionId,
                people: [
                    {
                        name: 'Mario',
                        state: 'open',
                        expiresAt: expect.any(Number),
                        checklists: [expect.any(String)],
                        items: {},
                    },
                ],
            },
        ]);
    });

    test('is not sent when nothing is shared', async () => {
        const phone = await owner();
        await phone.expectSilence();
    });

    test('follows what the person answers, by the item of the owner, and what they add', async () => {
        const copy = await shareWith('Mario');
        const mario = await guest('Mario');
        const phone = await owner();
        await nextShares(phone);

        await mario.client.hello(
            { projectId: copy?.shareId as string, computer: mario.computer },
            mario.device.deviceId,
        );
        const guestRoom = await daemon.rooms.get(copy?.shareId as string);
        const first = listItems(guestRoom?.state as never, copy?.checklists[0]?.copy as string)[0];
        const asGuest = { ...project, projectId: copy?.shareId as string };
        mario.client.sendOp(
            deviceOp(
                asGuest,
                mario.device.deviceId,
                50,
                'item.update',
                { itemId: first?.id as string, status: 'cancelled', note: 'no error' },
                copy?.copySessionId,
            ),
        );
        mario.client.sendOp(
            deviceOp(
                asGuest,
                mario.device.deviceId,
                51,
                'session.note',
                { note: 'Looks fine otherwise' },
                copy?.copySessionId,
            ),
        );

        let latest = await nextShares(phone);
        for (let i = 0; i < 5 && !latest.sessions[0]?.people[0]?.note; i++) {
            latest = await nextShares(phone);
        }
        const person = latest.sessions[0]?.people[0];
        // Keyed by the item of the owner, not by the copy.
        expect(person?.items).toEqual({
            [first?.origin as string]: { status: 'cancelled', note: 'no error' },
        });
        expect(person?.note).toBe('Looks fine otherwise');
        expect(project.itemIds).toContain(first?.origin as never);
    });

    test('says when a copy is closed or removed', async () => {
        await shareWith('Mario');
        const phone = await owner();
        await nextShares(phone);
        await daemon.sharing.close({
            projectId: project.projectId,
            sessionId: project.sessionId,
            personName: 'Mario',
        });
        const closed = await nextShares(phone);
        expect(closed.sessions[0]?.people[0]?.state).toBe('closed');
        await daemon.sharing.dropSession(project.projectId, project.sessionId);
        const gone = await nextShares(phone);
        expect(gone.sessions).toEqual([]);
    });

    test('never reaches the devices of the people', async () => {
        const copy = await shareWith('Mario');
        const mario = await guest('Mario');
        await mario.client.hello(
            { projectId: copy?.shareId as string, computer: mario.computer },
            mario.device.deviceId,
        );
        const guestRoom = await daemon.rooms.get(copy?.shareId as string);
        await guestRoom?.submitLocal('session.message', copy?.copySessionId as string, {
            message: 'hello',
        });
        const seen: ServerMessage[] = [];
        for (let i = 0; i < 6; i++) {
            try {
                seen.push(await mario.client.next(150));
            } catch {
                break;
            }
        }
        expect(seen.length).toBeGreaterThan(0);
        expect(seen.some((message) => message.type === 'shares')).toBe(false);
    });

    test('a copy tells its person when it stops taking answers, the project of the owner does not', async () => {
        const copy = await shareWith('Mario');
        const mario = await guest('Mario');
        const snapshot = await mario.client.hello(
            { projectId: copy?.shareId as string, computer: mario.computer },
            mario.device.deviceId,
        );
        expect(snapshot).toMatchObject({
            type: 'snapshot',
            project: { sharedUntil: copy?.expiresAt },
        });
        const phone = await owner();
        void phone;
        const original = await daemon.rooms.get(project.projectId);
        expect(original?.project.sharedUntil).toBeUndefined();
        expect(JSON.stringify(original?.syncMessage())).not.toContain('sharedUntil');
    });
});

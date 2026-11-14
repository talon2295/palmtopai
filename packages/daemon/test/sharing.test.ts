import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    createId,
    createOp,
    getChecklist,
    type Item,
    listChecklists,
    listItems,
    listSessions,
    type OpOf,
    type OpType,
    type ProjectState,
} from '@palmtopai/protocol';
import type { Share } from '../src';
import { MemoryStorage, PeopleStore, RoomManager, Sharing } from '../src';
import { ActionError, shortRef } from '../src/agent-actions';
import { authorizeDeviceOp, MAX_CLOCK_JUMP, MAX_DEVICE_ITEMS } from '../src/permissions';
import type { ProjectRoom } from '../src/room';

const DAY = 86_400_000;

/** The owner's project with one session and one checklist of three checks, and a sharing set up. */
async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'palmtop-sharing-'));
    const clock = { now: 1_000_000 };
    const storage = new MemoryStorage();
    const rooms = new RoomManager(storage, {
        computerName: (id) => (id === projectId ? 'Office' : undefined),
    });
    const people = await PeopleStore.open(join(dir, 'people.json'), () => clock.now);
    const sharing = new Sharing({
        people,
        rooms,
        storage,
        projectName: () => 'demo',
        now: () => clock.now,
    });
    const projectId = createId();
    await storage.createProject({
        id: projectId,
        name: 'demo',
        rootPath: '/tmp/demo',
        createdAt: 1,
    });
    const room = (await rooms.get(projectId)) as ProjectRoom;
    const sessionId = createId();
    const checklistId = createId();
    const itemIds = [createId(), createId(), createId()];
    await room.submitLocal('session.upsert', sessionId, {
        title: 'Release 2.1',
        branch: 'main',
        startedAt: 1,
    });
    await room.submitLocal('checklist.create', sessionId, { checklistId, title: 'Login' });
    for (const [order, itemId] of itemIds.entries()) {
        await room.submitLocal('item.add', sessionId, {
            itemId,
            checklistId,
            text: `Check ${order + 1}`,
            order,
        });
    }
    await people.addPerson('Mario');
    await people.addPerson('Luca');

    return {
        dir,
        clock,
        storage,
        rooms,
        people,
        sharing,
        projectId,
        room,
        sessionId,
        checklistId,
        itemIds,
        cleanup: () => rm(dir, { recursive: true, force: true }),
        share: (checklist = checklistId, person = 'Mario', days?: number) =>
            sharing.share({
                room,
                sessionId,
                checklistRef: shortRef(checklist),
                personName: person,
                ...(days !== undefined && { days }),
            }),
        retest: (person = 'Mario', itemRefs?: string[], message?: string) =>
            sharing.retest({
                room,
                sessionId,
                personName: person,
                ...(itemRefs && { itemRefs }),
                ...(message !== undefined && { message }),
            }),
        /** The copy of a person, as the guest's device finds it. */
        async copyOf(person = 'Mario') {
            const personId = people.findPerson(person)?.personId as string;
            const share = people.shareFor(personId, projectId, sessionId) as Share;
            const guest = (await rooms.get(share.shareId)) as ProjectRoom;
            return { share, guest };
        },
    };
}

type Harness = Awaited<ReturnType<typeof setup>>;

/** An op of a device (the guest's phone) on the room of the copy. */
function deviceOp<T extends OpType>(
    room: ProjectRoom,
    sessionId: string,
    type: T,
    payload: OpOf<T>['payload'],
    deviceId = 'guest-phone',
) {
    return room.submit(
        createOp({
            projectId: room.projectId,
            sessionId,
            type,
            payload,
            clock: { lamport: room.state.lamport + 1, deviceId },
        }),
        { kind: 'device', deviceId },
    );
}

const itemWithOrigin = (state: ProjectState, checklistId: string, origin: string): Item =>
    listItems(state, checklistId).find((item) => item.origin === origin) as Item;

async function status(promise: Promise<unknown>): Promise<number | string> {
    try {
        await promise;
    } catch (error) {
        return error instanceof ActionError ? error.status : 'other';
    }
    return 'none';
}

describe('sharing a checklist', () => {
    let t: Harness;
    beforeEach(async () => {
        t = await setup();
    });
    afterEach(() => t.cleanup());

    test('gives the person a copy in a project of its own, linked to the originals', async () => {
        const result = await t.share();
        expect(result).toMatchObject({
            person: 'Mario',
            state: 'open',
            outcome: 'new',
            project: { name: 'demo' },
            session: { title: 'Release 2.1' },
            checklists: [{ ref: shortRef(t.checklistId), title: 'Login', reviewed: 0, total: 3 }],
        });
        expect(result.expiresAt).toBe(t.clock.now + 7 * DAY);

        const { share, guest } = await t.copyOf();
        expect(share.shareId).not.toBe(t.projectId);
        expect(t.people.isShareProject(share.shareId)).toBe(true);
        expect(t.people.isShareProject(t.projectId)).toBe(false);

        const [session] = listSessions(guest.state);
        expect(session?.title).toBe('Release 2.1');
        expect(session?.id).toBe(share.copySessionId);
        const copies = listChecklists(guest.state, share.copySessionId);
        expect(copies).toHaveLength(1);
        expect(copies[0]).toMatchObject({ title: 'Login', origin: t.checklistId, kind: 'checks' });
        const items = listItems(guest.state, copies[0]?.id as string);
        expect(items.map((item) => item.text)).toEqual(['Check 1', 'Check 2', 'Check 3']);
        expect(items.map((item) => item.origin)).toEqual(t.itemIds);
        expect(items.every((item) => item.status === undefined && !item.addedByUser)).toBe(true);
        // The original did not change.
        expect(listItems(t.room.state, t.checklistId).every((item) => !item.origin)).toBe(true);
    });

    test('the copy is stored on its own, with a path that is not a folder of the computer', async () => {
        await t.share();
        const { share } = await t.copyOf();
        const metas = await t.storage.listProjects();
        expect(metas.find((meta) => meta.id === share.shareId)?.rootPath).toStartWith('guest:');
        expect(share.copySessionId).not.toBe(t.sessionId);
    });

    test('the copy carries no computer name, the original does', async () => {
        await t.share();
        const { guest } = await t.copyOf();
        expect(t.room.project.computer).toBe('Office');
        expect(guest.project.computer).toBeUndefined();
    });

    test('refuses an unknown person, a question and a checklist shared twice', async () => {
        expect(await status(t.share(t.checklistId, 'Nobody'))).toBe(404);
        const questionId = createId();
        await t.room.submitLocal('checklist.create', t.sessionId, {
            checklistId: questionId,
            title: 'Which one?',
            kind: 'choice',
        });
        expect(await status(t.share(questionId))).toBe(400);
        await t.share();
        await expect(t.share()).rejects.toThrow(/retest/);
        expect(await status(t.share(t.checklistId, 'mario'))).toBe(409);
    });

    test('names are matched without regard to case, the days are checked', async () => {
        const result = await t.share(t.checklistId, 'mARIO', 30);
        expect(result.person).toBe('Mario');
        expect(result.expiresAt).toBe(t.clock.now + 30 * DAY);
        expect(await status(t.share(t.checklistId, 'Luca', 0))).toBe(400);
        expect(await status(t.share(t.checklistId, 'Luca', 366))).toBe(400);
    });

    test('a second checklist of the session joins the same copy', async () => {
        const second = createId();
        await t.room.submitLocal('checklist.create', t.sessionId, {
            checklistId: second,
            title: 'Logout',
        });
        await t.room.submitLocal('item.add', t.sessionId, {
            itemId: createId(),
            checklistId: second,
            text: 'Logs out',
            order: 0,
        });
        await t.share();
        const result = await t.share(second);
        expect(result.outcome).toBe('added');
        expect(result.checklists.map((list) => list.title)).toEqual(['Login', 'Logout']);
        expect(t.people.shares()).toHaveLength(1);
    });

    test('two people get two copies that do not touch each other', async () => {
        await t.share(t.checklistId, 'Mario');
        await t.share(t.checklistId, 'Luca');
        const mario = await t.copyOf('Mario');
        const luca = await t.copyOf('Luca');
        expect(mario.share.shareId).not.toBe(luca.share.shareId);
        const [item] = listItems(mario.guest.state, mario.share.checklists[0]?.copy as string);
        await deviceOp(mario.guest, mario.share.copySessionId, 'item.update', {
            itemId: (item as Item).id,
            status: 'done',
        });
        const untouched = listItems(luca.guest.state, luca.share.checklists[0]?.copy as string);
        expect(untouched.every((copy) => copy.status === undefined)).toBe(true);
    });

    test('a device cannot make an item pose as a copy', async () => {
        await t.share();
        const { share, guest } = await t.copyOf();
        const op = createOp({
            projectId: guest.projectId,
            sessionId: share.copySessionId,
            type: 'item.add',
            payload: {
                itemId: createId(),
                checklistId: share.checklists[0]?.copy as string,
                text: 'Mine',
                order: 9,
                origin: t.itemIds[0] as string,
            },
            clock: { lamport: 99, deviceId: 'guest-phone' },
        });
        expect(authorizeDeviceOp(guest.state, op, 'guest-phone')).toMatchObject({
            code: 'forbidden',
        });
        // Without the origin the same op is a normal item added by the guest.
        const plain = createOp({
            projectId: guest.projectId,
            sessionId: share.copySessionId,
            type: 'item.add',
            payload: { ...op.payload, origin: undefined },
            clock: { lamport: 99, deviceId: 'guest-phone' },
        });
        expect(authorizeDeviceOp(guest.state, plain, 'guest-phone')).toBeNull();
    });
});

describe('retest', () => {
    let t: Harness;
    beforeEach(async () => {
        t = await setup();
        await t.share();
    });
    afterEach(() => t.cleanup());

    async function copyItems() {
        const { share, guest } = await t.copyOf();
        return { share, guest, items: listItems(guest.state, share.checklists[0]?.copy as string) };
    }

    /** The guest reviews the copy of an original item. */
    async function review(origin: string, state: 'done' | 'cancelled', note?: string) {
        const { share, guest, items } = await copyItems();
        const item = items.find((candidate) => candidate.origin === origin) as Item;
        const result = await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: item.id,
            status: state,
            ...(note !== undefined && { note }),
        });
        expect(result.status).toBe('applied');
    }

    test('changed text asks for a new review, unchanged items keep theirs', async () => {
        await review(t.itemIds[0] as string, 'done');
        await review(t.itemIds[1] as string, 'cancelled', 'broken');
        await t.room.submitLocal('item.update', t.sessionId, {
            itemId: t.itemIds[1] as string,
            text: 'Check 2, fixed',
        });
        const result = await t.retest();
        expect(result).toEqual({
            person: 'Mario',
            added: 0,
            updated: 1,
            reset: 1,
            removed: 0,
            unchanged: 2,
        });
        const { items } = await copyItems();
        expect(items[0]).toMatchObject({ text: 'Check 1', status: 'done' });
        expect(items[1]).toMatchObject({ text: 'Check 2, fixed' });
        expect(items[1]?.status).toBeUndefined();
        expect(items[1]?.note).toBeUndefined();
    });

    test('a change to an item nobody reviewed is not a new review', async () => {
        await t.room.submitLocal('item.update', t.sessionId, {
            itemId: t.itemIds[2] as string,
            text: 'Check 3 (clearer)',
        });
        expect(await t.retest()).toMatchObject({ updated: 1, reset: 0 });
    });

    test('new items are added and removed ones go', async () => {
        const added = createId();
        await t.room.submitLocal('item.add', t.sessionId, {
            itemId: added,
            checklistId: t.checklistId,
            text: 'Check 4',
            order: 3,
        });
        await t.room.submitLocal('item.remove', t.sessionId, { itemId: t.itemIds[0] as string });
        const result = await t.retest();
        expect(result).toMatchObject({ added: 1, removed: 1, unchanged: 2 });
        const { items } = await copyItems();
        expect(items.map((item) => item.text)).toEqual(['Check 2', 'Check 3', 'Check 4']);
        expect(items.at(-1)?.origin).toBe(added);
    });

    test('what the guest added is left alone', async () => {
        const { share, guest } = await copyItems();
        const own = createId();
        await deviceOp(guest, share.copySessionId, 'item.add', {
            itemId: own,
            checklistId: share.checklists[0]?.copy as string,
            text: 'Also try Safari',
            order: 10,
        });
        await t.room.submitLocal('item.remove', t.sessionId, { itemId: t.itemIds[0] as string });
        await t.retest();
        const { items } = await copyItems();
        expect(items.find((item) => item.id === own)).toMatchObject({
            text: 'Also try Safari',
            addedByUser: true,
        });
    });

    test('with refs only those items are looked at', async () => {
        await t.room.submitLocal('item.update', t.sessionId, {
            itemId: t.itemIds[0] as string,
            text: 'Check 1 v2',
        });
        await t.room.submitLocal('item.update', t.sessionId, {
            itemId: t.itemIds[1] as string,
            text: 'Check 2 v2',
        });
        await t.room.submitLocal('item.remove', t.sessionId, { itemId: t.itemIds[2] as string });
        const result = await t.retest('Mario', [shortRef(t.itemIds[0] as string)]);
        expect(result).toMatchObject({ updated: 1, removed: 0 });
        const { items } = await copyItems();
        expect(items.map((item) => item.text)).toEqual(['Check 1 v2', 'Check 2', 'Check 3']);
        expect(await status(t.retest('Mario', ['zzzzzz']))).toBe(404);
    });

    test('a checklist taken out of the original goes from the copy, the title follows', async () => {
        const second = createId();
        await t.room.submitLocal('checklist.create', t.sessionId, {
            checklistId: second,
            title: 'Logout',
        });
        await t.share(second);
        await t.room.submitLocal('checklist.update', t.sessionId, {
            checklistId: t.checklistId,
            title: 'Login v2',
        });
        await t.room.submitLocal('checklist.remove', t.sessionId, { checklistId: second });
        await t.retest();
        const { share, guest } = await t.copyOf();
        expect(listChecklists(guest.state, share.copySessionId).map((list) => list.title)).toEqual([
            'Login v2',
        ]);
        expect(share.checklists).toHaveLength(1);
        expect(getChecklist(guest.state, share.checklists[0]?.copy as string)?.origin).toBe(
            t.checklistId,
        );
    });

    test('a message goes to the copy of that person only', async () => {
        await t.share(t.checklistId, 'Luca');
        await t.retest('Mario', undefined, 'Please check the fix');
        const mario = await t.copyOf('Mario');
        const luca = await t.copyOf('Luca');
        expect(listSessions(mario.guest.state)[0]?.message?.text).toBe('Please check the fix');
        expect(listSessions(luca.guest.state)[0]?.message).toBeUndefined();
        expect(listSessions(t.room.state)[0]?.message).toBeUndefined();
    });

    test('a closed or expired copy is not updated', async () => {
        await t.sharing.close({
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: 'Mario',
        });
        expect(await status(t.retest())).toBe(409);
    });
});

describe('message to a person', () => {
    let t: Harness;
    beforeEach(async () => {
        t = await setup();
    });
    afterEach(() => t.cleanup());

    test('is the message of that copy, and empty removes it', async () => {
        await t.share();
        const args = { projectId: t.projectId, sessionId: t.sessionId, personName: 'Mario' };
        await t.sharing.message({ ...args, message: 'Start with the login' });
        const { guest } = await t.copyOf();
        expect(listSessions(guest.state)[0]?.message?.text).toBe('Start with the login');
        await t.sharing.message({ ...args, message: '' });
        expect(listSessions(guest.state)[0]?.message).toBeUndefined();
    });

    test('needs a copy of this session for that person', async () => {
        await t.share();
        expect(
            await status(
                t.sharing.message({
                    projectId: t.projectId,
                    sessionId: t.sessionId,
                    personName: 'Luca',
                    message: 'Hi',
                }),
            ),
        ).toBe(404);
    });
});

describe('closing and expiry', () => {
    let t: Harness;
    beforeEach(async () => {
        t = await setup();
    });
    afterEach(() => t.cleanup());

    const listed = async () =>
        (await t.sharing.list()).map((view) => `${view.person}:${view.state}`);

    test('a copy turns expired after its days, closed when the owner closes it', async () => {
        await t.share(t.checklistId, 'Mario', 2);
        await t.share(t.checklistId, 'Luca');
        expect(await listed()).toEqual(['Mario:open', 'Luca:open']);
        t.clock.now += 3 * DAY;
        expect(await listed()).toEqual(['Mario:expired', 'Luca:open']);
        await t.sharing.close({
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: 'Luca',
        });
        expect(await listed()).toEqual(['Mario:expired', 'Luca:closed']);
    });

    test('closing keeps what the person reviewed', async () => {
        await t.share();
        const { share, guest } = await t.copyOf();
        const [item] = listItems(guest.state, share.checklists[0]?.copy as string);
        await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: (item as Item).id,
            status: 'done',
        });
        await t.sharing.close({
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: 'Mario',
        });
        const [view] = await t.sharing.list();
        expect(view?.checklists[0]).toMatchObject({ reviewed: 1, total: 3 });
    });

    test('sharing again reopens it with the new days, and keeps the reviews', async () => {
        await t.share(t.checklistId, 'Mario', 1);
        const before = await t.copyOf();
        t.clock.now += 2 * DAY;
        const again = await t.share(t.checklistId, 'Mario', 5);
        expect(again.outcome).toBe('reopened');
        expect(again.state).toBe('open');
        expect(again.expiresAt).toBe(t.clock.now + 5 * DAY);
        expect((await t.copyOf()).share.shareId).toBe(before.share.shareId);
    });

    test('a copy whose original is gone is deleted at startup, one whose original is there stays', async () => {
        await t.share(t.checklistId, 'Mario');
        expect(await t.sharing.cleanOrphans(() => true)).toBe(0);
        expect(t.people.shares()).toHaveLength(1);

        // The session was deleted but the daemon stopped before the copies went.
        await t.room.submitLocal('session.remove', t.sessionId, {});
        const { share } = await t.copyOf();
        expect(await t.sharing.cleanOrphans(() => true)).toBe(1);
        expect(t.people.shares()).toHaveLength(0);
        expect(await t.storage.loadProject(share.shareId)).toBeNull();
    });

    test('a copy whose project is gone is deleted at startup', async () => {
        await t.share(t.checklistId, 'Mario');
        expect(await t.sharing.cleanOrphans(() => false)).toBe(1);
        expect(t.people.shares()).toHaveLength(0);
    });

    test('the copies go with their session and with their project', async () => {
        await t.share(t.checklistId, 'Mario');
        const { share } = await t.copyOf();
        expect(await t.sharing.dropSession(t.projectId, t.sessionId)).toBe(1);
        expect(t.people.shares()).toHaveLength(0);
        expect(await t.storage.loadProject(share.shareId)).toBeNull();
        expect(await t.sharing.dropSession(t.projectId, t.sessionId)).toBe(0);

        await t.share(t.checklistId, 'Mario');
        await t.share(t.checklistId, 'Luca');
        expect(await t.sharing.dropProject(t.projectId)).toBe(2);
        expect(await t.sharing.list()).toEqual([]);
    });
});

describe('taking one checklist out of a copy', () => {
    let t: Harness;
    let secondId: string;
    beforeEach(async () => {
        t = await setup();
        secondId = createId();
        await t.room.submitLocal('checklist.create', t.sessionId, {
            checklistId: secondId,
            title: 'Logout',
        });
        await t.room.submitLocal('item.add', t.sessionId, {
            itemId: createId(),
            checklistId: secondId,
            text: 'Logs out',
            order: 0,
        });
        await t.share();
        await t.share(secondId);
    });
    afterEach(() => t.cleanup());

    const remove = (checklist: string, person = 'Mario') =>
        t.sharing.removeChecklist({
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: person,
            checklistRef: shortRef(checklist),
        });

    test('the checklist and its answers go, the other stays, the copy stays open', async () => {
        const { share, guest } = await t.copyOf();
        const [item] = listItems(guest.state, share.checklists[0]?.copy as string);
        await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: (item as Item).id,
            status: 'done',
        });
        const result = await remove(t.checklistId);
        expect(result.removed).toMatchObject({ title: 'Login', reviewed: 1, total: 3 });
        expect(result.state).toBe('open');
        expect(result.checklists.map((list) => list.title)).toEqual(['Logout']);

        const after = await t.copyOf();
        expect(
            listChecklists(after.guest.state, after.share.copySessionId).map((list) => list.title),
        ).toEqual(['Logout']);
        expect(after.share.checklists).toHaveLength(1);
        expect((await t.sharing.list())[0]?.checklists.map((list) => list.title)).toEqual([
            'Logout',
        ]);
    });

    test('the answers on it go, and what is lost is told before', async () => {
        const { share, guest } = await t.copyOf();
        const copy = share.checklists[0]?.copy as string;
        const [first, second] = listItems(guest.state, copy);
        await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: (first as Item).id,
            status: 'cancelled',
            note: 'Broken',
        });
        await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: (second as Item).id,
            status: 'done',
        });
        const target = {
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: 'Mario',
            checklistRef: shortRef(t.checklistId),
        };
        const preview = await t.sharing.previewRemoval(target);
        expect(preview.removed).toMatchObject({
            title: 'Login',
            reviewed: 2,
            total: 3,
            done: 1,
            cancelled: 1,
            question: 0,
            notes: 1,
        });
        // Looking changes nothing.
        expect((await t.sharing.list())[0]?.checklists).toHaveLength(2);

        await remove(t.checklistId);
        const view = await t.sharing.ownerView(t.projectId);
        expect(view[0]?.people[0]?.items).toEqual({});
    });

    test('an edit queued on the device for the removed checklist cannot hurt the rest', async () => {
        const { share, guest } = await t.copyOf();
        const [item] = listItems(guest.state, share.checklists[0]?.copy as string);
        const [other] = listItems(guest.state, share.checklists[1]?.copy as string);
        await remove(t.checklistId);
        // Rejected or ignored, never a crash.
        await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: (item as Item).id,
            status: 'done',
        });
        const accepted = await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: (other as Item).id,
            status: 'done',
        });
        expect(accepted.status).not.toBe('rejected');
        const [view] = await t.sharing.list();
        expect(view?.checklists).toHaveLength(1);
        expect(view?.checklists[0]).toMatchObject({ title: 'Logout', reviewed: 1, total: 1 });
    });

    test('the other people keep theirs', async () => {
        await t.share(t.checklistId, 'Luca');
        await remove(t.checklistId);
        const luca = await t.copyOf('Luca');
        expect(listChecklists(luca.guest.state, luca.share.copySessionId)).toHaveLength(1);
    });

    test('the last one closes the copy, and sharing again opens a fresh one', async () => {
        await remove(t.checklistId);
        const result = await remove(secondId);
        expect(result.state).toBe('closed');
        expect(result.checklists).toEqual([]);
        expect(t.people.shares()).toHaveLength(1);

        const again = await t.share();
        expect(again.outcome).toBe('reopened');
        expect(again.state).toBe('open');
        expect(again.checklists.map((list) => list.title)).toEqual(['Login']);
        expect(again.checklists[0]).toMatchObject({ reviewed: 0, total: 3 });
    });

    test('the checklist can be shared again, as a new copy without reviews', async () => {
        await remove(t.checklistId);
        const again = await t.share();
        expect(again.outcome).toBe('added');
        expect(again.checklists.find((list) => list.title === 'Login')).toMatchObject({
            reviewed: 0,
            total: 3,
        });
    });

    test('an unknown checklist, a closed copy and an unknown person are refused', async () => {
        expect(await status(remove(createId()))).toBe(404);
        expect(await status(remove(t.checklistId, 'Nobody'))).toBe(404);
        await t.sharing.close({
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: 'Mario',
        });
        expect(await status(remove(t.checklistId))).toBe(409);
    });

    test('an expired copy can be tidied up too', async () => {
        t.clock.now += 8 * DAY;
        const result = await remove(t.checklistId);
        expect(result.state).toBe('expired');
        expect(result.checklists).toHaveLength(1);
    });
});

describe('feedback from the people it is shared with', () => {
    let t: Harness;
    beforeEach(async () => {
        t = await setup();
        await t.share(t.checklistId, 'Mario');
        await t.share(t.checklistId, 'Luca');
    });
    afterEach(() => t.cleanup());

    async function reviewAs(
        person: string,
        origin: string,
        state: 'done' | 'cancelled' | 'question',
        note?: string,
    ) {
        const { share, guest } = await t.copyOf(person);
        const item = itemWithOrigin(guest.state, share.checklists[0]?.copy as string, origin);
        await deviceOp(guest, share.copySessionId, 'item.update', {
            itemId: item.id,
            status: state,
            ...(note !== undefined && { note }),
        });
    }

    const feedback = () => t.sharing.sharedFeedback(t.projectId, t.sessionId);

    test('is absent for a session that was not shared', async () => {
        expect(await t.sharing.sharedFeedback(t.projectId, createId())).toBeNull();
    });

    test('nothing new until someone reviews', async () => {
        const shared = await feedback();
        expect(shared).toMatchObject({ hasNew: false, checklists: [], notes: [] });
        expect(shared?.people).toEqual([
            { person: 'Mario', state: 'open', reviewed: 0, total: 3 },
            { person: 'Luca', state: 'open', reviewed: 0, total: 3 },
        ]);
    });

    test('puts the outcomes of every person side by side, by the original ref', async () => {
        const first = t.itemIds[0] as string;
        await reviewAs('Mario', first, 'done');
        await reviewAs('Luca', first, 'cancelled', 'wrong error');
        const shared = await feedback();
        expect(shared?.hasNew).toBe(true);
        expect(shared?.checklists).toEqual([
            {
                ref: shortRef(t.checklistId),
                title: 'Login',
                items: [
                    {
                        ref: shortRef(first),
                        text: 'Check 1',
                        outcomes: [
                            { person: 'Mario', status: 'done', changed: true },
                            {
                                person: 'Luca',
                                status: 'cancelled',
                                note: 'wrong error',
                                changed: true,
                            },
                        ],
                    },
                ],
            },
        ]);
        expect(shared?.people.map((entry) => entry.reviewed)).toEqual([1, 1]);
    });

    test('acknowledging hides what was delivered and shows it only as context after', async () => {
        const first = t.itemIds[0] as string;
        const second = t.itemIds[1] as string;
        await reviewAs('Mario', first, 'done');
        const shared = await feedback();
        await t.sharing.acknowledge(t.projectId, t.sessionId, shared?.ack ?? []);
        expect((await feedback())?.hasNew).toBe(false);

        await reviewAs('Luca', second, 'cancelled');
        const next = await feedback();
        expect(next?.checklists[0]?.items.map((item) => item.ref)).toEqual([shortRef(second)]);
        // Mario has not reviewed the second one: the line still shows him, as not reviewed.
        expect(next?.checklists[0]?.items[0]?.outcomes).toEqual([
            { person: 'Mario', changed: false },
            { person: 'Luca', status: 'cancelled', changed: true },
        ]);
    });

    test('a late acknowledgement never hides a newer review', async () => {
        const first = t.itemIds[0] as string;
        await reviewAs('Mario', first, 'done');
        const shown = await feedback();
        await reviewAs('Mario', first, 'cancelled', 'changed my mind');
        await t.sharing.acknowledge(t.projectId, t.sessionId, shown?.ack ?? []);
        const after = await feedback();
        expect(after?.hasNew).toBe(true);
        expect(after?.checklists[0]?.items[0]?.outcomes[0]).toMatchObject({
            person: 'Mario',
            status: 'cancelled',
            changed: true,
        });
    });

    test('the note of the guest comes with their name', async () => {
        const { share, guest } = await t.copyOf('Mario');
        await deviceOp(guest, share.copySessionId, 'session.note', { note: 'Looks good so far' });
        const shared = await feedback();
        expect(shared?.notes).toEqual([{ person: 'Mario', note: 'Looks good so far' }]);
        expect(shared?.hasNew).toBe(true);
        await t.sharing.acknowledge(t.projectId, t.sessionId, shared?.ack ?? []);
        const after = await feedback();
        expect(after).toMatchObject({ hasNew: false, notes: [] });
    });

    test('an acknowledgement for a copy of another session is ignored', async () => {
        const first = t.itemIds[0] as string;
        await reviewAs('Mario', first, 'done');
        const shown = await feedback();
        await t.sharing.acknowledge(t.projectId, createId(), shown?.ack ?? []);
        expect((await feedback())?.hasNew).toBe(true);
    });

    test('a closed copy still reports what the person reviewed', async () => {
        await reviewAs('Mario', t.itemIds[0] as string, 'done');
        await t.sharing.close({
            projectId: t.projectId,
            sessionId: t.sessionId,
            personName: 'Mario',
        });
        const shared = await feedback();
        expect(shared?.people[0]).toMatchObject({ person: 'Mario', state: 'closed', reviewed: 1 });
        expect(shared?.hasNew).toBe(true);
    });
});

describe('people', () => {
    test('are kept in people.json and found again without regard to case', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-people-'));
        try {
            const path = join(dir, 'people.json');
            const store = await PeopleStore.open(path);
            const mario = await store.addPerson('Mario');
            expect(await status(store.addPerson('MARIO'))).toBe(409);
            expect(await status(store.addPerson('  '))).toBe(400);
            expect(await status(store.addPerson('a\u0007b'))).toBe(400);
            const again = await PeopleStore.open(path);
            expect(again.findPerson('mario')?.personId).toBe(mario.personId);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe('what a device may do to a room', () => {
    let t: Harness;
    beforeEach(async () => {
        t = await setup();
        await t.share();
    });
    afterEach(() => t.cleanup());

    test('a clock far ahead of the room is refused, so it can neither win every write nor break the daemon', async () => {
        const { share, guest } = await t.copyOf();
        const itemId = listItems(guest.state, share.checklists[0]?.copy as string)[0]?.id as string;
        const op = (lamport: number) =>
            createOp({
                projectId: guest.projectId,
                sessionId: share.copySessionId,
                type: 'item.update',
                payload: { itemId, status: 'done' },
                clock: { lamport, deviceId: 'guest-phone' },
            });
        expect(
            authorizeDeviceOp(guest.state, op(guest.state.lamport + 10), 'guest-phone'),
        ).toBeNull();
        expect(
            authorizeDeviceOp(
                guest.state,
                op(guest.state.lamport + MAX_CLOCK_JUMP + 1),
                'guest-phone',
            ),
        ).toMatchObject({ code: 'forbidden' });
        const refused = await guest.submit(op(Number.MAX_SAFE_INTEGER), {
            kind: 'device',
            deviceId: 'guest-phone',
        });
        expect(refused.status).toBe('rejected');
        // The daemon can still write on the copy.
        await expect(t.retest('Mario', undefined, 'Hello again')).resolves.toBeDefined();
    });

    test('the devices add a limited number of items to a session', async () => {
        const { share, guest } = await t.copyOf();
        const checklistId = share.checklists[0]?.copy as string;
        for (let i = 0; i < MAX_DEVICE_ITEMS; i++) {
            const result = await deviceOp(guest, share.copySessionId, 'item.add', {
                itemId: createId(),
                checklistId,
                text: `Mine ${i}`,
                order: 100 + i,
            });
            expect(result.status).toBe('applied');
        }
        const one = await deviceOp(guest, share.copySessionId, 'item.add', {
            itemId: createId(),
            checklistId,
            text: 'One too many',
            order: 999,
        });
        expect(one).toMatchObject({ status: 'rejected' });
        // Reviewing and writing a note are still possible.
        const note = await deviceOp(guest, share.copySessionId, 'session.note', { note: 'ok' });
        expect(note.status).toBe('applied');
    });

    test('the check of a scope is made when the op is applied, not when it arrived', async () => {
        const { share, guest } = await t.copyOf();
        let open = true;
        // The room is busy: the op waits in its queue, and the copy is closed meanwhile.
        const busy = guest.exclusive(() => Bun.sleep(40));
        const op = createOp({
            projectId: guest.projectId,
            sessionId: share.copySessionId,
            type: 'session.note',
            payload: { note: 'late' },
            clock: { lamport: guest.state.lamport + 1, deviceId: 'guest-phone' },
        });
        const result = guest.submit(op, {
            kind: 'device',
            deviceId: 'guest-phone',
            authorize: () => (open ? null : { code: 'forbidden', message: 'closed' }),
        });
        open = false;
        await busy;
        expect(await result).toMatchObject({ status: 'rejected' });
        expect(guest.state.sessions[share.copySessionId]?.values.note).toBeUndefined();
    });
});

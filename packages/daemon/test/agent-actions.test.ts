import { describe, expect, test } from 'bun:test';
import { createId, createOp, type ItemStatus } from '@palmtopai/protocol';
import { MemoryStorage, ProjectRoom } from '../src';
import {
    ActionError,
    addItem,
    createChecklist,
    defaultSessionTitle,
    deliverFeedback,
    editItem,
    type FeedbackView,
    feedbackView,
    listSessionSummaries,
    openSession,
    refOf,
    resolveRef,
    resolveSession,
    type SessionView,
    shortRef,
    startSession,
} from '../src/agent-actions';

/** Items of a checklist of checks, which carry a text and nothing else. */
const checks = (...texts: string[]) => texts.map((text) => ({ text }));

describe('item and checklist refs', () => {
    const candidates = Array.from({ length: 50 }, () => ({ id: createId() }));

    test('short refs are stable, 6 chars, and distinct for ids created in the same millisecond', () => {
        const refs = candidates.map((candidate) => shortRef(candidate.id));
        expect(refs.every((ref) => /^[0-9a-hjkmnp-tv-z]{6}$/.test(ref))).toBe(true);
        expect(new Set(refs).size).toBe(refs.length);
        expect(shortRef(candidates[0]?.id as string)).toBe(refs[0] as string);
        expect(refOf(candidates[0]?.id as string)).toStartWith(refs[0] as string);
    });

    test('resolves prefixes case-insensitively and full ids', () => {
        const target = candidates[7] as { id: string };
        expect(resolveRef(candidates, shortRef(target.id), 'item')).toBe(target);
        expect(resolveRef(candidates, shortRef(target.id).slice(0, 4).toUpperCase(), 'item')).toBe(
            target,
        );
        expect(resolveRef(candidates, target.id, 'item')).toBe(target);
        expect(resolveRef(candidates, target.id.toLowerCase(), 'item')).toBe(target);
    });

    test('invalid, unknown and ambiguous refs map to 400, 404 and 409', () => {
        const status = (fn: () => unknown) => {
            try {
                fn();
            } catch (error) {
                return error instanceof ActionError ? error.status : 'other';
            }
            return 'none';
        };
        expect(status(() => resolveRef(candidates, 'abc', 'item'))).toBe(400);
        expect(status(() => resolveRef(candidates, 'il1o', 'item'))).toBe(400);
        expect(status(() => resolveRef([], 'abcd', 'item'))).toBe(404);

        // Two candidates sharing a 4-char prefix (32^4 ≈ 1M of them): find them among many ids.
        // A collision shows up after ~1,300 ids on average; with 10,000 the odds of finding none
        // are about 1e-21 (3,000 missed once in ~70 runs).
        const pool = Array.from({ length: 10_000 }, () => ({ id: createId() }));
        const seen = new Map<string, { id: string }>();
        let pair: [{ id: string }, { id: string }] | null = null;
        for (const candidate of pool) {
            const prefix = refOf(candidate.id, 4);
            const other = seen.get(prefix);
            if (other) {
                pair = [other, candidate];
                break;
            }
            seen.set(prefix, candidate);
        }
        if (!pair) throw new Error('no collision found');
        const prefix = refOf(pair[0].id, 4);
        expect(status(() => resolveRef(pair, prefix, 'item'))).toBe(409);
        expect(resolveRef(pair, refOf(pair[1].id, 12), 'item')).toBe(pair[1]);
    });

    test('default session title uses branch and local time', () => {
        expect(defaultSessionTitle('main', new Date(2026, 0, 1, 9, 5))).toBe('main · 09:05');
        expect(defaultSessionTitle(undefined, new Date(2026, 0, 1, 23, 59))).toBe(
            'session · 23:59',
        );
    });
});

async function projectRoom() {
    const storage = new MemoryStorage();
    const projectId = createId();
    await storage.createProject({ id: projectId, name: 'demo', rootPath: '/demo', createdAt: 1 });
    const room = await ProjectRoom.load(storage, projectId);
    if (!room) throw new Error('room not loaded');

    // Like a real client, the fake device observes the room clock before every op.
    const nextLamport = () => room.state.lamport + 1;
    const device = {
        review: (sessionId: string, itemId: string, status: ItemStatus | null, note?: string) =>
            room.submit(
                createOp({
                    projectId,
                    sessionId,
                    type: 'item.update',
                    payload: { itemId, status, ...(note !== undefined && { note }) },
                    clock: { lamport: nextLamport(), deviceId: 'phone' },
                }),
                { kind: 'device', deviceId: 'phone' },
            ),
    };
    const feedback = (sessionId: string): FeedbackView => feedbackView(room.state, sessionId);
    const ack = (sessionId: string, view: FeedbackView) =>
        room.transact((tx) => deliverFeedback(tx, sessionId, view.ack));
    return { room, device, feedback, ack };
}

describe('sessions', () => {
    test('are started explicitly and addressed by ref within the project', async () => {
        const { room } = await projectRoom();
        const first = await room.transact((tx) =>
            startSession(tx, { branch: 'main' }, new Date(2026, 0, 1, 9, 5)),
        );
        const second = await room.transact((tx) => startSession(tx, { title: 'Docs' }));

        expect(first).toMatchObject({
            ref: shortRef(first.id),
            title: 'main · 09:05',
            branch: 'main',
            checklists: [],
        });
        expect(second.title).toBe('Docs');
        expect(resolveSession(room.state, second.ref).id).toBe(second.id);
        expect(
            listSessionSummaries(room.state)
                .map((session) => session.ref)
                .sort(),
        ).toEqual([first.ref, second.ref].sort());
        expect(() => resolveSession(room.state, 'zzzz')).toThrow(
            'no session "zzzz" in this project',
        );

        await room.transact((tx) => openSession(tx, first.ref, 'feature/x'));
        expect(resolveSession(room.state, first.ref).branch).toBe('feature/x');
    });
});

describe('feedback', () => {
    async function reviewedSession() {
        const context = await projectRoom();
        const session: SessionView = await context.room.transact((tx) => startSession(tx, {}));
        const checklist = await context.room.transact((tx) =>
            createChecklist(tx, session.id, { title: 'Auth', items: checks('A', 'B', 'C', 'D') }),
        );
        const [a, b, c, d] = checklist.items.map((item) => item.id) as [
            string,
            string,
            string,
            string,
        ];
        return { ...context, session, checklist, ids: { a, b, c, d } };
    }

    test('reports changed reviews once, then only what changes again', async () => {
        const { session, device, feedback, ack, ids } = await reviewedSession();
        expect(feedback(session.id)).toMatchObject({ hasNew: false });

        await device.review(session.id, ids.a, 'done');
        await device.review(session.id, ids.b, 'cancelled');
        await device.review(session.id, ids.c, 'question', 'per user or global?');

        const first = feedback(session.id);
        expect(first.hasNew).toBe(true);
        expect(first.checklists[0]).toMatchObject({ reviewed: 3, total: 4, unchanged: 0 });
        expect(
            first.checklists[0]?.changed.map((item) => [item.text, item.status, item.note]),
        ).toEqual([
            ['A', 'done', undefined],
            ['B', 'cancelled', undefined],
            ['C', 'question', 'per user or global?'],
        ]);
        expect(first.checklists[0]?.unreviewed.map((item) => item.text)).toEqual(['D']);
        expect(await ack(session.id, first)).toEqual({ items: 3 });

        const second = feedback(session.id);
        expect(second.hasNew).toBe(false);
        expect(second.checklists[0]).toMatchObject({ changed: [], unchanged: 3 });
        expect(second.ack).toEqual({ items: [] });

        await device.review(session.id, ids.c, 'question', 'global, please');
        await device.review(session.id, ids.d, 'done');
        const third = feedback(session.id);
        expect(third.checklists[0]?.changed.map((item) => item.text)).toEqual(['C', 'D']);
        expect(third.checklists[0]).toMatchObject({ unchanged: 2, unreviewed: [] });

        // Acknowledging the same feedback twice delivers nothing new.
        expect(await ack(session.id, first)).toEqual({ items: 0 });
    });

    test('a review changed between read and acknowledgement stays new', async () => {
        const { session, device, feedback, ack, ids } = await reviewedSession();
        await device.review(session.id, ids.a, 'question', 'first');
        const read = feedback(session.id);
        await device.review(session.id, ids.a, 'question', 'second thoughts');
        await ack(session.id, read);
        expect(feedback(session.id).checklists[0]?.changed.map((item) => item.note)).toEqual([
            'second thoughts',
        ]);
    });

    test('editing the text of a reviewed item resets its review and note', async () => {
        const { room, session, device, feedback, ack, ids } = await reviewedSession();
        await device.review(session.id, ids.a, 'cancelled', 'not like this');
        await device.review(session.id, ids.b, 'done');
        await ack(session.id, feedback(session.id));

        const edited = await room.transact((tx) =>
            editItem(tx, session.id, ids.a, { text: 'A, simpler' }),
        );
        expect(edited).toMatchObject({ text: 'A, simpler' });
        expect(edited.status).toBeUndefined();
        expect(edited.note).toBeUndefined();

        // Same text: nothing to review again.
        const same = await room.transact((tx) => editItem(tx, session.id, ids.b, { text: 'B' }));
        expect(same.status).toBe('done');

        const next = feedback(session.id);
        expect(next.checklists[0]?.unreviewed.map((item) => item.text)).toEqual([
            'A, simpler',
            'C',
            'D',
        ]);
        expect(next.checklists[0]?.changed).toEqual([]);
    });

    test('markers of items in another session are ignored', async () => {
        const { room, session, device, feedback, ids } = await reviewedSession();
        const other = await room.transact((tx) => startSession(tx, {}));
        await device.review(session.id, ids.a, 'done');
        const read = feedback(session.id);
        expect(await room.transact((tx) => deliverFeedback(tx, other.id, read.ack))).toEqual({
            items: 0,
        });
        expect(feedback(session.id).hasNew).toBe(true);
    });

    test('large deliveries are split into several ops', async () => {
        const { room, device, feedback, ack } = await projectRoom();
        const session = await room.transact((tx) => startSession(tx, {}));
        for (let n = 0; n < 3; n++) {
            const checklist = await room.transact((tx) =>
                createChecklist(tx, session.id, {
                    title: `c${n}`,
                    items: checks(...Array.from({ length: 200 }, (_, i) => `item ${i}`)),
                }),
            );
            for (const item of checklist.items) await device.review(session.id, item.id, 'done');
        }
        const seq = room.seq;
        expect(await ack(session.id, feedback(session.id))).toEqual({ items: 600 });
        expect(room.seq - seq).toBe(2);
        expect(feedback(session.id)).toMatchObject({ hasNew: false });
    });
});

describe('choices', () => {
    async function withChoice() {
        const context = await projectRoom();
        const session: SessionView = await context.room.transact((tx) => startSession(tx, {}));
        const choice = await context.room.transact((tx) =>
            createChecklist(tx, session.id, {
                title: 'Which cache?',
                kind: 'choice',
                items: [
                    { text: 'Redis', detail: 'Shared, one more service to run' },
                    { text: 'In memory' },
                ],
            }),
        );
        return { ...context, session, choice };
    }

    test('a choice is a list of kind choice, one pick by default, with details', async () => {
        const { choice } = await withChoice();
        expect(choice).toMatchObject({ kind: 'choice', pick: 'one', title: 'Which cache?' });
        expect(choice.items.map((item) => [item.text, item.detail])).toEqual([
            ['Redis', 'Shared, one more service to run'],
            ['In memory', undefined],
        ]);
    });

    test('--multiple stores pick any; a checklist stays a checklist', async () => {
        const { room, session } = await withChoice();
        const many = await room.transact((tx) =>
            createChecklist(tx, session.id, {
                title: 'Which of these?',
                kind: 'choice',
                pick: 'any',
                items: checks('One', 'Two'),
            }),
        );
        expect(many).toMatchObject({ kind: 'choice', pick: 'any' });
        const list = await room.transact((tx) =>
            createChecklist(tx, session.id, { title: 'Checks', items: checks('One') }),
        );
        expect(list).toMatchObject({ kind: 'checks', pick: 'one' });
    });

    test('an item added without a ref goes to the last checklist, never to a choice', async () => {
        const { room, session, choice } = await withChoice();
        // Only a choice in the session: there is no checklist to add a check to.
        await expect(
            room.transact((tx) => addItem(tx, session.id, { text: 'Lost' })),
        ).rejects.toThrow('no checklist in this session');

        const checklist = await room.transact((tx) =>
            createChecklist(tx, session.id, { title: 'Checks', items: checks('One') }),
        );
        const added = await room.transact((tx) => addItem(tx, session.id, { text: 'Two' }));
        expect(added.checklist.ref).toBe(checklist.ref);

        // With the ref of the choice it is an option, detail included.
        const option = await room.transact((tx) =>
            addItem(tx, session.id, {
                text: 'Neither',
                detail: 'Keep it simple',
                checklist: choice.ref,
            }),
        );
        expect(option.checklist.ref).toBe(choice.ref);
        expect(option.item.detail).toBe('Keep it simple');
    });

    test('changing the detail of an answered option clears the answer', async () => {
        const { room, session, choice, device } = await withChoice();
        const option = choice.items[0]?.id as string;
        await device.review(session.id, option, 'done', 'this one');

        const same = await room.transact((tx) =>
            editItem(tx, session.id, option, { detail: 'Shared, one more service to run' }),
        );
        expect(same.status).toBe('done');

        const edited = await room.transact((tx) =>
            editItem(tx, session.id, option, { detail: 'Shared, and we already run it' }),
        );
        expect(edited.detail).toBe('Shared, and we already run it');
        expect(edited.status).toBeUndefined();
        expect(edited.note).toBeUndefined();
    });

    test('an answered question has nothing left to review for the agent', async () => {
        const { session, choice, device, feedback } = await withChoice();
        const [first] = choice.items.map((item) => item.id) as [string, string];
        expect(feedback(session.id).checklists[0]?.unreviewed.map((item) => item.text)).toEqual([
            'Redis',
            'In memory',
        ]);

        await device.review(session.id, first, 'done');
        expect(feedback(session.id).checklists[0]?.unreviewed).toEqual([]);
    });

    test('the feedback of a choice counts the options chosen', async () => {
        const { session, choice, device, feedback } = await withChoice();
        const [first, second] = choice.items.map((item) => item.id) as [string, string];
        expect(feedback(session.id).checklists[0]).toMatchObject({
            kind: 'choice',
            pick: 'one',
            chosen: 0,
        });

        await device.review(session.id, first, 'done', 'but keep the TTL configurable');
        await device.review(session.id, second, 'cancelled');
        const view = feedback(session.id);
        expect(view.checklists[0]).toMatchObject({ chosen: 1, reviewed: 2, total: 2 });
        expect(view.checklists[0]?.changed.map((item) => [item.text, item.status])).toEqual([
            ['Redis', 'done'],
            ['In memory', 'cancelled'],
        ]);
    });
});

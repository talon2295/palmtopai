import { describe, expect, test } from 'bun:test';
import {
    apply,
    applyAll,
    createId,
    createProjectState,
    doneMarker,
    getItem,
    hasUndeliveredAddition,
    hasUndeliveredReview,
    hasUndeliveredSessionNote,
    listChecklists,
    listItems,
    listSessions,
    type Op,
    opSchema,
    projectStateSchema,
    type ReviewMarker,
    reviewMarker,
    sessionNoteMarker,
    summarizeProject,
} from '../src';
import { deepFreeze, mulberry32, op, projectId, sessionId, shuffle } from './helpers';

const laptop = (lamport: number) => ({ lamport, deviceId: 'laptop' });
const phone = (lamport: number) => ({ lamport, deviceId: 'phone' });
const tablet = (lamport: number) => ({ lamport, deviceId: 'tablet' });

function startSession(lamport = 1): Op {
    return op(
        'session.upsert',
        {
            title: 'main · 10:00',
            branch: 'main',
            startedAt: 1000,
        },
        laptop(lamport),
    );
}

describe('apply basics', () => {
    const checklistId = createId();
    const [itemA, itemB] = [createId(), createId()] as [string, string];

    const setup: Op[] = [
        startSession(1),
        op('checklist.create', { checklistId, title: 'Refactor auth' }, laptop(2)),
        op('item.add', { itemId: itemA, checklistId, text: 'Write tests', order: 2 }, laptop(3)),
        op('item.add', { itemId: itemB, checklistId, text: 'Extract module', order: 1 }, laptop(4)),
    ];

    test('builds sessions, checklists and items ordered by `order`', () => {
        const state = applyAll(createProjectState(projectId), setup);

        expect(listSessions(state)).toEqual([
            {
                id: sessionId,
                projectId,
                title: 'main · 10:00',
                branch: 'main',
                startedAt: 1000,
                lastActivityAt: 4000,
            },
        ]);
        expect(listChecklists(state, sessionId)).toEqual([
            {
                id: checklistId,
                sessionId,
                title: 'Refactor auth',
                createdAt: 2000,
                updatedAt: 2000,
                kind: 'checks',
                pick: 'one',
            },
        ]);
        expect(listItems(state, checklistId)).toEqual([
            {
                id: itemB,
                checklistId,
                text: 'Extract module',
                order: 1,
                updatedAt: 4000,
                updatedBy: 'laptop',
                addedByUser: true,
            },
            {
                id: itemA,
                checklistId,
                text: 'Write tests',
                order: 2,
                updatedAt: 3000,
                updatedBy: 'laptop',
                addedByUser: true,
            },
        ]);
        expect(state.lamport).toBe(4);
    });

    test('update sets status and note, null clears the note, updatedBy follows the last writer', () => {
        let state = applyAll(createProjectState(projectId), setup);
        state = apply(
            state,
            op('item.update', { itemId: itemA, status: 'done', note: 'ok?' }, phone(5)),
        );

        let item = listItems(state, checklistId).find((i) => i.id === itemA);
        expect(item).toMatchObject({
            status: 'done',
            note: 'ok?',
            updatedAt: 5000,
            updatedBy: 'phone',
        });

        state = apply(state, op('item.update', { itemId: itemA, note: null }, laptop(6)));
        item = listItems(state, checklistId).find((i) => i.id === itemA);
        expect(item?.note).toBeUndefined();
        expect(item).toMatchObject({ status: 'done', updatedBy: 'laptop' });
    });

    test('item.remove hides the item; checklist.remove hides the checklist and its items', () => {
        let state = applyAll(createProjectState(projectId), setup);
        expect(getItem(state, itemA)?.text).toBe('Write tests');
        state = apply(state, op('item.remove', { itemId: itemA }, phone(5)));
        expect(listItems(state, checklistId).map((i) => i.id)).toEqual([itemB]);
        expect(getItem(state, itemA)).toBeNull();

        state = apply(state, op('checklist.remove', { checklistId }, phone(6)));
        expect(listChecklists(state, sessionId)).toEqual([]);
        expect(listItems(state, checklistId)).toEqual([]);
        expect(getItem(state, itemB)).toBeNull();
        expect(getItem(state, createId())).toBeNull();
    });

    test('is pure: input state and op are never mutated', () => {
        const before = deepFreeze(applyAll(createProjectState(projectId), setup));
        const snapshot = structuredClone(before);
        const update = deepFreeze(op('item.update', { itemId: itemA, status: 'done' }, phone(5)));

        const after = apply(before, update);

        expect(before).toEqual(snapshot);
        expect(after).not.toBe(before);
        expect(after.items[itemA]?.values.status).toBe('done');
    });

    test('is deterministic: same ops give the same state', () => {
        const first = applyAll(createProjectState(projectId), setup);
        const second = applyAll(createProjectState(projectId), setup);
        expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    });

    test('is idempotent: applying an op twice equals applying it once', () => {
        const update = op('item.update', { itemId: itemA, status: 'question' }, phone(5));
        const once = applyAll(createProjectState(projectId), [...setup, update]);
        const twice = applyAll(createProjectState(projectId), [...setup, update, update, ...setup]);
        expect(twice).toEqual(once);
    });

    test('rejects ops of another project', () => {
        const foreign = { ...startSession(), projectId: createId() };
        expect(() => apply(createProjectState(projectId), foreign)).toThrow(/belongs to project/);
    });

    test('produces state that passes the snapshot schema', () => {
        const state = applyAll(createProjectState(projectId), [
            ...setup,
            op('item.update', { itemId: itemA, note: null }, phone(5)),
            op('item.remove', { itemId: itemB }, phone(6)),
        ]);
        expect(projectStateSchema.parse(state)).toEqual(state);
    });
});

describe('project summary', () => {
    const checklistId = createId();
    const [itemA, itemB] = [createId(), createId()] as [string, string];

    test('counts sessions and items left to review, and the last activity', () => {
        const empty = createProjectState(projectId);
        expect(summarizeProject(empty)).toEqual({
            lastActivityAt: 0,
            sessions: 0,
            pending: 0,
            archived: [],
        });

        const state = applyAll(empty, [
            startSession(1),
            op('checklist.create', { checklistId, title: 'Refactor auth' }, laptop(2)),
            op('item.add', { itemId: itemA, checklistId, text: 'One', order: 1 }, laptop(3)),
            op('item.add', { itemId: itemB, checklistId, text: 'Two', order: 2 }, laptop(4)),
        ]);
        expect(summarizeProject(state)).toEqual({
            lastActivityAt: 4000,
            sessions: 1,
            pending: 2,
            archived: [],
        });

        // A reviewed item is not pending any more; a removed checklist hides its items.
        const reviewed = apply(
            state,
            op('item.update', { itemId: itemA, status: 'done' }, phone(5)),
        );
        expect(summarizeProject(reviewed)).toMatchObject({ pending: 1, lastActivityAt: 5000 });
        const cleared = apply(reviewed, op('checklist.remove', { checklistId }, laptop(6)));
        expect(summarizeProject(cleared)).toMatchObject({ sessions: 1, pending: 0 });
        const closed = apply(cleared, op('session.remove', {}, laptop(7)));
        expect(summarizeProject(closed)).toEqual({
            lastActivityAt: 0,
            sessions: 0,
            pending: 0,
            archived: [],
        });
    });

    test('an archived session leaves the counts and is listed apart; archiving is no activity', () => {
        const state = applyAll(createProjectState(projectId), [
            startSession(1),
            op('checklist.create', { checklistId, title: 'Refactor auth' }, laptop(2)),
            op('item.add', { itemId: itemA, checklistId, text: 'One', order: 1 }, laptop(3)),
        ]);
        const archived = apply(state, op('session.archive', { archived: true }, phone(9)));
        expect(listSessions(archived)[0]).toMatchObject({ archived: true, lastActivityAt: 3000 });
        expect(summarizeProject(archived)).toEqual({
            lastActivityAt: 0,
            sessions: 0,
            pending: 0,
            archived: [{ id: sessionId, title: expect.any(String), lastActivityAt: 3000 }],
        });
        // Out of the archive: counted again, as before.
        const back = apply(archived, op('session.archive', { archived: false }, laptop(10)));
        expect(summarizeProject(back)).toMatchObject({ sessions: 1, pending: 1, archived: [] });
        expect(listSessions(back)[0]?.archived).toBeUndefined();
        // Before the session itself: nothing to list, and the same state in either order.
        const first = apply(
            createProjectState(projectId),
            op('session.archive', { archived: true }, phone(9)),
        );
        expect(listSessions(first)).toEqual([]);
        const upsert = startSession(1);
        const archiveOp = op('session.archive', { archived: true }, phone(9));
        expect(applyAll(createProjectState(projectId), [archiveOp, upsert])).toEqual(
            applyAll(createProjectState(projectId), [upsert, archiveOp]),
        );
    });

    test('a session marked done stays where it is, counts as before, and commutes', () => {
        const state = applyAll(createProjectState(projectId), [
            startSession(1),
            op('checklist.create', { checklistId, title: 'Refactor auth' }, laptop(2)),
            op('item.add', { itemId: itemA, checklistId, text: 'One', order: 1 }, laptop(3)),
        ]);
        expect(doneMarker(state, sessionId)).toBeNull();
        const doneOp = op('session.done', { done: true }, phone(9));
        const done = apply(state, doneOp);
        // No activity: the time of the last thing the agent wrote is kept.
        expect(listSessions(done)[0]).toMatchObject({ done: true, lastActivityAt: 3000 });
        expect(summarizeProject(done)).toMatchObject({ sessions: 1, pending: 1 });
        expect(doneMarker(done, sessionId)).toBe(doneOp.opId);
        // The daemon takes it back; a done written later by another device wins again.
        const taken = apply(done, op('session.done', { done: false }, laptop(10)));
        expect(listSessions(taken)[0]?.done).toBeUndefined();
        expect(doneMarker(taken, sessionId)).toBeNull();
        const again = op('session.done', { done: true }, tablet(11));
        expect(doneMarker(apply(taken, again), sessionId)).toBe(again.opId);
        // The same state in any order, a done before its session included.
        const ops = [
            startSession(1),
            op('session.done', { done: true }, phone(5)),
            op('session.done', { done: false }, laptop(6)),
            op('session.done', { done: true }, tablet(7)),
        ];
        const expected = applyAll(createProjectState(projectId), ops);
        const rng = mulberry32(7);
        for (let i = 0; i < 20; i++) {
            expect(applyAll(createProjectState(projectId), shuffle(ops, rng))).toEqual(expected);
        }
        expect(doneMarker(expected, sessionId)).toBe(ops[3]?.opId as string);
        // A removed session keeps no done.
        const removed = apply(done, op('session.remove', {}, laptop(12)));
        expect(doneMarker(removed, sessionId)).toBeNull();
    });

    test('an answered question stops counting: its other options are not work left', () => {
        const choiceId = createId();
        const [first, second, third] = [createId(), createId(), createId()] as [
            string,
            string,
            string,
        ];
        const state = applyAll(createProjectState(projectId), [
            startSession(1),
            op(
                'checklist.create',
                { checklistId: choiceId, title: 'Which?', kind: 'choice' },
                laptop(2),
            ),
            op(
                'item.add',
                { itemId: first, checklistId: choiceId, text: 'A', order: 0 },
                laptop(3),
            ),
            op(
                'item.add',
                { itemId: second, checklistId: choiceId, text: 'B', order: 1 },
                laptop(4),
            ),
            op(
                'item.add',
                { itemId: third, checklistId: choiceId, text: 'C', order: 2 },
                laptop(5),
            ),
        ]);
        // A question is one thing to answer, whatever the number of options.
        expect(summarizeProject(state)).toMatchObject({ pending: 1 });

        const answered = apply(
            state,
            op('item.update', { itemId: second, status: 'done' }, phone(6)),
        );
        expect(summarizeProject(answered)).toMatchObject({ pending: 0 });

        // Any mark counts as an answer, also a refusal.
        const refused = apply(
            state,
            op('item.update', { itemId: first, status: 'cancelled' }, phone(6)),
        );
        expect(summarizeProject(refused)).toMatchObject({ pending: 0 });

        // A checklist of checks goes on counting one by one.
        const checklistId = createId();
        const mixed = applyAll(answered, [
            op('checklist.create', { checklistId, title: 'Checks' }, laptop(7)),
            op('item.add', { itemId: createId(), checklistId, text: 'One', order: 0 }, laptop(8)),
        ]);
        expect(summarizeProject(mixed)).toMatchObject({ pending: 1 });
    });
});

describe('last-write-wins per field', () => {
    const checklistId = createId();
    const itemId = createId();
    const base: Op[] = [
        startSession(1),
        op('checklist.create', { checklistId, title: 'Review' }, laptop(2)),
        op('item.add', { itemId, checklistId, text: 'Original', order: 0 }, laptop(3)),
    ];

    function resultInBothOrders(a: Op, b: Op) {
        const ab = applyAll(createProjectState(projectId), [...base, a, b]);
        const ba = applyAll(createProjectState(projectId), [...base, b, a]);
        expect(ab).toEqual(ba);
        return ab;
    }

    test('higher lamport wins regardless of arrival order', () => {
        const state = resultInBothOrders(
            op('item.update', { itemId, text: 'from phone' }, phone(5)),
            op('item.update', { itemId, text: 'from laptop' }, laptop(4)),
        );
        expect(state.items[itemId]?.values.text).toBe('from phone');
    });

    test('equal lamport: device id breaks the tie deterministically', () => {
        const state = resultInBothOrders(
            op('item.update', { itemId, status: 'done', note: 'laptop note' }, laptop(4)),
            op('item.update', { itemId, status: 'cancelled', note: 'phone note' }, phone(4)),
        );
        expect(state.items[itemId]?.values).toMatchObject({
            status: 'cancelled',
            note: 'phone note',
        });
    });

    test('concurrent writes on different fields are both kept', () => {
        const state = resultInBothOrders(
            op('item.update', { itemId, status: 'question', note: 'why?' }, phone(4)),
            op('item.update', { itemId, text: 'Renamed', order: 7 }, laptop(9)),
        );
        expect(listItems(state, checklistId)).toEqual([
            expect.objectContaining({
                text: 'Renamed',
                status: 'question',
                note: 'why?',
                order: 7,
                updatedBy: 'laptop',
            }),
        ]);
    });

    test('an older write does not override a newer one on the same field', () => {
        const state = resultInBothOrders(
            op('item.update', { itemId, status: 'done', note: 'new' }, phone(8)),
            op('item.update', { itemId, status: 'cancelled' }, tablet(6)),
        );
        expect(state.items[itemId]?.values).toMatchObject({ status: 'done', note: 'new' });
    });

    test('remove wins over concurrent or later updates', () => {
        const state = resultInBothOrders(
            op('item.remove', { itemId }, laptop(4)),
            op('item.update', { itemId, status: 'done' }, phone(10)),
        );
        expect(listItems(state, checklistId)).toEqual([]);
        expect(state.items[itemId]?.removed).not.toBeNull();
    });

    test('an update that arrives before its add is merged once the add arrives', () => {
        const otherItem = createId();
        const add = op(
            'item.add',
            { itemId: otherItem, checklistId, text: 'Late', order: 1 },
            laptop(4),
        );
        const update = op('item.update', { itemId: otherItem, status: 'done' }, phone(5));

        const early = applyAll(createProjectState(projectId), [...base, update]);
        expect(listItems(early, checklistId).map((i) => i.id)).toEqual([itemId]);

        const state = resultInBothOrders(add, update);
        expect(listItems(state, checklistId).find((i) => i.id === otherItem)).toMatchObject({
            text: 'Late',
            status: 'done',
        });
    });

    test('session lastActivityAt is the latest op timestamp in any order', () => {
        const state = resultInBothOrders(
            op('item.update', { itemId, status: 'done' }, phone(4), { ts: 90_000 }),
            op('item.update', { itemId, text: 'x' }, laptop(5), { ts: 50_000 }),
        );
        expect(listSessions(state)[0]?.lastActivityAt).toBe(90_000);
    });
});

describe('item status and notes', () => {
    const checklistId = createId();
    const itemId = createId();
    const base: Op[] = [
        startSession(1),
        op('checklist.create', { checklistId, title: 'Review' }, laptop(2)),
        op('item.add', { itemId, checklistId, text: 'Original', order: 0 }, laptop(3)),
    ];

    function itemAfter(...ops: Op[]) {
        const forward = applyAll(createProjectState(projectId), [...base, ...ops]);
        const backward = applyAll(createProjectState(projectId), [...base, ...ops].reverse());
        expect(backward).toEqual(forward);
        return { state: forward, item: listItems(forward, checklistId)[0] };
    }

    test('a new item is not reviewed and has no note', () => {
        const { item } = itemAfter();
        expect(item).not.toHaveProperty('status');
        expect(item).not.toHaveProperty('note');
    });

    test.each(['done', 'cancelled', 'question'] as const)(
        '%s works with and without a note',
        (status) => {
            expect(itemAfter(op('item.update', { itemId, status }, phone(4))).item).toMatchObject({
                status,
            });
            expect(
                itemAfter(op('item.update', { itemId, status }, phone(4))).item,
            ).not.toHaveProperty('note');
            expect(
                itemAfter(op('item.update', { itemId, status, note: 'because' }, phone(4))).item,
            ).toMatchObject({ status, note: 'because' });
        },
    );

    test('changing status keeps the note; the note can be edited on its own', () => {
        const { item } = itemAfter(
            op('item.update', { itemId, status: 'question', note: 'why?' }, phone(4)),
            op('item.update', { itemId, status: 'done' }, laptop(5)),
            op('item.update', { itemId, note: 'why? answered' }, phone(6)),
        );
        expect(item).toMatchObject({ status: 'done', note: 'why? answered' });
    });

    test('item.add can carry status and note', () => {
        const other = createId();
        const state = applyAll(createProjectState(projectId), [
            ...base,
            op(
                'item.add',
                { itemId: other, checklistId, text: 'Pre', order: 1, status: 'done', note: 'n' },
                laptop(4),
            ),
        ]);
        expect(listItems(state, checklistId)[1]).toMatchObject({ status: 'done', note: 'n' });
    });

    test('resetting the status clears the note, and a later status does not bring it back', () => {
        const { state, item } = itemAfter(
            op('item.update', { itemId, status: 'cancelled', note: 'not needed' }, phone(4)),
            op('item.update', { itemId, status: null }, phone(5)),
        );
        expect(item).not.toHaveProperty('status');
        expect(item).not.toHaveProperty('note');
        expect(state.items[itemId]?.values).toMatchObject({ status: null, note: null });

        const again = apply(state, op('item.update', { itemId, status: 'done' }, phone(6)));
        expect(listItems(again, checklistId)[0]).toEqual(
            expect.not.objectContaining({ note: expect.anything() }),
        );
    });

    test('a note never shows on an unreviewed item, even after a concurrent reset', () => {
        const { state, item } = itemAfter(
            op('item.update', { itemId, status: null }, laptop(4)),
            op('item.update', { itemId, note: 'typed meanwhile' }, phone(5)),
        );
        expect(state.items[itemId]?.values.note).toBe('typed meanwhile');
        expect(item).not.toHaveProperty('status');
        expect(item).not.toHaveProperty('note');
    });

    test('an empty note counts as no note', () => {
        const { item } = itemAfter(
            op('item.update', { itemId, status: 'question', note: '' }, phone(4)),
        );
        expect(item).toMatchObject({ status: 'question' });
        expect(item).not.toHaveProperty('note');
    });
});

describe('convergence under arbitrary delivery order', () => {
    test('scripted concurrent scenario converges for 300 shuffled orders (with duplicates)', () => {
        const c1 = createId();
        const c2 = createId();
        const [i1, i2, i3, i4] = [createId(), createId(), createId(), createId()] as [
            string,
            string,
            string,
            string,
        ];
        const ops: Op[] = [
            startSession(1),
            op('checklist.create', { checklistId: c1, title: 'Phase 1' }, laptop(2)),
            op('item.add', { itemId: i1, checklistId: c1, text: 'one', order: 1 }, laptop(3)),
            op('item.add', { itemId: i2, checklistId: c1, text: 'two', order: 2 }, laptop(4)),
            op('item.add', { itemId: i3, checklistId: c1, text: 'three', order: 3 }, laptop(5)),
            op('item.update', { itemId: i1, status: 'done', note: 'looks good' }, phone(6)),
            op('item.update', { itemId: i1, text: 'one (renamed)' }, laptop(6)),
            op('item.update', { itemId: i2, status: 'question', note: 'phone says' }, phone(7)),
            op('item.update', { itemId: i2, note: 'laptop says' }, laptop(7)),
            op('item.update', { itemId: i3, status: 'cancelled' }, phone(8)),
            op('item.remove', { itemId: i3 }, laptop(8)),
            op('checklist.update', { checklistId: c1, title: 'Phase 1 (final)' }, laptop(9)),
            op('item.update', { itemId: i1, note: null }, tablet(9)),
            op('item.update', { itemId: i2, order: 0 }, tablet(10)),
            op('checklist.create', { checklistId: c2, title: 'Scratch' }, laptop(10)),
            op('item.add', { itemId: i4, checklistId: c2, text: 'tmp', order: 1 }, laptop(11)),
            op('checklist.remove', { checklistId: c2 }, phone(12)),
            op('session.upsert', { title: 'main (renamed)' }, laptop(13)),
            op('session.note', { note: 'from the phone' }, phone(14)),
            op('session.note', { note: 'from the tablet' }, tablet(14)),
            op('session.message', { message: 'first' }, laptop(14)),
            op('session.message', { message: 'second' }, laptop(15)),
        ];
        const withDuplicates = [...ops, ops[2] as Op, ops[5] as Op, ops[10] as Op];

        const reference = applyAll(createProjectState(projectId), ops);
        const random = mulberry32(42);
        for (let run = 0; run < 300; run++) {
            const state = applyAll(createProjectState(projectId), shuffle(withDuplicates, random));
            expect(state).toEqual(reference);
        }

        expect(listSessions(reference)[0]?.title).toBe('main (renamed)');
        expect(listSessions(reference)[0]).toMatchObject({
            note: 'from the tablet',
            message: { text: 'second' },
        });
        expect(listChecklists(reference, sessionId).map((c) => c.title)).toEqual([
            'Phase 1 (final)',
        ]);
        expect(
            listItems(reference, c1).map((i) => [i.text, i.status ?? null, i.note ?? null]),
        ).toEqual([
            ['two', 'question', 'phone says'],
            ['one (renamed)', 'done', null],
        ]);
        expect(listItems(reference, c2)).toEqual([]);
    });

    test('random ops from three devices converge for every seed', () => {
        const devices = ['laptop', 'phone', 'tablet'];
        // Checklists and items never move between sessions: each session has its own ids.
        const sessions = [sessionId, createId()].map((id) => ({
            id,
            checklistIds: [createId(), createId()],
            itemIds: Array.from({ length: 4 }, () => createId()),
        }));
        const statuses = ['done', 'cancelled', 'question', null] as const;

        for (let seed = 1; seed <= 50; seed++) {
            const random = mulberry32(seed);
            const pick = <T>(values: readonly T[]): T =>
                values[Math.floor(random() * values.length)] as T;
            const lamports = new Map(devices.map((d) => [d, 0]));
            const ops: Op[] = [];

            for (let n = 0; n < 40; n++) {
                const deviceId = pick(devices);
                const lamport = (lamports.get(deviceId) ?? 0) + 1 + Math.floor(random() * 3);
                lamports.set(deviceId, lamport);
                const clock = { lamport, deviceId };
                const ts = Math.floor(random() * 1_000_000);
                const session = pick(sessions);
                const itemId = pick(session.itemIds);
                const checklistId = pick(session.checklistIds);
                const at = { ts, sessionId: session.id };
                const roll = random();

                if (roll < 0.1) {
                    ops.push(op('checklist.create', { checklistId, title: `c${n}` }, clock, at));
                } else if (roll < 0.15) {
                    ops.push(op('checklist.remove', { checklistId }, clock, at));
                } else if (roll < 0.35) {
                    ops.push(
                        op('item.add', { itemId, checklistId, text: `t${n}`, order: n }, clock, at),
                    );
                } else if (roll < 0.9) {
                    const status = random() < 0.5 ? pick(statuses) : undefined;
                    ops.push(
                        op(
                            'item.update',
                            {
                                itemId,
                                ...(random() < 0.5 && { text: `u${n}` }),
                                ...(status !== undefined && { status }),
                                note: status === null || random() < 0.3 ? null : `n${n}`,
                            },
                            clock,
                            at,
                        ),
                    );
                } else if (roll < 0.93) {
                    ops.push(op('item.remove', { itemId }, clock, at));
                } else if (roll < 0.95) {
                    ops.push(op('session.upsert', { title: `s${n}` }, clock, at));
                } else if (roll < 0.97) {
                    ops.push(op('session.remove', {}, clock, at));
                } else {
                    const markers = { status: pick(ops)?.opId ?? itemId, note: itemId };
                    ops.push(
                        op('feedback.deliver', { items: [{ itemId, ...markers }] }, clock, at),
                    );
                }
            }

            for (const generated of ops) expect(opSchema.safeParse(generated).success).toBe(true);

            const reference = applyAll(createProjectState(projectId), ops);
            for (let run = 0; run < 20; run++) {
                const state = applyAll(createProjectState(projectId), shuffle(ops, random));
                expect(state).toEqual(reference);
            }
        }
    });
});

describe('session removal', () => {
    const checklistId = createId();
    const [itemA, itemB] = [createId(), createId()] as [string, string];
    const other = createId();
    const otherChecklist = createId();

    const ops: Op[] = [
        startSession(1),
        op('checklist.create', { checklistId, title: 'Secret plan' }, laptop(2)),
        op('item.add', { itemId: itemA, checklistId, text: 'Rotate API key', order: 1 }, laptop(3)),
        op('item.update', { itemId: itemA, status: 'question', note: 'which key?' }, phone(4)),
        op('session.upsert', { title: 'other', startedAt: 1 }, laptop(4), { sessionId: other }),
        op('checklist.create', { checklistId: otherChecklist, title: 'Kept' }, laptop(5), {
            sessionId: other,
        }),
        op('session.remove', {}, phone(6)),
        // Written by devices and the agent that had not seen the removal yet.
        op('item.add', { itemId: itemB, checklistId, text: 'Late item', order: 2 }, laptop(6)),
        op('item.update', { itemId: itemA, note: 'late note' }, tablet(7)),
        op('checklist.update', { checklistId, title: 'Late title' }, laptop(8)),
        op('session.upsert', { title: 'late title' }, laptop(9)),
    ];

    test('removes the session with its checklists and items, leaving no text behind', () => {
        const state = applyAll(createProjectState(projectId), ops);
        expect(listSessions(state).map((session) => session.id)).toEqual([other]);
        expect(listChecklists(state, sessionId)).toEqual([]);
        expect(getItem(state, itemA)).toBeNull();
        expect(listChecklists(state, other).map((checklist) => checklist.title)).toEqual(['Kept']);
        const stored = JSON.stringify(state);
        for (const text of ['Secret plan', 'Rotate API key', 'which key?', 'Late', 'late']) {
            expect(stored).not.toContain(text);
        }
        expect(projectStateSchema.safeParse(state).success).toBe(true);
    });

    test('converges whatever the order of the removal and of later ops', () => {
        const reference = applyAll(createProjectState(projectId), ops);
        const random = mulberry32(7);
        for (let run = 0; run < 300; run++) {
            const shuffled = shuffle([...ops, ops[6] as Op, ops[2] as Op], random);
            expect(applyAll(createProjectState(projectId), shuffled)).toEqual(reference);
        }
    });
});

describe('choices', () => {
    const choiceId = createId();
    const [optionA, optionB] = [createId(), createId()] as [string, string];

    const setup: Op[] = [
        startSession(1),
        op(
            'checklist.create',
            { checklistId: choiceId, title: 'Which cache?', kind: 'choice', pick: 'any' },
            laptop(2),
        ),
        op(
            'item.add',
            {
                itemId: optionA,
                checklistId: choiceId,
                text: 'Redis',
                detail: 'One more service',
                order: 0,
            },
            laptop(3),
        ),
        op(
            'item.add',
            { itemId: optionB, checklistId: choiceId, text: 'In memory', order: 1 },
            laptop(4),
        ),
    ];

    test('a choice keeps its kind and pick, and its options their detail', () => {
        const state = applyAll(createProjectState(projectId), setup);
        expect(listChecklists(state, sessionId)).toMatchObject([
            { id: choiceId, title: 'Which cache?', kind: 'choice', pick: 'any' },
        ]);
        expect(listItems(state, choiceId)).toMatchObject([
            { id: optionA, text: 'Redis', detail: 'One more service' },
            { id: optionB, text: 'In memory' },
        ]);
        // An option without detail has no empty string hanging around.
        expect(listItems(state, choiceId)[1]).not.toHaveProperty('detail');
    });

    test('renaming a choice does not turn it into a checklist', () => {
        const renamed = applyAll(createProjectState(projectId), [
            ...setup,
            op(
                'checklist.update',
                { checklistId: choiceId, title: 'Which cache, really?' },
                laptop(5),
            ),
        ]);
        expect(listChecklists(renamed, sessionId)).toMatchObject([
            { title: 'Which cache, really?', kind: 'choice', pick: 'any' },
        ]);
    });

    test('a list written before choices existed is a checklist of checks', () => {
        const state = applyAll(createProjectState(projectId), [
            startSession(1),
            op('checklist.create', { checklistId: choiceId, title: 'Auth' }, laptop(2)),
        ]);
        expect(listChecklists(state, sessionId)).toMatchObject([{ kind: 'checks', pick: 'one' }]);
        // Nothing was written for them, so an older state still parses.
        const record = state.checklists[choiceId] as (typeof state.checklists)[string];
        expect(record.values).not.toHaveProperty('kind');
        expect(projectStateSchema.parse(state)).toEqual(state);
    });

    test('the detail of an option is last-write-wins like the rest', () => {
        const state = applyAll(createProjectState(projectId), [
            ...setup,
            op('item.update', { itemId: optionA, detail: 'from the phone' }, phone(6)),
            op('item.update', { itemId: optionA, detail: 'from the laptop' }, laptop(5)),
        ]);
        expect(getItem(state, optionA)?.detail).toBe('from the phone');
        const cleared = apply(state, op('item.update', { itemId: optionA, detail: '' }, laptop(7)));
        expect(getItem(cleared, optionA)).not.toHaveProperty('detail');
    });
});

describe('older data', () => {
    test('session status of older versions is dropped when a state is loaded', () => {
        const state = applyAll(createProjectState(projectId), [startSession(1)]);
        const record = state.sessions[sessionId] as (typeof state.sessions)[string];
        const legacy = {
            ...state,
            sessions: {
                [sessionId]: {
                    ...record,
                    values: { ...record.values, status: 'ended' },
                    clocks: { ...record.clocks, status: record.clocks.title },
                },
            },
        };
        const parsed = projectStateSchema.parse(legacy);
        expect(parsed).toEqual(state);
        expect(
            opSchema.safeParse(op('session.upsert', { status: 'ended' } as never, laptop(2)))
                .success,
        ).toBe(true);
    });
});

describe('feedback delivery', () => {
    const checklistId = createId();
    const itemId = createId();
    const daemon = (lamport: number) => ({ lamport, deviceId: 'palmtop-daemon' });

    // The agent writes through the daemon, whose device id is reserved.
    const base: Op[] = [
        op('session.upsert', { title: 'Session', startedAt: 1 }, daemon(1)),
        op('checklist.create', { checklistId, title: 'Review me' }, daemon(2)),
        op('item.add', { itemId, checklistId, text: 'Step', order: 0 }, daemon(3)),
    ];

    test('an item review is new until delivered, and new again after status or note change', () => {
        const review = op('item.update', { itemId, status: 'question', note: 'why?' }, phone(4));
        let state = applyAll(createProjectState(projectId), [...base, review]);
        expect(hasUndeliveredReview(state, itemId)).toBe(true);
        const marker = reviewMarker(state, itemId);
        expect(marker).toEqual({ status: review.opId, note: review.opId });
        const before = getItem(state, itemId);

        state = apply(
            state,
            op(
                'feedback.deliver',
                { items: [{ itemId, ...(marker as ReviewMarker) }] },
                daemon(5),
                { ts: 99_000 },
            ),
        );
        expect(hasUndeliveredReview(state, itemId)).toBe(false);
        // Bookkeeping only: the item and its session keep their updatedAt / updatedBy.
        expect(getItem(state, itemId)).toEqual(before);

        expect(
            hasUndeliveredReview(
                apply(state, op('item.update', { itemId, text: 'Step (renamed)' }, laptop(6))),
                itemId,
            ),
        ).toBe(false);
        expect(
            hasUndeliveredReview(
                apply(state, op('item.update', { itemId, note: 'why not?' }, phone(6))),
                itemId,
            ),
        ).toBe(true);
        expect(
            hasUndeliveredReview(
                apply(state, op('item.update', { itemId, status: 'done' }, phone(6))),
                itemId,
            ),
        ).toBe(true);
    });

    test('a stale delivery does not hide a newer review', () => {
        const first = op('item.update', { itemId, status: 'done' }, phone(4));
        const second = op('item.update', { itemId, status: 'cancelled' }, phone(5));
        const state = applyAll(createProjectState(projectId), [
            ...base,
            first,
            second,
            op(
                'feedback.deliver',
                { items: [{ itemId, status: first.opId, note: first.opId }] },
                daemon(6),
            ),
        ]);
        expect(hasUndeliveredReview(state, itemId)).toBe(true);
    });

    test('deliveries for removed or unknown items change nothing visible', () => {
        const unknown = createId();
        const state = applyAll(createProjectState(projectId), [
            ...base,
            op('item.remove', { itemId }, laptop(4)),
            op(
                'feedback.deliver',
                {
                    items: [
                        { itemId, status: createId(), note: createId() },
                        { itemId: unknown, status: createId(), note: createId() },
                    ],
                },
                daemon(5),
            ),
        ]);
        expect(getItem(state, itemId)).toBeNull();
        expect(getItem(state, unknown)).toBeNull();
        expect(hasUndeliveredReview(state, unknown)).toBe(false);
        expect(projectStateSchema.safeParse(state).success).toBe(true);
    });

    test('an item added by the user is new until its text is delivered, also after a review', () => {
        const added = createId();
        const add = op(
            'item.add',
            { itemId: added, checklistId, text: 'Also this', order: 1 },
            phone(4),
        );
        let state = applyAll(createProjectState(projectId), [...base, add]);
        expect(getItem(state, added)?.addedByUser).toBe(true);
        expect(getItem(state, itemId)?.addedByUser).toBe(false);
        expect(hasUndeliveredAddition(state, added)).toBe(true);
        expect(hasUndeliveredAddition(state, itemId)).toBe(false);
        const marker = reviewMarker(state, added) as ReviewMarker;
        expect(marker).toEqual({ status: add.opId, note: add.opId, text: add.opId });

        state = apply(
            state,
            op('feedback.deliver', { items: [{ itemId: added, ...marker }] }, daemon(5)),
        );
        expect(hasUndeliveredAddition(state, added)).toBe(false);

        // A review delivered later keeps the text marker: the addition is not reported again.
        state = apply(state, op('item.update', { itemId: added, status: 'done' }, phone(6)));
        const reviewed = reviewMarker(state, added) as ReviewMarker;
        state = apply(
            state,
            op('feedback.deliver', { items: [{ itemId: added, ...reviewed }] }, daemon(7)),
        );
        expect(hasUndeliveredAddition(state, added)).toBe(false);
        expect(hasUndeliveredReview(state, added)).toBe(false);

        // The user rewrites it: new again. The agent rewrites it: not news for the agent.
        const edited = apply(
            state,
            op('item.update', { itemId: added, text: 'Also that' }, phone(8)),
        );
        expect(hasUndeliveredAddition(edited, added)).toBe(true);
        const byAgent = apply(
            state,
            op('item.update', { itemId: added, text: 'Also those' }, daemon(8)),
        );
        expect(hasUndeliveredAddition(byAgent, added)).toBe(false);
    });

    test('the session note is new until delivered; the agent message has its time', () => {
        const note = op('session.note', { note: 'Use the staging DB' }, phone(4), { ts: 5_000 });
        let state = applyAll(createProjectState(projectId), [
            ...base,
            note,
            op('session.message', { message: 'Plan ready' }, daemon(5), { ts: 6_000 }),
        ]);
        expect(listSessions(state)[0]).toMatchObject({
            note: 'Use the staging DB',
            message: { text: 'Plan ready', at: 6_000 },
        });
        expect(sessionNoteMarker(state, sessionId)).toBe(note.opId);
        expect(hasUndeliveredSessionNote(state, sessionId)).toBe(true);

        state = apply(
            state,
            op('feedback.deliver', { items: [], sessionNote: note.opId }, daemon(6)),
        );
        expect(hasUndeliveredSessionNote(state, sessionId)).toBe(false);

        const changed = apply(state, op('session.note', { note: 'Use prod' }, phone(7)));
        expect(hasUndeliveredSessionNote(changed, sessionId)).toBe(true);
        const cleared = applyAll(state, [
            op('session.note', { note: '' }, phone(7)),
            op('session.message', { message: '' }, daemon(8)),
        ]);
        expect(hasUndeliveredSessionNote(cleared, sessionId)).toBe(false);
        expect(listSessions(cleared)[0]?.note).toBeUndefined();
        expect(listSessions(cleared)[0]?.message).toBeUndefined();
        expect(projectStateSchema.safeParse(cleared).success).toBe(true);
    });

    test('a delivery needs items or a session note', () => {
        expect(opSchema.safeParse(op('feedback.deliver', { items: [] }, daemon(4))).success).toBe(
            false,
        );
        expect(
            opSchema.safeParse(
                op('feedback.deliver', { items: [], sessionNote: createId() }, daemon(4)),
            ).success,
        ).toBe(true);
    });
});

describe('copies shared with guests', () => {
    const listId = createId();
    const itemId = createId();
    const originList = createId();
    const originItem = createId();

    function copy(): Op[] {
        return [
            startSession(),
            op(
                'checklist.create',
                { checklistId: listId, title: 'Login', origin: originList },
                laptop(2),
            ),
            op(
                'item.add',
                {
                    itemId,
                    checklistId: listId,
                    text: 'Wrong password',
                    order: 0,
                    origin: originItem,
                },
                laptop(3),
            ),
        ];
    }

    test('a checklist and an item keep the id of the one they were copied from', () => {
        const state = applyAll(createProjectState(projectId), copy());
        expect(listChecklists(state, sessionId)[0]?.origin).toBe(originList);
        expect(listItems(state, listId)[0]?.origin).toBe(originItem);
    });

    test('without an origin nothing is added to what the selectors return', () => {
        const state = applyAll(createProjectState(projectId), [
            startSession(),
            op('checklist.create', { checklistId: listId, title: 'Login' }, laptop(2)),
            op(
                'item.add',
                { itemId, checklistId: listId, text: 'Wrong password', order: 0 },
                laptop(3),
            ),
        ]);
        expect(listChecklists(state, sessionId)[0]).not.toHaveProperty('origin');
        expect(listItems(state, listId)[0]).not.toHaveProperty('origin');
    });

    test('later updates and reviews leave the origin where it is', () => {
        const state = applyAll(createProjectState(projectId), [
            ...copy(),
            op('checklist.update', { checklistId: listId, title: 'Login v2' }, laptop(4)),
            op('item.update', { itemId, text: 'Wrong password, again' }, laptop(5)),
            op('item.update', { itemId, status: 'done', note: 'ok' }, phone(6)),
        ]);
        expect(listChecklists(state, sessionId)[0]).toMatchObject({
            title: 'Login v2',
            origin: originList,
        });
        expect(listItems(state, listId)[0]).toMatchObject({
            text: 'Wrong password, again',
            status: 'done',
            origin: originItem,
        });
    });

    test('the order of the ops does not matter', () => {
        const ops = copy();
        const forward = applyAll(createProjectState(projectId), ops);
        const backward = applyAll(createProjectState(projectId), [...ops].reverse());
        expect(backward).toEqual(forward);
    });

    test('an origin has to be an id', () => {
        const bad = op(
            'item.add',
            { itemId, checklistId: listId, text: 'x', order: 0, origin: 'nope' },
            laptop(3),
        );
        expect(opSchema.safeParse(bad).success).toBe(false);
    });
});

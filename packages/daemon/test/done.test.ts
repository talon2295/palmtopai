import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createId, createOp, type OpOf, type OpType } from '@palmtopai/protocol';
import { type Daemon, KEY_HEADER } from '../src';
import { DoneDeliveries, DoneWaiters } from '../src/done-delivery';
import { createTempHome, startTestDaemon, waitUntil } from './helpers';

/** How long the daemon holds a request of `palmtop wait` in these tests. */
const HOLD_MS = 250;

/** The user marks a session done on a device; the agent finds out with `wait` and `feedback`. */
describe('a session marked done, through the Local API', () => {
    let daemon: Daemon;
    let home: string;
    let key: string;
    let cleanup: () => Promise<void>;
    let projectId: string;
    let checklistRef: string;
    let session: { ref: string; id: string };

    // biome-ignore lint/suspicious/noExplicitAny: the JSON of the Local API, read freely by the tests
    type Json = Record<string, any>;

    const call = async (method: string, path: string, payload?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${daemon.localPort}${path}`, {
            method,
            headers: { [KEY_HEADER]: key, 'content-type': 'application/json' },
            ...(payload !== undefined && { body: JSON.stringify(payload) }),
        });
        const body = (await response.json()) as Json;
        return { status: response.status, body };
    };

    const base = () => `/projects/${projectId}/sessions/${session.ref}`;
    const wait = () => call('GET', `${base()}/wait`);

    const startSession = async (title: string) => {
        const started = await call('POST', `/projects/${projectId}/sessions`, { title });
        session = { ref: started.body.ref, id: started.body.id };
        const list = await call('POST', `${base()}/checklists`, {
            title: 'Login',
            items: ['Right password', 'Wrong password'],
        });
        checklistRef = list.body.ref;
    };

    /** What a device writes (through the same checks as the relay): returns the rejection, if any. */
    const device = async (
        payload: { done: boolean },
        deviceId = 'phone',
        sessionId = session.id,
    ) => {
        const room = await daemon.rooms.get(projectId);
        if (!room) throw new Error('no room');
        const op = createOp({
            projectId,
            sessionId,
            type: 'session.done' satisfies OpType,
            payload: payload satisfies OpOf<'session.done'>['payload'],
            clock: { lamport: room.state.lamport + 1, deviceId },
        });
        const result = await room.submit(op, { kind: 'device', deviceId });
        return result.status === 'rejected' ? result.rejection.message : null;
    };

    const doneHere = () =>
        daemon.rooms.get(projectId).then((room) => room?.state.sessions[session.id]?.values.done);

    const waitUntilDone = async (expected: boolean) => {
        const deadline = Date.now() + 3_000;
        while ((await doneHere()) !== expected) {
            if (Date.now() > deadline) throw new Error(`done never became ${expected}`);
            await Bun.sleep(10);
        }
    };

    /** What `palmtop feedback` does: read, then tell the daemon the agent got it. */
    const read = async () => {
        const feedback = await call('GET', `${base()}/feedback`);
        await call('POST', `${base()}/feedback/ack`, feedback.body.ack);
        return feedback.body;
    };

    beforeAll(async () => {
        ({ home, cleanup } = await createTempHome());
        daemon = await startTestDaemon(home, { waitHoldMs: HOLD_MS });
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        const resolved = await call('POST', '/projects/resolve', { rootPath: '/tmp/done-demo' });
        projectId = resolved.body.projectId;
    });

    afterAll(async () => {
        await daemon.stop();
        await cleanup();
    });

    test('a wait with nothing to wait for holds, then asks to be repeated', async () => {
        await startSession('Holds');
        const started = Date.now();
        const answer = await wait();
        expect(answer).toEqual({ status: 200, body: { status: 'pending' } });
        expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 20);
    });

    test('a done during the wait ends it at once, with nothing the user wrote', async () => {
        await startSession('Wakes');
        const room = await daemon.rooms.get(projectId);
        await room?.submitLocal('session.note', session.id, { note: 'Ignore the footer' });
        const waiting = wait();
        await Bun.sleep(60);
        expect(await device({ done: true })).toBeNull();
        const answer = await waiting;
        expect(answer.status).toBe(200);
        expect(answer.body).toEqual({
            status: 'done',
            session: { ref: session.ref, title: 'Wakes' },
        });
        expect(JSON.stringify(answer.body)).not.toContain('footer');
    });

    test('until feedback delivers it, the done is still there: a new wait ends at once; read, it is spent', async () => {
        const again = await wait();
        expect(again.body.status).toBe('done');
        // The agent reads the feedback, which says so and carries what to acknowledge.
        const feedback = await call('GET', `${base()}/feedback`);
        expect(feedback.body).toMatchObject({ done: true, hasNew: true });
        expect(feedback.body.ack.done).toEqual(expect.any(String));
        await call('POST', `${base()}/feedback/ack`, feedback.body.ack);

        // Read: the done is gone, on every device, and waiting again sleeps.
        expect(await doneHere()).toBe(false);
        const started = Date.now();
        expect((await wait()).body.status).toBe('pending');
        expect(Date.now() - started).toBeGreaterThanOrEqual(HOLD_MS - 20);
        const after = await call('GET', `${base()}/feedback`);
        expect(after.body.done).toBeUndefined();
        expect(after.body.ack.done).toBeUndefined();
        expect(after.body.session.done).toBeUndefined();
        const listed = await call('GET', `/projects/${projectId}/sessions`);
        expect(listed.body.sessions.find((s: Json) => s.id === session.id).done).toBeUndefined();
    });

    test('pressing done again is a new done', async () => {
        expect(await device({ done: true }, 'tablet')).toBeNull();
        expect((await wait()).body.status).toBe('done');
        await read();
        expect((await wait()).body.status).toBe('pending');
    });

    test('what the agent writes in the session takes the done back', async () => {
        for (const write of [
            () => call('POST', `${base()}/items`, { text: 'One more thing' }),
            () => call('POST', `${base()}/checklists`, { title: 'Another', items: ['x'] }),
            () => call('PUT', `${base()}/message`, { message: 'Fixed it' }),
        ]) {
            expect(await device({ done: true })).toBeNull();
            expect(await doneHere()).toBe(true);
            await write();
            await waitUntilDone(false);
        }
        // Editing an item (a retest, a correction) is news too.
        const shown = await call('GET', base());
        const item = shown.body.checklists[0].items[0];
        expect(await device({ done: true })).toBeNull();
        await call('PATCH', `${base()}/items/${item.ref}`, { text: 'Right password, again' });
        await waitUntilDone(false);
        // A device can ask for done again, and the session is listed as done.
        expect(await device({ done: true })).toBeNull();
        const listed = await call('GET', `/projects/${projectId}/sessions`);
        expect(listed.body.sessions.find((s: Json) => s.id === session.id).done).toBe(true);
    });

    test('a done the user pressed after seeing the news is not taken back with it', async () => {
        await startSession('Later');
        const room = await daemon.rooms.get(projectId);
        if (!room) throw new Error('no room');
        // The news, and right behind it a done whose clock is past the news: it is the user's.
        const news = room.submitLocal('item.add', session.id, {
            itemId: createId(),
            checklistId: (await call('GET', base())).body.checklists[0].id,
            text: 'Extra',
            order: 9,
        });
        const later = createOp({
            projectId,
            sessionId: session.id,
            type: 'session.done',
            payload: { done: true },
            clock: { lamport: room.state.lamport + 5, deviceId: 'phone' },
        });
        const pressed = room.submit(later, { kind: 'device', deviceId: 'phone' });
        await Promise.all([news, pressed]);
        await Bun.sleep(150);
        expect(await doneHere()).toBe(true);
        expect((await wait()).body.status).toBe('done');
    });

    test('writes that are not news leave it alone', async () => {
        expect(await device({ done: true })).toBeNull();
        await call('PATCH', base(), { title: 'Renamed' });
        await call('PATCH', `${base()}/checklists/${checklistRef}`, { title: 'Login, renamed' });
        await call('PUT', `${base()}/message`, { message: '' });
        await Bun.sleep(80);
        expect(await doneHere()).toBe(true);
        await read();
        expect(await doneHere()).toBe(false);
    });

    test('devices can mark done, never take it back, and only on a session that exists', async () => {
        expect(await device({ done: false })).toMatch(/only mark a session done/);
        expect(await device({ done: true }, 'phone', createId())).toBe('unknown session');
    });

    test('a wait that is given up (its process stopped) stops holding in the daemon', async () => {
        const other = await createTempHome();
        const long = await startTestDaemon(other.home, { waitHoldMs: 60_000 });
        try {
            const longKey = (await readFile(join(long.home, 'local.key'), 'utf8')).trim();
            const resolved = (await (
                await fetch(`http://127.0.0.1:${long.localPort}/projects/resolve`, {
                    method: 'POST',
                    headers: { [KEY_HEADER]: longKey, 'content-type': 'application/json' },
                    body: JSON.stringify({ rootPath: '/tmp/done-abandoned' }),
                })
            ).json()) as Json;
            const started = (await (
                await fetch(
                    `http://127.0.0.1:${long.localPort}/projects/${resolved.projectId}/sessions`,
                    {
                        method: 'POST',
                        headers: { [KEY_HEADER]: longKey, 'content-type': 'application/json' },
                        body: '{}',
                    },
                )
            ).json()) as Json;
            const controller = new AbortController();
            const request = fetch(
                `http://127.0.0.1:${long.localPort}/projects/${resolved.projectId}/sessions/${started.ref}/wait`,
                { headers: { [KEY_HEADER]: longKey }, signal: controller.signal },
            ).catch(() => null);
            await waitUntil(() => long.doneWaiters.holding === 1, 'the request holding');
            controller.abort();
            await request;
            await waitUntil(() => long.doneWaiters.holding === 0, 'the request let go');
        } finally {
            await long.stop();
            await other.cleanup();
        }
    });

    test('a session deleted while the agent waits ends the wait: it is gone', async () => {
        await startSession('Doomed');
        const waiting = wait();
        await Bun.sleep(50);
        await call('DELETE', base());
        const answer = await waiting;
        expect(answer.status).toBe(404);
        expect(answer.body.error).toMatch(/session/);
        expect((await wait()).status).toBe(404);
    });

    test('a project removed while the agent waits ends the wait too', async () => {
        const resolved = await call('POST', '/projects/resolve', { rootPath: '/tmp/done-gone' });
        const other = resolved.body.projectId as string;
        const started = await call('POST', `/projects/${other}/sessions`, { title: 'Gone' });
        const url = `/projects/${other}/sessions/${started.body.ref}/wait`;
        const waiting = call('GET', url);
        await Bun.sleep(50);
        await call('DELETE', `/projects/${other}`);
        expect((await waiting).status).toBe(404);
    });

    test('two waits on the same session both end at the tap, and both sleep again once it is read', async () => {
        await startSession('Twice');
        const [first, second] = [wait(), wait()];
        await Bun.sleep(40);
        // The agent adds more to review while they hold: nothing ends, nothing breaks.
        await call('POST', `${base()}/items`, { text: 'One more thing' });
        await Bun.sleep(40);
        expect(await device({ done: true })).toBeNull();
        expect((await first).body.status).toBe('done');
        expect((await second).body.status).toBe('done');
        await read();
        const [again, other] = [wait(), wait()];
        expect((await again).body.status).toBe('pending');
        expect((await other).body.status).toBe('pending');
    });

    test('one wait for each session: the last to start takes the place, the one before ends', async () => {
        await startSession('One only');
        const process = (name: string, claim: boolean) =>
            call('GET', `${base()}/wait?client=${name}${claim ? '&claim=1' : ''}`);
        const first = process('first', true);
        await Bun.sleep(40);
        expect((await call('GET', '/waits')).body.waits).toEqual([
            {
                project: { id: projectId, name: 'done-demo' },
                session: { ref: session.ref, title: 'One only' },
            },
        ]);
        // Another process starts: the first one is told at once, not after its hold.
        const second = process('second', true);
        expect((await first).body).toEqual({ status: 'superseded' });
        // It asking again does not take the place back.
        expect((await process('first', false)).body).toEqual({ status: 'superseded' });
        await Bun.sleep(40);
        expect((await call('GET', '/waits')).body.waits).toHaveLength(1);
        // The tap ends the one that waits, and nobody waits after it.
        expect(await device({ done: true })).toBeNull();
        expect((await second).body.status).toBe('done');
        expect((await call('GET', '/waits')).body.waits).toEqual([]);
        await read();
    });

    test('a wait that asks again after a restart of the daemon takes its place back', async () => {
        await startSession('Back');
        const asked = await call('GET', `${base()}/wait?client=survivor`);
        expect(asked.body.status).toBe('pending');
        expect((await call('GET', '/waits')).body.waits).toHaveLength(1);
        // A process that was cut off is not holding: its place is free for the next to claim.
        const controller = new AbortController();
        const request = fetch(
            `http://127.0.0.1:${daemon.localPort}${base()}/wait?client=cut&claim=1`,
            { headers: { [KEY_HEADER]: key }, signal: controller.signal },
        ).catch(() => null);
        await Bun.sleep(40);
        controller.abort();
        await request;
        await Bun.sleep(40);
        expect((await call('GET', '/waits')).body.waits).toEqual([]);
        expect((await call('GET', `${base()}/wait?client=late`)).body.status).toBe('pending');
        expect((await call('GET', '/waits')).body.waits).toHaveLength(1);
    });

    test('two sessions wait on their own', async () => {
        await startSession('First');
        const first = { ...session };
        await startSession('Second');
        const second = { ...session };
        const waitFor = (target: { ref: string }) =>
            call('GET', `/projects/${projectId}/sessions/${target.ref}/wait`);
        const [firstWait, secondWait] = [waitFor(first), waitFor(second)];
        await Bun.sleep(40);
        session = second;
        expect(await device({ done: true })).toBeNull();
        expect((await secondWait).body.status).toBe('done');
        expect((await firstWait).body.status).toBe('pending');
    });

    test('only the done that was read is spent: a newer tap stays, and the record leaves with the session', async () => {
        await startSession('Remembered');
        expect(await device({ done: true })).toBeNull();
        const room = await daemon.rooms.get(projectId);
        const first = room?.state.sessions[session.id]?.clocks.done?.opId as string;
        await read();
        const file = join(home, 'done-delivered.json');
        const saved = JSON.parse(await readFile(file, 'utf8')) as {
            sessions: Record<string, string>;
        };
        expect(saved.sessions[`${projectId}/${session.id}`]).toBe(first);

        // The agent read a done and, before it answers, the user taps again: that one is not
        // the done it read, so it is not spent and wakes the next wait.
        expect(await device({ done: true })).toBeNull();
        const second = room?.state.sessions[session.id]?.clocks.done?.opId as string;
        const stale = await call('POST', `${base()}/feedback/ack`, { items: [], done: first });
        expect(stale.status).toBe(200);
        expect(await doneHere()).toBe(true);
        expect((await wait()).body.status).toBe('done');
        await call('POST', `${base()}/feedback/ack`, { items: [], done: second });
        expect(await doneHere()).toBe(false);

        await call('DELETE', base());
        await Bun.sleep(100);
        expect(
            Object.keys(JSON.parse(await readFile(file, 'utf8')).sessions).filter((name) =>
                name.endsWith(session.id),
            ),
        ).toEqual([]);
    });

    test('a daemon started again has nothing left to tell once it was read', async () => {
        await startSession('Restarted');
        expect(await device({ done: true })).toBeNull();
        await read();
        await daemon.stop();
        daemon = await startTestDaemon(home, { waitHoldMs: HOLD_MS });
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        // The port is new, the project and the session are the same.
        expect((await wait()).body.status).toBe('pending');
        expect(await doneHere()).toBe(false);
    });
});

describe('the record of the dones the agent was told about', () => {
    test('an unreadable file is the same as no file', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const path = join(home, 'done-delivered.json');
            await writeFile(path, '{ not json');
            const store = await DoneDeliveries.open(path);
            expect(store.get('p', 's')).toBeUndefined();
            await store.set('p', 's', 'op1');
            await store.set('p', 't', 'op2');
            await store.set('q', 's', 'op3');
            expect((await DoneDeliveries.open(path)).get('p', 's')).toBe('op1');
            await store.removeProject('p');
            const reopened = await DoneDeliveries.open(path);
            expect([
                reopened.get('p', 's'),
                reopened.get('p', 't'),
                reopened.get('q', 's'),
            ]).toEqual([undefined, undefined, 'op3']);
        } finally {
            await cleanup();
        }
    });

    test('the process that waits for a session: the last claim wins, and a silent one stops counting', () => {
        let now = 1_000;
        const waiters = new DoneWaiters({ graceMs: 100, now: () => now });
        expect(waiters.hold('p/s', 'a', true)).toBe(true);
        expect(waiters.waiting()).toEqual(['p/s']);
        // A question of another process that did not claim is refused while the first is alive.
        expect(waiters.hold('p/s', 'b', false)).toBe(false);
        expect(waiters.isHolder('p/s', 'a')).toBe(true);
        // It claims: it takes the place, the first is no longer the one.
        expect(waiters.hold('p/s', 'b', true)).toBe(true);
        expect(waiters.hold('p/s', 'a', false)).toBe(false);
        // Silent for longer than the grace: nobody waits, and the next question may take the place.
        now += 101;
        expect(waiters.waiting()).toEqual([]);
        expect(waiters.hold('p/s', 'a', false)).toBe(true);
        expect(waiters.isHolder('p/s', 'a')).toBe(true);
        waiters.release('p/s', 'b');
        expect(waiters.isHolder('p/s', 'a')).toBe(true);
        waiters.release('p/s', 'a');
        expect(waiters.waiting()).toEqual([]);
    });

    test('who waits is told as it changes, and a wait that falls silent is gone after the grace', async () => {
        const waiters = new DoneWaiters({ graceMs: 40 });
        const changes: string[] = [];
        waiters.onChange((projectId) => changes.push(projectId));
        waiters.hold('p/a', 'one', true);
        waiters.hold('p/a', 'one', false);
        waiters.hold('p/b', 'two', true);
        expect(waiters.waitingIn('p')).toEqual(['a', 'b']);
        expect(changes).toEqual(['p', 'p']);
        waiters.release('p/b', 'two');
        expect(waiters.waitingIn('p')).toEqual(['a']);
        // `one` asks no more: the devices hear it after the grace, with no question to prompt it.
        await Bun.sleep(150);
        expect(waiters.waitingIn('p')).toEqual([]);
        expect(changes).toHaveLength(4);
        waiters.stop();
    });

    test('a waiter wakes at the next notice, at its time, or when it is aborted', async () => {
        const waiters = new DoneWaiters();
        const first = waiters.next(10_000);
        waiters.notify();
        await first;
        const started = Date.now();
        await waiters.next(40);
        expect(Date.now() - started).toBeGreaterThanOrEqual(30);
        const controller = new AbortController();
        const aborted = waiters.next(10_000, controller.signal);
        controller.abort();
        await aborted;
    });
});

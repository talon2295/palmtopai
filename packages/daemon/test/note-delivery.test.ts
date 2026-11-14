import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { joinNote } from '@palmtopai/protocol';
import { type Daemon, KEY_HEADER } from '../src';
import { NoteDeliveries, noteFingerprints } from '../src/note-delivery';
import { createTempHome, startTestDaemon } from './helpers';

/** The note the user keeps for the agent, as a list: what the agent is told is new or edited. */
describe('the note as a list, through the Local API', () => {
    let daemon: Daemon;
    let home: string;
    let key: string;
    let cleanup: () => Promise<void>;
    let projectId: string;
    let session: { ref: string; id: string };

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

    const base = () => `/projects/${projectId}/sessions/${session.ref}`;

    const writeNote = async (note: string) => {
        const room = await daemon.rooms.get(projectId);
        await room?.submitLocal('session.note', session.id, { note });
    };

    const read = async () => {
        const feedback = await call('GET', `${base()}/feedback`);
        await call('POST', `${base()}/feedback/ack`, feedback.body.ack);
        return feedback.body;
    };

    beforeAll(async () => {
        ({ home, cleanup } = await createTempHome());
        daemon = await startTestDaemon(home);
        key = (await readFile(join(home, 'local.key'), 'utf8')).trim();
        const resolved = await call('POST', '/projects/resolve', { rootPath: '/tmp/note-demo' });
        projectId = resolved.body.projectId;
        const started = await call('POST', `/projects/${projectId}/sessions`, { title: 'Notes' });
        session = { ref: started.body.ref, id: started.body.id };
        await call('POST', `${base()}/checklists`, { title: 'Login', items: ['Right password'] });
    });

    afterAll(async () => {
        await daemon.stop();
        await cleanup();
    });

    test('the first time the whole list is new and nothing is marked', async () => {
        await writeNote(
            joinNote([
                { id: 'aaaa', text: 'Header is wrong\non mobile' },
                { id: 'bbbb', text: 'Check the footer' },
            ]),
        );
        const feedback = await read();
        expect(feedback.note).toBe('- Header is wrong\n  on mobile\n- Check the footer');
        const shown = await call('GET', base());
        expect(shown.body.note).toBe('- Header is wrong\n  on mobile\n- Check the footer');
        // Read: nothing new until it changes.
        const again = await call('GET', `${base()}/feedback`);
        expect(again.body.note).toBeUndefined();
    });

    test('then an edited element is [edit], an added one [new], the others unmarked', async () => {
        await writeNote(
            joinNote([
                { id: 'aaaa', text: 'Header is wrong on every page' },
                { id: 'bbbb', text: 'Check the footer' },
                { id: 'cccc', text: 'And the logo' },
            ]),
        );
        const feedback = await read();
        expect(feedback.note).toBe(
            '- [edit] Header is wrong on every page\n- Check the footer\n- [new] And the logo',
        );
    });

    test('removing an element only tells the rest of the list', async () => {
        await writeNote(
            joinNote([
                { id: 'aaaa', text: 'Header is wrong on every page' },
                { id: 'cccc', text: 'And the logo' },
            ]),
        );
        const feedback = await read();
        expect(feedback.note).toBe('- Header is wrong on every page\n- And the logo');
    });

    test('only fingerprints are kept, and they leave with the session', async () => {
        const file = join(home, 'note-delivered.json');
        const saved = await readFile(file, 'utf8');
        expect(saved).toContain(session.id);
        expect(saved).not.toContain('Header');
        expect(saved).not.toContain('logo');
        expect(JSON.parse(saved).sessions[`${projectId}/${session.id}`]).toEqual(
            noteFingerprints(
                session.id,
                joinNote([
                    { id: 'aaaa', text: 'Header is wrong on every page' },
                    { id: 'cccc', text: 'And the logo' },
                ]),
            ),
        );

        await call('DELETE', base());
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(JSON.parse(await readFile(file, 'utf8')).sessions).toEqual({});
    });

    test('an acknowledgement of a note that changed since is not remembered', async () => {
        const started = await call('POST', `/projects/${projectId}/sessions`, { title: 'Late' });
        session = { ref: started.body.ref, id: started.body.id };
        await writeNote(joinNote([{ id: 'aaaa', text: 'one' }]));
        await read();
        await writeNote(
            joinNote([
                { id: 'aaaa', text: 'one' },
                { id: 'bbbb', text: 'two' },
            ]),
        );
        const stale = await call('GET', `${base()}/feedback`);
        await writeNote(
            joinNote([
                { id: 'aaaa', text: 'one' },
                { id: 'bbbb', text: 'two' },
                { id: 'cccc', text: 'three' },
            ]),
        );
        await call('POST', `${base()}/feedback/ack`, stale.body.ack);
        // The note it was given is not the note now: `two` is still new to the agent.
        const next = await call('GET', `${base()}/feedback`);
        expect(next.body.note).toBe('- one\n- [new] two\n- [new] three');
    });

    test('a note that is not a list reaches the agent as written', async () => {
        const started = await call('POST', `/projects/${projectId}/sessions`, { title: 'Old' });
        session = { ref: started.body.ref, id: started.body.id };
        await writeNote('Use staging\nand check the login');
        const feedback = await read();
        expect(feedback.note).toBe('Use staging\nand check the login');
        // Edited by an app that knows lists: no marks yet, nothing was remembered by name.
        await writeNote(joinNote([{ id: 'aaaa', text: 'Use staging' }]));
        const next = await read();
        expect(next.note).toBe('- Use staging');
    });
});

describe('the record of what the agent read', () => {
    test('an unreadable file is the same as no file', async () => {
        const { home, cleanup } = await createTempHome();
        try {
            const path = join(home, 'note-delivered.json');
            await writeFile(path, '{ not json');
            const store = await NoteDeliveries.open(path);
            expect(store.get('p', 's')).toBeUndefined();
            await store.set('p', 's', { aaaa: 'f' });
            expect((await NoteDeliveries.open(path)).get('p', 's')).toEqual({ aaaa: 'f' });
            await store.removeProject('p');
            expect((await NoteDeliveries.open(path)).get('p', 's')).toBeUndefined();
        } finally {
            await cleanup();
        }
    });
});

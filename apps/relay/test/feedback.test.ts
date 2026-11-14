import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEEDBACK_FILE, FeedbackStore, receiveFeedback } from '../src/feedback';

const VALID = {
    type: 'bug',
    message: '  The QR code does not show  ',
    email: 'tester@example.com',
    page: '/',
};

describe('feedback store', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    test('keeps valid feedback, trimmed, with an id and a date', () => {
        const store = new FeedbackStore();
        const result = receiveFeedback(store, JSON.stringify(VALID));
        expect(result.status).toBe('stored');
        const [entry] = store.list();
        expect(entry).toMatchObject({
            type: 'bug',
            message: 'The QR code does not show',
            email: 'tester@example.com',
            page: '/',
        });
        expect(entry?.id).toMatch(/^[0-9a-f]{12}$/);
        expect(Date.parse(entry?.at ?? '')).not.toBeNaN();
    });

    test('refuses invalid bodies and drops the honeypot ones', () => {
        const store = new FeedbackStore();
        const send = (body: unknown) =>
            receiveFeedback(store, typeof body === 'string' ? body : JSON.stringify(body)).status;
        expect(send('not json')).toBe('invalid');
        expect(send({ ...VALID, type: 'praise' })).toBe('invalid');
        expect(send({ ...VALID, message: '   ' })).toBe('invalid');
        expect(send({ ...VALID, message: 'x'.repeat(4001) })).toBe('invalid');
        expect(send({ ...VALID, email: '' })).toBe('invalid');
        expect(send({ ...VALID, email: 'not an email' })).toBe('invalid');
        expect(send({ ...VALID, website: 'http://spam.example' })).toBe('spam');
        expect(send(`{"message":"${'x'.repeat(17_000)}"}`)).toBe('too_big');
        expect(store.list()).toEqual([]);
    });

    test('appends to feedback.jsonl and skips broken lines', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-feedback-'));
        dirs.push(dir);
        const store = new FeedbackStore(dir);
        receiveFeedback(store, JSON.stringify(VALID));
        await appendFile(join(dir, FEEDBACK_FILE), '{"cut":\n');
        receiveFeedback(store, JSON.stringify({ ...VALID, type: 'feature' }));
        const lines = (await readFile(join(dir, FEEDBACK_FILE), 'utf8')).trim().split('\n');
        expect(lines).toHaveLength(3);
        expect(new FeedbackStore(dir).list().map((entry) => entry.type)).toEqual([
            'bug',
            'feature',
        ]);
    });

    test('an empty store lists nothing', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-feedback-'));
        dirs.push(dir);
        expect(new FeedbackStore(dir).list()).toEqual([]);
    });
});

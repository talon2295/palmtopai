import { describe, expect, test } from 'bun:test';
import {
    apply,
    cliReleaseSchema,
    createId,
    createProjectState,
    DAEMON_PROTOCOL_VERSION,
    isDaemonOutdated,
    LIMITS,
    MAX_DEVICE_MESSAGE_BYTES,
    parseClientMessage,
    parseOp,
    parseServerMessage,
    sealedFrameBytes,
} from '../src';
import { op, projectId } from './helpers';

const clock = { lamport: 1, deviceId: 'phone' };
const itemId = createId();
const checklistId = createId();

const baseOp = op('item.add', { itemId, checklistId, text: 'Write tests', order: 1 }, clock);

/** Fresh copy of the same op (same opId) so tests can spread and tamper with it. */
function validOp() {
    return structuredClone(baseOp);
}

describe('op validation', () => {
    test('accepts a well-formed op and round-trips through JSON', () => {
        const result = parseOp(JSON.stringify(validOp()));
        expect(result).toEqual({ ok: true, value: validOp() as never });
    });

    test('accepts every op type', () => {
        const ops = [
            op('session.upsert', {}, clock),
            op('checklist.create', { checklistId, title: 'T' }, clock),
            op('checklist.update', { checklistId, title: 'T2' }, clock),
            op('checklist.remove', { checklistId }, clock),
            op(
                'item.add',
                { itemId, checklistId, text: 'x', order: 0, status: 'question', note: '' },
                clock,
            ),
            op('item.update', { itemId, note: null }, clock),
            op('item.update', { itemId, status: null }, clock),
            op('item.update', { itemId, status: null, note: null }, clock),
            op('item.update', { itemId, status: 'cancelled', note: 'no' }, clock),
            op('item.remove', { itemId }, clock),
            op('feedback.deliver', { items: [{ itemId, status: itemId, note: itemId }] }, clock),
        ];
        for (const candidate of ops) expect(parseOp(candidate).ok).toBe(true);
    });

    test('strips unknown fields instead of letting them into the state', () => {
        const result = parseOp({
            ...validOp(),
            extra: true,
            payload: { ...validOp().payload, admin: true },
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.value).not.toHaveProperty('extra');
            expect(result.value.payload).not.toHaveProperty('admin');
        }
    });

    const invalid: Array<[string, unknown]> = [
        ['malformed JSON', '{"type": "item.add"'],
        ['non-object', 42],
        ['unknown op type', { ...validOp(), type: 'item.explode' }],
        ['unsupported version', { ...validOp(), v: 2 }],
        ['missing opId', { ...validOp(), opId: undefined }],
        ['opId not a ULID', { ...validOp(), opId: 'abc' }],
        ['projectId not a ULID', { ...validOp(), projectId: '../../etc/passwd' }],
        ['lamport zero', { ...validOp(), clock: { lamport: 0, deviceId: 'phone' } }],
        ['lamport not integer', { ...validOp(), clock: { lamport: 1.5, deviceId: 'phone' } }],
        ['device id with spaces', { ...validOp(), clock: { lamport: 1, deviceId: 'my phone' } }],
        ['negative timestamp', { ...validOp(), ts: -1 }],
        ['empty item text', { ...validOp(), payload: { ...validOp().payload, text: '' } }],
        [
            'item text over limit',
            { ...validOp(), payload: { ...validOp().payload, text: 'x'.repeat(LIMITS.text + 1) } },
        ],
        ['non-finite order', { ...validOp(), payload: { ...validOp().payload, order: Infinity } }],
        ['payload of another type', { ...validOp(), payload: { checklistId, title: 'T' } }],
        ['item.update without fields', op('item.update', { itemId } as never, clock)],
        [
            'item.update with wrong type',
            op('item.update', { itemId, status: 'yes' } as never, clock),
        ],
        ['legacy checked field only', op('item.update', { itemId, checked: true } as never, clock)],
        [
            'item.add with a note but no status',
            { ...validOp(), payload: { ...validOp().payload, note: 'orphan' } },
        ],
        [
            'item.update resetting status while setting a note',
            op('item.update', { itemId, status: null, note: 'x' }, clock),
        ],
        ['feedback.deliver with nothing', op('feedback.deliver', { items: [] }, clock)],
        [
            'feedback.deliver with invalid markers',
            op('feedback.deliver', { items: [{ itemId, status: 'x', note: itemId }] }, clock),
        ],
        [
            'feedback.deliver over the item limit',
            op(
                'feedback.deliver',
                {
                    items: Array.from({ length: LIMITS.deliveredItems + 1 }, () => ({
                        itemId,
                        status: itemId,
                        note: itemId,
                    })),
                },
                clock,
            ),
        ],
    ];

    test.each(invalid)('rejects %s', (_label, candidate) => {
        const result = parseOp(candidate);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
    });
});

describe('client messages', () => {
    test('accepts hello, op, ping, pong and device.unpair', () => {
        // The sealed channel already proved who the device is: hello carries no credential.
        expect(parseClientMessage({ type: 'hello', projectId }).ok).toBe(true);
        expect(parseClientMessage({ type: 'hello' }).ok).toBe(true);
        expect(parseClientMessage({ type: 'hello', projectId, lastSeq: 12 }).ok).toBe(true);
        expect(parseClientMessage({ type: 'device.unpair' }).ok).toBe(true);
        expect(parseClientMessage(JSON.stringify({ type: 'op', op: validOp() })).ok).toBe(true);
        expect(parseClientMessage('{"type":"ping"}').ok).toBe(true);
        expect(parseClientMessage({ type: 'pong' }).ok).toBe(true);
    });

    const invalid: Array<[string, unknown]> = [
        ['hello with an invalid project', { type: 'hello', projectId: 'nope' }],
        ['hello with negative lastSeq', { type: 'hello', projectId, lastSeq: -1 }],
        // Pairing is end to end now (`e2e.ts`): the key is never sent.
        ['the old pairing redeem', { type: 'pair.redeem', key: 'k'.repeat(22) }],
        ['op with invalid op', { type: 'op', op: { ...validOp(), opId: 'nope' } }],
        ['server-only message', { type: 'snapshot', state: createProjectState(projectId), seq: 0 }],
        ['missing type', { projectId }],
        ['empty string', ''],
    ];

    test.each(invalid)('rejects %s', (_label, candidate) => {
        expect(parseClientMessage(candidate).ok).toBe(false);
    });

    test('validation errors never echo what was submitted', () => {
        const secret = 'S3CR3T-VALUE-0123456789';
        const result = parseClientMessage({ type: 'hello', projectId: secret });
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).not.toContain(secret);
    });
});

describe('server messages', () => {
    test('accepts snapshot with real state, ops batch, op, error', () => {
        const state = apply(createProjectState(projectId), validOp());
        const seqOp = { seq: 1, op: validOp() };

        const info = { id: projectId, name: 'demo' };
        expect(
            parseServerMessage(JSON.stringify({ type: 'snapshot', project: info, state, seq: 1 })),
        ).toEqual({
            ok: true,
            value: { type: 'snapshot', project: info, state, seq: 1 },
        });
        expect(parseServerMessage({ type: 'ops', project: info, ops: [seqOp], seq: 1 }).ok).toBe(
            true,
        );
        expect(parseServerMessage({ type: 'ops', ops: [seqOp], seq: 1 }).ok).toBe(false);
        expect(
            parseServerMessage({
                type: 'error',
                code: 'forbidden',
                message: 'devices cannot send item.add',
                opId: baseOp.opId,
            }).ok,
        ).toBe(true);
        expect(parseServerMessage({ type: 'op', ...seqOp }).ok).toBe(true);
        expect(
            parseServerMessage({ type: 'error', code: 'unauthorized', message: 'nope' }).ok,
        ).toBe(true);
    });

    test('rejects malformed server messages', () => {
        expect(parseServerMessage({ type: 'op', op: validOp() }).ok).toBe(false); // missing seq
        expect(parseServerMessage({ type: 'error', code: 'teapot', message: 'x' }).ok).toBe(false);
        // The end of a pairing: the computer, never a token.
        const computer = { id: createId(), name: 'Office' };
        expect(parseServerMessage({ type: 'paired', computer }).ok).toBe(true);
        expect(
            parseServerMessage({
                type: 'pair.granted',
                computerId: computer.id,
                token: 't'.repeat(43),
            }).ok,
        ).toBe(false);
        expect(
            parseServerMessage({ type: 'snapshot', state: { projectId, lamport: -1 }, seq: 0 }).ok,
        ).toBe(false);
        expect(parseServerMessage({ type: 'hello' }).ok).toBe(false);
    });
});

describe('versions', () => {
    test('daemons without a protocol are version 1; older than the minimum are outdated', () => {
        expect(isDaemonOutdated(DAEMON_PROTOCOL_VERSION)).toBe(false);
        // Protocol 1 pairs devices with one project, 2 has a token: too old for this app.
        expect(isDaemonOutdated(undefined)).toBe(true);
        expect(isDaemonOutdated(1)).toBe(true);
        expect(isDaemonOutdated(2)).toBe(true);
        expect(isDaemonOutdated(undefined, 1)).toBe(false);
        expect(isDaemonOutdated(1, 2)).toBe(true);
        expect(isDaemonOutdated(2, 2)).toBe(false);
    });

    test('CLI release manifest', () => {
        const release = {
            version: '0.1.0',
            build: 'abcdef012345',
            sha256: 'f'.repeat(64),
            size: 1,
        };
        expect(cliReleaseSchema.safeParse(release).success).toBe(true);
        expect(cliReleaseSchema.safeParse({ ...release, build: 'dev' }).success).toBe(false);
        expect(cliReleaseSchema.safeParse({ ...release, sha256: 'x' }).success).toBe(false);
        expect(cliReleaseSchema.safeParse({ ...release, version: 'latest' }).success).toBe(false);
        expect(cliReleaseSchema.safeParse({ ...release, size: 0 }).success).toBe(false);
    });
});

describe('shared copies on the device protocol', () => {
    const person = {
        name: 'Mario',
        state: 'open',
        expiresAt: 5_000,
        items: { [createId()]: { status: 'cancelled', note: 'no error' } },
        checklists: [createId()],
        note: 'Looks fine',
    };

    test('the answers of the people are a server message, by session', () => {
        const message = {
            type: 'shares',
            projectId,
            sessions: [{ sessionId: createId(), people: [person] }],
        };
        const parsed = parseServerMessage(JSON.stringify(message));
        expect(parsed.ok).toBe(true);
        expect(parsed.ok && parsed.value).toEqual(message as never);
    });

    test('are checked: a state, a status and a name that is there', () => {
        const sessions = (extra: object) => [
            { sessionId: createId(), people: [{ ...person, ...extra }] },
        ];
        for (const bad of [
            { state: 'maybe' },
            { name: '' },
            { items: { nope: { status: 'done' } } },
        ]) {
            expect(
                parseServerMessage({ type: 'shares', projectId, sessions: sessions(bad) }).ok,
            ).toBe(false);
        }
        expect(parseServerMessage({ type: 'shares', projectId: 'nope', sessions: [] }).ok).toBe(
            false,
        );
    });

    test('a copy says until when it takes answers, a project of the computer says nothing', () => {
        const info = { id: projectId, name: 'Release', computer: 'Grace', sharedUntil: 9_000 };
        const message = parseServerMessage({ type: 'project', project: info });
        expect(message.ok && message.value).toEqual({ type: 'project', project: info });
        const plain = parseServerMessage({
            type: 'project',
            project: { id: projectId, name: 'x' },
        });
        expect(
            plain.ok && plain.value.type === 'project' && plain.value.project,
        ).not.toHaveProperty('sharedUntil');
    });
});

describe('screenshot messages', () => {
    const imageId = createId();
    const put = (extra: object = {}) => ({
        type: 'image.put',
        projectId: createId(),
        sessionId: createId(),
        imageId,
        mime: 'image/jpeg',
        data: Buffer.alloc(100, 1).toString('base64'),
        ...extra,
    });

    test('a device stores and asks for an image', () => {
        expect(parseClientMessage(put()).ok).toBe(true);
        expect(parseClientMessage(put({ mime: 'image/webp' })).ok).toBe(true);
        expect(parseClientMessage({ type: 'image.get', projectId: createId(), imageId }).ok).toBe(
            true,
        );
    });

    test('only JPEG and WebP, as base64, up to the limit of an image', () => {
        expect(parseClientMessage(put({ mime: 'image/png' })).ok).toBe(false);
        expect(parseClientMessage(put({ mime: 'image/svg+xml' })).ok).toBe(false);
        expect(parseClientMessage(put({ data: '' })).ok).toBe(false);
        expect(parseClientMessage(put({ data: 'not base64!' })).ok).toBe(false);
        expect(parseClientMessage(put({ imageId: '../../etc/passwd' })).ok).toBe(false);
        expect(
            parseClientMessage(put({ data: Buffer.alloc(LIMITS.image, 1).toString('base64') })).ok,
        ).toBe(true);
        expect(
            parseClientMessage(put({ data: Buffer.alloc(LIMITS.image + 4, 1).toString('base64') }))
                .ok,
        ).toBe(false);
    });

    test('the biggest image still fits the frame a device can send', () => {
        const largest = JSON.stringify(
            put({ data: Buffer.alloc(LIMITS.image, 1).toString('base64') }),
        );
        expect(sealedFrameBytes(Buffer.byteLength(largest))).toBeLessThanOrEqual(
            MAX_DEVICE_MESSAGE_BYTES,
        );
        // The limit is about what the frame allows: a few thousand bytes more would not fit.
        const toobig = JSON.stringify(
            put({ data: Buffer.alloc(LIMITS.image + 12_000, 1).toString('base64') }),
        );
        expect(sealedFrameBytes(Buffer.byteLength(toobig))).toBeGreaterThan(
            MAX_DEVICE_MESSAGE_BYTES,
        );
    });

    test('the computer answers with the image, its absence, or an error that names it', () => {
        expect(parseServerMessage({ type: 'image.saved', imageId }).ok).toBe(true);
        expect(parseServerMessage({ type: 'image.missing', imageId }).ok).toBe(true);
        expect(
            parseServerMessage({ type: 'image', imageId, mime: 'image/jpeg', data: 'AAAA' }).ok,
        ).toBe(true);
        expect(
            parseServerMessage({ type: 'error', code: 'forbidden', message: 'no', imageId }).ok,
        ).toBe(true);
    });

    test('the protocol that has them is 6 or later', () => {
        expect(DAEMON_PROTOCOL_VERSION).toBeGreaterThanOrEqual(6);
    });
});

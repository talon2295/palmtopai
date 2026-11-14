import { z } from 'zod';
import { ULID_PATTERN } from './ids';

export const PROTOCOL_VERSION = 1;

export const LIMITS = {
    title: 200,
    text: 2_000,
    note: 10_000,
    branch: 255,
    computerName: 40,
    /** Items per `feedback.deliver` op: larger deliveries are split. */
    deliveredItems: 500,
    /**
     * Bytes of a screenshot, once re-encoded by the app. A device message is sealed in a frame of
     * at most `MAX_DEVICE_MESSAGE_BYTES`: base64 inside the JSON, then base64url around the
     * ciphertext, so about 147 000 bytes is the most that fits. Staying below it needs no pieces.
     */
    image: 140_000,
} as const;

// ---------------------------------------------------------------------------
// Primitives

export const idSchema = z.string().regex(ULID_PATTERN, 'invalid id');
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid device id');
/** Name of the computer shown before the project name (`palmtop config name`). */
export const computerNameSchema = z
    .string()
    .trim()
    .min(1, 'the name is empty')
    .max(LIMITS.computerName, `the name is longer than ${LIMITS.computerName} characters`)
    .regex(/^\P{Cc}*$/u, 'the name contains control characters');
const timestampSchema = z.number().int().nonnegative();
const seqSchema = z.number().int().nonnegative();
const titleSchema = z.string().min(1).max(LIMITS.title);
const textSchema = z.string().min(1).max(LIMITS.text);
/** Extra lines of an item (the pros and cons of an option); `''` means none. */
const detailSchema = z.string().max(LIMITS.text);
const noteSchema = z.string().max(LIMITS.note);
const messageSchema = z.string().max(LIMITS.text);

/** What a screenshot is stored as: the app re-encodes whatever the user picks to one of these. */
export const imageMimeSchema = z.enum(['image/jpeg', 'image/webp']);
/** Standard base64 of at most `LIMITS.image` bytes. */
const imageDataSchema = z
    .string()
    .max(Math.ceil((LIMITS.image * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'invalid image data');

export const clockSchema = z.object({
    lamport: z.number().int().positive(),
    deviceId: deviceIdSchema,
});

export const stampSchema = clockSchema.extend({ opId: idSchema });

// ---------------------------------------------------------------------------
// Entity values (fields replicated with last-write-wins)

export const sessionValuesSchema = z.object({
    title: titleSchema,
    branch: z.string().min(1).max(LIMITS.branch),
    startedAt: timestampSchema,
    /** Note written by the user on a device for the agent (`session.note`); `''` = none. */
    note: noteSchema,
    /** Id of the op that had last written `note` when the note was delivered to the agent. */
    deliveredNote: idSchema,
    /** Message of the agent shown on devices (`session.message`); `''` = none. */
    message: messageSchema,
    messageAt: timestampSchema,
    /**
     * Put away by the user (`session.archive`): out of the Dashboard and its counts. The daemon
     * takes it out again when the agent writes something the devices are notified of.
     */
    archived: z.boolean(),
    /**
     * The user finished the review of the session on a device (`session.done`, phase 25). The
     * daemon takes it back when the agent writes something new in the session.
     */
    done: z.boolean(),
});

/**
 * What a list asks of the user: `checks` (the default) are things to verify one by one, a
 * `choice` is one question whose items are the options to pick from. Written by `checklist.create`
 * and never changed afterwards: the app decides how to show the list from it. Lists written before
 * phase 17 carry neither field and count as `checks`.
 */
export const checklistKindSchema = z.enum(['checks', 'choice']);

/** How many options of a choice can be chosen: `one` (the default) or `any` of them. */
export const choicePickSchema = z.enum(['one', 'any']);

export const checklistValuesSchema = z.object({
    sessionId: idSchema,
    title: titleSchema,
    createdAt: timestampSchema,
    kind: checklistKindSchema,
    pick: choicePickSchema,
    /** In a copy shared with a guest: the id of the checklist it was copied from. */
    origin: idSchema.optional(),
});

/**
 * Review state of an item: `done` (V), `cancelled` (X), `question` (?). In a choice they read as
 * chosen, discarded and "explain this one".
 * An item without status has not been reviewed yet and carries no note.
 */
export const itemStatusSchema = z.enum(['done', 'cancelled', 'question']);

export const itemValuesSchema = z.object({
    checklistId: idSchema,
    /** Session of the op that wrote the item: removing the session removes the item. */
    sessionId: idSchema,
    text: textSchema,
    /** A couple of lines under the text, for the options of a choice; `''` = none. */
    detail: detailSchema,
    /** `null` = not reviewed. */
    status: itemStatusSchema.nullable(),
    note: noteSchema.nullable(),
    order: z.number(),
    /** In a copy shared with a guest: the id of the item it was copied from. */
    origin: idSchema.optional(),
    /**
     * Ids of the ops that had last written `status` and `note` when the review of the item was
     * delivered to the agent. A later write to either field makes the review new again.
     */
    delivered: z.object({
        status: idSchema,
        note: idSchema,
        /** Items added by the user: the text write delivered to the agent. */
        text: idSchema.optional(),
    }),
});

// ---------------------------------------------------------------------------
// Replicated state

/** Drops keys that are no longer fields (e.g. the session `status` of older versions). */
function knownKeys(keys: readonly string[]) {
    return (raw: unknown) =>
        raw && typeof raw === 'object' && !Array.isArray(raw)
            ? Object.fromEntries(Object.entries(raw).filter(([key]) => keys.includes(key)))
            : raw;
}

function lwwRecordSchema<S extends z.ZodObject>(values: S) {
    return z.object({
        id: idSchema,
        values: values.partial(),
        clocks: z.preprocess(
            knownKeys(Object.keys(values.shape)),
            z.partialRecord(values.keyof(), stampSchema),
        ),
        /** Highest-stamped op that touched the record: source of updatedAt / updatedBy. */
        last: z.object({ stamp: stampSchema, ts: timestampSchema }).nullable(),
        /** Tombstone: once set, the record ignores every later op (remove wins). */
        removed: stampSchema.nullable(),
    });
}

export const sessionRecordSchema = lwwRecordSchema(sessionValuesSchema).extend({
    lastActivityAt: timestampSchema,
});
export const checklistRecordSchema = lwwRecordSchema(checklistValuesSchema);
export const itemRecordSchema = lwwRecordSchema(itemValuesSchema);

export const projectStateSchema = z.object({
    projectId: idSchema,
    lamport: z.number().int().nonnegative(),
    sessions: z.record(idSchema, sessionRecordSchema),
    checklists: z.record(idSchema, checklistRecordSchema),
    items: z.record(idSchema, itemRecordSchema),
});

/** Project metadata shared outside the daemon. Nothing secret is part of it. */
export const projectMetaSchema = z.object({
    id: idSchema,
    name: z.string().min(1).max(LIMITS.title),
    rootPath: z.string().min(1),
    gitRemote: z.string().min(1).optional(),
    createdAt: timestampSchema,
});

/** What a paired device learns about a project on connect. */
export const projectInfoSchema = projectMetaSchema.pick({ id: true, name: true }).extend({
    /** Name of the computer (daemons older than phase 9.7 do not send it). */
    computer: computerNameSchema.optional(),
    /**
     * Only on a copy shared with a person: when it stops taking answers (it stays readable until
     * the owner closes it). Its presence tells the app it is showing a guest's copy.
     */
    sharedUntil: timestampSchema.optional(),
});

// ---------------------------------------------------------------------------
// Operations

export const sessionUpsertPayloadSchema = sessionValuesSchema
    .pick({ title: true, branch: true, startedAt: true })
    .partial();

/** Sets the user's note for the agent (devices only); `''` clears it. */
export const sessionNotePayloadSchema = z.object({ note: noteSchema });

/** Sets the agent's message shown on devices (agent only); `''` clears it. */
export const sessionMessagePayloadSchema = z.object({ message: messageSchema });

/** Deletes the session of the op with its checklists and items, on every replica, for good. */
export const sessionRemovePayloadSchema = z.object({});

/** Archives a session, or takes it out of the archive (written by the daemon only). */
export const sessionArchivePayloadSchema = z.object({ archived: z.boolean() });

/**
 * The user marks the session done (devices, only `true`), and the daemon takes it back when the
 * agent writes something new in the session.
 */
export const sessionDonePayloadSchema = z.object({ done: z.boolean() });

/** Sent by the daemon when the agent has received the review of some items. */
export const feedbackDeliverPayloadSchema = z
    .object({
        items: z
            .array(
                z.object({
                    itemId: idSchema,
                    status: idSchema,
                    note: idSchema,
                    text: idSchema.optional(),
                }),
            )
            .max(LIMITS.deliveredItems),
        /** Id of the op that wrote the session note the agent received. */
        sessionNote: idSchema.optional(),
    })
    .refine((p) => p.items.length > 0 || p.sessionNote !== undefined, {
        message: 'feedback.deliver requires items or a session note',
    });

export const checklistCreatePayloadSchema = z.object({
    checklistId: idSchema,
    title: titleSchema,
    /** Absent = `checks`, so lists created before phase 17 stay what they were. */
    kind: checklistKindSchema.optional(),
    /** Only meaningful for a choice; absent = `one`. */
    pick: choicePickSchema.optional(),
    /** The checklist this one was copied from, for a copy shared with a guest. */
    origin: idSchema.optional(),
});

export const checklistUpdatePayloadSchema = z.object({
    checklistId: idSchema,
    title: titleSchema,
});

export const checklistRemovePayloadSchema = z.object({
    checklistId: idSchema,
});

export const itemAddPayloadSchema = z
    .object({
        itemId: idSchema,
        checklistId: idSchema,
        text: textSchema,
        detail: detailSchema.optional(),
        status: itemStatusSchema.optional(),
        note: noteSchema.optional(),
        order: z.number(),
        /** The item this one was copied from, for a copy shared with a guest. */
        origin: idSchema.optional(),
    })
    .refine((p) => p.note === undefined || p.status !== undefined, {
        message: 'a note requires a status',
        path: ['note'],
    });

export const itemUpdatePayloadSchema = z
    .object({
        itemId: idSchema,
        text: textSchema.optional(),
        /** `''` clears the detail. */
        detail: detailSchema.optional(),
        /** `null` resets the item to "not reviewed" and also clears its note. */
        status: itemStatusSchema.nullable().optional(),
        /** `null` or `''` clears the note. */
        note: noteSchema.nullable().optional(),
        order: z.number().optional(),
    })
    .refine(
        (p) =>
            p.text !== undefined ||
            p.detail !== undefined ||
            p.status !== undefined ||
            p.note !== undefined ||
            p.order !== undefined,
        { message: 'item.update requires at least one field' },
    )
    .refine((p) => p.status !== null || p.note == null, {
        message: 'resetting the status cannot set a note',
        path: ['note'],
    });

export const itemRemovePayloadSchema = z.object({
    itemId: idSchema,
});

const envelope = {
    v: z.literal(PROTOCOL_VERSION),
    opId: idSchema,
    projectId: idSchema,
    sessionId: idSchema,
    clock: clockSchema,
    ts: timestampSchema,
};

export const opSchema = z.discriminatedUnion('type', [
    z.object({
        ...envelope,
        type: z.literal('session.upsert'),
        payload: sessionUpsertPayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('session.remove'),
        payload: sessionRemovePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('session.note'),
        payload: sessionNotePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('session.message'),
        payload: sessionMessagePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('session.archive'),
        payload: sessionArchivePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('session.done'),
        payload: sessionDonePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('checklist.create'),
        payload: checklistCreatePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('checklist.update'),
        payload: checklistUpdatePayloadSchema,
    }),
    z.object({
        ...envelope,
        type: z.literal('checklist.remove'),
        payload: checklistRemovePayloadSchema,
    }),
    z.object({ ...envelope, type: z.literal('item.add'), payload: itemAddPayloadSchema }),
    z.object({ ...envelope, type: z.literal('item.update'), payload: itemUpdatePayloadSchema }),
    z.object({ ...envelope, type: z.literal('item.remove'), payload: itemRemovePayloadSchema }),
    z.object({
        ...envelope,
        type: z.literal('feedback.deliver'),
        payload: feedbackDeliverPayloadSchema,
    }),
]);

/** An op as persisted and broadcast by the server, with its per-project sequence number. */
export const seqOpSchema = z.object({ seq: seqSchema, op: opSchema });

// ---------------------------------------------------------------------------
// WebSocket messages (device protocol: phones ↔ daemon, forwarded by the relay)

export const errorCodeSchema = z.enum(['invalid_message', 'unauthorized', 'forbidden', 'internal']);
/**
 * Message of the `unauthorized` error the computer sends, sealed, to a device it just revoked:
 * only the computer can send it, unlike a close code the relay could make up.
 */
export const DEVICE_UNPAIRED = 'device unpaired';

const pingSchema = z.object({ type: z.literal('ping') });
const pongSchema = z.object({ type: z.literal('pong') });

const base64url = (bytes: number) =>
    z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`), 'invalid key');

/**
 * Hosts of the browsers' push services. The daemon only sends to these: a paired device cannot
 * make it post to any other address.
 */
export const PUSH_SERVICE_HOSTS = [
    'fcm.googleapis.com',
    '.push.services.mozilla.com',
    '.push.apple.com',
    '.notify.windows.com',
] as const;

export function isPushServiceUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:' || parsed.port !== '' || parsed.username || parsed.password) {
        return false;
    }
    return PUSH_SERVICE_HOSTS.some((host) =>
        host.startsWith('.') ? parsed.hostname.endsWith(host) : parsed.hostname === host,
    );
}

/** A browser push subscription (`PushSubscription.toJSON()`) and the VAPID keys of the phone. */
export const pushRegistrationSchema = z.object({
    subscription: z.object({
        endpoint: z.string().max(2048).refine(isPushServiceUrl, 'not a known push service'),
        keys: z.object({ p256dh: base64url(65), auth: base64url(16) }),
    }),
    /** Generated on the phone and shared with every paired computer, which all sign with it. */
    vapid: z.object({ publicKey: base64url(65), privateKey: base64url(32) }),
});

/**
 * Single-use key of a QR code, a pairing link or a pairing code. The device proves it holds it
 * during the end-to-end pairing (`e2e.ts`) without sending it: what is on a screen (or in a
 * terminal scrollback) stops working once used, revoked or expired.
 */
export const pairKeySchema = z.string().regex(/^[A-Za-z0-9_-]{22,64}$/, 'invalid pairing key');

/** The computer a device is paired with: one room, one key, all its projects. */
export const computerInfoSchema = z.object({ id: idSchema, name: computerNameSchema });

/** One line of the project list a device receives: enough to pick and to sort by activity. */
export const projectSummarySchema = z.object({
    id: idSchema,
    name: titleSchema,
    /** Last activity of any session, `0` in a project without sessions. */
    lastActivityAt: timestampSchema,
    /** Sessions still in the project. */
    sessions: z.number().int().nonnegative(),
    /** Items waiting for a review, across the project's sessions. */
    pending: z.number().int().nonnegative(),
    /**
     * Sessions in the archive, left out of `sessions`, `pending` and `lastActivityAt`, most
     * recent first: what the archive of the app lists. Daemons before 0.20 do not send it.
     */
    archived: z
        .array(z.object({ id: idSchema, title: titleSchema, lastActivityAt: timestampSchema }))
        .max(200)
        .optional(),
});

/** Whether a copy given to a person takes answers (`open`), is read-only (`expired`) or was taken away. */
export const sharedStateSchema = z.enum(['open', 'expired', 'closed']);

/**
 * What one person answered on their copy of a session, for the owner's devices: by the id of the
 * item in the owner's checklist and the note they wrote.
 */
export const sharedPersonSchema = z.object({
    name: z.string().min(1).max(LIMITS.computerName),
    state: sharedStateSchema,
    expiresAt: timestampSchema,
    /** The checklists of the owner given to this person: only their items get a chip. */
    checklists: z.array(idSchema).max(500).default([]),
    items: z.record(idSchema, z.object({ status: itemStatusSchema, note: noteSchema.optional() })),
    note: noteSchema.optional(),
    /** The person marked their copy done (phase 25.5); the owner sees it, the agent never does. */
    done: z.boolean().optional(),
});

export const sessionSharesSchema = z.object({
    sessionId: idSchema,
    people: z.array(sharedPersonSchema).max(60),
});

export const clientMessageSchema = z.discriminatedUnion('type', [
    /**
     * First message on the sealed channel (`e2e.ts`), which already proved who the device is.
     * `projectId` is the project to follow, when the device already knows one; without it the
     * device only receives the project list.
     */
    z.object({
        type: z.literal('hello'),
        projectId: idSchema.optional(),
        lastSeq: seqSchema.optional(),
        /**
         * The app reads `session.archive` (0.20). An older one fails on a catch-up holding one and
         * would ask for it again and again: it gets a snapshot instead.
         */
        archive: z.boolean().optional(),
        /** The app reads `session.done` (protocol 7), the same way. */
        done: z.boolean().optional(),
    }),
    /** Follows another project of the same computer, without reconnecting. */
    z.object({
        type: z.literal('subscribe'),
        projectId: idSchema,
        lastSeq: seqSchema.optional(),
        archive: z.boolean().optional(),
        done: z.boolean().optional(),
    }),
    z.object({ type: z.literal('op'), op: opSchema }),
    /**
     * Deletes a project of this computer, with its sessions, checklists and reviews. It is not
     * an op: the project leaves the computer's registry. Files on the computer are untouched.
     */
    z.object({ type: z.literal('project.remove'), projectId: idSchema }),
    /**
     * Archives sessions of a project, or takes them out of the archive: the ones listed, or all
     * of them (archiving a project). Not an op of the device: the computer writes it.
     */
    z.object({
        type: z.literal('archive'),
        projectId: idSchema,
        sessionIds: z.array(idSchema).max(500).optional(),
        archived: z.boolean(),
    }),
    /**
     * Stores a screenshot of a session on the computer (protocol 6). It is not an op: the bytes
     * stay out of the log and the state, and a note names the image by `imageId` (`note-text.ts`).
     */
    z.object({
        type: z.literal('image.put'),
        projectId: idSchema,
        sessionId: idSchema,
        imageId: idSchema,
        mime: imageMimeSchema,
        data: imageDataSchema,
    }),
    /** Asks for a screenshot of a project: answered with `image` or `image.missing`. */
    z.object({ type: z.literal('image.get'), projectId: idSchema, imageId: idSchema }),
    /** Sent to the daemon only: never stored in the project state nor forwarded to devices. */
    z.object({ type: z.literal('push.subscribe'), push: pushRegistrationSchema }),
    z.object({ type: z.literal('push.unsubscribe') }),
    /** The app is on screen (`visible`) or in the background: no push while it is on screen. */
    z.object({ type: z.literal('presence'), visible: z.boolean() }),
    /** The device unpairs: the computer forgets its key and its notifications, then closes. */
    z.object({ type: z.literal('device.unpair') }),
    pingSchema,
    pongSchema,
]);

export const serverMessageSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('snapshot'),
        project: projectInfoSchema,
        state: projectStateSchema,
        seq: seqSchema,
        /** `DAEMON_PROTOCOL_VERSION`; absent = 1. */
        protocol: z.number().int().min(1).optional(),
    }),
    /** Ops missed since the client's `lastSeq`; `seq` is the latest server seq. */
    z.object({
        type: z.literal('ops'),
        project: projectInfoSchema,
        ops: z.array(seqOpSchema),
        seq: seqSchema,
        protocol: z.number().int().min(1).optional(),
    }),
    z.object({ type: z.literal('op'), seq: seqSchema, op: opSchema }),
    /**
     * The computer registered this device, at the end of a pairing (by code: once the user said
     * yes on the computer too). The device keeps the pairing and goes on with `hello`.
     */
    z.object({ type: z.literal('paired'), computer: computerInfoSchema }),
    /**
     * Projects of the computer: sent after `hello`, when one is created or removed, when the
     * computer is renamed, and (debounced) as sessions go on.
     */
    z.object({
        type: z.literal('projects'),
        computer: computerInfoSchema,
        projects: z.array(projectSummarySchema),
    }),
    /** Project info changed while connected (the computer was renamed). */
    z.object({ type: z.literal('project'), project: projectInfoSchema }),
    /**
     * What the people a session is shared with answered, for the owner's devices following the
     * project: after the sync, and again when someone answers. An app that does not know it
     * drops it.
     */
    z.object({
        type: z.literal('shares'),
        projectId: idSchema,
        sessions: z.array(sessionSharesSchema),
    }),
    /**
     * The sessions of the project an agent is waiting in for the user's Review done (protocol 8):
     * after the sync and every time it changes. An app that does not know it drops it.
     */
    z.object({
        type: z.literal('waiting'),
        projectId: idSchema,
        sessionIds: z.array(idSchema).max(500),
    }),
    /** The computer stored the screenshot of an `image.put`. */
    z.object({ type: z.literal('image.saved'), imageId: idSchema }),
    /** A screenshot asked for with `image.get`. */
    z.object({
        type: z.literal('image'),
        imageId: idSchema,
        mime: imageMimeSchema,
        data: z.string(),
    }),
    /** The computer has no such screenshot (deleted with its session, or never received). */
    z.object({ type: z.literal('image.missing'), imageId: idSchema }),
    z.object({
        type: z.literal('error'),
        code: errorCodeSchema,
        message: z.string(),
        /** Set when the error refers to a rejected op, so the client can roll it back. */
        opId: idSchema.optional(),
        /** Set when it refers to an `image.put`, which failed. */
        imageId: idSchema.optional(),
    }),
    pingSchema,
    pongSchema,
]);

// ---------------------------------------------------------------------------
// Types

export type ItemStatus = z.infer<typeof itemStatusSchema>;
export type ChecklistKind = z.infer<typeof checklistKindSchema>;
export type ChoicePick = z.infer<typeof choicePickSchema>;
export type ImageMime = z.infer<typeof imageMimeSchema>;
export type SessionValues = z.infer<typeof sessionValuesSchema>;
export type ChecklistValues = z.infer<typeof checklistValuesSchema>;
export type ItemValues = z.infer<typeof itemValuesSchema>;
export type SessionRecord = z.infer<typeof sessionRecordSchema>;
export type ChecklistRecord = z.infer<typeof checklistRecordSchema>;
export type ItemRecord = z.infer<typeof itemRecordSchema>;
export type ProjectState = z.infer<typeof projectStateSchema>;
export type ProjectMeta = z.infer<typeof projectMetaSchema>;
export type ProjectInfo = z.infer<typeof projectInfoSchema>;
export type SharedState = z.infer<typeof sharedStateSchema>;
export type SharedPerson = z.infer<typeof sharedPersonSchema>;
export type SessionShares = z.infer<typeof sessionSharesSchema>;
export type Op = z.infer<typeof opSchema>;
export type OpType = Op['type'];
export type OpOf<T extends OpType> = Extract<Op, { type: T }>;
export type SeqOp = z.infer<typeof seqOpSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type ComputerInfo = z.infer<typeof computerInfoSchema>;
export type ProjectSummary = z.infer<typeof projectSummarySchema>;
export type ClientMessage = z.infer<typeof clientMessageSchema>;
export type PushRegistration = z.infer<typeof pushRegistrationSchema>;
export type ServerMessage = z.infer<typeof serverMessageSchema>;

// ---------------------------------------------------------------------------
// Parsing

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): ParseResult<T> {
    let data = raw;
    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return { ok: false, error: 'invalid JSON' };
        }
    }
    const result = schema.safeParse(data);
    return result.success
        ? { ok: true, value: result.data }
        : { ok: false, error: z.prettifyError(result.error) };
}

/** Validates an incoming client message, given as a JSON string or an already decoded value. */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
    return parseWith(clientMessageSchema, raw);
}

/** Validates an incoming server message, given as a JSON string or an already decoded value. */
export function parseServerMessage(raw: unknown): ParseResult<ServerMessage> {
    return parseWith(serverMessageSchema, raw);
}

export function parseOp(raw: unknown): ParseResult<Op> {
    return parseWith(opSchema, raw);
}

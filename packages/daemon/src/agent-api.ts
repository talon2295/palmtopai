import {
    checklistKindSchema,
    choicePickSchema,
    computerNameSchema,
    doneMarker,
    idSchema,
    LIMITS,
    listSessions,
    sessionNoteMarker,
} from '@palmtopai/protocol';
import type { Context, Hono } from 'hono';
import { z } from 'zod';
import {
    ActionError,
    addItem,
    createChecklist,
    deliverFeedback,
    editItem,
    feedbackView,
    listSessionSummaries,
    openSession,
    removeChecklist,
    removeItem,
    removeSession,
    renameChecklist,
    resolveSession,
    sessionView,
    setMessage,
    shortRef,
    startSession,
    updateSession,
} from './agent-actions';
import type { DoneDeliveries, DoneWaiters } from './done-delivery';
import type { ImageStore } from './images';
import { type NoteDeliveries, noteFingerprints } from './note-delivery';
import { personNameSchema } from './people-store';
import type { ProjectRegistry } from './registry';
import type { RoomTransaction } from './room';
import type { RoomManager } from './rooms';
import { MAX_SHARE_DAYS, type Sharing } from './sharing';

export const BRANCH_HEADER = 'x-palmtop-branch';

const titleSchema = z.string().trim().min(1).max(LIMITS.title);
const textSchema = z.string().trim().min(1).max(LIMITS.text);
/** `''` clears the detail of an item. */
const detailSchema = z.string().trim().max(LIMITS.text);
const refSchema = z.string().min(1).max(26);
/** An item to create: a plain text, or a text with its lines of detail. */
const itemInputSchema = z.union([
    textSchema.transform((text) => ({ text })),
    z.object({ text: textSchema, detail: detailSchema.optional() }),
]);

const feedbackAckShape = {
    items: z
        .array(
            z.object({
                itemId: idSchema,
                status: idSchema,
                note: idSchema,
                text: idSchema.optional(),
            }),
        )
        .max(10_000),
    sessionNote: idSchema.optional(),
    /** The op that wrote the done the agent was told about. */
    done: idSchema.optional(),
};

const bodies = {
    sessionStart: z.object({ title: titleSchema.optional() }),
    session: z.object({ title: titleSchema }),
    checklist: z.object({
        title: titleSchema,
        items: z.array(itemInputSchema).max(200).default([]),
        kind: checklistKindSchema.optional(),
        pick: choicePickSchema.optional(),
    }),
    checklistRename: z.object({ title: titleSchema }),
    item: z.object({
        text: textSchema,
        detail: detailSchema.optional(),
        checklist: refSchema.optional(),
    }),
    itemEdit: z
        .object({ text: textSchema.optional(), detail: detailSchema.optional() })
        .refine((body) => body.text !== undefined || body.detail !== undefined, {
            message: 'nothing to change: pass a text or a detail',
        }),
    feedbackAck: z.object({
        ...feedbackAckShape,
        /** The acknowledgements of the copies shared with other people. */
        shared: z
            .array(z.object({ shareId: idSchema, ...feedbackAckShape }))
            .max(1_000)
            .optional(),
    }),
    /** `to`: the message is for the copy of that person, not for the session. */
    message: z.object({
        message: z.string().trim().max(LIMITS.text),
        to: personNameSchema.optional(),
    }),
    ownerName: z.object({ name: computerNameSchema.nullable(), for: personNameSchema.optional() }),
    share: z.object({
        checklist: refSchema,
        with: personNameSchema,
        days: z.number().int().min(1).max(MAX_SHARE_DAYS).optional(),
    }),
    retest: z.object({
        with: personNameSchema,
        items: z.array(refSchema).max(500).optional(),
        message: z.string().trim().max(LIMITS.text).optional(),
    }),
};

export interface AgentApiOptions {
    registry: ProjectRegistry;
    rooms: RoomManager;
    connectedDevices: (projectId: string) => number;
    /** Deletes a project: registry entry, phones, room and data. */
    removeProject: (projectId: string) => Promise<void>;
    sharing: Sharing;
    /** Which elements of each session's note the agent has read. */
    noteDeliveries: NoteDeliveries;
    /** The screenshots of the projects: what a token in a note stands for. */
    images: ImageStore;
    /** Which done of each session the agent was told about. */
    doneDeliveries: DoneDeliveries;
    /** Wakes the requests of `palmtop wait` when a done, or a removal, might end their wait. */
    doneWaiters: DoneWaiters;
    /** How long a request of `palmtop wait` holds before answering `pending` (default 25 s). */
    waitHoldMs?: number;
}

/** `palmtop wait` asks again after this long without an answer: no request stays open for ever. */
export const DEFAULT_WAIT_HOLD_MS = 25_000;

export class HttpError extends Error {
    constructor(
        readonly status: 400 | 404,
        message: string,
    ) {
        super(message);
    }
}

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
    const result = schema.safeParse(await c.req.json().catch(() => null));
    if (!result.success) throw new HttpError(400, z.prettifyError(result.error));
    return result.data;
}

/**
 * Endpoints used by the `palmtop` CLI on behalf of the agent. The agent starts a session
 * explicitly and then addresses it by its ref, so parallel sessions in the same project never
 * touch each other's checklists: every checklist and item ref is resolved inside the session.
 */
export function registerAgentRoutes(app: Hono, options: AgentApiOptions): void {
    const room = async (c: Context) => {
        const projectId = idSchema.safeParse(c.req.param('projectId'));
        if (!projectId.success || !options.registry.has(projectId.data)) {
            throw new HttpError(404, 'unknown project');
        }
        const loaded = await options.rooms.get(projectId.data);
        if (!loaded) throw new HttpError(404, 'unknown project');
        return loaded;
    };

    const branch = (c: Context) => {
        const value = c.req.header(BRANCH_HEADER)?.trim();
        return value && value.length <= LIMITS.branch ? value : undefined;
    };

    /** Runs a write in one transaction: the session ref is resolved atomically with the ops. */
    const write = async <T>(
        c: Context,
        task: (tx: RoomTransaction, sessionId: string) => Promise<T>,
    ) => {
        const target = await room(c);
        const ref = c.req.param('session') as string;
        const sessionBranch = branch(c);
        return target.transact(async (tx) => task(tx, await openSession(tx, ref, sessionBranch)));
    };

    app.get('/projects/:projectId/status', async (c) => {
        const target = await room(c);
        const info = options.registry.info(target.projectId);
        const ref = c.req.query('session');
        let session: { ref: string; title: string } | null = null;
        if (ref) {
            try {
                const found = resolveSession(target.state, ref);
                session = { ref, title: found.title };
            } catch (error) {
                if (!(error instanceof ActionError)) throw error;
            }
        }
        return c.json({
            project: { id: target.projectId, name: info?.name, rootPath: info?.rootPath },
            seq: target.seq,
            connectedDevices: options.connectedDevices(target.projectId),
            sessions: listSessionSummaries(target.state).length,
            session,
        });
    });

    /** Every project of this computer, most recently active first. */
    app.get('/projects', async (c) => {
        const projects = [];
        for (const projectId of options.registry.projectIds()) {
            const info = options.registry.info(projectId);
            const loaded = await options.rooms.get(projectId);
            if (!info || !loaded) continue;
            const sessions = listSessionSummaries(loaded.state);
            projects.push({
                id: projectId,
                name: info.name,
                rootPath: info.rootPath,
                sessions: sessions.length,
                connectedDevices: options.connectedDevices(projectId),
                lastActivityAt: sessions.reduce(
                    (max, session) => Math.max(max, session.lastActivityAt),
                    0,
                ),
            });
        }
        projects.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return c.json({ projects });
    });

    app.delete('/projects/:projectId', async (c) => {
        const target = await room(c);
        const info = options.registry.info(target.projectId);
        const sessions = listSessionSummaries(target.state).length;
        await options.removeProject(target.projectId);
        return c.json({
            id: target.projectId,
            name: info?.name,
            rootPath: info?.rootPath,
            sessions,
        });
    });

    /** Sessions of every project of this computer, most recently active first. */
    app.get('/sessions', async (c) => {
        const sessions = [];
        for (const projectId of options.registry.projectIds()) {
            const info = options.registry.info(projectId);
            const loaded = await options.rooms.get(projectId);
            if (!info || !loaded) continue;
            for (const session of listSessionSummaries(loaded.state)) {
                sessions.push({
                    ...session,
                    project: { id: projectId, name: info.name, rootPath: info.rootPath },
                });
            }
        }
        sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
        return c.json({ sessions });
    });

    app.get('/projects/:projectId/sessions', async (c) => {
        const target = await room(c);
        return c.json({ sessions: listSessionSummaries(target.state) });
    });

    app.post('/projects/:projectId/sessions', async (c) => {
        const { title } = await parseBody(c, bodies.sessionStart);
        const target = await room(c);
        const sessionBranch = branch(c);
        const view = await target.transact((tx) =>
            startSession(tx, {
                ...(title && { title }),
                ...(sessionBranch && { branch: sessionBranch }),
            }),
        );
        return c.json(view, 201);
    });

    const base = '/projects/:projectId/sessions/:session';

    app.get(base, async (c) => {
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        return c.json(
            sessionView(target.state, session.id, await options.images.index(target.projectId)),
        );
    });

    app.patch(base, async (c) => {
        const body = await parseBody(c, bodies.session);
        const view = await write(c, async (tx, sessionId) => {
            await updateSession(tx, sessionId, body);
            return sessionView(tx.state, sessionId);
        });
        return c.json(view);
    });

    app.delete(base, async (c) => {
        const target = await room(c);
        const ref = c.req.param('session');
        return c.json(await target.transact((tx) => removeSession(tx, ref)));
    });

    /** Read-only: the feedback stays new until the CLI acknowledges it with `feedback/ack`. */
    app.get(`${base}/feedback`, async (c) => {
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        const view = feedbackView(
            target.state,
            session.id,
            options.noteDeliveries.get(target.projectId, session.id),
            await options.images.index(target.projectId),
            options.doneDeliveries.get(target.projectId, session.id),
        );
        const shared = await options.sharing.sharedFeedback(target.projectId, session.id);
        if (!shared) return c.json(view);
        return c.json({ ...view, hasNew: view.hasNew || shared.hasNew, shared });
    });

    app.post(`${base}/feedback/ack`, async (c) => {
        const { shared, ...ack } = await parseBody(c, bodies.feedbackAck);
        const target = await room(c);
        const ref = c.req.param('session');
        const sessionId = resolveSession(target.state, ref).id;
        const { delivered, read } = await target.transact(async (tx) => {
            const session = resolveSession(tx.state, ref);
            const delivered = await deliverFeedback(tx, session.id, ack);
            // The elements are remembered only when the note is still the one the agent was
            // given: if it changed in between, they are all told again next time.
            const read =
                ack.sessionNote !== undefined &&
                sessionNoteMarker(tx.state, session.id) === ack.sessionNote
                    ? noteFingerprints(session.id, session.note ?? '')
                    : null;
            return { delivered, read };
        });
        if (read) await options.noteDeliveries.set(target.projectId, sessionId, read);
        // The done is remembered only while it is the one the agent was told about: a new one
        // (the user pressed again) is still waiting.
        if (ack.done !== undefined && doneMarker(target.state, sessionId) === ack.done) {
            await options.doneDeliveries.set(target.projectId, sessionId, ack.done);
            // Read: the done is spent, and the button of the devices comes back. A newer tap (another
            // marker) is not the one the agent read and stays.
            await target.transact(async (tx) => {
                if (doneMarker(tx.state, sessionId) === ack.done) {
                    await tx.submit('session.done', sessionId, { done: false });
                }
            });
        }
        if (shared && shared.length > 0) {
            await options.sharing.acknowledge(target.projectId, sessionId, shared);
        }
        return c.json(delivered);
    });

    /**
     * `palmtop wait`: answers `done` when the user marked the session done and the agent was not
     * told yet, `pending` after a while (the CLI asks again), `superseded` when another process
     * waits for the session now, and fails with 404 once the session or its project is gone.
     * Nothing else is in the answer: what the user wrote reaches the agent only with `feedback`.
     * `client` names the process (one wait for each session: the last one to start is the one);
     * `claim=1` is its first question.
     */
    app.get(`${base}/wait`, async (c) => {
        // The CLI may ask for less (the last stretch before its own end), never for more.
        const asked = Number(c.req.query('hold'));
        const limit = options.waitHoldMs ?? DEFAULT_WAIT_HOLD_MS;
        const hold = Number.isFinite(asked) && asked > 0 ? Math.min(asked, limit) : limit;
        const deadline = Date.now() + hold;
        const { signal } = c.req.raw;
        const client = c.req.query('client') ?? '';
        // Only the first question of the request can take the place: a wake-up must not give it back.
        let claiming = c.req.query('claim') === '1';
        let key = '';
        let keep = false;
        try {
            for (;;) {
                const target = await room(c);
                const session = resolveSession(target.state, c.req.param('session'));
                key = `${target.projectId}/${session.id}`;
                if (client && !options.doneWaiters.hold(key, client, claiming)) {
                    return c.json({ status: 'superseded' });
                }
                claiming = false;
                const marker = doneMarker(target.state, session.id);
                if (
                    marker !== null &&
                    marker !== options.doneDeliveries.get(target.projectId, session.id)
                ) {
                    return c.json({
                        status: 'done',
                        session: { ref: shortRef(session.id), title: session.title },
                    });
                }
                const left = deadline - Date.now();
                if (left <= 0 || signal.aborted) {
                    keep = !signal.aborted;
                    return c.json({ status: 'pending' });
                }
                keep = true;
                await options.doneWaiters.next(left, signal);
                keep = false;
                if (client && !options.doneWaiters.isHolder(key, client)) {
                    return c.json({ status: 'superseded' });
                }
            }
        } finally {
            // Between two questions the place stays (the process is about to ask again); it is
            // freed when the process is done, gone or cut off.
            if (client && key && !keep) options.doneWaiters.release(key, client);
        }
    });

    /** The sessions an agent is waiting for the user's Review done in, on this computer. */
    app.get('/waits', async (c) => {
        const waits = [];
        for (const key of options.doneWaiters.waiting()) {
            const [projectId, sessionId] = key.split('/') as [string, string];
            const info = options.registry.info(projectId);
            const loaded = await options.rooms.get(projectId);
            const session = loaded && listSessions(loaded.state).find((s) => s.id === sessionId);
            if (!info || !session) continue;
            waits.push({
                project: { id: projectId, name: info.name },
                session: { ref: shortRef(session.id), title: session.title },
            });
        }
        return c.json({ waits });
    });

    /** `''` removes the message; with `to`, it is the message of a person's copy. */
    app.put(`${base}/message`, async (c) => {
        const { message, to } = await parseBody(c, bodies.message);
        if (to !== undefined) {
            const target = await room(c);
            const session = resolveSession(target.state, c.req.param('session'));
            return c.json(
                await options.sharing.message({
                    projectId: target.projectId,
                    sessionId: session.id,
                    personName: to,
                    message,
                }),
            );
        }
        return c.json(await write(c, (tx, sessionId) => setMessage(tx, sessionId, message)));
    });

    app.post(`${base}/checklists`, async (c) => {
        const body = await parseBody(c, bodies.checklist);
        return c.json(await write(c, (tx, sessionId) => createChecklist(tx, sessionId, body)), 201);
    });

    app.patch(`${base}/checklists/:ref`, async (c) => {
        const { title } = await parseBody(c, bodies.checklistRename);
        const ref = c.req.param('ref');
        return c.json(
            await write(c, (tx, sessionId) => renameChecklist(tx, sessionId, ref, title)),
        );
    });

    app.delete(`${base}/checklists/:ref`, async (c) => {
        const ref = c.req.param('ref');
        return c.json(await write(c, (tx, sessionId) => removeChecklist(tx, sessionId, ref)));
    });

    app.post(`${base}/items`, async (c) => {
        const body = await parseBody(c, bodies.item);
        return c.json(
            await write(c, (tx, sessionId) =>
                addItem(tx, sessionId, {
                    text: body.text,
                    ...(body.detail !== undefined && { detail: body.detail }),
                    ...(body.checklist && { checklist: body.checklist }),
                }),
            ),
            201,
        );
    });

    app.patch(`${base}/items/:ref`, async (c) => {
        const body = await parseBody(c, bodies.itemEdit);
        const ref = c.req.param('ref');
        return c.json(await write(c, (tx, sessionId) => editItem(tx, sessionId, ref, body)));
    });

    app.delete(`${base}/items/:ref`, async (c) => {
        const ref = c.req.param('ref');
        return c.json(await write(c, (tx, sessionId) => removeItem(tx, sessionId, ref)));
    });

    // -- sharing with other people (a copy of a checklist for each of them) ------------------

    /** Every copy given to someone, on any project of this computer. */
    app.get('/shares', async (c) => c.json({ shares: await options.sharing.list() }));

    app.post(`${base}/shares`, async (c) => {
        const body = await parseBody(c, bodies.share);
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        return c.json(
            await options.sharing.share({
                room: target,
                sessionId: session.id,
                checklistRef: body.checklist,
                personName: body.with,
                ...(body.days !== undefined && { days: body.days }),
            }),
            201,
        );
    });

    /** The name the copies of this session give their owner: for all of them, or for one person. */
    app.put(`${base}/owner-name`, async (c) => {
        const body = await parseBody(c, bodies.ownerName);
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        const { copies } = await options.sharing.setOwnerName({
            projectId: target.projectId,
            sessionId: session.id,
            name: body.name,
            ...(body.for !== undefined && { personName: body.for }),
        });
        return c.json({ name: body.name, for: body.for ?? null, copies });
    });

    app.delete(`${base}/shares/:person`, async (c) => {
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        return c.json(
            await options.sharing.close({
                projectId: target.projectId,
                sessionId: session.id,
                personName: c.req.param('person'),
            }),
        );
    });

    /** What taking a checklist out of the copy of a person would delete (nothing is changed). */
    app.get(`${base}/shares/:person/checklists/:checklist`, async (c) => {
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        return c.json(
            await options.sharing.previewRemoval({
                projectId: target.projectId,
                sessionId: session.id,
                personName: c.req.param('person'),
                checklistRef: c.req.param('checklist'),
            }),
        );
    });

    app.delete(`${base}/shares/:person/checklists/:checklist`, async (c) => {
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        return c.json(
            await options.sharing.removeChecklist({
                projectId: target.projectId,
                sessionId: session.id,
                personName: c.req.param('person'),
                checklistRef: c.req.param('checklist'),
            }),
        );
    });

    app.post(`${base}/retest`, async (c) => {
        const body = await parseBody(c, bodies.retest);
        const target = await room(c);
        const session = resolveSession(target.state, c.req.param('session'));
        return c.json(
            await options.sharing.retest({
                room: target,
                sessionId: session.id,
                personName: body.with,
                ...(body.items && { itemRefs: body.items }),
                ...(body.message !== undefined && { message: body.message }),
            }),
        );
    });
}

/** Maps domain and validation errors to JSON responses; anything else stays a 500. */
export function agentErrorResponse(error: unknown, c: Context): Response | null {
    if (error instanceof ActionError || error instanceof HttpError) {
        return c.json({ error: error.message }, error.status);
    }
    return null;
}

import { compareStamps, type Stamp } from './clock';
import type { Op, ProjectState, SessionRecord } from './schemas';

/**
 * A replicated record. Every field carries the stamp of the op that last wrote it;
 * a write wins only if its stamp is strictly greater (last-write-wins per field).
 */
interface LwwRecord<V> {
    id: string;
    values: Partial<V>;
    clocks: Partial<Record<keyof V, Stamp>>;
    last: { stamp: Stamp; ts: number } | null;
    removed: Stamp | null;
}

export function createProjectState(projectId: string): ProjectState {
    return { projectId, lamport: 0, sessions: {}, checklists: {}, items: {} };
}

function emptyRecord<V>(id: string): LwwRecord<V> {
    return { id, values: {}, clocks: {}, last: null, removed: null };
}

/** `touch: false` merges bookkeeping fields without changing the record's updatedAt/updatedBy. */
function mergeValues<V, R extends LwwRecord<V>>(
    record: R,
    fields: Partial<V>,
    stamp: Stamp,
    ts: number,
    { touch = true } = {},
): R {
    if (record.removed) return record;

    let values = record.values;
    let clocks = record.clocks;
    for (const key of Object.keys(fields) as Array<keyof V>) {
        const value = fields[key];
        if (value === undefined) continue;
        const current = clocks[key];
        if (current && compareStamps(stamp, current) <= 0) continue;
        if (values === record.values) {
            values = { ...values };
            clocks = { ...clocks };
        }
        values[key] = value;
        clocks[key] = stamp;
    }

    const isNewest = touch && (!record.last || compareStamps(stamp, record.last.stamp) > 0);
    if (values === record.values && !isNewest) return record;
    return { ...record, values, clocks, last: isNewest ? { stamp, ts } : record.last };
}

/**
 * Tombstone with the highest removal stamp. `sessionId` is kept so that removing the session
 * later finds tombstones written before the records themselves arrived.
 */
function removeRecord<V extends { sessionId?: string }>(
    record: LwwRecord<V> | undefined,
    id: string,
    stamp: Stamp,
    sessionId?: string,
): LwwRecord<V> {
    if (record?.removed && compareStamps(record.removed, stamp) >= 0) return record;
    const values = (sessionId ? { sessionId } : {}) as Partial<V>;
    return { ...emptyRecord<V>(id), values, removed: stamp };
}

function withRecord<R>(map: Record<string, R>, id: string, record: R): Record<string, R> {
    return map[id] === record ? map : { ...map, [id]: record };
}

function touchSession(
    sessions: Record<string, SessionRecord>,
    sessionId: string,
    ts: number,
): Record<string, SessionRecord> {
    const current = sessions[sessionId];
    if (current?.removed || (current && current.lastActivityAt >= ts)) return sessions;
    const base = current ?? {
        ...emptyRecord<SessionRecord['values']>(sessionId),
        lastActivityAt: 0,
    };
    return { ...sessions, [sessionId]: { ...base, lastActivityAt: ts } as SessionRecord };
}

/**
 * Tombstones every checklist and item of a removed session with the session's removal stamp.
 * Run after each op of a removed session, so records written by ops that arrive after the
 * removal end up exactly as if they had arrived before it.
 */
function purgeSession(state: ProjectState, sessionId: string, stamp: Stamp): ProjectState {
    let checklists = state.checklists;
    const removedChecklists = new Set<string>();
    for (const record of Object.values(state.checklists)) {
        if (record.values.sessionId !== sessionId) continue;
        removedChecklists.add(record.id);
        const removed = removeRecord(record, record.id, stamp, sessionId);
        if (removed === record) continue;
        if (checklists === state.checklists) checklists = { ...checklists };
        checklists[record.id] = removed;
    }
    let items = state.items;
    for (const record of Object.values(state.items)) {
        const { sessionId: itemSession, checklistId } = record.values;
        // Items written before items recorded their session are found through their checklist.
        const inSession =
            itemSession === sessionId ||
            (itemSession === undefined &&
                checklistId !== undefined &&
                removedChecklists.has(checklistId));
        if (!inSession) continue;
        const removed = removeRecord(record, record.id, stamp, sessionId);
        if (removed === record) continue;
        if (items === state.items) items = { ...items };
        items[record.id] = removed;
    }
    return checklists === state.checklists && items === state.items
        ? state
        : { ...state, checklists, items };
}

/**
 * Pure, deterministic reducer. Ops commute: any delivery order of the same set of ops
 * (including duplicates) yields the same state. Ops must be validated before being applied.
 */
export function apply(state: ProjectState, op: Op): ProjectState {
    const next = applyOp(state, op);
    const removed = next.sessions[op.sessionId]?.removed;
    return removed ? purgeSession(next, op.sessionId, removed) : next;
}

function applyOp(state: ProjectState, op: Op): ProjectState {
    if (op.projectId !== state.projectId) {
        throw new Error(`op ${op.opId} belongs to project ${op.projectId}, not ${state.projectId}`);
    }

    const stamp: Stamp = { lamport: op.clock.lamport, deviceId: op.clock.deviceId, opId: op.opId };
    // Archiving and marking done are no activity: the session keeps its place in the list.
    const sessions =
        op.type === 'session.archive' || op.type === 'session.done'
            ? state.sessions
            : touchSession(state.sessions, op.sessionId, op.ts);
    const lamport = Math.max(state.lamport, op.clock.lamport);
    const next: ProjectState =
        sessions === state.sessions && lamport === state.lamport
            ? state
            : { ...state, sessions, lamport };

    switch (op.type) {
        case 'session.upsert': {
            const p = op.payload;
            const record = next.sessions[op.sessionId] as SessionRecord;
            const merged = mergeValues(
                record,
                {
                    title: p.title,
                    branch: p.branch,
                    startedAt: p.startedAt,
                },
                stamp,
                op.ts,
            );
            return merged === record
                ? next
                : { ...next, sessions: withRecord(next.sessions, op.sessionId, merged) };
        }

        case 'session.note':
        case 'session.message': {
            const record = next.sessions[op.sessionId] as SessionRecord;
            const fields: Partial<SessionRecord['values']> =
                op.type === 'session.note'
                    ? { note: op.payload.note }
                    : { message: op.payload.message, messageAt: op.ts };
            const merged = mergeValues(record, fields, stamp, op.ts);
            return merged === record
                ? next
                : { ...next, sessions: withRecord(next.sessions, op.sessionId, merged) };
        }

        case 'session.archive':
        case 'session.done': {
            // A record without activity when it comes first: the ops still commute, and until
            // its title arrives there is no session to list.
            const record =
                next.sessions[op.sessionId] ??
                ({ ...emptyRecord(op.sessionId), lastActivityAt: 0 } as SessionRecord);
            if (record.removed) return next;
            const fields: Partial<SessionRecord['values']> =
                op.type === 'session.archive'
                    ? { archived: op.payload.archived }
                    : { done: op.payload.done };
            const merged = mergeValues(record, fields, stamp, op.ts);
            return merged === record
                ? next
                : { ...next, sessions: withRecord(next.sessions, op.sessionId, merged) };
        }

        case 'session.remove': {
            const current = next.sessions[op.sessionId];
            const removed = removeRecord(current, op.sessionId, stamp);
            if (removed === current) return next;
            // A tombstone keeps no activity: the same whatever the ops seen before it.
            const tombstone = { ...removed, lastActivityAt: 0 } as SessionRecord;
            return { ...next, sessions: { ...next.sessions, [op.sessionId]: tombstone } };
        }

        case 'checklist.create':
        case 'checklist.update': {
            const p = op.payload;
            const record = next.checklists[p.checklistId] ?? emptyRecord(p.checklistId);
            // `kind`, `pick` and `origin` are only written at creation: a list never changes what it is.
            const fields =
                op.type === 'checklist.create'
                    ? {
                          sessionId: op.sessionId,
                          title: op.payload.title,
                          createdAt: op.ts,
                          kind: op.payload.kind,
                          pick: op.payload.pick,
                          origin: op.payload.origin,
                      }
                    : { sessionId: op.sessionId, title: p.title };
            const merged = mergeValues(record, fields, stamp, op.ts);
            return { ...next, checklists: withRecord(next.checklists, p.checklistId, merged) };
        }

        case 'checklist.remove': {
            const { checklistId } = op.payload;
            const removed = removeRecord(
                next.checklists[checklistId],
                checklistId,
                stamp,
                op.sessionId,
            );
            return { ...next, checklists: withRecord(next.checklists, checklistId, removed) };
        }

        case 'item.add': {
            const p = op.payload;
            const record = next.items[p.itemId] ?? emptyRecord(p.itemId);
            const merged = mergeValues(
                record,
                {
                    checklistId: p.checklistId,
                    sessionId: op.sessionId,
                    text: p.text,
                    detail: p.detail,
                    status: p.status ?? null,
                    note: p.note ?? null,
                    order: p.order,
                    origin: p.origin,
                },
                stamp,
                op.ts,
            );
            return { ...next, items: withRecord(next.items, p.itemId, merged) };
        }

        case 'item.update': {
            const p = op.payload;
            const record = next.items[p.itemId] ?? emptyRecord(p.itemId);
            const merged = mergeValues(
                record,
                {
                    sessionId: op.sessionId,
                    text: p.text,
                    detail: p.detail,
                    status: p.status,
                    // Resetting the status wipes the note with the same stamp.
                    note: p.status === null ? null : p.note,
                    order: p.order,
                },
                stamp,
                op.ts,
            );
            return { ...next, items: withRecord(next.items, p.itemId, merged) };
        }

        case 'item.remove': {
            const { itemId } = op.payload;
            const removed = removeRecord(next.items[itemId], itemId, stamp, op.sessionId);
            return { ...next, items: withRecord(next.items, itemId, removed) };
        }

        case 'feedback.deliver': {
            let items = next.items;
            for (const { itemId, status, note, text } of op.payload.items) {
                const record = items[itemId] ?? emptyRecord(itemId);
                const merged = mergeValues(
                    record,
                    {
                        sessionId: op.sessionId,
                        delivered: { status, note, ...(text !== undefined && { text }) },
                    },
                    stamp,
                    op.ts,
                    {
                        touch: false,
                    },
                );
                if (merged === items[itemId]) continue;
                if (items === next.items) items = { ...items };
                items[itemId] = merged;
            }
            let sessions = next.sessions;
            const { sessionNote } = op.payload;
            if (sessionNote !== undefined) {
                const record = sessions[op.sessionId] as SessionRecord;
                const merged = mergeValues(record, { deliveredNote: sessionNote }, stamp, op.ts, {
                    touch: false,
                });
                sessions = withRecord(sessions, op.sessionId, merged);
            }
            return items === next.items && sessions === next.sessions
                ? next
                : { ...next, items, sessions };
        }
    }
}

export function applyAll(state: ProjectState, ops: Iterable<Op>): ProjectState {
    let current = state;
    for (const op of ops) current = apply(current, op);
    return current;
}

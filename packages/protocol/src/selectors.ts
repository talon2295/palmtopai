import { isReservedDeviceId } from './ids';
import { screenshotIds } from './note-text';
import type {
    ChecklistKind,
    ChecklistRecord,
    ChoicePick,
    ItemRecord,
    ItemStatus,
    ProjectState,
} from './schemas';

export interface Session {
    id: string;
    projectId: string;
    title: string;
    branch?: string;
    startedAt: number;
    lastActivityAt: number;
    /** The user's note for the agent, when not empty. */
    note?: string;
    /** The agent's message for the user, when not empty, with the time it was set. */
    message?: { text: string; at: number };
    /** In the archive: out of the Dashboard and its counts. */
    archived?: boolean;
    /** The user marked the review of the session finished (phase 25). */
    done?: boolean;
}

export interface Checklist {
    id: string;
    sessionId: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    /** `checks` unless the agent asked a question with options (`choice`). */
    kind: ChecklistKind;
    /** For a choice: how many of its options can be chosen. */
    pick: ChoicePick;
    /** In a copy shared with a guest: the checklist it was copied from. */
    origin?: string;
}

export interface Item {
    id: string;
    checklistId: string;
    text: string;
    /** Present only when not empty: the extra lines of an option. */
    detail?: string;
    /** Absent = not reviewed yet. */
    status?: ItemStatus;
    /** Present only on reviewed items with a non-empty note. */
    note?: string;
    order: number;
    updatedAt: number;
    updatedBy: string;
    /** Added on a device by the user (not by the agent). */
    addedByUser: boolean;
    /** In a copy shared with a guest: the item it was copied from. */
    origin?: string;
}

function compareIds(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/**
 * Selectors expose only complete, non-removed entities. Partial records exist when ops
 * arrive out of order (e.g. an update before its add) and stay hidden until complete.
 */
export function listSessions(state: ProjectState): Session[] {
    const sessions: Session[] = [];
    for (const record of Object.values(state.sessions)) {
        if (record.removed) continue;
        const { title, branch, startedAt, note, message, messageAt, archived, done } =
            record.values;
        if (title === undefined || startedAt === undefined) continue;
        sessions.push({
            id: record.id,
            projectId: state.projectId,
            title,
            ...(branch !== undefined && { branch }),
            startedAt,
            lastActivityAt: record.lastActivityAt,
            ...(note && { note }),
            ...(message && { message: { text: message, at: messageAt ?? 0 } }),
            ...(archived && { archived: true }),
            ...(done && { done: true }),
        });
    }
    return sessions.sort((a, b) => b.lastActivityAt - a.lastActivityAt || compareIds(a.id, b.id));
}

function toChecklist(record: ChecklistRecord | undefined): Checklist | null {
    if (!record || record.removed || !record.last) return null;
    const { sessionId, title, createdAt, kind, pick, origin } = record.values;
    if (sessionId === undefined || title === undefined || createdAt === undefined) return null;
    return {
        id: record.id,
        sessionId,
        title,
        createdAt,
        updatedAt: record.last.ts,
        kind: kind ?? 'checks',
        pick: pick ?? 'one',
        ...(origin && { origin }),
    };
}

export function getChecklist(state: ProjectState, checklistId: string): Checklist | null {
    return toChecklist(state.checklists[checklistId]);
}

export function listChecklists(state: ProjectState, sessionId: string): Checklist[] {
    const checklists: Checklist[] = [];
    for (const record of Object.values(state.checklists)) {
        const checklist = toChecklist(record);
        if (checklist?.sessionId === sessionId) checklists.push(checklist);
    }
    return checklists.sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
}

function toItem(record: ItemRecord | undefined): Item | null {
    if (!record || record.removed || !record.last) return null;
    const { checklistId, text, detail, status, note, order, origin } = record.values;
    if (checklistId === undefined || text === undefined || order === undefined) return null;
    return {
        id: record.id,
        checklistId,
        text,
        ...(detail && { detail }),
        // A note can survive a concurrent status reset: unreviewed items never show one.
        ...(status != null && { status }),
        ...(status != null && note && { note }),
        order,
        updatedAt: record.last.ts,
        updatedBy: record.last.stamp.deviceId,
        addedByUser: isAddedByUser(record),
        ...(origin && { origin }),
    };
}

/** The checklist of an item is only written by `item.add`: its author added the item. */
export function isAddedByUser(record: ItemRecord | undefined): boolean {
    const author = record?.clocks.checklistId?.deviceId;
    return author !== undefined && !isReservedDeviceId(author);
}

/** A visible item: complete, not removed, and belonging to a visible checklist. */
export function getItem(state: ProjectState, itemId: string): Item | null {
    const item = toItem(state.items[itemId]);
    return item && getChecklist(state, item.checklistId) ? item : null;
}

/** Items of a visible checklist, sorted by `order`. Items of a removed checklist are hidden. */
export function listItems(state: ProjectState, checklistId: string): Item[] {
    if (!getChecklist(state, checklistId)) return [];
    const items: Item[] = [];
    for (const record of Object.values(state.items)) {
        const item = toItem(record);
        if (item?.checklistId === checklistId) items.push(item);
    }
    return items.sort((a, b) => a.order - b.order || compareIds(a.id, b.id));
}

export interface ProjectSummaryCounts {
    /** Last activity of any session not archived, `0` without one. */
    lastActivityAt: number;
    /** Sessions not archived. */
    sessions: number;
    /** Items of visible checklists still waiting for a review, in sessions not archived. */
    pending: number;
    /** Sessions in the archive, most recent first. */
    archived: Array<{ id: string; title: string; lastActivityAt: number }>;
}

/** At most this many archived sessions of a project go with its summary. */
export const MAX_ARCHIVED_IN_SUMMARY = 200;

/**
 * Items of a list still waiting for the user. A question stops counting as soon as it has one
 * answer: the options left are alternatives nobody has to mark, not work to do.
 */
export function pendingItems<T extends { status?: ItemStatus }>(
    list: { kind: ChecklistKind },
    items: readonly T[],
): T[] {
    if (list.kind === 'choice' && items.some((item) => item.status !== undefined)) return [];
    return items.filter((item) => item.status === undefined);
}

/**
 * What a list adds to "left to review" on the devices: a question is **one** thing to answer,
 * however many options it offers, and stops counting once it has an answer.
 */
export function pendingReviews<T extends { status?: ItemStatus }>(
    list: { kind: ChecklistKind },
    items: readonly T[],
): number {
    const waiting = pendingItems(list, items).length;
    return list.kind === 'choice' ? Math.min(waiting, 1) : waiting;
}

/** What a device shows for a project it is not following: activity and work left to review. */
export function summarizeProject(state: ProjectState): ProjectSummaryCounts {
    const all = listSessions(state);
    const sessions = all.filter((session) => !session.archived);
    const sessionIds = new Set(sessions.map((session) => session.id));
    const byChecklist = new Map<string, Item[]>();
    for (const record of Object.values(state.items)) {
        const item = toItem(record);
        if (!item) continue;
        const list = byChecklist.get(item.checklistId);
        if (list) list.push(item);
        else byChecklist.set(item.checklistId, [item]);
    }
    let pending = 0;
    for (const record of Object.values(state.checklists)) {
        const checklist = toChecklist(record);
        if (!checklist || !sessionIds.has(checklist.sessionId)) continue;
        pending += pendingReviews(checklist, byChecklist.get(checklist.id) ?? []);
    }
    return {
        // `listSessions` sorts by last activity: the first one is the most recent.
        lastActivityAt: sessions[0]?.lastActivityAt ?? 0,
        sessions: sessions.length,
        pending,
        archived: all
            .filter((session) => session.archived)
            .slice(0, MAX_ARCHIVED_IN_SUMMARY)
            .map(({ id, title, lastActivityAt }) => ({ id, title, lastActivityAt })),
    };
}

export interface ReviewMarker {
    /** Id of the op that last wrote the status. */
    status: string;
    /** Id of the op that last wrote the note. */
    note: string;
    /** Items added by the user: id of the op that last wrote the text. */
    text?: string;
}

/** What `feedback.deliver` records for an item: which writes of its review were delivered. */
export function reviewMarker(state: ProjectState, itemId: string): ReviewMarker | null {
    const record = state.items[itemId];
    const clocks = record?.clocks;
    if (!clocks?.status || !clocks.note) return null;
    return {
        status: clocks.status.opId,
        note: clocks.note.opId,
        ...(isAddedByUser(record) && clocks.text && { text: clocks.text.opId }),
    };
}

/**
 * True for an item the user added whose text, as last written by the user, has not been
 * delivered to the agent. Text rewritten by the agent is not news for the agent.
 */
export function hasUndeliveredAddition(state: ProjectState, itemId: string): boolean {
    const record = state.items[itemId];
    const text = record?.clocks.text;
    if (!isAddedByUser(record) || !text || isReservedDeviceId(text.deviceId)) return false;
    return record?.values.delivered?.text !== text.opId;
}

/** Id of the op that wrote the session note, when the note is not empty. */
export function sessionNoteMarker(state: ProjectState, sessionId: string): string | null {
    const record = state.sessions[sessionId];
    if (!record?.values.note || !record.clocks.note) return null;
    return record.clocks.note.opId;
}

/** Id of the op that marked the session done, while it is: what the agent is told it received. */
export function doneMarker(state: ProjectState, sessionId: string): string | null {
    const record = state.sessions[sessionId];
    if (!record || record.removed || !record.values.done || !record.clocks.done) return null;
    return record.clocks.done.opId;
}

/** True when the user's note changed since it was last delivered to the agent. */
export function hasUndeliveredSessionNote(state: ProjectState, sessionId: string): boolean {
    const marker = sessionNoteMarker(state, sessionId);
    return marker !== null && state.sessions[sessionId]?.values.deliveredNote !== marker;
}

/** True when status or note of the item changed since its review was last delivered. */
export function hasUndeliveredReview(state: ProjectState, itemId: string): boolean {
    const marker = reviewMarker(state, itemId);
    const delivered = state.items[itemId]?.values.delivered;
    return (
        marker !== null && (marker.status !== delivered?.status || marker.note !== delivered?.note)
    );
}

/** The screenshots the notes of a project name: its sessions' notes and its items' notes. */
export function namedScreenshots(state: ProjectState): Set<string> {
    const named = new Set<string>();
    const add = (text: string | null | undefined) => {
        if (text) for (const id of screenshotIds(text)) named.add(id);
    };
    for (const record of Object.values(state.sessions)) {
        if (!record.removed) add(record.values.note);
    }
    for (const record of Object.values(state.items)) {
        if (!record.removed) add(record.values.note);
    }
    return named;
}

import { createHash } from 'node:crypto';
import {
    type ChecklistKind,
    type ChoicePick,
    createId,
    doneMarker,
    getChecklist,
    hasUndeliveredAddition,
    hasUndeliveredReview,
    hasUndeliveredSessionNote,
    type ItemStatus,
    LIMITS,
    listChecklists,
    listItems,
    listSessions,
    type ProjectState,
    pendingItems,
    type ReviewMarker,
    renderNote,
    replaceScreenshots,
    reviewMarker,
    type Session,
    screenshotIds,
    sessionNoteMarker,
    splitNote,
} from '@palmtopai/protocol';
import type { StoredImage } from './images';
import { type NoteFingerprints, noteFingerprint } from './note-delivery';
import type { RoomTransaction, SubmitResult } from './room';

/** Characters shown for a reference. */
export const REF_LENGTH = 6;
const MIN_REF_LENGTH = 4;
const FULL_REF_LENGTH = 26;
const REF_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const REF_PATTERN = /^[0-9a-hjkmnp-tv-z]+$/;

export class ActionError extends Error {
    override name = 'ActionError';
    readonly status: 400 | 404 | 409;

    constructor(status: 400 | 404 | 409, message: string) {
        super(message);
        this.status = status;
    }
}

/**
 * Stable reference derived from a hash of the id. ULIDs created in the same millisecond differ
 * only in their last characters, so their suffixes would look alike (`jd0h2v` / `jd0h2x`);
 * hashed references are visually distinct. Longer prefixes disambiguate collisions.
 */
export function refOf(id: string, length = FULL_REF_LENGTH): string {
    const digest = createHash('sha256').update(id).digest();
    let ref = '';
    for (let i = 0; i < length; i++) ref += REF_ALPHABET[(digest[i] as number) % 32];
    return ref;
}

export function shortRef(id: string): string {
    return refOf(id, REF_LENGTH);
}

/** Accepts a reference prefix of at least 4 characters (case-insensitive) or the full id. */
export function resolveRef<T extends { id: string }>(
    candidates: T[],
    ref: string,
    kind: string,
    scope = 'this session',
): T {
    const trimmed = ref.trim();
    const exact = candidates.find((candidate) => candidate.id === trimmed.toUpperCase());
    if (exact) return exact;

    const normalized = trimmed.toLowerCase();
    if (
        normalized.length < MIN_REF_LENGTH ||
        normalized.length > FULL_REF_LENGTH ||
        !REF_PATTERN.test(normalized)
    ) {
        throw new ActionError(400, `invalid ${kind} ref "${ref}"`);
    }
    const matches = candidates.filter((candidate) => refOf(candidate.id).startsWith(normalized));
    if (matches.length === 0) throw new ActionError(404, `no ${kind} "${ref}" in ${scope}`);
    if (matches.length > 1) {
        throw new ActionError(409, `${kind} ref "${ref}" is ambiguous, use more characters`);
    }
    return matches[0] as T;
}

// -- views returned to the CLI (never contain tokens) -------------------------------------------

export interface ItemView {
    ref: string;
    id: string;
    text: string;
    /** Extra lines under the text, on the options of a choice. */
    detail?: string;
    status?: ItemStatus;
    note?: string;
    order: number;
    /** Added by the user on a device. */
    addedByUser?: true;
}

export interface ChecklistView {
    ref: string;
    id: string;
    title: string;
    /** `checks` for a checklist, `choice` when the title is a question and the items its options. */
    kind: ChecklistKind;
    /** Only meaningful for a choice: how many options can be chosen. */
    pick: ChoicePick;
    reviewed: number;
    items: ItemView[];
}

export interface SessionSummary {
    ref: string;
    id: string;
    title: string;
    branch?: string;
    startedAt: number;
    lastActivityAt: number;
    /** Archived by the user on a device: out of the Dashboard until the agent writes to it. */
    archived?: boolean;
    /** The user marked the review finished on a device (until the agent writes again). */
    done?: boolean;
}

export interface SessionView extends SessionSummary {
    /** The user's note for the agent. */
    note?: string;
    /** The message the agent shows on the user's devices, with the time it was set. */
    message?: { text: string; at: number };
    checklists: ChecklistView[];
}

export interface FeedbackChecklist {
    ref: string;
    id: string;
    title: string;
    kind: ChecklistKind;
    pick: ChoicePick;
    reviewed: number;
    /** Options chosen (`done`), on a choice only: the items themselves are not all listed here. */
    chosen?: number;
    total: number;
    /** Reviewed items whose status or note changed since the feedback was last delivered. */
    changed: ItemView[];
    /** Items the user added (or rewrote) since the feedback was last delivered. */
    added: ItemView[];
    /** Items without a review status. */
    unreviewed: ItemView[];
    /** Reviewed items already delivered and unchanged since. */
    unchanged: number;
}

export interface FeedbackAck {
    items: Array<{ itemId: string } & ReviewMarker>;
    /** Id of the op that wrote the session note shown. */
    sessionNote?: string;
    /** Id of the op that marked the session done, when the agent was told about it. */
    done?: string;
}

export interface FeedbackImage {
    id: string;
    path: string;
    mime: 'image/jpeg' | 'image/webp';
}

export interface FeedbackView {
    session: SessionSummary;
    /** The user's note for the agent, when it changed since the feedback was last delivered. */
    note?: string;
    /** Screenshots the agent is given with this feedback, as files (when the computer has them). */
    images?: FeedbackImage[];
    checklists: FeedbackChecklist[];
    /** The user marked the session done: they finished the review, whatever is left unreviewed. */
    done?: true;
    /** True when a review, an added item, the note or a done changed since the last delivery. */
    hasNew: boolean;
    /** To send back once the feedback has been shown, so it is not reported as new again. */
    ack: FeedbackAck;
}

/** The screenshots stored on this computer, by id: what a token in a note stands for. */
export type ImageIndex = ReadonlyMap<string, StoredImage>;

/**
 * A note as the agent reads it: each screenshot token becomes a line with the file of the image,
 * or says it did not arrive yet. Without an index the tokens are left as they are.
 */
export function screenshotText(text: string, index?: ImageIndex): string {
    if (!index) return text;
    return replaceScreenshots(text, (id) => {
        const image = index.get(id);
        return image
            ? `screenshot: ${image.path}`
            : 'screenshot: (not received from the device yet)';
    });
}

function itemViews(state: ProjectState, checklistId: string, index?: ImageIndex): ItemView[] {
    return listItems(state, checklistId).map(
        (item): ItemView => ({
            ref: shortRef(item.id),
            id: item.id,
            text: item.text,
            ...(item.detail && { detail: item.detail }),
            ...(item.status && { status: item.status }),
            ...(item.note && { note: screenshotText(item.note, index) }),
            order: item.order,
            ...(item.addedByUser && { addedByUser: true as const }),
        }),
    );
}

function checklistView(
    state: ProjectState,
    checklistId: string,
    index?: ImageIndex,
): ChecklistView {
    const checklist = getChecklist(state, checklistId);
    if (!checklist) throw new ActionError(404, 'checklist not found');
    const items = itemViews(state, checklistId, index);
    return {
        ref: shortRef(checklist.id),
        id: checklist.id,
        title: checklist.title,
        kind: checklist.kind,
        pick: checklist.pick,
        reviewed: items.filter((item) => item.status).length,
        items,
    };
}

/** Resolves a session ref (or full id) among the sessions of the project. */
export function resolveSession(state: ProjectState, ref: string): Session {
    return resolveRef(listSessions(state), ref, 'session', 'this project');
}

function sessionSummary(session: Session): SessionSummary {
    return {
        ref: shortRef(session.id),
        id: session.id,
        title: session.title,
        ...(session.branch && { branch: session.branch }),
        startedAt: session.startedAt,
        lastActivityAt: session.lastActivityAt,
        ...(session.archived && { archived: true }),
        ...(session.done && { done: true }),
    };
}

/** Sessions of the project, most recently active first. */
export function listSessionSummaries(state: ProjectState): SessionSummary[] {
    return listSessions(state).map(sessionSummary);
}

export function sessionView(
    state: ProjectState,
    sessionId: string,
    index?: ImageIndex,
): SessionView {
    const session = listSessions(state).find((candidate) => candidate.id === sessionId);
    if (!session) throw new ActionError(404, 'session not found');
    return {
        ...sessionSummary(session),
        ...(session.note && { note: screenshotText(renderNote(session.note), index) }),
        ...(session.message && { message: session.message }),
        checklists: listChecklists(state, session.id).map((checklist) =>
            checklistView(state, checklist.id, index),
        ),
    };
}

/**
 * Review feedback of a session, split into what is new for the agent and what is not. `read` is
 * what the agent was given of the elements of the note before: once it read some, the elements it
 * did not read are marked `[new]` and the ones that changed `[edit]`. With an `index` of the
 * screenshots on this computer, their tokens become files, and `images` lists the ones the agent
 * is given for the first time (a note that is shown again does not send its old pictures again).
 * `deliveredDone` is the done the agent was told about last: a done is new until it was.
 */
export function feedbackView(
    state: ProjectState,
    sessionId: string,
    read?: NoteFingerprints,
    index?: ImageIndex,
    deliveredDone?: string,
): FeedbackView {
    const session = listSessions(state).find((candidate) => candidate.id === sessionId);
    if (!session) throw new ActionError(404, 'session not found');
    const ack: FeedbackAck = { items: [] };
    /** Screenshots the agent receives with this feedback. */
    const given = new Set<string>();
    const give = (text: string | null | undefined) => {
        if (text) for (const id of screenshotIds(text)) given.add(id);
    };

    const checklists = listChecklists(state, sessionId).map((checklist): FeedbackChecklist => {
        const items = itemViews(state, checklist.id, index);
        const changed: ItemView[] = [];
        const added: ItemView[] = [];
        const unreviewed: ItemView[] = [];
        let unchanged = 0;
        const acknowledge = (item: ItemView) =>
            ack.items.push({ itemId: item.id, ...(reviewMarker(state, item.id) as ReviewMarker) });
        // An answered question is done: its other options are not items left to review.
        const open = new Set(pendingItems(checklist, items).map((item) => item.id));
        for (const item of items) {
            if (hasUndeliveredAddition(state, item.id)) {
                added.push(item);
                give(state.items[item.id]?.values.note);
                acknowledge(item);
            } else if (!item.status) {
                if (open.has(item.id)) unreviewed.push(item);
            } else if (hasUndeliveredReview(state, item.id)) {
                changed.push(item);
                give(state.items[item.id]?.values.note);
                acknowledge(item);
            } else {
                unchanged++;
            }
        }
        return {
            ref: shortRef(checklist.id),
            id: checklist.id,
            title: checklist.title,
            kind: checklist.kind,
            pick: checklist.pick,
            reviewed: items.length - unreviewed.length,
            ...(checklist.kind === 'choice' && {
                chosen: items.filter((item) => item.status === 'done').length,
            }),
            total: items.length,
            changed,
            added,
            unreviewed,
            unchanged,
        };
    });

    const noteMarker = hasUndeliveredSessionNote(state, sessionId)
        ? sessionNoteMarker(state, sessionId)
        : null;
    if (noteMarker) ack.sessionNote = noteMarker;
    const done = doneMarker(state, sessionId);
    if (done !== null && done !== deliveredDone) ack.done = done;
    const mark = markNote(sessionId, read);
    if (noteMarker && session.note) {
        // The elements the agent has not seen (all of them, the first time).
        for (const entry of splitNote(session.note)) {
            if (!mark || mark(entry)) give(entry.text);
        }
    }
    const images = index
        ? [...given].flatMap((id) => {
              const image = index.get(id);
              return image ? [{ id, path: image.path, mime: image.mime }] : [];
          })
        : undefined;

    return {
        session: sessionSummary(session),
        ...(noteMarker &&
            session.note && { note: screenshotText(renderNote(session.note, mark), index) }),
        ...(images && { images }),
        checklists,
        ...(done !== null && { done: true as const }),
        hasNew: ack.items.length > 0 || noteMarker !== null || ack.done !== undefined,
        ack,
    };
}

/** Marks the elements of a note against what the agent read; none until it has read any. */
function markNote(sessionId: string, read: NoteFingerprints | undefined) {
    if (!read || Object.keys(read).length === 0) return undefined;
    return (entry: { id: string | null; text: string }) => {
        const before = entry.id ? read[entry.id] : undefined;
        if (before === undefined) return 'new';
        return before === noteFingerprint(sessionId, entry.text) ? null : 'edit';
    };
}

// -- writes (always inside a room transaction) --------------------------------------------------

function applied(result: SubmitResult): void {
    if (result.status !== 'applied') {
        throw new Error(`local op not applied: ${result.status}`);
    }
}

export function defaultSessionTitle(branch: string | undefined, now: Date): string {
    const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    return `${branch ?? 'session'} · ${time}`;
}

/** Starts a new session. The agent then addresses it by the returned ref. */
export async function startSession(
    tx: RoomTransaction,
    input: { title?: string; branch?: string },
    now = new Date(),
): Promise<SessionView> {
    const sessionId = createId();
    applied(
        await tx.submit('session.upsert', sessionId, {
            title: input.title ?? defaultSessionTitle(input.branch, now),
            ...(input.branch && { branch: input.branch }),
            startedAt: now.getTime(),
        }),
    );
    return sessionView(tx.state, sessionId);
}

/** Resolves the session of a write and records the branch the agent is working on. */
export async function openSession(
    tx: RoomTransaction,
    ref: string,
    branch?: string,
): Promise<string> {
    const session = resolveSession(tx.state, ref);
    if (branch && session.branch !== branch) {
        applied(await tx.submit('session.upsert', session.id, { branch }));
    }
    return session.id;
}

function checklistsOf(state: ProjectState, sessionId: string) {
    return listChecklists(state, sessionId);
}

function itemsOf(state: ProjectState, sessionId: string) {
    return checklistsOf(state, sessionId).flatMap((checklist) => listItems(state, checklist.id));
}

function nextOrder(state: ProjectState, checklistId: string): number {
    const items = listItems(state, checklistId);
    return items.reduce((max, item) => Math.max(max, item.order), -1) + 1;
}

/** One item to create: a check, or an option of a choice with its lines of detail. */
export interface ItemInput {
    text: string;
    detail?: string;
}

/**
 * Creates a checklist of checks, or a choice (`kind: 'choice'`): one question in the title and
 * the options as items. `kind` and `pick` are written only for a choice, so a plain checklist
 * stays exactly what it was before phase 17.
 */
export async function createChecklist(
    tx: RoomTransaction,
    sessionId: string,
    input: { title: string; items: ItemInput[]; kind?: ChecklistKind; pick?: ChoicePick },
): Promise<ChecklistView> {
    const checklistId = createId();
    const choice = input.kind === 'choice';
    applied(
        await tx.submit('checklist.create', sessionId, {
            checklistId,
            title: input.title,
            ...(choice && { kind: 'choice' as const, pick: input.pick ?? 'one' }),
        }),
    );
    for (const [order, item] of input.items.entries()) {
        applied(
            await tx.submit('item.add', sessionId, {
                itemId: createId(),
                checklistId,
                text: item.text,
                ...(item.detail && { detail: item.detail }),
                order,
            }),
        );
    }
    return checklistView(tx.state, checklistId);
}

export async function renameChecklist(
    tx: RoomTransaction,
    sessionId: string,
    ref: string,
    title: string,
): Promise<ChecklistView> {
    const checklist = resolveRef(checklistsOf(tx.state, sessionId), ref, 'checklist');
    applied(await tx.submit('checklist.update', sessionId, { checklistId: checklist.id, title }));
    return checklistView(tx.state, checklist.id);
}

export async function removeChecklist(
    tx: RoomTransaction,
    sessionId: string,
    ref: string,
): Promise<{ ref: string; title: string }> {
    const checklist = resolveRef(checklistsOf(tx.state, sessionId), ref, 'checklist');
    applied(await tx.submit('checklist.remove', sessionId, { checklistId: checklist.id }));
    return { ref: shortRef(checklist.id), title: checklist.title };
}

/**
 * Adds an item to the given checklist, or to the most recent list of checks of the session.
 * Choices are skipped when picking a default: an item added without a ref is a check, and the
 * options of a question are written with the question itself.
 */
export async function addItem(
    tx: RoomTransaction,
    sessionId: string,
    input: ItemInput & { checklist?: string },
): Promise<{ checklist: { ref: string; title: string }; item: ItemView }> {
    const checklists = checklistsOf(tx.state, sessionId);
    const checklist = input.checklist
        ? resolveRef(checklists, input.checklist, 'checklist')
        : checklists.filter((candidate) => candidate.kind === 'checks').at(-1);
    if (!checklist) {
        throw new ActionError(404, 'no checklist in this session: create one first');
    }
    const itemId = createId();
    applied(
        await tx.submit('item.add', sessionId, {
            itemId,
            checklistId: checklist.id,
            text: input.text,
            ...(input.detail && { detail: input.detail }),
            order: nextOrder(tx.state, checklist.id),
        }),
    );
    const view = checklistView(tx.state, checklist.id);
    return {
        checklist: { ref: view.ref, title: view.title },
        item: view.items.find((item) => item.id === itemId) as ItemView,
    };
}

/**
 * A review is about what the user read: changed text or detail needs a new review. Also used by
 * `retest`, which carries the same change over to a copy shared with a guest.
 */
export function changesReview(
    item: { text: string; detail?: string; status?: ItemStatus },
    input: { text?: string; detail?: string },
): boolean {
    const changed =
        (input.text !== undefined && input.text !== item.text) ||
        (input.detail !== undefined && input.detail !== (item.detail ?? ''));
    return item.status !== undefined && changed;
}

export async function editItem(
    tx: RoomTransaction,
    sessionId: string,
    ref: string,
    input: { text?: string; detail?: string },
): Promise<ItemView> {
    const item = resolveRef(itemsOf(tx.state, sessionId), ref, 'item');
    const reset = changesReview(item, input);
    applied(
        await tx.submit('item.update', sessionId, {
            itemId: item.id,
            ...(input.text !== undefined && { text: input.text }),
            ...(input.detail !== undefined && { detail: input.detail }),
            ...(reset ? { status: null } : {}),
        }),
    );
    return checklistView(tx.state, item.checklistId).items.find(
        (candidate) => candidate.id === item.id,
    ) as ItemView;
}

export async function removeItem(
    tx: RoomTransaction,
    sessionId: string,
    ref: string,
): Promise<{ ref: string; text: string }> {
    const item = resolveRef(itemsOf(tx.state, sessionId), ref, 'item');
    applied(await tx.submit('item.remove', sessionId, { itemId: item.id }));
    return { ref: shortRef(item.id), text: item.text };
}

/** Sets the message shown to the user at the top of the session; `''` removes it. */
export async function setMessage(
    tx: RoomTransaction,
    sessionId: string,
    message: string,
): Promise<SessionView> {
    applied(await tx.submit('session.message', sessionId, { message }));
    return sessionView(tx.state, sessionId);
}

export async function updateSession(
    tx: RoomTransaction,
    sessionId: string,
    input: { title: string },
): Promise<void> {
    applied(await tx.submit('session.upsert', sessionId, input));
}

/** Deletes a session with its checklists and notes, everywhere. */
export async function removeSession(tx: RoomTransaction, ref: string): Promise<SessionSummary> {
    const session = resolveSession(tx.state, ref);
    applied(await tx.submit('session.remove', session.id, {}));
    return sessionSummary(session);
}

/**
 * Records that the agent received a feedback. Markers of items outside the session are ignored,
 * and a late acknowledgement never hides a newer review (it names older ops).
 */
export async function deliverFeedback(
    tx: RoomTransaction,
    sessionId: string,
    ack: FeedbackAck,
): Promise<{ items: number }> {
    const session = listSessions(tx.state).find((candidate) => candidate.id === sessionId);
    if (!session) throw new ActionError(404, 'session not found');
    const inSession = new Set(itemsOf(tx.state, sessionId).map((item) => item.id));
    const items = ack.items.filter((entry) => {
        if (!inSession.has(entry.itemId)) return false;
        const delivered = tx.state.items[entry.itemId]?.values.delivered;
        return (
            delivered?.status !== entry.status ||
            delivered?.note !== entry.note ||
            delivered?.text !== entry.text
        );
    });
    const sessionNote =
        ack.sessionNote !== undefined &&
        tx.state.sessions[sessionId]?.values.deliveredNote !== ack.sessionNote
            ? ack.sessionNote
            : undefined;
    const chunks: Array<typeof items> = [];
    for (let start = 0; start < items.length; start += LIMITS.deliveredItems) {
        chunks.push(items.slice(start, start + LIMITS.deliveredItems));
    }
    if (chunks.length === 0 && sessionNote !== undefined) chunks.push([]);
    for (const [index, chunk] of chunks.entries()) {
        applied(
            await tx.submit('feedback.deliver', sessionId, {
                items: chunk,
                ...(index === 0 && sessionNote !== undefined && { sessionNote }),
            }),
        );
    }
    return { items: items.length, ...(sessionNote !== undefined && { note: true }) };
}

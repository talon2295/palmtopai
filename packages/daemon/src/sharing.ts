import {
    computerNameSchema,
    createId,
    type Item,
    type ItemStatus,
    listChecklists,
    listItems,
    listSessions,
    type ProjectState,
    type SessionShares,
    type SharedPerson,
} from '@palmtopai/protocol';
import {
    ActionError,
    changesReview,
    deliverFeedback,
    type FeedbackAck,
    type FeedbackImage,
    type FeedbackView,
    feedbackView,
    resolveRef,
    screenshotText,
    shortRef,
} from './agent-actions';
import type { ImageStore } from './images';
import type { PeopleStore, Person, Share } from './people-store';
import type { ProjectRoom } from './room';
import type { RoomManager } from './rooms';
import type { StorageAdapter } from './storage/adapter';

export const DEFAULT_SHARE_DAYS = 7;
export const MAX_SHARE_DAYS = 365;
const DAY_MS = 86_400_000;
/** Name of a copy whose session has a title that is too long or empty (it cannot happen today). */
const FALLBACK_NAME = 'Shared checklist';

export type ShareState = 'open' | 'expired' | 'closed';

/** One copy of a session, as `palmtop share` and `palmtop share list` show it. */
export interface ShareView {
    person: string;
    state: ShareState;
    expiresAt: number;
    /** The project and session the copy comes from. */
    project: { id: string; name: string } | null;
    session: { ref: string; title: string } | null;
    /** The checklists given, with how many of their items the person has reviewed. */
    checklists: Array<{ ref: string; title: string; reviewed: number; total: number }>;
}

export interface ShareResult extends ShareView {
    /** `new`: first copy of this session for the person; `added`: one more checklist; `reopened`. */
    outcome: 'new' | 'added' | 'reopened';
}

/** What taking a checklist out of a copy deletes: the answers of the person and their own items. */
export interface RemovalLoss {
    ref: string;
    title: string;
    reviewed: number;
    total: number;
    done: number;
    cancelled: number;
    question: number;
    /** Items with a note of the person. */
    notes: number;
}

export interface RemovalPreview {
    person: string;
    removed: RemovalLoss;
}

export interface RemoveResult extends ShareView {
    /** The checklist taken out of the copy, with what it took along. */
    removed: RemovalLoss;
}

interface RemovalTarget {
    projectId: string;
    sessionId: string;
    personName: string;
    checklistRef: string;
}

export interface RetestResult {
    person: string;
    added: number;
    /** Items whose text or detail changed. */
    updated: number;
    /** Updated items that had a review: it is asked again. */
    reset: number;
    removed: number;
    unchanged: number;
}

export interface SharedOutcome {
    person: string;
    status?: ItemStatus;
    note?: string;
    /** Not yet delivered to the agent. */
    changed: boolean;
}

export interface SharedChecklistFeedback {
    ref: string;
    title: string;
    /** Items with at least one new outcome, with the outcome of every person who has the item. */
    items: Array<{ ref: string; text: string; outcomes: SharedOutcome[] }>;
}

export interface SharedFeedback {
    /** Where each person stands: one line per copy. */
    people: Array<{
        person: string;
        state: ShareState;
        reviewed: number;
        total: number;
    }>;
    checklists: SharedChecklistFeedback[];
    /** Notes written on their copy of the session. */
    notes: Array<{ person: string; note: string }>;
    /** The screenshots in what they wrote that the agent is given with this feedback. */
    images?: FeedbackImage[];
    hasNew: boolean;
    /** To send back, once shown, with the acknowledgement of the original. */
    ack: Array<{ shareId: string } & FeedbackAck>;
}

/** The feedback of a session that was shared: the one of the original, and the copies. */
export type FeedbackWithShared = FeedbackView & { shared?: SharedFeedback };

export interface SharingOptions {
    people: PeopleStore;
    rooms: RoomManager;
    storage: StorageAdapter;
    /** The screenshots of the copies: their files go with the copy, and the agent is given them. */
    images?: ImageStore;
    /** Name of a project of the computer. */
    projectName: (projectId: string) => string | null;
    /**
     * Called before a person is given a copy, to refuse it (e.g. too many people at once): the
     * room of a person is only open while they have something to see.
     */
    beforeShare?: (personId: string) => void | Promise<void>;
    /**
     * Called after the copies of a person changed: given, closed, taken away. With the project
     * the copies come from, when it is known.
     */
    onChange?: (personId: string, sourceProjectId?: string) => void;
    /** Called when the name a copy gives its owner changed. */
    onOwnerName?: (shareId: string) => void;
    now?: () => number;
    log?: (line: string) => void;
}

export function shareState(share: Share, now: number): ShareState {
    if (share.closedAt !== null) return 'closed';
    return now >= share.expiresAt ? 'expired' : 'open';
}

/** What a retest or a share reads from the original, in one step. */
interface SourceSlice {
    sessionTitle: string;
    checklists: Map<string, { id: string; title: string; kind: string; items: Item[] }>;
}

/**
 * Checklists shared with other people. Sharing gives a person a **copy** in a project of its own,
 * kept in the data folder and out of `projects.json`: the copy is what the owner gave, and only
 * changes when the owner says so (`retest`). Every operation here runs one at a time.
 */
export class Sharing {
    readonly #people: PeopleStore;
    readonly #rooms: RoomManager;
    readonly #storage: StorageAdapter;
    readonly #images: ImageStore | undefined;
    readonly #projectName: (projectId: string) => string | null;
    readonly #now: () => number;
    readonly #log: (line: string) => void;
    readonly #beforeShare: (personId: string) => void | Promise<void>;
    readonly #onChange: (personId: string, sourceProjectId?: string) => void;
    readonly #onOwnerName: (shareId: string) => void;
    #queue: Promise<unknown> = Promise.resolve();

    constructor(options: SharingOptions) {
        this.#beforeShare = options.beforeShare ?? (() => {});
        this.#onChange = options.onChange ?? (() => {});
        this.#onOwnerName = options.onOwnerName ?? (() => {});
        this.#people = options.people;
        this.#rooms = options.rooms;
        this.#storage = options.storage;
        this.#images = options.images;
        this.#projectName = options.projectName;
        this.#now = options.now ?? Date.now;
        this.#log = options.log ?? (() => {});
    }

    /** True for a project that is a copy shared with a guest. */
    isGuestProject(projectId: string): boolean {
        return this.#people.isShareProject(projectId);
    }

    /** Gives `personName` a copy of one checklist of checks of the session. */
    share(input: {
        room: ProjectRoom;
        sessionId: string;
        checklistRef: string;
        personName: string;
        days?: number;
    }): Promise<ShareResult> {
        return this.#serial(async () => {
            const person = this.#person(input.personName);
            const days = input.days ?? DEFAULT_SHARE_DAYS;
            if (!Number.isInteger(days) || days < 1 || days > MAX_SHARE_DAYS) {
                throw new ActionError(
                    400,
                    `days must be a whole number from 1 to ${MAX_SHARE_DAYS}`,
                );
            }
            const source = await readSource(input.room, input.sessionId);
            const checklist = resolveRef(
                [...source.checklists.values()],
                input.checklistRef,
                'checklist',
            );
            if (checklist.kind !== 'checks') {
                throw new ActionError(
                    400,
                    'only a checklist of checks can be shared, not a question',
                );
            }
            await this.#beforeShare(person.personId);
            const now = this.#now();
            const expiresAt = now + days * DAY_MS;
            const existing = this.#people.shareFor(
                person.personId,
                input.room.projectId,
                input.sessionId,
            );

            if (existing) {
                const open = shareState(existing, now) === 'open';
                const has = existing.checklists.some((pair) => pair.source === checklist.id);
                if (open && has) {
                    throw new ActionError(
                        409,
                        `"${checklist.title}" is already shared with ${person.name}: use "palmtop retest --with ${person.name}" to update the copy`,
                    );
                }
                const guestRoom = await this.#guestRoom(existing.shareId);
                const pairs = [...existing.checklists];
                if (!has) {
                    const copy = await guestRoom.transact((tx) =>
                        copyChecklist(tx, existing.copySessionId, checklist),
                    );
                    pairs.push({ source: checklist.id, copy });
                }
                const updated: Share = {
                    ...existing,
                    checklists: pairs,
                    expiresAt,
                    closedAt: null,
                };
                await this.#people.putShare(updated);
                this.#onChange(person.personId, input.room.projectId);
                return {
                    ...(await this.#view(updated)),
                    outcome: open ? 'added' : 'reopened',
                };
            }

            const shareId = createId();
            const copySessionId = createId();
            await this.#storage.createProject({
                id: shareId,
                name: copyName(source.sessionTitle),
                rootPath: `guest:${person.personId}`,
                createdAt: now,
            });
            const guestRoom = await this.#guestRoom(shareId);
            const copy = await guestRoom.transact(async (tx) => {
                await submit(tx, 'session.upsert', copySessionId, {
                    title: source.sessionTitle,
                    startedAt: now,
                });
                return copyChecklist(tx, copySessionId, checklist);
            });
            const share: Share = {
                shareId,
                personId: person.personId,
                sourceProjectId: input.room.projectId,
                sourceSessionId: input.sessionId,
                copySessionId,
                checklists: [{ source: checklist.id, copy }],
                createdAt: now,
                expiresAt,
                closedAt: null,
            };
            await this.#people.putShare(share);
            this.#onChange(person.personId, input.room.projectId);
            return { ...(await this.#view(share)), outcome: 'new' };
        });
    }

    /**
     * Brings the copy of a person up to date with the original: changed text asks for a new
     * review, new items are added, removed items go, and a review of an unchanged item stays.
     * What the person added on the copy is left alone. With `itemRefs` only those items are looked at.
     */
    retest(input: {
        room: ProjectRoom;
        sessionId: string;
        personName: string;
        itemRefs?: string[];
        message?: string;
    }): Promise<RetestResult> {
        return this.#serial(async () => {
            const person = this.#person(input.personName);
            const share = this.#shareOf(person, input.room.projectId, input.sessionId);
            const state = shareState(share, this.#now());
            if (state !== 'open') {
                throw new ActionError(
                    409,
                    `the copy of ${person.name} is ${state}: share it again to reopen it`,
                );
            }
            const source = await readSource(input.room, input.sessionId);
            const limited = input.itemRefs !== undefined && input.itemRefs.length > 0;
            let only: Set<string> | null = null;
            if (limited) {
                const candidates = share.checklists.flatMap(
                    (pair) => source.checklists.get(pair.source)?.items ?? [],
                );
                only = new Set(
                    (input.itemRefs as string[]).map(
                        (ref) => resolveRef(candidates, ref, 'item', 'the shared checklists').id,
                    ),
                );
            }
            const result: RetestResult = {
                person: person.name,
                added: 0,
                updated: 0,
                reset: 0,
                removed: 0,
                unchanged: 0,
            };
            const guestRoom = await this.#guestRoom(share.shareId);
            const pairs = await guestRoom.transact(async (tx) => {
                const kept: Share['checklists'] = [];
                if (
                    !only &&
                    sessionTitleOf(tx.state, share.copySessionId) !== source.sessionTitle
                ) {
                    await submit(tx, 'session.upsert', share.copySessionId, {
                        title: source.sessionTitle,
                    });
                }
                for (const pair of share.checklists) {
                    const original = source.checklists.get(pair.source);
                    if (!original) {
                        // Taken out of the original: it goes from the copy too.
                        if (!only) {
                            await submit(tx, 'checklist.remove', share.copySessionId, {
                                checklistId: pair.copy,
                            });
                            continue;
                        }
                        kept.push(pair);
                        continue;
                    }
                    kept.push(pair);
                    const copyList = listChecklists(tx.state, share.copySessionId).find(
                        (candidate) => candidate.id === pair.copy,
                    );
                    if (!only && copyList && copyList.title !== original.title) {
                        await submit(tx, 'checklist.update', share.copySessionId, {
                            checklistId: pair.copy,
                            title: original.title,
                        });
                    }
                    const copies = listItems(tx.state, pair.copy);
                    const byOrigin = new Map(
                        copies.flatMap((item) =>
                            item.origin ? [[item.origin, item] as const] : [],
                        ),
                    );
                    for (const item of original.items) {
                        if (only && !only.has(item.id)) continue;
                        const copy = byOrigin.get(item.id);
                        if (!copy) {
                            await submit(tx, 'item.add', share.copySessionId, {
                                itemId: createId(),
                                checklistId: pair.copy,
                                text: item.text,
                                ...(item.detail && { detail: item.detail }),
                                order: item.order,
                                origin: item.id,
                            });
                            result.added++;
                            continue;
                        }
                        const next = { text: item.text, detail: item.detail ?? '' };
                        const textChanged = next.text !== copy.text;
                        const detailChanged = next.detail !== (copy.detail ?? '');
                        const orderChanged = item.order !== copy.order;
                        if (!textChanged && !detailChanged && !orderChanged) {
                            result.unchanged++;
                            continue;
                        }
                        const reset = changesReview(copy, next);
                        await submit(tx, 'item.update', share.copySessionId, {
                            itemId: copy.id,
                            ...(textChanged && { text: next.text }),
                            ...(detailChanged && { detail: next.detail }),
                            ...(orderChanged && { order: item.order }),
                            ...(reset && { status: null }),
                        });
                        if (textChanged || detailChanged) result.updated++;
                        else result.unchanged++;
                        if (reset) result.reset++;
                    }
                    if (!only) {
                        const originals = new Set(original.items.map((item) => item.id));
                        for (const copy of copies) {
                            if (!copy.origin || originals.has(copy.origin)) continue;
                            await submit(tx, 'item.remove', share.copySessionId, {
                                itemId: copy.id,
                            });
                            result.removed++;
                        }
                    }
                }
                if (input.message !== undefined) {
                    await submit(tx, 'session.message', share.copySessionId, {
                        message: input.message,
                    });
                }
                return kept;
            });
            if (pairs.length !== share.checklists.length) {
                await this.#people.putShare({ ...share, checklists: pairs });
                this.#onChange(person.personId, input.room.projectId);
            }
            return result;
        });
    }

    /** Writes the message a person sees on their copy of the session; `''` removes it. */
    message(input: {
        projectId: string;
        sessionId: string;
        personName: string;
        message: string;
    }): Promise<{ person: string }> {
        return this.#serial(async () => {
            const person = this.#person(input.personName);
            const share = this.#shareOf(person, input.projectId, input.sessionId);
            if (share.closedAt !== null) {
                throw new ActionError(409, `the copy of ${person.name} is closed`);
            }
            const guestRoom = await this.#guestRoom(share.shareId);
            await guestRoom.transact((tx) =>
                submit(tx, 'session.message', share.copySessionId, { message: input.message }),
            );
            return { person: person.name };
        });
    }

    /** Takes the copy away from the person's list. What they reviewed stays with the owner. */
    close(input: { projectId: string; sessionId: string; personName: string }): Promise<ShareView> {
        return this.#serial(async () => {
            const person = this.#person(input.personName);
            const share = this.#shareOf(person, input.projectId, input.sessionId);
            const closed: Share =
                share.closedAt === null ? { ...share, closedAt: this.#now() } : share;
            if (closed !== share) {
                await this.#people.putShare(closed);
                this.#onChange(person.personId, input.projectId);
            }
            return this.#view(closed);
        });
    }

    /**
     * Takes one checklist out of the copy of a person: it disappears from their app, and what
     * they answered on it is deleted with it. The last one closes the copy, like `close`.
     */
    removeChecklist(input: RemovalTarget): Promise<RemoveResult> {
        return this.#serial(async () => {
            const { person, share, pair, guestRoom } = await this.#removalTarget(input);
            const gone = this.#loss(guestRoom.state, share, pair);
            await guestRoom.transact((tx) =>
                submit(tx, 'checklist.remove', share.copySessionId, { checklistId: pair.copy }),
            );
            const remaining = share.checklists.filter((candidate) => candidate.copy !== pair.copy);
            const updated: Share = {
                ...share,
                checklists: remaining,
                closedAt: remaining.length === 0 ? this.#now() : null,
            };
            await this.#people.putShare(updated);
            this.#onChange(person.personId, input.projectId);
            return { ...(await this.#view(updated)), removed: gone };
        });
    }

    /** What `removeChecklist` would delete, to ask the owner before doing it. */
    previewRemoval(input: RemovalTarget): Promise<RemovalPreview> {
        return this.#serial(async () => {
            const { person, share, pair, guestRoom } = await this.#removalTarget(input);
            return { person: person.name, removed: this.#loss(guestRoom.state, share, pair) };
        });
    }

    async #removalTarget(input: RemovalTarget) {
        const person = this.#person(input.personName);
        const share = this.#shareOf(person, input.projectId, input.sessionId);
        if (share.closedAt !== null) {
            throw new ActionError(
                409,
                `the copy of ${person.name} is closed: share a checklist again to reopen it`,
            );
        }
        const guestRoom = await this.#guestRoom(share.shareId);
        const pair = resolveRef(
            share.checklists.map((candidate) => ({ ...candidate, id: candidate.source })),
            input.checklistRef,
            'checklist',
            `the copy of ${person.name}`,
        );
        return { person, share, pair, guestRoom };
    }

    #loss(state: ProjectState, share: Share, pair: Share['checklists'][number]): RemovalLoss {
        const progress = this.#progress(state, share, pair);
        const items = listItems(state, pair.copy);
        const count = (status: ItemStatus) =>
            items.filter((item) => item.origin && item.status === status).length;
        return {
            ...progress,
            done: count('done'),
            cancelled: count('cancelled'),
            question: count('question'),
            notes: items.filter((item) => item.note).length,
        };
    }

    /** Every copy, oldest first. */
    async list(): Promise<ShareView[]> {
        return this.#serial(async () => {
            const views: ShareView[] = [];
            for (const share of this.#people.shares()) views.push(await this.#view(share));
            return views;
        });
    }

    /**
     * The name the copies of a session give their owner: for everyone who has one, or (with
     * `personName`) for that person's copy only, which then wins. `null` takes the name back.
     */
    setOwnerName(input: {
        projectId: string;
        sessionId: string;
        name: string | null;
        personName?: string;
    }): Promise<{ copies: number }> {
        return this.#serial(async () => {
            if (input.name !== null) {
                const parsed = computerNameSchema.safeParse(input.name);
                if (!parsed.success) {
                    throw new ActionError(400, parsed.error.issues[0]?.message ?? 'bad name');
                }
            }
            if (input.personName !== undefined) {
                const person = this.#person(input.personName);
                const share = this.#shareOf(person, input.projectId, input.sessionId);
                const { ownerName: _previous, ...rest } = share;
                await this.#people.putShare(
                    input.name === null ? rest : { ...rest, ownerName: input.name },
                );
                this.#onOwnerName(share.shareId);
                return { copies: 1 };
            }
            await this.#people.setOwnerNameOfSession(input.sessionId, input.name);
            const shares = this.#people.sharesOfSession(input.projectId, input.sessionId);
            for (const share of shares) this.#onOwnerName(share.shareId);
            return { copies: shares.length };
        });
    }

    /** Takes every copy of a person away from them (they were removed). Returns how many. */
    closeAllOf(personId: string): Promise<number> {
        return this.#serial(async () => {
            const open = this.#people
                .shares()
                .filter((share) => share.personId === personId && share.closedAt === null);
            for (const share of open) {
                await this.#people.putShare({ ...share, closedAt: this.#now() });
                this.#onChange(personId, share.sourceProjectId);
            }
            return open.length;
        });
    }

    /**
     * Deletes the copies whose original is gone: a deletion that was cut short (the daemon
     * stopped between the session and its copies) must not leave them in the hands of someone.
     */
    cleanOrphans(hasProject: (projectId: string) => boolean): Promise<number> {
        return this.#serial(async () => {
            const orphans: Share[] = [];
            for (const share of this.#people.shares()) {
                if (!hasProject(share.sourceProjectId)) {
                    orphans.push(share);
                    continue;
                }
                try {
                    const original = await this.#rooms.get(share.sourceProjectId);
                    const found =
                        original &&
                        listSessions(original.state).some(
                            (session) => session.id === share.sourceSessionId,
                        );
                    if (!found) orphans.push(share);
                } catch (error) {
                    // Not read is not proof that it is gone: the copy waits for the next start.
                    this.#log(`copy not checked at startup: ${(error as Error).message}`);
                }
            }
            return this.#drop(orphans);
        });
    }

    /** The copies of a session are deleted with it. */
    dropSession(projectId: string, sessionId: string): Promise<number> {
        return this.#serial(() => this.#drop(this.#people.sharesOfSession(projectId, sessionId)));
    }

    /** The copies of a project are deleted with it. */
    dropProject(projectId: string): Promise<number> {
        return this.#serial(() => this.#drop(this.#people.sharesOfProject(projectId)));
    }

    /**
     * What the guests did on their copies of a session, for the agent: the outcomes by item with
     * every person side by side and the notes they wrote. `null` when the session was not shared.
     */
    sharedFeedback(projectId: string, sessionId: string): Promise<SharedFeedback | null> {
        return this.#serial(async () => {
            const shares = this.#people.sharesOfSession(projectId, sessionId);
            if (shares.length === 0) return null;
            const now = this.#now();
            const feedback: SharedFeedback = {
                people: [],
                checklists: [],
                notes: [],
                hasNew: false,
                ack: [],
            };
            const images: FeedbackImage[] = [];
            const bySource = new Map<string, SharedChecklistFeedback>();
            const sourceItems = new Map<
                string,
                Map<string, SharedChecklistFeedback['items'][number]>
            >();

            for (const share of shares) {
                const person = this.#people.person(share.personId);
                const guestRoom = await this.#rooms.get(share.shareId);
                if (!person || !guestRoom) continue;
                const state = guestRoom.state;
                // Where the pictures of this copy are: what they wrote names them by id.
                const index = await this.#images?.index(share.shareId);
                const view = feedbackView(state, share.copySessionId, undefined, index);
                images.push(...(view.images ?? []));
                const changedIds = new Set(
                    view.checklists.flatMap((list) => list.changed.map((item) => item.id)),
                );
                const copyToSource = new Map(
                    share.checklists.map((pair) => [pair.copy, pair.source]),
                );
                let reviewed = 0;
                let total = 0;

                for (const list of listChecklists(state, share.copySessionId)) {
                    const sourceId = copyToSource.get(list.id);
                    if (!sourceId) continue;
                    let block = bySource.get(sourceId);
                    if (!block) {
                        block = { ref: shortRef(sourceId), title: list.title, items: [] };
                        bySource.set(sourceId, block);
                        sourceItems.set(sourceId, new Map());
                    }
                    for (const item of listItems(state, list.id)) {
                        if (!item.origin) continue;
                        total++;
                        if (item.status) reviewed++;
                        const changed = changedIds.has(item.id);
                        const known = sourceItems.get(sourceId) as Map<
                            string,
                            SharedChecklistFeedback['items'][number]
                        >;
                        let line = known.get(item.origin);
                        if (!line) {
                            line = { ref: shortRef(item.origin), text: item.text, outcomes: [] };
                            known.set(item.origin, line);
                        }
                        line.outcomes.push({
                            person: person.name,
                            ...(item.status && { status: item.status }),
                            ...(item.note && { note: screenshotText(item.note, index) }),
                            changed,
                        });
                    }
                }

                if (view.note) feedback.notes.push({ person: person.name, note: view.note });
                feedback.people.push({
                    person: person.name,
                    state: shareState(share, now),
                    reviewed,
                    total,
                });
                if (view.ack.items.length > 0 || view.ack.sessionNote !== undefined) {
                    feedback.ack.push({ shareId: share.shareId, ...view.ack });
                }
            }

            for (const [sourceId, block] of bySource) {
                const lines = [...(sourceItems.get(sourceId)?.values() ?? [])];
                block.items = lines.filter((line) => line.outcomes.some((o) => o.changed));
                if (block.items.length > 0) feedback.checklists.push(block);
            }
            feedback.hasNew = feedback.checklists.length > 0 || feedback.notes.length > 0;
            if (this.#images) feedback.images = images;
            return feedback;
        });
    }

    /**
     * What the people answered on their copies of the sessions of a project, in full (not just
     * what is new), for the owner's devices: the outcome of each of the owner's items, what
     * the people added, and the notes they wrote.
     */
    ownerView(projectId: string): Promise<SessionShares[]> {
        return this.#serial(async () => {
            const now = this.#now();
            const bySession = new Map<string, SharedPerson[]>();
            for (const share of this.#people.sharesOfProject(projectId)) {
                const person = this.#people.person(share.personId);
                const guestRoom = await this.#rooms.get(share.shareId);
                if (!person || !guestRoom) continue;
                const state = guestRoom.state;
                const items: SharedPerson['items'] = {};
                for (const list of listChecklists(state, share.copySessionId)) {
                    for (const item of listItems(state, list.id)) {
                        if (item.origin && item.status) {
                            items[item.origin] = {
                                status: item.status,
                                ...(item.note && { note: item.note }),
                            };
                        }
                    }
                }
                const copy = listSessions(state).find(
                    (session) => session.id === share.copySessionId,
                );
                const note = copy?.note;
                const people = bySession.get(share.sourceSessionId) ?? [];
                people.push({
                    name: person.name,
                    state: shareState(share, now),
                    expiresAt: share.expiresAt,
                    checklists: share.checklists.map((pair) => pair.source),
                    items,
                    ...(note && { note }),
                    ...(copy?.done && { done: true }),
                });
                bySession.set(share.sourceSessionId, people);
            }
            return [...bySession].map(([sessionId, people]) => ({
                sessionId,
                people: people.slice(0, 60),
            }));
        });
    }

    /** Records that the agent saw what `sharedFeedback` returned. */
    acknowledge(
        projectId: string,
        sessionId: string,
        entries: Array<{ shareId: string } & FeedbackAck>,
    ): Promise<void> {
        return this.#serial(async () => {
            for (const { shareId, ...ack } of entries) {
                const share = this.#people.share(shareId);
                if (
                    !share ||
                    share.sourceProjectId !== projectId ||
                    share.sourceSessionId !== sessionId
                ) {
                    continue;
                }
                const guestRoom = await this.#rooms.get(shareId);
                if (!guestRoom) continue;
                await guestRoom.transact((tx) => deliverFeedback(tx, share.copySessionId, ack));
            }
        });
    }

    #person(name: string): Person {
        const person = this.#people.findPerson(name);
        if (!person) {
            throw new ActionError(
                404,
                `no person called "${name}": ask the user to invite them first (palmtop invite, from a terminal)`,
            );
        }
        return person;
    }

    #shareOf(person: Person, projectId: string, sessionId: string): Share {
        const share = this.#people.shareFor(person.personId, projectId, sessionId);
        if (!share) {
            throw new ActionError(404, `this session is not shared with ${person.name}`);
        }
        return share;
    }

    async #guestRoom(shareId: string): Promise<ProjectRoom> {
        const room = await this.#rooms.get(shareId);
        if (!room) throw new ActionError(404, 'the copy is missing');
        return room;
    }

    async #drop(shares: Share[]): Promise<number> {
        for (const share of shares) {
            await this.#people.removeShare(share.shareId);
            await this.#rooms.discard(share.shareId);
            await this.#storage.deleteProject(share.shareId);
            await this.#images?.removeProject(share.shareId);
            this.#log(`copy ${share.shareId} removed with its original`);
        }
        for (const share of shares) this.#onChange(share.personId, share.sourceProjectId);
        return shares.length;
    }

    async #view(share: Share): Promise<ShareView> {
        const person = this.#people.person(share.personId);
        const original = await this.#rooms.get(share.sourceProjectId);
        const guestRoom = await this.#rooms.get(share.shareId);
        const session = original
            ? listSessions(original.state).find(
                  (candidate) => candidate.id === share.sourceSessionId,
              )
            : undefined;
        const name = this.#projectName(share.sourceProjectId);
        return {
            person: person?.name ?? '?',
            state: shareState(share, this.#now()),
            expiresAt: share.expiresAt,
            project: name === null ? null : { id: share.sourceProjectId, name },
            session: session ? { ref: shortRef(session.id), title: session.title } : null,
            checklists: share.checklists.map((pair) =>
                this.#progress(guestRoom?.state, share, pair),
            ),
        };
    }

    /** One copied checklist: its title and how many of the items given the person has reviewed. */
    #progress(
        state: ProjectState | undefined,
        share: Share,
        pair: Share['checklists'][number],
    ): ShareView['checklists'][number] {
        const title = state
            ? (listChecklists(state, share.copySessionId).find((c) => c.id === pair.copy)?.title ??
              '')
            : '';
        const items = state ? listItems(state, pair.copy).filter((item) => item.origin) : [];
        return {
            ref: shortRef(pair.source),
            title,
            reviewed: items.filter((item) => item.status).length,
            total: items.length,
        };
    }

    #serial<T>(task: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }
}

function copyName(title: string): string {
    return title.length > 0 && title.length <= 200 ? title : FALLBACK_NAME;
}

function sessionTitleOf(state: ProjectState, sessionId: string): string | undefined {
    return listSessions(state).find((session) => session.id === sessionId)?.title;
}

/** Reads the session and the checklists of the original in one step. */
function readSource(room: ProjectRoom, sessionId: string): Promise<SourceSlice> {
    return room.exclusive(() => {
        const session = listSessions(room.state).find((candidate) => candidate.id === sessionId);
        if (!session) throw new ActionError(404, 'session not found');
        const checklists: SourceSlice['checklists'] = new Map();
        for (const list of listChecklists(room.state, sessionId)) {
            checklists.set(list.id, {
                id: list.id,
                title: list.title,
                kind: list.kind,
                items: listItems(room.state, list.id),
            });
        }
        return { sessionTitle: session.title, checklists };
    });
}

type Transaction = Parameters<Parameters<ProjectRoom['transact']>[0]>[0];

async function submit(tx: Transaction, ...args: Parameters<Transaction['submit']>): Promise<void> {
    const result = await tx.submit(...args);
    if (result.status !== 'applied') {
        throw new Error(`local op not applied: ${result.status}`);
    }
}

/** Writes a checklist and its items in the copy, each linked to the one it comes from. */
async function copyChecklist(
    tx: Transaction,
    sessionId: string,
    original: { id: string; title: string; items: Item[] },
): Promise<string> {
    const checklistId = createId();
    await submit(tx, 'checklist.create', sessionId, {
        checklistId,
        title: original.title,
        origin: original.id,
    });
    for (const item of original.items) {
        await submit(tx, 'item.add', sessionId, {
            itemId: createId(),
            checklistId,
            text: item.text,
            ...(item.detail && { detail: item.detail }),
            order: item.order,
            origin: item.id,
        });
    }
    return checklistId;
}

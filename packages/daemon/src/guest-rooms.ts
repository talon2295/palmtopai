import {
    type Op,
    type ProjectSummary,
    type ServerMessage,
    summarizeProject,
} from '@palmtopai/protocol';
import { ActionError } from './agent-actions';
import {
    DeviceHub,
    type DeviceImages,
    type DevicePushSubscriptions,
    type HubScope,
} from './device-hub';
import type { RegisteredDevice } from './device-registry';
import { PairKeys } from './pairing';
import { type PeopleStore, type Person, PersonDevices, type Share } from './people-store';
import type { Rejection } from './permissions';
import { RoomIdentity } from './room-identity';
import type { RoomManager } from './rooms';
import { shareState } from './sharing';

/** An invitation lasts this long: the person may open it hours after it was sent. */
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * The relay holds at most 50 rooms for one connection, the computer's included, and closes the
 * whole connection (the computer's phones with it) when asked for more.
 */
export const MAX_GUEST_ROOMS = 49;
/** What a copy says its owner is called, until the owner picks a name. */
export const DEFAULT_OWNER_NAME = 'Shared checklists';
/** How long a person waits for a room when the places were all taken. */
const RETRY_MS = 30_000;
/** `setTimeout` cannot wait longer than this. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** The part of the relay link that a room of a person needs. */
export interface GuestRelay {
    addRoom(identity: RoomIdentity, hub: DeviceHub): void;
    removeRoom(roomId: string): void;
}

export interface GuestRoomsOptions {
    people: PeopleStore;
    rooms: RoomManager;
    relay: GuestRelay;
    /** The subscriptions of the devices of these rooms: apart from the computer's. */
    push: DevicePushSubscriptions;
    /** The screenshots of the copies (with the smaller room a copy has). */
    images?: DeviceImages;
    /** The owner's name shown on every copy that has no name of its own. */
    ownerName: () => string | undefined;
    /** Takes the copies of a person away from them (called when the person is removed). */
    closeShares: (personId: string) => Promise<unknown>;
    /** A person opened their invitation: the device they paired. */
    onJoin?: (person: Person, device: RegisteredDevice) => void;
    helloTimeoutMs?: number;
    presenceTimeoutMs?: number;
    maxMessageBytes?: number;
    now?: () => number;
    log: (line: string) => void;
}

interface Entry {
    personId: string;
    identity: RoomIdentity;
    hub: DeviceHub;
    pairKeys: PairKeys;
    /** The room is open at the relay. */
    active: boolean;
}

/**
 * What the hub of a person's room serves: the copies made for that person that were not closed,
 * and nothing else. A project that is not one of them does not exist for this room: it cannot be
 * followed, listed or deleted, and its name is never sent.
 */
class GuestScope implements HubScope {
    readonly roomId: string;
    readonly roomPublicKey: string;
    readonly label: string;
    readonly signingKey: HubScope['signingKey'];
    /** The owner archives; a person takes part in what was shared, read-only after its date. */
    readonly archive = false;
    readonly #people: PeopleStore;
    readonly #personId: string;
    readonly #now: () => number;

    constructor(identity: RoomIdentity, people: PeopleStore, personId: string, now: () => number) {
        this.roomId = identity.roomId;
        this.roomPublicKey = identity.roomPublicKey;
        this.label = `guest ${personId.slice(-6)}`;
        this.signingKey = () => identity.signingKey();
        this.#people = people;
        this.#personId = personId;
        this.#now = now;
    }

    has(projectId: string): boolean {
        return this.#shareOf(projectId) !== null;
    }

    /** A person attaches screenshots to what they write, while their copy takes answers. */
    authorizeImage(projectId: string): Rejection | null {
        const share = this.#shareOf(projectId);
        if (!share) return { code: 'forbidden', message: 'unknown project' };
        if (shareState(share, this.#now()) !== 'open') {
            return { code: 'forbidden', message: 'this checklist is read-only now' };
        }
        return null;
    }

    authorizeOp(projectId: string, op: Op): Rejection | null {
        const share = this.#shareOf(projectId);
        if (!share) return { code: 'forbidden', message: 'unknown project' };
        if (shareState(share, this.#now()) !== 'open') {
            return { code: 'forbidden', message: 'this checklist is read-only now' };
        }
        // A person reviews and writes notes: what they have to say goes in a note.
        if (op.type === 'item.add') {
            return { code: 'forbidden', message: 'devices cannot add items to a shared checklist' };
        }
        // Only the owner deletes: a person can take part in a session, not end it.
        if (op.type === 'session.remove') {
            return { code: 'forbidden', message: 'devices cannot send session.remove' };
        }
        return null;
    }

    #shareOf(projectId: string): Share | null {
        const share = this.#people.share(projectId);
        return share && share.personId === this.#personId && share.closedAt === null ? share : null;
    }
}

/**
 * The rooms of the people checklists are shared with. Each person has a room of their own at the
 * relay, with a key of its own, so that their device can reach the copies made for them and not
 * the computer. A room is open only while it has a use (a copy that was not closed, or an
 * invitation still valid): the relay holds a limited number of rooms for this computer.
 */
export class GuestRooms {
    readonly #options: GuestRoomsOptions;
    readonly #entries = new Map<string, Entry>();
    readonly #now: () => number;
    #timer: ReturnType<typeof setTimeout> | undefined;
    #queue: Promise<unknown> = Promise.resolve();

    constructor(options: GuestRoomsOptions) {
        this.#options = options;
        this.#now = options.now ?? Date.now;
    }

    /** Opens the rooms that have a use, closes the others. */
    reconcile(): Promise<void> {
        return this.#serial(() => this.#reconcile());
    }

    /** The name a copy gives its owner. */
    ownerNameOf(shareId: string): string {
        const { people, ownerName } = this.#options;
        const share = people.share(shareId);
        return (
            share?.ownerName ??
            (share && people.ownerNameOfSession(share.sourceSessionId)) ??
            ownerName() ??
            DEFAULT_OWNER_NAME
        );
    }

    /**
     * Refuses a copy for a person whose room cannot open: too many people at once. Nothing to
     * check for a person whose room is open already.
     */
    ensureRoom(personId: string): void {
        const entry = this.#entries.get(personId);
        if (entry?.active) return;
        if (this.#activeCount() >= MAX_GUEST_ROOMS) {
            throw new ActionError(
                409,
                `${MAX_GUEST_ROOMS} people have something to see right now, which is the most this computer can serve at once: close a copy or remove a person first`,
            );
        }
    }

    /**
     * A new invitation for a person (created if they are new). The key is single-use and valid
     * for a day. A person who already has a device gets a new one only with `replace`: the old
     * device is unpaired.
     */
    invite(
        name: string,
        options: { replace?: boolean } = {},
    ): Promise<{ person: Person; key: string; expiresAt: number; roomId: string }> {
        return this.#serial(async () => {
            const { people } = this.#options;
            let person = people.findPerson(name) ?? (await people.addPerson(name));
            if (person.device) {
                if (!options.replace) {
                    throw new ActionError(
                        409,
                        `${person.name} has a device already: a new invitation replaces it`,
                    );
                }
            }
            person = await people.prepareRoom(person.personId);
            if (!this.#entries.get(person.personId)?.active) this.ensureRoom(person.personId);
            const entry = this.#entry(person);
            if (person.device) await entry.hub.revoke(person.device.deviceId);
            // One invitation at a time: a new one cancels the one before.
            for (const earlier of entry.pairKeys.valid()) entry.pairKeys.revoke(earlier);
            const { key, expiresAt } = entry.pairKeys.create({ ttlMs: INVITE_TTL_MS });
            person = await people.setInvite(person.personId, { key, expiresAt });
            await this.#reconcile();
            return { person, key, expiresAt, roomId: entry.identity.roomId };
        });
    }

    /** The person goes: their device is unpaired, their copies are taken away, their room closes. */
    removePerson(name: string): Promise<Person> {
        return this.#serial(async () => {
            const { people, closeShares } = this.#options;
            const person = people.findPerson(name);
            if (!person) throw new ActionError(404, `no person called "${name}"`);
            const entry = this.#entries.get(person.personId);
            if (person.device) {
                // No hub in memory to do it: its notifications go all the same.
                if (entry) await entry.hub.revoke(person.device.deviceId);
                else await this.#options.push.remove(person.device.deviceId);
            }
            await closeShares(person.personId);
            const removed = await people.removePerson(person.personId);
            await this.#reconcile();
            this.#entries.delete(person.personId);
            return removed;
        });
    }

    /** Tells the devices of a person what changed: the projects they see, the one they follow. */
    refresh(personId: string): void {
        // A copy may have a new expiry: the person's devices learn it with the project info.
        for (const share of this.#options.people.shares()) {
            if (share.personId !== personId || share.closedAt !== null) continue;
            void this.republishProject(share.shareId).catch((error: unknown) => {
                this.#options.log(`copy info not sent: ${(error as Error).message}`);
            });
        }
        const entry = this.#entries.get(personId);
        entry?.hub.dropUnavailable();
        void entry?.hub.publishProjects().catch((error: unknown) => {
            this.#options.log(`project list of a guest not sent: ${(error as Error).message}`);
        });
        void this.reconcile().catch((error: unknown) => {
            this.#options.log(`guest rooms not updated: ${(error as Error).message}`);
        });
    }

    /** Sends an op or a message about a copy to the devices following it. */
    publish(projectId: string, message: ServerMessage): void {
        // A copy that was taken away is not sent to anyone, whoever still follows it.
        if (this.#options.people.share(projectId)?.closedAt !== null) return;
        this.#hubOf(projectId)?.publish(projectId, message);
    }

    /** The devices following a copy hear its (new) project info, e.g. the name of the owner. */
    async republishProject(shareId: string): Promise<void> {
        const room = await this.#options.rooms.get(shareId);
        if (room) this.publish(shareId, { type: 'project', project: room.project });
        const personId = this.#options.people.share(shareId)?.personId;
        if (personId) await this.#entries.get(personId)?.hub.publishProjects();
    }

    /** Every device of every room hears the new list (activity moves a project up). */
    async publishProjects(): Promise<void> {
        for (const entry of this.#entries.values()) {
            if (entry.active) await entry.hub.publishProjects();
        }
    }

    isVisible(projectId: string, deviceId: string): boolean {
        return this.#hubOf(projectId)?.isVisible(projectId, deviceId) ?? false;
    }

    /** True when the device is the one of the person the copy was made for. */
    isRecipient(projectId: string, deviceId: string): boolean {
        const share = this.#options.people.share(projectId);
        const person = share && this.#options.people.person(share.personId);
        return person?.device?.deviceId === deviceId && share?.closedAt === null;
    }

    /** The hub of the room of a person (tests, and the commands that revoke a device). */
    hubOf(personId: string): DeviceHub | null {
        return this.#entries.get(personId)?.hub ?? null;
    }

    stop(): void {
        clearTimeout(this.#timer);
    }

    #hubOf(projectId: string): DeviceHub | null {
        const share = this.#options.people.share(projectId);
        return share ? (this.#entries.get(share.personId)?.hub ?? null) : null;
    }

    #activeCount(): number {
        return [...this.#entries.values()].filter((entry) => entry.active).length;
    }

    /** True when the person has something to see, or an invitation waiting to be opened. */
    #hasUse(person: Person): boolean {
        if (person.removedAt || !person.roomKey) return false;
        const hasCopy = this.#options.people
            .shares()
            .some((share) => share.personId === person.personId && share.closedAt === null);
        const invited = person.invite != null && person.invite.expiresAt > this.#now();
        return hasCopy || invited;
    }

    #entry(person: Person): Entry {
        const known = this.#entries.get(person.personId);
        if (known) return known;
        const { people, rooms, push, log, onJoin } = this.#options;
        if (!person.roomKey) throw new Error('the person has no room yet');
        const identity = new RoomIdentity(person.roomKey);
        const pairKeys = new PairKeys({ ttlMs: INVITE_TTL_MS, now: this.#now });
        if (person.invite) pairKeys.restore(person.invite.key, person.invite.expiresAt);
        const scope = new GuestScope(identity, people, person.personId, this.#now);
        const hub = new DeviceHub({
            scope,
            devices: new PersonDevices(people, person.personId, {
                now: this.#now,
                onRegistered: (device) => {
                    const current = people.person(person.personId);
                    if (current) onJoin?.(current, device);
                },
            }),
            rooms,
            projectList: () => this.#projectList(person.personId),
            ...(this.#options.images && { images: this.#options.images }),
            push,
            pairKeys,
            ...(this.#options.helloTimeoutMs !== undefined && {
                helloTimeoutMs: this.#options.helloTimeoutMs,
            }),
            ...(this.#options.presenceTimeoutMs !== undefined && {
                presenceTimeoutMs: this.#options.presenceTimeoutMs,
            }),
            ...(this.#options.maxMessageBytes !== undefined && {
                maxMessageBytes: this.#options.maxMessageBytes,
            }),
            log,
        });
        const entry: Entry = { personId: person.personId, identity, hub, pairKeys, active: false };
        this.#entries.set(person.personId, entry);
        return entry;
    }

    /** What the person sees: their copies, and the owner as the one who shares them. */
    async #projectList(personId: string) {
        const { people, rooms, ownerName } = this.#options;
        const projects: ProjectSummary[] = [];
        for (const share of people.shares()) {
            if (share.personId !== personId || share.closedAt !== null) continue;
            const room = await rooms.get(share.shareId);
            if (!room) continue;
            projects.push({
                id: share.shareId,
                name: room.project.name,
                ...summarizeProject(room.state),
            });
        }
        projects.sort(
            (a, b) => b.lastActivityAt - a.lastActivityAt || a.name.localeCompare(b.name),
        );
        // The id of the room's "computer" is the person's: it tells nothing of the real one.
        return {
            computer: { id: personId, name: ownerName() ?? DEFAULT_OWNER_NAME },
            projects,
        };
    }

    async #reconcile(): Promise<void> {
        const { people, relay, log } = this.#options;
        let next: number | null = null;
        let blocked = false;
        for (const person of people.people()) {
            if (person.invite && person.invite.expiresAt <= this.#now()) {
                await people.setInvite(person.personId, null);
            }
            const current = people.person(person.personId) as Person;
            const entry = this.#entries.get(current.personId);
            if (this.#hasUse(current)) {
                const ready = this.#entry(current);
                if (!ready.active) {
                    if (this.#activeCount() >= MAX_GUEST_ROOMS) {
                        log(
                            `room of a guest not opened: ${MAX_GUEST_ROOMS} rooms are open already`,
                        );
                        blocked = true;
                        continue;
                    }
                    ready.active = true;
                    relay.addRoom(ready.identity, ready.hub);
                }
                if (current.invite) {
                    next = Math.min(next ?? Number.POSITIVE_INFINITY, current.invite.expiresAt);
                }
            } else if (entry?.active) {
                entry.active = false;
                // The person is told the list is empty before the room closes: their app then
                // says "nothing is shared with you" instead of waiting for an owner who is there.
                try {
                    entry.hub.dropUnavailable();
                    await entry.hub.publishProjects();
                    await entry.hub.flush();
                } catch (error) {
                    log(`last list of a guest not sent: ${(error as Error).message}`);
                }
                relay.removeRoom(entry.identity.roomId);
            }
        }
        clearTimeout(this.#timer);
        // A person left without a room because the places were taken tries again later.
        if (blocked) next = Math.min(next ?? Number.POSITIVE_INFINITY, this.#now() + RETRY_MS);
        if (next !== null) {
            const wait = Math.min(Math.max(next - this.#now(), 0) + 1_000, MAX_TIMER_MS);
            this.#timer = setTimeout(() => {
                void this.reconcile().catch((error: unknown) => {
                    log(`guest rooms not updated: ${(error as Error).message}`);
                });
            }, wait);
            this.#timer.unref?.();
        }
    }

    #serial<T>(task: () => Promise<T>): Promise<T> {
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }
}

import { readFile, rename } from 'node:fs/promises';
import {
    computerNameSchema,
    createId,
    deviceIdSchema,
    deviceNameSchema,
    idSchema,
    type PairedDevice,
    pairKeySchema,
    publicKeySchema,
} from '@palmtopai/protocol';
import { generateRoomKeyPair, roomIdOf } from '@palmtopai/protocol/relay-crypto';
import { z } from 'zod';
import { ActionError } from './agent-actions';
import type { DeviceDirectory } from './device-hub';
import type { RegisteredDevice } from './device-registry';
import { isErrnoException, writeFileAtomic } from './fs-utils';

export const MAX_PERSON_NAME = 40;

/** How a person is called in commands and in what the agent reads: one short line of text. */
export const personNameSchema = z
    .string()
    .trim()
    .min(1, 'the name is empty')
    .max(MAX_PERSON_NAME, `the name is longer than ${MAX_PERSON_NAME} characters`)
    .regex(/^\P{Cc}*$/u, 'the name contains control characters');

const timestampSchema = z.number().int().nonnegative();

/** The device a person pairs with their room: one, and the key it proves at every connection. */
const deviceSchema = z.object({
    deviceId: deviceIdSchema,
    name: deviceNameSchema,
    publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    pairedAt: timestampSchema,
    lastSeenAt: timestampSchema.nullable(),
});

/**
 * A person the owner shares checklists with. They have a room of their own at the relay (its key
 * is here, mode 600 like the rest of this file), so that their device reaches the copies made
 * for them and nothing of the computer. A person who was removed keeps the name: what they
 * reviewed stays with the owner.
 */
const personSchema = z.object({
    personId: idSchema,
    name: personNameSchema,
    createdAt: timestampSchema,
    roomKey: z.object({ publicKey: publicKeySchema, privateKey: publicKeySchema }).optional(),
    device: deviceSchema.nullable().optional(),
    /** The key of the invitation still open, kept so it survives a restart of the daemon. */
    invite: z.object({ key: pairKeySchema, expiresAt: timestampSchema }).nullable().optional(),
    removedAt: timestampSchema.nullable().optional(),
});

/**
 * What one person was given from one session of the owner: a project of its own in the data
 * folder (`shareId` is its id), outside `projects.json`, so that nothing that lists the projects
 * of the computer ever sees it. `checklists` links each copy to the checklist it came from.
 */
const shareSchema = z.object({
    shareId: idSchema,
    personId: idSchema,
    sourceProjectId: idSchema,
    sourceSessionId: idSchema,
    /** The session inside the copy. */
    copySessionId: idSchema,
    checklists: z.array(z.object({ source: idSchema, copy: idSchema })),
    createdAt: timestampSchema,
    /** After this the copy is read-only for the guest. */
    expiresAt: timestampSchema,
    /** Set by `palmtop share close`: the copy is no longer shown to the guest. */
    closedAt: timestampSchema.nullable(),
    /** What the guest sees as the name of the owner on this copy (`session owner-name --for`). */
    ownerName: computerNameSchema.optional(),
});

const fileSchema = z.object({
    people: z.array(z.unknown()),
    shares: z.array(z.unknown()),
    /** Name of the owner shown on the copies of a session, by session id. */
    ownerNames: z.record(idSchema, computerNameSchema).default({}),
});

export type Person = z.infer<typeof personSchema>;
export type Share = z.infer<typeof shareSchema>;

const sameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The people the owner shares checklists with and what each of them was given, in `people.json`
 * (mode 600). The private key of each person's room is here too, with the names and the
 * links between a copy and its original.
 */
export class PeopleStore {
    readonly #path: string;
    readonly #people: Map<string, Person>;
    readonly #shares: Map<string, Share>;
    readonly #ownerNames: Map<string, string>;
    readonly #now: () => number;
    #writes: Promise<void> = Promise.resolve();

    private constructor(
        path: string,
        people: Map<string, Person>,
        shares: Map<string, Share>,
        ownerNames: Map<string, string>,
        now: () => number,
    ) {
        this.#path = path;
        this.#people = people;
        this.#shares = shares;
        this.#ownerNames = ownerNames;
        this.#now = now;
    }

    /**
     * Invalid entries (e.g. from another version) are skipped, never fatal. A file that cannot
     * be read at all is put aside, not overwritten by the next save: it holds the room keys.
     */
    static async open(path: string, now: () => number = Date.now): Promise<PeopleStore> {
        let raw: unknown = null;
        let readable = true;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        } catch (error) {
            if (isErrnoException(error, 'ENOENT')) readable = false;
            else if (!(error instanceof SyntaxError)) throw error;
            else await keepAside(path);
        }
        const people = new Map<string, Person>();
        const shares = new Map<string, Share>();
        const ownerNames = new Map<string, string>();
        const parsed = fileSchema.safeParse(raw);
        if (!parsed.success && readable && raw !== null) await keepAside(path);
        if (parsed.success) {
            for (const [sessionId, name] of Object.entries(parsed.data.ownerNames)) {
                ownerNames.set(sessionId, name);
            }
            for (const value of parsed.data.people) {
                const person = personSchema.safeParse(value);
                if (person.success) people.set(person.data.personId, person.data);
            }
            for (const value of parsed.data.shares) {
                const share = shareSchema.safeParse(value);
                if (share.success && people.has(share.data.personId)) {
                    shares.set(share.data.shareId, share.data);
                }
            }
        }
        return new PeopleStore(path, people, shares, ownerNames, now);
    }

    /** Everyone, the removed ones too (their copies are still the owner's to read). */
    people(): Person[] {
        return [...this.#people.values()].sort((a, b) => a.createdAt - b.createdAt);
    }

    person(personId: string): Person | null {
        return this.#people.get(personId) ?? null;
    }

    /**
     * Names are unique among the people who were not removed, without regard to case: `mario`
     * finds `Mario`.
     */
    findPerson(name: string): Person | null {
        return (
            this.people().find((person) => !person.removedAt && sameName(person.name, name)) ?? null
        );
    }

    personOfRoom(roomId: string): Person | null {
        return (
            this.people().find(
                (person) => person.roomKey && roomIdOf(person.roomKey.publicKey) === roomId,
            ) ?? null
        );
    }

    /** Gives the person a room of their own, the first time they are invited. */
    async prepareRoom(personId: string): Promise<Person> {
        const person = this.#require(personId);
        if (person.roomKey) return person;
        return this.#update({ ...person, roomKey: generateRoomKeyPair() });
    }

    /** The invitation still open: replaces any earlier one; `null` when it was used or expired. */
    setInvite(
        personId: string,
        invite: { key: string; expiresAt: number } | null,
    ): Promise<Person> {
        return this.#update({ ...this.#require(personId), invite });
    }

    /** The one device of a person; the invitation is spent with it. */
    setDevice(personId: string, device: RegisteredDevice | null): Promise<Person> {
        const person = this.#require(personId);
        return this.#update({ ...person, device, ...(device && { invite: null }) });
    }

    /** The person leaves: no room, no device, no invitation. What they reviewed stays. */
    removePerson(personId: string): Promise<Person> {
        const { roomKey: _roomKey, ...person } = this.#require(personId);
        return this.#update({ ...person, device: null, invite: null, removedAt: this.#now() });
    }

    ownerNameOfSession(sessionId: string): string | null {
        return this.#ownerNames.get(sessionId) ?? null;
    }

    async setOwnerNameOfSession(sessionId: string, name: string | null): Promise<void> {
        await this.#write(this.#ownerNames, sessionId, name ?? undefined);
    }

    #require(personId: string): Person {
        const person = this.#people.get(personId);
        if (!person) throw new ActionError(404, 'unknown person');
        return person;
    }

    async #update(person: Person): Promise<Person> {
        const checked = personSchema.parse(person);
        await this.#write(this.#people, checked.personId, checked);
        return checked;
    }

    async addPerson(name: string): Promise<Person> {
        const parsed = personNameSchema.safeParse(name);
        if (!parsed.success)
            throw new ActionError(400, parsed.error.issues[0]?.message ?? 'bad name');
        if (this.findPerson(parsed.data)) {
            throw new ActionError(409, `there is already a person called "${parsed.data}"`);
        }
        const person: Person = { personId: createId(), name: parsed.data, createdAt: this.#now() };
        await this.#write(this.#people, person.personId, person);
        return person;
    }

    shares(): Share[] {
        return [...this.#shares.values()].sort((a, b) => a.createdAt - b.createdAt);
    }

    share(shareId: string): Share | null {
        return this.#shares.get(shareId) ?? null;
    }

    /** True for the id of a copy shared with a guest: not a project of the computer. */
    isShareProject(projectId: string): boolean {
        return this.#shares.has(projectId);
    }

    sharesOfSession(projectId: string, sessionId: string): Share[] {
        return this.shares().filter(
            (share) => share.sourceProjectId === projectId && share.sourceSessionId === sessionId,
        );
    }

    sharesOfProject(projectId: string): Share[] {
        return this.shares().filter((share) => share.sourceProjectId === projectId);
    }

    shareFor(personId: string, projectId: string, sessionId: string): Share | null {
        return (
            this.sharesOfSession(projectId, sessionId).find(
                (share) => share.personId === personId,
            ) ?? null
        );
    }

    async putShare(share: Share): Promise<void> {
        await this.#write(this.#shares, share.shareId, shareSchema.parse(share));
    }

    async removeShare(shareId: string): Promise<boolean> {
        if (!this.#shares.has(shareId)) return false;
        await this.#write(this.#shares, shareId, undefined);
        return true;
    }

    /**
     * Changes one entry and saves. If the file cannot be written the entry goes back to what it
     * was: what the daemon believes is what the next start will find (a removal must not
     * come back after a restart).
     */
    async #write<V>(map: Map<string, V>, key: string, value: V | undefined): Promise<void> {
        const had = map.has(key);
        const previous = map.get(key);
        if (value === undefined) map.delete(key);
        else map.set(key, value);
        try {
            await this.#save();
        } catch (error) {
            if (had) map.set(key, previous as V);
            else map.delete(key);
            throw error;
        }
    }

    #save(): Promise<void> {
        const data = `${JSON.stringify(
            {
                people: this.people(),
                shares: this.shares(),
                ownerNames: Object.fromEntries(this.#ownerNames),
            },
            null,
            4,
        )}\n`;
        const run = this.#writes.then(() => writeFileAtomic(this.#path, data));
        // One failed write must not make every later one fail: each caller sees its own.
        this.#writes = run.catch(() => undefined);
        return run;
    }
}

/** Renames a file the store cannot make sense of, so that nothing writes over it. */
async function keepAside(path: string): Promise<void> {
    try {
        await rename(path, `${path}.invalid-${Date.now()}`);
    } catch {
        // Gone already, or not renameable: the next save replaces it, as before.
    }
}

/** `lastSeenAt` is written at most this often: it is shown, not used for security. */
const SEEN_WRITE_INTERVAL_MS = 60_000;

/**
 * The devices of one person, for the hub of their room: at most one, kept in `people.json`.
 * Pairing again replaces it.
 */
export class PersonDevices implements DeviceDirectory {
    readonly #store: PeopleStore;
    readonly #personId: string;
    readonly #now: () => number;
    readonly #onRegistered: (device: RegisteredDevice) => void;

    constructor(
        store: PeopleStore,
        personId: string,
        options: { now?: () => number; onRegistered?: (device: RegisteredDevice) => void } = {},
    ) {
        this.#store = store;
        this.#personId = personId;
        this.#now = options.now ?? Date.now;
        this.#onRegistered = options.onRegistered ?? (() => {});
    }

    get(deviceId: string): RegisteredDevice | null {
        const device = this.#store.person(this.#personId)?.device;
        return device && device.deviceId === deviceId ? device : null;
    }

    async add(device: PairedDevice): Promise<RegisteredDevice> {
        const registered: RegisteredDevice = { ...device, pairedAt: this.#now(), lastSeenAt: null };
        await this.#store.setDevice(this.#personId, registered);
        this.#onRegistered(registered);
        return registered;
    }

    async restore(device: RegisteredDevice): Promise<void> {
        await this.#store.setDevice(this.#personId, device);
    }

    async remove(deviceId: string): Promise<boolean> {
        if (!this.get(deviceId)) return false;
        await this.#store.setDevice(this.#personId, null);
        return true;
    }

    async seen(deviceId: string): Promise<void> {
        const device = this.get(deviceId);
        const now = this.#now();
        if (
            !device ||
            (device.lastSeenAt !== null && now - device.lastSeenAt < SEEN_WRITE_INTERVAL_MS)
        ) {
            return;
        }
        await this.#store.setDevice(this.#personId, { ...device, lastSeenAt: now });
    }
}

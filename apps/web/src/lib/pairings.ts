import { computerNameSchema, idSchema, LIMITS, roomIdSchema } from '@palmtopai/protocol';
import { z } from 'zod';
import { browserStore, type KeyValueStore, readJson, writeJson } from './storage';

/**
 * v3: a pairing is with a computer (one room, all of its projects) and holds the computer's room
 * key, which every connection must prove (end-to-end encryption). The token of v2 is gone: those
 * pairings are not read, the device pairs again.
 */
const PAIRINGS_KEY = 'palmtop.pairings.v3';
const ACTIVE_KEY = 'palmtop.activeProject';
const ACTIVE_COMPUTER_KEY = 'palmtop.activeComputer';

/**
 * A project of a paired computer, kept to show the list before the first connection, and on the
 * Dashboard while the computer is not connected (counts from the last time it was).
 */
export const pairedProjectSchema = z.object({
    id: idSchema,
    name: z.string().min(1).max(LIMITS.title),
    lastActivityAt: z.number().int().nonnegative().optional(),
    sessions: z.number().int().nonnegative().optional(),
    pending: z.number().int().nonnegative().optional(),
    /** Sessions in the archive, left out of the counts above (computers from 0.20). */
    archived: z
        .array(
            z.object({
                id: idSchema,
                title: z.string().min(1).max(LIMITS.title),
                lastActivityAt: z.number().int().nonnegative(),
            }),
        )
        .max(200)
        .optional(),
});

export const pairingSchema = z.object({
    computerId: idSchema,
    /** Relay room of the computer: `sha256` of `computerKey`. */
    roomId: roomIdSchema,
    /** The computer's room key (Ed25519, raw, base64url), fixed at pairing. */
    computerKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    /** Last known name of the computer. */
    computer: computerNameSchema.optional(),
    /** Projects last seen on the computer, most recently active first. */
    projects: z.array(pairedProjectSchema).default([]),
    pairedAt: z.number().int().nonnegative(),
    /**
     * Paired with an invitation: the "computer" is the room of somebody who shares checklists
     * with this device. It holds those checklists and nothing else.
     */
    guest: z.boolean().optional(),
    /**
     * Fingerprint of this device's key when the computer last accepted it. Pairings made before
     * it was kept have none until the next connection.
     */
    deviceKey: z.string().max(64).optional(),
});

export type PairedProject = z.infer<typeof pairedProjectSchema>;

/** What a pairing keeps of a project of the computer's list. */
export function pairedProjectOf(project: PairedProject): PairedProject {
    const { id, name, lastActivityAt, sessions, pending, archived } = project;
    return {
        id,
        name,
        ...(lastActivityAt !== undefined && { lastActivityAt }),
        ...(sessions !== undefined && { sessions }),
        ...(pending !== undefined && { pending }),
        ...(archived && archived.length > 0 && { archived }),
    };
}

/** True for a project whose sessions are all in the archive: off the Dashboard. */
export function isArchivedProject(project: PairedProject): boolean {
    return (project.sessions ?? 0) === 0 && (project.archived?.length ?? 0) > 0;
}
export type Pairing = z.infer<typeof pairingSchema>;

export function loadPairings(store: KeyValueStore | null = browserStore()): Pairing[] {
    const parsed = z.array(pairingSchema).safeParse(readJson(store, PAIRINGS_KEY));
    return parsed.success ? parsed.data : [];
}

function savePairings(pairings: Pairing[], store: KeyValueStore | null): Pairing[] {
    writeJson(store, PAIRINGS_KEY, pairings);
    return pairings;
}

/** Adds a pairing or refreshes an existing one (pairing the same computer again). */
export function upsertPairing(
    input: {
        computerId: string;
        roomId: string;
        computerKey: string;
        computer?: string;
        guest?: boolean;
        deviceKey?: string;
    },
    store: KeyValueStore | null = browserStore(),
    now = Date.now(),
): Pairing[] {
    const pairings = loadPairings(store);
    const existing = pairings.find((pairing) => pairing.computerId === input.computerId);
    // Paired again: the key of an earlier pairing says nothing about this one.
    const { deviceKey: _earlier, ...kept } = existing ?? {};
    const next: Pairing = { projects: [], ...kept, ...input, pairedAt: now };
    return savePairings(
        [...pairings.filter((pairing) => pairing.computerId !== input.computerId), next],
        store,
    );
}

/**
 * Remembers the computer name and its projects, to show them while it is offline, and the key
 * the computer just accepted (`deviceKey`): only a connection that proved it sends the list.
 */
export function rememberComputer(
    computerId: string,
    info: {
        computer?: string | undefined;
        projects: PairedProject[];
        deviceKey?: string | undefined;
    },
    store: KeyValueStore | null = browserStore(),
): Pairing[] {
    const pairings = loadPairings(store);
    const target = pairings.find((pairing) => pairing.computerId === computerId);
    if (!target) return pairings;
    const computer = info.computer ?? target.computer;
    const deviceKey = info.deviceKey ?? target.deviceKey;
    if (
        target.computer === computer &&
        target.deviceKey === deviceKey &&
        sameProjects(target.projects, info.projects)
    ) {
        return pairings;
    }
    return savePairings(
        pairings.map((pairing) =>
            pairing === target
                ? {
                      ...pairing,
                      ...(computer !== undefined && { computer }),
                      ...(deviceKey !== undefined && { deviceKey }),
                      projects: info.projects,
                  }
                : pairing,
        ),
        store,
    );
}

/**
 * True when this device no longer has the key it paired with: the computer said so, or the
 * pairing was made with another key than the one this device has now (the browser deleted it).
 */
export function lostKey(
    pairing: Pairing,
    fingerprint: string | undefined,
    reason?: string | null,
): boolean {
    if (reason === 'key') return true;
    return (
        fingerprint !== undefined &&
        pairing.deviceKey !== undefined &&
        pairing.deviceKey !== fingerprint
    );
}

function sameProjects(a: PairedProject[], b: PairedProject[]): boolean {
    return (
        a.length === b.length &&
        a.every((project, index) => {
            const other = b[index];
            return (
                other?.id === project.id &&
                other.name === project.name &&
                other.lastActivityAt === project.lastActivityAt &&
                other.sessions === project.sessions &&
                other.pending === project.pending &&
                (other.archived ?? []).map((session) => session.id).join() ===
                    (project.archived ?? []).map((session) => session.id).join()
            );
        })
    );
}

export function removePairing(
    computerId: string,
    store: KeyValueStore | null = browserStore(),
): Pairing[] {
    return savePairings(
        loadPairings(store).filter((pairing) => pairing.computerId !== computerId),
        store,
    );
}

/** The computer a project belongs to, among the paired ones. */
export function pairingOfProject(pairings: Pairing[], projectId: string | null): Pairing | null {
    if (!projectId) return null;
    return (
        pairings.find((pairing) => pairing.projects.some((project) => project.id === projectId)) ??
        null
    );
}

export function loadActiveProject(store: KeyValueStore | null = browserStore()): string | null {
    const value = readJson(store, ACTIVE_KEY);
    return typeof value === 'string' ? value : null;
}

export function saveActiveProject(
    projectId: string,
    store: KeyValueStore | null = browserStore(),
): void {
    writeJson(store, ACTIVE_KEY, projectId);
}

/** The computer open on this device; `null` before the first choice (the app picks one). */
export function loadActiveComputer(store: KeyValueStore | null = browserStore()): string | null {
    const value = readJson(store, ACTIVE_COMPUTER_KEY);
    return typeof value === 'string' ? value : null;
}

export function saveActiveComputer(
    computerId: string,
    store: KeyValueStore | null = browserStore(),
): void {
    writeJson(store, ACTIVE_COMPUTER_KEY, computerId);
}

/**
 * The computer to show: the one opened last, else the one holding the selected project, else the
 * one paired last. A computer without projects can be open too (just paired, nothing there yet).
 */
export function openComputer(
    pairings: Pairing[],
    computerId: string | null,
    projectId: string | null,
): Pairing | null {
    return (
        pairings.find((pairing) => pairing.computerId === computerId) ??
        pairingOfProject(pairings, projectId) ??
        pairings.at(-1) ??
        null
    );
}

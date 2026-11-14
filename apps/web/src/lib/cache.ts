import { type ClientCache, indexedDbCache } from '@palmtopai/client';
import { namedScreenshots, screenshotIds } from '@palmtopai/protocol';
import { useEffect, useState } from 'react';

/**
 * Projects of a paired computer kept on this device (IndexedDB): shown while the computer is
 * off, with the edits not delivered yet. `undefined` where IndexedDB is missing.
 */
export function computerCache(computerId: string): ClientCache | undefined {
    if (typeof indexedDB === 'undefined') return undefined;
    return indexedDbCache({ scope: computerId });
}

/**
 * Forgets the screenshots this device kept that no note names any more: the ones of the cached
 * projects (their state and their queued edits) are the ones to keep. Never throws: a cache that
 * cannot be read keeps everything.
 */
export async function pruneCachedImages(cache: ClientCache): Promise<void> {
    if (!cache.pruneImages) return;
    try {
        const keep = new Set<string>();
        for (const projectId of await cache.projectIds()) {
            const entry = await cache.load(projectId);
            if (!entry) continue;
            if (entry.state) for (const id of namedScreenshots(entry.state)) keep.add(id);
            // What the people wrote on their copies names pictures too.
            for (const session of entry.shares ?? []) {
                for (const person of session.people) {
                    const notes = [person.note, ...Object.values(person.items).map((i) => i.note)];
                    for (const text of notes) {
                        if (text) for (const id of screenshotIds(text)) keep.add(id);
                    }
                }
            }
            for (const op of entry.pending) {
                const note = 'note' in op.payload ? op.payload.note : undefined;
                if (typeof note === 'string') for (const id of screenshotIds(note)) keep.add(id);
            }
        }
        await cache.pruneImages(keep);
    } catch {
        // Kept for next time.
    }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "just now", "5 min ago", "3 h ago", then the date and time. */
export function formatSyncedAt(at: number, now: number): string {
    const elapsed = Math.max(0, now - at);
    if (elapsed < MINUTE) return 'just now';
    if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} min ago`;
    if (elapsed < 24 * HOUR) return `${Math.floor(elapsed / HOUR)} h ago`;
    return `on ${new Date(at).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
    })}`;
}

/** The current time, refreshed every `intervalMs` while mounted. */
export function useNow(intervalMs = MINUTE): number {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(timer);
    }, [intervalMs]);
    return now;
}

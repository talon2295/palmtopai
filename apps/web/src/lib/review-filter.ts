import { type ChecklistKind, type ItemStatus, pendingReviews } from '@palmtopai/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserStore, type KeyValueStore, readJson, writeJson } from './storage';

/**
 * With reviewed items hidden, the lists with nothing left to review go after the others, each
 * group in its own order. A list waits while one of its items is still settling (`busy`: the
 * seconds kept for a note, or a note being written), so it never moves under the user's finger.
 * Complete means what "to review" counts: every check marked, a question answered.
 */
export function completeListsLast<
    L extends {
        checklist: { kind: ChecklistKind };
        items: readonly { id: string; status?: ItemStatus }[];
    },
>(lists: readonly L[], busy: (itemId: string) => boolean): L[] {
    const complete = (list: L) =>
        list.items.length > 0 &&
        pendingReviews(list.checklist, list.items) === 0 &&
        !list.items.some((item) => busy(item.id));
    return [...lists.filter((list) => !complete(list)), ...lists.filter(complete)];
}

const HIDE_REVIEWED_KEY = 'palmtop.hideReviewed';
const HIDE_RESULTS_KEY = 'palmtop.hideResults';

/** How long an item reviewed on this device stays visible while reviewed items are hidden. */
export const HIDE_DELAY_MS = 5_000;

/** A display preference of this device: no op is sent, other devices are not affected. */
export function loadHideReviewed(store: KeyValueStore | null = browserStore()): boolean {
    return readJson(store, HIDE_REVIEWED_KEY) === true;
}

export function saveHideReviewed(
    hide: boolean,
    store: KeyValueStore | null = browserStore(),
): void {
    writeJson(store, HIDE_REVIEWED_KEY, hide);
}

/** Same for the answers of the people a session is shared with: shown unless hidden. */
export function loadHideResults(store: KeyValueStore | null = browserStore()): boolean {
    return readJson(store, HIDE_RESULTS_KEY) === true;
}

export function saveHideResults(hide: boolean, store: KeyValueStore | null = browserStore()): void {
    writeJson(store, HIDE_RESULTS_KEY, hide);
}

export interface Countdowns {
    /** Items counting down, with a run number that changes on every restart. */
    runs: ReadonlyMap<string, number>;
    /** Starts or restarts the countdown of an item. */
    start(itemId: string): void;
    stop(itemId: string): void;
    clear(): void;
}

/** Per-item countdowns of `durationMs`: an item leaves `runs` when its countdown ends. */
export function useCountdowns(durationMs: number): Countdowns {
    const [runs, setRuns] = useState<ReadonlyMap<string, number>>(() => new Map());
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const lastRun = useRef(0);

    const stop = useCallback((itemId: string) => {
        clearTimeout(timers.current.get(itemId));
        timers.current.delete(itemId);
        setRuns((current) => {
            if (!current.has(itemId)) return current;
            const next = new Map(current);
            next.delete(itemId);
            return next;
        });
    }, []);

    const start = useCallback(
        (itemId: string) => {
            clearTimeout(timers.current.get(itemId));
            lastRun.current += 1;
            const run = lastRun.current;
            setRuns((current) => new Map(current).set(itemId, run));
            timers.current.set(
                itemId,
                setTimeout(() => stop(itemId), durationMs),
            );
        },
        [durationMs, stop],
    );

    const clear = useCallback(() => {
        for (const timer of timers.current.values()) clearTimeout(timer);
        timers.current.clear();
        setRuns((current) => (current.size === 0 ? current : new Map()));
    }, []);

    useEffect(() => clear, [clear]);

    return { runs, start, stop, clear };
}

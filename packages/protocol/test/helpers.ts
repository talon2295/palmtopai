import { createId, createOp, type OpOf, type OpType } from '../src';

export const projectId = createId();
export const sessionId = createId();

/** Builds an op for the test project with an explicit clock. */
export function op<T extends OpType>(
    type: T,
    payload: OpOf<T>['payload'],
    clock: { lamport: number; deviceId: string },
    options: { ts?: number; sessionId?: string } = {},
): OpOf<T> {
    return createOp({
        projectId,
        sessionId: options.sessionId ?? sessionId,
        type,
        payload,
        clock,
        ts: options.ts ?? clock.lamport * 1000,
    });
}

/** Small seeded PRNG so failing permutations are reproducible. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export function shuffle<T>(values: readonly T[], random: () => number): T[] {
    const copy = [...values];
    for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [copy[i], copy[j]] = [copy[j] as T, copy[i] as T];
    }
    return copy;
}

export function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
}

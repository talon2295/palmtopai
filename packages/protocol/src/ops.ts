import type { Clock } from './clock';
import { createId } from './ids';
import { type OpOf, type OpType, PROTOCOL_VERSION } from './schemas';

export interface OpInput<T extends OpType> {
    projectId: string;
    sessionId: string;
    type: T;
    payload: OpOf<T>['payload'];
    clock: Clock;
    ts?: number;
    opId?: string;
}

/** Builds a versioned op envelope. The caller must tick its clock for every op. */
export function createOp<T extends OpType>(input: OpInput<T>): OpOf<T> {
    return {
        v: PROTOCOL_VERSION,
        opId: input.opId ?? createId(),
        projectId: input.projectId,
        sessionId: input.sessionId,
        type: input.type,
        payload: input.payload,
        clock: input.clock,
        ts: input.ts ?? Date.now(),
    } as OpOf<T>;
}

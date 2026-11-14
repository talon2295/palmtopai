import type { ProjectMeta, ProjectState, SeqOp } from '@palmtopai/protocol';

export interface Snapshot {
    state: ProjectState;
    /** Seq of the last op folded into `state`. */
    seq: number;
}

export interface LoadedProject {
    meta: ProjectMeta;
    snapshot: Snapshot;
    /** Ops after the snapshot, in seq order. */
    ops: SeqOp[];
}

/**
 * Persistence for project state. Adapters never see keys: secrets live in the
 * registry, so the same contract can later be backed by a remote relay.
 *
 * Invariants enforced by every adapter (see the contract suite):
 * - op seqs are strictly increasing per project;
 * - a snapshot cannot go back in time or past the last appended op;
 * - saving a snapshot drops the ops it already contains.
 */
export interface StorageAdapter {
    /** Creates an empty project (seq 0). Fails if it already exists. */
    createProject(meta: ProjectMeta): Promise<void>;
    loadProject(projectId: string): Promise<LoadedProject | null>;
    appendOps(projectId: string, ops: SeqOp[]): Promise<void>;
    saveSnapshot(projectId: string, state: ProjectState, seq: number): Promise<void>;
    listProjects(): Promise<ProjectMeta[]>;
    /** Deletes a project and all its data. Deleting an unknown project does nothing. */
    deleteProject(projectId: string): Promise<void>;
}

export class StorageError extends Error {
    override name = 'StorageError';
}

/** Shared validation so every adapter rejects the same writes. */
export function assertAppendable(projectId: string, lastSeq: number, ops: SeqOp[]): void {
    let previous = lastSeq;
    for (const { seq, op } of ops) {
        if (op.projectId !== projectId) {
            throw new StorageError(`op ${op.opId} belongs to project ${op.projectId}`);
        }
        if (seq <= previous) {
            throw new StorageError(`op seq ${seq} is not greater than ${previous}`);
        }
        previous = seq;
    }
}

export function assertSnapshotable(
    projectId: string,
    current: { snapshotSeq: number; lastSeq: number },
    state: ProjectState,
    seq: number,
): void {
    if (state.projectId !== projectId) {
        throw new StorageError(`snapshot state belongs to project ${state.projectId}`);
    }
    if (seq < current.snapshotSeq) {
        throw new StorageError(`snapshot seq ${seq} is older than ${current.snapshotSeq}`);
    }
    if (seq > current.lastSeq) {
        throw new StorageError(`snapshot seq ${seq} is past the last op ${current.lastSeq}`);
    }
}

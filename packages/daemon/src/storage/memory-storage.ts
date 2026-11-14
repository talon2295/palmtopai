import {
    createProjectState,
    type ProjectMeta,
    type ProjectState,
    type SeqOp,
} from '@palmtopai/protocol';
import {
    assertAppendable,
    assertSnapshotable,
    type LoadedProject,
    type StorageAdapter,
    StorageError,
} from './adapter';

/** In-memory adapter for unit tests. Values are cloned so callers cannot mutate stored data. */
export class MemoryStorage implements StorageAdapter {
    readonly #projects = new Map<string, LoadedProject>();

    async createProject(meta: ProjectMeta): Promise<void> {
        if (this.#projects.has(meta.id)) {
            throw new StorageError(`project ${meta.id} already exists`);
        }
        this.#projects.set(meta.id, {
            meta: structuredClone(meta),
            snapshot: { state: createProjectState(meta.id), seq: 0 },
            ops: [],
        });
    }

    async loadProject(projectId: string): Promise<LoadedProject | null> {
        const project = this.#projects.get(projectId);
        return project ? structuredClone(project) : null;
    }

    async appendOps(projectId: string, ops: SeqOp[]): Promise<void> {
        const project = this.#require(projectId);
        assertAppendable(projectId, lastSeqOf(project), ops);
        project.ops.push(...structuredClone(ops));
    }

    async saveSnapshot(projectId: string, state: ProjectState, seq: number): Promise<void> {
        const project = this.#require(projectId);
        assertSnapshotable(
            projectId,
            { snapshotSeq: project.snapshot.seq, lastSeq: lastSeqOf(project) },
            state,
            seq,
        );
        project.snapshot = { state: structuredClone(state), seq };
        project.ops = project.ops.filter((entry) => entry.seq > seq);
    }

    async listProjects(): Promise<ProjectMeta[]> {
        return [...this.#projects.values()].map((project) => structuredClone(project.meta));
    }

    async deleteProject(projectId: string): Promise<void> {
        this.#projects.delete(projectId);
    }

    #require(projectId: string): LoadedProject {
        const project = this.#projects.get(projectId);
        if (!project) throw new StorageError(`unknown project ${projectId}`);
        return project;
    }
}

function lastSeqOf(project: LoadedProject): number {
    return project.ops.at(-1)?.seq ?? project.snapshot.seq;
}

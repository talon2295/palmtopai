import { readFile } from 'node:fs/promises';
import { createId, idSchema, publicKeySchema } from '@palmtopai/protocol';
import { generateRoomKeyPair } from '@palmtopai/protocol/relay-crypto';
import { z } from 'zod';
import { isErrnoException, writeFileAtomic } from './fs-utils';
import { RoomIdentity } from './room-identity';
import { normalizeRoot, rootName, sameRoot } from './root-path';
import type { StorageAdapter } from './storage/adapter';

/**
 * Format of `projects.json`. Version 2 (with the computer token) is migrated at startup, older
 * files are wiped (see `resetOutdatedHome`).
 */
export const REGISTRY_VERSION = 3;

const projectSchema = z.object({
    projectId: idSchema,
    rootPath: z.string().min(1),
    createdAt: z.number().int().nonnegative(),
});

/**
 * Identity of this computer: one relay room for all its projects, so a device is paired with the
 * computer and follows every project on it, including the ones created later. The room key is
 * also what the computer proves to its devices (end-to-end encryption, `e2e.ts`).
 */
const computerSchema = z.object({
    id: idSchema,
    roomKey: z.object({ publicKey: publicKeySchema, privateKey: publicKeySchema }),
});

const fileSchema = z.object({
    version: z.literal(REGISTRY_VERSION),
    computer: computerSchema,
    projects: z.array(projectSchema),
});

type StoredProject = z.infer<typeof projectSchema>;
type StoredComputer = z.infer<typeof computerSchema>;

export interface ResolvedProject {
    projectId: string;
    name: string;
    created: boolean;
}

export interface RegisteredProject {
    projectId: string;
    name: string;
    rootPath: string;
    createdAt: number;
}

/**
 * Maps project root paths to project ids and holds the computer's room key (`projects.json`,
 * mode 600). The private room key never leaves this class: only signatures do, for the relay
 * and, through a non-extractable WebCrypto key, for the devices.
 */
export class ProjectRegistry {
    readonly #path: string;
    readonly #storage: StorageAdapter;
    readonly #computer: StoredComputer;
    readonly #identity: RoomIdentity;
    readonly roomId: string;
    readonly #byId = new Map<string, StoredProject>();
    readonly #createdListeners = new Set<(projectId: string) => void>();
    readonly #platform: NodeJS.Platform;
    #queue: Promise<unknown> = Promise.resolve();

    private constructor(
        path: string,
        storage: StorageAdapter,
        computer: StoredComputer,
        projects: StoredProject[],
        platform: NodeJS.Platform,
    ) {
        this.#platform = platform;
        this.#path = path;
        this.#storage = storage;
        this.#computer = computer;
        this.#identity = new RoomIdentity(computer.roomKey);
        this.roomId = this.#identity.roomId;
        for (const stored of projects) this.#byId.set(stored.projectId, stored);
    }

    /** `platform` is for tests: it says how folders are written and compared. */
    static async open(
        path: string,
        storage: StorageAdapter,
        platform: NodeJS.Platform = process.platform,
    ): Promise<ProjectRegistry> {
        let file: z.infer<typeof fileSchema> | null = null;
        try {
            const result = fileSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
            if (!result.success) throw new Error('unexpected format');
            file = result.data;
        } catch (error) {
            if (!isErrnoException(error, 'ENOENT')) {
                // Never include file contents in the message: they contain the private room key.
                throw new Error(`cannot read project registry ${path}: ${(error as Error).name}`);
            }
        }
        if (file) return new ProjectRegistry(path, storage, file.computer, file.projects, platform);

        // First start on this computer: a fresh identity, saved before anything can use it.
        const computer: StoredComputer = { id: createId(), roomKey: generateRoomKeyPair() };
        const registry = new ProjectRegistry(path, storage, computer, [], platform);
        await registry.#persist();
        return registry;
    }

    get computerId(): string {
        return this.#computer.id;
    }

    /** Called after a new project is persisted (devices are told about it). */
    onCreated(listener: (projectId: string) => void): () => void {
        this.#createdListeners.add(listener);
        return () => this.#createdListeners.delete(listener);
    }

    projectIds(): string[] {
        return [...this.#byId.keys()];
    }

    /** Every project of this computer, as devices see them listed. */
    list(): RegisteredProject[] {
        return [...this.#byId.values()].map((stored) => ({
            projectId: stored.projectId,
            name: rootName(stored.rootPath, this.#platform),
            rootPath: stored.rootPath,
            createdAt: stored.createdAt,
        }));
    }

    /** Public room key: the identity devices pin when they pair (`sha256` of it is `roomId`). */
    get roomPublicKey(): string {
        return this.#identity.roomPublicKey;
    }

    /** The room key as a WebCrypto signing key, for the end-to-end handshakes. */
    signingKey(): ReturnType<RoomIdentity['signingKey']> {
        return this.#identity.signingKey();
    }

    /** Proves to the relay that this daemon holds the key of the computer's room. */
    roomProof(nonce: string): { publicKey: string; signature: string } {
        return this.#identity.roomProof(nonce);
    }

    /** What the log says about this room (the hub is not told more than that). */
    get label(): string {
        return this.#computer.id;
    }

    has(projectId: string): boolean {
        return this.#byId.has(projectId);
    }

    /** Public project facts. */
    info(projectId: string): { projectId: string; name: string; rootPath: string } | null {
        const entry = this.#byId.get(projectId);
        if (!entry) return null;
        return {
            projectId,
            name: rootName(entry.rootPath, this.#platform),
            rootPath: entry.rootPath,
        };
    }

    /** Returns the project for `rootPath` without creating it; `null` if there is none. */
    async find(rootPath: string): Promise<ResolvedProject | null> {
        // Waits for pending creations, so a lookup right after `resolve` sees the new project.
        await this.#queue;
        return this.#existing(rootPath);
    }

    /** Returns the project for `rootPath`, creating it the first time. */
    resolve(input: { rootPath: string; gitRemote?: string }): Promise<ResolvedProject> {
        const rootPath = normalizeRoot(input.rootPath, this.#platform);
        const task = async (): Promise<ResolvedProject> => {
            const existing = this.#existing(rootPath);
            if (existing) return existing;
            const name = rootName(rootPath, this.#platform);

            const stored: StoredProject = {
                projectId: createId(),
                rootPath,
                createdAt: Date.now(),
            };
            await this.#storage.createProject({
                id: stored.projectId,
                name,
                rootPath,
                ...(input.gitRemote && { gitRemote: input.gitRemote }),
                createdAt: stored.createdAt,
            });
            this.#byId.set(stored.projectId, stored);
            await this.#persist();
            for (const listener of this.#createdListeners) listener(stored.projectId);
            return { projectId: stored.projectId, name, created: true };
        };
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }

    /** Forgets a project: devices stop seeing it in the list of this computer. */
    remove(projectId: string): Promise<boolean> {
        const task = async (): Promise<boolean> => {
            if (!this.#byId.delete(projectId)) return false;
            await this.#persist();
            return true;
        };
        const run = this.#queue.then(task, task);
        this.#queue = run.catch(() => undefined);
        return run;
    }

    #existing(rootPath: string): ResolvedProject | null {
        const entry = [...this.#byId.values()].find((candidate) =>
            sameRoot(candidate.rootPath, rootPath, this.#platform),
        );
        if (!entry) return null;
        return {
            projectId: entry.projectId,
            name: rootName(entry.rootPath, this.#platform),
            created: false,
        };
    }

    #persist(): Promise<void> {
        const data = {
            version: REGISTRY_VERSION,
            computer: this.#computer,
            projects: [...this.#byId.values()],
        };
        return writeFileAtomic(this.#path, `${JSON.stringify(data, null, 4)}\n`);
    }
}

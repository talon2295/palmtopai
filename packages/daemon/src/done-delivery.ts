import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { writeFileAtomic } from './fs-utils';

const fileSchema = z.object({ sessions: z.record(z.string(), z.string()) });

/**
 * Which "done" of each session the agent has been told about, in `done-delivered.json` (mode 600):
 * `project/session` and the id of the op that wrote the done. It is local to this computer and
 * never replicated, like the record of the notes the agent read. A `palmtop wait` started again
 * without a new done does not return at once, and the entries of a session go with the session and
 * with its project.
 */
export class DoneDeliveries {
    readonly #path: string;
    readonly #sessions: Map<string, string>;
    #writes: Promise<void> = Promise.resolve();

    private constructor(path: string, sessions: Map<string, string>) {
        this.#path = path;
        this.#sessions = sessions;
    }

    /** An unreadable file is the same as no file: the dones then all read as not delivered. */
    static async open(path: string): Promise<DoneDeliveries> {
        const sessions = new Map<string, string>();
        let raw: unknown = null;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        } catch {
            // No file yet, or one that cannot be read.
        }
        const parsed = fileSchema.safeParse(raw);
        if (parsed.success) {
            for (const [key, opId] of Object.entries(parsed.data.sessions)) sessions.set(key, opId);
        }
        return new DoneDeliveries(path, sessions);
    }

    get(projectId: string, sessionId: string): string | undefined {
        return this.#sessions.get(`${projectId}/${sessionId}`);
    }

    set(projectId: string, sessionId: string, opId: string): Promise<void> {
        const key = `${projectId}/${sessionId}`;
        if (this.#sessions.get(key) === opId) return this.#writes;
        this.#sessions.set(key, opId);
        return this.#save();
    }

    removeSession(projectId: string, sessionId: string): Promise<void> {
        if (!this.#sessions.delete(`${projectId}/${sessionId}`)) return this.#writes;
        return this.#save();
    }

    removeProject(projectId: string): Promise<void> {
        let removed = false;
        for (const key of [...this.#sessions.keys()]) {
            if (!key.startsWith(`${projectId}/`)) continue;
            this.#sessions.delete(key);
            removed = true;
        }
        return removed ? this.#save() : this.#writes;
    }

    #save(): Promise<void> {
        const data = `${JSON.stringify({ sessions: Object.fromEntries(this.#sessions) }, null, 4)}\n`;
        this.#writes = this.#writes
            .catch(() => undefined)
            .then(() => writeFileAtomic(this.#path, data));
        return this.#writes;
    }
}

/**
 * Wakes the `palmtop wait` requests that are holding (they look at the state again when something
 * that could end their wait happened: a done, a session or a project removed) and knows which
 * `palmtop wait` process waits for each session.
 *
 * One process waits for a session: a new one takes the place of the one before, which is told at
 * its next question (or at once, if it is holding) and ends. A process is the same one while it asks
 * again and again (every hold of the daemon) with the same `client`. A wait that stopped asking for
 * longer than `graceMs` is not waiting any more.
 */
export class DoneWaiters {
    readonly #listeners = new Set<() => void>();
    /** Session (`project/session`) to the process that waits for it. */
    readonly #holders = new Map<string, { client: string; lastSeen: number }>();
    readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #changes = new Set<(projectId: string) => void>();
    readonly #graceMs: number;
    readonly #now: () => number;

    constructor(options: { graceMs?: number; now?: () => number } = {}) {
        this.#graceMs = options.graceMs ?? 35_000;
        this.#now = options.now ?? Date.now;
    }

    /** Called with the project whenever the sessions somebody waits in changed. */
    onChange(listener: (projectId: string) => void): void {
        this.#changes.add(listener);
    }

    /** The sessions of a project somebody is waiting in. */
    waitingIn(projectId: string): string[] {
        const prefix = `${projectId}/`;
        return this.waiting()
            .filter((key) => key.startsWith(prefix))
            .map((key) => key.slice(prefix.length));
    }

    /** Stops the timers that notice a wait gone silent. */
    stop(): void {
        for (const timer of this.#timers.values()) clearTimeout(timer);
        this.#timers.clear();
    }

    #changed(key: string): void {
        const projectId = key.slice(0, key.indexOf('/'));
        for (const listener of this.#changes) listener(projectId);
    }

    /** A wait that stops asking is gone after the grace: devices are told then, not later. */
    #watch(key: string): void {
        clearTimeout(this.#timers.get(key));
        const timer = setTimeout(() => {
            this.#timers.delete(key);
            const holder = this.#holders.get(key);
            if (!holder || this.#now() - holder.lastSeen <= this.#graceMs) return;
            this.#holders.delete(key);
            this.#changed(key);
        }, this.#graceMs + 50);
        timer.unref?.();
        this.#timers.set(key, timer);
    }

    /** How many requests are holding (tests). */
    get holding(): number {
        return this.#listeners.size;
    }

    /**
     * A question of a `palmtop wait` process. `claim` is its first one: it takes the place of the
     * process that waited before. Later ones only keep the place: false when another process took
     * it meanwhile, which means this one has to end.
     */
    hold(key: string, client: string, claim: boolean): boolean {
        const now = this.#now();
        const current = this.#holders.get(key);
        const alive = current !== undefined && now - current.lastSeen <= this.#graceMs;
        if (!claim && alive && current.client !== client) return false;
        this.#holders.set(key, { client, lastSeen: now });
        this.#watch(key);
        if (claim && alive && current.client !== client) this.notify();
        if (!alive) this.#changed(key);
        return true;
    }

    /** True while `client` is the one waiting for the session. */
    isHolder(key: string, client: string): boolean {
        return this.#holders.get(key)?.client === client;
    }

    /** The process ended (a done, the session gone, the question cut off): its place is free. */
    release(key: string, client: string): void {
        if (this.#holders.get(key)?.client !== client) return;
        this.#holders.delete(key);
        clearTimeout(this.#timers.get(key));
        this.#timers.delete(key);
        this.#changed(key);
    }

    /** The sessions somebody is waiting for, as `project/session`. */
    waiting(): string[] {
        const now = this.#now();
        return [...this.#holders]
            .filter(([, holder]) => now - holder.lastSeen <= this.#graceMs)
            .map(([key]) => key);
    }

    notify(): void {
        for (const listener of [...this.#listeners]) listener();
    }

    /** Resolves at the next `notify`, after `ms`, or when `signal` aborts: whichever comes first. */
    next(ms: number, signal?: AbortSignal): Promise<void> {
        return new Promise<void>((resolve) => {
            const finish = () => {
                clearTimeout(timer);
                this.#listeners.delete(finish);
                signal?.removeEventListener('abort', finish);
                resolve();
            };
            const timer = setTimeout(finish, ms);
            this.#listeners.add(finish);
            signal?.addEventListener('abort', finish, { once: true });
        });
    }
}

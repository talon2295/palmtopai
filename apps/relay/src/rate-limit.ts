/** Counts events per key in fixed windows (e.g. connections per IP per minute). */
export class WindowLimiter {
    readonly #limit: number;
    readonly #windowMs: number;
    readonly #now: () => number;
    readonly #windows = new Map<string, { start: number; count: number }>();
    #lastPrune = 0;

    constructor(limit: number, windowMs: number, now: () => number = Date.now) {
        this.#limit = limit;
        this.#windowMs = windowMs;
        this.#now = now;
    }

    /** Records one event; returns false when the key is over the limit in the current window. */
    hit(key: string): boolean {
        const now = this.#now();
        this.#prune(now);
        const window = this.#windows.get(key);
        if (!window || now - window.start >= this.#windowMs) {
            this.#windows.set(key, { start: now, count: 1 });
            return this.#limit >= 1;
        }
        window.count += 1;
        return window.count <= this.#limit;
    }

    #prune(now: number): void {
        if (now - this.#lastPrune < this.#windowMs) return;
        this.#lastPrune = now;
        for (const [key, window] of this.#windows) {
            if (now - window.start >= this.#windowMs) this.#windows.delete(key);
        }
    }
}

/** Per-socket message counter over one-second windows. */
export class MessageRate {
    readonly #limit: number;
    #start = 0;
    #count = 0;

    constructor(limitPerSecond: number) {
        this.#limit = limitPerSecond;
    }

    hit(now = Date.now()): boolean {
        if (now - this.#start >= 1_000) {
            this.#start = now;
            this.#count = 0;
        }
        this.#count += 1;
        return this.#count <= this.#limit;
    }
}

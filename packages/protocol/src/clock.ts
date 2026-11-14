/** Lamport timestamp of a device. Unique per (lamport, deviceId) as long as a device ticks before every op. */
export interface Clock {
    lamport: number;
    deviceId: string;
}

/** A clock bound to a specific op: `opId` breaks ties if two ops ever share the same clock. */
export interface Stamp extends Clock {
    opId: string;
}

function compareStrings(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
}

/** Total order on stamps: lamport, then deviceId, then opId. */
export function compareStamps(a: Stamp, b: Stamp): number {
    if (a.lamport !== b.lamport) return a.lamport - b.lamport;
    return compareStrings(a.deviceId, b.deviceId) || compareStrings(a.opId, b.opId);
}

/** Mutable Lamport clock owned by a single device (daemon or web client). */
export class LamportClock {
    readonly deviceId: string;
    #lamport: number;

    constructor(deviceId: string, lamport = 0) {
        this.deviceId = deviceId;
        this.#lamport = lamport;
    }

    get lamport(): number {
        return this.#lamport;
    }

    /** Advances the clock for a new local op and returns its timestamp. */
    tick(): Clock {
        this.#lamport += 1;
        return { lamport: this.#lamport, deviceId: this.deviceId };
    }

    /** Merges a lamport value seen on a remote op or snapshot. */
    observe(lamport: number): void {
        if (lamport > this.#lamport) this.#lamport = lamport;
    }
}

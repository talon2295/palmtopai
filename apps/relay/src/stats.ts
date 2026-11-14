import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Usage counters of the relay, built only from what it sees without reading message contents:
 * connections, rooms (one per computer), the anonymous stats id of devices, downloads, pages and
 * refusals. Computers and devices are kept as salted hashes; no IP address is stored.
 */

export const STATS_FILE = 'stats.json';
const FLUSH_INTERVAL_MS = 30_000;
const DAY_MS = 86_400_000;
/** Days returned by `report()`: the file keeps every day. */
const REPORTED_DAYS = 30;

export type Download = 'installSh' | 'installPs1' | 'bundle' | 'versionJson';
export type Page = 'home' | 'docs' | 'changelog' | 'app' | 'installMd';
export type Direction = 'toDaemons' | 'toDevices';

const trafficSchema = z.object({ messages: z.number(), bytes: z.number() });

const countersSchema = z.object({
    daemonConnections: z.number(),
    deviceConnections: z.number(),
    downloads: z.object({
        installSh: z.number(),
        // Added with Windows: a `stats.json` written before has no such counter, and is kept.
        installPs1: z.number().default(0),
        bundle: z.number(),
        versionJson: z.number(),
    }),
    pages: z.object({
        home: z.number(),
        docs: z.number(),
        changelog: z.number(),
        app: z.number(),
        installMd: z.number(),
    }),
    /** By reason: `outdated`, `unauthorized`, `room_full`, `daemon_offline`, ... */
    rejects: z.record(z.string(), z.number()),
    feedback: z.number(),
    traffic: z.object({ toDaemons: trafficSchema, toDevices: trafficSchema }),
    peakDevices: z.number(),
});

const daySchema = countersSchema.extend({
    activeComputers: z.number(),
    newComputers: z.number(),
    activeDevices: z.number(),
    newDevices: z.number(),
    // Added with the guest rooms: a file written before has neither.
    activeGuestRooms: z.number().default(0),
    newGuestRooms: z.number().default(0),
});

/** First and last day (UTC, `YYYY-MM-DD`) a computer or device was seen. */
const seenSchema = z.object({ first: z.string(), last: z.string() });

const statsFileSchema = z.object({
    version: z.literal(1),
    since: z.string(),
    salt: z.string(),
    totals: countersSchema.extend({ peakDevicesAt: z.string().nullable() }),
    days: z.record(z.string(), daySchema),
    computers: z.record(z.string(), seenSchema),
    devices: z.record(z.string(), seenSchema),
    /** Rooms of people a computer shares with: not computers. A file written before has none. */
    guestRooms: z.record(z.string(), seenSchema).default({}),
});

export type Counters = z.infer<typeof countersSchema>;
export type DayStats = z.infer<typeof daySchema> & { day: string };
type StatsFile = z.infer<typeof statsFileSchema>;

export interface LiveComputer {
    /** Short hash of the room: the same computer keeps the same id. */
    id: string;
    connectedAt: string;
    devices: number;
    protocol: number;
}

export interface StatsReport {
    generatedAt: string;
    /** First start of the relay with this data directory. */
    since: string;
    relay: {
        startedAt: string;
        uptimeSeconds: number;
        memory: { rss: number; heapUsed: number };
        /** CLI version served for download, if any. */
        cli: string | null;
        persisted: boolean;
    };
    live: {
        computers: number;
        /** Rooms of people a computer shares with, held right now. */
        guestRooms: number;
        devices: number;
        list: LiveComputer[];
        protocols: Record<string, number>;
        lastMinute: Record<Direction, { messages: number; bytes: number }>;
    };
    totals: Counters & {
        peakDevicesAt: string | null;
        computers: number;
        guestRooms: number;
        devices: number;
        activeComputers7d: number;
        activeGuestRooms7d: number;
        activeDevices7d: number;
    };
    /** Newest first. */
    days: DayStats[];
}

export interface LiveState {
    computers: LiveComputer[];
    guestRooms: number;
    devices: number;
    cli: string | null;
}

function emptyCounters(): Counters {
    return {
        daemonConnections: 0,
        deviceConnections: 0,
        downloads: { installSh: 0, installPs1: 0, bundle: 0, versionJson: 0 },
        pages: { home: 0, docs: 0, changelog: 0, app: 0, installMd: 0 },
        rejects: {},
        feedback: 0,
        traffic: { toDaemons: { messages: 0, bytes: 0 }, toDevices: { messages: 0, bytes: 0 } },
        peakDevices: 0,
    };
}

function emptyFile(now: Date): StatsFile {
    return {
        version: 1,
        since: now.toISOString(),
        salt: randomBytes(16).toString('base64url'),
        totals: { ...emptyCounters(), peakDevicesAt: null },
        days: {},
        computers: {},
        devices: {},
        guestRooms: {},
    };
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Messages and bytes over the last minute, in 10 s buckets. */
class LastMinute {
    static readonly BUCKET_MS = 10_000;
    readonly #buckets = new Map<number, Record<Direction, { messages: number; bytes: number }>>();

    add(now: number, direction: Direction, bytes: number, messages: number): void {
        const key = Math.floor(now / LastMinute.BUCKET_MS);
        let bucket = this.#buckets.get(key);
        if (!bucket) {
            bucket = { toDaemons: { messages: 0, bytes: 0 }, toDevices: { messages: 0, bytes: 0 } };
            this.#buckets.set(key, bucket);
            for (const old of this.#buckets.keys()) if (old <= key - 6) this.#buckets.delete(old);
        }
        bucket[direction].messages += messages;
        bucket[direction].bytes += bytes;
    }

    sum(now: number): Record<Direction, { messages: number; bytes: number }> {
        const key = Math.floor(now / LastMinute.BUCKET_MS);
        const total = {
            toDaemons: { messages: 0, bytes: 0 },
            toDevices: { messages: 0, bytes: 0 },
        };
        for (const [bucketKey, bucket] of this.#buckets) {
            if (bucketKey <= key - 6) continue;
            for (const direction of ['toDaemons', 'toDevices'] as const) {
                total[direction].messages += bucket[direction].messages;
                total[direction].bytes += bucket[direction].bytes;
            }
        }
        return total;
    }
}

export interface RelayStatsOptions {
    /** Directory of `stats.json`; without it the counters live in memory only. */
    dataDir?: string;
    now?: () => Date;
    log?: (line: string) => void;
}

export class RelayStats {
    readonly #path: string | null;
    readonly #now: () => Date;
    readonly #log: (line: string) => void;
    readonly #startedAt: Date;
    readonly #lastMinute = new LastMinute();
    #file: StatsFile;
    #dirty = false;
    #timer: ReturnType<typeof setInterval> | null = null;

    constructor(options: RelayStatsOptions = {}) {
        this.#now = options.now ?? (() => new Date());
        this.#log = options.log ?? (() => {});
        this.#startedAt = this.#now();
        this.#path = options.dataDir ? join(options.dataDir, STATS_FILE) : null;
        this.#file = this.#load(options.dataDir);
        if (this.#path) {
            this.#timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
            this.#timer.unref?.();
        }
    }

    #load(dataDir: string | undefined): StatsFile {
        if (!dataDir || !this.#path) return emptyFile(this.#now());
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        let raw: string;
        try {
            raw = readFileSync(this.#path, 'utf8');
        } catch {
            const file = emptyFile(this.#now());
            this.#dirty = true;
            return file;
        }
        try {
            return statsFileSchema.parse(JSON.parse(raw));
        } catch {
            // Keep the unreadable file for a look by hand and start counting again.
            const aside = `${this.#path}.invalid-${Date.now()}`;
            renameSync(this.#path, aside);
            this.#log(`invalid ${STATS_FILE}, moved to ${aside}: statistics start again`);
            this.#dirty = true;
            return emptyFile(this.#now());
        }
    }

    /** Short salted hash: the same room or device always gets the same id. */
    idOf(value: string): string {
        return createHash('sha256')
            .update(this.#file.salt)
            .update(value)
            .digest('base64url')
            .slice(0, 16);
    }

    #today(): { day: string; stats: StatsFile['days'][string] } {
        const day = dayOf(this.#now());
        let stats = this.#file.days[day];
        if (!stats) {
            stats = {
                ...emptyCounters(),
                activeComputers: 0,
                newComputers: 0,
                activeDevices: 0,
                newDevices: 0,
                activeGuestRooms: 0,
                newGuestRooms: 0,
            };
            this.#file.days[day] = stats;
        }
        this.#dirty = true;
        return { day, stats };
    }

    /** Both today's counters and the totals. */
    #count(update: (counters: Counters) => void): void {
        update(this.#today().stats);
        update(this.#file.totals);
    }

    #seen(kind: 'computers' | 'devices' | 'guestRooms', id: string): void {
        const { day, stats } = this.#today();
        const known = this.#file[kind][id];
        const [active, fresh] = {
            computers: ['activeComputers', 'newComputers'],
            devices: ['activeDevices', 'newDevices'],
            guestRooms: ['activeGuestRooms', 'newGuestRooms'],
        }[kind] as [
            'activeComputers' | 'activeDevices' | 'activeGuestRooms',
            'newComputers' | 'newDevices' | 'newGuestRooms',
        ];
        if (!known) {
            this.#file[kind][id] = { first: day, last: day };
            stats[active] += 1;
            stats[fresh] += 1;
        } else if (known.last !== day) {
            known.last = day;
            stats[active] += 1;
        }
    }

    /** A daemon proved the room of a computer: one room is one computer. */
    computerConnected(roomId: string): void {
        this.#seen('computers', this.idOf(roomId));
    }

    /** A daemon proved the room of a person it shares with: not a computer. */
    guestRoomConnected(roomId: string): void {
        this.#seen('guestRooms', this.idOf(roomId));
    }

    daemonConnected(): void {
        this.#count((c) => {
            c.daemonConnections += 1;
        });
    }

    /** `statsId` is the anonymous id sent by the app, `null` when missing or invalid. */
    deviceConnected(statsId: string | null, liveDevices: number): void {
        this.#count((c) => {
            c.deviceConnections += 1;
        });
        if (statsId) this.#seen('devices', this.idOf(statsId));
        const { stats } = this.#today();
        stats.peakDevices = Math.max(stats.peakDevices, liveDevices);
        if (liveDevices > this.#file.totals.peakDevices) {
            this.#file.totals.peakDevices = liveDevices;
            this.#file.totals.peakDevicesAt = this.#now().toISOString();
        }
    }

    download(kind: Download): void {
        this.#count((c) => {
            c.downloads[kind] += 1;
        });
    }

    page(kind: Page): void {
        this.#count((c) => {
            c.pages[kind] += 1;
        });
    }

    reject(reason: string): void {
        this.#count((c) => {
            c.rejects[reason] = (c.rejects[reason] ?? 0) + 1;
        });
    }

    feedback(): void {
        this.#count((c) => {
            c.feedback += 1;
        });
    }

    traffic(direction: Direction, bytes: number, messages = 1): void {
        this.#lastMinute.add(this.#now().getTime(), direction, bytes, messages);
        this.#count((c) => {
            c.traffic[direction].messages += messages;
            c.traffic[direction].bytes += bytes;
        });
    }

    report(live: LiveState): StatsReport {
        const now = this.#now();
        const weekAgo = dayOf(new Date(now.getTime() - 6 * DAY_MS));
        const activeSince = (seen: Record<string, { last: string }>) =>
            Object.values(seen).filter((entry) => entry.last >= weekAgo).length;
        const protocols: Record<string, number> = {};
        for (const computer of live.computers) {
            const key = String(computer.protocol);
            protocols[key] = (protocols[key] ?? 0) + 1;
        }
        const memory = process.memoryUsage();
        return {
            generatedAt: now.toISOString(),
            since: this.#file.since,
            relay: {
                startedAt: this.#startedAt.toISOString(),
                uptimeSeconds: Math.round((now.getTime() - this.#startedAt.getTime()) / 1000),
                memory: { rss: memory.rss, heapUsed: memory.heapUsed },
                cli: live.cli,
                persisted: this.#path !== null,
            },
            live: {
                computers: live.computers.length,
                guestRooms: live.guestRooms,
                devices: live.devices,
                list: live.computers,
                protocols,
                lastMinute: this.#lastMinute.sum(now.getTime()),
            },
            totals: {
                ...structuredClone(this.#file.totals),
                computers: Object.keys(this.#file.computers).length,
                guestRooms: Object.keys(this.#file.guestRooms).length,
                devices: Object.keys(this.#file.devices).length,
                activeComputers7d: activeSince(this.#file.computers),
                activeGuestRooms7d: activeSince(this.#file.guestRooms),
                activeDevices7d: activeSince(this.#file.devices),
            },
            days: Object.entries(this.#file.days)
                .sort(([a], [b]) => (a < b ? 1 : -1))
                .slice(0, REPORTED_DAYS)
                .map(([day, stats]) => ({ day, ...structuredClone(stats) })),
        };
    }

    /** Writes `stats.json` atomically when something changed. */
    flush(): void {
        if (!this.#path || !this.#dirty) return;
        const temporary = `${this.#path}.tmp`;
        try {
            writeFileSync(temporary, JSON.stringify(this.#file), { mode: 0o600 });
            renameSync(temporary, this.#path);
            this.#dirty = false;
        } catch (error) {
            this.#log(`could not write ${STATS_FILE}: ${(error as Error).message}`);
        }
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.flush();
    }
}

/** Kind of an HTML page of the site, for the page counters (the app is counted by its host). */
export function pageOf(pathname: string): Page | null {
    if (pathname === '/' || pathname === '/index.html') return 'home';
    if (pathname === '/install.md') return 'installMd';
    if (pathname === '/changelog' || pathname.startsWith('/changelog/')) return 'changelog';
    if (pathname === '/docs' || pathname.startsWith('/docs/')) return 'docs';
    return null;
}

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pageOf, RelayStats, STATS_FILE } from '../src/stats';

const LIVE = { computers: [], guestRooms: 0, devices: 0, cli: null };

describe('relay statistics', () => {
    const dirs: string[] = [];
    afterEach(async () => {
        for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
    });

    async function tempDir() {
        const dir = await mkdtemp(join(tmpdir(), 'palmtop-stats-'));
        dirs.push(dir);
        return dir;
    }

    /** A clock the test moves by hand. */
    function clock(start = '2026-09-20T10:00:00Z') {
        let now = new Date(start);
        return {
            now: () => now,
            set: (iso: string) => {
                now = new Date(iso);
            },
        };
    }

    test('counts distinct computers and devices, new and active per day', () => {
        const time = clock();
        const stats = new RelayStats({ now: time.now });
        stats.computerConnected('room-a');
        stats.computerConnected('room-a');
        stats.computerConnected('room-b');
        stats.deviceConnected('device-1', 1);
        stats.deviceConnected('device-1', 2);
        stats.deviceConnected(null, 3);

        time.set('2026-09-21T09:00:00Z');
        stats.computerConnected('room-a');
        stats.deviceConnected('device-2', 1);

        const report = stats.report(LIVE);
        expect(report.totals).toMatchObject({
            computers: 2,
            devices: 2,
            deviceConnections: 4,
            peakDevices: 3,
            peakDevicesAt: '2026-09-20T10:00:00.000Z',
            activeComputers7d: 2,
            activeDevices7d: 2,
        });
        const [today, yesterday] = report.days;
        expect(today).toMatchObject({
            day: '2026-09-21',
            activeComputers: 1,
            newComputers: 0,
            activeDevices: 1,
            newDevices: 1,
            peakDevices: 1,
        });
        expect(yesterday).toMatchObject({
            day: '2026-09-20',
            activeComputers: 2,
            newComputers: 2,
            activeDevices: 1,
            newDevices: 1,
            deviceConnections: 3,
            peakDevices: 3,
        });

        // A week later only what came back counts as active.
        time.set('2026-09-27T09:00:00Z');
        stats.computerConnected('room-b');
        expect(stats.report(LIVE).totals).toMatchObject({
            activeComputers7d: 2,
            activeDevices7d: 1,
        });
        time.set('2026-09-28T09:00:00Z');
        expect(stats.report(LIVE).totals).toMatchObject({
            activeComputers7d: 1,
            activeDevices7d: 0,
        });
    });

    test('downloads, pages, refusals, feedback and traffic', () => {
        const time = clock();
        const stats = new RelayStats({ now: time.now });
        stats.download('installSh');
        stats.download('bundle');
        stats.download('bundle');
        stats.page('home');
        stats.page('docs');
        stats.reject('outdated');
        stats.reject('outdated');
        stats.feedback();
        stats.traffic('toDaemons', 100);
        stats.traffic('toDevices', 300, 3);

        const report = stats.report(LIVE);
        expect(report.totals.downloads).toEqual({
            installSh: 1,
            installPs1: 0,
            bundle: 2,
            versionJson: 0,
        });
        expect(report.totals.pages).toMatchObject({ home: 1, docs: 1, app: 0 });
        expect(report.totals.rejects).toEqual({ outdated: 2 });
        expect(report.totals.feedback).toBe(1);
        expect(report.totals.traffic.toDevices).toEqual({ messages: 3, bytes: 300 });
        expect(report.live.lastMinute.toDaemons).toEqual({ messages: 1, bytes: 100 });
        expect(report.days[0]?.downloads.bundle).toBe(2);

        time.set('2026-09-20T10:01:30Z');
        expect(stats.report(LIVE).live.lastMinute.toDaemons).toEqual({ messages: 0, bytes: 0 });
        expect(stats.report(LIVE).totals.traffic.toDaemons.bytes).toBe(100);
    });

    test('live state: computers, devices and protocols', () => {
        const stats = new RelayStats();
        const computer = { id: 'abc', connectedAt: 'x', devices: 2, protocol: 2 };
        const report = stats.report({
            computers: [computer, { ...computer, protocol: 1 }],
            guestRooms: 3,
            devices: 4,
            cli: '0.13.1',
        });
        expect(report.live).toMatchObject({
            computers: 2,
            guestRooms: 3,
            devices: 4,
            protocols: { '1': 1, '2': 1 },
        });
        expect(report.relay).toMatchObject({ cli: '0.13.1', persisted: false });
    });

    test('ids are salted hashes, stable within a data directory', async () => {
        const dir = await tempDir();
        const first = new RelayStats({ dataDir: dir });
        const id = first.idOf('room-a');
        expect(id).toHaveLength(16);
        expect(id).not.toContain('room-a');
        first.stop();
        expect(new RelayStats({ dataDir: dir }).idOf('room-a')).toBe(id);
        expect(new RelayStats().idOf('room-a')).not.toBe(id);
    });

    test('persist across restarts, without room ids or stats ids in the file', async () => {
        const dir = await tempDir();
        const first = new RelayStats({ dataDir: dir });
        first.computerConnected('room-secret-id');
        first.deviceConnected('device-secret', 1);
        first.download('installSh');
        first.stop();

        const raw = await readFile(join(dir, STATS_FILE), 'utf8');
        expect(raw).not.toContain('room-secret-id');
        expect(raw).not.toContain('device-secret');

        const second = new RelayStats({ dataDir: dir });
        second.computerConnected('room-secret-id');
        const report = second.report(LIVE);
        expect(report.totals).toMatchObject({ computers: 1, devices: 1 });
        expect(report.totals.downloads.installSh).toBe(1);
        expect(report.relay.persisted).toBe(true);
        second.stop();
    });

    test('guest rooms are counted apart from computers, new and active per day', () => {
        const time = clock('2026-09-20T10:00:00Z');
        const stats = new RelayStats({ now: time.now });
        stats.computerConnected('home');
        stats.guestRoomConnected('mario');
        stats.guestRoomConnected('luca');
        time.set('2026-09-21T10:00:00Z');
        stats.guestRoomConnected('mario');
        const report = stats.report(LIVE);
        expect(report.totals).toMatchObject({
            computers: 1,
            guestRooms: 2,
            activeGuestRooms7d: 2,
        });
        expect(report.days[0]).toMatchObject({
            day: '2026-09-21',
            activeGuestRooms: 1,
            newGuestRooms: 0,
        });
        expect(report.days[1]).toMatchObject({
            day: '2026-09-20',
            activeComputers: 1,
            activeGuestRooms: 2,
            newGuestRooms: 2,
        });
    });

    test('a file written before the guest rooms is read, not thrown away', async () => {
        const dir = await tempDir();
        const old = {
            version: 1,
            since: '2026-09-01T00:00:00.000Z',
            salt: 'salt',
            totals: {
                daemonConnections: 7,
                deviceConnections: 9,
                downloads: { installSh: 0, bundle: 0, versionJson: 0 },
                pages: { home: 0, docs: 0, changelog: 0, app: 0, installMd: 0 },
                rejects: {},
                feedback: 0,
                traffic: {
                    toDaemons: { messages: 0, bytes: 0 },
                    toDevices: { messages: 0, bytes: 0 },
                },
                peakDevices: 2,
                peakDevicesAt: null,
            },
            days: {
                '2026-09-20': {
                    daemonConnections: 7,
                    deviceConnections: 9,
                    downloads: { installSh: 0, bundle: 0, versionJson: 0 },
                    pages: { home: 0, docs: 0, changelog: 0, app: 0, installMd: 0 },
                    rejects: {},
                    feedback: 0,
                    traffic: {
                        toDaemons: { messages: 0, bytes: 0 },
                        toDevices: { messages: 0, bytes: 0 },
                    },
                    peakDevices: 2,
                    activeComputers: 1,
                    newComputers: 1,
                    activeDevices: 1,
                    newDevices: 1,
                },
            },
            computers: { a: { first: '2026-09-20', last: '2026-09-20' } },
            devices: { b: { first: '2026-09-20', last: '2026-09-20' } },
        };
        await writeFile(join(dir, STATS_FILE), JSON.stringify(old));
        const stats = new RelayStats({ dataDir: dir, now: clock('2026-09-21T10:00:00Z').now });
        const report = stats.report(LIVE);
        expect(report.totals).toMatchObject({
            computers: 1,
            devices: 1,
            guestRooms: 0,
            daemonConnections: 7,
        });
        expect(report.days[0]).toMatchObject({ activeGuestRooms: 0, newGuestRooms: 0 });
        // The counter of install.ps1 did not exist: it starts from zero, nothing is thrown away.
        expect(report.totals.downloads.installPs1).toBe(0);
        stats.download('installPs1');
        expect(stats.report(LIVE).totals.downloads.installPs1).toBe(1);
        expect(stats.report(LIVE).totals.daemonConnections).toBe(7);
        stats.guestRoomConnected('mario');
        stats.stop();
        expect((await readdir(dir)).filter((file) => file.includes('invalid'))).toEqual([]);
    });

    test('an unreadable file is moved aside and counting starts again', async () => {
        const dir = await tempDir();
        await writeFile(join(dir, STATS_FILE), '{"version":7}');
        const logs: string[] = [];
        const stats = new RelayStats({ dataDir: dir, log: (line) => logs.push(line) });
        expect(stats.report(LIVE).totals.computers).toBe(0);
        stats.stop();
        expect(logs[0]).toContain('statistics start again');
        const files = await readdir(dir);
        expect(files).toContain(STATS_FILE);
        expect(files.some((file) => file.startsWith(`${STATS_FILE}.invalid-`))).toBe(true);
    });

    test('page kinds', () => {
        expect(pageOf('/')).toBe('home');
        expect(pageOf('/docs/')).toBe('docs');
        expect(pageOf('/docs/cli')).toBe('docs');
        expect(pageOf('/changelog/')).toBe('changelog');
        // The app is counted by its host (`app.<host>`): on the site `/app/` is a redirect.
        expect(pageOf('/app/')).toBeNull();
        expect(pageOf('/install.md')).toBe('installMd');
        expect(pageOf('/assets/x.js')).toBeNull();
    });
});

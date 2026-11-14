import { afterEach, describe, expect, test } from 'bun:test';
import { stripVTControlCharacters } from 'node:util';
import type { FeedbackEntry } from '@palmtopai/protocol';
import { renderToString as renderColored } from 'ink';
import { loadSnapshot, parseArgs } from '../scripts/stats/client';
import {
    feedbackMarkdown,
    formatBytes,
    formatCount,
    formatDuration,
    newestFirst,
} from '../scripts/stats/format';
import { DashboardView } from '../scripts/stats/view';
import { type Relay, startRelay } from '../src';

/** Colors depend on the terminal running the tests (on in an ssh session): compare plain text. */
const renderToString = (...args: Parameters<typeof renderColored>) =>
    stripVTControlCharacters(renderColored(...args));

const FEEDBACK: FeedbackEntry[] = [
    {
        id: 'a1',
        at: '2026-09-24T10:00:00.000Z',
        type: 'bug',
        message: 'QR not shown\non Safari',
        email: 'one@example.com',
        page: '/',
    },
    {
        id: 'b2',
        at: '2026-09-25T09:30:00.000Z',
        type: 'feature',
        message: 'Dark QR page',
        email: 'two@example.com',
        page: '/app/',
    },
];

describe('stats dashboard', () => {
    let relay: Relay | null = null;
    afterEach(async () => {
        await relay?.stop();
        relay = null;
    });

    test('formats bytes, durations and counts', () => {
        expect(formatBytes(512)).toBe('512 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(300 * 1024 * 1024)).toBe('300 MB');
        expect(formatDuration(45)).toBe('45s');
        expect(formatDuration(723)).toBe('12m 03s');
        expect(formatDuration(3 * 3600 + 7 * 60)).toBe('3h 07m');
        expect(formatDuration(2 * 86_400 + 4 * 3600)).toBe('2d 04h');
        expect(formatCount(9_999)).toBe('9999');
        expect(formatCount(12_345)).toBe('12.3k');
        expect(formatCount(3_400_000)).toBe('3.4M');
        expect(newestFirst(FEEDBACK).map((entry) => entry.id)).toEqual(['b2', 'a1']);
    });

    test('exports feedback as Markdown grouped by type, messages quoted', () => {
        const markdown = feedbackMarkdown(FEEDBACK, new Date('2026-09-25T12:00:00Z'));
        expect(markdown).toBe(`# PalmtopAI feedback

Exported 2026-09-25 12:00 UTC · 2 messages

## Bugs (1)

### 2026-09-24 10:00 · one@example.com

Page: \`/\` · id \`a1\`

> QR not shown
> on Safari

## Feature requests (1)

### 2026-09-25 09:30 · two@example.com

Page: \`/app/\` · id \`b2\`

> Dark QR page
`);
        expect(feedbackMarkdown([], new Date())).toContain('0 messages');
    });

    test('options: watch by default, --json, --export-feedback [file], --port', () => {
        expect(parseArgs([], {})).toEqual({ mode: 'watch', port: 8788, file: null });
        expect(parseArgs([], { ADMIN_PORT: '9000' }).port).toBe(9000);
        expect(parseArgs(['--json', '--port', '9001'], {})).toMatchObject({
            mode: 'json',
            port: 9001,
        });
        expect(parseArgs(['--export-feedback'], {})).toMatchObject({ mode: 'export', file: null });
        expect(parseArgs(['--export-feedback', 'out.md', '--port', '1'], {})).toEqual({
            mode: 'export',
            port: 1,
            file: 'out.md',
        });
        expect(() => parseArgs(['--port', 'x'], {})).toThrow('--port');
        expect(() => parseArgs(['--nope'], {})).toThrow('unknown option --nope');
    });

    test('reads statistics and feedback from the admin listener', async () => {
        relay = startRelay({ port: 0, adminPort: 0, log: () => {} });
        await fetch(`http://127.0.0.1:${relay.port}/feedback`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                type: 'other',
                message: 'Hello',
                email: 'x@example.com',
                page: '/',
            }),
        });
        const snapshot = await loadSnapshot(relay.adminPort as number);
        expect(snapshot.stats.totals.feedback).toBe(1);
        expect(snapshot.feedback).toHaveLength(1);
        expect(snapshot.feedback[0]).toMatchObject({ type: 'other', message: 'Hello' });

        // The public port does not answer statistics.
        await expect(loadSnapshot(relay.port)).rejects.toThrow('answered 404');
        const port = relay.adminPort as number;
        await relay.stop();
        relay = null;
        await expect(loadSnapshot(port)).rejects.toThrow("Can't reach the relay");
    });

    test('renders live data, totals, the days and the feedback list', () => {
        const stats = startRelay({ port: 0, log: () => {} });
        const report = stats.report();
        void stats.stop();
        report.live = {
            ...report.live,
            computers: 1,
            guestRooms: 3,
            devices: 2,
            protocols: { '2': 1 },
            list: [
                {
                    id: 'abcd1234',
                    connectedAt: new Date(Date.parse(report.generatedAt) - 90_000).toISOString(),
                    devices: 2,
                    protocol: 2,
                },
            ],
        };
        report.totals.downloads.installSh = 4;
        report.totals.rejects = { outdated: 2 };

        const text = renderToString(
            <DashboardView
                report={report}
                feedback={FEEDBACK}
                error={null}
                offset={0}
                visible={1}
                live
            />,
            { columns: 140 },
        );
        expect(text).toContain('Computers online      1');
        expect(text).toContain('Guest rooms           3');
        expect(text).toContain('v2 ×1');
        // A relay older than the guest rooms sends no such fields: shown as none, not as NaN.
        const older = renderToString(
            <DashboardView
                report={{
                    ...report,
                    live: { ...report.live, guestRooms: undefined as never },
                    totals: { ...report.totals, guestRooms: undefined as never },
                }}
                feedback={FEEDBACK}
                error={null}
                offset={0}
                visible={1}
                live
            />,
            { columns: 140 },
        );
        expect(older).toContain('Guest rooms           0');
        expect(older).not.toContain('undefined');
        expect(text).toContain('abcd1234 for 1m 30s · 2 devices · protocol 2');
        expect(text).toContain('install.sh 4');
        expect(text).toContain('outdated 2');
        expect(text).toContain('in memory only');
        expect(text).toContain('FEEDBACK (2) 1–1 of 2, ↑↓ to scroll');
        // Newest first, one at a time.
        expect(text).toContain('Dark QR page');
        expect(text).not.toContain('QR not shown');

        const scrolled = renderToString(
            <DashboardView
                report={report}
                feedback={FEEDBACK}
                error="Can't reach the relay"
                offset={1}
                visible={1}
                live
            />,
            { columns: 140 },
        );
        expect(scrolled).toContain('QR not shown');
        expect(scrolled).toContain("Can't reach the relay");

        const empty = renderToString(
            <DashboardView report={null} feedback={[]} error={null} offset={0} visible={3} live />,
        );
        expect(empty).toContain('Loading…');
    });
});

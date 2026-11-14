import type { FeedbackEntry } from '@palmtopai/protocol';
import { Box, Text } from 'ink';
import type { ReactNode } from 'react';
import type { StatsReport } from '../../src/stats';
import { formatBytes, formatCount, formatDateTime, formatDuration, newestFirst } from './format';

export interface ViewProps {
    report: StatsReport | null;
    feedback: FeedbackEntry[];
    /** Why the last refresh failed, shown above the last data. */
    error: string | null;
    /** First feedback shown (scrolling with ↑↓). */
    offset: number;
    /** How many feedback entries fit. */
    visible: number;
    /** Watching: shows the keys and the refresh time. */
    live: boolean;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
    return (
        <Box flexDirection="column" marginRight={4} marginBottom={1}>
            <Text bold color="cyan">
                {title}
            </Text>
            {children}
        </Box>
    );
}

function Row({ label, value, dim }: { label: string; value: ReactNode; dim?: boolean }) {
    return (
        <Box>
            <Box width={22}>
                <Text dimColor>{label}</Text>
            </Box>
            <Text dimColor={dim}>{value}</Text>
        </Box>
    );
}

const LABELS: Record<string, string> = {
    installSh: 'install.sh',
    installPs1: 'install.ps1',
    bundle: 'palmtop.mjs',
    versionJson: 'version.json',
    installMd: 'install.md',
};

/** `a 3 · b 1`, or a dash when empty. */
function pairs(record: Record<string, number>): string {
    const entries = Object.entries(record).filter(([, value]) => value > 0);
    if (entries.length === 0) return '—';
    return entries.map(([key, value]) => `${LABELS[key] ?? key} ${formatCount(value)}`).join(' · ');
}

const COLUMNS = [
    { key: 'day', label: 'day', width: 7 },
    { key: 'activeComputers', label: 'pc', width: 5 },
    { key: 'newComputers', label: '+pc', width: 5 },
    { key: 'activeDevices', label: 'dev', width: 5 },
    { key: 'newDevices', label: '+dev', width: 6 },
    { key: 'deviceConnections', label: 'conn', width: 7 },
    { key: 'peakDevices', label: 'peak', width: 6 },
    { key: 'install', label: 'inst', width: 6 },
    { key: 'bundle', label: 'dl', width: 5 },
    { key: 'home', label: 'home', width: 6 },
    { key: 'feedback', label: 'fb', width: 4 },
] as const;

function Days({ days }: { days: StatsReport['days'] }) {
    const rows = days.slice(0, 7).map((day) => ({
        day: day.day.slice(5),
        activeComputers: day.activeComputers,
        newComputers: day.newComputers,
        activeDevices: day.activeDevices,
        newDevices: day.newDevices,
        deviceConnections: day.deviceConnections,
        peakDevices: day.peakDevices,
        // Both installers: the way people get palmtop, on any system.
        install: day.downloads.installSh + day.downloads.installPs1,
        bundle: day.downloads.bundle,
        home: day.pages.home,
        feedback: day.feedback,
    }));
    return (
        <Section title="LAST 7 DAYS (UTC)">
            <Box>
                {COLUMNS.map((column) => (
                    <Box key={column.key} width={column.width}>
                        <Text dimColor>{column.label}</Text>
                    </Box>
                ))}
            </Box>
            {rows.length === 0 && <Text dimColor>no data yet</Text>}
            {rows.map((row) => (
                <Box key={row.day}>
                    {COLUMNS.map((column) => (
                        <Box key={column.key} width={column.width}>
                            <Text>{row[column.key]}</Text>
                        </Box>
                    ))}
                </Box>
            ))}
        </Section>
    );
}

function Feedback({
    entries,
    offset,
    visible,
    live,
}: {
    entries: FeedbackEntry[];
    offset: number;
    visible: number;
    live: boolean;
}) {
    const sorted = newestFirst(entries);
    const shown = sorted.slice(offset, offset + visible);
    const color = { bug: 'red', feature: 'green', other: 'yellow' } as const;
    return (
        <Box flexDirection="column">
            <Text bold color="cyan">
                FEEDBACK ({entries.length}){' '}
                {sorted.length > visible && (
                    <Text dimColor>
                        {offset + 1}–{offset + shown.length} of {sorted.length}
                        {live && ', ↑↓ to scroll'}
                    </Text>
                )}
            </Text>
            {entries.length === 0 && <Text dimColor>no feedback yet</Text>}
            {shown.map((entry) => (
                <Box key={entry.id} flexDirection="column" marginTop={1}>
                    <Text>
                        <Text color={color[entry.type]} bold>
                            [{entry.type}]
                        </Text>{' '}
                        <Text dimColor>
                            {formatDateTime(entry.at)} · {entry.email} · {entry.page}
                        </Text>
                    </Text>
                    <Box paddingLeft={2}>
                        <Text wrap="wrap">{entry.message}</Text>
                    </Box>
                </Box>
            ))}
        </Box>
    );
}

export function DashboardView({ report, feedback, error, offset, visible, live }: ViewProps) {
    if (!report) {
        return (
            <Box flexDirection="column">
                <Text bold>PalmtopAI relay</Text>
                <Text color={error ? 'red' : undefined}>{error ?? 'Loading…'}</Text>
            </Box>
        );
    }
    const { relay, totals } = report;
    const up = report.live.lastMinute.toDaemons;
    const down = report.live.lastMinute.toDevices;
    return (
        <Box flexDirection="column">
            <Box marginBottom={1} justifyContent="space-between">
                <Text>
                    <Text bold>PalmtopAI relay</Text>
                    <Text dimColor>
                        {' '}
                        · palmtop {relay.cli ?? '—'} · up {formatDuration(relay.uptimeSeconds)} ·
                        RSS {formatBytes(relay.memory.rss)} · updated{' '}
                        {report.generatedAt.slice(11, 19)} UTC
                    </Text>
                </Text>
                {live && <Text dimColor>q to quit</Text>}
            </Box>
            {error && <Text color="red">{error}</Text>}
            {!relay.persisted && (
                <Text color="yellow">
                    Statistics are in memory only (no DATA_DIR): lost when the relay restarts.
                </Text>
            )}

            <Box flexWrap="wrap">
                <Section title="LIVE">
                    <Row label="Computers online" value={report.live.computers} />
                    <Row label="Guest rooms" value={report.live.guestRooms ?? 0} />
                    <Row label="Devices connected" value={report.live.devices} />
                    <Row
                        label="Protocols"
                        value={
                            Object.entries(report.live.protocols)
                                .map(([version, count]) => `v${version} ×${count}`)
                                .join(' · ') || '—'
                        }
                    />
                    <Row
                        label="Last minute ↑"
                        value={`${formatCount(up.messages)} msg · ${formatBytes(up.bytes)} to computers`}
                    />
                    <Row
                        label="Last minute ↓"
                        value={`${formatCount(down.messages)} msg · ${formatBytes(down.bytes)} to devices`}
                    />
                </Section>

                <Section title={`TOTALS since ${report.since.slice(0, 10)}`}>
                    <Row
                        label="Computers"
                        value={`${totals.computers} (7 days: ${totals.activeComputers7d})`}
                    />
                    <Row
                        label="Guest rooms"
                        value={`${totals.guestRooms ?? 0} (7 days: ${totals.activeGuestRooms7d ?? 0})`}
                    />
                    <Row
                        label="Devices"
                        value={`${totals.devices} (7 days: ${totals.activeDevices7d})`}
                    />
                    <Row
                        label="Computer connections"
                        value={formatCount(totals.daemonConnections)}
                    />
                    <Row label="Device connections" value={formatCount(totals.deviceConnections)} />
                    <Row
                        label="Peak devices"
                        value={`${totals.peakDevices}${totals.peakDevicesAt ? ` (${formatDateTime(totals.peakDevicesAt)})` : ''}`}
                    />
                    <Row label="Feedback" value={totals.feedback} />
                </Section>

                <Days days={report.days} />
            </Box>

            <Section title="COMPUTERS ONLINE">
                {report.live.list.length === 0 && <Text dimColor>none</Text>}
                {report.live.list.map((computer) => (
                    <Text key={computer.id}>
                        {computer.id} <Text dimColor>for</Text>{' '}
                        {formatDuration(
                            (Date.parse(report.generatedAt) - Date.parse(computer.connectedAt)) /
                                1000,
                        )}{' '}
                        <Text dimColor>·</Text> {computer.devices} device
                        {computer.devices === 1 ? '' : 's'} <Text dimColor>· protocol</Text>{' '}
                        {computer.protocol}
                    </Text>
                ))}
            </Section>

            <Section title="ACTIVITY">
                <Row label="Downloads" value={pairs(totals.downloads)} />
                <Row label="Pages" value={pairs(totals.pages)} />
                <Row label="Refused" value={pairs(totals.rejects)} />
                <Row
                    label="Traffic"
                    value={`to computers ${formatBytes(totals.traffic.toDaemons.bytes)} · to devices ${formatBytes(totals.traffic.toDevices.bytes)}`}
                />
            </Section>

            <Feedback entries={feedback} offset={offset} visible={visible} live={live} />
        </Box>
    );
}

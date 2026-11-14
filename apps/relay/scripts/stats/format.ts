import type { FeedbackEntry, FeedbackType } from '@palmtopai/protocol';

export function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `45s`, `12m 03s`, `3h 07m`, `2d 04h`. */
export function formatDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds));
    const pad = (n: number) => String(n).padStart(2, '0');
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
    return `${Math.floor(s / 86_400)}d ${pad(Math.floor((s % 86_400) / 3600))}h`;
}

/** `1.2k`, `3.4M` for big counters. */
export function formatCount(value: number): string {
    if (value < 10_000) return String(value);
    if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
    return `${(value / 1_000_000).toFixed(1)}M`;
}

/** `2026-09-25 14:03` (UTC, like the days of the statistics). */
export function formatDateTime(iso: string): string {
    return iso.slice(0, 16).replace('T', ' ');
}

export const FEEDBACK_HEADINGS: Record<FeedbackType, string> = {
    bug: 'Bugs',
    feature: 'Feature requests',
    other: 'Other',
};

/** Newest first. */
export function newestFirst(entries: FeedbackEntry[]): FeedbackEntry[] {
    return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** The feedback as Markdown, grouped by type, newest first; messages quoted as they are. */
export function feedbackMarkdown(entries: FeedbackEntry[], exportedAt: Date): string {
    const lines = [
        '# PalmtopAI feedback',
        '',
        `Exported ${formatDateTime(exportedAt.toISOString())} UTC · ${entries.length} message${entries.length === 1 ? '' : 's'}`,
    ];
    for (const type of Object.keys(FEEDBACK_HEADINGS) as FeedbackType[]) {
        const group = newestFirst(entries.filter((entry) => entry.type === type));
        if (group.length === 0) continue;
        lines.push('', `## ${FEEDBACK_HEADINGS[type]} (${group.length})`);
        for (const entry of group) {
            lines.push(
                '',
                `### ${formatDateTime(entry.at)} · ${entry.email}`,
                '',
                `Page: \`${entry.page}\` · id \`${entry.id}\``,
                '',
                ...entry.message.split('\n').map((line) => (line ? `> ${line}` : '>')),
            );
        }
    }
    return `${lines.join('\n')}\n`;
}

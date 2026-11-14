#!/usr/bin/env bun
import { writeFileSync } from 'node:fs';
import { render, renderToString, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useState } from 'react';
import { loadSnapshot, type Options, parseArgs, type Snapshot, USAGE } from './stats/client';
import { feedbackMarkdown } from './stats/format';
import { DashboardView } from './stats/view';

/**
 * Dashboard of the relay, on the server: `bun run stats` (live), `--json`,
 * `--export-feedback [file]`. Reads the admin listener, which only answers on 127.0.0.1.
 */

const REFRESH_MS = 2_000;
/** Rows taken by everything above the feedback list. */
const ROWS_ABOVE_FEEDBACK = 34;
const ROWS_PER_FEEDBACK = 3;

function Live({ port }: { port: number }) {
    const { exit } = useApp();
    const { rows } = useWindowSize();
    const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [offset, setOffset] = useState(0);
    const visible = Math.max(2, Math.floor((rows - ROWS_ABOVE_FEEDBACK) / ROWS_PER_FEEDBACK));
    const total = snapshot?.feedback.length ?? 0;

    useEffect(() => {
        let stopped = false;
        const refresh = async () => {
            try {
                const next = await loadSnapshot(port);
                if (stopped) return;
                setSnapshot(next);
                setError(null);
            } catch (failure) {
                if (!stopped) setError((failure as Error).message);
            }
        };
        void refresh();
        const timer = setInterval(refresh, REFRESH_MS);
        return () => {
            stopped = true;
            clearInterval(timer);
        };
    }, [port]);

    useInput((input, key) => {
        if (input === 'q' || key.escape || (key.ctrl && input === 'c')) exit();
        const last = Math.max(0, total - visible);
        if (key.downArrow || input === 'j') setOffset((value) => Math.min(last, value + 1));
        if (key.upArrow || input === 'k') setOffset((value) => Math.max(0, value - 1));
        if (key.pageDown || input === ' ') setOffset((value) => Math.min(last, value + visible));
        if (key.pageUp) setOffset((value) => Math.max(0, value - visible));
    });

    return (
        <DashboardView
            report={snapshot?.stats ?? null}
            feedback={snapshot?.feedback ?? []}
            error={error}
            offset={Math.min(offset, Math.max(0, total - visible))}
            visible={visible}
            live
        />
    );
}

async function main(options: Options): Promise<number> {
    if (options.mode === 'watch' && process.stdin.isTTY && process.stdout.isTTY) {
        const app = render(<Live port={options.port} />, { alternateScreen: true });
        await app.waitUntilExit();
        return 0;
    }
    const snapshot = await loadSnapshot(options.port);
    if (options.mode === 'json') {
        process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
        return 0;
    }
    if (options.mode === 'export') {
        const now = new Date();
        const file = options.file ?? `feedback-${now.toISOString().slice(0, 10)}.md`;
        writeFileSync(file, feedbackMarkdown(snapshot.feedback, now));
        console.log(`${snapshot.feedback.length} feedback written to ${file}`);
        return 0;
    }
    // Not a terminal (a pipe, ssh without -t): one picture, every feedback.
    const view = (
        <DashboardView
            report={snapshot.stats}
            feedback={snapshot.feedback}
            error={null}
            offset={0}
            visible={snapshot.feedback.length}
            live={false}
        />
    );
    console.log(renderToString(view, { columns: process.stdout.columns || 120 }));
    return 0;
}

let options: Options;
try {
    options = parseArgs(process.argv.slice(2), process.env);
} catch (error) {
    console.error(`${(error as Error).message}\n\n${USAGE}`);
    process.exit(2);
}
try {
    process.exit(await main(options));
} catch (error) {
    console.error((error as Error).message);
    process.exit(1);
}

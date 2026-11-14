import { type FeedbackEntry, feedbackEntrySchema } from '@palmtopai/protocol';
import { z } from 'zod';
import type { StatsReport } from '../../src/stats';

export const DEFAULT_ADMIN_PORT = 8788;

export interface Snapshot {
    stats: StatsReport;
    feedback: FeedbackEntry[];
}

/** Reads statistics and feedback from the admin listener of the relay (127.0.0.1 only). */
export async function loadSnapshot(port: number, fetchImpl = fetch): Promise<Snapshot> {
    const base = `http://127.0.0.1:${port}`;
    let stats: Response;
    let feedback: Response;
    try {
        [stats, feedback] = await Promise.all([
            fetchImpl(`${base}/stats`),
            fetchImpl(`${base}/feedback`),
        ]);
    } catch {
        throw new Error(
            `Can't reach the relay on 127.0.0.1:${port}: is it running? (pm2 status palmtop-relay)`,
        );
    }
    if (!stats.ok || !feedback.ok) {
        throw new Error(`The relay on 127.0.0.1:${port} answered ${stats.status}: too old?`);
    }
    return {
        stats: (await stats.json()) as StatsReport,
        feedback: z.array(feedbackEntrySchema).parse(await feedback.json()),
    };
}

export interface Options {
    mode: 'watch' | 'json' | 'export';
    port: number;
    /** `--export-feedback [file]`. */
    file: string | null;
}

export const USAGE = `Usage: bun run stats [--json | --export-feedback [file]] [--port <admin port>]

  (no option)               live dashboard, refreshed every 2 s (q to quit)
  --json                    statistics and feedback as JSON on stdout
  --export-feedback [file]  feedback as Markdown (default: feedback-<date>.md)
  --port <n>                admin port of the relay (default: $ADMIN_PORT or ${DEFAULT_ADMIN_PORT})`;

export function parseArgs(args: string[], env: Record<string, string | undefined>): Options {
    const options: Options = {
        mode: 'watch',
        port: Number(env.ADMIN_PORT) || DEFAULT_ADMIN_PORT,
        file: null,
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--json') options.mode = 'json';
        else if (arg === '--export-feedback') {
            options.mode = 'export';
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                options.file = next;
                i += 1;
            }
        } else if (arg === '--port') {
            const port = Number(args[i + 1]);
            if (!Number.isInteger(port) || port <= 0) throw new Error('--port needs a number');
            options.port = port;
            i += 1;
        } else throw new Error(`unknown option ${arg}`);
    }
    return options;
}

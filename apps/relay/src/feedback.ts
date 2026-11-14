import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    FEEDBACK_BODY_MAX_BYTES,
    type FeedbackEntry,
    feedbackEntrySchema,
    feedbackSchema,
} from '@palmtopai/protocol';

export const FEEDBACK_FILE = 'feedback.jsonl';

/**
 * Feedback kept by the relay, one JSON line each in `feedback.jsonl`. Without a data directory
 * (tests) it stays in memory. The sender's IP address is never stored.
 */
export class FeedbackStore {
    readonly #path: string | null;
    readonly #memory: FeedbackEntry[] = [];

    constructor(dataDir?: string) {
        this.#path = dataDir ? join(dataDir, FEEDBACK_FILE) : null;
        if (dataDir) mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    }

    add(entry: Omit<FeedbackEntry, 'id' | 'at'>, now = new Date()): FeedbackEntry {
        const stored = { id: randomBytes(6).toString('hex'), at: now.toISOString(), ...entry };
        if (this.#path) appendFileSync(this.#path, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
        else this.#memory.push(stored);
        return stored;
    }

    /** Oldest first; unreadable lines are skipped. */
    list(): FeedbackEntry[] {
        if (!this.#path) return [...this.#memory];
        let raw: string;
        try {
            raw = readFileSync(this.#path, 'utf8');
        } catch {
            return [];
        }
        const entries: FeedbackEntry[] = [];
        for (const line of raw.split('\n')) {
            if (!line.trim()) continue;
            try {
                const entry = feedbackEntrySchema.safeParse(JSON.parse(line));
                if (entry.success) entries.push(entry.data);
            } catch {
                // A line cut by a crash: skip it.
            }
        }
        return entries;
    }
}

export type FeedbackResult =
    | { status: 'stored'; entry: FeedbackEntry }
    | { status: 'spam' }
    | { status: 'too_big' }
    | { status: 'invalid' };

/** Validates a `POST /feedback` body and stores it. */
export function receiveFeedback(store: FeedbackStore, body: string): FeedbackResult {
    if (Buffer.byteLength(body) > FEEDBACK_BODY_MAX_BYTES) return { status: 'too_big' };
    let json: unknown;
    try {
        json = JSON.parse(body);
    } catch {
        return { status: 'invalid' };
    }
    const parsed = feedbackSchema.safeParse(json);
    if (!parsed.success) return { status: 'invalid' };
    const { website, ...feedback } = parsed.data;
    if (website) return { status: 'spam' };
    return { status: 'stored', entry: store.add(feedback) };
}

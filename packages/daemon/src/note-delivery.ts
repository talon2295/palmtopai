import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { splitNote } from '@palmtopai/protocol';
import { z } from 'zod';
import { writeFileAtomic } from './fs-utils';

/** What the agent was given of the elements of a note: the fingerprint of each, by name. */
export type NoteFingerprints = Record<string, string>;

/**
 * A short fingerprint of an element of the note, tied to its session. It lets the computer say
 * whether an element changed since the agent read it without keeping the text.
 */
export function noteFingerprint(sessionId: string, text: string): string {
    return createHash('sha256')
        .update(sessionId)
        .update('\n')
        .update(text)
        .digest('hex')
        .slice(0, 16);
}

/** The fingerprints of the named elements of a note. */
export function noteFingerprints(sessionId: string, note: string): NoteFingerprints {
    const result: NoteFingerprints = {};
    for (const entry of splitNote(note)) {
        if (entry.id) result[entry.id] = noteFingerprint(sessionId, entry.text);
    }
    return result;
}

const fileSchema = z.object({
    sessions: z.record(z.string(), z.record(z.string(), z.string())),
});

/**
 * Which elements of the note of each session the agent has read, in `note-delivered.json` (mode
 * 600): project, then session, then element name and fingerprint. It is local to this computer
 * and never replicated. Only fingerprints are kept, so no text of a note stays in it, and the
 * entries of a session go with the session and with its project.
 */
export class NoteDeliveries {
    readonly #path: string;
    readonly #projects: Map<string, Map<string, NoteFingerprints>>;
    #writes: Promise<void> = Promise.resolve();

    private constructor(path: string, projects: Map<string, Map<string, NoteFingerprints>>) {
        this.#path = path;
        this.#projects = projects;
    }

    /** An unreadable file is the same as no file: every element then reads as new. */
    static async open(path: string): Promise<NoteDeliveries> {
        const projects = new Map<string, Map<string, NoteFingerprints>>();
        let raw: unknown = null;
        try {
            raw = JSON.parse(await readFile(path, 'utf8'));
        } catch {
            // No file yet, or one that cannot be read.
        }
        const parsed = fileSchema.safeParse(raw);
        if (parsed.success) {
            for (const [key, fingerprints] of Object.entries(parsed.data.sessions)) {
                const [projectId, sessionId] = key.split('/');
                if (!projectId || !sessionId) continue;
                const sessions = projects.get(projectId) ?? new Map();
                sessions.set(sessionId, fingerprints);
                projects.set(projectId, sessions);
            }
        }
        return new NoteDeliveries(path, projects);
    }

    get(projectId: string, sessionId: string): NoteFingerprints | undefined {
        return this.#projects.get(projectId)?.get(sessionId);
    }

    set(projectId: string, sessionId: string, fingerprints: NoteFingerprints): Promise<void> {
        const sessions = this.#projects.get(projectId) ?? new Map<string, NoteFingerprints>();
        sessions.set(sessionId, fingerprints);
        this.#projects.set(projectId, sessions);
        return this.#save();
    }

    removeSession(projectId: string, sessionId: string): Promise<void> {
        const sessions = this.#projects.get(projectId);
        if (!sessions?.delete(sessionId)) return this.#writes;
        if (sessions.size === 0) this.#projects.delete(projectId);
        return this.#save();
    }

    removeProject(projectId: string): Promise<void> {
        if (!this.#projects.delete(projectId)) return this.#writes;
        return this.#save();
    }

    #save(): Promise<void> {
        const sessions: Record<string, NoteFingerprints> = {};
        for (const [projectId, bySession] of this.#projects) {
            for (const [sessionId, fingerprints] of bySession) {
                sessions[`${projectId}/${sessionId}`] = fingerprints;
            }
        }
        const data = `${JSON.stringify({ sessions }, null, 4)}\n`;
        this.#writes = this.#writes
            .catch(() => undefined)
            .then(() => writeFileAtomic(this.#path, data));
        return this.#writes;
    }
}

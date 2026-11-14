import {
    type ChecklistKind,
    isReservedDeviceId,
    type PushRegistration,
    type SeqOp,
} from '@palmtopai/protocol';
import webpush from 'web-push';
import type { PushStore } from './push-store';

/** What the service worker shows. Titles only: never the text of items or of the message. */
export interface PushPayload {
    title: string;
    body: string;
    projectId: string;
    sessionId: string;
    tag: string;
}

export interface PushSender {
    /** `gone`: the push service says the subscription no longer exists. */
    send(registration: PushRegistration, payload: PushPayload): Promise<{ gone: boolean }>;
}

export interface PushNotifierOptions {
    store: PushStore;
    sender: PushSender;
    /** `COMPUTER - project`, or `null` for a project that no longer exists. */
    projectLabel: (projectId: string) => string | null;
    /** True while the device is looking at this project: no notification for what is on screen. */
    isVisible: (projectId: string, deviceId: string) => boolean;
    /**
     * Whether a stored device is meant to hear about this project. Absent: every one. The
     * notifier of the people checklists are shared with uses it, so that each hears only of the
     * copies made for them.
     */
    recipients?: (projectId: string, deviceId: string) => boolean;
    /** Changes of one session within this delay make one notification. */
    delayMs?: number;
    log: (line: string) => void;
}

interface Batch {
    projectId: string;
    sessionId: string;
    /** Lists created in this batch, by id: a checklist of checks or a question with options. */
    checklists: Map<string, { title: string; kind: ChecklistKind }>;
    items: number;
    message: boolean;
    timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_DELAY_MS = 3_000;

/**
 * Notifies paired devices when the agent gives them something to look at: a new checklist, new
 * items to review, a new message. Changes of a session are grouped for a few seconds.
 */
export class PushNotifier {
    readonly #options: PushNotifierOptions;
    readonly #batches = new Map<string, Batch>();

    constructor(options: PushNotifierOptions) {
        this.#options = options;
    }

    /** Called for every applied op; only ops of the agent (the daemon) can notify. */
    observe(projectId: string, { op }: SeqOp): void {
        if (!isReservedDeviceId(op.clock.deviceId)) return;
        const relevant =
            op.type === 'checklist.create' ||
            op.type === 'item.add' ||
            (op.type === 'session.message' && op.payload.message !== '');
        if (!relevant || this.#options.store.list().length === 0) return;

        const key = `${projectId}:${op.sessionId}`;
        let batch = this.#batches.get(key);
        if (!batch) {
            batch = {
                projectId,
                sessionId: op.sessionId,
                checklists: new Map(),
                items: 0,
                message: false,
                timer: setTimeout(() => {
                    this.#batches.delete(key);
                    void this.#flush(batch as Batch);
                }, this.#options.delayMs ?? DEFAULT_DELAY_MS),
            };
            this.#batches.set(key, batch);
        }
        if (op.type === 'checklist.create') {
            batch.checklists.set(op.payload.checklistId, {
                title: op.payload.title,
                kind: op.payload.kind ?? 'checks',
            });
        } else if (op.type === 'item.add') {
            // Items of a checklist created in the same batch are part of "New checklist".
            if (!batch.checklists.has(op.payload.checklistId)) batch.items += 1;
        } else {
            batch.message = true;
        }
    }

    /**
     * Tells every device of the store something that is not about a project (a person opened
     * their invitation). Titles only, like the rest.
     */
    async announce(notice: { title: string; body: string; tag: string }): Promise<void> {
        const payload: PushPayload = { ...notice, projectId: '', sessionId: '' };
        await Promise.all(
            this.#options.store.list().map(async ({ deviceId, registration }) => {
                try {
                    await this.#options.sender.send(registration, payload);
                } catch (error) {
                    this.#options.log(
                        `push to device ${deviceId} failed: ${(error as Error).message}`,
                    );
                }
            }),
        );
    }

    stop(): void {
        for (const batch of this.#batches.values()) clearTimeout(batch.timer);
        this.#batches.clear();
    }

    async #flush(batch: Batch): Promise<void> {
        const title = this.#options.projectLabel(batch.projectId);
        if (!title) return;
        const payload: PushPayload = {
            title,
            body: describe(batch),
            projectId: batch.projectId,
            sessionId: batch.sessionId,
            tag: `palmtop-${batch.projectId}-${batch.sessionId}`,
        };
        const targets = this.#options.store
            .list()
            .filter(
                (target) => this.#options.recipients?.(batch.projectId, target.deviceId) ?? true,
            )
            .filter((target) => !this.#options.isVisible(batch.projectId, target.deviceId));
        await Promise.all(
            targets.map(async ({ deviceId, registration }) => {
                try {
                    const { gone } = await this.#options.sender.send(registration, payload);
                    if (gone) {
                        await this.#options.store.removeEndpoint(
                            registration.subscription.endpoint,
                        );
                        this.#options.log(
                            `push subscription of device ${deviceId} expired, removed`,
                        );
                    }
                } catch (error) {
                    this.#options.log(
                        `push to device ${deviceId} failed: ${(error as Error).message}`,
                    );
                }
            }),
        );
    }
}

export function describe(batch: Pick<Batch, 'checklists' | 'items' | 'message'>): string {
    const parts: string[] = [];
    if (batch.message) parts.push('New message from the agent');
    const lists = [...batch.checklists.values()];
    const checks = lists.filter((list) => list.kind !== 'choice');
    const choices = lists.filter((list) => list.kind === 'choice');
    if (checks.length === 1) parts.push(`New checklist: ${(checks[0] as { title: string }).title}`);
    else if (checks.length > 1) parts.push(`${checks.length} new checklists`);
    if (choices.length === 1) {
        parts.push(`A decision to make: ${(choices[0] as { title: string }).title}`);
    } else if (choices.length > 1) parts.push(`${choices.length} decisions to make`);
    if (batch.items > 0) {
        parts.push(`${batch.items} new ${batch.items === 1 ? 'item' : 'items'} to review`);
    }
    return parts.join(' · ');
}

/** Status codes of push services for a subscription that is gone for good. */
const GONE_STATUS = new Set([404, 410]);

/** Sends through the browsers' push services with `web-push`, signed with the phone's VAPID key. */
export function webPushSender(subject: string): PushSender {
    return {
        async send(registration, payload) {
            try {
                await webpush.sendNotification(registration.subscription, JSON.stringify(payload), {
                    vapidDetails: { subject, ...registration.vapid },
                    // Kept by the push service while the device is off or offline.
                    TTL: 4 * 24 * 60 * 60,
                    // Delivered right away also with the screen locked (Android Doze, iOS).
                    urgency: 'high',
                    timeout: 15_000,
                });
                return { gone: false };
            } catch (error) {
                const status = (error as { statusCode?: number }).statusCode;
                if (status !== undefined && GONE_STATUS.has(status)) return { gone: true };
                // web-push errors carry the request details: report the status only.
                throw new Error(
                    status !== undefined ? `push service answered ${status}` : 'network error',
                );
            }
        },
    };
}

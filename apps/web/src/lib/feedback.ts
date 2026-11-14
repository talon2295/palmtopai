import { FEEDBACK_PATH, type FeedbackType } from '@palmtopai/protocol';
import { browserStore, type KeyValueStore } from './storage';

const EMAIL_KEY = 'palmtop.feedbackEmail';

export type FeedbackResult = 'sent' | 'rate_limited' | 'invalid' | 'network' | 'error';

export const FEEDBACK_RESULT_TEXT: Record<Exclude<FeedbackResult, 'sent'>, string> = {
    rate_limited: 'Too many messages in a short time: try again in a minute.',
    invalid: 'Check the fields: something is not valid.',
    network: "Couldn't send it: check your connection and try again.",
    error: "Couldn't send it right now: try again later.",
};

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** Posts feedback to the relay that serves the app (same origin). */
export async function sendFeedback(
    feedback: { type: FeedbackType; message: string; email: string; page: string },
    send: Fetch = (input, init) => fetch(input, init),
): Promise<FeedbackResult> {
    let status: number;
    try {
        const response = await send(FEEDBACK_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(feedback),
        });
        status = response.status;
    } catch {
        return 'network';
    }
    if (status === 201) return 'sent';
    if (status === 429) return 'rate_limited';
    if (status === 400 || status === 413) return 'invalid';
    return 'error';
}

/** The email of the last feedback sent from this device, to fill the form next time. */
export function loadFeedbackEmail(store: KeyValueStore | null = browserStore()): string {
    try {
        return store?.getItem(EMAIL_KEY) ?? '';
    } catch {
        return '';
    }
}

export function saveFeedbackEmail(
    email: string,
    store: KeyValueStore | null = browserStore(),
): void {
    try {
        store?.setItem(EMAIL_KEY, email);
    } catch {
        // Best effort: the form starts empty next time.
    }
}

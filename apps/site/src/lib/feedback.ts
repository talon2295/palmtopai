/** Same limits as the relay (`packages/protocol/src/feedback.ts`), checked again there. */
export const FEEDBACK_MESSAGE_MAX = 4000;

export const FEEDBACK_TYPES = [
    { value: 'bug', label: 'Bug' },
    { value: 'feature', label: 'Feature request' },
    { value: 'other', label: 'Other' },
] as const;

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

/** What to tell the person after a send, by HTTP status (0 = network error). */
export function feedbackResultText(status: number): string {
    if (status === 201) return "Thanks! We read every message and we'll reply by email.";
    if (status === 429) return 'Too many messages in a short time: try again in a minute.';
    if (status === 400 || status === 413) return 'Check the fields: something is not valid.';
    if (status === 0) return "Couldn't send it: check your connection and try again.";
    return "Couldn't send it right now: try again later.";
}

/**
 * The feedback form of the site: posts JSON to the relay (`/feedback`, same origin; the CSP
 * forbids plain form submissions) and shows the result in `[data-feedback-status]`.
 */
export function bindFeedbackForm(
    form: HTMLFormElement,
    send: Fetch = (input, init) => fetch(input, init),
    page = () => window.location.pathname,
): void {
    const status = form.querySelector<HTMLElement>('[data-feedback-status]');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const body = {
            type: String(data.get('type') ?? 'other'),
            message: String(data.get('message') ?? ''),
            email: String(data.get('email') ?? ''),
            page: page(),
            website: String(data.get('website') ?? ''),
        };
        if (button) button.disabled = true;
        form.setAttribute('aria-busy', 'true');
        let code = 0;
        try {
            const response = await send('/feedback', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
            code = response.status;
        } catch {
            code = 0;
        }
        if (code === 201) form.reset();
        if (status) {
            status.textContent = feedbackResultText(code);
            status.dataset.result = code === 201 ? 'ok' : 'error';
        }
        form.removeAttribute('aria-busy');
        if (button) button.disabled = false;
    });
}

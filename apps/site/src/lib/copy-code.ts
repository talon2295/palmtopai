export type CopyResult = 'Copied' | 'Selected';

/**
 * Copies the text of `element`. Without a clipboard (plain http, old browser) it selects the
 * text instead, for a manual copy.
 */
export async function copyElementText(element: Element): Promise<CopyResult> {
    try {
        await navigator.clipboard.writeText(element.textContent?.trim() ?? '');
        return 'Copied';
    } catch {
        window.getSelection()?.selectAllChildren(element);
        return 'Selected';
    }
}

/**
 * Code snippets of the landing page: `<button class="copy-code"><code>…</code></button>`. A click
 * copies the code and `data-copied` holds the result for a moment (the CSS shows it as a tooltip).
 */
export function bindCopyCode(root: ParentNode, resetAfterMs = 1_500): void {
    for (const button of root.querySelectorAll<HTMLElement>('.copy-code')) {
        let reset: ReturnType<typeof setTimeout> | undefined;
        button.addEventListener('click', async () => {
            const code = button.querySelector('code') ?? button;
            button.dataset.copied = await copyElementText(code);
            clearTimeout(reset);
            reset = setTimeout(() => {
                delete button.dataset.copied;
            }, resetAfterMs);
        });
    }
}

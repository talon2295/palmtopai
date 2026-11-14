/**
 * Puts a text on the clipboard. `false` when the browser does not allow it (plain http, an old
 * browser, a refused permission): the caller then selects the text so it can be copied by hand.
 */
export async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        // Without the clipboard API, an off-screen field and the old command still work.
        const field = document.createElement('textarea');
        field.value = text;
        field.setAttribute('readonly', '');
        field.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
        document.body.append(field);
        try {
            field.select();
            return document.execCommand('copy');
        } catch {
            return false;
        } finally {
            field.remove();
        }
    }
}

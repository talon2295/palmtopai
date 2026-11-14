import { renderSVG, renderUnicodeCompact } from 'uqr';

export const PAIR_PAGE_HEADERS = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'content-security-policy':
        "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

function escapeHtml(value: string): string {
    return value
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; padding: 2rem 1rem; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 28rem; width: 100%; }
h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
p { line-height: 1.5; }
.muted { opacity: .7; font-size: .9rem; }
.card { border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 1rem; padding: 1rem; margin: 1rem 0; }
.qr { background: white; padding: .75rem; border-radius: .75rem; }
.qr svg { display: block; width: 100%; height: auto; }
.warning { border-color: #d97706; }
details { margin-top: .75rem; }
code { word-break: break-all; font-size: .8rem; }
.button { display: block; text-align: center; padding: .7rem 1rem; border-radius: .75rem; background: CanvasText; color: Canvas; font-weight: 600; text-decoration: none; }
`;

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

/**
 * A QR code for a terminal: half blocks, white on black whatever the theme, so a camera reads it
 * the same way on a light or dark terminal. About 25 lines tall for a pairing link.
 */
export function renderTerminalQr(url: string): string {
    return renderUnicodeCompact(url, { ecc: 'M', border: 2 })
        .split('\n')
        .map((line) => `\u001b[97;40m${line}\u001b[0m`)
        .join('\n');
}

export function renderPairPage(options: {
    computerName: string;
    qrUrl: string;
    openUrl: string;
    relayHost: string;
    warning?: string;
}): string {
    const warning = options.warning
        ? `<section class="card warning"><p>${escapeHtml(options.warning)}</p></section>`
        : '';

    const label = options.computerName;
    return page(
        `Pair · ${label}`,
        `<h1>Pair a device</h1>
<p>Scan with a phone or tablet to review the work on <strong>${escapeHtml(label)}</strong>, or open it on this computer. Every project of this computer shows up there, including the ones you start later. Devices connect through ${escapeHtml(options.relayHost)}: any network works.</p>
<p class="muted">This page works once: close it when you are done.</p>
${warning}
<section class="card">
  <div class="qr">${renderSVG(options.qrUrl, { ecc: 'M', pixelSize: 8 })}</div>
  <p><a class="button" href="${escapeHtml(options.openUrl)}" target="_blank" rel="noopener noreferrer">Open on this computer</a></p>
  <p class="muted">Opens the app in a new tab of this browser, paired like any other device.</p>
  <details>
    <summary>Show link</summary>
    <p class="muted">This link pairs one device, once, within five minutes. Run <code>palmtop pair</code> again for another device.</p>
    <code>${escapeHtml(options.qrUrl)}</code>
  </details>
</section>
<p class="muted">App added to the Home Screen? It shows a code: run <code>palmtop pair CODE</code> in a terminal on this computer.</p>`,
    );
}

export function renderPairError(): string {
    return page(
        'Pairing link expired',
        `<h1>Pairing link expired</h1>
<p>This pairing page was already opened or is older than a minute.</p>
<p>Run <code>palmtop pair</code> again on this computer.</p>`,
    );
}

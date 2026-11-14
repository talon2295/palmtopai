/** `#rrggbb` under a black layer of `opacity` (0–1), as the overlay of a sheet draws it. */
export function dimColor(color: string, opacity: number): string {
    const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
    if (!match?.[1]) return color;
    const value = Number.parseInt(match[1], 16);
    const channel = (shift: number) =>
        Math.round(((value >> shift) & 0xff) * (1 - opacity))
            .toString(16)
            .padStart(2, '0');
    return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * Darkens the browser bars (`theme-color`, the phone's status bar in the app on the Home
 * Screen) like the overlay darkens the page. Returns what puts the colors back.
 */
export function dimThemeColor(doc: Document, opacity: number): () => void {
    const metas = [...doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')];
    const original = metas.map((meta) => meta.content);
    for (const meta of metas) meta.content = dimColor(meta.content, opacity);
    return () => {
        metas.forEach((meta, index) => {
            meta.content = original[index] ?? meta.content;
        });
    };
}
